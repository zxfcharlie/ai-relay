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
const { startCleanupSchedule } = require('./services/cleanup');

const PORT = process.env.PORT || 8511;

const app = express();
app.use(express.json({ limit: '30mb' })); // generous enough for a few attached images (base64)
app.use(cookieParser());

// App API (cookie-authenticated, used by the bundled web UI)
app.use('/api/auth', authRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/images', imagesRoutes);
app.use('/api', chatRoutes);

// Remote relay API (Bearer relay-key authenticated, OpenAI-compatible,
// for use from other machines / other apps)
app.use('/v1', relayRoutes);

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
