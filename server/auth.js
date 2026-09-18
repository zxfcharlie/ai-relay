const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDB, getSecret } = require('./db');

const SECRET = getSecret();
const COOKIE_NAME = 'relay_token';

function hashPassword(pw) {
  return bcrypt.hashSync(pw, 10);
}

function checkPassword(pw, hash) {
  return bcrypt.compareSync(pw, hash);
}

function signToken(user) {
  return jwt.sign({ uid: user.id }, SECRET, { expiresIn: '30d' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const payload = jwt.verify(token, SECRET);
    const db = getDB();
    const user = db.users.find((u) => u.id === payload.uid);
    if (!user) return res.status(401).json({ error: 'Not signed in.' });
    // Covers an existing session for an account an admin later suspends —
    // access is revoked on the next request, not just at the next login.
    if (user.status !== 'active') {
      return res.status(403).json({ error: '账号正在等待管理员审核。', pending: true });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired, please sign in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Admins only.' });
  }
  next();
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    isAdmin: u.isAdmin,
    status: u.status,
    createdAt: u.createdAt,
    hasPersonalOpenAIKey: !!u.personalOpenAIKey,
    hasPersonalClaudeKey: !!u.personalClaudeKey,
    relayApiKey: u.relayApiKey
  };
}

module.exports = {
  hashPassword,
  checkPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  requireAdmin,
  publicUser,
  COOKIE_NAME
};
