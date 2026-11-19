// Skills: reusable SKILL.md playbooks (agentskills.io-style). Index goes into the system prompt;
// full text is loaded on demand with skill_view. The agent can create/patch skills itself.
const fs = require('fs/promises');
const path = require('path');
const { parseFrontmatter, isInside, exists } = require('./util');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function register(ctx) {
  const root = () => path.join(ctx.userDataDir(), 'skills');
  const extra = () => (ctx.getSettings().extraSkillsDir || '').trim();

  async function seed() {
    try {
      const marker = path.join(root(), '.seeded');
      if (await exists(marker)) return;
      await fs.mkdir(root(), { recursive: true });
      // Flat layout: bundled skills are files named skill-<name>.md next to this script.
      for (const f of await fs.readdir(__dirname)) {
        const m = /^skill-(.+)\.md$/.exec(f);
        if (!m) continue;
        const dest = path.join(root(), m[1]);
        if (!(await exists(dest))) {
          await fs.mkdir(dest, { recursive: true });
          await fs.writeFile(path.join(dest, 'SKILL.md'), await fs.readFile(path.join(__dirname, f)));
        }
      }
      await fs.writeFile(marker, new Date().toISOString());
    } catch { /* seeding is best-effort */ }
  }

  async function scan(dir, source) {
    const out = [];
    let items = [];
    try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const d of items) {
      if (!d.isDirectory()) continue;
      const file = path.join(dir, d.name, 'SKILL.md');
      try {
        const { meta } = parseFrontmatter(await fs.readFile(file, 'utf8'));
        out.push({ name: meta.name || d.name, dirName: d.name, description: meta.description || '', dir: path.join(dir, d.name), source });
      } catch { /* not a skill */ }
    }
    return out;
  }

  async function listSkills() {
    const mine = await scan(root(), 'user');
    const ext = extra() ? await scan(extra(), 'external') : [];
    const seen = new Set(mine.map((s) => s.name));
    return mine.concat(ext.filter((s) => !seen.has(s.name))).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function indexPrompt() {
    const list = await listSkills();
    if (!list.length) return '';
    return list.slice(0, 80).map((s) => `- ${s.name}: ${s.description.slice(0, 160)}`).join('\n');
  }

  const find = async (name) => (await listSkills()).find((s) => s.name === name || s.dirName === name);
  const userSkillDir = (name) => path.join(root(), name);
  const P = (props, req) => ({ type: 'object', properties: props, required: req || [] });

  const defs = [
    {
      name: 'skills_list', toolset: 'skills', category: 'read',
      description: 'List available skills (name + description).',
      parameters: P({}),
      run: async () => {
        const l = await listSkills();
        return l.length ? l.map((s) => `${s.name} — ${s.description}${s.source === 'external' ? ' [external]' : ''}`).join('\n') : 'No skills yet.';
      },
    },
    {
      name: 'skill_view', toolset: 'skills', category: 'read',
      description: 'Load a skill\'s full instructions (SKILL.md), or one of its extra files via file_path. Do this BEFORE starting a task that matches a skill in the index.',
      parameters: P({ name: { type: 'string' }, file_path: { type: 'string', description: 'optional file inside the skill folder' } }, ['name']),
      run: async (a) => {
        const s = await find(a.name);
        if (!s) return `ERROR: skill "${a.name}" not found. Use skills_list.`;
        if (a.file_path) {
          const f = path.join(s.dir, a.file_path);
          if (!isInside(s.dir, f)) return 'ERROR: file_path must stay inside the skill folder.';
          return await fs.readFile(f, 'utf8');
        }
        const text = await fs.readFile(path.join(s.dir, 'SKILL.md'), 'utf8');
        let files = [];
        try { files = (await fs.readdir(s.dir)).filter((n) => n !== 'SKILL.md'); } catch {}
        return text + (files.length ? `\n\n[Extra files: ${files.join(', ')} — load with file_path]` : '');
      },
    },
    {
      name: 'skill_manage', toolset: 'skills', category: 'write',
      description: 'Create, edit, patch or delete YOUR skills (self-improvement). Actions: create (name, content = full SKILL.md with frontmatter name/description), edit (name, content = full replacement), patch (name, old_string, new_string), write_file (name, file_path, content), delete (name). Use after solving non-trivial tasks or when a skill proved wrong. Needs user permission.',
      parameters: P({ action: { type: 'string', enum: ['create', 'edit', 'patch', 'write_file', 'delete'] }, name: { type: 'string' }, content: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, file_path: { type: 'string' } }, ['action', 'name']),
      confirm: (a) => ({ title: `Skill: ${a.action} «${a.name}»`, detail: String(a.content || a.new_string || '').slice(0, 500) }),
      run: async (a) => {
        if (!NAME_RE.test(a.name)) return 'ERROR: name must be kebab-case: lowercase letters, digits, hyphens (max 64).';
        const dir = userSkillDir(a.name);
        const file = path.join(dir, 'SKILL.md');
        if (a.action === 'create') {
          if (await exists(file)) return `ERROR: skill "${a.name}" already exists — use edit or patch.`;
          const c = String(a.content || '');
          const { meta } = parseFrontmatter(c);
          if (!meta.name || !meta.description) return 'ERROR: content must start with frontmatter containing name: and description:.';
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(file, c, 'utf8');
          return `OK: skill "${a.name}" created.`;
        }
        if (!(await exists(file))) return `ERROR: skill "${a.name}" not found in your skills folder.`;
        if (a.action === 'edit') {
          const { meta } = parseFrontmatter(String(a.content || ''));
          if (!meta.name || !meta.description) return 'ERROR: content must keep frontmatter name:/description:.';
          await fs.writeFile(file, a.content, 'utf8');
          return `OK: skill "${a.name}" replaced.`;
        }
        if (a.action === 'patch') {
          const t = await fs.readFile(file, 'utf8');
          const n = t.split(a.old_string || '\u0000').length - 1;
          if (n !== 1) return n ? `ERROR: old_string matches ${n} places.` : 'ERROR: old_string not found.';
          await fs.writeFile(file, t.replace(a.old_string, () => a.new_string || ''), 'utf8');
          return `OK: skill "${a.name}" patched.`;
        }
        if (a.action === 'write_file') {
          if (!a.file_path) return 'ERROR: file_path required.';
          const f = path.join(dir, a.file_path);
          if (!isInside(dir, f) || path.basename(f) === 'SKILL.md') return 'ERROR: invalid file_path.';
          await fs.mkdir(path.dirname(f), { recursive: true });
          await fs.writeFile(f, String(a.content || ''), 'utf8');
          return `OK: wrote ${a.file_path}.`;
        }
        if (a.action === 'delete') { await fs.rm(dir, { recursive: true, force: true }); return `OK: skill "${a.name}" deleted.`; }
        return 'ERROR: unknown action.';
      },
    },
  ];

  return { defs, listSkills, indexPrompt, seed, find, readSkill: async (name) => { const s = await find(name); return s ? fs.readFile(path.join(s.dir, 'SKILL.md'), 'utf8') : null; } };
}

module.exports = { register };
