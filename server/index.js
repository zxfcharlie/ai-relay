const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { setupProxyIfConfigured } = require('./services/network');
setupProxyIfConfigured(); // must run before any fetch() to OpenAI/Claude happens

const authRoutes = require('./routes/auth');
const settingsRoutes = require('./routes/settings');
const chatRoutes = require('./routes/chat');
const relayRoutes = require('./routes/relay');
const imagesRoutes = require('./routes/images');
const usageRoutes = require('./routes/usage');
const { startCleanupSchedule } = require('./services/cleanup');

const PORT = process.env.PORT || 8511;

const app = express();
app.use(express.json({ limit: '45mb' })); // generous enough for a few attached images/PDFs (base64)
app.use(cookieParser());

// App API (cookie-authenticated, used by the bundled web UI)
app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/images', imagesRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api', chatRoutes);

// Remote relay API (Bearer relay-key authenticated, OpenAI-compatible,
// for use from other machines / other apps)
app.use('/v1', relayRoutes);

// Standalone API documentation for the relay endpoints (served explicitly,
// since a bare "/docs" would otherwise fall through to the SPA catch-all
// below rather than resolving docs.html the way "/docs.html" would).
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'docs.html'));
});

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/v1')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Relay listening on http://0.0.0.0:${PORT}`);
});

startCleanupSchedule();
