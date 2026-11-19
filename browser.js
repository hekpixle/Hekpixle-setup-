// Browser automation: a real Chromium window (Electron WebContentsView) the agent
// can drive via accessibility-style snapshots with element refs, plus screenshots.
// Uses a persistent session, so logins survive between runs.
const { sleep, truncate } = require('./util');

const PARTITION = 'persist:hekpixle-browser';

const SNAPSHOT_JS = `(function(maxChars){
  var out=[], len=0, n=0, MAXEL=450;
  document.querySelectorAll('[data-hek-ref]').forEach(function(e){e.removeAttribute('data-hek-ref');});
  var SKIP={SCRIPT:1,STYLE:1,NOSCRIPT:1,TEMPLATE:1,HEAD:1,META:1,LINK:1,SVG:1,PATH:1,IFRAME:0};
  var BLOCK={DIV:1,P:1,SECTION:1,ARTICLE:1,LI:1,UL:1,OL:1,TABLE:1,TR:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,HEADER:1,FOOTER:1,NAV:1,MAIN:1,ASIDE:1,FORM:1,BR:1,HR:1,PRE:1,BLOCKQUOTE:1,DL:1,DT:1,DD:1,FIELDSET:1};
  var vh=window.innerHeight, vw=window.innerWidth;
  function vis(el){var r=el.getBoundingClientRect(); if(r.width<=0||r.height<=0) return false; var cs=getComputedStyle(el); return cs.visibility!=='hidden'&&cs.display!=='none'&&cs.opacity!=='0';}
  function lab(el){return (el.getAttribute('aria-label')||el.innerText||el.value||el.title||el.alt||el.getAttribute('placeholder')||'').replace(/\\s+/g,' ').trim().slice(0,90);}
  function inter(el){
    var t=el.tagName, role=(el.getAttribute('role')||'').toLowerCase();
    if(t==='A'&&el.hasAttribute('href')) return 'link';
    if(t==='BUTTON'||t==='SUMMARY') return 'button';
    if(t==='INPUT'){var ty=(el.type||'text').toLowerCase(); if(ty==='hidden') return null; return ty==='checkbox'||ty==='radio'?ty:(ty==='submit'||ty==='button'||ty==='reset'?'button':'input');}
    if(t==='SELECT') return 'select'; if(t==='TEXTAREA') return 'textarea';
    if(el.isContentEditable&&el.getAttribute('contenteditable')!==null) return 'editable';
    if(/^(button|link|checkbox|radio|tab|menuitem|option|switch|combobox|textbox|searchbox|treeitem)$/.test(role)) return role;
    if(el.hasAttribute('onclick')||el.tabIndex>=0&&t!=='BODY'&&getComputedStyle(el).cursor==='pointer') return 'clickable';
    return null;
  }
  function push(s){ if(len<=maxChars){ out.push(s); len+=s.length; } }
  function walk(node){
    if(len>maxChars) return;
    if(node.nodeType===3){ var tx=node.nodeValue.replace(/\\s+/g,' ').trim(); if(tx) push(tx+' '); return; }
    if(node.nodeType!==1) return;
    var el=node, tag=el.tagName; if(SKIP[tag]) return;
    if(!vis(el)){ if(getComputedStyle(el).display!=='contents') return; }
    var kind=inter(el);
    if(kind && n<MAXEL){
      var ref='e'+(++n); el.setAttribute('data-hek-ref',ref);
      var r=el.getBoundingClientRect(), off=(r.bottom<0||r.top>vh)?' (offscreen)':'';
      var d='['+ref+' '+kind;
      if(tag==='A'){ d+=' "'+lab(el)+'" -> '+(el.href||'').slice(0,200); }
      else if(tag==='INPUT'||tag==='TEXTAREA'){ d+=(el.name?' name='+el.name:'')+(el.getAttribute('placeholder')?' placeholder="'+el.getAttribute('placeholder').slice(0,50)+'"':'')+(el.type==='checkbox'||el.type==='radio'?(el.checked?' checked':' unchecked'):' value="'+String(el.value||'').slice(0,60)+'"')+(el.disabled?' disabled':'')+(lab(el)&&el.type!=='text'&&tag==='INPUT'?' label="'+lab(el)+'"':''); }
      else if(tag==='SELECT'){ var os=[].slice.call(el.options).slice(0,25).map(function(o){return (o.selected?'*':'')+o.value+'='+o.text.trim().slice(0,30);}); d+=(el.name?' name='+el.name:'')+' options: '+os.join(' | '); }
      else { d+=' "'+lab(el)+'"'; }
      push(d+off+'] ');
      if(tag==='A'||tag==='BUTTON'||tag==='SELECT'||tag==='INPUT'||tag==='TEXTAREA'||kind==='button') return;
    }
    var hm=/^H([1-6])$/.exec(tag); if(hm) push('\\n'+'#'.repeat(+hm[1])+' ');
    else if(tag==='LI') push('\\n- ');
    if(el.shadowRoot){ for(var s=el.shadowRoot.firstChild;s;s=s.nextSibling) walk(s); }
    for(var c=el.firstChild;c;c=c.nextSibling) walk(c);
    if(BLOCK[tag]) push('\\n');
  }
  walk(document.body||document.documentElement);
  var text=out.join('').replace(/[ \\t]+\\n/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();
  return JSON.stringify({url:location.href,title:document.title,text:text,elements:n,truncated:len>maxChars,scroll:{y:Math.round(window.scrollY),vh:vh,total:Math.round(document.documentElement.scrollHeight)}});
})`;

const KEYMAP = { enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', arrowup: 'Up', up: 'Up', arrowdown: 'Down', down: 'Down', arrowleft: 'Left', left: 'Left', arrowright: 'Right', right: 'Right', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', space: 'Space' };

function register(ctx) {
  const { BrowserWindow, WebContentsView } = ctx.electron;
  let win = null;
  const tabs = []; // { id, view, logs:[] }
  let active = null;
  let nextId = 1;

  const settings = () => ctx.getSettings();

  function layout() {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    tabs.forEach((t) => { try { t.view.setBounds({ x: 0, y: 0, width: w, height: h }); } catch {} });
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    const show = settings().browserVisible !== false;
    win = new BrowserWindow({ width: 1200, height: 820, show, title: 'Hekpixle Browser', autoHideMenuBar: true, backgroundColor: '#ffffff' });
    win.on('resize', layout);
    win.on('closed', () => { win = null; tabs.length = 0; active = null; });
    return win;
  }

  function newTab(url) {
    const w = ensureWindow();
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const tab = { id: nextId++, view, logs: [] };
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url: u }) => { if (/^https?:/i.test(u)) newTab(u); return { action: 'deny' }; });
    wc.on('console-message', (...args) => {
      // Electron changed this signature across versions: (event, level, message, ...) or (event) with details
      const e = args[0];
      const msg = (e && e.message) || args[2] || '';
      const lvl = (e && e.level) !== undefined ? e.level : args[1];
      tab.logs.push(`[${lvl}] ${String(msg).slice(0, 300)}`);
      if (tab.logs.length > 100) tab.logs.shift();
    });
    wc.on('page-title-updated', (_e, title) => { if (tab === active && win && !win.isDestroyed()) win.setTitle(`${title} — Hekpixle Browser`); });
    tabs.push(tab);
    w.contentView.addChildView(view);
    activate(tab);
    layout();
    if (url) loadUrl(tab, url).catch(() => {});
    return tab;
  }

  function activate(tab) {
    active = tab;
    tabs.forEach((t) => { try { t.view.setVisible(t === tab); } catch {} });
    layout();
  }

  function current() {
    if (!active || !tabs.includes(active)) return newTab();
    return active;
  }

  function waitLoaded(wc, ms = 15000) {
    return new Promise((resolve) => {
      if (!wc.isLoading()) return resolve();
      const done = () => { clearTimeout(t); wc.removeListener('did-stop-loading', done); wc.removeListener('did-fail-load', done); resolve(); };
      const t = setTimeout(done, ms);
      wc.once('did-stop-loading', done);
      wc.once('did-fail-load', done);
    });
  }

  async function loadUrl(tab, url) {
    const wc = tab.view.webContents;
    try { await wc.loadURL(url); } catch (e) { if (!/ERR_ABORTED/.test(String(e && e.message))) throw e; }
    await waitLoaded(wc);
    await sleep(500);
  }

  const evalJs = (tab, code) => tab.view.webContents.executeJavaScript(code, true);

  async function snapshot(tab, maxChars) {
    const wc = tab.view.webContents;
    await waitLoaded(wc, 8000);
    const raw = await evalJs(tab, `${SNAPSHOT_JS}(${Math.max(2000, Math.min(60000, maxChars || 14000))})`);
    const j = JSON.parse(raw);
    const pos = j.scroll.total > j.scroll.vh ? `scroll ${j.scroll.y}/${j.scroll.total - j.scroll.vh}px` : 'fits one screen';
    return `URL: ${j.url}\nTitle: ${j.title}\nTab: ${tab.id} | ${j.elements} interactive elements | ${pos}${j.truncated ? ' | TEXT TRUNCATED (scroll or ask for larger max_chars)' : ''}\n` +
      `Elements are tagged [eN]; use browser_click/browser_type with ref "eN".\n\n${j.text}`;
  }

  async function locate(tab, ref) {
    if (!/^e\d+$/.test(String(ref))) throw new Error('ref must look like "e12" (from browser_snapshot)');
    const r = await evalJs(tab, `(function(){var el=document.querySelector('[data-hek-ref="${ref}"]'); if(!el) return null; el.scrollIntoView({block:'center',inline:'center'}); var r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,tag:el.tagName,type:el.type||''};})()`);
    if (!r) throw new Error(`element ${ref} not found — the page changed; call browser_snapshot again`);
    return r;
  }

  async function realClick(tab, x, y, count = 1) {
    const wc = tab.view.webContents;
    wc.focus();
    x = Math.round(x); y = Math.round(y);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(40);
    for (let i = 1; i <= count; i++) {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: i });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: i });
      await sleep(40);
    }
  }

  async function press(tab, combo) {
    const wc = tab.view.webContents;
    const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean);
    const key = parts.pop();
    const mods = parts.map((m) => { const l = m.toLowerCase(); return l === 'ctrl' ? 'control' : l === 'cmd' || l === 'meta' ? 'meta' : l; });
    const kc = KEYMAP[String(key).toLowerCase()] || (key.length === 1 ? key.toUpperCase() : key);
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: kc, modifiers: mods });
    if (kc === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: mods });
    else if (key.length === 1 && !mods.length) wc.sendInputEvent({ type: 'char', keyCode: key, modifiers: mods });
    wc.sendInputEvent({ type: 'keyUp', keyCode: kc, modifiers: mods });
  }

  async function settle(tab) { await sleep(500); await waitLoaded(tab.view.webContents, 10000); }

  const J = (props, required) => ({ type: 'object', properties: props || {}, required: required || [] });
  const defs = [];

  defs.push({
    name: 'browser_navigate', toolset: 'browser', category: 'control',
    description: 'Open a URL in the agent browser (real Chromium, persistent logins) and return a snapshot: page text plus interactive elements tagged [eN]. Use for any website, JS-heavy pages, logins, forms.',
    parameters: J({ url: { type: 'string' }, new_tab: { type: 'boolean' } }, ['url']),
    run: async (a) => {
      let url = String(a.url).trim();
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
      if (!/^(https?|file|about):/i.test(url)) throw new Error('only http(s) URLs are allowed');
      const tab = a.new_tab || !tabs.length ? newTab() : current();
      await loadUrl(tab, url);
      return truncate(await snapshot(tab), 40000);
    },
  });
  defs.push({
    name: 'browser_snapshot', toolset: 'browser', category: 'read',
    description: 'Re-read the current page: visible text + interactive elements with refs [eN]. Call after any action that may change the page.',
    parameters: J({ max_chars: { type: 'number', description: 'default 14000' } }),
    run: async (a) => truncate(await snapshot(current(), a.max_chars), 65000),
  });
  defs.push({
    name: 'browser_click', toolset: 'browser', category: 'control',
    description: 'Click an element by ref (from the latest snapshot). Returns a fresh snapshot.',
    parameters: J({ ref: { type: 'string' }, double: { type: 'boolean' } }, ['ref']),
    run: async (a) => {
      const tab = current();
      const p = await locate(tab, a.ref);
      await sleep(150);
      await realClick(tab, p.x, p.y, a.double ? 2 : 1);
      await settle(tab);
      return truncate(await snapshot(tab), 40000);
    },
  });
  defs.push({
    name: 'browser_type', toolset: 'browser', category: 'control',
    description: 'Type text into an input/textarea/editable element by ref (replaces existing text unless clear=false). submit=true presses Enter afterwards. Unicode/Persian supported.',
    parameters: J({ ref: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' } }, ['ref', 'text']),
    run: async (a) => {
      const tab = current();
      const wc = tab.view.webContents;
      await locate(tab, a.ref);
      const clear = a.clear !== false;
      await evalJs(tab, `(function(){var el=document.querySelector('[data-hek-ref="${a.ref}"]'); if(!el) return; el.focus(); ${clear ? "if(el.select&&el.tagName!=='SELECT'){el.select();} else if(el.isContentEditable){document.execCommand('selectAll');}" : "if(el.setSelectionRange&&el.value!==undefined){var l=el.value.length;try{el.setSelectionRange(l,l);}catch(e){}}"} })()`);
      wc.focus();
      if (clear && a.text === '') await press(tab, 'Backspace'); else await wc.insertText(String(a.text));
      if (a.submit) { await sleep(150); await press(tab, 'Enter'); await settle(tab); } else await sleep(200);
      return truncate(await snapshot(tab), 40000);
    },
  });
  defs.push({
    name: 'browser_select', toolset: 'browser', category: 'control',
    description: 'Choose an option in a <select> by ref and value (or visible text).',
    parameters: J({ ref: { type: 'string' }, value: { type: 'string' } }, ['ref', 'value']),
    run: async (a) => {
      const tab = current();
      await locate(tab, a.ref);
      const ok = await evalJs(tab, `(function(){var el=document.querySelector('[data-hek-ref="${a.ref}"]'); if(!el||el.tagName!=='SELECT') return false; var v=${JSON.stringify(String(a.value))}; var o=[].slice.call(el.options).find(function(o){return o.value===v||o.text.trim()===v;}); if(!o) return false; el.value=o.value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
      if (!ok) return `ERROR: option "${a.value}" not found in ${a.ref}`;
      await settle(tab);
      return truncate(await snapshot(tab), 40000);
    },
  });
  defs.push({
    name: 'browser_press', toolset: 'browser', category: 'control',
    description: 'Press a key or combo in the page: Enter, Tab, Escape, ArrowDown, PageDown, ctrl+a, ctrl+f …',
    parameters: J({ key: { type: 'string' } }, ['key']),
    run: async (a) => { const tab = current(); await press(tab, a.key); await settle(tab); return truncate(await snapshot(tab), 40000); },
  });
  defs.push({
    name: 'browser_scroll', toolset: 'browser', category: 'control',
    description: 'Scroll the page (or an element by ref) up/down; amount in pixels (default one screen). Returns a fresh snapshot.',
    parameters: J({ direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] }, amount: { type: 'number' }, ref: { type: 'string' } }, ['direction']),
    run: async (a) => {
      const tab = current();
      const target = a.ref ? `document.querySelector('[data-hek-ref="${String(a.ref).replace(/[^e0-9]/g, '')}"]')` : 'null';
      await evalJs(tab, `(function(){var el=${target}; var d=${JSON.stringify(a.direction)}; var amt=${Number(a.amount) || 0}||((el?el.clientHeight:window.innerHeight)*0.85); var s=el||window; if(d==='top') s.scrollTo({top:0}); else if(d==='bottom') s.scrollTo({top:1e9}); else s.scrollBy({top:d==='down'?amt:-amt,behavior:'instant'});})()`);
      await sleep(400);
      return truncate(await snapshot(tab), 40000);
    },
  });
  defs.push({
    name: 'browser_back', toolset: 'browser', category: 'control',
    description: 'Go back (or forward/reload) in the current tab.',
    parameters: J({ action: { type: 'string', enum: ['back', 'forward', 'reload'] } }),
    run: async (a) => {
      const tab = current(); const wc = tab.view.webContents;
      const nh = wc.navigationHistory;
      if (a.action === 'forward') (nh ? nh.goForward() : wc.goForward());
      else if (a.action === 'reload') wc.reload();
      else (nh ? nh.goBack() : wc.goBack());
      await settle(tab);
      return truncate(await snapshot(tab), 40000);
    },
  });
  defs.push({
    name: 'browser_screenshot', toolset: 'browser', category: 'read',
    description: 'Take a screenshot of the current browser page so you can SEE it (layout, images, charts, captchas). Use browser_snapshot for text/refs.',
    parameters: J({}),
    run: async () => {
      const tab = current();
      await waitLoaded(tab.view.webContents, 8000);
      const img = await tab.view.webContents.capturePage();
      const s = img.getSize();
      if (!s.width) throw new Error('empty capture — is the browser window minimized or hidden? (Settings → Tools → show browser window)');
      const k = Math.min(1, 1400 / Math.max(s.width, s.height));
      const r = k < 1 ? img.resize({ width: Math.round(s.width * k), height: Math.round(s.height * k) }) : img;
      return { text: `Browser screenshot of ${tab.view.webContents.getURL()}`, image: 'data:image/jpeg;base64,' + r.toJPEG(78).toString('base64') };
    },
  });
  defs.push({
    name: 'browser_tabs', toolset: 'browser', category: 'control',
    description: 'Manage tabs: list, switch (id), close (id, default current).',
    parameters: J({ action: { type: 'string', enum: ['list', 'switch', 'close'] }, id: { type: 'number' } }, ['action']),
    run: async (a) => {
      if (a.action === 'list' || !tabs.length) return tabs.map((t) => `${t === active ? '▶' : ' '} #${t.id} ${t.view.webContents.getTitle()} — ${t.view.webContents.getURL()}`).join('\n') || '(no tabs)';
      const tab = a.id ? tabs.find((t) => t.id === a.id) : active;
      if (!tab) return `ERROR: no tab #${a.id}`;
      if (a.action === 'switch') { activate(tab); return `switched to #${tab.id}`; }
      tabs.splice(tabs.indexOf(tab), 1);
      try { win.contentView.removeChildView(tab.view); tab.view.webContents.close(); } catch {}
      if (active === tab) { active = tabs[tabs.length - 1] || null; if (active) activate(active); }
      return `closed tab #${tab.id}`;
    },
  });
  defs.push({
    name: 'browser_console', toolset: 'browser', category: 'read',
    description: 'Read recent console messages from the current page (useful for debugging web apps).',
    parameters: J({ clear: { type: 'boolean' } }),
    run: async (a) => { const t = current(); const o = t.logs.join('\n') || '(no console output)'; if (a.clear) t.logs.length = 0; return o; },
  });
  defs.push({
    name: 'browser_eval', toolset: 'browser', category: 'write',
    description: 'Run JavaScript in the current page and return the result (JSON). For advanced extraction or interaction when other browser tools are not enough.',
    parameters: J({ expression: { type: 'string' } }, ['expression']),
    confirm: (a) => ({ key: 'eval', title: 'اجرای جاوااسکریپت در صفحه‌ی مرورگر', detail: String(a.expression).slice(0, 600) }),
    run: async (a) => {
      const r = await evalJs(current(), `(async()=>{ const __v = await (${a.expression}); return JSON.stringify(__v === undefined ? null : __v); })()`);
      return truncate(String(r), 20000);
    },
  });
  defs.push({
    name: 'browser_wait', toolset: 'browser', category: 'read',
    description: 'Wait for a number of seconds or until given text appears on the page (timeout 30s), then return a snapshot.',
    parameters: J({ seconds: { type: 'number' }, text: { type: 'string' } }),
    run: async (a) => {
      const tab = current();
      if (a.text) {
        const end = Date.now() + 30000;
        while (Date.now() < end) {
          const found = await evalJs(tab, `document.body && document.body.innerText.includes(${JSON.stringify(String(a.text))})`).catch(() => false);
          if (found) break;
          await sleep(500);
        }
      } else await sleep(Math.min(30, Math.max(0, +a.seconds || 2)) * 1000);
      return truncate(await snapshot(tab), 40000);
    },
  });
  defs.push({
    name: 'browser_close', toolset: 'browser', category: 'control',
    description: 'Close the agent browser window (the login session is kept).',
    parameters: J({}),
    run: async () => { if (win && !win.isDestroyed()) win.close(); return 'browser closed'; },
  });

  ctx.disposers.push(() => { try { if (win && !win.isDestroyed()) win.destroy(); } catch {} });
  return defs;
}

module.exports = { register };
