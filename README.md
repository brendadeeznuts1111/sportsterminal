# Sports Terminal v5.32

Sports Terminal is a Bun-powered betting operations terminal for Buckeye PPH live wager ingestion, agent/player intelligence, pattern detection, odds comparison, exposure tracking, alerts, webhooks, and backend health monitoring.

The app runs as one Bun backend that serves the API, WebSocket, always-on ingestion loops, and the static SPA frontend at `http://localhost:3000/`.

Frontend development now uses a small static module layout: `frontend/public/index.html` is the shell, `frontend/public/css/terminal.css` holds shared styling, and `frontend/public/js/app.js` coordinates focused modules such as WebSocket, API, Buckeye, Performance, navigation, and settings.

## Current Status

Implemented:

- Always-on Buckeye ingestion for every vaulted agent while the backend process is running.
- OS vault credential storage through `Bun.secrets`, with per-agent logout and a vault status endpoint.
- Buckeye live wager polling, token renewal, access-log ingestion, performance snapshots, sports type seeding, checkpoints, and startup restore.
- Bun SQL backed SQLite persistence through the app database wrapper.
- Managed scheduler loops based on `Bun.sleep`; `Bun.scheduler` is not available in the current Bun 1.3.13 runtime.
- Pattern detection and history for odds, wagers, agents, IP, live timing, and feed risk.
- Odds grid with 16 books, consensus, best-line highlighting, movements, and book health when a live odds provider is configured.
- Buckeye wager feed, agent downline, hierarchy/player export parsing, player search/detail, sport and agent exposure.
- Alert rules, alert history, toast toggle, webhook CRUD, retry, and delivery logging.
- System Status sidebar page for backend, vault, book, and pattern health.
- Player 360 profile contracts with real API-only hydration, live source coverage, field-level mapping, mismatch tracking, and Status/Docs panels.
- Bun install security scanner configured with `@bun-security-scanner/osv`.

Player 360 data lineage lives in `docs/PLAYER_360_DATA_MAP.md`; the live modal Docs/Status panels render the same contract from `/api/v1/players/:playerId/intelligence-map`.

Partial or planned:

- Real odds require `ODDS_API_KEY`; without it, odds polling is disabled. Synthetic odds require explicit `ODDS_DEMO_MODE=true` and are not used by Buckeye views.
- Polymarket, Kalshi, Ace Per Head, Metallic, heatmap, candlestick, and bet builder remain placeholders.
- The local raw Buckeye exports are intentionally ignored and should be treated as sensitive source material, not app source.

## Requirements

- Bun `1.3.13+`
- Windows PowerShell or another shell that can run Bun
- Buckeye credentials and a fresh `cf_clearance` cookie for live Buckeye polling

No Node install, Puppeteer, Chrome automation, or external SQLite package is required for normal local development.

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
- WebSocket: `/ws`

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
NODE_ENV=development
BUCKEYE_BASE_URL=https://fantasy402.com
POLL_INTERVAL_MS=5000
ACCESS_LOG_INTERVAL_MS=600000
AGENT_PERFORMANCE_INTERVAL_MS=900000
TOKEN_RENEWAL_MINUTES=15
ODDS_POLL_INTERVAL_MS=30000
BOOK_HEALTH_INTERVAL_MS=60000
REDIS_URL=redis://localhost:6379  # Optional; enables performance cache
FRONTEND_PORT=3001                # Optional; used only by bun run serve
JWT_SECRET=change-me-in-production-min-32-chars
DATABASE_URL=sqlite:./data/terminal.db
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000
```

`DATABASE_URL` can be a SQLite URL or path. Examples:

- `sqlite:./data/terminal.db`
- `sqlite://./data/terminal.db`
- `./data/terminal.db`
- `:memory:` for tests

Credentials can be entered in Settings. On successful auth, the backend stores Buckeye secrets in the OS vault and restores them on the next backend start. The frontend should not be the source of truth for long-lived Buckeye credentials.

## Scripts

Run from `C:\Users\bobby\sportsterminal`:

```powershell
bun run dev          # Hot-reload backend + frontend
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
Invoke-RestMethod http://localhost:3000/api/buckeye/vault-status
```

Expected health shape:

```json
{
  "status": "ok",
  "uptime": 123.45,
  "scrapers": {
    "activeAgents": 0,
    "agents": [],
    "actionQueue": { "totalQueued": 0, "queues": {} },
    "counters": {
      "wagers_total": 0,
      "alerts_triggered_total": 0,
      "errors_total": 0
    }
  }
}
```

## Enhanced Proxy

The main app backend owns normal Sports Terminal ingestion. For isolated Buckeye proxy work, use the standalone enhanced proxy entrypoint:

```powershell
bun run enhanced-proxy.ts
```

It starts on `PROXY_PORT` (default `3001`) and uses `DB_PATH` (default `buckeye_cache.sqlite`). Runtime configuration is visible at:

- `GET /features` — active feature flags and tunables
- `GET /metrics` — Bun/process/JSC metrics when `ENABLE_METRICS=true`
- `GET /ready` — readiness probe based on stored token state
- `POST /config` — reloads environment-backed config
- `WS /ws` — live Buckeye ticker subscription endpoint

Useful feature flags:

```env
ENABLE_METRICS=true
ENABLE_RESPONSE_COMPRESSION=true
ENABLE_RETRY=true
ENABLE_WS_COMPRESSION=true
ENABLE_PER_CUSTOMER_RATE_LIMIT=true
ENABLE_AUTO_RENEWAL=true
ENABLE_IDEMPOTENCY=true
ENABLE_WS_BATCHING=false
```

Compatibility aliases are supported: `ENABLE_RETRY` maps to the enhanced proxy retry flag, `ENABLE_PER_CUSTOMER_RATE_LIMIT` maps to rate limiting, and `ENABLE_AUTO_RENEWAL` maps to token pre-renewal. The legacy root `proxy.ts` remains ignored local tooling; `enhanced-proxy.ts` is the documented entrypoint.

## Security

- `Bun.secrets` stores backend Buckeye password, token, and Cloudflare cookie presence per vaulted agent.
- The standalone proxy uses `com.sports-terminal.buckeye-proxy` for static proxy secrets (`proxy-admin-key`, Buckeye credentials, Kimi key, and `cf-clearance`), with environment-variable fallback for CI/headless deployments.
- `GET`, `POST`, and `DELETE /api/secrets` manage standalone proxy secrets and require `X-API-Key`.
- The standalone proxy prewarms Buckeye, Kimi, backend, and localhost network targets on startup and exposes DNS/WebSocket pressure stats at `GET /api/agent/network-stats`.
- `bunfig.toml` sets `console.depth = 6` for deeper operator log inspection and `BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS=300` for stable upstream DNS caching.
- Backend-to-proxy bridge calls can opt into Bun's object-style forward proxy with `PROXY_FETCH_PROXY_URL`; `PROXY_FETCH_PROXY_TOKEN` sets `Proxy-Authorization` and falls back to `PROXY_API_KEY`.
- IP surveillance uses persisted Buckeye `getWebLog` evidence plus live lookup endpoints: `GET /api/agent/ip-suspicious` and `GET /api/agent/ip-lookup?ip=...` or `?player=...`. Responses include local GeoIP labels, IP reputation, player timelines, JSON/CSV export via `GET /api/agent/ip-export`, and operator blocking via `POST /api/agent/ip-block`.
- Full weblog ingestion accepts Buckeye log types `A`, `B`, `C`, `I`, and `F`; account changes and failed login bursts are stored in SQLite and can trigger player flags/alerts.
- Configurable agent rules live at `GET/POST/DELETE /api/agent/rules`; the wager loop evaluates shared-IP, CLV beater, failed-login, velocity, and account-change conditions against each new wager.
- `GET /api/buckeye/vault-status` returns presence flags only. It never returns secret values.
- `DELETE /api/buckeye/vault-status?agentId=...` clears one vaulted agent. `all=1` clears all vaulted Buckeye secrets.
- WebSocket connections require a valid HS256 JWT in production mode.
- HTTP endpoints are rate-limited through `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`.
- `bunfig.toml` enables the OSV install-time security scanner.
- `NODE_ENV=development` enables local development bypasses; do not use it for production exposure.

Disconnecting the browser UI does not stop backend ingestion. Manual vault logout is the explicit action that prevents future automatic restore for an agent.

## UI Map

### Trading

- `Trading Floor`: 16-book odds grid with consensus, best-line highlighting, spread/total prices, movement arrows, pattern icons, detail drawers, and book settings.
- `Patterns`: Pattern history, filter chips, score cards, detail evidence, and detection categories for odds, wagers, agents, IP, live, and feed risk.

### Positions

- `Positions`: Sport and agent exposure breakdowns from Buckeye wager data, with sortable tables and recent positions.

### PPH Books

- `Buckeye`: Live `getBetTicker` feed, wager filters, stats cards, agent/sport/game panels, and alert badges.
- `Ace Per Head`: Placeholder.
- `Metallic`: Placeholder.

### Agent Network

- `Agent Tree`: Visual hierarchy canvas using parsed/exported hierarchy data when available.
- `Downline`: Agent hierarchy stats, sortable agent table, customer drill-down, volume/risk/alert summaries.
- `Player Search`: Search by login and open player details.
- `Player Detail`: Stats, 7-day projection bars, wager breakdown, and recent wagers.

### Exchanges

- `Polymarket`: Placeholder.
- `Kalshi`: Placeholder.

### System

- `Alerts`: Alert history, severity badges, acknowledged filtering, and toast toggle.
- `Webhooks`: Discord, Slack, Telegram, and generic webhook CRUD with trigger filters and delivery logs.
- `Settings`: Backend URL, Buckeye base URL, agent credentials, Cloudflare cookie, auto-connect, vault health, and logout controls.
- `Status`: Backend health, vault status, book status, and 24-hour pattern summary.

### Coming Soon

- Movement Heatmap
- Candlestick Charts
- Bet Builder

## Backend Architecture

```text
backend/
  src/
    index.ts                  Bun HTTP server, API routes, WebSocket upgrade, static frontend serving
    database.ts               Bun.SQL SQLite wrapper, schema init, migrations
    config/
      env.ts                  Startup environment validation
    actions/
      ActionQueue.ts          Per-agent action sequencing and timeouts
    api/
      router.ts               API router
      routes/                 Feature route handlers
    scrapers/
      BuckeyeAPI.ts           fantasy402.com auth, wager, access-log, performance, and config client
      ScraperManager.ts       Always-on agent lifecycle, scheduler loops, vault refresh, DB persistence
    services/
      BunSecretVault.ts       OS vault index and per-agent secret storage
      BuckeyeVaultRestore.ts  Startup restore for all vaulted agents
      Scheduler.ts            Managed recurring jobs using Bun.sleep
      WebhookService.ts       Webhook CRUD, payload formatting, retry, delivery logging
    odds/
      OddsPoller.ts           Live odds polling, persistence, movements, matrix views
    patterns/
      PatternService.ts       Pattern persistence, scoring, summary, and agent links
    risk/
      AlertEngine.ts          Wager alert detection rules
  tests/
    *.test.ts
```

The project uses a root Bun workspace lockfile: `bun.lock`.

## API Highlights

Health and metrics:

- `GET /health`
- `GET /metrics`

Buckeye and exposure:

- `POST /api/connect`
- `GET /api/stats`
- `GET /api/wagers`
- `GET /api/wagers/alerts`
- `GET /api/wagers/live`
- `GET /api/agents`
- `GET /api/agents/downline`
- `GET /api/agents/hierarchy`
- `GET /api/buckeye/vault-status`
- `DELETE /api/buckeye/vault-status`
- `GET /api/buckeye/access-logs`
- `GET /api/buckeye/agent-performance`
- `GET /api/buckeye/sports-types`
- `GET /api/buckeye/manager-snapshot`
- `GET /api/exposure/sports`
- `GET /api/exposure/agents`

Patterns:

- `GET /api/patterns/history`
- `GET /api/patterns/summary`
- `GET /api/patterns/agents`

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
- Local database files live under `backend/data/` and are ignored by Git.
- Raw Buckeye export captures are ignored because they can contain sensitive customer/agent material.

Ignored local data/tools:

- `backend/data/`
- `backend/dist/`
- `node_modules/`
- `backend/node_modules/`
- sensitive raw Buckeye export captures
- `docs/*.exe`

## Documentation Map

- `README.md`: current operator/developer quickstart and surface map.
- `docs/IMPLEMENTATION_TRACKER.md`: current delivery status and verification notes.
- `docs/BUCKEYE_BACKEND_SCOPE.md`: Buckeye endpoint, schema, and ingestion contract.
- `docs/DATA_DICTIONARY.md`: env vars, vault keys, source fields, table columns, API names, and WebSocket events.
- `docs/ENTERPRISE_TAB_GOALS.md`: enterprise goals, workflows, and readiness standards for each sidebar tab.
- `docs/AUDIT_ANALYTICS_ENGINE.md`: audit logging, analytics schema, retention, and polling safety contract.
- `docs/PROJECT_ORGANIZATION.md`: where new code, docs, raw exports, and runtime files belong.
- `docs/CHANGELOG.md`: chronological change notes.
- `docs/CODE_QUALITY_CHECKLIST.md`: quick review checks before handoff.

## Troubleshooting

### App does not open locally

```powershell
bun run status
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
- Check `GET /api/buckeye/vault-status` for presence flags.
- Enable `DEBUG=true` for verbose backend logging.

### Odds grid works but Buckeye data is empty

Demo odds run automatically. Live wager data appears after Buckeye auth starts polling or after a vaulted agent is restored on backend startup.

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
