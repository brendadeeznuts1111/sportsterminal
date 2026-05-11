// proxy-enhanced.ts — Production Buckeye PPH Proxy (Bun-native)
// Merged features: CircuitBreaker, apiKeyAuth, SWR cache, special handlers,
// renewToken, status, endpoints, openapi.json, dashboard, request tracking,
// JWT auth, per-endpoint rate limiting, token scheduling, idempotency
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { randomUUIDv7 } from "bun";
import { estimateShallowMemoryUsageOf, heapStats as jscHeapStats } from "bun:jsc";
import { Database } from "bun:sqlite";
import { watch } from "node:fs";
import { z } from "zod";
import { CONFIG, initConfig, reloadFromEnv } from "./config";
import { ENDPOINT_COUNTS, TEST_SUMMARY, getAllEndpoints } from "./endpoint-index";
import { CircuitBreaker, atomicWrite, logger, requestContext, hashPayload as utilsHashPayload } from "./utils";
import {
  buildBrowserHeaders,
  buildServiceHeaders,
  prewarmNetworkTargets as connectionPrewarmNetworkTargets,
  enrichDnsStats,
  getApiFingerprintHeader,
  getDnsCacheStats,
  type WarmupBenchmark
} from "./utils/connection";
import { fetchWithTimeout } from "./utils/fetchWithTimeout";
import { PROXY_SECRET_NAMES, deleteManagedSecret, extractCfClearanceValue, getManagedSecret, getManagedSecretNames, getScopedSecret, proxySecretEnvFallback, setManagedSecret, setScopedSecret, shouldUseKeychain } from "./utils/secrets";

await initConfig();

// ==========================================
// CONSTANTS (was magic numbers scattered)
// ==========================================
const PROXY_CONSTANTS = {
  TRACE_MAX_SPANS: 1000,
  RISK_ENGINE_INTERVAL_MS: 30000,
  LINE_ADJUSTMENT_INTERVAL_MS: 60000,
  LOG_PRUNE_THRESHOLD: 50000,
  LOG_PRUNE_BATCH: 10000,
  LOG_PRUNE_INTERVAL_MS: 3600000,
  WAL_CHECKPOINT_INTERVAL_MS: 3600000,
  IDEMPOTENCY_TTL_SECONDS: 86400,
  TOKEN_EXPIRY_SECONDS: 7200,
  COMPRESSION_THRESHOLD_BYTES: 1024,
  WRITE_OPTIMIZE_COUNTER: 1000,
  DB_BUSY_TIMEOUT_MS: 5000,
  DB_BUSY_TIMEOUT_PROXY_MS: 30000,
  SPEED_SCORE_FAST_MS: 60000,
  SPEED_SCORE_MEDIUM_MS: 180000,
  RECONNECT_DELAY_MS: 3000,
  RECONNECT_MAX_DELAY_MS: 30000,
  WS_BATCH_MIN_MS: 100,
  WS_BATCH_MAX_MS: 5000,
  WS_IDLE_TIMEOUT_SECONDS: 600,
  ADMIN_REFRESH_INTERVAL_MS: 10000,
  WS_MAX_PAYLOAD_LENGTH_BYTES: 1024 * 1024,
  BACKPRESSURE_LIMIT_BYTES: 8 * 1024 * 1024,
  KIMI_API_ORIGIN: "https://api.moonshot.cn",
  KIMI_API_PORT: 443,
  OTEL_EXPORT_INTERVAL_MS: 10000,
  RETRY_MAX_DELAY_MS: 10000,
  SYNDICATE_MIN_STAKE: 1000,
  SYNDICATE_TIME_WINDOW_MS: 300000,
  HIGH_ROLLER_STAKE: 2000,
} as const;

type JsonObject = Record<string, unknown>;

interface TokenRow extends JsonObject {
  customerID: string;
  cf_clearance: string | null;
  bearer_token: string | null;
  created_at: number;
  expires_at: number;
}

interface ProxyCredentialValues {
  password?: string;
  cfClearance?: string;
}

interface CacheRow extends JsonObject {
  response_json: string;
  cached_at: number;
  ttl_seconds: number;
}

interface CountRow {
  count: number;
}

interface WsData {
  url: string;
  reqId?: string;
  customerID?: string;
  authenticated?: boolean;
  connectedAt?: number;
}



const networkWarmups: WarmupBenchmark[] = await connectionPrewarmNetworkTargets([
  CONFIG.baseUrl,
  PROXY_CONSTANTS.KIMI_API_ORIGIN,
  CONFIG.backendUrl,
  `http://localhost:${CONFIG.port}`,
]);
logger.info("Network warmup complete", { targets: networkWarmups });

interface IdempotencyRow {
  status: number;
  response_json: string;
  created_at: number;
}

interface TaxonomyConfig {
  endpoint: string;
  cacheTtl: number;
  shape: string;
}

type TaxonomyLevel = "sports" | "leagues" | "schedule" | "lines" | "periods" | "gametypes";
type TaxonomyRecord = Record<string, unknown>;
type PerformancePeriod = "daily" | "weekly";
type ProxyAliasName = "sportsLeagues" | "leagueLines" | "agentDownline" | "agentBilling" | "playerInfo" | "dynamicLive" | "gameVolume" | "pendingReportConfig" | "updatePendingReportConfig";

interface ProxyAliasCandidate {
  endpoint: string;
  operation: string;
  defaults?: JsonObject;
}

interface ProxyAliasParam {
  required: string[];
  optional: string[];
  example: JsonObject;
}

interface AgentSummary {
  id: string;
  name: string;
  level: number;
  parent: string;
  totalBets: number;
  totalWagered: number;
  netProfit: number;
  commission: number;
  activeCount: number;
  lastActive: string;
}

interface PerformanceBucket {
  date: string;
  startDate: string;
  endDate: string;
  bets: number;
  wager: number;
  win: number;
  loss: number;
  net: number;
  commission: number;
  customers: number;
}

// ==========================================
// OTEL TRACE COLLECTOR (Enhancement — OTLP export)
// ==========================================
interface TraceSpan {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  status: "UNSET" | "OK" | "ERROR";
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
}

class TraceCollector {
  private spans: TraceSpan[] = [];
  private maxSpans = PROXY_CONSTANTS.TRACE_MAX_SPANS;
  private exporting = false;

  startSpan(name: string, parentId?: string, attributes?: Record<string, unknown>): { spanId: string; end: (status?: "OK" | "ERROR", attrs?: Record<string, unknown>) => void } {
    const traceId = randomUUIDv7().replace(/-/g, "");
    const spanId = randomUUIDv7().replace(/-/g, "").slice(0, 16);
    const span: TraceSpan = {
      traceId,
      spanId,
      parentId,
      name,
      startTime: Date.now(),
      status: "UNSET",
      attributes: attributes ? Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v)])) : {},
      events: [],
    };
    this.spans.push(span);
    if (this.spans.length > this.maxSpans) this.spans.shift();
    return {
      spanId,
      end: (status = "OK", attrs) => {
        span.endTime = Date.now();
        span.status = status;
        if (attrs) Object.assign(span.attributes, Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v)])));
      },
    };
  }

  addEvent(spanId: string, name: string, attributes?: Record<string, unknown>) {
    const span = this.spans.find(s => s.spanId === spanId);
    if (span) span.events.push({ name, timestamp: Date.now(), attributes });
  }

  getRecent(limit = 100): TraceSpan[] {
    return this.spans.slice(-limit);
  }

  prettyPrint(limit = 20): string {
    const recent = this.getRecent(limit);
    if (recent.length === 0) return "No trace spans recorded.";
    const lines = recent.map((s, i) => {
      const duration = s.endTime ? `${(s.endTime - s.startTime).toFixed(2)}ms` : "incomplete";
      const attrs = Object.entries(s.attributes).map(([k, v]) => `${k}=${v}`).join(", ");
      return `  ${i + 1}. [${s.status}] ${s.name} | ${duration} | traceId=${s.traceId.slice(0, 8)}… | ${attrs}`;
    });
    return `Trace Spans (last ${recent.length}):\n${lines.join("\n")}`;
  }

  async export() {
    if (!CONFIG.otel.enabled || this.exporting || this.spans.length === 0) return;
    this.exporting = true;
    try {
      const finished = this.spans.filter(s => s.endTime !== undefined);
      if (finished.length === 0) return;
      const resourceSpans = [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: CONFIG.otel.serviceName } }] },
        scopeSpans: [{
          scope: { name: "buckeye-proxy", version: "2.0" },
          spans: finished.map(s => ({
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentId || undefined,
            name: s.name,
            kind: 1,
            startTimeUnixNano: String(Math.floor(s.startTime * 1e6)),
            endTimeUnixNano: String(Math.floor((s.endTime || s.startTime) * 1e6)),
            attributes: Object.entries(s.attributes).map(([k, v]) => ({ key: k, value: typeof v === "number" ? { intValue: v } : typeof v === "boolean" ? { boolValue: v } : { stringValue: v } })),
            status: { code: s.status === "ERROR" ? 2 : s.status === "OK" ? 1 : 0 },
            events: s.events.map(e => ({ name: e.name, timeUnixNano: String(Math.floor(e.timestamp * 1e6)), attributes: [] })),
          })),
        }],
      }];
      const body = JSON.stringify({ resourceSpans });
      const res = await fetch(CONFIG.otel.endpoint, {
        method: "POST",
        headers: buildServiceHeaders(),
        body,
      }).catch(() => undefined);
      if (res && res.ok) {
        this.spans = this.spans.filter(s => s.endTime === undefined);
      }
    } catch (e) {
      console.warn("[Proxy] OTel export failed:", e);
    } finally {
      this.exporting = false;
    }
  }
}

const tracer = new TraceCollector();

// ==========================================
// REQUEST LISTENER (in-memory ring buffer)
// ==========================================
interface RequestEvent {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  customerID: string | null;
  error: string | null;
}

class RequestListener {
  private buffer: RequestEvent[] = [];
  private maxSize = 500;

  push(ev: RequestEvent) {
    this.buffer.push(ev);
    if (this.buffer.length > this.maxSize) this.buffer.shift();
  }

  getRecent(limit = 100): RequestEvent[] {
    return this.buffer.slice(-limit).reverse();
  }

  getStats(minutes = 5): { total: number; errors: number; avgDuration: number; topPaths: Array<{ path: string; count: number }> } {
    const cutoff = Date.now() - minutes * 60000;
    const recent = this.buffer.filter(e => e.timestamp >= cutoff);
    const total = recent.length;
    const errors = recent.filter(e => e.status >= 400).length;
    const avgDuration = total > 0 ? Math.round(recent.reduce((s, e) => s + e.durationMs, 0) / total) : 0;
    const pathCounts = new Map<string, number>();
    for (const e of recent) pathCounts.set(e.path, (pathCounts.get(e.path) || 0) + 1);
    const topPaths = Array.from(pathCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([path, count]) => ({ path, count }));
    return { total, errors, avgDuration, topPaths };
  }

  prettyPrint(limit = 20): string {
    const recent = this.getRecent(limit);
    if (recent.length === 0) return "No request events recorded.";
    const lines = recent.map((e, i) => {
      const time = new Date(e.timestamp).toISOString().split("T")[1].slice(0, 8);
      const err = e.error ? ` | ERROR: ${e.error}` : "";
      const dur = `${e.durationMs}ms`;
      return `  ${i + 1}. [${time}] ${e.method} ${e.path} → ${e.status} (${dur}) | id=${e.id.slice(0, 8)}…${err}`;
    });
    return `Request Events (last ${recent.length}):\n${lines.join("\n")}`;
  }
}

const requestListener = new RequestListener();

interface PerformanceReport {
  period: PerformancePeriod;
  data: PerformanceBucket[];
  totals: Omit<PerformanceBucket, "date" | "startDate" | "endDate">;
}

interface StoredWagerAnalytic {
  bettorId: string;
  gameId: string;
  wagerType: string;
  side: string;
  line: number;
  odds: number;
  stake: number;
  profit: number;
  sport: string;
  timestamp: number;
}

interface Syndicate {
  id: string;
  members: string[];
  commonGame: string;
  pattern: string;
  totalStake: number;
  timestamp: number;
  windowMs?: number;
  wagerCount?: number;
  avgStake?: number;
  riskScore?: number;
  confidence?: number;
  signals?: string[];
}

interface IntegrityCaseRow {
  id: string;
  agentID: string;
  syndicateId: string | null;
  status: string;
  priority: string;
  title: string;
  summary: string | null;
  evidence: string | null;
  reviewer: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

interface LineMove {
  gameId: string;
  timestamp: number;
  lineType: string;
  side: string;
  oldLine: number;
  newLine: number;
  oldOdds: number;
  newOdds: number;
}

interface SharpAlert {
  gameId: string;
  movement: LineMove;
  correlatedBettors: string[];
  totalStake: number;
  confidence: number;
}

const AUTH_ENDPOINT = CONFIG.authEndpoint;
const TAXONOMY_MAP: Record<TaxonomyLevel, TaxonomyConfig> = {
  sports: { endpoint: "System/getSports", cacheTtl: 3600, shape: "Sport[]" },
  leagues: { endpoint: "System/getLeagues", cacheTtl: 1800, shape: "League[]" },
  schedule: { endpoint: "Manager/getSchedule", cacheTtl: 300, shape: "Game[]" },
  lines: { endpoint: "Manager/getLines", cacheTtl: 60, shape: "Line[]" },
  periods: { endpoint: "Manager/getPeriods", cacheTtl: 600, shape: "Period[]" },
  gametypes: { endpoint: "System/getGameTypes", cacheTtl: 3600, shape: "GameType[]" },
};
const PENDING_REPORT_CONFIG_DEFAULTS: JsonObject = {
  agent: "on",
  customerID: "on",
  password: "off",
  name: "on",
  timeAccepted: "on",
  timeScheduled: "on",
  type: "on",
  print: "on",
  delete: "off",
  custTotal: "off",
  agentSite: "1",
};
const PROXY_ALIAS_MAP: Record<ProxyAliasName, ProxyAliasCandidate[]> = {
  sportsLeagues: [
    { endpoint: "Manager/getSportsType", operation: "getSportsType", defaults: { agentSite: "1" } },
    { endpoint: "System/getSports", operation: "getSports" },
    { endpoint: "System/getLeagues", operation: "getLeagues" },
  ],
  leagueLines: [
    { endpoint: "Manager/getLines", operation: "getLines" },
    { endpoint: "Manager/getSchedule", operation: "getSchedule" },
  ],
  agentDownline: [
    { endpoint: "Manager/getListAgenstByAgent", operation: "getListAgenstByAgent", defaults: { agentType: "M", agentSite: "1" } },
  ],
  agentBilling: [
    { endpoint: "Manager/getAgentBilling", operation: "getAgentBilling", defaults: { agentSite: "1", week: "0" } },
  ],
  playerInfo: [
    { endpoint: "System/getPlayerActivity", operation: "getPlayerActivity" },
    { endpoint: "Manager/getBettorDetails", operation: "getBettorDetails", defaults: { agentSite: "1" } },
    { endpoint: "Manager/getReportPlayerAnalysis", operation: "getReportPlayerAnalysis", defaults: { agentSite: "1" } },
  ],
  dynamicLive: [
    { endpoint: "Manager/getDynamicLines", operation: "getDynamicLines" },
    { endpoint: "Manager/getLiveLines", operation: "getLiveLines" },
    { endpoint: "Manager/getBetTicker", operation: "getBetTicker" },
  ],
  gameVolume: [
    { endpoint: "Manager/getGameVolume", operation: "getGameVolume" },
    { endpoint: "Manager/getGameExposure", operation: "getGameExposure" },
    { endpoint: "Manager/getWagerByGame", operation: "getWagerByGame" },
  ],
  pendingReportConfig: [
    { endpoint: "Manager/getConfigWebReportsPending", operation: "getConfigWebReportsPending", defaults: { agentSite: "1" } },
  ],
  updatePendingReportConfig: [
    { endpoint: "Manager/updateReportConfigPending", operation: "updateReportConfigPending", defaults: PENDING_REPORT_CONFIG_DEFAULTS },
  ],
  playerDetails: [
    { endpoint: "Manager/getPlayerDetails", operation: "getPlayerDetails", defaults: { agentSite: "1" } },
    { endpoint: "Manager/getInfoPlayer", operation: "getInfoPlayer", defaults: { agentSite: "1" } },
  ],
  playerLimits: [
    { endpoint: "Manager/getPlayerLimits", operation: "getPlayerLimits", defaults: { agentSite: "1" } },
  ],
  searchCustomer: [
    { endpoint: "Manager/searchCustomerAdmin", operation: "searchCustomerAdmin", defaults: { agentSite: "1" } },
  ],
  notifySettings: [
    { endpoint: "Manager/getAddedInfo", operation: "getAddedInfo" },
    { endpoint: "Manager/saveNotifyAgent", operation: "saveNotifyAgent" },
  ],
  playerStatus: [
    { endpoint: "Manager/updatePlayerStatus", operation: "updatePlayerStatus", defaults: { agentSite: "1" } },
  ],
};
const PROXY_ALIAS_PARAMS: Record<ProxyAliasName, ProxyAliasParam> = {
  sportsLeagues: {
    required: ["token", "cf_clearance"],
    optional: ["agentID", "customerID"],
    example: { token: "...", cf_clearance: "...", agentID: "BILLY666" },
  },
  leagueLines: {
    required: ["token", "cf_clearance", "league", "sport"],
    optional: ["agentID", "customerID", "period", "live", "gameId"],
    example: { token: "...", cf_clearance: "...", league: "NFL", sport: "NFL" },
  },
  agentDownline: {
    required: ["token", "cf_clearance", "agentID"],
    optional: ["customerID", "agentType", "agentOwner", "agentSite"],
    example: { token: "...", cf_clearance: "...", agentID: "BILLY666" },
  },
  agentBilling: {
    required: ["token", "cf_clearance", "agentID"],
    optional: ["customerID", "agentSite", "week", "startDate", "endDate"],
    example: { token: "...", cf_clearance: "...", agentID: "BILLY666", week: "0" },
  },
  playerInfo: {
    required: ["token", "cf_clearance", "playerID"],
    optional: ["agentID", "customerID", "bettorID", "startDate", "endDate"],
    example: { token: "...", cf_clearance: "...", playerID: "PLAYER123" },
  },
  dynamicLive: {
    required: ["token", "cf_clearance"],
    optional: ["agentID", "customerID", "sport", "league", "live"],
    example: { token: "...", cf_clearance: "..." },
  },
  gameVolume: {
    required: ["token", "cf_clearance", "gameId"],
    optional: ["agentID", "customerID", "sport", "league", "GameID"],
    example: { token: "...", cf_clearance: "...", gameId: "12345" },
  },
  pendingReportConfig: {
    required: ["token", "cf_clearance", "agentID"],
    optional: ["agentOwner", "agentSite", "__cf_bm"],
    example: { token: "...", cf_clearance: "...", agentID: "BILLY666" },
  },
  updatePendingReportConfig: {
    required: ["token", "cf_clearance", "agentID"],
    optional: ["agent", "customerID", "password", "name", "timeAccepted", "timeScheduled", "type", "print", "delete", "custTotal", "agentOwner", "agentSite", "__cf_bm"],
    example: { token: "...", cf_clearance: "...", agentID: "BILLY666", customerID: "on", password: "off" },
  },
  playerDetails: {
    required: ["token", "cf_clearance", "playerID"],
    optional: ["agentID", "agentOwner", "agentSite"],
    example: { token: "...", cf_clearance: "...", playerID: "PLAYER123" },
  },
  playerLimits: {
    required: ["token", "cf_clearance", "playerID"],
    optional: ["agentID", "agentOwner", "agentSite"],
    example: { token: "...", cf_clearance: "...", playerID: "PLAYER123" },
  },
  searchCustomer: {
    required: ["token", "cf_clearance", "agentID", "filter"],
    optional: ["agentOwner", "agentSite"],
    example: { token: "...", cf_clearance: "...", agentID: "BILLY666", filter: "john" },
  },
  notifySettings: {
    required: ["token", "cf_clearance", "customerID"],
    optional: ["telegramID", "email", "minimum"],
    example: { token: "...", cf_clearance: "...", customerID: "BILLY666" },
  },
  playerStatus: {
    required: ["token", "cf_clearance", "playerID", "status"],
    optional: ["agentID", "agentOwner", "agentSite"],
    example: { token: "...", cf_clearance: "...", playerID: "PLAYER123", status: "active" },
  },
};

type RequiredParamSpec = string | string[];

const REQUIRED_ENDPOINT_PARAMS: Record<string, RequiredParamSpec[]> = {
  leagueLines: ["league", "sport"],
  "Lines/Get_LeagueLines2": ["league", "sport"],
  playerInfo: [["playerID", "playerLogin", "bettorID", "customerID", "acc"]],
  "Manager/getInfoPlayer": [["playerLogin", "playerID", "bettorID", "customerID", "acc"]],
  agentPerformance: [["agentID", "customerID"]],
  "Manager/getAgentPerformance": [["agentID", "customerID"]],
  getAgentPerformance: [["agentID", "customerID"]],
  gameVolume: [["gameId", "GameID", "gameID"]],
  "Manager/getGameVolume": [["gameId", "GameID", "gameID"]],
  pending: ["date"],
  getPending: ["date"],
  "Manager/getPending": ["date"],
  pendingReportConfig: [["agentID", "customerID"]],
  updatePendingReportConfig: [["agentID", "customerID"]],
};

const DEMO_ENDPOINT_KEYS = new Set([
  "accountInfo",
  "agentDownline",
  "agentBilling",
  "betTicker",
  "dynamicLive",
  "gameVolume",
  "leagueLines",
  "pending",
  "playerInfo",
]);

// ==========================================
// COMPLETE BUCKEYE ENDPOINT MAP (from network trace)
// ==========================================
const ENDPOINT_MAP: Record<string, { path: string; cacheTtl: number; category: string }> = {
  auth: { path: "System/authenticateCustomer", cacheTtl: 0, category: "auth" },
  renewToken: { path: "System/renewToken", cacheTtl: 0, category: "auth" },
  logWrite: { path: "Log/write", cacheTtl: 0, category: "telemetry" },
  accountInfo: { path: "Manager/getAccountInfoOwner", cacheTtl: 60, category: "account" },
  playerInfo: { path: "Manager/getInfoPlayer", cacheTtl: 120, category: "player" },
  newEmails: { path: "Manager/getNewEmailsCount", cacheTtl: 30, category: "account" },
  mail: { path: "Manager/getMail", cacheTtl: 60, category: "account" },
  cryptoInfo: { path: "Manager/getCryptoInfo", cacheTtl: 300, category: "banking" },
  authorizations: { path: "Manager/getAuthorizations", cacheTtl: 300, category: "admin" },
  sportsLeagues: { path: "League/Get_SportsLeagues", cacheTtl: 3600, category: "taxonomy" },
  leagueLines: { path: "Lines/Get_LeagueLines2", cacheTtl: 60, category: "lines" },
  games: { path: "Manager/getGames", cacheTtl: 300, category: "taxonomy" },
  gameVolume: { path: "Manager/getGameVolume", cacheTtl: 30, category: "lines" },
  periodsBySport: { path: "Manager/getPeriodsBySport", cacheTtl: 3600, category: "config" },
  buyPoints: { path: "Lines/getBuyPointsGroup", cacheTtl: 3600, category: "config" },
  amountLimits: { path: "Limit/getAmountLimitGroup", cacheTtl: 3600, category: "config" },
  linesPlus: { path: "Provider/getLinesPlusData", cacheTtl: 60, category: "lines" },
  propBuilderURL: { path: "Provider/getPropBuilderGameScheduleURL", cacheTtl: 300, category: "props" },
  dynamicLive: { path: "Manager/getDynamicLive", cacheTtl: 10, category: "live" },
  sportsTypesLive: { path: "Manager/getSportsTypesLive", cacheTtl: 60, category: "live" },
  scoresLive: { path: "Report/getScoresLiveDynamic", cacheTtl: 15, category: "live" },
  props: { path: "Manager/getProps", cacheTtl: 300, category: "props" },
  extendedProps: { path: "Manager/getExtendedProps", cacheTtl: 300, category: "props" },
  teaserProfile: { path: "Manager/getTeaserProfile", cacheTtl: 300, category: "config" },
  agentDownline: { path: "Manager/getListAgenstByAgent", cacheTtl: 300, category: "agent" },
  agentBilling: { path: "Manager/getAgentBilling", cacheTtl: 300, category: "agent" },
  sportsAdmin: { path: "Manager/getSportsCustomerAdmin", cacheTtl: 300, category: "admin" },
  sportsType: { path: "Manager/getSportsType", cacheTtl: 3600, category: "taxonomy" },
  vigSetup: { path: "Manager/getSportsVigSetup", cacheTtl: 300, category: "admin" },
  maxWager: { path: "Manager/getSportsMaxWager", cacheTtl: 300, category: "admin" },
  colors: { path: "Manager/getColorsSelections", cacheTtl: 3600, category: "admin" },
  stores: { path: "Manager/getStores", cacheTtl: 3600, category: "admin" },
  circleLimits: { path: "Manager/getCircleLimits", cacheTtl: 300, category: "admin" },
  betTicker: { path: "Manager/getBetTicker", cacheTtl: 5, category: "analytics" },
  betTickerConfig: { path: "Manager/getBetTickerConfig", cacheTtl: 300, category: "analytics" },
  pending: { path: "Manager/getPending", cacheTtl: 15, category: "analytics" },
  pendingReportConfig: { path: "Manager/getConfigWebReportsPending", cacheTtl: 300, category: "reports" },
  updatePendingReportConfig: { path: "Manager/updateReportConfigPending", cacheTtl: 0, category: "reports" },
  openBets: { path: "Manager/getOpenBets", cacheTtl: 30, category: "analytics" },
  agentPerformance: { path: "Manager/getAgentPerformance", cacheTtl: 300, category: "analytics" },
  wagerByPlayer: { path: "Manager/getWagerByPlayer", cacheTtl: 60, category: "analytics" },
  playerWeek: { path: "Manager/getPlayerWeek", cacheTtl: 300, category: "analytics" },
  transactionPlayer: { path: "Manager/getEnterTransactions", cacheTtl: 300, category: "analytics" },
  historyPlayer: { path: "Manager/getReportPlayerAnalysis", cacheTtl: 300, category: "analytics" },
  webLog: { path: "Manager/getWebLog", cacheTtl: 60, category: "analytics" },
  getConfigWebReports: { path: "Manager/getConfigWebReports", cacheTtl: 300, category: "reports" },
  agentManagement: { path: "Manager/getAgentManagement", cacheTtl: 300, category: "agent" },
  listVip: { path: "Manager/getListVip", cacheTtl: 300, category: "agent" },
  cryptoAvailable: { path: "Manager/getCryptoAvailable", cacheTtl: 300, category: "banking" },
  getMessage: { path: "Manager/getMessage", cacheTtl: 30, category: "account" },
  playerActivity: { path: "System/getPlayerActivity", cacheTtl: 120, category: "player" },
  bettorDetails: { path: "Manager/getBettorDetails", cacheTtl: 120, category: "player" },
  liveGame: { path: "Manager/getGames", cacheTtl: 15, category: "live" },

  // === Discovered from manager.js reverse engineering (May 11, 2026) ===
  getAddedInfo: { path: "Manager/getAddedInfo", cacheTtl: 60, category: "account" },
  getCommunicationMessages: { path: "Manager/getCommunicationMessages", cacheTtl: 60, category: "account" },
  getLineTypes: { path: "Manager/getLineTypes", cacheTtl: 3600, category: "config" },
  searchCustomerAdmin: { path: "Manager/searchCustomerAdmin", cacheTtl: 30, category: "search" },
  saveNotifyAgent: { path: "Manager/saveNotifyAgent", cacheTtl: 0, category: "account" },
  updateBasicSettings: { path: "Manager/updateBasicSettings", cacheTtl: 0, category: "account" },
  updateDistribution: { path: "Manager/updateDistribution", cacheTtl: 0, category: "accounting" },
  changePassword: { path: "Manager/changePassword", cacheTtl: 0, category: "auth" },
  mailAgentUpdate: { path: "Manager/mailAgentUpdate", cacheTtl: 0, category: "messages" },
  sendFeedback: { path: "Manager/sendFeedback", cacheTtl: 0, category: "support" },
  getMasterSheet: { path: "Manager/getMasterSheet", cacheTtl: 300, category: "accounting" },
  getHeriarchy: { path: "Manager/getHeriarchy", cacheTtl: 300, category: "agent" },
  getPlayers: { path: "Manager/getPlayers", cacheTtl: 300, category: "agent" },

  // === Discovered from proxy deep scan (May 11, 2026) ===
  getPlayerDetails: { path: "Manager/getPlayerDetails", cacheTtl: 120, category: "player" },
  getPlayerLimits: { path: "Manager/getPlayerLimits", cacheTtl: 120, category: "player" },
  setPlayerLimits: { path: "Manager/setPlayerLimits", cacheTtl: 0, category: "player" },
  updatePlayerStatus: { path: "Manager/updatePlayerStatus", cacheTtl: 0, category: "player" },
};

function getEndpointMeta(endpointPath: string): { key: string; cacheTtl: number; category: string } | null {
  for (const [key, meta] of Object.entries(ENDPOINT_MAP)) {
    if (meta.path === endpointPath) return { key, cacheTtl: meta.cacheTtl, category: meta.category };
  }
  return null;
}

function getEndpointDescription(key: string): string {
  const desc: Record<string, string> = {
    auth: "Authenticate with customerID/password",
    renewToken: "Refresh bearer token (auto-called every 30s)",
    logWrite: "Frontend telemetry passthrough",
    accountInfo: "Agent account snapshot and balance",
    playerInfo: "Player profile, limits, and status",
    newEmails: "Unread notification count",
    mail: "Inbox messages",
    cryptoInfo: "Crypto deposit addresses and history",
    authorizations: "Agent permissions and feature flags",
    sportsLeagues: "Sports and leagues tree (all sports)",
    leagueLines: "Betting lines for a specific league",
    games: "Scheduled games list",
    gameVolume: "Game exposure and wager volume",
    periodsBySport: "Available periods (FG, 1H, 2H, etc)",
    buyPoints: "Buy points configuration",
    amountLimits: "Wager amount limits by type",
    linesPlus: "Enhanced lines data",
    propBuilderURL: "Prop builder schedule URL",
    dynamicLive: "Live in-game betting events",
    sportsTypesLive: "Live sports categories",
    scoresLive: "Real-time scores",
    props: "Available prop bets",
    extendedProps: "Extended prop offerings",
    teaserProfile: "Teaser odds and rules",
    agentDownline: "Agent sub-agent and player list",
    agentBilling: "Weekly/daily billing figures",
    sportsAdmin: "Sports admin configuration",
    sportsType: "Available sport type codes and names",
    vigSetup: "Vig/juice settings by sport",
    maxWager: "Maximum wager amounts",
    colors: "UI color scheme",
    stores: "Retail store locations",
    circleLimits: "Circle game limits",
    betTicker: "Real-time bet ticker (live wagers)",
    betTickerConfig: "Ticker display configuration",
    pending: "Raw pending wagers grouped by ticket/wager with parlay legs",
    pendingReportConfig: "Pending report column visibility configuration",
    updatePendingReportConfig: "Update pending report column visibility toggles",
    openBets: "Current open wagers",
    agentPerformance: "Agent performance report",
    wagerByPlayer: "Player wager history",
    playerWeek: "Player weekly figures",
    transactionPlayer: "Player transaction log",
    historyPlayer: "Player account analysis",
    webLog: "Web/IP access log",
    getConfigWebReports: "Web reports column configuration",
    agentManagement: "Agent downline management tree",
    listVip: "VIP player list",
    cryptoAvailable: "Available cryptocurrency options",
    getMessage: "Agent messages",
    playerActivity: "Player activity events",
    bettorDetails: "Detailed bettor information",

    // Discovered from manager.js reverse engineering (May 11, 2026)
    getAddedInfo: "Telegram ID and notification threshold settings",
    getCommunicationMessages: "Pop-up messages, stamp messages, and communication preferences",
    getLineTypes: "Available line types for sport dropdown",
    searchCustomerAdmin: "Search customers by ID, name, or password",
    saveNotifyAgent: "Save Telegram notification settings",
    updateBasicSettings: "Update language, timezone, menu style, and VIP notify flag",
    updateDistribution: "Update agent makeup/distribution",
    changePassword: "Change account password",
    mailAgentUpdate: "Mark agent message as read",
    sendFeedback: "Send feedback message to support",
    getMasterSheet: "Weekly accounting master sheet",
    getHeriarchy: "Flat agent hierarchy list (classic skin)",
    getPlayers: "Players under current agent",

    // Discovered from proxy deep scan (May 11, 2026)
    getPlayerDetails: "Detailed player account information",
    getPlayerLimits: "Player wager and betting limits",
    setPlayerLimits: "Update player wager and betting limits",
    updatePlayerStatus: "Update player account status (active/suspended)",
  };
  return desc[key] || "Buckeye PPH API endpoint";
}

// ==========================================
// ACTIVE REQUEST TRACKING + SHUTDOWN
// ==========================================
let shuttingDown = false;
let activeRequests = 0;
const activeSpans = new Map<string, ReturnType<TraceCollector["startSpan"]>>();

function startRequestSpan(reqId: string, path: string, method: string) {
  if (!CONFIG.otel.enabled) return;
  const span = tracer.startSpan("proxy_request", undefined, { path, method, service: CONFIG.otel.serviceName });
  activeSpans.set(reqId, span);
}

function endRequestSpan(reqId: string, status: number, error?: string) {
  const span = activeSpans.get(reqId);
  if (!span) return;
  activeSpans.delete(reqId);
  span.end(status >= 400 ? "ERROR" : "OK", { status, error: error || undefined });
}

// ==========================================
// CIRCUIT BREAKER INSTANCE
// ==========================================
const circuitBreaker = new CircuitBreaker();

async function buckeyeCall<T>(fn: () => Promise<T>, meta: JsonObject = {}): Promise<T> {
  return CONFIG.features.autoRetry ? circuitBreaker.call(fn, meta) : fn();
}

// ==========================================
// 2. SQLITE SETUP (WAL + POOLING)
// ==========================================
const db = new Database(CONFIG.dbPath, { create: true });
db.run("PRAGMA journal_mode = WAL;");
db.run(`PRAGMA busy_timeout = ${PROXY_CONSTANTS.DB_BUSY_TIMEOUT_MS};`);
db.run("PRAGMA foreign_keys = ON;");

// Graceful startup wait — ensure WAL checkpoint is idle before accepting traffic.
let walReady = CONFIG.dbPath === ":memory:";
if (!walReady) {
  for (let i = 0; i < 50; i++) {
    const result = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as { busy?: number } | null;
    if (result && Number(result.busy ?? 0) === 0) {
      walReady = true;
      break;
    }
    await Bun.sleep(100);
  }
}
if (!walReady) {
  logger.error("SQLite WAL checkpoint failed after 5s");
  process.exit(1);
}
logger.info("SQLite WAL ready");

// PRAGMA optimize after every 1000 writes to keep query planner sharp
let writeCounter = 0;
const originalDbRun = db.run.bind(db);
db.run = function (...args: unknown[]) {
  writeCounter++;
  const result = originalDbRun.apply(this, args);
  if (writeCounter % PROXY_CONSTANTS.WRITE_OPTIMIZE_COUNTER === 0) {
    try { originalDbRun.call(this, "PRAGMA optimize"); } catch (e) { console.warn("[Proxy] PRAGMA optimize failed:", e); }
  }
  return result;
};

const readPool: Database[] = [];
for (let i = 0; i < 3; i++) {
  const conn = CONFIG.dbPath === ":memory:" ? db : new Database(CONFIG.dbPath, { readonly: true });
  if (conn !== db) {
    conn.run("PRAGMA journal_mode = WAL;");
    conn.run(`PRAGMA busy_timeout = ${PROXY_CONSTANTS.DB_BUSY_TIMEOUT_PROXY_MS};`);
  }
  readPool.push(conn);
}
let readPoolIndex = 0;
function getReadDb(): Database {
  const conn = readPool[readPoolIndex];
  readPoolIndex = (readPoolIndex + 1) % readPool.length;
  return conn;
}

const dbRead = readPool[0];

db.run(`
  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY,
    customerID TEXT,
    cf_clearance TEXT,
    auth_code TEXT,
    bearer_token TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    expires_at INTEGER
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_tokens_customer ON tokens(customerID)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_tokens_expiry ON tokens(expires_at)`);

db.run(`
  CREATE TABLE IF NOT EXISTS api_cache (
    id INTEGER PRIMARY KEY,
    endpoint TEXT,
    payload_hash TEXT,
    response_json TEXT,
    cached_at INTEGER DEFAULT (unixepoch()),
    ttl_seconds INTEGER DEFAULT 60
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_cache_lookup ON api_cache(endpoint, payload_hash)`);

db.run(`
  CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY,
    customerID TEXT,
    req_id TEXT,
    endpoint TEXT,
    status INTEGER,
    duration_ms INTEGER,
    error TEXT,
    logged_at INTEGER DEFAULT (unixepoch())
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS rate_limit (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    window_start INTEGER
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY,
    endpoint TEXT,
    customerID TEXT,
    status INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS rate_limit_overrides (
    endpoint TEXT PRIMARY KEY,
    "limit" INTEGER NOT NULL,
    window INTEGER NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch())
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS risk_config (
    agentID TEXT PRIMARY KEY,
    customerID TEXT,
    thresholds TEXT,
    webhook TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS syndicate_cache (
    id TEXT PRIMARY KEY,
    agentID TEXT,
    pattern TEXT,
    members TEXT,
    totalStake REAL,
    commonGame TEXT,
    windowMs INTEGER DEFAULT 0,
    wagerCount INTEGER DEFAULT 0,
    avgStake REAL DEFAULT 0,
    riskScore INTEGER DEFAULT 0,
    confidence INTEGER DEFAULT 0,
    signals TEXT DEFAULT '[]',
    detected_at INTEGER DEFAULT (unixepoch())
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS line_history (
    id INTEGER PRIMARY KEY,
    gameId TEXT,
    lineType TEXT,
    side TEXT,
    oldLine REAL,
    newLine REAL,
    oldOdds REAL,
    newOdds REAL,
    timestamp INTEGER DEFAULT (unixepoch())
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS wager_analytics (
    id INTEGER PRIMARY KEY,
    agentID TEXT,
    wagerNumber TEXT,
    bettorId TEXT,
    gameId TEXT,
    wagerType TEXT,
    side TEXT,
    line REAL,
    odds REAL,
    stake REAL,
    profit REAL,
    sport TEXT,
    timestamp INTEGER
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_syndicate_agent_detected ON syndicate_cache(agentID, detected_at)`);

db.run(`
  CREATE TABLE IF NOT EXISTS integrity_cases (
    id TEXT PRIMARY KEY,
    agentID TEXT NOT NULL,
    syndicateId TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    title TEXT NOT NULL,
    summary TEXT,
    evidence TEXT DEFAULT '{}',
    reviewer TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_integrity_cases_agent_status ON integrity_cases(agentID, status, updated_at)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_line_history_game_time ON line_history(gameId, timestamp)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_wager_analytics_bettor_time ON wager_analytics(bettorId, timestamp)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_wager_analytics_agent_time ON wager_analytics(agentID, timestamp)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_wager_analytics_game_time ON wager_analytics(gameId, timestamp)`);

db.run(`
  CREATE TABLE IF NOT EXISTS line_adjustment_rules (
    id INTEGER PRIMARY KEY,
    agentID TEXT NOT NULL,
    sport TEXT NOT NULL DEFAULT '',
    league TEXT NOT NULL DEFAULT '',
    lineType TEXT NOT NULL DEFAULT 'SPREAD',
    condition TEXT NOT NULL DEFAULT 'sharp_money_threshold',
    threshold REAL NOT NULL DEFAULT 5000,
    adjustmentPercent REAL NOT NULL DEFAULT 5,
    maxMovePercent REAL NOT NULL DEFAULT 10,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_line_rules_agent ON line_adjustment_rules(agentID, enabled)`);

db.run(`
  CREATE TABLE IF NOT EXISTS sharpness_history (
    bettorId TEXT NOT NULL,
    sharpScore INTEGER NOT NULL DEFAULT 0,
    wagerCount INTEGER NOT NULL DEFAULT 0,
    winRate REAL NOT NULL DEFAULT 0,
    roi REAL NOT NULL DEFAULT 0,
    calculated_at INTEGER DEFAULT (unixepoch())
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_sharpness_bettor ON sharpness_history(bettorId, calculated_at)`);

db.run(`
  CREATE TABLE IF NOT EXISTS line_adjustment_log (
    id INTEGER PRIMARY KEY,
    gameId TEXT NOT NULL,
    lineType TEXT NOT NULL,
    side TEXT NOT NULL,
    oldLine REAL,
    newLine REAL,
    reason TEXT NOT NULL,
    ruleId INTEGER,
    executed_by TEXT NOT NULL DEFAULT 'auto_engine',
    timestamp INTEGER DEFAULT (unixepoch())
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_line_adj_log_game ON line_adjustment_log(gameId, timestamp)`);

db.run(`
  CREATE TABLE IF NOT EXISTS enforcement_queue (
    id INTEGER PRIMARY KEY,
    position_id INTEGER,
    customer_id TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    suggested_max_exposure REAL,
    suggested_wager_limit REAL,
    suggested_action TEXT,
    ai_confidence REAL,
    ai_summary TEXT,
    status TEXT DEFAULT 'pending',
    viewed_at TEXT,
    viewed_by TEXT,
    applied_at TEXT,
    applied_by TEXT,
    buckeye_admin_url TEXT,
    reminder_count INTEGER DEFAULT 0,
    last_reminder_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT DEFAULT (datetime('now', '+30 minutes'))
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_enforcement_pending ON enforcement_queue(status, risk_level, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_enforcement_customer ON enforcement_queue(customer_id, status)`);

// ...existing code...

// Add missing columns if upgrading from older schema
for (const column of [
  "ALTER TABLE request_log ADD COLUMN customerID TEXT",
  "ALTER TABLE request_log ADD COLUMN req_id TEXT",
  "ALTER TABLE wager_analytics ADD COLUMN agentID TEXT",
  "ALTER TABLE syndicate_cache ADD COLUMN windowMs INTEGER DEFAULT 0",
  "ALTER TABLE syndicate_cache ADD COLUMN wagerCount INTEGER DEFAULT 0",
  "ALTER TABLE syndicate_cache ADD COLUMN avgStake REAL DEFAULT 0",
  "ALTER TABLE syndicate_cache ADD COLUMN riskScore INTEGER DEFAULT 0",
  "ALTER TABLE syndicate_cache ADD COLUMN confidence INTEGER DEFAULT 0",
  "ALTER TABLE syndicate_cache ADD COLUMN signals TEXT DEFAULT '[]'",
]) {
  try { db.run(column); } catch (e) { console.debug("[Proxy] Migration column may already exist:", e); }
}

// Prepared statements
const insertToken = db.prepare(`INSERT INTO tokens (customerID, cf_clearance, auth_code, bearer_token, expires_at) VALUES ($customerID, $cf_clearance, $auth_code, $bearer_token, $expires_at)`);
const getLatestToken = dbRead.prepare(`SELECT * FROM tokens WHERE customerID = $customerID ORDER BY id DESC LIMIT 1`);
const getLatestTokenWrite = db.prepare(`SELECT * FROM tokens WHERE customerID = $customerID ORDER BY id DESC LIMIT 1`);
const updateToken = db.prepare(`UPDATE tokens SET bearer_token = $bearer_token, expires_at = $expires_at WHERE customerID = $customerID AND id = (SELECT id FROM tokens WHERE customerID = $customerID ORDER BY id DESC LIMIT 1)`);
const getExpiringTokens = dbRead.prepare(`SELECT customerID, cf_clearance, bearer_token, expires_at FROM tokens WHERE bearer_token IS NOT NULL AND expires_at IS NOT NULL AND expires_at < $threshold ORDER BY expires_at ASC`);

const insertCache = db.prepare(`INSERT INTO api_cache (endpoint, payload_hash, response_json, ttl_seconds) VALUES ($endpoint, $payload_hash, $response_json, $ttl_seconds)`);
const getCache = dbRead.prepare(`SELECT * FROM api_cache WHERE endpoint = $endpoint AND payload_hash = $payload_hash AND (unixepoch() - cached_at) < ttl_seconds ORDER BY cached_at DESC LIMIT 1`);
const getCacheStale = dbRead.prepare(`SELECT * FROM api_cache WHERE endpoint = $endpoint AND payload_hash = $payload_hash ORDER BY cached_at DESC LIMIT 1`);

const logRequestStmt = db.prepare(`INSERT INTO request_log (customerID, req_id, endpoint, status, duration_ms, error) VALUES ($customerID, $req_id, $endpoint, $status, $duration_ms, $error)`);
const totalRequestCount = db.prepare(`SELECT COUNT(*) AS count FROM request_log`);
const errorRequestCount = db.prepare(`SELECT COUNT(*) AS count FROM request_log WHERE error IS NOT NULL`);
const statusErrorRequestCount = dbRead.prepare(`SELECT COUNT(*) AS count FROM request_log WHERE status >= 400`);
const avgRequestDuration = dbRead.prepare(`SELECT AVG(duration_ms) AS avg FROM request_log`);
const recentRequestLogsStmt = dbRead.prepare(`SELECT * FROM request_log ORDER BY logged_at DESC LIMIT $limit`);
const countCustomerRequests = db.prepare(`SELECT COUNT(*) AS count FROM request_log WHERE customerID = $customerID AND logged_at > $windowStart`);
const countCustomerEndpointRequests = db.prepare(`SELECT COUNT(*) AS count FROM request_log WHERE customerID = $customerID AND endpoint = $endpoint AND logged_at > $windowStart`);

const checkRateStmt = dbRead.prepare(`SELECT count, window_start FROM rate_limit WHERE key = $key`);
const upsertRateStmt = db.prepare(`INSERT INTO rate_limit (key, count, window_start) VALUES ($key, 1, $now) ON CONFLICT(key) DO UPDATE SET count = count + 1, window_start = CASE WHEN excluded.window_start > window_start THEN excluded.window_start ELSE window_start END`);

const getIdempotency = dbRead.prepare(`SELECT status, response_json, created_at FROM idempotency WHERE key = $key AND (unixepoch() - created_at) < ${PROXY_CONSTANTS.IDEMPOTENCY_TTL_SECONDS}`);
const setIdempotency = db.prepare(`INSERT OR REPLACE INTO idempotency (key, endpoint, customerID, status, response_json) VALUES ($key, $endpoint, $customerID, $status, $response_json)`);

const purgeExpiredCache = db.prepare(`DELETE FROM api_cache WHERE (unixepoch() - cached_at) > ttl_seconds`);
const purgeOldIdempotency = db.prepare(`DELETE FROM idempotency WHERE (unixepoch() - created_at) > ${PROXY_CONSTANTS.IDEMPOTENCY_TTL_SECONDS}`);
const purgeOldRequestLogs = db.prepare(`DELETE FROM request_log WHERE (unixepoch() - logged_at) > 604800`);
const tokenCount = dbRead.prepare(`SELECT COUNT(*) as total FROM tokens WHERE bearer_token IS NOT NULL`);
const getWarmableTokens = dbRead.prepare(`SELECT customerID, MAX(expires_at) AS expires_at FROM tokens WHERE bearer_token IS NOT NULL AND expires_at > unixepoch() GROUP BY customerID ORDER BY expires_at DESC LIMIT 20`);

const getRateLimitOverrideStmt = dbRead.prepare(`SELECT endpoint, "limit", window, updated_at FROM rate_limit_overrides WHERE endpoint = $endpoint`);
const setRateLimitOverrideStmt = db.prepare(`INSERT OR REPLACE INTO rate_limit_overrides (endpoint, "limit", window, updated_at) VALUES ($endpoint, $limit, $window, unixepoch())`);
const getAllRateLimitOverridesStmt = dbRead.prepare(`SELECT endpoint, "limit", window, updated_at FROM rate_limit_overrides`);

const insertSyndicate = db.prepare(`INSERT OR REPLACE INTO syndicate_cache (id, agentID, pattern, members, totalStake, commonGame, windowMs, wagerCount, avgStake, riskScore, confidence, signals, detected_at) VALUES ($id, $agentID, $pattern, $members, $totalStake, $commonGame, $windowMs, $wagerCount, $avgStake, $riskScore, $confidence, $signals, $detected_at)`);
const getSyndicates = dbRead.prepare(`SELECT * FROM syndicate_cache WHERE agentID = $agentID ORDER BY detected_at DESC LIMIT $limit`);
const insertIntegrityCase = db.prepare(`INSERT INTO integrity_cases (id, agentID, syndicateId, status, priority, title, summary, evidence, reviewer, notes, created_at, updated_at) VALUES ($id, $agentID, $syndicateId, $status, $priority, $title, $summary, $evidence, $reviewer, $notes, unixepoch(), unixepoch())`);
const getIntegrityCaseById = dbRead.prepare(`SELECT * FROM integrity_cases WHERE id = $id LIMIT 1`);
const getIntegrityCases = dbRead.prepare(`SELECT * FROM integrity_cases WHERE agentID = $agentID AND ($status = '' OR status = $status) ORDER BY updated_at DESC LIMIT $limit`);
const updateIntegrityCase = db.prepare(`UPDATE integrity_cases SET status = $status, priority = $priority, title = $title, summary = $summary, evidence = $evidence, reviewer = $reviewer, notes = $notes, updated_at = unixepoch() WHERE id = $id`);
const getIntegrityCaseStatusCounts = dbRead.prepare(`SELECT status, COUNT(*) AS count FROM integrity_cases WHERE agentID = $agentID GROUP BY status`);
const getSyndicateStats = dbRead.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(totalStake), 0) AS totalStake, COALESCE(MAX(riskScore), 0) AS maxRiskScore, COALESCE(MAX(detected_at), 0) AS latestDetectedAt FROM syndicate_cache WHERE agentID = $agentID AND detected_at > $since`);
const insertRiskConfig = db.prepare(`INSERT OR REPLACE INTO risk_config (agentID, customerID, thresholds, webhook, updated_at) VALUES ($agentID, $customerID, $thresholds, $webhook, unixepoch())`);
const getRiskConfig = dbRead.prepare(`SELECT * FROM risk_config WHERE agentID = $agentID`);
const insertLineHistory = db.prepare(`INSERT INTO line_history (gameId, lineType, side, oldLine, newLine, oldOdds, newOdds) VALUES ($gameId, $lineType, $side, $oldLine, $newLine, $oldOdds, $newOdds)`);
const getLineHistory = dbRead.prepare(`SELECT * FROM line_history WHERE gameId = $gameId AND timestamp > $since ORDER BY timestamp`);
const getLineHistorySince = dbRead.prepare(`SELECT * FROM line_history WHERE timestamp > $since ORDER BY timestamp`);
const insertWagerAnalytics = db.prepare(`INSERT INTO wager_analytics (agentID, wagerNumber, bettorId, gameId, wagerType, side, line, odds, stake, profit, sport, timestamp) VALUES ($agentID, $wagerNumber, $bettorId, $gameId, $wagerType, $side, $line, $odds, $stake, $profit, $sport, $timestamp)`);
const getWagerAnalytics = dbRead.prepare(`SELECT * FROM wager_analytics WHERE bettorId = $bettorId AND timestamp > $since ORDER BY timestamp DESC`);
const getAgentWagers = dbRead.prepare(`SELECT * FROM wager_analytics WHERE agentID = $agentID AND timestamp > $since ORDER BY timestamp`);
const getGameWagerAnalytics = dbRead.prepare(`SELECT * FROM wager_analytics WHERE gameId = $gameId AND timestamp > $since ORDER BY timestamp`);
const getAllRiskConfigs = dbRead.prepare(`SELECT * FROM risk_config`);
const getSyndicatesByAgent = dbRead.prepare(`SELECT * FROM syndicate_cache WHERE agentID = $agentID AND detected_at > $since ORDER BY detected_at DESC`);

const insertLineRule = db.prepare(`INSERT INTO line_adjustment_rules (agentID, sport, league, lineType, condition, threshold, adjustmentPercent, maxMovePercent, enabled) VALUES ($agentID, $sport, $league, $lineType, $condition, $threshold, $adjustmentPercent, $maxMovePercent, $enabled)`);
const getLineRulesByAgent = dbRead.prepare(`SELECT * FROM line_adjustment_rules WHERE agentID = $agentID AND enabled = 1 ORDER BY created_at DESC`);
const getAllLineRules = dbRead.prepare(`SELECT * FROM line_adjustment_rules WHERE enabled = 1 ORDER BY created_at DESC`);
const updateLineRule = db.prepare(`UPDATE line_adjustment_rules SET sport = $sport, league = $league, lineType = $lineType, condition = $condition, threshold = $threshold, adjustmentPercent = $adjustmentPercent, maxMovePercent = $maxMovePercent, enabled = $enabled WHERE id = $id`);
const deleteLineRule = db.prepare(`DELETE FROM line_adjustment_rules WHERE id = $id AND agentID = $agentID`);

// Enforcement queue prepared statements
const insertEnforcementQueue = db.prepare(`INSERT INTO enforcement_queue (position_id, customer_id, risk_level, suggested_max_exposure, suggested_wager_limit, suggested_action, ai_confidence, ai_summary, buckeye_admin_url) VALUES ($position_id, $customer_id, $risk_level, $suggested_max_exposure, $suggested_wager_limit, $suggested_action, $ai_confidence, $ai_summary, $buckeye_admin_url)`);
const getEnforcementQueue = dbRead.prepare(`SELECT * FROM enforcement_queue WHERE status = COALESCE($status, status) AND risk_level = COALESCE($risk_level, risk_level) ORDER BY CASE risk_level WHEN 'BLACK' THEN 1 WHEN 'RED' THEN 2 ELSE 3 END, created_at DESC LIMIT $limit`);
const getEnforcementQueueByCustomer = dbRead.prepare(`SELECT * FROM enforcement_queue WHERE customer_id = $customer_id AND status = COALESCE($status, status) ORDER BY created_at DESC`);
const updateEnforcementViewed = db.prepare(`UPDATE enforcement_queue SET status = 'viewed', viewed_at = datetime('now'), viewed_by = $viewed_by WHERE id = $id`);
const updateEnforcementApplied = db.prepare(`UPDATE enforcement_queue SET status = 'applied', applied_at = datetime('now'), applied_by = $applied_by WHERE id = $id`);
const expireOldEnforcement = db.prepare(`UPDATE enforcement_queue SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')`);
const getUrgentEnforcement = dbRead.prepare(`SELECT * FROM enforcement_queue WHERE status = 'pending' AND risk_level = 'BLACK' AND (viewed_at IS NULL OR viewed_at < datetime('now', '-5 minutes')) AND reminder_count < 3 AND (last_reminder_at IS NULL OR last_reminder_at < datetime('now', '-5 minutes'))`);
const incrementEnforcementReminder = db.prepare(`UPDATE enforcement_queue SET reminder_count = reminder_count + 1, last_reminder_at = datetime('now') WHERE id = $id`);

const deleteRiskConfig = db.prepare(`DELETE FROM risk_config WHERE agentID = $agentID`);
const deleteRateLimitOverrideInline = db.prepare(`DELETE FROM rate_limit_overrides WHERE endpoint = $endpoint`);

const insertSharpness = db.prepare(`INSERT INTO sharpness_history (bettorId, sharpScore, wagerCount, winRate, roi, calculated_at) VALUES ($bettorId, $sharpScore, $wagerCount, $winRate, $roi, unixepoch())`);
const getSharpnessByBettor = dbRead.prepare(`SELECT * FROM sharpness_history WHERE bettorId = $bettorId ORDER BY calculated_at DESC LIMIT $limit`);

const insertLineAdjLog = db.prepare(`INSERT INTO line_adjustment_log (gameId, lineType, side, oldLine, newLine, reason, ruleId, executed_by, timestamp) VALUES ($gameId, $lineType, $side, $oldLine, $newLine, $reason, $ruleId, $executed_by, unixepoch())`);
const getLineAdjLog = dbRead.prepare(`SELECT * FROM line_adjustment_log WHERE gameId = $gameId ORDER BY timestamp DESC LIMIT $limit`);
const getRecentLineAdjLog = dbRead.prepare(`SELECT * FROM line_adjustment_log WHERE timestamp > $since ORDER BY timestamp DESC LIMIT $limit`);

// Request counters for /metrics
let totalRequests = 0;
let errorRequests = 0;
const endpointLatencies = new Map<string, number[]>();

// Rate limit overrides
const rateLimitOverrides = new Map<string, { limit: number; window: number }>();

function loadRateLimitOverrides() {
  const rows = getAllRateLimitOverridesStmt.all() as Array<{ endpoint: string; limit: number; window: number }>;
  rateLimitOverrides.clear();
  for (const row of rows) {
    rateLimitOverrides.set(row.endpoint, { limit: row.limit, window: row.window });
  }
  logger.info("Rate limit overrides loaded", { count: rateLimitOverrides.size });
}

function findRateLimitOverride(endpoint: string): { limit: number; window: number } | null {
  return rateLimitOverrides.get(endpoint) || null;
}

// ==========================================
// WAL CHECKPOINT + CACHE PURGE INTERVALS
// ==========================================
if (CONFIG.features.walCheckpoint) {
  setInterval(() => { try { db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { console.warn("[Proxy] WAL checkpoint failed:", e); } }, PROXY_CONSTANTS.WAL_CHECKPOINT_INTERVAL_MS);
}

setInterval(() => {
  try {
    const r1 = purgeExpiredCache.run();
    const r2 = purgeOldIdempotency.run();
    if (r1.changes || r2.changes) logger.info("Purged stale entries", { cache: r1.changes, idempotency: r2.changes });
    if (r2.changes) logger.info("Cleaned old idempotency keys", { deleted: r2.changes, olderThanHours: 24 });
  } catch (err: unknown) { logger.warn("Purge failed", { error: err instanceof Error ? err.message : String(err) }); }
}, 21600000);

// SQLite hot backup every 6 hours (offset by 1h from purge)
setInterval(async () => {
  try {
    const backupDir = "./backups";
    await atomicWrite(`${backupDir}/.keep`, "").catch(() => { });
    const backupPath = `${backupDir}/proxy-${Date.now()}.db`;
    db.run(`VACUUM INTO '${backupPath}'`);
    logger.log("info", "backup", `SQLite hot backup created`, { path: backupPath });
    // Keep only last 10 backups
    const files = Array.fromAsync ? await Array.fromAsync(Bun.glob(`${backupDir}/proxy-*.db`)) : [];
    const sorted = files.sort();
    while (sorted.length > 10) {
      const old = sorted.shift();
      if (old) { await Bun.file(old).delete().catch(() => { }); }
    }
  } catch (err: unknown) {
    logger.warn("Backup failed", { error: err instanceof Error ? err.message : String(err) });
  }
}, 21600000 + 3600000);

// Memory-efficient log rotation (Enhancement 23)
setInterval(() => {
  try {
    const logDb = new Database("logs.sqlite", { readonly: true });
    const logCount = logDb.query("SELECT COUNT(*) as c FROM logs").get() as { c: number } | null;
    logDb.close();
    if (logCount && logCount.c > PROXY_CONSTANTS.LOG_PRUNE_THRESHOLD) {
      const writeDb = new Database("logs.sqlite");
      writeDb.run(`DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id LIMIT ${PROXY_CONSTANTS.LOG_PRUNE_BATCH})`);
      writeDb.close();
      logger.log("info", "background", "Pruned old log rows", { before: logCount.c });
    }
  } catch (e) {
    console.debug("[Proxy] Log pruning skipped — logs.sqlite may not exist:", e);
  }
}, 3600000);

// ==========================================
// OTEL TRACE EXPORTER — background flush
// ==========================================
if (CONFIG.otel.enabled) {
  setInterval(() => { void tracer.export().catch(() => { }); }, CONFIG.otel.exportIntervalMs);
  logger.info("OTel trace exporter enabled", { endpoint: CONFIG.otel.endpoint, intervalMs: CONFIG.otel.exportIntervalMs });
}

// ==========================================
// RISK ENGINE — background alert evaluation
// ==========================================
let riskEngineRunning = false;
var riskEngineTimer: Timer | null = null;
async function runRiskEngine(): Promise<void> {
  if (riskEngineRunning) return;
  riskEngineRunning = true;
  try {
    const configs = getAllRiskConfigs.all() as Array<{ agentID: string; thresholds: string; webhook: string | null }>;
    for (const cfg of configs) {
      const thresholds = JSON.parse(cfg.thresholds || "{}");
      const stored = await getStoredCredentials(cfg.agentID);
      if (!stored) continue;

      try {
        const wagerRes = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
          method: "POST",
          headers: browserHeaders(stored.token, `cf_clearance=${stored.cf_clearance}`),
          body: toForm({ operation: "getBetTicker", agentID: cfg.agentID, agentOwner: cfg.agentID, agentSite: "1" }),
        }), { reqId: "risk-engine", endpoint: "getBetTicker" });
        const wagerData = await wagerRes.json().catch(() => null);
        const wagers = parseBuckeyeWagers(wagerData);
        const now = Date.now();
        const todayStart = new Date(now).setHours(0, 0, 0, 0);
        const weekStart = now - 7 * 86400000;

        const todayWagers = wagers.filter(w => w.timestamp >= todayStart);
        const weekWagers = wagers.filter(w => w.timestamp >= weekStart);
        const todayPL = todayWagers.reduce((s, w) => s + (w.profit || 0), 0);
        const weekPL = weekWagers.reduce((s, w) => s + (w.profit || 0), 0);
        const maxBet = todayWagers.reduce((mx, w) => Math.max(mx, w.stake), 0);

        const alerts: string[] = [];
        if (thresholds.maxDailyLoss && todayPL < -thresholds.maxDailyLoss) alerts.push(`Daily loss exceeded: $${todayPL.toFixed(2)}`);
        if (thresholds.maxWeeklyLoss && weekPL < -thresholds.maxWeeklyLoss) alerts.push(`Weekly loss exceeded: $${weekPL.toFixed(2)}`);
        if (thresholds.maxBet && maxBet > thresholds.maxBet) alerts.push(`Large bet placed: $${maxBet.toFixed(2)}`);

        if (alerts.length > 0 && cfg.webhook) {
          await fetch(cfg.webhook, {
            method: "POST",
            headers: buildServiceHeaders(),
            body: JSON.stringify({ agentID: cfg.agentID, alerts, timestamp: Date.now() }),
          }).catch(() => { });
          logger.info("Risk alert sent", { agentID: cfg.agentID, alerts });
        }
      } catch (err: unknown) {
        logger.warn("Risk engine agent check failed", { agentID: cfg.agentID, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    riskEngineRunning = false;
  }
}

if (CONFIG.features.riskEngine) {
  riskEngineTimer = setInterval(() => { void runRiskEngine().catch(() => { }); }, PROXY_CONSTANTS.RISK_ENGINE_INTERVAL_MS) as unknown as Timer;
}

// ==========================================
// 3. TOKEN PRE-RENEWAL + SCHEDULING
// ==========================================
const tokenRenewalTimers = new Map<string, Timer>();

async function renewTokenForCustomer(customerID: string, reqId = "token-renewal"): Promise<boolean> {
  try {
    const stored = await getStoredCredentials(customerID);
    if (!stored) return false;

    const upstream = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/System/renewToken`, {
      method: "POST",
      headers: browserHeaders(stored.token, `cf_clearance=${stored.cf_clearance}`),
      body: toForm({ operation: "renewToken", agentID: customerID, agentOwner: customerID, agentSite: "1" }),
    }), { reqId, endpoint: "renewToken" });

    const text = await upstream.text();
    let data: { token?: string; code?: string };
    try {
      data = JSON.parse(text) as { token?: string; code?: string };
    } catch {
      logger.warn("Token renewal returned non-JSON", { customerID, preview: text.slice(0, 200) });
      return false;
    }
    const token = data.token || data.code;
    if (!upstream.ok || !token) return false;

    const expiresAt = Math.floor(Date.now() / 1000) + 7200;
    insertToken.run({ $customerID: customerID, $cf_clearance: null, $auth_code: null, $bearer_token: String(token), $expires_at: expiresAt });
    invalidateTokenCache(customerID);
    scheduleTokenRenewal(customerID, expiresAt);
    logger.info("Token pre-renewed", { reqId, customerID, expiresAt });
    return true;
  } catch (err: unknown) {
    logger.warn("Token renewal error", { customerID, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function scheduleTokenRenewal(customerID: string, expiresAtUnix: number) {
  const existing = tokenRenewalTimers.get(customerID);
  if (existing) clearTimeout(existing);

  const now = Date.now() / 1000;
  const ttl = Math.max(0, expiresAtUnix - now);
  const delayMs = Math.max(5000, ttl * 0.8 * 1000);
  const timer = setTimeout(() => {
    void renewTokenForCustomer(customerID).catch((error: unknown) => {
      logger.warn("Token pre-renewal failed", { customerID, error: error instanceof Error ? error.message : String(error) });
    });
  }, delayMs);
  tokenRenewalTimers.set(customerID, timer);
}

function scheduleExistingTokenRenewals() {
  try {
    const rows = getReadDb().query("SELECT customerID, MAX(expires_at) AS expires_at FROM tokens WHERE bearer_token IS NOT NULL GROUP BY customerID").all() as Array<{ customerID: string; expires_at: number }>;
    for (const row of rows) {
      if (row.customerID && row.expires_at) scheduleTokenRenewal(row.customerID, row.expires_at);
    }
  } catch (err: unknown) {
    logger.warn("scheduleExistingTokenRenewals failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

// Interval-based pre-renewal sweep
if (CONFIG.features.tokenPreRenewal) {
  setInterval(async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const threshold = now + Math.floor(CONFIG.tokenRenewal.renewalThresholdMs / 1000);
      const expiring = getExpiringTokens.all({ $threshold: threshold }) as Array<{ customerID: string; cf_clearance: string; bearer_token: string; expires_at: number }>;
      for (const row of expiring) {
        logger.info("Pre-renewing token", { customerID: row.customerID, expires_in: row.expires_at - now });
        await renewTokenForCustomer(row.customerID);
      }
    } catch (err: unknown) {
      logger.error("Pre-renewal sweep failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }, CONFIG.tokenRenewal.renewalIntervalMs);
}

// Cache warming piggybacks on the existing proxy route and stored credentials.
const CACHE_WARM_ENDPOINTS = ["sportsLeagues", "betTicker"] as const;

async function warmPopularCaches(): Promise<void> {
  if (!CONFIG.features.memoryCache) return;
  const rows = getWarmableTokens.all() as Array<{ customerID: string; expires_at: number }>;
  if (rows.length === 0) return;

  for (const row of rows) {
    for (const endpoint of CACHE_WARM_ENDPOINTS) {
      await fetch(`http://localhost:${CONFIG.port}/api/proxy/${endpoint}`, {
        method: "POST",
        headers: buildServiceHeaders({ apiKey: CONFIG.apiKey }),
        body: JSON.stringify({ customerID: row.customerID, agentID: row.customerID }),
      }).catch((error: unknown) => {
        logger.warn("Cache warm failed", { endpoint, customerID: row.customerID, error: error instanceof Error ? error.message : String(error) });
      });
    }
  }
}

if (CONFIG.features.memoryCache) {
  setInterval(() => {
    void warmPopularCaches().catch((error: unknown) => {
      logger.warn("Cache warm sweep failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, CONFIG.tokenRenewal.renewalIntervalMs);
  setTimeout(() => {
    void warmPopularCaches().catch((error: unknown) => {
      logger.warn("Startup cache warm failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, 2500);
}

// ==========================================
// ENFORCEMENT QUEUE REMINDER CRON
// ==========================================
setInterval(() => {
  try {
    expireOldEnforcement.run();
    const urgent = getUrgentEnforcement.all() as Array<{ id: number; customer_id: string; suggested_wager_limit: number | null }>;
    for (const item of urgent) {
      logger.warn("UNENFORCED BLACK position", { customerID: item.customer_id, limit: item.suggested_wager_limit });
      incrementEnforcementReminder.run({ $id: item.id });
    }
  } catch (err: unknown) {
    logger.warn("Enforcement reminder cron failed", { error: err instanceof Error ? err.message : String(err) });
  }
}, 300000); // Every 5 minutes

// ==========================================
// 4. SWR (STALE-WHILE-REVALIDATE) CACHE
// ==========================================
const SWR_TTL_MULTIPLIER = 2;
const pendingRefresh = new Map<string, Promise<unknown>>();

function storeCache(endpoint: string, pHash: string, data: unknown, ttlSeconds = CONFIG.defaultRateLimit.window) {
  insertCache.run({ $endpoint: endpoint, $payload_hash: pHash, $response_json: JSON.stringify(data), $ttl_seconds: ttlSeconds });
}

function refreshCache(endpoint: string, pHash: string, fetchFn: () => Promise<unknown>, reqId = "global") {
  if (pendingRefresh.has(pHash)) return;
  const refresh = fetchFn()
    .then((data) => {
      storeCache(endpoint, pHash, data);
      logger.info("SWR cache refreshed", { reqId, endpoint });
      return data;
    })
    .catch((error: unknown) => {
      logger.warn("SWR cache refresh failed", { reqId, endpoint, error: error instanceof Error ? error.message : String(error) });
      return null;
    })
    .finally(() => pendingRefresh.delete(pHash));
  pendingRefresh.set(pHash, refresh);
}

async function getCacheWithSWR(
  endpoint: string,
  payload: JsonObject,
  fetchFn: () => Promise<unknown>,
  reqId = "global",
  ttlSeconds = CONFIG.defaultRateLimit.window
): Promise<{ data: unknown; source: string; stale?: boolean }> {
  const pHash = utilsHashPayload({ endpoint, ...payload });
  const cacheKey = { $endpoint: endpoint, $payload_hash: pHash };
  const cached = getCacheStale.get(cacheKey) as CacheRow | null;

  const now = Math.floor(Date.now() / 1000);
  const ttl = cached?.ttl_seconds || ttlSeconds;
  const swrWindow = ttl * SWR_TTL_MULTIPLIER;

  if (cached && (now - cached.cached_at) < ttl) {
    return { data: JSON.parse(cached.response_json), source: "cache" };
  }

  if (cached && (now - cached.cached_at) < swrWindow) {
    refreshCache(endpoint, pHash, fetchFn, reqId);
    return { data: JSON.parse(cached.response_json), source: "stale_cache", stale: true };
  }

  const data = await fetchFn();
  storeCache(endpoint, pHash, data, ttlSeconds);
  return { data, source: "live" };
}

// ==========================================
// 5. HELPERS
// ==========================================
const corsMethods = ["POST", "GET", "PATCH", "DELETE", "OPTIONS"];
const corsHeaders = ["Content-Type", "Authorization", "X-API-Key", "X-Request-ID", "X-Stream", "Idempotency-Key", "X-API-Fingerprint"];

// Static CORS for backward compatibility (used when Request is not available)
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Request-ID, X-Stream, Idempotency-Key",
};

// Dynamic CORS: respects CORS_ORIGIN env var when set
function buildCorsHeaders(req: Request): Record<string, string> {
  const requestOrigin = req.headers.get("Origin") || "";
  const allowedOrigin = CONFIG.corsOrigin;
  // If CORS_ORIGIN is configured, validate; otherwise allow any origin (dev default)
  const origin = allowedOrigin
    ? (requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin)
    : (requestOrigin || "*");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Request-ID, X-Stream, Idempotency-Key",
    "Vary": "Origin",
  };
}

function browserHeaders(token = "undefined", cookie = "") {
  return buildBrowserHeaders({
    token,
    cookie: cookie || (CONFIG.cfClearance ? `cf_clearance=${CONFIG.cfClearance}` : undefined),
  });
}

function toForm(data: JsonObject): string {
  return new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)] as [string, string])).toString();
}

async function readBody(req: Request): Promise<JsonObject> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) return req.json() as Promise<JsonObject>;
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text)) as JsonObject;
}

// Lightweight Zod body validator
async function safeParseBody<T>(req: Request, schema: z.ZodSchema<T>): Promise<{ success: true; data: T } | { success: false; error: string }> {
  try {
    const raw = await readBody(req);
    const data = schema.parse(raw);
    return { success: true, data };
  } catch (err: unknown) {
    const message = err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      : err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

const SampleRateSchema = z.object({ rate: z.coerce.number().min(0).max(1) });
const RateLimitOverrideSchema = z.object({
  endpoint: z.string().min(1, "endpoint required"),
  limit: z.coerce.number().positive("limit must be > 0"),
  window: z.coerce.number().positive("window must be > 0"),
});

function parseJsonValue<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function normalizeCaseStatus(value: unknown): string {
  const status = String(value || "open").toLowerCase();
  return ["open", "reviewing", "escalated", "closed", "false_positive"].includes(status) ? status : "open";
}

function normalizeCasePriority(value: unknown): string {
  const priority = String(value || "medium").toLowerCase();
  return ["low", "medium", "high", "critical"].includes(priority) ? priority : "medium";
}

function serializeIntegrityCase(row: IntegrityCaseRow) {
  return {
    id: row.id,
    agentID: row.agentID,
    syndicateId: row.syndicateId || null,
    status: row.status,
    priority: row.priority,
    title: row.title,
    summary: row.summary || "",
    evidence: parseJsonValue<JsonObject>(row.evidence, {}),
    reviewer: row.reviewer || "",
    notes: row.notes || "",
    createdAt: new Date(row.created_at * 1000).toISOString(),
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
  };
}

function hashPayloadImpl(payload: unknown): string {
  return Bun.hash(JSON.stringify(payload)).toString(36);
}

function getDemoCfClearance(): string {
  return `demo_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}, acceptEncoding = "", req?: Request) {
  const body = JSON.stringify(data, null, 2);
  const corsHeaders = req ? buildCorsHeaders(req) : cors;
  const responseHeaders: Record<string, string> = { "Content-Type": "application/json", ...corsHeaders, ...headers };
  const gzip = Bun.gzipSync;
  if (CONFIG.features.responseCompression && gzip && acceptEncoding.includes("gzip") && body.length > PROXY_CONSTANTS.COMPRESSION_THRESHOLD_BYTES) {
    const compressed = gzip(body);
    const bytes = new Uint8Array(compressed.byteLength);
    bytes.set(compressed);
    return new Response(bytes.buffer as ArrayBuffer, {
      status,
      headers: { "Content-Encoding": "gzip", ...responseHeaders },
    });
  }
  return new Response(body, { status, headers: responseHeaders });
}

function shouldLog(): boolean {
  if (!CONFIG.features.requestSampling) return true;
  const sampleRate = CONFIG.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return Math.random() < sampleRate;
}

// ==========================================
// HEATMAP AGGREGATION HELPERS
// ==========================================
interface HeatmapCell {
  day: number;
  hour: number;
  dayName: string;
  count: number;
  volume: number;
}

interface HeatmapResult {
  days: number;
  matrix: HeatmapCell[][];
  peakHour: number | null;
  peakDay: number | null;
  total: number;
  totalVolume: number;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseWebLogEntries(raw: unknown): Array<Record<string, unknown>> {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const list = obj.LIST || obj.data || obj.list || obj.weblog || obj.result;
  if (Array.isArray(list)) return list as Array<Record<string, unknown>>;
  return [];
}

function buildHeatmapFromEntries(entries: Array<Record<string, unknown>>, days: number, timeField: string): HeatmapResult {
  const matrix: HeatmapCell[][] = [];
  for (let d = 0; d < 7; d++) {
    matrix[d] = [];
    for (let h = 0; h < 24; h++) {
      matrix[d][h] = { day: d, hour: h, dayName: DAY_NAMES[d], count: 0, volume: 0 };
    }
  }

  const cutoff = Date.now() - days * 86400000;
  let total = 0;

  for (const entry of entries) {
    const rawTime = String(entry[timeField] || entry.Access_Date || entry.access_datetime || entry.logDate || "");
    const ts = Date.parse(rawTime);
    if (isNaN(ts) || ts < cutoff) continue;
    const date = new Date(ts);
    const dow = date.getDay();
    const hod = date.getHours();
    matrix[dow][hod].count++;
    total++;
  }

  let peakHour: number | null = null;
  let peakDay: number | null = null;
  let maxCount = 0;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if (matrix[d][h].count > maxCount) {
        maxCount = matrix[d][h].count;
        peakDay = d;
        peakHour = h;
      }
    }
  }

  return { days, matrix, peakHour, peakDay, total, totalVolume: 0 };
}

function buildHeatmapFromWagers(wagers: Array<Record<string, unknown>>, days: number): HeatmapResult {
  const matrix: HeatmapCell[][] = [];
  for (let d = 0; d < 7; d++) {
    matrix[d] = [];
    for (let h = 0; h < 24; h++) {
      matrix[d][h] = { day: d, hour: h, dayName: DAY_NAMES[d], count: 0, volume: 0 };
    }
  }

  const cutoff = Date.now() - days * 86400000;
  let total = 0;
  let totalVolume = 0;

  for (const wager of wagers) {
    const rawTime = String(wager.Insert_Date_Time || wager.insert_date_time || wager.Date || wager.Time || "");
    const ts = Date.parse(rawTime);
    if (isNaN(ts) || ts < cutoff) continue;
    const date = new Date(ts);
    const dow = date.getDay();
    const hod = date.getHours();
    const amount = Number(wager.AmountWagered || wager.amount_wagered || wager.Risk || wager.volume || 0) / 100;
    matrix[dow][hod].count++;
    matrix[dow][hod].volume += amount;
    total++;
    totalVolume += amount;
  }

  let peakHour: number | null = null;
  let peakDay: number | null = null;
  let maxCount = 0;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if (matrix[d][h].count > maxCount) {
        maxCount = matrix[d][h].count;
        peakDay = d;
        peakHour = h;
      }
    }
  }

  return { days, matrix, peakHour, peakDay, total, totalVolume };
}

// ==========================================
// ANALYTICS: SYNDICATE DETECTION, SHARP MONEY, EV
// ==========================================

interface Wager {
  bettorId: string;
  gameId: string;
  wagerType: string;
  side: string;
  line: number;
  odds: number;
  stake: number;
  timestamp: number;
  profit?: number;
  sport?: string;
  wagerStatus?: string;
  chosenTeam?: string;
  description?: string;
  originalLine?: number;
  adjustedLine?: number;
  isParlay?: boolean;
  parlayName?: string;
  overUnder?: string;
  amountWon?: number;
}

const WAGER_TYPE_MAP: Record<string, string> = {
  L: "STRAIGHT",
  S: "STRAIGHT",
  P: "PARLAY",
  I: "IF_BET",
  T: "TEASER",
  G: "RACEBOOK",
  A: "MANUAL_PLAY",
  C: "CONTEST",
  N: "LIVE_PROP",
  R: "REVERSE",
  M: "MONEYLINE",
};

interface EVCategory {
  category: string;
  roi: number;
  winRate: number;
  avgOdds: number;
  impliedProb: number;
  edge: number;
  sampleSize: number;
}

interface EVResult {
  model: string;
  overall: {
    winRate: number;
    avgOdds: number;
    impliedProbability: number;
    expectedROI: number;
    confidence: number;
  };
  byCategory: EVCategory[];
}

function parseBuckeyeWagers(raw: unknown): Wager[] {
  if (!raw) return [];
  const obj = raw as Record<string, unknown>;
  const list = (obj.LIST || obj.data || obj.list || obj) as Array<Record<string, unknown>>;
  if (!Array.isArray(list)) return [];
  return list.map((w, i) => {
    const rawType = String(w.WagerType || w.wagerType || w.Type || w.type || "L").trim().toUpperCase();
    const wagerType = WAGER_TYPE_MAP[rawType] || rawType;
    const rawSport = String(w.SportType || w.Sport || w.sport || "").trim();
    const rawCustomerId = String(w.customerID || w.Login || w.bettorID || w.playerLogin || w.agentID || `unknown-${i}`).trim();
    const rawTeam = String(w.ChosenTeamID || w.chosenTeam || w.Team1ID || w.side || "").trim();
    const rawStatus = String(w.WagerStatus || w.wagerStatus || w.Status || "").trim();
    const rawOU = String(w.TotalPointsOU || w.OverUnder || "").trim();
    const amountWagered = Number(w.AmountWagered || w.amount_wagered || w.Risk || w.LegAmountWagered || 0);
    const amountWon = Number(w.ToWinAmount || w.amount_won || w.LegToWinAmount || 0);
    const netWinnings = Number(w.NetWinnings || w.net_winnings || 0);
    const origLine = Number(w.OrigSpread || w.OrigTotalPoints || w.Line || w.line || w.Spread || w.spread || 0);
    const adjLine = Number(w.AdjSpread || w.AdjTotalPoints || w.AdjustedSpread || 0);
    const finalOdds = Number(w.FinalMoney || w.Odds || w.odds || w.MoneyLine || w.moneyLine || 0);
    const rawGameId = String(w.GRA || w.gra || w.gameID || w.GameID || w.gameId || `${rawSport}-${w.Team1RotNum || ""}-${w.Team2RotNum || ""}`).trim();
    const rawTime = String(w.AcceptedDateTime || w.Insert_Date_Time || w.insert_date_time || w.Date || w.Time || "");
    const ts = Date.parse(rawTime);
    const isParlay = wagerType === "PARLAY" || wagerType === "TEASER" || Number(w.PlayNumber || w.playNumber || 1) > 1;
    const side = rawOU ? rawOU : (rawTeam.includes("/") ? rawTeam.split("/")[0] : rawTeam);
    return {
      bettorId: rawCustomerId,
      gameId: rawGameId,
      wagerType,
      side,
      line: adjLine || origLine,
      odds: finalOdds,
      stake: amountWagered / 100,
      timestamp: isNaN(ts) ? 0 : ts,
      profit: netWinnings / 100,
      sport: rawSport,
      wagerStatus: rawStatus,
      chosenTeam: rawTeam,
      description: String(w.Description || w.ShortDesc || "").trim(),
      originalLine: origLine,
      adjustedLine: adjLine,
      isParlay,
      parlayName: String(w.ParlayName || "").trim(),
      overUnder: rawOU,
      amountWon: amountWon / 100,
    };
  }).filter(w => w.timestamp > 0);
}

function detectSyndicates(wagers: Wager[], opts: { minBettors: number; minStake: number }): Syndicate[] {
  const { minBettors, minStake } = opts;
  const groups = new Map<string, Wager[]>();
  for (const w of wagers) {
    const key = `${w.gameId}|${w.wagerType}|${w.side}|${w.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(w);
  }

  const syndicates: Syndicate[] = [];
  for (const [, groupWagers] of groups.entries()) {
    const sorted = [...groupWagers].sort((a, b) => a.timestamp - b.timestamp);
    let cluster: Wager[] = [];
    for (let i = 0; i < sorted.length; i++) {
      if (cluster.length === 0) {
        cluster.push(sorted[i]);
      } else if (sorted[i].timestamp - cluster[cluster.length - 1].timestamp <= 300000) {
        cluster.push(sorted[i]);
      } else {
        const syndicate = buildSyndicateFromCluster(cluster, minBettors, minStake);
        if (syndicate) syndicates.push(syndicate);
        cluster = [sorted[i]];
      }
    }
    const syndicate = buildSyndicateFromCluster(cluster, minBettors, minStake);
    if (syndicate) syndicates.push(syndicate);
  }
  return syndicates;
}

function buildSyndicateFromCluster(cluster: Wager[], minBettors: number, minStake: number): Syndicate | null {
  if (cluster.length < minBettors) return null;
  const uniqueBettors = new Set(cluster.map(w => w.bettorId).filter(Boolean));
  const totalStake = cluster.reduce((s, w) => s + w.stake, 0);
  if (uniqueBettors.size < minBettors || totalStake < minStake) return null;

  const sorted = [...cluster].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const windowMs = Math.max(0, last.timestamp - first.timestamp);
  const avgStake = totalStake / cluster.length;
  const stakeMultiplier = minStake > 0 ? totalStake / minStake : 1;
  const speedScore = windowMs <= PROXY_CONSTANTS.SPEED_SCORE_FAST_MS ? 25 : windowMs <= PROXY_CONSTANTS.SPEED_SCORE_MEDIUM_MS ? 15 : 8;
  const bettorScore = Math.min(30, uniqueBettors.size * 8);
  const stakeScore = Math.min(30, Math.round(stakeMultiplier * 12));
  const repeatScore = Math.min(15, cluster.length * 3);
  const riskScore = Math.min(100, Math.round(speedScore + bettorScore + stakeScore + repeatScore));
  const signals = [
    `${uniqueBettors.size} unique bettors`,
    `${cluster.length} same-selection wagers`,
    `$${Math.round(totalStake).toLocaleString()} total stake`,
    `${Math.round(windowMs / 1000)}s cluster window`,
  ];

  return {
    id: randomUUIDv7(),
    members: Array.from(uniqueBettors),
    commonGame: first.gameId,
    pattern: `${first.wagerType} ${first.side || "ANY"} ${first.line}`,
    totalStake,
    timestamp: first.timestamp,
    windowMs,
    wagerCount: cluster.length,
    avgStake,
    riskScore,
    confidence: Math.min(100, Math.round(riskScore * 0.8 + Math.min(20, uniqueBettors.size * 3))),
    signals,
  };
}

function correlateSharpMoney(lineHistory: LineMove[], wagers: Wager[]): SharpAlert[] {
  const alerts: SharpAlert[] = [];
  for (const move of lineHistory) {
    const before = move.timestamp - 60000;
    const relevantWagers = wagers.filter(w =>
      w.timestamp >= before && w.timestamp <= move.timestamp &&
      w.gameId === move.gameId &&
      ((move.lineType === "spread" && w.wagerType === "SPREAD" && w.side.toUpperCase() === move.side.toUpperCase()) ||
        (move.lineType === "total" && w.wagerType === "TOTAL" && w.side.toUpperCase() === move.side.toUpperCase()) ||
        (move.lineType === "moneyline" && w.wagerType === "MONEYLINE"))
    );
    if (relevantWagers.length > 0) {
      const totalStake = relevantWagers.reduce((s, w) => s + w.stake, 0);
      const uniqueBettors = new Set(relevantWagers.map(w => w.bettorId));
      alerts.push({
        gameId: move.gameId,
        movement: move,
        correlatedBettors: Array.from(uniqueBettors),
        totalStake,
        confidence: Math.min(100, Math.round((totalStake / 5000) * 50 + relevantWagers.length * 10)),
      });
    }
  }
  return alerts;
}

function computeExpectedValue(historicalWagers: Wager[], modelType: string): EVResult {
  if (historicalWagers.length < 50) {
    return {
      model: modelType,
      overall: { winRate: 0, avgOdds: 0, impliedProbability: 0, expectedROI: 0, confidence: 0 },
      byCategory: [],
    };
  }

  const groups = new Map<string, Wager[]>();
  for (const w of historicalWagers) {
    const key = `${w.sport || "unknown"}|${w.wagerType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(w);
  }

  const byCategory: EVCategory[] = [];
  for (const [key, groupWagers] of groups.entries()) {
    const totalStake = groupWagers.reduce((s, w) => s + w.stake, 0);
    const totalProfit = groupWagers.reduce((s, w) => s + (w.profit || 0), 0);
    const roi = totalStake > 0 ? totalProfit / totalStake : 0;
    const wins = groupWagers.filter(w => (w.profit ?? 0) > 0).length;
    const winRate = wins / groupWagers.length;
    const avgOdds = groupWagers.reduce((s, w) => s + w.odds, 0) / groupWagers.length;
    const impliedProb = avgOdds > 0 ? 100 / (avgOdds + 100) : -avgOdds / (-avgOdds + 100);
    const edge = winRate - impliedProb;
    byCategory.push({
      category: key,
      roi,
      winRate,
      avgOdds,
      impliedProb,
      edge,
      sampleSize: groupWagers.length,
    });
  }

  const overallWins = historicalWagers.filter(w => (w.profit ?? 0) > 0).length;
  const overallWinRate = overallWins / historicalWagers.length;
  const overallAvgOdds = historicalWagers.reduce((s, w) => s + w.odds, 0) / historicalWagers.length;
  const overallImplied = overallAvgOdds > 0 ? 100 / (overallAvgOdds + 100) : -overallAvgOdds / (-overallAvgOdds + 100);
  const expectedROI = overallWinRate * (overallAvgOdds / 100) - (1 - overallWinRate);

  return {
    model: modelType,
    overall: {
      winRate: overallWinRate,
      avgOdds: overallAvgOdds,
      impliedProbability: overallImplied,
      expectedROI,
      confidence: Math.min(100, historicalWagers.length / 10),
    },
    byCategory,
  };
}

// ==========================================
// PREDICTIVE SHARPNESS SCORING
// ==========================================

interface WagerAnalytic {
  stake: number;
  profit: number;
  sport: string;
  wagerType: string;
  timestamp: number;
}

interface SharpnessResult {
  score: number;
  confidence: number;
  factors: {
    totalBets: number;
    avgStake: number;
    maxStake: number;
    winRate: number;
    recentWinRate: number;
    recentROI: number;
    sports: number;
    types: number;
    stdDev: number;
    insufficient?: boolean;
  };
}

function computePredictiveSharpness(wagers: WagerAnalytic[]): SharpnessResult {
  if (wagers.length < 30) {
    return { score: 0, confidence: 10, factors: { totalBets: wagers.length, avgStake: 0, maxStake: 0, winRate: 0, recentWinRate: 0, recentROI: 0, sports: 0, types: 0, stdDev: 0, insufficient: true } };
  }

  const totalBets = wagers.length;
  const totalStake = wagers.reduce((s, w) => s + w.stake, 0);
  const avgStake = totalStake / totalBets;
  const maxStake = Math.max(...wagers.map(w => w.stake));
  const winRate = wagers.filter(w => w.profit > 0).length / totalBets;

  const variance = wagers.reduce((s, w) => s + Math.pow(w.stake - avgStake, 2), 0) / totalBets;
  const stdDev = Math.sqrt(variance);

  const recent = wagers.slice(-20);
  const recentWinRate = recent.filter(w => w.profit > 0).length / recent.length;
  const recentStake = recent.reduce((s, w) => s + w.stake, 0);
  const recentROI = recentStake > 0 ? recent.reduce((s, w) => s + w.profit, 0) / recentStake : 0;

  const sports = new Set(wagers.map(w => w.sport || "UNK")).size;
  const types = new Set(wagers.map(w => w.wagerType || "UNK")).size;

  let score = 0;
  if (avgStake > 500) score += 15;
  if (maxStake > PROXY_CONSTANTS.HIGH_ROLLER_STAKE) score += 15;
  if (winRate > 0.55) score += 25;
  if (winRate > 0.6) score += 15;
  if (recentWinRate > 0.6) score += 20;
  if (recentROI > 0.1) score += 10;
  if (sports > 3) score += 5;
  if (types > 2) score += 5;
  if (stdDev > avgStake * 0.5) score += 10;
  score = Math.min(100, Math.max(0, score));

  const confidence = Math.min(100, Math.round(30 + (totalBets / 10)));

  return {
    score,
    confidence,
    factors: { totalBets, avgStake, maxStake, winRate, recentWinRate, recentROI, sports, types, stdDev },
  };
}

// ==========================================
// BACKTESTING SIMULATION
// ==========================================

interface BacktestRule {
  sport: string;
  league: string;
  lineType: string;
  condition: string;
  threshold: number;
  adjustmentPercent: number;
  maxMovePercent: number;
}

interface BacktestResult {
  totalAdjustments: number;
  totalProfitImpact: number;
  falsePositives: number;
  adjustmentsByType: Record<string, number>;
  adjustmentsByDay: Array<{ date: string; count: number }>;
  simulatedPnl: number;
}

function simulateLineAdjustments(
  wagers: Wager[],
  rules: BacktestRule[],
  lineHistory: LineMove[],
): BacktestResult {
  let totalAdjustments = 0;
  let falsePositives = 0;
  let simulatedPnl = 0;
  const adjustmentsByType: Record<string, number> = {};

  for (const move of lineHistory) {
    for (const rule of rules) {
      if (rule.lineType !== move.lineType && rule.lineType !== "ANY") continue;

      const nearbyWagers = wagers.filter(w =>
        w.gameId === move.gameId &&
        w.timestamp >= move.timestamp - 300000 &&
        w.timestamp <= move.timestamp
      );

      const totalStake = nearbyWagers.reduce((s, w) => s + w.stake, 0);
      const uniqueBettors = new Set(nearbyWagers.map(w => w.bettorId)).size;

      let conditionMet = false;
      if (rule.condition === "sharp_money_threshold" && totalStake >= rule.threshold) conditionMet = true;
      if (rule.condition === "syndicate_trigger" && uniqueBettors >= 3 && totalStake >= rule.threshold) conditionMet = true;
      if (rule.condition === "manual") continue;

      if (conditionMet) {
        totalAdjustments++;
        const adjKey = `${rule.lineType}:${rule.condition}`;
        adjustmentsByType[adjKey] = (adjustmentsByType[adjKey] || 0) + 1;

        const movement = Math.abs(move.newLine - move.oldLine);
        const maxMove = Math.abs(move.oldLine) * (rule.maxMovePercent / 100);
        if (movement > maxMove) {
          falsePositives++;
        } else {
          const adjustmentDollar = totalStake * (rule.adjustmentPercent / 100);
          simulatedPnl += adjustmentDollar * 0.05;
        }
      }
    }
  }

  const adjustmentsByDay: Array<{ date: string; count: number }> = [];
  const dayMap = new Map<string, number>();
  for (const move of lineHistory) {
    const day = new Date(move.timestamp).toISOString().slice(0, 10);
    dayMap.set(day, (dayMap.get(day) || 0) + 1);
  }
  for (const [date, count] of dayMap.entries()) {
    adjustmentsByDay.push({ date, count });
  }

  return {
    totalAdjustments,
    totalProfitImpact: simulatedPnl,
    falsePositives,
    adjustmentsByType,
    adjustmentsByDay,
    simulatedPnl,
  };
}

// ==========================================
// LINE ADJUSTMENT ENGINE (background)
// ==========================================

let lineEngineRunning = false;
async function evaluateLineAdjustments(): Promise<void> {
  if (lineEngineRunning || !CONFIG.features.analytics) return;
  lineEngineRunning = true;
  try {
    const rules = getAllLineRules.all() as Array<{ id: number; agentID: string; sport: string; league: string; lineType: string; condition: string; threshold: number; adjustmentPercent: number; maxMovePercent: number; enabled: number }>;
    if (rules.length === 0) return;

    for (const rule of rules) {
      const stored = await getStoredCredentials(rule.agentID);
      if (!stored) continue;

      try {
        const wagerRes = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
          method: "POST",
          headers: browserHeaders(stored.token, `cf_clearance=${stored.cf_clearance}`),
          body: toForm({ operation: "getBetTicker", agentID: rule.agentID, agentOwner: rule.agentID, agentSite: "1" }),
        }), { reqId: "line-engine", endpoint: "getBetTicker" });
        const wagerData = await wagerRes.json().catch(() => null);
        const wagers = parseBuckeyeWagers(wagerData);
        const fiveMinAgo = Date.now() - 300000;
        const recentWagers = wagers.filter(w => w.timestamp >= fiveMinAgo);

        const totalStake = recentWagers.reduce((s, w) => s + w.stake, 0);

        let conditionMet = false;
        if (rule.condition === "sharp_money_threshold" && totalStake >= rule.threshold) conditionMet = true;
        if (rule.condition === "syndicate_trigger") {
          const syndicates = detectSyndicates(recentWagers, { minBettors: 3, minStake: rule.threshold });
          if (syndicates.length > 0) conditionMet = true;
        }

        if (conditionMet) {
          const gameGroups = new Map<string, Wager[]>();
          for (const w of recentWagers) {
            if (!gameGroups.has(w.gameId)) gameGroups.set(w.gameId, []);
            gameGroups.get(w.gameId)!.push(w);
          }

          for (const [gameId, gameWagers] of gameGroups.entries()) {
            const gameStake = gameWagers.reduce((s, w) => s + w.stake, 0);
            if (gameStake < rule.threshold) continue;

            const gameLines = getLineHistory.all({ $gameId: gameId, $since: Math.floor(fiveMinAgo / 1000) }) as Array<{ lineType: string; side: string; oldLine: number; newLine: number }>;
            if (gameLines.length > 0 && rule.lineType !== "ANY") {
              for (const line of gameLines) {
                if (line.lineType === rule.lineType.toLowerCase()) {
                  const oldLine = line.oldLine;
                  const newLine = line.newLine || oldLine + (oldLine * rule.adjustmentPercent / 100);
                  const maxMove = Math.abs(oldLine) * (rule.maxMovePercent / 100);
                  const finalLine = Math.min(Math.abs(newLine), Math.abs(oldLine) + maxMove) * Math.sign(newLine || oldLine || 1);

                  insertLineAdjLog.run({
                    $gameId: gameId, $lineType: line.lineType, $side: line.side,
                    $oldLine: oldLine, $newLine: finalLine,
                    $reason: rule.condition, $ruleId: rule.id, $executed_by: "auto_engine",
                  });

                  logger.info("Line adjustment", { gameId, lineType: line.lineType, oldLine, newLine: finalLine, rule: rule.id });
                }
              }
            } else {
              const primaryWager = gameWagers[0];
              const assumedOldLine = primaryWager?.line || 0;
              const adjustment = assumedOldLine * (rule.adjustmentPercent / 100);
              const newLine = assumedOldLine + adjustment;
              const maxMove = Math.abs(assumedOldLine) * (rule.maxMovePercent / 100);
              const finalLine = assumedOldLine === 0 ? adjustment : Math.min(Math.abs(newLine), Math.abs(assumedOldLine) + maxMove) * Math.sign(newLine);

              insertLineAdjLog.run({
                $gameId: gameId, $lineType: rule.lineType, $side: primaryWager?.side || "UNKNOWN",
                $oldLine: assumedOldLine, $newLine: finalLine,
                $reason: rule.condition, $ruleId: rule.id, $executed_by: "auto_engine",
              });

              logger.info("Line adjustment (assumed)", { gameId, lineType: rule.lineType, oldLine: assumedOldLine, newLine: finalLine, rule: rule.id });
            }

            for (const [, sub] of subscribers) {
              safeSendJson(sub.ws, {
                type: "line_adjustment",
                gameId,
                lineType: rule.lineType,
                ruleId: rule.id,
                condition: rule.condition,
                stake: gameStake,
                threshold: rule.threshold,
                timestamp: Date.now(),
              }, "line-adjustment");
            }
          }
        }
      } catch (err: unknown) {
        logger.warn("Line engine rule evaluation failed", { agentID: rule.agentID, ruleId: rule.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    lineEngineRunning = false;
  }
}

if (CONFIG.features.analytics) {
  setInterval(() => { void evaluateLineAdjustments().catch(() => { }); }, 60000);
}

const memCache = new Map<string, { value: unknown; expires: number }>();
const tokenMemCache = new Map<string, { token: TokenRow | null; expires: number }>();
const inflight = new Map<string, Promise<unknown>>();
let cacheHits = 0;
let cacheMisses = 0;

function setMemCache(key: string, value: unknown, ttlMs = CONFIG.memoryCacheTtlMs): void {
  if (!CONFIG.features.memoryCache) return;
  memCache.set(key, { value, expires: Date.now() + ttlMs });
}

function getMemCache(key: string): unknown | null {
  if (!CONFIG.features.memoryCache) return null;
  const hit = memCache.get(key);
  if (!hit) { cacheMisses++; return null; }
  if (Date.now() > hit.expires) {
    memCache.delete(key);
    cacheMisses++;
    return null;
  }
  cacheHits++;
  return hit.value;
}

function getCachedToken(customerID: string): TokenRow | null {
  if (!CONFIG.features.tokenCache) {
    return getLatestTokenWrite.get({ $customerID: customerID }) as TokenRow | null;
  }
  const cached = tokenMemCache.get(customerID);
  if (cached && Date.now() < cached.expires) return cached.token;
  const token = getLatestTokenWrite.get({ $customerID: customerID }) as TokenRow | null;
  tokenMemCache.set(customerID, { token, expires: Date.now() + CONFIG.tokenCacheTtlMs });
  return token;
}

function invalidateTokenCache(customerID: string): void {
  tokenMemCache.delete(customerID);
}

const proxySecretMemory = new Map<string, string>();

function proxySecretCacheKey(name: string, customerID?: string | null): string {
  const normalizedCustomer = String(customerID || "").trim().toUpperCase();
  return normalizedCustomer ? `${normalizedCustomer}:${name}` : name;
}

function rememberProxySecretInMemory(name: string, value: string, customerID?: string | null): void {
  if (!value) return;
  const normalizedCustomer = String(customerID || "").trim().toUpperCase();
  proxySecretMemory.set(proxySecretCacheKey(name, normalizedCustomer || null), value);
}

async function readProxySecret(name: typeof PROXY_SECRET_NAMES[keyof typeof PROXY_SECRET_NAMES], customerID?: string | null): Promise<string> {
  const scopedKey = proxySecretCacheKey(name, customerID);
  const fromMemory = proxySecretMemory.get(scopedKey) || proxySecretMemory.get(name);
  if (fromMemory) return name === PROXY_SECRET_NAMES.cfClearance ? extractCfClearanceValue(fromMemory) : fromMemory;

  const fromConfig =
    name === PROXY_SECRET_NAMES.password ? CONFIG.password :
      name === PROXY_SECRET_NAMES.cfClearance ? CONFIG.cfClearance :
        undefined;
  if (fromConfig) return name === PROXY_SECRET_NAMES.cfClearance ? extractCfClearanceValue(fromConfig) : fromConfig;

  if (shouldUseKeychain()) {
    const fromKeychain = await getScopedSecret(name, customerID);
    if (fromKeychain) {
      const value = name === PROXY_SECRET_NAMES.cfClearance ? extractCfClearanceValue(fromKeychain) : fromKeychain;
      rememberProxySecretInMemory(name, value, customerID);
      return value;
    }
  }

  const fromEnv = proxySecretEnvFallback(name);
  if (fromEnv) {
    const value = name === PROXY_SECRET_NAMES.cfClearance ? extractCfClearanceValue(fromEnv) : fromEnv;
    rememberProxySecretInMemory(name, value, customerID);
    if (shouldUseKeychain()) {
      await setScopedSecret(name, value, customerID);
    }
    return value;
  }

  return "";
}

async function rememberProxyCredentialSecrets(customerID: string, values: ProxyCredentialValues): Promise<void> {
  const password = values.password ? String(values.password) : "";
  const cfClearance = values.cfClearance ? extractCfClearanceValue(String(values.cfClearance)) : "";

  if (password) {
    rememberProxySecretInMemory(PROXY_SECRET_NAMES.password, password, customerID);
    if (shouldUseKeychain()) await setScopedSecret(PROXY_SECRET_NAMES.password, password, customerID);
  }
  if (cfClearance) {
    rememberProxySecretInMemory(PROXY_SECRET_NAMES.cfClearance, cfClearance, customerID);
    if (shouldUseKeychain()) await setScopedSecret(PROXY_SECRET_NAMES.cfClearance, cfClearance, customerID);
  }
}

async function loadProxyCredentials(customerID: string, incoming: ProxyCredentialValues = {}): Promise<Required<ProxyCredentialValues>> {
  const incomingPassword = incoming.password ? String(incoming.password) : "";
  const incomingCf = incoming.cfClearance ? extractCfClearanceValue(String(incoming.cfClearance)) : "";
  return {
    password: incomingPassword || await readProxySecret(PROXY_SECRET_NAMES.password, customerID),
    cfClearance: incomingCf || await readProxySecret(PROXY_SECRET_NAMES.cfClearance, customerID),
  };
}

function applyManagedSecretToConfig(name: string, value: string | null): void {
  const next = value || undefined;
  switch (name) {
    case PROXY_SECRET_NAMES.proxyAdminKey:
      CONFIG.apiKey = next || Bun.env.PROXY_API_KEY || "dev-key-123";
      CONFIG.adminApiKey = next || Bun.env.ADMIN_API_KEY || CONFIG.apiKey;
      break;
    case PROXY_SECRET_NAMES.buckeyeApiKey:
      CONFIG.buckeyeApiKey = next;
      break;
    case PROXY_SECRET_NAMES.buckeyeCustomerId:
      CONFIG.customerId = next;
      CONFIG.agentId ||= next;
      CONFIG.agentOwner ||= next;
      break;
    case PROXY_SECRET_NAMES.password:
      CONFIG.password = next;
      break;
    case PROXY_SECRET_NAMES.agentId:
      CONFIG.agentId = next || CONFIG.customerId;
      break;
    case PROXY_SECRET_NAMES.agentOwner:
      CONFIG.agentOwner = next || CONFIG.customerId;
      break;
    case PROXY_SECRET_NAMES.kimiApiKey:
      CONFIG.kimiApiKey = next;
      break;
    case PROXY_SECRET_NAMES.cfClearance:
    case "buckeye-cf-clearance":
      CONFIG.cfClearance = next ? extractCfClearanceValue(next) : undefined;
      if (CONFIG.cfClearance) rememberProxySecretInMemory(PROXY_SECRET_NAMES.cfClearance, CONFIG.cfClearance);
      break;
  }
}

function memCacheKey(endpoint: string, payload: JsonObject): string {
  return `${endpoint}:${hashPayloadImpl({ endpoint, ...payload })}`;
}

function isTokenExpired(customerID: string): boolean {
  const token = getCachedToken(customerID);
  if (!token?.expires_at) return true;
  return token.expires_at <= Math.floor(Date.now() / 1000);
}

async function dedupeRequest<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!CONFIG.features.requestDedupe) return fn();
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function normalizeResponse(endpoint: string, raw: unknown, keyOverride?: string): unknown {
  if (!CONFIG.features.responseNormalize) return raw;
  if (typeof raw !== "object" || raw === null) return raw;

  const topLevelRows = Array.isArray(raw) ? raw.filter(isTaxonomyRecord) : null;
  const obj = topLevelRows ? {} as Record<string, unknown> : raw as Record<string, unknown>;
  const list = topLevelRows ?? obj.LIST ?? obj.Data ?? obj.data ?? obj.Result ?? obj.result ?? obj.GENERAL ?? null;
  const arr = Array.isArray(list) ? list : (list ? [list] : null);
  const meta = getEndpointMeta(endpoint);
  const key = keyOverride || meta?.key || "";

  if (key === "betTicker" || endpoint.includes("getBetTicker")) {
    const wagers = (arr || [obj]).map((w: Record<string, unknown>) => ({
      wagerNumber: w.WagerNumber || w.ItemNumber || w.wagerNumber,
      agentID: String(w.agentID || w.AgentID || w.AgentLogin || "").trim(),
      customerID: String(w.customerID || w.Login || "").trim(),
      nameFirst: String(w.NameFirst || "").trim(),
      login: String(w.Login || "").trim(),
      wagerType: WAGER_TYPE_MAP[String(w.WagerType || w.LegWagerType || "L").trim().toUpperCase()] || String(w.WagerType || "L").trim(),
      wagerTypeCode: String(w.WagerType || w.LegWagerType || "L").trim(),
      amountWagered: Number(w.AmountWagered || w.LegAmountWagered || 0) / 100,
      toWinAmount: Number(w.ToWinAmount || w.LegToWinAmount || 0) / 100,
      netWinnings: Number(w.NetWinnings || 0) / 100,
      volumeAmount: Number(w.VolumeAmount || w.AmountWagered || 0) / 100,
      sportType: String(w.SportType || w.Sport || "").trim(),
      chosenTeam: String(w.ChosenTeamID || w.Team1ID || "").trim(),
      description: String(w.Description || w.ShortDesc || "").trim(),
      origSpread: Number(w.OrigSpread || w.OrigTotalPoints || 0),
      adjSpread: Number(w.AdjSpread || w.AdjTotalPoints || 0),
      finalMoney: Number(w.FinalMoney || w.Odds || 0),
      overUnder: String(w.TotalPointsOU || "").trim(),
      wagerStatus: String(w.WagerStatus || w.Status || "").trim(),
      gameDateTime: String(w.GameDateTime || "").trim(),
      team1: String(w.Team1ID || w.ShortName1 || "").trim(),
      team2: String(w.Team2ID || w.ShortName2 || "").trim(),
      team1Rot: Number(w.Team1RotNum || 0),
      team2Rot: Number(w.Team2RotNum || 0),
      isParlay: Number(w.PlayNumber || 1) > 1 || String(w.WagerType || "L").trim() === "P",
      parlayName: String(w.ParlayName || "").trim(),
      placedOn: String(w.PlacedOn || "").trim(),
      acceptedDateTime: String(w.AcceptedDateTime || "").trim(),
    }));
    return { wagers, count: wagers.length, rawCount: arr ? arr.length : 1 };
  }

  if (key === "pending" || endpoint.includes("getPending")) {
    const nestedList = typeof list === "object" && list !== null && !Array.isArray(list)
      ? (list as Record<string, unknown>).ARRAY ?? (list as Record<string, unknown>).array
      : null;
    const rows = topLevelRows
      ? topLevelRows
      : Array.isArray(list)
        ? list as Record<string, unknown>[]
        : Array.isArray(nestedList)
          ? nestedList as Record<string, unknown>[]
          : arr
            ? arr as Record<string, unknown>[]
            : [obj];
    const grouped = new Map<string, Record<string, unknown>[]>();

    for (const row of rows) {
      const ticketNumber = cleanString(row.TicketNumber ?? row.ticketNumber);
      const wagerNumber = cleanString(row.WagerNumber ?? row.wagerNumber);
      const key = `${ticketNumber || "ticket"}-${wagerNumber || grouped.size}`;
      const group = grouped.get(key) || [];
      group.push(row);
      grouped.set(key, group);
    }

    const wagers = Array.from(grouped.entries()).map(([groupKey, legs]) => {
      const first = legs[0] || {};
      const wagerType = cleanString(first.WagerType ?? first.wagerType).toUpperCase();
      const ticketNumber = numberField(first, ["TicketNumber", "ticketNumber"]);
      const wagerNumber = numberField(first, ["WagerNumber", "wagerNumber"]);
      const stake = moneyField(first, ["AmountWagered", "amountWagered"]);
      const toWin = moneyField(first, ["ToWinAmount", "toWinAmount"]);

      return {
        key: groupKey,
        ticketNumber,
        wagerNumber,
        player: {
          id: cleanString(first.customerID ?? first.playerID),
          name: cleanString(first.NameFirst ?? first.name),
          login: cleanString(first.Login ?? first.login),
          agent: cleanString(first.AgentLogin ?? first.agentID ?? first.agent),
        },
        wager: {
          type: wagerType,
          typeName: pendingWagerTypeName(wagerType),
          status: cleanString(first.WagerStatus ?? first.status, "P"),
          outcome: cleanString(first.Outcome ?? first.outcome, "P"),
          stake,
          toWin,
          risk: stake,
          description: cleanString(first.Description ?? first.description),
          placedAt: cleanString(first.AcceptedDateTime ?? first.placedAt),
          placedOn: cleanString(first.PlacedOn ?? first.placedOn, "Internet"),
          credit: cleanString(first.CreditAcctFlag ?? first.credit) === "Y",
          freePlay: cleanString(first.FreePlayFlag ?? first.freePlay) === "Y",
          roundRobin: numberField(first, ["RoundRobinLink", "roundRobin"]) === 1,
          parlayName: cleanString(first.ParlayName ?? first.TeaserName) || null,
          totalPicks: numberField(first, ["totalPicks", "TotalPicks"], legs.length),
          teaserPoints: numberField(first, ["TeaserPoints", "teaserPoints"]),
        },
        legs: legs.map((leg, index) => {
          const legWagerType = cleanString(leg.LegWagerType ?? leg.legType).toUpperCase();
          const side = pendingTotalSide(leg);
          const wagerTypeName = pendingLegMarketName(legWagerType, side);
          const odds = numberField(leg, ["FinalMoney", "finalMoney"]);
          const spread = numberField(leg, ["AdjSpread", "adjSpread", "OrigSpread"]);
          const totalPoints = numberField(leg, ["AdjTotalPoints", "adjTotalPoints", "OrigTotalPoints"]);
          const line = wagerTypeName === "MONEYLINE" ? odds : wagerTypeName === "TOTAL" ? totalPoints : spread;
          return {
            itemNumber: numberField(leg, ["ItemNumber", "itemNumber"], index + 1),
            chosenTeam: cleanString(leg.ChosenTeamID ?? leg.chosenTeam),
            wagerType: legWagerType,
            wagerTypeName,
            side,
            line,
            odds,
            spread,
            totalPoints,
            buyPoints: numberField(leg, ["BuyPoints", "buyPoints"]),
            game: {
              datetime: cleanString(leg.GameDateTime ?? leg.gameDateTime),
              sport: cleanString(leg.SportType ?? leg.sport),
              league: cleanString(leg.SportSubType ?? leg.league),
              away: {
                team: cleanString(leg.Team1ID ?? leg.awayTeam),
                shortName: cleanString(leg.ShortName1 ?? leg.awayShort),
                rot: numberField(leg, ["Team1RotNum", "awayRot"]),
                pitcher: cleanString(leg.ListedPitcher1 ?? leg.awayPitcher) || null,
                pitcherReq: cleanString(leg.Pitcher1ReqFlag ?? leg.awayPitcherReq) === "Y",
                logo: cleanString(leg.LogoTeam1 ?? leg.awayLogo) || null,
                score: leg.Team1FinalScore ?? leg.awayScore ?? null,
              },
              home: {
                team: cleanString(leg.Team2ID ?? leg.homeTeam),
                shortName: cleanString(leg.ShortName2 ?? leg.homeShort),
                rot: numberField(leg, ["Team2RotNum", "homeRot"]),
                pitcher: cleanString(leg.ListedPitcher2 ?? leg.homePitcher) || null,
                pitcherReq: cleanString(leg.Pitcher2ReqFlag ?? leg.homePitcherReq) === "Y",
                logo: cleanString(leg.LogoTeam2 ?? leg.homeLogo) || null,
                score: leg.Team2FinalScore ?? leg.homeScore ?? null,
              },
            },
            volume: moneyField(leg, ["VolumeAmount", "volume"]),
            legStake: moneyField(leg, ["LegAmountWagered", "legStake"]),
            legToWin: moneyField(leg, ["LegToWinAmount", "legToWin"]),
          };
        }),
      };
    });

    return {
      date: obj.Date || obj.date,
      totalPending: obj.Total || wagers.length,
      totalRisk: moneyField(obj, ["TotalRisk", "totalRisk"], wagers.reduce((sum, wager) => sum + wager.wager.stake, 0)),
      totalToWin: wagers.reduce((sum, wager) => sum + wager.wager.toWin, 0),
      rawRowCount: rows.length,
      wagers,
    };
  }

  if (key === "sportsLeagues" || endpoint.includes("Get_SportsLeagues") || endpoint.includes("getSports")) {
    const sports = (arr || [obj]).map((s: Record<string, unknown>) => {
      const leagueRows = s.Leagues || s.leagues;
      return {
        id: s.SportID || s.ID || s.Sport,
        code: s.Sport || s.Code,
        name: s.SportName || s.Name || s.Description,
        icon: s.Icon || s.SportIcon,
        leagues: Array.isArray(leagueRows) ? leagueRows.map((lg: Record<string, unknown>) => ({
          id: lg.LeagueID || lg.ID || lg.League,
          code: lg.League || lg.Code,
          name: lg.LeagueName || lg.Name || lg.Description,
          season: lg.Season || lg.CurrentSeason,
          hasLines: lg.HasLines || lg.hasLines || true,
        })) : [],
      };
    });
    return { sports, count: sports.length };
  }

  if (key === "leagueLines" || endpoint.includes("Get_LeagueLines") || endpoint.includes("getLines")) {
    const games = (arr || [obj]).map((g: Record<string, unknown>) => {
      const lineRows = g.Lines || g.lines || g.Line;
      return {
        id: g.GameID || g.ID,
        rot: g.RotNum || g.Rotation || g.ROT,
        datetime: g.GameDateTime || g.DateTime,
        status: g.GameStatus || g.Status || "SCHEDULED",
        away: { team: g.AwayTeam || g.Away, pitcher: g.AwayPitcher || null, score: g.AwayScore || null, rot: g.AwayRot || g.RotNumAway || null },
        home: { team: g.HomeTeam || g.Home, pitcher: g.HomePitcher || null, score: g.HomeScore || null, rot: g.HomeRot || g.RotNumHome || null },
        lines: Array.isArray(lineRows) ? lineRows.map((ln: Record<string, unknown>) => ({
          id: ln.LineID || ln.ID,
          type: ln.WagerType || ln.Type || "SPREAD",
          period: ln.Period || ln.period || "FG",
          side: ln.Side || ln.side || null,
          line: ln.Line || ln.Points || ln.Spread || 0,
          odds: ln.Odds || ln.odd || 0,
          overOdds: ln.OverOdds || ln.over || null,
          underOdds: ln.UnderOdds || ln.under || null,
          moneyline: ln.MoneyLine || ln.moneyline || null,
          vig: ln.Vig || 110,
          maxRisk: ln.MaxRisk || ln.maxRisk || null,
          status: ln.Status || "OPEN",
        })) : [],
      };
    });
    return { games, count: games.length };
  }

  if ((key === "games" || endpoint.includes("getGames")) && key !== "liveGame") {
    const games = (arr || [obj]).map((g: Record<string, unknown>) => ({
      id: g.GameID || g.ID, sport: g.Sport || g.sport, league: g.League || g.league,
      away: g.AwayTeam || g.Away, home: g.HomeTeam || g.Home,
      datetime: g.GameDateTime || g.DateTime, status: g.Status || g.GameStatus || "SCHEDULED", tv: g.TV || null,
    }));
    return { games, count: games.length };
  }

  if (key === "playerInfo" || endpoint.includes("getInfoPlayer")) {
    const p = (arr ? arr[0] : obj) as Record<string, unknown>;
    return { player: { id: p.Player || p.ID || p.playerID, name: p.Name || p.PlayerName, balance: p.Balance || 0, atRisk: p.AtRisk || 0, dayGross: p.DayGross || 0, weekGross: p.WeekGross || 0, monthGross: p.MonthGross || 0, status: p.Status || "Active", agent: p.Agent || p.AgentID, phone: p.Phone || null, email: p.Email || null, lastLogin: p.LastLogin || null, lastWager: p.LastWager || null, creditLimit: p.CreditLimit || 0, maxWager: p.MaxWager || 0 } };
  }

  if (key === "agentDownline" || endpoint.includes("getListAgenstByAgent") || endpoint.includes("getAgentManagement")) {
    const rows = buckeyeRows(raw);
    const agents = (rows.length ? rows : (arr || [obj])).map((a: Record<string, unknown>) => ({
      id: stringField(a, ["Agent", "AgentID", "ID", "agentID", "customerID", "Login", "login"]),
      name: stringField(a, ["Name", "AgentName", "name", "Username", "Login", "login"]),
      login: stringField(a, ["AgentLogin", "Login", "login"]),
      type: stringField(a, ["Type", "AgentType", "type"], "Agent"),
      status: stringField(a, ["Status", "status"], "Active"),
      players: numberField(a, ["Players", "PlayerCount", "players", "playerCount"]),
      subAgents: numberField(a, ["SubAgents", "subAgents"]),
      balance: numberField(a, ["Balance", "balance"]),
      weekGross: numberField(a, ["WeekGross", "weekGross"]),
      dayGross: numberField(a, ["DayGross", "dayGross"]),
      monthGross: numberField(a, ["MonthGross", "monthGross"]),
      creditLimit: numberField(a, ["CreditLimit", "creditLimit"]),
      maxWager: numberField(a, ["MaxWager", "maxWager"]),
      phone: nullableStringField(a, ["Phone", "phone"]),
      email: nullableStringField(a, ["Email", "email"]),
      lastLogin: nullableStringField(a, ["LastLogin", "lastLogin"]),
      created: nullableStringField(a, ["Created", "created"]),
      commission: numberField(a, ["Commission", "commission"]),
      holdPercent: numberField(a, ["HoldPercent", "holdPercent", "Hold", "hold"]),
    }));
    return { agents, count: agents.length };
  }

  if (key === "dynamicLive" || endpoint.includes("getDynamicLive")) {
    const events = (arr || [obj]).map((e: Record<string, unknown>) => ({
      id: e.GameID || e.EventID || e.ID, sport: e.Sport, league: e.League,
      away: e.AwayTeam || e.Away, home: e.HomeTeam || e.Home,
      awayScore: e.AwayScore || 0, homeScore: e.HomeScore || 0,
      period: e.Period || e.CurrentPeriod || "1Q", timeRemaining: e.TimeRemaining || e.Clock || null,
      status: e.Status || "LIVE", lines: e.Lines || e.lines || [],
    }));
    return { events, count: events.length };
  }

  if (key === "accountInfo" || endpoint.includes("getAccountInfoOwner")) {
    const info = (obj.INFO || obj.info || obj.accountInfo || obj) as Record<string, unknown>;
    return { account: { id: info.customerID || info.CustomerID || info.AgentID, active: info.Active ?? info.active, balance: info.CurrentBalance || info.Balance || 0, available: info.AvailableBalance || info.Available || 0, creditLimit: info.CreditLimit || 0 } };
  }

  if (key === "vigSetup" || endpoint.includes("getSportsVigSetup")) {
    const settings = (arr || [obj]).map((s: Record<string, unknown>) => ({
      sport: s.Sport || s.sport, vig: s.Vig || s.vig || 110, juice: s.Juice || s.juice || 0,
      minVig: s.MinVig || s.minVig || 100, maxVig: s.MaxVig || s.maxVig || 150,
    }));
    return { settings, count: settings.length };
  }

  if (key === "amountLimits" || endpoint.includes("getAmountLimitGroup")) {
    const limits = (arr || [obj]).map((lim: Record<string, unknown>) => ({
      type: lim.WagerType || lim.Type || "STRAIGHT", min: lim.MinAmount || lim.Min || 0,
      max: lim.MaxAmount || lim.Max || 0, perWager: lim.PerWager || lim.maxPerWager || 0,
    }));
    return { limits, count: limits.length };
  }

  if (key === "buyPoints" || endpoint.includes("getBuyPointsGroup")) {
    const groups = (arr || [obj]).map((g: Record<string, unknown>) => ({
      id: g.GroupID || g.ID, name: g.Name || g.GroupName, sport: g.Sport,
      points: g.Points || g.points || 0, cost: g.Cost || g.cost || 0,
    }));
    return { groups, count: groups.length };
  }

  if (key === "agentBilling" || endpoint.includes("getAgentBilling") || endpoint.includes("getWeeklyFigure")) {
    const rows = buckeyeRows(raw);
    const figures = (rows.length ? rows : (arr || [obj])).map((f: Record<string, unknown>) => ({
      agent: stringField(f, ["Agent", "AgentID", "agent"]),
      name: stringField(f, ["Name", "agentName", "AgentName"]),
      gross: numberField(f, ["Gross", "gross"]),
      net: numberField(f, ["Net", "net"]),
      hold: numberField(f, ["HoldPercent", "Hold", "hold"]),
      commission: numberField(f, ["Commission", "commission"]),
      wagers: numberField(f, ["Wagers", "wagerCount", "wagers"]),
      wins: numberField(f, ["Wins", "wins"]),
      losses: numberField(f, ["Losses", "losses"]),
      pending: numberField(f, ["Pending", "pending"]),
      cancelled: numberField(f, ["Cancelled", "cancelled"]),
      refunded: numberField(f, ["Refunded", "refunded"]),
      totalRisk: numberField(f, ["TotalRisk", "totalRisk"]),
      totalWin: numberField(f, ["TotalWin", "totalWin"]),
      avgBet: numberField(f, ["AverageBet", "avgBet"]),
      openBets: numberField(f, ["OpenBets", "openBets"]),
      playersActive: numberField(f, ["PlayersActive", "playersActive"]),
      newPlayers: numberField(f, ["NewPlayers", "newPlayers"]),
    }));
    return {
      period: stringField(obj, ["Period", "period", "Week", "week"]),
      startDate: stringField(obj, ["StartDate", "startDate"]),
      endDate: stringField(obj, ["EndDate", "endDate"]),
      figures,
      count: figures.length,
    };
  }

  if (key === "gameVolume" || endpoint.includes("getGameVolume")) {
    return { gameId: (obj as Record<string, unknown>).GameID || (obj as Record<string, unknown>).gameId, awayVolume: (obj as Record<string, unknown>).AwayVolume || 0, homeVolume: (obj as Record<string, unknown>).HomeVolume || 0, totalRisk: (obj as Record<string, unknown>).TotalRisk || 0, totalCount: (obj as Record<string, unknown>).WagerCount || 0, exposure: (obj as Record<string, unknown>).Exposure || 0 };
  }

  if (key === "scoresLive" || endpoint.includes("getScoresLiveDynamic")) {
    const scores = (arr || [obj]).map((s: Record<string, unknown>) => ({
      id: s.GameID || s.EventID || s.ID, sport: s.Sport || s.SportType, league: s.League,
      away: s.AwayTeam || s.Away, home: s.HomeTeam || s.Home,
      awayScore: s.AwayScore || s.Team1FinalScore || 0, homeScore: s.HomeScore || s.Team2FinalScore || 0,
      period: s.Period || s.CurrentPeriod || "", timeRemaining: s.TimeRemaining || s.Clock || null,
      status: s.Status || "LIVE",
    }));
    return { scores, count: scores.length };
  }

  if (key === "sportsTypesLive" || endpoint.includes("getSportsTypesLive")) {
    const sports = (arr || [obj]).map((s: Record<string, unknown>) => ({
      id: s.SportID || s.ID || s.SportType, name: s.SportName || s.Sport || s.Name, count: s.GameCount || s.Count || 0, live: true,
    }));
    return { sports, count: sports.length };
  }

  if (key === "liveGame") {
    const scores = (arr || [obj]).map((s: Record<string, unknown>) => ({
      id: s.GameID || s.ID, sport: s.Sport, away: s.AwayTeam || s.Away, home: s.HomeTeam || s.Home,
      awayScore: s.AwayScore || 0, homeScore: s.HomeScore || 0, period: s.Period || s.CurrentPeriod || "",
      timeRemaining: s.TimeRemaining || s.Clock || null, status: s.Status || "LIVE",
    }));
    return { scores, count: scores.length };
  }

  if (key === "props" || endpoint.includes("getProps")) {
    const props = (arr || [obj]).map((p: Record<string, unknown>) => ({
      id: p.PropID || p.ID, sport: p.Sport, league: p.League, type: p.PropType || p.Type || "",
      description: p.Description || p.Desc || "", status: p.Status || "OPEN",
    }));
    return { props, count: props.length };
  }

  if (key === "authorizations" || endpoint.includes("getAuthorizations")) {
    return { permissions: obj.agent || obj.Agent || obj.permissions || obj.Permissions || obj };
  }

  if (key === "newEmails" || endpoint.includes("getNewEmailsCount")) {
    const emailInfo = (obj.INFO || obj.info || obj) as Record<string, unknown>;
    return { count: emailInfo.newMsgCount || emailInfo.NewMsgCount || 0 };
  }

  if (key === "renewToken" || endpoint.includes("renewToken")) {
    return {
      token: String(obj.token || obj.code || obj.access_token || ""),
      expires: Number(obj.expires || obj.expires_at || 0),
    };
  }

  if (arr && arr.length > 0) {
    return { items: arr, count: arr.length };
  }

  return raw;
}

function isTaxonomyLevel(level: string): level is TaxonomyLevel {
  return Object.prototype.hasOwnProperty.call(TAXONOMY_MAP, level);
}

function taxonomyList(raw: unknown): TaxonomyRecord[] {
  const root = asTaxonomyRecord(raw);
  const candidate = root ? (root.LIST ?? root.data ?? root.result) : raw;
  const rows = Array.isArray(candidate) ? candidate : candidate === undefined || candidate === null ? [] : [candidate];
  return rows.filter(isTaxonomyRecord);
}

function isTaxonomyRecord(value: unknown): value is TaxonomyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTaxonomyRecord(value: unknown): TaxonomyRecord | null {
  return isTaxonomyRecord(value) ? value : null;
}

function stringField(row: TaxonomyRecord, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && value !== "") return String(value);
  }
  return fallback;
}

function nullableStringField(row: TaxonomyRecord, keys: string[]): string | null {
  const value = stringField(row, keys);
  return value || null;
}

function numberField(row: TaxonomyRecord, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

function moneyField(row: TaxonomyRecord, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = row[key];
    const amount = typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
        ? Number(value)
        : null;
    if (amount !== null) return Math.abs(amount) >= 1000 ? amount / 100 : amount;
  }
  return fallback;
}

function pendingWagerTypeName(code: string): string {
  switch (code) {
    case "":
      return "ALL TYPES";
    case "P":
      return "PARLAY";
    case "I":
      return "IF BET";
    case "T":
      return "TEASER";
    case "G":
      return "RACEBOOK";
    case "A":
      return "MANUAL PLAY";
    case "C":
      return "CONTEST";
    case "N":
      return "LIVE/PROP";
    case "L":
      return "LINE";
    case "S":
      return "STRAIGHT";
    default:
      return code || "PENDING";
  }
}

function pendingTotalSide(row: TaxonomyRecord): string | null {
  const side = stringField(row, ["TotalPointsOU", "totalPointsOU", "Side", "side"]).trim().toUpperCase();
  if (side === "O" || side === "OVER") return "OVER";
  if (side === "U" || side === "UNDER") return "UNDER";
  return side || null;
}

function pendingLegMarketName(code: string, side: string | null): string {
  switch (code) {
    case "M":
      return "MONEYLINE";
    case "S":
      return "SPREAD";
    case "L":
      return side === "OVER" || side === "UNDER" ? "TOTAL" : "LINE";
    default:
      return code || "LINE";
  }
}

function activeField(row: TaxonomyRecord): boolean {
  return row.Active !== false && row.Status !== "Inactive";
}

function normalizeTaxonomy(level: TaxonomyLevel, raw: unknown): unknown[] {
  const list = taxonomyList(raw);

  switch (level) {
    case "sports":
      return list.map((sport) => ({
        id: stringField(sport, ["SportID", "id", "Sport", "code"]),
        code: stringField(sport, ["Sport", "code", "SportCode"]),
        name: stringField(sport, ["SportName", "name", "SportDescription", "Description"]),
        icon: nullableStringField(sport, ["SportIcon", "icon"]),
        active: activeField(sport),
        seasons: Array.isArray(sport.Seasons) ? sport.Seasons : [],
      }));
    case "leagues":
      return list.map((league) => ({
        id: stringField(league, ["LeagueID", "id", "League"]),
        code: stringField(league, ["League", "code", "LeagueCode"]),
        name: stringField(league, ["LeagueName", "name", "Description"]),
        sport: stringField(league, ["Sport", "sport", "SportCode"]),
        region: stringField(league, ["Region", "region", "Country"], "INT"),
        season: stringField(league, ["Season", "season", "CurrentSeason"]),
        active: activeField(league),
      }));
    case "schedule":
      return list.map((game) => ({
        id: stringField(game, ["GameID", "id", "GameNum", "EventID"]),
        sport: stringField(game, ["Sport", "sport"]),
        league: stringField(game, ["League", "league"]),
        away: {
          team: stringField(game, ["AwayTeam", "away", "Away"]),
          pitcher: nullableStringField(game, ["AwayPitcher", "awayPitcher"]),
          score: nullableStringField(game, ["AwayScore", "awayScore"]),
        },
        home: {
          team: stringField(game, ["HomeTeam", "home", "Home"]),
          pitcher: nullableStringField(game, ["HomePitcher", "homePitcher"]),
          score: nullableStringField(game, ["HomeScore", "homeScore"]),
        },
        datetime: stringField(game, ["GameDateTime", "dateTime", "EventDate", "DateTime"]),
        status: stringField(game, ["GameStatus", "status", "Status"], "SCHEDULED"),
        tv: nullableStringField(game, ["TV", "tv"]),
        rot: nullableStringField(game, ["RotNum", "rot", "Rotation"]),
        notes: nullableStringField(game, ["Notes", "notes"]),
      }));
    case "lines":
      return list.map((line) => {
        const wagerType = stringField(line, ["WagerType", "type", "LineType"], "SPREAD");
        return {
          id: stringField(line, ["LineID", "id", "WagerNumber", "LineNum"]),
          gameId: stringField(line, ["GameID", "gameId"]),
          period: stringField(line, ["Period", "period", "PeriodDescription"], "FG"),
          type: wagerType,
          side: nullableStringField(line, ["Side", "side"]) ?? (wagerType.includes("Over") ? "OVER" : wagerType.includes("Under") ? "UNDER" : null),
          line: numberField(line, ["Line", "Points", "line", "Spread"]),
          odds: numberField(line, ["Odds", "odds", "Odd"]),
          overOdds: nullableStringField(line, ["OverOdds", "over"]),
          underOdds: nullableStringField(line, ["UnderOdds", "under"]),
          moneyline: nullableStringField(line, ["MoneyLine", "moneyline"]),
          vig: numberField(line, ["Vig", "vig"], 110),
          maxRisk: nullableStringField(line, ["MaxRisk", "maxRisk"]),
          status: stringField(line, ["Status", "status"], "OPEN"),
          lastUpdate: stringField(line, ["LastUpdate", "updatedAt"], String(Date.now())),
        };
      });
    case "periods":
      return list.map((period) => ({
        id: stringField(period, ["PeriodID", "id", "Period"]),
        code: stringField(period, ["Period", "code", "PeriodCode"]),
        description: stringField(period, ["PeriodDescription", "description", "Name"]),
        sport: stringField(period, ["Sport", "sport"]),
        sortOrder: numberField(period, ["SortOrder", "sort"]),
      }));
    case "gametypes":
      return list.map((gameType) => ({
        id: stringField(gameType, ["GameTypeID", "id", "Type"]),
        code: stringField(gameType, ["GameType", "code", "Type"]),
        name: stringField(gameType, ["Description", "name", "GameTypeDescription"]),
        sport: stringField(gameType, ["Sport", "sport"]),
      }));
  }
}

function isProxyAlias(alias: string): alias is ProxyAliasName {
  return Object.prototype.hasOwnProperty.call(PROXY_ALIAS_MAP, alias);
}

function aliasPayload(alias: ProxyAliasName, candidate: ProxyAliasCandidate, body: JsonObject): JsonObject {
  const agentID = cleanString(body.agentID || body.customerID || body.agentOwner);
  const playerID = cleanString(body.playerID || body.bettorID || body.customerID || body.playerLogin);
  const payload: JsonObject = {
    ...candidate.defaults,
    ...body,
    operation: candidate.operation,
    RRO: "1",
  };
  delete payload.token;
  delete payload.cf_clearance;
  delete payload.cfClearance;
  delete payload.__cf_bm;
  delete payload.useCache;

  if (agentID) {
    payload.agentID ??= agentID;
    payload.agentOwner ??= agentID;
  }
  if (playerID) {
    payload.playerID ??= playerID;
    payload.customerID ??= playerID;
    payload.playerLogin ??= playerID;
    payload.acc ??= playerID;
  }
  if (alias === "leagueLines") {
    payload.sport ??= body.sport || body.league;
    payload.league ??= body.league || body.sport;
  }
  if (alias === "gameVolume") {
    payload.gameId ??= body.gameId || body.GameID || body.gameID;
    payload.GameID ??= body.GameID || body.gameId || body.gameID;
  }
  if (alias === "dynamicLive") {
    payload.live ??= body.live ?? "1";
  }
  if (alias === "pendingReportConfig") {
    payload.agentID = agentID;
    payload.agentOwner = cleanString(body.agentOwner || agentID);
    payload.agentSite = cleanString(body.agentSite || payload.agentSite || "1");
  }
  if (alias === "updatePendingReportConfig") {
    payload.agentID = agentID;
    payload.agentOwner = cleanString(body.agentOwner || agentID);
    payload.agentSite = cleanString(body.agentSite || payload.agentSite || "1");
    delete payload.RRO;
  }
  return payload;
}

async function callProxyAlias(alias: ProxyAliasName, body: JsonObject, token: string, cfClearance: string, reqId: string, cfBm = "") {
  const errors: Array<{ endpoint: string; status?: number; details: string }> = [];
  const cookie = [`cf_clearance=${cfClearance}`];
  if (cfBm) cookie.push(`__cf_bm=${cfBm}`);
  for (const candidate of PROXY_ALIAS_MAP[alias]) {
    const payload = aliasPayload(alias, candidate, body);
    try {
      const upstream = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/${candidate.endpoint}`, {
        method: "POST",
        headers: browserHeaders(token, cookie.join("; ")),
        body: toForm(payload),
      }), { reqId, endpoint: candidate.endpoint });
      const raw = await readBuckeyeJson(upstream);
      if (upstream.ok) return { candidate, payload, raw, status: upstream.status };
      errors.push({ endpoint: candidate.endpoint, status: upstream.status, details: JSON.stringify(raw).slice(0, 400) });
    } catch (err: unknown) {
      errors.push({ endpoint: candidate.endpoint, details: err instanceof Error ? err.message : String(err) });
    }
  }
  throw new Error(errors.map((err) => `${err.endpoint}${err.status ? ` ${err.status}` : ""}: ${err.details}`).join("; "));
}

function cleanString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value).trim();
}

function rowString(row: TaxonomyRecord, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && value !== "") return String(value).trim();
  }
  return fallback;
}

function rowNumber(row: TaxonomyRecord, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

function recordsFromCandidate(candidate: unknown): TaxonomyRecord[] {
  if (Array.isArray(candidate)) return candidate.filter(isTaxonomyRecord);
  const record = asTaxonomyRecord(candidate);
  if (!record) return [];

  for (const key of ["LIST", "GENERAL", "ARRAY", "rows", "agents", "performance", "data", "result", "RESULT"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested.filter(isTaxonomyRecord);
    if (isTaxonomyRecord(nested)) {
      const nestedRows = recordsFromCandidate(nested);
      if (nestedRows.length > 0) return nestedRows;
    }
  }
  return [];
}

function buckeyeRows(raw: unknown): TaxonomyRecord[] {
  const root = asTaxonomyRecord(raw);
  const info = asTaxonomyRecord(root?.INFO);
  const candidates = [
    info?.LIST,
    info?.ARRAY,
    root?.LIST,
    root?.GENERAL,
    root?.data,
    root?.rows,
    root?.agents,
    root?.performance,
    root?.result,
    root?.RESULT,
    Array.isArray(raw) ? raw : null,
  ];

  for (const candidate of candidates) {
    const rows = recordsFromCandidate(candidate);
    if (rows.length > 0) return rows;
  }
  return [];
}

function normalizeAgentList(raw: unknown): AgentSummary[] {
  return buckeyeRows(raw)
    .map((agent) => {
      const id = rowString(agent, ["AgentID", "agentID", "CustomerID", "customerID", "id", "Login", "login"]);
      const name = rowString(agent, ["AgentName", "name", "Username", "Login", "login"], id);
      return {
        id,
        name,
        level: rowNumber(agent, ["Level", "level"], 1),
        parent: rowString(agent, ["ParentID", "parent", "ParentAgentID", "MasterAgentID", "masterAgentID"]),
        totalBets: rowNumber(agent, ["TotalBets", "bets", "wagercount", "WagerCount", "wager_count"]),
        totalWagered: rowNumber(agent, ["TotalWagered", "wagered", "volume", "Volume", "TotalVolume", "LastWeek"]),
        netProfit: rowNumber(agent, ["NetProfit", "profit", "net", "Net", "Settle", "Balance"]),
        commission: rowNumber(agent, ["Commission", "comm", "PerHeadRate", "HeadCountRateM"]),
        activeCount: rowNumber(agent, ["ActivePlayers", "activeCount", "PlayerCount", "playerCount"]),
        lastActive: rowString(agent, ["LastActive", "lastActivity", "LastWagerAt", "last_wager_at"]),
      };
    })
    .filter((agent) => agent.id || agent.name);
}

function summarizePerformanceRows(rows: TaxonomyRecord[]): Omit<PerformanceBucket, "date" | "startDate" | "endDate"> {
  const customers = new Set<string>();
  const totals = rows.reduce<Omit<PerformanceBucket, "date" | "startDate" | "endDate">>(
    (acc, row) => {
      const customer = rowString(row, ["CustomerID", "customerID", "Login", "login", "player", "Player"]);
      if (customer) customers.add(customer);
      const win = rowNumber(row, ["WinAmount", "win", "amountwon", "AmountWon", "amountWon"]);
      const loss = rowNumber(row, ["LossAmount", "loss", "amountlost", "AmountLost", "amountLost"]);
      const net = rowNumber(row, ["NetProfit", "net", "Net"], win - loss);
      acc.bets += rowNumber(row, ["Bets", "bets", "wagercount", "WagerCount", "wagerCount"], 0);
      acc.wager += rowNumber(row, ["WagerAmount", "wager", "TotalWagered", "volume", "Volume", "Risk", "AmountWagered"], 0);
      acc.win += win;
      acc.loss += loss;
      acc.net += net;
      acc.commission += rowNumber(row, ["Commission", "comm", "Comm"], 0);
      return acc;
    },
    { bets: 0, wager: 0, win: 0, loss: 0, net: 0, commission: 0, customers: 0 }
  );
  if (totals.bets === 0 && rows.length > 0) totals.bets = rows.length;
  totals.customers = customers.size || rows.length;
  return totals;
}

function normalizePerformance(raw: unknown, period: PerformancePeriod = "weekly"): PerformanceReport {
  const rows = buckeyeRows(raw);
  const data = rows.map((row) => {
    const date = rowString(row, ["Date", "date", "Week", "week", "startDate", "StartDate"]);
    const summary = summarizePerformanceRows([row]);
    return {
      date,
      startDate: date,
      endDate: rowString(row, ["EndDate", "endDate"], date),
      ...summary,
    };
  });
  const totals = summarizePerformanceRows(rows);
  return { period, data, totals };
}

function parseLocalDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function buildPerformanceBuckets(startValue: string | undefined, endValue: string | undefined, period: PerformancePeriod) {
  const now = new Date();
  const defaultEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const defaultStart = addDays(defaultEnd, period === "daily" ? -6 : -27);
  const start = parseLocalDate(startValue, defaultStart);
  const end = parseLocalDate(endValue, defaultEnd);
  if (start.getTime() > end.getTime()) throw new Error("startDate must be before endDate");

  const buckets: Array<{ date: string; startDate: string; endDate: string }> = [];
  let cursor = new Date(start);
  const step = period === "daily" ? 1 : 7;
  while (cursor.getTime() <= end.getTime()) {
    const bucketStart = new Date(cursor);
    const bucketEnd = period === "daily" ? new Date(cursor) : addDays(cursor, 6);
    if (bucketEnd.getTime() > end.getTime()) bucketEnd.setTime(end.getTime());
    buckets.push({
      date: period === "daily" ? isoDate(bucketStart) : `${isoDate(bucketStart)} - ${isoDate(bucketEnd)}`,
      startDate: isoDate(bucketStart),
      endDate: isoDate(bucketEnd),
    });
    cursor = addDays(bucketEnd, 1);
  }
  return buckets;
}

function performanceReportFromBuckets(period: PerformancePeriod, buckets: PerformanceBucket[]): PerformanceReport {
  const totals = buckets.reduce(
    (acc, row) => {
      acc.bets += row.bets;
      acc.wager += row.wager;
      acc.win += row.win;
      acc.loss += row.loss;
      acc.net += row.net;
      acc.commission += row.commission;
      acc.customers += row.customers;
      return acc;
    },
    { bets: 0, wager: 0, win: 0, loss: 0, net: 0, commission: 0, customers: 0 }
  );
  return { period, data: buckets, totals };
}

async function readBuckeyeJson(upstream: Response): Promise<unknown> {
  return (await parseBuckeyeResponse(upstream)).data;
}

class UpstreamProxyError extends Error {
  constructor(
    readonly upstreamStatus: number,
    readonly clientStatus: number,
    readonly payload: JsonObject,
    readonly rawSnippet: string
  ) {
    super(String(payload.error || `Buckeye upstream error ${upstreamStatus}`));
  }
}

async function parseBuckeyeResponse(upstream: Response): Promise<{ data: unknown; text: string; contentType: string }> {
  const contentType = upstream.headers.get("content-type") || "";
  const text = await upstream.text();
  if (!text) return { data: null, text, contentType };

  if (contentType.includes("application/json") || looksLikeJson(text)) {
    try {
      return { data: JSON.parse(text) as unknown, text, contentType };
    } catch {
      return { data: { raw: text.slice(0, 500), parseError: "Invalid JSON from Buckeye" }, text, contentType };
    }
  }

  return {
    data: {
      error: "Non-JSON response from Buckeye",
      snippet: text.slice(0, 500),
    },
    text,
    contentType,
  };
}

async function readBuckeyeOrThrow(upstream: Response, endpoint: string, reqId = "global"): Promise<unknown> {
  const parsed = await parseBuckeyeResponse(upstream);
  if (upstream.ok) return parsed.data;

  const errorMessage = buckeyeErrorMessage(upstream.status, parsed.data, parsed.contentType);
  const payload: JsonObject = {
    error: errorMessage,
    upstreamStatus: upstream.status,
    endpoint,
    reqId,
  };
  logger.warn("Buckeye upstream error", {
    reqId,
    endpoint,
    upstreamStatus: upstream.status,
    contentType: parsed.contentType,
    snippet: parsed.text.slice(0, 500),
  });
  throw new UpstreamProxyError(upstream.status, upstreamClientStatus(upstream.status), payload, parsed.text.slice(0, 500));
}

function buckeyeErrorMessage(status: number, data: unknown, contentType: string): string {
  if (isTaxonomyRecord(data)) {
    const msg = cleanString(data.error || data.message || data.Message || data.details);
    if (msg) return msg;
  }
  if (!contentType.includes("application/json")) {
    return `Buckeye returned non-JSON (${status}) - likely auth, session, or Cloudflare failure`;
  }
  return `Buckeye upstream error ${status}`;
}

function upstreamClientStatus(status: number): number {
  if (status === 401 || status === 403) return status;
  if (status === 429) return 429;
  if (status >= 500) return 502;
  return status >= 400 ? status : 502;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

async function getStoredCredentials(customerID: string): Promise<{ token: string; cf_clearance: string } | null> {
  const stored = getCachedToken(customerID);
  if (!stored?.bearer_token) return null;
  const cfClearance = await readProxySecret(PROXY_SECRET_NAMES.cfClearance, customerID)
    || extractCfClearanceValue(stored.cf_clearance || "");
  if (!cfClearance) return null;
  return { token: stored.bearer_token, cf_clearance: cfClearance };
}

function applyEndpointDefaults(endpointKey: string, endpoint: string, payload: JsonObject): JsonObject {
  const next = { ...payload };
  if ((endpointKey === "pending" || endpointKey === "getPending" || endpoint === "Manager/getPending") && !cleanString(next.date)) {
    next.date = new Date().toISOString().slice(0, 10);
  }
  return next;
}

function missingRequiredParams(endpointKey: string, endpoint: string, payload: JsonObject): string[] {
  const specs = REQUIRED_ENDPOINT_PARAMS[endpointKey] || REQUIRED_ENDPOINT_PARAMS[endpoint] || [];
  const missing: string[] = [];
  for (const spec of specs) {
    if (Array.isArray(spec)) {
      if (!spec.some((key) => cleanString(payload[key]))) missing.push(spec.join("|"));
    } else if (!cleanString(payload[spec])) {
      missing.push(spec);
    }
  }
  return missing;
}

function validateRequiredParams(endpointKey: string, endpoint: string, payload: JsonObject): Response | null {
  const missing = missingRequiredParams(endpointKey, endpoint, payload);
  if (!missing.length) return null;
  return json({
    error: `Missing required parameters: ${missing.join(", ")}`,
    missing,
    endpoint: endpointKey,
  }, 400);
}

function missingAliasRequestParams(alias: ProxyAliasName, body: JsonObject): string[] {
  return PROXY_ALIAS_PARAMS[alias].required
    .filter((param) => param !== "token" && param !== "cf_clearance")
    .filter((param) => !cleanString(body[param]));
}

function getMockResponse(endpointKey: string, payload: JsonObject): unknown | null {
  const key = endpointKey === "getPending" ? "pending" : endpointKey;
  if (!DEMO_ENDPOINT_KEYS.has(key)) return null;
  switch (key) {
    case "accountInfo":
      return {
        accountInfo: {
          customerID: cleanString(payload.customerID || payload.agentID, "DEMO"),
          balance: 10000,
          available: 8500,
          openWagers: 12,
        },
      };
    case "agentDownline":
      return {
        agents: [
          { id: "DEMO1", name: "Demo Agent", login: "DEMO1", players: 5, subAgents: 2, balance: 10000, weekGross: 1250 },
        ],
      };
    case "agentBilling":
      return { period: "demo", figures: [{ agent: "DEMO1", name: "Demo Agent", gross: 1200, net: 850, wagers: 42 }], count: 1 };
    case "betTicker":
      return { wagers: [{ wagerNumber: 12345, customerID: "DEMO100", amountWagered: 100, toWinAmount: 90.91, status: "pending" }] };
    case "dynamicLive":
      return { events: [{ id: "DEMO-GAME", sport: "Football", away: "Demo Away", home: "Demo Home", status: "LIVE" }] };
    case "gameVolume":
      return { gameId: cleanString(payload.gameId || payload.GameID, "DEMO-GAME"), risk: 1200, toWin: 950, sides: [] };
    case "leagueLines":
      return [
        { id: "DEMO-LINE", gameId: "DEMO-GAME", period: "FG", type: "SPREAD", side: "HOME", line: -3.5, odds: -110, status: "OPEN" },
      ];
    case "pending":
      return {
        date: cleanString(payload.date),
        totalPending: 1,
        totalRisk: 100,
        totalToWin: 90.91,
        wagers: [
          {
            key: "DEMO-1",
            ticketNumber: 1000001,
            wagerNumber: 1,
            player: { id: "DEMO100", name: "Demo Player", login: "DEMO100", agent: cleanString(payload.agentID, "DEMO") },
            wager: { type: "S", typeName: "STRAIGHT", status: "P", stake: 100, toWin: 90.91, totalPicks: 1 },
            legs: [],
          },
        ],
        rawRowCount: 1,
      };
    case "playerInfo":
      return { player: { id: cleanString(payload.playerID || payload.playerLogin || payload.customerID, "DEMO100"), name: "Demo Player", active: true } };
    default:
      return null;
  }
}

function normalizeBettorDetails(raw: unknown, bettorID: string) {
  const rows = buckeyeRows(raw);
  const wagers = rows.map((row) => {
    const wager = rowNumber(row, ["AmountWagered", "WagerAmount", "Risk", "risk", "volume", "Volume"]);
    const win = rowNumber(row, ["ToWinAmount", "ToWin", "WinAmount", "amountwon", "AmountWon"]);
    const loss = rowNumber(row, ["LossAmount", "amountlost", "AmountLost"]);
    const net = rowNumber(row, ["NetProfit", "net", "Net"], win - loss);
    return {
      id: rowString(row, ["WagerNumber", "TicketNumber", "id", "DocumentNumber"]),
      date: rowString(row, ["InsertDateTime", "Date", "date", "TransactionDateTime", "TimeStamp"]),
      sport: rowString(row, ["Sport", "sport", "sportType"], "Unknown"),
      type: rowString(row, ["WagerType", "type", "BetType"]),
      description: rowString(row, ["ShortDesc", "Description", "description", "Details"]),
      wager,
      win,
      loss,
      net,
      raw: row,
    };
  });
  const bySport = new Map<string, { sport: string; bets: number; wager: number; net: number }>();
  for (const wager of wagers) {
    const sport = wager.sport || "Unknown";
    const entry = bySport.get(sport) || { sport, bets: 0, wager: 0, net: 0 };
    entry.bets += 1;
    entry.wager += wager.wager;
    entry.net += wager.net;
    bySport.set(sport, entry);
  }
  return {
    bettorID,
    wagers,
    totals: {
      bets: wagers.length,
      wager: wagers.reduce((sum, row) => sum + row.wager, 0),
      net: wagers.reduce((sum, row) => sum + row.net, 0),
    },
    bySport: [...bySport.values()].sort((a, b) => b.wager - a.wager),
  };
}

function rowTimestamp(row: TaxonomyRecord): number {
  const numeric = rowNumber(row, ["timestamp", "Timestamp", "created_at", "CreatedAt"]);
  if (numeric > 0) return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const raw = rowString(row, ["InsertDateTime", "Insert_Date_Time", "WagerDateTime", "TicketDate", "PlacedAt", "Date", "Time"]);
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(parsed) ? Math.floor(Date.now() / 1000) : Math.floor(parsed / 1000);
}

function normalizeAnalyticWager(row: TaxonomyRecord, agentID = ""): StoredWagerAnalytic & { agentID: string; wagerNumber: string } {
  return {
    agentID,
    wagerNumber: rowString(row, ["WagerNumber", "TicketNumber", "DocumentNumber", "id"]),
    bettorId: rowString(row, ["Player", "bettorId", "customerID", "CustomerID", "Login", "login"]),
    gameId: rowString(row, ["GameID", "gameId", "GameNum", "EventID", "Rotation"]),
    wagerType: rowString(row, ["WagerType", "type", "LineType", "BetType"], "UNKNOWN").toUpperCase(),
    side: rowString(row, ["Side", "side", "Pick", "Team", "Selection"]),
    line: rowNumber(row, ["Line", "line", "Points", "Spread"]),
    odds: rowNumber(row, ["Odds", "odds", "Price", "price", "AmericanOdds"]),
    stake: moneyField(row, ["Risk", "risk", "stake", "AmountWagered", "WagerAmount", "Amount"], 0),
    profit: moneyField(row, ["WinAmount", "profit", "ToWin", "ToWinAmount", "NetProfit"], 0),
    sport: rowString(row, ["Sport", "sport", "SportType"], "UNK"),
    timestamp: rowTimestamp(row),
  };
}

function storeAnalyticWagers(rows: TaxonomyRecord[], agentID = "", bettorID = ""): StoredWagerAnalytic[] {
  const wagers = rows
    .map((row) => {
      const normalized = normalizeAnalyticWager(row, agentID);
      if (bettorID && !normalized.bettorId) normalized.bettorId = bettorID;
      return normalized;
    })
    .filter((wager) => wager.bettorId && wager.gameId);

  for (const wager of wagers) {
    insertWagerAnalytics.run({
      $agentID: wager.agentID || null,
      $wagerNumber: wager.wagerNumber || null,
      $bettorId: wager.bettorId,
      $gameId: wager.gameId,
      $wagerType: wager.wagerType,
      $side: wager.side,
      $line: wager.line,
      $odds: wager.odds,
      $stake: wager.stake,
      $profit: wager.profit,
      $sport: wager.sport,
      $timestamp: wager.timestamp,
    });
  }
  return wagers;
}

function detectAnalyticSyndicates(wagers: StoredWagerAnalytic[], minBettors = 2, minStake = 1000, timeWindowMs = 300000): Syndicate[] {
  const groups = new Map<string, StoredWagerAnalytic[]>();
  for (const wager of wagers) {
    const key = `${wager.gameId}|${wager.wagerType}|${wager.side}|${wager.line}`;
    const group = groups.get(key) ?? [];
    group.push(wager);
    groups.set(key, group);
  }

  const syndicates: Syndicate[] = [];
  for (const groupWagers of groups.values()) {
    const sorted = [...groupWagers].sort((a, b) => a.timestamp - b.timestamp);
    let cluster: StoredWagerAnalytic[] = [];
    for (const wager of sorted) {
      if (cluster.length === 0 || (wager.timestamp - cluster[cluster.length - 1].timestamp) * 1000 <= timeWindowMs) {
        cluster.push(wager);
      } else {
        processSyndicateCluster(cluster, syndicates, minBettors, minStake);
        cluster = [wager];
      }
    }
    processSyndicateCluster(cluster, syndicates, minBettors, minStake);
  }
  return syndicates;
}

function processSyndicateCluster(cluster: StoredWagerAnalytic[], syndicates: Syndicate[], minBettors: number, minStake: number): void {
  if (cluster.length === 0) return;
  const totalStake = cluster.reduce((sum, wager) => sum + wager.stake, 0);
  const members = [...new Set(cluster.map((wager) => wager.bettorId).filter(Boolean))];
  if (members.length < minBettors || totalStake < minStake) return;
  const sorted = [...cluster].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const windowMs = Math.max(0, (last.timestamp - first.timestamp) * 1000);
  const avgStake = totalStake / cluster.length;
  const stakeMultiplier = minStake > 0 ? totalStake / minStake : 1;
  const speedScore = windowMs <= PROXY_CONSTANTS.SPEED_SCORE_FAST_MS ? 25 : windowMs <= PROXY_CONSTANTS.SPEED_SCORE_MEDIUM_MS ? 15 : 8;
  const bettorScore = Math.min(30, members.length * 8);
  const stakeScore = Math.min(30, Math.round(stakeMultiplier * 12));
  const repeatScore = Math.min(15, cluster.length * 3);
  const riskScore = Math.min(100, Math.round(speedScore + bettorScore + stakeScore + repeatScore));
  syndicates.push({
    id: randomUUIDv7(),
    members,
    commonGame: first.gameId,
    pattern: `${first.wagerType} ${first.side} ${first.line}`.trim(),
    totalStake,
    timestamp: first.timestamp,
    windowMs,
    wagerCount: cluster.length,
    avgStake,
    riskScore,
    confidence: Math.min(100, Math.round(riskScore * 0.8 + Math.min(20, members.length * 3))),
    signals: [
      `${members.length} unique bettors`,
      `${cluster.length} same-selection wagers`,
      `$${Math.round(totalStake).toLocaleString()} total stake`,
      `${Math.round(windowMs / 1000)}s cluster window`,
    ],
  });
}

function correlateAnalyticSharpMoney(lineHistory: LineMove[], wagers: StoredWagerAnalytic[], lookbackMs = 60000): SharpAlert[] {
  const alerts: SharpAlert[] = [];
  for (const move of lineHistory) {
    const before = move.timestamp - Math.floor(lookbackMs / 1000);
    const relevant = wagers.filter((wager) =>
      wager.timestamp >= before &&
      wager.timestamp <= move.timestamp &&
      wager.gameId === move.gameId &&
      ((move.lineType === "SPREAD" && wager.wagerType === "SPREAD" && wager.side === move.side) ||
        (move.lineType === "TOTAL" && wager.wagerType === "TOTAL" && wager.side === move.side) ||
        (move.lineType === "MONEYLINE" && wager.wagerType === "MONEYLINE"))
    );
    if (relevant.length === 0) continue;
    const totalStake = relevant.reduce((sum, wager) => sum + wager.stake, 0);
    alerts.push({
      gameId: move.gameId,
      movement: move,
      correlatedBettors: [...new Set(relevant.map((wager) => wager.bettorId))],
      totalStake,
      confidence: Math.min(100, Math.round((totalStake / 5000) * 50 + relevant.length * 10)),
    });
  }
  return alerts;
}

function computeAnalyticEV(wagers: StoredWagerAnalytic[]): JsonObject {
  if (wagers.length < 20) return { error: "Insufficient data (min 20 wagers)", sampleSize: wagers.length };

  const groups = new Map<string, StoredWagerAnalytic[]>();
  for (const wager of wagers) {
    const key = `${wager.sport || "UNK"}|${wager.wagerType || "UNK"}`;
    const group = groups.get(key) ?? [];
    group.push(wager);
    groups.set(key, group);
  }

  const byCategory: JsonObject[] = [];
  let totalStakeAll = 0;
  let totalProfitAll = 0;
  let winsAll = 0;

  for (const [category, group] of groups) {
    const stake = group.reduce((sum, wager) => sum + wager.stake, 0);
    const profit = group.reduce((sum, wager) => sum + wager.profit, 0);
    const wins = group.filter((wager) => wager.profit > 0).length;
    const roi = stake > 0 ? profit / stake : 0;
    const winRate = group.length > 0 ? wins / group.length : 0;
    const avgOdds = group.reduce((sum, wager) => sum + wager.odds, 0) / group.length;
    const impliedProb = avgOdds > 0 ? 100 / (avgOdds + 100) : avgOdds < 0 ? -avgOdds / (-avgOdds + 100) : 0.5;

    totalStakeAll += stake;
    totalProfitAll += profit;
    winsAll += wins;

    byCategory.push({
      category,
      sampleSize: group.length,
      roi: Number(roi.toFixed(4)),
      winRate: Number(winRate.toFixed(4)),
      avgOdds: Number(avgOdds.toFixed(1)),
      impliedProb: Number(impliedProb.toFixed(4)),
      edge: Number((winRate - impliedProb).toFixed(4)),
      stake,
      profit,
    });
  }

  const overallWinRate = winsAll / wagers.length;
  const overallAvgOdds = wagers.reduce((sum, wager) => sum + wager.odds, 0) / wagers.length;
  const overallImplied = overallAvgOdds > 0 ? 100 / (overallAvgOdds + 100) : overallAvgOdds < 0 ? -overallAvgOdds / (-overallAvgOdds + 100) : 0.5;
  const payoutMultiple = overallAvgOdds > 0 ? overallAvgOdds / 100 : overallAvgOdds < 0 ? 100 / Math.abs(overallAvgOdds) : 1;
  const expectedROI = overallWinRate * payoutMultiple - (1 - overallWinRate);

  return {
    model: "frequentist",
    overall: {
      sampleSize: wagers.length,
      winRate: Number(overallWinRate.toFixed(4)),
      avgOdds: Number(overallAvgOdds.toFixed(1)),
      impliedProbability: Number(overallImplied.toFixed(4)),
      expectedROI: Number(expectedROI.toFixed(4)),
      edge: Number((overallWinRate - overallImplied).toFixed(4)),
      confidence: Math.min(100, Math.round(wagers.length / 5)),
      stake: totalStakeAll,
      profit: totalProfitAll,
    },
    byCategory,
  };
}

function fmtCur(n: number): string {
  const abs = Math.abs(n || 0);
  return `${n < 0 ? "-" : ""}$${abs >= 1000 ? `${(abs / 1000).toFixed(1)}K` : abs.toFixed(0)}`;
}

function field(value: unknown, fallback = ""): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function normalizeReportDate(dateStr: string | undefined): string {
  if (!dateStr) {
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  }
  if (dateStr.includes('/')) return dateStr;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function normalizeWebLogDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  if (dateStr.includes('/')) return dateStr;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function verifyJwt(token: string): Promise<JsonObject | null> {
  const jwtSecret = CONFIG.jwtSecret;
  if (!jwtSecret) return null;
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart) return null;
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart))) as { alg?: string };
  if (header.alg !== "HS256") return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(jwtSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${headerPart}.${payloadPart}`)));
  if (base64UrlEncode(signature) !== signaturePart) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart))) as JsonObject;
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (exp && exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function apiKeyAuth(req: Request): Response | null {
  const key = req.headers.get("X-API-Key");
  if (key !== CONFIG.apiKey) {
    return json({ error: "Invalid API key" }, 401);
  }
  return null;
}

function adminApiKeyAuth(req: Request): Response | null {
  const url = new URL(req.url);
  const key = req.headers.get("X-Admin-Key") || req.headers.get("X-API-Key") || url.searchParams.get("api_key");
  if (key !== CONFIG.adminApiKey) {
    return json({ error: "Invalid admin API key" }, 401);
  }
  return null;
}

function recordLatency(endpoint: string, durationMs: number, isError: boolean) {
  totalRequests++;
  if (isError) errorRequests++;
  if (!CONFIG.features.metrics) return;
  const arr = endpointLatencies.get(endpoint) ?? [];
  arr.push(durationMs);
  if (arr.length > 100) arr.shift();
  endpointLatencies.set(endpoint, arr);
}

function requestFinished(ctx: { reqId: string; start: number; method: string }, endpoint: string, customerID: string | null, status: number, error?: unknown) {
  const duration = Math.round(performance.now() - ctx.start);
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  // Push to in-memory request listener ring buffer
  requestListener.push({ id: ctx.reqId, timestamp: Date.now(), method: ctx.method, path: endpoint, status, durationMs: duration, customerID, error: message });
  // End OTel span for this request
  endRequestSpan(ctx.reqId, status, message || undefined);
  if (CONFIG.features.requestLogging && shouldLog()) {
    logRequestStmt.run({ $customerID: customerID || null, $req_id: ctx.reqId, $endpoint: endpoint, $status: status, $duration_ms: duration, $error: message || null });
    logger.info("Proxy request completed", { reqId: ctx.reqId, endpoint, customerID, status, durationMs: duration, error: message });
  } else if (error || status >= 400) {
    // Always log errors regardless of sampling
    logRequestStmt.run({ $customerID: customerID || null, $req_id: ctx.reqId, $endpoint: endpoint, $status: status, $duration_ms: duration, $error: message || null });
  }
}

// ==========================================
// 6. FETCH WITH RETRY + CIRCUIT BREAKER
// ==========================================
async function buckeyeFetch(url: string, options: RequestInit, retries = CONFIG.maxRetries): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchWithTimeout(url, options, 30000);
      if (res.status >= 500 && i < retries - 1) throw new Error(`Server error ${res.status}`);
      return res;
    } catch (err: unknown) {
      if (i === retries - 1) throw err;
      if (!CONFIG.features.autoRetry) throw err;
      const delay = Math.min(CONFIG.retryBaseMs * Math.pow(2, i) + Math.random() * 500, PROXY_CONSTANTS.RETRY_MAX_DELAY_MS);
      await Bun.sleep(delay);
    }
  }
  throw new Error("Unreachable");
}

// ==========================================
// 7. PER-CUSTOMER + PER-ENDPOINT RATE LIMITING
// ==========================================
function checkRateLimit(key: string, limit = CONFIG.defaultRateLimit.limit, windowSec = CONFIG.defaultRateLimit.window) {
  if (!CONFIG.features.rateLimiting) return { allowed: true, remaining: limit, retryAfter: 0 };
  const now = Math.floor(Date.now() / 1000);
  const [customerID, endpoint] = key.includes("::") ? key.split("::", 2) : [key, ""];
  const override = endpoint ? findRateLimitOverride(endpoint) : null;
  const effectiveLimit = override ? override.limit : limit;
  const effectiveWindow = override ? override.window : windowSec;
  const windowStart = now - effectiveWindow;
  const row = endpoint
    ? countCustomerEndpointRequests.get({ $customerID: customerID, $endpoint: endpoint, $windowStart: windowStart }) as CountRow | null
    : countCustomerRequests.get({ $customerID: customerID, $windowStart: windowStart }) as CountRow | null;
  const count = row?.count || 0;
  if (count >= effectiveLimit) return { allowed: false, retryAfter: effectiveWindow, remaining: 0 };
  return { allowed: true, remaining: Math.max(0, effectiveLimit - count - 1), retryAfter: 0 };
}

function getRateLimitStatus(customerID: string) {
  const result = checkRateLimit(customerID);
  return { remaining: result.remaining, retryAfter: result.retryAfter, limit: CONFIG.defaultRateLimit.limit };
}

// ==========================================
// 8. SPECIAL HANDLERS
// ==========================================
function applySpecialHandler(endpoint: string, payload: JsonObject, body: JsonObject): JsonObject {
  const op = (payload.operation as string) || endpoint.replace('Manager/', '');

  if (op === 'getAgentPerformance') {
    const enriched = { ...payload };
    if (!enriched.startDate && !enriched.start) {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 30);
      enriched.startDate = start.toISOString().split('T')[0];
      enriched.endDate = end.toISOString().split('T')[0];
    }
    enriched.agentID = enriched.agentID || body.customerID || body.agentID || '';
    (enriched as JsonObject).RRO = '1';
    return enriched;
  }

  if (op === 'getWebLog') {
    const enriched = { ...payload };
    enriched.logType = enriched.logType || 'ALL';
    enriched.pageSize = enriched.pageSize || 50;
    enriched.pageNumber = enriched.pageNumber || 1;
    enriched.agentID = enriched.agentID || body.customerID || body.agentID || '';
    (enriched as JsonObject).RRO = '1';
    return enriched;
  }

  if (op === 'renewToken') {
    const enriched = { ...payload };
    enriched.operation = 'renewToken';
    (enriched as JsonObject).RRO = '1';
    return enriched;
  }

  if (op === 'write' || endpoint.includes('Log/write') || endpoint.includes('logWrite')) {
    const enriched = { ...payload };
    (enriched as JsonObject).RRO = '1';
    return enriched;
  }

  if (op === 'Get_SportsLeagues' || endpoint.includes('Get_SportsLeagues') || endpoint.includes('sportsLeagues')) {
    const enriched = { ...payload };
    (enriched as JsonObject).RRO = '1';
    return enriched;
  }

  if (op === 'Get_LeagueLines2' || endpoint.includes('Get_LeagueLines') || endpoint.includes('leagueLines')) {
    const enriched = { ...payload };
    (enriched as JsonObject).RRO = '1';
    return enriched;
  }

  if (op === 'getDynamicLive' || endpoint.includes('getDynamicLive') || endpoint.includes('dynamicLive')) {
    const enriched = { ...payload };
    (enriched as JsonObject).RRO = '1';
    return enriched;
  }

  if (op === 'getPending' || endpoint.includes('getPending')) {
    const enriched = { ...payload };
    enriched.operation = 'getPending';
    enriched.agentID = enriched.agentID || body.agentID || body.customerID || '';
    enriched.agentOwner = enriched.agentOwner || enriched.agentID;
    enriched.agentSite = enriched.agentSite || '1';
    enriched.customerID = enriched.customerID || '0';
    enriched.sort = enriched.sort || '1';
    enriched.typeSort = enriched.typeSort || '2';
    enriched.week = enriched.week || '0';
    (enriched as JsonObject).RRO = '1';
    delete enriched.path;
    return enriched;
  }

  if (op === 'getConfigWebReportsPending' || endpoint.includes('getConfigWebReportsPending')) {
    const enriched = { ...payload };
    enriched.operation = 'getConfigWebReportsPending';
    enriched.agentID = enriched.agentID || body.agentID || '';
    enriched.agentOwner = enriched.agentOwner || enriched.agentID;
    enriched.agentSite = enriched.agentSite || '1';
    (enriched as JsonObject).RRO = '1';
    delete enriched.path;
    return enriched;
  }

  if (op === 'updateReportConfigPending' || endpoint.includes('updateReportConfigPending')) {
    const enriched: JsonObject = {
      ...PENDING_REPORT_CONFIG_DEFAULTS,
      ...payload,
      operation: 'updateReportConfigPending',
    };
    enriched.agentID = enriched.agentID || body.agentID || '';
    enriched.agentOwner = enriched.agentOwner || enriched.agentID;
    enriched.agentSite = enriched.agentSite || '1';
    delete enriched.RRO;
    delete enriched.path;
    return enriched;
  }

  if (op === 'getSportsTypesLive' || endpoint.includes('getSportsTypesLive')) {
    const enriched = { ...payload };
    (enriched as JsonObject).RRO = '1';
    return enriched;
  }

  if (op === 'getScoresLiveDynamic' || endpoint.includes('getScoresLiveDynamic') || endpoint.includes('scoresLive')) {
    const enriched = { ...payload };
    (enriched as JsonObject).RRO = '1';
    return enriched;
  }

  return payload;
}

async function fetchWithFallback(baseUrl: string, endpoint: string, payload: JsonObject, token: string, cfClearance: string, reqId = "global"): Promise<Response> {
  const op = String(payload.operation || '');

  if (op === 'getWebLog') {
    const start = normalizeWebLogDate(field(payload.startDate || payload.start));
    const end = normalizeWebLogDate(field(payload.endDate || payload.end));
    const type = field(payload.type, 'A');
    const body = new URLSearchParams({
      agentID: field(payload.agentID || payload.customerID),
      customerID: field(payload.customerID),
      start,
      end,
      type,
      actions: field(payload.actions, 'ALL'),
      ip: field(payload.ip),
      operation: 'getWebLog',
      RRO: '1',
      agentOwner: field(payload.agentOwner || payload.agentID || payload.customerID),
      agentSite: '1',
    });

    const endpoints = [
      `${baseUrl}/qubic/api/Manager/getWebLog`,
      `${baseUrl}/cloud/api/Manager/getWebLog`,
    ];
    let lastError = '';
    for (const url of endpoints) {
      try {
        const res = await buckeyeCall(() => buckeyeFetch(url, {
          method: 'POST',
          headers: browserHeaders(token, `cf_clearance=${cfClearance}`),
          body: body.toString(),
        }, 1), { reqId, endpoint: op });
        if (res.ok || res.status !== 500) return res;
        lastError = `500 from ${url}`;
      } catch (e: unknown) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    return new Response(JSON.stringify({ error: lastError }), { status: 500 });
  }

  if (op === 'getAgentPerformance') {
    const start = normalizeReportDate(field(payload.startDate || payload.start));
    const end = normalizeReportDate(field(payload.endDate || payload.end));
    const body = new URLSearchParams({
      start,
      end,
      agentID: field(payload.agentID || payload.customerID),
      type: field(payload.type, 'CP'),
      freePlay: field(payload.freePlay, 'Y'),
      store: field(payload.store || payload.agentID || payload.customerID),
      sport: field(payload.sport),
      subsport: field(payload.subsport),
      period: String(payload.period ?? '-1'),
      wagerType: field(payload.wagerType),
      betType: field(payload.betType),
      tipo: String(payload.tipo ?? payload.activity ?? '-1'),
      debug: String(payload.debug ?? '0'),
      operation: 'getAgentPerformance',
      RRO: '1',
      agentOwner: field(payload.agentOwner || payload.agentID || payload.customerID),
      agentSite: '1',
    });
    if (payload.group) body.set('group', field(payload.group));

    return buckeyeCall(() => buckeyeFetch(`${baseUrl}/cloud/api/Manager/getAgentPerformance`, {
      method: 'POST',
      headers: browserHeaders(token, `cf_clearance=${cfClearance}`),
      body: body.toString(),
    }), { reqId, endpoint: op });
  }

  if (op === 'getPending' || endpoint.includes('getPending')) {
    const body = toForm(payload);
    const endpoints = [
      `${baseUrl}/qubic/api/Manager/getPending`,
      `${baseUrl}/cloud/api/Manager/getPending`,
    ];
    let lastError = '';

    for (const url of endpoints) {
      try {
        const res = await buckeyeCall(() => buckeyeFetch(url, {
          method: 'POST',
          headers: browserHeaders(token, `cf_clearance=${cfClearance}`),
          body,
        }), { reqId, endpoint: 'getPending' });
        if (res.ok) return res;
        lastError = `${res.status} ${await res.clone().text().catch(() => '')}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return new Response(JSON.stringify({ error: 'getPending failed', details: lastError }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return buckeyeCall(() => buckeyeFetch(`${baseUrl}/cloud/api/${endpoint}`, {
    method: 'POST',
    headers: browserHeaders(token, `cf_clearance=${cfClearance}`),
    body: toForm(payload),
  }), { reqId, endpoint });
}

// ==========================================
// 9. HEALTH / METRICS / READINESS
// ==========================================
async function dependencyHealth() {
  const dnsStats = getDnsCacheStats();
  const dns = enrichDnsStats(dnsStats);
  const [buckeyeOk, databaseOk] = await Promise.all([
    fetch(CONFIG.baseUrl, { method: "HEAD" }).then((res) => res.ok).catch(() => false),
    Promise.resolve().then(() => getReadDb().query("SELECT 1 AS ok").get() !== undefined).catch(() => false),
  ]);
  const status = buckeyeOk && databaseOk ? "healthy" : "degraded";
  return {
    body: {
      status,
      buckeye: buckeyeOk,
      database: databaseOk,
      circuitBreaker: circuitBreaker.getStatus(),
      activeRequests,
      network: {
        pendingRequests: server.pendingRequests,
        pendingWebSockets: server.pendingWebSockets,
        dns,
        dnsStats,
        warmups: networkWarmups,
      },
      shuttingDown,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    httpStatus: status === "healthy" ? 200 : 503,
  };
}

function networkHealthMetrics(): JsonObject {
  const dnsStats = getDnsCacheStats();
  const dns = enrichDnsStats(dnsStats);
  return {
    pendingRequests: server.pendingRequests,
    pendingWebSockets: server.pendingWebSockets,
    activeRequests,
    dns,
    dnsStats,
    http: {
      pendingRequests: server.pendingRequests,
      activeRequests,
    },
    ws: {
      pendingWebSockets: server.pendingWebSockets,
    },
    warmups: networkWarmups,
    websocket: {
      sessions: sessions.size,
      subscribers: subscribers.size,
      backpressureEvents: wsBackpressureEvents,
      droppedMessages: wsDroppedMessages,
      idleTimeoutSeconds: PROXY_CONSTANTS.WS_IDLE_TIMEOUT_SECONDS,
      maxPayloadLengthBytes: PROXY_CONSTANTS.WS_MAX_PAYLOAD_LENGTH_BYTES,
      backpressureLimitBytes: PROXY_CONSTANTS.BACKPRESSURE_LIMIT_BYTES,
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

function runtimeMetrics() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  let jsc: unknown = {};
  let heap: unknown = {};
  try { jsc = (Bun as unknown as { jsc?: { getVMStats?: () => unknown } }).jsc?.getVMStats?.() || {}; } catch (e) { console.debug("[Proxy] JSC stats unavailable:", e); jsc = {}; }
  try { heap = jscHeapStats(); } catch (e) { console.debug("[Proxy] Heap stats unavailable:", e); heap = {}; }
  const dnsStats = getDnsCacheStats();
  const serverLoad = {
    pendingRequests: server.pendingRequests,
    pendingWebSockets: server.pendingWebSockets,
    tickerSubscribers: safeSubscriberCount("ticker"),
    activeRequests,
  };

  const avgLatencies: Record<string, { avg: number; p50: number; p99: number; count: number }> = {};
  for (const [ep, latencies] of endpointLatencies) {
    if (latencies.length === 0) continue;
    const sorted = [...latencies].sort((a, b) => a - b);
    avgLatencies[ep] = {
      avg: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      count: sorted.length,
    };
  }

  const dbRow = totalRequestCount.get() as CountRow | null;
  const errRow = errorRequestCount.get() as CountRow | null;
  const tokenRow = tokenCount.get() as { total: number } | null;
  const totalLat = Object.values(avgLatencies);
  const overallAvgLatency = totalLat.length
    ? Math.round(totalLat.reduce((s, v) => s + v.avg, 0) / totalLat.length)
    : 0;
  const cacheTotal = cacheHits + cacheMisses;

  const shallowMemory = {
    endpoints: estimateShallowMemoryUsageOf(ENDPOINT_COUNTS),
    subscribers: estimateShallowMemoryUsageOf(subscribers),
    sessions: estimateShallowMemoryUsageOf(sessions),
    activeSpans: estimateShallowMemoryUsageOf(activeSpans),
  };

  return {
    memory: { rss: Math.round(memory.rss / 1024 / 1024) + "MB", heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + "MB", heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + "MB", shallowEstimate: shallowMemory },
    cpu: { user: cpu.user, system: cpu.system },
    jsc,
    heap,
    server: serverLoad,
    network: {
      dnsStats,
      warmups: networkWarmups,
    },
    uptime: process.uptime(),
    activeRequests,
    wsSessions: sessions.size,
    wsBackpressureEvents,
    wsDroppedMessages,
    wsLimits: {
      idleTimeoutSeconds: PROXY_CONSTANTS.WS_IDLE_TIMEOUT_SECONDS,
      maxPayloadLengthBytes: PROXY_CONSTANTS.WS_MAX_PAYLOAD_LENGTH_BYTES,
      backpressureLimitBytes: PROXY_CONSTANTS.BACKPRESSURE_LIMIT_BYTES,
    },
    tickerHistory: tickerHistory.length,
    requests: { total: totalRequests, errors: errorRequests },
    dbLog: { total: dbRow?.count ?? 0, errors: errRow?.count ?? 0 },
    latency: avgLatencies,
    overallAvgLatency,
    tokens: tokenRow?.total ?? 0,
    cache: { hits: cacheHits, misses: cacheMisses, ratio: cacheTotal > 0 ? cacheHits / cacheTotal : 0 },
    circuitBreaker: circuitBreaker.getStatus(),
  };
}

function safeSubscriberCount(topic: string): number {
  try {
    return server.subscriberCount(topic);
  } catch {
    return 0;
  }
}

function prometheusMetrics(): string {
  const memory = process.memoryUsage();
  let heap: unknown = {};
  try { heap = jscHeapStats(); } catch { heap = {}; }
  const dbRow = totalRequestCount.get() as CountRow | null;
  const errRow = statusErrorRequestCount.get() as CountRow | null;
  const avgRow = avgRequestDuration.get() as { avg?: number | null } | null;
  const circuitState = circuitBreaker.getStatus().state;
  const dnsStats = getDnsCacheStats();
  const lines: string[] = [
    "# HELP buckeye_requests_total Total requests recorded by the Buckeye proxy",
    "# TYPE buckeye_requests_total counter",
    `buckeye_requests_total ${numberMetric(dbRow?.count ?? totalRequests)}`,
    "# HELP buckeye_errors_total Total failed requests recorded by the Buckeye proxy",
    "# TYPE buckeye_errors_total counter",
    `buckeye_errors_total ${numberMetric(errRow?.count ?? errorRequests)}`,
    "# HELP buckeye_avg_duration_ms Average proxy request duration in milliseconds",
    "# TYPE buckeye_avg_duration_ms gauge",
    `buckeye_avg_duration_ms ${numberMetric(avgRow?.avg ?? 0)}`,
    "# HELP buckeye_active_requests Currently active HTTP requests",
    "# TYPE buckeye_active_requests gauge",
    `buckeye_active_requests ${numberMetric(activeRequests)}`,
    "# HELP buckeye_active_websockets Active proxy websocket subscriptions and sessions",
    "# TYPE buckeye_active_websockets gauge",
    `buckeye_active_websockets ${numberMetric(subscribers.size + sessions.size)}`,
    "# HELP buckeye_dns_cache_hits_completed_total Completed DNS cache hits",
    "# TYPE buckeye_dns_cache_hits_completed_total counter",
    `buckeye_dns_cache_hits_completed_total ${numberMetric(dnsStats?.cacheHitsCompleted)}`,
    "# HELP buckeye_dns_cache_misses_total DNS cache misses",
    "# TYPE buckeye_dns_cache_misses_total counter",
    `buckeye_dns_cache_misses_total ${numberMetric(dnsStats?.cacheMisses)}`,
    "# HELP buckeye_dns_cache_errors_total DNS cache errors",
    "# TYPE buckeye_dns_cache_errors_total counter",
    `buckeye_dns_cache_errors_total ${numberMetric(dnsStats?.errors)}`,
    "# HELP buckeye_dns_cache_entries Current DNS cache entries",
    "# TYPE buckeye_dns_cache_entries gauge",
    `buckeye_dns_cache_entries ${numberMetric(dnsStats?.size)}`,
    "# HELP buckeye_websocket_backpressure_events_total WebSocket sends queued under backpressure",
    "# TYPE buckeye_websocket_backpressure_events_total counter",
    `buckeye_websocket_backpressure_events_total ${numberMetric(wsBackpressureEvents)}`,
    "# HELP buckeye_websocket_dropped_messages_total WebSocket sends dropped or failed",
    "# TYPE buckeye_websocket_dropped_messages_total counter",
    `buckeye_websocket_dropped_messages_total ${numberMetric(wsDroppedMessages)}`,
    "# HELP buckeye_memory_rss_bytes Resident memory usage",
    "# TYPE buckeye_memory_rss_bytes gauge",
    `buckeye_memory_rss_bytes ${numberMetric(memory.rss)}`,
    "# HELP buckeye_memory_heap_used_bytes Heap memory used",
    "# TYPE buckeye_memory_heap_used_bytes gauge",
    `buckeye_memory_heap_used_bytes ${numberMetric(memory.heapUsed)}`,
    "# HELP buckeye_memory_cache_entries In-memory response cache entries",
    "# TYPE buckeye_memory_cache_entries gauge",
    `buckeye_memory_cache_entries ${numberMetric(memCache.size)}`,
    "# HELP buckeye_token_cache_entries In-memory token cache entries",
    "# TYPE buckeye_token_cache_entries gauge",
    `buckeye_token_cache_entries ${numberMetric(tokenMemCache.size)}`,
    "# HELP buckeye_inflight_requests Inflight deduplicated upstream calls",
    "# TYPE buckeye_inflight_requests gauge",
    `buckeye_inflight_requests ${numberMetric(inflight.size)}`,
    "# HELP buckeye_uptime_seconds Proxy process uptime",
    "# TYPE buckeye_uptime_seconds gauge",
    `buckeye_uptime_seconds ${numberMetric(process.uptime())}`,
    "# HELP buckeye_circuit_breaker_state Circuit breaker state as one-hot labels",
    "# TYPE buckeye_circuit_breaker_state gauge",
    `buckeye_circuit_breaker_state{state="CLOSED"} ${circuitState === "CLOSED" ? 1 : 0}`,
    `buckeye_circuit_breaker_state{state="OPEN"} ${circuitState === "OPEN" ? 1 : 0}`,
    `buckeye_circuit_breaker_state{state="HALF_OPEN"} ${circuitState === "HALF_OPEN" ? 1 : 0}`,
    "# HELP buckeye_pending_requests Current requests queued in Bun server",
    "# TYPE buckeye_pending_requests gauge",
    `buckeye_pending_requests ${numberMetric(server.pendingRequests)}`,
    "# HELP buckeye_jsc_objects_total JS object count from JSC heap stats",
    "# TYPE buckeye_jsc_objects_total gauge",
    `buckeye_jsc_objects_total ${numberMetric((heap as { objectCount?: number }).objectCount ?? 0)}`,
    "# HELP buckeye_jsc_heap_capacity_bytes JSC heap capacity",
    "# TYPE buckeye_jsc_heap_capacity_bytes gauge",
    `buckeye_jsc_heap_capacity_bytes ${numberMetric((heap as { heapCapacity?: number }).heapCapacity ?? 0)}`,
  ];

  return `${lines.join("\n")}\n`;
}

function numberMetric(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

async function readiness() {
  const checks = {
    sqlite: true,
    buckeye: false,
    tokenExists: false,
  };
  try { getReadDb().query("SELECT 1").get(); } catch { checks.sqlite = false; }
  const latest = getLatestTokenWrite.get({ $customerID: "BILLY666" }) as TokenRow | null;
  checks.tokenExists = !!latest?.bearer_token;
  const buckeyeTest = await fetch(CONFIG.baseUrl, { method: "HEAD" }).catch(() => null);
  checks.buckeye = buckeyeTest?.ok || false;

  const ready = checks.sqlite && (CONFIG.demoMode || (checks.tokenExists && checks.buckeye));
  return { ready, checks };
}

function buildOpenApiSpec() {
  const all = getAllEndpoints();
  const paths: JsonObject = {
    "/": { get: { summary: "Service info", responses: { "200": { description: "Proxy service status" } } } },
    "/ping": { get: { summary: "Lightweight liveness probe", responses: { "200": { description: "pong" } } } },
    "/health": { get: { summary: "Dependency health check", responses: { "200": { description: "Healthy" }, "503": { description: "Degraded" } } } },
    "/ready": { get: { summary: "Kubernetes readiness probe", responses: { "200": { description: "Ready" }, "503": { description: "Not ready" } } } },
    "/metrics": { get: { summary: "Runtime metrics", responses: { "200": { description: "Metrics JSON" } } } },
    "/metrics/prometheus": { get: { summary: "Prometheus text metrics", responses: { "200": { description: "Prometheus text/plain metrics" } } } },
    "/features": { get: { summary: "Feature flags", responses: { "200": { description: "Feature flag config" } } } },
    "/demo/status": { get: { summary: "Demo mode status and mocked endpoint inventory", responses: { "200": { description: "Demo mode status" } } } },
    "/openapi.json": { get: { summary: "OpenAPI document", responses: { "200": { description: "OpenAPI JSON" } } } },
    "/dashboard": { get: { summary: "Live dashboard HTML", responses: { "200": { description: "HTML dashboard" } } } },
    "/admin": { get: { summary: "Protected proxy admin dashboard", security: [{ apiKey: [] }], responses: { "200": { description: "HTML admin dashboard" }, "401": { description: "Unauthorized" } } } },
    "/api/agent/network-stats": { get: { summary: "Protected Bun network health stats", security: [{ apiKey: [] }], responses: { "200": { description: "DNS, preconnect, HTTP, and WebSocket network stats" }, "401": { description: "Unauthorized" } } } },
    "/api/secrets": {
      get: { summary: "List managed proxy secrets", security: [{ apiKey: [] }], responses: { "200": { description: "Secret values keyed by name" } } },
      post: { summary: "Set a managed proxy secret", security: [{ apiKey: [] }], responses: { "200": { description: "Secret saved" }, "400": { description: "Invalid secret payload" } } },
      delete: { summary: "Delete a managed proxy secret", security: [{ apiKey: [] }], responses: { "200": { description: "Secret deleted" }, "400": { description: "Missing secret name" } } },
    },
    "/api/proxy/admin/summary": { get: { summary: "Protected admin summary", security: [{ apiKey: [] }], responses: { "200": { description: "Admin summary JSON" } } } },
    "/api/proxy/admin/config": { get: { summary: "Protected redacted proxy config", security: [{ apiKey: [] }], responses: { "200": { description: "Redacted config JSON" } } } },
    "/api/proxy/admin/logs": { get: { summary: "Protected recent proxy request logs", security: [{ apiKey: [] }], responses: { "200": { description: "Recent request logs" } } } },
    "/api/proxy/auth": { post: { summary: "Authenticate and store Buckeye token", security: [{ apiKey: [] }], responses: { "200": { description: "Authentication result" } } } },
    "/api/proxy/{endpoint}": { post: { summary: "Proxy a Buckeye endpoint", security: [{ apiKey: [] }], parameters: [{ name: "endpoint", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Buckeye response" }, "429": { description: "Rate limited" }, "503": { description: "Shutting down or dependency unavailable" } } } },
    "/api/proxy/taxonomy/{level}": {
      post: {
        summary: "Fetch normalized Buckeye sportsbook taxonomy",
        description: "Returns sports, leagues, schedules, lines, periods, or game types in canonical Zone 1 shapes.",
        security: [{ apiKey: [] }],
        parameters: [{ name: "level", in: "path", required: true, schema: { type: "string", enum: Object.keys(TAXONOMY_MAP) } }],
        responses: { "200": { description: "Normalized taxonomy data" }, "400": { description: "Invalid level or missing Buckeye auth" }, "502": { description: "Buckeye fetch failed" } },
      },
    },
    "/api/proxy/sportsLeagues": { post: { summary: "Buckeye sports/leagues alias", requestBody: { description: JSON.stringify(PROXY_ALIAS_PARAMS.sportsLeagues) }, responses: { "200": { description: "Sports/leagues payload" } } } },
    "/api/proxy/leagueLines": { post: { summary: "Buckeye league lines alias", requestBody: { description: JSON.stringify(PROXY_ALIAS_PARAMS.leagueLines) }, responses: { "200": { description: "League line payload" } } } },
    "/api/proxy/agentDownline": { post: { summary: "Buckeye getListAgenstByAgent alias", requestBody: { description: JSON.stringify(PROXY_ALIAS_PARAMS.agentDownline) }, responses: { "200": { description: "Agent downline" } } } },
    "/api/proxy/agentBilling": { post: { summary: "Buckeye getAgentBilling alias", requestBody: { description: JSON.stringify(PROXY_ALIAS_PARAMS.agentBilling) }, responses: { "200": { description: "Agent billing figures" } } } },
    "/api/proxy/playerInfo": { post: { summary: "Buckeye player info alias", requestBody: { description: JSON.stringify(PROXY_ALIAS_PARAMS.playerInfo) }, responses: { "200": { description: "Player details" } } } },
    "/api/proxy/dynamicLive": { post: { summary: "Buckeye live events alias", requestBody: { description: JSON.stringify(PROXY_ALIAS_PARAMS.dynamicLive) }, responses: { "200": { description: "Live events or ticker payload" } } } },
    "/api/proxy/gameVolume": { post: { summary: "Buckeye game volume/exposure alias", requestBody: { description: JSON.stringify(PROXY_ALIAS_PARAMS.gameVolume) }, responses: { "200": { description: "Game volume payload" } } } },
    "/api/proxy/pending": { post: { summary: "Buckeye pending wagers grouped by ticket and parlay legs", requestBody: { description: "Requires token, cf_clearance, agentID. Optional: date, wagerType, amount, sort, typeSort, week, customerID, agentOwner, agentSite, __cf_bm." }, responses: { "200": { description: "Grouped pending wager payload" } } } },
    "/api/proxy/pendingReportConfig": { post: { summary: "Read Buckeye pending report column visibility", requestBody: { description: JSON.stringify(PROXY_ALIAS_PARAMS.pendingReportConfig) }, responses: { "200": { description: "Pending report configuration" } } } },
    "/api/proxy/updatePendingReportConfig": { post: { summary: "Update Buckeye pending report column visibility", requestBody: { description: JSON.stringify(PROXY_ALIAS_PARAMS.updatePendingReportConfig) }, responses: { "200": { description: "Pending report configuration update result" } } } },
    "/api/proxy/analytics/syndicates": { post: { summary: "Detect correlated bettor clusters", security: [{ apiKey: [] }], responses: { "200": { description: "Syndicate scan result" } } } },
    "/api/proxy/analytics/syndicates/stats": { get: { summary: "Summarize syndicate detections and review cases", security: [{ apiKey: [] }], responses: { "200": { description: "Syndicate stats" } } } },
    "/api/proxy/integrity/cases": { get: { summary: "List integrity review cases", security: [{ apiKey: [] }], responses: { "200": { description: "Integrity cases" } } }, post: { summary: "Create integrity review case", security: [{ apiKey: [] }], responses: { "201": { description: "Created case" } } } },
    "/api/proxy/integrity/cases/{id}": { patch: { summary: "Update integrity review case", security: [{ apiKey: [] }], responses: { "200": { description: "Updated case" } } } },
    "/api/proxy/analytics/sharp-money": { post: { summary: "Correlate wagers with line movement", security: [{ apiKey: [] }], responses: { "200": { description: "Sharp-money alerts" } } } },
    "/api/proxy/analytics/ev": { post: { summary: "Compute bettor expected-value model", security: [{ apiKey: [] }], responses: { "200": { description: "EV model result" } } } },
    "/api/proxy/risk/config": {
      get: { summary: "Read risk thresholds", security: [{ apiKey: [] }], responses: { "200": { description: "Risk config" } } },
      post: { summary: "Save risk thresholds", security: [{ apiKey: [] }], responses: { "200": { description: "Risk config saved" } } },
    },
  };

  for (const endpoint of Object.values(all.proxy)) {
    paths[endpoint.path.split("?")[0]] ??= {
      [endpoint.method.toLowerCase()]: {
        summary: endpoint.name,
        description: endpoint.description,
        security: endpoint.auth === "api_key" ? [{ apiKey: [] }] : [],
        responses: { [String(endpoint.status)]: { description: endpoint.description } },
      },
    };
  }

  return {
    openapi: "3.0.0",
    info: { title: "Buckeye Proxy API", version: "2.0" },
    servers: [{ url: `http://localhost:${CONFIG.port}` }],
    components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } } },
    paths,
    "x-endpointCounts": ENDPOINT_COUNTS,
    "x-testSummary": TEST_SUMMARY,
  };
}

function getAdminLogs(limit: number): JsonObject[] {
  const safeLimit = Math.min(Math.max(limit || 50, 1), 500);
  return recentRequestLogsStmt.all({ $limit: safeLimit }) as JsonObject[];
}

function adminSummaryPayload(limit = 25): JsonObject {
  const metrics = runtimeMetrics() as JsonObject;
  const health = {
    circuitBreaker: circuitBreaker.getStatus(),
    activeRequests,
    subscribers: subscribers.size,
    sessions: sessions.size,
    shuttingDown,
  };
  return {
    generatedAt: new Date().toISOString(),
    service: "Buckeye Proxy Admin",
    url: `http://localhost:${CONFIG.port}`,
    health,
    metrics,
    logs: getAdminLogs(limit),
    rateLimitOverrides: getAllRateLimitOverridesStmt.all(),
  };
}

function redactedConfig(): JsonObject {
  return redactSensitive(CONFIG) as JsonObject;
}

function redactSensitive(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitive(entryValue, entryKey),
      ])
    );
  }
  if (isSensitiveKey(key) && value !== undefined && value !== null && value !== "") return "[redacted]";
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|secret|password|clearance|bearer|cookie|jwt|authorization/i.test(key);
}

function buildAdminHtml(): string {
  const boot = JSON.stringify({
    summary: adminSummaryPayload(25),
    config: redactedConfig(),
  }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Buckeye Proxy Admin</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #0b0d10; color: #d7dde8; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 22px; border-bottom: 1px solid #252b34; background: #10141a; }
  h1 { margin: 0; font-size: 20px; letter-spacing: 0; }
  main { padding: 18px 22px; display: grid; gap: 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .card { border: 1px solid #252b34; border-radius: 6px; padding: 12px; background: #111820; }
  .label { color: #91a0b5; font-size: 12px; text-transform: uppercase; }
  .value { margin-top: 6px; font-size: 18px; color: #f3f6fb; overflow-wrap: anywhere; }
  section { display: grid; gap: 10px; }
  h2 { margin: 0; font-size: 15px; color: #f3f6fb; }
  pre, table { width: 100%; overflow: auto; }
  pre { margin: 0; padding: 12px; border: 1px solid #252b34; border-radius: 6px; background: #080a0d; color: #c9d3e2; }
  table { border-collapse: collapse; border: 1px solid #252b34; background: #080a0d; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #252b34; text-align: left; vertical-align: top; }
  th { color: #91a0b5; font-size: 12px; text-transform: uppercase; }
  input { min-width: 0; background: #080a0d; color: #f3f6fb; border: 1px solid #2f3845; border-radius: 4px; padding: 8px; font: inherit; }
  button { background: #1f6feb; color: #fff; border: 0; border-radius: 4px; padding: 8px 12px; font: inherit; cursor: pointer; }
  form { display: grid; grid-template-columns: minmax(160px, 1fr) 100px 100px auto; gap: 8px; align-items: end; }
  .muted { color: #91a0b5; }
  .health-green { color: #4ade80; }
  .health-yellow { color: #facc15; }
  .health-red { color: #f87171; }
  .health-grey { color: #94a3b8; }
  tr.health-green td:first-child { border-left: 3px solid #4ade80; }
  tr.health-yellow td:first-child { border-left: 3px solid #facc15; }
  tr.health-red td:first-child { border-left: 3px solid #f87171; }
  tr.health-grey td:first-child { border-left: 3px solid #94a3b8; }
  .card-value-green { color: #00d084; }
  .card-value-yellow { color: #ffcc00; }
  .card-value-red { color: #ff2d55; }
  @media (max-width: 720px) { form { grid-template-columns: 1fr; } header { align-items: flex-start; flex-direction: column; } }
</style>
</head>
<body>
<header>
  <h1>Buckeye Proxy Admin</h1>
  <div class="muted" id="generatedAt"></div>
</header>
<main>
  <div class="grid" id="cards"></div>
  <section>
    <h2>Endpoint Latency Matrix</h2>
    <table>
      <thead><tr><th>Endpoint</th><th>Requests</th><th>Avg (ms)</th><th>p50 (ms)</th><th>p99 (ms)</th><th>Health</th></tr></thead>
      <tbody id="latencyMatrix"></tbody>
    </table>
    <div class="muted" id="latencyMatrixEmpty">No endpoint data yet.</div>
  </section>
  <section>
    <h2>Sample Rate</h2>
    <form id="sampleRateForm">
      <input id="sampleRate" type="number" min="0" max="1" step="0.01" placeholder="0.01" value="0.01">
      <button type="submit">Update</button>
    </form>
    <div class="muted" id="sampleRateStatus"></div>
  </section>
  <section>
    <h2>Rate Limit Override</h2>
    <form id="overrideForm">
      <input id="endpoint" placeholder="endpoint" autocomplete="off">
      <input id="limit" type="number" min="1" placeholder="limit">
      <input id="window" type="number" min="1" placeholder="window">
      <button type="submit">Save</button>
    </form>
    <div class="muted" id="overrideStatus"></div>
  </section>
  <section>
    <h2>Recent Logs</h2>
    <table>
      <thead><tr><th>Time</th><th>Endpoint</th><th>Status</th><th>Duration</th><th>Customer</th></tr></thead>
      <tbody id="logs"></tbody>
    </table>
  </section>
  <section>
    <h2>Redacted Config</h2>
    <pre id="config"></pre>
  </section>
</main>
<script>
  const boot = ${boot};
  const apiKey = new URLSearchParams(location.search).get('api_key') || '';
  const headers = apiKey ? { 'X-Admin-Key': apiKey } : {};
  function cell(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function healthClass(p99) {
    if (!Number.isFinite(p99)) return 'health-grey';
    if (p99 < 500) return 'health-green';
    if (p99 < 2000) return 'health-yellow';
    return 'health-red';
  }
  function healthLabel(p99) {
    if (!Number.isFinite(p99)) return 'No data';
    if (p99 < 500) return 'Healthy';
    if (p99 < 2000) return 'Degraded';
    return 'Slow';
  }
  function render(summary, config) {
    document.getElementById('generatedAt').textContent = summary.generatedAt || '';
    const dbTotal = summary.metrics?.dbLog?.total || 0;
    const dbErrors = summary.metrics?.dbLog?.errors || 0;
    const errorRate = dbTotal > 0 ? dbErrors / dbTotal : 0;
    const circuitState = summary.health?.circuitBreaker?.state || 'UNKNOWN';
    const cacheRatio = summary.metrics?.cache?.ratio ?? 0;
    const cards = [
      { label: 'Total Requests', value: dbTotal },
      { label: 'Errors', value: dbErrors, color: errorRate > 0.1 ? 'card-value-red' : '' },
      { label: 'Avg Latency', value: (summary.metrics?.overallAvgLatency || 0) + 'ms' },
      { label: 'Active Tokens', value: summary.metrics?.tokens || 0 },
      { label: 'Cache Hit Ratio', value: cacheRatio > 0 ? Math.round(cacheRatio * 100) + '%' : '0%', color: cacheRatio < 0.5 ? 'card-value-red' : cacheRatio < 0.8 ? 'card-value-yellow' : 'card-value-green' },
      { label: 'Circuit Breaker', value: circuitState, color: circuitState === 'OPEN' ? 'card-value-red' : circuitState === 'HALF_OPEN' ? 'card-value-yellow' : '' },
      { label: 'WebSocket Clients', value: summary.health?.subscribers },
      { label: 'Active Requests', value: summary.health?.activeRequests },
      { label: 'Sample Rate', value: config.sampleRate },
    ];
    document.getElementById('cards').innerHTML = cards.map(c => '<div class="card"><div class="label">' + cell(c.label) + '</div><div class="value ' + (c.color || '') + '">' + cell(c.value) + '</div></div>').join('');
    const latency = summary.metrics?.latency || {};
    const latencyEntries = Object.entries(latency);
    document.getElementById('latencyMatrixEmpty').style.display = latencyEntries.length ? 'none' : 'block';
    document.getElementById('latencyMatrix').innerHTML = latencyEntries.map(([ep, stats]) => {
      const cls = healthClass(stats.p99);
      const label = healthLabel(stats.p99);
      return '<tr class="' + cls + '"><td>' + cell(ep) + '</td><td>' + cell(stats.count) + '</td><td>' + cell(stats.avg) + '</td><td>' + cell(stats.p50) + '</td><td>' + cell(stats.p99) + '</td><td class="' + cls + '">' + cell(label) + '</td></tr>';
    }).join('');
    document.getElementById('logs').innerHTML = (summary.logs || []).map(log => '<tr><td>' + cell(log.logged_at) + '</td><td>' + cell(log.endpoint) + '</td><td>' + cell(log.status) + '</td><td>' + cell(log.duration_ms) + 'ms</td><td>' + cell(log.customerID) + '</td></tr>').join('');
    document.getElementById('config').textContent = JSON.stringify(config, null, 2);
    if (typeof config.sampleRate === 'number') {
      document.getElementById('sampleRate').value = String(config.sampleRate);
    }
  }
  async function refresh() {
    try {
      const [summaryRes, configRes] = await Promise.all([
        fetch('/api/proxy/admin/summary?limit=100', { headers }),
        fetch('/api/proxy/admin/config', { headers }),
      ]);
      if (!summaryRes.ok || !configRes.ok) throw new Error('Admin refresh failed');
      render(await summaryRes.json(), (await configRes.json()).config);
    } catch (e) {
      console.warn("[Proxy] Admin refresh failed, using boot data:", e);
      render(boot.summary, boot.config);
    }
  }
  document.getElementById('sampleRateForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const rate = Number(document.getElementById('sampleRate').value);
    const response = await fetch('/api/proxy/admin/sample-rate', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ rate }) });
    document.getElementById('sampleRateStatus').textContent = response.ok ? 'Updated' : 'Update failed';
    await refresh();
  });
  document.getElementById('overrideForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      endpoint: document.getElementById('endpoint').value,
      limit: Number(document.getElementById('limit').value),
      window: Number(document.getElementById('window').value),
    };
    const response = await fetch('/admin/rate-limit', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    document.getElementById('overrideStatus').textContent = response.ok ? 'Saved' : 'Save failed';
    await refresh();
  });
  render(boot.summary, boot.config);
  refresh();
  setInterval(refresh, PROXY_CONSTANTS.ADMIN_REFRESH_INTERVAL_MS);
</script>
</body>
</html>`;
}

// ==========================================
// 10. WEBSOCKET PUB/SUB + TICKER HISTORY + BATCHING
// ==========================================
type Sub = { ws: ServerWebSocket<WsData>; customerID: string; token: string; cf_clearance: string; interval?: Timer; batchInterval?: number };
const sessions = new Map<ServerWebSocket<WsData>, { interval: Timer }>();
const subscribers = new Map<string, Sub>();
const TICKER_HISTORY_SIZE = 50;
const tickerHistory: Array<{ timestamp: number; data: unknown }> = [];
let tickBatch: unknown[] = [];
var tickBatchTimer: Timer | null = null;
let wsBackpressureEvents = 0;
let wsDroppedMessages = 0;

function safeSendWs(ws: ServerWebSocket<WsData>, payload: string | ArrayBuffer | Uint8Array, label: string): boolean {
  if (ws.readyState !== 1) return false;

  try {
    const result = ws.send(payload, CONFIG.features.wsCompression);
    if (result === 0) {
      wsDroppedMessages++;
      logger.warn("WebSocket send dropped", { label, remoteAddress: ws.remoteAddress });
      try { ws.close(1011, "Send failed"); } catch { /* already closed */ }
      return false;
    }
    if (result === -1) {
      wsBackpressureEvents++;
      logger.warn("WebSocket backpressure", { label, remoteAddress: ws.remoteAddress });
    }
    return true;
  } catch (err: unknown) {
    wsDroppedMessages++;
    logger.warn("WebSocket send error", { label, remoteAddress: ws.remoteAddress, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function safeSendJson(ws: ServerWebSocket<WsData>, payload: JsonObject, label: string): boolean {
  return safeSendWs(ws, JSON.stringify(payload), label);
}

function broadcastWs(payload: string, label: string): void {
  for (const sub of subscribers.values()) {
    safeSendWs(sub.ws, payload, label);
  }
  for (const ws of sessions.keys()) {
    safeSendWs(ws, payload, label);
  }
}

function rememberTicker(data: unknown) {
  tickerHistory.push({ timestamp: Date.now(), data });
  if (tickerHistory.length > TICKER_HISTORY_SIZE) tickerHistory.shift();
}

function flushBatch() {
  if (tickBatch.length === 0) { tickBatchTimer = null; return; }
  const payload = JSON.stringify({ type: "batch", count: tickBatch.length, ticks: tickBatch });
  tickBatch = [];
  tickBatchTimer = null;
  broadcastWs(payload, "ticker-batch");
}

function enqueueTick(data: unknown) {
  rememberTicker(data);
  if (!CONFIG.features.wsBatching) {
    const tick = JSON.stringify({ type: "tick", timestamp: Date.now(), data });
    broadcastWs(tick, "ticker-tick");
    return;
  }
  tickBatch.push(data);
  if (!tickBatchTimer) {
    tickBatchTimer = setTimeout(flushBatch, CONFIG.wsBatchIntervalMs);
  }
}

const liveScoresCache = new Map<string, { awayScore: number; homeScore: number }>();

function pushLiveFlash(event: { id: string; sport?: string; away?: string; home?: string; awayScore: number; homeScore: number; period?: string }) {
  const prev = liveScoresCache.get(event.id);
  const isFlash = prev && (prev.awayScore !== event.awayScore || prev.homeScore !== event.homeScore);
  liveScoresCache.set(event.id, { awayScore: event.awayScore, homeScore: event.homeScore });
  if (isFlash) {
    const msg = JSON.stringify({ type: "live_flash", event, timestamp: Date.now() });
    broadcastWs(msg, "live-flash");
  }
}

function startTicker(sub: Sub) {
  const interval = sub.batchInterval || 5000;
  sub.interval = setInterval(async () => {
    try {
      // Token expiry check (Enhancement 34)
      if (CONFIG.features.tokenExpiryCheck && isTokenExpired(sub.customerID)) {
        safeSendJson(sub.ws, { type: "error", message: "Token expired, re-authenticate" }, "token-expired");
        sub.ws.close(4001, "Token expired");
        stopTicker(sub.ws.remoteAddress || "");
        return;
      }

      // MemCache for hot ticker path (Enhancement 39)
      const cacheKey = `ticker:${sub.customerID}:${sub.token.slice(0, 8)}`;
      let data = getMemCache(cacheKey) as unknown;

      if (!data) {
        const res = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
          method: "POST",
          headers: browserHeaders(sub.token, `cf_clearance=${sub.cf_clearance}`),
          body: toForm({ operation: "getBetTicker", RRO: "1" }),
        }), { endpoint: "getBetTicker" });
        data = await res.json().catch(() => ({ error: "parse failed" }));
        // Normalize and cache for 2s (hot path)
        data = normalizeResponse("Manager/getBetTicker", data);
        setMemCache(cacheKey, data, CONFIG.memoryCacheTtlMs);
      }

      enqueueTick(data);
    } catch (err: unknown) {
      safeSendJson(sub.ws, { type: "error", message: err instanceof Error ? err.message : String(err) }, "ticker-error");
    }
  }, interval);
}

function stopTicker(id: string) {
  const sub = subscribers.get(id);
  if (sub?.interval) clearInterval(sub.interval);
  subscribers.delete(id);
}

// ==========================================
// 11. BUN SERVER (HTTP + WEBSOCKET)
// ==========================================
var configWatcher: ReturnType<typeof watch> | null = null;

// TLS support (Enhancement 27)
let tls: { key: string; cert: string } | undefined;
try {
  const key = await Bun.file("./certs/key.pem").text();
  const cert = await Bun.file("./certs/cert.pem").text();
  tls = { key, cert };
  logger.log("info", "tls", "TLS enabled");
} catch (e) {
  console.debug("[Proxy] TLS certs not found:", e);
  tls = undefined;
}

// Port fallback (Enhancement 30)
async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 10; port++) {
    try {
      const test = await fetch(`http://localhost:${port}`).catch(() => null);
      if (!test) return port;
    } catch (e) { console.debug("[Proxy] Port check failed:", e); }
  }
  return startPort;
}
const actualPort = await findAvailablePort(CONFIG.port);
if (actualPort !== CONFIG.port) {
  logger.warn("Port busy, using alternative", { port: CONFIG.port, actualPort });
  CONFIG.port = actualPort;
}

const server = Bun.serve<WsData>({
  port: CONFIG.port,
  hostname: "0.0.0.0",
  development: !CONFIG.production,
  tls,

  websocket: ({
    data: {} as WsData,
    compress: CONFIG.features.wsCompression,
    perMessageDeflate: CONFIG.features.wsCompression ? { compress: true, decompress: true } : false,
    sendPings: true,
    idleTimeout: PROXY_CONSTANTS.WS_IDLE_TIMEOUT_SECONDS,
    maxPayloadLength: PROXY_CONSTANTS.WS_MAX_PAYLOAD_LENGTH_BYTES,
    backpressureLimit: PROXY_CONSTANTS.BACKPRESSURE_LIMIT_BYTES,
    closeOnBackpressureLimit: true,

    open(ws: ServerWebSocket<WsData>) {
      if (CONFIG.features.requestLogging) logger.info("WebSocket client connected", { remoteAddress: ws.remoteAddress, reqId: ws.data?.reqId, customerID: ws.data?.customerID });
    },

    async message(ws: ServerWebSocket<WsData>, message: string | Uint8Array) {
      let parsed: JsonObject;
      try {
        parsed = JSON.parse(message as string) as JsonObject;
      } catch {
        safeSendJson(ws, { type: "error", message: "Invalid JSON" }, "invalid-json");
        return;
      }

      const msgType = parsed.type as string;
      const action = parsed.action as string;

      // Ping/pong support
      if (msgType === "ping") {
        safeSendJson(ws, { type: "pong", t: Date.now() }, "pong");
        return;
      }

      // WS validation (Enhancement 43)
      if (CONFIG.features.wsValidation) {
        const validTypes = ["subscribe", "unsubscribe", "subscribe-persistent", "ping", "pong"];
        if (!validTypes.includes(msgType) && !validTypes.includes(action)) {
          safeSendJson(ws, { type: "error", message: "Invalid message type" }, "invalid-message-type");
          return;
        }
        if ((msgType === "subscribe" || action === "subscribe") && (!parsed.customerID || !parsed.cf_clearance)) {
          safeSendJson(ws, { type: "error", message: "Missing customerID or cf_clearance" }, "missing-ws-auth");
          return;
        }
      }

      if (action === "subscribe-persistent") {
        // Old-style subscribe (from proxy.ts)
        if (CONFIG.features.requestLogging) {
          safeSendJson(ws, { type: "history", data: tickerHistory }, "ticker-history");
        }
        const token = String(parsed.token || "");
        const cf_clearance = String(parsed.cf_clearance || "");
        const customerID = String(parsed.customerID || "");
        if (!token || !cf_clearance) {
          safeSendJson(ws, { type: "error", message: "token and cf_clearance required" }, "missing-persistent-auth");
          return;
        }
        startTicker({ ws, customerID, token, cf_clearance });
      } else if (msgType === "subscribe" || action === "subscribe") {
        // New-style subscribe (from enhanced)
        if (CONFIG.features.requestLogging) {
          safeSendJson(ws, { type: "history", data: tickerHistory }, "ticker-history");
        }
        const token = String(parsed.token || "");
        const cf_clearance = String(parsed.cf_clearance || "");
        const customerID = String(parsed.customerID || "");
        if (!token || !cf_clearance) {
          safeSendJson(ws, { type: "error", message: "token and cf_clearance required" }, "missing-subscribe-auth");
          return;
        }
        const id = ws.remoteAddress || Math.random().toString(36).slice(2);
        stopTicker(id);

        // Per-subscriber batch interval (Enhancement 30)
        const batchMs = CONFIG.features.wsClientBatching && typeof parsed.batchMs === "number" && parsed.batchMs >= PROXY_CONSTANTS.WS_BATCH_MIN_MS && parsed.batchMs <= PROXY_CONSTANTS.WS_BATCH_MAX_MS
          ? parsed.batchMs
          : CONFIG.wsBatchIntervalMs;

        const sub: Sub = { ws, customerID, token, cf_clearance, batchInterval: batchMs };
        subscribers.set(id, sub);
        startTicker(sub);
        safeSendJson(ws, { type: "subscribed", id, message: `Live ticker active (batch: ${batchMs}ms)` }, "subscribed");
      }

      if (msgType === "unsubscribe" || action === "unsubscribe") {
        const id = ws.remoteAddress || Math.random().toString(36).slice(2);
        stopTicker(id);
        safeSendJson(ws, { type: "unsubscribed" }, "unsubscribed");
      }
    },

    drain(ws: ServerWebSocket<WsData>) {
      if (CONFIG.features.requestLogging) logger.info("WebSocket drain", { remoteAddress: ws.remoteAddress, reqId: ws.data?.reqId });
    },

    error(ws: ServerWebSocket<WsData>, error: Error) {
      logger.warn("WebSocket error", { remoteAddress: ws.remoteAddress, reqId: ws.data?.reqId, error: error.message });
    },

    close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
      const id = ws.remoteAddress || Math.random().toString(36).slice(2);
      stopTicker(id);
      const session = sessions.get(ws);
      if (session) { clearInterval(session.interval); sessions.delete(ws); }
      if (CONFIG.features.requestLogging) logger.info("WebSocket client disconnected", { remoteAddress: ws.remoteAddress, code });
    },
  } as unknown as WebSocketHandler<WsData>),

  async fetch(req, server) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...buildCorsHeaders(req), "Access-Control-Allow-Methods": corsMethods.join(", "), "Access-Control-Allow-Headers": corsHeaders.join(", ") } });

    const ctx = requestContext(req);
    const url = new URL(req.url);
    const path = url.pathname;
    startRequestSpan(ctx.reqId, path, req.method);

    try {
      // WebSocket upgrade
      if (path === "/ws" || req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        let customerID: string | undefined;
        let authenticated = true;

        // JWT auth for WS (if enabled via validated config)
        const jwtEnabled = CONFIG.jwtAuthEnabled;
        if (jwtEnabled) {
          const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
          const token = url.searchParams.get("token") || bearer || "";
          const payload = token ? await verifyJwt(token).catch(() => null) : null;
          customerID = typeof payload?.customerID === "string" ? payload.customerID : undefined;
          authenticated = Boolean(payload);
        }

        if (!authenticated && jwtEnabled) {
          return new Response(JSON.stringify({ error: 'Invalid WebSocket token' }), { status: 401, headers: { 'Content-Type': 'application/json', ...buildCorsHeaders(req) } });
        }

        const ok = server.upgrade(req, { data: { url: req.url, reqId: ctx.reqId, customerID, authenticated, connectedAt: Date.now() } satisfies WsData });
        return ok ? undefined : new Response(JSON.stringify({ error: 'WebSocket upgrade failed' }), { status: 400, headers: { 'Content-Type': 'application/json', ...buildCorsHeaders(req) } });
      }

      if (path === "/ping" || path === "/ping/") {
        const pingHeaders: Record<string, string> = { "X-Request-ID": ctx.reqId, ...buildCorsHeaders(req) };
        return new Response("pong", { status: 200, headers: pingHeaders });
      }

      if (shuttingDown) {
        return json({ error: "Server is shutting down" }, 503, {}, "", req);
      }

      const acceptEncoding = req.headers.get("accept-encoding") || "";

      // ---- / ----
      if (path === "/" || path === "") {
        return json({
          service: "Buckeye PPH Proxy",
          version: "2.0",
          runtime: "Bun",
          sqlite: "bun:sqlite (WAL)",
          status: "running",
          timestamp: new Date().toISOString(),
          websocket: "/ws",
          endpoints: ["/", "/ping", "/features", "/demo/status", "/metrics", "/metrics/prometheus", "/ready", "/health", "/config", "/ws", "/openapi.json", "/dashboard", "/admin", "/api/agent/network-stats", "/api/secrets", "/api/proxy/auth", "/api/proxy/:endpoint", "/api/proxy/{endpointKey}", "/api/proxy/taxonomy/:level", "/api/proxy/sportsLeagues", "/api/proxy/leagueLines", "/api/proxy/agentDownline", "/api/proxy/agentBilling", "/api/proxy/playerInfo", "/api/proxy/dynamicLive", "/api/proxy/scoresLive", "/api/proxy/sportsTypesLive", "/api/proxy/liveGame", "/api/proxy/gameVolume", "/api/proxy/pending", "/api/proxy/pendingReportConfig", "/api/proxy/updatePendingReportConfig", "/api/proxy/tokens", "/api/proxy/logs", "/api/proxy/admin/summary", "/api/proxy/admin/config", "/api/proxy/admin/logs", "/api/proxy/health", "/api/proxy/status", "/api/proxy/endpoints", "/api/proxy/renewToken", "/api/proxy/agent/heatmap", "/api/proxy/agents", "/api/proxy/agent/performance", "/api/proxy/bettor/details", "/api/proxy/analytics/syndicates", "/api/proxy/analytics/syndicates/stats", "/api/proxy/analytics/sharp-money", "/api/proxy/analytics/ev-simulation", "/api/proxy/analytics/predictive-sharpness", "/api/proxy/analytics/backtest", "/api/proxy/integrity/cases", "/api/proxy/integrity/cases/:id", "/api/proxy/risk/alerts", "/api/proxy/risk/config", "/api/proxy/risk/syndicates", "/api/proxy/line-rules", "/api/proxy/line-adjustments/log", "/admin/rate-limit"],
          subscribers: subscribers.size + sessions.size,
          features: { ...CONFIG.features },
          circuitBreaker: circuitBreaker.getStatus(),
        }, 200, {}, "", req);
      }

      // ---- /HEALTH ----
      if (path === "/health") {
        const health = await dependencyHealth();
        return json(health.body, health.httpStatus);
      }

      // ---- /FEATURES ----
      if (path === "/features") {
        return json({
          features: { ...CONFIG.features },
          retry: { maxRetries: CONFIG.maxRetries, backoffBaseMs: CONFIG.retryBaseMs },
          rateLimit: { defaultPerMinute: CONFIG.defaultRateLimit.limit, window: CONFIG.defaultRateLimit.window },
          tokenRenewal: CONFIG.tokenRenewal,
          circuitBreaker: circuitBreaker.getStatus(),
          tunables: {
            wsBatchIntervalMs: CONFIG.wsBatchIntervalMs,
            tokenCacheTtlMs: CONFIG.tokenCacheTtlMs,
            memoryCacheTtlMs: CONFIG.memoryCacheTtlMs,
            memCacheEntries: memCache.size,
            inflightRequests: inflight.size,
            tokenMemCacheEntries: tokenMemCache.size,
            riskEngineRunning,
            lineEngineRunning,
          },
        });
      }

      // ---- /DEMO/STATUS ----
      if (path === "/demo/status") {
        return json({
          demoMode: CONFIG.features.demoMode,
          mockedEndpoints: Array.from(DEMO_ENDPOINT_KEYS).sort(),
          bypassesBuckeyeAuth: CONFIG.features.demoMode,
          note: CONFIG.features.demoMode
            ? "Demo mode returns local mock payloads for listed endpoints before Buckeye token validation."
            : "Demo mode is disabled; listed endpoints still require Buckeye token/cf_clearance or stored credentials.",
        });
      }

      // ---- /METRICS ----
      if (path === "/metrics/prometheus" && CONFIG.features.metrics) {
        return new Response(prometheusMetrics(), {
          status: 200,
          headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", ...cors },
        });
      }

      if (path === "/metrics" && CONFIG.features.metrics) {
        return json(runtimeMetrics());
      }

      if (path === "/api/agent/network-stats" && req.method === "GET") {
        const authErr = apiKeyAuth(req);
        if (authErr) return authErr;
        return json(networkHealthMetrics(), 200, { "X-Request-ID": ctx.reqId });
      }

      // ---- /READY (k8s probe) ----
      if (path === "/ready") {
        const result = await readiness();
        return json(result, result.ready ? 200 : 503);
      }

      // ---- /CONFIG (runtime config hot-reload) ----
      if (path === "/config" && req.method === "POST") {
        const updated = reloadFromEnv();
        return json({ reloaded: true, features: updated.features, tunables: { wsBatchIntervalMs: updated.wsBatchIntervalMs, maxRetries: updated.maxRetries, retryBaseMs: updated.retryBaseMs } });
      }

      // ---- /API/SECRETS ----
      if (path === "/api/secrets") {
        const authErr = apiKeyAuth(req);
        if (authErr) return authErr;

        if (req.method === "GET") {
          const names = await getManagedSecretNames();
          const redact = url.searchParams.get("redact") === "1" || url.searchParams.get("redact") === "true";
          const secretsMap: Record<string, string | null> = {};
          for (const name of names) {
            const value = await getManagedSecret(name);
            secretsMap[name] = redact && value ? "[set]" : value;
          }
          return json(secretsMap, 200, { "X-Request-ID": ctx.reqId });
        }

        if (req.method === "POST") {
          const body = await readBody(req);
          const name = cleanString(body.name);
          const value = typeof body.value === "string" ? body.value : "";
          if (!name || typeof body.value !== "string") {
            return json({ error: "name and value required" }, 400, { "X-Request-ID": ctx.reqId });
          }
          if (!/^[A-Za-z0-9:_-]+$/.test(name)) {
            return json({ error: "secret name contains unsupported characters" }, 400, { "X-Request-ID": ctx.reqId });
          }
          try {
            await setManagedSecret(name, value);
            applyManagedSecretToConfig(name, value);
            return json({ success: true, name }, 200, { "X-Request-ID": ctx.reqId });
          } catch (err: unknown) {
            return json({ error: "Secret write failed", details: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-ID": ctx.reqId });
          }
        }

        if (req.method === "DELETE") {
          const name = cleanString(url.searchParams.get("name"));
          if (!name) return json({ error: "name required" }, 400, { "X-Request-ID": ctx.reqId });
          try {
            await deleteManagedSecret(name);
            applyManagedSecretToConfig(name, null);
            return json({ success: true, name }, 200, { "X-Request-ID": ctx.reqId });
          } catch (err: unknown) {
            return json({ error: "Secret delete failed", details: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-ID": ctx.reqId });
          }
        }

        return json({ error: "Method not allowed" }, 405, { "X-Request-ID": ctx.reqId });
      }

      // ---- /OPENAPI.JSON ----
      if (path === "/openapi.json") {
        return json(buildOpenApiSpec());
      }

      // ---- ADMIN JSON + HTML ----
      if (path === "/api/proxy/admin/summary" && req.method === "GET") {
        const authErr = adminApiKeyAuth(req);
        if (authErr) return authErr;
        const limit = parseInt(url.searchParams.get("limit") || "25", 10);
        return json(adminSummaryPayload(limit));
      }

      if (path === "/api/proxy/admin/config" && req.method === "GET") {
        const authErr = adminApiKeyAuth(req);
        if (authErr) return authErr;
        return json({ config: redactedConfig() });
      }

      if (path === "/api/proxy/admin/logs" && req.method === "GET") {
        const authErr = adminApiKeyAuth(req);
        if (authErr) return authErr;
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const logs = getAdminLogs(limit);
        return json({ count: logs.length, logs });
      }

      if (path === "/api/proxy/admin/sample-rate" && req.method === "POST") {
        const authErr = adminApiKeyAuth(req);
        if (authErr) return authErr;
        const parsed = await safeParseBody(req, SampleRateSchema);
        if (!parsed.success) return json({ error: parsed.error }, 400);
        CONFIG.sampleRate = parsed.data.rate;
        logger.log("info", "admin", `Sample rate changed to ${parsed.data.rate}`);
        return json({ success: true, sampleRate: parsed.data.rate });
      }

      if (path === "/admin" && req.method === "GET") {
        const authErr = adminApiKeyAuth(req);
        if (authErr) return authErr;
        return new Response(buildAdminHtml(), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", ...cors },
        });
      }

      // ---- /DASHBOARD ----
      if (path === "/dashboard" && req.method === "GET") {
        const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Buckeye Proxy Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Consolas', 'Courier New', monospace; background: #0a0e14; color: #b3b1ad; padding: 20px; }
  h1 { color: #ff8c00; font-size: 1.5em; margin-bottom: 20px; border-bottom: 1px solid #333; padding-bottom: 10px; }
  .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #131721; border: 1px solid #2a2f3a; border-radius: 6px; padding: 14px; }
  .card .label { color: #6c7891; font-size: 0.8em; text-transform: uppercase; }
  .card .value { color: #e6e1cf; font-size: 1.4em; font-weight: bold; margin-top: 4px; }
  .card .value.green { color: #7bc275; }
  .card .value.red { color: #ea6c6c; }
  .card .value.yellow { color: #e6b450; }
  #ticker-container { background: #131721; border: 1px solid #2a2f3a; border-radius: 6px; padding: 14px; max-height: 500px; overflow-y: auto; }
  #ticker-container h3 { color: #6c7891; font-size: 0.8em; text-transform: uppercase; margin-bottom: 8px; }
  #ticker-data { font-size: 0.85em; white-space: pre-wrap; word-break: break-all; color: #b3b1ad; }
  .conn-status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .conn-status.connected { background: #7bc275; }
  .conn-status.disconnected { background: #ea6c6c; }
  .conn-status.connecting { background: #e6b450; }
  #controls { margin-bottom: 20px; }
  button { background: #2a2f3a; color: #b3b1ad; border: 1px solid #3a4050; border-radius: 4px; padding: 8px 16px; cursor: pointer; font-family: inherit; }
  button:hover { background: #3a4050; }
  input { background: #0a0e14; color: #b3b1ad; border: 1px solid #2a2f3a; border-radius: 4px; padding: 8px 12px; font-family: inherit; width: 200px; }
  input:focus { outline: none; border-color: #ff8c00; }
</style>
</head>
<body>
<h1>Buckeye Proxy Dashboard</h1>
<div id="controls">
  <label style="color: #6c7891; margin-right: 8px;">Customer ID:</label>
  <input type="text" id="customerId" value="BILLY666" placeholder="Customer ID" />
  <button id="subscribeBtn">Subscribe</button>
  <span id="wsStatus" style="margin-left: 12px; color: #6c7891;">
    <span class="conn-status disconnected" id="connDot"></span><span id="connText">Disconnected</span>
  </span>
</div>
<div class="status-grid" id="statusGrid">
  <div class="card"><div class="label">Connection</div><div class="value" id="connCount">0</div></div>
  <div class="card"><div class="label">Ticks Received</div><div class="value" id="tickCount">0</div></div>
  <div class="card"><div class="label">Last Tick</div><div class="value" id="lastTick" style="font-size:0.8em;">---</div></div>
  <div class="card"><div class="label">Circuit Breaker</div><div class="value green" id="circuitState">CLOSED</div></div>
</div>
<div id="ticker-container">
  <h3>Live Ticker Data</h3>
  <pre id="ticker-data">Waiting for data...</pre>
</div>
<script>
  const WS_URL = 'ws://' + location.host;
  let ws = null;
  let tickCount = 0;
  let reconnectTimer = null;
  function connect() {
    const statusDot = document.getElementById('connDot');
    const statusText = document.getElementById('connText');
    statusDot.className = 'conn-status connecting';
    statusText.textContent = 'Connecting...';
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      statusDot.className = 'conn-status connected';
      statusText.textContent = 'Connected';
      document.getElementById('connCount').textContent = '1';
      document.getElementById('circuitState').textContent = 'MONITORING';
      document.getElementById('circuitState').className = 'value green';
      const customerId = document.getElementById('customerId').value || 'BILLY666';
      ws.send(JSON.stringify({ action: 'subscribe' }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'history') {
        document.getElementById('ticker-data').textContent = 'History: ' + (msg.data?.length || 0) + ' ticks stored';
      } else if (msg.type === 'tick' || msg.type === 'batch') {
        const data = msg.data || (msg.ticks && msg.ticks[0]);
        tickCount++;
        document.getElementById('tickCount').textContent = tickCount;
        document.getElementById('lastTick').textContent = new Date().toLocaleTimeString();
        const wagers = data?.LIST || data?.data?.LIST || [];
        const preview = JSON.stringify(data, null, 2).slice(0, 2000);
        document.getElementById('ticker-data').textContent = preview + (preview.length >= 2000 ? '\\n... [truncated]' : '');
      } else if (msg.type === 'error') {
        document.getElementById('ticker-data').textContent = 'Error: ' + JSON.stringify(msg);
      }
    };
    ws.onclose = () => {
      statusDot.className = 'conn-status disconnected';
      statusText.textContent = 'Disconnected';
      document.getElementById('connCount').textContent = '0';
      document.getElementById('circuitState').textContent = 'DISCONNECTED';
      document.getElementById('circuitState').className = 'value red';
      reconnectTimer = setTimeout(connect, PROXY_CONSTANTS.RECONNECT_DELAY_MS);
    };
    ws.onerror = () => { ws?.close(); };
  }
  document.getElementById('subscribeBtn').addEventListener('click', () => { if (ws) ws.close(); connect(); });
  connect();
</script>
</body>
</html>`;
        return new Response(dashboardHtml, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...cors } });
      }

      // ---- /API/PROXY/AUTH ----
      if (path === "/api/proxy/auth" && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const customerID = cleanString(body.customerID || body.customerId || CONFIG.customerId || CONFIG.agentId);
        const credentials = await loadProxyCredentials(customerID, {
          password: cleanString(body.password),
          cfClearance: cleanString(body.cf_clearance || body.cfClearance),
        });
        const password = credentials.password;
        const cf_clearance = credentials.cfClearance;
        if (!customerID) { activeRequests--; return json({ error: "customerID required" }, 400, { "X-Request-ID": ctx.reqId }); }
        if (!password) { activeRequests--; return json({ error: "password required" }, 400, { "X-Request-ID": ctx.reqId }); }
        if (!cf_clearance) { activeRequests--; return json({ error: "cf_clearance required" }, 400, { "X-Request-ID": ctx.reqId }); }

        const form = toForm({
          customerID, password, state: "true", multiaccount: "1",
          response_type: "code", client_id: customerID,
          domain: "fantasy402.com", redirect_uri: "fantasy402.com",
          operation: "authenticateCustomer", RRO: "1",
        });

        try {
          const upstream = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}${AUTH_ENDPOINT}`, {
            method: "POST",
            headers: browserHeaders("undefined"),
            body: form,
            redirect: "manual",
          }), { reqId: ctx.reqId, endpoint: "auth" });

          const bodyText = await upstream.clone().text();
          requestFinished(ctx, "auth", customerID, upstream.status);

          const location = upstream.headers.get("location");
          const authCode = location ? new URL(location, CONFIG.baseUrl).searchParams.get("code") : null;

          let storedToken = null;
          if (authCode) {
            try {
              const tokenRes = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/System/renewToken`, {
                method: "POST",
                headers: browserHeaders("undefined", `cf_clearance=${cf_clearance}`),
                body: toForm({ operation: "renewToken", agentID: customerID, agentOwner: customerID, agentSite: "1" }),
              }), { reqId: ctx.reqId, endpoint: "renewToken" });
              const tokenData = await tokenRes.json() as { token?: string; code?: string };
              storedToken = tokenData.token || tokenData.code || null;
            } catch (e) { console.warn("[Proxy] Token renewal fallback failed:", e); }
          }

          const expiresAt = Math.floor(Date.now() / 1000) + 7200;
          insertToken.run({
            $customerID: customerID,
            $cf_clearance: null,
            $auth_code: authCode,
            $bearer_token: storedToken,
            $expires_at: expiresAt,
          });
          invalidateTokenCache(customerID);
          scheduleTokenRenewal(customerID, expiresAt);

          const ok = upstream.ok || upstream.status === 302;
          if (ok) {
            await rememberProxyCredentialSecrets(customerID, { password, cfClearance: cf_clearance });
          }
          activeRequests--;
          return json({ success: ok, status: upstream.status, authCode, location, bearer_token: storedToken, body: bodyText }, ok ? 200 : upstream.status, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "auth", customerID, 0, err);
          activeRequests--;
          return json({ error: "Auth failed", details: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- /API/PROXY/TAXONOMY/:LEVEL ----
      if (path.startsWith("/api/proxy/taxonomy/") && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }

        const rawLevel = path.replace("/api/proxy/taxonomy/", "");
        if (!isTaxonomyLevel(rawLevel)) {
          activeRequests--;
          return json({ error: `Unknown taxonomy level: ${rawLevel}`, valid: Object.keys(TAXONOMY_MAP) }, 400, { "X-Request-ID": ctx.reqId });
        }

        const taxonomy = TAXONOMY_MAP[rawLevel];
        let customerID: string | null = null;
        try {
          const body = await readBody(req);
          const { token, cf_clearance, customerID: bodyCustomerID, ...filters } = body;
          customerID = bodyCustomerID ? String(bodyCustomerID) : null;

          let finalToken = token ? String(token) : "";
          let finalCf = cf_clearance ? extractCfClearanceValue(String(cf_clearance)) : "";
          if (customerID && (!finalToken || !finalCf)) {
            const stored = await getStoredCredentials(customerID);
            finalToken ||= stored?.token || "";
            finalCf ||= stored?.cf_clearance || "";
          }

          if (!finalToken || !finalCf) {
            requestFinished(ctx, `taxonomy:${rawLevel}`, customerID, 400, "Missing token/cf_clearance");
            activeRequests--;
            return json({ error: "token/cf_clearance or customerID required" }, 400, { "X-Request-ID": ctx.reqId });
          }

          const pHash = utilsHashPayload({ level: rawLevel, ...filters });
          const memKey = `tax:${rawLevel}:${pHash}`;
          const memCached = getMemCache(memKey);
          if (memCached) {
            requestFinished(ctx, `taxonomy:${rawLevel}`, customerID, 200);
            activeRequests--;
            return json({ source: "mem_cache", level: rawLevel, shape: taxonomy.shape, data: memCached }, 200, { "X-Request-ID": ctx.reqId });
          }

          const cached = getCache.get({ $endpoint: taxonomy.endpoint, $payload_hash: pHash }) as CacheRow | null;
          if (cached) {
            const data = JSON.parse(cached.response_json) as unknown;
            setMemCache(memKey, data, taxonomy.cacheTtl * 1000);
            requestFinished(ctx, `taxonomy:${rawLevel}`, customerID, 200);
            activeRequests--;
            return json({ source: "sqlite_cache", level: rawLevel, shape: taxonomy.shape, cached_at: cached.cached_at, data }, 200, { "X-Request-ID": ctx.reqId });
          }

          const upstream = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/${taxonomy.endpoint}`, {
            method: "POST",
            headers: browserHeaders(finalToken, `cf_clearance=${finalCf}`),
            body: toForm({ ...filters, operation: taxonomy.endpoint.split("/").pop() || rawLevel, RRO: "1" }),
          }), { reqId: ctx.reqId, endpoint: taxonomy.endpoint });

          const raw = await readBuckeyeOrThrow(upstream, taxonomy.endpoint, ctx.reqId);
          const data = normalizeTaxonomy(rawLevel, raw);
          insertCache.run({ $endpoint: taxonomy.endpoint, $payload_hash: pHash, $response_json: JSON.stringify(data), $ttl_seconds: taxonomy.cacheTtl });
          setMemCache(memKey, data, taxonomy.cacheTtl * 1000);
          requestFinished(ctx, `taxonomy:${rawLevel}`, customerID, upstream.status);
          activeRequests--;
          return json({ source: "live", level: rawLevel, shape: taxonomy.shape, data }, upstream.status, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          const status = err instanceof UpstreamProxyError ? err.clientStatus : 500;
          requestFinished(ctx, `taxonomy:${rawLevel}`, customerID, status, err);
          activeRequests--;
          if (err instanceof UpstreamProxyError) {
            return json({ ...err.payload, level: rawLevel }, err.clientStatus, { "X-Request-ID": ctx.reqId });
          }
          return json({ error: "Taxonomy fetch failed", level: rawLevel, details: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- /API/PROXY NAMED BUCKEYE ALIASES ----
      if (path.startsWith("/api/proxy/") && path !== "/api/proxy/discover-endpoints" && req.method === "POST") {
        const alias = path.replace("/api/proxy/", "");
        if (isProxyAlias(alias)) {
          activeRequests++;
          let customerID: string | null = null;
          try {
            const body = await readBody(req);
            customerID = cleanString(body.agentID || body.customerID || body.playerID || body.bettorID) || null;
            const missing = missingAliasRequestParams(alias, body);
            if (missing.length) {
              requestFinished(ctx, `alias:${alias}`, customerID, 400, `Missing params: ${missing.join(", ")}`);
              activeRequests--;
              return json({ error: `Missing required parameters: ${missing.join(", ")}`, missing, alias }, 400, { "X-Request-ID": ctx.reqId });
            }
            if ((alias === "pendingReportConfig" || alias === "updatePendingReportConfig") && !cleanString(body.agentID)) {
              requestFinished(ctx, `alias:${alias}`, customerID, 400, "Missing agentID");
              activeRequests--;
              return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId });
            }
            if (CONFIG.features.demoMode) {
              const mock = getMockResponse(alias, body);
              if (mock !== null) {
                requestFinished(ctx, `alias:${alias}`, customerID, 200);
                activeRequests--;
                return json({ source: "demo", alias, data: mock }, 200, { "X-Request-ID": ctx.reqId });
              }
            }
            let finalToken = cleanString(body.token);
            let finalCf = cleanString(body.cf_clearance || body.cfClearance);
            const finalCfBm = cleanString(body.__cf_bm || body.cf_bm || body.cfBm);
            if (customerID && (!finalToken || !finalCf)) {
              const stored = await getStoredCredentials(customerID);
              finalToken ||= stored?.token || "";
              finalCf ||= stored?.cf_clearance || "";
            }
            if (CONFIG.features.demoMode && (!finalToken || !finalCf)) {
              finalToken = "demo-token";
              finalCf = getDemoCfClearance();
            }
            if (!finalToken || !finalCf) {
              requestFinished(ctx, `alias:${alias}`, customerID, 400, "Missing token/cf_clearance");
              activeRequests--;
              return json({ error: "token/cf_clearance or stored customerID credentials required" }, 400, { "X-Request-ID": ctx.reqId });
            }

            const result = await callProxyAlias(alias, body, finalToken, finalCf, ctx.reqId, finalCfBm);
            const normalized = alias === "agentDownline" || alias === "agentBilling"
              ? normalizeResponse(result.candidate.endpoint, result.raw)
              : alias === "playerInfo"
                ? normalizeBettorDetails(result.raw, cleanString(body.playerID || body.bettorID || body.customerID))
                : alias === "leagueLines"
                  ? normalizeTaxonomy("lines", result.raw)
                  : result.raw;

            requestFinished(ctx, `alias:${alias}`, customerID, result.status);
            activeRequests--;
            return json({
              source: "live",
              alias,
              endpoint: result.candidate.endpoint,
              operation: result.candidate.operation,
              data: normalized,
            }, result.status, { "X-Request-ID": ctx.reqId });
          } catch (err: unknown) {
            requestFinished(ctx, `alias:${alias}`, customerID, 502, err);
            activeRequests--;
            return json({ error: `${alias} failed`, details: err instanceof Error ? err.message : String(err) }, 502, { "X-Request-ID": ctx.reqId });
          }
        }
      }

      // ---- /API/PROXY/RISK/CONFIG ----
      if (path === "/api/proxy/risk/config" && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const agentID = cleanString(body.agentID);
        if (!agentID) {
          activeRequests--;
          return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId });
        }
        const thresholds = asTaxonomyRecord(body.thresholds) || {};
        insertRiskConfig.run({
          $agentID: agentID,
          $customerID: cleanString(body.customerID || agentID),
          $thresholds: JSON.stringify(thresholds),
          $webhook: cleanString(body.webhookUrl || body.webhook) || null,
        });
        requestFinished(ctx, "risk/config", agentID, 200);
        activeRequests--;
        return json({ success: true, agentID, thresholds }, 200, { "X-Request-ID": ctx.reqId });
      }

      if (path === "/api/proxy/risk/config" && req.method === "GET") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const agentID = cleanString(url.searchParams.get("agentID"));
        if (!agentID) {
          activeRequests--;
          return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId });
        }
        const cfg = getRiskConfig.get({ $agentID: agentID }) as { agentID: string; customerID: string; thresholds: string; webhook: string | null; updated_at: number } | null;
        requestFinished(ctx, "risk/config", agentID, cfg ? 200 : 404);
        activeRequests--;
        if (!cfg) return json({ found: false }, 404, { "X-Request-ID": ctx.reqId });
        return json({ found: true, agentID: cfg.agentID, customerID: cfg.customerID, thresholds: JSON.parse(cfg.thresholds || "{}"), webhook: cfg.webhook, updatedAt: cfg.updated_at }, 200, { "X-Request-ID": ctx.reqId });
      }

      // ---- /API/PROXY/ANALYTICS/EV ----
      if (path === "/api/proxy/analytics/ev" && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }

        const body = await readBody(req);
        const token = cleanString(body.token);
        const cf_clearance = cleanString(body.cf_clearance || body.cfClearance);
        const bettorID = cleanString(body.bettorID || body.bettorId || body.customerID);
        const days = Math.max(1, rowNumber(body, ["days"], 365));
        if (!token || !cf_clearance || !bettorID) {
          activeRequests--;
          return json({ error: "token, cf_clearance, and bettorID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        const since = Math.floor(Date.now() / 1000) - days * 86400;
        try {
          let wagers = getWagerAnalytics.all({ $bettorId: bettorID, $since: since }) as StoredWagerAnalytic[];
          if (wagers.length < 20) {
            const upstream = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getWagerByPlayer`, {
              method: "POST",
              headers: browserHeaders(token, `cf_clearance=${cf_clearance}`),
              body: toForm({ playerID: bettorID, customerID: bettorID, operation: "getWagerByPlayer", RRO: "1" }),
            }), { reqId: ctx.reqId, endpoint: "getWagerByPlayer" });
            const raw = await readBuckeyeJson(upstream);
            if (!upstream.ok) throw new Error(`getWagerByPlayer failed with ${upstream.status}: ${JSON.stringify(raw).slice(0, 400)}`);
            storeAnalyticWagers(buckeyeRows(raw), "", bettorID);
            wagers = getWagerAnalytics.all({ $bettorId: bettorID, $since: since }) as StoredWagerAnalytic[];
          }

          const model = computeAnalyticEV(wagers);
          requestFinished(ctx, "analytics/ev", bettorID, 200);
          activeRequests--;
          return json(model, 200, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "analytics/ev", bettorID, 500, err);
          activeRequests--;
          return json({ error: "EV computation failed", details: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- AGENT DOWNLINE ROUTES ----
      if (path === "/api/proxy/agents" && (req.method === "GET" || req.method === "POST")) {
        activeRequests++;
        const body = req.method === "POST" ? await readBody(req) : {};
        const token = cleanString(url.searchParams.get("token") || body.token);
        const cf_clearance = cleanString(url.searchParams.get("cf_clearance") || body.cf_clearance || body.cfClearance);
        const customerID = cleanString(url.searchParams.get("customerID") || url.searchParams.get("agentID") || body.customerID || body.agentID);
        if (!token || !cf_clearance) {
          activeRequests--;
          return json({ error: "token and cf_clearance required" }, 400, { "X-Request-ID": ctx.reqId });
        }
        if (!customerID) {
          activeRequests--;
          return json({ error: "customerID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        const candidates = [
          { endpoint: "Manager/getAgentList", operation: "getAgentList", extra: {} },
          { endpoint: "Manager/getAgentManagement", operation: "getAgentManagement", extra: {} },
          { endpoint: "Manager/getListAgenstByAgent", operation: "getListAgenstByAgent", extra: { agentType: "M" } },
        ];
        let lastError = "";

        try {
          for (const candidate of candidates) {
            const upstream = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/${candidate.endpoint}`, {
              method: "POST",
              headers: browserHeaders(token, `cf_clearance=${cf_clearance}`),
              body: toForm({
                operation: candidate.operation,
                agentID: customerID,
                RRO: "1",
                agentOwner: customerID,
                agentSite: "1",
                ...candidate.extra,
              }),
            }), { reqId: ctx.reqId, endpoint: candidate.operation });
            const raw = await readBuckeyeJson(upstream);
            if (upstream.ok) {
              const normalized = normalizeAgentList(raw);
              if (normalized.length > 0 || candidate === candidates[candidates.length - 1]) {
                requestFinished(ctx, candidate.operation, customerID, upstream.status);
                activeRequests--;
                return json(normalized, 200, { "X-Request-ID": ctx.reqId });
              }
              lastError = `${candidate.operation} returned no agents`;
            } else {
              lastError = `${candidate.operation} failed with ${upstream.status}`;
            }
          }
          requestFinished(ctx, "agentDownline", customerID, 502, lastError);
          activeRequests--;
          return json({ error: "Agent list unavailable", details: lastError }, 502, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "agentDownline", customerID, 500, err);
          activeRequests--;
          return json({ error: "Agent list failed", details: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-ID": ctx.reqId });
        }
      }

      if (path === "/api/proxy/agent/performance" && req.method === "POST") {
        activeRequests++;
        const body = await readBody(req);
        const token = cleanString(body.token);
        const cf_clearance = cleanString(body.cf_clearance || body.cfClearance);
        const agentID = cleanString(body.agentID || body.customerID);
        const view: PerformancePeriod = cleanString(body.view || body.period, "weekly") === "daily" ? "daily" : "weekly";
        if (!token || !cf_clearance || !agentID) {
          activeRequests--;
          return json({ error: "token, cf_clearance, and agentID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        try {
          const buckets = buildPerformanceBuckets(
            cleanString(body.startDate || body.start) || undefined,
            cleanString(body.endDate || body.end) || undefined,
            view
          );
          const maxBuckets = view === "daily" ? 31 : 26;
          if (buckets.length > maxBuckets) {
            activeRequests--;
            return json({ error: `${view} reports support a maximum of ${maxBuckets} buckets per request` }, 400, { "X-Request-ID": ctx.reqId });
          }

          const data: PerformanceBucket[] = [];
          for (const bucket of buckets) {
            const payload: JsonObject = {
              operation: "getAgentPerformance",
              agentID,
              customerID: agentID,
              startDate: bucket.startDate,
              endDate: bucket.endDate,
              type: cleanString(body.type, "CP"),
              freePlay: cleanString(body.freePlay, "Y"),
              store: cleanString(body.store || agentID),
              sport: cleanString(body.sport),
              subsport: cleanString(body.subsport),
              period: cleanString(body.performancePeriod || body.buckeyePeriod, "-1"),
              wagerType: cleanString(body.wagerType),
              betType: cleanString(body.betType),
              tipo: cleanString(body.tipo || body.activity, "-1"),
              debug: cleanString(body.debug, "0"),
              agentOwner: cleanString(body.agentOwner || agentID),
              agentSite: "1",
              RRO: "1",
            };
            if (body.group) payload.group = body.group;
            const upstream = await fetchWithFallback(CONFIG.baseUrl, "Manager/getAgentPerformance", payload, token, cf_clearance, ctx.reqId);
            const raw = await readBuckeyeJson(upstream);
            if (!upstream.ok) {
              throw new Error(`getAgentPerformance ${bucket.date} failed with ${upstream.status}: ${JSON.stringify(raw).slice(0, 400)}`);
            }
            data.push({
              date: bucket.date,
              startDate: bucket.startDate,
              endDate: bucket.endDate,
              ...summarizePerformanceRows(buckeyeRows(raw)),
            });
          }

          const report = performanceReportFromBuckets(view, data);
          requestFinished(ctx, "agentPerformance", agentID, 200);
          activeRequests--;
          return json(report, 200, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "agentPerformance", agentID, 500, err);
          activeRequests--;
          return json({ error: "Agent performance failed", details: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-ID": ctx.reqId });
        }
      }

      if (path === "/api/proxy/bettor/details" && req.method === "POST") {
        activeRequests++;
        const body = await readBody(req);
        const token = cleanString(body.token);
        const cf_clearance = cleanString(body.cf_clearance || body.cfClearance);
        const bettorID = cleanString(body.bettorID || body.customerID || body.playerLogin || body.player);
        const agentID = cleanString(body.agentID || body.agentOwner || body.store);
        if (!token || !cf_clearance || !bettorID) {
          activeRequests--;
          return json({ error: "token, cf_clearance, and bettorID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        const startDate = cleanString(body.startDate || body.start) || isoDate(addDays(new Date(), -7));
        const endDate = cleanString(body.endDate || body.end) || isoDate(new Date());
        const candidates = [
          {
            endpoint: "Manager/getBettorDetails",
            payload: {
              operation: "getBettorDetails",
              bettorID,
              customerID: bettorID,
              playerLogin: bettorID,
              agentID,
              startDate,
              endDate,
              RRO: "1",
              agentOwner: cleanString(body.agentOwner || agentID),
              agentSite: "1",
            },
          },
          {
            endpoint: "System/getPlayerActivity",
            payload: {
              operation: "getPlayerActivity",
              acc: bettorID,
              customerID: bettorID,
              playerLogin: bettorID,
              agentID,
              startDate,
              endDate,
              RRO: "1",
            },
          },
          {
            endpoint: "Manager/getReportPlayerAnalysis",
            payload: {
              operation: "getReportPlayerAnalysis",
              playerLogin: bettorID,
              customerID: bettorID,
              agentID,
              RRO: "1",
              agentOwner: cleanString(body.agentOwner || agentID),
              agentSite: "1",
            },
          },
        ];
        let lastError = "";

        try {
          for (const candidate of candidates) {
            const upstream = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/${candidate.endpoint}`, {
              method: "POST",
              headers: browserHeaders(token, `cf_clearance=${cf_clearance}`),
              body: toForm(candidate.payload),
            }), { reqId: ctx.reqId, endpoint: candidate.endpoint });
            const raw = await readBuckeyeJson(upstream);
            if (upstream.ok) {
              const details = normalizeBettorDetails(raw, bettorID);
              requestFinished(ctx, candidate.endpoint, agentID || bettorID, upstream.status);
              activeRequests--;
              return json(details, 200, { "X-Request-ID": ctx.reqId });
            }
            lastError = `${candidate.endpoint} failed with ${upstream.status}`;
          }
          requestFinished(ctx, "bettorDetails", agentID || bettorID, 502, lastError);
          activeRequests--;
          return json({ error: "Bettor details unavailable", details: lastError }, 502, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "bettorDetails", agentID || bettorID, 500, err);
          activeRequests--;
          return json({ error: "Bettor details failed", details: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- /API/PROXY/:ENDPOINT ----
      if (path.startsWith("/api/proxy/") && path !== "/api/proxy/auth" && path !== "/api/proxy/tokens" && path !== "/api/proxy/logs" && path !== "/api/proxy/health" && path !== "/api/proxy/status" && path !== "/api/proxy/endpoints" && path !== "/api/proxy/renewToken" && path !== "/api/proxy/discover-endpoints" && !path.startsWith("/api/proxy/agent/") && !path.startsWith("/api/proxy/analytics/") && !path.startsWith("/api/proxy/integrity/") && !path.startsWith("/api/proxy/risk/") && !path.startsWith("/api/proxy/line-") && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const endpointKey = path.replace("/api/proxy/", "");
        const meta = ENDPOINT_MAP[endpointKey];
        const endpoint = meta?.path || endpointKey;
        const cacheTtl = meta?.cacheTtl ?? CONFIG.defaultRateLimit.window;
        const isLogWrite = endpoint === "Log/write" || endpointKey === "logWrite";
        let customerID: string | null = null;

        try {
          const idempotencyKey = CONFIG.features.idempotency && !isLogWrite ? req.headers.get("Idempotency-Key") : null;

          const respond = async (response: Response) => {
            if (idempotencyKey && response.status < 500) {
              setIdempotency.run({ $key: idempotencyKey, $endpoint: endpoint, $customerID: customerID, $status: response.status, $response_json: await response.clone().text() });
            }
            return response;
          };

          if (idempotencyKey) {
            const stored = getIdempotency.get({ $key: idempotencyKey }) as IdempotencyRow | null;
            if (stored) {
              activeRequests--;
              return new Response(stored.response_json, { status: stored.status, headers: { "Content-Type": "application/json", ...cors, "X-Idempotent-Replay": "true", "X-Request-ID": ctx.reqId } });
            }
          }

          const body = await readBody(req);
          const {
            token: bodyToken,
            cf_clearance: bodyCf,
            cfClearance: bodyCfCamel,
            __cf_bm: _bodyCfBm,
            cf_bm: _bodyCfBmSnake,
            cfBm: _bodyCfBmCamel,
            useCache = false,
            ...bodyPayload
          } = body;
          const rawCustomerID = body.customerID || body.agentID || body.agentOwner || CONFIG.agentId || CONFIG.customerId;
          customerID = rawCustomerID ? String(rawCustomerID).trim() : null;
          const payload = applyEndpointDefaults(endpointKey, endpoint, bodyPayload);
          const paramError = validateRequiredParams(endpointKey, endpoint, payload);
          if (paramError) {
            requestFinished(ctx, endpoint, customerID, 400, "Missing required parameters");
            activeRequests--;
            return respond(paramError);
          }

          if (CONFIG.features.demoMode) {
            const mock = getMockResponse(endpointKey, payload);
            if (mock !== null) {
              requestFinished(ctx, endpoint, customerID, 200);
              activeRequests--;
              return respond(json({ source: "demo", data: mock }, 200, { "X-Request-ID": ctx.reqId }));
            }
          }

          if (customerID && !isLogWrite) {
            const rateResult = checkRateLimit(`${customerID}::${endpoint}`);
            if (!rateResult.allowed) {
              requestFinished(ctx, endpoint, customerID, 429, "Rate limit exceeded");
              activeRequests--;
              const nowUnix = Math.floor(Date.now() / 1000);
              const override = findRateLimitOverride(endpoint);
              const rateLimit = override?.limit || CONFIG.defaultRateLimit.limit;
              const rateWindow = override?.window || CONFIG.defaultRateLimit.window;
              return respond(json({ error: "Rate limit exceeded", retryAfter: rateResult.retryAfter }, 429, {
                "Retry-After": String(rateResult.retryAfter),
                "X-RateLimit-Limit": String(rateLimit),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": String(nowUnix + (rateResult.retryAfter || rateWindow)),
                "X-Request-ID": ctx.reqId,
              }));
            }
          }

          let finalToken = bodyToken ? String(bodyToken) : "";
          let finalCf = bodyCf || bodyCfCamel ? extractCfClearanceValue(String(bodyCf || bodyCfCamel)) : "";

          if (customerID && (!finalToken || !finalCf)) {
            const stored = await getStoredCredentials(customerID);
            if (stored) {
              finalToken ||= stored.token;
              finalCf ||= stored.cf_clearance;
            }
          }
          if (CONFIG.features.demoMode && (!finalToken || !finalCf)) {
            finalToken = "demo-token";
            finalCf = getDemoCfClearance();
          }

          if (!finalToken || !finalCf) {
            requestFinished(ctx, endpoint, customerID, 400, "Missing token or cf_clearance");
            activeRequests--;
            return respond(json({ error: "token and cf_clearance (or stored customerID credentials) required" }, 400, { "X-Request-ID": ctx.reqId }));
          }

          const enrichedPayload = applySpecialHandler(endpoint, payload, body);
          const shouldStream = req.headers.get("X-Stream") === "true" || body.stream === true || body.stream === "true";

          if (shouldStream) {
            const upstream = await fetchWithFallback(CONFIG.baseUrl, endpoint, enrichedPayload, finalToken, finalCf, ctx.reqId);
            requestFinished(ctx, endpoint, customerID, upstream.status);
            activeRequests--;
            return new Response(upstream.body, {
              status: upstream.status,
              headers: {
                "Content-Type": upstream.headers.get("content-type") || "application/json",
                ...(upstream.headers.get("content-encoding") ? { "Content-Encoding": upstream.headers.get("content-encoding") || "" } : {}),
                ...cors,
                "X-Request-ID": ctx.reqId,
              },
            });
          }

          const fetchLive = async () => {
            const tokenPrefix = finalToken.slice(0, 8);
            const dedupeKey = `${endpoint}::${hashPayloadImpl({ endpoint, ...enrichedPayload })}::${tokenPrefix}`;
            return dedupeRequest(dedupeKey, async () => {
              const upstream = await fetchWithFallback(CONFIG.baseUrl, endpoint, enrichedPayload, finalToken, finalCf, ctx.reqId);
              return readBuckeyeOrThrow(upstream, endpoint, ctx.reqId);
            });
          };

          // Passthrough for logWrite: no cache at all
          if (isLogWrite) {
            const rawData = await fetchLive();
            const data = normalizeResponse(endpoint, rawData, endpointKey);
            requestFinished(ctx, endpoint, customerID, 200);
            activeRequests--;
            return respond(json({ source: "live", data }, 200, { "X-Request-ID": ctx.reqId }, acceptEncoding));
          }

          if (useCache && cacheTtl > 0) {
            const result = await getCacheWithSWR(endpoint, enrichedPayload, fetchLive, ctx.reqId, cacheTtl);
            const normalizedData = normalizeResponse(endpoint, result.data, endpointKey);
            requestFinished(ctx, endpoint, customerID, 200);
            activeRequests--;
            return respond(json({ source: result.source, stale: Boolean(result.stale), data: normalizedData }, 200, { "X-Request-ID": ctx.reqId }));
          }

          // After SWR cache check, check memCache
          if (CONFIG.features.memoryCache && cacheTtl > 0) {
            const memKey = memCacheKey(endpoint, enrichedPayload);
            const cached = getMemCache(memKey);
            if (cached) {
              requestFinished(ctx, endpoint, customerID, 200);
              activeRequests--;
              return respond(json({ source: "mem_cache", data: normalizeResponse(endpoint, cached, endpointKey) }, 200, { "X-Request-ID": ctx.reqId }));
            }
          }

          const rawData = await fetchLive();
          const data = normalizeResponse(endpoint, rawData, endpointKey);

          // Detect live score changes and push live_flash to WS subscribers
          if (CONFIG.features.analytics) {
            const effectiveKey = endpointKey || "";
            if (effectiveKey === "scoresLive" || effectiveKey === "dynamicLive" || effectiveKey === "liveGame" || effectiveKey === "games") {
              try {
                const events = Array.isArray(data) ? data : (data as Record<string, unknown>)?.events ?? (data as Record<string, unknown>)?.scores ?? (data as Record<string, unknown>)?.items ?? [];
                if (Array.isArray(events)) {
                  for (const ev of events) {
                    if (typeof ev === "object" && ev !== null && ("awayScore" in ev || "away" in ev)) {
                      pushLiveFlash({
                        id: String(ev.id ?? ev.ID ?? ev.GameID ?? ""),
                        sport: String(ev.sport ?? ev.Sport ?? ""),
                        away: String(ev.away ?? ev.AwayTeam ?? ""),
                        home: String(ev.home ?? ev.HomeTeam ?? ""),
                        awayScore: Number(ev.awayScore ?? ev.AwayScore ?? 0),
                        homeScore: Number(ev.homeScore ?? ev.HomeScore ?? 0),
                        period: String(ev.period ?? ev.Period ?? ""),
                      });
                    }
                  }
                }
              } catch { /* live_flash is best-effort */ }
            }
          }

          // Auto-update stored token on renewToken responses
          if (endpoint === "System/renewToken" && customerID) {
            try {
              const tokenData = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
              const newToken = String(tokenData.token || tokenData.code || tokenData.access_token || "");
              if (newToken) {
                const expiresAt = Math.floor(Date.now() / 1000) + 3600;
                await rememberProxyCredentialSecrets(customerID, { cfClearance: finalCf });
                insertToken.run({ $customerID: customerID, $cf_clearance: null, $auth_code: null, $bearer_token: newToken, $expires_at: expiresAt });
                invalidateTokenCache(customerID);
                scheduleTokenRenewal(customerID, expiresAt);
                logger.info("Auto-renewed token via proxy", { customerID, reqId: ctx.reqId });
              }
            } catch (tokenErr: unknown) {
              logger.warn("Auto-renewToken DB update failed", { error: tokenErr instanceof Error ? tokenErr.message : String(tokenErr) });
            }
          }

          // Store live response in memCache
          if (CONFIG.features.memoryCache && cacheTtl > 0) {
            const memKey = memCacheKey(endpoint, enrichedPayload);
            setMemCache(memKey, rawData, cacheTtl * 1000);
          }

          requestFinished(ctx, endpoint, customerID, 200);
          activeRequests--;
          return respond(json({ source: "live", data }, 200, { "X-Request-ID": ctx.reqId }, acceptEncoding));
        } catch (err: unknown) {
          const details = err instanceof Error ? err.message : String(err);
          const status = err instanceof UpstreamProxyError
            ? err.clientStatus
            : details.includes("CIRCUIT_OPEN") ? 503 : 500;
          requestFinished(ctx, endpoint, customerID, status, err);
          activeRequests--;
          if (err instanceof UpstreamProxyError) {
            return json(err.payload, err.clientStatus, { "X-Request-ID": ctx.reqId });
          }
          return json({ error: "Proxy failed", details }, status, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- /API/PROXY/TOKENS ----
      if (path === "/api/proxy/tokens") {
        if (req.method === "GET") {
          const customerID = url.searchParams.get("customerID");
          if (!customerID) return json({ error: "customerID required" }, 400);
          const token = getLatestTokenWrite.get({ $customerID: customerID }) as TokenRow | null;
          if (!token) return json({ found: false }, 404);
          const now = Math.floor(Date.now() / 1000);
          const cfClearance = await readProxySecret(PROXY_SECRET_NAMES.cfClearance, customerID)
            || extractCfClearanceValue(token.cf_clearance || "");
          return json({
            found: true,
            token: token.bearer_token ? token.bearer_token.substring(0, 40) + "..." : null,
            cf_clearance: cfClearance ? cfClearance.substring(0, 20) + "..." : null,
            expired: token.expires_at < now,
            expires_in: token.expires_at - now,
            created_at: token.created_at,
            expires_at: token.expires_at,
          });
        }
        if (req.method === "POST") {
          const authErr = apiKeyAuth(req);
          if (authErr) return authErr;
          const customerID = url.searchParams.get("customerID");
          if (!customerID) return json({ error: "customerID required" }, 400);
          const token = getLatestTokenWrite.get({ $customerID: customerID }) as TokenRow | null;
          if (!token) return json({ found: false }, 404);
          const now = Math.floor(Date.now() / 1000);
          const cfClearance = await readProxySecret(PROXY_SECRET_NAMES.cfClearance, customerID)
            || extractCfClearanceValue(token.cf_clearance || "");
          return json({
            found: true,
            token: token.bearer_token ? token.bearer_token.substring(0, 40) + "..." : null,
            cf_clearance: cfClearance ? cfClearance.substring(0, 20) + "..." : null,
            expired: token.expires_at < now,
            expires_in: token.expires_at - now,
            created_at: token.created_at,
            expires_at: token.expires_at,
          });
        }
      }

      // ---- /API/PROXY/LOGS ----
      if (path === "/api/proxy/logs" && req.method === "GET") {
        const authErr = apiKeyAuth(req);
        if (authErr) return authErr;
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const logs = getAdminLogs(limit);
        return json({ count: logs.length, logs });
      }

      // ---- /API/PROXY/HEALTH ----
      if (path === "/api/proxy/health") {
        const cf_clearance = url.searchParams.get("cf_clearance");
        if (!cf_clearance) {
          const health = await dependencyHealth();
          return json(health.body, health.httpStatus);
        }
        try {
          const test = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/`, {
            headers: { "Cookie": `cf_clearance=${cf_clearance}`, "User-Agent": browserHeaders()["User-Agent"] },
          }), { endpoint: "health" });
          const dbOk = getReadDb().query("SELECT 1").get() !== undefined;
          return json({ valid: test.status === 200, status: test.status, dependencies: (await dependencyHealth()).body });
        } catch (err: unknown) {
          return json({ valid: false, error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      // ---- /API/PROXY/STATUS ----
      if (path === "/api/proxy/status" && req.method === "GET") {
        const customerID = url.searchParams.get("customerID");
        const now = Math.floor(Date.now() / 1000);
        const row = totalRequestCount.get() as CountRow | null;
        const errRow = errorRequestCount.get() as CountRow | null;
        const resp: JsonObject = {
          service: "Buckeye Proxy",
          version: "2.0",
          uptime: process.uptime(),
          memory: { rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB" },
          timestamp: new Date().toISOString(),
          fingerprint: getApiFingerprintHeader(),
          stats: { total_requests: row?.count ?? 0, errors: errRow?.count ?? 0 },
          circuitBreaker: circuitBreaker.getStatus(),
          endpoints: ENDPOINT_COUNTS,
          test_results: { passed: TEST_SUMMARY.passed, total: TEST_SUMMARY.total, failures: [] },
          activeRequests,
        };
        if (customerID) {
          const token = getLatestTokenWrite.get({ $customerID: customerID }) as TokenRow | null;
          if (token) {
            (resp as JsonObject).token = {
              exists: true,
              expired: token.expires_at < now,
              expires_in: token.expires_at - now,
              renew_needed: (token.expires_at - now) < 900,
            };
          }
        }
        return json(resp);
      }

      // ---- /API/PROXY/ENDPOINTS ----
      if (path === "/api/proxy/endpoints" && req.method === "GET") {
        const all = getAllEndpoints();
        const proxyRoutes: Record<string, string> = {};
        const buckeyeRoutes: Record<string, string> = {};
        for (const [k, v] of Object.entries(all.proxy)) proxyRoutes[v.path] = `${v.method} - ${v.description}`;
        for (const [k, v] of Object.entries(all.buckeye)) buckeyeRoutes[k] = `[${v.test_ok ? "OK" : "FAIL"}] ${v.description}`;
        const cacheControl = url.searchParams.get("_") ? "no-cache" : "max-age=300";
        return json({
          proxy: proxyRoutes,
          buckeye: buckeyeRoutes,
          taxonomy: Object.fromEntries(Object.entries(TAXONOMY_MAP).map(([level, cfg]) => [
            `/api/proxy/taxonomy/${level}`,
            `POST - ${cfg.endpoint} -> ${cfg.shape}, cache ${cfg.cacheTtl}s`,
          ])),
          aliases: Object.fromEntries(Object.entries(PROXY_ALIAS_MAP).map(([alias, candidates]) => [
            `/api/proxy/${alias}`,
            {
              method: "POST",
              params: PROXY_ALIAS_PARAMS[alias as ProxyAliasName],
              candidates: candidates.map((candidate) => ({
                endpoint: candidate.endpoint,
                operation: candidate.operation,
                defaults: candidate.defaults || {},
              })),
            },
          ])),
          analytics: {
            "/api/proxy/analytics/syndicates": "POST - detect same-game/same-line bettor clusters",
            "/api/proxy/analytics/syndicates/stats": "GET - summarize syndicate detections and integrity case status",
            "/api/proxy/analytics/sharp-money": "POST - correlate local wager analytics with line history",
            "/api/proxy/analytics/ev-simulation": "POST - compute bettor EV and edge model",
            "/api/proxy/analytics/predictive-sharpness": "POST - compute predictive sharpness score for a bettor",
            "/api/proxy/analytics/backtest": "POST - simulate line adjustment rules against historical data",
            "/api/proxy/integrity/cases": "GET/POST - list or create integrity review cases",
            "/api/proxy/integrity/cases/:id": "PATCH - update an integrity review case",
            "/api/proxy/risk/alerts": "GET/POST - read or save risk alert thresholds",
            "/api/proxy/risk/config": "GET/POST/DELETE - risk config CRUD",
            "/api/proxy/risk/syndicates": "GET - read cached syndicate detections",
            "/api/proxy/line-rules": "GET/POST/PUT/DELETE - auto line adjustment rule CRUD",
            "/api/proxy/line-adjustments/log": "GET - line adjustment audit log",
          },
          endpointMap: Object.fromEntries(Object.entries(ENDPOINT_MAP).map(([key, meta]) => [
            key,
            { path: `/cloud/api/${meta.path}`, cacheTtl: meta.cacheTtl, category: meta.category, description: getEndpointDescription(key) },
          ])),
          counts: ENDPOINT_COUNTS,
          test_summary: `${TEST_SUMMARY.passed}/${TEST_SUMMARY.total} passed`,
        }, 200, { "Cache-Control": cacheControl });
      }

      // ---- /API/PROXY/AGENT/HEATMAP ----
      if (path === "/api/proxy/agent/heatmap" && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const agentID = String(body.agentID || body.customerID || "");
        const days = Math.min(Math.max(parseInt(String(body.days || "30"), 10) || 30, 1), 90);

        if (!agentID) {
          activeRequests--;
          return json({ error: "agentID or customerID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        let finalToken = body.token ? String(body.token) : "";
        let finalCf = body.cf_clearance ? extractCfClearanceValue(String(body.cf_clearance)) : "";

        if (agentID && (!finalToken || !finalCf)) {
          const stored = await getStoredCredentials(agentID);
          if (stored) {
            finalToken ||= stored.token;
            finalCf ||= stored.cf_clearance;
          }
        }

        try {
          // Fetch web logs (timestamps with IP, device) for activity heatmap
          const webLogParams = new URLSearchParams({
            agentID: agentID,
            customerID: agentID,
            start: normalizeWebLogDate(new Date(Date.now() - days * 86400000).toISOString()),
            end: normalizeWebLogDate(new Date().toISOString()),
            type: "A",
            actions: "ALL",
            operation: "getWebLog",
            RRO: "1",
            agentOwner: agentID,
            agentSite: "1",
          });

          const webLogRes = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/qubic/api/Manager/getWebLog`, {
            method: "POST",
            headers: browserHeaders(finalToken, `cf_clearance=${finalCf}`),
            body: webLogParams.toString(),
          }), { reqId: ctx.reqId, endpoint: "getWebLog" });

          const webLogData = await webLogRes.json().catch(() => null);

          // Also fetch recent wagers for volume heatmap
          const wagerRes = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
            method: "POST",
            headers: browserHeaders(finalToken, `cf_clearance=${finalCf}`),
            body: toForm({ operation: "getBetTicker", agentID, agentOwner: agentID, agentSite: "1" }),
          }), { reqId: ctx.reqId, endpoint: "getBetTicker" });

          const wagerData = await wagerRes.json().catch(() => null);
          const wagerList = Array.isArray(wagerData?.LIST) ? wagerData.LIST : Array.isArray(wagerData?.data?.LIST) ? wagerData.data.LIST : [];

          // Parse web log entries for timestamps
          const logEntries = parseWebLogEntries(webLogData);

          // Build 7x24 matrices
          const accessHeatmap = buildHeatmapFromEntries(logEntries, days, "access_datetime");
          const wagerHeatmap = buildHeatmapFromWagers(wagerList, days);

          requestFinished(ctx, "agent/heatmap", agentID, 200);
          activeRequests--;
          return json({
            agentID,
            days,
            access: accessHeatmap,
            wagers: wagerHeatmap,
            totalAccessLogEntries: logEntries.length,
            totalWagers: wagerList.length,
            fetchedAt: new Date().toISOString(),
          }, 200, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "agent/heatmap", agentID, 500, err);
          activeRequests--;
          return json({ error: "Heatmap fetch failed", details: err instanceof Error ? err.message : String(err) }, 502, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- /API/PROXY/ANALYTICS/SYNDICATES ----
      if (path === "/api/proxy/analytics/syndicates" && req.method === "POST") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const agentID = String(body.agentID || body.customerID || "");
        const lookbackHours = Math.min(Math.max(parseInt(String(body.lookbackHours || "24"), 10) || 24, 1), 168);
        const minBettors = Math.max(parseInt(String(body.minBettors || "2"), 10) || 2, 2);
        const minStake = Math.max(parseInt(String(body.minStake || "1000"), 10) || 1000, 0);
        const days = Math.ceil(lookbackHours / 24);

        if (!agentID) {
          activeRequests--;
          return json({ error: "agentID or customerID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        let finalToken = body.token ? String(body.token) : "";
        let finalCf = body.cf_clearance ? extractCfClearanceValue(String(body.cf_clearance)) : "";
        if (agentID && (!finalToken || !finalCf)) {
          const stored = await getStoredCredentials(agentID);
          if (stored) { finalToken ||= stored.token; finalCf ||= stored.cf_clearance; }
        }
        if (!finalToken || !finalCf) {
          activeRequests--;
          return json({ error: "token/cf_clearance or stored credentials required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        try {
          const wagerRes = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
            method: "POST",
            headers: browserHeaders(finalToken, `cf_clearance=${finalCf}`),
            body: toForm({ operation: "getBetTicker", agentID, agentOwner: agentID, agentSite: "1" }),
          }), { reqId: ctx.reqId, endpoint: "getBetTicker" });

          const wagerData = await wagerRes.json().catch(() => null);
          const wagerList = Array.isArray(wagerData?.LIST) ? wagerData.LIST : Array.isArray(wagerData?.data?.LIST) ? wagerData.data.LIST : [];
          const storedWagers = storeAnalyticWagers(wagerList.filter(isTaxonomyRecord), agentID);
          const cutoff = Date.now() - lookbackHours * 3600000;
          const wagers = parseBuckeyeWagers(wagerData).filter(w => w.timestamp >= cutoff);
          const syndicates = detectSyndicates(wagers, { minBettors, minStake });

          for (const s of syndicates) {
            insertSyndicate.run({
              $id: s.id, $agentID: agentID, $pattern: s.pattern,
              $members: JSON.stringify(s.members), $totalStake: s.totalStake, $commonGame: s.commonGame,
              $windowMs: s.windowMs || 0, $wagerCount: s.wagerCount || s.members.length, $avgStake: s.avgStake || 0,
              $riskScore: s.riskScore || 0, $confidence: s.confidence || 0, $signals: JSON.stringify(s.signals || []),
              $detected_at: Math.floor(s.timestamp / 1000),
            });
          }

          requestFinished(ctx, "analytics/syndicates", agentID, 200);
          activeRequests--;
          return json({
            agentID, lookbackHours, minBettors, minStake,
            totalWagers: wagers.length,
            storedWagers: storedWagers.length,
            syndicates: syndicates.length,
            syndicateDetails: syndicates,
            fetchedAt: new Date().toISOString(),
          }, 200, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "analytics/syndicates", agentID, 500, err);
          activeRequests--;
          return json({ error: "Syndicate detection failed", details: err instanceof Error ? err.message : String(err) }, 502, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- /API/PROXY/ANALYTICS/SHARP-MONEY ----
      if (path === "/api/proxy/analytics/sharp-money" && req.method === "POST") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const agentID = String(body.agentID || body.customerID || "");
        const gameId = String(body.gameId || "");
        const minutesBefore = Math.min(Math.max(parseInt(String(body.minutesBefore || "60"), 10) || 60, 1), 1440);

        if (!agentID) {
          activeRequests--;
          return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        let finalToken = body.token ? String(body.token) : "";
        let finalCf = body.cf_clearance ? extractCfClearanceValue(String(body.cf_clearance)) : "";
        if (agentID && (!finalToken || !finalCf)) {
          const stored = await getStoredCredentials(agentID);
          if (stored) { finalToken ||= stored.token; finalCf ||= stored.cf_clearance; }
        }
        if (!finalToken || !finalCf) {
          activeRequests--;
          return json({ error: "token/cf_clearance or stored credentials required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        try {
          const cutoff = Date.now() - minutesBefore * 60000;
          const wagerRes = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
            method: "POST",
            headers: browserHeaders(finalToken, `cf_clearance=${finalCf}`),
            body: toForm({ operation: "getBetTicker", agentID, agentOwner: agentID, agentSite: "1" }),
          }), { reqId: ctx.reqId, endpoint: "getBetTicker" });

          const wagerData = await wagerRes.json().catch(() => null);
          const wagers = parseBuckeyeWagers(wagerData).filter(w => w.timestamp >= cutoff);

          // For sharp money, we need line movements. If the caller provided them, use them.
          // Otherwise we infer from wager patterns (same game, same type, different lines at different times).
          const lineHistory: LineMove[] = Array.isArray(body.lineHistory) ? (body.lineHistory as LineMove[]) : [];
          const alerts = correlateSharpMoney(lineHistory, wagers);

          // If no line history provided, provide wagers grouped by game for manual analysis
          const gameGroups = new Map<string, Wager[]>();
          for (const w of wagers) {
            if (gameId && w.gameId !== gameId) continue;
            if (!gameGroups.has(w.gameId)) gameGroups.set(w.gameId, []);
            gameGroups.get(w.gameId)!.push(w);
          }

          requestFinished(ctx, "analytics/sharp-money", agentID, 200);
          activeRequests--;
          return json({
            agentID, gameId, minutesBefore,
            totalWagers: wagers.length,
            lineHistoryProvided: lineHistory.length > 0,
            sharpAlerts: alerts,
            gameSummaries: Array.from(gameGroups.entries()).map(([gid, gw]) => ({
              gameId: gid,
              wagerCount: gw.length,
              totalStake: gw.reduce((s, w) => s + w.stake, 0),
              uniqueBettors: new Set(gw.map(w => w.bettorId)).size,
            })),
            fetchedAt: new Date().toISOString(),
          }, 200, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "analytics/sharp-money", agentID, 500, err);
          activeRequests--;
          return json({ error: "Sharp money analysis failed", details: err instanceof Error ? err.message : String(err) }, 502, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- /API/PROXY/ANALYTICS/EV-SIMULATION ----
      if (path === "/api/proxy/analytics/ev-simulation" && req.method === "POST") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const agentID = String(body.agentID || body.customerID || "");
        const bettorID = String(body.bettorID || "");
        const modelType = String(body.modelType || "bayesian");
        const lookbackDays = Math.min(Math.max(parseInt(String(body.lookbackDays || "30"), 10) || 30, 1), 365);

        if (!agentID) {
          activeRequests--;
          return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        let finalToken = body.token ? String(body.token) : "";
        let finalCf = body.cf_clearance ? extractCfClearanceValue(String(body.cf_clearance)) : "";
        if (agentID && (!finalToken || !finalCf)) {
          const stored = await getStoredCredentials(agentID);
          if (stored) { finalToken ||= stored.token; finalCf ||= stored.cf_clearance; }
        }
        if (!finalToken || !finalCf) {
          activeRequests--;
          return json({ error: "token/cf_clearance or stored credentials required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        try {
          const cutoff = Date.now() - lookbackDays * 86400000;
          const wagerRes = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
            method: "POST",
            headers: browserHeaders(finalToken, `cf_clearance=${finalCf}`),
            body: toForm({ operation: "getBetTicker", agentID, agentOwner: agentID, agentSite: "1" }),
          }), { reqId: ctx.reqId, endpoint: "getBetTicker" });

          const wagerData = await wagerRes.json().catch(() => null);
          let wagers = parseBuckeyeWagers(wagerData).filter(w => w.timestamp >= cutoff);
          if (bettorID) wagers = wagers.filter(w => w.bettorId === bettorID);

          const ev = computeExpectedValue(wagers, modelType);

          requestFinished(ctx, "analytics/ev-simulation", agentID, 200);
          activeRequests--;
          return json({
            agentID, bettorID: bettorID || "all", modelType, lookbackDays,
            totalWagers: wagers.length,
            ev,
            fetchedAt: new Date().toISOString(),
          }, 200, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "analytics/ev-simulation", agentID, 500, err);
          activeRequests--;
          return json({ error: "EV simulation failed", details: err instanceof Error ? err.message : String(err) }, 502, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- /API/PROXY/RISK/ALERTS ----
      if (path === "/api/proxy/risk/alerts" && req.method === "POST") {
        activeRequests++;
        if (!CONFIG.features.riskEngine) { activeRequests--; return json({ error: "Risk engine disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const agentID = String(body.agentID || body.customerID || "");
        const thresholds = asTaxonomyRecord(body.thresholds) || {};
        const webhookUrl = String(body.webhookUrl || "");

        if (!agentID) {
          activeRequests--;
          return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        insertRiskConfig.run({
          $agentID: agentID,
          $customerID: String(body.customerID || agentID),
          $thresholds: JSON.stringify(thresholds),
          $webhook: webhookUrl || null,
        });

        requestFinished(ctx, "risk/alerts", agentID, 200);
        activeRequests--;
        return json({ success: true, agentID, thresholds, webhookUrl: webhookUrl || null }, 200, { "X-Request-ID": ctx.reqId });
      }

      if (path === "/api/proxy/risk/alerts" && req.method === "GET") {
        activeRequests++;
        if (!CONFIG.features.riskEngine) { activeRequests--; return json({ error: "Risk engine disabled" }, 403); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const agentID = url.searchParams.get("agentID");
        if (agentID) {
          const cfg = getRiskConfig.get({ $agentID: agentID }) as { agentID: string; thresholds: string; webhook: string | null; updated_at: number } | null;
          activeRequests--;
          if (!cfg) return json({ agentID, thresholds: {}, webhookUrl: null });
          return json({ agentID: cfg.agentID, thresholds: JSON.parse(cfg.thresholds), webhookUrl: cfg.webhook, updatedAt: cfg.updated_at });
        }
        const all = getAllRiskConfigs.all() as Array<{ agentID: string; thresholds: string; webhook: string | null; updated_at: number }>;
        activeRequests--;
        return json({ configs: all.map(c => ({ agentID: c.agentID, thresholds: JSON.parse(c.thresholds), webhookUrl: c.webhook, updatedAt: c.updated_at })) });
      }

      // ---- /API/PROXY/RISK/CONFIG ----
      if (path === "/api/proxy/risk/config" && req.method === "DELETE") {
        activeRequests++;
        if (!CONFIG.features.riskEngine) { activeRequests--; return json({ error: "Risk engine disabled" }, 403); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const agentID = url.searchParams.get("agentID");
        if (!agentID) { activeRequests--; return json({ error: "agentID required" }, 400); }
        deleteRiskConfig.run({ $agentID: agentID });
        activeRequests--;
        return json({ success: true, deleted: agentID });
      }

      // ---- /API/PROXY/RISK/SYNDICATES (GET cached) ----
      if (path === "/api/proxy/risk/syndicates" && req.method === "GET") {
        activeRequests++;
        if (!CONFIG.features.riskEngine) { activeRequests--; return json({ error: "Risk engine disabled" }, 403); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const agentID = url.searchParams.get("agentID");
        if (!agentID) { activeRequests--; return json({ error: "agentID required" }, 400); }
        const since = url.searchParams.get("since");
        const sinceTs = since ? Math.floor(new Date(since).getTime() / 1000) : Math.floor(Date.now() / 1000) - 86400;
        const rows = getSyndicatesByAgent.all({ $agentID: agentID, $since: sinceTs }) as Array<{
          id: string; agentID: string; pattern: string; members: string; totalStake: number; detected_at: number;
          windowMs?: number; wagerCount?: number; avgStake?: number; riskScore?: number; confidence?: number; signals?: string;
        }>;
        activeRequests--;
        return json({
          agentID,
          syndicates: rows.map(r => ({
            id: r.id,
            pattern: r.pattern,
            members: JSON.parse(r.members),
            totalStake: r.totalStake,
            windowMs: r.windowMs || 0,
            wagerCount: r.wagerCount || 0,
            avgStake: r.avgStake || 0,
            riskScore: r.riskScore || 0,
            confidence: r.confidence || 0,
            signals: JSON.parse(r.signals || "[]"),
            detectedAt: new Date(r.detected_at * 1000).toISOString(),
          })),
        });
      }

      // ---- /API/PROXY/ANALYTICS/SYNDICATES/STATS ----
      if (path === "/api/proxy/analytics/syndicates/stats" && req.method === "GET") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const agentID = url.searchParams.get("agentID") || "";
        if (!agentID) { activeRequests--; return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId }); }
        const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") || "24", 10) || 24, 1), 168);
        const since = Math.floor(Date.now() / 1000) - hours * 3600;
        const syndicateStats = getSyndicateStats.get({ $agentID: agentID, $since: since }) as { count: number; totalStake: number; maxRiskScore: number; latestDetectedAt: number } | null;
        const caseRows = getIntegrityCaseStatusCounts.all({ $agentID: agentID }) as Array<{ status: string; count: number }>;
        activeRequests--;
        return json({
          agentID,
          windowHours: hours,
          syndicates: {
            count: syndicateStats?.count || 0,
            totalStake: syndicateStats?.totalStake || 0,
            maxRiskScore: syndicateStats?.maxRiskScore || 0,
            latestDetectedAt: syndicateStats?.latestDetectedAt ? new Date(syndicateStats.latestDetectedAt * 1000).toISOString() : null,
          },
          cases: caseRows.reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {} as Record<string, number>),
        }, 200, { "X-Request-ID": ctx.reqId });
      }

      // ---- /API/PROXY/INTEGRITY/CASES ----
      if (path === "/api/proxy/integrity/cases" && req.method === "GET") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const agentID = url.searchParams.get("agentID") || "";
        if (!agentID) { activeRequests--; return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId }); }
        const status = normalizeCaseStatus(url.searchParams.get("status") || "");
        const statusFilter = url.searchParams.has("status") ? status : "";
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
        const rows = getIntegrityCases.all({ $agentID: agentID, $status: statusFilter, $limit: limit }) as IntegrityCaseRow[];
        activeRequests--;
        return json({ agentID, status: statusFilter || "all", cases: rows.map(serializeIntegrityCase) }, 200, { "X-Request-ID": ctx.reqId });
      }

      if (path === "/api/proxy/integrity/cases" && req.method === "POST") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const agentID = String(body.agentID || "");
        if (!agentID) { activeRequests--; return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId }); }
        const id = randomUUIDv7();
        const status = normalizeCaseStatus(body.status);
        const priority = normalizeCasePriority(body.priority);
        const title = String(body.title || body.syndicateId || "Integrity review").slice(0, 160);
        const evidence = typeof body.evidence === "string" ? body.evidence : JSON.stringify(body.evidence || {});
        insertIntegrityCase.run({
          $id: id,
          $agentID: agentID,
          $syndicateId: body.syndicateId ? String(body.syndicateId) : null,
          $status: status,
          $priority: priority,
          $title: title,
          $summary: body.summary ? String(body.summary) : "",
          $evidence: evidence,
          $reviewer: body.reviewer ? String(body.reviewer) : "",
          $notes: body.notes ? String(body.notes) : "",
        });
        const row = getIntegrityCaseById.get({ $id: id }) as IntegrityCaseRow | null;
        activeRequests--;
        return json({ case: row ? serializeIntegrityCase(row) : null }, 201, { "X-Request-ID": ctx.reqId });
      }

      if (path.startsWith("/api/proxy/integrity/cases/") && req.method === "PATCH") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const id = decodeURIComponent(path.replace("/api/proxy/integrity/cases/", ""));
        const existing = getIntegrityCaseById.get({ $id: id }) as IntegrityCaseRow | null;
        if (!existing) { activeRequests--; return json({ error: "case not found" }, 404, { "X-Request-ID": ctx.reqId }); }
        const body = await readBody(req);
        const reviewer = body.reviewer !== undefined ? String(body.reviewer) : (existing.reviewer || "");
        const appended = body.appendNote ? `[${new Date().toISOString()}] ${reviewer || "reviewer"}: ${String(body.appendNote)}` : "";
        const notes = appended ? [existing.notes || "", appended].filter(Boolean).join("\n") : body.notes !== undefined ? String(body.notes) : (existing.notes || "");
        const evidence = body.evidence !== undefined ? (typeof body.evidence === "string" ? body.evidence : JSON.stringify(body.evidence)) : (existing.evidence || "{}");
        updateIntegrityCase.run({
          $id: id,
          $status: body.status !== undefined ? normalizeCaseStatus(body.status) : existing.status,
          $priority: body.priority !== undefined ? normalizeCasePriority(body.priority) : existing.priority,
          $title: body.title !== undefined ? String(body.title).slice(0, 160) : existing.title,
          $summary: body.summary !== undefined ? String(body.summary) : (existing.summary || ""),
          $evidence: evidence,
          $reviewer: reviewer,
          $notes: notes,
        });
        const row = getIntegrityCaseById.get({ $id: id }) as IntegrityCaseRow | null;
        activeRequests--;
        return json({ case: row ? serializeIntegrityCase(row) : null }, 200, { "X-Request-ID": ctx.reqId });
      }

      // ---- /API/PROXY/ANALYTICS/PREDICTIVE-SHARPNESS ----
      if (path === "/api/proxy/analytics/predictive-sharpness" && req.method === "POST") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const agentID = String(body.agentID || body.customerID || "");
        const bettorID = String(body.bettorID || "");
        const lookbackDays = Math.min(Math.max(parseInt(String(body.lookbackDays || "90"), 10) || 90, 1), 365);

        if (!agentID) {
          activeRequests--;
          return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        let finalToken = body.token ? String(body.token) : "";
        let finalCf = body.cf_clearance ? extractCfClearanceValue(String(body.cf_clearance)) : "";
        if (agentID && (!finalToken || !finalCf)) {
          const stored = await getStoredCredentials(agentID);
          if (stored) { finalToken ||= stored.token; finalCf ||= stored.cf_clearance; }
        }
        if (!finalToken || !finalCf) {
          activeRequests--;
          return json({ error: "token/cf_clearance or stored credentials required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        try {
          const since = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
          const cutoff = Date.now() - lookbackDays * 86400000;

          let wagers: Wager[] = [];
          if (bettorID) {
            const dbRows = getWagerAnalytics.all({ $bettorId: bettorID, $since: since }) as Array<Record<string, unknown>>;
            if (dbRows.length >= 30) {
              wagers = dbRows.map(r => ({
                bettorId: String(r.bettorId || ""),
                gameId: String(r.gameId || ""),
                wagerType: String(r.wagerType || ""),
                side: String(r.side || ""),
                line: Number(r.line || 0),
                odds: Number(r.odds || 0),
                stake: Number(r.stake || 0),
                timestamp: Number(r.timestamp || 0) * 1000,
                profit: Number(r.profit || 0),
                sport: String(r.sport || ""),
              }));
            }
          }

          if (wagers.length < 30) {
            const wagerRes = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
              method: "POST",
              headers: browserHeaders(finalToken, `cf_clearance=${finalCf}`),
              body: toForm({ operation: "getBetTicker", agentID, agentOwner: agentID, agentSite: "1" }),
            }), { reqId: ctx.reqId, endpoint: "getBetTicker" });
            const wagerData = await wagerRes.json().catch(() => null);
            let parsed = parseBuckeyeWagers(wagerData).filter(w => w.timestamp >= cutoff);
            if (bettorID) parsed = parsed.filter(w => w.bettorId === bettorID);
            wagers = parsed;
          }

          const wagerAnalytics: WagerAnalytic[] = wagers.map(w => ({
            stake: w.stake,
            profit: w.profit || 0,
            sport: w.sport || "",
            wagerType: w.wagerType || "",
            timestamp: w.timestamp,
          }));

          const result = computePredictiveSharpness(wagerAnalytics);

          if (bettorID) {
            insertSharpness.run({
              $bettorId: bettorID, $sharpScore: result.score, $wagerCount: wagerAnalytics.length,
              $winRate: result.factors.winRate, $roi: result.factors.recentROI,
            });
          }

          requestFinished(ctx, "analytics/predictive-sharpness", agentID, 200);
          activeRequests--;
          return json({
            bettorID: bettorID || "all",
            agentID,
            lookbackDays,
            totalWagers: wagerAnalytics.length,
            ...result,
            fetchedAt: new Date().toISOString(),
          }, 200, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "analytics/predictive-sharpness", agentID, 500, err);
          activeRequests--;
          return json({ error: "Predictive sharpness failed", details: err instanceof Error ? err.message : String(err) }, 502, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- /API/PROXY/LINE-RULES (CRUD) ----
      if (path === "/api/proxy/line-rules" && req.method === "GET") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const agentID = url.searchParams.get("agentID");
        const rules = agentID
          ? getLineRulesByAgent.all({ $agentID: agentID })
          : getAllLineRules.all();
        activeRequests--;
        return json({ rules });
      }

      if (path === "/api/proxy/line-rules" && req.method === "POST") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const agentID = String(body.agentID || "");
        const sport = String(body.sport || "NFL");
        const league = String(body.league || "");
        const lineType = String(body.lineType || "SPREAD");
        const condition = String(body.condition || "sharp_money_threshold");
        const threshold = Number(body.threshold || 5000);
        const adjustmentPercent = Number(body.adjustmentPercent || 5);
        const maxMovePercent = Number(body.maxMovePercent || 10);
        const enabled = body.enabled === false ? 0 : 1;

        if (!agentID) { activeRequests--; return json({ error: "agentID required" }, 400); }

        const result = insertLineRule.run({
          $agentID: agentID, $sport: sport, $league: league, $lineType: lineType,
          $condition: condition, $threshold: threshold, $adjustmentPercent: adjustmentPercent,
          $maxMovePercent: maxMovePercent, $enabled: enabled,
        });

        activeRequests--;
        return json({ success: true, id: Number(result.lastInsertRowid), agentID, sport, league, lineType, condition, threshold, adjustmentPercent, maxMovePercent, enabled }, 201);
      }

      if (path === "/api/proxy/line-rules" && req.method === "PUT") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const id = Number(body.id);
        const agentID = String(body.agentID || "");
        if (!id || !agentID) { activeRequests--; return json({ error: "id and agentID required" }, 400); }

        updateLineRule.run({
          $id: id, $agentID: agentID,
          $sport: String(body.sport || "NFL"), $league: String(body.league || ""),
          $lineType: String(body.lineType || "SPREAD"), $condition: String(body.condition || "sharp_money_threshold"),
          $threshold: Number(body.threshold || 5000), $adjustmentPercent: Number(body.adjustmentPercent || 5),
          $maxMovePercent: Number(body.maxMovePercent || 10), $enabled: body.enabled === false ? 0 : 1,
        });

        activeRequests--;
        return json({ success: true, id });
      }

      if (path === "/api/proxy/line-rules" && req.method === "DELETE") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const id = url.searchParams.get("id");
        const agentID = url.searchParams.get("agentID");
        if (!id || !agentID) { activeRequests--; return json({ error: "id and agentID required" }, 400); }
        deleteLineRule.run({ $id: Number(id), $agentID: agentID });
        activeRequests--;
        return json({ success: true, deleted: Number(id) });
      }

      // ---- /API/PROXY/LINE-ADJUSTMENTS/LOG ----
      if (path === "/api/proxy/line-adjustments/log" && req.method === "GET") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const gameId = url.searchParams.get("gameId");
        const since = url.searchParams.get("since");
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10), 1), 500);

        if (gameId) {
          const rows = getLineAdjLog.all({ $gameId: gameId, $limit: limit });
          activeRequests--;
          return json({ gameId, adjustments: rows });
        }
        const sinceTs = since ? Math.floor(new Date(since).getTime() / 1000) : Math.floor(Date.now() / 1000) - 86400;
        const rows = getRecentLineAdjLog.all({ $since: sinceTs, $limit: limit });
        activeRequests--;
        return json({ adjustments: rows });
      }

      // ---- /API/PROXY/ANALYTICS/BACKTEST ----
      if (path === "/api/proxy/analytics/backtest" && req.method === "POST") {
        activeRequests++;
        if (!CONFIG.features.analytics) { activeRequests--; return json({ error: "Analytics disabled" }, 403, { "X-Request-ID": ctx.reqId }); }
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const agentID = String(body.agentID || body.customerID || "");
        const days = Math.min(Math.max(parseInt(String(body.days || "7"), 10) || 7, 1), 90);
        const ruleParams = Array.isArray(body.rules) ? body.rules as BacktestRule[] : [];

        if (!agentID) {
          activeRequests--;
          return json({ error: "agentID required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        let finalToken = body.token ? String(body.token) : "";
        let finalCf = body.cf_clearance ? extractCfClearanceValue(String(body.cf_clearance)) : "";
        if (agentID && (!finalToken || !finalCf)) {
          const stored = await getStoredCredentials(agentID);
          if (stored) { finalToken ||= stored.token; finalCf ||= stored.cf_clearance; }
        }
        if (!finalToken || !finalCf) {
          activeRequests--;
          return json({ error: "token/cf_clearance or stored credentials required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        try {
          const since = Math.floor(Date.now() / 1000) - days * 86400;
          const cutoff = Date.now() - days * 86400000;

          const wagerRes = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
            method: "POST",
            headers: browserHeaders(finalToken, `cf_clearance=${finalCf}`),
            body: toForm({ operation: "getBetTicker", agentID, agentOwner: agentID, agentSite: "1" }),
          }), { reqId: ctx.reqId, endpoint: "getBetTicker" });
          const wagerData = await wagerRes.json().catch(() => null);
          const wagers = parseBuckeyeWagers(wagerData).filter(w => w.timestamp >= cutoff);

          const lineHistoryRows = getLineHistorySince.all({ $since: since }) as Array<{ gameId: string; lineType: string; side: string; oldLine: number; newLine: number; oldOdds: number; newOdds: number; timestamp: number }>;
          const lineHistory: LineMove[] = lineHistoryRows.map(r => ({
            timestamp: r.timestamp * 1000,
            lineType: r.lineType,
            side: r.side,
            oldLine: r.oldLine,
            newLine: r.newLine,
            oldOdds: r.oldOdds,
            newOdds: r.newOdds,
            gameId: r.gameId,
          }));

          const rules = ruleParams.length > 0 ? ruleParams : (getAllLineRules.all() as Array<{ id: number; agentID: string; sport: string; league: string; lineType: string; condition: string; threshold: number; adjustmentPercent: number; maxMovePercent: number; enabled: number }>).map(r => ({
            sport: r.sport, league: r.league, lineType: r.lineType, condition: r.condition,
            threshold: r.threshold, adjustmentPercent: r.adjustmentPercent, maxMovePercent: r.maxMovePercent,
          }));

          const simulation = simulateLineAdjustments(wagers, rules, lineHistory);

          requestFinished(ctx, "analytics/backtest", agentID, 200);
          activeRequests--;
          return json({
            agentID, days,
            wagersAnalyzed: wagers.length,
            lineHistorySize: lineHistory.length,
            rulesTested: rules.length,
            simulation,
            fetchedAt: new Date().toISOString(),
          }, 200, { "X-Request-ID": ctx.reqId });
        } catch (err: unknown) {
          requestFinished(ctx, "analytics/backtest", agentID, 500, err);
          activeRequests--;
          return json({ error: "Backtest failed", details: err instanceof Error ? err.message : String(err) }, 502, { "X-Request-ID": ctx.reqId });
        }
      }

      // ---- /ADMIN/RATE-LIMIT ----
      if (path === "/admin/rate-limit") {
        const authErr = adminApiKeyAuth(req);
        if (authErr) return authErr;

        if (req.method === "GET") {
          const all = getAllRateLimitOverridesStmt.all() as Array<{ endpoint: string; limit: number; window: number; updated_at: number }>;
          return json({ overrides: all });
        }

        if (req.method === "POST") {
          const parsed = await safeParseBody(req, RateLimitOverrideSchema);
          if (!parsed.success) return json({ error: parsed.error }, 400);
          const { endpoint, limit, window } = parsed.data;
          setRateLimitOverrideStmt.run({ $endpoint: endpoint, $limit: limit, $window: window });
          rateLimitOverrides.set(endpoint, { limit, window });
          return json({ success: true, endpoint, limit, window });
        }

        if (req.method === "DELETE") {
          const endpoint = url.searchParams.get("endpoint");
          if (!endpoint) return json({ error: "endpoint query param required" }, 400);
          deleteRateLimitOverrideInline.run({ $endpoint: endpoint });
          rateLimitOverrides.delete(endpoint);
          return json({ success: true, deleted: endpoint });
        }

        return json({ error: "Method not allowed" }, 405);
      }

      // ---- /ADMIN/WS ----
      if (path === "/admin/ws" && req.method === "GET") {
        const authErr = adminApiKeyAuth(req);
        if (authErr) return authErr;
        const clients = Array.from(subscribers.entries()).map(([id, sub]) => ({
          id: id.slice(0, 8),
          customerID: sub.customerID,
          connected: sub.ws.readyState === 1,
          batched: !!sub.batchInterval,
        }));
        return json({ count: clients.length, clients });
      }

      // ---- /ADMIN/TRACES ----
      if (path === "/admin/traces" && req.method === "GET") {
        const authErr = adminApiKeyAuth(req);
        if (authErr) return authErr;
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10), 1), 500);
        return json({
          service: CONFIG.otel.serviceName,
          otelEnabled: CONFIG.otel.enabled,
          endpoint: CONFIG.otel.endpoint,
          spans: tracer.getRecent(limit),
        });
      }

      // ---- /ADMIN/REQUESTS ----
      if (path === "/admin/requests" && req.method === "GET") {
        const authErr = adminApiKeyAuth(req);
        if (authErr) return authErr;
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10), 1), 500);
        const statsMinutes = Math.min(Math.max(parseInt(url.searchParams.get("statsMinutes") || "5", 10), 1), 60);
        return json({
          recent: requestListener.getRecent(limit),
          stats: requestListener.getStats(statsMinutes),
        });
      }

      // ---- /API/PROXY/RENEWTOKEN ----
      if (path === "/api/proxy/renewToken" && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }
        const body = await readBody(req);
        const { customerID: bodyCustID, cf_clearance: bodyCf, token: bodyToken } = body;

        let finalToken = bodyToken ? String(bodyToken) : "";
        let finalCf = bodyCf ? extractCfClearanceValue(String(bodyCf)) : "";
        const customerKey = bodyCustID ? String(bodyCustID) : "";

        if (customerKey && (!finalToken || !finalCf)) {
          const stored = await getStoredCredentials(customerKey);
          if (!stored) { activeRequests--; return json({ error: "No token found for this customerID" }, 404); }
          finalToken ||= stored.token;
          finalCf ||= stored.cf_clearance;
        }

        if (!finalToken || !finalCf) { activeRequests--; return json({ error: "Missing token or cf_clearance" }, 400); }

        const upstreamUrl = `${CONFIG.baseUrl}/cloud/api/System/renewToken`;
        const formData = toForm({ operation: "renewToken", agentID: customerKey || "BILLY666", agentOwner: customerKey || "BILLY666", agentSite: "1" });

        try {
          const upstream = await buckeyeCall(() => buckeyeFetch(upstreamUrl, {
            method: "POST",
            headers: browserHeaders(finalToken, `cf_clearance=${finalCf}`),
            body: formData,
          }), { reqId: ctx.reqId, endpoint: "renewToken" });

          const text = await upstream.text();
          const data = JSON.parse(text) as { token?: string; code?: string };

          if (upstream.ok && (data.token || data.code)) {
            const newToken = String(data.token || data.code);
            const expiresAt = Math.floor(Date.now() / 1000) + PROXY_CONSTANTS.TOKEN_EXPIRY_SECONDS;
            if (customerKey && finalCf) {
              await rememberProxyCredentialSecrets(customerKey, { cfClearance: finalCf });
            }
            insertToken.run({
              $customerID: customerKey || "BILLY666",
              $cf_clearance: null,
              $auth_code: null,
              $bearer_token: newToken,
              $expires_at: expiresAt,
            });
            invalidateTokenCache(customerKey || "BILLY666");
            scheduleTokenRenewal(customerKey || "BILLY666", expiresAt);
            activeRequests--;
            return json({ success: true, token: newToken });
          } else {
            activeRequests--;
            return json({ error: "Renewal failed", details: data }, upstream.status);
          }
        } catch (err: unknown) {
          activeRequests--;
          return json({ error: "Proxy error", details: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      // ---- /API/PROXY/DISCOVER-ENDPOINTS ----
      if (path === "/api/proxy/discover-endpoints" && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }

        const KNOWN_BUCKEYE_ENDPOINTS = [
          `${CONFIG.baseUrl}/cloud/api/Manager/getPerformancePlayer`,
          `${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`,
          `${CONFIG.baseUrl}/cloud/api/Manager/getPlayerLimits`,
          `${CONFIG.baseUrl}/cloud/api/Manager/setPlayerLimits`,
          `${CONFIG.baseUrl}/cloud/api/Manager/updatePlayerStatus`,
          `${CONFIG.baseUrl}/cloud/api/Manager/getPlayerDetails`,
          `${CONFIG.baseUrl}/cloud/api/Manager/getAgentPerformance`,
        ];

        const session = getLatestTokenWrite.get({ $customerID: "BILLY666" }) as TokenRow | null;
        if (!session || !session.bearer_token) {
          activeRequests--;
          return json({ error: "No active session" }, 401, { "X-Request-ID": ctx.reqId });
        }

        const results = await Promise.all(
          KNOWN_BUCKEYE_ENDPOINTS.map(async (url) => {
            try {
              const res = await fetch(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  "Authorization": `Bearer ${session.bearer_token}`,
                },
                body: new URLSearchParams({
                  operation: url.split("/").pop() || "",
                  RRO: "1",
                  PlayerID: "TEST_DISCOVERY",
                  MaxExposure: "0",
                }).toString(),
              });
              return {
                endpoint: url,
                status: res.status,
                statusText: res.statusText,
                accessible: res.status !== 404 && res.status !== 403,
              };
            } catch (err: any) {
              return {
                endpoint: url,
                status: 0,
                statusText: err.message,
                accessible: false,
              };
            }
          })
        );

        activeRequests--;
        return json({
          scanned: results.length,
          accessible: results.filter(r => r.accessible).map(r => r.endpoint),
          blocked: results.filter(r => !r.accessible).map(r => ({ endpoint: r.endpoint, status: r.status })),
          timestamp: new Date().toISOString(),
        }, 200, { "X-Request-ID": ctx.reqId });
      }

      // ---- /API/ENFORCEMENT/QUEUE ----
      if (path === "/api/enforcement/queue" && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }

        const body = await readBody(req);
        const status = cleanString(body.status) || null;
        const risk_level = cleanString(body.risk_level) || null;
        const limit = Math.min(100, Math.max(1, rowNumber(body, ["limit"], 50)));

        const queue = getEnforcementQueue.all({ $status: status, $risk_level: risk_level, $limit: limit }) as Array<{
          id: number; position_id: number | null; customer_id: string; risk_level: string;
          suggested_max_exposure: number | null; suggested_wager_limit: number | null;
          suggested_action: string | null; ai_confidence: number | null; ai_summary: string | null;
          status: string; viewed_at: string | null; viewed_by: string | null;
          applied_at: string | null; applied_by: string | null; buckeye_admin_url: string | null;
          reminder_count: number; last_reminder_at: string | null; created_at: string; expires_at: string;
        }>;

        activeRequests--;
        return json({ count: queue.length, queue }, 200, { "X-Request-ID": ctx.reqId });
      }

      // ---- /API/ENFORCEMENT/MARK-VIEWED ----
      if (path === "/api/enforcement/mark-viewed" && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }

        const body = await readBody(req);
        const queue_id = rowNumber(body, ["queue_id"], 0);
        const trader_name = cleanString(body.trader_name) || "unknown";

        if (!queue_id) {
          activeRequests--;
          return json({ error: "queue_id required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        updateEnforcementViewed.run({ $id: queue_id, $viewed_by: trader_name });
        activeRequests--;
        return json({ ok: true, queue_id, viewed_by: trader_name }, 200, { "X-Request-ID": ctx.reqId });
      }

      // ---- /API/ENFORCEMENT/MARK-APPLIED ----
      if (path === "/api/enforcement/mark-applied" && req.method === "POST") {
        activeRequests++;
        const authErr = apiKeyAuth(req);
        if (authErr) { activeRequests--; return authErr; }

        const body = await readBody(req);
        const queue_id = rowNumber(body, ["queue_id"], 0);
        const trader_name = cleanString(body.trader_name) || "unknown";

        if (!queue_id) {
          activeRequests--;
          return json({ error: "queue_id required" }, 400, { "X-Request-ID": ctx.reqId });
        }

        updateEnforcementApplied.run({ $id: queue_id, $applied_by: trader_name });
        activeRequests--;
        return json({ ok: true, queue_id, applied_by: trader_name }, 200, { "X-Request-ID": ctx.reqId });
      }

      activeRequests--;
      return json({ error: "Not found" }, 404);
    } catch (err: unknown) {
      activeRequests--;
      logger.error("Unhandled fetch error", { error: err instanceof Error ? err.message : String(err), path: url.pathname, reqId: ctx.reqId });
      return json({ error: "Internal Server Error", code: "INTERNAL_ERROR" }, 500);
    } finally {
      endRequestSpan(ctx.reqId, 404);
    }
  },

  error(error: Error) {
    logger.error("Bun.serve unhandled error", { error: error.message, stack: error.stack });
    return new Response(JSON.stringify({ error: "Internal Server Error", code: "INTERNAL_ERROR" }), { status: 500, headers: { "Content-Type": "application/json", ...cors } });
  },
});
server.ref();

// ==========================================
// 12. GRACEFUL SHUTDOWN
// ==========================================
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, draining connections`, { activeRequests, subscribers: subscribers.size + sessions.size });

  // Broadcast shutdown to WS clients
  for (const [, sub] of subscribers) {
    safeSendJson(sub.ws, { type: "shutdown", reason: "server restart", delayMs: 5000 }, "shutdown");
  }
  for (const ws of sessions.keys()) {
    safeSendJson(ws, { type: "shutdown", reason: "server restart", delayMs: 5000 }, "shutdown");
  }

  await Bun.sleep(5000);

  for (const [id, sub] of subscribers) {
    try { sub.ws.close(1000, "Graceful shutdown"); } catch (e) { console.debug("[Proxy] WS close during shutdown failed:", e); }
    stopTicker(id);
  }
  for (const [ws, session] of sessions.entries()) {
    clearInterval(session.interval);
    try { ws.close(1001, "Server shutting down"); } catch (e) { console.debug("[Proxy] Session WS close during shutdown failed:", e); }
    sessions.delete(ws);
  }

  const deadline = Date.now() + 10000;
  while (activeRequests > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
  }

  // Clear renewal timers
  for (const timer of tokenRenewalTimers.values()) clearTimeout(timer);
  tokenRenewalTimers.clear();

  if (tickBatchTimer) clearTimeout(tickBatchTimer);
  if (riskEngineTimer) clearInterval(riskEngineTimer);
  if (configWatcher) { configWatcher.close(); configWatcher = null; }

  // Clear caches
  memCache.clear();
  tokenMemCache.clear();
  inflight.clear();
  rateLimitOverrides.clear();

  insertToken.finalize();
  getLatestToken.finalize();
  getLatestTokenWrite.finalize();
  updateToken.finalize();
  getExpiringTokens.finalize();
  insertCache.finalize();
  getCache.finalize();
  getCacheStale.finalize();
  logRequestStmt.finalize();
  totalRequestCount.finalize();
  errorRequestCount.finalize();
  countCustomerRequests.finalize();
  countCustomerEndpointRequests.finalize();
  checkRateStmt.finalize();
  upsertRateStmt.finalize();
  getIdempotency.finalize();
  setIdempotency.finalize();
  purgeExpiredCache.finalize();
  purgeOldIdempotency.finalize();
  purgeOldRequestLogs.finalize();
  tokenCount.finalize();
  getRateLimitOverrideStmt.finalize();
  setRateLimitOverrideStmt.finalize();
  getAllRateLimitOverridesStmt.finalize();
  insertRiskConfig.finalize();
  getRiskConfig.finalize();
  getAllRiskConfigs.finalize();
  insertSyndicate.finalize();
  getSyndicates.finalize();
  getSyndicatesByAgent.finalize();
  insertIntegrityCase.finalize();
  getIntegrityCaseById.finalize();
  getIntegrityCases.finalize();
  updateIntegrityCase.finalize();
  getIntegrityCaseStatusCounts.finalize();
  getSyndicateStats.finalize();
  insertLineHistory.finalize();
  getLineHistory.finalize();
  getLineHistorySince.finalize();
  insertWagerAnalytics.finalize();
  getWagerAnalytics.finalize();
  getAgentWagers.finalize();
  getGameWagerAnalytics.finalize();
  insertLineRule.finalize();
  getLineRulesByAgent.finalize();
  getAllLineRules.finalize();
  updateLineRule.finalize();
  deleteLineRule.finalize();
  deleteRiskConfig.finalize();
  deleteRateLimitOverrideInline.finalize();
  insertSharpness.finalize();
  getSharpnessByBettor.finalize();
  insertLineAdjLog.finalize();
  getLineAdjLog.finalize();
  getRecentLineAdjLog.finalize();
  db.close();
  for (const conn of readPool) {
    if (conn !== db) conn.close();
  }

  logger.info("Shutdown complete");
  process.exit(0);
}

// Global safety nets — log unhandled errors but keep proxy alive
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: reason instanceof Error ? reason.message : String(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  // Do NOT exit — proxy should stay alive and serve requests
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGUSR2", () => {
  logger.log("info", "reload", "SIGUSR2 received, reloading config");
  try {
    reloadFromEnv();
    logger.log("info", "reload", "Config reloaded via SIGUSR2", { features: CONFIG.features });
  } catch (err: unknown) {
    logger.error("reload", "SIGUSR2 reload failed", { error: err instanceof Error ? err.message : String(err) });
  }
});

// ==========================================
// 13. CONFIG HOT-RELOAD (dev only)
// ==========================================
// NOTE: File watchers disabled to prevent Bun --watch restart loops.
// Config changes require manual restart.
// if (!CONFIG.production) {
//   configWatcher = watch('.env', { persistent: false }, async (event) => {
//     if (event !== 'change') return;
//     logger.info('.env changed, reloading config');
//     try {
//       reloadFromEnv();
//       logger.info('Config reloaded', { features: CONFIG.features });
//     } catch (err: unknown) {
//       logger.error('Config reload failed', { error: err instanceof Error ? err.message : String(err) });
//     }
//   });
// }

// Load rate limit overrides and start token renewal
loadRateLimitOverrides();
scheduleExistingTokenRenewals();
logger.info(`Enhanced Proxy running at http://localhost:${CONFIG.port}`);
logger.info(`WebSocket: ws://localhost:${CONFIG.port}/ws`);
logger.info(`Features:`, { ...CONFIG.features });
logger.info(`Metrics: http://localhost:${CONFIG.port}/metrics`);
logger.info(`Prometheus: http://localhost:${CONFIG.port}/metrics/prometheus`);
logger.info(`Ready probe: http://localhost:${CONFIG.port}/ready`);
logger.info(`Dashboard: http://localhost:${CONFIG.port}/dashboard`);
logger.info(`Admin: http://localhost:${CONFIG.port}/admin`);

// HMR accept handler for fine-grained hot reload in development
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    logger.log("info", "hmr", "Module updated, hot reloaded");
  });
}
