# AGENTS.md — Sports Terminal v5.32

Always run commands from repo root `C:\Users\bobby\sportsterminal\` (not a subdirectory).

## Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Hot-reload dev server (backend + WebSocket) |
| `bun run start` | Production server |
| `bun run build` | Build backend to `backend/dist/` |
| `bun run serve` | Static frontend-only server on port 3001 |
| `bun run db:reset` | Delete SQLite DB (recreated on next dev start) |
| `bun run db:migrate` | Run SQLite migrations |
| `bun run stop` | Kill stale process on port 3000 |
| `bun run status` | Show port usage and Bun processes |
| `bun run clean-start` | Stop + dev in one command |
| `bun run dev:port 3001` | Dev on custom port |
| `bun test` | All backend tests |
| `bun test backend/tests/<file>.test.ts` | Single test file |
| `bun run --cwd backend lint` | ESLint (allows 500 warnings) |
| `bun run --cwd backend lint:strict` | ESLint (allows 50 warnings) |
| `bun run --cwd backend typecheck` | `tsc --noEmit` check |

**After editing backend code, always run:** `bun run --cwd backend typecheck && bun run --cwd backend lint`

## Architecture

Monorepo with one Bun workspace (`backend`). Frontend is a static SPA in `frontend/public/` — no build step, served directly by the backend.

**Default port is 3000** (not 3002). Configured in `backend/.env` or defaults in `backend/src/config/env.ts`.

### Backend `backend/src/`

```
index.ts              Bun HTTP server + WebSocket (/ws) + static serving
database.ts           Bun.SQL SQLite wrapper, schema init, migrations
config/env.ts         loadEnv() — validates PORT, JWT_SECRET, BUCKEYE_BASE_URL
api/
  router.ts           UrlPatternRouter — all /api/* routes registered here
  UrlPatternRouter.ts Custom URLPattern-based router
  routes/             Handler modules per domain (16 files)
  middleware/          auth.ts, apiLogger.ts
  rateLimiter.ts      Per-IP rate limiting
  helpers.ts           corsHeaders, requireAdminTokenIfConfigured
scrapers/
  BuckeyeAPI.ts       HTTP client for fantasy402.com (~2400 lines)
  ScraperManager.ts   Always-on polling lifecycle, backoff, vault restore
actions/ActionQueue.ts Per-agent action sequencing
auth/jwt.ts            HS256 JWT create/verify, dev bypass
services/
  BunSecretVault.ts      OS vault per-agent secret storage
  BuckeyeVaultRestore.ts Startup restore for vaulted agents
  PerformanceCache.ts    Redis-backed cache (optional)
  Scheduler.ts           Managed recurring jobs via Bun.sleep
  RawApiLogger.ts        Raw API call logging
  WebhookService.ts      Discord/Slack/Telegram/Generic
  CrossReferenceService.ts  Player cross-reference
  GeoIpService.ts           Geo-IP enrichment
  HierarchyBackfillService.ts Hierarchy backfill
odds/                  OddsPoller + providers (DemoOddsProvider, TheOddsApiProvider)
patterns/             Pattern detection and persistence
player360/            Player 360 deep-dive logic
risk/AlertEngine.ts   Alert detection rules
types/                 Shared TypeScript interfaces
utils/                 Shared utilities
```

### Backend tsconfig — strict mode

`backend/tsconfig.json` enables `strict`, `noImplicitAny`, `strictNullChecks`. The root tsconfig has `strict: false` but only covers root-level `.ts` files (proxy scripts), **not** backend code.

Path alias: `@/*` maps to `./src/*` in backend — use `import { X } from '@/services/BunSecretVault'`.

### Key dependencies

- **Bun runtime** v1.3.13+ (no Node required)
- **zod** — request/response validation in routes
- **jose** — JWT signing/verification
- **fast-geoip** — IP geolocation enrichment
- **Bun.SQL** — built-in SQLite (no external package)

## Critical Conventions

### Amount units (don't get this wrong)
- **Buckeye API returns cents** — `AmountWagered: 2500` = $25.00
- **Backend normalizes** in `BuckeyeAPI.normalizeWager()` (divide by 100)
- **Database stores dollars** — all SQL queries operate on dollar amounts
- **Frontend displays dollars** directly — no further conversion

### Authentication flow
1. Frontend sends `auth` WS message with `agentId`, `password`, `cfCookie`
2. Backend `BuckeyeAPI.login()` POSTs to `/cloud/api/System/authenticateCustomer`
3. Receives JWT → starts polling `getBetTicker` every 5s
4. Token returned to frontend → `localStorage` for resume
5. Auto-reconnects on refresh (token ~10 min valid)

### Cloudflare
- `cf_clearance` cookie is **mandatory** for fantasy402.com access
- User copies from browser DevTools → Settings → stored in `BunSecretVault`
- Cookie expires 30 min – 2 hrs; backend sends on every request

### Polling & resilience
- Normal: 5s. Exponential backoff: 5→10→20→40→max 60s
- Token renewal: every 15 min
- Max 3 re-login attempts, then `auth_failed` broadcast and stop

### Environment constraints
- `NODE_ENV=production` enables JWT auth + rate limiting; `development` bypasses both
- `JWT_SECRET` must be 32+ chars in production (checked at startup in `config/env.ts`)
- `DATABASE_URL` supports SQLite (`sqlite:./data/terminal.db`) or Postgres (`postgres://...`)
- `ADMIN_API_TOKEN` — optional, guards sensitive mutations when set
- `REDIS_URL` — optional, enables performance caching + pub/sub

## Where to find things

- **All API routes**: `backend/src/api/router.ts` — 80+ routes via `UrlPatternRouter`
- **Route handlers**: `backend/src/api/routes/` — one file per domain
- **Frontend entry**: `frontend/public/index.html` → `js/app.js`
- **Frontend WS**: `frontend/public/js/ws-client.js`
- **Database schema**: `backend/src/database.ts` — all table definitions and migrations
- **Buckeye API client**: `backend/src/scrapers/BuckeyeAPI.ts` — auth, wager, access-log, performance calls
- **Env validation**: `backend/src/config/env.ts` — all env vars and their constraints

## Testing

Tests in `backend/tests/*.test.ts`. Run from repo root with `bun test`.

Test files: `actionQueue`, `api`, `auth`, `health`, `odds`, `patterns`, `performance`, `players`, `proxy-enhanced-config`, `rateLimiter`, `raw-api-logger`, `router`, `scheduler`, `webhook`.

Database tests use `:memory:` SQLite. No external services required.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port 3000 in use | `bun run stop` then `bun run dev` |
| Multiple Bun processes | `bun run status` then `bun run stop` or `taskkill /F /IM bun.exe` |
| Stale deps | Delete `node_modules` + `backend/node_modules`, then `bun install` |
| Verify backend running | `Invoke-RestMethod http://localhost:3000/health` |
| Buckeye login fails | Fresh `cf_clearance` cookie, confirm `BUCKEYE_BASE_URL`, check vault status |
| Odds grid empty | Demo odds auto-activate; live data requires Buckeye auth or `ODDS_API_KEY` |

## Security reminders

- Never commit `backend/.env`, `backend/data/`, or raw Buckeye export files
- `Bun.secrets` stores passwords/tokens; vault-status endpoint returns only presence flags
- `DELETE /api/buckeye/vault-status?agentId=...` clears one agent; `all=1` clears all
- `bunfig.toml` enables OSV install-time security scanner