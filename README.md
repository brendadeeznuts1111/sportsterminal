# Sports Terminal v5.2

Sports Terminal is a Bun-powered betting operations terminal for Buckeye PPH live wager monitoring, 16-book odds comparison, exposure tracking, player drill-downs, alerts, and webhook delivery.

The app is intentionally simple to run locally: one Bun backend serves both the API/WebSocket layer and the single-file frontend at `http://localhost:3000/`.

## Current Status

Implemented:

- Buckeye live wager API client for `fantasy402.com`
- WebSocket auth/session flow with token resume
- Cloudflare `cf_clearance` cookie support from the Settings UI
- Bun native SQLite via `bun:sqlite`
- Demo odds grid with 16 books, consensus, best-line highlighting, movements, and book health
- Buckeye wager feed, agent downline, player search/detail, sport and agent exposure
- Alert rules, alert history, toast toggle, webhook CRUD, retries, and delivery log
- Static SPA served by the backend

Partial or planned:

- Patterns tab has demo UI plus backend steam/reverse-line detection plumbing, but no persistent pattern history or rules engine yet.
- Polymarket, Kalshi, Ace Per Head, Metallic, heatmap, candlestick, and bet builder are placeholders.
- Live odds require `ODDS_API_KEY`; otherwise the demo provider is used.

## Requirements

- Bun `1.3.13+`
- Windows PowerShell or another shell that can run Bun
- Buckeye credentials and a fresh `cf_clearance` cookie for live Buckeye polling

No Node install, Python, Chrome, Puppeteer, or external SQLite package is required for normal local development.

## Quick Start

From the repo root:

```powershell
cd C:\Users\bobby\sportsterminal
bun install
bun run dev
```

Open:

```text
http://localhost:3000/
```

The backend serves:

- Frontend: `GET /`
- Health: `GET /health`
- API routes: `GET /api/...`
- WebSocket: same host, upgraded automatically by the frontend

## Environment

Copy the example file when you need local overrides:

```powershell
Copy-Item backend\.env.example backend\.env
```

Common values:

```env
PORT=3000
HOST=0.0.0.0
DEBUG=false
BUCKEYE_BASE_URL=https://fantasy402.com
POLL_INTERVAL_MS=5000
TOKEN_RENEWAL_MINUTES=15
JWT_SECRET=change-me-in-production-min-32-chars
DATABASE_URL=sqlite:./data/terminal.db
```

`DATABASE_URL` can be either `sqlite:./data/terminal.db` or `./data/terminal.db`; the backend normalizes both for Bun SQLite.

Credentials can be entered in the Settings UI. The backend does not require Buckeye credentials to boot; it starts with demo odds and empty live wager data until a Buckeye connection is made.

## Scripts

Run from `C:\Users\bobby\sportsterminal`:

```powershell
bun run dev          # Hot-reload backend + frontend at http://localhost:3000/
bun run start        # Production-style backend start
bun test             # All backend tests
bun run build        # Bundle backend to backend/dist/
bun run status       # Show port usage and Bun processes
bun run stop         # Stop the process listening on port 3000
bun run clean-start  # Stop then start dev server
bun run serve        # Optional static frontend-only server on port 3001
bun run db:migrate   # Run SQLite migrations
```

`bun run serve` is optional. It serves only static files from `frontend/public`; the normal app path is `bun run dev`.

## Local Verification

```powershell
bun test
bun run build
Invoke-RestMethod http://localhost:3000/health
```

Expected health shape:

```json
{
  "status": "ok",
  "scrapers": {
    "activeAgents": 0,
    "agents": []
  }
}
```

## UI Map

### Trading

- `Trading Floor`: 16-book odds grid with consensus, best-line highlighting, spread/total prices, movement arrows, pattern icons, detail drawers, and book settings.
- `Patterns`: Demo pattern rows and simulate button; real persistence/rules engine is still pending.

### Positions

- `Positions`: Sport and agent exposure breakdowns from Buckeye wager data, with sortable tables and recent positions.

### PPH Books

- `Buckeye`: Live `getBetTicker` feed, wager filters, stats cards, agent/sport/game panels, and alert badges.
- `Ace Per Head`: Placeholder.
- `Metallic`: Placeholder.

### Agent Network

- `Agent Tree`: Visual hierarchy canvas using live hierarchy when available, with local ignored export fallback.
- `Downline`: Agent hierarchy stats, sortable agent table, customer drill-down, volume/risk/alert summaries.
- `Player Search`: Search by login and open player details.
- `Player Detail`: Stats, 7-day P&L bars, wager breakdown, and recent wagers.

### Exchanges

- `Polymarket`: Placeholder.
- `Kalshi`: Placeholder.

### System

- `Alerts`: Alert history, severity badges, acknowledged filtering, and toast toggle.
- `Webhooks`: Discord, Slack, Telegram, and generic webhook CRUD with trigger filters and delivery logs.
- `Settings`: Backend URL, Buckeye base URL, agent credentials, Cloudflare cookie, auto-connect, connection test, and connect/disconnect controls.

### Coming Soon

- Movement Heatmap
- Candlestick Charts
- Bet Builder

## Backend Architecture

```text
backend/
  src/
    index.ts              Bun HTTP server, API routes, WebSocket upgrade, static frontend serving
    database.ts           Bun SQLite wrapper, schema init, migrations, credential encryption helpers
    scrapers/
      BuckeyeAPI.ts       HTTP client for fantasy402.com auth/getBetTicker/renewToken
      ScraperManager.ts   Agent polling lifecycle, backoff, DB persistence, exposure queries
    odds/
      OddsPoller.ts       Demo/live odds polling, persistence, movements, matrix views
      providers/
        DemoOddsProvider.ts
        TheOddsApiProvider.ts
    risk/
      AlertEngine.ts      Wager alert detection rules
    services/
      WebhookService.ts   Webhook CRUD, payload formatting, retry, delivery logging
  tests/
    api.test.ts
    odds.test.ts
    webhook.test.ts
```

The project uses a root Bun workspace lockfile: `bun.lock`.

## API Highlights

Health and metrics:

- `GET /health`
- `GET /metrics`

Buckeye and exposure:

- `GET /api/stats`
- `GET /api/wagers`
- `GET /api/wagers/alerts`
- `GET /api/wagers/live`
- `GET /api/agents`
- `GET /api/agents/downline`
- `GET /api/agents/hierarchy`
- `GET /api/exposure/sports`
- `GET /api/exposure/agents`
- `POST /api/connect`

Odds:

- `GET /api/odds/live`
- `GET /api/odds/events`
- `GET /api/odds/snapshots`
- `GET /api/odds/movements`
- `GET /api/books`
- `GET /api/books/status`

Webhooks:

- `GET /api/webhooks`
- `POST /api/webhooks`
- `GET /api/webhooks/:id`
- `PUT /api/webhooks/:id`
- `DELETE /api/webhooks/:id`
- `GET /api/webhooks/:id/deliveries`

## Data Notes

- Buckeye amount fields arrive in cents.
- `BuckeyeAPI.normalizeWager()` converts wager amounts to dollars before persistence.
- SQLite stores dollar values.
- Frontend displays dollar values directly.
- Local database lives at `backend/data/terminal.db` and is ignored by Git.

Ignored local data/tools:

- `backend/data/`
- `backend/dist/`
- `node_modules/`
- `backend/node_modules/`
- `docs/agentslistharz.md`
- `docs/agentobject.md`
- `docs/*.exe`

The ignored docs exports may contain sensitive customer/agent data and should not be committed.

## Troubleshooting

### App does not open locally

Check server status:

```powershell
bun run status
```

Start fresh:

```powershell
bun run clean-start
```

Then open `http://localhost:3000/`.

### Port 3000 is already in use

```powershell
bun run stop
bun run dev
```

### Dependencies look stale

```powershell
Remove-Item -Recurse -Force node_modules, backend\node_modules -ErrorAction SilentlyContinue
bun install
```

### Buckeye login fails

- Confirm agent ID and password.
- Paste a fresh `cf_clearance` cookie into Settings.
- Confirm `BUCKEYE_BASE_URL=https://fantasy402.com`.
- Enable `DEBUG=true` for verbose backend logging.

### Odds grid works but Buckeye data is empty

That is expected before connecting Buckeye. Demo odds run automatically; live wager data appears after Buckeye auth starts polling.

## GitHub

Remote:

```text
origin https://github.com/brendadeeznuts1111/sportsterminal.git
```

Main branch:

```text
main
```

## License

Private / proprietary.
