const { getDB, save } = require('../db');
const { deleteImageFile, listImageFiles } = require('./images');

// Covers both m.images and m.files (PDFs) — same on-disk storage, same
// retention rules, just a different array on the message.
function purgeAttachmentsForMessage(m) {
  let changed = false;
  if (m.images && m.images.length) {
    for (const img of m.images) deleteImageFile(img.filename);
    m.images = [];
    changed = true;
  }
  if (m.files && m.files.length) {
    for (const f of m.files) deleteImageFile(f.filename);
    m.files = [];
    changed = true;
  }
  return changed;
}

// Deletes attachments older than the configured retention window (clearing
// the reference on their message, text stays), then sweeps any leftover
// file on disk that no message points to any more (covers conversation /
// account deletion and any other edge case).
function runCleanup() {
  const db = getDB();
  const days = Number(db.settings.imageRetentionDays);
  let changed = false;

  if (Number.isFinite(days) && days > 0) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const m of db.messages) {
      const hasAttachments = (m.images && m.images.length) || (m.files && m.files.length);
      if (hasAttachments && new Date(m.createdAt).getTime() < cutoff) {
        if (purgeAttachmentsForMessage(m)) changed = true;
      }
    }
  }
  if (changed) save();

  const referenced = new Set();
  for (const m of db.messages) {
    for (const img of m.images || []) referenced.add(img.filename);
    for (const f of m.files || []) referenced.add(f.filename);
  }
  for (const file of listImageFiles()) {
    if (!referenced.has(file)) deleteImageFile(file);
  }
}

function startCleanupSchedule() {
  runCleanup();
  setInterval(runCleanup, 6 * 60 * 60 * 1000).unref();
}

module.exports = { runCleanup, startCleanupSchedule, purgeImagesForMessage: purgeAttachmentsForMessage };
