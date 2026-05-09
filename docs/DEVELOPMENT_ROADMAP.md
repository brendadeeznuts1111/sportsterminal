# Sports Terminal — Development Roadmap

> Derived from audit of `Buckeye PPH Update.docx` vs actual codebase state.
> Last updated: 2026-05-08

---

## Executive Summary

The project is a **polished frontend prototype** with a **partial backend shell**. The frontend has one fully working section (Buckeye Bet Ticker with static demo data) and 9 empty placeholder sections. The backend implements a Puppeteer scraper for the wrong target URL (`buckeyeagent.com` instead of `fantasy402.com`) and lacks the REST API routes, real auth, and WebSocket event broadcasting described in the scope documents.

**The #1 blocker:** The backend and frontend don't share a live data contract. The frontend loads `buckeye_data.js` (a 149-record static snapshot). The backend scrapes a different site with unverified CSS selectors. They never talk to each other for real data.

---

## Zone Inventory

### Zone 1: Sportsbook Taxonomy (Odds Grid)
| Feature | Status | Notes |
|---------|--------|-------|
| 16-book comparison grid | 🟡 Stub | 3 hardcoded games with `Math.random()` odds |
| Type filter chips | ✅ UI exists | No functional effect |
| Region filter | ❌ Missing | Not in code |
| Best-line highlighting | 🟡 Just fixed | CSS `.best`/`.worst` added; logic is hardcoded indices |
| Book health/sharp indicators | ❌ Missing | No health scoring implemented |

**Priority: MEDIUM** — This is demo filler until live odds APIs are integrated.

---

### Zone 2: Pattern Detection
| Feature | Status | Notes |
|---------|--------|-------|
| Steam Move detection | 🟡 Stub | 1 hardcoded row |
| Reverse Line Movement | 🟡 Stub | 1 hardcoded row |
| Syndicate Play | 🟡 Stub | 1 hardcoded row |
| Arbitrage scanning | 🟡 Stub | 1 hardcoded row |
| Severity scoring | 🟡 Stub | Hardcoded 45-85% scores |
| Pattern history | ❌ Missing | No persistence or history view |
| Custom alert rules | ❌ Missing | No user-configurable rules |
| Auto-trade hooks | ❌ Missing | No automated execution |

**Priority: LOW** — Needs live odds feeds first. Patterns are meaningless on random data.

---

### Zone 3: Kalshi / Polymarket Integration
| Feature | Status | Notes |
|---------|--------|-------|
| Kalshi API config in Settings | 🟡 UI fields exist | No actual API calls |
| Yes/No market cards | ❌ Missing | Section is placeholder text |
| Category filter | ❌ Missing | Not implemented |
| Kalshi vs Polymarket arb table | ❌ Missing | Not implemented |
| Live polling | ❌ Missing | No timers or fetch logic |
| Position tracking | ❌ Missing | No integration with Positions tab |

**Priority: LOW** — Exchanges are secondary to the PPH core business.

---

### Zone 4: PPH Integration (Buckeye) — THE CORE
| Feature | Status | Notes |
|---------|--------|-------|
| **Bet Ticker UI** | ✅ Working | Renders static data beautifully |
| **Filters (type, VIP, min, search)** | ✅ Working | All functional on static data |
| **Stats cards** | ✅ Working | Derived from static data |
| **Agent exposure bars** | ✅ Working | Top 10 by volume |
| **Sport breakdown** | ✅ Working | Parsed from `ShortDesc` |
| **CSV export** | ✅ Working | Downloads full dataset |
| **WebSocket client skeleton** | ✅ Exists | `TerminalWebSocketClient` class is complete |
| **Live WebSocket data feed** | 🔴 Broken | `updateFromBackend()` logs to console but does NOT push wagers into ticker |
| **Accept/Decline action queue** | ❌ Missing | Buttons in UI do nothing |
| **Backend API client** | 🔴 Wrong target | Scrapes `buckeyeagent.com` instead of `fantasy402.com/getBetTicker` |
| **Backend REST API routes** | ❌ Missing | No `/api/wagers`, `/api/agents`, etc. |
| **Backend WebSocket events** | ❌ Missing | No `wager.new`, `wager.alert`, `exposure.update` broadcasts |
| **Real authentication** | 🔴 Fake | JWT is a TODO; accepts any password |
| **Scraper scheduler** | 🔴 Broken | `setImmediate` causes tight loop instead of interval polling |
| **Session persistence** | ❌ Missing | No cookie jar across restarts |
| **Idle shutdown** | 🟡 Partial | Exists but never triggers correctly due to scheduler bug |
| **Tests** | ❌ Missing | `bun test` has no test files |

**Priority: CRITICAL** — This is the only zone that generates revenue. Everything else is a distraction until this is solid.

---

### Zone 5: Navigation
| Feature | Status | Notes |
|---------|--------|-------|
| Sidebar section switching | ✅ Working | 14 sections |
| Nested submenus | ✅ UI exists | PPH Books, Exchanges |
| Keyboard shortcuts 1-6 | ✅ Working | Just fixed `1` key bug |
| Mobile hamburger | ❌ Missing | Desktop only |

**Priority: LOW** — Works fine for desktop MVP.

---

### Zone 6: Bet Builder
| Feature | Status | Notes |
|---------|--------|-------|
| Multi-leg parlay builder | ❌ Missing | Section says "Multi-leg parlay builder." |

**Priority: LOW** — Post-MVP feature.

---

### Zone 7: Positions
| Feature | Status | Notes |
|---------|--------|-------|
| Position table | 🟡 Stub | 3 hardcoded positions |
| P&L tracking | 🟡 Stub | Static math on hardcoded data |
| EV calculation | 🟡 Stub | Hardcoded 2.8-4.1% |
| Export CSV/JSON/PDF | 🟡 Stub | Shows toast only |

**Priority: MEDIUM** — Needs live data to be useful. Depends on Zone 4.

---

### Zone 8: Webhooks / Alerts
| Feature | Status | Notes |
|---------|--------|-------|
| Discord webhook | ❌ Missing | Section is placeholder text |
| Telegram bot | ❌ Missing | Not implemented |
| Alert center | 🟡 Partial | Renders static alert rows from wager data |

**Priority: MEDIUM** — High value for risk management. Depends on Zone 4 alert engine.

---

## Critical Architecture Gap

```
Scope Document Says          Code Actually Does
─────────────────────────────────────────────────────────
fantasy402.com/getBetTicker  →  Puppeteer → buckeyeagent.com
JSON API polling             →  DOM scraping with guessed selectors
BuckeyeAPI.ts (HTTP client)  →  BaseScraper.ts (browser automation)
wagers table                 →  bets table (different schema)
5-second polling loop        →  setImmediate tight loop
wager.new WS events          →  auth_response, data_response only
```

**Decision required:** Migrate backend from Puppeteer scraping to direct JSON API client, OR commit to Puppeteer and update all docs. The static data snapshot (`buckeye_data.js`) matches the JSON API schema, not the DOM scraping schema.

---

## Recommended Build Order

### Phase 1: Fix the Core Data Pipe (Week 1)
1. **Rebuild `BuckeyeAPI.ts`** as HTTP client (fetch + cookie jar) targeting `fantasy402.com`
   - `login()` → POST to `/login`, capture `PHPSESSID` + `auth_token`
   - `getBetTicker()` → GET with session cookies, return `LIST` array
   - `renewToken()` → GET `/renewToken` every 15 min
2. **Fix scraper scheduler** → Replace `setImmediate` loop with `setInterval`
3. **Add REST API routes**
   - `GET /api/wagers` → return all wagers from DB
   - `GET /api/wagers/alerts` → filtered by risk rules
   - `GET /api/wagers/live` → GSLIVE only
   - `GET /api/agents` → top agents by volume
   - `GET /api/stats` → summary stats
4. **Implement real WebSocket events**
   - `wager.new` → broadcast on new wager detection
   - `wager.alert` → broadcast on threshold breach
   - `exposure.update` → broadcast on recalculation
5. **Wire frontend to backend**
   - `updateFromBackend()` should push wagers into `buckeyeWagers` array and re-render

### Phase 2: Risk Engine (Week 1-2)
1. **Build `AlertEngine.ts`** with the 7 documented rules
2. **Build `ExposureCalculator.ts`** for agent/player exposure math
3. **Update DB schema** to match scope doc (`wagers` table, not `bets`)
4. **Add alert persistence** → SQLite `alerts` table with indexes

### Phase 3: Agent Downline + Player Drill-Down (Week 2)
1. **Backend**: `getAgentDownline()`, `getWeeklyFigures()`, `getAgentPerformance()`
2. **Backend**: `getPlayerDetails()`, `getPlayerPnlHistory()`
3. **Frontend**: Build the Agent Network section (currently missing)
4. **Frontend**: Click-through from Bet Ticker → Player detail view

### Phase 4: Polish + Integration (Week 3)
1. **Zone 1**: Connect odds grid to real API (The Odds API or similar)
2. **Zone 7**: Connect positions to real wager data from backend
3. **Zone 8**: Add Discord webhook dispatcher
4. **Tests**: Write unit tests for API client, alert engine, exposure calculator

### Phase 5: Expansion (Future)
1. **Zone 3**: Kalshi/Polymarket live polling
2. **Zone 2**: Real pattern detection on live odds feeds
3. **Zone 6**: Bet builder with leg validation
4. Multi-PPH support (Ace Per Head, Metallic)

---

## Files to Create / Modify

### New Backend Files
```
backend/src/
├── api/
│   ├── routes/
│   │   ├── wagers.ts
│   │   ├── agents.ts
│   │   ├── players.ts
│   │   └── risk.ts
│   └── websocket.ts          # Real broadcast manager
├── scrapers/
│   └── BuckeyeAPI.ts         # HTTP client (replaces Puppeteer)
├── risk/
│   ├── AlertEngine.ts
│   └── ExposureCalculator.ts
├── db/
│   ├── schema.ts             # Align with scope doc
│   └── queries.ts
└── models/
    ├── Wager.ts
    ├── Agent.ts
    └── Alert.ts
```

### Files to Delete / Deprecate
```
backend/src/scrapers/buckeye/
├── BaseScraper.ts            # Puppeteer base — replace with HTTP client
├── BuckeyeScraper.ts         # DOM scraping — replace with API consumer
├── ScraperManager.ts         # Rewrite for HTTP polling
└── config.ts                 # Selectors are wrong — needs API endpoints
```

### Frontend Fixes
```
frontend/public/index.html
├── Add: updateFromBackend() pushes to buckeyeWagers
├── Add: Agent Network section HTML
├── Add: Player drill-down modal/section
└── Fix: Settings save persists to backend
```

---

## Immediate Next Steps

1. **Decide:** Puppeteer scraping vs JSON API client? (Recommendation: JSON API — faster, no CAPTCHA, matches real data)
2. **Build `BuckeyeAPI.ts`** as HTTP fetch client with cookie jar
3. **Fix scheduler** in `ScraperManager.ts`
4. **Add REST routes** to `index.ts`
5. **Implement WebSocket broadcasts** for `wager.new` / `wager.alert`

These 5 items unblock everything else. Without them, Zones 1-3 and 6-8 are permanently stuck in demo mode.
