# Changelog

## Unreleased - v5.32

### Added

- **System Status issue rollup** — `/api/health/system-status` now consolidates scraper errors, action queue backlog, raw API failures, Player 360 source errors, offline books, and critical/high patterns into a single operator issue feed.
- **Player 360 real-data contract map** — `/api/v1/players/:id/intelligence-map` now includes field-level UI mappings, source freshness, endpoint coverage, explicit contract mismatches, and real/probe/missing status for each profile source.
- **Player 360 Status/Docs hardening** — the modal Status and Docs panels now render the live intelligence-map payload and no longer fill missing sources with static live rows.
- **Player 360 hybrid hotset refresh** — heavy Buckeye sources now expose per-player TTL, policy, scale class, last attempt, last success, and next refresh metadata instead of encouraging all-player polling.
- **Player 360 cold backfill cohort** — each background Player 360 poll now can pick a tiny archived-customer cohort from local `wager_archive` so ledger/account/performance coverage fills gradually across cold customers without a 50k-customer Buckeye sweep.
- **Real API-only Player 360 profile hydration** — profile endpoint failures show an API error and retry path instead of generating a local mock profile from already-loaded wagers.
- **Confirmed Buckeye player endpoints** — `getPerformancePlayer`, `getTransactionList`, `getTransactionHistory`, `getReportDeletedTransactions`, `getInfoPlayer`, and mapped-probe `getTeaserProfile` are now tracked as Player 360 source candidates.

### Changed

- Player 360 frontend rendering is being split into focused browser modules: transaction/free-play rendering now lives in `player-transactions.js`, Docs/data-map rendering lives in `player-docs.js`, and shared escaping/formatting helpers live in `utils.js`.
- Player 360 source status is per-player: `wager_archive` is live only when archive rows exist for that player; deposits and customer snapshots remain probe/missing until rows or validated probes exist.
- Profile Tab Coverage now shows the weakest required source timestamp as Recent Update plus the refresh-policy summary for each tab.
- Player performance enrichment now probes `getPerformancePlayer` with `acc=<player/account>&period=0` before relying on broader agent-performance rows.
- Transaction ledger refresh now merges `getTransactionList`, `getTransactionHistory`, and `getReportDeletedTransactions` under the same 6-hour on-open/hotset policy, with same-day history and deleted rows classified into the ledger/deposit contract.
- Player 360 watermarks and status now include hot player count plus cold-backfill count/limit so operators can see whether database seeding is progressing.
- v5.32 frontend assets use the new cache-busting version label.

## v5.31

### Added

- Always-on Buckeye ingestion for vaulted agents while the backend process is running.
- Multi-agent OS vault index and per-agent secret presence checks through `Bun.secrets`.
- Startup restore for all vaulted Buckeye agents, with independent failure handling.
- Vault health API and Settings UI vault panel.
- Manual vault logout for one agent, with internal clear-all support.
- Access-log ingestion through Buckeye `getWebLog`.
- Agent performance ingestion through `getAgentPerformance`.
- Sports type seeding through `getSportsType`.
- Ingestion checkpoints for future-safe incremental pulls.
- Pattern history, summary, evidence, and filter surfaces.
- System Status sidebar page for backend, vault, book, and pattern health.
- `backend/src/config/env.ts` startup environment validation.
- Managed scheduler service for recurring backend loops.
- Bun install security scanner configuration through `bunfig.toml`.
- Project organization guide.
- Data dictionary covering env vars, vault keys, Buckeye fields, local tables, API routes, and WebSocket events.
- Enterprise tab goals covering sidebar workflows, readiness standards, data contracts, and operational UX principles.
- Audit analytics engine contract covering raw logs, archive tables, poller state, retention, and test expectations.
- Complete URLPattern route registration for existing route modules.
- **Audit & Analytics Engine** — 7 new database tables (`raw_api_logs`, `wager_archive`, `access_logs`, `master_snapshots`, `weekly_figures`, `agent_performance`, `audit_logs`) with full indexes, watermark-based incremental polling, and batched PII-redacted raw API logging.
- **9 analytics API endpoints** — `/api/betting/velocity`, `/api/betting/live-vs-pre`, `/api/logs/access`, `/api/master/history`, `/api/performance/summary`, `/api/performance/details`, `/api/export/wagers`, `/api/export/access-logs`, `/api/export/performance`.
- **Performance dashboard tab** — Master health card, bet velocity chart (Chart.js line+bar), live vs pregame donut, access log monitor with new-IP highlighting, sortable agent performance table with expandable detail, CSV export buttons. All updated in real-time via WebSocket.
- **Up tab (Error Tracking & Recovery)** — Real-time error monitoring, poller health dashboard, watermark status, error history table, and recovery matrix with 12 error types and their automatic/manual recovery paths.
- **API endpoint status dashboard** — Live health checks for all 32+ endpoints in the Status tab, grouped by category with response codes and timing.
- **Comprehensive API documentation** — `docs/API_ENDPOINTS.md` with real JSON responses captured from the live server, covering all endpoints plus error handling, recovery flows, rate limiting, and CORS.
- **v5.31 UI polish and raw API observability** — collapsible sidebar groups with persisted state, clearer topbar ingestion/socket/wager chips, and a redacted Raw API Archive panel in Performance.
- **Frontend module organization** — `index.html` is now a static shell, shared CSS lives in `/css/terminal.css`, and `/js/app.js` loads as a browser module with focused module homes for WebSocket, API, Buckeye, Performance, navigation, and settings work.

### Changed

- Browser disconnect no longer stops Buckeye ingestion.
- Database wrapper now uses Bun SQL while preserving the app's local DB API shape.
- Odds and Buckeye recurring jobs now run through managed scheduler loops.
- README, Buckeye scope, and implementation tracker now describe the v5.31 architecture.
- `RawApiLogger` upgraded to batched inserts (25/batch, 250ms flush) with PII redaction.
- `ScraperManager` now includes 5-min access log poller, 30-min master snapshot poller, and daily archive refresh — all with watermark-based recovery.
- Frontend sidebar now includes Performance and Up tabs between Status and Settings.

### Notes

- `Bun.scheduler` is not available in the local Bun 1.3.13 runtime, so recurring work uses managed `Bun.sleep` loops.
- Raw Buckeye hierarchy/player exports remain ignored because they can contain sensitive customer and agent data.
- All 84 backend tests pass with 0 failures. 4 performance cache tests are intentionally skipped (Redis not configured).
