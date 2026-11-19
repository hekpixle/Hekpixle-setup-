// Scheduled automations ("cron"): natural-ish schedules, run unattended by the agent,
// results delivered to desktop notification / Telegram / local log.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const UNIT = { s: 1000, sec: 1000, m: 60000, min: 60000, h: 3600000, hr: 3600000, d: 86400000 };
const unitMs = (u) => {
  u = u.toLowerCase().replace(/(seconds?|minutes?|hours?|days?)$/, (x) => ({ s: 's', m: 'm', h: 'h', d: 'd' }[x[0]]));
  return UNIT[u];
};

function parseField(f, min, max) {
  const set = new Set();
  for (const part of f.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad cron field "${f}"`);
    let lo, hi;
    if (m[1] === '*') { lo = min; hi = max; }
    else if (m[1].includes('-')) { [lo, hi] = m[1].split('-').map(Number); }
    else { lo = +m[1]; hi = m[2] ? max : lo; }
    const step = m[2] ? +m[2] : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron field out of range "${f}"`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

function parseCron(expr) {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) throw new Error('cron needs 5 fields: minute hour day-of-month month day-of-week');
  const dowRaw = parseField(p[4], 0, 7);
  const dow = new Set([...dowRaw].map((d) => d % 7));
  return { min: parseField(p[0], 0, 59), hour: parseField(p[1], 0, 23), dom: parseField(p[2], 1, 31), mon: parseField(p[3], 1, 12), dow, domStar: p[2] === '*', dowStar: p[4] === '*' };
}

function cronNext(expr, fromMs) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(Math.floor(fromMs / 60000) * 60000 + 60000);
  d.setSeconds(0, 0);
  for (let i = 0; i < 600000; i++) {
    if (!c.mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    const domOk = c.dom.has(d.getDate()), dowOk = c.dow.has(d.getDay());
    const dayOk = c.domStar && c.dowStar ? true : c.domStar ? dowOk : c.dowStar ? domOk : (domOk || dowOk);
    if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}

function parseSchedule(str, now = Date.now()) {
  const s = String(str || '').trim();
  let m = s.match(/^every\s+(\d+)\s*([a-z]+)$/i);
  if (m && unitMs(m[2])) { const ms = +m[1] * unitMs(m[2]); if (ms < 60000) throw new Error('minimum interval is 1 minute'); return { kind: 'every', everyMs: ms }; }
  m = s.match(/^in\s+(\d+)\s*([a-z]+)$/i);
  if (m && unitMs(m[2])) return { kind: 'once', at: now + +m[1] * unitMs(m[2]) };
  if (s.split(/\s+/).length === 5) { parseCron(s); return { kind: 'cron', expr: s }; }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) { if (t <= now) throw new Error('that date/time is in the past'); return { kind: 'once', at: t }; }
  throw new Error('schedule must be "every 30m", "in 2h", an ISO date/time, or a 5-field cron expression (e.g. "0 9 * * 1-5")');
}

function nextRun(spec, from) {
  if (spec.kind === 'once') return spec.at > from ? spec.at : null;
  if (spec.kind === 'every') return from + spec.everyMs;
  if (spec.kind === 'cron') return cronNext(spec.expr, from);
  return null;
}

function register(ctx) {
  const jobsFile = () => path.join(ctx.userDataDir(), 'cron_jobs.json');
  const runsFile = () => path.join(ctx.userDataDir(), 'cron_runs.json');
  const readJ = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };
  const writeJ = async (f, v) => { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(v, null, 2)); };
  let jobs = null, timer = null;
  const running = new Set();

  const load = async () => { if (!jobs) jobs = await readJ(jobsFile(), []); return jobs; };
  const save = () => writeJ(jobsFile(), jobs);

  async function runJob(job, manual) {
    if (running.has(job.id)) return 'already running';
    running.add(job.id);
    let status = 'ok', output = '';
    try {
      output = await ctx.runUnattended(job);
    } catch (e) { status = 'error'; output = String(e && e.message || e); }
    running.delete(job.id);
    job.lastRunAt = Date.now(); job.lastStatus = status; job.lastOutput = String(output).slice(0, 4000); job.runs = (job.runs || 0) + 1;
    if (!manual) {
      const n = nextRun(job.spec, Date.now());
      if (n == null) { job.enabled = false; job.nextRunAt = null; } else job.nextRunAt = n;
    }
    await save();
    const hist = await readJ(runsFile(), []);
    hist.push({ jobId: job.id, name: job.name, ts: job.lastRunAt, status, output: job.lastOutput });
    await writeJ(runsFile(), hist.slice(-100));
    try { await ctx.deliverCron(job, output, status); } catch { /* delivery best-effort */ }
    return status === 'ok' ? output : 'ERROR: ' + output;
  }

  async function tick() {
    try {
      await load();
      const now = Date.now();
      for (const job of jobs) {
        if (!job.enabled || !job.nextRunAt || job.nextRunAt > now || running.has(job.id)) continue;
        if (now - job.nextRunAt > 2 * 3600000 && job.spec.kind !== 'once') { job.nextRunAt = nextRun(job.spec, now); await save(); continue; } // missed while app was closed
        runJob(job, false).catch(() => {});
      }
    } catch {}
  }

  const fmt = (j) => `${j.id}  ${j.enabled ? '▶' : '⏸'}  "${j.name}"  ${j.spec.kind === 'cron' ? j.spec.expr : j.spec.kind === 'every' ? 'every ' + Math.round(j.spec.everyMs / 60000) + 'm' : 'once ' + new Date(j.spec.at).toLocaleString()}  → ${j.deliver}  next: ${j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—'}  last: ${j.lastStatus || '—'}`;

  async function act(a, source) {
    await load();
    const find = () => jobs.find((j) => j.id === a.id);
    switch (a.action) {
      case 'list': return jobs.length ? jobs.map(fmt).join('\n') : 'No scheduled jobs.';
      case 'create': {
        if (!a.prompt || !a.schedule) return 'ERROR: prompt and schedule are required.';
        let spec; try { spec = parseSchedule(a.schedule); } catch (e) { return 'ERROR: ' + e.message; }
        const job = { id: 'j' + crypto.randomBytes(3).toString('hex'), name: a.name || String(a.prompt).slice(0, 40), prompt: String(a.prompt), spec, deliver: a.deliver || (source === 'telegram' ? 'telegram' : 'desktop'), skills: Array.isArray(a.skills) ? a.skills : [], enabled: true, createdAt: Date.now(), nextRunAt: nextRun(spec, Date.now()), runs: 0 };
        jobs.push(job); await save();
        return 'OK: created.\n' + fmt(job);
      }
      case 'pause': case 'resume': case 'remove': case 'update': case 'run_now': {
        const j = find();
        if (!j) return `ERROR: no job "${a.id}"`;
        if (a.action === 'remove') { jobs = jobs.filter((x) => x !== j); await save(); return 'OK: removed.'; }
        if (a.action === 'pause') { j.enabled = false; await save(); return 'OK: paused.'; }
        if (a.action === 'resume') { j.enabled = true; j.nextRunAt = nextRun(j.spec, Date.now()); await save(); return 'OK: resumed.\n' + fmt(j); }
        if (a.action === 'run_now') return await runJob(j, true);
        if (a.name) j.name = a.name;
        if (a.prompt) j.prompt = a.prompt;
        if (a.deliver) j.deliver = a.deliver;
        if (a.schedule) { try { j.spec = parseSchedule(a.schedule); j.nextRunAt = nextRun(j.spec, Date.now()); j.enabled = true; } catch (e) { return 'ERROR: ' + e.message; } }
        await save(); return 'OK: updated.\n' + fmt(j);
      }
      default: return 'ERROR: unknown action.';
    }
  }

  const defs = [{
    name: 'cronjob', toolset: 'cron', category: 'write',
    description: 'Schedule the agent to do something later or repeatedly, unattended (reports, reminders, monitoring, backups). Actions: create (prompt, schedule, name?, deliver?), list, update (id + fields), pause, resume, remove, run_now (id). schedule: "every 30m", "every 2h", "in 10m", an ISO date/time, or 5-field cron ("0 9 * * 1-5" = weekdays 09:00 local time). deliver: desktop (notification, default), telegram (needs /sethome in the bot), local (log only). The prompt must be fully self-contained: the job runs in a fresh session with no memory of this chat. Needs user permission.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'list', 'update', 'pause', 'resume', 'remove', 'run_now'] }, id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, deliver: { type: 'string', enum: ['desktop', 'telegram', 'local'] }, skills: { type: 'array', items: { type: 'string' } } }, required: ['action'] },
    confirm: (a) => (a.action === 'list' ? null : { title: `زمان‌بندی: ${a.action}`, detail: [a.name, a.schedule, a.prompt && String(a.prompt).slice(0, 300), a.id].filter(Boolean).join('\n') }),
    run: (a, call) => act(a, call.source),
  }];

  return {
    defs,
    start: () => { if (!timer) { timer = setInterval(tick, 20000); setTimeout(tick, 5000); } },
    stop: () => { if (timer) clearInterval(timer); timer = null; },
    list: async () => { await load(); return jobs.map((j) => ({ ...j })); },
    runs: () => readJ(runsFile(), []),
    act: (a) => act(a, 'desktop'),
  };
}

module.exports = { register, parseSchedule, parseCron, cronNext, nextRun };
