// Short-term strategy: trade WITH the 4h trend, enter on a 1h pullback,
// confirm with 15m momentum, use OBV + volume for confidence.
// Produces LONG / SHORT setups with an entry zone, stop-loss, two take-profits,
// a safe leverage suggestion, position size, and a time window.
const { ema, rsi, atr, obv, last } = require('./indicators');
const config = require('./config');

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length || 1); }

// Build the trade plan (entry zone, stop, targets, leverage, size).
function buildPlan(price, dir, k1h, atr1) {
  const swing = dir === 1 ? Math.min(...k1h.slice(-12).map(c => c.low)) : Math.max(...k1h.slice(-12).map(c => c.high));
  let dist = Math.abs(price - swing) + 0.25 * atr1;
  dist = Math.min(Math.max(dist, 0.8 * atr1), 2 * atr1);
  dist = Math.max(dist, price * 0.004); // at least 0.4% to survive noise + fees
  const stopPct = (dist / price) * 100;

  const entry = price;
  const stop = entry - dir * dist;
  const tp1 = entry + dir * dist * 1.5;
  const tp2 = entry + dir * dist * 2.5;
  // Entry zone: a little better than current price down to slightly worse.
  const zoneA = entry - dir * dist * 0.3;
  const zoneB = entry + dir * dist * 0.1;
  const entryLow = Math.min(zoneA, zoneB), entryHigh = Math.max(zoneA, zoneB);

  // Leverage: keep liquidation at least ~2x further away than the stop-loss.
  const safeLev = Math.floor(100 / (2 * stopPct));
  const leverage = Math.max(1, Math.min(config.maxLeverage, safeLev));
  let notional = config.riskPerTradeUsd / (stopPct / 100);
  const maxMargin = config.accountUsd * 0.5;
  if (notional / leverage > maxMargin) notional = maxMargin * leverage;
  const margin = notional / leverage;
  const riskUsd = notional * stopPct / 100;

  return {
    side: dir === 1 ? 'LONG' : 'SHORT', entry, entryLow, entryHigh, stop, tp1, tp2, stopPct, dist,
    leverage, notional, margin, riskUsd,
    rewardUsdTp1: riskUsd * 1.5, rewardUsdTp2: riskUsd * 2.5,
  };
}

function analyze(symbol, k15, k1h, k4h, ticker) {
  const price = last(k15).close;
  const c1 = k1h.map(c => c.close), c4 = k4h.map(c => c.close), c15 = k15.map(c => c.close);

  const e20_4 = last(ema(c4, 20)), e50_4 = last(ema(c4, 50));
  const e20_1 = last(ema(c1, 20)), e50_1 = last(ema(c1, 50));
  const e20_15 = last(ema(c15, 20));
  const rsi1 = last(rsi(c1, 14)), rsi4 = last(rsi(c4, 14));
  const rsi15Arr = rsi(c15, 14);
  const atr1 = last(atr(k1h, 14));
  const obvArr = obv(k1h);
  const obvEma = last(ema(obvArr, 20));
  const obvNow = last(obvArr);
  const obvTrend = obvNow > obvEma ? 'UP' : obvNow < obvEma ? 'DOWN' : 'FLAT';

  const vols = k1h.map(c => c.quoteVolume);
  const volRatio = avg(vols.slice(-4, -1)) / avg(vols.slice(-24, -4));
  const changePct = ticker ? ticker.changePct : ((price - c1[c1.length - 25]) / c1[c1.length - 25]) * 100;

  let trend = 'NEUTRAL';
  if (c4[c4.length - 1] > e50_4 && e20_4 > e50_4) trend = 'UP';
  else if (c4[c4.length - 1] < e50_4 && e20_4 < e50_4) trend = 'DOWN';

  const base = {
    symbol, price, changePct, trend, rsi1h: rsi1, rsi4h: rsi4, volRatio, obvTrend,
    ema20_1h: e20_1, ema50_1h: e50_1, atr1h: atr1,
    quoteVolume: ticker ? ticker.quoteVolume : null,
    verdict: 'WAIT', confidence: 0, reasons: [], setup: null,
  };

  if (trend === 'NEUTRAL') {
    base.reasons.push('No clear 4h trend (sideways) - wait');
    return base;
  }
  const dir = trend === 'UP' ? 1 : -1;
  if (dir === -1 && !config.allowShorts) {
    base.reasons.push('Downtrend, shorts disabled - wait');
    return base;
  }

  const recent1h = k1h.slice(-4);
  const checks = [];
  const pulledBack = dir === 1
    ? Math.min(...recent1h.map(c => c.low)) <= e20_1 * 1.003 && price > e50_1 * 0.99
    : Math.max(...recent1h.map(c => c.high)) >= e20_1 * 0.997 && price < e50_1 * 1.01;
  checks.push([pulledBack, dir === 1 ? 'Pulled back to 1h EMA20 support' : 'Bounced up to 1h EMA20 resistance', 'No pullback yet (price stretched from 1h EMA20)']);
  const rsiOk = rsi1 >= 40 && rsi1 <= 60;
  checks.push([rsiOk, `1h RSI ${rsi1.toFixed(0)} in healthy zone`, `1h RSI ${rsi1.toFixed(0)} ${rsi1 > 60 ? 'too high' : 'too low'} for entry`]);
  const prev15 = c15[c15.length - 2];
  const momentum = dir === 1 ? price > e20_15 && price > prev15 : price < e20_15 && price < prev15;
  checks.push([momentum, '15m momentum turning in trend direction', '15m momentum not confirmed yet']);
  const notChased = dir === 1 ? changePct < 10 : changePct > -10;
  checks.push([notChased, 'Not chasing a big 24h move', `Already moved ${changePct.toFixed(1)}% in 24h - too late`]);

  const passed = checks.filter(c => c[0]).length;
  base.reasons.push(dir === 1 ? '4h uptrend (price above EMA20/50)' : '4h downtrend (price below EMA20/50)');
  for (const [ok, good, bad] of checks) base.reasons.push(ok ? '✓ ' + good : '✗ ' + bad);
  const obvAgrees = dir === 1 ? obvTrend === 'UP' : obvTrend === 'DOWN';
  base.reasons.push(obvAgrees ? `✓ OBV confirms (${dir === 1 ? 'buyers' : 'sellers'} in control)` : '• OBV not confirming yet');

  if (passed < checks.length) {
    base.verdict = passed >= 3 ? 'WATCH' : 'WAIT';
    return base;
  }

  const plan = buildPlan(price, dir, k1h, atr1);
  if (plan.stopPct > config.maxStopPct) {
    base.verdict = 'AVOID';
    base.reasons.push(`✗ Stop-loss would need ${plan.stopPct.toFixed(1)}% - too volatile for your risk limit`);
    return base;
  }

  let conf = 50;
  if (dir === 1 ? e20_1 > e50_1 : e20_1 < e50_1) conf += 10;
  if (volRatio > 1.15) { conf += 5; base.reasons.push('✓ Volume rising'); }
  if (obvAgrees) conf += 10;
  if (dir === 1 ? rsi4 >= 50 && rsi4 <= 68 : rsi4 <= 50 && rsi4 >= 32) conf += 10;
  if (Math.abs(e20_4 - e50_4) / e50_4 > 0.01) conf += 5;
  const r15 = last(rsi15Arr), r15p = rsi15Arr[rsi15Arr.length - 2];
  if (dir === 1 ? r15 > r15p : r15 < r15p) conf += 5;
  if (Math.abs(changePct) > 6) conf -= 10;
  conf = Math.max(0, Math.min(95, conf));

  base.verdict = plan.side;
  base.confidence = conf;
  base.setup = plan;
  return base;
}

module.exports = { analyze, buildPlan };
