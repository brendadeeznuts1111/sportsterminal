# Sports Terminal - Buckeye PPH Integration

A production-grade sports betting terminal with real-time agent hierarchy scraping, player P&L tracking, and risk exposure monitoring for Buckeye per-head operators.

## 🎯 Architecture Overview

```
┌─────────────────────────────────────────┐
│      Frontend (HTML/JavaScript)         │
│  • Odds Grid                            │
│  • Agent Tree Navigation                │
│  • Player P&L Dashboard                 │
│  • Risk Alert System                    │
│  • WebSocket Client                     │
└────────────────┬────────────────────────┘
                 │ WebSocket (JWT Auth)
                 │
┌────────────────▼────────────────────────┐
│    Bun Backend (TypeScript)             │
│  • WebSocket Server                     │
│  • Scraper Manager                      │
│  • SQLite Database (AES-GCM encrypted)  │
│  • Risk Engine                          │
└────────────────┬────────────────────────┘
                 │ Puppeteer
                 │
┌────────────────▼────────────────────────┐
│   Buckeye Agent Portal (Headless)       │
│  • Login & Session Management           │
│  • Downline Tree Scraping               │
│  • Player Data Extraction               │
│  • Odds & Bets Monitoring               │
└─────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites
- **Node.js/Bun**: v1.1.42+
- **Python**: 3.10+
- **Chrome/Chromium**: For Puppeteer (auto-installed)
- **SQLite3**: For database

### Backend Setup

1. **Install dependencies**
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env with your Buckeye credentials and JWT secret
   bun install
   ```

2. **Configure credentials** (.env)
   ```env
   BUCKEYE_AGENT_ID=your_agent_id
   BUCKEYE_PASSWORD=your_password
   BUCKEYE_LOGIN_URL=https://buckeyeagent.com/login
   PORT=3000
   JWT_SECRET=your_jwt_secret_key_min_32_chars
   DATABASE_URL=sqlite:./data/terminal.db
   HEADLESS=true
   DEBUG_SCRAPER=false
   ```

3. **Start the server**
   ```bash
   bun run start
   ```

   Expected output:
   ```
   ✅ Database initialized
   ✅ Scraper manager initialized
   🚀 Backend running at http://0.0.0.0:3000
   ```

### Frontend Setup

1. **Open in browser**
   - Direct: Open `frontend/public/index.html` in your browser
   - Or: Serve via HTTP
   ```bash
   cd frontend/public
   python -m http.server 8000
   # Visit http://localhost:8000/index.html
   ```

2. **Connect to backend**
   - Settings → Test Connection (verify WebSocket is reachable)
   - Authentication → Enter your Buckeye credentials
   - Click "Connect to Buckeye"

## 📊 Core Features by Sidebar Tab

### Trading Floor (Zone 1 — Odds Grid)
- **16-book comparison grid** across NBA, MLB, NHL, NCAAB, NFL, Soccer, Tennis, UFC
- **Consensus column** with market-average lines
- **Best-line highlighting** (gold border on best price per outcome)
- **Line movement arrows** (▲/▼ with delta) stored and displayed in real time
- **Spread/total prices** shown as small `(+105)` / `(-110)` next to line values
- **Pattern icons** (🔥 steam move, 🚨 reverse line) on game rows with tooltips
- **Detail drawers** per game with sparkline + per-book breakdown
- **Demo data** from `DemoOddsProvider` (add `ODDS_API_KEY` env var for The Odds API)

### Patterns (Zone 2 — Partial)
- **Demo pattern list** with 4 hardcoded rows and severity scoring bars
- **Backend detection**: Steam move (3+ books within 90s) and reverse line detection in `OddsPoller`
- **Simulate button** for testing alert flows
- *Missing*: Real pattern storage, custom rules engine, auto-trading execution

### Positions (Zone 4 — Exposure)
- **Sport Exposure table**: Sortable by sport, total, %, live count, top game, popular side, avg price, game total
- **Agent Exposure table**: Sortable by agent, total, %, live count, top customer, top game
- Data derived from live `buckeyeWagers` — updates as new bets arrive

### Buckeye (Zone 4 — Live Wager Feed)
- **Real-time bet ticker** from `fantasy402.com/cloud/api/Manager/getBetTicker`
- **Filters**: Wager type (Straight/Parlay/Live/Alert/Prop), VIP only, min bet threshold
- **Stats cards**: Total wagers, volume, unique customers, active agents, alert count, live count, max wager
- **Bottom panels**: Top Agents by Volume, Sport Breakdown, Game Breakdown
- **Amount normalization**: API returns cents → displayed as dollars
- **Prop bet detection** from `ShortDesc` (player props, O/U, spreads)

### Downline (Zone 4 — Agent Network)
- **Agent hierarchy** derived from wager data (no DOM scraping)
- **Stats cards**: Total agents, active agents, total volume, average wager
- **Sortable agent table** with volume, wager count, top customer, top game
- **Customer drill-down**: Click agent → see their customers with individual volumes and % of agent's book

### Player Search (Zone 4 — Player Drill-Down)
- **Search by login** with live filtering
- **Player list** with wager count, total volume, total risk, net P&L
- **Click-through to Player Detail** with stats, 7-day P&L bars, wager breakdown

### Alerts (Zone 4 + 8)
- **7 alert rules**: High Volume, ALERT Writer, Live Large, Parlay Payout, VIP, Exotic Large, Teaser Large
- **Severity levels**: Critical (red), Warning (yellow), Info (blue)
- **Toast notifications** with on/off toggle (persisted in `localStorage`)
- **Alert history** with acknowledged filter

### Webhooks (Zone 8)
- **CRUD webhooks** for Discord, Slack, Telegram, Generic
- **Trigger filtering** by severity (`all`, `critical`, `warning`, `info`)
- **Retry logic**: 3 attempts with exponential backoff
- **Delivery log** with payload, response status, success/failure

### Settings (Zone 4 — System)
- **Backend URL** and endpoint configuration
- **Buckeye credentials** + Cloudflare `cf_clearance` cookie
- **Auto-connect** toggle with session persistence (JWT in `localStorage`)
- **Test Connection** button to verify WebSocket reachability
- **Toast toggle** for alert notifications

## 📡 WebSocket Protocol

### Client → Server

#### Authentication
```json
{
  "type": "auth",
  "agentId": "AGN123",
  "username": "agent_username",
  "password": "password"
}
```

#### Request Data
```json
{
  "type": "request_data",
  "agentId": "AGN123"
}
```

#### Force Refresh
```json
{
  "type": "refresh",
  "agentId": "AGN123"
}
```

### Server → Client

#### Authentication Response
```json
{
  "type": "auth_response",
  "success": true,
  "message": "Authenticated"
}
```

#### Data Response
```json
{
  "type": "data_response",
  "agentId": "AGN123",
  "data": {
    "agent": { "id": "AGN123", "name": "Main Agent", "balance": 50000, "credit": 100000 },
    "players": [
      { "id": "PLY001", "name": "John", "net_pnl": 2500, "ytd_pnl": 10000, "exposure": 3500 }
    ],
    "bets": [
      { "id": "BET001", "player_id": "PLY001", "wager": 100, "odds": 1.95, "status": "pending" }
    ],
    "alerts": [
      { "id": "ALR001", "type": "exposure_warning", "player_id": "PLY001", "value": 5500, "threshold": 5000 }
    ]
  }
}
```

#### Error Response
```json
{
  "type": "error",
  "message": "Error description"
}
```

## 🛠 Configuration Reference

### BuckeyeConfig (src/scrapers/buckeye/config.ts)

```typescript
{
  loginUrl: "https://buckeyeagent.com/login",
  baseUrl: "https://buckeyeagent.com",

  endpoints: {
    odds: "/lines/basketball",        // Sport-specific
    bets: "/active-bets",
    downlineTree: "/agents",
    playersList: "/players",
    playerDetails: "/player-details",
    pnlReport: "/pnl-report"
  },

  selectors: {
    login: {
      usernameInput: "#agent_id",
      passwordInput: "#password",
      submitButton: "button[type='submit']"
    },
    tree: {
      root: "#agent-tree",
      agentRow: ".agent-row",
      agentIdAttr: "data-agent-id",
      agentName: ".agent-name",
      agentBalance: ".balance",
      agentCredit: ".credit"
    },
    // ... more selectors
  },

  intervals: {
    odds: 30000,         // 30 seconds
    bets: 30000,
    downline: 90000,     // 90 seconds
    playerDetails: 300000 // 5 minutes
  },

  thresholds: {
    exposureWarning: 5000,
    exposureCritical: 20000,
    pnlAlert: 1000
  }
}
```

## 📊 Database Schema

### agents
```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT DEFAULT 'buckeye',
  parent_agent_id TEXT,
  tier INTEGER,
  credit REAL,
  balance REAL,
  status TEXT DEFAULT 'active',
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### players
```sql
CREATE TABLE players (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  net_pnl REAL DEFAULT 0,
  ytd_pnl REAL DEFAULT 0,
  exposure REAL DEFAULT 0,
  credit_limit REAL,
  status TEXT DEFAULT 'active',
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

### bets
```sql
CREATE TABLE bets (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  event_id TEXT,
  wager REAL,
  odds REAL,
  status TEXT DEFAULT 'pending',
  pnl REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  graded_at DATETIME,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

### risk_alerts
```sql
CREATE TABLE risk_alerts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  player_id TEXT,
  type TEXT NOT NULL,
  value REAL,
  threshold REAL,
  message TEXT,
  acknowledged BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (player_id) REFERENCES players(id)
);
```

## 🔒 Security Considerations

1. **Credential Encryption**: All stored credentials encrypted with AES-256-GCM
2. **HTTP API Client**: Direct API polling (no Puppeteer/browser automation)
3. **JWT Tokens**: Session authentication via WebSocket
4. **HTTPS**: Deploy backend behind HTTPS reverse proxy (Nginx/Caddy)
5. **Rate Limiting**: Built-in concurrency limits to avoid detection
6. **Session Persistence**: JWT token + Cloudflare cookie in `localStorage`

## 🧪 Testing

### Health Check
```bash
curl http://localhost:3000/health
```

### Metrics
```bash
curl http://localhost:3000/metrics
```

### Browser Console
```javascript
// Test WebSocket connection
const ws = new WebSocket('ws://localhost:3000/ws');
ws.onopen = () => console.log('Connected');
ws.send(JSON.stringify({ type: 'auth', agentId: 'TEST', username: 'user', password: 'pass' }));
```

## 📈 Next Steps (Planned by Zone)

### Zone 2 — Pattern Detection & Trading Automation 🔄
- [ ] Store detected patterns in `detected_patterns` table
- [ ] Pattern history endpoint `GET /api/patterns/history`
- [ ] Custom rules engine (`user_rules` table + evaluator)
- [ ] Auto-trading simulation on pattern match
- [ ] Frontend rule builder UI

### Zone 3 — Kalshi & Exchanges ⬜️
- [ ] Kalshi API poller with WebSocket push
- [ ] Kalshi position tracker (`kalshi_positions` table)
- [ ] Unrealised/realised P&L dashboard
- [ ] Polymarket direct API integration

### Zone 1 — Odds Grid (Real Data) ⬜️
- [ ] Activate The Odds API (set `ODDS_API_KEY` env var)
- [ ] Kalshi odds feed
- [ ] Candlestick charts (OHLC + volume)
- [ ] Movement heatmap

### Zone 4 — Backend Ops (Remaining Gaps) ⬜️
- [ ] Ace Per Head (APH) scraper
- [ ] Metallic (MET) scraper
- [ ] Prom-client metrics endpoint
- [ ] Idle shutdown (stop scrapers when no WS clients)
- [ ] JWT enforcement on WebSocket upgrade
- [ ] Rate limiting (100 req/min sliding window)

### General
- [ ] PDF export for reports
- [ ] Mobile app (React Native)
- [ ] Bet tracking journal with EV calculator

## 🐛 Troubleshooting

### WebSocket Connection Fails
- Check backend is running: `curl http://localhost:3000/health`
- Check firewall allows port 3000
- Verify `serverUrl` in Settings matches backend

### Login Fails
- Verify credentials in .env are correct
- Check Buckeye URL is correct
- Enable `DEBUG_SCRAPER=true` in .env for detailed logs
- Check for CAPTCHA (requires manual solving)

### Data Not Updating
- Click "🔄 Refresh" button
- Check backend logs for scraper errors
- Verify selectors match current Buckeye HTML structure

### Performance Issues
- Reduce scraping frequency in `config.ts`
- Increase `maxGlobalConcurrency` limits
- Deploy on larger machine if needed

## 📝 License

Private / Proprietary

## 👥 Support

For issues or questions about Buckeye integration, refer to the Buckeye Agent Portal documentation or contact support.
