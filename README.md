# Crypto Watch Portal

Your own market-watch agent with a browser portal. It runs 24/7 on a server and:

- scans major coins, **hot coins** (today's biggest movers) and **cheap high-volume coins** every 5 minutes
- uses EMA trend, RSI, ATR, **OBV** and volume to find short-term **LONG** and **SHORT** setups
- shows each trade in the **New Trades** sidebar with: buy zone (from price → to price), stop-loss, 2 targets, leverage, margin, max loss, **enter-by time** and **close-by time**
- tracks every trade live and posts to the **Updates** tab when a target or stop is hit
- shows **TradingView charts** (EMA, RSI, OBV) for any coin you click
- alerts you with browser notifications, a sound and, optionally, **Telegram**

> It gives analysis only. **You** place trades on your app. No exchange keys are needed or used.

---

## 1. Try it on your computer first (2 minutes)

Install Node.js 18+ from nodejs.org, then in this folder:

```bash
npm install
npm run demo        # simulated prices, sample trades
# open http://localhost:3000
```

For live Binance prices: `npm start`

## 2. Deploy online (pick one)

The agent must run all the time, so use hosting that **doesn't sleep**.

### Option A - Railway (easiest, about $5/month)
1. Put this folder in a GitHub repo (private is fine).
2. railway.app → New Project → Deploy from GitHub repo.
3. Variables tab → add the settings from `.env.example` (at least `PORTAL_PASSWORD`).
4. Settings → Networking → Generate Domain. Open it, log in with `admin` + your password.
5. (Optional) Add a Volume mounted at `/app/data` so trade history survives redeploys.

### Option B - Render
New → Web Service → connect the repo. Build: `npm install`, Start: `npm start`.
Use the **Starter** plan; the free plan sleeps after 15 minutes and the agent stops.
Choose the **Singapore or Frankfurt** region.

### Option C - Your own server over HTTP
```bash
git clone https://github.com/abdulmateenk/cryptoagent && cd cryptoagent
cp .env.example .env      # edit your settings
npm install
PORT=80 npm start         # or use pm2: pm2 start server.js --name cryptoagent
```
Open `http://YOUR-SERVER-IP/`. Note: browsers only show pop-up notifications on **https**;
on plain http you still get in-page alerts + sound, and Telegram alerts work everywhere.
A free https certificate (e.g. Caddy or Nginx + Let's Encrypt) fixes that.

### Option D - Any VPS with Docker (DigitalOcean, Hetzner, etc. ~$4-6/month)
```bash
docker build -t crypto-portal .
docker run -d --restart=always -p 80:3000 --env-file .env -v $(pwd)/data:/app/data crypto-portal
```

> Choose a server region outside the USA (e.g. Singapore/Europe). Prices come from
> `data-api.binance.vision` (Binance's public data), which works from most regions.

## 3. Turn on alerts

- **Browser:** open the portal → click **🔔 Enable alerts** → Allow. Works while the portal tab is open.
- **Telegram (recommended, works even when the portal is closed):**
  1. In Telegram, message **@BotFather** → `/newbot` → copy the token → `TELEGRAM_BOT_TOKEN`.
  2. Send any message to your new bot, then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `"chat":{"id": ...}` → `TELEGRAM_CHAT_ID`.
  3. Restart the app and press **Test alert** in the portal.

## 4. How to use a trade card

| Field | Meaning |
|---|---|
| Buy zone / Short zone | Enter only while price is inside this range |
| Enter by | If the price hasn't been in the zone by this time, skip the trade |
| Stop-loss | Place it **immediately** when you enter. Never move it further away |
| Target 1 | Sell **half** here, then move stop-loss to your entry price |
| Target 2 | Close the rest |
| Close by | If neither target nor stop is hit by now, close the trade |
| Leverage / margin | Use **isolated** margin with this leverage and margin |

LONG = buy (spot or futures). SHORT needs futures/margin; skip shorts if your app is spot-only
(or set `ALLOW_SHORTS=false`).

## 5. Your apps

- **Binance:** signals use Binance prices, so they match directly.
- **Fasset / other apps:** prices can differ slightly; check the zone on your app before entering, and only trade coins your app lists.
- **KTrade** is a stock broker, so these crypto signals don't apply there.
- **IQ Option** is an offshore CFD/options platform, not a PVARA-licensed crypto exchange. Be very careful there.

## 6. Settings

All settings are in `.env.example`: account size, risk per trade, max leverage, coins,
scan speed, entry window and close-by time.

## Honest notes

- No strategy wins every time. Expect losing trades. The system is built so that wins
  (+1.5R / +2.5R) are bigger than losses (-1R), and the history table shows your real results.
- Watch the win rate for a couple of weeks (or paper-trade) before using real money.
- Keep leverage low. Higher leverage doesn't make the analysis better; it only makes losses faster.
