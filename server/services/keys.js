const { getDB } = require('../db');

// Personal key wins if the user set one; otherwise fall back to the
// admin-configured global key for that provider. Custom (admin-added
// third-party) providers only ever have one shared key — there's no
// per-user personal override for those, unlike the two built-ins.
function resolveApiKey(user, provider) {
  const db = getDB();
  if (provider === 'openai') {
    return user.personalOpenAIKey || db.settings.globalOpenAIKey || null;
  }
  if (provider === 'claude') {
    return user.personalClaudeKey || db.settings.globalClaudeKey || null;
  }
  const custom = (db.settings.customProviders || []).find((p) => p.slug === provider && p.enabled);
  return custom ? (custom.apiKey || null) : null;
}

module.exports = { resolveApiKey };
