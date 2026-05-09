# Buckeye PPH Backend v5.2 — Production Scope

## Executive Summary

Based on real screenshots and API analysis of the Buckeye PPH platform (`fantasy402.com`), this document defines the complete backend architecture for integrating live wager data into the Sports Terminal.

**Key Discovery**: Buckeye exposes a `getBetTicker` JSON API endpoint that returns all active wagers. Instead of Puppeteer DOM scraping, we authenticate and poll this API directly — much more reliable and performant.

**Amount Units**: The API returns `AmountWagered`, `ToWinAmount`, and `VolumeAmount` in **cents**. The backend normalizes these to dollars by dividing by 100 in `normalizeWager()`.

---

## 1. API Reverse-Engineering

### 1.1 Discovered Endpoints

| Endpoint | Method | URL Pattern | Auth |
|----------|--------|-------------|------|
| Login | POST | `/cloud/api/System/authenticateCustomer` | None (returns JWT) |
| Get Bet Ticker | POST | `/cloud/api/Manager/getBetTicker` | Bearer JWT + cf_clearance cookie |
| Get Bet Ticker Config | POST | `/cloud/api/Manager/getBetTickerConfig` | Bearer JWT |
| Renew Token | POST | `/cloud/api/System/renewToken` | Bearer JWT |

### 1.2 Authentication Flow

```
1. POST /cloud/api/System/authenticateCustomer
   Body: customerID, password, domain, state=true, operation=authenticateCustomer, RRO=1
   Response: JSON { code: "JWT_TOKEN", accountInfo: {...} }

2. POST /cloud/api/Manager/getBetTicker
   Headers: Authorization: Bearer {JWT}, Cookie: cf_clearance=xxx
   Body: agentID, agentOwner, agentSite=1, operation=getBetTicker, RRO=1, wagerNumber={lastSeen}
   Response: { "LIST": [ wager objects ] }

3. POST /cloud/api/System/renewToken (every 15 min)
   Refreshes session to prevent timeout
```

### 1.3 Response Schema (Confirmed from Real Data)

```json
{
  "LIST": [
    {
      "WagerNumber": 749959076,
      "AgentID": "NXC337",
      "CustomerID": "NZ121 ",
      "Login": "NZ121",
      "WagerType": "M",
      "AmountWagered": 2500,
      "InsertDateTime": "2026-05-08 08:51:18.427",
      "ToWinAmount": 1397,
      "TicketWriter": "GSLIVE",
      "VolumeAmount": 2500,
      "ShortDesc": "M.G296512619 - Tennis - Geoffrey Blancaneaux vs Alejo Sanchez Quilez / 2nd Set / Winner (2 way) / Geoffrey Blancaneaux -179",
      "VIP": "0",
      "AgentLogin": "NXC337 "
    }
  ]
}
```

**Amounts are in cents** — `AmountWagered: 2500` = $25.00.

### 1.4 Field Mapping to UI

| UI Column | JSON Field | Notes |
|-----------|-----------|-------|
| Customer | `Login` | Player login ID |
| Type | `WagerType` | M=Straight, L=Line, S=Spread, P=Parlay, E=Exotic, T=Teaser, C=Custom |
| Agent | `AgentLogin` | Agent code |
| Sport | Parsed from `ShortDesc` | Extracted via regex from description prefix |
| Description | `ShortDesc` | Full wager description with sport/game/line/odds |
| Risk | `VolumeAmount` | Risk amount (0 = pending/alert). Stored in dollars |
| Win | `ToWinAmount` | Potential payout. Stored in dollars |
| Source | `TicketWriter` | Internet / GSLIVE / ALERT |
| Time | `InsertDateTime` | Timestamp in ET |

---

## 2. Backend Architecture (Bun + TypeScript)

### 2.1 Project Structure

```
backend/
├── src/
│   ├── index.ts                   # Bun HTTP server + WS upgrade
│   ├── database.ts                # SQLite init + schema
│   ├── scrapers/
│   │   ├── BuckeyeAPI.ts          # API client (HTTP, NOT Puppeteer)
│   │   └── ScraperManager.ts      # Polling lifecycle, backoff, re-auth
│   ├── risk/
│   │   └── AlertEngine.ts         # Alert detection rules
│   └── types/
│       └── index.ts               # Shared interfaces
├── tests/
│   └── api.test.ts                # Bun.test — AlertEngine + change detection
├── data/
│   └── terminal.db                # SQLite database
├── .env.example
└── package.json
```

### 2.2 Core Files

#### `src/scrapers/BuckeyeAPI.ts` — API Client

```typescript
interface BuckeyeCredentials {
  agentId: string;      // "BILLY666"
  password: string;
  baseUrl?: string;     // "https://fantasy402.com"
  cfCookie?: string;    // cf_clearance from browser DevTools
}

class BuckeyeAPI {
  async login(): Promise<boolean>
  async testAccess(): Promise<boolean>
  async getBetTicker(): Promise<EnrichedWager[]>  // polls live wager feed
  async renewToken(): Promise<boolean>
  detectChanges(newWagers: EnrichedWager[]): WagerChange[]
  clearCache(): void
  isAuthenticated(): boolean
  getToken(): string
}
```

**Normalization**: `normalizeWager()` divides `AmountWagered`, `ToWinAmount`, `VolumeAmount` by 100 (cents → dollars).

#### `src/scrapers/ScraperManager.ts` — Polling Manager

- `startAgent()` → login → interval polling + token renewal
- `pollAgent()` → fetch wagers → detect changes → persist to DB → broadcast WS events → evaluate alerts
- Exponential backoff on errors: 5s → 10s → 20s → 40s → max 60s
- Max 3 re-login attempts, then broadcasts `auth_failed` event
- `resumeAgent()` for session persistence via stored JWT

#### `src/risk/AlertEngine.ts` — Alert Detection

| Rule | Threshold | Severity |
|------|-----------|----------|
| High Volume Wager | ≥ $50,000 | critical |
| ALERT Ticket Writer | Any ALERT wager | warning |
| Live Large Wager | GSLIVE + ≥ $10,000 | warning |
| Parlay High Payout | Parlay + win ≥ $100,000 | warning |
| VIP Wager | Any VIP player wager | info |
| Exotic Large | Exotic + ≥ $5,000 | warning |
| Teaser Large | Teaser + ≥ $5,000 | warning |

---

## 3. Polling Strategy

| Endpoint | Interval | Rationale |
|----------|----------|-----------|
| `getBetTicker` | 5 seconds (adaptive) | Near real-time wager feed |
| `renewToken` | 15 minutes | Prevent session expiry |
| Error backoff | 5s → 10s → 20s → 40s → 60s | Exponential on failures |
| DB cleanup | 1 hour (planned) | Archive old wagers |

---

## 4. WebSocket Events

```typescript
// Server → Client
interface WsEvent {
  type: 'wager.new' | 'wager.alert' | 'exposure.update' | 'auth_failed';
  timestamp: string;
  payload: unknown;
}

// wager.new — New bet placed
{
  type: 'wager.new',
  payload: {
    wagerNumber: 749959999,
    login: "NZ121",
    agentLogin: "NXC337",
    wagerType: "M",
    amountWagered: 50.00,    // dollars
    ticketWriter: "GSLIVE",
    shortDesc: "M.G296512999 - Tennis - ..."
  }
}

// wager.alert — Risk flagged
{
  type: 'wager.alert',
  payload: {
    wagerNumber: 749959999,
    rule: "High Volume Wager",
    severity: "critical",
    message: "Agent NXC337: $50,000.00 wager by NZ121"
  }
}
```

---

## 5. Frontend Integration Points

### 5.1 Real-Time Feed
- WS connection to `/ws`
- `wager.new` events append to Bet Ticker table
- `wager.alert` events flash red + show toast (if toasts enabled)
- Auto-scroll to newest wager (toggleable)
- Session persistence: JWT token + credentials in `localStorage`
- Auto-connect on page load (if enabled)

### 5.2 Bet Ticker UI (Matching Real Buckeye)
- Columns: Customer, Type, Agent, Sport, Description, Risk, Win, Source, Time
- Color coding: ALERT=red row, GSLIVE=cyan row, Internet=default
- Filters: Min bet amount, VIP only, wager type, search, agent filter
- Actions: Clear ticker, export CSV, configuration
- Toast toggle: mute/unmute all notifications

### 5.3 Dashboard Panels
- **Stats Cards**: Total Wagers, Total Volume, Unique Customers, Active Agents, Alert Wagers, Live GSLIVE, Max Wager
- **Top Agents by Volume**: Horizontal bar chart with color thresholds
- **Sport Breakdown**: Count + volume per sport
- **Game Breakdown**: Top 10 games by volume with matchup parsing

### 5.4 Agent Network & Player Drill-Down
- Agent downline table with player count, wager count, volume, risk, alerts, live
- Click agent → filter ticker to that agent's wagers
- Player search with volume/risk sorting
- Player detail view: stats cards, 7-day P&L bars, wager breakdown, recent wagers
- Click customer → player detail view

---

## 6. Risk Thresholds

```typescript
const RISK_THRESHOLDS = {
  wagerWarning: 10000,      // $10K — yellow highlight
  wagerCritical: 50000,     // $50K — red highlight + alert
  exposureWarning: 50000,   // Agent level
  exposureCritical: 200000, // Agent level
  parlayMaxLegs: 8,
  parlayMaxPayout: 500000,  // $500K
};
```

---

## 7. Implementation Checklist

### Phase 1: API Client ✅
- [x] `BuckeyeAPI.ts` — Login + getBetTicker + renewToken
- [x] Cloudflare cookie support (`cf_clearance`)
- [x] Session persistence (cookie jar + JWT)
- [x] Error handling (auth failure, rate limits, backoff)

### Phase 2: Data Pipeline ✅
- [x] Wager normalization (trim fields, parse dates, cents→dollars)
- [x] SQLite storage with schema
- [x] Change detection (diff engine)
- [x] Sport/line/odds parser from ShortDesc

### Phase 3: Real-Time ✅
- [x] WebSocket server with upgrade
- [x] 5-second polling loop with adaptive backoff
- [x] Event broadcasting (wager.new, wager.alert, exposure.update, auth_failed)
- [x] Frontend WS client with auto-reconnect
- [x] Session resume via stored JWT

### Phase 4: Risk Engine ✅
- [x] Alert rules implementation (7 rules)
- [x] Alert persistence in SQLite
- [x] Threshold management

### Phase 5: Frontend Polish ✅
- [x] Bet Ticker matching real Buckeye UI
- [x] Agent dashboard + downline
- [x] Player search + drill-down
- [x] Sport breakdown + game breakdown
- [x] Toast toggle + session persistence
- [x] Export functionality

---

## 8. Key Metrics from Real Data

| Metric | Value |
|--------|-------|
| Live Wagers | 250–300 (fluctuates in real-time) |
| Wager Types | 7 (L, M, S, P, E, T, C) |
| Avg Wager | ~$117 (demo: varies by player) |
| Max Wager | ~$8,000 (live) |
| Total Volume | ~$2.5M (live, 400+ wagers) |
| Unique Agents | 140+ (live) |
| Internet | ~56% |
| GSLIVE | ~21% |
| ALERT | ~22% |
| Top Sport | Baseball / Tennis / Soccer (varies) |

---

## 9. Security Considerations

1. **Credential Storage**: Credentials stored in `localStorage` on frontend; backend does not persist passwords
2. **Session Management**: Auto-renew tokens every 15 min, JWT reuse for ~10 min
3. **Cloudflare**: `cf_clearance` cookie required; expires 30min–2hrs, user refreshes via browser
4. **Rate Limiting**: Backend respects natural API limits (1 req/5s per agent)
5. **Reconnection Resilience**: Exponential backoff, max 3 re-login attempts

---

## 10. Files Delivered

| File | Description |
|------|-------------|
| `frontend/public/index.html` | Single-file SPA frontend v5.2 |
| `frontend/public/buckeye_data.js` | Demo wager data (149 records, cents) |
| `backend/src/scrapers/BuckeyeAPI.ts` | HTTP API client |
| `backend/src/scrapers/ScraperManager.ts` | Polling lifecycle manager |
| `backend/src/risk/AlertEngine.ts` | Alert rule engine |
| `backend/src/index.ts` | Bun HTTP + WebSocket server |
| `docs/BUCKEYE_BACKEND_SCOPE.md` | This document |
| `docs/IMPLEMENTATION_TRACKER.md` | Zone-based progress tracker |
