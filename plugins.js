// Plugins: drop a .js file (or a folder with index.js) into <userData>/plugins/ — or add it from Settings → Plugins.
//
//   // @description What this plugin does          (optional, shown in Settings)
//   // @version 1.0.0                              (optional)
//   module.exports = (api) => {
//     api.registerTool({ name, description, parameters, run: async (args, call) => 'text' });
//     api.on('pre_tool_call',  ({ name, args, source }) => ({ block: 'reason' }));   // optional
//     api.on('post_tool_call', ({ name, args, result }) => {});
//     api.on('system_prompt',  () => 'extra instructions');
//     api.onUnload(() => { /* clear timers, close handles */ });
//   }
const fs = require('fs/promises');
const path = require('path');

const EXAMPLE_NAME = 'example-hello';
const EXAMPLE_CODE = `// @description Example plugin: adds a "hello_plugin" tool (safe to delete)
// @version 1.0.0
module.exports = (api) => {
  api.registerTool({
    name: 'hello_plugin',
    description: 'Example plugin tool. Greets someone by name.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    confirm: false, // no permission prompt (use only for harmless tools)
    run: async (args) => 'Hello, ' + args.name + '! (from the example plugin)',
  });
  api.on('system_prompt', () => 'The example plugin is installed: you may use hello_plugin to greet people.');
};
`;

const safeName = (n) => String(n || '').replace(/\.js$/i, '').replace(/[^A-Za-z0-9_\-؀-ۿ]/g, '_').replace(/^[._]+/, '').slice(0, 60);

function register(ctx) {
  const dir = () => path.join(ctx.userDataDir(), 'plugins');
  const stateFile = () => path.join(dir(), '.state.json');
  const tools = [];
  const hooks = { pre_tool_call: [], post_tool_call: [], system_prompt: [] };
  const unloaders = [];
  let info = []; // [{ name, kind, enabled, loaded, error, tools, description, version }]

  async function readState() { try { return JSON.parse(await fs.readFile(stateFile(), 'utf8')); } catch { return { disabled: [] }; } }
  async function writeState(st) { await fs.mkdir(dir(), { recursive: true }); await fs.writeFile(stateFile(), JSON.stringify(st, null, 2)); }

  async function readMeta(file, folder) {
    const meta = { description: '', version: '' };
    try {
      const src = (await fs.readFile(file, 'utf8')).slice(0, 4000);
      const d = src.match(/@description\s+(.+)/); if (d) meta.description = d[1].trim();
      const v = src.match(/@version\s+(\S+)/); if (v) meta.version = v[1].trim();
    } catch {}
    if (folder) {
      try { const pj = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')); meta.description = meta.description || pj.description || ''; meta.version = meta.version || pj.version || ''; } catch {}
    }
    return meta;
  }

  async function load() {
    for (const f of unloaders.splice(0)) { try { await f(); } catch {} }
    tools.length = 0; info = [];
    for (const k of Object.keys(hooks)) hooks[k].length = 0;
    let items = [];
    try { items = await fs.readdir(dir(), { withFileTypes: true }); } catch { return; }
    const st = await readState();
    const disabled = new Set(st.disabled || []);
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      if (it.name.startsWith('.') || it.name.startsWith('_')) continue; // .data, .state.json, hidden/disabled-by-prefix
      let file = null, folder = null;
      if (it.isFile() && it.name.endsWith('.js')) file = path.join(dir(), it.name);
      else if (it.isDirectory()) { folder = path.join(dir(), it.name); file = path.join(folder, 'index.js'); }
      if (!file) continue;
      const pname = it.name.replace(/\.js$/, '');
      const rec = { name: pname, kind: folder ? 'folder' : 'file', enabled: !disabled.has(pname), loaded: false, error: '', tools: [], ...(await readMeta(file, folder)) };
      info.push(rec);
      if (!rec.enabled) continue;
      const mine = [];
      try {
        try { await fs.access(file); } catch { throw new Error(folder ? 'index.js پیدا نشد' : 'فایل پیدا نشد'); }
        delete require.cache[require.resolve(file)];
        const mod = require(file);
        const fn = typeof mod === 'function' ? mod : mod && mod.register;
        if (typeof fn !== 'function') throw new Error('plugin must export a function (api) => {...}');
        await fn({
          registerTool: (def) => {
            if (!def || !def.name || typeof def.run !== 'function') throw new Error('registerTool needs {name, description, parameters, run}');
            const tname = String(def.name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
            mine.push({
              name: tname, toolset: 'plugins', category: def.category || 'control',
              description: def.description || def.name, parameters: def.parameters || { type: 'object', properties: {} },
              confirm: def.confirm === false ? null : (def.confirm || ((a) => ({ title: `ابزار افزونه: ${def.name}`, detail: JSON.stringify(a).slice(0, 500) }))),
              run: def.run,
            });
          },
          on: (h, f) => { if (hooks[h] && typeof f === 'function') hooks[h].push(f); },
          onUnload: (f) => { if (typeof f === 'function') unloaders.push(f); },
          dataDir: path.join(dir(), '.data', pname),
          pluginDir: folder || dir(),
          getSettings: ctx.getSettings,
          log: (...a) => console.log(`[plugin ${pname}]`, ...a),
        });
        tools.push(...mine);
        rec.tools = mine.map((t) => t.name);
        rec.loaded = true;
      } catch (e) { rec.error = e.message || String(e); }
    }
  }

  async function uniqueName(base, ext) {
    let n = base, i = 2;
    for (;;) { try { await fs.access(path.join(dir(), n + ext)); n = `${base}-${i++}`; } catch { return n; } }
  }

  return {
    load,
    defs: () => tools,
    list: () => info.map((x) => ({ ...x, tools: [...x.tools] })),
    status: () => ({ loaded: info.filter((x) => x.loaded).map((x) => x.name), errors: info.filter((x) => x.error).map((x) => `${x.name}: ${x.error}`), dir: dir() }),
    // Copy a .js file or a folder (with index.js) into the plugins folder.
    async installFrom(src) {
      const st = await fs.stat(src);
      await fs.mkdir(dir(), { recursive: true });
      if (st.isDirectory()) {
        try { await fs.access(path.join(src, 'index.js')); } catch { throw new Error('این پوشه فایل index.js ندارد.'); }
        const name = safeName(path.basename(src)) || 'plugin';
        const dest = path.join(dir(), name);
        await fs.rm(dest, { recursive: true, force: true });
        await fs.cp(src, dest, { recursive: true });
        await load(); return name;
      }
      if (!/\.js$/i.test(src)) throw new Error('فقط فایل .js یا پوشه‌ی دارای index.js پذیرفته می‌شود.');
      const name = safeName(path.basename(src)) || 'plugin';
      await fs.copyFile(src, path.join(dir(), name + '.js'));
      await load(); return name;
    },
    async installCode(name, code) {
      code = String(code || '');
      if (!code.trim()) throw new Error('کد خالی است.');
      const n = safeName(name) || await uniqueName('my-plugin', '.js');
      await fs.mkdir(dir(), { recursive: true });
      await fs.writeFile(path.join(dir(), n + '.js'), code, 'utf8');
      await load(); return n;
    },
    async installExample() { return this.installCode(EXAMPLE_NAME, EXAMPLE_CODE); },
    exampleCode: () => EXAMPLE_CODE,
    async setEnabled(name, on) {
      const st = await readState(); const s = new Set(st.disabled || []);
      if (on) s.delete(name); else s.add(name);
      await writeState({ disabled: [...s] }); await load();
    },
    async remove(name) {
      const n = safeName(name);
      const rec = info.find((x) => x.name === n);
      if (!rec) throw new Error('افزونه پیدا نشد.');
      const p = rec.kind === 'folder' ? path.join(dir(), n) : path.join(dir(), n + '.js');
      try { await ctx.electron.shell.trashItem(p); } catch { await fs.rm(p, { recursive: true, force: true }); }
      const st = await readState(); await writeState({ disabled: (st.disabled || []).filter((x) => x !== n) });
      await load();
    },
    async pre(info) { for (const f of hooks.pre_tool_call) { try { const r = await f(info); if (r && r.block) return String(r.block); } catch {} } return null; },
    async post(info) { for (const f of hooks.post_tool_call) { try { await f(info); } catch {} } },
    async promptExtras() { const o = []; for (const f of hooks.system_prompt) { try { const r = await f(); if (r) o.push(String(r)); } catch {} } return o.join('\n'); },
  };
}
module.exports = { register };
