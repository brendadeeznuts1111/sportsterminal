# Buckeye Manual Findings

Source review date: 2026-05-09

Sources:

- `https://fantasy402.com/doc/manual-agent.pdf`
- `https://fantasy402.com/doc/FAQ.pdf`

These manuals describe the Buckeye agent UI, not the private JSON API directly. Treat them as product behavior evidence that helps name endpoints, columns, and Player 360 surfaces. Do not store or commit downloaded PDFs or extracted text; keep only these implementation notes.

## Product Areas Confirmed

| Manual area | Product behavior | Sports Terminal mapping |
|---|---|---|
| Weekly Figures | Current/past week player performance, daily figures, week total, end-of-week balance, pending balance, deposits/withdrawals, last wager placed, and Excel export options. Daily and weekly figures can drill into component wagers and transactions. | `getWeeklyFigureByAgentLite`, `weekly_figures`, and future weekly detail capture should stay accounting-summary oriented. Do not mix agent performance report rows into `weekly_figures`. |
| Pending | Open wager report with agent/player/time/type/amount filters, risk/to-win totals, delete permission behavior, and open-play markers. | `getBetTicker`/`wager_archive` plus deleted-wager probes. `wager_type` should remain flexible because the UI names more types than the old local CHECK constraint allowed. |
| Account Details | Player profile includes account basics, balance, pending, available, transactions, wagers, performance, analysis, allow/deny, max wager, vig setup, free plays, place wagers, and accounting for agent accounts. | Player 360 should keep separate tabs for profile/account snapshots, transaction ledger, wagers, performance, access/risk, and free-play analysis. |
| Transactions | Account transaction view separates non-wager transactions, all transactions, deposits/withdrawals, betting adjustments, wagers-only, casino pending/non-posted activity, and balance-after-transaction. | `player_transactions` should preserve `tran_code`, `tran_type`, description, balance, entered-by, and source operation instead of reducing rows to deposit/withdrawal only. |
| Promotional transactions | Promotional Credit/Debit adjusts balance without counting as deposit/withdrawal and without affecting daily figure. | Free-play/promo classification should stay separate from deposit/withdrawal. Current conservative free-play categories are directionally correct; add explicit promo credit/debit examples when Buckeye raw rows prove codes. |
| Free Plays | Free Play tab has time frame, free-play balance, pending free-play risk, add/subtract transactions, transaction history, delete controls, and straight-wager-only restriction via customer service. | `/api/v1/freeplay/analysis` should eventually expose current free-play balance and pending free-play risk if a source row proves those fields. The existing issued/redeemed/expired/outstanding estimate is a ledger-derived approximation. |
| Performance | Account performance has daily/weekly/monthly/yearly views; Agent Performance has customer performance, sport performance, and customer volume. | `getPerformancePlayer` should remain the player-specific enrichment source. `getAgentPerformance` maps to broader customer/sport/volume analytics and `agent_performance_snapshots`. |
| Analysis | Analysis compares wagered lines to closing lines for straight wagers, with filters for timeframe and line type, and risk indicators for closing-line advantage, non-game periods, and oddball markets. | Compliance/risk scoring should prioritize CLV, prop-only behavior, non-primary markets, oddball market concentration, and non-game periods when those fields are available. |
| IP Tracker | Report modes are Web Access Log, Global IP Match, Account IP Match, and Users by IP. Web Access Log records attempted wagers but not merely selected unsubmitted wagers. IP geolocation is approximate. | `getWebLog` is the correct source for access logs and multi-account links. Access evidence should distinguish observed login/actions from unsubmitted browsing intent, and should label geolocation as approximate. |
| Transaction History | Report can filter by agent, player, transaction type, date range, and a free-play-only checkbox. Types include deposits, withdrawals, adjustments, fees, promotional, and transfers. | `getTransactionHistory` should keep filters for transaction-type checkboxes and `freeFlag`. The local ledger should keep fees, promo, transfer, and free-play rows instead of flattening them away. |
| Agent Admin | Master-agent-only hierarchy management shows expandable sub-agent hierarchy, password, balance, settle, last-week player count, last transaction, permissions, and account drill-through. | `agent_hierarchy`, `player_agent_map`, and `/api/v1/agents/hierarchy` are aligned with the UI. Future agent profile endpoints can add balance, settle, last transaction, and permission state if API payloads are captured. |
| Accounting | Agent accounts have commission/accounting settings, including agent/affiliate split, red figure, weekly profit, per-head commission, PPH credit shutdown, call unit, internet-only, casino, live, live casino, casino fee, and SMS. | Existing hierarchy rate fields (`HeadCountRateM`, `InetHeadCountRateM`, casino/live rates, etc.) match the manual's accounting model. Agent risk dashboards should treat these as billing/accounting rates, not player risk by themselves. |

## Implementation Notes

- Weekly figures are not the same thing as agent performance. Weekly Figures is a week/accounting report; Agent Performance is a separate analytics report. This validates keeping `weekly_figures` summary-only.
- Promotional credit/debit is not a deposit/withdrawal in Buckeye's accounting semantics. This validates keeping promo/free-play-like movements out of deposit totals unless raw text explicitly proves they are money-in/money-out.
- Free play has its own balance and pending risk in the UI. Our `outstandingEstimate` is useful, but it should be labeled as an estimate until we capture the exact free-play balance source.
- IP Tracker supports multiple report modes. Current `getWebLog` ingestion covers Web Access Log first; Account IP Match, Global IP Match, and Users by IP should be modeled as related queries or derived views, not invented from incomplete data.
- Closing-line analysis in the manual is straight-wager focused. Current CLV/risk surfaces should avoid implying full parlay/teaser CLV support until Buckeye or our own odds archive proves it.
- Agent hierarchy is a master-agent capability. Routes that expose hierarchy or agent account details should continue to respect authenticated manager scope once auth enforcement is tightened.

## Follow-Up Candidates

1. Capture raw `getTransactionHistory` rows for Promotional Credit, Promotional Debit, Free Play Deposit, and Free Play Withdrawal so `TranType` mappings can move from candidate to confirmed.
2. Probe whether the Free Plays tab has a distinct endpoint or whether its data is a filtered transaction-history request.
3. Add `/api/v1/access-logs/matches` or extend `/api/v1/players/:id/links/check` to model Account IP Match and Users by IP explicitly.
4. Capture Agent Admin account fields for balance, settle, last-week count, last transaction, and permission summaries if an agent-profile endpoint is found.
5. Add an Analysis/CLV source-status row that clearly says closing-line availability is partial and straight-wager focused.
