const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');
const { DATA_DIR } = require('../db');

const IMAGES_DIR = path.join(DATA_DIR, 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

// Writes a base64-decoded image to disk once and returns a small reference
// { filename, mediaType } to store in db.json instead of the raw bytes —
// keeps the JSON store small and avoids rewriting every attached image on
// every unrelated save().
function saveImage(mediaType, base64Data) {
  const ext = EXT_BY_MIME[mediaType] || 'bin';
  const filename = `${nanoid()}.${ext}`;
  fs.writeFileSync(path.join(IMAGES_DIR, filename), Buffer.from(base64Data, 'base64'));
  return { filename, mediaType };
}

function readImageBase64(filename) {
  const p = path.join(IMAGES_DIR, filename);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p).toString('base64');
}

function deleteImageFile(filename) {
  if (!filename) return;
  const p = path.join(IMAGES_DIR, filename);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) { /* best effort */ }
}

function listImageFiles() {
  try {
    return fs.readdirSync(IMAGES_DIR);
  } catch (e) {
    return [];
  }
}

module.exports = { saveImage, readImageBase64, deleteImageFile, listImageFiles, IMAGES_DIR };
