const { getDB } = require('../db');

// Personal key wins if the user set one; otherwise fall back to the
// admin-configured global key for that provider.
function resolveApiKey(user, provider) {
  const db = getDB();
  if (provider === 'openai') {
    return user.personalOpenAIKey || db.settings.globalOpenAIKey || null;
  }
  if (provider === 'claude') {
    return user.personalClaudeKey || db.settings.globalClaudeKey || null;
  }
  return null;
}

module.exports = { resolveApiKey };
