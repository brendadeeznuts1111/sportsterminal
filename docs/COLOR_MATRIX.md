# 🎨 Sports Terminal Color Matrix
## Domain Objects × Properties × Colors × Code Locations

---

## ANSI Color Reference (Bloomberg Terminal Dark Theme)

| Token | ANSI Code | Hex Approx | HSL | Usage |
|-------|-----------|------------|-----|-------|
| `$.reset` | `\x1b[0m` | `#FFFFFF` | — | Reset all styles |
| `$.bold` | `\x1b[1m` | — | — | Bold weight |
| `$.dim` | `\x1b[2m` | `#888888` | — | Dim/faint text |
| `$.red` | `\x1b[31m` | `#FF4444` | `0°, 100%, 63%` | ERROR, CRITICAL, negative P&L, BLACK tier, BLOCK action |
| `$.green` | `\x1b[32m` | `#44FF44` | `120°, 100%, 63%` | SUCCESS, HEALTHY, positive P&L, GREEN tier, DEPOSIT |
| `$.yellow` | `\x1b[33m` | `#FFFF44` | `60°, 100%, 63%` | WARN, DEGRADED, MEDIUM severity, RED tier, YELLOW tier, REDUCE action |
| `$.blue` | `\x1b[34m` | `#4444FF` | `240°, 100%, 63%` | INFO, BLUE tier, general labels |
| `$.magenta` | `\x1b[35m` | `#FF44FF` | `300°, 100%, 63%` | AI outputs, BACK side, SYNDICATE flags |
| `$.cyan` | `\x1b[36m` | `#44FFFF` | `180°, 100%, 63%` | Player IDs, LAY side, actions, keys |
| `$.orange` | `\x1b[38;5;208m` | `#FF8700` | `27°, 100%, 50%` | **Brand accent** — Agent labels, Hub labels, Archetype headers, section titles |
| `$.darkOrange` | `\x1b[38;5;166m` | `#D75F00` | `24°, 100%, 42%` | Secondary accent (reserved) |
| `$.gold` | `\x1b[38;5;220m` | `#FFD700` | `51°, 100%, 50%` | VIP, deposits, top values, MiniApp enabled |
| `$.bBlack` | `\x1b[90m` | `#808080` | — | Bright black (secondary text) |
| `$.bRed` | `\x1b[91m` | `#FF6B6B` | — | Bright red (intense errors) |
| `$.bGreen` | `\x1b[92m` | `#6BFF6B` | — | Bright green (intense success) |
| `$.bYellow` | `\x1b[93m` | `#FFFF6B` | — | Bright yellow (intense warnings) |
| `$.bgRedWhite` | `\x1b[41m\x1b[37m` | `#FF4444` bg, `#FFFFFF` fg | — | CRITICAL severity badge, LIVE status, FRAUD flag, SUSPENDED market |
| `$.bgYellowBlack` | `\x1b[43m\x1b[30m` | `#FFFF44` bg, `#000000` fg | — | DEGRADED badge, HEDGED status, AGENT type A |
| `$.bgGreenBlack` | `\x1b[42m\x1b[30m` | `#44FF44` bg, `#000000` fg | — | HEALTHY badge, OPEN status, AGENT type P |
| `$.bgOrangeBlack` | `\x1b[48;5;208m\x1b[30m` | `#FF8700` bg, `#000000` fg | — | SETTLED status, AGENT type M, default route star |

---

## Domain Object × Property × Color × Code Location Matrix

### 1. WAGER

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `WagerNumber` | `$.bold` | `#FFFFFF` bold | — | Primary identifier | `Wager[Bun.inspect.custom]` |
| `RiskTier` | `tierColor()` → `$.red/yellow/orange/green` | varies | varies | Tier severity mapping | `Wager[Bun.inspect.custom]` |
| `Archetype` | `$.dim` | `#888888` | — | Secondary metadata | `Wager[Bun.inspect.custom]` |
| `AmountWagered` | `$.bold` | `#FFFFFF` bold | — | Monetary value emphasis | `Wager[Bun.inspect.custom]` |
| `Sport` | — | — | — | Plain text | `Wager[Bun.inspect.custom]` |
| `Status` | `statusColor` → `$.green/red/yellow/dim` | varies | varies | WON=green, LOST=red, PENDING=yellow | `Wager[Bun.inspect.custom]` |
| `WinRate` | `$.green` if >60% else `$.yellow` | `#44FF44` / `#FFFF44` | 120°/60° | Win rate threshold | `Wager[Bun.inspect.custom]` |
| `AgentID` | — | — | — | Plain text | `Wager[Bun.inspect.custom]` |
| `Market` | — | — | — | Table only | `Wager.toTableRow()` |
| `Selection` | — | — | — | Table only | `Wager.toTableRow()` |
| `Line` | — | — | — | Table only | `Wager.toTableRow()` |
| `Odds` | — | — | — | Table only | `Wager.toTableRow()` |
| `BetType` | — | — | — | Table only | `Wager.toTableRow()` |
| `PlacedDate` | — | — | — | Table only | `Wager.toTableRow()` |
| `IPAddress` | — | — | — | Table only | `Wager.toTableRow()` |
| `Device` | — | — | — | Table only | `Wager.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:Wager[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:Wager.toTableRow()`
- `backend/src/services/EnrichedWagerService.ts` (data source)
- `backend/proxy-enhanced.ts` `/api/wagers/live` route

---

### 2. AGENT

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `login` | `$.bold` + `$.orange` | `#FF8700` bold | 27°, 100%, 50% | Primary identifier + brand | `Agent[Bun.inspect.custom]` |
| `agent_type="M"` | `$.bgOrangeBlack` | `#FF8700` bg, `#000000` fg | — | Master agent badge | `Agent[Bun.inspect.custom]` |
| `agent_type="A"` | `$.bgYellowBlack` | `#FFFF44` bg, `#000000` fg | — | Agent badge | `Agent[Bun.inspect.custom]` |
| `agent_type="P"` | `$.bgGreenBlack` | `#44FF44` bg, `#000000` fg | — | Player badge | `Agent[Bun.inspect.custom]` |
| `level` | — | — | — | Plain number | `Agent[Bun.inspect.custom]` |
| `agent_id` | `$.dim` | `#888888` | — | Secondary ID | `Agent[Bun.inspect.custom]` |
| `risk_score` | `$.red` if >0.75, `$.yellow` if >0.5, else `$.green` | varies | varies | Risk gradient | `Agent[Bun.inspect.custom]` |
| `hub_id` | `$.cyan` | `#44FFFF` | 180°, 100%, 63% | Hub reference | `Agent[Bun.inspect.custom]` |
| `children_count` | `$.dim` | `#888888` | — | Downline indicator | `Agent[Bun.inspect.custom]` |
| `credit_limit` | `$.dim` | `#888888` | — | Financial limit | `Agent[Bun.inspect.custom]` |
| `Parent` | — | — | — | Table only | `Agent.toTableRow()` |
| `Tier` | — | — | — | Table only | `Agent.toTableRow()` |
| `Wager Limit` | — | — | — | Table only | `Agent.toTableRow()` |
| `Balance` | — | — | — | Table only | `Agent.toTableRow()` |
| `7d Handle` | — | — | — | Table only | `Agent.toTableRow()` |
| `7d P&L` | — | — | — | Table only | `Agent.toTableRow()` |
| `Active` | — | — | — | Table only | `Agent.toTableRow()` |
| `Cluster` | — | — | — | Table only | `Agent.toTableRow()` |
| `Last Login` | — | — | — | Table only | `Agent.toTableRow()` |
| `Phone` | — | — | — | Table only | `Agent.toTableRow()` |
| `Email` | — | — | — | Table only | `Agent.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:Agent[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:Agent.toTableRow()`
- `backend/src/services/HierarchyService.ts`
- `backend/src/services/AgentFlatService.ts`
- `frontend/src/components/HierarchyTab.tsx`

---

### 3. PLAYER

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `customer_id` | `$.bold` + `$.cyan` | `#44FFFF` bold | 180°, 100%, 63% | Primary player ID | `Player[Bun.inspect.custom]` |
| `risk_tier` | `tierColor()` | varies | varies | Tier severity | `Player[Bun.inspect.custom]` |
| `sharp_score` | `$.red` if >70, `$.yellow` if >40, else `$.green` | varies | varies | Sharpness gradient | `Player[Bun.inspect.custom]` |
| `win_rate` | `$.red` if >60%, else `$.green` | `#FF4444` / `#44FF44` | 0°/120° | Win rate alert threshold | `Player[Bun.inspect.custom]` |
| `total_deposited` | `$.gold` | `#FFD700` | 51°, 100%, 50% | Financial value highlight | `Player[Bun.inspect.custom]` |
| `tags` | `$.dim` | `#888888` | — | Metadata list | `Player[Bun.inspect.custom]` |
| `Name` | — | — | — | Table only | `Player.toTableRow()` |
| `Archetype` | — | — | — | Table only | `Player.toTableRow()` |
| `Lifetime Wagers` | — | — | — | Table only | `Player.toTableRow()` |
| `Avg Wager` | — | — | — | Table only | `Player.toTableRow()` |
| `Open Bets` | — | — | — | Table only | `Player.toTableRow()` |
| `Settled` | — | — | — | Table only | `Player.toTableRow()` |
| `Withdrawn` | — | — | — | Table only | `Player.toTableRow()` |
| `Net Deposits` | — | — | — | Table only | `Player.toTableRow()` |
| `Balance` | — | — | — | Table only | `Player.toTableRow()` |
| `Credit` | — | — | — | Table only | `Player.toTableRow()` |
| `Violations` | — | — | — | Table only | `Player.toTableRow()` |
| `Flags` | — | — | — | Table only | `Player.toTableRow()` |
| `Last Active` | — | — | — | Table only | `Player.toTableRow()` |
| `First Seen` | — | — | — | Table only | `Player.toTableRow()` |
| `Country` | — | — | — | Table only | `Player.toTableRow()` |
| `City` | — | — | — | Table only | `Player.toTableRow()` |
| `IP` | — | — | — | Table only | `Player.toTableRow()` |
| `Notes` | — | — | — | Table only | `Player.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:Player[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:Player.toTableRow()`
- `backend/scripts/generate-archetypes.ts`
- `backend/scripts/batch-ai-analysis.ts`
- `backend/src/services/EnrichedWagerService.ts`
- `frontend/src/components/PlayerProfileTab.tsx`

---

### 4. RISK SCORE

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `compositeScore` | `$.red` if >0.75, `$.yellow` if >0.5, else `$.green` | varies | varies | Overall risk gradient | `RiskScore[Bun.inspect.custom]` |
| `flags` | `$.dim` | `#888888` | — | Flag list metadata | `RiskScore[Bun.inspect.custom]` |
| `aiConfidence` | `$.magenta` | `#FF44FF` | 300°, 100%, 63% | AI signal highlight | `RiskScore[Bun.inspect.custom]` |
| `traceId` | `$.dim` | `#888888` | — | Trace reference | `RiskScore[Bun.inspect.custom]` |
| `wagerNumber` | — | — | — | Plain reference | `RiskScore[Bun.inspect.custom]` |
| `playerId` | — | — | — | Plain reference | `RiskScore[Bun.inspect.custom]` |
| `Sharp` | `scoreBar()` | varies | varies | Visual bar in table | `RiskScore.inspectDetailed()` |
| `Velocity` | `scoreBar()` | varies | varies | Visual bar in table | `RiskScore.inspectDetailed()` |
| `IP Risk` | `scoreBar()` | varies | varies | Visual bar in table | `RiskScore.inspectDetailed()` |
| `Syndicate` | `scoreBar()` | varies | varies | Visual bar in table | `RiskScore.inspectDetailed()` |
| `CLV` | `scoreBar()` | varies | varies | Visual bar in table | `RiskScore.inspectDetailed()` |
| `Stake Anom` | `scoreBar()` | varies | varies | Visual bar in table | `RiskScore.inspectDetailed()` |
| `Timing` | `scoreBar()` | varies | varies | Visual bar in table | `RiskScore.inspectDetailed()` |
| `AI` | — | — | — | Table only | `RiskScore.toTableRow()` |
| `Model` | — | — | — | Table only | `RiskScore.toTableRow()` |
| `Time` | — | — | — | Table only | `RiskScore.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:RiskScore[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:RiskScore.inspectDetailed()`
- `src/types/inspectable-all.ts:RiskScore.toTableRow()`
- `plugins/risk-sharp-detector/scripts/detect.ts`
- `plugins/risk-sharp-detector/scripts/calculate.ts`
- `backend/src/services/RiskScoringService.ts`
- `Tests/risk-sharp-detector.test.ts`

---

### 5. POSITION

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `positionId` | `$.bold` | `#FFFFFF` bold | — | Primary identifier | `Position[Bun.inspect.custom]` |
| `side="back"` | `$.magenta` | `#FF44FF` | 300°, 100%, 63% | Back bet side | `Position[Bun.inspect.custom]` |
| `side="lay"` | `$.cyan` | `#44FFFF` | 180°, 100%, 63% | Lay bet side | `Position[Bun.inspect.custom]` |
| `pnl` | `$.green` if >0, `$.red` if <0, `$.dim` if 0 | varies | varies | Profit/loss direction | `Position[Bun.inspect.custom]` |
| `status="OPEN"` | `$.bgGreenBlack` | `#44FF44` bg | — | Open position badge | `Position[Bun.inspect.custom]` |
| `status="HEDGED"` | `$.bgYellowBlack` | `#FFFF44` bg | — | Hedged position badge | `Position[Bun.inspect.custom]` |
| `status="SETTLED"` | `$.bgOrangeBlack` | `#FF8700` bg | — | Settled position badge | `Position[Bun.inspect.custom]` |
| `bookExposure` | `$.yellow` | `#FFFF44` | 60°, 100%, 63% | Exposure warning | `Position[Bun.inspect.custom]` |
| `Sport` | — | — | — | Table only | `Position.toTableRow()` |
| `League` | — | — | — | Table only | `Position.toTableRow()` |
| `Market` | — | — | — | Table only | `Position.toTableRow()` |
| `Event` | — | — | — | Table only | `Position.toTableRow()` |
| `Stake` | — | — | — | Table only | `Position.toTableRow()` |
| `Odds` | — | — | — | Table only | `Position.toTableRow()` |
| `Odds Fmt` | — | — | — | Table only | `Position.toTableRow()` |
| `Exposure` | — | — | — | Table only | `Position.toTableRow()` |
| `Book Exp` | — | — | — | Table only | `Position.toTableRow()` |
| `Liability` | — | — | — | Table only | `Position.toTableRow()` |
| `Margin` | — | — | — | Table only | `Position.toTableRow()` |
| `Hold` | — | — | — | Table only | `Position.toTableRow()` |
| `Hedge ID` | — | — | — | Table only | `Position.toTableRow()` |
| `Hedge Stake` | — | — | — | Table only | `Position.toTableRow()` |
| `Hedge Odds` | — | — | — | Table only | `Position.toTableRow()` |
| `Opened` | — | — | — | Table only | `Position.toTableRow()` |
| `Closed` | — | — | — | Table only | `Position.toTableRow()` |
| `Settled` | — | — | — | Table only | `Position.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:Position[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:Position.toTableRow()`
- `backend/src/services/PositionLedgerService.ts`
- `frontend/src/components/TradingFloorTab.tsx`
- `frontend/src/components/PositionCard.tsx`

---

### 6. RISK ALERT

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `severity="CRITICAL"` | `$.bgRedWhite` | `#FF4444` bg, `#FFFFFF` fg | — | Critical alert badge | `RiskAlert[Bun.inspect.custom]` |
| `severity="HIGH"` | `$.red` | `#FF4444` | 0°, 100%, 63% | High severity | `RiskAlert[Bun.inspect.custom]` |
| `severity="MEDIUM"` | `$.yellow` | `#FFFF44` | 60°, 100%, 63% | Medium severity | `RiskAlert[Bun.inspect.custom]` |
| `severity="LOW"` | `$.green` | `#44FF44` | 120°, 100%, 63% | Low severity | `RiskAlert[Bun.inspect.custom]` |
| `type` | `$.dim` | `#888888` | — | Alert type label | `RiskAlert[Bun.inspect.custom]` |
| `playerId` | `$.bold` | `#FFFFFF` bold | — | Target emphasis | `RiskAlert[Bun.inspect.custom]` |
| `suggestedAction` | `$.cyan` | `#44FFFF` | 180°, 100%, 63% | Action highlight | `RiskAlert[Bun.inspect.custom]` |
| `delivered=false` | `$.red` | `#FF4444` | — | Undelivered warning | `RiskAlert[Bun.inspect.custom]` |
| `acknowledgedBy` | `$.green` | `#44FF44` | — | Acknowledged check | `RiskAlert[Bun.inspect.custom]` |
| `message` | `Bun.wrapAnsi()` | — | — | Long message wrapping | `RiskAlert[Bun.inspect.custom]` |
| `Wager` | — | — | — | Table only | `RiskAlert.toTableRow()` |
| `Channel` | — | — | — | Table only | `RiskAlert.toTableRow()` |
| `Delivered` | — | — | — | Table only | `RiskAlert.toTableRow()` |
| `Attempts` | — | — | — | Table only | `RiskAlert.toTableRow()` |
| `Ack` | — | — | — | Table only | `RiskAlert.toTableRow()` |
| `Dismissed` | — | — | — | Table only | `RiskAlert.toTableRow()` |
| `Related` | — | — | — | Table only | `RiskAlert.toTableRow()` |
| `Time` | — | — | — | Table only | `RiskAlert.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:RiskAlert[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:RiskAlert.toTableRow()`
- `backend/src/services/AlertRoutingService.ts`
- `plugins/alert-telegram-enhanced/index.ts`
- `plugins/alert-discord/index.ts`
- `frontend/src/components/RiskAlertPanel.tsx`

---

### 7. HUB SUMMARY

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `name` | `$.bold` + `$.orange` | `#FF8700` bold | 27°, 100%, 50% | Hub name + brand | `HubSummary[Bun.inspect.custom]` |
| `hub_id` | `$.dim` | `#888888` | — | Secondary ID | `HubSummary[Bun.inspect.custom]` |
| `avg_risk_score` | `$.yellow` if >0.5, else `$.green` | varies | varies | Risk threshold | `HubSummary[Bun.inspect.custom]` |
| `total_pnl_7d` | `pnlColor()` → `$.green/red/dim` | varies | varies | Profit/loss direction | `HubSummary[Bun.inspect.custom]` |
| `flagged_children` | `$.red` | `#FF4444` | — | Warning indicator | `HubSummary[Bun.inspect.custom]` |
| `active_players` | `$.dim` | `#888888` | — | Count metadata | `HubSummary[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Agents` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Players` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Active` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `7d Handle` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `30d Handle` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `7d P&L` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `30d P&L` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Risk Avg` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Risk Max` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Flags` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Deposits` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Withdrawals` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Commission` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Top Agent` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Top Handle` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Active Wagers` | — | — | — | Table only | `HubSummary.toTableRow()` |
| `Settled` | — | — | — | Table only | `HubSummary.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:HubSummary[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:HubSummary.toTableRow()`
- `backend/src/services/HubAnalyticsService.ts`
- `frontend/src/components/HubDashboard.tsx`

---

### 8. PLUGIN MANIFEST

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `name` | `$.bold` | `#FFFFFF` bold | — | Plugin name emphasis | `PluginManifest[Bun.inspect.custom]` |
| `isActive=true` | `$.green` dot | `#44FF44` | — | Active status | `PluginManifest[Bun.inspect.custom]` |
| `isActive=false` | `$.red` dot | `#FF4444` | — | Inactive status | `PluginManifest[Bun.inspect.custom]` |
| `category` | `$.cyan` | `#44FFFF` | 180°, 100%, 63% | Category label | `PluginManifest[Bun.inspect.custom]` |
| `miniapp.enabled` | `$.gold` | `#FFD700` | 51°, 100%, 50% | MiniApp indicator | `PluginManifest[Bun.inspect.custom]` |
| `hooks` | `$.dim` | `#888888` | — | Hook count | `PluginManifest[Bun.inspect.custom]` |
| `permissions.can_write_buckeye` | `$.red` | `#FF4444` | — | Write permission warning | `PluginManifest[Bun.inspect.custom]` |
| `cronSchedules` | `$.dim` | `#888888` | — | Cron count | `PluginManifest[Bun.inspect.custom]` |
| `Version` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Active` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Hooks` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Tools` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Cron` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `MiniApp` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Widget` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Write` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Telegram` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Players` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Limits` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `SQLite` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Domains` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Author` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Path` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Installed` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Last Run` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Exec Count` | — | — | — | Table only | `PluginManifest.toTableRow()` |
| `Avg Dur` | — | — | — | Table only | `PluginManifest.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:PluginManifest[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:PluginManifest.toTableRow()`
- `src/plugins/PluginLoader.ts`
- `src/plugins/PluginRegistry.ts`
- `frontend/src/components/PluginManager.tsx`
- `bun sportsterminal plugin list` CLI command

---

### 9. PLUGIN EXECUTION LOG

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `plugin_name` | `$.bold` | `#FFFFFF` bold | — | Plugin name emphasis | `PluginExecution[Bun.inspect.custom]` |
| `error` | `$.red` | `#FF4444` | — | Error highlight | `PluginExecution[Bun.inspect.custom]` |
| `success` | `$.green` check | `#44FF44` | — | Success indicator | `PluginExecution[Bun.inspect.custom]` |
| `risk_score_contribution` | `$.red` if >0.5, else `$.green` | varies | varies | Risk impact | `PluginExecution[Bun.inspect.custom]` |
| `duration_ms` | `$.dim` | `#888888` | — | Timing metadata | `PluginExecution[Bun.inspect.custom]` |
| `duration_ns` | `$.dim` | `#888888` | — | Nanosecond timing | `PluginExecution[Bun.inspect.custom]` |
| `trace_id` | `$.dim` | `#888888` | — | Trace reference | `PluginExecution[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Tool` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Trigger` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Agent` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Hub` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Level` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Cluster` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Target` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Risk +` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Confidence` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Summary` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Dur (ns)` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Status` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Error Msg` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Trace` | — | — | — | Table only | `PluginExecution.toTableRow()` |
| `Time` | — | — | — | Table only | `PluginExecution.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:PluginExecution[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:PluginExecution.toTableRow()`
- `src/plugins/PluginLoader.ts` (execution logging)
- `backend/src/services/PluginAuditService.ts`
- `Tests/risk-sharp-detector.test.ts` (assertions)

---

### 10. AI RISK FLAG

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `risk_level="CRITICAL"` | `$.bgRedWhite` | `#FF4444` bg | — | Critical badge | `AIRiskFlag[Bun.inspect.custom]` |
| `risk_level="HIGH"` | `$.red` | `#FF4444` | — | High level | `AIRiskFlag[Bun.inspect.custom]` |
| `risk_level="MEDIUM"` | `$.yellow` | `#FFFF44` | — | Medium level | `AIRiskFlag[Bun.inspect.custom]` |
| `risk_level="LOW"` | `$.green` | `#44FF44` | — | Low level | `AIRiskFlag[Bun.inspect.custom]` |
| `suggested_action` | `$.cyan` | `#44FFFF` | — | Action highlight | `AIRiskFlag[Bun.inspect.custom]` |
| `heuristic_fallback=true` | `$.yellow` | `#FFFF44` | — | Heuristic indicator | `AIRiskFlag[Bun.inspect.custom]` |
| `heuristic_fallback=false` | `$.magenta` | `#FF44FF` | — | AI indicator | `AIRiskFlag[Bun.inspect.custom]` |
| `aiConfidence` | `$.dim` | `#888888` | — | Confidence percentage | `AIRiskFlag[Bun.inspect.custom]` |
| `total_tokens` | `$.dim` | `#888888` | — | Token count | `AIRiskFlag[Bun.inspect.custom]` |
| `customer_id` | `$.bold` | `#FFFFFF` bold | — | Player emphasis | `AIRiskFlag[Bun.inspect.custom]` |
| `ai_summary` | `Bun.wrapAnsi()` | — | — | Long text wrapping | `AIRiskFlag[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Wager` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Action` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Source` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Model` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Confidence` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Prompt Tok` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Comp Tok` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Total Tok` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Latency` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Rule` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |
| `Time` | — | — | — | Table only | `AIRiskFlag.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:AIRiskFlag[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:AIRiskFlag.toTableRow()`
- `backend/scripts/batch-ai-analysis.ts`
- `backend/src/services/AIRiskService.ts`
- `frontend/src/components/AIRiskPanel.tsx`

---

### 11. AGENT ACTION (Rules Engine)

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `action="block"` | `$.red` | `#FF4444` | — | Block action | `AgentAction[Bun.inspect.custom]` |
| `action="suspend"` | `$.red` | `#FF4444` | — | Suspend action | `AgentAction[Bun.inspect.custom]` |
| `action="reduce"` | `$.yellow` | `#FFFF44` | — | Reduce action | `AgentAction[Bun.inspect.custom]` |
| `action="limit"` | `$.yellow` | `#FFFF44` | — | Limit action | `AgentAction[Bun.inspect.custom]` |
| `action="review"` | `$.orange` | `#FF8700` | — | Review action | `AgentAction[Bun.inspect.custom]` |
| `action="monitor"` | `$.green` | `#44FF44` | — | Monitor action | `AgentAction[Bun.inspect.custom]` |
| `rule_name` | `$.bold` | `#FFFFFF` bold | — | Rule emphasis | `AgentAction[Bun.inspect.custom]` |
| `is_executed` | `$.green` check / `$.dim` circle | varies | — | Execution status | `AgentAction[Bun.inspect.custom]` |
| `reason` | `$.dim` | `#888888` | — | Reason text | `AgentAction[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Rule ID` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Player` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Agent` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Hub` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Reason` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Trigger` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Trigger Val` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Executed` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Exec At` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Exec By` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Buckeye Log` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Telegram` | — | — | — | Table only | `AgentAction.toTableRow()` |
| `Time` | — | — | — | Table only | `AgentAction.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:AgentAction[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:AgentAction.toTableRow()`
- `backend/scripts/run-rules-engine.ts`
- `backend/src/services/RulesEngineService.ts`
- `frontend/src/components/AgentActionsPanel.tsx`

---

### 12. ENFORCEMENT QUEUE

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `status="completed"` | `$.green` | `#44FF44` | — | Completed | `EnforcementQueueItem[Bun.inspect.custom]` |
| `status="failed"` | `$.red` | `#FF4444` | — | Failed | `EnforcementQueueItem[Bun.inspect.custom]` |
| `status="processing"` | `$.yellow` | `#FFFF44` | — | Processing | `EnforcementQueueItem[Bun.inspect.custom]` |
| `status="cancelled"` | `$.dim` | `#888888` | — | Cancelled | `EnforcementQueueItem[Bun.inspect.custom]` |
| `status="pending"` | `$.orange` | `#FF8700` | — | Pending | `EnforcementQueueItem[Bun.inspect.custom]` |
| `action_type="BLOCK"` | `$.red` | `#FF4444` | — | Block action | `EnforcementQueueItem[Bun.inspect.custom]` |
| `action_type="SUSPEND"` | `$.red` | `#FF4444` | — | Suspend action | `EnforcementQueueItem[Bun.inspect.custom]` |
| `target_id` | `$.bold` | `#FFFFFF` bold | — | Target emphasis | `EnforcementQueueItem[Bun.inspect.custom]` |
| `retry_count` | `$.dim` | `#888888` | — | Retry counter | `EnforcementQueueItem[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Action` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Target` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Type` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Priority` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `AI Ref` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Buckeye` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Telegram` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Plugin` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Retries` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Error` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Created` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Executed` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |
| `Expires` | — | — | — | Table only | `EnforcementQueueItem.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:EnforcementQueueItem[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:EnforcementQueueItem.toTableRow()`
- `backend/src/services/EnforcementQueueService.ts`
- `backend/src/services/EnforcementWorker.ts`
- `frontend/src/components/EnforcementQueuePanel.tsx`

---

### 13. TELEGRAM ROUTE

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `is_default` | `$.gold` star | `#FFD700` | 51°, 100%, 50% | Default route marker | `TelegramRoute[Bun.inspect.custom]` |
| `plugin_name` | `$.cyan` | `#44FFFF` | 180°, 100%, 63% | Plugin reference | `TelegramRoute[Bun.inspect.custom]` |
| `delivery_rate` | `$.green` if >90%, else `$.yellow` | varies | varies | Delivery health | `TelegramRoute[Bun.inspect.custom]` |
| `topic_id` | — | — | — | Plain number | `TelegramRoute[Bun.inspect.custom]` |
| `agent_id` | — | — | — | Plain text | `TelegramRoute[Bun.inspect.custom]` |
| `Plugin` | — | — | — | Table only | `TelegramRoute.toTableRow()` |
| `Agent` | — | — | — | Table only | `TelegramRoute.toTableRow()` |
| `Purpose` | — | — | — | Table only | `TelegramRoute.toTableRow()` |
| `Topic` | — | — | — | Table only | `TelegramRoute.toTableRow()` |
| `Chat` | — | — | — | Table only | `TelegramRoute.toTableRow()` |
| `Chat Name` | — | — | — | Table only | `TelegramRoute.toTableRow()` |
| `Default` | — | — | — | Table only | `TelegramRoute.toTableRow()` |
| `Last Used` | — | — | — | Table only | `TelegramRoute.toTableRow()` |
| `Messages` | — | — | — | Table only | `TelegramRoute.toTableRow()` |
| `Delivery %` | — | — | — | Table only | `TelegramRoute.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:TelegramRoute[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:TelegramRoute.toTableRow()`
- `backend/src/services/TelegramRoutingService.ts`
- `plugins/alert-telegram-enhanced/index.ts`
- `frontend/src/components/TelegramConfigPanel.tsx`

---

### 14. BUCKEYE WRITE AUDIT

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `status="completed"` | `$.green` | `#44FF44` | — | Success | `BuckeyeWriteAudit[Bun.inspect.custom]` |
| `status="failed"` | `$.red` | `#FF4444` | — | Failure | `BuckeyeWriteAudit[Bun.inspect.custom]` |
| `status="rolled_back"` | `$.yellow` | `#FFFF44` | — | Rollback | `BuckeyeWriteAudit[Bun.inspect.custom]` |
| `operation` | `$.bold` | `#FFFFFF` bold | — | Operation emphasis | `BuckeyeWriteAudit[Bun.inspect.custom]` |
| `column` | `$.cyan` | `#44FFFF` | — | Column highlight | `BuckeyeWriteAudit[Bun.inspect.custom]` |
| `new_value` | `$.bold` | `#FFFFFF` bold | — | New value emphasis | `BuckeyeWriteAudit[Bun.inspect.custom]` |
| `payload_hash` | `$.dim` | `#888888` | — | Hash truncation | `BuckeyeWriteAudit[Bun.inspect.custom]` |
| `performed_by` | — | — | — | Plain text | `BuckeyeWriteAudit[Bun.inspect.custom]` |
| `error` | `$.red` | `#FF4444` | — | Error message | `BuckeyeWriteAudit[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Column` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Old Val` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `New Val` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Wager` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Customer` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `By` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `At` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Payload Hash` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Integrity` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Error Code` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Error` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `AI Ref` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Telegram` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Plugin` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Dur ms` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `HTTP` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |
| `Time` | — | — | — | Table only | `BuckeyeWriteAudit.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:BuckeyeWriteAudit[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:BuckeyeWriteAudit.toTableRow()`
- `src/utils/BuckeyeAuditWrapper.ts`
- `backend/src/services/BuckeyeWriteService.ts`
- `frontend/src/components/AuditLogPanel.tsx`

---

### 15. PLAYER TRANSACTION

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `type="DEPOSIT"` | `$.green` | `#44FF44` | — | Deposit inflow | `PlayerTransaction[Bun.inspect.custom]` |
| `type="BONUS"` | `$.green` | `#44FF44` | — | Bonus inflow | `PlayerTransaction[Bun.inspect.custom]` |
| `type="WITHDRAWAL"` | `$.red` | `#FF4444` | — | Withdrawal outflow | `PlayerTransaction[Bun.inspect.custom]` |
| `type="FEE"` | `$.red` | `#FF4444` | — | Fee outflow | `PlayerTransaction[Bun.inspect.custom]` |
| `type="ADJUSTMENT"` | `$.yellow` | `#FFFF44` | — | Adjustment neutral | `PlayerTransaction[Bun.inspect.custom]` |
| `amount` | `amtColor` | varies | varies | Directional color | `PlayerTransaction[Bun.inspect.custom]` |
| `status="COMPLETED"` | `$.green` | `#44FF44` | — | Completed | `PlayerTransaction[Bun.inspect.custom]` |
| `status="FAILED"` | `$.red` | `#FF4444` | — | Failed | `PlayerTransaction[Bun.inspect.custom]` |
| `fee_amount` | `$.red` | `#FF4444` | — | Fee deduction | `PlayerTransaction[Bun.inspect.custom]` |
| `method` | — | — | — | Plain text | `PlayerTransaction[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Currency` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Net` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Fee` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Method` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Detail` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Ref` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Description` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `IP` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Device` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Processed By` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Time` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |
| `Processed` | — | — | — | Table only | `PlayerTransaction.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:PlayerTransaction[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:PlayerTransaction.toTableRow()`
- `backend/src/services/TransactionService.ts`
- `backend/src/services/PlayerFinancialService.ts`
- `frontend/src/components/TransactionHistoryTab.tsx`

---

### 16. WAGER VIOLATION

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `severity="CRITICAL"` | `$.red` | `#FF4444` | — | Critical | `WagerViolation[Bun.inspect.custom]` |
| `severity="MAJOR"` | `$.yellow` | `#FFFF44` | — | Major | `WagerViolation[Bun.inspect.custom]` |
| `severity="MINOR"` | `$.orange` | `#FF8700` | — | Minor | `WagerViolation[Bun.inspect.custom]` |
| `rule_name` | `$.bold` | `#FFFFFF` bold | — | Rule emphasis | `WagerViolation[Bun.inspect.custom]` |
| `resolved` | `$.green` check | `#44FF44` | — | Resolved | `WagerViolation[Bun.inspect.custom]` |
| `unresolved` | `$.red` circle | `#FF4444` | — | Open | `WagerViolation[Bun.inspect.custom]` |
| `status="escalated"` | `$.bgRedWhite` | `#FF4444` bg | — | Escalated badge | `WagerViolation[Bun.inspect.custom]` |
| `details` | `$.dim` | `#888888` | — | Detail text | `WagerViolation[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Rule ID` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Category` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Wager` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Player` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Agent` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Details` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Status` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Detected` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Detected By` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Resolved` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Resolved By` | — | — | — | Table only | `WagerViolation.toTableRow()` |
| `Resolution` | — | — | — | Table only | `WagerViolation.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:WagerViolation[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:WagerViolation.toTableRow()`
- `backend/src/services/ViolationDetectionService.ts`
- `backend/src/services/RulesEngineService.ts`
- `frontend/src/components/ViolationsPanel.tsx`

---

### 17. PLAYER FLAG

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `flag_type="SHARP"` | `$.red` | `#FF4444` | — | Sharp flag | `PlayerFlag[Bun.inspect.custom]` |
| `flag_type="SYNDICATE"` | `$.magenta` | `#FF44FF` | — | Syndicate flag | `PlayerFlag[Bun.inspect.custom]` |
| `flag_type="BOT"` | `$.yellow` | `#FFFF44` | — | Bot flag | `PlayerFlag[Bun.inspect.custom]` |
| `flag_type="FRAUD"` | `$.bgRedWhite` | `#FF4444` bg | — | Fraud badge | `PlayerFlag[Bun.inspect.custom]` |
| `flag_type="MONEY_LAUNDERING"` | `$.bgRedWhite` | `#FF4444` bg | — | AML badge | `PlayerFlag[Bun.inspect.custom]` |
| `flag_type="ARBITRAGE"` | `$.orange` | `#FF8700` | — | Arbitrage flag | `PlayerFlag[Bun.inspect.custom]` |
| `flag_type="VIP"` | `$.gold` | `#FFD700` | — | VIP flag | `PlayerFlag[Bun.inspect.custom]` |
| `source="AI"` | `$.magenta` | `#FF44FF` | — | AI source | `PlayerFlag[Bun.inspect.custom]` |
| `source="MANUAL"` | `$.blue` | `#4444FF` | — | Manual source | `PlayerFlag[Bun.inspect.custom]` |
| `is_active` | `$.green` dot / `$.dim` circle | varies | — | Active status | `PlayerFlag[Bun.inspect.custom]` |
| `confidence` | `$.dim` | `#888888` | — | Confidence % | `PlayerFlag[Bun.inspect.custom]` |
| `customer_id` | `$.bold` | `#FFFFFF` bold | — | Player emphasis | `PlayerFlag[Bun.inspect.custom]` |
| `reason` | `$.dim` | `#888888` | — | Reason text | `PlayerFlag[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Flag` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Player` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Source` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Confidence` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Reason` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Evidence` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `By` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Active` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Created` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Updated` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Expires` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Resolved` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Resolved By` | — | — | — | Table only | `PlayerFlag.toTableRow()` |
| `Impact` | — | — | — | Table only | `PlayerFlag.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:PlayerFlag[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:PlayerFlag.toTableRow()`
- `backend/src/services/PlayerFlaggingService.ts`
- `backend/src/services/FlagManagementService.ts`
- `frontend/src/components/PlayerFlagsPanel.tsx`

---

### 18. SPORT EVENT

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `status="LIVE"` | `$.bgRedWhite` | `#FF4444` bg | — | Live event badge | `SportEvent[Bun.inspect.custom]` |
| `status="UPCOMING"` | `$.green` | `#44FF44` | — | Upcoming | `SportEvent[Bun.inspect.custom]` |
| `status="FINAL"` | `$.dim` | `#888888` | — | Final | `SportEvent[Bun.inspect.custom]` |
| `sport` | `$.orange` | `#FF8700` | — | Sport label | `SportEvent[Bun.inspect.custom]` |
| `home_team` | `$.bold` | `#FFFFFF` bold | — | Team emphasis | `SportEvent[Bun.inspect.custom]` |
| `away_team` | `$.bold` | `#FFFFFF` bold | — | Team emphasis | `SportEvent[Bun.inspect.custom]` |
| `score` | `$.bold` | `#FFFFFF` bold | — | Score emphasis | `SportEvent[Bun.inspect.custom]` |
| `period` | `$.yellow` | `#FFFF44` | — | Period highlight | `SportEvent[Bun.inspect.custom]` |
| `market_count` | `$.dim` | `#888888` | — | Count metadata | `SportEvent[Bun.inspect.custom]` |
| `volume` | `$.dim` | `#888888` | — | Volume metadata | `SportEvent[Bun.inspect.custom]` |
| `Event` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `League` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `Home` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `Away` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `Score` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `Period` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `Time` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `Venue` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `Broadcast` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `Markets` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `Volume` | — | — | — | Table only | `SportEvent.toTableRow()` |
| `Handle` | — | — | — | Table only | `SportEvent.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:SportEvent[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:SportEvent.toTableRow()`
- `backend/src/services/SportsbookService.ts`
- `backend/src/services/EventService.ts`
- `frontend/src/components/SportsbookTab.tsx`

---

### 19. MARKET

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `is_suspended` | `$.bgRedWhite` | `#FF4444` bg | — | Suspended badge | `Market[Bun.inspect.custom]` |
| `is_live` | `$.bgRedWhite` | `#FF4444` bg | — | Live badge | `Market[Bun.inspect.custom]` |
| `type` | `$.cyan` | `#44FFFF` | — | Market type | `Market[Bun.inspect.custom]` |
| `odds` | `$.green` | `#44FF44` | — | Odds value | `Market[Bun.inspect.custom]` |
| `odds_decimal` | `$.green` | `#44FF44` | — | Decimal odds | `Market[Bun.inspect.custom]` |
| `volume` | `$.dim` | `#888888` | — | Volume metadata | `Market[Bun.inspect.custom]` |
| `Market` | — | — | — | Table only | `Market.toTableRow()` |
| `Type` | — | — | — | Table only | `Market.toTableRow()` |
| `Subtype` | — | — | — | Table only | `Market.toTableRow()` |
| `Selection` | — | — | — | Table only | `Market.toTableRow()` |
| `Sel ID` | — | — | — | Table only | `Market.toTableRow()` |
| `Line` | — | — | — | Table only | `Market.toTableRow()` |
| `Spread` | — | — | — | Table only | `Market.toTableRow()` |
| `Total` | — | — | — | Table only | `Market.toTableRow()` |
| `O/U` | — | — | — | Table only | `Market.toTableRow()` |
| `Odds` | — | — | — | Table only | `Market.toTableRow()` |
| `American` | — | — | — | Table only | `Market.toTableRow()` |
| `Prob` | — | — | — | Table only | `Market.toTableRow()` |
| `Volume` | — | — | — | Table only | `Market.toTableRow()` |
| `Handle` | — | — | — | Table only | `Market.toTableRow()` |
| `Liability` | — | — | — | Table only | `Market.toTableRow()` |
| `Max Bet` | — | — | — | Table only | `Market.toTableRow()` |
| `Min Bet` | — | — | — | Table only | `Market.toTableRow()` |
| `Live` | — | — | — | Table only | `Market.toTableRow()` |
| `Suspended` | — | — | — | Table only | `Market.toTableRow()` |
| `Closed` | — | — | — | Table only | `Market.toTableRow()` |
| `Updated` | — | — | — | Table only | `Market.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:Market[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:Market.toTableRow()`
- `backend/src/services/MarketService.ts`
- `backend/src/services/OddsService.ts`
- `frontend/src/components/MarketDepthPanel.tsx`

---

### 20. HEALTH STATUS

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `status="HEALTHY"` | `$.bgGreenBlack` | `#44FF44` bg | — | Healthy badge | `HealthStatus[Bun.inspect.custom]` |
| `status="DEGRADED"` | `$.bgYellowBlack` | `#FFFF44` bg | — | Degraded badge | `HealthStatus[Bun.inspect.custom]` |
| `status="DOWN"` | `$.bgRedWhite` | `#FF4444` bg | — | Down badge | `HealthStatus[Bun.inspect.custom]` |
| `service` | `$.bold` | `#FFFFFF` bold | — | Service name | `HealthStatus[Bun.inspect.custom]` |
| `latency_ms` | `$.green` if <200, `$.yellow` if <1000, `$.red` if >1000 | varies | varies | Latency gradient | `HealthStatus[Bun.inspect.custom]` |
| `queue_depth` | `$.yellow` if >100, `$.red` if >500 | varies | varies | Queue warning | `HealthStatus[Bun.inspect.custom]` |
| `uptime_seconds` | `$.dim` | `#888888` | — | Uptime metadata | `HealthStatus[Bun.inspect.custom]` |
| `error` | `$.red` | `#FF4444` | — | Error message | `HealthStatus[Bun.inspect.custom]` |
| `Service` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Status` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Latency` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Version` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Uptime` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Req/min` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Err Rate` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `CPU %` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Memory` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Conns` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Queue` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Error` | — | — | — | Table only | `HealthStatus.toTableRow()` |
| `Checked` | — | — | — | Table only | `HealthStatus.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:HealthStatus[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:HealthStatus.toTableRow()`
- `backend/proxy-enhanced.ts` `/api/health` endpoint
- `backend/src/services/HealthCheckService.ts`
- `frontend/src/components/SystemHealthPanel.tsx`

---

### 21. WEBHOOK ALERT

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `status="sent"` | `$.green` | `#44FF44` | — | Sent | `WebhookAlert[Bun.inspect.custom]` |
| `status="failed"` | `$.red` | `#FF4444` | — | Failed | `WebhookAlert[Bun.inspect.custom]` |
| `status="retrying"` | `$.yellow` | `#FFFF44` | — | Retrying | `WebhookAlert[Bun.inspect.custom]` |
| `channel` | `$.cyan` | `#44FFFF` | — | Channel label | `WebhookAlert[Bun.inspect.custom]` |
| `attempts` | `$.bold` | `#FFFFFF` bold | — | Attempt count | `WebhookAlert[Bun.inspect.custom]` |
| `next_retry` | `$.dim` | `#888888` | — | Retry time | `WebhookAlert[Bun.inspect.custom]` |
| `payload_size` | `$.dim` | `#888888` | — | Size metadata | `WebhookAlert[Bun.inspect.custom]` |
| `last_error` | `$.red` | `#FF4444` | — | Error message | `WebhookAlert[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Event` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Status` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Attempts` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Next Retry` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Error Code` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Last Error` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `HTTP` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Payload` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Created` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Sent` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Delivered` | — | — | — | Table only | `WebhookAlert.toTableRow()` |
| `Acked` | — | — | — | Table only | `WebhookAlert.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:WebhookAlert[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:WebhookAlert.toTableRow()`
- `backend/src/services/WebhookDeliveryService.ts`
- `backend/src/services/AlertRetryQueue.ts`
- `frontend/src/components/WebhookLogPanel.tsx`

---

### 22. ARCHETYPE RESULT

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `archetype` | `$.bold` + `$.gold` | `#FFD700` bold | — | Archetype emphasis | `ArchetypeResult[Bun.inspect.custom]` |
| `confidence` | `$.cyan` | `#44FFFF` | — | Confidence % | `ArchetypeResult[Bun.inspect.custom]` |
| `dimensions.*` | `$.dim` | `#888888` | — | Dimension labels | `ArchetypeResult[Bun.inspect.custom]` |
| `archetype_group` | `$.dim` | `#888888` | — | Group label | `ArchetypeResult[Bun.inspect.custom]` |
| `wager_count` | — | — | — | Plain number | `ArchetypeResult[Bun.inspect.custom]` |
| `days_active` | — | — | — | Plain number | `ArchetypeResult[Bun.inspect.custom]` |
| `Player` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Archetype` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Group` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Confidence` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Wagers` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Days Active` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Avg Daily` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Peak Day` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Volume` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Stake` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Win Rate` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Recency` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Diversity` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Consistency` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Fav Sport` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Fav Market` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Deposit Pat` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Withdraw Pat` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Session Min` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |
| `Calculated` | — | — | — | Table only | `ArchetypeResult.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:ArchetypeResult[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:ArchetypeResult.toTableRow()`
- `backend/scripts/generate-archetypes.ts`
- `backend/src/services/ArchetypeService.ts`
- `frontend/src/components/ArchetypePanel.tsx`

---

### 23. PLAYER NOTE

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `category="RISK"` | `$.red` | `#FF4444` | — | Risk note | `PlayerNote[Bun.inspect.custom]` |
| `category="FRAUD"` | `$.red` | `#FF4444` | — | Fraud note | `PlayerNote[Bun.inspect.custom]` |
| `category="VIP"` | `$.gold` | `#FFD700` | — | VIP note | `PlayerNote[Bun.inspect.custom]` |
| `category="COMPLAINT"` | `$.yellow` | `#FFFF44` | — | Complaint note | `PlayerNote[Bun.inspect.custom]` |
| `category="ARBITRAGE"` | `$.orange` | `#FF8700` | — | Arbitrage note | `PlayerNote[Bun.inspect.custom]` |
| `category="BEHAVIOR"` | `$.dim` | `#888888` | — | Behavior note | `PlayerNote[Bun.inspect.custom]` |
| `category="GENERAL"` | `$.dim` | `#888888` | — | General note | `PlayerNote[Bun.inspect.custom]` |
| `is_private` | `$.red` lock | `#FF4444` | — | Private indicator | `PlayerNote[Bun.inspect.custom]` |
| `customer_id` | `$.bold` | `#FFFFFF` bold | — | Player emphasis | `PlayerNote[Bun.inspect.custom]` |
| `agent_id` | `$.dim` | `#888888` | — | Author metadata | `PlayerNote[Bun.inspect.custom]` |
| `note` | `Bun.wrapAnsi()` | — | — | Long text wrapping | `PlayerNote[Bun.inspect.custom]` |
| `tags` | `$.dim` | `#888888` | — | Tag list | `PlayerNote[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `PlayerNote.toTableRow()` |
| `Player` | — | — | — | Table only | `PlayerNote.toTableRow()` |
| `Priority` | — | — | — | Table only | `PlayerNote.toTableRow()` |
| `Note` | — | — | — | Table only | `PlayerNote.toTableRow()` |
| `By` | — | — | — | Table only | `PlayerNote.toTableRow()` |
| `Private` | — | — | — | Table only | `PlayerNote.toTableRow()` |
| `Tags` | — | — | — | Table only | `PlayerNote.toTableRow()` |
| `Time` | — | — | — | Table only | `PlayerNote.toTableRow()` |
| `Updated` | — | — | — | Table only | `PlayerNote.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:PlayerNote[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:PlayerNote.toTableRow()`
- `backend/src/services/PlayerNoteService.ts`
- `frontend/src/components/PlayerNotesPanel.tsx`

---

### 24. PLUGIN CRON JOB

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `is_active` | `$.green` dot / `$.dim` circle | varies | — | Active status | `PluginCronJob[Bun.inspect.custom]` |
| `plugin_name` | `$.bold` | `#FFFFFF` bold | — | Plugin name | `PluginCronJob[Bun.inspect.custom]` |
| `schedule` | `$.cyan` | `#44FFFF` | — | Cron expression | `PluginCronJob[Bun.inspect.custom]` |
| `script_path` | — | — | — | Path text | `PluginCronJob[Bun.inspect.custom]` |
| `run_count` | `$.dim` | `#888888` | — | Run count | `PluginCronJob[Bun.inspect.custom]` |
| `last_error` | `$.red` | `#FF4444` | — | Error indicator | `PluginCronJob[Bun.inspect.custom]` |
| `next_run` | `$.dim` | `#888888` | — | Next run time | `PluginCronJob[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `PluginCronJob.toTableRow()` |
| `Plugin` | — | — | — | Table only | `PluginCronJob.toTableRow()` |
| `Schedule` | — | — | — | Table only | `PluginCronJob.toTableRow()` |
| `Script` | — | — | — | Table only | `PluginCronJob.toTableRow()` |
| `Active` | — | — | — | Table only | `PluginCronJob.toTableRow()` |
| `Last Run` | — | — | — | Table only | `PluginCronJob.toTableRow()` |
| `Next Run` | — | — | — | Table only | `PluginCronJob.toTableRow()` |
| `Stagger` | — | — | — | Table only | `PluginCronJob.toTableRow()` |
| `Runs` | — | — | — | Table only | `PluginCronJob.toTableRow()` |
| `Avg Dur` | — | — | — | Table only | `PluginCronJob.toTableRow()` |
| `Error` | — | — | — | Table only | `PluginCronJob.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:PluginCronJob[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:PluginCronJob.toTableRow()`
- `src/plugins/PluginCronRegistry.ts`
- `backend/src/services/CronSchedulerService.ts`
- `frontend/src/components/CronJobPanel.tsx`

---

### 25. REQUEST LOG

| Property | Color Token | Hex | HSL | Color Reason | Code Location |
|----------|-------------|-----|-----|--------------|---------------|
| `status>=500` | `$.red` | `#FF4444` | — | Server error | `RequestLog[Bun.inspect.custom]` |
| `status>=400` | `$.yellow` | `#FFFF44` | — | Client error | `RequestLog[Bun.inspect.custom]` |
| `status>=200` | `$.green` | `#44FF44` | — | Success | `RequestLog[Bun.inspect.custom]` |
| `endpoint` | `$.bold` | `#FFFFFF` bold | — | Endpoint emphasis | `RequestLog[Bun.inspect.custom]` |
| `duration_ms` | `$.green` if <200, `$.yellow` if <1000, `$.red` if >1000 | varies | varies | Latency gradient | `RequestLog[Bun.inspect.custom]` |
| `source` | `$.dim` | `#888888` | — | Source label | `RequestLog[Bun.inspect.custom]` |
| `error` | `$.red` | `#FF4444` | — | Error message | `RequestLog[Bun.inspect.custom]` |
| `ID` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Method` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Endpoint` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Status` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Duration` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Dur (ns)` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Source` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Agent` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Customer` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Trace` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Req Size` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Res Size` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Error` | — | — | — | Table only | `RequestLog.toTableRow()` |
| `Time` | — | — | — | Table only | `RequestLog.toTableRow()` |

**Code Instances:**
- `src/types/inspectable-all.ts:RequestLog[Bun.inspect.custom]`
- `src/types/inspectable-all.ts:RequestLog.toTableRow()`
- `backend/proxy-enhanced.ts` (request logging)
- `backend/src/services/RequestLogService.ts`
- `frontend/src/components/RequestLogPanel.tsx`

---

## Color Function Map

| Function | Logic | Used By |
|----------|-------|---------|
| `tierColor()` | BLACK→red, RED→yellow, YELLOW→orange, GREEN→green, BLUE→blue, GREY→dim | Wager, Player, HubSummary |
| `severityColor()` | CRITICAL→bgRedWhite, HIGH→red, MEDIUM→yellow, LOW→green, INFO→blue | RiskAlert, WagerViolation |
| `pnlColor()` | >0→green, <0→red, 0→dim | Position, HubSummary |
| `scoreBar()` | >0.75→red bar, >0.5→yellow bar, else→green bar | RiskScore.inspectDetailed() |
| `statusColor` (Wager) | WON→green, LOST→red, PENDING→yellow, else→dim | Wager |
| `actionColor` (AgentAction) | block/suspend→red, reduce/limit→yellow, review→orange, monitor→green | AgentAction |
| `statusColor` (Plugin) | active→green dot, inactive→red dot | PluginManifest |

---

## File Locations Summary

| File | Contains |
|------|----------|
| `src/types/inspectable-all.ts` | All 25 domain classes with `[Bun.inspect.custom]` and `toTableRow()` |
| `src/utils/enhanced-logger.ts` | Logger that auto-detects arrays → `Bun.inspect.table()` |
| `src/utils/cli-formatter.ts` | `renderTable()`, `renderCompact()`, `renderCards()`, `renderSummaryStats()` |
| `backend/proxy-enhanced.ts` | Wager, RequestLog, HealthStatus instantiation |
| `backend/src/services/` | All service-layer object creation |
| `frontend/src/components/` | UI components consuming these objects |
| `Tests/*.test.ts` | Test assertions on inspect output |
