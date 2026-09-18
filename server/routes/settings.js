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
      pricing: db.settings.pricing || {}
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
