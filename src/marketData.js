// Market data: Binance public API (no API key needed), or synthetic data in DEMO mode.
const config = require('./config');

const STABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'USDP', 'DAI', 'EUR', 'EURI', 'AEUR', 'USDE', 'XUSD', 'BFUSD', 'USD1', 'PAXG', 'WBTC', 'WBETH']);

// Try the public data mirror first, then the main API as a backup.
const BASES = [...new Set([config.binanceBase, 'https://data-api.binance.vision', 'https://api.binance.com'])];
let baseIdx = 0;
async function getJson(path) {
  let lastErr;
  for (let n = 0; n < BASES.length; n++) {
    const base = BASES[(baseIdx + n) % BASES.length];
    try {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(15000) }); // never hang a scan
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Binance ${res.status}: ${body.slice(0, 100)}`);
      }
      baseIdx = (baseIdx + n) % BASES.length; // remember the one that works
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Can't reach Binance (${lastErr && lastErr.message}) - check your internet connection`);
}

function parseKlines(rows) {
  return rows.map(r => ({
    openTime: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4],
    volume: +r[5], closeTime: r[6], quoteVolume: +r[7],
  }));
}

// ---------- DEMO data (random walk with trends) ----------
const demoState = {};
const DEMO_BASE = {
  BTCUSDT: 92000, ETHUSDT: 3100, SOLUSDT: 165, XRPUSDT: 2.2, DOGEUSDT: 0.18,
  ADAUSDT: 0.62, TRXUSDT: 0.29, SHIBUSDT: 0.000014, PEPEUSDT: 0.0000095,
  HBARUSDT: 0.21, XLMUSDT: 0.31, SUIUSDT: 0.95, WIFUSDT: 0.74, BONKUSDT: 0.000021,
  FLOKIUSDT: 0.00009, SEIUSDT: 0.33,
};
const INTERVAL_MS = { '15m': 9e5, '1h': 36e5, '4h': 144e5 };

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function demoKlines(symbol, interval, limit) {
  const key = symbol + interval;
  const step = INTERVAL_MS[interval];
  const now = Date.now();
  const endOpen = Math.floor(now / step) * step;
  if (!demoState[key]) {
    const rnd = seeded([...key].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
    const base = DEMO_BASE[symbol] || 1;
    const vol = interval === '15m' ? 0.004 : interval === '1h' ? 0.008 : 0.016;
    const drift = (rnd() - 0.5) * vol * 0.6;
    let price = base * (1 - drift * 150);
    const candles = [];
    for (let i = 1100; i > 0; i--) {
      const open = price;
      const wave = Math.sin(i / 9) * vol * 0.6;
      const close = open * (1 + drift + wave * 0.3 + (rnd() - 0.5) * vol * 2);
      const high = Math.max(open, close) * (1 + rnd() * vol);
      const low = Math.min(open, close) * (1 - rnd() * vol);
      const volume = 1000 + rnd() * 2000;
      candles.push({ openTime: endOpen - i * step, open, high, low, close, volume, closeTime: endOpen - i * step + step - 1, quoteVolume: volume * close });
      price = close;
    }
    demoState[key] = { candles, rnd, vol, drift };
  }
  const st = demoState[key];
  // advance the "live" candle a bit each call so the demo moves
  const c = st.candles[st.candles.length - 1];
  c.close = c.close * (1 + (st.rnd() - 0.5) * st.vol);
  c.high = Math.max(c.high, c.close);
  c.low = Math.min(c.low, c.close);
  return st.candles.slice(-limit).map(x => ({ ...x }));
}

// ---------- Public API ----------
// DEMO: build 15m candles from the 1h series so both timeframes agree.
function demo15m(symbol, limit) {
  const h = demoKlines(symbol, '1h', Math.ceil(limit / 4) + 1);
  const out = [];
  for (const c of h) {
    for (let q = 0; q < 4; q++) {
      const o = c.open + (c.close - c.open) * (q / 4), cl = c.open + (c.close - c.open) * ((q + 1) / 4);
      const wig = (c.high - c.low) * 0.25;
      out.push({ openTime: c.openTime + q * 9e5, closeTime: c.openTime + (q + 1) * 9e5 - 1, open: o, close: cl,
        high: Math.min(c.high, Math.max(o, cl) + wig), low: Math.max(c.low, Math.min(o, cl) - wig), volume: c.volume / 4, quoteVolume: c.quoteVolume / 4 });
    }
  }
  const lastC = out[out.length - 1];
  lastC.close = h[h.length - 1].close;
  return out.filter(c => c.openTime <= Date.now()).slice(-limit);
}

async function klines(symbol, interval, limit = 200) {
  if (config.demo) return interval === '15m' ? demo15m(symbol, limit) : demoKlines(symbol, interval, limit);
  return parseKlines(await getJson(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`));
}

// 24h stats for a list of symbols
async function tickers24h(symbols) {
  if (config.demo) {
    const out = {};
    for (const s of symbols) {
      const k = demoKlines(s, '1h', 25);
      const open = k[0].close, close = k[k.length - 1].close;
      out[s] = { lastPrice: close, changePct: ((close - open) / open) * 100, quoteVolume: k.reduce((a, c) => a + c.quoteVolume, 0) * 5000 };
    }
    return out;
  }
  const param = encodeURIComponent(JSON.stringify(symbols));
  const rows = await getJson(`/api/v3/ticker/24hr?symbols=${param}`);
  const out = {};
  for (const r of rows) out[r.symbol] = { lastPrice: +r.lastPrice, changePct: +r.priceChangePercent, quoteVolume: +r.quoteVolume };
  return out;
}

// Discover coins to add automatically:
//  cheap = low price per coin but heavily traded
//  hot   = biggest 24h movers (up or down) that still have real volume
async function discoverCoins() {
  if (config.demo) {
    return {
      cheap: ['SHIBUSDT', 'PEPEUSDT', 'HBARUSDT', 'XLMUSDT', 'BONKUSDT', 'FLOKIUSDT'].slice(0, config.cheapTopN),
      hot: ['SUIUSDT', 'WIFUSDT', 'SEIUSDT'].slice(0, config.hotTopN),
    };
  }
  const rows = (await getJson('/api/v3/ticker/24hr'))
    .filter(r => r.symbol.endsWith('USDT'))
    .filter(r => {
      const base = r.symbol.slice(0, -4);
      return !STABLES.has(base) && !/(UP|DOWN|BULL|BEAR)$/.test(base);
    })
    .map(r => ({ symbol: r.symbol, price: +r.lastPrice, vol: +r.quoteVolume, change: +r.priceChangePercent, count: +r.count }))
    .filter(r => r.price > 0 && r.count > 0);

  const cheap = config.scanCheap ? rows
    .filter(r => r.price <= config.cheapMaxPrice && r.vol >= config.cheapMinVolumeUsd)
    .sort((a, b) => b.vol - a.vol).slice(0, config.cheapTopN).map(r => r.symbol) : [];
  const hot = config.scanHot ? rows
    .filter(r => r.vol >= config.hotMinVolumeUsd)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, config.hotTopN).map(r => r.symbol) : [];
  return { cheap, hot };
}

module.exports = { klines, tickers24h, discoverCoins };
