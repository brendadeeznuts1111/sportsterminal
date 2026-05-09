# Changelog

## v5.3 — 2026-05-09

### Added
- **Route extraction**: Monolithic `index.ts` (~700 lines) split into `backend/src/api/routes/` with 9 route files + router + helpers
- **JWT enforcement**: WebSocket connections require HS256 JWT in production mode. Tokens issued on Buckeye auth. Dev bypass via `NODE_ENV=development`.
- **Rate limiting**: IP-based sliding window (100 req/min) on all HTTP endpoints. Returns 429 with `Retry-After` header.
- **Idle shutdown**: Scrapers and odds poller stop after 5 min with zero WebSocket clients. Auto-restart on new connection.
- **Action Queue**: Per-agent action queues with UUID v4 IDs, 30s timeout, `betAction` WebSocket messages. Accept/Decline buttons in wager detail modal.
- **Pattern Detection**: `PatternService` with wager correlation, event matching, PIN reference lookup. `detected_patterns` and `access_logs` tables. Live Patterns tab with category filters and detail drawer.
- **Wager parsing**: Structured `parsed_game`, `parsed_market`, `parsed_side`, `parsed_price`, `parsed_period` columns on wagers table.
- **Metrics counters**: `wagers_total`, `alerts_triggered_total`, `errors_total` in `/metrics` endpoint.
- **XSS-safe rendering**: `escapeHtml()` function and delegated event listeners in frontend.
- **Projected net exposure**: Player detail shows projected net (wagered minus potential payout), clearly labeled as projection.
- **JWT generator**: `scripts/generate-jwt.ts` CLI helper for creating test tokens.

### Changed
- `index.ts` refactored from ~700 to ~200 lines — routes delegated to `router.ts`
- `ScraperManager` now tracks wager/alert/error counters and action queue metrics
- `OddsPoller` now detects and persists line movement patterns
- Frontend wager table uses `data-action` attributes instead of inline `onclick` handlers
- `.env.example` updated with `NODE_ENV`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `IDLE_TIMEOUT_MS`

### Dependencies
- Added `jose` (v6.2.3) for HS256 JWT signing/verification

### Tests
- 53 tests pass, 0 failures across 7 test files
- New: `auth.test.ts` (5), `rateLimiter.test.ts` (6), `actionQueue.test.ts` (6), `patterns.test.ts` (6)

---

## v5.2 — 2026-05-08

### Added
- Buckeye PPH live wager API client (`BuckeyeAPI.ts`) targeting `fantasy402.com`
- WebSocket auth/session flow with token resume
- Cloudflare `cf_clearance` cookie support
- Bun native SQLite via `bun:sqlite`
- Demo odds grid with 16 books, consensus, best-line highlighting, movements
- Buckeye wager feed, agent downline, player search/detail, sport and agent exposure
- Alert rules (7 rules), alert history, toast toggle
- Webhook CRUD, retries, and delivery log (Discord/Slack/Telegram/Generic)
- Static SPA served by the backend
- Amount normalization (cents → dollars)
- Prop bet detection, HTML entity decoding, futures/parlay parsing
