'use strict';
/*
 * Private AI Chat — a single-file, dependency-free PWA.
 *
 * Privacy model
 *  - All chats, images and settings (incl. API keys) live in IndexedDB on this device,
 *    encrypted with a random 256-bit AES-GCM master key.
 *  - The master key is wrapped (encrypted) by:
 *      a) a key derived from your passcode (PBKDF2-SHA256, 600k iterations), and optionally
 *      b) a key derived from a Face ID passkey via the WebAuthn PRF extension (iOS 18+).
 *  - Nothing is sent anywhere except directly to the AI provider you configure.
 */

// ---------------------------------------------------------------- utilities
const $ = (s, el = document) => el.querySelector(s);
const te = new TextEncoder();
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const uid = () => Array.from(rand(12), b => b.toString(16).padStart(2, '0')).join('');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------- IndexedDB
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('private-ai-chat', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('meta');
        d.createObjectStore('chats');
        d.createObjectStore('images');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  req(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const q = fn(t.objectStore(store));
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  get: (st, k) => DB.req(st, 'readonly', s => s.get(k)),
  put: (st, k, v) => DB.req(st, 'readwrite', s => s.put(v, k)),
  del: (st, k) => DB.req(st, 'readwrite', s => s.delete(k)),
  all: st => DB.req(st, 'readonly', s => s.getAll()),
  clear: st => DB.req(st, 'readwrite', s => s.clear()),
};

// ---------------------------------------------------------------- crypto
const PBKDF2_ITER = 600000;
const AES = { name: 'AES-GCM', length: 256 };

async function passKek(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, AES, false, ['wrapKey', 'unwrapKey']);
}
async function prfKek(prfOutput, salt) {
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('private-ai-chat/faceid-kek/v1') }, base, AES, false, ['wrapKey', 'unwrapKey']);
}
async function wrapMk(mk, kek) {
  const iv = rand(12);
  return { iv, ct: await crypto.subtle.wrapKey('raw', mk, kek, { name: 'AES-GCM', iv }) };
}
function unwrapMk(w, kek) {
  return crypto.subtle.unwrapKey('raw', w.ct, kek, { name: 'AES-GCM', iv: w.iv }, AES, true, ['encrypt', 'decrypt']);
}

const Vault = {
  mk: null,
  meta: null, // { v, salt, iter, wrapPass, faceid: {credId, prfSalt, wrap} | null, fails, lockUntil }
  async encBytes(bytes) {
    const iv = rand(12);
    return { iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.mk, bytes) };
  },
  async decBytes(rec) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, this.mk, rec.ct));
  },
  async enc(obj) { return this.encBytes(te.encode(JSON.stringify(obj))); },
  async dec(rec) { return JSON.parse(new TextDecoder().decode(await this.decBytes(rec))); },
  saveMeta() { return DB.put('meta', 'vault', this.meta); },

  async create(pass) {
    const mk = await crypto.subtle.generateKey(AES, true, ['encrypt', 'decrypt']);
    const salt = rand(16);
    const kek = await passKek(pass, salt, PBKDF2_ITER);
    this.meta = { v: 1, salt, iter: PBKDF2_ITER, wrapPass: await wrapMk(mk, kek), faceid: null, fails: 0, lockUntil: 0 };
    await this.saveMeta();
    this.mk = mk;
  },
  async unlockWithPass(pass) {
    const m = this.meta;
    const kek = await passKek(pass, m.salt, m.iter);
    try {
      this.mk = await unwrapMk(m.wrapPass, kek);
    } catch {
      m.fails = (m.fails || 0) + 1;
      // Escalating delay after 5 wrong attempts: 30s, 60s, 120s, ... (max 1h)
      if (m.fails >= 5) m.lockUntil = Date.now() + Math.min(3600e3, 30e3 * 2 ** (m.fails - 5));
      await this.saveMeta();
      throw new Error('Wrong passcode');
    }
    m.fails = 0; m.lockUntil = 0;
    await this.saveMeta();
  },
  async unlockWithPrf(prfOut) {
    const f = this.meta.faceid;
    this.mk = await unwrapMk(f.wrap, await prfKek(prfOut, f.prfSalt));
  },
  async changePass(pass) {
    const salt = rand(16);
    const kek = await passKek(pass, salt, PBKDF2_ITER);
    Object.assign(this.meta, { salt, iter: PBKDF2_ITER, wrapPass: await wrapMk(this.mk, kek) });
    await this.saveMeta();
  },
  async enableFace(credId, prfSalt, prfOut) {
    this.meta.faceid = { credId, prfSalt, wrap: await wrapMk(this.mk, await prfKek(prfOut, prfSalt)) };
    await this.saveMeta();
  },
  async disableFace() { this.meta.faceid = null; await this.saveMeta(); },
  lock() { this.mk = null; },
};

// ---------------------------------------------------------------- Face ID (WebAuthn + PRF)
const FaceID = {
  async supported() {
    try {
      return !!(window.PublicKeyCredential && window.isSecureContext &&
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch { return false; }
  },
  // Must be called directly from a tap handler (iOS requires a user gesture).
  async register() {
    const prfSalt = rand(32);
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: rand(32),
        rp: { name: 'Private AI Chat', id: location.hostname },
        user: { id: rand(16), name: 'Private AI Chat', displayName: 'Private AI Chat unlock key' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    if (ext.prf && ext.prf.enabled === false) throw new Error(PRF_UNSUPPORTED);
    const first = ext.prf && ext.prf.results && ext.prf.results.first;
    return { credId: new Uint8Array(cred.rawId), prfSalt, prfOut: first ? new Uint8Array(first) : null };
  },
  async evaluate(credId, prfSalt) {
    const a = await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: credId }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    const ext = a.getClientExtensionResults ? a.getClientExtensionResults() : {};
    const first = ext.prf && ext.prf.results && ext.prf.results.first;
    if (!first) throw new Error(PRF_UNSUPPORTED);
    return new Uint8Array(first);
  },
};
const PRF_UNSUPPORTED = 'This device/browser cannot derive an encryption key from Face ID (needs iOS 18 or newer). Use your passcode instead.';

// ---------------------------------------------------------------- settings
const PROVIDERS = {
  openai: { base: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  anthropic: { base: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' },
  openrouter: { base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
  deepseek: { base: 'https://api.deepseek.com', model: 'deepseek-flash' },
  custom: { base: '', model: '' },
};
const DEFAULTS = {
  provider: 'openai',
  apiKey: '',
  baseUrl: PROVIDERS.openai.base,
  model: PROVIDERS.openai.model,
  systemPrompt: 'You are a helpful, concise assistant.',
  maxTokens: 8192,
  thinking: 'high', // DeepSeek: off | low | high | max
  imageKey: '',
  imageBaseUrl: 'https://api.openai.com/v1',
  imageModel: 'gpt-image-1',
  imageSize: 'square',
  imageQuality: 'auto',
  autoLock: 1,
};
let S = { ...DEFAULTS };
async function loadSettings() {
  const rec = await DB.get('meta', 'settings');
  S = { ...DEFAULTS, ...(rec ? await Vault.dec(rec) : {}) };
}
async function saveSettings() { await DB.put('meta', 'settings', await Vault.enc(S)); }

function chatBase() {
  return (S.provider === 'anthropic' ? PROVIDERS.anthropic.base : (S.baseUrl || PROVIDERS[S.provider].base)).replace(/\/+$/, '');
}
function imageCreds() {
  if (S.imageKey) return { key: S.imageKey, base: (S.imageBaseUrl || DEFAULTS.imageBaseUrl).replace(/\/+$/, '') };
  if (S.provider === 'openai' && S.apiKey) return { key: S.apiKey, base: chatBase() };
  return null;
}

// ---------------------------------------------------------------- AI providers
async function apiError(resp) {
  let msg = resp.statusText;
  try {
    const j = await resp.json();
    msg = (j.error && (j.error.message || j.error)) || j.message || JSON.stringify(j);
  } catch { /* not json */ }
  return new Error(`API error ${resp.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
}

async function* sse(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* ignore keep-alives */ }
    }
  }
}

const SHAPES = {
  square: { gpt: '1024x1024', dalle: '1024x1024' },
  landscape: { gpt: '1536x1024', dalle: '1792x1024' },
  portrait: { gpt: '1024x1536', dalle: '1024x1792' },
};
const IMAGE_TOOL = {
  name: 'generate_image',
  description: 'Create an image from a text description and show it to the user. Use whenever the user asks you to create, draw, generate, design or make a picture, photo, illustration, logo, etc. Write a detailed, self-contained prompt.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to create.' },
      shape: { type: 'string', enum: ['square', 'landscape', 'portrait'], description: 'Aspect ratio.' },
    },
    required: ['prompt'],
  },
};

async function generateImage(prompt, shape, signal) {
  const c = imageCreds();
  if (!c) throw new Error('Image generation needs an OpenAI API key. Add one under Settings → Image generation.');
  const model = S.imageModel || DEFAULTS.imageModel;
  const dalle = model.startsWith('dall-e');
  const sz = SHAPES[shape] || SHAPES[S.imageSize] || SHAPES.square;
  const body = { model, prompt, n: 1, size: dalle ? sz.dalle : sz.gpt };
  if (dalle) {
    body.response_format = 'b64_json';
    if (model === 'dall-e-3' && S.imageQuality === 'high') body.quality = 'hd';
  } else if (S.imageQuality && S.imageQuality !== 'auto') {
    body.quality = S.imageQuality;
  }
  const resp = await fetch(`${c.base}/images/generations`, {
    method: 'POST', signal, referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await apiError(resp);
  const j = await resp.json();
  const d = j.data && j.data[0];
  if (!d) throw new Error('The image API returned no image.');
  if (d.b64_json) return { bytes: b64ToBytes(d.b64_json), type: 'image/png', revised: d.revised_prompt };
  if (d.url) {
    const r = await fetch(d.url, { signal });
    return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/png', revised: d.revised_prompt };
  }
  throw new Error('Unrecognised image API response.');
}

function historyFor(messages) {
  const out = [];
  for (const m of messages) {
    if (m.error && !m.text && !(m.images && m.images.length)) continue;
    let content = m.text || '';
    if (m.images && m.images.length) {
      content += (content ? '\n\n' : '') + m.images.map(i => `[An image was generated and shown to the user. Prompt: "${i.prompt}"]`).join('\n');
    }
    if (!content.trim()) continue;
    const h = { role: m.role, content };
    if (m.role === 'assistant') h.reasoning = m.reasoning || '';
    out.push(h);
  }
  return out;
}

function systemPrompt(canImage) {
  return (S.systemPrompt || '').trim() + '\n\n' + (canImage
    ? 'You can create images with the generate_image tool. Call it whenever the user asks for an image. After it runs the image is already visible to the user; do not include links or markdown images, just add a short comment if useful.'
    : 'Image generation is not configured in this app. If the user asks for an image, tell them to add an OpenAI key under Settings → Image generation.');
}

/**
 * Runs one assistant turn with tool-calling for image generation.
 * cb.onText(fullText), cb.onImage({bytes,type}, prompt), cb.onStatus(text|null)
 */
async function chatTurn(messages, cb, signal) {
  if (!S.apiKey) throw new Error('Add your API key in Settings first.');
  if (!S.model) throw new Error('Choose a model in Settings (tap “Fetch” to list available models).');
  const canImage = !!imageCreds();
  const hist = historyFor(messages);
  const sys = systemPrompt(canImage);
  let full = '';
  let thoughts = '';
  const extra = [];
  for (let round = 0; round < 4; round++) {
    const prefix = full ? full + '\n\n' : '';
    const tPrefix = thoughts ? thoughts + '\n\n' : '';
    const onText = t => cb.onText(prefix + t);
    const onReasoning = t => cb.onReasoning(tPrefix + t);
    const r = S.provider === 'anthropic'
      ? await anthropicStream(sys, hist.concat(extra), canImage, onText, signal)
      : await openaiStream(sys, hist.concat(extra), canImage, onText, signal, onReasoning);
    if (r.text) full = prefix + r.text;
    if (r.reasoning) thoughts = tPrefix + r.reasoning;
    if (!r.calls.length) break;

    const results = [];
    for (const call of r.calls) {
      let args = {};
      try { args = JSON.parse(call.args || '{}'); } catch { /* bad json */ }
      if (call.name !== 'generate_image' || !args.prompt) {
        results.push({ id: call.id, content: 'Error: unknown tool or missing prompt.' });
        continue;
      }
      cb.onStatus('Creating image…');
      try {
        const img = await generateImage(args.prompt, args.shape, signal);
        await cb.onImage(img, args.prompt);
        results.push({ id: call.id, content: 'Success: the image was generated and is now displayed to the user.' });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        results.push({ id: call.id, content: `Error generating image: ${e.message}` });
      }
      cb.onStatus(null);
    }

    if (S.provider === 'anthropic') {
      const content = [];
      if (r.text && r.text.trim()) content.push({ type: 'text', text: r.text });
      for (const c of r.calls) {
        let input = {};
        try { input = JSON.parse(c.args || '{}'); } catch { /* ignore */ }
        content.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      extra.push({ role: 'assistant', content, reasoning: r.reasoning || '' });
      extra.push({ role: 'user', content: results.map(x => ({ type: 'tool_result', tool_use_id: x.id, content: x.content })) });
    } else {
      extra.push({
        role: 'assistant', content: r.text || null, reasoning: r.reasoning || '',
        tool_calls: r.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
      });
      for (const x of results) extra.push({ role: 'tool', tool_call_id: x.id, content: x.content });
    }
  }
  return full;
}

async function openaiStream(sys, messages, canImage, onText, signal, onReasoning) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${S.apiKey}` };
  if (S.provider === 'openrouter') headers['X-Title'] = 'Private AI Chat';
  const deepseek = S.provider === 'deepseek';
  // DeepSeek thinking mode + tools requires every earlier assistant turn's reasoning to be sent back.
  // If some turn has none (older message, other provider), use non-thinking mode for this request.
  const think = deepseek && S.thinking !== 'off' &&
    !(canImage && messages.some(m => m.role === 'assistant' && !m.reasoning));
  const wire = messages.map(({ reasoning, ...m }) => (think && m.role === 'assistant' ? { ...m, reasoning_content: reasoning || '' } : m));
  const body = { model: S.model, stream: true, messages: [{ role: 'system', content: sys }, ...wire] };
  if (canImage) body.tools = [{ type: 'function', function: IMAGE_TOOL }];
  if (deepseek) {
    body.thinking = { type: think ? 'enabled' : 'disabled' };
    if (think) body.reasoning_effort = S.thinking;
  }
  const resp = await fetch(`${chatBase()}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), signal, referrerPolicy: 'no-referrer',
  });
  if (!resp.ok) throw await apiError(resp);
  let text = '';
  let reasoning = '';
  const calls = [];
  for await (const ev of sse(resp)) {
    if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
    const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (!delta) continue;
    const thought = delta.reasoning_content || (typeof delta.reasoning === 'string' ? delta.reasoning : '');
    if (thought) { reasoning += thought; if (onReasoning) onReasoning(reasoning); }
    if (delta.content) { text += delta.content; onText(text); }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? calls.length;
      calls[i] = calls[i] || { id: '', name: '', args: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function && tc.function.name) calls[i].name += tc.function.name;
      if (tc.function && tc.function.arguments) calls[i].args += tc.function.arguments;
    }
  }
  return { text, reasoning, calls: calls.filter(Boolean) };
}

async function anthropicStream(sys, messages, canImage, onText, signal) {
  messages = messages.map(({ reasoning, ...m }) => m);
  const body = { model: S.model, max_tokens: Number(S.maxTokens) || 8192, system: sys, stream: true, messages };
  if (canImage) body.tools = [{ name: IMAGE_TOOL.name, description: IMAGE_TOOL.description, input_schema: IMAGE_TOOL.parameters }];
  const resp = await fetch(`${PROVIDERS.anthropic.base}/messages`, {
    method: 'POST', signal, referrerPolicy: 'no-referrer',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': S.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await apiError(resp);
  let text = '';
  const blocks = {};
  for await (const ev of sse(resp)) {
    if (ev.type === 'error') throw new Error((ev.error && ev.error.message) || 'Stream error');
    if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
      blocks[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, args: '' };
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta.type === 'text_delta') { text += ev.delta.text; onText(text); }
      else if (ev.delta.type === 'input_json_delta' && blocks[ev.index]) blocks[ev.index].args += ev.delta.partial_json;
    }
  }
  return { text, calls: Object.values(blocks) };
}

async function fetchModels() {
  if (!S.apiKey) throw new Error('Enter your API key first.');
  let resp;
  if (S.provider === 'anthropic') {
    resp = await fetch(`${PROVIDERS.anthropic.base}/models?limit=100`, {
      referrerPolicy: 'no-referrer',
      headers: { 'x-api-key': S.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
  } else {
    resp = await fetch(`${chatBase()}/models`, { referrerPolicy: 'no-referrer', headers: { Authorization: `Bearer ${S.apiKey}` } });
  }
  if (!resp.ok) throw await apiError(resp);
  const j = await resp.json();
  return (j.data || []).map(m => m.id).sort();
}

// ---------------------------------------------------------------- markdown (escape-first, safe)
function inlineMd(s) {
  return s.split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  }).join('');
}
const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/;
const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inlineMd(c.trim()));
function md(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><button class="copy" type="button">Copy</button><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)/);
    if (h) { const n = Math.min(h[1].length + 2, 6); out.push(`<h${n}>${inlineMd(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST_RE.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      while (i < lines.length && (LIST_RE.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (LIST_RE.test(lines[i])) items.push(inlineMd(lines[i].replace(LIST_RE, '')));
        else items[items.length - 1] += '<br>' + inlineMd(lines[i].trim());
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(x => `<li>${x}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${md(q.join('\n'))}</blockquote>`);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>)/.test(lines[i]) && !LIST_RE.test(lines[i])) para.push(inlineMd(lines[i++]));
    if (!para.length) para.push(inlineMd(lines[i++]));
    out.push(`<p>${para.join('<br>')}</p>`);
  }
  return out.join('');
}

// ---------------------------------------------------------------- app state
let chats = [];          // decrypted chat objects {id,title,created,updated,messages}
let current = null;
let busy = false;
let abortCtl = null;
let imageMode = false;
const imgUrls = new Map(); // image id -> object URL

const el = {
  lock: $('#lock'), app: $('#app'), lockTitle: $('#lockTitle'), lockSub: $('#lockSub'), lockForm: $('#lockForm'),
  pass1: $('#pass1'), pass2: $('#pass2'), lockSubmit: $('#lockSubmit'), lockErr: $('#lockErr'), lockHint: $('#lockHint'),
  faceBtn: $('#faceBtn'), chatList: $('#chatList'), search: $('#search'), messages: $('#messages'), input: $('#input'),
  composer: $('#composer'), sendBtn: $('#sendBtn'), imgMode: $('#imgMode'), chatTitle: $('#chatTitle'),
  settings: $('#settings'), settingsForm: $('#settingsForm'), viewer: $('#viewer'),
};

async function saveChat(chat) { await DB.put('chats', chat.id, await Vault.enc(chat)); }
async function loadChats() {
  chats = [];
  for (const rec of await DB.all('chats')) {
    try { chats.push(await Vault.dec(rec)); } catch { /* corrupt record */ }
  }
  chats.sort((a, b) => b.updated - a.updated);
}
async function imageUrl(id) {
  if (imgUrls.has(id)) return imgUrls.get(id);
  const rec = await DB.get('images', id);
  if (!rec) return null;
  const bytes = await Vault.decBytes(rec.data);
  const url = URL.createObjectURL(new Blob([bytes], { type: rec.type || 'image/png' }));
  imgUrls.set(id, url);
  return url;
}

// ---------------------------------------------------------------- lock screen
async function showLock() {
  el.app.hidden = true;
  el.lock.hidden = false;
  el.lockErr.textContent = '';
  el.pass1.value = el.pass2.value = '';
  const setup = !Vault.meta;
  el.pass2.hidden = !setup;
  el.pass2.required = setup;
  el.lockSubmit.textContent = setup ? 'Create vault' : 'Unlock';
  el.lockSub.textContent = setup ? 'Create a passcode to encrypt your chats on this device.' : 'Locked';
  el.lockHint.textContent = setup
    ? 'Minimum 6 characters. There is no recovery — if you forget it, your chats cannot be decrypted. You can enable Face ID afterwards in Settings.'
    : '';
  el.faceBtn.hidden = setup || !Vault.meta.faceid;
  if (!el.faceBtn.hidden) el.faceBtn.focus(); else el.pass1.focus();
}

el.lockForm.addEventListener('submit', async e => {
  e.preventDefault();
  el.lockErr.textContent = '';
  const p1 = el.pass1.value;
  try {
    el.lockSubmit.disabled = true;
    if (!Vault.meta) {
      if (p1.length < 6) throw new Error('Use at least 6 characters.');
      if (p1 !== el.pass2.value) throw new Error('Passcodes do not match.');
      el.lockSubmit.textContent = 'Encrypting…';
      await Vault.create(p1);
      await saveSettings();
    } else {
      const wait = (Vault.meta.lockUntil || 0) - Date.now();
      if (wait > 0) throw new Error(`Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`);
      el.lockSubmit.textContent = 'Unlocking…';
      await Vault.unlockWithPass(p1);
    }
    await enterApp();
  } catch (err) {
    el.lockErr.textContent = err.message;
    el.lockSubmit.textContent = Vault.meta ? 'Unlock' : 'Create vault';
  } finally {
    el.lockSubmit.disabled = false;
  }
});

el.faceBtn.addEventListener('click', async () => {
  el.lockErr.textContent = '';
  const f = Vault.meta.faceid;
  try {
    const out = await FaceID.evaluate(f.credId, f.prfSalt); // first call in the gesture
    await Vault.unlockWithPrf(out);
    await enterApp();
  } catch (err) {
    el.lockErr.textContent = err.name === 'NotAllowedError' ? 'Face ID was cancelled. Use your passcode.' : err.message;
  }
});

async function enterApp() {
  await loadSettings();
  await loadChats();
  el.lock.hidden = true;
  el.app.hidden = false;
  el.pass1.value = el.pass2.value = '';
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  openChat(chats[0] || null);
  renderChatList();
  if (!S.apiKey) openSettings();
}

function lockApp() {
  if (abortCtl) abortCtl.abort();
  Vault.lock();
  S = { ...DEFAULTS };
  chats = []; current = null;
  for (const u of imgUrls.values()) URL.revokeObjectURL(u);
  imgUrls.clear();
  el.messages.innerHTML = '';
  el.chatList.innerHTML = '';
  if (el.settings.open) el.settings.close();
  if (el.viewer.open) el.viewer.close();
  showLock();
}

// Auto-lock + privacy veil
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    document.body.classList.add('veiled');
    if (Vault.mk && Number(S.autoLock) === 0) lockApp();
  } else {
    if (Vault.mk && Date.now() - hiddenAt >= Number(S.autoLock) * 60e3) lockApp();
    document.body.classList.remove('veiled');
  }
});

// ---------------------------------------------------------------- chat list
function fmtDate(t) {
  const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function renderChatList() {
  const q = el.search.value.trim().toLowerCase();
  const list = chats.filter(c => !q || c.title.toLowerCase().includes(q) || c.messages.some(m => (m.text || '').toLowerCase().includes(q)));
  el.chatList.innerHTML = list.map(c => `
    <li data-id="${c.id}" class="${current && current.id === c.id ? 'active' : ''}">
      <button type="button" class="chat-open"><span class="t">${esc(c.title)}</span><span class="d">${fmtDate(c.updated)}</span></button>
      <button type="button" class="chat-more" aria-label="Chat options">⋯</button>
    </li>`).join('') || `<li class="muted fine">${q ? 'No matches' : 'No chats yet'}</li>`;
}
el.search.addEventListener('input', renderChatList);
el.chatList.addEventListener('click', async e => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const chat = chats.find(c => c.id === li.dataset.id);
  if (e.target.closest('.chat-open')) { openChat(chat); closeDrawer(); return; }
  if (e.target.closest('.chat-more')) {
    const action = prompt(`“${chat.title}”\nType a new name to rename, or type DELETE to delete this chat:`, chat.title);
    if (action === null) return;
    if (action.trim() === 'DELETE') await deleteChat(chat);
    else if (action.trim()) { chat.title = action.trim().slice(0, 80); await saveChat(chat); }
    renderChatList();
    if (current) el.chatTitle.textContent = current.title;
  }
});
async function deleteChat(chat) {
  for (const m of chat.messages) for (const img of m.images || []) {
    await DB.del('images', img.id);
    if (imgUrls.has(img.id)) { URL.revokeObjectURL(imgUrls.get(img.id)); imgUrls.delete(img.id); }
  }
  await DB.del('chats', chat.id);
  chats = chats.filter(c => c !== chat);
  if (current === chat) openChat(chats[0] || null);
}
function newChat() {
  if (busy) return;
  openChat(null);
  closeDrawer();
  el.input.focus();
}
$('#newChat').addEventListener('click', newChat);
$('#newChat2').addEventListener('click', newChat);
$('#menuBtn').addEventListener('click', () => el.app.classList.add('drawer-open'));
$('#scrim').addEventListener('click', closeDrawer);
function closeDrawer() { el.app.classList.remove('drawer-open'); }
$('#lockNow').addEventListener('click', lockApp);

// ---------------------------------------------------------------- messages
function openChat(chat) {
  if (busy) return;
  current = chat;
  el.chatTitle.textContent = chat ? chat.title : 'New chat';
  renderMessages();
  renderChatList();
}

function renderMessages() {
  if (!current || !current.messages.length) {
    const ready = S.apiKey ? '' : '<p>Open <b>Settings</b> to add your API key.</p>';
    el.messages.innerHTML = `<div class="empty"><h3>How can I help?</h3><p>Ask anything, or ask for an image — e.g. “create an image of a fox reading a book”. Tap 🎨 to send a prompt straight to the image model.</p>${ready}</div>`;
    return;
  }
  el.messages.innerHTML = current.messages.map(msgHtml).join('');
  hydrateImages(el.messages);
  scrollToBottom(true);
}
function msgHtml(m) {
  const isUser = m.role === 'user';
  const body = isUser ? esc(m.text) : md(m.text || '');
  const imgs = (m.images || []).map(i => `<img data-img="${i.id}" alt="${esc(i.prompt)}" title="${esc(i.prompt)}">`).join('');
  const tag = isUser && m.mode === 'image' ? '<div class="tag">🎨 image prompt</div>' : '';
  const status = m.status ? `<div class="status">${esc(m.status)}</div>` : '';
  const thoughts = !isUser && m.reasoning && !m.streaming
    ? `<details class="reasoning"><summary>Reasoning</summary><div>${esc(m.reasoning)}</div></details>` : '';
  const typing = m.streaming && !m.status ? ' typing' : '';
  const err = m.error ? `<div class="error">⚠︎ ${esc(m.error)}</div>` : '';
  const actions = !isUser && !m.streaming
    ? `<div class="actions">${m.text ? '<button type="button" data-act="copy">Copy</button>' : ''}<button type="button" data-act="retry">Retry</button></div>`
    : '';
  return `<div class="msg ${m.role}" data-id="${m.id}">${tag}${thoughts}<div class="bubble${typing}">${body}${status}${imgs ? `<div class="imgs">${imgs}</div>` : ''}</div>${err}${actions}</div>`;
}
async function hydrateImages(root) {
  for (const img of root.querySelectorAll('img[data-img]:not([src])')) {
    const url = await imageUrl(img.dataset.img).catch(() => null);
    if (url) img.src = url;
  }
}
function updateMsg(m) {
  const node = el.messages.querySelector(`.msg[data-id="${m.id}"]`);
  if (!node) return renderMessages();
  const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 120;
  node.outerHTML = msgHtml(m);
  hydrateImages(el.messages);
  if (nearBottom) scrollToBottom();
}
let rafPending = false;
function scheduleUpdate(m) {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; updateMsg(m); });
}
function scrollToBottom() { el.messages.scrollTop = el.messages.scrollHeight; }

el.messages.addEventListener('click', async e => {
  const copy = e.target.closest('pre .copy');
  if (copy) {
    await navigator.clipboard.writeText(copy.nextElementSibling.textContent).catch(() => {});
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    return;
  }
  const img = e.target.closest('img[data-img]');
  if (img && img.src) {
    $('#viewerImg').src = img.src;
    $('#viewerCap').textContent = img.alt;
    $('#viewerSave').href = img.src;
    el.viewer.showModal();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act || busy) return;
  const id = act.closest('.msg').dataset.id;
  const idx = current.messages.findIndex(m => m.id === id);
  const m = current.messages[idx];
  if (act.dataset.act === 'copy') {
    await navigator.clipboard.writeText(m.text).catch(() => {});
    act.textContent = 'Copied';
  } else if (act.dataset.act === 'retry') {
    const prevUser = current.messages[idx - 1];
    for (const img of m.images || []) await DB.del('images', img.id);
    Object.assign(m, { text: '', reasoning: '', images: [], error: null, status: null });
    current.messages.length = idx + 1; // drop anything after this answer
    renderMessages();
    await runAssistant(current, m, prevUser && prevUser.mode === 'image' ? prevUser.text : null);
  }
});
$('#viewerClose').addEventListener('click', () => el.viewer.close());

// ---------------------------------------------------------------- composer
function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, window.innerHeight * 0.4) + 'px';
}
el.input.addEventListener('input', autosize);
el.input.addEventListener('keydown', e => {
  // Enter sends on hardware keyboards; on iPhone the return key inserts a newline.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover: hover)').matches) {
    e.preventDefault();
    el.composer.requestSubmit();
  }
});
el.imgMode.addEventListener('click', () => {
  imageMode = !imageMode;
  el.imgMode.setAttribute('aria-pressed', String(imageMode));
  document.body.classList.toggle('imgmode', imageMode);
  el.input.placeholder = imageMode ? 'Describe the image…' : 'Message';
  el.input.focus();
});
el.composer.addEventListener('submit', async e => {
  e.preventDefault();
  if (busy) { if (abortCtl) abortCtl.abort(); return; }
  const text = el.input.value.trim();
  if (!text) return;
  if (!current) {
    current = { id: uid(), title: 'New chat', created: Date.now(), updated: Date.now(), messages: [] };
    chats.unshift(current);
  }
  const chat = current;
  const direct = imageMode;
  chat.messages.push({ id: uid(), role: 'user', text, ts: Date.now(), mode: direct ? 'image' : undefined });
  if (chat.title === 'New chat') chat.title = text.replace(/\s+/g, ' ').slice(0, 48);
  el.chatTitle.textContent = chat.title;
  el.input.value = '';
  autosize();
  const asst = { id: uid(), role: 'assistant', text: '', images: [], ts: Date.now() };
  chat.messages.push(asst);
  renderMessages();
  renderChatList();
  await runAssistant(chat, asst, direct ? text : null);
});

function setBusy(b) {
  busy = b;
  el.sendBtn.classList.toggle('stop', b);
  el.sendBtn.textContent = b ? '■' : '↑';
  el.sendBtn.setAttribute('aria-label', b ? 'Stop' : 'Send');
}

async function addImage(chat, msg, img, prompt) {
  const id = uid();
  await DB.put('images', id, { type: img.type, data: await Vault.encBytes(img.bytes) });
  msg.images.push({ id, prompt });
  await saveChat(chat);
}

async function runAssistant(chat, asst, directImagePrompt) {
  setBusy(true);
  abortCtl = new AbortController();
  const signal = abortCtl.signal;
  asst.streaming = true;
  updateMsg(asst);
  try {
    if (directImagePrompt) {
      asst.status = 'Creating image…';
      updateMsg(asst);
      const img = await generateImage(directImagePrompt, S.imageSize, signal);
      await addImage(chat, asst, img, directImagePrompt);
      if (img.revised) asst.text = `*Revised prompt:* ${img.revised}`;
    } else {
      await chatTurn(chat.messages.slice(0, -1), {
        onText: t => {
          asst.text = t;
          if (asst.status === 'Thinking…') asst.status = null;
          scheduleUpdate(asst);
        },
        onReasoning: t => {
          asst.reasoning = t;
          if (!asst.status) asst.status = 'Thinking…';
          scheduleUpdate(asst);
        },
        onStatus: s => { asst.status = s; updateMsg(asst); },
        onImage: async (img, prompt) => { await addImage(chat, asst, img, prompt); updateMsg(asst); },
      }, signal);
    }
  } catch (err) {
    if (err.name === 'AbortError') { if (!asst.text && !asst.images.length) asst.error = 'Stopped.'; }
    else asst.error = err.message === 'Load failed' || err.message === 'Failed to fetch'
      ? 'Network error — check your connection, base URL and API key.'
      : err.message;
  } finally {
    asst.streaming = false;
    asst.status = null;
    chat.updated = Date.now();
    abortCtl = null;
    setBusy(false);
    if (Vault.mk) {
      await saveChat(chat);
      chats.sort((a, b) => b.updated - a.updated);
      if (current === chat) updateMsg(asst);
      renderChatList();
    }
  }
}

// ---------------------------------------------------------------- settings dialog
const form = el.settingsForm;
function syncProviderFields() {
  const p = form.provider.value;
  for (const n of form.querySelectorAll('[data-show]')) n.hidden = !n.dataset.show.split(' ').includes(p);
}
function openSettings() {
  for (const [k, v] of Object.entries(S)) if (form[k]) form[k].value = v;
  syncProviderFields();
  refreshFaceStatus();
  closeDrawer();
  el.settings.showModal();
}
$('#openSettings').addEventListener('click', openSettings);
form.provider.addEventListener('change', () => {
  const p = form.provider.value;
  const known = Object.values(PROVIDERS).map(x => x.model);
  const knownBases = Object.values(PROVIDERS).map(x => x.base);
  if (!form.model.value || known.includes(form.model.value)) form.model.value = PROVIDERS[p].model;
  if (!form.baseUrl.value || knownBases.includes(form.baseUrl.value)) form.baseUrl.value = PROVIDERS[p].base;
  $('#modelList').innerHTML = '';
  syncProviderFields();
});
function readForm() {
  const next = { ...S };
  for (const k of Object.keys(DEFAULTS)) if (form[k]) next[k] = typeof DEFAULTS[k] === 'number' ? Number(form[k].value) : form[k].value.trim();
  return next;
}
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.submitter && e.submitter.value === 'close') { el.settings.close(); return; }
  S = readForm();
  await saveSettings();
  el.settings.close();
  if (!current || !current.messages.length) renderMessages();
});
$('#fetchModels').addEventListener('click', async e => {
  const btn = e.currentTarget;
  const saved = S;
  S = readForm();
  btn.textContent = '…';
  try {
    const ids = await fetchModels();
    $('#modelList').innerHTML = ids.map(id => `<option value="${esc(id)}"></option>`).join('');
    alert(`Found ${ids.length} models. Tap the Model field to pick one.`);
  } catch (err) {
    alert(err.message);
  } finally {
    S = saved;
    btn.textContent = 'Fetch';
  }
});

async function refreshFaceStatus() {
  const btn = $('#faceToggle'), status = $('#faceStatus');
  const sup = await FaceID.supported();
  if (Vault.meta && Vault.meta.faceid) {
    btn.textContent = 'Disable Face ID';
    btn.disabled = false;
    status.textContent = 'Face ID unlock is on. Your passcode still works as a backup.';
  } else {
    btn.textContent = 'Enable Face ID';
    btn.disabled = !sup;
    status.textContent = sup ? 'Uses a passkey to derive an encryption key (iOS 18+).'
      : 'Face ID / passkeys are not available here. Open the installed app over HTTPS on iOS 18+.';
  }
}

// Shows a modal and runs fn() directly inside the tap handler, so WebAuthn has a user gesture.
function confirmTap(message, fn) {
  return new Promise((resolve, reject) => {
    const dlg = $('#tapDlg');
    $('#tapMsg').textContent = message;
    const ok = $('#tapOk'), cancel = $('#tapCancel');
    const done = () => { ok.onclick = cancel.onclick = null; dlg.close(); };
    ok.onclick = () => { const p = fn(); done(); p.then(resolve, reject); };
    cancel.onclick = () => { done(); reject(new Error('Cancelled')); };
    dlg.showModal();
  });
}

$('#faceToggle').addEventListener('click', async () => {
  const status = $('#faceStatus');
  if (Vault.meta.faceid) {
    if (!confirm('Turn off Face ID unlock? You will need your passcode.')) return;
    await Vault.disableFace();
    return refreshFaceStatus();
  }
  try {
    const reg = await FaceID.register(); // first await inside the tap: keeps the user gesture
    let out = reg.prfOut;
    if (!out) out = await confirmTap('One more Face ID scan is needed to finish setup.', () => FaceID.evaluate(reg.credId, reg.prfSalt));
    await Vault.enableFace(reg.credId, reg.prfSalt, out);
    status.textContent = 'Face ID enabled.';
    refreshFaceStatus();
  } catch (err) {
    status.textContent = err.name === 'NotAllowedError' ? 'Face ID setup was cancelled.' : err.message;
  }
});

$('#changePass').addEventListener('click', async () => {
  const p1 = prompt('New passcode (min 6 characters):');
  if (p1 === null) return;
  if (p1.length < 6) return alert('Use at least 6 characters.');
  if (prompt('Confirm new passcode:') !== p1) return alert('Passcodes do not match.');
  await Vault.changePass(p1);
  alert('Passcode changed.');
});

$('#exportBtn').addEventListener('click', async () => {
  if (!confirm('Export all chats (with images) as an UNENCRYPTED JSON file? Keep it somewhere safe.')) return;
  const data = { app: 'private-ai-chat', exported: new Date().toISOString(), chats: [] };
  for (const c of chats) {
    const copy = structuredClone(c);
    for (const m of copy.messages) for (const img of m.images || []) {
      const rec = await DB.get('images', img.id);
      if (rec) img.dataUrl = `data:${rec.type};base64,${bytesToB64(await Vault.decBytes(rec.data))}`;
    }
    data.chats.push(copy);
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `ai-chats-${Date.now()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});

$('#wipeBtn').addEventListener('click', async () => {
  if (prompt('This permanently deletes ALL chats, images, keys and settings on this device.\nType ERASE to confirm:') !== 'ERASE') return;
  await DB.clear('chats');
  await DB.clear('images');
  await DB.clear('meta');
  Vault.meta = null;
  lockApp();
});

// ---------------------------------------------------------------- iOS viewport handling
function fitViewport() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${h}px`);
  window.scrollTo(0, 0);
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', fitViewport);
  visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
}
window.addEventListener('resize', fitViewport);

// ---------------------------------------------------------------- boot
(async function boot() {
  fitViewport();
  if (!window.crypto || !crypto.subtle) {
    document.body.textContent = 'This app must be opened over HTTPS.';
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  await DB.open();
  Vault.meta = (await DB.get('meta', 'vault')) || null;
  showLock();
})();
