// Alerts: live browser events (handled by the portal) + optional Telegram.
const config = require('./config');
const { bus, addUpdate } = require('./store');

function fmt(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toFixed(d);
}

const TZ = process.env.TIMEZONE || 'Asia/Karachi';
function pkt(ts) {
  return new Date(ts).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function telegram(text) {
  if (!config.telegramToken || !config.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) { console.error('telegram failed', e.message); }
}

function newSignal(sig) {
  const s = sig.setup;
  const coin = sig.symbol.replace('USDT', '');
  const title = `${sig.side === 'LONG' ? '🟢 LONG' : '🔴 SHORT'} ${coin}/USDT · ${sig.confidence}%`;
  const bt = sig.strategy && sig.strategy.bt;
  const body =
    `Entry zone: ${fmt(s.entryLow)} - ${fmt(s.entryHigh)} (enter by ${pkt(sig.entryUntil)})\n` +
    `Stop-loss: ${fmt(s.stop)} (-${s.stopPct.toFixed(2)}%)\n` +
    `TP1: ${fmt(s.tp1)}  ·  TP2: ${fmt(s.tp2)}\n` +
    `Leverage: ${s.leverage}x isolated · Margin ≈ $${s.margin.toFixed(2)} · Risk ≈ $${s.riskUsd.toFixed(2)}\n` +
    `Close by: ${pkt(sig.closeBy)}` +
    (bt ? `\nStrategy: ${sig.strategy.name} · backtest ${bt.trades} trades, ${bt.winRate.toFixed(0)}% wins, ${bt.avgR >= 0 ? '+' : ''}${bt.avgR.toFixed(2)}R avg` : '');
  const a = { type: 'new', title, body, id: sig.id, symbol: sig.symbol };
  addUpdate(a);
  bus.emit('alert', a);
  telegram(`<b>${title}</b>\n${body}\n\nOpen the portal and press <b>I took it</b> or <b>Skip</b>. No reply = "Not taken" (still tracked).\nSell half at TP1, then move stop to entry. Not financial advice.`);
}

function update(sig, what) {
  const coin = sig.symbol.replace('USDT', '');
  const notTaken = sig.userAction === 'missed' || sig.userAction === 'skipped';
  const pre = notTaken ? `(not taken) ` : '';
  const map = notTaken ? {
    tp1: `${pre}${coin} reached TP1`,
    tp2: `${pre}${coin} would have hit TP2 ✓`,
    stop: `${pre}${coin} would have hit stop-loss`,
    breakeven: `${pre}${coin} TP1 then back to entry - would have been a small win`,
    expired: `${pre}${coin} time ended`,
  } : {
    tp1: `✅ ${coin} hit TP1 - take half profit, move stop to entry`,
    tp2: `🏆 ${coin} hit TP2 - trade closed in profit`,
    stop: `⛔ ${coin} hit stop-loss - trade closed`,
    breakeven: `➖ ${coin} back to entry after TP1 - 2nd half closed at entry`,
    expired: `⌛ ${coin} reached close-by time - close it now if still open`,
  };
  map.missed = `⏰ ${coin} marked "Not taken" - no response by the enter-by time. The agent keeps tracking it.`;
  const title = map[what] || `${coin} update`;
  const body = sig.status === 'closed' && sig.resultR !== undefined
    ? `${notTaken ? 'Would have been' : 'Result'}: ${sig.resultR >= 0 ? '+' : ''}${sig.resultR.toFixed(2)}R (≈ ${sig.resultUsd >= 0 ? '+' : '-'}$${Math.abs(sig.resultUsd).toFixed(2)})`
    : `Price: ${fmt(sig.lastPrice)}`;
  const a = { type: what, title, body, id: sig.id, symbol: sig.symbol };
  addUpdate(a);
  bus.emit('alert', a);
  // Keep Telegram quiet for trades you didn't take, except the final result
  if (!notTaken || sig.status === 'closed' || what === 'missed') telegram(`<b>${title}</b>\n${body}`);
}

module.exports = { newSignal, update, telegram };
