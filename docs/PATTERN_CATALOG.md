# Pattern Catalog

SportsTerminal patterns are generated from local persisted evidence, not placeholder UI values. New Buckeye wagers flow through `wagers`, odds movements flow through `line_movements`, access-log clusters flow through `access_logs`, and all detections persist to `detected_patterns`.

The operator-facing source of truth is:

- API: `GET /api/patterns/catalog`
- Backend catalog: `backend/src/patterns/catalog.ts`
- Wager/IP/live detectors: `backend/src/patterns/PatternService.ts`
- Odds movement detectors: `backend/src/odds/OddsPoller.ts`

Each catalog entry includes the detector name, active source tables, trigger threshold, severity rule, reason codes, evidence fields, and confidence level.

## Active Detector Families

| Family | Examples | Primary Tables |
|--------|----------|----------------|
| Odds movement | `Steam Move`, `Reverse Line` | `line_movements`, `detected_patterns` |
| Agent/wager clustering | `Agent Swarm`, `cross_agent_steam`, `Cross-Agent Swarm` | `wagers`, `detected_patterns`, `pattern_agents` |
| Live timing | `Live Past-Post Risk`, `Late Live Spike` | `wagers`, `events`, `detected_patterns` |
| Agent behavior | `agent_reversal`, `late_money`, `velocity_spike` | `wagers`, `events`, `detected_patterns` |
| PIN correlation | `Pinnacle Drift Bet`, `Post-PIN Move Bet`, `Repeat Timing Signature`, `Steam Chase` | `wagers`, `odds_snapshots`, `line_movements`, `detected_patterns` |
| IP correlation | `Shared IP Cluster`, `IP Follow Pattern` | `access_logs`, `wagers`, `detected_patterns` |

## Verification

Useful local checks:

```powershell
Invoke-RestMethod http://localhost:3000/api/patterns/catalog
Invoke-RestMethod "http://localhost:3000/api/patterns/history?limit=5&sinceHours=24"
Invoke-RestMethod "http://localhost:3000/api/patterns/summary?sinceHours=24"
```

The Patterns tab reads the catalog and shows detector definitions next to live detections, so unsupported/static pattern names should not appear as first-class filter choices.
