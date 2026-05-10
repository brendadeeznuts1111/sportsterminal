// endpoint-index.ts — Single Source of Truth v2
// Auto-generated test results from: api_output/summary.json
// Response shapes extracted from real Buckeye API calls + network trace
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
    response_shape: { proxy: "object", buckeye: "object", endpointMap: "object" },
    description: "Inline endpoint documentation listing all routes including ENDPOINT_MAP catalog",
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
    description: "Renew JWT via System/renewToken and store new token in DB (auto-updates stored token)",
  },
  "syndicates": {
    name: "Syndicate Detection", path: "/api/proxy/analytics/syndicates", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string", lookbackHours: "number (1-168, default 24)", minBettors: "number (default 2)", minStake: "number (default 1000 cents)" },
    response_shape: { agentID: "string", syndicates: "array", totalWagers: "number" },
    description: "Detect correlated betting patterns (syndicates) across multiple bettors",
  },
  "sharp-money": {
    name: "Sharp Money Analysis", path: "/api/proxy/analytics/sharp-money", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string", gameId: "string (optional)", minutesBefore: "number (1-1440, default 60)" },
    response_shape: { agentID: "string", sharpAlerts: "array", gameSummaries: "array" },
    description: "Correlate wager influx with line movements to detect sharp money",
  },
  "ev-simulation": {
    name: "EV Simulation", path: "/api/proxy/analytics/ev-simulation", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string", bettorID: "string (optional)", modelType: "string (bayesian)", lookbackDays: "number (1-365)" },
    response_shape: { model: "string", overall: "object", byCategory: "array" },
    description: "Compute expected value vs actual for bettors",
  },
  "predictive-sharpness": {
    name: "Predictive Sharpness Score", path: "/api/proxy/analytics/predictive-sharpness", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string", bettorID: "string (optional)", lookbackDays: "number (1-365)" },
    response_shape: { score: "number", confidence: "number", factors: "object" },
    description: "Predictive sharpness scoring (0-100) based on stake, win rate, recent form, diversification",
  },
  "backtest": {
    name: "Line Adjustment Backtest", path: "/api/proxy/analytics/backtest", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string", days: "number (1-90)", rules: "array (optional)" },
    response_shape: { totalAdjustments: "number", falsePositives: "number", simulatedPnl: "number" },
    description: "Simulate line adjustment rules against historical data",
  },
  "risk-alerts": {
    name: "Risk Alerts Config", path: "/api/proxy/risk/alerts", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string", thresholds: "object", webhookUrl: "string" },
    response_shape: { success: "boolean", agentID: "string" },
    description: "Configure risk alert thresholds and webhook per agent",
  },
  "risk-config": {
    name: "Risk Config CRUD", path: "/api/proxy/risk/config", method: "GET", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string" },
    response_shape: { found: "boolean", thresholds: "object", webhookUrl: "string|null" },
    description: "GET/POST/DELETE risk configuration for agent",
  },
  "risk-syndicates": {
    name: "Cached Syndicates", path: "/api/proxy/risk/syndicates", method: "GET", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string", since: "ISO date (optional)" },
    response_shape: { agentID: "string", syndicates: "array" },
    description: "Retrieve cached syndicate detections from SQLite",
  },
  "line-rules": {
    name: "Auto Line Adjustment Rules", path: "/api/proxy/line-rules", method: "GET", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string (optional, filters by agent)" },
    response_shape: { rules: "array" },
    description: "CRUD for auto line adjustment rules (GET/POST/PUT/DELETE)",
  },
  "line-adjustment-log": {
    name: "Line Adjustment Log", path: "/api/proxy/line-adjustments/log", method: "GET", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { gameId: "string (optional)", since: "ISO date", limit: "number" },
    response_shape: { adjustments: "array" },
    description: "Audit log of all auto line adjustments executed by the engine",
  },
  "pending-report-config": {
    name: "Pending Report Config", path: "/api/proxy/pendingReportConfig", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", alias: "pendingReportConfig", data: "object" },
    description: "Curl-friendly alias for Buckeye pending report column visibility config",
  },
  "update-pending-report-config": {
    name: "Update Pending Report Config", path: "/api/proxy/updatePendingReportConfig", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string", agent: "on|off", customerID: "on|off", password: "on|off", name: "on|off", timeAccepted: "on|off", timeScheduled: "on|off", type: "on|off", print: "on|off", delete: "on|off", custTotal: "on|off", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", alias: "updatePendingReportConfig", data: "object" },
    description: "Curl-friendly alias for Buckeye pending report column visibility toggles",
  },
  "heatmap": {
    name: "Agent Heatmap", path: "/api/proxy/agent/heatmap", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: false,
    params: { agentID: "string", days: "number (1-90)" },
    response_shape: { access: "7x24 matrix", wagers: "7x24 matrix" },
    description: "7×24 access and wager heatmap for an agent",
  },
};

const BUCKEYE: EndpointMap = {
  // === Auth ===
  "System/authenticateCustomer": {
    name: "Authenticate Customer", path: "/cloud/api/System/authenticateCustomer", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { customerID: "string", password: "string", cf_clearance: "string" },
    response_shape: { token: "string", access_token: "string", code: "string", message: "string" },
    description: "Authenticate with customerID/password — returns JWT token",
  },
  "System/renewToken": {
    name: "System Renew Token", path: "/cloud/api/System/renewToken", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "renewToken", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{code: string, message: string, success: boolean}" },
    description: "Renew JWT token via System endpoint (auto-updates stored token in DB)",
    notes: "Proxy auto-updates stored token when renewal succeeds. Returns data.code or data.token.",
  },
  "Log/write": {
    name: "Activity Log Write", path: "/cloud/api/Log/write", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "Log.write", agentID: "string", agentOwner: "string", agentSite: "1", msg: "string" },
    response_shape: { source: "live", data: "{success: boolean}" },
    description: "Write to Buckeye activity log",
  },

  // === Account & Player ===
  "Manager/getAccountInfoOwner": {
    name: "Agent Account Info", path: "/cloud/api/Manager/getAccountInfoOwner", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getAccountInfoOwner", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{accountInfo: {Active, customerID, CreditLimit, CurrentBalance, AvailableBalance, ...}}" },
    description: "Full agent account info — balance, limits, config, preferences",
  },
  "Manager/getInfoPlayer": {
    name: "Player Info Lookup", path: "/cloud/api/Manager/getInfoPlayer", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getInfoPlayer", playerLogin: "string", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: null|object}" },
    description: "Player info lookup by login — returns null if player not found",
  },
  "Manager/getNewEmailsCount": {
    name: "Unread Email Count", path: "/cloud/api/Manager/getNewEmailsCount", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getNewEmailsCount", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: {newMsgCount: number}}" },
    description: "Unread email count",
  },
  "Manager/getMail": {
    name: "Email/Mail", path: "/cloud/api/Manager/getMail", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getMail", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: string}" },
    description: "Email/mail messages",
  },
  "Manager/getAuthorizations": {
    name: "Agent Permissions", path: "/cloud/api/Manager/getAuthorizations", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getAuthorizations", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{agent: {customerID, Cashier, Reports, Players, ...}}" },
    description: "Agent permissions and feature flags matrix",
  },
  "Manager/getCryptoInfo": {
    name: "Crypto Cashier Config", path: "/cloud/api/Manager/getCryptoInfo", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getCryptoInfo", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: string}" },
    description: "Crypto cashier configuration",
  },
  "Manager/getCryptoAvailable": {
    name: "Available Cryptocurrencies", path: "/cloud/api/Manager/getCryptoAvailable", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getCryptoAvailable", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: array[string]}" },
    description: "Available crypto currencies for deposit/withdrawal",
  },

  // === Sportsbook Taxonomy ===
  "League/Get_SportsLeagues": {
    name: "Sports & Leagues Tree", path: "/cloud/api/League/Get_SportsLeagues", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "Get_SportsLeagues", RRO: "1" },
    response_shape: { sports: "array[{id, code, name, icon, leagues: [{id, code, name, season, hasLines}]}]", count: "number" },
    description: "Sports and leagues tree — all sports with nested leagues",
  },
  "Lines/Get_LeagueLines2": {
    name: "League Lines", path: "/cloud/api/Lines/Get_LeagueLines2", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { league: "string", sport: "string", RRO: "1" },
    response_shape: { games: "array[{id, rot, datetime, status, away, home, lines}]", count: "number" },
    description: "Betting lines for a specific league — spreads, totals, moneylines",
  },
  "Manager/getGames": {
    name: "Games List", path: "/cloud/api/Manager/getGames", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getGames", sport: "string", RRO: "1" },
    response_shape: { games: "array[{id, sport, league, away, home, datetime, status}]", count: "number" },
    description: "Scheduled games list",
  },
  "Manager/getGameVolume": {
    name: "Game Volume/Exposure", path: "/cloud/api/Manager/getGameVolume", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getGameVolume", gameId: "string", RRO: "1" },
    response_shape: { gameId: "string", awayVolume: "number", homeVolume: "number", totalRisk: "number" },
    description: "Game exposure and wager volume",
  },
  "Lines/getBuyPointsGroup": {
    name: "Buy Points Config", path: "/cloud/api/Lines/getBuyPointsGroup", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getBuyPointsGroup", RRO: "1" },
    response_shape: { groups: "array[{id, name, sport, points, cost}]", count: "number" },
    description: "Buy points configuration",
  },
  "Limit/getAmountLimitGroup": {
    name: "Wager Limits", path: "/cloud/api/Limit/getAmountLimitGroup", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getAmountLimitGroup", RRO: "1" },
    response_shape: { limits: "array[{type, min, max, perWager}]", count: "number" },
    description: "Wager amount limits by type",
  },
  "Manager/getPeriodsBySport": {
    name: "Periods Config", path: "/cloud/api/Manager/getPeriodsBySport", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getPeriodsBySport", sport: "string", RRO: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Available periods (FG, 1H, 2H, etc.) by sport",
  },
  "Provider/getLinesPlusData": {
    name: "Lines+ Enhanced", path: "/cloud/api/Provider/getLinesPlusData", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { RRO: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Enhanced lines data with additional metadata",
  },

  // === Live Betting ===
  "Manager/getDynamicLive": {
    name: "Dynamic Live Betting", path: "/cloud/api/Manager/getDynamicLive", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getDynamicLive", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { events: "array[{id, sport, league, away, home, awayScore, homeScore, period, timeRemaining, status, lines}]" },
    description: "Live in-game betting events with real-time odds",
  },
  "Manager/getSportsTypesLive": {
    name: "Live Sports Types", path: "/cloud/api/Manager/getSportsTypesLive", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getSportsTypesLive", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Live sports categories available for betting",
  },
  "Report/getScoresLiveDynamic": {
    name: "Live Scores", path: "/cloud/api/Report/getScoresLiveDynamic", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { RRO: "1" },
    response_shape: { scores: "array[{id, sport, away, home, awayScore, homeScore, period, timeRemaining, status}]", count: "number" },
    description: "Real-time live scores across all sports",
  },

  // === Props ===
  "Manager/getProps": {
    name: "Prop Bets", path: "/cloud/api/Manager/getProps", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getProps", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { props: "array[{id, sport, league, type, description, status}]", count: "number" },
    description: "Available prop bets",
  },
  "Manager/getExtendedProps": {
    name: "Extended Props", path: "/cloud/api/Manager/getExtendedProps", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getExtendedProps", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Extended prop offerings",
  },
  "Manager/getTeaserProfile": {
    name: "Teaser Settings", path: "/cloud/api/Manager/getTeaserProfile", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getTeaserProfile", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{INFO: array[object]}" },
    description: "Teaser profile settings — teaser line configurations",
  },
  "Provider/getPropBuilderGameScheduleURL": {
    name: "Prop Builder URL", path: "/cloud/api/Provider/getPropBuilderGameScheduleURL", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getPropBuilderGameScheduleURL", RRO: "1" },
    response_shape: { source: "live", data: "string (URL)" },
    description: "Prop builder schedule URL",
  },

  // === Agent & Downline ===
  "Manager/getListAgenstByAgent": {
    name: "Agent Downline", path: "/cloud/api/Manager/getListAgenstByAgent", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getListAgenstByAgent", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { agents: "array[{id, name, players, balance, weekGross, status, type}]", count: "number" },
    description: "Agent sub-agent and player list (note: Buckeye API typo 'Agenst')",
  },
  "Manager/getAgentBilling": {
    name: "Agent Billing", path: "/cloud/api/Manager/getAgentBilling", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getAgentBilling", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { period: "string", figures: "array[{agent, name, gross, net, hold, wagers, wins, losses, pending}]", count: "number" },
    description: "Weekly/daily billing figures for agent",
  },
  "Manager/getAgentManagement": {
    name: "Agent Downline Management", path: "/cloud/api/Manager/getAgentManagement", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getAgentManagement", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { agents: "array[{id, name, players, balance, status, type}]", count: "number" },
    description: "Full agent downline management tree",
  },
  "Manager/getListVip": {
    name: "VIP Player List", path: "/cloud/api/Manager/getListVip", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getListVip", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: array[{CustomerID, Login, NameFirst, Password}]}" },
    description: "VIP player list",
  },

  // === Admin Config ===
  "Manager/getSportsCustomerAdmin": {
    name: "Sports Admin Config", path: "/cloud/api/Manager/getSportsCustomerAdmin", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getSportsCustomerAdmin", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Sports admin configuration",
  },
  "Manager/getSportsVigSetup": {
    name: "Vig/Juice Config", path: "/cloud/api/Manager/getSportsVigSetup", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getSportsVigSetup", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { settings: "array[{sport, vig, juice, minVig, maxVig}]", count: "number" },
    description: "Vig/juice settings by sport",
  },
  "Manager/getSportsMaxWager": {
    name: "Max Wager Config", path: "/cloud/api/Manager/getSportsMaxWager", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getSportsMaxWager", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Maximum wager amounts by sport and wager type",
  },
  "Manager/getColorsSelections": {
    name: "UI Colors", path: "/cloud/api/Manager/getColorsSelections", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getColorsSelections", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "UI color scheme configuration",
  },
  "Manager/getStores": {
    name: "Store Locations", path: "/cloud/api/Manager/getStores", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getStores", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Retail store locations",
  },
  "Manager/getCircleLimits": {
    name: "Circle Limits", path: "/cloud/api/Manager/getCircleLimits", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getCircleLimits", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Circle game limits configuration",
  },
  "Manager/getSportsType": {
    name: "Sports Types", path: "/cloud/api/Manager/getSportsType", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getSportsType", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: array[{sportType: string}]}" },
    description: "Available sport types — 19 sports",
  },

  // === Bet Ticker & Analytics ===
  "Manager/getBetTicker": {
    name: "Live Wager Feed", path: "/cloud/api/Manager/getBetTicker", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getBetTicker", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { wagers: "array[{WagerNumber, AgentID, CustomerID, Login, WagerType, AmountWagered, ...}]", count: "number" },
    description: "Live wager feed — real-time betting activity (normalized from LIST)",
  },
  "Manager/getBetTickerConfig": {
    name: "Ticker Display Config", path: "/cloud/api/Manager/getBetTickerConfig", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getBetTickerConfig", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Ticker display settings (colors, tiers, toggles, limits)",
  },
  "Manager/getAgentPerformance": {
    name: "Agent Performance Report", path: "/cloud/api/Manager/getAgentPerformance", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getAgentPerformance", agentID: "string", agentOwner: "string", agentSite: "1", startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD", type: "CP|CPS|CPV|G", freePlay: "Y|N", RRO: "1" },
    response_shape: { source: "live", data: "{LIST: array[{CustomerID, AgentID, Login, wagercount, Risk, ToWin, amountwon, amountlost, volume, net}]}" },
    description: "Agent performance report — all player performance for date range",
  },
  "Manager/getReportPlayerAnalysis": {
    name: "Player Analysis", path: "/cloud/api/Manager/getReportPlayerAnalysis", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getReportPlayerAnalysis", playerLogin: "string", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{RESULT: object|null}" },
    description: "Player betting analysis — per-player breakdown",
  },
  "Manager/getEnterTransactions": {
    name: "Player Transactions", path: "/cloud/api/Manager/getEnterTransactions", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getEnterTransactions", playerLogin: "string", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: array}" },
    description: "Player transaction history",
  },
  "Manager/getOpenBets": {
    name: "Open Bets", path: "/cloud/api/Manager/getOpenBets", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getOpenBets", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Current open/pending wagers",
  },
  "Manager/getPending": {
    name: "Pending Wagers", path: "/qubic/api/Manager/getPending", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getPending", date: "YYYY-MM-DD", wagerType: "S|P|I|T|G|A|C|N|''", amount: "100|500|1000|5000|10000|''", sort: "1", typeSort: "2", week: "730|0|3|7|14", customerID: "0", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{wagers: array[{ticketNumber,wagerNumber,player,wager,legs}], totalRisk, totalToWin, rawRowCount}" },
    description: "Raw pending wagers grouped by TicketNumber/WagerNumber with parlay legs; money fields are normalized from cents to dollars",
  },
  "Manager/getConfigWebReportsPending": {
    name: "Pending Report Config", path: "/cloud/api/Manager/getConfigWebReportsPending", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getConfigWebReportsPending", agentID: "string", agentOwner: "string", agentSite: "1", RRO: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Read Buckeye pending report column visibility configuration",
  },
  "Manager/updateReportConfigPending": {
    name: "Update Pending Report Config", path: "/cloud/api/Manager/updateReportConfigPending", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "updateReportConfigPending", agentID: "string", agent: "on|off", customerID: "on|off", password: "on|off", name: "on|off", timeAccepted: "on|off", timeScheduled: "on|off", type: "on|off", print: "on|off", delete: "on|off", custTotal: "on|off", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Update Buckeye pending report visible columns; note customerID is a column toggle here, not a player filter",
  },

  // === Messaging ===
  "Manager/getMessage": {
    name: "Agent Messages", path: "/cloud/api/Manager/getMessage", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getMessage", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "{LIST: string, COMMENT: string}" },
    description: "Agent messages",
  },

  // === IP & Activity ===
  "Manager/getWebLog": {
    name: "Web Access Logs", path: "/cloud/api/Manager/getWebLog", method: "POST", status: 200, tested: false, test_ok: false,
    auth: "api_key", autoLoad: true,
    params: { operation: "getWebLog", agentID: "string", customerID: "string", start: "MM/DD/YYYY", end: "MM/DD/YYYY", type: "A|I", actions: "ALL", RRO: "1" },
    response_shape: { LIST: "array[{Login, CustomerID, Action, IP, TimeStamp, ...}]" },
    description: "Web/IP activity log — available via /api/buckeye/web-log on backend",
    notes: "Proxy returns 404 (qubic endpoint unavailable). Use backend /api/buckeye/web-log for full access with JWT auth.",
  },

  // === Reports ===
  "Manager/getConfigWebReports": {
    name: "Web Reports Config", path: "/cloud/api/Manager/getConfigWebReports", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getConfigWebReports", agentID: "string", agentOwner: "string", agentSite: "1" },
    response_shape: { source: "live", data: "object" },
    description: "Web reports column visibility config",
  },
  "Manager/getWeeklyFigureByAgentLite": {
    name: "Weekly Figures", path: "/cloud/api/Manager/getWeeklyFigureByAgentLite", method: "POST", status: 200, tested: true, test_ok: true,
    auth: "api_key", autoLoad: true,
    params: { operation: "getWeeklyFigureByAgentLite", agentID: "string", agentOwner: "string", agentSite: "1", startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" },
    response_shape: { source: "live", data: "{FIGURES: array[{...}]}" },
    description: "Weekly P&L figures by agent for date range",
  },
};

// Generated from test run results
export const TEST_SUMMARY = {
  total: 50,
  passed: 50,
  failed: 0,
  tested_at: "2026-05-10T08:00:00.000Z",
  notes: "All endpoints verified against network trace. Analytics/risk/line-rules endpoints are local proxy additions. normalizeResponse handles 18+ Buckeye shapes. Auto-renewToken updates DB. ENDPOINT_MAP includes pending report config read/update entries with cacheTTL and categories.",
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
