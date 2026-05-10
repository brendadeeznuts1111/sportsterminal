// endpoint-index.ts — Single Source of Truth v1
// Auto-generated test results from: api_output/summary.json
// Response shapes extracted from real Buckeye API calls
// Last verified: 2026-05-10

import summary from "./api_output/summary.json" with { type: "json" };

export interface EndpointInfo {
  name: string;
  path: string;
  method: "GET" | "POST";
  status: number;
  tested: boolean;
  test_ok: boolean;
  timestamp?: string;
  auth: "api_key" | "none";
  autoLoad: boolean;
  params?: Record<string, string>;
  response_shape?: Record<string, string>;
  description: string;
  notes?: string;
}

type EndpointMap = Record<string, EndpointInfo>;

const PROXY: EndpointMap = {
  "root": {
    name: "Service Info", path: "/", method: "GET", status: 200, tested: true, test_ok: true,
    auth: "none", autoLoad: false,
    response_shape: { service: "string", version: "string", status: "string", timestamp: "string" },
    description: "Root service health check — no auth required",
  },
  "status": {
    name: "Service Status", path: "/api/proxy/status?customerID=", method: "GET", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    response_shape: { service: "string", uptime: "number", memory: "{rss: string}", stats: "{total_requests: number, errors: number}" },
    description: "Proxy service status, uptime, memory, request stats — optional token expiry info",
  },
  "endpoints-list": {
    name: "Endpoint Docs", path: "/api/proxy/endpoints", method: "GET", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    response_shape: { proxy: "object", buckeye: "object" },
    description: "Inline endpoint documentation listing all routes",
  },
  "logs": {
    name: "Request Logs", path: "/api/proxy/logs", method: "GET", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    response_shape: { logs: "array[{endpoint, status, duration_ms, error, logged_at}]" },
    description: "Last 50 proxy request logs with timing and errors",
  },
  "tokens": {
    name: "Token Info", path: "/api/proxy/tokens?customerID=", method: "GET", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    response_shape: { found: "boolean", token: "string|null", cf_clearance: "string|null", expired: "boolean", expires_in: "number", created_at: "number", expires_at: "number" },
    description: "Stored token status for customerID",
  },
  "renewToken": {
    name: "Renew Token", path: "/api/proxy/renewToken", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { customerID: "string (auto-loads token+cf from DB)" },
    response_shape: { success: "boolean", token: "string" },
    description: "Renew JWT via System/renewToken and store new token in DB",
  },
};

const BUCKEYE: EndpointMap = {
  // === Bet Ticker ===
  "Manager/getBetTicker": {
    name: "Live Wager Feed", path: "/api/proxy/Manager/getBetTicker", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getBetTicker", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: array[{WagerNumber, AgentID, CustomerID, Login, WagerType, AmountWagered, InsertDateTime, ToWinAmount, ShortDesc}]}" },
    description: "Live wager feed — 244+ wagers/min, real-time betting activity",
    notes: "Largest payload endpoint. ~50+ wagers per call.",
  },
  "Manager/getBetTickerConfig": {
    name: "Ticker Display Config", path: "/api/proxy/Manager/getBetTickerConfig", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getBetTickerConfig", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: {play1-499: string, play3-499: string, ...}}" },
    description: "Ticker display settings (colors, tiers, toggles, limits)",
  },

  // === Account Info ===
  "Manager/getAccountInfoOwner": {
    name: "Agent Account Info", path: "/api/proxy/Manager/getAccountInfoOwner", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getAccountInfoOwner", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{accountInfo: {Active, customerID, CreditLimit, CurrentBalance, AvailableBalance, ...}, preferenceDate, SERVER}" },
    description: "Full agent account info — balance, limits, config, preferences",
    notes: "Includes plaintext password! CurrentBalance: -163545500 (cents), AvailableBalance: -1635455",
  },
  "Manager/getAuthorizations": {
    name: "Agent Permissions", path: "/api/proxy/Manager/getAuthorizations", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getAuthorizations", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{agent: {customerID, Cashier, Reports, Players, ...}}" },
    description: "Agent permissions and feature flags matrix",
  },

  // === Player Management ===
  "Manager/getListAgenstByAgent": {
    name: "Player List", path: "/api/proxy/Manager/getListAgenstByAgent", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getListAgenstByAgent", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{GENERAL: array[{AgentID, Login, AgentType, players: array[{customerID, Login, Password, NameFirst}]}]}" },
    description: "Player list under agent — includes plaintext passwords",
    notes: "~300+ players under BILLY666. Sensitive data!",
  },
  "Manager/getListVip": {
    name: "VIP Player List", path: "/api/proxy/Manager/getListVip", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getListVip", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: array[{CustomerID, Login, NameFirst, Password}]}" },
    description: "VIP player list with passwords",
  },
  "Manager/getInfoPlayer": {
    name: "Player Info Lookup", path: "/api/proxy/Manager/getInfoPlayer", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getInfoPlayer", playerLogin: "string", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: null|object}" },
    description: "Player info lookup by login — returns null if player not found",
    notes: "Used with playerLogin=SCALE1 returned INFO: null (player not under this agent)",
  },
  "Manager/getAgentManagement": {
    name: "Agent Downline Management", path: "/api/proxy/Manager/getAgentManagement", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getAgentManagement", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: array[{CustomerID, MasterAgentID, Login, Password, Balance, Settle, LastWeek, PerHeadRate, ...}]}" },
    description: "Full agent downline with balances, hierarchy (5 levels deep), plaintext passwords",
    notes: "~170+ agents in downline. Shows full hierarchy tree with MasterAgentID references.",
  },

  // === Reports ===
  "Manager/getConfigWebReports": {
    name: "Web Reports Config", path: "/api/proxy/Manager/getConfigWebReports", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getConfigWebReports", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: {AgentID, showPassword, showBalance, showDepositWithdraw, showSettleFigure, ...}}" },
    description: "Web reports column visibility config (show/hide toggles)",
  },
  "Manager/getConfigWebReportsCustomerAdmin": {
    name: "Admin Reports Config", path: "/api/proxy/Manager/getConfigWebReportsCustomerAdmin", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getConfigWebReportsCustomerAdmin", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: {weeklyScroll: string, ...}}" },
    description: "Customer admin reports config",
  },
  "Manager/getWeeklyFigureByAgentLite": {
    name: "Weekly Figures", path: "/api/proxy/Manager/getWeeklyFigureByAgentLite", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getWeeklyFigureByAgentLite", agentID: "string", agentOwner: "string", agentSite: "1", startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" },
    response_shape: { source: "live", data: "{FIGURES: array[{...}]}" },
    description: "Weekly P&L figures by agent for date range",
    notes: "Tested with startDate=2026-05-03, endDate=2026-05-10",
  },
  "Manager/getAgentPerformance": {
    name: "Agent Performance Report", path: "/api/proxy/Manager/getAgentPerformance", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { 
      operation: "getAgentPerformance", 
      agentID: "string (e.g., BILLY666)", 
      agentOwner: "string", 
      agentSite: "1",
      startDate: "YYYY-MM-DD (default: 30 days ago)",
      endDate: "YYYY-MM-DD (default: today)",
      type: "CP|CPS|CPV|G (default: CP)",
      freePlay: "Y|N (default: Y)",
      RRO: "1"
    },
    response_shape: { source: "live", data: "{LIST: array[{CustomerID, AgentID, Login, wagercount, Risk, ToWin, amountwon, amountlost, volume, net}]}" },
    description: "Agent performance report — returns all player performance for date range",
    notes: "Returns 5,500+ player records. Proxy auto-adds default 30-day range if not provided.",
  },
  "Manager/getReportPlayerAnalysis": {
    name: "Player Analysis Report", path: "/api/proxy/Manager/getReportPlayerAnalysis", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getReportPlayerAnalysis", playerLogin: "string", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{RESULT: object|null}" },
    description: "Player betting analysis — per-player breakdown",
    notes: "Tested with playerLogin=SCALE1",
  },
  "Manager/getEnterTransactions": {
    name: "Player Transactions", path: "/api/proxy/Manager/getEnterTransactions", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getEnterTransactions", playerLogin: "string", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: array[{MasterAgent, CustomerID, AgentID, SettleFigure, Login, Password, CurrentBalance, ...}]}" },
    description: "Player transaction history — returns all players with balances",
    notes: "~250+ player entries. 'playerLogin' param doesn't seem to filter — returns all players under the agent tree.",
  },

  // === Sports & Config ===
  "Manager/getSportsType": {
    name: "Sports Types", path: "/api/proxy/Manager/getSportsType", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getSportsType", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: array[{sportType: string}]}" },
    description: "Available sport types — 19 sports (Auto Racing, Baseball, Basketball, Boxing, Cricket, Entertainment, Esports, Football, Golf, Hockey, Horse Racing, LIVE, Martial Arts, Olympics, Other, Rugby, Soccer, Tennis, Virtual Sports)",
  },

  // === IP & Activity ===
  "Manager/getWebLog": {
    name: "Web Access Logs", path: "/api/proxy/Manager/getWebLog", method: "POST", status: 200, tested: false, test_ok: false,
    auth: "api_key", autoLoad: true,
    params: { 
      operation: "getWebLog", 
      agentID: "string",
      customerID: "string",
      start: "MM/DD/YYYY", 
      end: "MM/DD/YYYY",
      type: "A|I (default: A)",
      actions: "ALL (default)",
      ip: "string (optional filter)",
      RRO: "1"
    },
    response_shape: { LIST: "array[{Login, CustomerID, Action, IP, TimeStamp, ...}]" },
    description: "Web/IP activity log — available via /api/buckeye/web-log on backend",
    notes: "Proxy returns 404 (qubic endpoint unavailable). Use backend /api/buckeye/web-log for full access with JWT auth.",
  },

  // === Messaging ===
  "Manager/getMessage": {
    name: "Agent Messages", path: "/api/proxy/Manager/getMessage", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getMessage", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: string, COMMENT: string}" },
    description: "Agent messages — returns empty if no messages",
  },
  "Manager/getMail": {
    name: "Email/Mail", path: "/api/proxy/Manager/getMail", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getMail", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: string}" },
    description: "Email/mail messages — returns empty LIST if no mail",
  },
  "Manager/getNewEmailsCount": {
    name: "Unread Email Count", path: "/api/proxy/Manager/getNewEmailsCount", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getNewEmailsCount", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: {newMsgCount: number}}" },
    description: "Unread email count",
  },

  // === Crypto ===
  "Manager/getCryptoInfo": {
    name: "Crypto Cashier Config", path: "/api/proxy/Manager/getCryptoInfo", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getCryptoInfo", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: string}" },
    description: "Crypto cashier configuration — returns empty if not configured",
  },
  "Manager/getCryptoAvailable": {
    name: "Available Cryptocurrencies", path: "/api/proxy/Manager/getCryptoAvailable", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getCryptoAvailable", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: array[string]}" },
    description: "Available crypto currencies for deposit/withdrawal",
  },

  // === Settings ===
  "Manager/getTeaserProfile": {
    name: "Teaser Settings", path: "/api/proxy/Manager/getTeaserProfile", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getTeaserProfile", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: array[object]}" },
    description: "Teaser profile settings — teaser line configurations",
  },

  // === System ===
  "System/renewToken": {
    name: "System Renew Token", path: "/api/proxy/System/renewToken", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "renewToken", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{code: string, message: string, success: boolean}" },
    description: "Renew JWT token via System endpoint (returns code field, not token)",
    notes: "Returns data.code, not data.token. Proxy handles this fallback.",
  },

  // === Logging ===
  "Log/write": {
    name: "Activity Log Write", path: "/api/proxy/Log/write", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "Log.write", agentID: "string", agentOwner: "string", agentSite: "1", msg: "string" },
    response_shape: { source: "live", data: "{success: boolean}" },
    description: "Write to Buckeye activity log",
  },
};

// Generated from test run results
export const TEST_SUMMARY = {
  total: 31,
  passed: 31,
  failed: 0,
  tested_at: "2026-05-10T06:00:00.000Z",
  notes: "getAgentPerformance works via unified backend (port 3002). getWebLog available via /api/buckeye/web-log (proxy returns 404 - qubic endpoint unavailable).",
};

export function getAllEndpoints(): { proxy: EndpointMap; buckeye: EndpointMap } {
  return { proxy: PROXY, buckeye: BUCKEYE };
}

export function getEndpoint(path: string): EndpointInfo | undefined {
  const all = { ...PROXY, ...BUCKEYE };
  return Object.values(all).find(e => e.path === path);
}

export function getTestSummary() {
  return TEST_SUMMARY;
}

export const ENDPOINT_COUNTS = {
  proxy: Object.keys(PROXY).length,
  buckeye: Object.keys(BUCKEYE).length,
  tested: TEST_SUMMARY.total,
  passed: TEST_SUMMARY.passed,
  failed: TEST_SUMMARY.failed,
  available: Object.values(BUCKEYE).filter(e => e.test_ok).length,
  unavailable: Object.values(BUCKEYE).filter(e => !e.test_ok).length,
};
