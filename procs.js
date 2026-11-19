// Terminal (foreground + background processes) and execute_code (JS/Python with tool RPC).
const { exec, spawn, spawnSync } = require('child_process');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { truncate, sleep } = require('./util');

const WIN = process.platform === 'win32';

const DANGEROUS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b.*(\s\/(\s|$)|\s~|\s\$home|\*)/i,
  /\brm\s+-rf\s+\/(?!\w)/i,
  /\b(del|erase)\b.*\s\/[a-z]*s\b/i,
  /\brd\b.*\s\/s\b/i, /\brmdir\b.*\s\/s\b/i,
  /\bformat\s+[a-z]:/i, /\bdiskpart\b/i, /\bmkfs(\.\w+)?\b/i, /\bdd\s+if=.*of=\/dev\//i,
  /\bshutdown\b/i, /\brestart-computer\b/i, /\bstop-computer\b/i,
  /\breg\s+(delete|add)\b.*\\(software|system)\\/i,
  /\bremove-item\b.*-recurse/i,
  /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|iex|invoke-expression|powershell|pwsh)\b/i,
  /\bnet\s+user\b.*\/add/i, /\bbcdedit\b/i, /\bcipher\s+\/w/i, /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bchmod\s+-R\s+0?777\s+\//i, /\bgit\s+push\b.*--force/i, /\bgit\s+reset\s+--hard\b/i,
];
const isDangerous = (cmd) => DANGEROUS.some((r) => r.test(String(cmd)));

function killTree(proc) {
  try {
    if (WIN && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    else proc.kill('SIGKILL');
  } catch {}
}

function findPython() {
  for (const c of WIN ? [['python', []], ['py', ['-3']], ['python3', []]] : [['python3', []], ['python', []]]) {
    try { const r = spawnSync(c[0], [...c[1], '--version'], { windowsHide: true, timeout: 5000 }); if (r.status === 0) return c; } catch {}
  }
  return null;
}

const JS_PRELUDE = `
const __H = process.env.HEK_RPC, __T = process.env.HEK_TOKEN;
async function __call(name, args) {
  const r = await fetch(__H + '/call', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': __T }, body: JSON.stringify({ tool: name, args: args || {} }) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
const tools = new Proxy({}, { get: (_, n) => (a) => __call(n, a) });
`;
const PY_PRELUDE = `
import os, json, urllib.request
def _call(name, args):
    req = urllib.request.Request(os.environ['HEK_RPC'] + '/call', data=json.dumps({'tool': name, 'args': args}).encode('utf-8'), headers={'Content-Type': 'application/json', 'X-Token': os.environ['HEK_TOKEN']})
    j = json.loads(urllib.request.urlopen(req, timeout=600).read().decode('utf-8'))
    if 'error' in j: raise Exception(j['error'])
    return j['result']
class _T:
    def __getattr__(self, n): return lambda **kw: _call(n, kw)
tools = _T()
`;
const RPC_TOOLS = new Set(['web_search', 'web_extract', 'path_info', 'read_file', 'write_file', 'patch', 'search_files', 'list_dir', 'run_command']);

function register(ctx) {
  const procs = new Map();
  let seq = 0;

  function startBackground(command, cwd) {
    const id = 'p' + (++seq);
    const proc = spawn(command, { shell: true, cwd: cwd || undefined, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rec = { id, command, proc, buf: '', status: 'running', code: null, started: Date.now() };
    const add = (d) => { rec.buf += d.toString(); if (rec.buf.length > 200000) rec.buf = rec.buf.slice(-150000); };
    proc.stdout.on('data', add); proc.stderr.on('data', add);
    proc.on('exit', (c) => { rec.status = 'exited'; rec.code = c; });
    proc.on('error', (e) => { rec.status = 'failed'; add('spawn error: ' + e.message); });
    procs.set(id, rec);
    return rec;
  }

  function runForeground(command, cwd, timeoutS, signal) {
    return new Promise((resolve) => {
      const cmd = WIN ? `chcp 65001 >nul & ${command}` : command;
      exec(cmd, { cwd: cwd || undefined, timeout: timeoutS * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal, encoding: 'utf8' }, (err, stdout, stderr) => {
        let r = '';
        if (stdout) r += 'STDOUT:\n' + truncate(stdout, 30000);
        if (stderr) r += (r ? '\n' : '') + 'STDERR:\n' + truncate(stderr, 15000);
        if (err) {
          if (err.killed || err.signal) r += (r ? '\n' : '') + `TIMED OUT / KILLED after ${timeoutS}s (run with background=true for long jobs)`;
          else if (err.code != null) r += (r ? '\n' : '') + `EXIT CODE: ${err.code}`;
        }
        resolve(r || 'OK (no output)');
      });
    });
  }

  async function execCode(a, call) {
    const lang = (a.language || 'javascript').toLowerCase();
    const timeoutMs = Math.max(5, Math.min(300, +a.timeout_s || 60)) * 1000;
    const id = crypto.randomBytes(4).toString('hex');
    const dir = path.join(os.tmpdir(), 'hekpixle-code');
    await fs.mkdir(dir, { recursive: true });
    let file, cmd, args;
    if (lang === 'python' || lang === 'py') {
      const py = findPython();
      if (!py) return 'ERROR: Python was not found on this machine. Use language="javascript" (built in) or install Python.';
      file = path.join(dir, id + '.py');
      const body = String(a.code).split('\n').map((l) => '    ' + l).join('\n');
      await fs.writeFile(file, PY_PRELUDE + '\ntry:\n' + (body.trim() ? body : '    pass') + '\nexcept SystemExit:\n    raise\n', 'utf8');
      [cmd, args] = [py[0], [...py[1], '-X', 'utf8', file]];
    } else if (lang === 'javascript' || lang === 'js' || lang === 'node') {
      file = path.join(dir, id + '.js');
      await fs.writeFile(file, JS_PRELUDE + `\n(async () => {\n${a.code}\n})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });\n`, 'utf8');
      [cmd, args] = [process.execPath, [file]];
    } else return 'ERROR: language must be "javascript" or "python".';

    const token = crypto.randomBytes(16).toString('hex');
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/call' || req.headers['x-token'] !== token) { res.writeHead(403); return res.end(); }
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 5e6) req.destroy(); });
      req.on('end', async () => {
        const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        try {
          const { tool, args: targs } = JSON.parse(body);
          if (!RPC_TOOLS.has(tool)) return send({ error: `tool "${tool}" is not available inside execute_code (allowed: ${[...RPC_TOOLS].join(', ')})` });
          send({ result: await ctx.callTool(tool, targs || {}, call) });
        } catch (e) { send({ error: e.message }); }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    return await new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: a.cwd || undefined, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HEK_RPC: `http://127.0.0.1:${port}`, HEK_TOKEN: token, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', PYTHONIOENCODING: 'utf-8' } });
      let out = '', err = '', done = false;
      const finish = (note) => {
        if (done) return; done = true; clearTimeout(timer);
        try { server.close(); } catch {}
        fs.unlink(file).catch(() => {});
        let r = '';
        if (out) r += 'STDOUT:\n' + truncate(out, 30000);
        if (err) r += (r ? '\n' : '') + 'STDERR:\n' + truncate(err, 10000);
        if (note) r += (r ? '\n' : '') + note;
        resolve(r || 'OK (no output)');
      };
      const timer = setTimeout(() => { killTree(child); finish(`TIMED OUT after ${timeoutMs / 1000}s`); }, timeoutMs);
      if (call.signal) call.signal.addEventListener('abort', () => { killTree(child); finish('ABORTED'); }, { once: true });
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => finish('spawn error: ' + e.message));
      child.on('exit', (code) => finish(code ? `EXIT CODE: ${code}` : ''));
    });
  }

  const defs = [
    {
      name: 'run_command', toolset: 'terminal', category: 'control',
      description: 'Run a shell command (cmd.exe on Windows, sh elsewhere) and return stdout/stderr/exit code. timeout_s default 60 (max 600). For long-running or interactive jobs (dev servers, watchers, builds) set background=true and manage them with the process tool. Dangerous commands (recursive delete, format, shutdown, force-push…) always require explicit approval. Needs user permission.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout_s: { type: 'number' }, background: { type: 'boolean' } }, required: ['command'] },
      confirm: (a) => (isDangerous(a.command)
        ? { key: 'danger', never_always: true, title: '⚠️ دستور خطرناک — با دقت بخون', detail: a.command }
        : { title: a.background ? 'اجرای دستور (پس‌زمینه)' : 'اجرای دستور', detail: a.command }),
      run: async (a, call) => {
        if (a.background) {
          const rec = startBackground(a.command, a.cwd);
          await sleep(1500);
          return `Started background process ${rec.id} (pid ${rec.proc.pid}). Status: ${rec.status}.\nOutput so far:\n${truncate(rec.buf, 4000) || '(none yet)'}\nUse process(action="log", id="${rec.id}") to read more, "kill" to stop.`;
        }
        return runForeground(a.command, a.cwd, Math.max(1, Math.min(600, +a.timeout_s || 60)), call.signal);
      },
    },
    {
      name: 'process', toolset: 'terminal', category: 'control',
      description: 'Manage background processes started with run_command(background=true): list, log (tail output), write (send stdin text), wait (block up to N seconds for exit), kill.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'log', 'write', 'wait', 'kill'] }, id: { type: 'string' }, input: { type: 'string' }, tail_chars: { type: 'number' }, wait_s: { type: 'number' } }, required: ['action'] },
      run: async (a) => {
        if (a.action === 'list') return [...procs.values()].map((p) => `${p.id}  ${p.status}${p.code != null ? ' (exit ' + p.code + ')' : ''}  ${Math.round((Date.now() - p.started) / 1000)}s  ${p.command.slice(0, 80)}`).join('\n') || '(no background processes)';
        const p = procs.get(a.id);
        if (!p) return `ERROR: no process "${a.id}"`;
        if (a.action === 'log') return truncate(p.buf, Math.max(500, Math.min(60000, +a.tail_chars || 8000))) || '(no output)';
        if (a.action === 'write') { if (p.status !== 'running') return 'ERROR: process not running'; p.proc.stdin.write(String(a.input || '') + '\n'); await sleep(800); return truncate(p.buf.slice(-3000), 3000); }
        if (a.action === 'wait') { const end = Date.now() + Math.min(120, +a.wait_s || 10) * 1000; while (p.status === 'running' && Date.now() < end) await sleep(300); return `${p.status}${p.code != null ? ' (exit ' + p.code + ')' : ''}\n${truncate(p.buf.slice(-4000), 4000)}`; }
        if (a.action === 'kill') { killTree(p.proc); p.status = 'killed'; return `killed ${p.id}`; }
        return 'ERROR: unknown action';
      },
    },
    {
      name: 'execute_code', toolset: 'code', category: 'write',
      description: 'Run a JavaScript (built-in Node) or Python script to do multi-step work in ONE call: loops, data processing, calling many tools programmatically. Inside the script use `await tools.web_search({query})`, `tools.web_extract`, `tools.read_file`, `tools.write_file`, `tools.patch`, `tools.search_files`, `tools.list_dir`, `tools.run_command` (JS: await; Python: tools.read_file(path="…")). Each returns text. print/console.log what you want back. Timeout default 60s (max 300). Needs user permission.',
      parameters: { type: 'object', properties: { language: { type: 'string', enum: ['javascript', 'python'] }, code: { type: 'string' }, timeout_s: { type: 'number' }, cwd: { type: 'string' } }, required: ['code'] },
      confirm: (a) => ({ title: `اجرای کد (${a.language || 'javascript'})`, detail: String(a.code).slice(0, 800) }),
      run: execCode,
    },
  ];

  ctx.disposers.push(() => { for (const p of procs.values()) if (p.status === 'running') killTree(p.proc); });
  return { defs, isDangerous };
}

module.exports = { register, isDangerous };
