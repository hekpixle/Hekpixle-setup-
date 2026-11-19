// Persistent PowerShell worker (Windows). Compiles helper types once, then
// runs many small scripts quickly. Scripts are sent base64-encoded on one line.
const { spawn } = require('child_process');

class PsWorker {
  constructor(prelude) {
    this.prelude = prelude;
    this.proc = null;
    this.buf = '';
    this.cur = null;
    this.seq = 0;
    this.tail = Promise.resolve();
  }

  _spawn() {
    const p = spawn('powershell.exe',
      ['-NoLogo', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { windowsHide: true });
    this.proc = p;
    this.buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { this.buf += d; this._check(); });
    p.stderr.on('data', () => {});
    p.on('error', (e) => this._fail(new Error('PowerShell failed to start: ' + e.message)));
    p.on('exit', () => {
      if (this.proc === p) this.proc = null;
      this._fail(new Error('PowerShell exited unexpectedly'));
    });
  }

  _fail(err) {
    const c = this.cur;
    this.cur = null;
    if (c) { clearTimeout(c.timer); c.reject(err); }
  }

  _check() {
    const c = this.cur;
    if (!c) return;
    const marker = 'HEKDONE:' + c.id;
    const i = this.buf.indexOf(marker);
    if (i < 0) return;
    const out = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + marker.length);
    clearTimeout(c.timer);
    this.cur = null;
    const e = out.indexOf('HEKERR:');
    if (e >= 0) c.reject(new Error(out.slice(e + 7).trim()));
    else c.resolve(out.replace(/\r/g, '').trim());
  }

  _once(script, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('PowerShell not running'));
      const id = ++this.seq;
      const b64 = Buffer.from(script, 'utf8').toString('base64');
      const timer = setTimeout(() => {
        this.cur = null;
        try { this.proc && this.proc.kill(); } catch {}
        this.proc = null;
        this.ready = false;
        reject(new Error('PowerShell timed out'));
      }, timeoutMs);
      this.cur = { id, resolve, reject, timer };
      const line =
        `try { $__s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); ` +
        `$__r=(Invoke-Expression $__s | Out-String -Width 4096); Write-Output $__r } ` +
        `catch { Write-Output ('HEKERR: ' + $_.Exception.Message) }; Write-Output 'HEKDONE:${id}'\n`;
      this.proc.stdin.write(line);
    });
  }

  async run(script, timeoutMs = 15000) {
    const prev = this.tail;
    let release;
    this.tail = new Promise((r) => { release = r; });
    await prev;
    try {
      if (!this.proc || !this.ready) {
        if (this.proc) { try { this.proc.kill(); } catch {} }
        this._spawn();
        this.ready = false;
        await this._once(this.prelude, 60000);
        this.ready = true;
      }
      return await this._once(script, timeoutMs);
    } finally { release(); }
  }

  dispose() { try { this.proc && this.proc.kill(); } catch {} this.proc = null; this.ready = false; }
}

module.exports = { PsWorker };
