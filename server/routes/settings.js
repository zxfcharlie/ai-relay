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
      siteName: db.settings.siteName,
      imageRetentionDays: db.settings.imageRetentionDays
    },
    users: db.users.map(publicUser)
  });
});

router.put('/admin', requireAuth, requireAdmin, (req, res) => {
  const { globalOpenAIKey, globalClaudeKey, allowRegistration, siteName, imageRetentionDays } = req.body || {};
  const db = getDB();
  if (typeof globalOpenAIKey === 'string') db.settings.globalOpenAIKey = globalOpenAIKey.trim();
  if (typeof globalClaudeKey === 'string') db.settings.globalClaudeKey = globalClaudeKey.trim();
  if (typeof allowRegistration === 'boolean') db.settings.allowRegistration = allowRegistration;
  if (typeof siteName === 'string' && siteName.trim()) db.settings.siteName = siteName.trim();
  if (imageRetentionDays !== undefined) {
    const n = Number(imageRetentionDays);
    if (Number.isFinite(n) && n >= 0) db.settings.imageRetentionDays = Math.floor(n);
  }
  save();
  res.json({ ok: true });
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

module.exports = router;
