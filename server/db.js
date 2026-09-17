const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_DB = {
  users: [],
  conversations: [],
  messages: [],
  settings: {
    globalOpenAIKey: '',
    globalClaudeKey: '',
    allowRegistration: true,
    siteName: 'Relay',
    // How long an uploaded chat image stays available for re-viewing /
    // download before it's purged. 0 = delete right after the model has
    // used it (no later preview/download, minimum server footprint).
    imageRetentionDays: 3
  }
};

function load() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
  }
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    // backfill any missing top-level keys from default (safe upgrades)
    return { ...DEFAULT_DB, ...parsed, settings: { ...DEFAULT_DB.settings, ...(parsed.settings || {}) } };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

let db = load();
let writeQueued = false;

function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setImmediate(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    writeQueued = false;
  });
}

function getDB() {
  return db;
}

function save() {
  persist();
}

function getSecret() {
  if (fs.existsSync(SECRET_FILE)) {
    return fs.readFileSync(SECRET_FILE, 'utf-8').trim();
  }
  const secret = require('crypto').randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret);
  return secret;
}

module.exports = { getDB, save, getSecret, DATA_DIR };
