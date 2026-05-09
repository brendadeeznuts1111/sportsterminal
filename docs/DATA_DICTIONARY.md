# Data Dictionary

This is the single reference for Sports Terminal names: environment variables, OS vault keys, Buckeye upstream request/response fields, local tables, route parameters, and WebSocket payload names.

## Environment Variables

| Name | Default | Required | Used By | Meaning |
|------|---------|----------|---------|---------|
| `PORT` | `3000` | No | `backend/src/config/env.ts` | HTTP/WebSocket listen port |
| `HOST` | `0.0.0.0` | No | `backend/src/config/env.ts` | HTTP/WebSocket bind host |
| `NODE_ENV` | `development` | No | Auth/rate-limit flow | `production` enables production security behavior |
| `JWT_SECRET` | `change-me-in-production-min-32-chars` | Production yes | WebSocket JWT auth | HS256 signing/verification secret; must be 32+ chars in production |
| `DEBUG` | `false` | No | Buckeye client/server logs | Enables verbose debug logging when `true` or `1` |
| `BUCKEYE_BASE_URL` | `https://fantasy402.com` | No | `BuckeyeAPI` | Fantasy402/Buckeye origin |
| `DATABASE_URL` | `./data/terminal.db` | No | `backend/src/database.ts` | SQLite URL/path or Postgres URL |
| `POLL_INTERVAL_MS` | `5000` | No | `ScraperManager` | Buckeye `getBetTicker` polling interval |
| `TOKEN_RENEWAL_MINUTES` | `15` | No | `ScraperManager` | Buckeye token renewal interval in minutes |
| `ACCESS_LOG_INTERVAL_MS` | `600000` | No | `ScraperManager` | Buckeye `getWebLog` polling interval |
| `AGENT_PERFORMANCE_INTERVAL_MS` | `900000` | No | `ScraperManager` | Buckeye `getAgentPerformance` polling interval |
| `ODDS_POLL_INTERVAL_MS` | `30000` | No | `OddsPoller` | Odds snapshot/movement polling interval |
| `BOOK_HEALTH_INTERVAL_MS` | `60000` | No | `OddsPoller` | Book health polling interval |
| `RATE_LIMIT_MAX` | `100` | No | `RateLimiter` | Max HTTP requests per client window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | No | `RateLimiter` | HTTP rate-limit window length |
| `ODDS_API_KEY` | unset | No | `OddsPoller` | Enables The Odds API provider; demo provider is used when unset |
| `REDIS_URL` | unset | No | `PerformanceCache` | Optional Redis cache URL for performance cache |

Do not store Buckeye passwords, Buckeye JWTs, or Cloudflare cookies in `.env`. Use Settings and the OS vault.

## Database URL Forms

| Value | Dialect | Notes |
|-------|---------|-------|
| `sqlite:./data/terminal.db` | SQLite | Normal local app database |
| `sqlite://./data/terminal.db` | SQLite | Accepted by Bun SQL |
| `./data/terminal.db` | SQLite | Normalized to a SQLite URL |
| `:memory:` | SQLite | Test/in-memory database |
| `postgres://...` | Postgres | Schema is expected to be managed by migrations |
| `postgresql://...` | Postgres | Schema is expected to be managed by migrations |

## OS Vault Keys

All Buckeye secrets use the `Bun.secrets` service name:

```text
sportsterminal.buckeye
```

| Vault Name | Value | Secret | Notes |
|------------|-------|--------|-------|
| `__agents` | JSON array of agent IDs | No | Vault index, for example `["BILLY666"]` |
| `__last_agent` | Agent ID | No | Last connected/restored agent |
| `<AGENT>:agent` | Agent ID | No | Stored normalized uppercase agent ID |
| `<AGENT>:password` | Buckeye password | Yes | Used for re-auth fallback |
| `<AGENT>:cfCookie` | Cloudflare cookie string | Yes | Usually includes `cf_clearance`; may include `__cf_bm` |
| `<AGENT>:token` | Buckeye JWT | Yes | Refreshed after successful `renewToken` |

Vault status APIs only expose presence flags:

```json
{
  "agentId": "BILLY666",
  "hasPassword": true,
  "hasCfCookie": true,
  "hasToken": true,
  "active": true,
  "lastError": null
}
```

## Buckeye Upstream Endpoints

| Operation | Path | Purpose |
|-----------|------|---------|
| `authenticateCustomer` | `/cloud/api/System/authenticateCustomer` | Login and receive Buckeye JWT |
| `renewToken` | `/cloud/api/System/renewToken` | Refresh Buckeye JWT |
| `getBetTicker` | `/cloud/api/Manager/getBetTicker` | Live wager feed |
| `getBetTickerConfig` | `/cloud/api/Manager/getBetTickerConfig` | Bet ticker config/language metadata |
| `getWebLog` | `/qubic/api/Manager/getWebLog` | IP/access-log primary path |
| `getWebLog` | `/cloud/api/Manager/getWebLog` | IP/access-log fallback path |
| `getAgentPerformance` | `/cloud/api/Manager/getAgentPerformance` | Customer/sport/volume/graded performance |
| `getWeeklyFigureByAgentLite` | `/cloud/api/Manager/getWeeklyFigureByAgentLite` | Weekly summary |
| `getSportsType` | `/cloud/api/Manager/getSportsType` | Sports type seed list |
| `getAccountInfoOwner` | `/cloud/api/Manager/getAccountInfoOwner` | Account/owner metadata |
| `getConfigWebReports` | `/cloud/api/Manager/getConfigWebReports` | Report config |
| `getConfigWebReportsPending` | `/cloud/api/Manager/getConfigWebReportsPending` | Pending report config |
| `getAuthorizations` | `/cloud/api/Manager/getAuthorizations` | Permission/capability metadata |
| `getMessage` | `/cloud/api/Manager/getMessage` | Manager message payload |
| `getNewEmailsCount` | `/cloud/api/Manager/getNewEmailsCount` | Email/message count |
| `getListAgenstByAgent` | `/cloud/api/Manager/getListAgenstByAgent` | Agent list/downline context; upstream typo is intentional |

Common form fields:

| Field | Example | Meaning |
|-------|---------|---------|
| `agentID` | `BILLY666` | Authenticated/root agent |
| `agentOwner` | `SHARPTOBBY` | Owner/master context when required |
| `agentSite` | `1` | Buckeye site ID |
| `operation` | `getBetTicker` | Buckeye operation name |
| `RRO` | `1` | Required upstream flag |

## Buckeye `getBetTicker`

Request fields:

| Field | Example | Meaning |
|-------|---------|---------|
| `agentID` | `BILLY666` | Agent whose ticker is being pulled |
| `agentOwner` | `BILLY666` | Owner/master context |
| `agentSite` | `1` | Site ID |
| `operation` | `getBetTicker` | Operation |
| `RRO` | `1` | Required upstream flag |
| `wagerNumber` | `750038740` | Last seen wager sequence for delta polling |

Response fields:

| Source Field | Local Column | Type | Meaning |
|--------------|--------------|------|---------|
| `WagerNumber` | `wager_number` | integer | Unique Buckeye wager/ticket sequence |
| `AgentID` | `agent_id` | text | Agent ID from upstream row |
| `CustomerID` | `customer_id` | text | Customer/player ID, often padded |
| `Login` | `login` | text | Player login |
| `WagerType` | `wager_type` | text | `L`, `M`, `S`, `P`, `E`, `T`, `C` |
| `AmountWagered` | `amount_wagered` | integer/dollars | Upstream cents normalized to dollars |
| `ToWinAmount` | `to_win_amount` | integer/dollars | Upstream cents normalized to dollars |
| `VolumeAmount` | `volume_amount` | integer/dollars | Upstream cents normalized to dollars |
| `InsertDateTime` | `insert_datetime` | text datetime | Bet accepted timestamp |
| `TicketWriter` | `ticket_writer` | text | `Internet`, `GSLIVE`, `ALERT`, etc. |
| `ShortDesc` | `short_desc` | text | Full wager description |
| `VIP` | `vip` | text | Upstream VIP flag |
| `AgentLogin` | `agent_login` | text | Agent login, often padded |

Derived wager fields:

| Column | Meaning |
|--------|---------|
| `sport` | Parsed sport from `ShortDesc` |
| `parsed_game` | Canonical matchup/game |
| `parsed_market` | Spread, moneyline, total, team total, prop, etc. |
| `parsed_side` | Team/player/over/under side |
| `parsed_price` | Parsed American price |
| `parsed_period` | Game, half, quarter, set, live period, etc. |
| `matched_event_id` | Matched odds event ID when correlation succeeds |
| `pin_reference_json` | Captured reference/Pinnacle-style price context |
| `scraped_at` | Backend ingestion timestamp |

## Buckeye `getWebLog`

Request fields:

| Field | Example | Meaning |
|-------|---------|---------|
| `agentID` | `BILLY666` | Agent context |
| `customerID` | `CF346` | Optional player/customer filter |
| `start` | `05/01/2026` | Start date |
| `end` | `05/09/2026` | End date |
| `type` | `A` | Buckeye log type/context |
| `actions` | `A` | Action code |
| `ip` | `1.2.3.4` | Optional IP filter |
| `operation` | `getWebLog` | Operation |
| `RRO` | `1` | Required upstream flag |

Action codes:

| Code | Meaning |
|------|---------|
| `A` | Web Access Log |
| `B` | Global IP Matcher |
| `C` | Account IP Match / player matcher |
| `I` | Users by IP |

Persisted access-log fields:

| Source Field | Local Column | Meaning |
|--------------|--------------|---------|
| `LoginID` | `login_id` | Account login seen in the web log |
| `IPAddress` | `ip_address` | IP address |
| `AccessDateTime` | `access_datetime` | Access timestamp |
| `Operation` | `operation` | Buckeye operation/action string |
| `Data` | `data` | Raw log data payload |
| `type` | `log_type` | Log family/type |
| generated | `id` | Stable local row ID |
| generated | `agent_id` | Agent context used for the pull |
| generated | `pulled_at` | Backend pull timestamp |
| generated | `raw_json` | Full upstream row |

Limits:

- Users-by-IP: maximum 7-day range.
- Access logs: maximum 30-day range.

## Buckeye `getAgentPerformance`

Request fields:

| Field | Example | Meaning |
|-------|---------|---------|
| `start` | `04/28/2026` | Report start date |
| `end` | `05/09/2026` | Report end date |
| `agentID` | `BILLY666` | Agent/root being queried |
| `type` | `CP` | Report type |
| `freePlay` | `Y` | Include free play flag |
| `store` | `BILLY666` | Store/root context |
| `sport` | `Basketball          ` | Sport filter, often padded |
| `subsport` | `NBA` | League/subsport filter |
| `period` | `-1` | Period filter |
| `wagerType` | `S` | Wager type filter, blank for all |
| `betType` | `M` | Bet type filter, blank for all |
| `tipo` | `0` | Activity filter |
| `debug` | `0` | Upstream debug flag |
| `operation` | `getAgentPerformance` | Operation |
| `RRO` | `1` | Required upstream flag |
| `agentOwner` | `SHARPTOBBY` | Owner/master context |
| `agentSite` | `1` | Site ID |

Report type values:

| Value | Label |
|-------|-------|
| `CP` | Customer Performance |
| `CPS` | Sport Performance |
| `CPV` | Customer Volume |
| `G` | Graded Wagers |

Activity `tipo` values:

| Value | Label |
|-------|-------|
| `-1` | All Action |
| `0` | Sports |
| `1` | LV Digital Casino |
| `2` | Racebook |
| `3` | Live Casino |
| `4` | Live Betting |
| `5` | Poker |
| `6` | Prop Builder |
| `7` | Soccer 365 |
| `8` | Flash Bet |
| `9` | Extended Props |
| `10` | Crash |
| `11` | Fantasy |
| `12` | AC Digital Casino |

Wager and bet type values:

| Field | Value | Label |
|-------|-------|-------|
| `wagerType` | `S` | Straights |
| `wagerType` | `P` | Parlays |
| `wagerType` | `T` | Teasers |
| `wagerType` | `I` | If-Bets / Action Reverses |
| `wagerType` | `C` | Contests |
| `wagerType` | `A` | Manual Plays |
| `betType` | `S` | Spread |
| `betType` | `M` | Money Line |
| `betType` | `L` | Total |
| `betType` | `E` | Team Total |

Period values:

| Value | Label |
|-------|-------|
| `-1` | All Periods |
| `0` | Game |
| `1` | 1st Half |
| `2` | 2nd Half |
| `3` | 1st Quarter |
| `4` | 2nd Quarter |
| `5` | 3rd Quarter |
| `6` | 4th Quarter |

Response fields:

| Source Field | Local Column | Meaning |
|--------------|--------------|---------|
| `CustomerID` | `customer_id` | Customer/player ID |
| `AgentID` | `agent_id` | Agent responsible for row |
| `Login` | `login` | Display login; password fragments are redacted in parser output |
| `wagercount` | `wager_count` | Number of wagers |
| `Risk` | `risk` | Risk amount |
| `ToWin` | `to_win` | To-win amount |
| `amountwon` | `amount_won` | Won amount |
| `amountlost` | `amount_lost` | Lost amount |
| `volume` | `volume` | Volume amount |
| `net` | `net` | Net result |

Snapshot context columns:

| Column | Meaning |
|--------|---------|
| `report_agent_id` | Agent used to pull the report |
| `report_type` | `CP`, `CPS`, `CPV`, or `G` |
| `start_date`, `end_date` | Report window |
| `sport`, `subsport`, `period`, `wager_type`, `bet_type`, `activity_tipo`, `free_play` | Request filters |
| `pulled_at` | Backend pull timestamp |
| `raw_json` | Full upstream row |

## Buckeye `getSportsType`

Response shape:

```json
{
  "LIST": [
    { "sportType": "Basketball          ", "0": "Basketball          " }
  ]
}
```

Local columns:

| Source Field | Local Column | Meaning |
|--------------|--------------|---------|
| `sportType` | `raw_value` | Raw padded sport value used by Buckeye |
| trimmed `sportType` | `label` | Human-readable sport name |
| generated | `sort_order` | Stable display order |
| generated | `source` | `seed` or upstream source |
| generated | `updated_at` | Last seed/update timestamp |

Seeded sports:

```text
Auto Racing, Baseball, Basketball, Boxing, Cricket, Entertainment, Esports,
Football, Golf, Hockey, Horse Racing, LIVE, Martial Arts, Olympics, Other,
Rugby, Soccer, Tennis, Virtual Sports
```

## Local Table Dictionary

### `agents`

| Column | Meaning |
|--------|---------|
| `id` | Local agent ID/login key |
| `name` | Display/name field |
| `provider` | Provider, usually `buckeye` |
| `login` | Agent login |
| `display_name` | UI display name |
| `parent_agent_id` | Parent agent ID |
| `tier`, `level` | Hierarchy depth/level |
| `child_count` | Derived child agent count |
| `player_count` | Derived player count |
| `seq_number` | Source sequence number when available |
| `agent_type` | Buckeye agent type |
| `*_rate*` columns | Buckeye commission/rate fields |
| `credit`, `balance` | Credit/balance fields when available |
| `status` | Local status |
| `raw_json` | Full source row/context |
| `last_updated` | Last update timestamp |

### `players`

| Column | Meaning |
|--------|---------|
| `id` | Local player ID/login key |
| `agent_id` | Linked agent ID |
| `name` | Display/name field |
| `provider` | Provider, usually `buckeye` |
| `login` | Player login |
| `display_name` | UI display name |
| `agent_login` | Raw agent login from export/source |
| `net_pnl`, `ytd_pnl` | Performance fields when available |
| `exposure` | Current/projected exposure |
| `credit_limit` | Player credit limit when available |
| `status` | Local status |
| `last_seen` | Last seen timestamp |
| `raw_json` | Full source row/context |
| `last_updated` | Last update timestamp |

### `ingestion_checkpoints`

| Column | Meaning |
|--------|---------|
| `provider` | Provider, usually `buckeye` |
| `entity_type` | `wagers`, `access_logs`, `agent_performance`, `hierarchy`, `players`, etc. |
| `last_seq` | Last sequence/checkpoint number when available |
| `last_pull` | Last successful pull timestamp |
| `metadata` | JSON metadata, such as row counts or file hashes |

### `wagers`

See `getBetTicker` mapping above. Money values are normalized to dollars before storage.

### `access_logs`

See `getWebLog` mapping above.

### `agent_performance_snapshots`

See `getAgentPerformance` mapping above.

### `detected_patterns`

| Column | Meaning |
|--------|---------|
| `id` | Pattern ID |
| `event_id` | Matched odds event or synthetic event context |
| `type` | Pattern type, such as `agent_swarm` or `past_post_risk` |
| `market` | Market involved |
| `side` | Side involved |
| `severity` | `info`, `warning`, or `critical` |
| `score` | 0-100 score |
| `category` | `odds`, `wagers`, `agents`, `ip`, `live`, or `feed` |
| `wager_number` | Related wager when applicable |
| `agent_login` | Primary related agent when applicable |
| `trigger_book` | Book that triggered odds pattern |
| `details_json` | Evidence/reason payload |
| `description` | Human-readable summary |
| `detected_at` | Detection timestamp |
| `created_at` | Persistence timestamp |

### `pattern_agents`

| Column | Meaning |
|--------|---------|
| `pattern_id` | Linked pattern |
| `agent_login` | Related agent |
| `created_at` | Link creation timestamp |

### Odds Tables

| Table | Key Columns | Meaning |
|-------|-------------|---------|
| `events` | `id`, `sport`, `league`, `home_team`, `away_team`, `start_time`, `status` | Canonical games/events |
| `odds_snapshots` | `event_id`, `book`, spread/total/moneyline columns, `scraped_at` | Latest per-book odds |
| `line_movements` | `event_id`, `book`, `market`, `side`, `old_value`, `new_value`, `delta`, `recorded_at` | Movement history |
| `book_health` | `book`, `status`, `last_seen`, `error_count`, `last_error` | Provider/book status |

### Alert and Webhook Tables

| Table | Key Columns | Meaning |
|-------|-------------|---------|
| `alerts` | `wager_number`, `rule_name`, `severity`, `message`, `is_resolved`, `created_at` | Wager alert history |
| `risk_alerts` | `agent_id`, `player_id`, `type`, `value`, `threshold`, `acknowledged` | Agent/player risk alerts |
| `alert_webhooks` | `name`, `platform`, `url`, `triggers`, `enabled` | Webhook definitions |
| `webhook_deliveries` | `webhook_id`, `alert_id`, `payload`, `response_status`, `success`, `attempted_at` | Delivery attempts |

### Legacy / Compatibility Tables

| Table | Meaning |
|-------|---------|
| `odds` | Older/simple odds table retained for compatibility |
| `credentials` | Older encrypted credential table; live Buckeye credentials now belong in OS vault |

## Public API Route Names

Health and metrics:

| Route | Method | Meaning |
|-------|--------|---------|
| `/health` | GET | Backend health summary |
| `/metrics` | GET | Scraper/action queue counters |

Buckeye:

| Route | Method | Query/Body Keys | Meaning |
|-------|--------|-----------------|---------|
| `/api/connect` | POST | `agentId`, `password`, `cfCookie`, `baseUrl` | Start/auth Buckeye agent |
| `/api/buckeye/vault-status` | GET | optional `agentId` | Vault presence flags |
| `/api/buckeye/vault-status` | DELETE | `agentId` or `all=1` | Clear vaulted agent(s) |
| `/api/buckeye/ui-config` | GET | `agentId` | Ticker/config metadata |
| `/api/buckeye/account-info` | GET | `agentId` | Owner/account info |
| `/api/buckeye/weekly-figures` | GET | `agentId`, week/filter options | Weekly figures |
| `/api/buckeye/agent-performance/options` | GET | none | Documents supported performance options |
| `/api/buckeye/sports-types` | GET | none | Seeded/upstream sport list |
| `/api/buckeye/agent-performance` | GET | `agentId`, performance filters | Performance report rows |
| `/api/buckeye/manager-snapshot` | GET | `agentId` | Manager bootstrap snapshot |
| `/api/buckeye/access-logs` | GET | `agentId`, `start`, `end`, `actions`, `ip`, `customerID` | IP/access log rows |

Core data:

| Route | Method | Meaning |
|-------|--------|---------|
| `/api/stats` | GET | Wager/stat summary |
| `/api/wagers` | GET | Wager list |
| `/api/wagers/alerts` | GET | Alert wager list |
| `/api/wagers/live` | GET | Live wager list |
| `/api/agents` | GET | Agents |
| `/api/agents/downline` | GET | Downline summary |
| `/api/agents/hierarchy` | GET | Agent hierarchy |
| `/api/agents/backfill/hierarchy` | POST | Parse/backfill local hierarchy/player exports |
| `/api/agents/access-logs` | GET | Agent access-log view |
| `/api/agents/:id/performance` | GET | Agent performance |
| `/api/agents/:id/exposure` | GET | Agent exposure |
| `/api/players/:id/details` | GET | Player detail |
| `/api/players/:id/wagers` | GET | Player wagers |
| `/api/players/:id/pnl` | GET | Player projected P/L buckets |
| `/api/exposure/sports` | GET | Sport exposure |
| `/api/exposure/agents` | GET | Agent exposure |

Odds, books, and patterns:

| Route | Method | Meaning |
|-------|--------|---------|
| `/api/odds/live` | GET | Live odds matrix |
| `/api/odds/events` | GET | Events |
| `/api/odds/events/:id` | GET | Single event detail |
| `/api/odds/snapshots` | GET | Odds snapshots |
| `/api/odds/movements` | GET | Line movements |
| `/api/books` | GET | Book list/settings |
| `/api/books/status` | GET | Book health |
| `/api/patterns/history` | GET | Pattern history |
| `/api/patterns/summary` | GET | Pattern summary |
| `/api/patterns/agents` | GET | Pattern-agent rollup |

Alerts and webhooks:

| Route | Method | Meaning |
|-------|--------|---------|
| `/api/risk/alerts` | GET | Risk alert history |
| `/api/webhooks` | GET/POST | List/create webhooks |
| `/api/webhooks/:id` | GET/PUT/DELETE | Read/update/delete webhook |
| `/api/webhooks/:id/deliveries` | GET | Webhook delivery log |

## WebSocket Event Names

| Event Type | Direction | Payload Keys | Meaning |
|------------|-----------|--------------|---------|
| `wager.new` | server to client | normalized wager fields | New Buckeye wager |
| `wager.alert` | server to client | alert fields and wager context | Wager triggered alert rule |
| `exposure.update` | server to client | exposure summary | Exposure changed |
| `odds.update` | server to client | `events` | Odds poll completed |
| `odds.movement` | server to client | movement fields | New line movement |
| `pattern.alert` | server to client | pattern fields | New important pattern |
| `pattern.update` | server to client | pattern delta/counts | Pattern summary changed |
| `auth_failed` | server to client | `agentId`, `message` | Agent auth failed |
| `betAction` | server to client | action ID/result | Action queue update |

## Frontend Storage Keys

| Key | Meaning | Notes |
|-----|---------|-------|
| `sportsTerminal.backendUrl` | Backend URL override | Local browser setting |
| `sportsTerminal.endpoint` | Buckeye base URL/endpoint setting | Local browser setting |
| `sportsTerminal.autoConnect` | Auto-connect toggle | Does not replace backend vault restore |
| `sportsTerminal.toastEnabled` | Toast toggle | Local UI preference |
| Buckeye token/password/cookie values | Avoid storing | Backend OS vault is the durable secret store |

## Naming Rules

- Upstream Buckeye field names stay in PascalCase/camelCase exactly as observed in raw examples.
- Local database columns use snake_case.
- Frontend display labels should not imply settled P/L unless graded results are actually ingested.
- Money is normalized once in the backend and treated as dollars after persistence.
- Padded Buckeye values should keep raw value when sending back upstream and use trimmed value for display.
