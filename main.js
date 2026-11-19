const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, Notification } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');
const { exec, spawn } = require('child_process');
const os = require('os');
const telegram = require('./telegram');

// Profiles: `Hekpixle.exe --profile=work` keeps settings/memory/skills in a separate folder.
{
  const m = process.argv.find((a) => /^--profile=/.test(a));
  const n = m ? m.split('=')[1].replace(/[^a-zA-Z0-9_-]/g, '') : '';
  if (n) app.setPath('userData', path.join(app.getPath('appData'), 'Hekpixle-' + n));
}

let win;

// ---------- storage ----------
const dataFile = (n) => path.join(app.getPath('userData'), n);
async function readJson(n, d) {
  try { return JSON.parse(await fs.readFile(dataFile(n), 'utf8')); } catch { return d; }
}
async function writeJson(n, v) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(dataFile(n), JSON.stringify(v, null, 2));
}

const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  theme: 'light',
  reduceMotion: false,
  llmProxyUrl: '',
  personality: '',           // Custom personality instructions — appended to system prompt (like Hermes SOUL.md)
  fallbackBaseUrl: '',      // Fallback LLM Base URL — used when primary fails (like Hermes fallback providers)
  fallbackApiKey: '',        // Fallback API Key
  fallbackModel: '',        // Fallback model name
  maxSteps: 30,              // max tool-loop iterations per request
  approvalMode: 'manual',    // 'manual' = ask before risky actions | 'off' = never ask (dangerous commands still ask)
  alwaysAllow: [],           // tool names the user chose "always allow" for
  workspaceDir: '',          // default folder for search_files + project context files (AGENTS.md ...)
  extraSkillsDir: '',        // optional extra folder with skills (agentskills.io layout)
  browserVisible: true,      // show the agent browser window
  compressAtChars: 90000,    // summarize older turns when the conversation gets this long
  toolsets: {},              // { web: false } disables a toolset
  web: { provider: 'duckduckgo', apiKey: '', searxUrl: '', proxyUrl: '' },
  media: { baseUrl: '', apiKey: '', visionMode: 'direct', visionModel: '', visionBaseUrl: '', visionApiKey: '', imageModel: '', ttsModel: '', ttsVoice: '', sttModel: '' },
  mcpServers: {},            // { name: { command, args, env } | { url, headers } }
  cron: { autoAllowReads: true, autoAllowWrites: false },
  telegram: {
    botToken: '',
    proxyUrl: '',                  // e.g. 'http://127.0.0.1:7890' or 'socks5://127.0.0.1:1080' — for users in regions where Telegram is blocked
    allowedUserIds: [],            // e.g. [123456789] — when non-empty, only these users can talk to the bot
    replyOnUnauthorized: true,    // send a "not authorized" message to unauthorized users
    autoAllowReads: true,
    autoAllowWrites: false,
    onlyWhenMentioned: true,
    autoStart: false,
  },
};

function mergeSettings(raw) {
  const r = raw || {};
  const d = DEFAULT_SETTINGS;
  return {
    ...d, ...r,
    telegram: { ...d.telegram, ...(r.telegram || {}) },
    web: { ...d.web, ...(r.web || {}) },
    media: { ...d.media, ...(r.media || {}) },
    cron: { ...d.cron, ...(r.cron || {}) },
    toolsets: { ...(r.toolsets || {}) },
  };
}
let settingsCache = mergeSettings(readJsonSync('settings.json'));

// ---------- events to the UI ----------
function emit(ev) {
  try { if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev); } catch {}
}

// ---------- in-app permission (no Windows dialog) ----------
// Resolves true | false | 'always' (user pressed "always allow this tool").
const pendingPerms = new Map();
const pendingClarify = new Map();

function confirm(title, detail, toolName, canAlways) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(false);
    const id = crypto.randomUUID();
    pendingPerms.set(id, resolve);
    emit({ type: 'permission', id, title, detail, tool: toolName || '', canAlways: !!canAlways });
    try { win.flashFrame(true); } catch {}
  });
}

function askUser(question, choices) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve('');
    const id = crypto.randomUUID();
    pendingClarify.set(id, resolve);
    emit({ type: 'clarify', id, question, choices: choices || [] });
    try { win.flashFrame(true); } catch {}
  });
}

function denyAllPending() {
  for (const r of pendingPerms.values()) r(false);
  pendingPerms.clear();
  for (const r of pendingClarify.values()) r('');
  pendingClarify.clear();
}

async function addAlwaysAllow(name) {
  const raw = await readJson('settings.json', {});
  const list = Array.isArray(raw.alwaysAllow) ? raw.alwaysAllow : [];
  if (!list.includes(name)) { list.push(name); raw.alwaysAllow = list; await writeJson('settings.json', raw); settingsCache = mergeSettings(raw); }
}

// ============================================================================
// Tool registry: every tool is { name, toolset, category, description, parameters, confirm?, run }
// category: 'read' | 'control' | 'write'. Modules live in ./lib.
// ============================================================================
const SAFE_TOOLS = new Set(['save_memory', 'recall_memory', 'forget_memory', 'session_search', 'todo', 'clarify', 'skills_list', 'skill_view', 'file_history', 'process']);
const disposers = [];
const modules = {};
let modulesReady = false;

const legacyDefs = () => [
  {
    name: 'launch_app', toolset: 'desktop', category: 'control',
    description: 'Launch an application by name (e.g. "chrome", "notepad", "explorer", "calc", "code", "word", "excel") or full path. Pass optional args such as URLs/files. Common app names are auto-resolved on Windows. After launching, use computer(screenshot) to see it. Needs user permission.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, wait_ms: { type: 'number', description: 'wait after launch (max 10000)' } }, required: ['name'] },
    confirm: (a) => ({ title: 'اجرای برنامه', detail: `${a.name}${Array.isArray(a.args) && a.args.length ? ' ' + a.args.map((x) => `"${x}"`).join(' ') : ''}` }),
    run: (a) => launchApp(a.name, Array.isArray(a.args) ? a.args : [], a.wait_ms || 0),
  },
  {
    name: 'focus_app', toolset: 'desktop', category: 'control',
    description: 'Bring an already-running application window to the foreground by matching part of its title. Needs user permission.',
    parameters: { type: 'object', properties: { title_contains: { type: 'string' } }, required: ['title_contains'] },
    confirm: (a) => ({ title: 'فعال‌سازی پنجره', detail: a.title_contains }),
    run: (a) => focusApp(a.title_contains),
  },
  {
    name: 'send_keys', toolset: 'desktop', category: 'control',
    description: 'Legacy: send keystrokes in Windows SendKeys syntax to the focused window ({ENTER}, ^c = Ctrl+C, %{F4} = Alt+F4). Prefer computer(action="key"/"type") which also returns a screenshot. Needs user permission.',
    parameters: { type: 'object', properties: { keys: { type: 'string' }, delay_ms: { type: 'number' } }, required: ['keys'] },
    confirm: (a) => ({ title: 'ارسال کلید', detail: a.keys }),
    run: (a) => sendKeys(a.keys, a.delay_ms || 300),
  },
  {
    name: 'save_memory', toolset: 'memory', category: 'read',
    description: 'Save a key fact about the user, their preferences or ongoing projects; persists across sessions. Use when the user shares personal info, preferences, project details, recurring tasks, deadlines. No permission needed.',
    parameters: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, category: { type: 'string', enum: ['identity', 'preference', 'project', 'schedule', 'note'] } }, required: ['key', 'value'] },
    run: async (a) => {
      const mem = await readJson('memory.json', {});
      if (!mem.entries) mem.entries = [];
      mem.entries = mem.entries.filter((e) => e.key !== a.key);
      mem.entries.push({ key: a.key, value: a.value, category: a.category || 'note', savedAt: new Date().toISOString() });
      await writeJson('memory.json', mem);
      return `OK: memory saved — "${a.key}: ${a.value}"`;
    },
  },
  {
    name: 'recall_memory', toolset: 'memory', category: 'read',
    description: 'Search persistent memory for entries matching a keyword (or list all).',
    parameters: { type: 'object', properties: { keyword: { type: 'string' } } },
    run: async (a) => {
      const entries = (await readJson('memory.json', {})).entries || [];
      if (!entries.length) return 'No memories saved yet.';
      const kw = (a.keyword || '').toLowerCase().trim();
      const m = kw ? entries.filter((e) => e.key.toLowerCase().includes(kw) || String(e.value).toLowerCase().includes(kw)) : entries;
      if (!m.length) return `No memories matching "${a.keyword}".`;
      return (kw ? 'Matching memories:\n' : 'All memories:\n') + m.map((e) => `• ${e.key}: ${e.value} [${e.category || 'note'}]`).join('\n');
    },
  },
];

function allDefs() {
  const out = [...legacyDefs()];
  for (const k of ['files', 'procs', 'computer', 'browser', 'web', 'skills', 'cron', 'media', 'agentTools']) if (modules[k]) out.push(...(modules[k].defs || []));
  if (modules.mcp) out.push(...modules.mcp.defs());
  if (modules.plugins) out.push(...modules.plugins.defs());
  const seen = new Set();
  return out.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)));
}

const TOOLSETS = ['files', 'terminal', 'code', 'web', 'browser', 'desktop', 'vision', 'media', 'memory', 'skills', 'planning', 'delegation', 'cron', 'messaging', 'mcp', 'plugins'];

function activeDefs(s, o) {
  const allowed = o && o.allowedToolsets ? new Set(o.allowedToolsets) : null;
  const exclude = o && o.excludeTools ? new Set(o.excludeTools) : null;
  return allDefs().filter((d) => (s.toolsets || {})[d.toolset] !== false && (!allowed || allowed.has(d.toolset)) && !(exclude && exclude.has(d.name)));
}
const toOpenAI = (d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters || { type: 'object', properties: {} } } });

// Unattended sources (telegram / cron) never open UI prompts: auto-allow by category + settings.
function policyFor(source, s) {
  const t = (source === 'telegram' ? s.telegram : s.cron) || {};
  const reads = t.autoAllowReads !== false;
  const writes = !!t.autoAllowWrites;
  return (def) => {
    if (SAFE_TOOLS.has(def.name)) return true;
    if (def.category === 'write') return writes;
    return reads; // 'read' and 'control'
  };
}

// Runs one tool with permissions, hooks and error handling. Returns { text, image? }.
async function executeTool(name, args, call, tools) {
  const def = (tools || allDefs()).find((d) => d.name === name);
  if (!def) return { text: `ERROR: Unknown tool "${name}".` };
  const s = call.s || settingsCache;
  if ((s.toolsets || {})[def.toolset] === false) return { text: `ERROR: toolset "${def.toolset}" is disabled in Settings.` };
  try {
    if (modules.plugins) {
      const blocked = await modules.plugins.pre({ name, args, source: call.source });
      if (blocked) return { text: 'DENIED by plugin: ' + blocked };
    }
    const c = def.confirm ? def.confirm(args, call) : null;
    if (call.source !== 'desktop') {
      if (c && c.key === 'danger') return { text: 'DENIED: dangerous command is never auto-allowed outside the desktop app. Tell the user to run it from the desktop UI.' };
      if (!call.policy(def, args)) return { text: `DENIED by ${call.source} auto-allow policy. Tell the user this action is not auto-allowed there.` };
    } else if (c) {
      const danger = c.key === 'danger';
      const skip = !danger && (s.approvalMode === 'off' || (s.alwaysAllow || []).includes(def.name));
      if (!skip) {
        const res = await confirm(c.title, c.detail, def.name, !c.never_always && !danger);
        if (!res) return { text: 'DENIED by user.' };
        if (res === 'always') await addAlwaysAllow(def.name);
        if (def.onApprove) def.onApprove(c.key, call);
      } else if (def.onApprove) def.onApprove(c.key, call);
    }
    let r = await def.run(args || {}, call);
    if (typeof r === 'string') r = { text: r };
    else if (!r || typeof r !== 'object') r = { text: String(r == null ? 'OK' : r) };
    r.text = String(r.text == null ? 'OK' : r.text);
    if (r.text.length > 100000) r.text = r.text.slice(0, 100000) + '\n...[truncated]';
    if (modules.plugins) modules.plugins.post({ name, args, result: r.text }).catch(() => {});
    return r;
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.message === 'STOPPED')) return { text: 'ERROR: stopped.' };
    return { text: 'ERROR: ' + (e && e.message ? e.message : String(e)) };
  }
}

const statusOf = (r) => (r.startsWith('DENIED') ? 'denied' : r.startsWith('ERROR') ? 'error' : 'ok');

// Used by execute_code RPC and vision_analyze("screen")
async function callToolByName(name, args, parentCall, raw) {
  const r = await executeTool(name, args, { ...parentCall, state: parentCall.state });
  return raw ? r : r.text;
}

async function runSubAgent(t, parent) {
  const toolsets = Array.isArray(t.toolsets) && t.toolsets.length ? t.toolsets : ['web', 'files', 'terminal', 'code', 'vision', 'mcp'];
  const goal = String(t.goal || '').trim();
  const res = await runAgent([{ role: 'user', content: `GOAL:\n${goal}${t.context ? '\n\nCONTEXT:\n' + t.context : ''}` }], {
    source: parent.source, signal: parent.signal, depth: 1, maxSteps: 15, policy: parent.policy,
    allowedToolsets: toolsets, excludeTools: [...modules.agentTools.SUB_BLOCKED],
    systemExtra: 'You are a focused sub-agent working for another agent. Complete ONLY the goal. You cannot ask the user questions. When finished, reply with a concise, factual summary of what you found/did (include key data, file paths, URLs). No pleasantries.',
  });
  if (res.error && res.error !== 'STOPPED' && !(res.added || []).length) throw new Error(res.error);
  const last = [...(res.added || [])].reverse().find((m) => m.role === 'assistant' && m.content);
  return String((last && last.content) || '(no summary produced)').slice(0, 8000);
}

async function runUnattended(job) {
  const s = mergeSettings(await readJson('settings.json', {}));
  let prefix = '';
  for (const sk of job.skills || []) { const t = await modules.skills.readSkill(sk); if (t) prefix += `[Skill: ${sk}]\n${t}\n\n`; }
  const res = await runAgent([{ role: 'user', content: prefix + job.prompt }], {
    source: 'cron', maxSteps: 25, policy: policyFor('cron', s), excludeTools: ['clarify', 'cronjob', 'delegate_task'],
    systemExtra: `You are running as an UNATTENDED scheduled job named "${job.name}". The user is not present: do not ask questions. Your final message is delivered to the user as the job result, so make it complete and self-contained (Persian if the task is Persian).`,
  });
  if (res.error) throw new Error(res.error);
  const last = [...res.added].reverse().find((m) => m.role === 'assistant' && m.content);
  return (last && last.content) || '(no output)';
}

async function deliverCron(job, text, status) {
  emit({ type: 'cron-result', name: job.name, status, text: String(text).slice(0, 4000) });
  if (job.deliver === 'telegram') await telegram.sendText(`⏰ ${job.name}\n\n${text}`);
  else if (job.deliver !== 'local') {
    try { new Notification({ title: `Hekpixle — ${job.name}`, body: String(text).replace(/\s+/g, ' ').slice(0, 220) }).show(); } catch {}
  }
}

async function ensureModules() {
  if (modulesReady) { try { await modules.mcp.sync(); } catch {} return; }
  modulesReady = true;
  const ctx = {
    electron: require('electron'),
    getSettings: () => settingsCache,
    userDataDir: () => app.getPath('userData'),
    disposers,
    askUser,
    callTool: callToolByName,
    runSubAgent,
    runUnattended,
    deliverCron,
    sendTelegram: (text, chatId) => telegram.sendText(text, chatId),
  };
  modules.files = require('./files').register(ctx);
  modules.procs = require('./procs').register(ctx);
  modules.computer = { defs: require('./computer').register(ctx) };
  modules.browser = { defs: require('./browser').register(ctx) };
  modules.web = { defs: require('./web').register(ctx) };
  modules.skills = require('./skills').register(ctx);
  modules.cron = require('./cron').register(ctx);
  modules.media = require('./media').register(ctx);
  modules.agentTools = require('./agent-tools').register(ctx);
  modules.mcp = require('./mcp').register(ctx);
  modules.plugins = require('./plugins').register(ctx);
  modules.files = { ...modules.files, defs: modules.files.defs };
  modules.procs = { ...modules.procs, defs: modules.procs.defs };
  await modules.skills.seed();
  await modules.plugins.load();
  try { await modules.mcp.sync(); } catch (e) { console.warn('MCP sync failed:', e.message); }
  modules.cron.start();
}


// ============================================================================
// App launch + automation helpers (Windows / macOS / Linux)
// ============================================================================

// Common app-name → exe path resolutions. Each candidate is tried in order.
const WIN_APP_PATHS = {
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'chrome', // fall back to PATH lookup via 'start chrome'
  ],
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'msedge',
  ],
  firefox: [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    'firefox',
  ],
  brave: [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'brave',
  ],
  notepad: ['notepad.exe'],
  explorer: ['explorer.exe'],
  calc: ['calc.exe'],
  cmd: ['cmd.exe'],
  powershell: ['powershell.exe'],
  code: ['code.cmd'],
  word: [
    'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
    'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
    'C:\\Program Files\\Microsoft Office\\Office16\\WINWORD.EXE',
    'winword.exe',
  ],
  excel: [
    'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
    'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
    'excel.exe',
  ],
  powerpoint: [
    'C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
    'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\POWERPNT.EXE',
    'powerpnt.exe',
  ],
};

const MAC_APP_PATHS = {
  chrome: '/Applications/Google Chrome.app',
  edge: '/Applications/Microsoft Edge.app',
  firefox: '/Applications/Firefox.app',
  brave: '/Applications/Brave Browser.app',
  safari: '/Applications/Safari.app',
  notepad: null, // no equivalent; use TextEdit
  textedit: '/Applications/TextEdit.app',
  code: '/Applications/Visual Studio Code.app',
  word: '/Applications/Microsoft Word.app',
  excel: '/Applications/Microsoft Excel.app',
  powerpoint: '/Applications/Microsoft PowerPoint.app',
  notes: '/Applications/Notes.app',
  terminal: '/Applications/Utilities/Terminal.app',
};

const LINUX_APP_CMDS = {
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium'],
  edge: ['microsoft-edge'],
  firefox: ['firefox'],
  brave: ['brave-browser', 'brave'],
  code: ['code'],
};

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// Resolve an app name to a launchable command (returns {exe, args} style).
async function resolveApp(name, userArgs) {
  const platform = process.platform;
  const lower = String(name).toLowerCase();
  const args = Array.isArray(userArgs) ? userArgs.slice() : [];

  if (platform === 'win32') {
    const candidates = WIN_APP_PATHS[lower];
    if (candidates) {
      for (const c of candidates) {
        if (await fileExists(c)) return { exe: c, args };
      }
    }
    // Treat name as a path or PATH-resolvable exe
    return { exe: name, args };
  }

  if (platform === 'darwin') {
    const appPath = MAC_APP_PATHS[lower];
    if (appPath) {
      return { exe: 'open', args: ['-a', appPath, ...args] };
    }
    // If it looks like a .app path, use open -a
    if (/\.app$/.test(name)) {
      return { exe: 'open', args: ['-a', name, ...args] };
    }
    // Fall back: open URL or PATH-resolvable binary
    return { exe: 'open', args: [name, ...args] };
  }

  // Linux
  const cmds = LINUX_APP_CMDS[lower];
  if (cmds) {
    for (const c of cmds) {
      // We can't easily check PATH, just return the first candidate
      return { exe: c, args };
    }
  }
  return { exe: name, args };
}

async function launchApp(name, userArgs, waitMs) {
  const { exe, args } = await resolveApp(name, userArgs);
  const platform = process.platform;
  const wait = Math.max(0, Math.min(10000, waitMs | 0));

  return new Promise((resolve, reject) => {
    let child;
    if (platform === 'win32') {
      // Use cmd /c start so the agent process does not block on the GUI app
      const escapedExe = /[ \t]/.test(exe) ? `"${exe}"` : exe;
      const escapedArgs = args
        .map((a) => (/[ \t"]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a))
        .join(' ');
      const cmd = `start "" ${escapedExe} ${escapedArgs}`.trim();
      child = exec(cmd, { windowsHide: false, timeout: 15000 }, (err) => {
        if (err) return reject(new Error('launch failed: ' + err.message));
      });
    } else if (platform === 'darwin') {
      const allArgs = [exe, ...args];
      const cmd = `open ${allArgs.map((a) => /[ \t"]/.test(a) ? '"' + a.replace(/"/g, '\\\\"') + '"' : a).join(' ')}`;
      child = exec(cmd, { timeout: 15000 }, (err) => {
        if (err) return reject(new Error('launch failed: ' + err.message));
      });
    } else {
      // Linux: spawn detached
      try {
        child = spawn(exe, args, { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (e) {
        return reject(new Error('launch failed: ' + e.message));
      }
    }

    // Wait then resolve
    setTimeout(() => {
      resolve(`OK: launched ${name}${args.length ? ' with args ' + args.map((a) => `"${a}"`).join(' ') : ''}`);
    }, wait + 50);
  });
}

async function runCommand(command, cwd) {
  return new Promise((resolve) => {
    exec(command, {
      cwd: cwd || undefined,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const out = (stdout || '').toString();
      const errOut = (stderr || '').toString();
      let result = '';
      if (out) result += 'STDOUT:\n' + out.slice(0, 30000);
      if (errOut) result += (result ? '\n' : '') + 'STDERR:\n' + errOut.slice(0, 30000);
      if (err && err.code != null) result += (result ? '\n' : '') + `EXIT CODE: ${err.code}`;
      if (!result) result = 'OK (no output)';
      resolve(result);
    });
  });
}

// Run a PowerShell script via base64-encoded -EncodedCommand to bypass
// all escaping hell. The script must be a UTF-16LE base64 string.
function runPowerShell(scriptText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(scriptText, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
         { timeout: timeoutMs || 10000, windowsHide: true },
         (err, stdout, stderr) => {
           if (err && err.killed) return reject(new Error('PowerShell timed out'));
           if (err) return reject(new Error((stderr || err.message || '').toString().slice(0, 500)));
           resolve((stdout || '').toString());
         });
  });
}

async function sendKeys(keys, delayMs) {
  const platform = process.platform;
  const delay = Math.max(0, Math.min(5000, delayMs | 0));

  if (platform === 'win32') {
    // Use System.Windows.Forms.SendKeys. We pre-escape the user's keys for a
    // single-quoted PS string. Note: this means raw quotes in keys will fail;
    // for now we strip double-quotes since they're not valid SendKeys anyway.
    const safeKeys = String(keys).replace(/"/g, '""');
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms
      Start-Sleep -Milliseconds ${delay}
      try { [System.Windows.Forms.SendKeys]::SendWait('${safeKeys.replace(/'/g, "''")}') }
      catch { [System.Windows.Forms.SendKeys]::SendWait('${safeKeys.replace(/'/g, "''")}') }
      "OK"
    `.trim();
    try {
      const out = await runPowerShell(ps, 10000);
      return 'OK: keys sent' + (out.trim() ? ' (' + out.trim() + ')' : '');
    } catch (e) {
      return 'ERROR: send_keys failed — ' + e.message;
    }
  }

  if (platform === 'darwin') {
    return new Promise((resolve, reject) => {
      const safe = String(keys).replace(/"/g, '\\"');
      exec(`osascript -e 'tell application "System Events" to keystroke "${safe}"'`,
           { timeout: 8000 }, (err) => {
             if (err) return reject(new Error('osascript failed: ' + err.message));
             resolve('OK: keys sent');
           });
    });
  }

  // Linux: use xdotool
  return new Promise((resolve, reject) => {
    exec(`xdotool key ${JSON.stringify(keys)}`, { timeout: 8000 }, (err) => {
      if (err) return reject(new Error('xdotool failed (is it installed?): ' + err.message));
      resolve('OK: keys sent');
    });
  });
}

async function focusApp(titleContains) {
  const platform = process.platform;
  const safeTitle = String(titleContains).replace(/'/g, "''");

  if (platform === 'win32') {
    const ps = `
      $title = '${safeTitle}'
      $procs = Get-Process | Where-Object { $_.MainWindowTitle -like "*$title*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
      if (-not $procs) { Write-Output "No window found with title containing: $title"; exit 0 }
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class WinAPI {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
          [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        }
"@
      $h = $procs.MainWindowHandle
      if ([WinAPI]::IsIconic($h)) { [WinAPI]::ShowWindow($h, 9) | Out-Null }
      [WinAPI]::ShowWindow($h, 5) | Out-Null
      [WinAPI]::SetForegroundWindow($h) | Out-Null
      Write-Output "Focused: $($procs.MainWindowTitle)"
    `.trim();
    try {
      const out = await runPowerShell(ps, 8000);
      return 'OK: ' + out.trim();
    } catch (e) {
      return 'ERROR: focus failed — ' + e.message;
    }
  }

  if (platform === 'darwin') {
    return new Promise((resolve, reject) => {
      exec(`osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains "${safeTitle}") to true'`,
           { timeout: 8000 }, (err) => {
             if (err) return reject(new Error('osascript failed: ' + err.message));
             resolve('OK: focused ' + titleContains);
           });
    });
  }

  // Linux: xdotool
  return new Promise((resolve, reject) => {
    exec(`xdotool search --name "${String(titleContains).replace(/"/g, '\\"')}" windowactivate`,
         { timeout: 8000 }, (err, stdout) => {
           if (err) return reject(new Error('xdotool failed: ' + err.message));
           resolve('OK: focused ' + titleContains + (stdout.trim() ? ' (window ' + stdout.trim().split('\n')[0] + ')' : ''));
         });
  });
}

// ---------- streaming chat completion (OpenAI-compatible) ----------
// LLM proxy support — for users in regions where the LLM endpoint is blocked
let _llmDispatcher = null;
function refreshLlmDispatcher(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
    _llmDispatcher = null;
    return;
  }
  try {
    const { ProxyAgent } = require('undici');
    _llmDispatcher = new ProxyAgent(proxyUrl.trim());
  } catch (e) {
    console.warn('Failed to create LLM proxy agent:', e.message);
    _llmDispatcher = null;
  }
}

async function streamCompletion(s, base, messages, signal, dispatcher, sopts) {
  const tools = (sopts && sopts.tools) || [];
  const quiet = !!(sopts && sopts.quiet);
  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
    body: JSON.stringify({ model: s.model, messages, ...(tools.length ? { tools } : {}), stream: true }),
    ...(signal ? { signal } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  };
  let res;
  try {
    res = await fetch(base + '/chat/completions', fetchOpts);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('STOPPED');
    // Extract the underlying cause (e.g. ECONNREFUSED, ENOTFOUND)
    const cause = e?.cause;
    let causeStr = '';
    if (cause) {
      if (cause.code) causeStr += cause.code + ' ';
      if (cause.message) causeStr += cause.message;
    }
    if (!causeStr) causeStr = e.message;
    throw new Error('خطای شبکه: ' + causeStr);
  }
  if (!res.ok) throw new Error(`خطای API (${res.status}): ${(await res.text()).slice(0, 400)}`);

  const out = { content: '', reasoning: '', tool_calls: [] };
  const acc = {};
  const ct = res.headers.get('content-type') || '';

  const feed = (delta) => {
    if (!delta) return;
    const r = delta.reasoning_content ?? delta.reasoning;
    if (typeof r === 'string' && r) { out.reasoning += r; if (!quiet) emit({ type: 'reasoning', delta: r }); }
    if (typeof delta.content === 'string' && delta.content) { out.content += delta.content; if (!quiet) emit({ type: 'content', delta: delta.content }); }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0;
      const a = (acc[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) a.id = tc.id;
      if (tc.function?.name && a.function.name !== tc.function.name) a.function.name += tc.function.name;
      if (tc.function?.arguments) a.function.arguments += tc.function.arguments;
    }
  };

  if (!ct.includes('text/event-stream')) {
    // server ignored stream=true -> plain JSON
    const data = await res.json();
    if (data.error) throw new Error('خطای API: ' + (data.error.message || JSON.stringify(data.error)));
    feed(data.choices?.[0]?.message);
  } else {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') break outer;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        if (j.error) throw new Error('خطای API: ' + (j.error.message || JSON.stringify(j.error)));
        feed(j.choices?.[0]?.delta);
      }
    }
  }

  out.tool_calls = Object.keys(acc)
    .sort((a, b) => a - b)
    .map((k) => acc[k])
    .filter((t) => t.function.name)
    .map((t, n) => ({ ...t, id: t.id || `call_${Date.now()}_${n}` }));
  return out;
}

// ---------- agent loop ----------
// NOTE: in JS source, '\\' renders as a single backslash in the actual string,
// so '\\sum' is sent to the model as '\sum' (correct LaTeX).
const SYSTEM_PROMPT = [
  'You are Hekpixle, a personal AI agent running on the user\'s computer.',
  'You act through tools: you can see and operate the user\'s screen, browser and files, run code, search the web, and remember things.',

  // Language
  'Always reply in the same language the user writes in (Persian or English).',
  'If the user writes in Persian, reply in Persian; otherwise reply in English.',

  // Formatting
  'Format your replies with Markdown for clarity and structure:',
  '- Use #, ##, ### headings to organize long answers into sections.',
  '- Use **bold** for key terms and *italic* for emphasis.',
  '- Use bulleted lists (-) and numbered lists (1.) for steps or enumerations.',
  '- Use > blockquotes for important call-outs or notes.',
  '- Use tables (| a | b |) when comparing values or showing structured data.',
  '- Use fenced code blocks (```language\\n...\\n```) for code, with the language tag (e.g. ```python, ```js, ```bash) so syntax highlighting works.',
  '- Use inline code (`) for short identifiers, paths, or commands.',
  '- Use horizontal rules (---) to separate major sections.',

  // Math / physics
  'For ANY math or physics formula, expression, or equation, use LaTeX rendered with KaTeX:',
  '- Inline math: $E = mc^2$ or $\\sum_{i=1}^{n} i$ — wrap a single-line formula in single $...$ signs.',
  '- Display (block) math: $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt\\pi}{2}$$ — wrap multi-line or display formulas in $$...$$.',
  '- Use \\frac, \\sqrt, \\sum, \\int, \\alpha, \\beta, \\Delta, \\theta, \\nabla, ^{...}, _{...} etc. as needed.',
  '- Greek letters: \\alpha, \\beta, \\gamma, \\delta, \\epsilon, \\theta, \\lambda, \\mu, \\pi, \\rho, \\sigma, \\phi, \\omega (and uppercase forms: \\Alpha, \\Beta, etc.).',
  '- Operators: \\cdot, \\times, \\div, \\pm, \\mp, \\leq, \\geq, \\neq, \\approx, \\equiv, \\propto, \\to, \\Rightarrow, \\infty.',
  '- Common physics vectors: \\vec{a}, \\vec{E}, \\hat{i}, \\hat{j}, \\hat{k}, \\vec{p}, \\dot{x}, \\ddot{x}.',
  '- Common physics formulas: $F = m\\vec{a}$, $\\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\epsilon_0}$, $E = mc^2$, $i\\hbar \\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi$.',
  '- Never put plain-text math like "E=mc^2" — always wrap in $...$ so it renders properly.',
  '- After showing a formula, briefly explain each symbol (e.g. "where $m$ is mass, $c$ is the speed of light").',

  // Reasoning + tools
  'Before using tools, write one or two short sentences saying what you are thinking and what you are about to do.',
  'Before destructive actions, explain briefly what you will do; the app will also ask the user for permission.',
  'If the user denies an action, accept it and do not retry.',

  // ---- Capabilities ----
  'You are a full agent. Tool groups (the user can disable some): files (list_dir, path_info, read_file, write_file, patch, search_files, make_dir, copy_path, move_or_rename, delete_path, file_history, file_restore), terminal (run_command incl. background + process), code (execute_code), web (web_search, web_extract), browser (browser_* — a real Chromium window you drive with element refs), desktop (computer: screenshot/click/type/key/scroll on ANY app; ui_tree + ui_act on Windows; launch_app, focus_app), vision (vision_analyze), media (image_generate, text_to_speech, transcribe_audio), memory (save_memory, recall_memory, forget_memory, session_search), skills (skills_list, skill_view, skill_manage), planning (todo, clarify), delegation (delegate_task), cron (cronjob), messaging (send_message), plus MCP and plugin tools.',
  '',
  'Choosing tools:',
  '- Websites: browser_navigate -> browser_snapshot -> browser_click / browser_type using refs like e12. Quick reading of a page: web_extract. Research: web_search -> web_extract.',
  '- Desktop apps: launch_app -> computer(action="screenshot") -> act -> check the screenshot returned by the action. On Windows try ui_tree / ui_act first for exact controls.',
  '- You CAN see: screenshots and images are shown to you. Never claim you cannot see the screen before trying a screenshot.',
  '- Folders: to explore a folder use list_dir (depth=2..4 for a tree); path_info to check a path exists. Paths may be absolute, ~, Desktop/Documents/Downloads, or relative to the workspace. For organizing: make_dir, move_or_rename (into an existing folder keeps the name), copy_path, delete_path (Recycle Bin). When a path errors, read the error: it lists the nearest existing folder — list it and retry instead of guessing. Never say you cannot read folders.',
  '- Files and CLI: file tools and run_command. Long-running jobs: run_command with background=true, then process.',
  '- Many mechanical steps in a row: execute_code does them in one call. Large independent sub-tasks: delegate_task (parallel). Tasks with 3+ steps: keep a todo list.',
  '- To open a website for the USER to look at, launch_app("chrome", [url]). To work on a website yourself, use browser_*.',
  '',
  'Rules for acting:',
  '- On GUIs: one action at a time, verify the result after each; do not chain blind clicks or keystrokes.',
  '- Never type passwords or payment details, send messages/emails, buy, delete or submit irreversible forms unless the user explicitly asked for exactly that. On login/captcha/2FA screens stop and ask the user.',
  '- Do not run commands needing elevation (sudo/admin) without warning the user. If the user denies an action, accept it and do not retry.',
  '- Prefer the least invasive tool that works (read before write, patch before rewrite).',
  '',
  'Learning loop: before a non-trivial task, check the skill index below and skill_view a matching skill. After finishing a complex task (5+ tool calls), fixing a tricky problem, or learning a workflow/preference the user will want again, save it: skill_manage for procedures, save_memory for facts about the user. Fix skills that turn out to be wrong or outdated.',
  '',

  // Tone
  'Be concise but complete. Prefer one focused answer over a long meandering one.',
  'When the user asks a math/physics question, ALWAYS show the formula rendered with KaTeX, then explain each symbol after it.',

  // ---- Memory (learning loop — inspired by Hermes Agent) ----
  'You have two memory tools:',
  '1. save_memory(key, value, category?) — Save a fact about the user that persists across sessions. Use this when the user shares their name, job, preferences, projects, deadlines, recurring tasks, or anything worth remembering for future conversations. No permission needed — just save it.',
  '2. recall_memory(keyword?) — Search your persistent memory. Use this when the user asks "do you remember..." or refers to something discussed in a past session.',
  '',
  'Examples of when to use save_memory:',
  '- User says "My name is Ali" → save_memory(key="user_name", value="Ali", category="identity")',
  '- User says "I prefer Persian answers" → save_memory(key="preferred_language", value="Persian", category="preference")',
  '- User says "My project deadline is Friday" → save_memory(key="project_deadline", value="Friday", category="schedule")',
  '- User says "I use Python for everything" → save_memory(key="preferred_language", value="Python", category="preference")',
  '',
  'Use recall_memory when:',
  '- User asks "Do you remember my name?"',
  '- User refers to something from a previous session',
  '- You need context that might be in your persistent memory',
  '',
  'Be proactive: if the user shares personal info, save it BEFORE responding. This makes future conversations more personal.'
].join('\n');

const clean = (m) => { const { reasoning, error, ...rest } = m; return rest; };

const readCapped = async (p, n) => { try { const t = (await fs.readFile(p, 'utf8')).trim(); return t ? t.slice(0, n) : ''; } catch { return ''; } };

// Build the system prompt: base + environment + SOUL.md + personality + memory + skills index + context files + plugin extras.
async function buildDynamicSystemPrompt(s, o) {
  const opts = o || {};
  let prompt = SYSTEM_PROMPT;
  const now = new Date();
  prompt += `\n\n--- Environment ---\nOS: ${process.platform} (${os.release()}) | Home: ${os.homedir()}${s.workspaceDir ? ' | Workspace: ' + s.workspaceDir : ''}\nNow: ${now.toString()}`;
  if (opts.extra) prompt += '\n\n--- Role for this run ---\n' + opts.extra;
  if (opts.depth > 0) return prompt; // sub-agents stay lean: no memory/skills/context
  const soul = await readCapped(dataFile('SOUL.md'), 8000);
  if (soul) prompt += '\n\n--- Persona (SOUL.md) ---\n' + soul;
  if (s && s.personality && s.personality.trim()) prompt += '\n\n--- Personality / Custom Instructions ---\n' + s.personality.trim();
  try {
    const mem = await readJson('memory.json', {});
    if (mem.entries && mem.entries.length) {
      prompt += '\n\n--- Persistent memory (what you remember about the user) ---\n' + mem.entries.map((e) => `• ${e.key}: ${e.value} [${e.category || 'note'}]`).join('\n') +
        '\n\nUse this context naturally. If the user shares NEW important info, use save_memory.';
    }
  } catch {}
  try {
    if ((s.toolsets || {}).skills !== false && modules.skills) {
      const idx = await modules.skills.indexPrompt();
      if (idx) prompt += '\n\n--- Skills (load full text with skill_view before using) ---\n' + idx;
    }
  } catch {}
  const roots = [...new Set([s.workspaceDir, process.cwd()].filter(Boolean))];
  const names = ['AGENTS.md', 'HEKPIXLE.md', '.hekpixle.md', '.cursorrules'];
  let ctxText = await readCapped(dataFile('AGENTS.md'), 12000);
  for (const r of roots) for (const n of names) { const t = await readCapped(path.join(r, n), 12000); if (t) ctxText += `\n\n(${n} in ${r})\n${t}`; }
  if (ctxText.trim()) prompt += '\n\n--- Project / global context files ---\n' + ctxText.trim();
  try { if (modules.plugins) { const ex = await modules.plugins.promptExtras(); if (ex) prompt += '\n\n--- Plugins ---\n' + ex; } } catch {}
  return prompt;
}

// ---------- context compression ----------
const msgText = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join(' ') : '');
const msgChars = (m) => msgText(m).length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
const _sumCache = new Map();

async function llmOnce(s, base, messages) {
  const r = await fetch(base + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
    body: JSON.stringify({ model: s.model, messages }), ...(_llmDispatcher ? { dispatcher: _llmDispatcher } : {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`API ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

async function compressMessages(s, base, messages, force) {
  const total = messages.reduce((n, m) => n + msgChars(m), 0);
  if (!force && total <= (s.compressAtChars || 90000)) return messages;
  const keep = 10;
  let k = messages.length - keep;
  while (k > 0 && messages[k].role !== 'user') k--;
  if (k <= 1) return messages;
  let transcript = messages.slice(0, k).map((m) => {
    if (m.role === 'tool') return `[tool result ${m.name || ''}] ${msgText(m).slice(0, 300)}`;
    const calls = m.tool_calls ? ' [called: ' + m.tool_calls.map((c) => c.function.name).join(', ') + ']' : '';
    return `${m.role.toUpperCase()}: ${msgText(m).slice(0, 1800)}${calls}`;
  }).join('\n');
  if (transcript.length > 60000) transcript = transcript.slice(-60000);
  const key = k + ':' + crypto.createHash('sha1').update(transcript).digest('hex');
  let summary = _sumCache.get(key);
  if (!summary) {
    summary = await llmOnce(s, base, [
      { role: 'system', content: 'You compress an agent conversation into a briefing for itself. Keep: the user\'s goals and preferences, decisions made, facts discovered, file paths/URLs/IDs, what was done, what is still pending, and errors to avoid. Be dense and factual, under 700 words. Same language as the conversation.' },
      { role: 'user', content: transcript },
    ]);
    if (!summary) return messages;
    _sumCache.set(key, summary);
    if (_sumCache.size > 20) _sumCache.delete(_sumCache.keys().next().value);
  }
  return [
    { role: 'user', content: '[Summary of the earlier part of this conversation]\n' + summary },
    { role: 'assistant', content: 'Understood — I have the earlier context and will continue from here.' },
    ...messages.slice(k),
  ];
}

function thumbOf(dataUrl) {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    const sz = img.getSize();
    const k = Math.min(1, 520 / Math.max(sz.width, sz.height));
    return 'data:image/jpeg;base64,' + (k < 1 ? img.resize({ width: Math.round(sz.width * k), height: Math.round(sz.height * k) }) : img).toJPEG(60).toString('base64');
  } catch { return null; }
}

async function runAgent(messages, opts) {
  const options = opts || {};
  const source = options.source || 'desktop'; // 'desktop' | 'telegram' | 'cron'
  const depth = options.depth || 0;
  const ui = source === 'desktop' && depth === 0; // only the top-level desktop run streams to the UI
  const signal = options.signal || null;
  const isAborted = () => signal?.aborted;

  const s = mergeSettings(await readJson('settings.json', {}));
  settingsCache = s;
  if (!s.apiKey) return { error: 'API Key تنظیم نشده. از پایین سایدبار → Settings وارد کن.' };
  const base = s.baseUrl.replace(/\/+$/, '');
  refreshLlmDispatcher(s.llmProxyUrl);
  try { await ensureModules(); } catch (e) { console.warn('module init failed:', e); }

  const defs = activeDefs(s, options);
  const tools = defs.map(toOpenAI);
  const call = {
    source, signal, depth, s, state: {}, emit: ui ? emit : () => {},
    policy: options.policy || (source === 'desktop' ? () => true : policyFor(source, s)),
  };
  const sys = await buildDynamicSystemPrompt(s, { depth, extra: options.systemExtra });
  const added = [];   // persisted by the caller
  const work = [];    // like added, plus ephemeral image messages
  let base0 = messages.map(clean);
  if (depth === 0) { try { base0 = await compressMessages(s, base, base0, false); } catch (e) { console.warn('compression skipped:', e.message); } }
  const maxSteps = options.maxSteps || s.maxSteps || 30;

  const pruneImages = () => {
    const idx = work.map((m, i) => (m._img ? i : -1)).filter((i) => i >= 0);
    for (const i of idx.slice(0, Math.max(0, idx.length - 3))) { work[i] = { role: 'user', content: '[older screenshot omitted]' }; }
  };

  for (let i = 0; i < maxSteps; i++) {
    if (isAborted()) return { error: 'STOPPED', added };
    if (ui) emit({ type: 'start-step' });
    pruneImages();
    const req = [{ role: 'system', content: sys }, ...base0, ...work.map((m) => { const { _img, ...r } = m; return r; })];
    let msg;
    try {
      msg = await streamCompletion(s, base, req, signal, _llmDispatcher, { tools, quiet: !ui });
    } catch (e) {
      if (s.fallbackBaseUrl && s.fallbackApiKey && !e.message.includes('STOPPED')) {
        try {
          const fb = { ...s, baseUrl: s.fallbackBaseUrl, apiKey: s.fallbackApiKey, model: s.fallbackModel || s.model };
          msg = await streamCompletion(fb, s.fallbackBaseUrl.replace(/\/+$/, ''), req, signal, _llmDispatcher, { tools, quiet: !ui });
        } catch (e2) {
          if (ui) emit({ type: 'end-step' });
          return { error: e.message + ' (fallback also failed: ' + e2.message + ')', added };
        }
      } else {
        if (ui) emit({ type: 'end-step' });
        return { error: e.message, added };
      }
    }
    if (ui) emit({ type: 'end-step' });

    if (!msg.content && !msg.reasoning && !msg.tool_calls.length) return { error: 'پاسخ خالی از مدل.', added };
    const am = { role: 'assistant', content: msg.content, reasoning: msg.reasoning || undefined, tool_calls: msg.tool_calls.length ? msg.tool_calls : undefined };
    added.push(am); work.push(am);
    if (!msg.tool_calls.length) return { added };

    const images = [];
    for (const tc of msg.tool_calls) {
      if (isAborted()) return { error: 'STOPPED', added };
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
      if (!args || typeof args !== 'object') args = {};
      if (ui) emit({ type: 'tool', callId: tc.id, name: tc.function.name, args });

      const r = await executeTool(tc.function.name, args, call, defs);
      let text = r.text;
      if (r.image) {
        if (s.media.visionMode === 'aux' && s.media.visionModel && modules.media) {
          try { text += '\n\n[Description from the vision model]\n' + await modules.media.describe(r.image); }
          catch (e) { text += '\n[vision model failed: ' + e.message + ']'; }
        } else images.push({ name: tc.function.name, url: r.image });
        if (ui) { const th = thumbOf(r.image); if (th) emit({ type: 'image', callId: tc.id, src: th }); }
      }
      if (ui) emit({ type: 'tool-result', callId: tc.id, status: statusOf(text) });
      const tm = { role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: text };
      added.push(tm); work.push(tm);
    }
    // Images can't live inside tool messages (OpenAI format) — add them as one user message after all tool results.
    if (images.length) {
      work.push({ role: 'user', _img: true, content: [{ type: 'text', text: `[Image result from: ${images.map((x) => x.name).join(', ')}]` }, ...images.map((x) => ({ type: 'image_url', image_url: { url: x.url } }))] });
    }
  }
  return { error: 'تعداد مراحل از حد مجاز گذشت (می‌تونی در Settings → Tools «حداکثر مراحل» رو بیشتر کنی).', added };
}

// Track the current desktop agent run so the Stop button can abort it
let currentAbortController = null;

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    title: 'Hekpixle',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('focus', () => { try { win.flashFrame(false); } catch {} });
  win.on('closed', () => { denyAllPending(); win = null; if (process.platform !== 'darwin') app.quit(); });
}

const telegramExtras = {
  transcribe: async (buf, name, lang) => { await ensureModules(); return modules.media.transcribe(buf, name, lang); },
  toDataUrl: async (src) => { await ensureModules(); return modules.media.toDataUrl(src); },
};

app.whenReady().then(async () => {
  // Initialize the Telegram module with the window + settings + agent runner
  telegram.init({
    win: null, // will be set in createWindow; telegram uses a getter
    get userDataDir() { return app.getPath('userData'); },
    getSettings: () => ({ ...DEFAULT_SETTINGS, telegram: { ...DEFAULT_SETTINGS.telegram, ...((readJsonSync('settings.json') || {}).telegram || {}) } }),
    runAgentFn: (messages, opts) => runAgent(messages, opts),
    systemPromptFn: () => SYSTEM_PROMPT,
    extras: telegramExtras,
  });
  // Wrap getSettings so we always read from disk (settings can change any time)
  // We override the simple closure with a fresh reader:
  telegram._getSettingsFresh = () => {
    const s = readJsonSync('settings.json') || {};
    return { ...DEFAULT_SETTINGS, ...s, telegram: { ...DEFAULT_SETTINGS.telegram, ...(s.telegram || {}) } };
  };

  ipcMain.handle('settings:get', async () => mergeSettings(await readJson('settings.json', {})));
  ipcMain.handle('settings:set', async (_e, v) => {
    const merged = mergeSettings(v);
    await writeJson('settings.json', merged);
    settingsCache = merged;
    try { await ensureModules(); await modules.mcp.sync(); } catch (e) { console.warn('MCP sync failed:', e.message); }
    return true;
  });
  ipcMain.handle('chats:load', () => readJson('chats.json', []));
  ipcMain.handle('chats:save', async (_e, v) => { await writeJson('chats.json', v); return true; });
  ipcMain.handle('works:load', () => readJson('works.json', []));
  ipcMain.handle('works:save', async (_e, v) => { await writeJson('works.json', v); return true; });
  ipcMain.handle('agent:run', (_e, messages) => {
    // Set up an AbortController so the Stop button can interrupt this run
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    return runAgent(messages, { source: 'desktop', signal }).finally(() => {
      if (currentAbortController?.signal === signal) currentAbortController = null;
    });
  });
  ipcMain.handle('agent:stop', () => {
    if (currentAbortController) {
      try { currentAbortController.abort(); } catch {}
      currentAbortController = null;
    }
    // Also cancel any pending permission prompts
    denyAllPending();
    return true;
  });
  ipcMain.handle('permission:answer', (_e, id, ok) => {
    const r = pendingPerms.get(id);
    if (r) { pendingPerms.delete(id); r(ok === 'always' ? 'always' : !!ok); }
    return true;
  });
  ipcMain.handle('clarify:answer', (_e, id, text) => {
    const r = pendingClarify.get(id);
    if (r) { pendingClarify.delete(id); r(String(text || '')); }
    return true;
  });
  ipcMain.handle('skills:list', async () => { await ensureModules(); return (await modules.skills.listSkills()).map((x) => ({ name: x.name, description: x.description, source: x.source })); });
  ipcMain.handle('cron:list', async () => { await ensureModules(); return { jobs: await modules.cron.list(), runs: (await modules.cron.runs()).slice(-15).reverse() }; });
  ipcMain.handle('cron:action', async (_e, a) => { await ensureModules(); return await modules.cron.act(a || {}); });
  ipcMain.handle('tools:info', async () => {
    await ensureModules();
    const s = mergeSettings(await readJson('settings.json', {}));
    const all = allDefs();
    return {
      toolsets: TOOLSETS.map((t) => ({ name: t, enabled: (s.toolsets || {})[t] !== false, count: all.filter((d) => d.toolset === t).length })),
      mcp: modules.mcp.status(), plugins: modules.plugins.status(), skillsDir: path.join(app.getPath('userData'), 'skills'), userData: app.getPath('userData'),
    };
  });
  ipcMain.handle('tools:open', async (_e, what) => {
    const dir = what === 'plugins' ? path.join(app.getPath('userData'), 'plugins') : path.join(app.getPath('userData'), 'skills');
    await fs.mkdir(dir, { recursive: true }); await shell.openPath(dir); return true;
  });
  // ---- Plugins (Settings → Plugins) ----
  const plugWrap = (fn) => async (_e, ...a) => { try { await ensureModules(); return { ok: true, ...(await fn(...a)) }; } catch (e) { return { ok: false, error: e.message || String(e) }; } };
  const plugState = () => ({ plugins: modules.plugins.list(), dir: modules.plugins.status().dir });
  ipcMain.handle('plugins:list', plugWrap(async () => plugState()));
  ipcMain.handle('plugins:reload', plugWrap(async () => { await modules.plugins.load(); return plugState(); }));
  ipcMain.handle('plugins:toggle', plugWrap(async (name, on) => { await modules.plugins.setEnabled(String(name), !!on); return plugState(); }));
  ipcMain.handle('plugins:remove', plugWrap(async (name) => { await modules.plugins.remove(String(name)); return plugState(); }));
  ipcMain.handle('plugins:installCode', plugWrap(async (name, code) => { const n = await modules.plugins.installCode(name, code); return { name: n, ...plugState() }; }));
  ipcMain.handle('plugins:example', plugWrap(async () => { const n = await modules.plugins.installExample(); return { name: n, ...plugState() }; }));
  ipcMain.handle('plugins:exampleCode', plugWrap(async () => ({ code: modules.plugins.exampleCode() })));
  ipcMain.handle('plugins:pick', plugWrap(async (kind) => {
    const res = await dialog.showOpenDialog({
      title: kind === 'folder' ? 'پوشه‌ی افزونه (باید index.js داشته باشد)' : 'فایل افزونه (.js)',
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
      filters: kind === 'folder' ? undefined : [{ name: 'JavaScript', extensions: ['js'] }],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true, ...plugState() };
    const names = [];
    for (const p of res.filePaths) names.push(await modules.plugins.installFrom(p));
    return { names, ...plugState() };
  }));
  ipcMain.handle('plugins:open', async () => { await ensureModules(); const d = modules.plugins.status().dir; await fs.mkdir(d, { recursive: true }); await shell.openPath(d); return true; });
  ipcMain.handle('dialog:openFolder', async () => {
    try {
      const res = await dialog.showOpenDialog({ title: 'Select folder to attach', properties: ['openDirectory', 'multiSelections'] });
      if (res.canceled || !res.filePaths.length) return { files: [] };
      return { files: res.filePaths.map((p) => ({ path: p, name: path.basename(p) || p, ext: '', kind: 'folder', size: 0, mtime: 0 })) };
    } catch (e) { return { files: [], error: e.message }; }
  });
  ipcMain.handle('chat:compress', async (_e, messages) => {
    try {
      const s = mergeSettings(await readJson('settings.json', {}));
      if (!s.apiKey) return { error: 'API Key تنظیم نشده.' };
      refreshLlmDispatcher(s.llmProxyUrl);
      const msgs = (messages || []).map(clean);
      const out = await compressMessages(s, s.baseUrl.replace(/\/+$/, ''), msgs, true);
      if (out.length >= msgs.length) return { error: 'گفت‌وگو برای فشرده‌سازی خیلی کوتاهه.' };
      return { messages: out };
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('shell:openExternal', async (_e, url) => {
    try {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        await shell.openExternal(url);
      }
    } catch {}
    return true;
  });
  // File picker (for attachment button)
  ipcMain.handle('dialog:openFile', async () => {
    try {
      const res = await dialog.showOpenDialog({
        title: 'Select file to attach',
        properties: ['openFile', 'multiSelections'],
      });
      if (res.canceled || !res.filePaths.length) return { files: [] };
      // Enrich each path with metadata (size, mtime) so the UI can show it
      const files = [];
      for (const p of res.filePaths) {
        try {
          const stat = await fs.stat(p);
          const name = path.basename(p);
          const ext = (path.extname(name) || '').toLowerCase().slice(1);
          let kind = 'file';
          if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tiff'].includes(ext)) kind = 'image';
          else if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv'].includes(ext)) kind = 'video';
          else if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) kind = 'audio';
          else if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt'].includes(ext)) kind = 'document';
          else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) kind = 'archive';
          else if (['js', 'ts', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'rb', 'php', 'html', 'css', 'json', 'xml', 'yaml', 'yml'].includes(ext)) kind = 'code';
          files.push({
            path: p,
            name,
            ext,
            kind,
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        } catch {
          // skip inaccessible files
        }
      }
      return { files };
    } catch (e) {
      return { files: [], error: e.message };
    }
  });
  // Read file inline — for @ mentions (expand @path to file content in messages)
  ipcMain.handle('file:readInline', async (_e, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') return { error: 'No path' };
      await ensureModules();
      const resolved = modules.files.resolvePath(filePath);
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) return { content: await modules.files.listDirText(resolved, { depth: 2, max_entries: 150 }), path: resolved, isDir: true };
      if (stat.size > 60000) return { error: 'File too large (>60KB) — ask the agent to read it with read_file' };
      const content = await fs.readFile(resolved, 'utf8');
      return { content, path: resolved, size: stat.size };
    } catch (e) { return { error: e.code === 'ENOENT' ? 'path not found' : e.message }; }
  });
  // Telegram IPC
  ipcMain.handle('telegram:start', async () => {
    // Re-bind the window reference in case createWindow was called
    telegram.init({
      win: win,
      userDataDir: app.getPath('userData'),
      getSettings: () => telegram._getSettingsFresh(),
      runAgentFn: (messages, opts) => runAgent(messages, opts),
      systemPromptFn: () => SYSTEM_PROMPT,
    extras: telegramExtras,
    });
    return await telegram.startBot();
  });
  ipcMain.handle('telegram:stop', () => telegram.stopBot());
  ipcMain.handle('telegram:status', () => telegram.getStatus());
  ipcMain.handle('telegram:test', async (_e, token, proxyUrl) => {
    // Quick connectivity test: just calls getMe with the given token
    // (doesn't start the polling loop). Uses the proxy if provided.
    try {
      const t = String(token || '').trim();
      if (!t) return { ok: false, error: 'Bot token is empty' };
      if (!/^[\d]+:[\w\-]+$/.test(t)) {
        return { ok: false, error: 'Token format looks wrong (expecting "123456789:ABCxxx")' };
      }
      // Build a ProxyAgent if proxyUrl was passed
      let dispatcher = null;
      const proxy = String(proxyUrl || '').trim();
      if (proxy) {
        try {
          const { ProxyAgent } = require('undici');
          dispatcher = new ProxyAgent(proxy);
        } catch (e) {
          return { ok: false, error: 'Failed to set up proxy: ' + e.message };
        }
      }
      const url = `https://api.telegram.org/bot${t}/getMe`;
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          ...(dispatcher ? { dispatcher } : {}),
        });
      } catch (e) {
        // Extract the underlying cause from the fetch error
        const cause = e?.cause;
        let causeStr = '';
        if (cause) {
          if (cause.code) causeStr += cause.code + ' ';
          if (cause.message) causeStr += cause.message;
        }
        if (!causeStr) causeStr = e.message || 'unknown';
        const looksBlocked = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed/i.test(causeStr);
        const suggestion = looksBlocked && !proxy
          ? ' — اگه تو ایران هستی، api.telegram.org مسدوده. تو «Proxy URL» یه پروکسی بذار (مثلاً http://127.0.0.1:7890 یا socks5://127.0.0.1:1080).'
          : '';
        return { ok: false, error: 'Network: ' + causeStr + suggestion };
      }
      let data;
      try { data = await res.json(); }
      catch {
        return { ok: false, error: `Telegram returned non-JSON (HTTP ${res.status}). ${proxy ? '' : 'اگه مسدود شد، یه پروکسی بذار.'}` };
      }
      if (!data.ok) {
        return { ok: false, error: data.description || `HTTP ${res.status}` };
      }
      return {
        ok: true,
        id: data.result.id,
        username: data.result.username,
        firstName: data.result.first_name,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });  createWindow();
  // Now bind the actual window to the telegram module
  telegram.init({
    win: win,
    userDataDir: app.getPath('userData'),
    getSettings: () => telegram._getSettingsFresh(),
    runAgentFn: (messages, opts) => runAgent(messages, opts),
    systemPromptFn: () => SYSTEM_PROMPT,
    extras: telegramExtras,
  });

  // Start tools, skills, MCP servers and the scheduler in the background
  ensureModules().catch((e) => console.warn('module init failed:', e.message));

  // Auto-start telegram if configured
  try {
    const s = telegram._getSettingsFresh();
    if (s.telegram?.botToken && s.telegram?.autoStart) {
      setTimeout(() => telegram.startBot().catch(() => {}), 2000);
    }
  } catch {}

  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

// Sync settings read (used by telegram module — fire-and-forget, no async)
function readJsonSync(n) {
  try {
    const fsSync = require('fs');
    return JSON.parse(fsSync.readFileSync(path.join(app.getPath('userData'), n), 'utf8'));
  } catch { return {}; }
}

app.on('before-quit', () => {
  try { if (modules.cron) modules.cron.stop(); } catch {}
  for (const f of disposers) { try { f(); } catch {} }
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
