// Vision + media: vision_analyze, image_generate, text_to_speech, transcribe_audio.
// All use OpenAI-compatible endpoints; override base/key/models in Settings → Tools.
const fs = require('fs/promises');
const path = require('path');
const { httpFetch, describeFetchError, truncate } = require('./util');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

function register(ctx) {
  const { nativeImage, shell } = ctx.electron;
  const S = () => ctx.getSettings();
  const media = () => S().media || {};
  const base = () => (media().baseUrl || S().baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const key = () => media().apiKey || S().apiKey || '';
  const proxy = () => S().llmProxyUrl || '';
  const outDir = () => path.join(ctx.userDataDir(), 'media');

  async function toDataUrl(src) {
    let buf, mime;
    if (/^https?:\/\//i.test(src)) {
      const r = await httpFetch(src, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0' } }, (S().web || {}).proxyUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status} downloading image`);
      buf = Buffer.from(await r.arrayBuffer());
      mime = (r.headers.get('content-type') || '').split(';')[0] || 'image/jpeg';
    } else if (/^data:image\//.test(src)) return src;
    else { buf = await fs.readFile(src); mime = MIME[path.extname(src).toLowerCase()] || 'image/png'; }
    if (buf.length > 12 * 1024 * 1024) throw new Error('image too large (>12 MB)');
    // shrink big raster images so they fit vision limits
    try {
      const img = nativeImage.createFromBuffer(buf);
      const s = img.getSize();
      if (s.width && Math.max(s.width, s.height) > 1568) {
        const k = 1568 / Math.max(s.width, s.height);
        return 'data:image/jpeg;base64,' + img.resize({ width: Math.round(s.width * k), height: Math.round(s.height * k), quality: 'good' }).toJPEG(82).toString('base64');
      }
    } catch {}
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  async function auxVision(dataUrl, question) {
    const m = media();
    const b = (m.visionBaseUrl || base()).replace(/\/+$/, '');
    const k = m.visionApiKey || key();
    const r = await httpFetch(b + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
      body: JSON.stringify({ model: m.visionModel, messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: dataUrl } }] }], max_tokens: 1200 }),
      signal: AbortSignal.timeout(90000),
    }, proxy());
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`vision model error ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '(empty answer)';
  }

  async function post(url, body, timeout, asBuffer) {
    let r;
    try { r = await httpFetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key()}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(timeout) }, proxy()); }
    catch (e) { throw new Error('network error: ' + describeFetchError(e)); }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return asBuffer ? Buffer.from(await r.arrayBuffer()) : r.json();
  }

  const P = (props, req) => ({ type: 'object', properties: props, required: req || [] });

  const defs = [
    {
      name: 'vision_analyze', toolset: 'vision', category: 'read',
      description: 'Look at an image (file path, URL, or "screen" for the current screen) and answer a question about it. Use for photos, screenshots, charts, scanned documents, UI inspection.',
      parameters: P({ image: { type: 'string', description: 'file path, http(s) URL, or "screen"' }, question: { type: 'string', description: 'what to look for (default: describe in detail)' } }, ['image']),
      run: async (a, call) => {
        let dataUrl;
        if (a.image === 'screen') {
          const r = await ctx.callTool('computer', { action: 'screenshot' }, call, true);
          dataUrl = r.image;
        } else dataUrl = await toDataUrl(String(a.image));
        const q = a.question || 'Describe this image in detail. Transcribe any visible text.';
        if (media().visionModel) return await auxVision(dataUrl, q);
        return { text: `Image loaded. Question to answer: ${q}`, image: dataUrl };
      },
    },
    {
      name: 'image_generate', toolset: 'media', category: 'write',
      description: 'Generate an image from a text prompt (OpenAI-compatible images API). Saves a PNG and returns its path. Needs user permission.',
      parameters: P({ prompt: { type: 'string' }, size: { type: 'string', description: 'e.g. 1024x1024, 1536x1024, 1024x1536' }, save_to: { type: 'string', description: 'optional output path' }, open: { type: 'boolean' } }, ['prompt']),
      confirm: (a) => ({ title: 'تولید تصویر (هزینه‌ی API)', detail: String(a.prompt).slice(0, 300) }),
      run: async (a) => {
        const m = media();
        const j = await post(base() + '/images/generations', { model: m.imageModel || 'gpt-image-1', prompt: a.prompt, size: a.size || '1024x1024', n: 1 }, 180000);
        const d = j.data && j.data[0];
        if (!d) return 'ERROR: no image returned: ' + JSON.stringify(j).slice(0, 300);
        let buf;
        if (d.b64_json) buf = Buffer.from(d.b64_json, 'base64');
        else if (d.url) { const r = await httpFetch(d.url, { signal: AbortSignal.timeout(60000) }, proxy()); buf = Buffer.from(await r.arrayBuffer()); }
        else return 'ERROR: unexpected image response';
        await fs.mkdir(outDir(), { recursive: true });
        const file = a.save_to || path.join(outDir(), `img-${Date.now()}.png`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, buf);
        if (a.open) shell.openPath(file);
        return `OK: image saved to ${file}`;
      },
    },
    {
      name: 'text_to_speech', toolset: 'media', category: 'write',
      description: 'Convert text to speech (MP3) with an OpenAI-compatible TTS API. play=true opens it in the default player.',
      parameters: P({ text: { type: 'string' }, voice: { type: 'string' }, play: { type: 'boolean' }, save_to: { type: 'string' } }, ['text']),
      confirm: (a) => ({ title: 'تبدیل متن به گفتار (هزینه‌ی API)', detail: String(a.text).slice(0, 200) }),
      run: async (a) => {
        const m = media();
        const buf = await post(base() + '/audio/speech', { model: m.ttsModel || 'tts-1', voice: a.voice || m.ttsVoice || 'alloy', input: String(a.text).slice(0, 4000) }, 120000, true);
        await fs.mkdir(outDir(), { recursive: true });
        const file = a.save_to || path.join(outDir(), `tts-${Date.now()}.mp3`);
        await fs.writeFile(file, buf);
        if (a.play) shell.openPath(file);
        return `OK: audio saved to ${file}`;
      },
    },
    {
      name: 'transcribe_audio', toolset: 'media', category: 'read',
      description: 'Transcribe an audio/voice file (mp3, wav, m4a, ogg, webm…) to text with an OpenAI-compatible speech-to-text API.',
      parameters: P({ path: { type: 'string' }, language: { type: 'string', description: 'optional ISO code like fa, en' } }, ['path']),
      run: async (a) => truncate(await transcribe(await fs.readFile(a.path), path.basename(a.path), a.language), 30000),
    },
  ];

  async function transcribe(buf, filename, language) {
    const m = media();
    const fd = new FormData();
    fd.append('file', new Blob([buf]), filename || 'audio.ogg');
    fd.append('model', m.sttModel || 'whisper-1');
    if (language) fd.append('language', language);
    const j = await post(base() + '/audio/transcriptions', fd, 180000);
    return j.text || '';
  }

  const describe = (dataUrl) => auxVision(dataUrl, 'This is a screenshot/image an AI agent needs to operate. Describe: which app/page is shown, all visible interactive elements (buttons, fields, links, menus) with approximate pixel coordinates (x,y) relative to this image, and any important text. Be precise and compact.');
  return { defs, transcribe, toDataUrl, describe };
}

module.exports = { register };
