# AGENTS.md — Sports Terminal v5.31

## Build/Lint/Test Commands
- **Build**: `bun run build`
- **Start**: `bun run dev` (hot reload) or `bun run start` (prod)
- **Test**: `bun test` — Runs all tests in `backend/tests/`
- **Single test**: `bun test <path/to/test.ts>`
- **Serve frontend**: `bun run serve` — Serves static files from `frontend/public/`
- **Status**: `bun run status` — Show port usage and running Bun processes
- **Stop**: `bun run stop` — Kill only the process using port 3000
- **Clean start**: `bun run clean-start` — Stop + dev in one command
- **Dev on custom port**: `bun run dev:port 3001`
- **Verify analytics**: `bun run dev` then check `http://localhost:3000/api/betting/velocity?minutes=10`
- **Check error tracking**: Open the **Up** tab in the frontend sidebar

## Code Style Guidelines
- **Language**: TypeScript (.ts), Bun runtime (v1.3.13+), prefer Bun APIs
- **Imports**: ES6 only, group stdlib / third-party / local
- **Formatting**: 2-space indent, single quotes, semicolons, Prettier
- **Types**: Explicit, avoid `any`, interfaces for complex objects
- **Naming**: camelCase vars/functions, PascalCase classes, UPPER_SNAKE constants, kebab-case files
- **Error Handling**: try-catch async, descriptive messages, Bun patterns
- **Comments**: JSDoc public APIs, inline complex logic, TODO
- **Testing**: Bun.test, describe blocks, descriptive names, cover success/error

## Project Structure

```
sportsterminal/
├── backend/
│   ├── src/
│   │   ├── index.ts              # Bun HTTP server + WebSocket upgrade
│   │   ├── database.ts           # SQLite init + schema
│   │   ├── scrapers/
│   │   │   ├── BuckeyeAPI.ts     # HTTP client for fantasy402.com
│   │   │   └── ScraperManager.ts # Polling lifecycle + backoff + exposure
│   │   ├── odds/
│   │   │   ├── OddsPoller.ts     # Odds pipeline: poll, persist, movements
│   │   │   ├── types.ts          # Shared odds types
│   │   │   └── providers/
│   │   │       ├── DemoOddsProvider.ts   # Synthetic odds generator
│   │   │       └── TheOddsApiProvider.ts # Real odds API skeleton
│   │   ├── risk/
│   │   │   └── AlertEngine.ts    # Alert detection rules
│   │   └── webhooks/
│   │       └── WebhookService.ts # Discord/Slack/Telegram dispatcher
│   ├── tests/
│   │   ├── api.test.ts           # AlertEngine + change detection tests
│   │   ├── odds.test.ts          # Odds provider + movement tests
│   │   └── webhook.test.ts       # Webhook CRUD + dispatch tests
│   ├── data/
│   │   └── terminal.db           # SQLite database (auto-created)
│   └── package.json
├── frontend/
│   └── public/
│       ├── index.html            # Static SPA shell; Buckeye data loads from backend only
│       ├── css/
│       │   └── terminal.css      # Shared terminal styling
│       └── js/
│           ├── app.js            # Boot sequence and compatibility host
│           ├── ws-client.js      # Browser WebSocket client
│           └── *.js              # Focused frontend module homes
├── docs/
│   ├── BUCKEYE_BACKEND_SCOPE.md  # API spec + architecture
│   └── IMPLEMENTATION_TRACKER.md # Zone-based progress tracker
└── README.md
```

## Key Architectural Decisions

### Amount Units
- **API returns cents** — `AmountWagered: 2500` = $25.00
- **Backend normalizes to dollars** in `BuckeyeAPI.normalizeWager()` (divide by 100)
- **Database stores dollars** — all SQL queries operate on dollar amounts
- **Frontend displays dollars** directly — no further conversion needed

### Authentication Flow
1. Frontend sends `auth` WS message with `agentId`, `password`, `cfCookie`
2. Backend `BuckeyeAPI.login()` POSTs to `/cloud/api/System/authenticateCustomer`
3. Backend receives JWT token, starts polling `getBetTicker` every 5s
4. Token returned to frontend → stored in `localStorage` for session resume
5. Frontend auto-reconnects on page refresh using stored token (valid ~10 min)

### Cloudflare Handling
- `cf_clearance` cookie is **mandatory** for API access
- User copies cookie from browser DevTools → pastes into Settings form
- Cookie expires in 30min–2hrs; "Get Fresh Cookie" button opens Buckeye in new tab
- Backend sends cookie on every request via `Cookie` header

### Polling & Resilience
- Normal interval: 5 seconds
- Exponential backoff on errors: 5s → 10s → 20s → 40s → max 60s
- Token renewal: every 15 minutes
- Max 3 re-login attempts, then broadcasts `auth_failed` and stops polling

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and set:

```bash
PORT=3002               # Backend port (3000 used by Gitea)
HOST=0.0.0.0
DEBUG=false             # Set true for verbose BuckeyeAPI logging
BUCKEYE_BASE_URL=https://fantasy402.com
POLL_INTERVAL_MS=5000
TOKEN_RENEWAL_MINUTES=15
JWT_SECRET=change-me-in-production-min-32-chars
```

## Common Tasks

### Run backend locally
```bash
bun run dev
```

### Run tests
```bash
bun test
```

### Build for production
```bash
bun run build
bun run start
```

### Reset database
```bash
bun run db:reset
bun run dev
```

### Check what's running
```bash
bun run status
```

### Kill stale backend process
```bash
bun run stop
```

### Quick restart (stop + dev)
```bash
bun run clean-start
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Port 3000 already in use` | Run `bun run stop` first, then `bun run dev` |
| Multiple Bun processes / confusion | Run `bun run status` to see what's running, then `bun run stop` or `taskkill /F /IM bun.exe` |
| Running from wrong folder | Always run from `C:\Users\bobby\sportsterminal\` (not root) |
| Stale node_modules | Remove `node_modules` / `backend/node_modules`, then run `bun install` from `C:\Users\bobby\sportsterminal\` |

## Development Tips

- **Debug**: `bun --inspect backend/src/index.ts` then open `chrome://inspect`
- **Watch mode**: `bun --watch backend/src/index.ts`
- **Change port**: `bun run dev:port 3001` or set `PORT` in `.env`
- **Frontend + backend together**: Run `bun run dev` in one terminal, `bun run serve` in another

## Sidebar Reference

Every sidebar tab, its zone, and current implementation status.

### Trading

| Tab | Zone | Status | Description |
|-----|------|--------|-------------|
| **Trading Floor** | Zone 1 | ✅ Full | 16-book odds grid with consensus, best-line highlighting, movement arrows (▲/▼), spread/total prices, pattern icons, detail drawers |
| **Patterns** | Zone 2 | ✅ Full | Real detected-pattern history from odds, wagers, agents, IP, live timing, and feed risk with filters, scoring, evidence drawer, and backend persistence. |

### Positions

| Tab | Zone | Status | Description |
|-----|------|--------|-------------|
| **Positions** | Zone 4 | ✅ Full | Buckeye exposure breakdown: sortable sport exposure table (top game, side, price, game $) and agent exposure table (top customer, top game). Data from `buckeyeWagers`. |

### PPH Books

| Tab | Zone | Status | Description |
|-----|------|--------|-------------|
| **Buckeye** | Zone 4 | ✅ Full | Live wager feed from `getBetTicker`, filters (type/VIP/min bet), stats cards, agent/sport/game breakdown panels, alert badge |
| **Ace Per Head** | — | ⬜️ Soon | Placeholder — no section or backend |
| **Metallic** | — | ⬜️ Soon | Placeholder — no section or backend |

### Agent Network

| Tab | Zone | Status | Description |
|-----|------|--------|-------------|
| **Downline** | Zone 4 | ✅ Full | Agent hierarchy derived from wager data, stats cards, sortable agent table, customer drill-down with volume % |
| **Player Search** | Zone 4 | ✅ Full | Search players by login, list with P&L/exposure, click-through to Player Detail |
| **Player Detail** | Zone 4 | ✅ Full | Stats cards, 7-day P&L bars, wager breakdown, recent wagers table. Navigated from Player Search or wager table. |

### Exchanges

| Tab | Zone | Status | Description |
|-----|------|--------|-------------|
| **Polymarket** | Zone 3 | ⬜️ Soon | Placeholder — prediction market integration not started |
| **Kalshi** | Zone 3 | ⬜️ Soon | Placeholder — event contract exchange not started |

### System

| Tab | Zone | Status | Description |
|-----|------|--------|-------------|
| **Alerts** | Zone 4+8 | ✅ Full | Alert history with severity badges, toast toggle (persisted), auto-scroll, acknowledged filter |
| **Webhooks** | Zone 8 | ✅ Full | CRUD webhooks (Discord/Slack/Telegram/Generic), trigger filtering, delivery log with retry |
| **Settings** | Zone 4 | ✅ Full | Backend URL, endpoint, agent credentials, Cloudflare cookie, auto-connect toggle, test connection |

### Removed / Consolidated

| Tab | Reason |
|-----|--------|
| **Odds Grid** | Removed — redundant with Trading Floor (which is the actual odds grid) |
| **Heatmap** | Moved to Coming Soon — line movement heatmap not implemented |
| **Candlestick** | Moved to Coming Soon — OHLC charts not implemented |
| **Bet Builder** | Moved to Coming Soon — multi-leg parlay builder not implemented |

## Zone Status

| Zone | Tabs | Feature | Status |
|------|------|---------|--------|
| 4 | Buckeye, Downline, Player Search, Player Detail, Positions, Alerts, Settings | Backend Ops (live connection, alerts, agent downline, player drill-down, sport exposure v2) | ✅ Complete |
| 1 | Trading Floor | Odds Grid (live provider gated by `ODDS_API_KEY`; no automatic synthetic fallback), prices, best-line, movement detection | ✅ Complete |
| 8 | Webhooks | Webhook Alerts (Discord/Slack/Telegram/Generic with retry + logging) | ✅ Complete |
| 2 | Patterns | Pattern Detection and anomaly history from persisted live data | ✅ Complete |
| 3 | — | Kalshi Polling & Positions | ⬜️ Not started |
| — | — | Amount Normalization (cents→dollars, AmountWagered fallback) | ✅ Complete |
| — | — | Prop Bet Detection (player props from ShortDesc) | ✅ Complete |
| — | — | Real Data Parsing (ALERT tickets, HTML entities, GSLIVE, parlays, futures) | ✅ Complete |
| — | — | Connection Fixes (file:// WS fallback, TDZ error, error logging) | ✅ Complete |
