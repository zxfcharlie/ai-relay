// Talks to OpenAI and Anthropic (Claude) upstream APIs and normalizes both
// into a single async-generator interface that yields plain text deltas.
// Also normalizes message *content* (text + images) so callers never have
// to think about which provider's wire format they're targeting.

// ---------------- content normalization (text + images) ----------------

// Internal normalized content is either:
//   a plain string, or
//   an array of parts: { type: 'text', text } | { type: 'image', mediaType, data (base64, no prefix) }
// Callers may also pass OpenAI-style content arrays
// ([{type:'text',...}, {type:'image_url', image_url:{url:'data:...'}}]) —
// e.g. from the external relay endpoint — and this still works, since we
// normalize on the way in.

function normalizeContent(content) {
  if (typeof content === 'string' || content == null) return content || '';
  if (!Array.isArray(content)) return String(content);
  return content.map((part) => {
    if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
    if (part.type === 'image') return part; // already normalized
    if (part.type === 'text') return { type: 'text', text: part.text || '' };
    if (part.type === 'image_url') {
      const url = (part.image_url && part.image_url.url) || '';
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (m) return { type: 'image', mediaType: m[1], data: m[2] };
      // Remote (non-data) URLs aren't fetched server-side for this MVP.
      return { type: 'text', text: '[image omitted: remote URLs are not supported, use a data URL]' };
    }
    return { type: 'text', text: '' };
  });
}

function toOpenAIMessages(messages) {
  return messages.map((m) => {
    const c = normalizeContent(m.content);
    if (typeof c === 'string') return { role: m.role, content: c };
    return {
      role: m.role,
      content: c.map((p) =>
        p.type === 'image'
          ? { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } }
          : { type: 'text', text: p.text }
      )
    };
  });
}

function toClaudeMessages(messages) {
  let system;
  const out = [];
  for (const m of messages) {
    const c = normalizeContent(m.content);
    if (m.role === 'system') {
      const text = typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      system = system ? `${system}\n${text}` : text;
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof c === 'string') {
      out.push({ role, content: c });
    } else {
      out.push({
        role,
        content: c.map((p) =>
          p.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }
            : { type: 'text', text: p.text }
        )
      });
    }
  }
  return { system, messages: out };
}

// ---------------- provider inference (used by the relay's default routing) ----------------

// Configurable in case api.openai.com / api.anthropic.com aren't reachable
// from this host (e.g. geo-blocked) but a compatible mirror/proxy endpoint
// is — set OPENAI_BASE_URL / ANTHROPIC_BASE_URL to point elsewhere. For a
// generic HTTP(S) proxy instead, see services/network.js (HTTPS_PROXY).
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
const ANTHROPIC_BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

function providerForModel(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.includes('anthropic')) return 'claude';
  if (/^(gpt|o1|o3|o4|o5|chatgpt|text-|ft:)/.test(m)) return 'openai';
  return null;
}

// ---------------- dynamic model discovery (so "every model" stays current) ----------------

const modelCache = new Map(); // key: provider+':'+apiKey -> { time, models }
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCachedModels(provider, apiKey) {
  const entry = modelCache.get(`${provider}:${apiKey}`);
  if (entry && Date.now() - entry.time < CACHE_TTL_MS) return entry.models;
  return null;
}
function setCachedModels(provider, apiKey, models) {
  modelCache.set(`${provider}:${apiKey}`, { time: Date.now(), models });
}

// OpenAI's /v1/models list includes plenty of non-chat, non-image models
// (embeddings, tts, whisper, moderation, etc.) that this app can't use at
// all — those are dropped. Everything else is classified into a category
// so the UI can group it and route it correctly: 'chat' goes to
// /v1/chat/completions, 'image' goes to /v1/images/*.
const OPENAI_UNSUPPORTED = [
  'embedding', 'whisper', 'tts', 'dall-e', 'moderation', 'babbage', 'davinci-002',
  'ada', 'realtime', 'audio', 'transcribe', 'computer-use', 'search-preview',
  'sora', 'instruct'
];

function classifyOpenAIModel(id) {
  const lower = id.toLowerCase();
  if (OPENAI_UNSUPPORTED.some((b) => lower.includes(b))) return null;
  if (lower.includes('image')) return 'image';
  // o1/o3/o4/o5... — match any numbered reasoning-model prefix rather than
  // an explicit list, so a future o6/o7 isn't silently dropped.
  if (/^(gpt|o[0-9]|chatgpt)/.test(lower)) return 'chat';
  return null;
}

// Best-effort human-readable blurb + rough capability tier, matched by
// family pattern (not exact id) so it still makes sense for model
// snapshots this code has never seen — e.g. a dated "gpt-5.2-2026-11-03".
function describeOpenAIModel(id, category) {
  const lower = id.toLowerCase();
  if (category === 'image') {
    return {
      tier: 'image',
      description: '图像生成 / 编辑模型：可根据文字描述直接生成图片，也可以上传参考图后按指令编辑（改色、换背景、合成多图等）。'
    };
  }
  if (/^o[0-9]/.test(lower)) {
    return { tier: 'reasoning', description: '推理模型，擅长数学、代码与需要多步思考的复杂任务，响应通常较慢。' };
  }
  if (lower.includes('mini') || lower.includes('nano')) {
    return { tier: 'fast', description: '轻量版模型，速度快、成本低，适合日常对话和简单任务。' };
  }
  if (/^gpt-5/.test(lower)) {
    return { tier: 'flagship', description: 'OpenAI 旗舰对话模型，综合能力强，支持图片理解，适合复杂任务、长文写作与编程。' };
  }
  if (/^(gpt-4|chatgpt)/.test(lower)) {
    return { tier: 'balanced', description: '支持图文理解的多模态对话模型。' };
  }
  return { tier: 'balanced', description: 'OpenAI 对话模型。' };
}

function describeClaudeModel(id) {
  const lower = id.toLowerCase();
  if (lower.includes('opus')) {
    return { tier: 'flagship', description: 'Claude 旗舰模型，推理能力最强，适合复杂任务和高难度代码，支持图片理解。' };
  }
  if (lower.includes('haiku')) {
    return { tier: 'fast', description: 'Claude 轻量模型，响应速度最快，适合简单、高频的任务。' };
  }
  if (lower.includes('sonnet')) {
    return { tier: 'balanced', description: 'Claude 平衡型模型，兼顾能力与速度，适合日常使用，支持图片理解。' };
  }
  return { tier: 'balanced', description: 'Claude 对话模型。' };
}

// OpenAI's model list can include entries already past their announced
// retirement (shutdown_date) — still returned for a grace period, but
// calling them fails. Drop anything whose shutdown date has passed.
function isNotShutDown(m) {
  if (!m.shutdown_date) return true;
  const t = Date.parse(m.shutdown_date);
  return Number.isNaN(t) || t > Date.now();
}

async function fetchOpenAIModels(apiKey) {
  const cached = getCachedModels('openai', apiKey);
  if (cached) return cached;
  const res = await fetch(`${OPENAI_BASE_URL}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`OpenAI model list failed (${res.status})`);
  const data = await res.json();
  const models = (data.data || [])
    .filter(isNotShutDown)
    .map((m) => {
      const category = classifyOpenAIModel(m.id);
      if (!category) return null;
      const meta = describeOpenAIModel(m.id, category);
      return { id: m.id, label: m.id, provider: 'openai', category, ...meta };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  setCachedModels('openai', apiKey, models);
  return models;
}

async function fetchClaudeModels(apiKey) {
  const cached = getCachedModels('claude', apiKey);
  if (cached) return cached;
  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/models`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  });
  if (!res.ok) throw new Error(`Claude model list failed (${res.status})`);
  const data = await res.json();
  const models = (data.data || []).map((m) => ({
    id: m.id,
    label: m.display_name || m.id,
    provider: 'claude',
    category: 'chat',
    ...describeClaudeModel(m.id)
  }));
  setCachedModels('claude', apiKey, models);
  return models;
}

// ---------------- SSE parsing ----------------

async function* sseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = null;
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) yield { event, data };
    }
  }
}

// ---------------- streaming chat ----------------

async function* streamOpenAI(apiKey, model, messages) {
  const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages: toOpenAIMessages(messages), stream: true })
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 500)}`);
  }
  for await (const { data } of sseLines(res)) {
    if (data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
      if (delta && delta.content) yield delta.content;
    } catch (e) {
      // ignore malformed chunk
    }
  }
}

async function* streamClaude(apiKey, model, messages, maxTokens = 8192) {
  const { system, messages: converted } = toClaudeMessages(messages);
  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: converted,
      stream: true
    })
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    // Some models (mainly older/lower-tier ones) cap output well below
    // 8192 and reject the request outright rather than clamping it —
    // retry once with a conservative value instead of failing the whole
    // message over a fixed constant that doesn't fit every model.
    if (res.status === 400 && maxTokens > 4096 && /max_tokens/i.test(text)) {
      yield* streamClaude(apiKey, model, messages, 4096);
      return;
    }
    throw new Error(`Claude error ${res.status}: ${text.slice(0, 500)}`);
  }
  for await (const { event, data } of sseLines(res)) {
    if (event === 'content_block_delta') {
      try {
        const parsed = JSON.parse(data);
        if (parsed.delta && parsed.delta.type === 'text_delta') {
          yield parsed.delta.text;
        }
      } catch (e) {
        // ignore malformed chunk
      }
    } else if (event === 'error') {
      let message = 'Claude error';
      try {
        const parsed = JSON.parse(data);
        message = `Claude error: ${parsed.error && parsed.error.message}`;
      } catch (e) { /* keep generic message */ }
      throw new Error(message);
    }
  }
}

// Unified entry point: provider is 'openai' | 'claude'. `messages` items are
// { role, content } where content may be a string, a normalized parts
// array, or an OpenAI-style vision content array — see normalizeContent.
function streamChat(provider, apiKey, model, messages) {
  if (provider === 'openai') return streamOpenAI(apiKey, model, messages);
  if (provider === 'claude') return streamClaude(apiKey, model, messages);
  throw new Error('Unknown provider');
}

// ---------------- image generation / editing (gpt-image-*) ----------------
// These are a different OpenAI API family (POST /v1/images/*, not chat
// completions) — no streaming, and edits are multipart rather than JSON.
// Both return a normalized [{ mediaType, data (base64) }] regardless of
// how many images came back.

async function generateImage(apiKey, model, prompt) {
  const res = await fetch(`${OPENAI_BASE_URL}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, output_format: 'png' })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI image error ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return (data.data || [])
    .filter((d) => d.b64_json)
    .map((d) => ({ mediaType: 'image/png', data: d.b64_json }));
}

// images: [{ mediaType, data (base64) }] — the reference image(s) to edit.
async function editImage(apiKey, model, prompt, images) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  for (const img of images) {
    const buf = Buffer.from(img.data, 'base64');
    const ext = (img.mediaType || 'image/png').split('/')[1] || 'png';
    form.append('image[]', new Blob([buf], { type: img.mediaType || 'image/png' }), `image.${ext}`);
  }
  const res = await fetch(`${OPENAI_BASE_URL}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` }, // no Content-Type — fetch sets the multipart boundary for FormData
    body: form
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI image edit error ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return (data.data || [])
    .filter((d) => d.b64_json)
    .map((d) => ({ mediaType: 'image/png', data: d.b64_json }));
}

// One entry point: edits if reference images were supplied, else generates
// from the prompt alone.
function generateOrEditImage(apiKey, model, prompt, images) {
  if (images && images.length) return editImage(apiKey, model, prompt, images);
  return generateImage(apiKey, model, prompt);
}

module.exports = {
  streamChat,
  providerForModel,
  fetchOpenAIModels,
  fetchClaudeModels,
  generateOrEditImage
};
