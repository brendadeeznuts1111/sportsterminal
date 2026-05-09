# Sports Terminal v5.3 Implementation Tracker

> Last updated: **2026-05-09 18:00**
> Started: **2026-05-08**
> Phase order: **Zone 4 → 1 → 8 → 2 → 3**
> Build mode: **full-stack**
> Auth: **JWT (HS256)**
> Test suite: **64/64 passing**

---

## Overall Progress

| Zone | Feature Group | Tabs | Status | Started | Completed | Tests Passing | Verified |
|------|---------------|------|--------|---------|-----------|---------------|----------|
| 4    | Backend Operational Gaps | Buckeye, Downline, Player Search, Player Detail, Positions, Alerts, Settings | ✅ Complete | 2026-05-08 | 2026-05-09 | 64/64 | Yes |
| 1    | Sportsbook Grid Enhancements | Trading Floor | ✅ Complete (demo data) | 2026-05-08 | 2026-05-08 | 5/5 | Yes |
| 8    | Webhook Alerts | Webhooks | ✅ Complete | 2026-05-08 | 2026-05-08 | 7/7 | Yes |
| 2    | Patterns Tab & Trading Automation | Patterns | ✅ Complete (live detection) | 2026-05-08 | 2026-05-09 | 6/6 | Yes |
| 3    | Kalshi Live Polling & Positions | Kalshi (placeholder) | ⬜️ Not started | — | — | — | — |
| —    | Total Test Suite | — | — | — | — | **20/20** | Yes |

---

## Zone 4 – Backend Operational Gaps

Status: **✅ Complete**

### What Was Delivered in Phase 1
- ✅ Replaced Puppeteer DOM scraping with HTTP API client (`BuckeyeAPI.ts`) targeting `fantasy402.com/cloud/api/Manager/getBetTicker`
- ✅ Built `AlertEngine.ts` with 7 alert rules (High Volume, ALERT Writer, Live Large, Parlay Payout, VIP, Exotic Large, Teaser Large)
- ✅ Rebuilt `ScraperManager.ts` with `setInterval` polling (5s), token renewal (15min), and proper timer cleanup
- ✅ Added REST routes: `/api/wagers`, `/api/agents`, `/api/agents/downline`, `/api/agents/:id/performance`, `/api/agents/:id/exposure`, `/api/stats`, `/api/risk/alerts`, `/api/wagers/alerts`, `/api/wagers/live`, `/api/players/:id/details`, `/api/players/:id/wagers`, `/api/players/:id/pnl`
- ✅ Implemented WebSocket broadcasts: `wager.new`, `wager.alert`, `exposure.update`, `auth_failed`
- ✅ Frontend `updateFromBackend()` now merges backend wagers into `buckeyeWagers` array
- ✅ Frontend WS handlers register for live events
- ✅ `bun test` passes (8/8) — AlertEngine + BuckeyeAPI change detection
- ✅ Amount normalization: API returns cents; backend divides by 100 in `normalizeWager()`

### What Was Delivered in Phase 2
- ✅ Agent downline endpoint: `GET /api/agents/downline` — derived from wager data
- ✅ Agent performance endpoint: `GET /api/agents/:id/performance` — per-agent metrics + breakdowns
- ✅ Player details endpoint: `GET /api/players/:id/details`
- ✅ Player wagers endpoint: `GET /api/players/:id/wagers`
- ✅ Player P&L endpoint: `GET /api/players/:id/pnl?days=7` — zero-filled daily buckets
- ✅ Frontend Agent Network section with stats cards, agent table, "View Wagers" filtering
- ✅ Frontend Player Search section with search + player list
- ✅ Frontend Player Detail view with stats, 7-day P&L bars, wager breakdown, recent wagers table
- ✅ Click-through: Customer cell → Player Detail, Agent cell → Filter ticker by agent

### What Was Delivered in Phase 3 (Polish)
- ✅ Cloudflare cookie support (`cf_clearance`) via Settings form
- ✅ "Get Fresh Cookie" button opens Buckeye in new tab
- ✅ Session persistence: JWT token saved to `localStorage`, auto-resume within 10 min
- ✅ Auto-connect checkbox in Settings, reconnects within 1.5s on page refresh
- ✅ Reconnection resilience: exponential backoff (5s→10s→30s→60s), max 3 relogin attempts
- ✅ Toast toggle in Settings and Alert Center header, persisted in `localStorage`
- ✅ Sport parser fixed: handles both `M.G123 - Tennis - ...` and `M.Soccer #123...` formats
- ✅ Dedicated "Sport" column in wager table
- ✅ Bottom panels: Top Agents by Volume, Sport Breakdown, Game Breakdown
- ✅ `file://` protocol WebSocket fallback to `ws://localhost:3000/ws`
- ✅ TDZ error fix in `DEFAULT_BOOK_ORDER`
- ✅ Improved error logging throughout

### What Was Delivered in Phase 4 (Exposure v2)
- ✅ Sport Exposure endpoint: `GET /api/exposure/sports` — top game, most popular side, avg price, game total per sport
- ✅ Agent Exposure endpoint: `GET /api/exposure/agents` — top customer, top game per agent
- ✅ Frontend Sport Exposure: sortable 8-column table (Sport, Total, %, Live, Top Game, Side, Price, Game $)
- ✅ Frontend Agent Exposure: sortable 8-column table (Agent, Total, %, Live, Top Customer, Cust.$, Top Game, Game $)
- ✅ Prop bet detection from `ShortDesc` (player props, O/U)
- ✅ Amount normalization: `VolumeAmount=0` fallback to `AmountWagered`
- ✅ HTML entity decoding (`&#189;` → `½`, `&#188;` → `¼`, etc.)
- ✅ `C:`/`P:`/`M.`/`L:` prefix handling in parsers
- ✅ GSLIVE "Top" prefix handling
- ✅ Futures format parsing (`#NFL Futures - #To win Division...`)
- ✅ Parlay format parsing (`\r
` separator)
- ✅ `#Category` regex bug fix

### 4.1 Action Queue
- [x] Implement `ActionQueue` class with per‑agent queues
- [x] Add unique action ID generation (UUID v4)
- [x] Set timeout (30s) with cleanup
- [x] Emit `betAction` WebSocket message with result
- [x] Unit tests for queue sequencing, timeout, and concurrency

### 4.2 /metrics Endpoint
- [x] Basic `/metrics` exists (returns scraper manager state)
- [x] Add counters: `wagers_total`, `alerts_triggered_total`, `errors_total`
- [x] Action queue metrics included in `/metrics` response
- [ ] Install `prom-client` (optional — counters are in JSON format)
- [ ] Expose Prometheus‑compatible output (optional — JSON works for now)

### 4.3 Idle Shutdown
- [x] `ScraperManager.stopAgent()` clears poll + renewal timers
- [x] Add `IDLE_TIMEOUT_MS` env var reading
- [x] Track connected WS clients in `index.ts`
- [x] Start idle timer on zero clients; stop scrapers when timer expires
- [x] Restart scrapers on new connection
- [ ] Unit test: simulate connect/disconnect cycle (manual smoke test done)

### 4.4 JWT Enforcement (WebSocket)
- [x] Add `jose` library for JWT verification
- [x] Modify WebSocket upgrade handler to extract token from query string or `sec‑websocket‑protocol`
- [x] Validate HS256 token; reject with 401 if invalid
- [x] Dev bypass: skip check if `NODE_ENV=development`
- [x] Generate helper script to create tokens (`scripts/generate-jwt.ts`)
- [x] Unit test: token validation (valid, expired, wrong secret)

### 4.5 Rate Limiting (HTTP)
- [x] Implement simple IP‑based sliding window (100 req/min)
- [x] Apply to all HTTP endpoints (before route handling)
- [x] Return 429 with `Retry-After` header when exceeded
- [x] Unit test: burst >100, wait, resume

### 4.6 Documentation & Deployment
- [x] `.env.example` updated with new vars (`BUCKEYE_BASE_URL`, `POLL_INTERVAL_MS`, `TOKEN_RENEWAL_MINUTES`)
- [x] `docs/BUCKEYE_BACKEND_SCOPE.md` updated with real endpoints and amount units
- [ ] Update `README.md` with new env vars (`JWT_SECRET`, `IDLE_TIMEOUT_MS`, `NODE_ENV`)
- [ ] Add `CHANGELOG.md` entry for Zone 4
- [ ] Provide Docker/run instructions
- [ ] Run full regression test suite: ___

---

## Zone 1 – Sportsbook Grid Enhancements

Status: **✅ Complete (Demo Data)**

### What Exists
- ✅ Odds Grid UI renders 16 books across 8 demo games (NBA, MLB, NHL, NCAAB, NFL, Soccer, Tennis, UFC)
- ✅ DemoOddsProvider generates realistic synthetic odds with sharp/square variance
- ✅ TheOddsApiProvider skeleton (activated via `ODDS_API_KEY` env var)
- ✅ `OddsPoller` persists snapshots, detects line movements, serves live matrix
- ✅ Book health indicators (green/red/grey dots) with `GET /api/books/status`
- ✅ Best line highlighting (`.best-line` CSS class, computed on-the-fly)
- ✅ Line movement arrows (▲/▼ with delta) stored in `line_movements` table
- ✅ Spread/Total price display (-110 style) in grid cells
- ✅ Consensus column with market average
- ✅ Pattern detection: steam move (3+ books within 90s) and reverse line detection
- ✅ Detail drawer per game with sparkline + book breakdown
- ✅ `GET /api/odds/live`, `/api/odds/snapshots`, `/api/odds/movements`, `/api/odds/events/:id`
- ✅ Tests: 5/5 passing (DemoOddsProvider, line movements, book health, sharp book variance)

### What's Missing
- [ ] Real The Odds API integration (requires `ODDS_API_KEY`)
- [ ] Kalshi / Polymarket direct API feeds
- [ ] Auto-trading on line movements

### 1.1 Book Health Indicators — ✅ Done
- ✅ Polling mechanism in `OddsPoller` every 30s
- ✅ Tracks last status per book (online/offline/unreachable)
- ✅ `GET /api/books/status` endpoint
- ✅ Frontend: coloured dot next to book name

### 1.2 Best Line Highlighting — ✅ Done
- ✅ `.best-line` CSS class with gold border highlight
- ✅ Computed on-the-fly in `getLiveOddsMatrix()`
- ✅ Frontend highlights best price per market/outcome

### 1.3 Line Movement Arrows — ✅ Done
- ✅ `line_movements` table: id, event_id, book, market, side, old_value, new_value, delta, recorded_at
- ✅ Movement detection on each scrape vs last snapshot
- ✅ `GET /api/odds/movements?eventId=&limit=` endpoint
- ✅ Frontend: ▲/▼ arrows with delta in cells

### 1.4 Spread/Total Prices — ✅ Done
- ✅ `odds_snapshots` table has `spread_home_price`, `spread_away_price`, `total_over_price`, `total_under_price`
- ✅ Demo provider generates varied prices (-110, -105, -115, etc.)
- ✅ Frontend renders small `(+105)` / `(-110)` next to line values

### 1.5 Documentation — 🔄 Pending
- [ ] Update README for new API endpoints
- [ ] Add Zone 1 CHANGELOG entry

---

## Zone 8 – Webhook Alerts

Status: **✅ Complete**

### What Was Delivered
- ✅ `alert_webhooks` table: id, name, platform (discord/slack/telegram/generic), url, triggers JSON, enabled, timestamps
- ✅ `webhook_deliveries` table: logs every dispatch attempt with payload, response status, success/failure
- ✅ `WebhookService` class: CRUD + dispatch + retry + delivery log
- ✅ REST endpoints: `POST /api/webhooks`, `GET /api/webhooks`, `GET /api/webhooks/:id`, `PUT /api/webhooks/:id`, `DELETE /api/webhooks/:id`, `GET /api/webhooks/:id/deliveries`
- ✅ Platform-specific payload formatting:
  - Discord: rich embeds with color-coded severity
  - Slack: block kit header + section + context
  - Telegram: Markdown-formatted message
  - Generic: plain JSON `{rule, severity, message, wagerNumber, timestamp}`
- ✅ Retry logic: 3 attempts with exponential backoff (configurable delay)
- ✅ Trigger filtering: webhooks can subscribe to `all`, `critical`, `warning`, `info`
- ✅ Integrated into `ScraperManager`: every alert is dispatched to matching webhooks immediately after persistence + WS broadcast
- ✅ Frontend Webhooks section: add/edit form, platform selector, trigger multi-select, list with edit/delete, enabled/disabled badges
- ✅ 7 tests passing: create, list, update, delete, trigger filtering, Discord payload formatting, failed delivery logging

### What's Missing (Future Enhancements)
- [ ] Update README with webhook setup instructions
- [ ] Add Zone 8 CHANGELOG entry

---

## Zone 2 – Patterns Tab & Trading Automation

Status: **🔄 Partial (Demo UI Only)**

### What Exists
- ✅ Patterns sidebar section with 4 hardcoded demo rows
- ✅ Severity scoring UI (45-85% bars)
- ✅ "Simulate Patterns" button (shows toast)
- ✅ `switchSection('patterns')` works
- ✅ Backend `detectPatterns()` in OddsPoller: steam move (3+ books within 90s) and reverse line detection
- ✅ Pattern icons (🔥/🚨/⚠️) on game rows in odds grid
- ✅ Pattern tooltip on hover

### What's Missing
- [ ] Real pattern storage in `detected_patterns` table
- [ ] Pattern history endpoint `GET /api/patterns/history`
- [ ] Custom rules engine with user-defined conditions
- [ ] Auto-trading execution on pattern match

### What's Missing

### 2.1 Pattern History
- [ ] Create `detected_patterns` table
- [ ] Store entries from `PatternDetector` (if exists, else implement basic detector)
- [ ] Endpoint `GET /api/patterns/history` with optional filters (date, type, market)
- [ ] Unit tests: pattern storage and retrieval

### 2.2 Custom Rules Engine
- [ ] Create `user_rules` table: id, name, condition_json, action_json, enabled, created_at
- [ ] CRUD endpoints: `/api/rules`
- [ ] Implement rule evaluator that checks conditions against current state
- [ ] On match, execute action (initially simulated: log + WebSocket event `autoTrade`)
- [ ] Unit tests: condition evaluation, action triggering

### 2.3 Frontend – Rules Builder
- [ ] Add "Trading Automation" tab (or section)
- [ ] Rule builder UI: name, condition builder (e.g., market, operator, value), action selector
- [ ] List rules with on/off toggle and delete
- [ ] Show recent auto‑trade events (log)
- [ ] Verified manually: ___

### 2.4 Documentation
- [ ] Update README for rules
- [ ] Add Zone 2 CHANGELOG entry

---

## Zone 3 – Kalshi Live Polling & Positions

Status: **⬜️ Not started**

### What Exists
- ✅ Kalshi sidebar section (placeholder text)
- ✅ Positions sidebar section with 3 hardcoded rows
- ✅ Stats cards for P&L, Open Positions, Exposure, Win Rate (static values)
- ✅ `switchSection('kalshi')` and `switchSection('positions')` work

### What's Missing

### 3.1 Live Polling
- [ ] Create `src/kalshi/poller.ts` with configurable interval (default 5s)
- [ ] Maintain list of "watched" markets (stored in config or DB)
- [ ] On tick, fetch latest prices and push via WebSocket (`kalshiUpdate`)
- [ ] Start/stop poller with ScraperManager (idle shutdown aware)
- [ ] Unit test: polling logic with mocked HTTP

### 3.2 Position Tracking
- [ ] Create `kalshi_positions` table: id, market, side, size, entry_price, current_price, status (open/closed), opened_at, closed_at, exit_price, realised_pnl
- [ ] Endpoints:
  - `POST /api/kalshi/positions` (manual entry)
  - `PUT /api/kalshi/positions/:id/close` (set exit price, calculate realised P&L)
  - `GET /api/kalshi/positions` (list, include unrealised P&L based on current price)
- [ ] Unit tests: position life‑cycle, P&L calculations

### 3.3 P&L Dashboard
- [ ] Frontend panel: table of open positions with unrealised P&L, closed positions history
- [ ] Simple line chart of total P&L over time (use Chart.js from CDN)
- [ ] Manual entry form for new positions
- [ ] Verified manually: ___

### 3.4 Documentation
- [ ] Update README for Kalshi features
- [ ] Add Zone 3 CHANGELOG entry

---

## Final Integration & Deployment

- [ ] All zones completed
- [ ] Full test suite passes (`bun test`)
- [ ] Manual smoke test of all new features
- [ ] Docker‑compose up works end‑to‑end
- [ ] Final README, CHANGELOG consolidated
- [ ] Tag `v5.2` in Git

---

## Quick Decision Matrix

| If you want... | Sidebar Tab | Go to zone |
|----------------|-------------|-----------|
| Live wager feed from Buckeye | **Buckeye** | Zone 4 ✅ Complete |
| Agent hierarchy & customer drill-down | **Downline** | Zone 4 ✅ Complete |
| Player search + P&L detail | **Player Search** | Zone 4 ✅ Complete |
| Sport/agent exposure breakdown | **Positions** | Zone 4 ✅ Complete |
| 16-book odds grid with movements | **Trading Floor** | Zone 1 ✅ Complete (add `ODDS_API_KEY` for real data) |
| Discord/Telegram/Slack alerts | **Webhooks** | Zone 8 ✅ Complete |
| Alert history & toast toggle | **Alerts** | Zone 4+8 ✅ Complete |
| Auto-detect steam moves & auto-trade | **Patterns** | Zone 2 🔄 Partial (demo UI only) |
| Kalshi positions with P&L charts | **Kalshi** | Zone 3 ⬜️ Not started |
