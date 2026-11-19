// Shared helpers for Hekpixle tool modules (no external dependencies).
const fs = require('fs/promises');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep head + tail of long text so both the beginning and the end survive.
function truncate(s, n = 30000) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.6);
  const tail = n - head;
  return s.slice(0, head) + `\n...[${s.length - n} chars truncated]...\n` + s.slice(-tail);
}

// ---- proxy-aware fetch (undici ProxyAgent, same approach main.js already uses) ----
const _dispatchers = new Map();
function dispatcherFor(url) {
  if (!url || !String(url).trim()) return null;
  url = String(url).trim();
  if (!_dispatchers.has(url)) {
    try {
      const { ProxyAgent } = require('undici');
      _dispatchers.set(url, new ProxyAgent(url));
    } catch { _dispatchers.set(url, null); }
  }
  return _dispatchers.get(url);
}
async function httpFetch(url, opts, proxyUrl) {
  const o = { ...(opts || {}) };
  const d = dispatcherFor(proxyUrl);
  if (d) o.dispatcher = d;
  return fetch(url, o);
}

function describeFetchError(e) {
  const c = e && e.cause;
  let s = '';
  if (c) { if (c.code) s += c.code + ' '; if (c.message) s += c.message; }
  return s || (e && e.message) || 'unknown network error';
}

// ---- HTML -> readable text (small, dependency-free) ----
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', copy: '©', zwnj: '\u200c' };
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m));
}
function htmlToText(html, baseUrl) {
  let h = String(html || '');
  const titleM = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? decodeEntities(titleM[1]).replace(/\s+/g, ' ').trim() : '';
  h = h.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head|template|iframe)[\s\S]*?<\/\1>/gi, ' ');
  // prefer <main>/<article> when present and substantial
  const main = h.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i);
  if (main && main[2].length > 800) h = main[2];
  h = h.replace(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const t = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!t) return ' ';
    let full = href;
    try { if (baseUrl) full = new URL(href, baseUrl).href; } catch {}
    return /^(javascript|mailto|tel):/i.test(href) ? t : `${t} (${full})`;
  });
  h = h.replace(/<h([1-6])[^>]*>/gi, (m, n) => '\n\n' + '#'.repeat(+n) + ' ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote|header|footer|form|pre)>/gi, '\n')
    .replace(/<(br|hr)[^>]*>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: h };
}

// ---- tiny YAML-frontmatter parser (key: value lines only) ----
function parseFrontmatter(md) {
  const m = String(md || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(md || '') };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const k = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (k) meta[k[1]] = k[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Block obvious local / private-network targets for web tools (basic SSRF guard).
function isPrivateHost(urlStr) {
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    if (!/^https?:$/.test(u.protocol)) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (h === '::1' || h === '[::1]') return true;
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const [a, b] = [+m[1], +m[2]];
      if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true;
    }
    return false;
  } catch { return true; }
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

module.exports = { sleep, truncate, dispatcherFor, httpFetch, describeFetchError, decodeEntities, htmlToText, parseFrontmatter, isInside, isPrivateHost, exists };
