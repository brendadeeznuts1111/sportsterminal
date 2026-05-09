# Buckeye PPH Backend v5.31 - Integration Scope

## Executive Summary

Sports Terminal integrates with Buckeye PPH (`fantasy402.com`) through direct HTTP APIs. The backend authenticates agents, stores secrets in the OS vault, restores vaulted agents on startup, and keeps live ingestion running while the backend process is alive.

The browser UI is now a client of the backend, not the owner of ingestion. Closing the browser does not stop Buckeye polling. Manual vault logout is the explicit action that removes credentials and prevents future automatic restore.

Amount units remain important:

- Buckeye wager amount fields arrive in cents.
- `BuckeyeAPI.normalizeWager()` converts them to dollars before persistence.
- SQLite stores dollars.
- Frontend displays dollars directly.

---

## Discovered Buckeye Endpoints

All Manager/System endpoints are under `https://fantasy402.com` unless overridden by `BUCKEYE_BASE_URL`.

| Family | Operation | Method | Path | Notes |
|--------|-----------|--------|------|-------|
| Auth | `authenticateCustomer` | POST | `/cloud/api/System/authenticateCustomer` | Returns short-lived JWT |
| Auth | `renewToken` | POST | `/cloud/api/System/renewToken` | Refreshes session |
| Wagers | `getBetTicker` | POST | `/cloud/api/Manager/getBetTicker` | Live wager feed |
| Wagers | `getBetTickerConfig` | POST | `/cloud/api/Manager/getBetTickerConfig` | Feed/config metadata |
| Access logs | `getWebLog` | POST | `/qubic/api/Manager/getWebLog` | Primary path for Buckeye IP/access tools |
| Access logs | `getWebLog` | POST | `/cloud/api/Manager/getWebLog` | Fallback path |
| Performance | `getAgentPerformance` | POST | `/cloud/api/Manager/getAgentPerformance` | Customer/sport/volume/graded report rows |
| Weekly figures | `getWeeklyFigureByAgentLite` | POST | `/cloud/api/Manager/getWeeklyFigureByAgentLite` | This week, active, today summary |
| Sports | `getSportsType` | POST | `/cloud/api/Manager/getSportsType` | Sports list seeding |
| Account | `getAccountInfoOwner` | POST | `/cloud/api/Manager/getAccountInfoOwner` | Owner/account context |
| Config | `getConfigWebReports` | POST | `/cloud/api/Manager/getConfigWebReports` | Report config context |
| Config | `getConfigWebReportsPending` | POST | `/cloud/api/Manager/getConfigWebReportsPending` | Pending report config |
| Config | `getAuthorizations` | POST | `/cloud/api/Manager/getAuthorizations` | Feature/permission context |
| Messages | `getMessage` | POST | `/cloud/api/Manager/getMessage` | Manager message context |
| Messages | `getNewEmailsCount` | POST | `/cloud/api/Manager/getNewEmailsCount` | Notification count |
| Agents | `getListAgenstByAgent` | POST | `/cloud/api/Manager/getListAgenstByAgent` | Downline/list context, name is misspelled upstream |

Authentication generally needs:

- `Authorization: Bearer <Buckeye JWT>`
- `Cookie: cf_clearance=<value>; __cf_bm=<value when available>`
- `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`
- `X-Requested-With: XMLHttpRequest` for Manager endpoints
- `agentID`, `agentOwner`, `agentSite=1`, `operation`, and `RRO=1` form fields

---

## Authentication and Vault Model

### Login Flow

1. User enters agent ID, password, and Cloudflare cookie in Settings.
2. Backend calls `authenticateCustomer`.
3. Backend receives a Buckeye JWT.
4. Backend stores available password, token, and cookie material in `Bun.secrets`.
5. Backend upserts the agent into the vault index.
6. Backend starts ingestion loops for that agent.

### Startup Restore

1. Backend reads the vault index from `Bun.secrets`.
2. Each vaulted agent is restored independently.
3. Token resume is attempted first.
4. If token resume fails, password/cookie login is attempted.
5. If one agent fails, it is marked unhealthy and other agents continue.

### Token Renewal

- Renewal runs on the current token renewal interval.
- Successful `renewToken` writes the new token back to the OS vault.
- Failed renewal falls back to re-auth with vaulted password/cookie.
- Repeated failure stops only that agent and marks `lastError`.

### Vault Status API

`GET /api/buckeye/vault-status` returns only presence flags:

```json
{
  "available": true,
  "agents": [
    {
      "agentId": "BILLY666",
      "hasPassword": true,
      "hasCfCookie": true,
      "hasToken": true,
      "active": true,
      "lastError": null
    }
  ]
}
```

It must never return secret values.

`DELETE /api/buckeye/vault-status?agentId=BILLY666` clears one agent.

`DELETE /api/buckeye/vault-status?all=1` clears all vaulted Buckeye agents.

---

## Live Ingestion Loops

The app uses managed recurring jobs in `backend/src/services/Scheduler.ts`. This is intentionally not `Bun.scheduler`, because the current Bun runtime does not expose that API.

| Loop | Default | Owner | Purpose |
|------|---------|-------|---------|
| Wagers | `POLL_INTERVAL_MS`, usually 5s | `ScraperManager` | Pull live `getBetTicker` deltas |
| Access logs | `ACCESS_LOG_INTERVAL_MS`, usually 10m | `ScraperManager` | Pull Buckeye IP/access data |
| Agent performance | `AGENT_PERFORMANCE_INTERVAL_MS`, usually 15m | `ScraperManager` | Pull customer/agent performance snapshots |
| Token renewal | `TOKEN_RENEWAL_MINUTES`, usually 15m | `ScraperManager` | Keep Buckeye JWT fresh |
| Odds | `ODDS_POLL_INTERVAL_MS`, usually 30s | `OddsPoller` | Update odds snapshots and movements |
| Book health | `BOOK_HEALTH_INTERVAL_MS`, usually 60s | `OddsPoller` | Update book status |

Browser clients do not start or stop these loops. Backend process lifetime controls them.

---

## Buckeye Request Details

### `getBetTicker`

Minimum form:

```text
agentID=<agent>
agentOwner=<owner>
agentSite=1
operation=getBetTicker
RRO=1
wagerNumber=<lastSeen>
```

Confirmed response row:

```json
{
  "WagerNumber": 749959076,
  "AgentID": "NXC337",
  "CustomerID": "NZ121 ",
  "Login": "NZ121",
  "WagerType": "M",
  "AmountWagered": 2500,
  "InsertDateTime": "2026-05-08 08:51:18.427",
  "ToWinAmount": 1397,
  "TicketWriter": "GSLIVE",
  "VolumeAmount": 2500,
  "ShortDesc": "M.G296512619 - Tennis - Geoffrey Blancaneaux vs Alejo Sanchez Quilez / 2nd Set / Winner (2 way) / Geoffrey Blancaneaux -179",
  "VIP": "0",
  "AgentLogin": "NXC337 "
}
```

### `getWebLog`

Buckeye UI exposes an IP Tracker module that calls `getWebLog` with action types:

| Action | Meaning |
|--------|---------|
| `A` | Web Access Log |
| `B` | Global IP Matcher |
| `C` | Account IP Match / player matcher |
| `I` | Users by IP |

Request shape observed from Buckeye JS:

```text
agentID=<agent>
customerID=<optional>
start=<MM/DD/YYYY>
end=<MM/DD/YYYY>
type=<type>
actions=<A|B|C|I>
ip=<optional>
operation=getWebLog
RRO=1
```

Limits from Buckeye UI:

- Users-by-IP maximum range: 7 days.
- Access logs maximum range: 30 days.

Persisted fields:

- `LoginID`
- `IPAddress`
- `AccessDateTime`
- `Operation`
- `Data`
- `type`
- `agent_id`
- `pulled_at`

### `getAgentPerformance`

Representative form:

```text
start=04%2F28%2F2026
end=05%2F09%2F2026
agentID=BILLY666
type=CP
freePlay=Y
store=BILLY666
sport=Basketball++++++++++
subsport=NBA
period=-1
wagerType=
betType=
tipo=0
debug=0
operation=getAgentPerformance
RRO=1
agentOwner=SHARPTOBBY
agentSite=1
```

Important fields:

| Field | Meaning |
|-------|---------|
| `start`, `end` | Report date range, `MM/DD/YYYY` |
| `agentID` | Agent or master being queried |
| `type` | Report type. Known: `CP` customer performance, `CPS` sport performance, `CPV` customer volume, `G` graded wagers |
| `freePlay` | Include free play flag, observed `Y` |
| `store` | Store/root agent context |
| `sport` | Sport value from `getSportsType`, often padded |
| `subsport` | League/subsport, such as `NBA` |
| `period` | `-1` all, `0` game, `1` first half, `2` second half, quarters `3`-`6` |
| `wagerType` | `S`, `P`, `T`, `I`, `C`, `A`, or blank |
| `betType` | `S` spread, `M` money line, `L` total, `E` team total, or blank |
| `tipo` | Activity filter. `-1` all action, `0` sports, `4` live betting, other values for casino/racebook/poker/etc. |
| `debug` | Debug flag, observed `0` |

Confirmed response row:

```json
{
  "CustomerID": "CF346     ",
  "AgentID": "CHEDDFAM",
  "Login": "CF346 (pw:fixes)",
  "wagercount": 1,
  "Risk": 25.95,
  "ToWin": 79.14,
  "amountwon": 79.14,
  "amountlost": 0,
  "volume": 25.95,
  "net": 79.14
}
```

### `getSportsType`

Known values:

```text
Auto Racing
Baseball
Basketball
Boxing
Cricket
Entertainment
Esports
Football
Golf
Hockey
Horse Racing
LIVE
Martial Arts
Olympics
Other
Rugby
Soccer
Tennis
Virtual Sports
```

Persist trimmed display values but keep raw values when they matter for upstream requests.

---

## Persistence Contract

Important tables:

| Table | Purpose |
|-------|---------|
| `wagers` | Normalized Buckeye wager rows |
| `alerts` | Risk alert history |
| `access_logs` | Buckeye `getWebLog` rows |
| `agent_performance_snapshots` | Buckeye performance report rows |
| `buckeye_sport_types` | Seeded sport types |
| `ingestion_checkpoints` | Last processed sequence, pull time, and metadata per entity |
| `detected_patterns` | Pattern/anomaly history |
| `pattern_agents` | Pattern to agent links |
| `odds_snapshots` | Odds provider snapshots |
| `line_movements` | Odds movement history |
| `alert_webhooks` | Webhook definitions |
| `webhook_deliveries` | Webhook delivery attempts |

Checkpoint guidance:

- `wagers`: store highest `WagerNumber`.
- `hierarchy`: store parsed row count or max sequence when available.
- `players`: store parsed row count and file hash metadata.
- `access_logs`: store latest pulled `AccessDateTime`.
- `agent_performance`: store latest successful report window and row count.

---

## Pattern Detection Inputs

Pattern detection depends on the correlation layer:

- Parse wager `ShortDesc` into canonical sport, game, market, side, price, and period.
- Match parsed wager to an odds event by sport, team aliases, and event window.
- Capture nearest/current Pinnacle/reference price at wager ingest time.
- Store evidence and reason codes so history remains explainable.

Core pattern families:

- Shared IP Cluster
- IP Follow Pattern
- Agent Swarm
- Cross-Agent Swarm
- Live Past-Post Risk
- Late Live Spike
- Pinnacle Drift Bet
- Post-PIN Move Bet
- Reverse Public/Sharp Bet
- Repeat Timing Signature
- Steam Chase
- Bad Feed / Book Risk

---

## WebSocket Events

Server-to-client events include:

```typescript
type WsEventType =
  | 'wager.new'
  | 'wager.alert'
  | 'exposure.update'
  | 'pattern.alert'
  | 'pattern.update'
  | 'auth_failed'
  | 'betAction';
```

Pattern deltas should stay small for high-frequency updates. Prefer agent ID, count increment, severity, and pattern ID; fetch details lazily from history endpoints when needed.

---

## Safety Rules

- Never log raw passwords, Buckeye JWTs, or Cloudflare cookies.
- Vault status endpoints must only return boolean presence flags.
- Keep raw exported Buckeye hierarchy/player files ignored.
- Normalize money exactly once, in the backend.
- Do not stop live ingestion just because the UI disconnects.
- If one vaulted agent fails restore, continue restoring the rest.
- Treat old Pinnacle/reference comparisons as best effort unless a reference snapshot was captured at wager ingest time.
- Raw API logging is fire-and-forget — never let a logging failure propagate to the caller.
- All pollers use watermark-based recovery — cursors persist across restarts.
- Exponential backoff on errors: 5s → 10s → 20s → 40s → max 60s, reset on success.
- Token renewal every 15 min; fallback to password re-login (max 3 attempts), then stop agent.

## Audit & Analytics Layer

The Audit & Analytics Engine (implemented May 2026) adds:

### Database Tables
- `raw_api_logs` — Batched, PII-redacted response audit trail
- `wager_archive` — Immutable wager archive with raw JSON preservation
- `access_logs` — Watermark-based incremental access log storage
- `master_snapshots` — 30-min account balance/book snapshots
- `weekly_figures` — Weekly figure report archive
- `agent_performance` — Raw agent performance report archive
- `audit_logs` — Operator/system action trail
- `watermarks` — Restart-safe poller cursors

### Polling Schedule
| Poller | Interval | Watermark Key |
|--------|----------|---------------|
| Access Logs | 5 min | `last_access_log_poll.{agentId}` |
| Master Snapshots | 30 min | `last_master_snapshot.{agentId}` |
| Daily Archive | 24 hours | `last_daily_archive_refresh.{agentId}` |
| Agent Performance | 15 min | `last_agent_performance.{agentId}` |

### Analytics Endpoints
- `GET /api/betting/velocity` — Wager count and handle per minute
- `GET /api/betting/live-vs-pre` — Live vs pregame volume split
- `GET /api/logs/access` — Access log monitor with new-IP detection
- `GET /api/master/history` — Master account snapshot history
- `GET /api/performance/summary` — Agent performance summary
- `GET /api/performance/details` — Agent deep dive with trend + sport breakdown
- `GET /api/export/wagers` — CSV export of wager archive
- `GET /api/export/access-logs` — CSV export of access logs
- `GET /api/export/performance` — CSV export of weekly figures

### Frontend Tabs
- **Performance** — Master health card, velocity chart (Chart.js), live vs pregame donut, access log monitor, agent performance table, CSV exports. Real-time WebSocket updates.
- **Up** — Error tracking dashboard with poller health, watermark status, error history, and recovery matrix.

---

## Verification

```powershell
bun test
bun run build
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/api/buckeye/vault-status
Invoke-RestMethod http://localhost:3000/api/betting/velocity?minutes=10
Invoke-RestMethod http://localhost:3000/api/betting/live-vs-pre
Invoke-RestMethod http://localhost:3000/api/master/history?limit=5
Invoke-RestMethod http://localhost:3000/api/performance/summary
```

For endpoint work, add or update route tests and at least one synthetic fixture that mirrors the observed Buckeye response shape.
