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
  usage: [], // token/cost accounting — see services/usage.js
  settings: {
    globalOpenAIKey: '',
    globalClaudeKey: '',
    allowRegistration: true,
    // New signups sit as 'pending' until an admin approves them, rather
    // than being usable immediately.
    requireApproval: true,
    siteName: 'Relay',
    // How long an uploaded chat image stays available for re-viewing /
    // download before it's purged. 0 = delete right after the model has
    // used it (no later preview/download, minimum server footprint).
    imageRetentionDays: 3,
    // $ per 1M tokens per model, admin-entered (e.g. { "gpt-5.1": { inputPer1M: 1.25, outputPer1M: 10 } }).
    // Deliberately ships empty rather than with baked-in numbers — provider
    // pricing changes often enough that a hardcoded table would go stale
    // and misreport real cost.
    pricing: {},
    // Optional team-wide monthly spend target shown as a progress bar on
    // the usage dashboard. null/0 = not tracked.
    monthlyBudgetUSD: null,
    // Admin-added third-party model providers (e.g. an OpenAI-compatible
    // aggregator) — each gets its own slug used as the `provider` value on
    // conversations/messages, alongside the built-in 'openai' and 'claude'.
    // [{ id, slug, label, type: 'openai-compatible'|'anthropic-compatible', baseURL, apiKey, enabled }]
    customProviders: []
  }
};

function load() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
  }
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  let db;
  try {
    const parsed = JSON.parse(raw);
    // backfill any missing top-level keys from default (safe upgrades)
    db = { ...DEFAULT_DB, ...parsed, settings: { ...DEFAULT_DB.settings, ...(parsed.settings || {}) } };
  } catch (e) {
    db = JSON.parse(JSON.stringify(DEFAULT_DB));
  }

  // Per-record migration: accounts created before the approval-status
  // field existed have no `status` at all. Treat "missing" as "already
  // active" (they were already using the app) rather than locking out
  // every existing account — including the admin — the moment this field
  // was introduced. Written back immediately so it only runs once.
  let migrated = false;
  for (const u of db.users) {
    if (!u.status) {
      u.status = 'active';
      migrated = true;
    }
  }
  if (migrated) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }

  return db;
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
