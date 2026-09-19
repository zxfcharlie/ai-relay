const express = require('express');
const { nanoid } = require('nanoid');
const { getDB, save } = require('../db');
const { requireAuth, requireAdmin, publicUser } = require('../auth');
const { deleteImageFile } = require('../services/images');

const router = express.Router();

// ---- current user's own profile ----

router.get('/profile', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.put('/profile', requireAuth, (req, res) => {
  const { personalOpenAIKey, personalClaudeKey } = req.body || {};
  const db = getDB();
  const user = db.users.find((u) => u.id === req.user.id);
  if (typeof personalOpenAIKey === 'string') user.personalOpenAIKey = personalOpenAIKey.trim();
  if (typeof personalClaudeKey === 'string') user.personalClaudeKey = personalClaudeKey.trim();
  save();
  res.json({ user: publicUser(user) });
});

router.post('/profile/regenerate-relay-key', requireAuth, (req, res) => {
  const db = getDB();
  const user = db.users.find((u) => u.id === req.user.id);
  user.relayApiKey = 'rk-' + nanoid(40);
  save();
  res.json({ user: publicUser(user) });
});

// ---- admin: global provider keys + user management ----

router.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const db = getDB();
  res.json({
    settings: {
      hasGlobalOpenAIKey: !!db.settings.globalOpenAIKey,
      hasGlobalClaudeKey: !!db.settings.globalClaudeKey,
      allowRegistration: db.settings.allowRegistration,
      requireApproval: db.settings.requireApproval,
      siteName: db.settings.siteName,
      imageRetentionDays: db.settings.imageRetentionDays,
      monthlyBudgetUSD: db.settings.monthlyBudgetUSD,
      pricing: db.settings.pricing || {},
      // Never send the raw key back to the browser once it's saved — only
      // whether one is set, same treatment as the built-in global keys.
      customProviders: (db.settings.customProviders || []).map((p) => ({
        id: p.id, slug: p.slug, label: p.label, type: p.type, baseURL: p.baseURL,
        enabled: p.enabled, hasApiKey: !!p.apiKey
      }))
    },
    users: db.users.map(publicUser)
  });
});

router.put('/admin', requireAuth, requireAdmin, (req, res) => {
  const { globalOpenAIKey, globalClaudeKey, allowRegistration, requireApproval, siteName, imageRetentionDays, monthlyBudgetUSD } = req.body || {};
  const db = getDB();
  if (typeof globalOpenAIKey === 'string') db.settings.globalOpenAIKey = globalOpenAIKey.trim();
  if (typeof globalClaudeKey === 'string') db.settings.globalClaudeKey = globalClaudeKey.trim();
  if (typeof allowRegistration === 'boolean') db.settings.allowRegistration = allowRegistration;
  if (typeof requireApproval === 'boolean') db.settings.requireApproval = requireApproval;
  if (typeof siteName === 'string' && siteName.trim()) db.settings.siteName = siteName.trim();
  if (imageRetentionDays !== undefined) {
    const n = Number(imageRetentionDays);
    if (Number.isFinite(n) && n >= 0) db.settings.imageRetentionDays = Math.floor(n);
  }
  if (monthlyBudgetUSD !== undefined) {
    const n = Number(monthlyBudgetUSD);
    db.settings.monthlyBudgetUSD = (monthlyBudgetUSD === null || monthlyBudgetUSD === '' || !Number.isFinite(n) || n <= 0) ? null : n;
  }
  save();
  res.json({ ok: true });
});

// Per-model $ / 1M tokens, admin-entered (never guessed by this app —
// provider pricing changes too often to hardcode safely). Replaces the
// whole map; the client always sends its full edited table.
router.put('/admin/pricing', requireAuth, requireAdmin, (req, res) => {
  const { pricing } = req.body || {};
  if (!pricing || typeof pricing !== 'object') return res.status(400).json({ error: 'pricing object is required.' });
  const db = getDB();
  const clean = {};
  for (const [modelId, rate] of Object.entries(pricing)) {
    if (!rate || typeof rate !== 'object') continue;
    const inputPer1M = Number(rate.inputPer1M);
    const outputPer1M = Number(rate.outputPer1M);
    if (!Number.isFinite(inputPer1M) && !Number.isFinite(outputPer1M)) continue;
    clean[modelId] = {
      inputPer1M: Number.isFinite(inputPer1M) ? inputPer1M : 0,
      outputPer1M: Number.isFinite(outputPer1M) ? outputPer1M : 0
    };
  }
  db.settings.pricing = clean;
  save();
  res.json({ pricing: clean });
});

// ---- admin: custom (third-party) providers ----

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

router.post('/admin/providers', requireAuth, requireAdmin, (req, res) => {
  const { slug, label, type, baseURL, apiKey } = req.body || {};
  if (!slug || !SLUG_RE.test(slug)) {
    return res.status(400).json({ error: '标识需为小写字母开头、仅含小写字母/数字/连字符（如 toapis）。' });
  }
  if (slug === 'openai' || slug === 'claude') {
    return res.status(400).json({ error: '"openai" 和 "claude" 是内置标识，不能重复使用。' });
  }
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required.' });
  if (type !== 'openai-compatible' && type !== 'anthropic-compatible') {
    return res.status(400).json({ error: 'type must be "openai-compatible" or "anthropic-compatible".' });
  }
  if (!baseURL || !/^https?:\/\//.test(baseURL)) {
    return res.status(400).json({ error: 'baseURL must be a full http(s) URL.' });
  }
  const db = getDB();
  db.settings.customProviders = db.settings.customProviders || [];
  if (db.settings.customProviders.some((p) => p.slug === slug)) {
    return res.status(409).json({ error: `标识 "${slug}" 已经被使用。` });
  }
  const provider = {
    id: nanoid(),
    slug,
    label: label.trim(),
    type,
    baseURL: baseURL.trim().replace(/\/$/, ''),
    apiKey: (apiKey || '').trim(),
    enabled: true
  };
  db.settings.customProviders.push(provider);
  save();
  res.json({ provider: { ...provider, apiKey: undefined, hasApiKey: !!provider.apiKey } });
});

router.put('/admin/providers/:id', requireAuth, requireAdmin, (req, res) => {
  const { label, baseURL, apiKey, enabled } = req.body || {};
  const db = getDB();
  const provider = (db.settings.customProviders || []).find((p) => p.id === req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found.' });
  if (typeof label === 'string' && label.trim()) provider.label = label.trim();
  if (typeof baseURL === 'string' && /^https?:\/\//.test(baseURL)) provider.baseURL = baseURL.trim().replace(/\/$/, '');
  if (typeof apiKey === 'string' && apiKey.trim()) provider.apiKey = apiKey.trim();
  if (typeof enabled === 'boolean') provider.enabled = enabled;
  save();
  res.json({ provider: { ...provider, apiKey: undefined, hasApiKey: !!provider.apiKey } });
});

router.delete('/admin/providers/:id', requireAuth, requireAdmin, (req, res) => {
  const db = getDB();
  const before = (db.settings.customProviders || []).length;
  db.settings.customProviders = (db.settings.customProviders || []).filter((p) => p.id !== req.params.id);
  save();
  res.json({ removed: before - db.settings.customProviders.length });
});

router.delete('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const db = getDB();
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account." });
  }
  const before = db.users.length;
  db.users = db.users.filter((u) => u.id !== req.params.id);
  db.conversations = db.conversations.filter((c) => c.userId !== req.params.id);
  db.messages = db.messages.filter((m) => {
    const convo = db.conversations.find((c) => c.id === m.conversationId);
    if (!convo) {
      for (const img of m.images || []) deleteImageFile(img.filename);
      for (const f of m.files || []) deleteImageFile(f.filename);
      return false;
    }
    return true;
  });
  db.usage = db.usage.filter((u) => u.userId !== req.params.id);
  save();
  res.json({ removed: before - db.users.length });
});

router.put('/admin/users/:id/admin', requireAuth, requireAdmin, (req, res) => {
  const { isAdmin } = req.body || {};
  const db = getDB();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const adminCount = db.users.filter((u) => u.isAdmin).length;
  if (user.isAdmin && !isAdmin && adminCount <= 1) {
    return res.status(400).json({ error: 'At least one admin account must remain.' });
  }
  user.isAdmin = !!isAdmin;
  save();
  res.json({ user: publicUser(user) });
});

// Covers both "approve a pending signup" and "suspend an existing user" —
// same toggle, just the starting state differs.
router.put('/admin/users/:id/status', requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (status !== 'active' && status !== 'pending') {
    return res.status(400).json({ error: 'status must be "active" or "pending".' });
  }
  const db = getDB();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.id === req.user.id && status === 'pending') {
    return res.status(400).json({ error: "You can't suspend your own account." });
  }
  user.status = status;
  save();
  res.json({ user: publicUser(user) });
});

module.exports = router;
