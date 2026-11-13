// Tiny JSON-file store + live event bus for the portal.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('./config');

const bus = new EventEmitter();
bus.setMaxListeners(100);

const state = {
  signals: [],          // all signals (active + closed), newest first
  market: {},           // symbol -> latest analysis
  updates: [],          // feed of alerts shown in the "Updates" sidebar tab
  meta: { lastScan: null, nextScan: null, scanning: false, errors: [], cheapCoins: [], hotCoins: [], startedAt: Date.now() },
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
    if (Array.isArray(raw.signals)) state.signals = raw.signals;
    if (Array.isArray(raw.updates)) state.updates = raw.updates;
  } catch (_) { /* first run */ }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
    const closed = state.signals.filter(s => s.status === 'closed').slice(0, 500);
    const active = state.signals.filter(s => s.status !== 'closed');
    fs.writeFileSync(config.dataFile, JSON.stringify({ signals: [...active, ...closed], updates: state.updates.slice(0, 200) }));
  } catch (e) { console.error('save failed', e.message); }
}

function addUpdate(u) {
  state.updates.unshift({ at: Date.now(), ...u });
  state.updates = state.updates.slice(0, 200);
}

function stats() {
  const closed = state.signals.filter(s => s.status === 'closed');
  const wins = closed.filter(s => s.resultR > 0.05).length;
  const totalR = closed.reduce((a, s) => a + (s.resultR || 0), 0);
  const totalUsd = closed.reduce((a, s) => a + (s.resultUsd || 0), 0);
  const dayAgo = Date.now() - 864e5;
  return {
    active: state.signals.filter(s => s.status !== 'closed').length,
    closed: closed.length,
    wins,
    winRate: closed.length ? (wins / closed.length) * 100 : null,
    totalR, totalUsd,
    today: state.signals.filter(s => s.createdAt > dayAgo).length,
  };
}

function snapshot() {
  return {
    signals: state.signals.slice(0, 200),
    updates: state.updates.slice(0, 100),
    market: Object.values(state.market).sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0)),
    meta: state.meta,
    stats: stats(),
    settings: {
      accountUsd: config.accountUsd, riskPerTradeUsd: config.riskPerTradeUsd, maxLeverage: config.maxLeverage,
      scanIntervalMin: config.scanIntervalMin, allowShorts: config.allowShorts, demo: config.demo,
      minConfidence: config.minConfidence, entryWindowHours: config.entryWindowHours,
      signalExpiryHours: config.signalExpiryHours, telegram: !!(config.telegramToken && config.telegramChatId),
    },
  };
}

module.exports = { state, bus, load, save, snapshot, addUpdate };
