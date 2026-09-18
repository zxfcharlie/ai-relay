const express = require('express');
const { nanoid } = require('nanoid');
const { getDB, save } = require('../db');
const {
  hashPassword,
  checkPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  publicUser
} = require('../auth');

const router = express.Router();

router.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username and a password of at least 6 characters are required.' });
  }
  const db = getDB();
  const isFirstUser = db.users.length === 0;
  if (!isFirstUser && !db.settings.allowRegistration) {
    return res.status(403).json({ error: 'Registration is currently closed. Ask your admin for an invite.' });
  }
  const exists = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return res.status(409).json({ error: 'That username is already taken.' });

  // The first account (admin) is always active immediately; everyone after
  // that sits as 'pending' until an admin approves them, unless the admin
  // has turned approval off.
  const needsApproval = !isFirstUser && db.settings.requireApproval;
  const user = {
    id: nanoid(),
    username,
    passwordHash: hashPassword(password),
    isAdmin: isFirstUser,
    status: needsApproval ? 'pending' : 'active',
    createdAt: new Date().toISOString(),
    personalOpenAIKey: '',
    personalClaudeKey: '',
    relayApiKey: 'rk-' + nanoid(40)
  };
  db.users.push(user);
  save();

  if (needsApproval) {
    return res.json({ pendingApproval: true });
  }
  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ user: publicUser(user), isFirstUser });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const db = getDB();
  const user = db.users.find((u) => u.username.toLowerCase() === (username || '').toLowerCase());
  if (!user || !checkPassword(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: '账号正在等待管理员审核，请稍后再试。', pending: true });
  }
  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Lets the login page know whether to show "sign up" (no users yet, or
// registration open) versus a sign-in-only screen, and whether to warn
// that new signups need approval before they can log in.
router.get('/status', (req, res) => {
  const db = getDB();
  res.json({
    hasUsers: db.users.length > 0,
    allowRegistration: db.settings.allowRegistration,
    requireApproval: db.settings.requireApproval,
    siteName: db.settings.siteName
  });
});

module.exports = router;
