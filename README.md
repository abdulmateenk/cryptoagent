# Crypto Watch Portal

Your own market-watch agent with a browser portal. It runs 24/7 on a server and:

- scans major coins, **hot coins** (today's biggest movers) and **cheap high-volume coins** every 5 minutes
- runs **4 strategies** on every coin: Trend pullback, Volume breakout, Range bounce, MACD momentum
- **benchmarks before every signal**: backtests the strategy on that coin's last ~40 days with the exact same
  stop/targets, then runs risk checks (backtest win rate, avg result, profit factor, strategies agree,
  Bitcoin direction, liquidity, volatility, not chasing, RSI, price still near entry, max open trades).
  A signal is sent **only if everything passes**
- every signal asks you **I took it / Skip**. No answer by the enter-by time = **Not taken**, but the agent
  keeps tracking it to the end, so you see **Agent accuracy** (all signals), **Your results** (trades you took)
  and **Missed wins** (good trades you didn't take)
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

### Option V - Vercel (free) - already set up for this repo
Vercel is "serverless": it only runs code during a request, then freezes it. So this repo includes:
- `vercel.json` - runs the agent in **Singapore** (Binance blocks US servers) and routes everything to it
- a **GitHub Actions timer** (`.github/workflows/agent-timer.yml`) that wakes the agent every 5 minutes
- support for **Upstash Redis** storage so your trades survive restarts

One-time setup (5 minutes):
1. Vercel dashboard → your **cryptoagent** project → **Storage** → **Create / Connect** → **Upstash for Redis** (free plan)
   → connect it to this project. (This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.)
2. Project → **Settings → Environment Variables** → add `PORTAL_PASSWORD` (and Telegram, risk settings if you like).
3. **Deployments → Redeploy** the latest deployment.
4. GitHub → this repo → **Actions** tab → enable workflows if asked → open **Agent timer** → **Run workflow** once.
   If it can't find your site, add the repo variable `AGENT_URL` = your Vercel address
   (Settings → Secrets and variables → Actions → Variables).
5. Open your Vercel address. The top-left should show "Last scan HH:MM · next HH:MM".

Notes: GitHub's timer can run a few minutes late at busy times - that's normal. While the portal is open it
also wakes the agent every minute. GitHub pauses scheduled timers in repos with no activity for 60 days -
just re-enable it in the Actions tab if that happens.

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

## 3. Keep it running when your browser / PC is closed

The agent runs **on the server**, not in your browser. The portal is just a window into it.
Close the browser, turn off your PC - the server keeps scanning, tracking and sending Telegram alerts.
You only need the server process to stay up:

- **pm2** (plain server): `npm i -g pm2 && pm2 start server.js --name cryptoagent && pm2 save && pm2 startup`
  (restarts automatically after crashes and reboots)
- **Docker**: `--restart=always` (already in the command above)
- **Railway / Render (paid plan)**: always on by default

Do NOT run it on your own laptop if you want 24/7 - when the laptop sleeps, the agent sleeps.

## 4. Turn on alerts

- **Browser:** open the portal → click **🔔 Enable alerts** → Allow. Works while the portal tab is open.
- **Telegram (recommended, works even when the portal is closed):**
  1. In Telegram, message **@BotFather** → `/newbot` → copy the token → `TELEGRAM_BOT_TOKEN`.
  2. Send any message to your new bot, then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `"chat":{"id": ...}` → `TELEGRAM_CHAT_ID`.
  3. Restart the app and press **Test alert** in the portal.

## 5. How to use a trade card

| Field | Meaning |
|---|---|
| Buy zone / Short zone | Enter only while price is inside this range |
| Enter by | If the price hasn't been in the zone by this time, skip the trade |
| Stop-loss | Place it **immediately** when you enter. Never move it further away |
| Target 1 | Sell **half** here, then move stop-loss to your entry price |
| Target 2 | Close the rest |
| Close by | If neither target nor stop is hit by now, close the trade |
| Leverage / margin | Use **isolated** margin with this leverage and margin |
| Pre-trade analysis | The strategy's backtest on this coin + every risk check |
| I took it / Skip | Tell the agent what you did. No reply by enter-by = "Not taken" (still tracked) |
| I closed it | You closed early; your result is saved, the agent keeps tracking for accuracy |

LONG = buy (spot or futures). SHORT needs futures/margin; skip shorts if your app is spot-only
(or set `ALLOW_SHORTS=false`).

## 6. Your apps

- **Binance:** signals use Binance prices, so they match directly.
- **Fasset / other apps:** prices can differ slightly; check the zone on your app before entering, and only trade coins your app lists.
- **KTrade** is a stock broker, so these crypto signals don't apply there.
- **IQ Option** is an offshore CFD/options platform, not a PVARA-licensed crypto exchange. Be very careful there.

## 7. Settings

All settings are in `.env.example`: account size, risk per trade, max leverage, coins,
scan speed, entry window and close-by time.

## Honest notes

- No strategy wins every time. Expect losing trades. The system is built so that wins
  (+1.5R / +2.5R) are bigger than losses (-1R), and the history table shows your real results.
- Watch the win rate for a couple of weeks (or paper-trade) before using real money.
- Keep leverage low. Higher leverage doesn't make the analysis better; it only makes losses faster.
