const { getDB, save } = require('../db');
const { deleteImageFile, listImageFiles } = require('./images');

function purgeImagesForMessage(m) {
  if (!m.images || !m.images.length) return;
  for (const img of m.images) deleteImageFile(img.filename);
  m.images = [];
}

// Deletes image files older than the configured retention window (clearing
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
      if (m.images && m.images.length && new Date(m.createdAt).getTime() < cutoff) {
        purgeImagesForMessage(m);
        changed = true;
      }
    }
  }
  if (changed) save();

  const referenced = new Set();
  for (const m of db.messages) {
    for (const img of m.images || []) referenced.add(img.filename);
  }
  for (const file of listImageFiles()) {
    if (!referenced.has(file)) deleteImageFile(file);
  }
}

function startCleanupSchedule() {
  runCleanup();
  setInterval(runCleanup, 6 * 60 * 60 * 1000).unref();
}

module.exports = { runCleanup, startCleanupSchedule, purgeImagesForMessage };
