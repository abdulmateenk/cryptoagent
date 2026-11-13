// The agent loop: scan market -> analyze -> create/track signals -> notify.
const config = require('./config');
const md = require('./marketData');
const { analyze, buildPlan } = require('./strategy');
const { atr, last } = require('./indicators');
const store = require('./store');
const notify = require('./notify');

const { state, bus } = store;
let cheapRefreshedAt = 0;
let timer = null;

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]).catch(e => ({ error: e })); }
  });
  await Promise.all(workers);
  return out;
}

function logError(msg) {
  console.error(msg);
  state.meta.errors.unshift({ at: Date.now(), msg: String(msg).slice(0, 200) });
  state.meta.errors = state.meta.errors.slice(0, 10);
}

function closeSignal(sig, outcome, R, price) {
  sig.status = 'closed';
  sig.outcome = outcome;
  sig.resultR = R;
  sig.resultUsd = R * sig.setup.riskUsd;
  sig.closedAt = Date.now();
  sig.lastPrice = price;
  notify.update(sig, outcome);
}

// Walk 15m candles since the signal was created and apply stop / TP rules.
function trackSignal(sig, k15) {
  const s = sig.setup;
  const dir = sig.side === 'LONG' ? 1 : -1;
  const now = Date.now();
  const hit = (level, c) => dir === 1 ? c.high >= level : c.low <= level;     // favourable level reached
  const hitAdverse = (level, c) => dir === 1 ? c.low <= level : c.high >= level; // adverse level reached

  const candles = k15.filter(c => c.openTime >= sig.createdAt && c.closeTime > (sig.checkedUntil || 0));
  const livePrice = k15[k15.length - 1].close;
  candles.push({ high: livePrice, low: livePrice, closeTime: 0, live: true });

  for (const c of candles) {
    if (sig.status === 'closed') break;
    if (sig.status === 'active') {
      if (hitAdverse(s.stop, c)) { closeSignal(sig, 'stop', -1, s.stop); break; }
      if (hit(s.tp1, c)) {
        sig.status = 'tp1';
        sig.stopNow = s.entry;
        sig.lastPrice = s.tp1;
        notify.update(sig, 'tp1');
        if (hit(s.tp2, c)) { closeSignal(sig, 'tp2', 2, s.tp2); break; }
      }
    } else if (sig.status === 'tp1') {
      if (hitAdverse(s.entry, c)) { closeSignal(sig, 'breakeven', 0.75, s.entry); break; }
      if (hit(s.tp2, c)) { closeSignal(sig, 'tp2', 2, s.tp2); break; }
    }
    if (!c.live && c.closeTime < now) sig.checkedUntil = c.closeTime;
  }

  if (sig.status !== 'closed') {
    sig.lastPrice = livePrice;
    const mtmR = (dir * (livePrice - s.entry)) / s.dist;
    sig.liveR = sig.status === 'tp1' ? 0.75 + 0.5 * mtmR : mtmR;
    if (now > (sig.closeBy || sig.createdAt + config.signalExpiryHours * 36e5)) {
      closeSignal(sig, 'expired', sig.liveR, livePrice);
    }
  }
}

function canOpen(symbol) {
  const open = state.signals.find(s => s.symbol === symbol && s.status !== 'closed');
  if (open) return false;
  const lastOne = state.signals.find(s => s.symbol === symbol);
  if (lastOne && Date.now() - lastOne.createdAt < config.cooldownHours * 36e5) return false;
  return true;
}

function openSignal(sym, side, confidence, reasons, setup, price, extra = {}) {
  const now = Date.now();
  const sig = {
    id: `${sym}-${now}`,
    symbol: sym, side, confidence, reasons, setup,
    createdAt: now,
    entryUntil: now + config.entryWindowHours * 36e5,
    closeBy: now + config.signalExpiryHours * 36e5,
    status: 'active', lastPrice: price, liveR: 0, ...extra,
  };
  state.signals.unshift(sig);
  notify.newSignal(sig);
  return sig;
}

// DEMO mode only: make sure the portal shows a couple of sample trades.
function seedDemo(results) {
  if (state.signals.some(s => s.status !== 'closed')) return;
  const picks = Object.values(state.market).filter(a => a.trend !== 'NEUTRAL').slice(0, 3);
  for (const a of picks) {
    const r = results.find(x => x && x.sym === a.symbol);
    if (!r || !canOpen(a.symbol)) continue;
    const dir = a.trend === 'UP' ? 1 : -1;
    const plan = buildPlan(a.price, dir, r.k1h, last(atr(r.k1h, 14)));
    openSignal(a.symbol, plan.side, 72, ['DEMO sample trade (not a real signal)', ...a.reasons], plan, a.price, { demo: true });
  }
}

async function scan() {
  if (state.meta.scanning) return;
  state.meta.scanning = true;
  bus.emit('update');
  try {
    // Refresh hot + cheap coin lists every 15 minutes
    if ((config.scanCheap || config.scanHot) && Date.now() - cheapRefreshedAt > 15 * 6e4) {
      try {
        const { cheap, hot } = await md.discoverCoins();
        state.meta.cheapCoins = cheap;
        state.meta.hotCoins = hot;
        cheapRefreshedAt = Date.now();
      } catch (e) { logError('Coin discovery failed: ' + e.message); }
    }
    const activeSymbols = state.signals.filter(s => s.status !== 'closed').map(s => s.symbol);
    const symbols = [...new Set([...config.watchlist, ...state.meta.hotCoins, ...state.meta.cheapCoins, ...activeSymbols])];

    let tickers = {};
    try { tickers = await md.tickers24h(symbols); } catch (e) { logError('24h ticker failed: ' + e.message); }

    const results = await pool(symbols, 4, async sym => {
      const [k15, k1h, k4h] = await Promise.all([md.klines(sym, '15m', 120), md.klines(sym, '1h', 200), md.klines(sym, '4h', 200)]);
      return { sym, k15, k1h, k4h };
    });

    const fresh = {};
    for (const r of results) {
      if (!r || r.error) { logError(`Data failed: ${r && r.error ? r.error.message : 'unknown'}`); continue; }
      const { sym, k15, k1h, k4h } = r;
      try {
        // track existing signals first
        for (const sig of state.signals.filter(s => s.symbol === sym && s.status !== 'closed')) trackSignal(sig, k15);

        const a = analyze(sym, k15, k1h, k4h, tickers[sym]);
        a.cheap = state.meta.cheapCoins.includes(sym);
        a.hot = state.meta.hotCoins.includes(sym);
        fresh[sym] = a;

        if (a.setup && a.confidence >= config.minConfidence && canOpen(sym)) {
          openSignal(sym, a.verdict, a.confidence, a.reasons, a.setup, a.price);
        }
      } catch (e) { logError(`Analyze ${sym} failed: ${e.message}`); }
    }
    state.market = fresh;
    if (config.demo) seedDemo(results);
    state.meta.lastScan = Date.now();
    store.save();
  } catch (e) {
    logError('Scan failed: ' + e.message);
  } finally {
    state.meta.scanning = false;
    state.meta.nextScan = Date.now() + config.scanIntervalMin * 6e4;
    bus.emit('update');
  }
}

function start() {
  store.load();
  scan();
  timer = setInterval(scan, config.scanIntervalMin * 6e4);
}

function closeManually(id) {
  const sig = state.signals.find(s => s.id === id && s.status !== 'closed');
  if (!sig) return false;
  closeSignal(sig, 'manual', sig.liveR || 0, sig.lastPrice);
  store.save();
  bus.emit('update');
  return true;
}

module.exports = { start, scan, closeManually };
