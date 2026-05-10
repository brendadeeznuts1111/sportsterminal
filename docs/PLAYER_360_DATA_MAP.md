# Player 360 Data Map v5.32

Player 360 is real API first. The modal must hydrate from `/api/v1/players/:playerId/profile` and supporting Player 360 routes. It must not fabricate profile stats from browser-side mock data when an endpoint fails.

Buckeye's public `manual-agent.pdf` and `FAQ.pdf` confirm the UI/report semantics behind the Player 360 sources. See `docs/BUCKEYE_MANUAL_FINDINGS.md` for the reviewed notes.

## Frontend Module Map

Player 360 rendering is being extracted from the legacy `app.js` host into focused browser modules while preserving the existing API/data contracts:

| Module | Responsibility |
|---|---|
| `frontend/public/js/app.js` | Compatibility host, global inline-handler bridge, profile lifecycle, and shared state wiring. |
| `frontend/public/js/player-transactions.js` | Transaction ledger and Free-Play sub-tab rendering from `/profile`, `/transactions?category=freeplay`, and `/api/v1/freeplay/analysis`-compatible fields. |
| `frontend/public/js/player-docs.js` | Docs tab renderer for the live `/api/v1/players/:playerId/intelligence-map` data map, source coverage, gaps, and field contract. |
| `frontend/public/js/utils.js` | Shared escaping, date, money, compact-dollar, and DOM text helpers used by Player 360 and broader dashboards. |

New Player 360 UI work should prefer a focused module with explicit dependency injection from `app.js` instead of adding another large inline renderer to the compatibility host.

## Refresh And Scale Model

Player 360 uses a hybrid hotset model. `getBetTicker` remains real-time and cheap enough to run continuously. Heavy player endpoints are TTL-based and on-demand so a 50k-customer archive does not trigger 50k profile, ledger, or KYC calls.

| Source | Buckeye Operation | Refresh Policy | TTL | Scale Class | Trigger |
|---|---|---:|---:|---|---|
| `wager_archive` | `getBetTicker` | `live` | 0 | `realtime` | Always-on wager ingestion. |
| `access_logs` | `getWebLog` | `hotset` | 30 minutes | `cheap` | Agent poll plus profile-open refresh when missing/stale. |
| `agent_performance_snapshots` | `getPerformancePlayer` | `hotset` | 1 hour | `heavy` | Hot players in background; cold players on profile open only. |
| `player_transactions` | `getTransactionList` / `getTransactionHistory` | `on_open` | 6 hours | `heavy` | Profile open or hotset queue when missing/stale. Free-play categories are classified conservatively from ledger text. |
| `deleted_transactions` | `getReportDeletedTransactions` | `on_open` | 6 hours | `heavy` | Profile open or hotset queue when missing/stale; persisted into `player_transactions` with `sourceOperation`. |
| `deposits` | Classified from transaction ledger endpoints | `on_open` | 6 hours | `heavy` | Follows transaction-ledger refresh. |
| `customer_snapshots` | `getInfoPlayer` plus account candidates | `on_open` | 24 hours | `heavy` | Profile open or hotset queue when missing/stale. |
| `teaser_profile` | `getTeaserProfile` | `on_open` | 24 hours | `heavy` | Mapped probe only until payload fields are proven. |
| `player_links` | Derived from access logs | `derived` | 0 | `cheap` | Manual check or background derivation. |
| `player_flags` / `player_notes` | Operator entry | `manual` | 0 | `manual` | User-created compliance overlay. |

Hot players are players with a wager in the last 24 hours, an opened profile, an active flag, or a recent source error. Cold players remain searchable from local archive aggregation. Each Player 360 background cycle also takes a tiny cold cohort from `wager_archive` so the database can slowly fill source-status, ledger, account, deleted-transaction, teaser, and performance coverage without calling Buckeye for every archived customer at once. The default cohort is `PLAYER360_COLD_BACKFILL_PER_POLL=2` players per agent per Player 360 poll; increase it only after watching Buckeye latency and error rates.

## Contract Routes

| Surface | Route | Source |
|---|---|---|
| Search | `/api/v1/players/search?q=&agent=&from=&to=&sort=` | `wager_archive` aggregation |
| Profile | `/api/v1/players/:playerId/profile` | `wager_archive`, `access_logs`, `agent_performance_snapshots` from `getPerformancePlayer`, `player_transactions` from `getTransactionList` / `getTransactionHistory` / `getReportDeletedTransactions`, `deposits`, `customer_snapshots`, `player_links`, `player_flags`, `player_notes` |
| Intelligence map | `/api/v1/players/:playerId/intelligence-map` | Source freshness, watermarks, raw API probe history |
| Deposits | `/api/v1/players/:playerId/deposits` | `deposits` plus login-IP match against `access_logs` |
| Transaction ledger | `/api/v1/players/:playerId/transactions` | Combined `getTransactionList` / `getTransactionHistory` / `getReportDeletedTransactions` ledger: wager wins/losses, credits/debits, deleted rows, balances, document numbers. Pass `category=freeplay` to return only free-play rows. |
| Free-play analysis | `/api/v1/freeplay/analysis?playerId=&agentId=&from=&to=&groupBy=player\|agent\|day` | Aggregates `player_transactions` categories `freeplay_issued`, `freeplay_redeemed`, `freeplay_expired`, and `freeplay_adjustment` into totals and grouped rows with response-computed `sourceConfidence`. |
| Account | `/api/v1/players/:playerId/account-snapshots` | `customer_snapshots` |
| Links | `/api/v1/players/:playerId/links` and `/links/check` | `player_links`, derived from access-log overlap |
| Notes and flags | `/api/v1/players/:playerId/notes`, `/flags` | Manual operator tables |
| Exports | `/api/v1/players/:playerId/export/wagers`, `/export/access-logs` | CSV streams from `wager_archive` and `access_logs` |

## Source Status Rules

Every source row returned by `/intelligence-map` includes `refreshPolicy`, `ttlSeconds`, `lastAttemptAt`, `lastSuccessAt`, `nextRefreshAt`, `freshnessState`, and `scaleClass`.

| Source | Status Rule |
|---|---|
| `wager_archive` | `live` only when rows exist for the selected player/login. |
| `access_logs` | `live` when player access rows exist, `probe` when access poll watermark exists, otherwise `missing`. |
| `agent_performance_snapshots` | `live` when player/customer performance rows exist. Primary Buckeye source is `getPerformancePlayer` with `acc=<player/account>&period=0`; `getAgentPerformance` remains broader context. |
| `player_transactions` | `live` when `getTransactionList` or `getTransactionHistory` ledger rows exist for the selected account/login, `probe` when a refresh was attempted but no rows are proven, otherwise `missing`. |
| `deleted_transactions` | `live` when `getReportDeletedTransactions` rows exist for the selected account/login, `probe` after an attempted report pull, otherwise `missing`. |
| `deposits` | `live` when deposit-like rows exist, `probe` when transaction refreshes have run but no deposit rows are proven, otherwise `missing`. Wager wins/losses are not treated as deposits. |
| `customer_snapshots` | `live` when account snapshot rows exist. Probe `getInfoPlayer` first, then account/customer-info candidates. |
| `teaser_profile` | Always a mapped `probe` until a real payload shape is confirmed and explicit fields are promoted. |
| `player_links` | `derived`; rows depend on access-log overlap checks. |
| `player_flags` / `player_notes` | `manual`; operator-entered compliance overlay. |

## Missing Or Probe Data

The intelligence map tracks these explicitly instead of rendering fake values: dedicated withdrawal source, true closing-line feed, KYC document list and expiry timeline, source-of-funds, richer ISP/device fingerprint data, Telegram/group chat, and multi-account confidence beyond shared IP. Withdrawal-like rows can be classified from the transaction ledger endpoints when Buckeye returns them.

## Confirmed Buckeye Player Endpoints

| Buckeye Operation | URL | Payload Notes | Player 360 Use |
|---|---|---|---|
| `getPerformancePlayer` | `/cloud/api/Manager/getPerformancePlayer` | `acc=<player/account>&period=0&operation=getPerformancePlayer&RRO=1&agentID=<manager>&agentOwner=<manager>&agentSite=1` | Player-specific performance enrichment into `agent_performance_snapshots`. |
| `getTransactionList` | `/cloud/api/Manager/getTransactionList` | `acc=<player/account>&start=&operation=getTransactionList&RRO=1&agentID=<manager>&agentOwner=<manager>&agentSite=1` | Full account ledger into `player_transactions`; rows are classified as `wager_win`, `wager_loss`, `deposit`, `withdrawal`, `credit`, `debit`, `hold`, `adjustment`, free-play categories, or `other`. |
| `getTransactionHistory` | `/cloud/api/Manager/getTransactionHistory` | `customerID=<player/account>&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&deposits=checked&withdrawals=checked&adjustments=checked&transfers=checked&fess=checked&promotional=checked&balances=checked&distribution=unchecked&freeFlag=player&operation=getTransactionHistory&RRO=1&agentID=<manager>&agentOwner=<manager>&agentSite=1` | Date-windowed transaction history into `player_transactions`; merged with `getTransactionList` and de-duped by document/time/amount/category. |
| `getReportDeletedTransactions` | `/cloud/api/Manager/getReportDeletedTransactions` | `customerID=<manager/root>&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&operation=getReportDeletedTransactions&RRO=1&agentID=<manager>&agentOwner=<manager>&agentSite=1` | Deleted deposits, withdrawals, transfers, and adjustments into `player_transactions` with `sourceOperation=getReportDeletedTransactions`, `DeletedBy`, and Telegram Bot AID evidence in raw JSON; Player 360 filters returned rows back to the selected account. |
| `getInfoPlayer` | `/cloud/api/Manager/getInfoPlayer` | `acc=<player/account>` plus standard manager fields | Account/profile snapshot candidate for `customer_snapshots`. |
| `getTeaserProfile` | `/cloud/api/Manager/getTeaserProfile` | `acc=<player/account>` plus standard manager fields | Mapped probe for teaser/profile metadata. Do not render or store new fields until the payload shape is confirmed. |
| `getWebLog` | `/cloud/api/Manager/getWebLog` and `/qubic/api/Manager/getWebLog` | Date-windowed access-log payload | `access_logs`, IP novelty, geo/device rows, exports. |
| `getAccountInfoOwner` | `/cloud/api/Manager/getAccountInfoOwner` | Standard manager account context | Owner/master context and fallback metadata. |

## Frontend Rule

If `/profile` fails, the modal shows a real API error and retry/status actions. It must not build a mock/local profile from already-loaded wager rows.

## Transaction Ledger Field Map

Observed rows include:

| Buckeye Field | Local Field | Notes |
|---|---|---|
| `DocumentNumber` | `document_number`, `id` | Stable ledger row key. |
| `TranCode` | `tran_code` | `C` usually credit, `D` usually debit. |
| `TranType` | `tran_type` | Examples: `W` for wager win, `L` for wager loss. |
| `Amount` | `amount` | Upstream cents normalized to dollars. |
| `Balance` | `balance` | Upstream cents normalized to dollars. |
| `HoldAmount` | `hold_amount` | Upstream cents normalized to dollars. |
| `GradeNum` | `grade_num` | Ties ledger movement to a graded wager/document when present. |
| `Description` | `description`, `category` | Used to classify `Wager Won`, `Wager Loss`, deposit/withdrawal text, and adjustments. |
| `TranDateTime` | `transaction_time` | Ledger event timestamp. |
| `EnteredBy` | `entered_by` | Often `Internet` for player-originated rows. |

`getTransactionHistory` and `getReportDeletedTransactions` use the same local contract. The parser also accepts common aliases such as `TransactionDateTime`, `TransactionDate`, `TransactionType`, `TransactionCode`, `Customer`, `Credit`, `Debit`, `AgentId`, `MasterAgentID`, and `DeletedBy` so field-name drift in Buckeye payloads does not blank the Player 360 ledger. Deleted report rows use `deleted-<DocumentNumber>` as the local row ID so they do not overwrite active ledger documents.

Free-play classification is intentionally conservative until exact Buckeye `TranType` examples are proven. The manuals confirm that Promotional Credit/Debit changes balance without counting as deposit/withdrawal and without affecting daily figure, while Free Plays have a separate balance, pending free-play risk, add/subtract transactions, and a transaction table. Rows are promoted only when description/raw text includes terms such as `free play`, `freeplay`, `fp`, `bonus play`, `promo`, `redeem`, `expired`, or `credit pct`; ambiguous `F`/`H` rows without those terms remain normal credit/debit/other categories.

`sourceConfidence` is not persisted in `player_transactions`. The profile, transaction filter, and free-play analysis routes compute it from each row's `tran_type`, `description`, and `raw_json` so older backfilled ledger rows do not require a schema migration. Explicit free-play text is `confirmed`; promotional/FP-adjacent rows that passed conservative classification but lack explicit free-play wording are `candidate`.

`freePlaySummary.outstandingEstimate` is ledger-derived. Treat it as an estimate until a raw Buckeye free-play balance source is captured.

## Manual-Confirmed Risk Signals

Buckeye's Analysis UI is straight-wager focused and compares wagered lines against closing lines. It specifically reinforces these Player 360 risk candidates:

| Signal | Manual context | Local status |
|---|---|---|
| Closing-line advantage | Consistently getting materially better spread/total points or moneyline cents is a red flag. | Partial; use only when line/open/close data exists. |
| Prop-heavy behavior | Prop-only or prop-dominant accounts are called out as risky, especially when beating the line. | Available from wager description parsing, but CLV support is partial. |
| Oddball markets | Minor/non-primary markets are weaker and should be monitored when concentration is high. | Available from sport/league classification where parsed. |
| Non-game periods | High non-game period share is called out in the Analysis section. | Candidate; depends on reliable period parsing. |
| Shared IPs | IP Tracker Account IP Match and Users by IP are explicit multi-account investigation tools. | Derived through `player_links` and access-log overlap; add dedicated match endpoint later. |
