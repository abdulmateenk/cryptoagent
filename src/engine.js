// The agent loop: scan market -> analyze + backtest -> signal -> track -> notify.
//
// Signal life-cycle
//   new        -> waiting for you: "I took it" or "Skip" (until the enter-by time)
//   taken      -> your trade; tracked until target / stop / close-by time
//   skipped    -> you said no; still tracked so the agent's accuracy stays honest
//   missed     -> no response by enter-by time = "Not taken"; still tracked to the end
// Every signal is followed to its real outcome, so the agent's accuracy counts ALL signals.
const config = require('./config');
const md = require('./marketData');
const { analyze, buildPlan, planDistance, computeInd, trendAt } = require('./strategy');
const store = require('./store');
const notify = require('./notify');

const { state, bus } = store;

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]).catch(e => ({ error: e, sym: items[idx] })); }
  });
  await Promise.all(workers);
  return out;
}

function logError(msg) {
  console.error(msg);
  state.meta.errors.unshift({ at: Date.now(), msg: String(msg).slice(0, 200) });
  state.meta.errors = state.meta.errors.slice(0, 10);
}

const openTakenCount = () => state.signals.filter(s => s.userAction === 'taken' && !s.user && s.status !== 'closed').length;

function closeSignal(sig, outcome, R, price) {
  sig.status = 'closed';
  sig.outcome = outcome;
  sig.resultR = R;
  sig.resultUsd = R * sig.setup.riskUsd;
  sig.closedAt = Date.now();
  sig.lastPrice = price;
  // If you took it and didn't close it yourself, your result = the agent's result
  if (sig.userAction === 'taken' && !sig.user) sig.user = { closedAt: sig.closedAt, resultR: R, resultUsd: sig.resultUsd, auto: true };
  notify.update(sig, outcome);
}

// Walk 15m candles since the signal was created and apply stop / TP rules.
function trackSignal(sig, k15) {
  const s = sig.setup;
  const dir = sig.side === 'LONG' ? 1 : -1;
  const now = Date.now();
  if (sig.status !== 'closed') {
    const hit = (level, c) => (dir === 1 ? c.high >= level : c.low <= level);
    const hitAdverse = (level, c) => (dir === 1 ? c.low <= level : c.high >= level);
    const candles = k15.filter(c => c.openTime >= sig.createdAt && c.closeTime > (sig.checkedUntil || 0) && c.closeTime < now);
    const livePrice = k15[k15.length - 1].close;
    candles.push({ high: livePrice, low: livePrice, closeTime: 0, live: true });

    for (const c of candles) {
      if (sig.status === 'closed') break;
      if (sig.status === 'active') {
        if (hitAdverse(s.stop, c)) { closeSignal(sig, 'stop', -1, s.stop); break; }
        if (hit(s.tp1, c)) {
          sig.status = 'tp1';
          sig.lastPrice = s.tp1;
          notify.update(sig, 'tp1');
          if (hit(s.tp2, c)) { closeSignal(sig, 'tp2', 2, s.tp2); break; }
        }
      } else if (sig.status === 'tp1') {
        if (hitAdverse(s.entry, c)) { closeSignal(sig, 'breakeven', 0.75, s.entry); break; }
        if (hit(s.tp2, c)) { closeSignal(sig, 'tp2', 2, s.tp2); break; }
      }
      if (!c.live) sig.checkedUntil = c.closeTime;
    }
    if (sig.status !== 'closed') {
      sig.lastPrice = livePrice;
      const mtmR = (dir * (livePrice - s.entry)) / s.dist;
      sig.liveR = sig.status === 'tp1' ? 0.75 + 0.5 * mtmR : mtmR;
      if (now > sig.closeBy) closeSignal(sig, 'expired', sig.liveR, livePrice);
    }
  }
  // No response by the enter-by time -> "Not taken" (still tracked)
  if (!sig.userAction && now > sig.entryUntil) {
    sig.userAction = 'missed';
    if (sig.status !== 'closed') notify.update(sig, 'missed');
  }
}

function canOpen(symbol) {
  if (state.signals.find(s => s.symbol === symbol && s.status !== 'closed')) return false;
  const lastOne = state.signals.find(s => s.symbol === symbol);
  return !(lastOne && Date.now() - lastOne.createdAt < config.cooldownHours * 36e5);
}

function openSignal(a, extra = {}) {
  const now = extra.createdAt || Date.now();
  const sig = {
    id: `${a.symbol}-${now}`,
    symbol: a.symbol, side: a.setup.side, confidence: a.confidence,
    reasons: a.reasons, checks: a.checks, strategy: a.pick, setup: a.setup,
    createdAt: now,
    entryUntil: now + config.entryWindowHours * 36e5,
    closeBy: now + config.signalExpiryHours * 36e5,
    status: 'active', userAction: null, user: null,
    lastPrice: a.price, liveR: 0, ...extra,
  };
  state.signals.unshift(sig);
  state.signals.sort((x, y) => y.createdAt - x.createdAt);
  if (!extra.silent) notify.newSignal(sig);
  return sig;
}

function btcContext(k1h) {
  const d = computeInd(k1h);
  const n = k1h.length;
  return {
    trend: trendAt(d, n - 2),
    change4h: ((k1h[n - 1].close - k1h[n - 5].close) / k1h[n - 5].close) * 100,
    rsi: d.rsi[n - 1] || 50,
  };
}

// DEMO mode only: sample signals (some back-dated) so every part of the portal can be seen.
function seedDemo(results) {
  if (state.signals.length) return;
  const rs = results.filter(r => r && !r.error);
  const make = (r, hoursAgo, extra) => {
    const k = r.k1h, i = k.length - 2 - hoursAgo;
    const a = state.market[r.sym];
    const dir = a.trend === 'DOWN' ? -1 : 1;
    const entry = k[i].close;
    const setup = buildPlan(entry, dir, planDistance(k, i, dir, entry, (a.atrDemo = Math.abs(k[i].high - k[i].low) || entry * 0.01)));
    const strat = a.strategies[0];
    openSignal({
      symbol: r.sym, price: entry, confidence: 70, setup,
      reasons: ['DEMO sample trade (not a real signal)', `${strat.name}: backtest ${strat.bt.trades} trades, ${strat.bt.winRate.toFixed(0)}% wins`],
      checks: [{ ok: true, name: 'Backtest win rate', detail: `${strat.bt.winRate.toFixed(0)}%` }, { ok: true, name: 'Bitcoin direction', detail: 'ok' }, { ok: true, name: 'Liquidity', detail: 'ok' }],
      pick: { id: strat.id, name: strat.name, about: 'demo', bt: strat.bt },
    }, { demo: true, silent: hoursAgo > 0, createdAt: k[i + 1].openTime, ...extra });
  };
  rs.slice(0, 3).forEach(r => make(r, 0));
  rs.slice(3, 9).forEach((r, j) => make(r, 4 + j * 2, j === 0 ? { userAction: 'taken', takenAt: Date.now() } : {}));
}

async function scan() {
  if (state.meta.scanning) return;
  state.meta.scanning = true;
  bus.emit('update');
  try {
    if ((config.scanCheap || config.scanHot) && Date.now() - (state.meta.discoveredAt || 0) > 15 * 6e4) {
      try {
        const { cheap, hot } = await md.discoverCoins();
        state.meta.cheapCoins = cheap;
        state.meta.hotCoins = hot;
        state.meta.discoveredAt = Date.now();
      } catch (e) { logError('Coin discovery failed: ' + e.message); }
    }
    const tracked = state.signals.filter(s => s.status !== 'closed').map(s => s.symbol);
    const symbols = [...new Set(['BTCUSDT', ...config.watchlist, ...state.meta.hotCoins, ...state.meta.cheapCoins, ...tracked])];

    let tickers = {};
    try { tickers = await md.tickers24h(symbols); } catch (e) { logError('24h ticker failed: ' + e.message); }

    const results = await pool(symbols, 4, async sym => {
      const [k15, k1h] = await Promise.all([md.klines(sym, '15m', 120), md.klines(sym, '1h', 1000)]);
      return { sym, k15, k1h };
    });

    const btcRes = results.find(r => r && r.sym === 'BTCUSDT' && !r.error);
    const ctx = { btc: btcRes ? btcContext(btcRes.k1h) : null };
    state.meta.btc = ctx.btc;

    const fresh = {};
    for (const r of results) {
      if (!r || r.error) { logError(`Data failed for ${r && r.sym}: ${r && r.error ? r.error.message : 'unknown'}`); continue; }
      const { sym, k15, k1h } = r;
      try {
        for (const sig of state.signals.filter(s => s.symbol === sym && s.status !== 'closed')) trackSignal(sig, k15);
        if (k1h.length < 260) continue; // too new to benchmark
        ctx.openTaken = openTakenCount();
        const a = analyze(sym, k15, k1h, tickers[sym], ctx);
        a.cheap = state.meta.cheapCoins.includes(sym);
        a.hot = state.meta.hotCoins.includes(sym);
        fresh[sym] = a;
        if (a.setup && canOpen(sym)) openSignal(a);
      } catch (e) { logError(`Analyze ${sym} failed: ${e.message}`); }
    }
    // response deadlines for signals whose coin dropped out of the scan
    for (const sig of state.signals) if (!sig.userAction && Date.now() > sig.entryUntil) { sig.userAction = 'missed'; }

    state.market = fresh;
    if (config.demo && !state.signals.length) {
      seedDemo(results);
      for (const r of results) if (r && !r.error) for (const sig of state.signals.filter(s => s.symbol === r.sym && s.status !== 'closed')) trackSignal(sig, r.k15);
    }
    state.meta.lastScan = Date.now();
    state.meta.lastTrack = Date.now();
  } catch (e) {
    logError('Scan failed: ' + e.message);
  } finally {
    state.meta.scanning = false;
    state.meta.nextScan = Date.now() + config.scanIntervalMin * 6e4;
    await store.save();
    bus.emit('update');
  }
}

// Between full scans, re-check open trades every minute so targets/stops are caught fast.
async function quickTrack() {
  if (state.meta.scanning) return;
  state.meta.lastTrack = Date.now();
  const open = state.signals.filter(s => s.status !== 'closed');
  if (!open.length) return;
  for (const sym of [...new Set(open.map(s => s.symbol))]) {
    try {
      const k15 = await md.klines(sym, '15m', 120);
      for (const sig of open.filter(s => s.symbol === sym)) trackSignal(sig, k15);
    } catch (_) { /* next scan will retry */ }
  }
  await store.save();
  bus.emit('update');
}

// Always-on servers: run the loops ourselves.
async function start() {
  await store.load();
  scan();
  setInterval(scan, config.scanIntervalMin * 6e4);
  setInterval(quickTrack, 60e3);
}

// Serverless (Vercel): a timer / the open portal calls /api/tick; we do whatever is due.
async function tick({ force = false } = {}) {
  await store.load();
  const now = Date.now();
  const due = force || !state.meta.lastScan || now - state.meta.lastScan > config.scanIntervalMin * 6e4 - 30e3;
  if (due) {
    if (!(await store.lock('scan', 110))) return { action: 'busy' };
    try { await scan(); } finally { await store.unlock('scan'); }
    return { action: 'scan', lastScan: state.meta.lastScan };
  }
  if (now - (state.meta.lastTrack || 0) > 55e3 && state.signals.some(s => s.status !== 'closed')) {
    if (!(await store.lock('track', 50))) return { action: 'busy' };
    try { await quickTrack(); } finally { await store.unlock('track'); }
    return { action: 'track' };
  }
  return { action: 'none', nextScan: state.meta.nextScan };
}

// ---------- Your responses ----------
async function respond(id, action) {
  await store.load();
  const sig = state.signals.find(s => s.id === id);
  if (!sig) return { ok: false, error: 'not found' };
  if (action === 'take') {
    if (sig.status === 'closed') return { ok: false, error: 'trade already finished' };
    sig.userAction = 'taken';
    sig.takenAt = Date.now();
    sig.takenPrice = sig.lastPrice;
  } else if (action === 'skip') {
    if (sig.userAction === 'taken') return { ok: false, error: 'already taken' };
    sig.userAction = 'skipped';
  } else if (action === 'close') {
    // You closed your position yourself; the agent keeps tracking for its accuracy score.
    if (sig.userAction !== 'taken' || sig.user) return { ok: false, error: 'not an open trade of yours' };
    const R = sig.status === 'closed' ? sig.resultR : (sig.liveR || 0);
    sig.user = { closedAt: Date.now(), resultR: R, resultUsd: R * sig.setup.riskUsd, price: sig.lastPrice };
  } else return { ok: false, error: 'unknown action' };
  await store.save();
  bus.emit('update');
  return { ok: true };
}

module.exports = { start, scan, tick, respond };
