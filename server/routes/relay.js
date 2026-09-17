const express = require('express');
const { getDB } = require('../db');
const { streamChat, providerForModel, fetchOpenAIModels, fetchClaudeModels } = require('../services/providers');
const { resolveApiKey } = require('../services/keys');

const router = express.Router();

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
  if (!key) return res.status(401).json({ error: { message: 'Missing Authorization: Bearer <relay key>.' } });
  const db = getDB();
  const user = db.users.find((u) => u.relayApiKey === key);
  if (!user) return res.status(401).json({ error: { message: 'Invalid relay API key.' } });
  req.relayUser = user;
  next();
}

router.get('/models', relayAuth, async (req, res) => {
  const openaiKey = resolveApiKey(req.relayUser, 'openai');
  const claudeKey = resolveApiKey(req.relayUser, 'claude');
  const [openaiModels, claudeModels] = await Promise.all([
    openaiKey ? fetchOpenAIModels(openaiKey).catch(() => []) : [],
    claudeKey ? fetchClaudeModels(claudeKey).catch(() => []) : []
  ]);
  const data = [...openaiModels, ...claudeModels].map((m) => ({ id: m.id, object: 'model', owned_by: m.provider }));
  res.json({ object: 'list', data });
});

// POST /v1/chat/completions — OpenAI wire format in, OpenAI wire format out,
// regardless of whether the request is actually served by OpenAI or Claude.
// Vision content (OpenAI-style image_url with a data: URL) is accepted and
// translated automatically for whichever provider ends up serving it.
// An explicit "provider": "openai" | "claude" in the body overrides the
// default name-based routing, for custom / fine-tuned model names.
router.post('/chat/completions', relayAuth, async (req, res) => {
  const { model, messages, stream, provider: providerOverride } = req.body || {};
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'Request must include "model" and "messages".' } });
  }
  const provider = (providerOverride === 'openai' || providerOverride === 'claude')
    ? providerOverride
    : providerForModel(model);
  if (!provider) {
    return res.status(400).json({
      error: { message: `Unrecognized model "${model}". Pass an explicit "provider": "openai" | "claude" to override.` }
    });
  }
  const apiKey = resolveApiKey(req.relayUser, provider);
  if (!apiKey) {
    return res.status(400).json({
      error: { message: `No ${provider === 'openai' ? 'OpenAI' : 'Claude'} API key is configured for this account.` }
    });
  }

  const created = Math.floor(Date.now() / 1000);
  const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 12);

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();
    try {
      for await (const delta of streamChat(provider, apiKey, model, messages)) {
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
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  try {
    let full = '';
    for await (const delta of streamChat(provider, apiKey, model, messages)) {
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
    res.status(502).json({ error: { message: err.message } });
  }
});

module.exports = router;
