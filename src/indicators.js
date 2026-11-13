// Basic technical indicators on arrays of numbers / candles.

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI
function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

// Average True Range (Wilder)
function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// On-Balance Volume
function obv(candles) {
  const out = [0];
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    out.push(out[i - 1] + (d > 0 ? candles[i].volume : d < 0 ? -candles[i].volume : 0));
  }
  return out;
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Bollinger Bands (period, k std devs)
function bollinger(values, period = 20, k = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null), lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

// MACD (12, 26, 9)
function macd(values, f = 12, s = 26, sig = 9) {
  const ef = ema(values, f), es = ema(values, s);
  const line = values.map((_, i) => (ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null));
  const start = line.findIndex(v => v !== null);
  const sigArr = new Array(values.length).fill(null);
  if (start >= 0) {
    const tail = ema(line.slice(start), sig);
    tail.forEach((v, j) => { sigArr[start + j] = v; });
  }
  const hist = line.map((v, i) => (v !== null && sigArr[i] !== null ? v - sigArr[i] : null));
  return { line, signal: sigArr, hist };
}

// Highest high / lowest low of the previous `period` candles (excluding current)
function donchian(candles, period = 20) {
  const hi = new Array(candles.length).fill(null), lo = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - period; j < i; j++) { h = Math.max(h, candles[j].high); l = Math.min(l, candles[j].low); }
    hi[i] = h; lo[i] = l;
  }
  return { hi, lo };
}

const last = arr => arr[arr.length - 1];

module.exports = { ema, sma, rsi, atr, obv, bollinger, macd, donchian, last };
