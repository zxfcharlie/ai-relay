const express = require('express');
const path = require('path');
const { getDB } = require('../db');
const { requireAuth } = require('../auth');
const { IMAGES_DIR } = require('../services/images');

const router = express.Router();

const FILENAME_RE = /^[A-Za-z0-9_-]+\.[a-z0-9]+$/;

router.get('/:filename', requireAuth, (req, res) => {
  const { filename } = req.params;
  if (!FILENAME_RE.test(filename)) return res.status(400).end();

  const db = getDB();
  const msg = db.messages.find((m) => (m.images || []).some((img) => img.filename === filename));
  if (!msg) return res.status(404).end();
  const convo = db.conversations.find((c) => c.id === msg.conversationId);
  if (!convo || convo.userId !== req.user.id) return res.status(404).end();

  const img = msg.images.find((i) => i.filename === filename);
  res.setHeader('Content-Type', img.mediaType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(IMAGES_DIR, filename), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

module.exports = router;
