// All settings come from environment variables (see .env.example).
function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function list(name, def) {
  const v = process.env[name];
  if (!v) return def;
  return v.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

const config = {
  port: num('PORT', 3000),
  demo: bool('DEMO', false),

  // Market data source. data-api.binance.vision is Binance's public market-data
  // mirror and works from most server regions (api.binance.com blocks some, e.g. US).
  binanceBase: process.env.BINANCE_BASE || 'https://data-api.binance.vision',

  // Core coins always watched (USDT pairs).
  watchlist: list('WATCHLIST', ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'TRXUSDT']),

  // Auto-add cheap but heavily traded coins.
  scanCheap: bool('SCAN_CHEAP', true),
  cheapMaxPrice: num('CHEAP_MAX_PRICE', 1),           // USD per coin
  cheapMinVolumeUsd: num('CHEAP_MIN_VOLUME_USD', 20_000_000), // 24h quote volume
  cheapTopN: num('CHEAP_TOP_N', 8),

  // Auto-add "hot" coins: today's biggest movers (up or down) with real volume.
  scanHot: bool('SCAN_HOT', true),
  hotMinVolumeUsd: num('HOT_MIN_VOLUME_USD', 30_000_000),
  hotTopN: num('HOT_TOP_N', 10),

  scanIntervalMin: num('SCAN_INTERVAL_MIN', 5),
  entryWindowHours: num('ENTRY_WINDOW_HOURS', 2),   // how long a setup stays valid to enter

  // Risk settings
  accountUsd: num('ACCOUNT_USD', 100),
  riskPerTradeUsd: num('RISK_PER_TRADE_USD', 2),  // max loss if stop-loss is hit
  maxLeverage: num('MAX_LEVERAGE', 3),
  maxStopPct: num('MAX_STOP_PCT', 4),             // skip setups needing a wider stop
  allowShorts: bool('ALLOW_SHORTS', true),
  minConfidence: num('MIN_CONFIDENCE', 60),
  signalExpiryHours: num('SIGNAL_EXPIRY_HOURS', 12),  // close-by time for short-term trades
  cooldownHours: num('COOLDOWN_HOURS', 4),

  // Optional Telegram alerts (works even when the portal tab is closed)
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // Optional password protection for the portal
  portalUser: process.env.PORTAL_USER || 'admin',
  portalPassword: process.env.PORTAL_PASSWORD || '',

  dataFile: process.env.DATA_FILE || 'data/state.json',
};

module.exports = config;
