# AGENTS.md — Sports Terminal

Always run commands from repo root `C:\Users\bobby\sportsterminal\` (not a subdirectory).

## Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Hot-reload backend server (port 3000) |
| `bun run start` | Production backend server |
| `bun run build` | Build backend to `backend/dist/` |
| `bun run serve` | Static frontend-only server on port 3001 |
| `bun run proxy:dev` | Hot-reload standalone proxy (port 3001) |
| `bun run proxy:start` | Production proxy |
| `bun run proxy:build` | Compile proxy to `dist/proxy-server` |
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
| `bun run smoke:backend` | Backend smoke tests |
| `bun run smoke:proxy` | Proxy smoke tests |
| `bun run integrity:check` | SQLite integrity checks (wagers, archive, hierarchy) |
| `bun run artifacts:check` | Guard against committing sensitive/local artifacts |
| `bun run generate:openapi` | Generate OpenAPI spec |
| `bun run probe:player360` | Probe player360 contracts |
| `bun run backfill:hierarchy` | Hierarchy backfill script |

**After editing backend code, always run:** `bun run --cwd backend typecheck && bun run --cwd backend lint`

## Architecture

Monorepo with one Bun workspace (`backend`). Frontend is a static SPA in `frontend/public/` — no build step, served directly by the backend. The proxy (`proxy-enhanced.ts`) is a standalone script at repo root, **not** part of the backend workspace and must be run separately.

**Backend port: 3000. Proxy port: 3001** (configurable via `PORT` / `PROXY_PORT`).

### Backend `backend/src/`

```
index.ts              Bun HTTP server + WebSocket (/ws) + static serving
database.ts           Bun.SQL SQLite/Postgres wrapper, schema init, migrations
config/env.ts         loadEnv() — validates PORT, JWT_SECRET, BUCKEYE_BASE_URL
api/
  router.ts           UrlPatternRouter — 105+ route registrations
  UrlPatternRouter.ts Custom URLPattern-based router
  routes/             Handler modules per domain (16 files)
  middleware/         auth.ts, apiLogger.ts
  rateLimiter.ts      Per-IP rate limiting
  helpers.ts          corsHeaders, requireAdminTokenIfConfigured
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
  EnhancedProxyHealth.ts    Proxy health aggregation
  ProxyClient.ts            HTTP client to standalone proxy
  ProxyHealth.ts            Legacy proxy health checker
odds/                  OddsPoller + providers (DemoOddsProvider, TheOddsApiProvider)
patterns/             Pattern detection and persistence
player360/            Player 360 deep-dive logic
risk/AlertEngine.ts   Alert detection rules
services/CommandCenterCron.ts      Managed scheduler for risk background jobs
services/CommandCenterDashboard.ts Dashboard data aggregation
services/CommandCenterStatusService.ts Live status with table counts + stream metrics
services/LiveFeatureService.ts     Real-time feature extraction with heuristic fallback
services/PositionService.ts        Risk position lifecycle (generate, execute, override, expire)
services/RiskAlertService.ts       Webhook alert dispatch with circuit breaker integration
services/RiskCommandCenter.ts      Unified risk surface: summary, violations, timeseries, player detail
services/ShadowAgentService.ts     Kimi-powered A/B risk analysis with DB persistence
services/StreamHub.ts              Bun-native SSE pub/sub with ring buffer replay
services/WebhookCircuitBreaker.ts  In-memory per-URL circuit breaker (closed/degraded/open)
workers/shadowAgentWorker.ts       Web Worker for background shadow A/B comparison
config/commandCenterMap.ts         Centralized constants: endpoints, schedules, SSE events, error codes
types/                Shared TypeScript interfaces
utils/                Shared utilities
```

### Proxy `proxy-enhanced.ts`

```
ENDPOINT_MAP (48+ entries)           — Buckeye API catalog with cacheTTLs and categories
PROXY_ALIAS_MAP                     — Friendly-name → Buckeye endpoint fallbacks
TAXONOMY_MAP                        — Taxonomy level → endpoint/shape config
normalizeResponse()                  — 18+ Buckeye shape normalizers
parseBuckeyeWagers()                 — Raw Buckeye wager → Wager[] (cents→dollars)
detectSyndicates()                   — Correlated betting detection (5-min windows)
correlateSharpMoney()                — Wager ↔ line movement correlation
computeExpectedValue()              — EV simulation per sport/wagerType
computePredictiveSharpness()         — Predictive sharpness scoring (0-100)
simulateLineAdjustments()           — Backtesting line-move rules
evaluateLineAdjustments()           — Background task (60s interval)
runRiskEngine()                      — Background task (30s interval)
```

### Proxy SQLite Tables

| Table | Purpose |
|-------|---------|
| `tokens` | Stored Buckeye JWT tokens per customer |
| `api_cache` | SWR cache with TTL |
| `request_log` | Per-request timing and error logging |
| `rate_limit` | Per-IP/per-endpoint rate limiting |
| `idempotency` | Idempotency key dedup |
| `rate_limit_overrides` | Custom rate limits per endpoint |
| `risk_config` | Per-agent risk thresholds + webhook URL |
| `syndicate_cache` | Detected syndicates with pattern/members/stake |
| `line_history` | Historical line movements |
| `wager_analytics` | Parsed wager data for analytics |
| `line_adjustment_rules` | Auto line-adjustment rules per agent |
| `sharpness_history` | Historical sharpness scores per bettor |
| `line_adjustment_log` | Audit log of executed line adjustments |

### Feature Flags (`config.ts`)

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `analytics` | `ENABLE_ANALYTICS` | true | Syndicate detection, sharp money, EV, sharpness, backtest, line rules |
| `riskEngine` | `ENABLE_RISK_ENGINE` | true | Risk alert config, background risk evaluation |
| `wsValidation` | `ENABLE_WS_VALIDATION` | true | Validate WS message types |
| `wsClientBatching` | `ENABLE_WS_CLIENT_BATCHING` | true | Per-subscriber WS batch intervals |
| `memoryCache` | `ENABLE_MEMORY_CACHE` | true | Hot endpoint 2s TTL cache |
| `requestDedupe` | `ENABLE_REQUEST_DEDUPE` | true | Inflight request deduplication |
| `tokenCache` | `ENABLE_TOKEN_MEM_CACHE` | true | 5s TTL token cache |
| `responseNormalize` | `ENABLE_RESPONSE_NORMALIZE` | true | Gate for Buckeye shape normalizers |
| `requestSampling` | `SAMPLE_RATE` < 1 | true | Controls log sampling via `LOG_SAMPLE_RATE` |

## Critical Conventions

### Preload script (`scripts/preload.ts`)
`bunfig.toml` sets `preload = ["./scripts/preload.ts"]` — this runs before **every** `bun run`, `bun test`, and `bun build`:
- Zod-validates proxy environment variables (exits on invalid config)
- Patches `bun:sqlite` Database constructor to always enable WAL, `busy_timeout = 5000`, `foreign_keys = ON`, `synchronous = NORMAL`
- Injects default 30s fetch timeout (`sportsTerminalFetch`; only patches global `fetch` if `ENABLE_GLOBAL_FETCH_TIMEOUT=true`)
- Starts structured logger that flushes every 5s
- Prints demo-mode banner when `DEMO_MODE=true`

### Amount units (don't get this wrong)
- **Buckeye API returns cents** — `AmountWagered: 2500` = $25.00
- **Backend normalizes** in `BuckeyeAPI.normalizeWager()` (divide by 100)
- **Proxy normalizes** in `parseBuckeyeWagers()` (divide by 100)
- **Database stores dollars** — all SQL queries operate on dollar amounts
- **Frontend displays dollars** directly — no further conversion

### Auto-renewToken
- Proxy auto-updates stored token when `System/renewToken` succeeds
- Invalidates token cache, reschedules renewal timer
- Token renewal happens every 15 min (configurable via `TOKEN_RENEWAL_INTERVAL_MS`)

### Response normalization
- `normalizeResponse()` handles 21+ Buckeye endpoint shapes when `ENABLE_RESPONSE_NORMALIZE=true`
- Key normalizers: `betTicker`, `sportsLeagues`, `leagueLines`, `games`, `playerInfo`, `agentDownline`, `dynamicLive`, `accountInfo`, `vigSetup`, `amountLimits`, `buyPoints`, `agentBilling`, `gameVolume`, `scoresLive`, `sportsTypesLive`, `liveGame`, `props`, `authorizations`, `newEmails`
- Fallback: `{ items, count }` for any `LIST`/`Data` response

### Cloudflare
- `cf_clearance` cookie is **mandatory** for fantasy402.com access
- User copies from browser DevTools → Settings → stored in `BunSecretVault`
- Cookie expires 30 min – 2 hrs; backend sends on every request

### Polling & resilience
- Normal: 5s. Exponential backoff: 5→10→20→40→max 60s
- Token renewal: every 15 min
- Max 3 re-login attempts, then `auth_failed` broadcast and stop
- Risk engine: every 30s (when `ENABLE_RISK_ENGINE=true`)
- Line adjustment engine: every 60s (when `ENABLE_ANALYTICS=true`)

### Environment constraints
- `NODE_ENV=production` enables JWT auth + rate limiting; `development` bypasses both
- `JWT_SECRET` must be 32+ chars in production (checked at startup in `config/env.ts`)
- `DATABASE_URL` supports SQLite (`sqlite:./data/terminal.db`) or Postgres (`postgres://...`)
- `ADMIN_API_TOKEN` — optional, guards sensitive mutations when set
- `REDIS_URL` — optional, enables performance caching + pub/sub

## Where to find things

- **All API routes**: `backend/src/api/router.ts` — 112+ routes via `UrlPatternRouter`
- **Route handlers**: `backend/src/api/routes/` — one file per domain
- **Frontend entry**: `frontend/public/index.html` → `js/app.js`
- **Frontend WS**: `frontend/public/js/ws-client.js`
- **Frontend SSE**: `frontend/public/js/sse-client.js` — EventSource wrapper with auto-reconnect
- **Frontend modules**: `frontend/public/js/modules/` — state, render-scheduler, buckeye-integration, odds-matrix, agent-network, performance-analytics, webhooks-modals
- **Database schema**: `backend/src/database.ts` — all table definitions and migrations
- **Buckeye API client**: `backend/src/scrapers/BuckeyeAPI.ts` — auth, wager, access-log, performance calls
- **Env validation**: `backend/src/config/env.ts` — all env vars and their constraints
- **Proxy endpoint catalog**: `proxy-enhanced.ts` — `ENDPOINT_MAP` (48+ entries), `getEndpointMeta()`, `getEndpointDescription()`
- **Proxy feature flags**: `config.ts` — `FeatureFlags` interface with `analytics`, `riskEngine`, `requestSampling`
- **Proxy analytics algorithms**: `detectSyndicates()`, `correlateSharpMoney()`, `computeExpectedValue()`, `computePredictiveSharpness()`, `simulateLineAdjustments()`
- **Proxy background engines**: `runRiskEngine()` (30s), `evaluateLineAdjustments()` (60s)
- **Live score flash**: `pushLiveFlash()` — detects score changes via cached prev/next comparison, pushes `live_flash` WS messages
- **Live betting frontend**: `frontend/public/js/live.js` — Zone 5 Live Betting Center
- **`liveGame` normalizer** uses `keyOverride` param in `normalizeResponse()` so it doesn't shadow `games` normalizer
- `/api/proxy/renewToken` excluded from generic proxy catch-all — dedicated handler with stored-credential fallback now reachable
- Backend `handleProxyCompatibleRoute` now supports `Report/*`, `League/*`, `Lines/*`, `Provider/*`, `Limit/*` paths
- `shouldLog()` gated by `CONFIG.features.requestSampling` — when disabled, all request logs pass through
- `risk/alerts` POST now validates `thresholds` with `asTaxonomyRecord()`, consistent with `risk/config`
- All prepared statements (48 total) are finalized on shutdown
- Inline `db.prepare()` calls replaced with pre-prepared statements (`deleteRiskConfig`, `deleteRateLimitOverrideInline`)
- **Risk Command Center**: `backend/src/services/RiskCommandCenter.ts` — summary, violations, timeseries, player detail
- **Webhook Circuit Breaker**: `backend/src/services/WebhookCircuitBreaker.ts` — per-URL delivery protection
- **Risk API routes**: `/api/risk/summary`, `/api/risk/positions`, `/api/risk/violations`, `/api/risk/timeseries`, `/api/risk/players/:id`, `/api/risk/webhooks/health`

## Frontend Component Matrix

| Component | Endpoints | CSS Classes | Hex Colors |
|-----------|-----------|-------------|------------|
| Odds Matrix | `GET /api/odds/live` | `.matrix-container`, `.matrix-table`, `.sticky-col`, `.odds-price`, `.detail-drawer` | `#0a0e17`, `#111827`, `#1f2937`, `#ff6600`, `#10b981`, `#ef4444` |
| Player Profile | `GET /api/players/{id}/details`, `GET /api/players/{id}/wagers`, `GET /api/players/{id}/pnl`, `GET /api/players/{id}/agent-context`, `GET /api/v1/players/{id}/intelligence-map` | `.player-profile-overlay`, `.profile-stat-grid`, `.profile-stat-card`, `.profile-chart-card` | `#0a0e17`, `#111827`, `#1a2332`, `#e5e7eb`, `#6b7280`, `#ff6600` |
| Live Betting | `POST /api/proxy/Report/getScoresLiveDynamic`, `POST /api/proxy/Manager/getDynamicLive`, `POST /api/proxy/Manager/getSportsTypesLive` | `.live-badge`, `.game-card`, `.book-pill` | `#0a0e17`, `#10b981`, `#ef4444`, `#f59e0b`, `#3b82f6` |
| Agent Network | `GET /api/v1/agents/hierarchy`, `GET /api/agents/downline` | `.agent-lineage-row`, `.agent-node-row`, `.agent-rate-grid`, `.agent-level-bars` | `#0a0e17`, `#111827`, `#8b5cf6`, `#06b6d4` |
| Exposure Panels | `GET /api/exposure/sports`, `GET /api/exposure/agents` | `.exposure-bar`, `.exposure-bar-fill`, `.exposure-bar-label`, `.exposure-table` | `#0a0e17`, `#ef4444`, `#f59e0b`, `#10b981`, `#3b82f6` |
| Pattern Detection | `GET /api/patterns/history`, `GET /api/patterns/summary`, `GET /api/patterns/catalog` | `.pattern-row-critical`, `.pattern-row-warning`, `.pattern-row-watch`, `.pattern-badge-pulse` | `#ef4444`, `#f59e0b`, `#3b82f6`, `#8b5cf6`, `#10b981` |
| Syndicate Intel | `POST /api/proxy/analytics/syndicates` | `.intel-identity-card`, `.intel-avatar`, `.intel-risk-meter`, `.intel-stat-card`, `.intel-wager-card` | `#0a0e17`, `#111827`, `#f43f5e`, `#8b5cf6`, `#84cc16` |
| Integrity Cases | `GET /api/proxy/integrity/cases`, `PATCH /api/proxy/integrity/cases/{id}` | Inline styles (`rounded`, `border`, `p-2` case cards) | `#0a0e17`, `#1a2332`, `#e5e7eb`, `#6b7280` |
| Performance Dashboard | `GET /api/betting/velocity`, `GET /api/betting/live-vs-pre`, `GET /api/master/history`, `GET /api/performance/summary` | `.analytics-chart` | `#0a0e17`, `#111827`, `#3b82f6`, `#10b981`, `#f59e0b` |
| Webhooks Manager | `GET /api/webhooks`, `POST /api/webhooks`, `PUT /api/webhooks/{id}`, `DELETE /api/webhooks/{id}` | Inline styles (`rounded-lg`, `border`, `p-3` panels) | `#0a0e17`, `#111827`, `#ff6600`, `#e5e7eb` |
| Alerts & Notifications | WebSocket `/ws` | `.alert-critical`, `.alert-warning`, `.alert-info`, `.alert-row`, `.gslive-row` | `#ef4444`, `#f59e0b`, `#3b82f6`, `#10b981`, `#8b5cf6` |
| Settings / Vault | `GET /api/buckeye/vault-status` | Inline styles (`flex`, `rounded`, `px-2`, `py-1` agent rows) | `#0a0e17`, `#111827`, `#06b6d4`, `#e5e7eb` |

**Theme**: Sports Terminal Dark (`frontend/public/css/terminal.css`)
- `--bg: #0a0e17`, `--panel: #111827`, `--border: #1f2937`, `--text: #e5e7eb`, `--text-dim: #6b7280`
- `--accent: #ff6600`, `--green: #10b981`, `--red: #ef4444`, `--yellow: #f59e0b`, `--blue: #3b82f6`, `--purple: #8b5cf6`, `--cyan: #06b6d4`

**Full interactive reference**: `docs/API_REFERENCE.html` → "UI Matrix" tab

## Proxy API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/proxy/analytics/syndicates` | Detect correlated betting patterns |
| POST | `/api/proxy/analytics/sharp-money` | Correlate wagers with line movements |
| POST | `/api/proxy/analytics/ev-simulation` | Expected value simulation |
| POST | `/api/proxy/analytics/predictive-sharpness` | Predictive sharpness score (0-100) |
| POST | `/api/proxy/analytics/backtest` | Backtest line adjustment rules |
| GET | `/api/proxy/agent/heatmap` | 7×24 access + wager heatmap |
| POST | `/api/proxy/risk/alerts` | Configure risk thresholds + webhook |
| GET | `/api/proxy/risk/alerts` | Read risk config for agent |
| DELETE | `/api/proxy/risk/config` | Delete risk config |
| GET | `/api/proxy/risk/syndicates` | Cached syndicate detections |
| GET/POST/PUT/DELETE | `/api/proxy/line-rules` | Auto line adjustment rule CRUD |
| GET | `/api/proxy/line-adjustments/log` | Line adjustment audit log |
| GET | `/admin/traces` | Recent OTel trace spans (requires admin key) |
| GET | `/admin/requests` | Recent proxy request events + stats (requires admin key) |
| GET | `/admin/ws` | Active WebSocket subscriber list (requires admin key) |

### OpenTelemetry Tracing

Set `ENABLE_OTEL=true` to enable trace collection. Spans are created for every incoming request and exported to `OTEL_EXPORTER_OTLP_ENDPOINT` (default: `http://localhost:4318/v1/traces`) every `OTEL_EXPORT_INTERVAL_MS` (default: 10000ms). View collected spans via `GET /admin/traces`.

### Request Listener

An in-memory ring buffer (500 events) tracks proxy API requests. Access via `GET /admin/requests?limit=100&statsMinutes=5`. Returns recent events plus aggregated stats (total, errors, avg duration, top paths).

**Pretty-print in logs** (for debugging):
```typescript
// In proxy-enhanced.ts or any script importing it:
console.log(tracer.prettyPrint(10));     // Last 10 trace spans
console.log(requestListener.prettyPrint(10)); // Last 10 request events
```

## Patterns & Conventions

### Backend Utilities

**Constants** — `backend/src/utils/constants.ts`
- Import and use named constants instead of magic numbers.
- Covers: `POLL_INTERVALS`, `HTTP_TIMEOUTS`, `CACHE_TTL`, `WS_TIMEOUTS`, `RISK_AGENT`, `AUTH_TIMEOUTS`, `RATE_LIMIT`, etc.

**Null-Safety** — `backend/src/utils/null-safety.ts`
- `firstOf(a, b, c)` — returns first non-null value
- `centsTodollars(cents)` — converts Buckeye cents to dollars
- `safeString(value)` — trim with fallback
- `isFlagSet(flag)` — treats `'Y'`, `true`, `1` as set
- `hasChanged(prev, curr)` — safe change detection

**Safe JSON Parsing** — `backend/src/utils/parseJson.ts`
- `parseJson<T>(text, fallback)` — parse with fallback
- `parseJsonOrNull<T>(text)` — parse or return null
- `parseJsonOrText(text)` — parse or return original string

### WebSocket Pub/Sub (Bun Native)

The backend uses Bun's native topic-based publish/subscribe API instead of manual `Set<ServerWebSocket>` iteration.

**Topics:**
- `messages` — general broadcasts (alerts, data responses, etc.)
- `wagers:all` — all wager.new messages for unscoped clients
- `player:{playerId}` — player-scoped wager.new messages

**Subscription flow:**
- On connect: client auto-subscribes to `messages` + `wagers:all`
- On `player.subscribe`: subscribes to `player:{id}`, unsubscribes from `wagers:all`
- On `player.unsubscribe`: unsubscribes from `player:{id}`; if no player subs remain, re-subscribes to `wagers:all`

**Broadcasting:**
```ts
server.publish('messages', payload);        // general messages
server.publish('wagers:all', payload);      // all wagers (unscoped clients)
server.publish('player:ABC', payload);      // player-scoped wagers
```

This is faster than manual iteration because Bun's `uWebSockets` handles topic routing in C++.

### Bun.serve Patterns

**Error handler** — catches unhandled exceptions in `fetch()`:
```ts
Bun.serve({
  fetch(req, server) { /* ... */ },
  error(error) {
    console.error('[HTTP] Unhandled error:', error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 });
  },
});
```

**Graceful shutdown** — `server.stop()` waits for in-flight requests:
```ts
process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});
```

**Accurate client IP** — `server.requestIP(req)` returns `{ address, port }`:
```ts
const clientIp = server.requestIP(request)?.address;
```
- Used for rate limiting instead of fragile `x-forwarded-for` header parsing
- Falls back to header parsing when `requestIP()` returns null (proxied requests)

**WebSocket subscriber counts** — `server.subscriberCount(topic)`:
```ts
server.subscriberCount('messages');     // general subscribers
server.subscriberCount('wagers:all');   // wager feed subscribers
```
- Exposed in `/health` and `/metrics` endpoints

**Process keep-alive** — `server.ref()` / `server.unref()`:
```ts
const server = Bun.serve({ /* ... */ });
server.ref();   // explicit: keep process alive (default)
// server.unref(); // allow exit if nothing else is running
```

**Per-request idle timeout** — `server.timeout(req, seconds)`:
```ts
Bun.serve({
  fetch(req, server) {
    // Extend idle timeout for long-running proxy requests
    server.timeout(req, 60);
    return handleSlowRequest(req);
  },
});
```
- Use `server.timeout(req, 0)` to disable idle timeout for SSE streams
- Default global idle timeout is 10s; raise it via `idleTimeout` in `Bun.serve` options

### Frontend Logger

**`frontend/public/js/logger.js`** — centralized console wrapper:
```js
import { logger } from './logger.js';
logger.info('WS', 'Connected', url);
logger.warn('API', 'Fetch failed', err);
logger.error('Auth', 'Login failed', err);
```
- `logger.debug` is gated by `DEBUG` flag (localhost or `localStorage.debug=true`)
- All other levels always log with consistent `[TAG] message` formatting

## Testing

Tests in `backend/tests/*.test.ts`. Run from repo root with `bun test`.

Test files: `actionQueue`, `analytics`, `api`, `auth`, `health`, `health-enhanced`, `odds`, `patterns`, `performance`, `players`, `proxy-client`, `proxy-enhanced-config`, `rateLimiter`, `raw-api-logger`, `router`, `scheduler`, `webhook`.

Database tests use `:memory:` SQLite. No external services required.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port 3000 in use | `bun run stop` then `bun run dev` |
| Multiple Bun processes | `bun run status` then `bun run stop` or `taskkill /F /IM bun.exe` |
| Stale deps | Delete `node_modules` + `backend/node_modules`, then `bun install` |
| Verify backend running | `Invoke-RestMethod http://localhost:3000/health` |
| Verify proxy running | `Invoke-RestMethod http://localhost:3001/` |
| Buckeye login fails | Fresh `cf_clearance` cookie, confirm `BUCKEYE_BASE_URL`, check vault status |
| Odds grid empty | Demo odds auto-activate; live data requires Buckeye auth or `ODDS_API_KEY` |
| Analytics endpoints return 403 | Set `ENABLE_ANALYTICS=true` in proxy `.env` |

## Security reminders

- Never commit `backend/.env`, `backend/data/`, or raw Buckeye export files
- `Bun.secrets` stores passwords/tokens; vault-status endpoint returns only presence flags
- `DELETE /api/buckeye/vault-status?agentId=...` clears one agent; `all=1` clears all
- `bunfig.toml` enables OSV install-time security scanner
- Risk config webhooks are stored in SQLite — never log threshold values in responses
- Line adjustment logs contain game IDs and line movements — treat as sensitive
- Run `bun run artifacts:check` before commits to catch accidental sensitive-file staging
