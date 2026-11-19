// File tools: list/read/write/patch/search/move/delete + checkpoints (auto-backup before every overwrite).
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fsSync = require('fs');
const { truncate } = require('./util');

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '__pycache__', '.venv', 'venv', '$RECYCLE.BIN', 'System Volume Information', '.next', '.cache']);

function globToRegex(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]').replace(/\u0000/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}

function register(ctx) {
  const ckDir = () => path.join(ctx.userDataDir(), 'checkpoints');
  const ckIndexFile = () => path.join(ckDir(), 'index.json');
  const readIndex = async () => { try { return JSON.parse(await fs.readFile(ckIndexFile(), 'utf8')); } catch { return []; } };

  // Back up the current content of a file (if it exists) before it's changed.
  async function checkpoint(p) {
    let buf;
    try { buf = await fs.readFile(p); } catch { return null; }
    await fs.mkdir(ckDir(), { recursive: true });
    const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    await fs.writeFile(path.join(ckDir(), id + '.bak'), buf);
    const idx = await readIndex();
    idx.push({ id, path: path.resolve(p), ts: Date.now(), size: buf.length });
    while (idx.length > 300) { const old = idx.shift(); await fs.unlink(path.join(ckDir(), old.id + '.bak')).catch(() => {}); }
    await fs.writeFile(ckIndexFile(), JSON.stringify(idx));
    return id;
  }

  const defaultRoot = () => ctx.getSettings().workspaceDir || os.homedir();

  // ---- path resolution: quotes, file://, ~, %VAR%/$VAR, Desktop/Documents/Downloads aliases (OneDrive-safe), relative -> workspace ----
  const KNOWN = {
    desktop: 'desktop', 'دسکتاپ': 'desktop', 'میزکار': 'desktop',
    documents: 'documents', 'اسناد': 'documents', 'مستندات': 'documents',
    downloads: 'downloads', 'دانلود': 'downloads', 'دانلودها': 'downloads',
    pictures: 'pictures', 'تصاویر': 'pictures', 'عکس‌ها': 'pictures',
    music: 'music', 'موسیقی': 'music', videos: 'videos', 'ویدیو': 'videos', 'ویدیوها': 'videos',
    home: 'home', 'هوم': 'home',
  };
  function knownDir(k) { try { return ctx.electron.app.getPath(k); } catch { return path.join(os.homedir(), k[0].toUpperCase() + k.slice(1)); } }
  function resolvePath(raw) {
    let p = String(raw == null ? '' : raw).trim().replace(/^["'`“”]+|["'`“”]+$/g, '').trim();
    if (!p) return defaultRoot();
    if (/^file:\/\//i.test(p)) { try { p = require('url').fileURLToPath(p); } catch {} }
    p = p.replace(/%([^%\\/]+)%/g, (m, n) => (process.env[n] != null ? process.env[n] : m))
      .replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => (process.env[a || b] != null ? process.env[a || b] : m));
    if (/^[A-Za-z]:$/.test(p)) p += path.sep;
    if (p === '~' || /^~[\\/]/.test(p)) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) {
      const m = p.match(/^([^\\/]+)(?:[\\/](.*))?$/);
      const key = m && KNOWN[m[1].toLowerCase()];
      const local = path.resolve(defaultRoot(), p);
      if (key && !fsSync.existsSync(local)) p = path.join(key === 'home' ? os.homedir() : knownDir(key), m[2] || '');
      else p = local;
    }
    return path.normalize(p);
  }
  const fmtSize = (n) => (n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(1) + 'KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + 'MB' : (n / 1073741824).toFixed(2) + 'GB');
  const fmtDate = (t) => { try { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); } catch { return ''; } };

  async function nearestExisting(p) {
    let cur = p;
    for (let i = 0; i < 40; i++) { const up = path.dirname(cur); if (up === cur) return null; cur = up; try { const st = await fs.stat(cur); if (st.isDirectory()) return cur; } catch {} }
    return null;
  }
  // Turn raw fs errors into messages the model can act on.
  async function explain(e, p) {
    const code = e && e.code;
    if (code === 'ENOENT') {
      const near = await nearestExisting(p);
      let hint = '';
      if (near) { try { const items = (await fs.readdir(near)).slice(0, 40); hint = `\nNearest existing folder: ${near}\nIt contains: ${items.join(', ') || '(empty)'}`; } catch {} }
      return `ERROR: path not found: ${p}${hint}\nTip: check spelling with list_dir on the parent folder; Desktop/Documents/Downloads/~ aliases are supported.`;
    }
    if (code === 'EACCES' || code === 'EPERM') return `ERROR: permission denied for ${p} (${code}). The folder may be protected or in use by another program.`;
    if (code === 'EISDIR') return `ERROR: ${p} is a folder, not a file. Use list_dir to see inside it.`;
    if (code === 'ENOTDIR') return `ERROR: ${p} is a file, not a folder (or a parent in the path is a file).`;
    if (code === 'EBUSY') return `ERROR: ${p} is busy/locked by another program.`;
    return 'ERROR: ' + (e && e.message ? e.message : String(e));
  }
  const guard = (fn, pathOf) => async (a, call) => {
    try { return await fn(a, call); } catch (e) { if (e && (e.name === 'AbortError' || e.message === 'STOPPED')) throw e; return await explain(e, resolvePath(pathOf ? pathOf(a) : a.path)); }
  };

  // Directory listing (optionally recursive) with sizes and dates; folders first.
  async function listDirText(p, opts = {}) {
    const depth = Math.max(1, Math.min(6, +opts.depth || 1));
    const max = Math.max(10, Math.min(2000, +opts.max_entries || 300));
    const hidden = !!opts.show_hidden;
    const st = await fs.stat(p);
    if (!st.isDirectory()) return `${p} is a FILE (${fmtSize(st.size)}, modified ${fmtDate(st.mtimeMs)}). Use read_file to read it.`;
    const lines = []; let nDirs = 0, nFiles = 0, truncated = false, skipped = 0;
    async function walk(d, level) {
      let items;
      try { items = await fs.readdir(d, { withFileTypes: true }); } catch (e) { lines.push('  '.repeat(level) + `(cannot open: ${e.code || e.message})`); return; }
      items.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      for (const it of items) {
        if (!hidden && it.name.startsWith('.')) { skipped++; continue; }
        if (lines.length >= max) { truncated = true; return; }
        const full = path.join(d, it.name);
        const ind = '  '.repeat(level);
        let isDir = it.isDirectory(), size = 0, mt = 0;
        try { const s = await fs.stat(full); isDir = s.isDirectory(); size = s.size; mt = s.mtimeMs; } catch {}
        if (isDir) {
          nDirs++; lines.push(`${ind}[DIR]  ${it.name}/   ${fmtDate(mt)}`);
          if (level + 1 < depth && !SKIP_DIRS.has(it.name)) await walk(full, level + 1);
          else if (level + 1 < depth) lines.push(`${ind}  (skipped: ${it.name} is ignored in deep listings)`);
        } else { nFiles++; lines.push(`${ind}[FILE] ${it.name}   ${fmtSize(size)}   ${fmtDate(mt)}`); }
        if (truncated) return;
      }
    }
    await walk(p, 0);
    const head = `Folder: ${p}\n${nDirs} folders, ${nFiles} files${depth > 1 ? ` (depth ${depth})` : ''}${skipped ? `, ${skipped} hidden items not shown (show_hidden=true)` : ''}`;
    return head + '\n' + (lines.join('\n') || '(empty)') + (truncated ? `\n...[stopped at ${max} entries — narrow the path, lower depth, or raise max_entries]` : '');
  }

  async function exists(p) { try { await fs.stat(p); return true; } catch { return false; } }
  async function isDirP(p) { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } }
  async function copyAny(from, to) { await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false }); }
  const isBinary = (buf) => buf.subarray(0, 4096).includes(0);
  const P = (props, req) => ({ type: 'object', properties: props, required: req || [] });
  const dir = (a, t) => ({ title: t, detail: resolvePath(a.path) });

  async function fuzzyReplace(content, oldS, newS) {
    // line-based, whitespace-insensitive match; returns new content or null
    const lines = content.split('\n');
    const want = oldS.replace(/\r/g, '').split('\n').map((l) => l.trim());
    while (want.length && want[want.length - 1] === '') want.pop();
    if (!want.length) return null;
    const hits = [];
    for (let i = 0; i + want.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) if (lines[i + j].replace(/\r/g, '').trim() !== want[j]) { ok = false; break; }
      if (ok) hits.push(i);
    }
    if (hits.length !== 1) return hits.length ? 'AMBIGUOUS' : null;
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const repl = newS.replace(/\r?\n/g, eol).split(eol);
    lines.splice(hits[0], want.length, ...repl.map((l, k) => (k === repl.length - 1 && /\r$/.test(lines[hits[0] + want.length - 1] || '') ? l : l)));
    return lines.join('\n');
  }

  return {
    checkpoint, resolvePath, listDirText,
    defs: [
      {
        name: 'list_dir', toolset: 'files', category: 'read',
        description: 'List a folder: names, sizes, modified dates, folders first. depth=1..6 shows a tree (recursive); show_hidden includes dotfiles. Accepts absolute paths, ~, %USERPROFILE%, Desktop/Documents/Downloads, relative paths (to the workspace). If the path is a file, returns its info.',
        parameters: P({ path: { type: 'string', description: 'folder path (default: workspace or home)' }, depth: { type: 'number', description: '1 = this folder only (default); up to 6 for a tree' }, show_hidden: { type: 'boolean' }, max_entries: { type: 'number' } }),
        run: guard(async (a) => listDirText(resolvePath(a.path), a)),
      },
      {
        name: 'path_info', toolset: 'files', category: 'read',
        description: 'Check whether a path exists and what it is: type, absolute path, size, dates. For folders also counts files/subfolders and total size (recursive, capped).',
        parameters: P({ path: { type: 'string' } }, ['path']),
        run: guard(async (a, call) => {
          const p = resolvePath(a.path);
          let st; try { st = await fs.stat(p); } catch (e) { if (e.code === 'ENOENT') return `NOT FOUND: ${p}`; throw e; }
          if (!st.isDirectory()) return `FILE: ${p}\nsize: ${fmtSize(st.size)} (${st.size} bytes)\nmodified: ${fmtDate(st.mtimeMs)}\ncreated: ${fmtDate(st.birthtimeMs)}`;
          let files = 0, dirs = 0, total = 0, n = 0; const stack = [p]; let capped = false;
          while (stack.length) {
            if (call && call.signal && call.signal.aborted) break;
            const d = stack.pop(); let items; try { items = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
            for (const it of items) {
              if (++n > 50000) { capped = true; stack.length = 0; break; }
              const full = path.join(d, it.name);
              if (it.isDirectory()) { dirs++; stack.push(full); } else if (it.isFile()) { files++; try { total += (await fs.stat(full)).size; } catch {} }
            }
          }
          return `FOLDER: ${p}\n${files} files, ${dirs} subfolders, total ${fmtSize(total)}${capped ? ' (scan capped at 50000 items)' : ''}\nmodified: ${fmtDate(st.mtimeMs)}`;
        }),
      },
      {
        name: 'read_file', toolset: 'files', category: 'read',
        description: 'Read a text file. Optional offset (1-based line) and limit (lines) for big files; numbered=true prefixes line numbers. Without them: first 60000 characters. If given a folder, lists it instead.',
        parameters: P({ path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' }, numbered: { type: 'boolean' } }, ['path']),
        run: guard(async (a) => {
          const p = resolvePath(a.path);
          if (await isDirP(p)) return `(${p} is a folder — showing its contents)\n` + await listDirText(p, {});
          const buf = await fs.readFile(p);
          if (isBinary(buf)) return `ERROR: ${p} looks binary (${buf.length} bytes). Use vision_analyze for images or run_command for other formats.`;
          let t = buf.toString('utf8');
          if (a.offset || a.limit || a.numbered) {
            const lines = t.split('\n');
            const start = Math.max(1, +a.offset || 1) - 1;
            const end = a.limit ? Math.min(lines.length, start + Math.max(1, +a.limit)) : lines.length;
            const slice = lines.slice(start, end).map((l, i) => (a.numbered ? `${String(start + i + 1).padStart(5)}| ${l}` : l)).join('\n');
            const more = end < lines.length ? `\n...[${lines.length - end} more lines; continue with offset=${end + 1}]` : '';
            return truncate(slice, 60000) + more;
          }
          return t.length > 60000 ? t.slice(0, 60000) + `\n...[truncated, file has ${t.length} chars — use offset/limit]` : t;
        }),
      },
      {
        name: 'write_file', toolset: 'files', category: 'write',
        description: 'Create or overwrite a text file (parent folders are created; a checkpoint of the old version is saved automatically). For small edits prefer patch. Needs user permission.',
        parameters: P({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
        confirm: (a) => dir(a, 'نوشتن / بازنویسی فایل'),
        run: guard(async (a) => {
          const p = resolvePath(a.path);
          if (await isDirP(p)) return `ERROR: ${p} is an existing folder. Give a file name, e.g. ${path.join(p, 'file.txt')}`;
          await checkpoint(p);
          await fs.mkdir(path.dirname(p), { recursive: true });
          await fs.writeFile(p, a.content, 'utf8');
          return `OK: file written to ${p} (${a.content.length} chars).`;
        }),
      },
      {
        name: 'patch', toolset: 'files', category: 'write',
        description: 'Edit a file by replacing old_string with new_string (exact match; falls back to whitespace-insensitive line match if unique). Fails if old_string is not found or ambiguous (add more context or use replace_all). A checkpoint is saved. Needs user permission.',
        parameters: P({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
        confirm: (a) => ({ title: 'ویرایش فایل (patch)', detail: `${resolvePath(a.path)}\n− ${String(a.old_string).slice(0, 300)}\n+ ${String(a.new_string).slice(0, 300)}` }),
        run: guard(async (a) => {
          const p = resolvePath(a.path);
          const raw = await fs.readFile(p, 'utf8');
          if (!a.old_string) return 'ERROR: old_string is empty (use write_file to create files).';
          let out = null;
          const count = raw.split(a.old_string).length - 1;
          if (count === 1 || (count > 1 && a.replace_all)) out = a.replace_all ? raw.split(a.old_string).join(a.new_string) : raw.replace(a.old_string, () => a.new_string);
          else if (count > 1) return `ERROR: old_string matches ${count} places — add more surrounding context or set replace_all=true.`;
          else {
            const f = await fuzzyReplace(raw, a.old_string, a.new_string);
            if (f === 'AMBIGUOUS') return 'ERROR: old_string matches several places ignoring whitespace — add more context.';
            if (f == null) return 'ERROR: old_string not found. Re-read the file (read_file numbered=true) and copy the exact text.';
            out = f;
          }
          await checkpoint(p);
          await fs.writeFile(p, out, 'utf8');
          return `OK: patched ${p}${a.replace_all ? ` (${count} replacements)` : ''}.`;
        }),
      },
      {
        name: 'search_files', toolset: 'files', category: 'read',
        description: 'Search file CONTENTS with a regex (mode=content) or find files/folders by NAME glob (mode=name) under a folder. Skips node_modules/.git etc. Returns path:line: text.',
        parameters: P({ pattern: { type: 'string', description: 'regex for content mode, glob (*.js, **/test*) for name mode' }, path: { type: 'string', description: 'folder (default: workspace/home)' }, mode: { type: 'string', enum: ['content', 'name'] }, glob: { type: 'string', description: 'only files whose name matches, e.g. *.py' }, case_insensitive: { type: 'boolean' }, max_results: { type: 'number' } }, ['pattern']),
        run: guard(async (a, call) => {
          const root = resolvePath(a.path);
          if (!(await isDirP(root))) return `ERROR: ${root} is not a folder (or does not exist).`;
          const max = Math.max(1, Math.min(500, +a.max_results || 100));
          const mode = a.mode || 'content';
          let re, nameRe = a.glob ? globToRegex(a.glob) : null;
          if (mode === 'name') re = globToRegex(a.pattern);
          else { try { re = new RegExp(a.pattern, a.case_insensitive ? 'i' : ''); } catch (e) { return 'ERROR: bad regex: ' + e.message; } }
          const results = []; let scanned = 0;
          const stack = [root];
          while (stack.length && results.length < max && scanned < 30000) {
            if (call && call.signal && call.signal.aborted) break;
            const d = stack.pop();
            let items; try { items = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
            for (const it of items) {
              const full = path.join(d, it.name);
              if (it.isDirectory()) {
                if (SKIP_DIRS.has(it.name)) continue;
                stack.push(full);
                if (mode === 'name' && (re.test(it.name) || re.test(path.relative(root, full).replace(/\\/g, '/')))) results.push(full + path.sep);
                continue;
              }
              if (!it.isFile()) continue;
              scanned++;
              if (mode === 'name') { if (re.test(it.name) || re.test(path.relative(root, full).replace(/\\/g, '/'))) results.push(full); continue; }
              if (nameRe && !nameRe.test(it.name)) continue;
              try {
                const st = await fs.stat(full);
                if (st.size > 1.5 * 1024 * 1024) continue;
                const buf = await fs.readFile(full);
                if (isBinary(buf)) continue;
                const lines = buf.toString('utf8').split('\n');
                for (let i = 0; i < lines.length && results.length < max; i++) if (re.test(lines[i])) results.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              } catch {}
              if (results.length >= max) break;
            }
          }
          return results.length ? results.join('\n') + (results.length >= max ? `\n...[stopped at ${max} results]` : '') : `No matches (scanned ${scanned} files under ${root}).`;
        }),
      },
      {
        name: 'make_dir', toolset: 'files', category: 'write',
        description: 'Create a folder (and any missing parent folders). Needs user permission.',
        parameters: P({ path: { type: 'string' } }, ['path']),
        confirm: (a) => dir(a, 'ساخت پوشه'),
        run: guard(async (a) => {
          const p = resolvePath(a.path);
          if (await exists(p) && !(await isDirP(p))) return `ERROR: a FILE already exists at ${p}.`;
          await fs.mkdir(p, { recursive: true }); return `OK: folder ready: ${p}`;
        }),
      },
      {
        name: 'copy_path', toolset: 'files', category: 'write',
        description: 'Copy a file or a whole folder (recursive). If "to" is an existing folder, the item is copied INTO it. Never overwrites existing files. Needs user permission.',
        parameters: P({ from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']),
        confirm: (a) => ({ title: 'کپی فایل / پوشه', detail: `${resolvePath(a.from)}\n⟶ ${resolvePath(a.to)}` }),
        run: guard(async (a) => {
          const from = resolvePath(a.from); let to = resolvePath(a.to);
          if (!(await exists(from))) return `ERROR: source not found: ${from}`;
          if (await isDirP(to)) to = path.join(to, path.basename(from));
          if (await exists(to)) return `ERROR: destination already exists: ${to} (choose another name).`;
          if (to === from || to.startsWith(from + path.sep)) return 'ERROR: cannot copy a folder into itself.';
          await fs.mkdir(path.dirname(to), { recursive: true });
          await copyAny(from, to);
          return `OK: copied to ${to}`;
        }, (a) => a.from),
      },
      {
        name: 'move_or_rename', toolset: 'files', category: 'write',
        description: 'Move or rename a file/folder. If "to" is an existing folder, the item is moved INTO it (keeps its name). Works across drives. Does not overwrite existing items. Needs user permission.',
        parameters: P({ from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']),
        confirm: (a) => ({ title: 'جابه‌جایی / تغییر نام', detail: `${resolvePath(a.from)}\n⟶ ${resolvePath(a.to)}` }),
        run: guard(async (a) => {
          const from = resolvePath(a.from); let to = resolvePath(a.to);
          if (!(await exists(from))) return `ERROR: source not found: ${from}`;
          if (await isDirP(to)) to = path.join(to, path.basename(from));
          if (to === from) return 'OK: source and destination are the same — nothing to do.';
          if (await exists(to) && to.toLowerCase() !== from.toLowerCase()) return `ERROR: destination already exists: ${to} (choose another name or delete it first).`;
          if (to.startsWith(from + path.sep)) return 'ERROR: cannot move a folder into itself.';
          await fs.mkdir(path.dirname(to), { recursive: true });
          try { await fs.rename(from, to); }
          catch (e) {
            if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
            await copyAny(from, to); await fs.rm(from, { recursive: true, force: true });
          }
          return `OK: moved to ${to}`;
        }, (a) => a.from),
      },
      {
        name: 'delete_path', toolset: 'files', category: 'write',
        description: 'Delete a file or folder (moved to the Recycle Bin, so it is recoverable). Needs user permission.',
        parameters: P({ path: { type: 'string' } }, ['path']),
        confirm: (a) => dir(a, 'حذف (انتقال به سطل زباله)'),
        run: guard(async (a) => {
          const p = resolvePath(a.path);
          if (!(await exists(p))) return `ERROR: not found: ${p}`;
          if (path.parse(p).root === p || p === os.homedir()) return 'ERROR: refusing to delete a drive root or the home folder.';
          await ctx.electron.shell.trashItem(p); return `OK: moved to Recycle Bin: ${p}`;
        }),
      },
      {
        name: 'file_history', toolset: 'files', category: 'read',
        description: 'List automatic checkpoints (backups made before write_file/patch changed a file). Optionally filter by path.',
        parameters: P({ path: { type: 'string' }, limit: { type: 'number' } }),
        run: async (a) => {
          let idx = await readIndex();
          if (a.path) { const p = resolvePath(a.path); idx = idx.filter((e) => e.path === p); }
          idx = idx.slice(-(+a.limit || 20)).reverse();
          return idx.length ? idx.map((e) => `${e.id}  ${new Date(e.ts).toLocaleString()}  ${e.size}B  ${e.path}`).join('\n') : 'No checkpoints.';
        },
      },
      {
        name: 'file_restore', toolset: 'files', category: 'write',
        description: 'Restore a file from a checkpoint (rollback). Give the checkpoint id from file_history, or just a path to restore its latest checkpoint. The current version is checkpointed first, so rollback is undoable. Needs user permission.',
        parameters: P({ id: { type: 'string' }, path: { type: 'string' } }),
        confirm: (a) => ({ title: 'بازگردانی فایل از checkpoint', detail: a.id || a.path || '(آخرین checkpoint)' }),
        run: async (a) => {
          const idx = await readIndex();
          let e;
          if (a.id) e = idx.find((x) => x.id === a.id);
          else if (a.path) e = [...idx].reverse().find((x) => x.path === resolvePath(a.path));
          else e = idx[idx.length - 1];
          if (!e) return 'ERROR: checkpoint not found.';
          const buf = await fs.readFile(path.join(ckDir(), e.id + '.bak'));
          await checkpoint(e.path);
          await fs.mkdir(path.dirname(e.path), { recursive: true });
          await fs.writeFile(e.path, buf);
          return `OK: restored ${e.path} from ${new Date(e.ts).toLocaleString()} (${e.size} bytes).`;
        },
      },
    ],
  };
}

module.exports = { register };
