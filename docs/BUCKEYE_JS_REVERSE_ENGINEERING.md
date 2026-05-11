# Buckeye Manager.js Reverse Engineering — May 11, 2026

> Source: `https://fantasy402.com/app/manager/manager.js?bust=1.0.188`
> Analysis date: 2026-05-11
> Method: Static analysis of minified/obfuscated jQuery/RequireJS SPA

---

## 1. Operations Matrix: JS vs Local Documentation

### 1.1 Operations Found in JS (24 total)

| # | Operation | Type | Found In JS | In Local Docs | Local Doc Location | Gap |
|---|-----------|------|-------------|---------------|-------------------|-----|
| 1 | `authenticateCustomer` | Auth | ❌ (not in this file) | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | — |
| 2 | `renewToken` | Auth | ❌ (not in this file) | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | — |
| 3 | `getAccountInfoOwner` | Read | ✅ Line ~1550 | ✅ | `BUCKEYE_BACKEND_SCOPE.md`, `PLAYER_360_DATA_MAP.md` | Aligned |
| 4 | `getAddedInfo` | Read | ✅ Line ~1310 | ❌ | — | **MISSING** — Telegram/notify settings |
| 5 | `getAuthorizations` | Read | ✅ Line ~850 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 6 | `getCommunicationMessages` | Read | ✅ Line ~1680 | ❌ | — | **MISSING** — Pop-up/stamp messages |
| 7 | `getConfigWebReports` | Read | ✅ Line ~1100 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 8 | `getConfigWebReportsPending` | Read | ✅ Line ~1130 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 9 | `getHeriarchy` | Read | ✅ Line ~1050 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` (as `getHeriarchy`) | Aligned |
| 10 | `getLineTypes` | Read | ✅ Line ~1830 | ❌ | — | **MISSING** — Sport line type dropdown |
| 11 | `getListAgenstByAgent` | Read | ✅ Line ~1080 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned (typo preserved) |
| 12 | `getMasterSheet` | Read | ✅ Line ~950 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 13 | `getMessage` | Read | ✅ Line ~1650 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 14 | `getNewEmailsCount` | Read | ✅ Line ~1620 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 15 | `getPlayers` | Read | ✅ Line ~1060 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 16 | `getReportPlayerAnalysis` | Read | ✅ Line ~1820 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 17 | `getScoresLiveDynamic` | Read | ✅ Line ~1200 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 18 | `getSportsType` | Read | ✅ Line ~1090 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 19 | `getWeeklyFigureByAgentLite` | Read | ✅ Line ~1400 | ✅ | `BUCKEYE_BACKEND_SCOPE.md` | Aligned |
| 20 | `changePassword` | Write | ✅ Line ~1500 | ❌ | — | **MISSING** — Password change |
| 21 | `mailAgentUpdate` | Write | ✅ Line ~1670 | ❌ | — | **MISSING** — Mark message read |
| 22 | `saveNotifyAgent` | Write | ✅ Line ~1320 | ❌ | — | **MISSING** — Save Telegram/notify settings |
| 23 | `searchCustomerAdmin` | Read | ✅ Line ~1000 | ❌ | — | **MISSING** — Customer search |
| 24 | `sendFeedback` | Write | ✅ Line ~1700 | ❌ | — | **MISSING** — Feedback message |
| 25 | `updateBasicSettings` | Write | ✅ Line ~1450 | ❌ | — | **MISSING** — Update lang/timezone/menu |
| 26 | `updateDistribution` | Write | ✅ Line ~1420 | ❌ | — | **MISSING** — Update makeup/distribution |

### 1.2 Operations in Local Docs But NOT in JS

| Operation | Local Doc | Notes |
|-----------|-----------|-------|
| `getBetTicker` | `BUCKEYE_BACKEND_SCOPE.md` | Likely in a separate module file |
| `getBetTickerConfig` | `BUCKEYE_BACKEND_SCOPE.md` | Likely in a separate module file |
| `getWebLog` | `BUCKEYE_BACKEND_SCOPE.md` | Likely in a separate module file |
| `getAgentPerformance` | `BUCKEYE_BACKEND_SCOPE.md` | Likely in a separate module file |
| `getPerformancePlayer` | `PLAYER_360_DATA_MAP.md` | Likely in a separate module file |
| `getTransactionList` | `PLAYER_360_DATA_MAP.md` | Likely in a separate module file |
| `getTransactionHistory` | `PLAYER_360_DATA_MAP.md` | Likely in a separate module file |
| `getReportDeletedTransactions` | `PLAYER_360_DATA_MAP.md` | Likely in a separate module file |
| `getInfoPlayer` | `PLAYER_360_DATA_MAP.md` | Likely in a separate module file |
| `getTeaserProfile` | `PLAYER_360_DATA_MAP.md` | Likely in a separate module file |
| `updateReportConfigPending` | `BUCKEYE_BACKEND_SCOPE.md` | Likely in a separate module file |

**Assessment:** The JS file analyzed is the main `manager.js` shell. Feature-specific operations (betticker, transactions, player info, etc.) are loaded dynamically via RequireJS from `manager/module/*` files. This is expected and not a documentation gap.

---

## 2. Authorization Flags (Complete Matrix)

Found in `setAuthorizations()` at line ~850. These are returned by `getAuthorizations` in `a.INFO`.

| Flag | Values | UI Effect When Restricted |
|------|--------|---------------------------|
| `AllowPlaceBet` | `Y`/`N` | Removes "Lines" menu if `N` AND `AllowPlaceLateWagers` is `N` |
| `AllowPlaceLateWagers` | `Y`/`N` | Paired with `AllowPlaceBet` for lines menu |
| `AddNewAccountFlag` | `Y`/`N` | Removes "Add Account" menu if `N` |
| `AllowDeletedWagersReport` | `Y`/`N` | Removes "Delete Wager" menu if `N` |
| `EnterTransactionFlag` | `Y`/`N` | Removes "Transactions" menu if `N` |
| `DenyIpChecker` | `Y`/`N` | Removes "IP Tracker" menu if `Y` |
| `DenyEmail` | `Y`/`N` | Removes "Messaging" menu + stats cards if `Y` |
| `DenyGameAdmin` | `Y`/`N` | Removes "Game Admin" menu if `Y` |
| `DenyBetTicker` | `Y`/`N` | Removes "Bet Ticker" menu if `Y` |
| `DenyAgentBilling` | `Y`/`N` | Removes "Agent Billing" menu if `Y` |
| `DenyAgentPerformance` | `Y`/`N` | Removes "Agent Performance" menu if `Y` |
| `DenySettings` | `Y`/`N` | Removes settings gear if `Y` |
| `DenyContactUs` | `Y`/`N` | Removes "Contact" menu if `Y` |
| `AllowSetLiveBettingLimits` | `Y`/`N` | Removes "Live Betting Limits" menu if not `Y` |
| `AllowSetVirtualBetLimits` | `Y`/`N` | Part of live betting new menu gate |
| `AllowAdjExtProps` | `Y`/`N` | Part of live betting new menu gate |
| `AllowEditLCasinoLimits` | `Y`/`N` | Part of live betting new menu gate |
| `PokerOnly` | `Y`/`N` | Strips ALL menus except transaction history + home + signout |
| `ReadOnlyFlag` | `Y`/`N` | Switches to read-only mode, disables most actions |
| `Active` | `Y`/`N` | `N` = account disabled, shows lockout screen |
| `ForceReset` | `Y`/`N` | `Y` = forces password change modal on login |
| `CommissionType` | `S`/`?` | `S` hides accounting history + distribution |
| `NotifyVipBets` | `Y`/`N` | VIP bet notification setting |
| `MasterAgentID` | string | Used for hierarchy root context |

### 2.1 Third-Party Module Permissions

These control the `executeThirdPartyOption()` modules:

| Module | Flag | Index |
|--------|------|-------|
| Dynamic Live | `AllowSetLiveBettingLimits` | 0 |
| Crash | `AllowSetVirtualBetLimits` | 1 |
| Extended Props | `AllowAdjExtProps` | 2 |
| Live Casino | `AllowEditLCasinoLimits` | 3 |

---

## 3. Account Info Fields

Found in `getAccountInfo()` / `setAccountInfo()` and `settings()` functions.

| Field | Type | Usage |
|-------|------|-------|
| `Login` | string | Display name, header |
| `AgentType` | `M`/`A` | Master vs Agent |
| `AgentMenuStyle` | `Tile Menu` / `Left Menu` | UI layout mode |
| `Language` | string | UI language |
| `TimeZone` | number | Offset for score times |
| `CurrencyCode` | string | For `$` formatting |
| `CurrentBalance` | cents | Displayed as dollars/100 |
| `Active` | `Y`/`N` | Account enabled |
| `ReadOnlyFlag` | `Y`/`N` | Read-only mode |
| `ForceReset` | `Y`/`N` | Force password change |
| `Office` | string | Office ID |
| `customerID` | string | Internal ID (same as agent ID) |
| `CryptoCashierType` | string | Cashier type for crypto |
| `AppsCryptoCashierType` | string | App cashier type |
| `ezliveID` | string | `buck2` = system 2 |
| `email` | string | Contact email |
| `Password` | string | **Stored in plaintext in sessionStorage** |
| `preferenceDate` | array | Message preference dates |
| `DefaultSiteSkin` | string | Skin/theme |
| `ShowHowManyWeeks` | number | Max week filter range |
| `CommentsForCustomer` | string | Pop-up message text |

---

## 4. Hierarchy Engine

### 4.1 Data Structure

```js
// Flat list from API (getListAgenstByAgent / getHeriarchy)
{
  AgentID: "BILLY667  ",
  SeqNumber: 5735,
  Level: 1,
  AgentType: "A",  // A = Agent, M = Master
  Login: "BILLY667  ",
  MasterAgentID: "ROOT      "  // Parent
}

// Tree node (built by baseHeriarchy/buildTree)
{
  AgentID: "BILLY667",
  AgentType: "A",
  Login: "BILLY667",
  Master: "ROOT",
  masterLogin: "ROOT",
  children: []
}
```

### 4.2 Engine Components

| Function | Purpose |
|----------|---------|
| `baseHeriarchy(data)` | Builds nested object from flat list, 12 levels deep |
| `buildTree(list, result, parentId, depth)` | Recursive tree builder, max depth 13 |
| `findInTree(list, master)` | Finds children of a given master |
| `getAgentCountChildren({list, search})` | Counts direct children |
| `getAgentHeriarchy({list})` | Builds tree for Bootstrap Treeview |
| `getAgentHeriarchyForTree({list})` | Builds tree with tags/counts |
| `searchCompleteHeriarchy({agent, level, li, ...})` | Lazy-loads on tree expand |
| `setHeriarchyComponent({content})` | Renders tree UI |
| `setHeriarchyComponentGotham({agentID})` | Gotham skin variant |

### 4.3 Key Behaviors

- **12 levels** explicitly handled in `baseHeriarchy()` (Level 1-12)
- **Max depth 13** in `buildTree()` (guard against infinite recursion)
- **Lazy loading**: `searchCompleteHeriarchy()` loads on click, not all at once
- **Player attachment**: Agents (`AgentType: "A"`) can have `players[]` array
- **Checkbox bulk ops**: Tree nodes have checkboxes for bulk operations
- **Concat separator**: `n.concat.PARAM` used for hierarchy path keys

---

## 5. Response Shape Patterns

### 5.1 Common Envelopes

| Pattern | Source | Shape |
|---------|--------|-------|
| LIST | Most read ops | `{ LIST: [...] }` |
| INFO | Auth, config | `{ INFO: {...} }` |
| Data | Some reports | `{ Data: [...] }` |
| ARRAY | Weekly figures | `{ LIST: { ARRAY: [...] } }` |
| GENERAL | Hierarchy | `{ GENERAL: [...], PLAYERS: [...], EXTRA: {...} }` |
| Scores | Live scores | `{ Scores: [...] }` |
| COMMENT | Messages | `{ COMMENT: [...], LIST: [...] }` |

### 5.2 Error/Status Patterns

| Pattern | Meaning |
|---------|---------|
| `n.INFO === false` | Empty/no data |
| `e.LIST.length > 0` | Has results |
| `t.Active === -1` | No access/permission denied |
| `t.Active === null` | No data for period |
| `e.Type` (1-4) | `saveNotifyAgent` error codes |

---

## 6. Search/Customer Discovery

### 6.1 `searchCustomerAdmin`

**Request:**
```js
{
  agentID: this.ID,
  filter: searchText,
  operation: "searchCustomerAdmin",
  RRO: n.RRO
}
```

**Response:**
```js
{
  LIST: [
    {
      CustomerID: "CUST001",
      Login: "CUST001",
      Criterio: "ID|PW|Name",  // match type
      info: {
        Password: "pass123",
        NameFirst: "John"
      }
    }
  ]
}
```

**Features:**
- Searches by ID, password, or name
- Returns `Password` and `NameFirst` in clear text
- Used for the header search dropdown

---

## 7. Write Operations Detail

### 7.1 `updateDistribution`

```js
{
  agentID: targetAgent,
  distribution: value * 100,  // stored as cents/integer
  login: masterID,
  operation: "updateDistribution"
}
```

### 7.2 `updateBasicSettings`

```js
{
  language: "English",
  timezone: -5,
  menu: "Tile Menu",
  notifyFlag: "Y",
  agentID: this.ID,
  operation: "updateBasicSettings"
}
```

### 7.3 `saveNotifyAgent`

```js
{
  telegramID: "12345,67890",
  email: "agent@example.com",
  minimum: 100,  // MaxAmountNotifyTelegram
  customerID: this.ID,
  operation: "saveNotifyAgent"
}
```

Validation:
- Telegram ID: comma-separated, min 5 chars each, no duplicates
- Error types: 1=invalid format, 2=min length, 3=duplicates, 4=already used

### 7.4 `changePassword`

```js
{
  customerID: this.ID,
  pass: newPassword,
  operation: "changePassword"
}
```

**Security note:** Current password is available in `this.accountInfo.Password` (plaintext).

---

## 8. Missing from Local Docs (Action Items)

| # | Finding | Priority | Suggested Action |
|---|---------|----------|------------------|
| 1 | `getAddedInfo` operation | Medium | Add to `BUCKEYE_BACKEND_SCOPE.md` — returns Telegram ID, email, MaxAmountNotifyTelegram |
| 2 | `getCommunicationMessages` | Medium | Add to `BUCKEYE_BACKEND_SCOPE.md` — returns pop-ups, stamp messages, preferences |
| 3 | `getLineTypes` | Low | Add to `BUCKEYE_BACKEND_SCOPE.md` — sport line type dropdown |
| 4 | `searchCustomerAdmin` | High | Add to `BUCKEYE_BACKEND_SCOPE.md` — customer search with password exposure |
| 5 | `changePassword` | Medium | Add to `BUCKEYE_BACKEND_SCOPE.md` — password change endpoint |
| 6 | `mailAgentUpdate` | Low | Add to `BUCKEYE_BACKEND_SCOPE.md` — mark message as read |
| 7 | `saveNotifyAgent` | Medium | Add to `BUCKEYE_BACKEND_SCOPE.md` — Telegram/notification settings |
| 8 | `sendFeedback` | Low | Add to `BUCKEYE_BACKEND_SCOPE.md` — feedback message |
| 9 | `updateBasicSettings` | Medium | Add to `BUCKEYE_BACKEND_SCOPE.md` — lang/timezone/menu/notify |
| 10 | `updateDistribution` | Medium | Add to `BUCKEYE_BACKEND_SCOPE.md` — makeup/distribution update |
| 11 | Complete authorization flags | High | Update `BUCKEYE_BACKEND_SCOPE.md` with all 20+ flags |
| 12 | Hierarchy engine details | Medium | Document 12-level tree, lazy loading, max depth 13 |
| 13 | Account info field map | Medium | Document all `accountInfo` fields from JS |
| 14 | Third-party module permissions | Low | Document dynamic live/crash/props/casino flags |

---

## 9. Local Documentation Quality Assessment

### 9.1 Current Docs Inventory

| Document | Status | Assessment |
|----------|--------|------------|
| `BUCKEYE_BACKEND_SCOPE.md` | ✅ Good | Covers most read ops, auth, vault. Missing 10 write ops and some read ops. |
| `API_ENDPOINTS.md` | ✅ Good | Comprehensive backend API reference. Well maintained. |
| `BUCKEYE_MANUAL_FINDINGS.md` | ✅ Good | Product context from PDFs. Accurate. |
| `DATA_DICTIONARY.md` | ✅ Good | Env vars, vault keys, DB shapes. Current. |
| `PLAYER_360_DATA_MAP.md` | ✅ Good | Player 360 contract. Detailed and accurate. |
| `IMPLEMENTATION_TRACKER.md` | ✅ Good | Progress tracking. Current as of 2026-05-10. |
| `PATTERN_CATALOG.md` | ⚠️ Not reviewed | — |
| `AUDIT_ANALYTICS_ENGINE.md` | ⚠️ Not reviewed | — |
| `INTEGRITY_ANALYTICS_RESEARCH.md` | ⚠️ Not reviewed | — |
| `CHANGELOG.md` | ⚠️ Not reviewed | — |
| `CODE_QUALITY_CHECKLIST.md` | ⚠️ Not reviewed | — |
| `ENTERPRISE_TAB_GOALS.md` | ⚠️ Not reviewed | — |
| `PROJECT_ORGANIZATION.md` | ⚠️ Not reviewed | — |
| `API_REFERENCE.html` | ⚠️ Not reviewed | Interactive reference, may be generated |
| `agentobject.md` | ❌ Legacy | Raw agent export sample. Referenced in `BUCKEYE_BACKEND_SCOPE.md` as "ignored seed exports". Should be archived. |
| `agentslistharz.md` | ❌ Legacy | Appears to be corrupted/incomplete. Should be archived. |

### 9.2 Recommended Archives

| File | Reason | Destination |
|------|--------|-------------|
| `docs/agentobject.md` | Raw export sample, superseded by DB schema docs | `docs/archive/legacy/` |
| `docs/agentslistharz.md` | Corrupted/incomplete content | `docs/archive/legacy/` |
| `docs/archive/legacy/DEVELOPMENT_ROADMAP_2026-05-08.md` | Already archived, verify if still relevant | Keep in archive |

### 9.3 Docs Needing Updates

| Document | Updates Needed |
|----------|---------------|
| `BUCKEYE_BACKEND_SCOPE.md` | Add missing operations (§8), complete authorization flags, hierarchy engine details |
| `DATA_DICTIONARY.md` | Add new Buckeye operation params from JS findings |

---

## 10. Security Findings from JS

| Finding | Risk | Location |
|---------|------|----------|
| Password stored in `sessionStorage` | High | `verifySession()` — `sessionStorage.customerID` |
| Password in `accountInfo.Password` plaintext | High | Used for `changePasswordCurrent()` validation |
| `searchCustomerAdmin` returns passwords | High | Response includes `info.Password` |
| `cf_clearance` cookie required but manual | Medium | User must copy from DevTools |
| `RRO=1` anti-cache param is static | Low | Easy to fingerprint |
| No CSRF tokens on AJAX | Medium | All POSTs are operation-based but no CSRF |
| `__cf_bm` cookie sometimes included | Low | Cloudflare bot management |

---

## 11. Module Loading Pattern

The manager uses RequireJS for dynamic module loading:

```js
require(["manager/module/player-info"], function(PlayerInfo) {
  new PlayerInfo().get({ player: customerID });
});
```

**Known modules referenced:**
- `manager/module/player-info` — Player profile modal
- `manager/module/agent-management-thin` — Agent accounting/history
- `manager/module/add-customer` — Add new account
- `manager/module/cashier` — Cashier interface
- `manager/module/bet-ticker` — Live wager feed
- `manager/module/customer-admin/dynamic-live` — Live betting limits
- `manager/module/customer-admin/crash` — Crash game limits
- `manager/module/customer-admin/extended-props` — Extended props limits
- `manager/module/customer-admin/live-casino` — Live casino limits

**Note:** These modules are loaded from separate JS files, not in the main `manager.js`. Their operations are NOT visible in this analysis.

---

## 12. Proxy Discovery Results (May 11, 2026)

The enhanced proxy (`localhost:3001`) was probed for accessible endpoints. Results:

### 12.1 Accessible Endpoints (7 discovered via deep scan)

| Endpoint | Type | In JS | In endpoint-index.ts | Notes |
|----------|------|-------|---------------------|-------|
| `Manager/getAgentPerformance` | Read | ❌ | ✅ | Performance report |
| `Manager/getBetTicker` | Read | ❌ | ✅ | Live wager feed |
| `Manager/getPerformancePlayer` | Read | ❌ | ✅ | Player-specific performance |
| `Manager/getPlayerDetails` | Read | ❌ | ❌ | **NEW** — Player detail lookup |
| `Manager/getPlayerLimits` | Read | ❌ | ❌ | **NEW** — Player wager limits |
| `Manager/setPlayerLimits` | Write | ❌ | ❌ | **NEW** — Set player limits |
| `Manager/updatePlayerStatus` | Write | ❌ | ❌ | **NEW** — Update player status |

### 12.2 Proxy Catalog Summary

| Metric | Count |
|--------|-------|
| Proxy local endpoints | 19 |
| Buckeye upstream endpoints | 49 |
| Total tested | 50 |
| Passed | 50 |
| Failed | 0 |
| Available | 48 |
| Unavailable | 1 (`Manager/getWebLog` — returns 404) |

### 12.3 Endpoint Map Aliases (49 total)

The proxy exposes friendly aliases for Buckeye operations:

| Alias | Buckeye Operation |
|-------|-------------------|
| `agentDownline` | `Manager/getListAgenstByAgent` |
| `agentPerformance` | `Manager/getAgentPerformance` |
| `agentBilling` | `Manager/getAgentBilling` |
| `agentManagement` | `Manager/getAgentManagement` |
| `playerInfo` | `Manager/getInfoPlayer` |
| `bettorDetails` | `Manager/getReportPlayerAnalysis` |
| `transactionPlayer` | `Manager/getEnterTransactions` |
| `historyPlayer` | `Manager/getEnterTransactions` |
| `playerActivity` | `System/getPlayerActivity` |
| `playerWeek` | `Manager/getWeeklyFigureByAgentLite` |
| `wagerByPlayer` | `Manager/getReportPlayerAnalysis` |
| `liveGame` | `Manager/getDynamicLive` |
| `pending` | `Manager/getPending` |
| `openBets` | `Manager/getOpenBets` |
| `betTicker` | `Manager/getBetTicker` |
| `betTickerConfig` | `Manager/getBetTickerConfig` |
| `sportsLeagues` | `League/Get_SportsLeagues` |
| `leagueLines` | `Lines/Get_LeagueLines2` |
| `dynamicLive` | `Manager/getDynamicLive` |
| `gameVolume` | `Manager/getGameVolume` |
| `scoresLive` | `Report/getScoresLiveDynamic` |
| `props` | `Manager/getProps` |
| `extendedProps` | `Manager/getExtendedProps` |
| `teaserProfile` | `Manager/getTeaserProfile` |
| `sportsType` | `Manager/getSportsType` |
| `sportsTypesLive` | `Manager/getSportsTypesLive` |
| `sportsAdmin` | `Manager/getSportsCustomerAdmin` |
| `vigSetup` | `Manager/getSportsVigSetup` |
| `maxWager` | `Manager/getSportsMaxWager` |
| `buyPoints` | `Lines/getBuyPointsGroup` |
| `amountLimits` | `Limit/getAmountLimitGroup` |
| `periodsBySport` | `Manager/getPeriodsBySport` |
| `linesPlus` | `Provider/getLinesPlusData` |
| `propBuilderURL` | `Provider/getPropBuilderGameScheduleURL` |
| `circleLimits` | `Manager/getCircleLimits` |
| `colors` | `Manager/getColorsSelections` |
| `stores` | `Manager/getStores` |
| `listVip` | `Manager/getListVip` |
| `cryptoInfo` | `Manager/getCryptoInfo` |
| `cryptoAvailable` | `Manager/getCryptoAvailable` |
| `mail` | `Manager/getMail` |
| `newEmails` | `Manager/getNewEmailsCount` |
| `getMessage` | `Manager/getMessage` |
| `authorizations` | `Manager/getAuthorizations` |
| `accountInfo` | `Manager/getAccountInfoOwner` |
| `getConfigWebReports` | `Manager/getConfigWebReports` |
| `pendingReportConfig` | `Manager/getConfigWebReportsPending` |
| `updatePendingReportConfig` | `Manager/updateReportConfigPending` |
| `webLog` | `Manager/getWebLog` |
| `logWrite` | `Log/write` |
| `auth` | `System/authenticateCustomer` |
| `renewToken` | `System/renewToken` |

---

## 13. Consolidated Gap Analysis

### Operations Found in JS but NOT in endpoint-index.ts (6)

| Operation | Type | Priority | Action |
|-----------|------|----------|--------|
| `getAddedInfo` | Read | Medium | Add to endpoint-index.ts |
| `getCommunicationMessages` | Read | Medium | Add to endpoint-index.ts |
| `getLineTypes` | Read | Low | Add to endpoint-index.ts |
| `searchCustomerAdmin` | Read | High | Add to endpoint-index.ts |
| `saveNotifyAgent` | Write | Medium | Add to endpoint-index.ts |
| `updateBasicSettings` | Write | Medium | Add to endpoint-index.ts |
| `updateDistribution` | Write | Medium | Add to endpoint-index.ts |
| `changePassword` | Write | Medium | Add to endpoint-index.ts |
| `mailAgentUpdate` | Write | Low | Add to endpoint-index.ts |
| `sendFeedback` | Write | Low | Add to endpoint-index.ts |
| `getMasterSheet` | Read | Medium | Add to endpoint-index.ts |

### Operations Found in Proxy Discovery but NOT in JS or endpoint-index.ts (3)

| Operation | Type | Priority | Action |
|-----------|------|----------|--------|
| `Manager/getPlayerDetails` | Read | High | Add to endpoint-index.ts and test |
| `Manager/getPlayerLimits` | Read | High | Add to endpoint-index.ts and test |
| `Manager/setPlayerLimits` | Write | High | Add to endpoint-index.ts and test |
| `Manager/updatePlayerStatus` | Write | High | Add to endpoint-index.ts and test |

---

*End of reverse engineering analysis. All findings documented. Next step: Add missing endpoints to `endpoint-index.ts` and update proxy catalog.*
