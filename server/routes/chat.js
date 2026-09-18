const express = require('express');
const { nanoid } = require('nanoid');
const { getDB, save } = require('../db');
const { requireAuth } = require('../auth');
const { streamChat, fetchOpenAIModels, fetchClaudeModels, generateOrEditImage, sanitizeImageOptions } = require('../services/providers');
const { resolveApiKey } = require('../services/keys');
const { saveImage, readImageBase64, deleteImageFile } = require('../services/images');
const { purgeImagesForMessage } = require('../services/cleanup');
const { recordUsage } = require('../services/usage');

const router = express.Router();

const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;

function parseImageDataUrl(url) {
  if (typeof url !== 'string') return null;
  const m = DATA_URL_RE.exec(url);
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

// Every model available for this account, across whichever provider(s) it
// has a key for — fetched live from OpenAI / Anthropic rather than a fixed
// list, so new models show up automatically.
router.get('/models', requireAuth, async (req, res) => {
  const openaiKey = resolveApiKey(req.user, 'openai');
  const claudeKey = resolveApiKey(req.user, 'claude');

  const [openaiModels, claudeModels] = await Promise.all([
    openaiKey ? fetchOpenAIModels(openaiKey).catch((e) => ({ error: e.message })) : [],
    claudeKey ? fetchClaudeModels(claudeKey).catch((e) => ({ error: e.message })) : []
  ]);

  const errors = {};
  const models = [];
  if (Array.isArray(openaiModels)) models.push(...openaiModels);
  else if (openaiModels && openaiModels.error) errors.openai = openaiModels.error;
  if (Array.isArray(claudeModels)) models.push(...claudeModels);
  else if (claudeModels && claudeModels.error) errors.claude = claudeModels.error;

  res.json({ models, hasOpenAIKey: !!openaiKey, hasClaudeKey: !!claudeKey, errors });
});

router.get('/conversations', requireAuth, (req, res) => {
  const db = getDB();
  const list = db.conversations
    .filter((c) => c.userId === req.user.id)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map((c) => ({ id: c.id, title: c.title, model: c.model, provider: c.provider, category: c.category, updatedAt: c.updatedAt }));
  res.json({ conversations: list });
});

router.post('/conversations', requireAuth, (req, res) => {
  const { model, provider, category, imageOptions } = req.body || {};
  if (!model || !provider) return res.status(400).json({ error: 'model and provider are required.' });
  const db = getDB();
  const convo = {
    id: nanoid(),
    userId: req.user.id,
    title: 'New chat',
    model,
    provider,
    category: category === 'image' ? 'image' : 'chat',
    imageOptions: sanitizeImageOptions(imageOptions),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.conversations.push(convo);
  save();
  res.json({ conversation: convo });
});

router.get('/conversations/:id', requireAuth, (req, res) => {
  const db = getDB();
  const convo = db.conversations.find((c) => c.id === req.params.id && c.userId === req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found.' });
  const messages = db.messages
    .filter((m) => m.conversationId === convo.id)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      // Images are served from disk by reference, never inlined as base64
      // here — keeps this payload (and db.json) small.
      images: (m.images || []).map((img) => ({ filename: img.filename, mediaType: img.mediaType, url: `/api/images/${img.filename}` })),
      createdAt: m.createdAt
    }));
  res.json({ conversation: convo, messages });
});

router.delete('/conversations/:id', requireAuth, (req, res) => {
  const db = getDB();
  const convo = db.conversations.find((c) => c.id === req.params.id && c.userId === req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found.' });
  const messagesToRemove = db.messages.filter((m) => m.conversationId === convo.id);
  for (const m of messagesToRemove) for (const img of m.images || []) deleteImageFile(img.filename);
  db.conversations = db.conversations.filter((c) => c.id !== convo.id);
  db.messages = db.messages.filter((m) => m.conversationId !== convo.id);
  save();
  res.json({ ok: true });
});

router.put('/conversations/:id', requireAuth, (req, res) => {
  const { title, model, provider, category, imageOptions } = req.body || {};
  const db = getDB();
  const convo = db.conversations.find((c) => c.id === req.params.id && c.userId === req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found.' });
  if (typeof title === 'string' && title.trim()) convo.title = title.trim().slice(0, 80);
  if (typeof model === 'string') convo.model = model;
  if (typeof provider === 'string') convo.provider = provider;
  if (category === 'image' || category === 'chat') convo.category = category;
  if (imageOptions && typeof imageOptions === 'object') {
    convo.imageOptions = { ...(convo.imageOptions || {}), ...sanitizeImageOptions(imageOptions) };
  }
  save();
  res.json({ conversation: convo });
});

// A stored message's content, folded back into the { text, images[] } shape
// the provider layer expects. Image bytes live on disk, not in db.json.
function buildContent(m) {
  if (!m.images || !m.images.length) return m.content;
  const parts = [];
  if (m.content) parts.push({ type: 'text', text: m.content });
  for (const img of m.images) {
    const data = readImageBase64(img.filename);
    if (data) parts.push({ type: 'image', mediaType: img.mediaType, data });
  }
  return parts;
}

// Streams the assistant's reply back as SSE while it saves both the user
// message (text + any attached images) and the growing assistant message.
router.post('/conversations/:id/messages', requireAuth, async (req, res) => {
  const { content, images } = req.body || {};
  const text = (content || '').trim();
  const rawImages = Array.isArray(images) ? images.slice(0, 6) : [];
  const parsedImages = rawImages.map(parseImageDataUrl).filter(Boolean);
  if (!text && !parsedImages.length) return res.status(400).json({ error: 'Message is empty.' });

  const db = getDB();
  const convo = db.conversations.find((c) => c.id === req.params.id && c.userId === req.user.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found.' });

  const provider = convo.provider;
  const apiKey = resolveApiKey(req.user, provider);
  if (!apiKey) {
    return res.status(400).json({
      error: `No API key configured for ${provider === 'openai' ? 'OpenAI' : 'Claude'}. Add one in Settings.`
    });
  }

  // Written to disk once (not into db.json) so history can still show a
  // preview/download link; runCleanup() (or the immediate purge below when
  // retention is 0) is what keeps this from accumulating forever.
  const savedImages = parsedImages.map((img) => saveImage(img.mediaType, img.data));

  const userMsg = {
    id: nanoid(),
    conversationId: convo.id,
    role: 'user',
    content: text,
    images: savedImages,
    createdAt: new Date().toISOString()
  };
  db.messages.push(userMsg);
  if (convo.title === 'New chat') {
    convo.title = (text || (savedImages.length ? '[图片]' : '新对话')).slice(0, 60);
  }
  convo.updatedAt = new Date().toISOString();
  save();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  // Image-generation models are a different OpenAI API family entirely
  // (POST /v1/images/*, not chat completions) — no incremental text, just
  // a placeholder while it works and then the finished image(s).
  if (convo.category === 'image') {
    res.write(`data: ${JSON.stringify({ delta: '🎨 正在生成图片…' })}\n\n`);
    try {
      const refImages = savedImages
        .map((img) => ({ mediaType: img.mediaType, data: readImageBase64(img.filename) }))
        .filter((i) => i.data);
      const results = await generateOrEditImage(apiKey, convo.model, text || '编辑这张图片', refImages, convo.imageOptions);
      if (!results.length) throw new Error('模型没有返回图片。');

      if (Number(db.settings.imageRetentionDays) === 0) purgeImagesForMessage(userMsg);
      const outImages = results.map((img) => saveImage(img.mediaType, img.data));
      const assistantMsg = {
        id: nanoid(),
        conversationId: convo.id,
        role: 'assistant',
        content: '',
        images: outImages,
        createdAt: new Date().toISOString()
      };
      db.messages.push(assistantMsg);
      convo.updatedAt = new Date().toISOString();
      save();

      const imagesPayload = outImages.map((img) => ({ filename: img.filename, mediaType: img.mediaType, url: `/api/images/${img.filename}` }));
      res.write(`data: ${JSON.stringify({ done: true, messageId: assistantMsg.id, images: imagesPayload })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    } catch (err) {
      if (Number(db.settings.imageRetentionDays) === 0) purgeImagesForMessage(userMsg);
      save();
      res.write(`data: ${JSON.stringify({ error: err.message || 'Upstream error.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
  }

  const history = db.messages
    .filter((m) => m.conversationId === convo.id)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map((m) => ({ role: m.role, content: buildContent(m) }));

  let full = '';
  const usage = {};
  try {
    for await (const delta of streamChat(provider, apiKey, convo.model, history, usage)) {
      full += delta;
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
  } catch (err) {
    // The model has already been sent whatever images it could reach;
    // honor a "don't keep them" (0-day) setting even on failure.
    if (Number(db.settings.imageRetentionDays) === 0) purgeImagesForMessage(userMsg);
    recordUsage(db, { userId: req.user.id, conversationId: convo.id, provider, model: convo.model, ...usage });
    save();
    res.write(`data: ${JSON.stringify({ error: err.message || 'Upstream error.' })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  if (Number(db.settings.imageRetentionDays) === 0) purgeImagesForMessage(userMsg);
  recordUsage(db, { userId: req.user.id, conversationId: convo.id, provider, model: convo.model, ...usage });

  const assistantMsg = {
    id: nanoid(),
    conversationId: convo.id,
    role: 'assistant',
    content: full,
    images: [],
    createdAt: new Date().toISOString()
  };
  db.messages.push(assistantMsg);
  convo.updatedAt = new Date().toISOString();
  save();

  res.write(`data: ${JSON.stringify({ done: true, messageId: assistantMsg.id })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});

module.exports = router;
