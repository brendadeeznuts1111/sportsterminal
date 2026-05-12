# 🔍 Ripgrep Command Sheet — Color & Inspect Validation
## Sports Terminal Codebase Audit Commands

Run these from the SportsTerminal repo root (`C:\Users\bobby\sportsterminal\`).

**Prerequisites:** `ripgrep` (`rg`) installed. On Windows, `winget install BurntSushi.ripgrep.MSVC` is the usual path.

Most snippets are intentionally copy-pasteable from PowerShell.

---

## 1. ANSI COLOR TOKEN DISCOVERY

### Find ALL color token definitions
```bash
rg "\\$\." docs/inspectable-all.ts
```
**Expected output:** Every `$.red`, `$.green`, `$.orange`, etc. definition

### Find ALL background color combinations
```bash
rg "bgRedWhite|bgYellowBlack|bgGreenBlack|bgOrangeBlack" docs/inspectable-all.ts
```

### Find ALL `tierColor()` usages (risk tier mapping)
```bash
rg "tierColor\(" docs/inspectable-all.ts
```

### Find ALL `severityColor()` usages (alert severity)
```bash
rg "severityColor\(" docs/inspectable-all.ts
```

### Find ALL `pnlColor()` usages (profit/loss)
```bash
rg "pnlColor\(" docs/inspectable-all.ts
```

### Find ALL `scoreBar()` usages (visual bars)
```bash
rg "scoreBar\(" docs/inspectable-all.ts
```

---

## 2. Bun.inspect.custom AUDIT

### Find ALL custom inspect implementations
```bash
rg "\[Bun\.inspect\.custom\]" backend/src/ docs/
```
**Expected:** 25 matches in `docs/inspectable-all.ts`, plus the smaller production subset in `backend/src/types/inspectable-v2.ts`.

### Find custom inspect by domain object
```powershell
(rg "^  \[Bun\.inspect\.custom\]" docs/inspectable-all.ts | Measure-Object).Count
```
**Should return:** `25`

### Find custom inspect implementations outside the two known inspectable files
```powershell
rg "\[Bun\.inspect\.custom\]" backend/src/ docs/ -g "!types/inspectable-v2.ts" -g "!inspectable-all.ts"
```
**Should return:** Nothing unless another module intentionally adds a domain inspector.

### Find custom inspect for a SPECIFIC object
```powershell
Select-String -Path docs/inspectable-all.ts -Pattern "class Wager" -Context 0,30
```

---

## 3. toTableRow() AUDIT

### Find ALL toTableRow implementations
```bash
rg "^  toTableRow\(\): Record<string, unknown> \{" docs/inspectable-all.ts
```
**Expected:** 25 matches

### Count table columns per object (property count check)
```powershell
(rg -A 30 "toTableRow\(\)" docs/inspectable-all.ts | Select-String '^\s+"?[A-Za-z]' | Measure-Object).Count
```
**Should be:** 400+ (all properties across all objects)

### Find objects MISSING toTableRow
```powershell
rg "class (Wager|Agent|Player|RiskScore|Position|RiskAlert|HubSummary|PluginManifest|PluginExecution|AIRiskFlag|AgentAction|EnforcementQueueItem|TelegramRoute|BuckeyeWriteAudit|PlayerTransaction|WagerViolation|PlayerFlag|SportEvent|Market|HealthStatus|WebhookAlert|ArchetypeResult|PlayerNote|PluginCronJob|RequestLog)" docs/inspectable-all.ts | Select-String -NotMatch "toTableRow"
```
**Should return:** Nothing

---

## 4. COLOR USAGE IN LOGS / CONSOLE

### Find ALL `console.log` with colored output
```bash
rg "console\.(log|error|warn|debug)" backend/src/ --type ts
```

### Find logger calls that might bypass inspectable objects
```powershell
rg "logger\.(info|warn|error|debug|audit)" backend/src/ --type ts | Select-Object -First 50
```

### Find `Bun.inspect` calls with color options
```bash
rg "Bun\.inspect\(" backend/src/ --type ts
```

### Find `Bun.inspect.table` calls
```bash
rg "Bun\.inspect\.table\(" backend/src/ --type ts
```

---

## 5. RENDER HELPER USAGE

### Find `renderTable` usage across codebase
```bash
rg "renderTable\(" backend/src/ --type ts
```

### Find `renderCompact` usage
```bash
rg "renderCompact\(" backend/src/ --type ts
```

### Find `renderCards` usage
```bash
rg "renderCards\(" backend/src/ --type ts
```

### Find `renderSummaryStats` usage
```bash
rg "renderSummaryStats\(" backend/src/ --type ts
```

### Find `renderSection` usage
```bash
rg "renderSection\(" backend/src/ --type ts
```

---

## 6. SERVICE-LAYER OBJECT INSTANTIATION

### Find where Wager objects are created
```bash
rg "new Wager\(" backend/src/ --type ts
```

### Find where Agent objects are created
```bash
rg "new Agent\(" backend/src/ --type ts
```

### Find where Player objects are created
```bash
rg "new Player\(" backend/src/ --type ts
```

### Find where RiskScore objects are created
```bash
rg "new RiskScore\(" backend/src/ --type ts
```

### Find where Position objects are created
```bash
rg "new Position\(" backend/src/ --type ts
```

### Find where RiskAlert objects are created
```bash
rg "new RiskAlert\(" backend/src/ --type ts
```

### Find ALL new * instantiations (comprehensive)
```bash
rg "new (Wager|Agent|Player|RiskScore|Position|RiskAlert|HubSummary|PluginManifest|PluginExecution|AIRiskFlag|AgentAction|EnforcementQueueItem|TelegramRoute|BuckeyeWriteAudit|PlayerTransaction|WagerViolation|PlayerFlag|SportEvent|Market|HealthStatus|WebhookAlert|ArchetypeResult|PlayerNote|PluginCronJob|RequestLog)\(" backend/src/ --type ts
```

---

## 7. FRONTEND CONSUMPTION

### Find React components importing inspectable types
```bash
rg "from .*inspectable" frontend/public/ --type ts -g "*.js" -g "*.html"
```

### Find console.log in frontend
```powershell
rg "console\.(log|error|warn)" frontend/public/ -g "*.js" -g "*.html" | Select-Object -First 30
```

### Find where objects are rendered to DOM
```powershell
rg "JSON\.stringify" frontend/public/ -g "*.js" -g "*.html" | Select-Object -First 20
```

---

## 8. TEST COVERAGE

### Find test files asserting on inspect output
```bash
rg "Bun\.inspect" backend/tests/ --type ts
```

### Find test files with color assertions
```bash
rg "\\x1b\[" backend/tests/ --type ts
```

### Find test files using domain objects
```bash
rg "new (Wager|Agent|Player|RiskScore)" backend/tests/ --type ts
```

---

## 9. VALIDATION PIPELINE (Run All)

### Master validation script — save as `scripts/validate-colors.ps1`
```powershell
$ErrorActionPreference = "Stop"

echo "=== Color Token Validation ==="
echo "Color tokens defined:"
(rg "^\s+red:|^\s+green:|^\s+yellow:|^\s+orange:|^\s+cyan:|^\s+magenta:|^\s+gold:" docs/inspectable-all.ts | Measure-Object).Count

echo ""
echo "=== Bun.inspect.custom Count ==="
(rg "^  \[Bun\.inspect\.custom\]" docs/inspectable-all.ts | Measure-Object).Count

echo ""
echo "=== toTableRow Count ==="
(rg "^  toTableRow\(\): Record<string, unknown> \{" docs/inspectable-all.ts | Measure-Object).Count

echo ""
echo "=== Domain Object Classes ==="
(rg "^export class" docs/inspectable-all.ts | Measure-Object).Count

echo ""
echo "=== Service Layer Instantiations ==="
(rg "new (Wager|Agent|Player|RiskScore|Position|RiskAlert)\(" backend/src/ --type ts | Measure-Object).Count

echo ""
echo "=== Render Helper Usage ==="
(rg "renderTable|renderCompact|renderCards|renderSummaryStats" backend/src/ --type ts | Measure-Object).Count

echo ""
echo "=== Logger Integration ==="
(rg "logger\.(info|warn|error|debug|audit|table)" backend/src/ --type ts | Measure-Object).Count

echo ""
echo "=== CLI Formatter Usage ==="
(rg "CLIOutput|buildTable|badge|progressBar" backend/src/ --type ts | Measure-Object).Count

echo ""
echo "Validation complete"
```

**Run it:**
```powershell
.\scripts\validate-colors.ps1
```

---

## 10. ONE-LINER AUDITS

### Quick health check — all counts in one command
```powershell
"inspect.custom: $((rg '^  \[Bun\.inspect\.custom\]' docs/inspectable-all.ts | Measure-Object).Count), toTableRow: $((rg '^  toTableRow\(\): Record<string, unknown> \{' docs/inspectable-all.ts | Measure-Object).Count), classes: $((rg '^export class' docs/inspectable-all.ts | Measure-Object).Count)"
```

### Find orphaned color tokens (defined but never used)
```powershell
foreach ($token in "red","green","yellow","blue","magenta","cyan","orange","gold","dim","bold") {
  $count = (rg "\$\.\b$token\b" docs/inspectable-all.ts | Measure-Object).Count
  "$.$token: $count usages"
}
```

### Find which objects have the MOST colored properties
```powershell
rg "c\(\$\." docs/inspectable-all.ts
```

### Find objects with NO color in inspect.custom (should be none)
```powershell
rg "\[Bun\.inspect\.custom\]|c\(\$\." docs/inspectable-all.ts
```

---

## 11. FILE-SPECIFIC DEEP DIVES

### In `proxy-enhanced.ts` — find all object instantiations
```bash
rg "new (Wager|Agent|Player|RiskScore|Position|RiskAlert|HealthStatus|RequestLog)\(" proxy-enhanced.ts
```

### In `PluginLoader.ts` — find execution logging
```bash
rg "logger\.|console\.|Bun\.inspect" plugins/loader.ts
```

### In `EnrichedWagerService.ts` — find enrich + feed
```bash
rg "new Wager|tickerBuffer|feed" backend/src/services/EnrichedWagerService.ts
```

### In `batch-ai-analysis.ts` — find AI flag creation
```bash
rg "new AIRiskFlag|logger\." backend/scripts/batch-ai-analysis.ts
```

### In `run-rules-engine.ts` — find action creation
```bash
rg "new AgentAction|logger\." backend/scripts/run-rules-engine.ts
```

---

## 12. CROSS-REFERENCE CHECKS

### Verify every color token in `$.` object is used at least once
```powershell
"Token,Defined,Used"
foreach ($token in "red","green","yellow","blue","magenta","cyan","orange","gold","darkOrange","bRed","bGreen","bYellow","dim","bold","italic","underline","bgRedWhite","bgYellowBlack","bgGreenBlack","bgOrangeBlack") {
  $defined = (rg "^\s+$token:" docs/inspectable-all.ts | Measure-Object).Count
  $used = (rg "\$\.\b$token\b" docs/inspectable-all.ts | Measure-Object).Count
  "$token,$defined,$used"
}
```

### Find hardcoded ANSI codes (should all use `$.` tokens)
```powershell
rg "\\x1b\[[0-9;]*m" backend/src/ --type ts -g "!types/inspectable-v2.ts" | Select-Object -First 20
```
**Should return:** Minimal results (only in logger/cli-formatter if anywhere)

### Find ANSI escape literals outside the production inspectable module
```powershell
rg "\\x1b" backend/src/ --type ts -g "!types/inspectable-v2.ts"
```

---

## 13. EXPECTED COUNTS REFERENCE

| Metric | Expected Count | Validation Command |
|--------|---------------|-------------------|
| Domain classes | 25 | `(rg "^export class" docs/inspectable-all.ts \| Measure-Object).Count` |
| `Bun.inspect.custom` | 25 | `(rg "^  \[Bun\.inspect\.custom\]" docs/inspectable-all.ts \| Measure-Object).Count` |
| `toTableRow()` | 25 | `(rg "^  toTableRow\(\): Record<string, unknown> \{" docs/inspectable-all.ts \| Measure-Object).Count` |
| Color tokens in `$` | 30+ | `rg "^\s+\w+:" docs/inspectable-all.ts \| Select-Object -First 40` |
| Service instantiations | 50+ | `(rg "new (Wager\|Agent\|Player)" backend/src/ --type ts \| Measure-Object).Count` |
| Logger calls | 100+ | `(rg "logger\." backend/src/ --type ts \| Measure-Object).Count` |
| `renderTable` calls | 20+ | `(rg "renderTable" backend/src/ --type ts \| Measure-Object).Count` |
| Test coverage | 46 files | `(Get-ChildItem backend/tests/*.test.ts \| Measure-Object).Count` |

---

## 14. FIX COMMANDS

### If a class is missing `toTableRow()`
```powershell
foreach ($line in rg "^export class" docs/inspectable-all.ts) {
  $class = ($line -split "\s+")[2]
  $hasTable = (rg -A 50 "class $class" docs/inspectable-all.ts | Select-String "toTableRow" | Measure-Object).Count
  if ($hasTable -eq 0) { "MISSING toTableRow: $class" }
}
```

### If a class is missing `Bun.inspect.custom`
```powershell
foreach ($line in rg "^export class" docs/inspectable-all.ts) {
  $class = ($line -split "\s+")[2]
  $hasInspect = (rg -A 20 "class $class" docs/inspectable-all.ts | Select-String "Bun.inspect.custom" | Measure-Object).Count
  if ($hasInspect -eq 0) { "MISSING Bun.inspect.custom: $class" }
}
```

---

## Quick Reference: rg Flags Used

| Flag | Meaning |
|------|---------|
| `-A N` | Show N lines **After** match |
| `-B N` | Show N lines **Before** match |
| `-C N` | Show N lines of **Context** (before + after) |
| `--type ts` | Search only TypeScript files |
| `--type tsx` | Search only TSX files |
| `--files-with-match` | Only show filenames with matches |
| `--files-without-match` | Only show filenames WITHOUT matches |
| `-l` | Short for `--files-with-match` |
| `-c` | Count matches per file |
| `-w` | Match whole words only |
| `-i` | Case-insensitive |
| `-n` | Show line numbers |
| `--no-heading` | Don't group by filename |
| `-o` | Only show matching part |
| `-p` | Alias for `--pretty` (colorized output) |
| `-j 4` | Use 4 threads |
| `--max-columns 200` | Truncate long lines |
| `-g "*.ts"` | Only search `.ts` files |
| `-g "!*.test.ts"` | Exclude test files |
| `-g "!node_modules/**"` | Exclude node_modules |

---

Run `.\scripts\validate-colors.ps1` after every major change to ensure consistency.
