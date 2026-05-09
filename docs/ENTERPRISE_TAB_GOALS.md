# Enterprise Tab Goals

This document defines what each sidebar tab is supposed to accomplish and what the finished enterprise-grade version should feel like. It is the product standard for tab design, backend support, data quality, and operator workflows.

## Enterprise Product Principles

- **Evidence first**: every risk, pattern, exposure, and alert should explain what data triggered it and when that data was last updated.
- **Operational clarity**: a trader should know what needs attention within seconds of opening a tab.
- **Data lineage**: every number should trace back to a source family such as Buckeye wagers, access logs, odds snapshots, performance reports, or local derived state.
- **Low-latency defaults**: live views should update without manual refresh, while still showing explicit refresh and last-updated status.
- **Role-aware actions**: read, acknowledge, mute, export, logout, and destructive actions should be separated and auditable.
- **Progressive detail**: summary first, then drill-down drawer or detail page, then raw source payload when needed.
- **Consistent controls**: filters, search, time windows, status pills, empty states, and error states should behave consistently across tabs.
- **Secure by default**: secrets are never displayed, sensitive exports remain ignored, and auth/vault state is reported as presence flags only.
- **Graceful degradation**: if a provider is unavailable, the tab should say what is unavailable, what still works, and what the next retry/checkpoint is.
- **Auditability**: operator actions should have timestamps, actor identity when available, and a reversible or acknowledged state where appropriate.

## Tab Goal Matrix

| Area | Tab | Primary User | Enterprise Goal | Must Answer | Enterprise Standard |
|------|-----|--------------|-----------------|-------------|---------------------|
| Trading | Trading Floor | Trader, risk manager | Compare live market prices and identify actionable line movement. | Where is the best price, what moved, and which books look stale or risky? | Every row shows source, market, book health, last update, movement context, and related pattern indicators. |
| Trading | Patterns | Risk analyst, trader | Triage anomalies across odds, wagers, agents, IPs, live timing, and feed health. | What happened, why is it suspicious, who is involved, and what evidence supports the score? | Each pattern has score, severity, family, reason codes, evidence drawer, affected agents/players, source timestamps, and acknowledgement/escalation path. |
| Positions | Positions | Risk manager | Summarize current exposure by sport, game, side, agent, and customer. | Where are we overexposed and what customers or agents are driving it? | Totals reconcile to live wagers, filters are explicit, stale data is marked, and drill-down links to wagers/player/agent context. |
| PPH Books | Buckeye | Book operator, support | Serve as the live Buckeye wager command center. | What just came in, what changed, and is ingestion healthy? | Live feed is resilient, paused/error states are visible, raw wager detail is inspectable, and checkpoints prevent duplicate processing. |
| PPH Books | Ace Per Head | Integration owner | Reserve a provider-compatible book adapter surface. | Is this provider configured, planned, or unavailable? | Placeholder cannot imply live data; future implementation must match Buckeye's health, vault, wager, and exposure contracts. |
| PPH Books | Metallic | Integration owner | Reserve a provider-compatible book adapter surface. | Is this provider configured, planned, or unavailable? | Placeholder cannot imply live data; future implementation must match Buckeye's health, vault, wager, and exposure contracts. |
| Agent Network | Agent Tree | Risk leader, operations | Show hierarchical risk concentration across the agent network. | Which branches have exposure, active players, patterns, or ingestion issues? | Nodes show agent level, parent/child lineage, player count, exposure, pattern count, and source freshness. |
| Agent Network | Downline | Operations, risk analyst | Provide a sortable agent rollup for hierarchy and performance review. | Which agents are active, growing, exposed, or anomalous? | Agent rows include player count, child count, volume, exposure, pattern count, last activity, and stable links to detail filters. |
| Agent Network | Player Search | Support, risk analyst | Find any player quickly and jump to current risk context. | Who is this player and what is their current status? | Search handles padded IDs, case differences, aliases, and links to player detail, wagers, agent, IP, and pattern evidence. |
| Agent Network | Player Detail | Risk analyst, support | Provide a 360-degree player profile. | What has this player bet, won/lost, shared, or triggered recently? | Detail includes recent wagers, exposure, P&L trend, agent lineage, IP/access links, pattern history, and raw source identifiers. |
| System | Alerts | Operations, risk manager | Manage the actionable alert queue. | What needs acknowledgement now, who owns it, and what changed? | Alerts show severity, source, status, age, acknowledgement history, mute controls, and direct links to affected entities. |
| System | Webhooks | Admin, integration owner | Control outbound notifications and delivery health. | Where are alerts sent and are deliveries succeeding? | Webhooks support test send, retry history, redacted secrets, disable controls, provider type, and delivery logs. |
| System | Settings | Admin, operator | Configure runtime behavior safely. | What backend, vault, and provider settings are active? | Settings validate inputs, show vault presence not values, explain logout semantics, and prevent accidental ingestion shutdown. |
| System | Status | Operator, SRE | Show backend and ingestion health at a glance. | Is the system live, what is stale, and what failed last? | Every poller has active state, last success, last error, lag, checkpoint, vaulted-agent status, and provider availability. |
| Exchanges | Polymarket | Trading/product owner | Reserve exchange-market ingestion and risk workflow. | Is exchange data configured and how will it map to events? | Placeholder must be explicit; future tab should use provider health, market mapping, positions, and exposure parity. |
| Exchanges | Kalshi | Trading/product owner | Reserve regulated event-contract ingestion and risk workflow. | Is exchange data configured and how will it map to events? | Placeholder must be explicit; future tab should use provider health, market mapping, positions, and exposure parity. |
| Coming Soon | Heatmap | Trader | Future visual summary of line movement intensity. | Which events are moving fastest? | Until implemented, it should remain non-interactive or clearly marked unavailable. |
| Coming Soon | Candlestick | Trader, analyst | Future historical odds charting. | How did price move over time? | Must be backed by persisted odds snapshots and clear time-window controls before being promoted. |
| Coming Soon | Bet Builder | Trader | Future multi-leg construction and exposure preview. | What combined position would this create? | Must validate legs, price source, max exposure, and audit generated tickets before being promoted. |

## Cross-Tab Enterprise Standards

Every production tab should include:

- A clear page title and compact subtitle describing the operational purpose.
- Last-updated status and whether the data is live, cached, unavailable, or simulated.
- Time-window controls when history matters.
- Search or filter controls that preserve enough state to share/debug the current view.
- Empty states that explain whether there is no data, no match, or a provider failure.
- Error states with the failed source, retry behavior, and the last known good timestamp.
- Drill-down links to the most relevant entity: wager, game, player, agent, pattern, alert, or provider.
- Exports only when the exported fields and source freshness are unambiguous.

## Data Contract Requirements

Enterprise tabs should not depend on ambiguous frontend-only derivation for core numbers. Backend/API responses should provide:

- Stable IDs and raw source IDs, including wager numbers, agent login, customer login, event IDs, pattern IDs, and checkpoint sequence values.
- Normalized display values plus raw values when the source format matters.
- `source`, `pulledAt`, `updatedAt`, or equivalent freshness fields.
- Pagination or hard limits for history tables.
- Explicit flags for simulated/demo data versus live provider data.
- Reason codes for derived risk or pattern decisions.

## Workflow Standards

Use these defaults when designing or refining tabs:

- **Summary to evidence**: cards and badges summarize, tables prioritize, drawers explain.
- **Investigate in place**: clicking a risk item should open context without forcing a full navigation unless the user asks for a detail page.
- **No hidden destructive work**: disconnect, logout, clear vault, mute alerts, and delete webhook must have distinct labels and behavior.
- **Preserve filters**: when navigating from Agent Network to Patterns or Positions, carry the agent/player/game filter.
- **Fast scanning**: tables should be sortable by the field operators care about most, usually severity, exposure, volume, activity, or freshness.

## Security and Compliance

Enterprise software handling live betting operations must:

- Never display bearer tokens, Cloudflare cookies, passwords, webhook secrets, or raw sensitive exports.
- Store credential presence and health separately from secret values.
- Keep raw Buckeye exports out of source control.
- Make logout semantics explicit: clearing a vault entry stops future restore for that agent, while browser disconnect does not stop backend ingestion.
- Redact sensitive fields in logs, API responses, webhooks, screenshots, and docs.
- Prefer audit trails for user actions that change alert state, webhook delivery, credentials, or ingestion behavior.

## Observability

The Status tab and health endpoints should eventually cover:

- Backend process uptime and runtime version.
- WebSocket connection count and last broadcast time.
- Odds provider health and last movement ingest.
- Buckeye agent health per vaulted agent.
- Wager, access-log, performance, and sports-type checkpoints.
- Pattern detector last run, rows evaluated, rows emitted, and last error.
- Alert/webhook delivery queue depth and failure count.
- Database file/path health and write errors.

## Definition of Done for Any Tab

A tab is enterprise-ready when:

- It has a single clear job and does not duplicate another tab's primary workflow.
- It answers the operator's most urgent question without opening another page.
- Its numbers reconcile to named source data.
- It has loading, empty, error, stale, and live states.
- It supports investigation through filters, sorting, and drill-down.
- It is documented in `README.md`, `docs/IMPLEMENTATION_TRACKER.md`, and this file.
- Tests cover the backend route or core derivation that powers it when the tab affects risk, money, secrets, or alerts.

## Maturity Levels

Use this scale to classify tabs in the tracker:

| Level | Meaning | Example Standard |
|-------|---------|------------------|
| 0 | Placeholder | Clearly marked coming soon, no fake operational controls. |
| 1 | Read-only | Renders real or demo data with clear source labeling. |
| 2 | Live operational | Auto-refresh/live update, filters, stale states, and drill-down. |
| 3 | Actionable | Acknowledge, mute, export, retry, or configure actions with audit-safe behavior. |
| 4 | Assisted decisioning | Patterns, recommendations, grouped alerts, and evidence-backed confidence. |

