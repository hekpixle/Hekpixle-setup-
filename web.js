// web_search + web_extract (no browser needed). Providers: DuckDuckGo (keyless), Tavily, Brave, SearXNG.
const { httpFetch, htmlToText, decodeEntities, truncate, describeFetchError, isPrivateHost } = require('./util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parseDuckDuckGo(html) {
  const results = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/gi;
  let m;
  while ((m = re.exec(html)) && results.length < 25) {
    let url = decodeEntities(m[1]);
    const u = url.match(/[?&]uddg=([^&]+)/);
    if (u) { try { url = decodeURIComponent(u[1]); } catch {} }
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:/i.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const sn = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = sn ? decodeEntities(sn[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';
    results.push({ title, url, snippet });
  }
  return results;
}

function register(ctx) {
  const cfg = () => ctx.getSettings().web || {};
  const proxy = () => cfg().proxyUrl || '';

  async function getJson(url, opts) {
    const r = await httpFetch(url, { ...(opts || {}), signal: AbortSignal.timeout(25000) }, proxy());
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  async function search(query, limit) {
    const c = cfg();
    const provider = c.provider || 'duckduckgo';
    if (provider === 'tavily') {
      if (!c.apiKey) throw new Error('Tavily API key missing (Settings → Tools → Web)');
      const j = await getJson('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: c.apiKey, query, max_results: limit }) });
      return (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }));
    }
    if (provider === 'brave') {
      if (!c.apiKey) throw new Error('Brave Search API key missing (Settings → Tools → Web)');
      const j = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, { headers: { 'X-Subscription-Token': c.apiKey, Accept: 'application/json' } });
      return ((j.web && j.web.results) || []).map((x) => ({ title: x.title, url: x.url, snippet: decodeEntities(String(x.description || '').replace(/<[^>]+>/g, '')) }));
    }
    if (provider === 'searxng') {
      if (!c.searxUrl) throw new Error('SearXNG URL missing (Settings → Tools → Web)');
      const j = await getJson(`${c.searxUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, { headers: { 'User-Agent': UA } });
      return (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content }));
    }
    // DuckDuckGo HTML endpoint (no key). Try POST first, then GET on the lite host.
    let html = '';
    try {
      const r = await httpFetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'q=' + encodeURIComponent(query), signal: AbortSignal.timeout(25000) }, proxy());
      html = await r.text();
    } catch (e) { throw new Error('DuckDuckGo unreachable: ' + describeFetchError(e) + ' — set a Web proxy URL or another provider in Settings → Tools'); }
    const out = parseDuckDuckGo(html);
    if (!out.length && /anomaly|captcha|unusual traffic/i.test(html)) throw new Error('DuckDuckGo asked for a captcha (rate limit). Try again later or configure Tavily/Brave/SearXNG.');
    return out;
  }

  async function extract(url, maxChars) {
    if (isPrivateHost(url)) return `ERROR: ${url} points to a local/private address or non-http scheme — blocked.`;
    let r;
    try { r = await httpFetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'Accept-Language': 'en,fa;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(30000) }, proxy()); }
    catch (e) { return `ERROR: could not fetch ${url}: ${describeFetchError(e)}`; }
    if (!r.ok) return `ERROR: HTTP ${r.status} for ${url}`;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (/pdf|zip|octet-stream|image\/|video\/|audio\//.test(ct)) return `ERROR: ${url} is binary (${ct}); download it with run_command and read it locally.`;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 6 * 1024 * 1024) return `ERROR: page too large (${(buf.length / 1048576).toFixed(1)} MB)`;
    const raw = buf.toString('utf8');
    let title = '', text = raw;
    if (/html|xml/.test(ct) || /^\s*<(!doctype|html)/i.test(raw)) ({ title, text } = htmlToText(raw, r.url || url));
    const body = truncate(text, maxChars);
    const hint = text.length < 300 ? '\n\n(Very little text — the page probably needs JavaScript; try browser_navigate instead.)' : '';
    return `# ${title || url}\nURL: ${r.url || url}\n\n${body}${hint}`;
  }

  return [
    {
      name: 'web_search', toolset: 'web', category: 'read',
      description: 'Search the web. Returns titles, URLs and snippets. Follow up with web_extract (or browser_navigate) to read pages. Use for current events, documentation, facts you are unsure about.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'max results (default 8)' } }, required: ['query'] },
      run: async (a) => {
        const limit = Math.max(1, Math.min(20, +a.limit || 8));
        const res = (await search(String(a.query), limit)).slice(0, limit);
        if (!res.length) return 'No results.';
        return res.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${truncate(x.snippet || '', 300)}`).join('\n\n');
      },
    },
    {
      name: 'web_extract', toolset: 'web', category: 'read',
      description: 'Fetch one or more web pages (up to 5) and return their readable text. Fast and cheap; for JS-heavy or login-protected pages use browser_navigate.',
      parameters: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } }, url: { type: 'string' }, max_chars: { type: 'number', description: 'per page, default 15000, max 60000' } } },
      run: async (a) => {
        const urls = (Array.isArray(a.urls) ? a.urls : []).concat(a.url ? [a.url] : []).slice(0, 5);
        if (!urls.length) return 'ERROR: provide url or urls';
        const max = Math.max(1000, Math.min(60000, +a.max_chars || 15000));
        const outs = await Promise.all(urls.map((u) => extract(String(u), max)));
        return outs.join('\n\n---\n\n');
      },
    },
  ];
}

module.exports = { register, parseDuckDuckGo };
