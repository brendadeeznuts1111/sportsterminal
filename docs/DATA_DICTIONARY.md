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
| `PLAYER360_INTERVAL_MS` | `600000` | No | `ScraperManager` | Hotset Player 360 refresh interval. Heavy sources are TTL-gated per player. |
| `PLAYER360_MAX_PLAYERS_PER_POLL` | `50` | No | `ScraperManager` | Max hot players per agent refresh cycle; never a full customer scan. |
| `ODDS_POLL_INTERVAL_MS` | `30000` | No | `OddsPoller` | Odds snapshot/movement polling interval |
| `BOOK_HEALTH_INTERVAL_MS` | `60000` | No | `OddsPoller` | Book health polling interval |
| `RATE_LIMIT_MAX` | `100` | No | `RateLimiter` | Max HTTP requests per client window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | No | `RateLimiter` | HTTP rate-limit window length |
| `ODDS_API_KEY` | unset | No | `OddsPoller` | Enables The Odds API provider; odds polling is disabled when unset |
| `ODDS_DEMO_MODE` | `false` | No | `OddsPoller` | Test/development only: enables synthetic odds if no `ODDS_API_KEY`; never used for Buckeye wager data |
| `REDIS_URL` | unset | No | `PerformanceCache` | Optional Redis cache URL for performance cache |
| `FRONTEND_PORT` | `3001` | No | `scripts/serve-frontend.ts` | Optional static frontend-only server port |
| `BUCKEYE_AGENT_ID` | unset | Script-only | `backend/scripts/*` probes | One-off local probe/login scripts only; do not store production credentials |
| `BUCKEYE_PASSWORD` | unset | Script-only | `backend/scripts/*` probes | One-off local probe/login scripts only; prefer interactive/vaulted auth |

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
| `getPerformancePlayer` | `/cloud/api/Manager/getPerformancePlayer` | Player-specific performance, observed with `acc=<player/account>&period=0` |
| `getTransactionList` | `/cloud/api/Manager/getTransactionList` | Player account ledger, observed with `acc=<player/account>&start=` |
| `getTransactionHistory` | `/cloud/api/Manager/getTransactionHistory` | Date-windowed player transaction history, observed with `customerID`, `startDate`, `endDate`, transaction-type checkboxes, and `freeFlag=player` |
| `getReportDeletedTransactions` | `/cloud/api/Manager/getReportDeletedTransactions` | Deleted player transaction report, observed with `customerID`, `startDate`, and `endDate` |
| `getWeeklyFigureByAgentLite` | `/cloud/api/Manager/getWeeklyFigureByAgentLite` | Weekly summary |
| `getSportsType` | `/cloud/api/Manager/getSportsType` | Sports type seed list |
| `getAccountInfoOwner` | `/cloud/api/Manager/getAccountInfoOwner` | Account/owner metadata |
| `getInfoPlayer` | `/cloud/api/Manager/getInfoPlayer` | Player profile/account payload candidate |
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

## Buckeye `getListAgenstByAgent`

The upstream operation name is misspelled as `Agenst`; keep that spelling in request code.

Observed request metadata:

| Item | Value |
|------|-------|
| Method | `POST` |
| Path | `/cloud/api/Manager/getListAgenstByAgent` |
| Content type | `application/x-www-form-urlencoded; charset=UTF-8` |
| Auth | `Authorization: Bearer <Buckeye JWT>` |
| Cookie | `cf_clearance` required; `__cf_bm` included when present |
| Browser hints | `X-Requested-With: XMLHttpRequest`, same-origin `Origin`/`Referer` |

Request fields:

| Field | Example | Meaning |
|-------|---------|---------|
| `agentID` | `BILLY666` | Authenticated/root agent |
| `agentType` | `M` | Manager/downline tree mode |
| `operation` | `getListAgenstByAgent` | Operation |
| `RRO` | `1` | Required upstream flag |
| `agentOwner` | `BILLY666` | Owner/root context |
| `agentSite` | `1` | Site ID |

Agent response fields:

| Source Field | Local Column | Meaning |
|--------------|--------------|---------|
| `AgentID` | `agents.id` | Agent identifier, often padded upstream |
| `Login` | `agents.login` | Agent login, trimmed locally |
| `SeqNumber` | `agents.seq_number` | Upstream ordering key used to rebuild hierarchy |
| `Level` | `agents.level`, `agents.tier` | Depth in the manager tree |
| `AgentType` | `agents.agent_type` | Observed `M` manager and `A` agent |
| `HeadCountRateM` | `agents.head_count_rate_m` | Head-count commission/rate |
| `InetHeadCountRateM` | `agents.inet_head_count_rate_m` | Internet head-count commission/rate |
| `CasinoHeadCountRateM` | `agents.casino_head_count_rate_m` | Casino head-count commission/rate |
| `LiveBettingRateM` | `agents.live_betting_rate_m` | Live betting rate |
| `LiveBetting2RateM` | `agents.live_betting2_rate_m` | Secondary live betting rate |
| `LiveCasinoRateM` | `agents.live_casino_rate_m` | Live casino rate |
| `PropBuilderRateM` | `agents.prop_builder_rate_m` | Prop builder rate |
| `FlashBetsRate` | `agents.flash_bets_rate` | Flash bets rate |
| `ExtPropsRate` | `agents.ext_props_rate` | Extended props rate |
| `CrashRate` | `agents.crash_rate` | Crash product rate |
| `FantasyRate` | `agents.fantasy_rate` | Fantasy product rate |
| `AmigoTechRate` | `agents.amigo_tech_rate` | AmigoTech product rate |

Customer seed response fields from local combined exports:

| Source Field | Local Column | Meaning |
|--------------|--------------|---------|
| `customerID` | `players.raw_json.customerId`, fallback `players.id` | Customer/account ID, often padded |
| `Login` | `players.login`, `players.id` | Player login |
| `NameFirst` | `players.display_name`, `players.name` | Display name from Buckeye export |
| `Agent` | `players.agent_login`, `players.agent_id` | Owning agent login |
| `Password` | not stored | Sensitive upstream field; stripped during seed/backfill |

Example redacted upstream shape:

```json
{
  "GENERAL": [
    {
      "AgentID": "BILLY667  ",
      "SeqNumber": 5735,
      "Level": 1,
      "AgentType": "A",
      "Login": "BILLY667  ",
      "HeadCountRateM": 1,
      "InetHeadCountRateM": 0,
      "CasinoHeadCountRateM": 0,
      "LiveBettingRateM": 0,
      "LiveBetting2RateM": 0,
      "LiveCasinoRateM": 0,
      "PropBuilderRateM": 0,
      "FlashBetsRate": 0,
      "ExtPropsRate": 0,
      "CrashRate": 0,
      "FantasyRate": 0,
      "AmigoTechRate": 0
    }
  ],
  "PLAYERS": [
    {
      "customerID": "CUST001   ",
      "Login": "CUST001",
      "NameFirst": "Customer Name",
      "Password": "<redacted>",
      "Agent": "BILLY667"
    }
  ]
}
```

Seed/backfill behavior:

| Source | Use |
|--------|-----|
| `docs/agentobject.md` | Ignored local agent-only capture |
| `docs/agentslistharz.md` | Ignored local combined agent/customer capture |
| `POST /api/agents/backfill/hierarchy` | Parses ignored seed files, upserts `agents` and sanitized `players`, and writes `ingestion_checkpoints` |
| `GET /api/agents/hierarchy` | Returns database hierarchy first, live Buckeye hierarchy second, local seed fallback last |

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
| `group` | `1` | Optional grouping mode |
| `week` | `enter-dates` | Convenience preset translated into `start`/`end` |
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

Grouping and week preset values:

| Field | Value | Label |
|-------|-------|-------|
| `group` | `1` | Group Agent |
| `group` | `2` | Sorting Columns |
| `week` | `-1` | Today |
| `week` | `0` | This Week |
| `week` | `1` | Last Week |
| `week` | `enter-dates` | Entered Dates |

## Buckeye `getPerformancePlayer`

Observed request fields:

| Field | Example | Meaning |
|-------|---------|---------|
| `acc` | `BB1152` | Player/account identifier selected in Buckeye customer admin |
| `period` | `0` | Performance period filter |
| `operation` | `getPerformancePlayer` | Operation |
| `RRO` | `1` | Required upstream flag |
| `agentID` | `BILLY666` | Manager/root being queried |
| `agentOwner` | `BILLY666` | Owner/master context |
| `agentSite` | `1` | Site ID |

Rows are normalized into `agent_performance_snapshots` with `report_type=getPerformancePlayer` for Player 360 risk/performance enrichment.

## Buckeye `getTransactionList`

Observed request fields:

| Field | Example | Meaning |
|-------|---------|---------|
| `acc` | `BB1152` | Player/account identifier selected in Buckeye customer admin |
| `start` | blank | Optional cursor/start parameter used by the Buckeye transaction module |
| `operation` | `getTransactionList` | Operation |
| `RRO` | `1` | Required upstream flag |
| `agentID` | `BILLY666` | Manager/root being queried |
| `agentOwner` | `BILLY666` | Owner/master context |
| `agentSite` | `1` | Site ID |

Response fields:

| Source Field | Local Column | Meaning |
|--------------|--------------|---------|
| `DocumentNumber` | `document_number`, `id` | Buckeye ledger document number and stable local key |
| `TranCode` | `tran_code` | Transaction code; observed `C` credit and `D` debit |
| `TranType` | `tran_type` | Transaction type; observed `W` wager win and `L` wager loss |
| `Amount` | `amount` | Amount in cents, normalized to dollars |
| `Balance` | `balance` | Running balance in cents, normalized to dollars |
| `HoldAmount` | `hold_amount` | Hold amount in cents, normalized to dollars |
| `Description` | `description` | Human-readable ledger reason, used for category classification |
| `TranDateTime` | `transaction_time` | Ledger event timestamp |
| `GradeNum` | `grade_num` | Graded wager/document reference |
| `EnteredBy` | `entered_by` | Source actor, often `Internet` |

Category mapping:

| Local Category | Rule |
|----------------|------|
| `wager_win` | Description contains `Wager Won` or similar bet-win text |
| `wager_loss` | Description contains `Wager Loss` or similar bet-loss text |
| `deposit` | Description/type contains deposit, wire, ACH, card, crypto, payment, or funding text |
| `withdrawal` | Description/type contains withdrawal, payout, cash-out, or distribution text |
| `hold` | Description/type contains hold text |
| `adjustment` | Description/type contains adjustment, correction, or manual text |
| `credit` / `debit` | Fallback from `TranCode=C` or `TranCode=D` |
| `other` | No known mapping |

Player 360 stores all rows in `player_transactions`. Only deposit-like rows are copied into `deposits`, so wager wins/losses remain ledger rows instead of becoming fake deposits.

## Buckeye `getTransactionHistory`

Request fields:

| Field | Example | Meaning |
|-------|---------|---------|
| `customerID` | `BB1152` | Player/account identifier selected in Buckeye transaction history |
| `startDate` | `2026-05-09` | Date-window start, `YYYY-MM-DD` |
| `endDate` | `2026-05-09` | Date-window end, `YYYY-MM-DD` |
| `deposits` | `checked` | Include deposit rows |
| `withdrawals` | `checked` | Include withdrawal rows |
| `adjustments` | `checked` | Include adjustment rows |
| `transfers` | `checked` | Include transfer rows |
| `fess` | `checked` | Include fee rows; upstream field name is misspelled |
| `promotional` | `checked` | Include promotional rows |
| `balances` | `checked` | Include balance rows |
| `distribution` | `unchecked` | Distribution flag from Buckeye UI |
| `freeFlag` | `player` | Player ledger scope |
| `operation` | `getTransactionHistory` | Operation |
| `RRO` | `1` | Required upstream flag |
| `agentID` | `BILLY666` | Manager/root being queried |
| `agentOwner` | `BILLY666` | Owner/master context |
| `agentSite` | `1` | Site ID |

Player 360 stores `getTransactionHistory` rows in the same `player_transactions` contract as `getTransactionList`. The parser accepts the confirmed `DocumentNumber`/`TranDateTime` shape and common history aliases such as `TransactionDateTime`, `TransactionDate`, `TransactionType`, `TransactionCode`, `Credit`, and `Debit`. The refresh is on-open/hotset only and must not be scheduled across the full 50k-customer archive.

## Buckeye `getReportDeletedTransactions`

Request fields:

| Field | Example | Meaning |
|-------|---------|---------|
| `customerID` | `BILLY666` | Manager/root context observed from Buckeye; Player 360 filters returned rows to the selected account |
| `startDate` | `2026-05-09` | Report start, `YYYY-MM-DD` |
| `endDate` | `2026-05-09` | Report end, `YYYY-MM-DD` |
| `operation` | `getReportDeletedTransactions` | Operation |
| `RRO` | `1` | Required upstream flag |
| `agentID` | `BILLY666` | Manager/root being queried |
| `agentOwner` | `BILLY666` | Owner/master context |
| `agentSite` | `1` | Site ID |

Response fields:

| Source Field | Local Field | Meaning |
|--------------|-------------|---------|
| `DocumentNumber` | `document_number`, `id=deleted-<DocumentNumber>` | Deleted report document number with local prefix to avoid active-ledger collisions |
| `TranDateTime` | `transaction_time` | Original transaction timestamp |
| `CustomerID` | `customer_id`, `login` | Player account |
| `AgentId` | `agent_id`, `agent_login` | Immediate agent from deleted report |
| `MasterAgentID` | `raw_json.MasterAgentID` | Master/root agent evidence |
| `TranCode` / `TranType` | `tran_code` / `tran_type` | Credit/debit/type codes |
| `Description` | `description`, `category` | Withdrawal/deposit/adjustment text, often includes Telegram Bot AID |
| `Amount` | `amount` | Upstream cents normalized to dollars |
| `DeletedBy` | `entered_by`, `raw_json.DeletedBy` | Operator/user that deleted the transaction |

Player 360 stores deleted report rows in `player_transactions` and exposes source coverage as `deleted_transactions`. Rows remain heavy/on-open/hotset only, not a full-archive scheduled scan.

## `player_source_status`

Per-player source status used by `/api/v1/players/:id/intelligence-map`, the Player 360 Status tab, and the sidebar Status page. This table prevents heavy Buckeye endpoints from being polled for all archived players.

| Column | Meaning |
|--------|---------|
| `customer_id`, `login`, `agent_id` | Player and agent identity for the mapped source. |
| `source_key` | Stable local source name, such as `player_transactions`, `customer_snapshots`, or `teaser_profile`. |
| `refresh_policy` | `live`, `hotset`, `on_open`, `daily`, `manual`, or `derived`. |
| `ttl_seconds` | Freshness TTL used before another attempt is allowed. |
| `scale_class` | `realtime`, `cheap`, `heavy`, or `manual`. |
| `last_attempt_at` | Last time Sports Terminal attempted to refresh this source for this player. |
| `last_success_at` | Last time the source produced trusted rows or a confirmed reusable payload. |
| `last_error` | Most recent refresh error, if any. |
| `next_refresh_at` | Next TTL-derived attempt time. |

## Buckeye `getInfoPlayer`

Observed after loading the Buckeye customer-admin player-info module. Player 360 probes it with `acc=<player/account>` and standard manager fields, then stores useful masked/account metadata in `customer_snapshots`.

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

## Buckeye `getTeaserProfile`

Mapped as the Player 360 `teaser_profile` source. It uses the standard manager fields plus `acc=<player/account>`, but it remains a probe-only source until the real payload field contract is confirmed. The UI should show its status, TTL, last attempt, and next refresh in coverage tables, but must not fabricate teaser/account values.

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

### `scheduler_state` / `watermarks`

| Column | Meaning |
|--------|---------|
| `key` | Durable poller/job key, such as `last_access_log_poll` |
| `value` | ISO timestamp or JSON state payload |
| `updated_at` | Last state update timestamp |

### `schema_migrations`

| Column | Meaning |
|--------|---------|
| `version` | Applied migration identifier |
| `applied_at` | Migration timestamp |

### `raw_api_logs`

| Column | Meaning |
|--------|---------|
| `id` | Local log row ID |
| `endpoint` | API route or Buckeye source endpoint |
| `fetched_at` | Time the response was logged |
| `response_json` | Redacted response/error payload |
| `agent_id` | Related agent when known |
| `duration_ms` | Request duration |
| `request_params` | Redacted request/query parameters |
| `status_code` | HTTP status code or synthetic error status |

Raw API responses and request params are redacted before persistence. The v5.32 Performance Raw API Archive shows metadata by default and only returns `response_json` when `includeBody=1`; the UI renders that body as escaped text.

### `wager_archive`

| Column | Meaning |
|--------|---------|
| `wager_number` | Unique Buckeye ticket number |
| `agent_id`, `customer_id`, `login`, `agent_login` | Source account identifiers |
| `amount_wagered`, `to_win_amount`, `volume_amount` | Normalized wager amounts |
| `insert_date_time` | Buckeye accepted/inserted timestamp |
| `short_desc_raw` | Original `ShortDesc` text |
| `raw_json` | Original normalized wager payload |
| `sport`, `league`, `price` | Easy analytics columns when parsed |
| `ingested_at` | Local archive timestamp |

### `wagers`

See `getBetTicker` mapping above. Money values are normalized to dollars before storage.

### `access_logs`

See `getWebLog` mapping above.

### `agent_performance_snapshots`

See `getAgentPerformance` mapping above.

### `master_snapshots`, `weekly_figures`, `agent_performance`

| Table | Key Columns | Meaning |
|-------|-------------|---------|
| `master_snapshots` | `timestamp`, `balance`, `available_balance`, `percent_book`, `account_info_json` | Master account time-series snapshots |
| `weekly_figures` | `agent_id`, `week_start_date`, `sport`, `handle`, `win_loss`, `raw_json` | Weekly figure report archive |
| `agent_performance` | `agent_id`, `recorded_at`, `performance_json` | Raw agent performance report archive |

### `audit_logs`

| Column | Meaning |
|--------|---------|
| `action` | Operator/system action |
| `entity_type`, `entity_id` | Affected object |
| `actor_id`, `actor_type` | Actor context when known |
| `old_values`, `new_values` | JSON before/after payloads |
| `timestamp`, `ip_address` | Audit context |

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
| `/api/agents/:agentId/performance` | GET | Agent performance |
| `/api/agents/:agentId/exposure` | GET | Agent exposure |
| `/api/players/:playerId/details` | GET | Player detail |
| `/api/players/:playerId/wagers` | GET | Player wagers |
| `/api/players/:playerId/pnl` | GET | Player projected P/L buckets |
| `/api/exposure/sports` | GET | Sport exposure |
| `/api/exposure/agents` | GET | Agent exposure |

Odds, books, and patterns:

| Route | Method | Meaning |
|-------|--------|---------|
| `/api/odds/live` | GET | Live odds matrix |
| `/api/odds/events` | GET | Events |
| `/api/odds/events/:eventId` | GET | Single event detail |
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
| `/api/webhooks/:webhookId` | GET/PUT/DELETE | Read/update/delete webhook |
| `/api/webhooks/:webhookId/deliveries` | GET | Webhook delivery log |

Performance cache:

| Route | Method | Meaning |
|-------|--------|---------|
| `/api/performance/status` | GET | Redis/cache health flags |
| `/api/performance/:agentId` | GET | Cached/fetched agent performance data |
| `/api/performance/:agentId` | DELETE | Invalidate one cached agent performance payload |

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
| `auth_response` | server to client | `success`, `message`, `token` | Response to auth/resume |
| `data_response` | server to client | `agentId`, `data` | Response to `request_data` |
| `data_error` | server to client | `agentId`, `message` | Agent data load failed |
| `refresh_initiated` | server to client | `agentId` | Manual refresh accepted |
| `betAction_queued` | server to client | `actionId`, `agentId`, `wagerNumber`, `action` | Bet action queued |
| `betAction_error` | server to client | `message` | Bet action rejected/failed |
| `token_refreshed` | server to client | `token` | App JWT refresh succeeded |
| `token_refresh_error` | server to client | `message` | App JWT refresh failed |
| `error` | server to client | `message` | Generic WebSocket error |

Client-to-server WebSocket message types:

| Event Type | Payload Keys | Meaning |
|------------|--------------|---------|
| `auth` | `agentId`, `password`, `cfCookie`, optional `token` | Authenticate or resume a Buckeye session |
| `request_data` | `agentId` | Request current agent data |
| `refresh` | `agentId` | Force a Buckeye refresh |
| `betAction` | `agentId`, `wagerNumber`, `action`, optional `amount`, `reason` | Queue accept/decline action |
| `token_refresh` | none | Request a fresh app JWT |

## Audit & Analytics Tables

| Table | Purpose | Key Columns | Indexes |
|-------|---------|-------------|---------|
| `raw_api_logs` | Redacted response audit trail for Buckeye API routes and pollers | `endpoint`, `fetched_at`, `response_json`, `agent_id`, `duration_ms`, `request_params`, `status_code` | `(endpoint, fetched_at)`, `(agent_id)`, `(fetched_at)` |
| `wager_archive` | Immutable archive of Buckeye wagers (INSERT OR IGNORE by wager_number) | `wager_number`, `agent_id`, `customer_id`, `login`, `wager_type`, `amount_wagered`, `to_win_amount`, `insert_date_time`, `ticket_writer`, `volume_amount`, `short_desc_raw`, `vip`, `agent_login`, `ingested_at`, `raw_json`, `sport`, `league`, `price` | `(insert_date_time)`, `(agent_login, insert_date_time)`, `(customer_id)`, `(ingested_at)` |
| `access_logs` | Buckeye web access/IP tracker rows | `id`, `agent_id`, `login_id`, `ip_address`, `access_datetime`, `operation`, `data`, `log_type`, `pulled_at`, `raw_json` | `(ip_address, access_datetime DESC)`, `(login_id, access_datetime DESC)` |
| `master_snapshots` | Master account balance/book snapshots | `provider`, `agent_id`, `timestamp`, `balance`, `available_balance`, `percent_book`, `open_wager_count`, `account_info_json`, `raw_json` | `(timestamp)` |
| `weekly_figures` | Weekly figure report archive | `agent_id`, `week_start_date`, `sport`, `handle`, `win_loss`, `wager_type`, `raw_json`, `ingested_at` | `(agent_id, week_start_date)` |
| `agent_performance` | Raw agent performance report archive | `agent_id`, `recorded_at`, `performance_json` | `(agent_id, recorded_at)` |
| `audit_logs` | Operator/system action trail | `action`, `entity_type`, `entity_id`, `actor_id`, `actor_type`, `old_values`, `new_values`, `timestamp`, `ip_address` | `(timestamp)`, `(entity_type, entity_id)`, `(actor_id)` |
| `watermarks` | Restart-safe poller cursors | `key` (PK), `value`, `updated_at` | `(key)` |

## Analytics API Endpoints

| Endpoint | Method | Params | Returns |
|----------|--------|--------|---------|
| `/api/betting/velocity` | GET | `minutes` (default 30, max 60) | `{ minutes, velocity: [{ timestamp, wagerCount, totalHandle }] }` |
| `/api/betting/live-vs-pre` | GET | `date` (default today, YYYY-MM-DD) | `{ date, live: { count, volume }, pregame: { count, volume } }` |
| `/api/logs/access` | GET | `agent`, `ip`, `limit` (default 100, max 500) | `{ logs: [{ ...access_log_fields, first_seen, is_new_ip }], count }` |
| `/api/master/history` | GET | `limit` (default 100, max 500) | `{ snapshots: [...master_snapshot_fields], count }` |
| `/api/performance/summary` | GET | `week` (optional, ISO format) | `{ week, summary: [{ agent_id, row_count, handle, win_loss, last_ingested_at }], count }` |
| `/api/performance/details` | GET | `agent` (required), `weeks` (default 8, max 52) | `{ agentId, weeks, weeklyTrend, sportBreakdown, latestRaw }` |
| `/api/export/wagers` | GET | — | CSV of `wager_archive` |
| `/api/export/access-logs` | GET | — | CSV of `access_logs` |
| `/api/export/performance` | GET | — | CSV of `weekly_figures` |

## Error Handling & Recovery

| Error Type | HTTP Status | Recovery | Auto? |
|------------|-------------|----------|-------|
| Missing/Invalid JWT | 401 | Client re-authenticates via WS `auth` message | Manual |
| Expired Buckeye Token | 401 (upstream) | Auto-renewal (15 min) → password re-login (×3) → stop agent | ✅ Yes |
| Network Timeout | — | Exponential backoff 5s→10s→20s→40s→60s | ✅ Yes |
| Rate Limit (429) | 429 | `Retry-After` header, client must wait | ❌ Manual |
| DB Constraint Violation | 500 | `INSERT OR IGNORE`, transaction rollback | ✅ Yes |
| Malformed JSON Body | 400 | Client must fix request | ❌ Manual |
| Missing Required Param | 400 | Client must include param | ❌ Manual |
| Route Not Found | 404 | Client must use valid path | ❌ Manual |
| WebSocket Disconnect | — | Auto-reconnect (×5, 3s delay), JWT restore | ✅ Yes |
| RawApiLogger Failure | — | Fire-and-forget, errors logged silently | ✅ Yes |
| Poller Concurrent Guard | — | Skip poll, log warning, continue next interval | ✅ Yes |
| OddsPoller Provider Null | — | Log error, continue running | ✅ Yes |

## Frontend Storage Keys

| Key | Meaning | Notes |
|-----|---------|-------|
| `wsUrl` | WebSocket URL override | Local browser setting |
| `agentId` | Last selected agent ID | Non-secret convenience value |
| `baseUrl` | Buckeye base URL | Non-secret convenience value |
| `autoConnect` | Auto-connect toggle | Does not replace backend vault restore |
| `toastsEnabled` | Toast toggle | Local UI preference |
| `retainedRiskPercent` | Exposure retention percentage | Local UI setting |
| `bookPreferences` | Book visibility/order preferences | JSON UI preference |
| `sportsTerminal.sidebar.groups.v531` | Collapsible sidebar group state | JSON map of group key to open/closed state |
| `wsToken` | App JWT from auth response | Short-lived app session token |
| `password` | Removed on load/connect | Legacy key; should not persist |
| `cfCookie` | Removed on load/connect | Legacy key; should not persist |
| `buckeyeToken` | Removed on vault logout | Legacy key; Buckeye tokens belong in OS vault |
| `lastAuthTime` | Removed on vault logout | Legacy key |

## Naming Rules

- Upstream Buckeye field names stay in PascalCase/camelCase exactly as observed in raw examples.
- Local database columns use snake_case.
- Frontend display labels should not imply settled P/L unless graded results are actually ingested.
- Money is normalized once in the backend and treated as dollars after persistence.
- Padded Buckeye values should keep raw value when sending back upstream and use trimmed value for display.
