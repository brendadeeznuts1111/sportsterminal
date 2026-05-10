# Integrity Analytics Research Notes

These notes translate external sports-betting integrity guidance into concrete SportsTerminal product work. They are product and engineering guidance, not legal advice.

## Source Signals

| Source | Relevant Pattern | SportsTerminal Implication |
| --- | --- | --- |
| [NJ Admin Code 13:69N-1.6](https://regulations.justia.com/states/new-jersey/title-13/chapter-69n/subchapter-1/section-13-69n-1-6/) | Operators need controls for unusual activity, review/report flows, action tracking, and confidentiality around suspicious activity data. | Keep syndicate tooling evidence-based, read-only by default, auditable, and careful about who can see account-level clusters. |
| [UK Gambling Commission: Protecting betting integrity](https://www.gamblingcommission.gov.uk/licensees-and-businesses/guide/protecting-betting-integrity-may-2019) | Integrity operations need clear escalation paths, betting-risk review, and information handling discipline. | Add a case queue for high-risk clusters, with status, reviewer, notes, and source evidence packets. |
| [Sportradar integrity detection](https://sportradar.com/integrity-regulatory/integrity/anti-match-fixing/detection/) | Detection systems combine odds movement, staking data, operator intelligence, expert review, and affected-market summaries. | Move from single-rule alerts to multi-signal cluster scoring: same-selection timing, stake concentration, line movement, agent/player history, and event context. |
| [Google SRE monitoring guidance](https://sre.google/sre-book/monitoring-distributed-systems/) | Dashboards should answer operational questions and monitor latency, traffic, errors, and saturation. | Add analytics service health stats: scan latency, upstream failures, queue depth, detection count, false-positive dispositions, and cache age. |

## Current Implementation Direction

The Patterns tab now has a Syndicate Intelligence panel backed by `/api/proxy/analytics/syndicates`. The proxy stores normalized wager analytics, scores live clusters, and caches risk evidence fields so `/api/proxy/risk/syndicates` returns the same review shape. High-risk clusters can be promoted into the Integrity Case Queue, which stores status, priority, reviewer, notes, and the evidence packet for later review.

## Next Product Slices

| Priority | Slice | Endpoint/UI Work |
| --- | --- | --- |
| P0 | Integrity Case Queue | Implemented: `integrity_cases` table and Patterns tab queue for open, reviewing, escalated, closed, and false-positive cases. Next step is automatic seeding thresholds. |
| P0 | Evidence Packet Export | Add JSON/CSV export for a cluster: members, tickets, line, stake, timestamps, line moves, related players, notes, and reviewer actions. |
| P1 | Alert Hygiene Metrics | Add `/api/proxy/analytics/syndicates/stats` with scan latency, cluster count, high-score count, stale cache age, and reviewed/closed counts. |
| P1 | Multi-Signal Score v2 | Include line movement correlation, player prior sharpness, repeated pairings, common agent/downline, IP overlap, and VIP/ALERT channel flags. |
| P2 | Similar-Activity Replay | Given one cluster, search the local archive for prior matching patterns by same member set, market, league, time window, or stake band. |
| P2 | RBAC Guardrails | Gate account-level members, passwords, tokens, cookies, and raw payloads behind explicit admin/API-key scopes. |

## Review Principles

- Keep automated outputs explainable: every score should include visible signals.
- Prefer read-only recommendations before any line-adjustment or wager-action mutation.
- Preserve normalized dollars in analytics tables; raw Buckeye cents should not leak into UI totals.
- Treat suspicious-activity data as sensitive and avoid exposing raw credentials or copied cookies anywhere in UI, logs, docs, or test fixtures.
