# Vendored team registry

These files come from the turbo-cap desk registry. Do not edit them here; regenerate there and copy.

| File | Source in turbo-cap-valley-lion |
|---|---|
| `teams.ref.json` | `src/desk/aliases/teams.ref.json`, built by `bun run teams:ref` from vendored ESPN snapshots (746 teams: NFL, NBA, MLB, NHL, WNBA, MLS, EPL, UCL, Liga MX, FBS, D1 men's basketball) |
| `teams.donors.json` | `src/desk/aliases/teams.donors.json`: 4C `TEAM_ALIASES` (4c-odds-integration@789bdbd) and deep-link WNBA book spellings (deeplink-automation@76a9264), mapped to ESPN ids per league |
| `teams.authored.json` | `src/desk/aliases/teams.jsonc` with its comments removed (desk overrides; "Sacramento Athletics" is an inferred spelling) |
| `normalize.ts`, `team-index.ts` | `src/desk/teams/normalize.ts`, `src/desk/aliases/team-index.ts` (import paths changed only). The same files are vendored in the feed repo (`src/services/sharp-detection/teams/`) |

Provenance: turbo-cap commit `4d484f3d` on the local stack branch `cursor/teammeta-2-alias-normalization`. **That commit is not on GitHub yet**: turbo-cap is landed through its own gate, so the SHA becomes reachable only after the stack lands (it may then differ; the file hashes below will not).

```
sha256 teams.ref.json    2a3c211448ec51296fcb9fab43d6008189e204c3a24bc5e71ee9e0dcac5dc011
sha256 teams.donors.json f6ca9d438c5c92dd17fa61a904ba63ae1705d0e67657c770c8a31a2855c4f86a
```
