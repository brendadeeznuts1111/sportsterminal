// proxy-enhanced.ts — Production Buckeye PPH Proxy (Bun-native)
// Merged features: CircuitBreaker, apiKeyAuth, SWR cache, special handlers,
// renewToken, status, endpoints, openapi.json, dashboard, request tracking,
// JWT auth, per-endpoint rate limiting, token scheduling, idempotency
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { config, reloadFromEnv } from "./config";
import { CircuitBreaker, logger, hashPayload as utilsHashPayload, fetchWithRetry as utilsFetchWithRetry, requestContext, json as utilsJson } from "./utils";
import { getAllEndpoints, ENDPOINT_COUNTS, TEST_SUMMARY } from "./endpoint-index";
import type { ServerWebSocket, WebSocketHandler } from "bun";

type JsonObject = Record<string, unknown>;

interface TokenRow extends JsonObject {
  customerID: string;
  cf_clearance: string | null;
  bearer_token: string | null;
  created_at: number;
  expires_at: number;
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
}

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

interface PerformanceReport {
  period: PerformancePeriod;
  data: PerformanceBucket[];
  totals: Omit<PerformanceBucket, "date" | "startDate" | "endDate">;
}

const CONFIG = config;
const AUTH_ENDPOINT = "/cloud/api/System/authenticateCustomer";
const TAXONOMY_MAP: Record<TaxonomyLevel, TaxonomyConfig> = {
  sports: { endpoint: "System/getSports", cacheTtl: 3600, shape: "Sport[]" },
  leagues: { endpoint: "System/getLeagues", cacheTtl: 1800, shape: "League[]" },
  schedule: { endpoint: "Manager/getSchedule", cacheTtl: 300, shape: "Game[]" },
  lines: { endpoint: "Manager/getLines", cacheTtl: 60, shape: "Line[]" },
  periods: { endpoint: "Manager/getPeriods", cacheTtl: 600, shape: "Period[]" },
  gametypes: { endpoint: "System/getGameTypes", cacheTtl: 3600, shape: "GameType[]" },
};

// ==========================================
// ACTIVE REQUEST TRACKING + SHUTDOWN
// ==========================================
let shuttingDown = false;
let activeRequests = 0;

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
db.run("PRAGMA busy_timeout = 5000;");
db.run("PRAGMA foreign_keys = ON;");

const dbRead = CONFIG.dbPath === ":memory:"
  ? db
  : new Database(CONFIG.dbPath, { readonly: true });

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

// Add missing columns if upgrading from older schema
for (const column of [
  "ALTER TABLE request_log ADD COLUMN customerID TEXT",
  "ALTER TABLE request_log ADD COLUMN req_id TEXT",
]) {
  try { db.run(column); } catch { /* column exists */ }
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
const countCustomerRequests = db.prepare(`SELECT COUNT(*) AS count FROM request_log WHERE customerID = $customerID AND logged_at > $windowStart`);
const countCustomerEndpointRequests = db.prepare(`SELECT COUNT(*) AS count FROM request_log WHERE customerID = $customerID AND endpoint = $endpoint AND logged_at > $windowStart`);

const checkRateStmt = dbRead.prepare(`SELECT count, window_start FROM rate_limit WHERE key = $key`);
const upsertRateStmt = db.prepare(`INSERT INTO rate_limit (key, count, window_start) VALUES ($key, 1, $now) ON CONFLICT(key) DO UPDATE SET count = count + 1, window_start = CASE WHEN excluded.window_start > window_start THEN excluded.window_start ELSE window_start END`);

const getIdempotency = dbRead.prepare(`SELECT status, response_json, created_at FROM idempotency WHERE key = $key AND (unixepoch() - created_at) < 86400`);
const setIdempotency = db.prepare(`INSERT OR REPLACE INTO idempotency (key, endpoint, customerID, status, response_json) VALUES ($key, $endpoint, $customerID, $status, $response_json)`);

const purgeExpiredCache = db.prepare(`DELETE FROM api_cache WHERE (unixepoch() - cached_at) > ttl_seconds`);
const purgeOldIdempotency = db.prepare(`DELETE FROM idempotency WHERE (unixepoch() - created_at) > 86400`);
const tokenCount = dbRead.prepare(`SELECT COUNT(*) as total FROM tokens WHERE bearer_token IS NOT NULL`);

const getRateLimitOverrideStmt = dbRead.prepare(`SELECT endpoint, "limit", window, updated_at FROM rate_limit_overrides WHERE endpoint = $endpoint`);
const setRateLimitOverrideStmt = db.prepare(`INSERT OR REPLACE INTO rate_limit_overrides (endpoint, "limit", window, updated_at) VALUES ($endpoint, $limit, $window, unixepoch())`);
const getAllRateLimitOverridesStmt = dbRead.prepare(`SELECT endpoint, "limit", window, updated_at FROM rate_limit_overrides`);

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
  setInterval(() => { try { db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} }, 3600000);
}

setInterval(() => {
  try {
    const r1 = purgeExpiredCache.run();
    const r2 = purgeOldIdempotency.run();
    if (r1.changes || r2.changes) logger.info("Purged stale entries", { cache: r1.changes, idempotency: r2.changes });
  } catch (err: unknown) { logger.warn("Purge failed", { error: err instanceof Error ? err.message : String(err) }); }
}, 21600000);

// ==========================================
// 3. TOKEN PRE-RENEWAL + SCHEDULING
// ==========================================
const tokenRenewalTimers = new Map<string, Timer>();

async function renewTokenForCustomer(customerID: string, reqId = "token-renewal"): Promise<boolean> {
  const stored = getLatestTokenWrite.get({ $customerID: customerID }) as TokenRow | null;
  if (!stored?.bearer_token || !stored.cf_clearance) return false;

  const upstream = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/System/renewToken`, {
    method: "POST",
    headers: browserHeaders(stored.bearer_token || "", `cf_clearance=${stored.cf_clearance || ""}`),
    body: toForm({ operation: "renewToken", agentID: customerID, agentOwner: customerID, agentSite: "1" }),
  }), { reqId, endpoint: "renewToken" });

  const text = await upstream.text();
  const data = JSON.parse(text) as { token?: string; code?: string };
  const token = data.token || data.code;
  if (!upstream.ok || !token) return false;

  const expiresAt = Math.floor(Date.now() / 1000) + 7200;
  insertToken.run({ $customerID: customerID, $cf_clearance: stored.cf_clearance, $auth_code: null, $bearer_token: String(token), $expires_at: expiresAt });
  invalidateTokenCache(customerID);
  scheduleTokenRenewal(customerID, expiresAt);
  logger.info("Token pre-renewed", { reqId, customerID, expiresAt });
  return true;
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
  const rows = db.query("SELECT customerID, MAX(expires_at) AS expires_at FROM tokens WHERE bearer_token IS NOT NULL GROUP BY customerID").all() as Array<{ customerID: string; expires_at: number }>;
  for (const row of rows) {
    if (row.customerID && row.expires_at) scheduleTokenRenewal(row.customerID, row.expires_at);
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
  reqId = "global"
): Promise<{ data: unknown; source: string; stale?: boolean }> {
  const pHash = utilsHashPayload({ endpoint, ...payload });
  const cacheKey = { $endpoint: endpoint, $payload_hash: pHash };
  const cached = getCacheStale.get(cacheKey) as CacheRow | null;

  const now = Math.floor(Date.now() / 1000);
  const ttl = cached?.ttl_seconds || CONFIG.defaultRateLimit.window;
  const swrWindow = ttl * SWR_TTL_MULTIPLIER;

  if (cached && (now - cached.cached_at) < ttl) {
    return { data: JSON.parse(cached.response_json), source: "cache" };
  }

  if (cached && (now - cached.cached_at) < swrWindow) {
    refreshCache(endpoint, pHash, fetchFn, reqId);
    return { data: JSON.parse(cached.response_json), source: "stale_cache", stale: true };
  }

  const data = await fetchFn();
  storeCache(endpoint, pHash, data);
  return { data, source: "live" };
}

// ==========================================
// 5. HELPERS
// ==========================================
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Request-ID, X-Stream, Idempotency-Key",
};

const corsMethods = ["POST", "GET", "OPTIONS"];
const corsHeaders = ["Content-Type", "Authorization", "X-API-Key", "X-Request-ID", "X-Stream", "Idempotency-Key"];

function browserHeaders(token = "undefined", cookie = "") {
  const h: Record<string, string> = {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Origin": "https://fantasy402.com",
    "Priority": "u=1, i",
    "Referer": "https://fantasy402.com/",
    "Sec-Ch-Ua": `"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": `"Windows"`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (cookie) h["Cookie"] = cookie;
  return h;
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

function hashPayloadImpl(payload: unknown): string {
  return Bun.hash(JSON.stringify(payload)).toString(36);
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}, acceptEncoding = "") {
  const body = JSON.stringify(data, null, 2);
  const gzip = (Bun as unknown as { gzipSync?: (input: string) => Uint8Array }).gzipSync;
  if (CONFIG.features.responseCompression && gzip && acceptEncoding.includes("gzip") && body.length > 1024) {
    const compressed = gzip(body);
    const bytes = new Uint8Array(compressed.byteLength);
    bytes.set(compressed);
    return new Response(bytes.buffer as ArrayBuffer, {
      status,
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", ...cors, ...headers },
    });
  }
  return new Response(body, { status, headers: { "Content-Type": "application/json", ...cors, ...headers } });
}

function shouldLog(): boolean {
  const sampleRate = Number(process.env.LOG_SAMPLE_RATE ?? Bun.env.LOG_SAMPLE_RATE ?? "1");
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

const memCache = new Map<string, { value: unknown; expires: number }>();
const tokenMemCache = new Map<string, { token: TokenRow | null; expires: number }>();
const inflight = new Map<string, Promise<unknown>>();

function setMemCache(key: string, value: unknown, ttlMs = CONFIG.memoryCacheTtlMs): void {
  if (!CONFIG.features.memoryCache) return;
  memCache.set(key, { value, expires: Date.now() + ttlMs });
}

function getMemCache(key: string): unknown | null {
  if (!CONFIG.features.memoryCache) return null;
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    memCache.delete(key);
    return null;
  }
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

function normalizeResponse(endpoint: string, raw: unknown): unknown {
  if (endpoint.includes("getBetTicker") && typeof raw === "object" && raw !== null) {
    const obj = raw as JsonObject;
    return obj.LIST ?? obj.data ?? obj.result ?? raw;
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
  const text = await upstream.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
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
  if (!CONFIG.otel.endpoint) return null; // use jwtSecret from env if available
  const jwtSecret = process.env.JWT_SECRET || Bun.env.JWT_SECRET || "";
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
  const apiKey = process.env.PROXY_API_KEY || Bun.env.PROXY_API_KEY || "dev-key-123";
  const key = req.headers.get("X-API-Key");
  if (key !== apiKey) {
    return json({ error: "Invalid API key" }, 401);
  }
  return null;
}

function adminApiKeyAuth(req: Request): Response | null {
  const adminKey = process.env.ADMIN_API_KEY || Bun.env.ADMIN_API_KEY || process.env.PROXY_API_KEY || Bun.env.PROXY_API_KEY || "dev-key-123";
  const key = req.headers.get("X-Admin-Key") || req.headers.get("X-API-Key");
  if (key !== adminKey) {
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

function requestFinished(ctx: { reqId: string; start: number }, endpoint: string, customerID: string | null, status: number, error?: unknown) {
  const duration = Math.round(performance.now() - ctx.start);
  const message = error instanceof Error ? error.message : error ? String(error) : null;
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
      const res = await fetch(url, options);
      if (res.status >= 500 && i < retries - 1) throw new Error(`Server error ${res.status}`);
      return res;
    } catch (err: unknown) {
      if (i === retries - 1) throw err;
      if (!CONFIG.features.autoRetry) throw err;
      const delay = Math.min(CONFIG.retryBaseMs * Math.pow(2, i) + Math.random() * 500, 10000);
      await new Promise(r => setTimeout(r, delay));
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
  const [buckeyeOk, databaseOk] = await Promise.all([
    fetch(CONFIG.baseUrl, { method: "HEAD" }).then((res) => res.ok).catch(() => false),
    Promise.resolve().then(() => db.query("SELECT 1 AS ok").get() !== undefined).catch(() => false),
  ]);
  const status = buckeyeOk && databaseOk ? "healthy" : "degraded";
  return {
    body: {
      status,
      buckeye: buckeyeOk,
      database: databaseOk,
      circuitBreaker: circuitBreaker.getStatus(),
      activeRequests,
      shuttingDown,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    httpStatus: status === "healthy" ? 200 : 503,
  };
}

function runtimeMetrics() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  let jsc: unknown = {};
  try { jsc = (Bun as unknown as { jsc?: { getVMStats?: () => unknown } }).jsc?.getVMStats?.() || {}; } catch { jsc = {}; }

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

  return {
    memory: { rss: Math.round(memory.rss / 1024 / 1024) + "MB", heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + "MB", heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + "MB" },
    cpu: { user: cpu.user, system: cpu.system },
    jsc,
    uptime: process.uptime(),
    activeRequests,
    wsSessions: sessions.size,
    tickerHistory: tickerHistory.length,
    requests: { total: totalRequests, errors: errorRequests },
    dbLog: { total: dbRow?.count ?? 0, errors: errRow?.count ?? 0 },
    latency: avgLatencies,
    circuitBreaker: circuitBreaker.getStatus(),
  };
}

async function readiness() {
  const database = db.query("SELECT 1 AS ok").get() !== undefined;
  const token = db.query("SELECT customerID FROM tokens WHERE bearer_token IS NOT NULL AND expires_at > unixepoch() ORDER BY expires_at DESC LIMIT 1").get() as { customerID?: string } | null;
  const buckeye = await buckeyeCall(() => buckeyeFetch(CONFIG.baseUrl, { method: "HEAD" }), { endpoint: "ready" })
    .then((response) => response.ok)
    .catch(() => false);
  const ready = database && buckeye && Boolean(token?.customerID);
  return { ready, database, buckeye, hasUsableToken: Boolean(token?.customerID) };
}

function buildOpenApiSpec() {
  const all = getAllEndpoints();
  const paths: JsonObject = {
    "/": { get: { summary: "Service info", responses: { "200": { description: "Proxy service status" } } } },
    "/health": { get: { summary: "Dependency health check", responses: { "200": { description: "Healthy" }, "503": { description: "Degraded" } } } },
    "/ready": { get: { summary: "Kubernetes readiness probe", responses: { "200": { description: "Ready" }, "503": { description: "Not ready" } } } },
    "/metrics": { get: { summary: "Runtime metrics", responses: { "200": { description: "Metrics JSON" } } } },
    "/features": { get: { summary: "Feature flags", responses: { "200": { description: "Feature flag config" } } } },
    "/openapi.json": { get: { summary: "OpenAPI document", responses: { "200": { description: "OpenAPI JSON" } } } },
    "/dashboard": { get: { summary: "Live dashboard HTML", responses: { "200": { description: "HTML dashboard" } } } },
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

// ==========================================
// 10. WEBSOCKET PUB/SUB + TICKER HISTORY + BATCHING
// ==========================================
type Sub = { ws: ServerWebSocket<WsData>; customerID: string; token: string; cf_clearance: string; interval?: Timer; batchInterval?: number };
const sessions = new Map<ServerWebSocket<WsData>, { interval: Timer }>();
const subscribers = new Map<string, Sub>();
const TICKER_HISTORY_SIZE = 50;
const tickerHistory: Array<{ timestamp: number; data: unknown }> = [];
let tickBatch: unknown[] = [];
let tickBatchTimer: Timer | null = null;

function rememberTicker(data: unknown) {
  tickerHistory.push({ timestamp: Date.now(), data });
  if (tickerHistory.length > TICKER_HISTORY_SIZE) tickerHistory.shift();
}

function flushBatch() {
  if (tickBatch.length === 0) { tickBatchTimer = null; return; }
  const payload = JSON.stringify({ type: "batch", count: tickBatch.length, ticks: tickBatch });
  tickBatch = [];
  tickBatchTimer = null;
  for (const sub of subscribers.values()) {
    if (sub.ws.readyState === 1) sub.ws.send(payload);
  }
  for (const ws of sessions.keys()) ws.send(payload);
}

function enqueueTick(data: unknown) {
  rememberTicker(data);
  if (!CONFIG.features.wsBatching) {
    const tick = JSON.stringify({ type: "tick", timestamp: Date.now(), data });
    for (const sub of subscribers.values()) {
      if (sub.ws.readyState === 1) sub.ws.send(tick);
    }
    for (const ws of sessions.keys()) ws.send(tick);
    return;
  }
  tickBatch.push(data);
  if (!tickBatchTimer) {
    tickBatchTimer = setTimeout(flushBatch, CONFIG.wsBatchIntervalMs);
  }
}

function startTicker(sub: Sub) {
  const interval = sub.batchInterval || 5000;
  sub.interval = setInterval(async () => {
    try {
      // Token expiry check (Enhancement 34)
      if (CONFIG.features.tokenExpiryCheck && isTokenExpired(sub.customerID)) {
        sub.ws.send(JSON.stringify({ type: "error", message: "Token expired, re-authenticate" }));
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
      sub.ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
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
let configWatcher: ReturnType<typeof watch> | null = null;

const server = Bun.serve<WsData>({
  port: CONFIG.port,
  hostname: "0.0.0.0",
  development: !Bun.env.PROXY_PRODUCTION,

  websocket: ({
    compress: CONFIG.features.wsCompression,
    idleTimeout: 120,
    backpressureLimit: 16 * 1024 * 1024,

    open(ws: ServerWebSocket<WsData>) {
      if (CONFIG.features.requestLogging) logger.info("WebSocket client connected", { remoteAddress: ws.remoteAddress });
    },

async message(ws: ServerWebSocket<WsData>, message: string | Uint8Array) {
      let parsed: JsonObject;
      try {
        parsed = JSON.parse(message as string) as JsonObject;
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      const msgType = parsed.type as string;
      const action = parsed.action as string;

      // Ping/pong support
      if (msgType === "ping") {
        ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
        return;
      }

      // WS validation (Enhancement 43)
      if (CONFIG.features.wsValidation) {
        const validTypes = ["subscribe", "unsubscribe", "subscribe-persistent", "ping", "pong"];
        if (!validTypes.includes(msgType) && !validTypes.includes(action)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid message type" }));
          return;
        }
        if ((msgType === "subscribe" || action === "subscribe") && (!parsed.customerID || !parsed.cf_clearance)) {
          ws.send(JSON.stringify({ type: "error", message: "Missing customerID or cf_clearance" }));
          return;
        }
      }

      if (action === "subscribe-persistent") {
        // Old-style subscribe (from proxy.ts)
        if (CONFIG.features.requestLogging) {
          ws.send(JSON.stringify({ type: "history", data: tickerHistory }));
        }
        const token = String(parsed.token || "");
        const cf_clearance = String(parsed.cf_clearance || "");
        const customerID = String(parsed.customerID || "");
        if (!token || !cf_clearance) {
          ws.send(JSON.stringify({ type: "error", message: "token and cf_clearance required" }));
          return;
        }
        startTicker({ ws, customerID, token, cf_clearance });
      } else if (msgType === "subscribe" || action === "subscribe") {
        // New-style subscribe (from enhanced)
        if (CONFIG.features.requestLogging) {
          ws.send(JSON.stringify({ type: "history", data: tickerHistory }));
        }
        const token = String(parsed.token || "");
        const cf_clearance = String(parsed.cf_clearance || "");
        const customerID = String(parsed.customerID || "");
        if (!token || !cf_clearance) {
          ws.send(JSON.stringify({ type: "error", message: "token and cf_clearance required" }));
          return;
        }
        const id = ws.remoteAddress || Math.random().toString(36).slice(2);
        stopTicker(id);

        // Per-subscriber batch interval (Enhancement 30)
        const batchMs = CONFIG.features.wsClientBatching && typeof parsed.batchMs === "number" && parsed.batchMs >= 100 && parsed.batchMs <= 5000
          ? parsed.batchMs
          : CONFIG.wsBatchIntervalMs;

        const sub: Sub = { ws, customerID, token, cf_clearance, batchInterval: batchMs };
        subscribers.set(id, sub);
        startTicker(sub);
        ws.send(JSON.stringify({ type: "subscribed", id, message: `Live ticker active (batch: ${batchMs}ms)` }));
      }

      if (msgType === "unsubscribe" || action === "unsubscribe") {
        const id = ws.remoteAddress || Math.random().toString(36).slice(2);
        stopTicker(id);
        ws.send(JSON.stringify({ type: "unsubscribed" }));
      }
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
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": corsMethods.join(", "), "Access-Control-Allow-Headers": corsHeaders.join(", ") } });

    // WebSocket upgrade
    const upgradeUrl = new URL(req.url);
    if (upgradeUrl.pathname === "/ws" || req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const reqId = req.headers.get("X-Request-ID") || randomUUID();
      let customerID: string | undefined;
      let authenticated = true;

      // JWT auth for WS (if enabled via env)
      const jwtEnabled = process.env.ENABLE_JWT_AUTH === "true" || Bun.env.ENABLE_JWT_AUTH === "true";
      if (jwtEnabled) {
        const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
        const token = upgradeUrl.searchParams.get("token") || bearer || "";
        const payload = token ? await verifyJwt(token).catch(() => null) : null;
        customerID = typeof payload?.customerID === "string" ? payload.customerID : undefined;
        authenticated = Boolean(payload);
      }

      if (!authenticated && jwtEnabled) {
        return new Response(JSON.stringify({ error: 'Invalid WebSocket token' }), { status: 401, headers: { 'Content-Type': 'application/json', ...cors } });
      }

      const ok = server.upgrade(req, { data: { url: req.url, reqId, customerID, authenticated } satisfies WsData });
      return ok ? undefined : new Response(JSON.stringify({ error: 'WebSocket upgrade failed' }), { status: 400, headers: { 'Content-Type': 'application/json', ...cors } });
    }

    if (shuttingDown) return json({ error: "Server is shutting down" }, 503);

    const url = new URL(req.url);
    const path = url.pathname;
    const acceptEncoding = req.headers.get("accept-encoding") || "";
    const ctx = requestContext(req);

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
        endpoints: ["/", "/features", "/metrics", "/ready", "/health", "/config", "/ws", "/openapi.json", "/dashboard", "/api/proxy/auth", "/api/proxy/:endpoint", "/api/proxy/taxonomy/:level", "/api/proxy/tokens", "/api/proxy/logs", "/api/proxy/health", "/api/proxy/status", "/api/proxy/endpoints", "/api/proxy/renewToken", "/api/proxy/agent/heatmap", "/admin/rate-limit"],
        subscribers: subscribers.size + sessions.size,
        features: { ...CONFIG.features },
        circuitBreaker: circuitBreaker.getStatus(),
      });
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
        },
      });
    }

    // ---- /METRICS ----
    if (path === "/metrics" && CONFIG.features.metrics) {
      return json(runtimeMetrics());
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

    // ---- /OPENAPI.JSON ----
    if (path === "/openapi.json") {
      return json(buildOpenApiSpec());
    }

    // ---- /DASHBOARD ----
    if (path === "/dashboard" && req.method === "GET") {
      const apiKey = process.env.PROXY_API_KEY || Bun.env.PROXY_API_KEY || "dev-key-123";
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
      reconnectTimer = setTimeout(connect, 3000);
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
      const customerID = String(body.customerID || "");
      const password = String(body.password || "");
      const cf_clearance = String(body.cf_clearance || "");
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
          } catch {}
        }

        const expiresAt = Math.floor(Date.now() / 1000) + 7200;
        insertToken.run({
          $customerID: customerID,
          $cf_clearance: cf_clearance,
          $auth_code: authCode,
          $bearer_token: storedToken,
          $expires_at: expiresAt,
        });
        invalidateTokenCache(customerID);
        scheduleTokenRenewal(customerID, expiresAt);

        const ok = upstream.ok || upstream.status === 302;
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
        let finalCf = cf_clearance ? String(cf_clearance) : "";
        if (customerID && (!finalToken || !finalCf)) {
          const stored = getCachedToken(customerID);
          finalToken = stored?.bearer_token || "";
          finalCf = stored?.cf_clearance || "";
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

        const text = await upstream.text();
        if (!upstream.ok) {
          requestFinished(ctx, `taxonomy:${rawLevel}`, customerID, upstream.status, text);
          activeRequests--;
          return json({ error: "Taxonomy fetch failed", level: rawLevel, status: upstream.status, details: text }, upstream.status, { "X-Request-ID": ctx.reqId });
        }

        const raw = JSON.parse(text) as unknown;
        const data = normalizeTaxonomy(rawLevel, raw);
        insertCache.run({ $endpoint: taxonomy.endpoint, $payload_hash: pHash, $response_json: JSON.stringify(data), $ttl_seconds: taxonomy.cacheTtl });
        setMemCache(memKey, data, taxonomy.cacheTtl * 1000);
        requestFinished(ctx, `taxonomy:${rawLevel}`, customerID, upstream.status);
        activeRequests--;
        return json({ source: "live", level: rawLevel, shape: taxonomy.shape, data }, upstream.status, { "X-Request-ID": ctx.reqId });
      } catch (err: unknown) {
        requestFinished(ctx, `taxonomy:${rawLevel}`, customerID, 500, err);
        activeRequests--;
        return json({ error: "Taxonomy fetch failed", level: rawLevel, details: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-ID": ctx.reqId });
      }
    }

    // ---- /API/PROXY/:ENDPOINT ----
    if (path.startsWith("/api/proxy/") && path !== "/api/proxy/auth" && path !== "/api/proxy/tokens" && path !== "/api/proxy/logs" && path !== "/api/proxy/health" && path !== "/api/proxy/status" && path !== "/api/proxy/endpoints" && path !== "/api/proxy/renewToken" && !path.startsWith("/api/proxy/agent/") && req.method === "POST") {
      activeRequests++;
      const authErr = apiKeyAuth(req);
      if (authErr) { activeRequests--; return authErr; }
      const endpoint = path.replace("/api/proxy/", "");
      let customerID: string | null = null;

      try {
        const idempotencyKey = CONFIG.features.idempotency ? req.headers.get("Idempotency-Key") : null;

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
        const { token: bodyToken, cf_clearance: bodyCf, useCache = false, ...payload } = body;
        const rawCustomerID = body.customerID || body.customerID;
        customerID = rawCustomerID ? String(rawCustomerID) : null;

        if (customerID) {
          const rateResult = checkRateLimit(`${customerID}::${endpoint}`);
          if (!rateResult.allowed) {
            requestFinished(ctx, endpoint, customerID, 429, "Rate limit exceeded");
            activeRequests--;
            return respond(json({ error: "Rate limit exceeded", retryAfter: rateResult.retryAfter }, 429, { "Retry-After": String(rateResult.retryAfter), "X-Request-ID": ctx.reqId }));
          }
        }

        let finalToken = bodyToken ? String(bodyToken) : "";
        let finalCf = bodyCf ? String(bodyCf) : "";

        if (!finalToken && customerID) {
          const stored = getCachedToken(customerID);
          if (stored) {
            finalToken = stored.bearer_token || "";
            finalCf = stored.cf_clearance || "";
          }
        }

        if (!finalToken || !finalCf) {
          requestFinished(ctx, endpoint, customerID, 400, "Missing token/cf_clearance");
          activeRequests--;
          return respond(json({ error: "token/cf_clearance or customerID required" }, 400, { "X-Request-ID": ctx.reqId }));
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
            const text = await upstream.text();
            if (!upstream.ok) throw new Error(`Upstream ${upstream.status}: ${text}`);
            try { return JSON.parse(text) as unknown; } catch { return { raw: text }; }
          });
        };

        if (useCache) {
          const result = await getCacheWithSWR(endpoint, enrichedPayload, fetchLive, ctx.reqId);
          const normalizedData = normalizeResponse(endpoint, result.data);
          requestFinished(ctx, endpoint, customerID, 200);
          activeRequests--;
          return respond(json({ source: result.source, stale: Boolean(result.stale), data: normalizedData }, 200, { "X-Request-ID": ctx.reqId }));
        }

        // After SWR cache check, check memCache
        if (CONFIG.features.memoryCache) {
          const memKey = memCacheKey(endpoint, enrichedPayload);
          const cached = getMemCache(memKey);
          if (cached) {
            requestFinished(ctx, endpoint, customerID, 200);
            activeRequests--;
            return respond(json({ source: "mem_cache", data: normalizeResponse(endpoint, cached) }, 200, { "X-Request-ID": ctx.reqId }));
          }
        }

        const rawData = await fetchLive();
        const data = normalizeResponse(endpoint, rawData);

        // Store live response in memCache
        if (CONFIG.features.memoryCache) {
          const memKey = memCacheKey(endpoint, enrichedPayload);
          setMemCache(memKey, rawData, CONFIG.memoryCacheTtlMs);
        }

        requestFinished(ctx, endpoint, customerID, 200);
        activeRequests--;
        return respond(json({ source: "live", data }, 200, { "X-Request-ID": ctx.reqId }, acceptEncoding));
      } catch (err: unknown) {
        const details = err instanceof Error ? err.message : String(err);
        requestFinished(ctx, endpoint, customerID, details.includes("CIRCUIT_OPEN") ? 503 : 500, err);
        activeRequests--;
        return json({ error: "Proxy failed", details }, details.includes("CIRCUIT_OPEN") ? 503 : 500, { "X-Request-ID": ctx.reqId });
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
        return json({
          found: true,
          token: token.bearer_token ? token.bearer_token.substring(0, 40) + "..." : null,
          cf_clearance: token.cf_clearance ? token.cf_clearance.substring(0, 20) + "..." : null,
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
        return json({
          found: true,
          token: token.bearer_token ? token.bearer_token.substring(0, 40) + "..." : null,
          cf_clearance: token.cf_clearance ? token.cf_clearance.substring(0, 20) + "..." : null,
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
      const logs = dbRead.query(`SELECT * FROM request_log ORDER BY logged_at DESC LIMIT $limit`).all({ $limit: limit });
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
        const dbOk = db.query("SELECT 1").get() !== undefined;
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
      return json({
        proxy: proxyRoutes,
        buckeye: buckeyeRoutes,
        taxonomy: Object.fromEntries(Object.entries(TAXONOMY_MAP).map(([level, cfg]) => [
          `/api/proxy/taxonomy/${level}`,
          `POST - ${cfg.endpoint} -> ${cfg.shape}, cache ${cfg.cacheTtl}s`,
        ])),
        counts: ENDPOINT_COUNTS,
        test_summary: `${TEST_SUMMARY.passed}/${TEST_SUMMARY.total} passed`,
      });
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
      let finalCf = body.cf_clearance ? String(body.cf_clearance) : "";

      if (!finalToken && agentID) {
        const stored = getCachedToken(agentID);
        if (stored) {
          finalToken = stored.bearer_token || "";
          finalCf = stored.cf_clearance || "";
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

    // ---- /ADMIN/RATE-LIMIT ----
    if (path === "/admin/rate-limit" && CONFIG.features.adminApi) {
      const authErr = adminApiKeyAuth(req);
      if (authErr) return authErr;

      if (req.method === "GET") {
        const all = getAllRateLimitOverridesStmt.all() as Array<{ endpoint: string; limit: number; window: number; updated_at: number }>;
        return json({ overrides: all });
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        const endpoint = String(body.endpoint || "");
        const limit = Number(body.limit);
        const window = Number(body.window);
        if (!endpoint || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(window) || window <= 0) {
          return json({ error: "endpoint, limit, and window are required" }, 400);
        }
        setRateLimitOverrideStmt.run({ $endpoint: endpoint, $limit: limit, $window: window });
        rateLimitOverrides.set(endpoint, { limit, window });
        return json({ success: true, endpoint, limit, window });
      }

      if (req.method === "DELETE") {
        const endpoint = url.searchParams.get("endpoint");
        if (!endpoint) return json({ error: "endpoint query param required" }, 400);
        db.prepare(`DELETE FROM rate_limit_overrides WHERE endpoint = $endpoint`).run({ $endpoint: endpoint });
        rateLimitOverrides.delete(endpoint);
        return json({ success: true, deleted: endpoint });
      }

      return json({ error: "Method not allowed" }, 405);
    }

    // ---- /API/PROXY/RENEWTOKEN ----
    if (path === "/api/proxy/renewToken" && req.method === "POST") {
      activeRequests++;
      const authErr = apiKeyAuth(req);
      if (authErr) { activeRequests--; return authErr; }
      const body = await readBody(req);
      const { customerID: bodyCustID, cf_clearance: bodyCf, token: bodyToken } = body;

      let finalToken = bodyToken ? String(bodyToken) : "";
      let finalCf = bodyCf ? String(bodyCf) : "";
      const customerKey = bodyCustID ? String(bodyCustID) : "";

      if (customerKey && !finalToken) {
        const stored = getLatestTokenWrite.get({ $customerID: customerKey }) as TokenRow | null;
        if (!stored) { activeRequests--; return json({ error: "No token found for this customerID" }, 404); }
        finalToken = stored.bearer_token || "";
        finalCf = stored.cf_clearance || "";
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
          const expiresAt = Math.floor(Date.now() / 1000) + 7200;
          insertToken.run({
            $customerID: customerKey || "BILLY666",
            $cf_clearance: finalCf,
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

    activeRequests--;
    return json({ error: "Not found" }, 404);
  },
});

// ==========================================
// 12. GRACEFUL SHUTDOWN
// ==========================================
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, draining connections`, { activeRequests, subscribers: subscribers.size + sessions.size });

  // Broadcast shutdown to WS clients
  for (const [, sub] of subscribers) {
    try { sub.ws.send(JSON.stringify({ type: "shutdown", reason: "server restart", delayMs: 5000 })); } catch {}
  }
  for (const ws of sessions.keys()) {
    try { ws.send(JSON.stringify({ type: "shutdown", reason: "server restart", delayMs: 5000 })); } catch {}
  }

  await new Promise(r => setTimeout(r, 5000));

  for (const [id, sub] of subscribers) {
    try { sub.ws.close(1000, "Graceful shutdown"); } catch {}
    stopTicker(id);
  }
  for (const [ws, session] of sessions.entries()) {
    clearInterval(session.interval);
    try { ws.close(1001, "Server shutting down"); } catch {}
    sessions.delete(ws);
  }

  const deadline = Date.now() + 10000;
  while (activeRequests > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }

  // Clear renewal timers
  for (const timer of tokenRenewalTimers.values()) clearTimeout(timer);
  tokenRenewalTimers.clear();

  if (tickBatchTimer) clearTimeout(tickBatchTimer);
  if (configWatcher) { configWatcher.close(); configWatcher = null; }

  // Clear caches
  memCache.clear();
  tokenMemCache.clear();
  inflight.clear();
  rateLimitOverrides.clear();

  insertToken.finalize();
  getLatestToken.finalize();
  insertCache.finalize();
  getCache.finalize();
  logRequestStmt.finalize();
  db.close();
  if (dbRead !== db) dbRead.close();

  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// ==========================================
// 13. CONFIG HOT-RELOAD (dev only)
// ==========================================
if (!Bun.env.PROXY_PRODUCTION) {
  configWatcher = watch('.env', { persistent: false }, async (event) => {
    if (event !== 'change') return;
    logger.info('.env changed, reloading config');
    try {
      reloadFromEnv();
      logger.info('Config reloaded', { features: CONFIG.features });
    } catch (err: unknown) {
      logger.error('Config reload failed', { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// Load rate limit overrides and start token renewal
loadRateLimitOverrides();
scheduleExistingTokenRenewals();

logger.info(`Enhanced Proxy running at http://localhost:${CONFIG.port}`);
logger.info(`WebSocket: ws://localhost:${CONFIG.port}/ws`);
logger.info(`Features:`, { ...CONFIG.features });
logger.info(`Metrics: http://localhost:${CONFIG.port}/metrics`);
logger.info(`Ready probe: http://localhost:${CONFIG.port}/ready`);
logger.info(`Dashboard: http://localhost:${CONFIG.port}/dashboard`);
