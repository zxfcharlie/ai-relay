const express = require('express');
const multer = require('multer');
const { getDB } = require('../db');
const {
  streamChat, providerForModel, resolveProvider,
  fetchOpenAIModels, fetchClaudeModels, fetchCustomProviderModels,
  generateOrEditImage
} = require('../services/providers');
const { resolveApiKey } = require('../services/keys');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 16 } });

// OpenAI's own error responses always carry a "type" alongside "message" —
// matching that shape means strict SDK error handlers (which sometimes
// branch on err.type) work against this relay too.
function errJson(message, type) {
  return { error: { message, type: type || 'invalid_request_error' } };
}

// CORS is safe to open wide here: auth is a bearer relay key in the header,
// never a cookie, so there is no ambient-credential risk in allowing any
// origin to call this from a browser-based tool too.
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Any external app (a script, another server, an OpenAI-SDK-compatible
// client pointed at this base URL) authenticates with a user's personal
// relay key instead of a real OpenAI/Claude key. That lets one server act
// as a single, revocable point of remote access to both providers.
function relayAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!key) return res.status(401).json(errJson('Missing Authorization: Bearer <relay key>.', 'authentication_error'));
  const db = getDB();
  const user = db.users.find((u) => u.relayApiKey === key);
  if (!user) return res.status(401).json(errJson('Invalid relay API key.', 'authentication_error'));
  if (user.status !== 'active') return res.status(403).json(errJson('This account is pending approval or has been suspended.', 'authentication_error'));
  req.relayUser = user;
  next();
}

router.get('/models', relayAuth, async (req, res) => {
  const db = getDB();
  const openaiKey = resolveApiKey(req.relayUser, 'openai');
  const claudeKey = resolveApiKey(req.relayUser, 'claude');
  const customProviders = (db.settings.customProviders || []).filter((p) => p.enabled && p.apiKey);
  const [openaiModels, claudeModels, ...customResults] = await Promise.all([
    openaiKey ? fetchOpenAIModels(openaiKey).catch(() => []) : [],
    claudeKey ? fetchClaudeModels(claudeKey).catch(() => []) : [],
    ...customProviders.map((p) => fetchCustomProviderModels(p).catch(() => []))
  ]);
  // Extra fields (category/tier/description) beyond the standard OpenAI
  // model object — well-behaved OpenAI-compatible clients ignore unknown
  // fields, and it lets a caller build its own categorized/searchable
  // picker the same way this app's own UI does.
  const data = [...openaiModels, ...claudeModels, ...customResults.flat()].map((m) => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: m.provider,
    category: m.category,
    tier: m.tier,
    description: m.description
  }));
  res.json({ object: 'list', data });
});

// POST /v1/chat/completions — OpenAI wire format in, OpenAI wire format out,
// regardless of whether the request is actually served by OpenAI, Claude,
// or an admin-added third-party provider. Vision content (OpenAI-style
// image_url with a data: URL) is accepted and translated automatically for
// whichever provider ends up serving it. An explicit "provider" in the
// body — "openai", "claude", or a configured custom provider's slug —
// overrides the default name-based routing, for custom / fine-tuned model
// names or third-party model catalogs this app can't guess the origin of.
router.post('/chat/completions', relayAuth, async (req, res) => {
  const db = getDB();
  const { model, messages, stream, provider: providerOverride } = req.body || {};
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json(errJson('Request must include "model" and "messages".'));
  }
  const providerSlug = providerOverride || providerForModel(model);
  const providerInfo = providerSlug ? resolveProvider(db, providerSlug) : null;
  if (!providerInfo) {
    return res.status(400).json(errJson(`Unrecognized model "${model}". Pass an explicit "provider" (e.g. "openai", "claude", or a configured third-party provider's slug) to override.`));
  }
  const apiKey = resolveApiKey(req.relayUser, providerInfo.slug);
  if (!apiKey) {
    return res.status(400).json(errJson(`No API key is configured for provider "${providerInfo.label}".`));
  }

  const created = Math.floor(Date.now() / 1000);
  const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 12);

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();
    try {
      // Real OpenAI sends an initial role-only chunk before content deltas;
      // some stricter OpenAI-compatible client libraries expect it.
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      })}\n\n`);
      for await (const delta of streamChat(providerInfo, apiKey, model, messages)) {
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      const finalChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify(errJson(err.message, 'api_error'))}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  try {
    let full = '';
    for await (const delta of streamChat(providerInfo, apiKey, model, messages)) {
      full += delta;
    }
    res.json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content: full }, finish_reason: 'stop' }
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  } catch (err) {
    res.status(502).json(errJson(err.message, 'api_error'));
  }
});

// POST /v1/images/generations — OpenAI-compatible text-to-image. JSON body:
// { model, prompt, size?, quality?, background?, output_format?, n? }.
// Response shape matches OpenAI's Images API (data: [{ b64_json }]) so the
// official SDK's client.images.generate() works unmodified against this
// base URL, cost-affecting params included.
router.post('/images/generations', relayAuth, async (req, res) => {
  const { model, prompt, size, quality, background, output_format: outputFormat, n } = req.body || {};
  if (!model || !prompt) {
    return res.status(400).json(errJson('Request must include "model" and "prompt".'));
  }
  const apiKey = resolveApiKey(req.relayUser, 'openai');
  if (!apiKey) {
    return res.status(400).json(errJson('No OpenAI API key is configured for this account.'));
  }
  try {
    const images = await generateOrEditImage(apiKey, model, prompt, [], { size, quality, background, outputFormat, n });
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: images.map((img) => ({ b64_json: img.data }))
    });
  } catch (err) {
    res.status(502).json(errJson(err.message, 'api_error'));
  }
});

// POST /v1/images/edits — OpenAI-compatible image editing. multipart/form-
// data: model, prompt, size?, quality?, background?, output_format?, n?,
// and one or more reference images under "image" or "image[]" (matches
// client.images.edit() from the official SDK).
router.post('/images/edits', relayAuth, upload.fields([{ name: 'image' }, { name: 'image[]' }]), async (req, res) => {
  const { model, prompt, size, quality, background, output_format: outputFormat, n } = req.body || {};
  const files = [...((req.files && req.files.image) || []), ...((req.files && req.files['image[]']) || [])];
  if (!model || !prompt) {
    return res.status(400).json(errJson('Request must include "model" and "prompt".'));
  }
  if (!files.length) {
    return res.status(400).json(errJson('Request must include at least one "image" file.'));
  }
  const apiKey = resolveApiKey(req.relayUser, 'openai');
  if (!apiKey) {
    return res.status(400).json(errJson('No OpenAI API key is configured for this account.'));
  }
  try {
    const refImages = files.map((f) => ({ mediaType: f.mimetype || 'image/png', data: f.buffer.toString('base64') }));
    const images = await generateOrEditImage(apiKey, model, prompt, refImages, { size, quality, background, outputFormat, n });
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: images.map((img) => ({ b64_json: img.data }))
    });
  } catch (err) {
    res.status(502).json(errJson(err.message, 'api_error'));
  }
});

module.exports = router;
