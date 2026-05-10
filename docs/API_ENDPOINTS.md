# Sports Terminal — API Endpoint Reference

> **Live server:** `http://localhost:3000`
> **Captured:** May 9, 2026 — All examples are real responses from the running server.

---

## Table of Contents

1. [Health & Status](#1-health--status)
2. [Wagers](#2-wagers)
3. [Agents](#3-agents)
4. [Players](#4-players)
5. [Risk & Exposure](#5-risk--exposure)
6. [Odds & Patterns](#6-odds--patterns)
7. [Buckeye Proxy](#7-buckeye-proxy)
8. [Performance Cache](#8-performance-cache)
9. [Webhooks](#9-webhooks)
10. [Audit & Analytics](#10-audit--analytics)
11. [CSV Exports](#11-csv-exports)
12. [Error Handling & Recovery](#12-error-handling--recovery)

---

## 1. Health & Status

### `GET /health`

Server health check with uptime and active agent info.

**Response 200:**
```json
{
  "status": "ok",
  "uptime": 568.86,
  "scrapers": {
    "activeAgents": 1,
    "agents": [
      {
        "agentId": "BILLY666",
        "lastPoll": 1778340008911,
        "errorCount": 0,
        "authenticated": true
      }
    ],
    "actionQueue": {
      "totalQueued": 0,
      "queues": {}
    },
    "counters": {
      "wagers_total": 529,
      "alerts_triggered_total": 144,
      "errors_total": 0
    }
  }
}
```

### `GET /api/health/system-status`

Consolidated System Status issue feed for operator bug/risk tracking. Rolls up scraper errors, action queue backlog, recent raw API failures, grouped Player 360 source errors, offline odds books, and critical/high patterns. Repeated Player 360 failures caused by an expired Buckeye session are grouped into one agent-level issue so operators can distinguish session/upstream failures from parser or database bugs.

```json
{
  "status": "warning",
  "operationalStatus": "ok",
  "riskStatus": "warning",
  "generatedAt": "2026-05-09T23:35:00.000Z",
  "summary": {
    "activeAgents": 1,
    "rawApiFailures24h": 0,
    "playerSourceErrors": 0,
    "issues": 0,
    "critical": 0,
    "warning": 0
  },
  "dataFlows": {
    "liveWagers": {"status": "live", "rowCount": 25654, "lastSeen": "2026-05-10T00:33:23.905Z"},
    "wagerArchive": {"status": "live", "rowCount": 25654, "distinctWagers": 25654, "reconciled": true},
    "playerTransactions": {"status": "live", "rowCount": 1979630},
    "agentHierarchy": {"status": "live", "rowCount": 2288, "roots": 3, "maxLevel": 17},
    "playerAgentMap": {"status": "live", "rowCount": 56028, "orphanCount": 0},
    "patterns": {"status": "live", "rowCount": 929, "last24h": 929},
    "exposureInputs": {"status": "live", "rowCount": 25654, "sportCount": 26, "agentCount": 485},
    "crossReferences": {"status": "live", "rowCount": 58491, "playerAgentRows": 56028, "accessRows": 2102, "uniqueIps": 422, "playerLinkRows": 94, "patternAgentRows": 267}
  },
  "issues": []
}
```

`status` is the overall operator status. `operationalStatus` excludes pattern/risk detections so a healthy data pipeline is distinguishable from a high-risk betting day. `dataFlows` is computed from local tables only and is safe to poll from the Status page. `crossReferences` is a cheap readiness row for Player 360 investigation links; it combines player-agent maps, access logs, player links, and pattern-agent links.

### `GET /api/stats`

Global aggregate statistics across all wagers.

**Response 200:**
```json
{
  "totalWagers": 12155,
  "totalVolume": 14255419.61,
  "agentCount": 440,
  "alertCount": 8533,
  "liveCount": 2411
}
```

### Stats Matrix Endpoint Map

These endpoints are the active stats/performance/exposure matrix used by the dashboard and operator views. All rows are read-only and backed by local SQLite tables unless noted.

| Endpoint | Source tables | Primary UI / use |
|----------|---------------|------------------|
| `/api/stats` | `wagers` | Global wager totals, live count, alert count, agent count |
| `/api/exposure/sports` | `wagers`, parsed game fields | Positions sport exposure table |
| `/api/exposure/agents` | `wagers`, parsed game fields | Positions agent exposure table |
| `/api/agents/:agentId/performance` | `wagers` | Agent detail performance summary |
| `/api/agents/:agentId/exposure` | `wagers` | Agent detail exposure drill-down |
| `/api/betting/velocity` | `wager_archive` | Betting velocity timeline |
| `/api/betting/live-vs-pre` | `wager_archive` | Live vs pregame split |
| `/api/analytics/wager-velocity` | `wagers` | Recent live wager velocity by hour |
| `/api/analytics/performance-trends` | `agent_performance_snapshots` | Agent performance trend matrix |
| `/api/performance/summary` | `weekly_figures` | Weekly figure rollup by agent |
| `/api/performance/details` | `weekly_figures`, `agent_performance` | Agent performance deep dive |
| `/api/master/history` | `master_snapshots` | Master account balance history |
| `/api/analytics/raw-logs` | `raw_api_logs` | Raw API audit/error matrix |
| `/api/analytics/weekly-figures` | `weekly_figures` | Weekly figure archive browser |
| `/api/analytics/master-snapshots` | `master_snapshots` | Master snapshot archive browser |
| `/api/health/data-pipeline` | `raw_api_logs`, `weekly_figures`, `master_snapshots`, `wagers`, `agent_performance_snapshots`, `access_logs` | Pipeline row-count health |

---

## 2. Wagers

### `GET /api/wagers?limit=3`

Paginated wager list from the live `wagers` table.

**Query params:** `limit` (default 200), `offset` (default 0)

**Response 200:**
```json
[
  {
    "wager_number": 750054624,
    "agent_id": "NICROB",
    "customer_id": "GAVINB24",
    "login": "GAVINB24",
    "wager_type": "L",
    "amount_wagered": 325,
    "to_win_amount": 250,
    "volume_amount": 250,
    "insert_datetime": "2026-05-09 11:20:16.280",
    "ticket_writer": "Internet",
    "short_desc": "L.Tennis #18708 V Golubic Games/M Andreeva Games U 17 -130 - For Game",
    "vip": "0",
    "agent_login": "NICROB",
    "sport": "Tennis",
    "scraped_at": "2026-05-09T15:20:18.915Z",
    "parsed_game": "V Golubic Games/M Andreeva Games U 17",
    "parsed_market": "total",
    "parsed_side": "under",
    "parsed_price": -130,
    "parsed_period": "game",
    "matched_event_id": null,
    "pin_reference_json": "{}",
    "raw_json": "{\"WagerNumber\":750054624,\"AgentID\":\"NICROB\",\"CustomerID\":\"GAVINB24\",\"Login\":\"GAVINB24\",\"WagerType\":\"L\",\"AmountWagered\":325,\"ToWinAmount\":250,\"VolumeAmount\":250,\"InsertDateTime\":\"2026-05-09 11:20:16.280\",\"TicketWriter\":\"Internet\",\"ShortDesc\":\"L.Tennis #18708 V Golubic Games/M Andreeva Games U 17 -130 - For Game\",\"VIP\":\"0\",\"AgentLogin\":\"NICROB\"}"
  },
  {
    "wager_number": 750054614,
    "agent_id": "COLEMO",
    "customer_id": "CM422",
    "login": "CM422",
    "wager_type": "E",
    "amount_wagered": 115,
    "to_win_amount": 100,
    "volume_amount": 100,
    "insert_datetime": "2026-05-09 11:20:04.960",
    "ticket_writer": "Internet",
    "short_desc": "E.Basketball #501 Pistons O 53 -115 - For 1st Half",
    "vip": "0",
    "agent_login": "COLEMO",
    "sport": "Basketball",
    "scraped_at": "2026-05-09T15:20:08.918Z",
    "parsed_game": "Pistons O 53",
    "parsed_market": "total",
    "parsed_side": "over",
    "parsed_price": -115,
    "parsed_period": "1st half",
    "matched_event_id": null,
    "pin_reference_json": "{}",
    "raw_json": "{\"WagerNumber\":750054614,\"AgentID\":\"COLEMO\",\"CustomerID\":\"CM422\",\"Login\":\"CM422\",\"WagerType\":\"E\",\"AmountWagered\":115,\"ToWinAmount\":100,\"VolumeAmount\":100,\"InsertDateTime\":\"2026-05-09 11:20:04.960\",\"TicketWriter\":\"Internet\",\"ShortDesc\":\"E.Basketball #501 Pistons O 53 -115 - For 1st Half\",\"VIP\":\"0\",\"AgentLogin\":\"COLEMO\"}"
  },
  {
    "wager_number": 750054610,
    "agent_id": "COLEMO",
    "customer_id": "CM422",
    "login": "CM422",
    "wager_type": "E",
    "amount_wagered": 115,
    "to_win_amount": 100,
    "volume_amount": 0,
    "insert_datetime": "2026-05-09 11:20:01.453",
    "ticket_writer": "ALERT",
    "short_desc": "E:Basketball #501 Pistons O 53 -115 - For 1st Half",
    "vip": "0",
    "agent_login": "COLEMO",
    "sport": "Basketball",
    "scraped_at": "2026-05-09T15:20:04.089Z",
    "parsed_game": "Pistons O 53",
    "parsed_market": "total",
    "parsed_side": "over",
    "parsed_price": -115,
    "parsed_period": "1st half",
    "matched_event_id": null,
    "pin_reference_json": "{}",
    "raw_json": "{\"WagerNumber\":750054610,\"AgentID\":\"COLEMO\",\"CustomerID\":\"CM422\",\"Login\":\"CM422\",\"WagerType\":\"E\",\"AmountWagered\":115,\"ToWinAmount\":100,\"VolumeAmount\":0,\"InsertDateTime\":\"2026-05-09 11:20:01.453\",\"TicketWriter\":\"ALERT\",\"ShortDesc\":\"E:Basketball #501 Pistons O 53 -115 - For 1st Half\",\"VIP\":\"0\",\"AgentLogin\":\"COLEMO\"}"
  }
]
```

### `GET /api/wagers/alerts`

Wagers flagged with `ticket_writer = 'ALERT'`.

### `GET /api/wagers/live`

Wagers placed in-play (`ticket_writer = 'GSLIVE'`).

---

## 3. Agents

### `GET /api/agents`

List all unique agent logins with aggregate stats.

### `GET /api/agents/downline`

Agent hierarchy with player counts and volume.

### `GET /api/agents/hierarchy`

Raw Buckeye agent tree from `getListAgenstByAgent`.

The route returns the locally persisted Buckeye hierarchy first, then a live Buckeye call when authenticated, then ignored local seed captures as a fallback. This avoids repeatedly calling the upstream manager list endpoint for mostly static agent/customer structure.

**Live upstream source:**
```text
POST https://fantasy402.com/cloud/api/Manager/getListAgenstByAgent
agentID=<agent>&agentType=M&operation=getListAgenstByAgent&RRO=1&agentOwner=<owner>&agentSite=1
```

**Response 200:**
```json
{
  "GENERAL": [
    {
      "AgentID": "BILLY667",
      "SeqNumber": 5735,
      "Level": 1,
      "AgentType": "A",
      "Login": "BILLY667",
      "ParentAgentID": "",
      "PlayerCount": 12,
      "ChildCount": 0
    }
  ],
  "source": "database"
}
```

Raw seed captures may include `PLAYERS`, but local API responses and database rows must not expose upstream player passwords.

### `GET /api/agents/access-logs`

Buckeye web access logs (proxied from `getWebLog`).

### `GET /api/agents/:agentId/performance`

Per-agent performance metrics from the `wagers` table.

### `GET /api/agents/:agentId/exposure`

Per-agent exposure breakdown with top customers and games.

### `GET /api/agents/backfill/hierarchy` (POST)

Trigger a hierarchy backfill from stored agent data.

Parses ignored local seed files (`docs/agentobject.md` and `docs/agentslistharz.md`) and upserts Buckeye agents plus sanitized players/customers into the local database.

**Response 200:**
```json
{
  "success": true,
  "provider": "buckeye",
  "agents": 440,
  "players": 12000,
  "linkedPlayers": 12000,
  "placeholderAgents": 0,
  "maxSeqNumber": 6174
}
```

---

## 4. Players

### `GET /api/players/:playerId/details`

Player profile with wager count, volume, risk, and projected net exposure.

### `GET /api/players/:playerId/wagers`

All wagers for a specific player (last 200).

### `GET /api/players/:playerId/pnl`

Daily P&L history over N days (default 7).

### `GET /api/v1/players/:playerId/profile`

Player 360 profile from local archive tables. The response includes `agent`, `allAgents`, `agentContext`, and `freePlaySummary` when those records are available.

### `GET /api/v1/players/:playerId/transactions?category=freeplay`

Player transaction ledger filtered to free-play categories when `category=freeplay` is provided.

### `GET /api/v1/freeplay/analysis`

Aggregates free-play rows from `player_transactions`.

Query params: `playerId`, `agentId`, `from`, `to`, `groupBy=player|agent|day`.

Response totals include `issued`, `redeemed`, `expired`, `adjustments`, `outstandingEstimate`, `transactionCount`, and `sourceConfidence`. Groups use the same totals contract.

`sourceConfidence` is computed at response time from `tranType`, `description`, and `rawJson`; it is not stored as a `player_transactions` column. Rows with explicit `free play`, `freeplay`, or `bonus play` text are `confirmed`; broader promotional/free-play candidates remain `candidate`.

### `GET /api/v1/cross-reference?playerId=&agentId=`

Read-only local context graph for operator investigations. It does not call Buckeye. It joins the selected player or agent across player-agent maps, agent hierarchy, wager archive, access logs, free-play ledger rows, source status, player links, and detected patterns.

**Response shape:**

```json
{
  "entity": {"playerId": "WC8036", "agentId": "ADAM", "type": "player"},
  "agentContext": {"assigned": {"login": "ADAM", "level": 5}, "lineageLabel": "BLUEPPH > ADAM"},
  "playerContext": {"linkCount": 2},
  "wagerContext": {"rowCount": 24, "totalVolume": 15420, "lastSeen": "2026-05-09 20:31:00"},
  "accessContext": {"rowCount": 8, "uniqueIps": 3, "sharedIpCount": 1, "latestGeo": "Dallas, TX, US"},
  "freePlayContext": {"issued": 0, "redeemed": 0, "expired": 0, "outstandingEstimate": 0, "sourceConfidence": "confirmed"},
  "patternContext": {"total": 1, "critical": 0, "warning": 1},
  "dataQuality": {
    "missingAgentMap": false,
    "staleAccessLogs": false,
    "missingTransactions": false,
    "orphanPlayerAgentMap": false,
    "patternEvidencePresent": true,
    "freePlayCandidateOnly": false
  }
}
```

### Local Integrity Check

Run the read-only local integrity audit without calling Buckeye:

```bash
bun run integrity:check
```

The check reconciles `wagers` against `wager_archive`, verifies the legacy `wager_type IN (...)` constraint is gone, checks blank wager identities, checks orphan `player_agent_map` rows, and validates the expected seeded hierarchy shape (`3` roots, `2288` agents, max level `17`). It flags anomalies such as zero-amount wagers or newly observed wager type codes without deleting data.

---

## 5. Risk & Exposure

### `GET /api/risk/alerts`

Active unresolved alerts.

### `GET /api/exposure/sports`

Sport-level exposure breakdown with top game per sport.

### `GET /api/exposure/agents`

Agent-level exposure breakdown with top customer and game.

---

## 6. Odds & Patterns

### `GET /api/odds/live`

Current live odds when a live odds provider is configured. Synthetic odds require explicit `ODDS_DEMO_MODE=true` and are reserved for tests/local development.

### `GET /api/odds/events`

All tracked events/games.

### `GET /api/odds/events/:eventId`

Single event detail.

### `GET /api/odds/snapshots`

Per-event per-book odds snapshots.

### `GET /api/odds/movements`

Line movement history.

### `GET /api/books`

Book configuration and metadata.

### `GET /api/books/status`

Book health status.

### `GET /api/patterns/history`

Detected pattern history.

### `GET /api/patterns/catalog`

Active detector catalog for the Patterns tab. This is the operator-facing contract for pattern definitions and includes source tables, thresholds, severity rules, reason codes, evidence fields, detector name, and confidence.

**Response 200:**
```json
{
  "generatedAt": "2026-05-10T00:00:00.000Z",
  "count": 16,
  "patterns": [
    {
      "type": "Agent Swarm",
      "label": "Agent Swarm",
      "category": "agents",
      "status": "active",
      "sourceTables": ["wagers", "detected_patterns", "pattern_agents"],
      "detector": "PatternService.analyzeWager",
      "trigger": "Same agent has 4 or more matching wagers, or 3 or more distinct players, inside 10 minutes.",
      "confidence": "derived"
    }
  ]
}
```

### `GET /api/patterns/summary`

Pattern summary by type.

### `GET /api/patterns/agents`

Patterns grouped by agent.

---

## 7. Buckeye Proxy

### `GET /api/buckeye/vault-status`

Buckeye credential vault status.

### `DELETE /api/buckeye/vault-status`

Clear stored credentials.

### `GET /api/buckeye/ui-config`

Buckeye UI language/theme configuration.

### `GET /api/buckeye/account-info`

Master account info (balance, limits, feature flags).

### `GET /api/buckeye/weekly-figures`

Weekly figure report by agent.

### `GET /api/buckeye/agent-performance`

Agent performance report.

### `GET /api/buckeye/agent-performance/options`

Available performance report options.

### `GET /api/buckeye/access-logs`

Buckeye web access logs.

### `GET /api/buckeye/sports-types`

Seeded sports type list.

### `GET /api/buckeye/manager-snapshot`

Full manager bootstrap snapshot.

### `GET /api/buckeye/players-list`

Live player/customer list from Buckeye (`getPlayers`). Returns `LIST` array with `customerID`, `Login`, `NameFirst`, `Password`, `Agent`. No `SeqNumber` field is present — players do not have sequence numbers in the Buckeye API.

**Response 200:**
```json
{
  "LIST": [
    {"customerID": "S844", "Login": "S844", "NameFirst": "Laney Naramore", "Password": "Cliffy123", "Agent": "CSUTT"}
  ]
}
```

### `POST /api/connect`

Authenticate and start polling for a Buckeye agent.

### Standalone enhanced proxy

The standalone proxy runs through `bun run enhanced-proxy.ts` and is separate from the main backend API. It is useful for isolated Buckeye proxy diagnostics, cache tests, and WebSocket ticker experiments.

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Service metadata and enabled runtime features |
| `/features` | GET | Feature flags and tunables as loaded from environment variables |
| `/metrics` | GET | Runtime memory, CPU, JSC stats, request counts, latency samples, token count, and subscriber count when `ENABLE_METRICS=true` |
| `/ready` | GET | Readiness probe; returns 200 only when a usable stored token exists |
| `/config` | POST | Reload environment-backed config for the running proxy |
| `/ws` | WebSocket | Subscribe to live ticker events with `{ "type": "subscribe", "customerID", "token", "cf_clearance" }` |
| `/api/proxy/auth` | POST | Authenticate against Buckeye and persist an auth-code/token row |
| `/api/proxy/:endpoint` | POST | Proxy a Buckeye endpoint with optional cache, stream mode, retry, idempotency, and rate limiting |
| `/api/proxy/tokens?customerID=...` | GET | Stored token status for one customer |
| `/api/proxy/logs?limit=50` | GET | Recent enhanced-proxy request log rows |
| `/api/proxy/health?cf_clearance=...` | GET | Buckeye and SQLite dependency check |

Feature flags are documented in `docs/DATA_DICTIONARY.md`. The most common smoke-test set is:

```powershell
$env:ENABLE_METRICS='true'
$env:ENABLE_RESPONSE_COMPRESSION='true'
$env:ENABLE_RETRY='true'
$env:ENABLE_WS_COMPRESSION='true'
$env:ENABLE_PER_CUSTOMER_RATE_LIMIT='true'
bun run enhanced-proxy.ts
Invoke-RestMethod http://localhost:3001/features
Invoke-RestMethod http://localhost:3001/metrics
```

---

## 8. Performance Cache

### `GET /api/performance/status`

Redis cache status.

**Response 200 (disabled):**
```json
{
  "available": false,
  "message": "Performance cache not initialized — set REDIS_URL to enable"
}
```

### `GET /api/performance/:agentId`

Get cached performance data for an agent.

### `DELETE /api/performance/:agentId`

Invalidate cached performance data.

---

## 9. Webhooks

### `GET /api/webhooks`

List all configured webhooks.

### `POST /api/webhooks`

Create a new webhook.

**Request body:**
```json
{
  "name": "Discord Alerts",
  "platform": "discord",
  "url": "https://discord.com/api/webhooks/...",
  "triggers": ["critical", "warning"]
}
```

### `GET /api/webhooks/:webhookId`

Get a single webhook.

### `PUT /api/webhooks/:webhookId`

Update a webhook.

### `DELETE /api/webhooks/:webhookId`

Delete a webhook.

### `GET /api/webhooks/:webhookId/deliveries`

Delivery log for a webhook.

---

## 10. Audit & Analytics

### `GET /api/analytics/raw-logs`

Redacted Buckeye API archive rows for operator inspection.

**Query params:** `endpoint`, `agentId`, `status` (`success`, `warning`, `error`, or numeric code), `days` (default 7), `limit` (default 50, max 500), `includeBody=1`.

**Response 200:**
```json
{
  "logs": [
    {
      "id": 1,
      "endpoint": "/api/buckeye/account-info",
      "fetched_at": "2026-05-09 12:00:00",
      "agent_id": "BILLY666",
      "duration_ms": 42,
      "status_code": 200,
      "request_params": "{\"agentId\":\"BILLY666\"}",
      "request_params_summary": "agentId=BILLY666"
    }
  ],
  "count": 1,
  "days": 7,
  "endpoint": null,
  "agentId": null,
  "status": null,
  "includeBody": false
}
```

When `includeBody=1`, each row also includes `response_json`. The value is already redacted by `RawApiLogger`; callers must still render it as escaped text, never HTML.

---

### `GET /api/betting/velocity?minutes=30`

Bet ticker velocity — wager count and handle per minute over the last N minutes.

**Query params:** `minutes` (default 30, max 60)

**Response 200 (no recent wagers):**
```json
{
  "minutes": 30,
  "velocity": []
}
```

**Response 200 (with data):**
```json
{
  "minutes": 30,
  "velocity": [
    {
      "timestamp": "2026-05-09 11:15",
      "wagerCount": 8,
      "totalHandle": 2450.50
    },
    {
      "timestamp": "2026-05-09 11:16",
      "wagerCount": 12,
      "totalHandle": 3800.00
    }
  ]
}
```

---

### `GET /api/betting/live-vs-pre?date=2026-05-09`

Live vs pregame volume split for a given date.

**Query params:** `date` (default today, format `YYYY-MM-DD`)

**Response 200:**
```json
{
  "date": "2026-05-09",
  "live": {
    "count": 154,
    "volume": 186575.84
  },
  "pregame": {
    "count": 677,
    "volume": 149860.50
  }
}
```

| Field | Description |
|-------|-------------|
| `live.count` | Number of in-play wagers (GSLIVE) |
| `live.volume` | Total handle of in-play wagers |
| `pregame.count` | Number of pre-game wagers |
| `pregame.volume` | Total handle of pre-game wagers |

---

### `GET /api/logs/access?agent=X&ip=Y&limit=100`

Access log monitor with new IP detection.

**Query params:** `agent` (optional filter), `ip` (optional filter), `limit` (default 100, max 500)

**Response 200 (no logs yet):**
```json
{
  "logs": [],
  "count": 0
}
```

**Response 200 (with data):**
```json
{
  "logs": [
    {
      "id": 1,
      "agent_id": "BILLY666",
      "login_id": "player1",
      "ip_address": "192.168.1.100",
      "access_datetime": "2026-05-09 14:30:00",
      "operation": "LOGIN",
      "log_type": "A",
      "raw_json": "{\"LoginID\":\"player1\",\"IPAddress\":\"192.168.1.100\",...}",
      "first_seen": "2026-05-09 14:30:00",
      "is_new_ip": true
    }
  ],
  "count": 1
}
```

| Field | Description |
|-------|-------------|
| `is_new_ip` | `true` if this IP is seen for the first time in the last 30 days |
| `first_seen` | Timestamp of the first occurrence of this IP |

---

### `GET /api/master/history?limit=100`

Master account balance snapshots over time.

**Query params:** `limit` (default 100, max 500)

**Response 200 (no snapshots yet):**
```json
{
  "snapshots": [],
  "count": 0
}
```

**Response 200 (with data):**
```json
{
  "snapshots": [
    {
      "id": 1,
      "provider": "buckeye",
      "agent_id": "BILLY666",
      "timestamp": "2026-05-09 14:30:00",
      "balance": 250000.00,
      "available_balance": 185000.00,
      "percent_book": 74.0,
      "open_wager_count": 47,
      "account_info_json": "{...}",
      "raw_json": "{...}"
    }
  ],
  "count": 1
}
```

| Field | Description |
|-------|-------------|
| `balance` | Current master balance |
| `available_balance` | Available balance (net of open risk) |
| `percent_book` | Percentage of balance currently booked |
| `open_wager_count` | Number of open/unsettled wagers |

---

### `GET /api/performance/summary?week=2026-W19`

Agent performance summary from archived weekly figures.

**Query params:** `week` (optional, ISO week format `YYYY-Www`)

**Response 200:**
```json
{
  "week": null,
  "summary": [
    {
      "agent_id": "BILLY666",
      "row_count": 14113,
      "handle": 329413.84,
      "win_loss": -220820.74,
      "last_ingested_at": "2026-05-09T15:16:17.333Z"
    }
  ],
  "count": 1
}
```

| Field | Description |
|-------|-------------|
| `row_count` | Number of weekly figure rows for this agent |
| `handle` | Total handle (volume wagered) |
| `win_loss` | Net win/loss (negative = agent lost, house won) |
| `last_ingested_at` | Most recent archive ingestion timestamp |

---

### `GET /api/performance/details?agent=BELLO3&weeks=8`

Deep-dive performance detail for a single agent.

**Query params:** `agent` (required), `weeks` (default 8, max 52)

**Response 200 (no data yet):**
```json
{
  "agentId": "BELLO3",
  "weeks": 4,
  "weeklyTrend": [],
  "sportBreakdown": [],
  "latestRaw": null
}
```

**Response 200 (with data):**
```json
{
  "agentId": "BILLY666",
  "weeks": 8,
  "weeklyTrend": [
    {
      "week_start_date": "2026-W18",
      "sport": "Basketball",
      "handle": 45000.00,
      "win_loss": -3200.00,
      "wager_type": "M",
      "ingested_at": "2026-05-09T15:16:17.333Z"
    },
    {
      "week_start_date": "2026-W18",
      "sport": "Tennis",
      "handle": 12000.00,
      "win_loss": 850.00,
      "wager_type": "M",
      "ingested_at": "2026-05-09T15:16:17.333Z"
    }
  ],
  "sportBreakdown": [
    {
      "sport": "Basketball",
      "rows": 45,
      "handle": 45000.00,
      "win_loss": -3200.00
    },
    {
      "sport": "Tennis",
      "rows": 12,
      "handle": 12000.00,
      "win_loss": 850.00
    }
  ],
  "latestRaw": {
    "recorded_at": "2026-05-09T15:16:17.333Z",
    "performance_json": "{...}"
  }
}
```

| Field | Description |
|-------|-------------|
| `weeklyTrend` | Weekly time-series of handle and win/loss by sport |
| `sportBreakdown` | Aggregate handle and win/loss grouped by sport |
| `latestRaw` | Most recent raw agent_performance JSON blob |

---

## 11. CSV Exports

All CSV endpoints return `Content-Type: text/csv` with `Content-Disposition: attachment`.

### `GET /api/export/wagers`

Full wager archive as CSV.

**Response 200:**
```
wager_number,agent_id,customer_id,login,wager_type,amount_wagered,to_win_amount,insert_date_time,ticket_writer,volume_amount,short_desc_raw,vip,agent_login,ingested_at,raw_json,sport,league,price
750054624,NICROB,GAVINB24,GAVINB24,L,325,250,2026-05-09 11:20:16.280,Internet,250,"L.Tennis #18708 V Golubic Games/M Andreeva Games U 17 -130 - For Game",0,NICROB,2026-05-09T15:20:18.915Z,"{""WagerNumber"":750054624,...}",Tennis,,250
```

### `GET /api/export/access-logs`

Access log archive as CSV.

**Response 200:**
```
id,agent_id,login_id,ip_address,access_datetime,operation,data,log_type,pulled_at,raw_json
```

### `GET /api/export/performance`

Weekly figures archive as CSV.

**Response 200:**
```
id,agent_id,week_start_date,sport,handle,win_loss,wager_type,raw_json,ingested_at
1,BILLY666,2026-W18,Basketball,45000,-3200,M,"{...}",2026-05-09T15:16:17.333Z
```

---

## WebSocket Events

The server broadcasts real-time events to authenticated WebSocket clients.

### Connection

```
ws://localhost:3000?token=<jwt>
```

### Authentication

```json
{"type": "auth", "agentId": "BILLY666", "password": "***", "cfCookie": "cf_clearance=..."}
```

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `wager.new` | `{ wager_number, agent_id, login, amount_wagered, ... }` | New wager detected |
| `wager.alert` | `{ wager_number, rule_name, severity, message }` | Alert triggered |
| `exposure.update` | `{}` | Exposure recalculated |
| `auth_response` | `{ success, message, token }` | Auth result |
| `auth_failed` | `{ agentId, message }` | Session expired |
| `agentPerformance.update` | `{ agentId, rows, totals }` | Performance refresh |

---

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 204 | No content (CORS preflight) |
| 400 | Bad request (missing params, malformed JSON) |
| 401 | Unauthorized (missing/invalid JWT) |
| 404 | Route not found |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

---

## Rate Limiting

All `/api/*` routes are rate-limited. Default: **100 requests per minute** per IP.

Headers returned on limit:
```
Retry-After: 60
```

---

## CORS

All endpoints return CORS headers allowing cross-origin requests from any origin.

---

## Error Handling & Recovery

### Optional Admin Guard

Local development keeps the existing open HTTP behavior unless `ADMIN_API_TOKEN` is configured. When set, sensitive mutation routes require either `X-Admin-Token: <token>` or `Authorization: Bearer <token>`.

Guarded mutation surfaces include Buckeye connection/session mutation, Buckeye proxy mutation routes, webhook create/update/delete, player flag mutation, agent refresh/backfill/import mutation, and performance cache invalidation. Read-only health, hierarchy, player profile, wager, odds, pattern, and export routes keep their existing read contract.

### Error Response Format

All errors follow a consistent JSON envelope:

```json
{
  "error": "Human-readable error message"
}
```

Errors are generated by `handleAsync()` in `src/api/helpers.ts`:

```typescript
export function handleAsync(handler, headers) {
  return handler()
    .then((data) => new Response(JSON.stringify(data), { headers }))
    .catch((error) => {
      console.error('API error:', error);
      const status = error instanceof ApiError ? error.status : 500;
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
        { status, headers }
      );
    });
}
```

### Error Types & Recovery Matrix

| Error | HTTP Status | Source | Recovery Mechanism | Automatic? |
|-------|-------------|--------|--------------------|------------|
| **Missing/Invalid JWT** | 401 | `index.ts` WebSocket upgrade | Client re-authenticates via `auth` WS message with credentials | Manual (user reconnects) |
| **Expired Buckeye Token** | 401 (Buckeye API) | `BuckeyeAPI.getBetTicker()` | Auto-renewal every 15 min via `renewToken()`. Falls back to password re-login (max 3 attempts). After 3 failures, broadcasts `auth_failed` and stops polling. | ✅ Yes (up to 3 retries) |
| **Network Timeout** | — | `BuckeyeAPI.*` fetch calls | Exponential backoff: 5s → 10s → 20s → 40s → max 60s. Resets to 5s on next success. | ✅ Yes |
| **Rate Limit (429)** | 429 | `RateLimiter` in `router.ts` | Returns `Retry-After` header. Client must wait. No automatic retry. | ❌ Manual |
| **DB Constraint Violation** | 500 | `database.ts` / `ScraperManager` | `INSERT OR IGNORE` prevents duplicate key errors. Transactions roll back cleanly. | ✅ Yes |
| **Malformed JSON Body** | 400 | `readJsonBody()` in `helpers.ts` | Client must fix request format. | ❌ Manual |
| **Invalid Webhook ID** | 400 | `parseRequiredId()` in `helpers.ts` | Client must provide valid numeric ID. | ❌ Manual |
| **Missing Required Param** | 400 | Route handlers (e.g., `agent` param) | Client must include required query params. | ❌ Manual |
| **Route Not Found** | 404 | `index.ts` fallthrough | Client must use valid path. | ❌ Manual |
| **WebSocket Disconnect** | — | `TerminalWebSocketClient` | Auto-reconnect (max 5 attempts, 3s delay). Server pings every 30s, closes stale after 45s. Auth restored via JWT. | ✅ Yes |
| **RawApiLogger Failure** | — | `RawApiLogger.log()` | Fire-and-forget. Errors caught and logged to console only — never propagated. Queue flushes every 250ms or 25 items. | ✅ Yes (silent) |
| **Poller Concurrent Guard** | — | `ScraperManager.pollAgent()` | Skips poll if previous poll still running. Logs warning. | ✅ Yes |
| **OddsPoller Provider Null** | — | `OddsPoller.poll()` | Logs error, continues running. No provider configured = no crash. | ✅ Yes (graceful) |

### Poller Backoff Strategy

Every poller in `ScraperManager` uses the same backoff pattern:

```
consecutiveErrors=1 → 10s
consecutiveErrors=2 → 20s
consecutiveErrors=3 → 40s
consecutiveErrors=4+ → 60s (cap)
success → 5s (reset)
```

Tracked per-agent via `AgentInstance.consecutiveErrors` and `AgentInstance.currentPollMs`.

### Watermark-Based Recovery

All pollers use the `watermarks` table for restart-safe cursors:

| Watermark Key | Poller | Interval | Recovery on Restart |
|---------------|--------|----------|---------------------|
| `last_access_log_poll.{agentId}` | Access Logs | 5 min | Resumes from last successful poll timestamp |
| `last_master_snapshot.{agentId}` | Master Snapshots | 30 min | Resumes from last snapshot timestamp |
| `last_daily_archive_refresh.{agentId}` | Daily Archive | 24 hours | Resumes weekly figure + performance refresh |
| `last_agent_performance.{agentId}` | Agent Performance | 15 min | Resumes from last performance pull |

### Error Tracking in Health Endpoint

The `/health` endpoint exposes real-time error state:

```json
{
  "scrapers": {
    "agents": [
      {
        "agentId": "BILLY666",
        "lastPoll": 1778340008911,
        "errorCount": 0,
        "authenticated": true
      }
    ],
    "counters": {
      "wagers_total": 529,
      "alerts_triggered_total": 144,
      "errors_total": 0
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `errorCount` | Per-agent consecutive error count |
| `errors_total` | Global error counter across all agents |
| `authenticated` | Whether the agent's Buckeye session is valid |

### Frontend Error Display

The frontend shows errors via:

1. **Toast notifications** — `showToast(message, severity)` with `success`/`warning`/`error` levels
2. **Status tab** — Backend online/offline, agent error counts, API endpoint health dots
3. **Up tab** — Full error history, poller health, recovery matrix, watermark status
4. **WebSocket events** — `auth_failed`, `data_error`, `betAction_error`, `token_refresh_error`

### Recovery Flow Diagram

```
Buckeye API Error
    │
    ├─ 401 (token expired)
    │   ├─ renewToken() → success → resume polling
    │   └─ renewToken() → fail → password re-login
    │       ├─ success → resume polling
    │       └─ fail (×3) → broadcast auth_failed → stop agent
    │
    ├─ Network error (timeout, DNS, connection refused)
    │   └─ Exponential backoff (5s → 60s max)
    │       └─ success → reset to 5s interval
    │
    └─ Other (malformed response, parse error)
        └─ Log error → increment errorCount → continue next poll
```

---

## Document History

| Date | Author | Changes |
|------|--------|---------|
| 2026-05-09 | System | Initial document — all endpoints captured from live server |
| 2026-05-09 | System | Added Error Handling & Recovery section with real error types, backoff strategy, watermark recovery, and recovery flow diagram |
