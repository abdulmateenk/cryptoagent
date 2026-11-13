// Crypto Watch Portal - web server
// Runs two ways:
//   - always-on server (VPS / Railway / Render / your PC): `npm start` - the agent loops by itself
//   - Vercel (serverless): exported as a function; a timer calls /api/tick every few minutes
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./src/config');
const store = require('./src/store');
const engine = require('./src/engine');
const notify = require('./src/notify');

const app = express();
app.use(express.json());

const PUBLIC_PATHS = new Set(['/health', '/api/tick']); // timer must reach /api/tick without a password

// Optional password protection (set PORTAL_PASSWORD)
app.use((req, res, next) => {
  if (!config.portalPassword || PUBLIC_PATHS.has(req.path)) return next();
  const hdr = req.headers.authorization || '';
  const [scheme, encoded] = hdr.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
    const p = rest.join(':');
    const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (eq(u, config.portalUser) && eq(p, config.portalPassword)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Crypto Watch Portal"');
  res.status(401).send('Authentication required');
});

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error(e);
  res.status(500).json({ ok: false, error: e.message });
});

app.get('/health', (_req, res) => res.json({ ok: true, storage: store.backend, serverless: store.SERVERLESS }));

app.get('/api/state', wrap(async (_req, res) => {
  if (store.SERVERLESS) await store.load();
  res.set('Cache-Control', 'no-store');
  res.json(store.snapshot());
}));

// Does whatever is due: a full scan every SCAN_INTERVAL_MIN, otherwise a quick trade check.
app.all('/api/tick', wrap(async (_req, res) => res.json({ ok: true, ...(await engine.tick()) })));

app.post('/api/scan', wrap(async (_req, res) => {
  if (store.SERVERLESS) return res.json({ ok: true, ...(await engine.tick({ force: true })) });
  engine.scan();
  res.json({ ok: true, action: 'scan' });
}));

// Your response to a signal: take | skip | close
app.post('/api/signals/:id/:action', wrap(async (req, res) => res.json(await engine.respond(req.params.id, req.params.action))));

app.post('/api/test-alert', wrap(async (_req, res) => {
  await notify.telegram('🔔 Test alert from your Crypto Watch Portal - alerts are working.');
  res.json({ ok: true, telegram: !!(config.telegramToken && config.telegramChatId) });
}));

app.use(express.static(path.join(__dirname, 'web'), { index: 'index.html' }));

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Crypto Watch Portal running on http://localhost:${config.port}${config.demo ? '  (DEMO data)' : ''} · storage: ${store.backend}`);
    engine.start();
  });
}

module.exports = app;
