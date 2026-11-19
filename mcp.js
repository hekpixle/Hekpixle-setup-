// Minimal MCP (Model Context Protocol) client: stdio servers and streamable-HTTP servers.
// Servers are configured in Settings → Tools as JSON (same shape as Claude Desktop):
//   { "files": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","C:/Users/me"] },
//     "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } } }
const { spawn } = require('child_process');
const { httpFetch, truncate } = require('./util');

const WIN = process.platform === 'win32';
const PROTO = '2024-11-05';

class StdioClient {
  constructor(name, cfg) { this.name = name; this.cfg = cfg; this.id = 0; this.pending = new Map(); this.buf = ''; this.stderr = ''; }
  async start() {
    const c = this.cfg;
    this.proc = spawn(c.command, c.args || [], { env: { ...process.env, ...(c.env || {}) }, cwd: c.cwd || undefined, shell: WIN, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try { const m = JSON.parse(line); if (m.id != null && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.t); m.error ? p.rej(new Error(m.error.message || JSON.stringify(m.error))) : p.res(m.result); } } catch { /* non-JSON log line */ }
      }
    });
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    this.proc.on('exit', () => { for (const p of this.pending.values()) { clearTimeout(p.t); p.rej(new Error('MCP server exited. ' + this.stderr.trim().slice(-300))); } this.pending.clear(); this.dead = true; });
    this.proc.on('error', (e) => { this.dead = true; for (const p of this.pending.values()) p.rej(e); });
    await this.request('initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'hekpixle', version: '0.13.0' } }, 60000);
    this.notify('notifications/initialized', {});
  }
  request(method, params, timeout = 30000) {
    return new Promise((res, rej) => {
      if (this.dead) return rej(new Error('MCP server is not running'));
      const id = ++this.id;
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`MCP request "${method}" timed out`)); }, timeout);
      this.pending.set(id, { res, rej, t });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) { try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch {} }
  stop() { try { this.proc && this.proc.kill(); } catch {} this.dead = true; }
}

class HttpClient {
  constructor(name, cfg, proxy) { this.name = name; this.cfg = cfg; this.proxy = proxy; this.id = 0; this.session = null; }
  async post(body, timeout) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.cfg.headers || {}) };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const r = await httpFetch(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) }, this.proxy);
    const sid = r.headers.get('mcp-session-id'); if (sid) this.session = sid;
    if (!r.ok && r.status !== 202) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    if (body.id == null) return null;
    const text = await r.text();
    const ct = r.headers.get('content-type') || '';
    let msg = null;
    if (ct.includes('text/event-stream')) {
      for (const block of text.split(/\n\n+/)) {
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.id === body.id) msg = m; } catch {}
      }
    } else { try { msg = JSON.parse(text); } catch {} }
    if (!msg) throw new Error('empty/invalid MCP response');
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }
  async start() {
    await this.request('initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'hekpixle', version: '0.13.0' } }, 60000);
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, 15000).catch(() => {});
  }
  request(method, params, timeout = 30000) { return this.post({ jsonrpc: '2.0', id: ++this.id, method, params }, timeout); }
  stop() { if (this.session) httpFetch(this.cfg.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.session, ...(this.cfg.headers || {}) } }, this.proxy).catch(() => {}); }
}

const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

function register(ctx) {
  const servers = new Map(); // name -> { client, cfg, tools:[], error }
  let sig = '';

  async function connect(name, cfg) {
    const rec = { cfg, tools: [], error: null, client: null };
    servers.set(name, rec);
    try {
      const client = cfg.url ? new HttpClient(name, cfg, (ctx.getSettings().web || {}).proxyUrl) : new StdioClient(name, cfg);
      if (!cfg.url && !cfg.command) throw new Error('needs "command" or "url"');
      await client.start();
      rec.client = client;
      let cursor, all = [];
      do { const r = await client.request('tools/list', cursor ? { cursor } : {}, 30000); all = all.concat(r.tools || []); cursor = r.nextCursor; } while (cursor && all.length < 300);
      rec.tools = all;
    } catch (e) { rec.error = e.message; try { rec.client && rec.client.stop(); } catch {} }
  }

  async function sync() {
    const cfg = ctx.getSettings().mcpServers;
    const s = JSON.stringify(cfg || {});
    if (s === sig) return;
    sig = s;
    for (const rec of servers.values()) try { rec.client && rec.client.stop(); } catch {}
    servers.clear();
    if (!cfg || typeof cfg !== 'object') return;
    await Promise.all(Object.entries(cfg).filter(([, c]) => c && c.disabled !== true).map(([n, c]) => connect(n, c)));
  }

  // Tool defs are rebuilt each time they are requested (servers may come and go).
  function defs() {
    const out = [];
    for (const [name, rec] of servers) {
      for (const t of rec.tools) {
        const full = `mcp__${safe(name)}__${safe(t.name)}`.slice(0, 64);
        out.push({
          name: full, toolset: 'mcp', category: 'control',
          description: `[MCP:${name}] ${t.description || t.name}`.slice(0, 1000),
          parameters: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} },
          confirm: rec.cfg.autoApprove ? null : (a) => ({ title: `ابزار MCP: ${name} / ${t.name}`, detail: truncate(JSON.stringify(a), 600) }),
          run: async (a) => {
            const r = await rec.client.request('tools/call', { name: t.name, arguments: a || {} }, 120000);
            const text = (r.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type} content omitted]`)).join('\n');
            return (r.isError ? 'ERROR: ' : '') + truncate(text || JSON.stringify(r), 30000);
          },
        });
      }
    }
    return out;
  }

  const status = () => [...servers].map(([name, r]) => ({ name, ok: !r.error, tools: r.tools.length, error: r.error }));
  ctx.disposers.push(() => { for (const r of servers.values()) try { r.client && r.client.stop(); } catch {} });
  return { sync, defs, status };
}

module.exports = { register };
