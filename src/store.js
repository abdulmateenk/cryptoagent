// Storage for the agent's state.
//   - Upstash Redis (needed on Vercel / serverless): set KV_REST_API_URL + KV_REST_API_TOKEN
//     (added automatically when you connect "Upstash for Redis" in the Vercel dashboard)
//   - JSON file (normal always-on servers: VPS, Railway, Render)
//   - memory (fallback - data can be lost; the portal shows a warning)
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('./config');

const bus = new EventEmitter();
bus.setMaxListeners(100);

const SERVERLESS = !!process.env.VERCEL;
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const backend = REDIS_URL && REDIS_TOKEN ? 'redis' : SERVERLESS ? 'memory' : 'file';
const KEY = 'cryptoagent:state';

const state = {
  signals: [],          // all signals (active + closed), newest first
  market: {},           // symbol -> latest analysis
  updates: [],          // feed shown in the "Updates" tab
  meta: { lastScan: null, nextScan: null, lastTrack: 0, discoveredAt: 0, scanning: false, errors: [], cheapCoins: [], hotCoins: [], btc: null, startedAt: Date.now() },
};

async function redis(cmd) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error('Redis: ' + (j.error || res.status));
  return j.result;
}

function apply(raw) {
  if (!raw) return;
  if (Array.isArray(raw.signals)) state.signals = raw.signals;
  if (Array.isArray(raw.updates)) state.updates = raw.updates;
  if (raw.market && typeof raw.market === 'object') state.market = raw.market;
  if (raw.meta) Object.assign(state.meta, raw.meta, { scanning: state.meta.scanning });
}

function serialize() {
  const closed = state.signals.filter(s => s.status === 'closed').slice(0, 400);
  const active = state.signals.filter(s => s.status !== 'closed');
  const { scanning, ...meta } = state.meta;
  return JSON.stringify({ signals: [...active, ...closed], updates: state.updates.slice(0, 200), market: state.market, meta });
}

let fileLoaded = false;
async function load() {
  try {
    if (backend === 'redis') apply(JSON.parse((await redis(['GET', KEY])) || 'null'));
    else if (backend === 'file' && !fileLoaded) { apply(JSON.parse(fs.readFileSync(config.dataFile, 'utf8'))); fileLoaded = true; }
  } catch (e) {
    if (backend === 'file') fileLoaded = true; // first run: no file yet
    else console.error('load failed', e.message);
  }
}

async function save() {
  try {
    if (backend === 'redis') await redis(['SET', KEY, serialize()]);
    else if (backend === 'file') {
      fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
      fs.writeFileSync(config.dataFile, serialize());
    }
  } catch (e) { console.error('save failed', e.message); }
}

// Prevent two scans at once (e.g. timer + portal both asking)
const localLocks = {};
async function lock(name, seconds) {
  if (backend === 'redis') return (await redis(['SET', `cryptoagent:lock:${name}`, '1', 'NX', 'EX', String(seconds)])) === 'OK';
  if (localLocks[name] && localLocks[name] > Date.now()) return false;
  localLocks[name] = Date.now() + seconds * 1000;
  return true;
}
async function unlock(name) {
  if (backend === 'redis') { try { await redis(['DEL', `cryptoagent:lock:${name}`]); } catch (_) {} return; }
  delete localLocks[name];
}

function addUpdate(u) {
  state.updates.unshift({ at: Date.now(), ...u });
  state.updates = state.updates.slice(0, 200);
}

function summarize(list, rKey = 'resultR', usdKey = 'resultUsd', pick = x => x) {
  const rows = list.map(pick);
  const wins = rows.filter(r => r[rKey] > 0.05).length;
  return {
    count: rows.length, wins,
    winRate: rows.length ? (wins / rows.length) * 100 : null,
    totalR: rows.reduce((a, r) => a + (r[rKey] || 0), 0),
    totalUsd: rows.reduce((a, r) => a + (r[usdKey] || 0), 0),
    avgR: rows.length ? rows.reduce((a, r) => a + (r[rKey] || 0), 0) / rows.length : 0,
  };
}

function stats() {
  const S = state.signals;
  const closed = S.filter(s => s.status === 'closed');
  const notTaken = s => s.userAction === 'missed' || s.userAction === 'skipped';
  return {
    agent: summarize(closed),                                                     // every signal, taken or not
    mine: summarize(S.filter(s => s.userAction === 'taken' && s.user), 'resultR', 'resultUsd', s => s.user),
    missed: summarize(closed.filter(notTaken)),                                   // what you left on the table
    awaiting: S.filter(s => !s.userAction && s.status !== 'closed').length,
    openMine: S.filter(s => s.userAction === 'taken' && !s.user).length,
    tracking: S.filter(s => notTaken(s) && s.status !== 'closed').length,
    today: S.filter(s => s.createdAt > Date.now() - 864e5).length,
  };
}

function snapshot() {
  return {
    signals: state.signals.slice(0, 200),
    updates: state.updates.slice(0, 100),
    market: Object.values(state.market).sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0)),
    meta: { ...state.meta, now: Date.now() },
    stats: stats(),
    settings: {
      accountUsd: config.accountUsd, riskPerTradeUsd: config.riskPerTradeUsd, maxLeverage: config.maxLeverage,
      scanIntervalMin: config.scanIntervalMin, allowShorts: config.allowShorts, demo: config.demo,
      minConfidence: config.minConfidence, entryWindowHours: config.entryWindowHours,
      signalExpiryHours: config.signalExpiryHours, telegram: !!(config.telegramToken && config.telegramChatId),
      storage: backend, serverless: SERVERLESS,
    },
  };
}

module.exports = { state, bus, load, save, lock, unlock, snapshot, addUpdate, backend, SERVERLESS };
