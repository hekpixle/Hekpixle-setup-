// Desktop "computer use": screenshots (vision), mouse, keyboard, window list,
// and Windows UI-Automation element tree. Windows-first; basic Linux/macOS fallback.
const { execFile } = require('child_process');
const { PsWorker } = require('./ps');
const { sleep } = require('./util');

const WIN = process.platform === 'win32';

const CS = `
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HekWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static string ListWindows() {
    StringBuilder sb = new StringBuilder();
    IntPtr fg = GetForegroundWindow();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      string t = Title(h);
      if (t.Length == 0) return true;
      RECT r; GetWindowRect(h, out r);
      uint pid; GetWindowThreadProcessId(h, out pid);
      sb.Append(h.ToInt64()).Append('|').Append(pid).Append('|').Append(h == fg ? "*" : "").Append('|')
        .Append(r.L).Append(',').Append(r.T).Append(',').Append(r.R - r.L).Append(',').Append(r.B - r.T).Append('|').Append(t).Append("\\n");
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
  public static bool Focus(long hwnd) { IntPtr h = new IntPtr(hwnd); if (IsIconic(h)) ShowWindow(h, 9); ShowWindow(h, 5); return SetForegroundWindow(h); }
  static uint Down(int b) { return b == 1 ? 0x8u : (b == 2 ? 0x20u : 0x2u); }
  static uint Up(int b) { return b == 1 ? 0x10u : (b == 2 ? 0x40u : 0x4u); }
  public static void Click(int x, int y, int b, int n) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
    for (int i = 0; i < n; i++) { mouse_event(Down(b), 0, 0, 0, UIntPtr.Zero); mouse_event(Up(b), 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60); }
  }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); System.Threading.Thread.Sleep(80);
    mouse_event(0x2, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(80);
    for (int i = 1; i <= 12; i++) { SetCursorPos(x1 + (x2 - x1) * i / 12, y1 + (y2 - y1) * i / 12); System.Threading.Thread.Sleep(15); }
    System.Threading.Thread.Sleep(80); mouse_event(0x4, 0, 0, 0, UIntPtr.Zero);
  }
  public static void Wheel(int dy, int dx) { if (dy != 0) mouse_event(0x800, 0, 0, dy, UIntPtr.Zero); if (dx != 0) mouse_event(0x1000, 0, 0, dx, UIntPtr.Zero); }
  public static string Pos() { POINT p; GetCursorPos(out p); return p.X + "," + p.Y; }
}
`;

const PRELUDE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms,UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
${CS}
'@
[void][HekWin]::SetProcessDPIAware()
$global:HekEls = $null
function Hek-B64([string]$b) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
function Hek-Tree([long]$hwnd, [int]$max, [bool]$withText) {
  $AE = [System.Windows.Automation.AutomationElement]
  $root = $AE::FromHandle([IntPtr]$hwnd)
  $types = @([System.Windows.Automation.ControlType]::Button, [System.Windows.Automation.ControlType]::Edit,
    [System.Windows.Automation.ControlType]::CheckBox, [System.Windows.Automation.ControlType]::RadioButton,
    [System.Windows.Automation.ControlType]::ComboBox, [System.Windows.Automation.ControlType]::MenuItem,
    [System.Windows.Automation.ControlType]::Hyperlink, [System.Windows.Automation.ControlType]::ListItem,
    [System.Windows.Automation.ControlType]::TabItem, [System.Windows.Automation.ControlType]::TreeItem,
    [System.Windows.Automation.ControlType]::DataItem, [System.Windows.Automation.ControlType]::SplitButton,
    [System.Windows.Automation.ControlType]::Slider, [System.Windows.Automation.ControlType]::Spinner)
  if ($withText) { $types += [System.Windows.Automation.ControlType]::Text }
  $conds = @()
  foreach ($t in $types) { $conds += New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $t) }
  $or = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conds)
  $off = New-Object System.Windows.Automation.PropertyCondition($AE::IsOffscreenProperty, $false)
  $and = New-Object System.Windows.Automation.AndCondition($or, $off)
  $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $and)
  $global:HekEls = New-Object System.Collections.ArrayList
  $n = 0
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt $els.Count -and $n -lt $max; $i++) {
    try {
      $e = $els.Item($i); $c = $e.Current; $r = $c.BoundingRectangle
      if ($r.Width -le 1 -or $r.Height -le 1) { continue }
      $nm = ($c.Name -replace '\\s+', ' ').Trim(); if ($nm.Length -gt 80) { $nm = $nm.Substring(0, 80) }
      if ($c.ControlType.ProgrammaticName -eq 'ControlType.Text' -and $nm.Length -eq 0) { continue }
      $ty = $c.ControlType.ProgrammaticName -replace 'ControlType\\.', ''
      [void]$global:HekEls.Add($e)
      [void]$sb.AppendLine(('[' + $n + '] ' + $ty + ' "' + $nm + '" id=' + $c.AutomationId + ' rect=' + [int]$r.X + ',' + [int]$r.Y + ',' + [int]$r.Width + ',' + [int]$r.Height))
      $n++
    } catch { }
  }
  $sb.ToString()
}
function Hek-Act([int]$i, [string]$act, [string]$text) {
  if ($null -eq $global:HekEls -or $i -lt 0 -or $i -ge $global:HekEls.Count) { return 'ERR: element index not found - run ui_tree again' }
  $e = $global:HekEls[$i]
  $P = [System.Windows.Automation.InvokePattern]::Pattern
  if ($act -eq 'focus') { $e.SetFocus(); return 'OK focused' }
  if ($act -eq 'set_text') {
    try { $p = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $p.SetValue($text); return 'OK value set' }
    catch { return 'ERR: element has no ValuePattern; use ui_act focus then computer type' }
  }
  if ($act -eq 'get_value') {
    try { $p = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); return $p.Current.Value }
    catch { return $e.Current.Name }
  }
  try { $p = $e.GetCurrentPattern($P); $p.Invoke(); return 'OK invoked' } catch { }
  try { $p = $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $p.Toggle(); return 'OK toggled' } catch { }
  try { $p = $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $p.Select(); return 'OK selected' } catch { }
  try { $p = $e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); $p.Expand(); return 'OK expanded' } catch { }
  $r = $e.Current.BoundingRectangle
  [HekWin]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2), 0, 1)
  return 'OK clicked at element center'
}
`;

let _worker = null;
function worker() { if (!_worker) _worker = new PsWorker(PRELUDE); return _worker; }
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

// ---- key-name translation: "ctrl+shift+t" -> SendKeys "^+t" ----
const SK_NAMED = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', backspace: '{BACKSPACE}', delete: '{DEL}', del: '{DEL}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  insert: '{INSERT}', space: ' ', capslock: '{CAPSLOCK}', printscreen: '{PRTSC}',
};
for (let i = 1; i <= 12; i++) SK_NAMED['f' + i] = `{F${i}}`;
function toSendKeys(combo) {
  let str = String(combo).trim();
  let key;
  if (str === '+') { key = '+'; str = ''; }
  else if (str.endsWith('++')) { key = '+'; str = str.slice(0, -2); }
  const parts = str.split('+').map((s) => s.trim()).filter(Boolean);
  if (key === undefined) key = parts.pop();
  if (!key) throw new Error('empty key');
  let mods = '';
  for (const m of parts) {
    const l = m.toLowerCase();
    if (l === 'ctrl' || l === 'control') mods += '^';
    else if (l === 'shift') mods += '+';
    else if (l === 'alt') mods += '%';
    else throw new Error(`unsupported modifier "${m}" (use ctrl, shift, alt)`);
  }
  const lk = key.toLowerCase();
  if (SK_NAMED[lk]) return mods + SK_NAMED[lk];
  if (key.length === 1) return mods + (/[+^%~(){}\[\]]/.test(key) ? `{${key}}` : key);
  throw new Error(`unknown key "${key}"`);
}
const XDO_KEYS = { enter: 'Return', esc: 'Escape', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', pageup: 'Prior', pagedown: 'Next', up: 'Up', down: 'Down', left: 'Left', right: 'Right', tab: 'Tab', space: 'space', home: 'Home', end: 'End' };

function sh(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim())); else resolve(String(stdout).trim());
    });
  });
}

function register(ctx) {
  const { electron } = ctx;
  const { desktopCapturer, screen, clipboard } = electron;
  let last = null; // { full: NativeImage, scale, origin:{x,y}, img:{w,h} }

  async function capture(opts = {}) {
    const displays = screen.getAllDisplays();
    const prim = screen.getPrimaryDisplay();
    const d = (opts.display != null && displays[opts.display]) || prim;
    const sf = d.scaleFactor || 1;
    const pw = Math.round(d.size.width * sf);
    const ph = Math.round(d.size.height * sf);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: pw, height: ph } });
    if (!sources.length) throw new Error('could not capture the screen (no sources)');
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[Math.max(0, displays.indexOf(d))] || sources[0];
    const full = src.thumbnail;
    const size = full.getSize();
    if (!size.width) throw new Error('screen capture returned an empty image (is the screen locked?)');
    const maxDim = opts.maxDim || 1568;
    const k = Math.min(1, maxDim / Math.max(size.width, size.height));
    const img = k < 1 ? full.resize({ width: Math.round(size.width * k), height: Math.round(size.height * k), quality: 'good' }) : full;
    const is = img.getSize();
    last = { full, scale: size.width / is.width, origin: { x: Math.round(d.bounds.x * sf), y: Math.round(d.bounds.y * sf) }, img: is, phys: size };
    return { dataUrl: 'data:image/jpeg;base64,' + img.toJPEG(78).toString('base64'), w: is.width, h: is.height };
  }

  const toPhys = (x, y) => {
    if (!last) throw new Error('take a screenshot first (computer action=screenshot)');
    return { x: Math.round(last.origin.x + x * last.scale), y: Math.round(last.origin.y + y * last.scale) };
  };
  const xy = (c, name = 'coordinate') => {
    if (!Array.isArray(c) || c.length < 2 || !c.every((n) => Number.isFinite(+n))) throw new Error(`${name} must be [x, y] in screenshot pixels`);
    return [Math.round(+c[0]), Math.round(+c[1])];
  };

  async function pasteText(text) {
    const prev = clipboard.readText();
    clipboard.writeText(text);
    if (WIN) await worker().run(`[System.Windows.Forms.SendKeys]::SendWait('^v')`);
    else if (process.platform === 'linux') await sh('xdotool', ['key', 'ctrl+v']);
    else await sh('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
    await sleep(250);
    try { clipboard.writeText(prev); } catch {}
  }

  async function doAction(a) {
    const act = a.action;
    const pt = () => { const [x, y] = xy(a.coordinate); return toPhys(x, y); };
    if (WIN) {
      const W = worker();
      switch (act) {
        case 'mouse_move': { const p = pt(); await W.run(`[HekWin]::Move(${p.x},${p.y})`); return `moved to ${a.coordinate}`; }
        case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click': {
          const p = pt();
          const btn = act === 'right_click' ? 1 : act === 'middle_click' ? 2 : 0;
          const n = act === 'double_click' ? 2 : act === 'triple_click' ? 3 : 1;
          if (a.text) { /* modifier held during click (ctrl/shift) is not supported */ }
          await W.run(`[HekWin]::Click(${p.x},${p.y},${btn},${n})`);
          return `${act} at ${a.coordinate}`;
        }
        case 'left_click_drag': {
          const [sx, sy] = xy(a.start_coordinate, 'start_coordinate');
          const s = toPhys(sx, sy); const e = pt();
          await W.run(`[HekWin]::Drag(${s.x},${s.y},${e.x},${e.y})`);
          return `dragged ${a.start_coordinate} -> ${a.coordinate}`;
        }
        case 'scroll': {
          if (a.coordinate) { const p = pt(); await W.run(`[HekWin]::Move(${p.x},${p.y})`); }
          const amt = Math.max(1, Math.min(30, +a.amount || 3)) * 120;
          const dir = a.direction || 'down';
          const dy = dir === 'up' ? amt : dir === 'down' ? -amt : 0;
          const dx = dir === 'right' ? amt : dir === 'left' ? -amt : 0;
          await W.run(`[HekWin]::Wheel(${dy},${dx})`);
          return `scrolled ${dir}`;
        }
        case 'key': {
          const sk = toSendKeys(a.text);
          await W.run(`[System.Windows.Forms.SendKeys]::SendWait((Hek-B64 '${b64(sk)}'))`);
          return `pressed ${a.text}`;
        }
        case 'cursor_position': { const r = await W.run('[HekWin]::Pos()'); const [px, py] = r.split(',').map(Number); return last ? `cursor at (${Math.round((px - last.origin.x) / last.scale)}, ${Math.round((py - last.origin.y) / last.scale)}) in screenshot coordinates` : `cursor at physical (${px}, ${py})`; }
      }
    } else if (process.platform === 'linux') {
      switch (act) {
        case 'mouse_move': { const p = pt(); await sh('xdotool', ['mousemove', String(p.x), String(p.y)]); return 'moved'; }
        case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click': {
          const p = pt();
          const b = act === 'right_click' ? '3' : act === 'middle_click' ? '2' : '1';
          const n = act === 'double_click' ? '2' : act === 'triple_click' ? '3' : '1';
          await sh('xdotool', ['mousemove', String(p.x), String(p.y), 'click', '--repeat', n, b]);
          return `${act} done`;
        }
        case 'scroll': { if (a.coordinate) { const p = pt(); await sh('xdotool', ['mousemove', String(p.x), String(p.y)]); } await sh('xdotool', ['click', '--repeat', String(Math.min(30, +a.amount || 3)), a.direction === 'up' ? '4' : '5']); return 'scrolled'; }
        case 'key': await sh('xdotool', ['key', ...String(a.text).split('+').map((k) => XDO_KEYS[k.toLowerCase()] || k)]); return `pressed ${a.text}`;
      }
    } else if (act === 'left_click' || act === 'double_click' || act === 'mouse_move') {
      const p = pt();
      await sh('cliclick', [(act === 'double_click' ? 'dc' : act === 'mouse_move' ? 'm' : 'c') + `:${p.x},${p.y}`]).catch(() => { throw new Error('macOS control needs cliclick (brew install cliclick)'); });
      return `${act} done`;
    }
    throw new Error(`action "${act}" is not supported on ${process.platform}`);
  }

  const defs = [];

  defs.push({
    name: 'computer', toolset: 'desktop', category: 'control',
    description:
      'Control the whole desktop like a human: see the screen and operate ANY app. Coordinates are pixels in the most recent screenshot. ' +
      'Workflow: action=screenshot -> look -> act (click/type/key/scroll) -> the tool returns a fresh screenshot -> verify. ' +
      'Actions: screenshot, zoom (region=[x1,y1,x2,y2] for small text), left_click, right_click, middle_click, double_click, triple_click, mouse_move, left_click_drag (start_coordinate -> coordinate), scroll (direction up/down/left/right, amount), type (text; Unicode/Persian OK), key (e.g. "enter", "ctrl+c", "alt+f4", "ctrl+shift+t"), wait (seconds), cursor_position, list_windows, focus_window (text = part of window title). ' +
      'Prefer ui_tree/ui_act (Windows) for precise element control, and browser_* tools for web pages. Windows key combos are not supported; use launch_app / run_command to open things.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot', 'zoom', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'mouse_move', 'left_click_drag', 'scroll', 'type', 'key', 'wait', 'cursor_position', 'list_windows', 'focus_window'] },
        coordinate: { type: 'array', items: { type: 'number' }, description: '[x, y] in screenshot pixels' },
        start_coordinate: { type: 'array', items: { type: 'number' } },
        region: { type: 'array', items: { type: 'number' }, description: 'zoom region [x1,y1,x2,y2]' },
        text: { type: 'string', description: 'text to type, key combo, or window title' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'scroll notches (default 3)' },
        seconds: { type: 'number' },
        display: { type: 'number', description: 'monitor index for screenshot (default primary)' },
      },
      required: ['action'],
    },
    confirm: (a, call) => {
      if (['screenshot', 'zoom', 'wait', 'cursor_position', 'list_windows'].includes(a.action)) {
        return call.state.screenOk ? null : { key: 'screen', title: 'ایجنت می‌خواد صفحه‌ی نمایشت رو ببینه', detail: 'اسکرین‌شات‌ها برای مدل هوش مصنوعی ارسال می‌شن. (فقط یک بار در هر اجرا پرسیده می‌شه)' };
      }
      return call.state.ctrlOk ? null : { key: 'ctrl', title: 'ایجنت می‌خواد ماوس/کیبورد رو کنترل کنه', detail: `اولین عمل: ${a.action}${a.coordinate ? ' @ ' + a.coordinate : ''}${a.text ? ' "' + String(a.text).slice(0, 60) + '"' : ''}\n(در همین اجرا دیگه نمی‌پرسه)` };
    },
    onApprove: (key, call) => { if (key === 'screen') call.state.screenOk = true; else { call.state.ctrlOk = true; call.state.screenOk = true; } },
    run: async (a, call) => {
      const act = a.action;
      if (act === 'wait') { await sleep(Math.min(30, Math.max(0, +a.seconds || 1)) * 1000); return 'waited'; }
      if (act === 'list_windows') {
        if (!WIN) throw new Error('list_windows is Windows-only');
        const out = await worker().run('[HekWin]::ListWindows()');
        const lines = out.split('\n').filter(Boolean).map((l) => { const [h, pid, fg, rect, ...t] = l.split('|'); return `${fg === '*' ? '▶ ' : '  '}${t.join('|')}  [pid ${pid}, rect ${rect}]`; });
        return lines.join('\n') || '(no visible windows)';
      }
      if (act === 'focus_window') {
        if (!WIN) throw new Error('focus_window is Windows-only');
        const needle = String(a.text || '').toLowerCase();
        if (!needle) throw new Error('text (window title) is required');
        const out = await worker().run('[HekWin]::ListWindows()');
        const hit = out.split('\n').filter(Boolean).map((l) => l.split('|')).find((p) => p.slice(4).join('|').toLowerCase().includes(needle));
        if (!hit) return `ERROR: no window title contains "${a.text}"`;
        await worker().run(`[void][HekWin]::Focus(${hit[0]})`);
        await sleep(400);
        return `focused: ${hit.slice(4).join('|')}`;
      }
      if (act === 'screenshot' || act === 'zoom') {
        const shot = await capture({ display: a.display });
        if (act === 'zoom') {
          const [x1, y1, x2, y2] = (a.region || []).map(Math.round);
          if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) throw new Error('region must be [x1,y1,x2,y2]');
          const p1 = toPhys(x1, y1), p2 = toPhys(x2, y2);
          const crop = last.full.crop({ x: Math.max(0, p1.x - last.origin.x), y: Math.max(0, p1.y - last.origin.y), width: Math.max(2, p2.x - p1.x), height: Math.max(2, p2.y - p1.y) });
          const cs = crop.getSize();
          const k = Math.min(2, 1400 / Math.max(cs.width, cs.height));
          const z = k !== 1 ? crop.resize({ width: Math.round(cs.width * k), height: Math.round(cs.height * k), quality: 'best' }) : crop;
          return { text: `Zoomed region [${x1},${y1},${x2},${y2}] (note: coordinates for clicking still refer to the full screenshot).`, image: 'data:image/jpeg;base64,' + z.toJPEG(85).toString('base64') };
        }
        return { text: `Screenshot ${shot.w}x${shot.h}. Coordinates for actions are pixels in this image.`, image: shot.dataUrl };
      }
      if (act === 'cursor_position') return await doAction(a);
      if (act === 'type') {
        if (typeof a.text !== 'string' || !a.text) throw new Error('text is required');
        await pasteText(a.text);
      } else {
        const r = await doAction(a);
        a._r = r;
      }
      if (a.screenshot_after === false) return a._r || 'typed';
      await sleep(act === 'type' || act === 'key' ? 400 : 700);
      const shot = await capture({ display: a.display });
      return { text: `${a._r || 'typed ' + String(a.text).length + ' chars'}. Screenshot after action (${shot.w}x${shot.h}):`, image: shot.dataUrl };
    },
  });

  if (WIN) {
    defs.push({
      name: 'ui_tree', toolset: 'desktop', category: 'control',
      description: 'Windows only. List the interactive UI elements (buttons, text boxes, menu items, links, list items…) of a window via UI Automation, with indexes. Works without vision. Use ui_act with an index to click/type precisely. Default window: the one currently in front. Coordinates shown (at=) are in screenshot space once a screenshot exists.',
      parameters: { type: 'object', properties: { window_title: { type: 'string', description: 'part of the window title (default: foreground window)' }, include_text: { type: 'boolean', description: 'also list static text labels' }, max: { type: 'number', description: 'max elements (default 120)' } } },
      confirm: (a, call) => (call.state.screenOk ? null : { key: 'screen', title: 'ایجنت می‌خواد ساختار پنجره‌های برنامه‌ها رو بخونه', detail: 'فقط یک بار در هر اجرا پرسیده می‌شه.' }),
      onApprove: (key, call) => { call.state.screenOk = true; },
      run: async (a) => {
        let hwnd;
        if (a.window_title) {
          const out = await worker().run('[HekWin]::ListWindows()');
          const needle = String(a.window_title).toLowerCase();
          const hit = out.split('\n').filter(Boolean).map((l) => l.split('|')).find((p) => p.slice(4).join('|').toLowerCase().includes(needle));
          if (!hit) return `ERROR: no window title contains "${a.window_title}"`;
          hwnd = hit[0];
        } else {
          hwnd = await worker().run('[HekWin]::GetForegroundWindow().ToInt64()');
        }
        const max = Math.max(10, Math.min(300, +a.max || 120));
        const out = await worker().run(`Hek-Tree ${hwnd} ${max} $${a.include_text ? 'true' : 'false'}`, 45000);
        if (!out) return '(no interactive elements found; the app may not expose UI Automation — use computer screenshot instead)';
        const lines = out.split('\n').filter(Boolean).map((l) => l.replace(/rect=(-?\d+),(-?\d+),(\d+),(\d+)/, (m, x, y, w, h) => {
          x = +x; y = +y; w = +w; h = +h;
          if (!last) return `rect=${x},${y},${w},${h}`;
          const cx = Math.round((x + w / 2 - last.origin.x) / last.scale);
          const cy = Math.round((y + h / 2 - last.origin.y) / last.scale);
          return `at=(${cx},${cy})`;
        }));
        return lines.join('\n');
      },
    });
    defs.push({
      name: 'ui_act', toolset: 'desktop', category: 'control',
      description: 'Windows only. Act on an element from the latest ui_tree by index: click (invoke/toggle/select, falls back to a mouse click), focus, set_text (set a text box value), get_value. Re-run ui_tree if the window changed.',
      parameters: { type: 'object', properties: { index: { type: 'number' }, action: { type: 'string', enum: ['click', 'focus', 'set_text', 'get_value'] }, text: { type: 'string' } }, required: ['index', 'action'] },
      confirm: (a, call) => (call.state.ctrlOk ? null : { key: 'ctrl', title: 'ایجنت می‌خواد روی یک برنامه کار کنه', detail: `${a.action} روی عنصر #${a.index}${a.text ? ' — «' + String(a.text).slice(0, 60) + '»' : ''}\n(در همین اجرا دیگه نمی‌پرسه)` }),
      onApprove: (key, call) => { call.state.ctrlOk = true; call.state.screenOk = true; },
      run: async (a) => {
        const r = await worker().run(`Hek-Act ${parseInt(a.index, 10)} '${a.action}' (Hek-B64 '${b64(a.text || '')}')`, 20000);
        await sleep(400);
        return r || 'OK';
      },
    });
  }

  ctx.disposers.push(() => { if (_worker) _worker.dispose(); });
  return defs;
}

module.exports = { register, toSendKeys };
