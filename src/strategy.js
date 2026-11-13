// Multi-strategy analysis with a pre-trade benchmark.
//
// For every coin the agent:
//   1. computes indicators on ~1000 one-hour candles
//   2. runs 4 strategies on the last closed candle
//   3. BACKTESTS each strategy on that coin's own history with the exact same
//      stop-loss / take-profit / time-limit rules used for live trades
//   4. runs risk checks (BTC direction, liquidity, volatility, chasing, exposure...)
//   5. only signals when a strategy fires AND its backtest is good AND every check passes.
const I = require('./indicators');
const config = require('./config');

// ---------------- Indicators ----------------
function computeInd(k) {
  const close = k.map(c => c.close);
  const vol = k.map(c => c.quoteVolume);
  const obvArr = I.obv(k);
  const bb = I.bollinger(close, 20, 2);
  const m = I.macd(close);
  const dc = I.donchian(k, 20);
  return {
    close, vol,
    ema20: I.ema(close, 20), ema50: I.ema(close, 50), ema80: I.ema(close, 80), ema200: I.ema(close, 200),
    rsi: I.rsi(close, 14), atr: I.atr(k, 14),
    obv: obvArr, obvEma: I.ema(obvArr, 20),
    bbU: bb.upper, bbL: bb.lower, bbM: bb.mid,
    macd: m.line, macdSig: m.signal, macdHist: m.hist,
    dcHi: dc.hi, dcLo: dc.lo,
    volAvg: I.sma(vol, 20),
  };
}

// 4h trend approximated on 1h data: EMA200(1h) ≈ EMA50(4h), EMA80(1h) ≈ EMA20(4h)
function trendAt(d, i) {
  if (d.ema200[i] === null || d.ema80[i] === null) return 'NEUTRAL';
  if (d.close[i] > d.ema200[i] && d.ema80[i] > d.ema200[i]) return 'UP';
  if (d.close[i] < d.ema200[i] && d.ema80[i] < d.ema200[i]) return 'DOWN';
  return 'NEUTRAL';
}

// ---------------- Strategies ----------------
// Each returns +1 (long), -1 (short) or 0 for the candle at index i (a closed candle).
const STRATEGIES = [
  {
    id: 'pullback', name: 'Trend pullback',
    about: 'Trade with the trend after price dips back to the 20 EMA',
    detect(d, k, i) {
      const t = trendAt(d, i), r = d.rsi[i];
      if (r === null) return 0;
      if (t === 'UP' && k[i].low <= d.ema20[i] * 1.003 && d.close[i] > d.ema20[i] && d.close[i] > d.close[i - 1] && r >= 40 && r <= 60 && d.close[i] > d.ema50[i] * 0.99) return 1;
      if (t === 'DOWN' && k[i].high >= d.ema20[i] * 0.997 && d.close[i] < d.ema20[i] && d.close[i] < d.close[i - 1] && r >= 40 && r <= 60 && d.close[i] < d.ema50[i] * 1.01) return -1;
      return 0;
    },
  },
  {
    id: 'breakout', name: 'Volume breakout',
    about: 'Price breaks a 20-hour high/low with strong volume and OBV confirmation',
    detect(d, k, i) {
      const t = trendAt(d, i), r = d.rsi[i];
      if (d.dcHi[i] === null || d.volAvg[i - 1] === null || r === null) return 0;
      const volOk = d.vol[i] > 1.5 * d.volAvg[i - 1];
      if (t !== 'DOWN' && d.close[i] > d.dcHi[i] && volOk && r < 75 && d.obv[i] > d.obvEma[i]) return 1;
      if (t !== 'UP' && d.close[i] < d.dcLo[i] && volOk && r > 25 && d.obv[i] < d.obvEma[i]) return -1;
      return 0;
    },
  },
  {
    id: 'meanrev', name: 'Range bounce',
    about: 'In a sideways market, buy oversold bounces / short overbought rejections',
    detect(d, k, i) {
      if (trendAt(d, i) !== 'NEUTRAL' || d.bbL[i] === null || d.rsi[i - 1] === null) return 0;
      if (d.rsi[i - 1] < 30 && d.close[i] > d.bbL[i] && d.close[i] > k[i].open) return 1;
      if (d.rsi[i - 1] > 70 && d.close[i] < d.bbU[i] && d.close[i] < k[i].open) return -1;
      return 0;
    },
  },
  {
    id: 'macd', name: 'MACD momentum',
    about: 'MACD crosses its signal line in the direction of the trend',
    detect(d, k, i) {
      const t = trendAt(d, i);
      const h = d.macdHist[i], hp = d.macdHist[i - 1];
      if (h === null || hp === null) return 0;
      if (t === 'UP' && hp <= 0 && h > 0 && d.close[i] > d.ema50[i]) return 1;
      if (t === 'DOWN' && hp >= 0 && h < 0 && d.close[i] < d.ema50[i]) return -1;
      return 0;
    },
  },
];

// ---------------- Trade plan ----------------
function planDistance(k, i, dir, entry, atrVal) {
  const from = Math.max(0, i - 11);
  const swing = dir === 1 ? Math.min(...k.slice(from, i + 1).map(c => c.low)) : Math.max(...k.slice(from, i + 1).map(c => c.high));
  let dist = Math.abs(entry - swing) + 0.25 * atrVal;
  dist = Math.min(Math.max(dist, 0.8 * atrVal), 2 * atrVal);
  return Math.max(dist, entry * 0.004); // at least 0.4% to survive noise + fees
}

function buildPlan(entry, dir, dist) {
  const stopPct = (dist / entry) * 100;
  const zoneA = entry - dir * dist * 0.3, zoneB = entry + dir * dist * 0.1;
  const safeLev = Math.floor(100 / (2 * stopPct)); // liquidation ≥ 2x further than stop
  const leverage = Math.max(1, Math.min(config.maxLeverage, safeLev));
  let notional = config.riskPerTradeUsd / (stopPct / 100);
  const maxMargin = config.accountUsd * 0.5;
  if (notional / leverage > maxMargin) notional = maxMargin * leverage;
  const riskUsd = notional * stopPct / 100;
  return {
    side: dir === 1 ? 'LONG' : 'SHORT', entry,
    entryLow: Math.min(zoneA, zoneB), entryHigh: Math.max(zoneA, zoneB),
    stop: entry - dir * dist, tp1: entry + dir * dist * 1.5, tp2: entry + dir * dist * 2.5,
    stopPct, dist, leverage, notional, margin: notional / leverage, riskUsd,
    rewardUsdTp1: riskUsd * 1.5, rewardUsdTp2: riskUsd * 2.5,
  };
}

// Same rules as live tracking: stop first (conservative), TP1 = sell half + stop to entry,
// TP2 = close rest, time limit = close at market.
function simulate(k, i, dir, entry, dist, maxBars) {
  const stop = entry - dir * dist, tp1 = entry + dir * dist * 1.5, tp2 = entry + dir * dist * 2.5;
  let stage = 0;
  const end = Math.min(k.length - 2, i + maxBars); // never use the live candle
  for (let j = i + 1; j <= end; j++) {
    const c = k[j];
    const fav = lvl => (dir === 1 ? c.high >= lvl : c.low <= lvl);
    const adv = lvl => (dir === 1 ? c.low <= lvl : c.high >= lvl);
    if (stage === 0) {
      if (adv(stop)) return { R: -1, exit: j };
      if (fav(tp1)) { stage = 1; if (fav(tp2)) return { R: 2, exit: j }; continue; }
    } else {
      if (adv(entry)) return { R: 0.75, exit: j };
      if (fav(tp2)) return { R: 2, exit: j };
    }
    if (j === end && j === i + maxBars) {
      const m = (dir * (c.close - entry)) / dist;
      return { R: stage ? 0.75 + 0.5 * m : m, exit: j };
    }
  }
  return null; // not finished yet (too recent)
}

function backtest(strat, d, k) {
  const maxBars = Math.max(1, Math.round(config.signalExpiryHours));
  const results = [];
  for (let i = 210; i < k.length - 2; i++) {
    const dir = strat.detect(d, k, i);
    if (!dir || !d.atr[i]) continue;
    const entry = k[i].close;
    const dist = planDistance(k, i, dir, entry, d.atr[i]);
    if ((dist / entry) * 100 > config.maxStopPct) continue;
    const r = simulate(k, i, dir, entry, dist, maxBars);
    if (!r) break;
    results.push({ R: r.R, dir, at: k[i].openTime });
    i = r.exit; // no overlapping trades
  }
  const n = results.length;
  const wins = results.filter(r => r.R > 0.05).length;
  const pos = results.filter(r => r.R > 0).reduce((a, r) => a + r.R, 0);
  const neg = Math.abs(results.filter(r => r.R < 0).reduce((a, r) => a + r.R, 0));
  let eq = 0, peak = 0, maxDD = 0;
  for (const r of results) { eq += r.R; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }
  const days = k.length > 1 ? (k[k.length - 1].openTime - k[0].openTime) / 864e5 : 0;
  return {
    trades: n, wins,
    winRate: n ? (wins / n) * 100 : 0,
    avgR: n ? results.reduce((a, r) => a + r.R, 0) / n : 0,
    profitFactor: neg ? Math.min(pos / neg, 9.99) : (pos > 0 ? 9.99 : 0),
    maxDD, days: Math.round(days),
    recent: results.slice(-10).map(r => +r.R.toFixed(2)),
  };
}

function btPasses(bt) {
  return bt.trades >= config.btMinTrades && bt.winRate >= config.btMinWinRate &&
    bt.avgR >= config.btMinAvgR && bt.profitFactor >= config.btMinProfitFactor;
}

// ---------------- Main analysis ----------------
// ctx: { btc: {trend, change4h, rsi}, openTaken }
function analyze(symbol, k15, k1h, ticker, ctx = {}) {
  const d = computeInd(k1h);
  const n = k1h.length;
  const i = n - 2;                  // last CLOSED 1h candle
  const price = k15.length ? k15[k15.length - 1].close : k1h[n - 1].close;
  const changePct = ticker ? ticker.changePct : ((price - d.close[n - 25]) / d.close[n - 25]) * 100;
  const trend = trendAt(d, i);
  const rsi1 = d.rsi[n - 1];
  const obvTrend = d.obv[i] > d.obvEma[i] ? 'UP' : d.obv[i] < d.obvEma[i] ? 'DOWN' : 'FLAT';
  const volRatio = d.volAvg[i - 1] ? (d.vol[i] + d.vol[i - 1] + d.vol[i - 2]) / 3 / d.volAvg[i - 1] : null;

  // Run every strategy: live trigger (on last 1-2 closed candles) + backtest
  const strategies = STRATEGIES.map(s => {
    const now = s.detect(d, k1h, i);
    const prev = now ? 0 : s.detect(d, k1h, i - 1);
    const bt = backtest(s, d, k1h);
    return { id: s.id, name: s.name, about: s.about, fired: now || 0, recentDir: now || prev || 0, bt, btOk: btPasses(bt) };
  });

  const base = {
    symbol, price, changePct, trend, rsi1h: rsi1, obvTrend, volRatio,
    quoteVolume: ticker ? ticker.quoteVolume : null,
    verdict: 'WAIT', confidence: 0, reasons: [], setup: null,
    strategies: strategies.map(s => ({ id: s.id, name: s.name, fired: s.fired, bt: s.bt, btOk: s.btOk })),
    best: null, checks: [],
  };
  const enough = s => (s.bt.trades >= config.btMinTrades ? 1 : 0);
  const bestBt = strategies.slice().sort((a, b) => enough(b) - enough(a) || b.bt.avgR - a.bt.avgR)[0];
  base.best = { name: bestBt.name, winRate: bestBt.bt.winRate, avgR: bestBt.bt.avgR, trades: bestBt.bt.trades };

  const fired = strategies.filter(s => s.fired);
  if (!fired.length) {
    base.reasons.push(trend === 'NEUTRAL' ? 'Sideways market - no strategy triggered' : `${trend === 'UP' ? 'Uptrend' : 'Downtrend'} - waiting for an entry trigger`);
    return base;
  }
  // Pick the triggered strategy with the best backtest
  const pick = fired.slice().sort((a, b) => b.bt.avgR - a.bt.avgR)[0];
  const dir = pick.fired;
  const sideWord = dir === 1 ? 'LONG' : 'SHORT';

  const entry = price;
  const dist = planDistance(k1h, i, dir, d.close[i], d.atr[i]);
  const plan = buildPlan(entry, dir, dist);

  // ---------- Pre-trade checks ----------
  const checks = [];
  const add = (ok, name, detail) => checks.push({ ok: !!ok, name, detail });
  const bt = pick.bt;
  add(bt.trades >= config.btMinTrades, 'Enough history', `${bt.trades} past signals in ${bt.days} days (need ${config.btMinTrades})`);
  add(bt.winRate >= config.btMinWinRate, 'Backtest win rate', `${bt.winRate.toFixed(0)}% (need ${config.btMinWinRate}%)`);
  add(bt.avgR >= config.btMinAvgR, 'Backtest avg result', `${bt.avgR >= 0 ? '+' : ''}${bt.avgR.toFixed(2)}R per trade (need +${config.btMinAvgR}R)`);
  add(bt.profitFactor >= config.btMinProfitFactor, 'Profit factor', `${bt.profitFactor.toFixed(2)} (need ${config.btMinProfitFactor})`);
  if (dir === -1) add(config.allowShorts, 'Shorts allowed', config.allowShorts ? 'yes' : 'disabled in settings');

  const conflicting = strategies.filter(s => s.recentDir && s.recentDir !== dir);
  add(!conflicting.length, 'Strategies agree', conflicting.length ? `${conflicting.map(s => s.name).join(', ')} points the other way` : 'no strategy disagrees');

  if (config.btcGuard && symbol !== 'BTCUSDT' && ctx.btc) {
    const b = ctx.btc;
    const ok = dir === 1 ? !(b.change4h < -2 || (b.trend === 'DOWN' && b.rsi < 40)) : !(b.change4h > 2 || (b.trend === 'UP' && b.rsi > 60));
    add(ok, 'Bitcoin direction', `BTC ${b.change4h >= 0 ? '+' : ''}${b.change4h.toFixed(1)}% in 4h, trend ${b.trend.toLowerCase()}`);
  }
  if (ticker) add(ticker.quoteVolume >= config.minVolumeUsd, 'Liquidity', `$${(ticker.quoteVolume / 1e6).toFixed(0)}M traded in 24h`);
  add(plan.stopPct <= config.maxStopPct, 'Volatility / stop size', `stop ${plan.stopPct.toFixed(2)}% (max ${config.maxStopPct}%)`);
  add(dir === 1 ? changePct < 10 : changePct > -10, 'Not chasing', `${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}% in 24h`);
  add(dir === 1 ? rsi1 < 72 : rsi1 > 28, 'RSI not extreme', `1h RSI ${rsi1.toFixed(0)}`);
  const ran = (dir * (price - d.close[i])) / dist;
  add(ran < 0.5 && ran > -0.8, 'Price still near entry', ran >= 0.5 ? 'price already ran toward target' : ran <= -0.8 ? 'price moved against the setup' : 'yes');
  add((ctx.openTaken || 0) < config.maxOpenTrades, 'Exposure limit', `${ctx.openTaken || 0} of ${config.maxOpenTrades} open trades`);

  base.checks = checks;
  const failed = checks.filter(c => !c.ok);

  // Confidence
  const agreeing = strategies.filter(s => s.recentDir === dir).length;
  let conf = 30 + Math.max(0, Math.min(30, bt.winRate - 40)) + Math.max(0, Math.min(15, bt.avgR * 20));
  if (agreeing >= 2) conf += 10;
  if ((dir === 1 && obvTrend === 'UP') || (dir === -1 && obvTrend === 'DOWN')) conf += 5;
  if (volRatio && volRatio > 1.15) conf += 5;
  conf = Math.round(Math.max(0, Math.min(95, conf)));

  base.reasons.push(`${pick.name} triggered ${sideWord} - ${pick.about.toLowerCase()}`);
  base.reasons.push(`Backtest on this coin: ${bt.trades} trades, ${bt.winRate.toFixed(0)}% wins, ${bt.avgR >= 0 ? '+' : ''}${bt.avgR.toFixed(2)}R avg`);
  if (agreeing >= 2) base.reasons.push(`${agreeing} strategies agree on ${sideWord}`);
  if ((dir === 1 && obvTrend === 'UP') || (dir === -1 && obvTrend === 'DOWN')) base.reasons.push('OBV confirms the move');
  for (const f of failed) base.reasons.push(`✗ ${f.name}: ${f.detail}`);

  base.confidence = conf;
  if (failed.length || conf < config.minConfidence) {
    base.verdict = failed.length <= 2 ? 'WATCH' : 'WAIT';
    if (!failed.length) base.reasons.push(`✗ Confidence ${conf}% below ${config.minConfidence}%`);
    base.candidate = { side: sideWord, strategy: pick.name };
    return base;
  }
  base.verdict = sideWord;
  base.setup = plan;
  base.pick = { id: pick.id, name: pick.name, about: pick.about, bt };
  return base;
}

module.exports = { analyze, buildPlan, planDistance, computeInd, trendAt, STRATEGIES, backtest };
