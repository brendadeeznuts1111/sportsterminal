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

const CONFIG = config;
const AUTH_ENDPOINT = "/cloud/api/System/authenticateCustomer";

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

// Request counters for /metrics
let totalRequests = 0;
let errorRequests = 0;
const endpointLatencies = new Map<string, number[]>();

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
  if (CONFIG.features.requestLogging) {
    logRequestStmt.run({ $customerID: customerID || null, $req_id: ctx.reqId, $endpoint: endpoint, $status: status, $duration_ms: duration, $error: message || null });
    logger.info("Proxy request completed", { reqId: ctx.reqId, endpoint, customerID, status, durationMs: duration, error: message });
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
  const windowStart = now - windowSec;
  const [customerID, endpoint] = key.includes("::") ? key.split("::", 2) : [key, ""];
  const row = endpoint
    ? countCustomerEndpointRequests.get({ $customerID: customerID, $endpoint: endpoint, $windowStart: windowStart }) as CountRow | null
    : countCustomerRequests.get({ $customerID: customerID, $windowStart: windowStart }) as CountRow | null;
  const count = row?.count || 0;
  if (count >= limit) return { allowed: false, retryAfter: windowSec, remaining: 0 };
  return { allowed: true, remaining: Math.max(0, limit - count - 1), retryAfter: 0 };
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
type Sub = { ws: ServerWebSocket<WsData>; customerID: string; token: string; cf_clearance: string; interval?: Timer };
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
  sub.interval = setInterval(async () => {
    try {
      const res = await buckeyeCall(() => buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
        method: "POST",
        headers: browserHeaders(sub.token, `cf_clearance=${sub.cf_clearance}`),
        body: toForm({ operation: "getBetTicker", RRO: "1" }),
      }), { endpoint: "getBetTicker" });
      const data = await res.json().catch(() => ({ error: "parse failed" }));
      enqueueTick(data);
    } catch (err: unknown) {
      sub.ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
    }
  }, 5000);
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
      const parsed = JSON.parse(message as string) as JsonObject;
      const action = parsed.action as string;

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
      } else if (action === "subscribe") {
        // New-style subscribe (from enhanced)
        if (CONFIG.features.requestLogging) {
          ws.send(JSON.stringify({ type: "history", data: tickerHistory }));
        }
        const token = String(parsed.token || "");
        const cf_clearance = String(parsed.cf_clearance || "");
        const customerID = String(parsed.customerID || "");
        const id = ws.remoteAddress || Math.random().toString(36).slice(2);
        stopTicker(id);
        const sub: Sub = { ws, customerID, token, cf_clearance };
        subscribers.set(id, sub);
        startTicker(sub);
        ws.send(JSON.stringify({ type: "subscribed", id, message: "Live ticker active" }));
      } else if (parsed.type === "subscribe") {
        // Format from enhanced
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
        const sub: Sub = { ws, customerID, token, cf_clearance };
        subscribers.set(id, sub);
        startTicker(sub);
        ws.send(JSON.stringify({ type: "subscribed", id, message: "Live ticker active" }));
      }

      if (parsed.type === "unsubscribe" || action === "unsubscribe") {
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
        return new Response("Invalid WebSocket token", { status: 401 });
      }

      const ok = server.upgrade(req, { data: { url: req.url, reqId, customerID, authenticated } satisfies WsData });
      return ok ? undefined : new Response("WS upgrade failed", { status: 400 });
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
        endpoints: ["/", "/features", "/metrics", "/ready", "/health", "/config", "/ws", "/openapi.json", "/dashboard", "/api/proxy/auth", "/api/proxy/:endpoint", "/api/proxy/tokens", "/api/proxy/logs", "/api/proxy/health", "/api/proxy/status", "/api/proxy/endpoints", "/api/proxy/renewToken"],
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

    // ---- /API/PROXY/:ENDPOINT ----
    if (path.startsWith("/api/proxy/") && path !== "/api/proxy/auth" && path !== "/api/proxy/tokens" && path !== "/api/proxy/logs" && path !== "/api/proxy/health" && path !== "/api/proxy/status" && path !== "/api/proxy/endpoints" && path !== "/api/proxy/renewToken" && req.method === "POST") {
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
          const stored = getLatestTokenWrite.get({ $customerID: customerID }) as TokenRow | null;
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
          const upstream = await fetchWithFallback(CONFIG.baseUrl, endpoint, enrichedPayload, finalToken, finalCf, ctx.reqId);
          const text = await upstream.text();
          if (!upstream.ok) throw new Error(`Upstream ${upstream.status}: ${text}`);
          try { return JSON.parse(text) as unknown; } catch { return { raw: text }; }
        };

        if (useCache) {
          const result = await getCacheWithSWR(endpoint, enrichedPayload, fetchLive, ctx.reqId);
          requestFinished(ctx, endpoint, customerID, 200);
          activeRequests--;
          return respond(json({ source: result.source, stale: Boolean(result.stale), data: result.data }, 200, { "X-Request-ID": ctx.reqId }));
        }

        const data = await fetchLive();
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
        counts: ENDPOINT_COUNTS,
        test_summary: `${TEST_SUMMARY.passed}/${TEST_SUMMARY.total} passed`,
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

// Start token renewal for existing tokens
scheduleExistingTokenRenewals();

logger.info(`Enhanced Proxy running at http://localhost:${CONFIG.port}`);
logger.info(`WebSocket: ws://localhost:${CONFIG.port}/ws`);
logger.info(`Features:`, { ...CONFIG.features });
logger.info(`Metrics: http://localhost:${CONFIG.port}/metrics`);
logger.info(`Ready probe: http://localhost:${CONFIG.port}/ready`);
logger.info(`Dashboard: http://localhost:${CONFIG.port}/dashboard`);