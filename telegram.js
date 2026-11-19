/* ============================================================================
   Hekpixle v0.4 — Telegram bot integration
   ----------------------------------------------------------------------------
   This module turns Hekpixle into a Telegram bot. When you start the bot
   (via the UI), it polls Telegram for updates and responds to messages in
   private chats, groups, and supergroups. Channels are broadcast-only and
   the bot is read-only there by default.

   Architecture:
   - No external dependencies — uses Node's built-in `fetch` (Node 18+)
   - Long-polling via getUpdates (no need for a public webhook URL)
   - One conversation history per Telegram chat (stored in tg_chats.json)
   - Same LLM + tools as the desktop UI; auto-allow rules apply since the
     user is not present to click "Allow" for each permission prompt.
   ============================================================================ */

const fs = require('fs/promises');
const path = require('path');

// NOTE: TG_API does NOT include "/bot" — the token is prefixed with "bot"
// at use time so the final URL is https://api.telegram.org/bot<token>/<method>.
// (Earlier versions had a "double-bot" bug because TG_API ended with "/bot"
// and the URL template added another "bot".)
const TG_API = 'https://api.telegram.org';
const MAX_MSG = 4096;             // Telegram hard limit per message
const MAX_HISTORY = 30;            // Keep last N messages per chat for context
const POLL_TIMEOUT_SEC = 35;      // long-polling timeout

let winRef = null;
let userDataDir = '';
let settingsProvider = null;     // function returning current settings
let toolsRunner = null;          // function (messages, opts) => {added, error}
let agentSystemPrompt = null;    // function () => string  (so we get the latest)
let extras = {};                 // { transcribe(buf,name,lang), toDataUrl(src) } provided by main.js
let homeChatId = null;           // chat that receives scheduled-job results / send_message (set with /sethome)

let botRunning = false;
let botInfo = null;              // { id, username, first_name }
let abortController = null;      // for the polling loop
let chatHistory = new Map();     // chat_id -> [ {role, content} ]
let messageCounter = 0;
let lastError = '';
let lastUpdateId = 0;

/* ---------- storage ---------- */
function tgFile(n) { return path.join(userDataDir, n); }
async function loadHistory() {
  try {
    const data = JSON.parse(await fs.readFile(tgFile('tg_chats.json'), 'utf8'));
    chatHistory = new Map(Object.entries(data));
  } catch { chatHistory = new Map(); }
}
async function saveHistory() {
  try {
    const obj = Object.fromEntries(chatHistory);
    await fs.writeFile(tgFile('tg_chats.json'), JSON.stringify(obj));
  } catch {}
}
async function saveLastUpdateId() {
  try { await fs.writeFile(tgFile('tg_offset.json'), JSON.stringify({ offset: lastUpdateId })); } catch {}
}
async function loadLastUpdateId() {
  try { const o = JSON.parse(await fs.readFile(tgFile('tg_offset.json'), 'utf8')); lastUpdateId = o.offset || 0; }
  catch { lastUpdateId = 0; }
}

function historyFor(chatId) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, []);
  return chatHistory.get(chatId);
}

function pushHistory(chatId, msg) {
  const arr = historyFor(chatId);
  arr.push(msg);
  // Keep it bounded
  while (arr.length > MAX_HISTORY * 2) arr.shift();
}

/* ---------- Telegram HTTP ---------- */
// IMPORTANT: do NOT URL-encode the bot token — Telegram expects the colon
// `:` in `bot<id>:<hash>` to remain raw. The token's allowed characters are
// already URL-safe (digits, letters, colon, hyphen, underscore), so we use
// it as-is.
//
// PROXY SUPPORT: In regions where api.telegram.org is blocked (e.g. Iran),
// the user can configure a proxy URL in Settings → Telegram → Proxy URL.
// We use undici's ProxyAgent via the `dispatcher` option on fetch.

let _proxyDispatcher = null;
function refreshProxyDispatcher(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
    _proxyDispatcher = null;
    return;
  }
  try {
    // undici is bundled with Node.js 18+ (Electron 33 uses Node 20+)
    const { ProxyAgent } = require('undici');
    _proxyDispatcher = new ProxyAgent(proxyUrl.trim());
    lastError = '';
  } catch (e) {
    lastError = 'Failed to create proxy agent: ' + e.message;
    emitStatus();
    _proxyDispatcher = null;
  }
}

// Extract a human-readable cause from a fetch error. Node.js's fetch
// typically throws TypeError("fetch failed") with the real cause in
// `error.cause` (e.g. { code: 'ECONNREFUSED' } or { code: 'ENOTFOUND' }).
function describeFetchError(e, method) {
  const cause = e?.cause;
  let causeStr = '';
  if (cause) {
    if (cause.code) causeStr += cause.code + ' ';
    if (cause.message) causeStr += cause.message;
    if (!causeStr && typeof cause.toString === 'function') causeStr = cause.toString();
  }
  if (!causeStr) causeStr = e.message || 'unknown';

  // Suggest a proxy if the error looks network/DNS related
  const looksBlocked = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|OTHER$/i.test(causeStr);
  const suggestion = looksBlocked && !_proxyDispatcher
    ? '\n\n💡 اگه تو ایران هستی، api.telegram.org مسدوده. تو Settings → Telegram → «Proxy URL» یه پروکسی بذار (مثلاً http://127.0.0.1:7890 یا socks5://127.0.0.1:1080).'
    : '';

  return `Network error calling ${method}: ${causeStr}${suggestion}`;
}

async function tgCall(method, body) {
  const url = `${TG_API}/bot${botTokenRef()}/${method}`;
  const fetchOpts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  };
  if (_proxyDispatcher) fetchOpts.dispatcher = _proxyDispatcher;

  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (e) {
    throw new Error(describeFetchError(e, method));
  }
  let data;
  try { data = await res.json(); }
  catch {
    throw new Error(`Telegram ${method} returned non-JSON (HTTP ${res.status}). ${_proxyDispatcher ? '' : 'اگه مسدود شد، یه پروکسی بذار.'}`);
  }
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed (HTTP ${res.status}): ${data.description || 'unknown error'}`);
  }
  return data.result;
}

let _botTokenRef = '';
function botTokenRef() { return _botTokenRef; }

/* ---------- Status emit to UI ---------- */
function emitStatus() {
  if (!winRef || winRef.isDestroyed()) return;
  try {
    winRef.webContents.send('telegram:status', {
      running: botRunning,
      botUsername: botInfo?.username || null,
      botFirstName: botInfo?.first_name || null,
      messageCount: messageCounter,
      lastError: lastError,
    });
  } catch {}
}

/* ---------- Markdown → Telegram HTML converter ----------
   Telegram supports a limited subset of HTML:
   <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">, <br>
   No <h1>-<h6>, no <ul>/<ol>, no <table>, no <blockquote>.
   We convert:
   - # heading        -> <b>HEADING</b>
   - **bold**         -> <b>bold</b>
   - *italic* / _it_  -> <i>italic</i>
   - ~~strike~~       -> <s>strike</s>
   - `inline code`    -> <code>inline code</code>
   - ```lang\n...\n```-> <pre><code class="language-lang">...</code></pre>
   - [text](url)      -> <a href="url">text</a>
   - $...$ and $$...$$ (KaTeX) -> <code>...</code>
   - Lines starting with - or * -> "• " prefix
   - Lines starting with "1." -> "1. " prefix
   - > blockquote     -> "> " prefix (Telegram has no blockquote tag)
   All HTML special chars are escaped first.
   ----------------------------------------------------------------- */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;')
                   .replace(/</g, '&lt;')
                   .replace(/>/g, '&gt;');
}

function mdToTelegramHtml(md) {
  if (!md) return '';

  // Step 1: pull out code blocks (```...```) first, before escaping
  const codeBlocks = [];
  let s = md.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    codeBlocks.push(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0001CB${codeBlocks.length - 1}\u0001`;
  });

  // Step 2: pull out inline code (`...`)
  const inlineCodes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0001IC${inlineCodes.length - 1}\u0001`;
  });

  // Step 3: pull out math (KaTeX)
  const mathParts = [];
  // Block math first ($$...$$)
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    mathParts.push(`<pre><code>${escapeHtml(tex.trim())}</code></pre>`);
    return `\u0001MATH${mathParts.length - 1}\u0001`;
  });
  // Inline math ($...$)
  s = s.replace(/\$([^\n$][^$\n]*)\$/g, (_, tex) => {
    mathParts.push(`<code>${escapeHtml(tex)}</code>`);
    return `\u0001MATH${mathParts.length - 1}\u0001`;
  });

  // Step 4: escape the remaining text (which is mostly prose + markdown markers)
  s = escapeHtml(s);

  // Step 5: convert markdown structural pieces line by line
  const lines = s.split('\n');
  const out = [];
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let rawLine = line;

    // Headings
    let m = rawLine.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      // Close any open list
      if (inList) { out.push(''); inList = false; }
      out.push(`<b>${m[2].toUpperCase()}</b>`);
      continue;
    }
    // Horizontal rule
    if (/^---+\s*$/.test(rawLine)) {
      out.push('\u2014'.repeat(20));
      continue;
    }
    // Blockquote
    if (rawLine.startsWith('&gt; ')) {
      if (inList) { out.push(''); inList = false; }
      out.push('&#8227; ' + rawLine.slice(5));
      continue;
    }
    // Unordered list
    if (/^[\-\*]\s+/.test(rawLine)) {
      inList = true;
      out.push('  \u2022 ' + rawLine.replace(/^[\-\*]\s+/, ''));
      continue;
    }
    // Ordered list
    if (/^\d+\.\s+/.test(rawLine)) {
      inList = true;
      out.push('  ' + rawLine);
      continue;
    }
    // Empty line — close list
    if (rawLine.trim() === '') {
      if (inList) { inList = false; }
      out.push('');
      continue;
    }
    // Prose line
    if (inList) { out.push(''); inList = false; }
    out.push(rawLine);
  }
  s = out.join('\n');

  // Step 6: inline formatting — bold, italic, strikethrough, links
  // Bold **x**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  // Italic *x* or _x_
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<i>$2</i>');
  // Strikethrough ~~x~~
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  // Step 7: restore code/math placeholders
  s = s.replace(/\u0001CB(\d+)\u0001/g, (_, i) => codeBlocks[+i] || '');
  s = s.replace(/\u0001IC(\d+)\u0001/g, (_, i) => inlineCodes[+i] || '');
  s = s.replace(/\u0001MATH(\d+)\u0001/g, (_, i) => mathParts[+i] || '');

  // Step 8: collapse 3+ newlines to 2
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/* ---------- Send a long response as one or more messages ---------- */
async function sendLongMessage(chatId, text, replyToId) {
  if (!text || !text.trim()) return;
  // Convert to HTML
  const html = mdToTelegramHtml(text);

  // Split into chunks of MAX_MSG chars each, but break on \n\n when possible
  const chunks = [];
  let remaining = html;
  while (remaining.length > MAX_MSG) {
    let cut = remaining.lastIndexOf('\n\n', MAX_MSG);
    if (cut < 1000) cut = remaining.lastIndexOf('\n', MAX_MSG);
    if (cut < 1000) cut = MAX_MSG;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.length) chunks.push(remaining);

  for (let i = 0; i < chunks.length; i++) {
    try {
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyToId && i === 0 ? { reply_to_message_id: replyToId } : {}),
      });
    } catch (e) {
      // Try again without HTML parse mode (sometimes Telegram rejects bad HTML)
      try {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: chunks[i].replace(/<[^>]+>/g, ''),
          disable_web_page_preview: true,
          ...(replyToId && i === 0 ? { reply_to_message_id: replyToId } : {}),
        });
      } catch (e2) {
        lastError = e2.message;
        emitStatus();
      }
    }
  }
}

/* ---------- "Typing..." indicator ---------- */
async function tgDownload(fileId) {
  const f = await tgCall('getFile', { file_id: fileId });
  const url = `${TG_API}/file/bot${botTokenRef()}/${f.file_path}`;
  const res = await fetch(url, _proxyDispatcher ? { dispatcher: _proxyDispatcher } : {});
  if (!res.ok) throw new Error('download HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Send a message to the home chat (or a given chat id). Returns a status string for the agent.
async function sendText(text, chatId) {
  if (!botRunning) return 'ERROR: the Telegram bot is not running (start it in Settings → Telegram).';
  if (!homeChatId) { try { homeChatId = JSON.parse(await fs.readFile(tgFile('tg_home.json'), 'utf8')).chatId; } catch {} }
  const target = chatId || homeChatId;
  if (!target) return 'ERROR: no home chat — send /sethome to the bot from the chat that should receive messages.';
  try { await sendLongMessage(target, String(text)); return 'OK: sent to Telegram.'; }
  catch (e) { return 'ERROR: ' + e.message; }
}

async function sendChatAction(chatId, action) {
  try {
    await tgCall('sendChatAction', { chat_id: chatId, action: action || 'typing' });
  } catch {}
}

/* ---------- Commands ---------- */
async function handleCommand(chatId, text, fromUser, fromUserId) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+$/, ''); // strip @botname suffix
  switch (cmd) {
    case '/start':
      await sendLongMessage(chatId,
        `سلام ${fromUser} 👋\n\n` +
        `من **Hekpixle** هستم — ایجنت شخصی شما که به فایل‌ها، برنامه‌ها و کامپیوترتون دسترسی داره.\n\n` +
        `هر چی بپرسید یا بخواید کاری انجام بشه، بهتون پاسخ می‌دم.\n\n` +
        `دستورات:\n` +
        `• /help — راهنمایی کامل\n` +
        `• /clear — پاک‌کردن حافظه‌ی چت\n` +
        `• /status — وضعیت فعلی ایجنت\n` +
        `• /sethome — دریافت نتیجه‌ی کارهای زمان‌بندی‌شده در همین چت\n`);
      return true;
    case '/help':
      await sendLongMessage(chatId,
        `**قابلیت‌های Hekpixle**\n\n` +
        `**۱. پاسخ به سوالات** — هر چی بپرسید، با Markdown و فرمول ریاضی (در بلوک کد) پاسخ می‌دم.\n\n` +
        `**۲. دسترسی به فایل** — می‌تونم بگم چی تو فلان پوشه هست، یه فایل رو بخونم، فایل بسازم.\n\n` +
        `**۳. اجرای برنامه** — می‌تونم کروم، نوت‌پد، اکسپلورر، ماشین‌حساب و... رو باز کنم.\n` +
        `   مثال: «کروم رو باز کن و سرچ کن: اخبار»\n\n` +
        `**۴. اجرای دستور شل** — هر دستوری (git, npm, ping, ...) رو اجرا کنم و خروجیش رو بگم.\n\n` +
        `**۵. کنترل پنجره‌ها** — می‌تونم یه پنجره رو فعال کنم و کلید بفرستم (SendKeys).\n\n` +
        `**نکته:** در گروه‌ها، فقط وقتی منشن بشم (@HekpixleBot) یا روی پیام من ریپلای کنید، پاسخ می‌دم.\n\n` +
        `دستورات:\n` +
        `• /clear — پاک‌کردن حافظه\n` +
        `• /status — وضعیت\n` +
        `• /new — شروع گفت‌وگوی جدید\n` +
        `• /sethome — این چت = مقصد اعلان‌ها و نتیجه‌ی کارهای زمان‌بندی‌شده\n\n` +
        `همچنین می‌تونید **پیام صوتی** (رونویسی می‌شه) یا **عکس** (بررسی می‌شه) بفرستید.`);
      return true;
    case '/clear':
    case '/new':
      chatHistory.delete(chatId);
      await saveHistory();
      await sendLongMessage(chatId, '✓ حافظه‌ی گفت‌وگو پاک شد. از نو شروع کنیم.');
      return true;
    case '/status':
      await sendLongMessage(chatId,
        `**وضعیت ایجنت**\n` +
        `• Bot: @${botInfo?.username || '?'}\n` +
        `• Model: ${settingsProvider?.().model || '?'}\n` +
        `• Total messages handled: ${messageCounter}\n` +
        `• Home chat: ${homeChatId ? 'set' : 'not set (/sethome)'}\n` +
        `• Auto-allow reads: ${settingsProvider?.().telegram?.autoAllowReads ? 'yes' : 'no'}\n` +
        `• Auto-allow writes: ${settingsProvider?.().telegram?.autoAllowWrites ? 'yes' : 'no'}\n`);
      return true;
    case '/sethome':
      homeChatId = chatId;
      try { await fs.writeFile(tgFile('tg_home.json'), JSON.stringify({ chatId })); } catch {}
      await sendLongMessage(chatId, '✓ این چت به‌عنوان «خانه» ثبت شد؛ نتیجه‌ی کارهای زمان‌بندی‌شده و پیام‌های send_message اینجا میاد.');
      return true;
    case '/myid':
      // Help the user find their own Telegram user ID so they can whitelist themselves
      await sendLongMessage(chatId,
        `**Your Telegram user ID:**\n\n` +
        `<code>${fromUserId || '?'}</code>\n\n` +
        `برای محدود کردن این ربات به خودتون، این عدد رو تو Hekpixle → Settings → Telegram → "Allowed user IDs" بذارید.`
      );
      return true;
    default:
      return false; // unknown command — let the agent handle it as a normal message
  }
}

/* ---------- Message handler ---------- */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type; // 'private' | 'group' | 'supergroup' | 'channel'
  const fromUser = msg.from?.username
    ? '@' + msg.from.username
    : (msg.from?.first_name || 'there');
  const fromUserId = msg.from?.id;  // Telegram numeric user ID
  const text = msg.text || msg.caption || '';
  const messageId = msg.message_id;

  // Channels are read-only for the bot (it can't post unless admin) — skip
  if (chatType === 'channel') return;

  // Whitelist: if the user configured one or more allowed user IDs, only
  // messages from those IDs are processed. Others get a polite rejection.
  // (This is the Hermes-style behavior: you give the bot your own user ID
  // so only YOU can talk to it.)
  const tg = settingsProvider?.().telegram || {};
  if (Array.isArray(tg.allowedUserIds) && tg.allowedUserIds.length > 0) {
    const allowed = tg.allowedUserIds
      .map((s) => String(s).trim())
      .filter(Boolean)
      .map((s) => String(parseInt(s, 10)))
      .filter((s) => s !== 'NaN');
    if (allowed.length > 0 && !allowed.includes(String(fromUserId))) {
      // Not authorized — silently ignore (or optionally reply)
      if (tg.replyOnUnauthorized !== false) {
        try {
          await sendLongMessage(chatId,
            `⛔ شما اجازه‌ی استفاده از این ربات رو ندارید.\n\n` +
            `این ربات فقط مالک شخصیاش می‌تونه استفاده کنه. ` +
            `User ID شما: <code>${fromUserId || '?'}</code>`
          );
        } catch {}
      }
      return;
    }
  }

  // In groups, only respond if mentioned or replied to (unless disabled by setting)
  if (chatType !== 'private' && tg.onlyWhenMentioned !== false) {
    const mentioned = botInfo && text.includes('@' + botInfo.username);
    const replyToBot = msg.reply_to_message?.from?.id === botInfo?.id;
    if (!mentioned && !replyToBot) return;
  }

  // Strip the @botname mention from the text so it doesn't confuse the model
  let cleanedText = text;
  if (botInfo) {
    cleanedText = cleanedText.replace(new RegExp('@' + botInfo.username + '\\b', 'g'), '').trim();
  }

  // Commands
  if (cleanedText.startsWith('/') && await handleCommand(chatId, cleanedText, fromUser, fromUserId)) {
    return;
  }

  // Voice / audio -> transcript; photo -> the model looks at it
  let imageUrl = null;
  if (msg.voice || msg.audio) {
    try {
      if (!extras.transcribe) throw new Error('transcription not available');
      await sendChatAction(chatId, 'typing');
      const m = msg.voice || msg.audio;
      const buf = await tgDownload(m.file_id);
      const t = await extras.transcribe(buf, msg.voice ? 'voice.ogg' : (m.file_name || 'audio.mp3'));
      cleanedText = (cleanedText ? cleanedText + '\n' : '') + `[Voice message transcript]: ${t}`;
    } catch (e) {
      await sendLongMessage(chatId, '⚠️ رونویسی پیام صوتی ناموفق بود: ' + (e.message || e));
      return;
    }
  }
  if (msg.photo && msg.photo.length) {
    try {
      const best = msg.photo[msg.photo.length - 1];
      const buf = await tgDownload(best.file_id);
      imageUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
      if (!cleanedText) cleanedText = 'این تصویر رو نگاه کن و بگو چیه (متن‌های داخلش رو هم بخون).';
    } catch (e) {
      await sendLongMessage(chatId, '⚠️ دانلود عکس ناموفق بود: ' + (e.message || e));
      return;
    }
  }

  // Empty after stripping mention — ignore
  if (!cleanedText) {
    if (msg.document || msg.video || msg.sticker) await sendLongMessage(chatId, 'فایل/ویدیو/استیکر هنوز پشتیبانی نمی‌شه؛ متن، عکس یا پیام صوتی بفرست.');
    return;
  }

  // Send "typing..." action
  await sendChatAction(chatId, 'typing');

  // Push to history
  pushHistory(chatId, { role: 'user', content: imageUrl ? cleanedText + ' [photo]' : cleanedText });

  // Compose the user context line — include who is asking
  const userContext = `[from Telegram: ${fromUser}, chat type: ${chatType}]\n${cleanedText}`;

  // Telegram-specific formatting guidance (the main system prompt is built inside runAgent)
  const tgNote =
    'You are responding to a Telegram message. Format your reply in Markdown — the system converts it to Telegram HTML before sending.\n' +
    'For math/physics formulas use Unicode symbols when possible (², ³, √, ∑, ∫, π, α, β…); for complex formulas use code blocks.\n' +
    'Keep replies concise (under 4000 characters when possible); long replies are split. Do not use tables — use bullet lists.\n' +
    'When you use tools, briefly say what you did and the result. Screenshots you take are NOT visible to the user here — describe what matters.\n' +
    `Message context: ${userContext.split('\n')[0]}`;

  try {
    const hist = historyFor(chatId).map((m) => ({ role: m.role, content: m.content }));
    if (imageUrl && hist.length) hist[hist.length - 1] = { role: 'user', content: [{ type: 'text', text: cleanedText }, { type: 'image_url', image_url: { url: imageUrl } }] };
    // Permissions are decided in main.js from the telegram auto-allow settings (by tool category).
    const res = await toolsRunner(hist, { source: 'telegram', systemExtra: tgNote });

    let reply = '';
    if (res.error) reply = '⚠️ ' + res.error;
    else if (res.added?.length) {
      // Find the last assistant content
      for (let i = res.added.length - 1; i >= 0; i--) {
        if (res.added[i].role === 'assistant' && res.added[i].content) {
          reply = res.added[i].content;
          break;
        }
      }
    }
    if (!reply) reply = '…';

    // Push assistant reply to history
    pushHistory(chatId, { role: 'assistant', content: reply });

    // Send to Telegram
    await sendLongMessage(chatId, reply, messageId);

    // Persist history (throttled)
    messageCounter++;
    emitStatus();
    if (messageCounter % 5 === 0) saveHistory();
  } catch (e) {
    lastError = e.message;
    emitStatus();
    try {
      await sendLongMessage(chatId, '⚠️ خطا: ' + (e.message || 'unknown'));
    } catch {}
  }
}

/* ---------- Long-polling loop ---------- */
async function pollLoop() {
  while (botRunning && !abortController?.signal.aborted) {
    try {
      const updates = await tgCall('getUpdates', {
        offset: lastUpdateId,
        timeout: POLL_TIMEOUT_SEC,
        allowed_updates: ['message', 'edited_message', 'channel_post'],
      });
      for (const upd of updates) {
        if (upd.update_id >= lastUpdateId) lastUpdateId = upd.update_id + 1;
        const msg = upd.message || upd.edited_message || upd.channel_post;
        if (!msg) continue;
        // Process async — don't block the next poll
        handleMessage(msg).catch((e) => {
          lastError = e.message;
          emitStatus();
        });
      }
      saveLastUpdateId().catch(() => {});
    } catch (e) {
      lastError = e.message;
      emitStatus();
      // Telegram returns 409 if another bot instance with the same token is polling;
      // 401 if token is invalid. Wait a bit before retrying.
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/* ---------- Public API ---------- */
async function startBot() {
  if (botRunning) return { ok: false, error: 'Bot is already running' };
  const s = settingsProvider?.();
  if (!s || !s.telegram?.botToken) {
    return { ok: false, error: 'No bot token configured' };
  }
  _botTokenRef = s.telegram.botToken.trim();
  if (!/^[\d]+:[\w-]+$/.test(_botTokenRef)) {
    return { ok: false, error: 'Bot token looks invalid (expecting "<id>:<hash>")' };
  }
  // Refresh the proxy dispatcher based on current settings (in case the user
  // changed it since the last start)
  refreshProxyDispatcher(s.telegram?.proxyUrl);
  try {
    botInfo = await tgCall('getMe', {});
    if (!botInfo?.username) {
      return { ok: false, error: 'Bot info missing username' };
    }
    botRunning = true;
    abortController = null;
    lastError = '';
    await loadLastUpdateId();
    await loadHistory();
    emitStatus();
    // Kick off polling
    pollLoop();
    return { ok: true, botUsername: botInfo.username };
  } catch (e) {
    botRunning = false;
    botInfo = null;
    lastError = e.message;
    emitStatus();
    return { ok: false, error: e.message };
  }
}

function stopBot() {
  botRunning = false;
  if (abortController) {
    try { abortController.abort(); } catch {}
    abortController = null;
  }
  botInfo = null;
  lastError = '';
  emitStatus();
  return { ok: true };
}

function getStatus() {
  return {
    running: botRunning,
    botUsername: botInfo?.username || null,
    botFirstName: botInfo?.first_name || null,
    messageCount: messageCounter,
    lastError,
  };
}

function init({ win, userDataDir: ud, getSettings, runAgentFn, systemPromptFn, extras: ex }) {
  if (ex) extras = ex;
  winRef = win;
  userDataDir = ud;
  settingsProvider = getSettings;
  toolsRunner = runAgentFn;
  agentSystemPrompt = systemPromptFn;
}

module.exports = {
  init,
  startBot,
  stopBot,
  getStatus,
  sendText,
  refreshProxyDispatcher,
  mdToTelegramHtml,  // exported for testing
};
