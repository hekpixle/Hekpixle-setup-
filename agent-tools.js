// Agent-level tools: todo (planning), clarify (ask the user), session_search (past chats),
// send_message (Telegram), delegate_task (parallel sub-agents), forget_memory.
const fs = require('fs/promises');
const path = require('path');

const SUB_BLOCKED = new Set(['delegate_task', 'clarify', 'send_message', 'cronjob', 'save_memory', 'forget_memory', 'skill_manage', 'todo']);

function register(ctx) {
  const P = (props, req) => ({ type: 'object', properties: props, required: req || [] });
  const todoFile = () => path.join(ctx.userDataDir(), 'todo.json');
  const readJ = async (f, d) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } };

  const fmtTodos = (t) => t.length ? t.map((x) => `${x.status === 'completed' ? '[x]' : x.status === 'in_progress' ? '[~]' : x.status === 'cancelled' ? '[-]' : '[ ]'} ${x.id}. ${x.content}`).join('\n') : '(empty)';

  function snippet(text, terms) {
    const low = text.toLowerCase();
    let at = -1;
    for (const t of terms) { const i = low.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
    const s = Math.max(0, (at < 0 ? 0 : at) - 80);
    return text.slice(s, s + 260).replace(/\s+/g, ' ').trim();
  }

  async function searchSessions(query, limit) {
    const terms = String(query).toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (!terms.length) return 'ERROR: empty query';
    const files = [['chats.json', 'desktop chat'], ['tg_chats.json', 'telegram']];
    const hits = [];
    for (const [f, label] of files) {
      const data = await readJ(path.join(ctx.userDataDir(), f), null);
      const chats = Array.isArray(data) ? data : data && (data.chats || (typeof data === 'object' ? Object.values(data) : []));
      for (const c of chats || []) {
        const msgs = Array.isArray(c) ? c : c && c.messages;
        if (!Array.isArray(msgs)) continue;
        msgs.forEach((m, i) => {
          const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join(' ') : '';
          if (!text || (m.role !== 'user' && m.role !== 'assistant')) return;
          const low = text.toLowerCase();
          const score = terms.reduce((s, t) => s + (low.includes(t) ? 1 : 0), 0);
          if (score) hits.push({ score: score / terms.length + (m.role === 'user' ? 0.01 : 0), label, title: (c && c.title) || '', role: m.role, i, text });
        });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, limit);
    if (!top.length) return 'No matching past conversations.';
    return top.map((h) => `• [${h.label}${h.title ? ': ' + h.title : ''}] ${h.role}: …${snippet(h.text, terms)}…`).join('\n');
  }

  const defs = [
    {
      name: 'todo', toolset: 'planning', category: 'read',
      description: 'Plan and track multi-step work. Call with todos=[{id,content,status}] (status: pending|in_progress|completed|cancelled). merge=true updates/adds items by id; merge=false (default) replaces the list. Call with no args to read it. Use for tasks with 3+ steps; keep exactly one item in_progress.',
      parameters: P({ todos: { type: 'array', items: P({ id: { type: 'string' }, content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] } }, ['id', 'content', 'status']) }, merge: { type: 'boolean' } }),
      run: async (a, call) => {
        let list = call.todos || (call.todos = await readJ(todoFile(), []));
        if (Array.isArray(a.todos)) {
          if (a.merge) { for (const t of a.todos) { const i = list.findIndex((x) => String(x.id) === String(t.id)); if (i >= 0) list[i] = { ...list[i], ...t }; else list.push(t); } }
          else list = a.todos;
          call.todos = list;
          await fs.writeFile(todoFile(), JSON.stringify(list)).catch(() => {});
          call.emit && call.emit({ type: 'todo', todos: list });
        }
        return fmtTodos(list);
      },
    },
    {
      name: 'clarify', toolset: 'planning', category: 'read',
      description: 'Ask the user a clarifying question and wait for the answer. Optionally give up to 4 choices. Use only when you truly cannot proceed without their input (ambiguous goal, a decision only they can make).',
      parameters: P({ question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } } }, ['question']),
      run: async (a, call) => {
        if (call.source !== 'desktop') return 'The user is not at the desktop right now — ask your question in your final reply instead and stop here.';
        const ans = await ctx.askUser(String(a.question), (a.choices || []).slice(0, 4).map(String));
        return ans ? `User answered: ${ans}` : 'The user did not answer.';
      },
    },
    {
      name: 'session_search', toolset: 'memory', category: 'read',
      description: 'Search your past conversations (desktop + Telegram) for things the user said or you did before. Returns matching snippets. Use when the user refers to earlier work ("like last time", "that script we wrote").',
      parameters: P({ query: { type: 'string' }, limit: { type: 'number' } }, ['query']),
      run: (a) => searchSessions(a.query, Math.max(1, Math.min(15, +a.limit || 6))),
    },
    {
      name: 'forget_memory', toolset: 'memory', category: 'write',
      description: 'Delete a saved memory by its key.',
      parameters: P({ key: { type: 'string' } }, ['key']),
      run: async (a) => {
        const f = path.join(ctx.userDataDir(), 'memory.json');
        const mem = await readJ(f, { entries: [] });
        const before = (mem.entries || []).length;
        mem.entries = (mem.entries || []).filter((e) => e.key !== a.key);
        await fs.writeFile(f, JSON.stringify(mem, null, 2));
        return before === mem.entries.length ? `No memory with key "${a.key}".` : `OK: forgot "${a.key}".`;
      },
    },
    {
      name: 'send_message', toolset: 'messaging', category: 'write',
      description: 'Send a text message to the user on Telegram (their home chat set with /sethome, or a given chat_id). Use for notifying when a long task is done or delivering results while they are away.',
      parameters: P({ text: { type: 'string' }, chat_id: { type: 'string' } }, ['text']),
      confirm: (a) => ({ title: 'ارسال پیام تلگرام', detail: String(a.text).slice(0, 300) }),
      run: async (a) => ctx.sendTelegram(String(a.text), a.chat_id),
    },
    {
      name: 'delegate_task', toolset: 'delegation', category: 'control',
      description: 'Spawn sub-agents with fresh context to work in parallel (max 3). Each gets a goal and context and returns a short summary — only the summary enters your context, so use this for research, exploration or independent sub-tasks. tasks=[{goal, context?, toolsets?}] (toolsets e.g. ["web","files","browser"]; default web+files+terminal+code). Sub-agents cannot ask the user, delegate further or write memory.',
      parameters: P({ tasks: { type: 'array', items: P({ goal: { type: 'string' }, context: { type: 'string' }, toolsets: { type: 'array', items: { type: 'string' } } }, ['goal']) }, goal: { type: 'string' }, context: { type: 'string' }, toolsets: { type: 'array', items: { type: 'string' } } }),
      run: async (a, call) => {
        if (call.depth >= 1) return 'ERROR: sub-agents cannot delegate further.';
        let tasks = Array.isArray(a.tasks) ? a.tasks : [];
        if (!tasks.length && a.goal) tasks = [{ goal: a.goal, context: a.context, toolsets: a.toolsets }];
        if (!tasks.length) return 'ERROR: provide tasks or goal.';
        tasks = tasks.slice(0, 3);
        const res = await Promise.all(tasks.map(async (t, i) => {
          try { return `### Sub-agent ${i + 1}: ${String(t.goal).slice(0, 80)}\n${await ctx.runSubAgent(t, call)}`; }
          catch (e) { return `### Sub-agent ${i + 1} failed: ${e.message}`; }
        }));
        return res.join('\n\n');
      },
    },
  ];

  return { defs, SUB_BLOCKED, searchSessions };
}

module.exports = { register, SUB_BLOCKED };
