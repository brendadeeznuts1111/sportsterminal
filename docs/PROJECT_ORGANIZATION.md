# Project Organization

This guide keeps the Sports Terminal repo from drifting as Buckeye ingestion, patterns, and frontend operations grow.

## Source of Truth Docs

| File | Owns | Update When |
|------|------|-------------|
| `README.md` | How to run the app, current architecture, UI/API map | User-facing feature, route, env, or runtime behavior changes |
| `docs/IMPLEMENTATION_TRACKER.md` | Current delivery status, follow-ups, verification checklist | A zone moves status or a major feature lands |
| `docs/BUCKEYE_BACKEND_SCOPE.md` | Buckeye endpoint contract, request fields, persistence contract | New Buckeye endpoint, schema, ingest loop, or response shape |
| `docs/CHANGELOG.md` | Chronological release notes | Before handoff or commit for meaningful changes |
| `docs/CODE_QUALITY_CHECKLIST.md` | Review checks and recurring gotchas | A repeated bug class appears |
| `docs/DEVELOPMENT_ROADMAP.md` | Historical planning/audit context | Rarely; prefer tracker for current status |
| `AGENTS.md` | Coding-agent rules and project conventions | Workflow, commands, or architecture conventions change |

## Runtime File Boundaries

| Area | Location | Rule |
|------|----------|------|
| HTTP server, static frontend, WS upgrade | `backend/src/index.ts` | Keep boot orchestration here, not feature logic |
| Environment validation | `backend/src/config/env.ts` | Add every new env var here and in `README.md` |
| Database wrapper and schema | `backend/src/database.ts` | Keep table creation and wrapper compatibility here |
| Feature routes | `backend/src/api/routes/` | Route code should validate request/response shape and delegate logic |
| Buckeye HTTP client | `backend/src/scrapers/BuckeyeAPI.ts` | Upstream request building, parsing, normalization |
| Buckeye lifecycle | `backend/src/scrapers/ScraperManager.ts` | Polling, checkpoints, vault refresh, per-agent status |
| OS vault | `backend/src/services/BunSecretVault.ts` | Secret presence/index behavior only; never leak values |
| Startup restore | `backend/src/services/BuckeyeVaultRestore.ts` | Restore all vaulted agents and isolate failures |
| Scheduling | `backend/src/services/Scheduler.ts` | Recurring loop registration and cleanup |
| Pattern logic | `backend/src/patterns/` | Detection, persistence, summaries, evidence |
| Risk alerts | `backend/src/risk/` | Wager alert rules, independent of UI |
| Odds pipeline | `backend/src/odds/` | Providers, snapshots, movements, book health |
| Frontend SPA | `frontend/public/index.html` | UI sections, client fetches, local rendering |

## Data and Generated Files

Keep these out of source control:

- `backend/data/`
- `backend/dist/`
- `node_modules/`
- `backend/node_modules/`
- `docs/agentobject.md`
- `docs/agentslistharz.md`
- `docs/*.exe`

Tracked `.docx` files in `docs/` are product/reference artifacts. Raw markdown exports are local sensitive inputs and are ignored.

## Adding a Buckeye Endpoint

1. Add request-building and response normalization to `BuckeyeAPI.ts`.
2. Add persistence schema/checkpointing in `database.ts` if the data is durable.
3. Add lifecycle polling or one-shot trigger in `ScraperManager.ts` when needed.
4. Add an API route only if the frontend or an operator needs to inspect it.
5. Update `docs/BUCKEYE_BACKEND_SCOPE.md` with request fields and response notes.
6. Add route/client tests with synthetic response fixtures.

## Adding a Pattern

1. Keep parsing/correlation deterministic and fixture-backed.
2. Store evidence and reason codes in `detected_patterns`.
3. Link affected agents in `pattern_agents` when applicable.
4. Return lightweight summaries for dashboards.
5. Update Patterns UI filters only when the operator needs a new investigation path.
6. Add tests for false-positive guardrails as well as positive detections.

## Frontend Organization

The frontend is a single HTML file today. Keep it navigable:

- Put sidebar buttons near the matching section markup.
- Keep section rendering functions named `render...` or `load...`.
- Use data attributes and delegated event listeners instead of unsafe inline dynamic JavaScript.
- Escape external text before rendering.
- Keep cards for real repeated items or panels; avoid nested card layouts.
- Update the UI Map in `README.md` when sidebar tabs change.

## Documentation Handoff Checklist

Before ending a substantial task:

- `README.md` reflects new visible behavior.
- `docs/IMPLEMENTATION_TRACKER.md` reflects current status and follow-ups.
- `docs/BUCKEYE_BACKEND_SCOPE.md` reflects new Buckeye/API/schema behavior.
- `docs/CHANGELOG.md` has a short entry.
- Sensitive raw files remain ignored.
- `bun test` and `bun run build` have been run for code changes.

## Naming and Versioning

- Use v5.3 for the current always-on ingestion/status/pattern baseline.
- Keep future speculative work out of the current tracker unless it is an explicit next step.
- Prefer concrete route/table/function names in docs over broad labels.
