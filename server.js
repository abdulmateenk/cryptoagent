// Crypto Watch Portal - web server
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./src/config');
const store = require('./src/store');
const engine = require('./src/engine');
const notify = require('./src/notify');

const app = express();
app.use(express.json());

// Optional password protection (set PORTAL_PASSWORD)
app.use((req, res, next) => {
  if (!config.portalPassword || req.path === '/health') return next();
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

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/state', (_req, res) => res.json(store.snapshot()));

app.post('/api/scan', async (_req, res) => { engine.scan(); res.json({ ok: true }); });

// Your response to a signal: take | skip | close
app.post('/api/signals/:id/:action', (req, res) => res.json(engine.respond(req.params.id, req.params.action)));

app.post('/api/test-alert', async (_req, res) => {
  store.bus.emit('alert', { type: 'test', title: '🔔 Test alert', body: 'Alerts are working.' });
  await notify.telegram('🔔 Test alert from your Crypto Watch Portal - alerts are working.');
  res.json({ ok: true });
});

// Live updates via Server-Sent Events
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onUpdate = () => send('state', store.snapshot());
  const onAlert = a => send('alert', a);
  store.bus.on('update', onUpdate);
  store.bus.on('alert', onAlert);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  onUpdate();
  req.on('close', () => { clearInterval(ping); store.bus.off('update', onUpdate); store.bus.off('alert', onAlert); });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(config.port, () => {
  console.log(`Crypto Watch Portal running on http://localhost:${config.port}${config.demo ? '  (DEMO data)' : ''}`);
  engine.start();
});
