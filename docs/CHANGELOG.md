# Changelog

## Unreleased - v5.3

### Added

- Always-on Buckeye ingestion for vaulted agents while the backend process is running.
- Multi-agent OS vault index and per-agent secret presence checks through `Bun.secrets`.
- Startup restore for all vaulted Buckeye agents, with independent failure handling.
- Vault health API and Settings UI vault panel.
- Manual vault logout for one agent, with internal clear-all support.
- Access-log ingestion through Buckeye `getWebLog`.
- Agent performance ingestion through `getAgentPerformance`.
- Sports type seeding through `getSportsType`.
- Ingestion checkpoints for future-safe incremental pulls.
- Pattern history, summary, evidence, and filter surfaces.
- System Status sidebar page for backend, vault, book, and pattern health.
- `backend/src/config/env.ts` startup environment validation.
- Managed scheduler service for recurring backend loops.
- Bun install security scanner configuration through `bunfig.toml`.
- Project organization guide.

### Changed

- Browser disconnect no longer stops Buckeye ingestion.
- Database wrapper now uses Bun SQL while preserving the app's local DB API shape.
- Odds and Buckeye recurring jobs now run through managed scheduler loops.
- README, Buckeye scope, and implementation tracker now describe the v5.3 architecture.

### Notes

- `Bun.scheduler` is not available in the local Bun 1.3.13 runtime, so recurring work uses managed `Bun.sleep` loops.
- Raw Buckeye hierarchy/player exports remain ignored because they can contain sensitive customer and agent data.
