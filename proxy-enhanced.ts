// proxy-enhanced.ts — Production Buckeye PPH Proxy (Bun-native)
import { Database } from "bun:sqlite";
import { watch } from "node:fs";
import { config, reloadFromEnv } from "./config";

const CONFIG = config;

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
    response TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);

// Request counters for /metrics
let totalRequests = 0;
let errorRequests = 0;
const endpointLatencies = new Map<string, number[]>();

// Prepared statements
const insertToken = db.prepare(`INSERT INTO tokens (customerID, cf_clearance, auth_code, bearer_token, expires_at) VALUES ($customerID, $cf_clearance, $auth_code, $bearer_token, $expires_at)`);
const getLatestToken = dbRead.prepare(`SELECT * FROM tokens WHERE customerID = $customerID ORDER BY id DESC LIMIT 1`);
const getExpiringTokens = dbRead.prepare(`SELECT customerID, cf_clearance, bearer_token, expires_at FROM tokens WHERE bearer_token IS NOT NULL AND expires_at IS NOT NULL AND expires_at < $threshold ORDER BY expires_at ASC`);
const updateToken = db.prepare(`UPDATE tokens SET bearer_token = $bearer_token, expires_at = $expires_at WHERE customerID = $customerID AND id = (SELECT id FROM tokens WHERE customerID = $customerID ORDER BY id DESC LIMIT 1)`);
const insertCache = db.prepare(`INSERT INTO api_cache (endpoint, payload_hash, response_json, ttl_seconds) VALUES ($endpoint, $payload_hash, $response_json, $ttl_seconds)`);
const getCache = dbRead.prepare(`SELECT * FROM api_cache WHERE endpoint = $endpoint AND payload_hash = $payload_hash AND (unixepoch() - cached_at) < ttl_seconds ORDER BY cached_at DESC LIMIT 1`);
const logRequestStmt = db.prepare(`INSERT INTO request_log (endpoint, status, duration_ms, error) VALUES ($endpoint, $status, $duration_ms, $error)`);
const checkRateStmt = dbRead.prepare(`SELECT count, window_start FROM rate_limit WHERE key = $key`);
const upsertRateStmt = db.prepare(`INSERT INTO rate_limit (key, count, window_start) VALUES ($key, 1, $now) ON CONFLICT(key) DO UPDATE SET count = count + 1, window_start = CASE WHEN excluded.window_start > window_start THEN excluded.window_start ELSE window_start END`);
const getIdempotency = dbRead.prepare(`SELECT response FROM idempotency WHERE key = $key AND (unixepoch() - created_at) < 86400`);
const setIdempotency = db.prepare(`INSERT INTO idempotency (key, response) VALUES ($key, $response)`);
const purgeExpiredCache = db.prepare(`DELETE FROM api_cache WHERE (unixepoch() - cached_at) > ttl_seconds`);
const purgeOldIdempotency = db.prepare(`DELETE FROM idempotency WHERE (unixepoch() - created_at) > 86400`);
const countRequests = dbRead.prepare(`SELECT COUNT(*) as total FROM request_log`);
const countErrors = dbRead.prepare(`SELECT COUNT(*) as total FROM request_log WHERE error IS NOT NULL`);
const tokenCount = dbRead.prepare(`SELECT COUNT(*) as total FROM tokens WHERE bearer_token IS NOT NULL`);

// WAL checkpoint every hour
if (CONFIG.features.walCheckpoint) {
  setInterval(() => {
    try { db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  }, 3600000);
}

// Cache + idempotency purge every 6 hours
setInterval(() => {
  try {
    const r1 = purgeExpiredCache.run();
    const r2 = purgeOldIdempotency.run();
    if (r1.changes || r2.changes) {
      console.log(JSON.stringify({ level: "info", msg: "Purged stale entries", cache: r1.changes, idempotency: r2.changes, ts: new Date().toISOString() }));
    }
  } catch {}
}, 21600000);

// ==========================================
// 3. TOKEN PRE-RENEWAL
// ==========================================
async function attemptTokenRenewal(customerID: string, cfClearance: string, currentToken: string): Promise<boolean> {
  for (let attempt = 0; attempt < CONFIG.tokenRenewal.maxRenewalAttempts; attempt++) {
    try {
      const res = await buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/System/renewToken`, {
        method: "POST",
        headers: browserHeaders(currentToken, `cf_clearance=${cfClearance}`),
        body: toForm({ operation: "renewToken", agentID: customerID, agentOwner: customerID, agentSite: "1" }),
      }, 1);
      const data = await res.json() as { token?: string; code?: string; success?: boolean };
      const newToken = data.token || data.code;
      if (res.ok && newToken) {
        const newExpiry = Math.floor(Date.now() / 1000) + 7200;
        updateToken.run({ $customerID: customerID, $bearer_token: newToken, $expires_at: newExpiry });
        console.log(JSON.stringify({ level: "info", msg: "Token renewed", customerID, attempt: attempt + 1, ts: new Date().toISOString() }));
        return true;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ level: "warn", msg: "Renewal attempt failed", customerID, attempt: attempt + 1, error: msg, ts: new Date().toISOString() }));
    }
  }
  return false;
}

if (CONFIG.features.tokenPreRenewal) {
  setInterval(async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const threshold = now + Math.floor(CONFIG.tokenRenewal.renewalThresholdMs / 1000);
      const expiring = getExpiringTokens.all({ $threshold: threshold }) as Array<{ customerID: string; cf_clearance: string; bearer_token: string; expires_at: number }>;
      for (const row of expiring) {
        console.log(JSON.stringify({ level: "info", msg: "Pre-renewing token", customerID: row.customerID, expires_in: row.expires_at - now, ts: new Date().toISOString() }));
        await attemptTokenRenewal(row.customerID, row.cf_clearance, row.bearer_token);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ level: "error", msg: "Pre-renewal sweep failed", error: msg, ts: new Date().toISOString() }));
    }
  }, CONFIG.tokenRenewal.renewalIntervalMs);
}

// ==========================================
// 4. HELPERS
// ==========================================
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key, X-Stream",
};

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

function toForm(data: Record<string, unknown>): string {
  return new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)])).toString();
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) return req.json() as Promise<Record<string, unknown>>;
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text));
}

function hashPayload(payload: unknown): string {
  return Bun.hash(JSON.stringify(payload)).toString(36);
}

function json(data: unknown, status = 200, compress = false) {
  const body = JSON.stringify(data, null, 2);
  if (compress && body.length > 1024 && CONFIG.features.responseCompression) {
    const gzip = Bun.gzipSync(body);
    return new Response(gzip, {
      status,
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", ...cors },
    });
  }
  return new Response(body, { status, headers: { "Content-Type": "application/json", ...cors } });
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

function checkRateLimit(key: string, cfg = CONFIG.defaultRateLimit): boolean {
  if (!CONFIG.features.rateLimiting) return true;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / cfg.window) * cfg.window;
  const row = checkRateStmt.get({ $key: key }) as { count: number; window_start: number } | null;
  if (!row || row.window_start < windowStart) {
    upsertRateStmt.run({ $key: key, $now: windowStart });
    return true;
  }
  if (row.count >= cfg.limit) return false;
  upsertRateStmt.run({ $key: key, $now: windowStart });
  return true;
}

// ==========================================
// 5. WEBSOCKET PUB/SUB + BATCHING
// ==========================================
type Sub = { ws: WebSocket; customerID: string; token: string; cf_clearance: string; interval?: Timer };
const subscribers = new Map<string, Sub>();
let batchQueue: unknown[] = [];
let batchTimer: Timer | null = null;

function flushBatch() {
  if (batchQueue.length === 0) { batchTimer = null; return; }
  const payload = JSON.stringify({ type: "batch", count: batchQueue.length, ticks: batchQueue });
  batchQueue = [];
  batchTimer = null;
  for (const sub of subscribers.values()) {
    if (sub.ws.readyState === 1) sub.ws.send(payload);
  }
}

function enqueueTick(data: unknown) {
  if (!CONFIG.features.wsBatching) {
    const payload = JSON.stringify({ type: "tick", timestamp: Date.now(), data });
    for (const sub of subscribers.values()) {
      if (sub.ws.readyState === 1) sub.ws.send(payload);
    }
    return;
  }
  batchQueue.push(data);
  if (!batchTimer) {
    batchTimer = setTimeout(flushBatch, CONFIG.wsBatchIntervalMs);
  }
}

function startTicker(sub: Sub) {
  sub.interval = setInterval(async () => {
    try {
      const res = await buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/Manager/getBetTicker`, {
        method: "POST",
        headers: browserHeaders(sub.token, `cf_clearance=${sub.cf_clearance}`),
        body: toForm({ operation: "getBetTicker", RRO: "1" }),
      });
      const data = await res.json().catch(() => ({ error: "parse failed" }));
      enqueueTick(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sub.ws.send(JSON.stringify({ type: "error", message: msg }));
    }
  }, 3000);
}

function stopTicker(id: string) {
  const sub = subscribers.get(id);
  if (sub?.interval) clearInterval(sub.interval);
  subscribers.delete(id);
}

// ==========================================
// 6. BUN SERVER (HTTP + WEBSOCKET)
// ==========================================
const server = Bun.serve({
  port: CONFIG.port,
  hostname: "0.0.0.0",
  development: !Bun.env.PROXY_PRODUCTION,

  websocket: {
    compress: CONFIG.features.wsCompression,
    idleTimeout: 120,
    backpressureLimit: 16 * 1024 * 1024,

    open(ws) {
      if (CONFIG.features.requestLogging) console.log(JSON.stringify({ level: "info", msg: "WS open", remoteAddress: ws.remoteAddress, ts: new Date().toISOString() }));
    },

    async message(ws, message) {
      try {
        const msg = JSON.parse(message as string);
        if (msg.type === "subscribe" && msg.customerID && msg.token && msg.cf_clearance) {
          const id = ws.remoteAddress || Math.random().toString(36).slice(2);
          stopTicker(id);
          const sub: Sub = { ws: ws as unknown as WebSocket, customerID: msg.customerID, token: msg.token, cf_clearance: msg.cf_clearance };
          subscribers.set(id, sub);
          startTicker(sub);
          ws.send(JSON.stringify({ type: "subscribed", id, message: "Live ticker active" }));
        }
        if (msg.type === "unsubscribe") {
          const id = ws.remoteAddress || Math.random().toString(36).slice(2);
          stopTicker(id);
          ws.send(JSON.stringify({ type: "unsubscribed" }));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ws.send(JSON.stringify({ type: "error", message: msg }));
      }
    },

    close(ws, code, reason) {
      const id = ws.remoteAddress || Math.random().toString(36).slice(2);
      stopTicker(id);
      if (CONFIG.features.requestLogging) console.log(JSON.stringify({ level: "info", msg: "WS close", remoteAddress: ws.remoteAddress, code, ts: new Date().toISOString() }));
    },
  },

  async fetch(req, server) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const path = url.pathname;
    const acceptEncoding = req.headers.get("accept-encoding") || "";

    if (path === "/ws") {
      const ok = server.upgrade(req, { data: { url: req.url } });
      return ok ? undefined : new Response("WS upgrade failed", { status: 400 });
    }

    // ---- /FEATURES ----
    if (path === "/features") return json({ features: CONFIG.features, tunables: { wsBatchIntervalMs: CONFIG.wsBatchIntervalMs, maxRetries: CONFIG.maxRetries, retryBaseMs: CONFIG.retryBaseMs, defaultRateLimit: CONFIG.defaultRateLimit, tokenRenewal: CONFIG.tokenRenewal } });

    // ---- /METRICS (enhanced) ----
    if (path === "/metrics" && CONFIG.features.metrics) {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      let jsc: Record<string, unknown> = {};
      try { jsc = (Bun as any).jsc?.getVMStats?.() || {}; } catch {}

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

      const dbRow = countRequests.get() as { total: number } | undefined;
      const errRow = countErrors.get() as { total: number } | undefined;
      const tokRow = tokenCount.get() as { total: number } | undefined;

      return json({
        memory: { rss: Math.round(mem.rss / 1024 / 1024) + "MB", heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + "MB", heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + "MB", external: Math.round(mem.external / 1024 / 1024) + "MB" },
        cpu: { user: cpu.user, system: cpu.system },
        jsc,
        uptime: Math.round(process.uptime()) + "s",
        requests: { total: totalRequests, errors: errorRequests },
        dbLog: { total: dbRow?.total ?? 0, errors: errRow?.total ?? 0 },
        tokens: { active: tokRow?.total ?? 0 },
        subscribers: subscribers.size,
        latency: avgLatencies,
        dbSize: (await Bun.file(CONFIG.dbPath).stat())?.size || 0,
        features: CONFIG.features,
      });
    }

    // ---- /READY (k8s probe) ----
    if (path === "/ready") {
      try {
        const latest = getLatestToken.get({ $customerID: "BILLY666" }) as { expires_at: number; bearer_token: string | null } | null;
        const ready = !!latest && !!latest.bearer_token && latest.expires_at > (Date.now() / 1000);
        return new Response(ready ? "Ready" : "Not ready", { status: ready ? 200 : 503, headers: cors });
      } catch {
        return new Response("Not ready", { status: 503, headers: cors });
      }
    }

    // ---- /CONFIG (runtime config hot-reload) ----
    if (path === "/config" && req.method === "POST") {
      const updated = reloadFromEnv();
      return json({ reloaded: true, features: updated.features, tunables: { wsBatchIntervalMs: updated.wsBatchIntervalMs, maxRetries: updated.maxRetries, retryBaseMs: updated.retryBaseMs } });
    }

    // ---- / (root) ----
    if (path === "/") {
      return json({
        service: "Buckeye PPH Proxy",
        version: "2.0",
        runtime: "Bun",
        sqlite: "bun:sqlite (WAL)",
        websocket: "/ws",
        endpoints: ["/", "/features", "/metrics", "/ready", "/config", "/ws", "/api/proxy/auth", "/api/proxy/:endpoint", "/api/proxy/tokens", "/api/proxy/logs", "/api/proxy/health"],
        subscribers: subscribers.size,
        features: CONFIG.features,
      });
    }

    // ---- /api/proxy/auth ----
    if (path === "/api/proxy/auth" && req.method === "POST") {
      const body = await readBody(req);
      const { customerID, password, cf_clearance } = body;
      if (!cf_clearance) return json({ error: "cf_clearance required" }, 400);

      const start = performance.now();
      const form = toForm({
        customerID, password, state: "true", multiaccount: "1",
        response_type: "code", client_id: customerID,
        domain: "fantasy402.com", redirect_uri: "fantasy402.com",
        operation: "authenticateCustomer", RRO: "1",
      } as Record<string, unknown>);

      try {
        const upstream = await buckeyeFetch(`${CONFIG.baseUrl}${CONFIG.authEndpoint}`, {
          method: "POST",
          headers: browserHeaders("undefined"),
          body: form,
          redirect: "manual",
        }, 1);

        const duration = Math.round(performance.now() - start);
        recordLatency("auth", duration, !upstream.ok);
        if (CONFIG.features.requestLogging) logRequestStmt.run({ $endpoint: "auth", $status: upstream.status, $duration_ms: duration, $error: null });

        const location = upstream.headers.get("location");
        const authCode = location ? new URL(location, CONFIG.baseUrl).searchParams.get("code") : null;
        const bodyText = await upstream.text().catch(() => null);

        insertToken.run({
          $customerID: customerID,
          $cf_clearance: cf_clearance,
          $auth_code: authCode,
          $bearer_token: null,
          $expires_at: Math.floor(Date.now() / 1000) + 7200,
        });

        return json({ success: upstream.status === 200 || upstream.status === 302, status: upstream.status, authCode, location, body: bodyText });

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const duration = Math.round(performance.now() - start);
        recordLatency("auth", duration, true);
        if (CONFIG.features.requestLogging) logRequestStmt.run({ $endpoint: "auth", $status: 0, $duration_ms: duration, $error: msg });
        return json({ error: "Auth failed", details: msg }, 500);
      }
    }

    // ---- /api/proxy/:endpoint ----
    if (path.startsWith("/api/proxy/") && req.method === "POST") {
      const endpoint = path.replace("/api/proxy/", "");
      const body = await readBody(req);
      const { token, cf_clearance, useCache = false, stream = false, ...payload } = body;
      const idempotencyKey = CONFIG.features.idempotency ? req.headers.get("Idempotency-Key") : null;

      if (!token || !cf_clearance) return json({ error: "token and cf_clearance required" }, 400);

      if (!checkRateLimit(`ratelimit:${String(token).substring(0, 20)}:${endpoint}`)) {
        return json({ error: "Rate limit exceeded", retryAfter: CONFIG.defaultRateLimit.window }, 429);
      }

      if (idempotencyKey) {
        const cached = getIdempotency.get({ $key: idempotencyKey }) as { response: string } | null;
        if (cached) return new Response(cached.response, { status: 200, headers: { "Content-Type": "application/json", ...cors, "X-Idempotent": "true" } });
      }

      const pHash = hashPayload({ endpoint, ...payload });

      if (useCache) {
        const cached = getCache.get({ $endpoint: endpoint, $payload_hash: pHash }) as { response_json: string; cached_at: number } | null;
        if (cached) return json({ source: "sqlite_cache", cached_at: cached.cached_at, data: JSON.parse(cached.response_json) });
      }

      const start = performance.now();
      try {
        const upstream = await buckeyeFetch(`${CONFIG.baseUrl}/cloud/api/${endpoint}`, {
          method: "POST",
          headers: browserHeaders(String(token), `cf_clearance=${String(cf_clearance)}`),
          body: toForm(payload as Record<string, unknown>),
        });

        const duration = Math.round(performance.now() - start);
        recordLatency(endpoint, duration, !upstream.ok);
        if (CONFIG.features.requestLogging) logRequestStmt.run({ $endpoint: endpoint, $status: upstream.status, $duration_ms: duration, $error: null });

        if (CONFIG.features.streamMode && stream && upstream.body) {
          return new Response(upstream.body as ReadableStream, {
            status: upstream.status,
            headers: {
              "Content-Type": upstream.headers.get("content-type") || "application/json",
              "Content-Encoding": upstream.headers.get("content-encoding") || "",
              ...cors,
            },
          });
        }

        const text = await upstream.text();
        const data = JSON.parse(text);

        insertCache.run({ $endpoint: endpoint, $payload_hash: pHash, $response_json: text, $ttl_seconds: 60 });
        if (idempotencyKey) setIdempotency.run({ $key: idempotencyKey, $response: text });

        return json({ source: "live", data }, upstream.status, acceptEncoding.includes("gzip"));

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const duration = Math.round(performance.now() - start);
        recordLatency(endpoint, duration, true);
        if (CONFIG.features.requestLogging) logRequestStmt.run({ $endpoint: endpoint, $status: 0, $duration_ms: duration, $error: msg });
        return json({ error: "Proxy failed", details: msg }, 500);
      }
    }

    // ---- /api/proxy/tokens ----
    if (path === "/api/proxy/tokens" && req.method === "GET") {
      const customerID = url.searchParams.get("customerID");
      if (!customerID) return json({ error: "customerID required" }, 400);
      const token = getLatestToken.get({ $customerID: customerID }) as { expires_at: number; auth_code: string | null; bearer_token: string | null } | null;
      if (!token) return json({ found: false }, 404);
      const now = Math.floor(Date.now() / 1000);
      return json({ found: true, expired: token.expires_at < now, expires_in: token.expires_at - now, has_auth_code: !!token.auth_code, has_bearer: !!token.bearer_token });
    }

    // ---- /api/proxy/logs ----
    if (path === "/api/proxy/logs" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const logs = dbRead.query(`SELECT * FROM request_log ORDER BY logged_at DESC LIMIT $limit`).all({ $limit: limit });
      return json({ count: logs.length, logs });
    }

    // ---- /api/proxy/health ----
    if (path === "/api/proxy/health") {
      const cf_clearance = url.searchParams.get("cf_clearance");
      if (!cf_clearance) return json({ error: "cf_clearance required" }, 400);
      try {
        const test = await fetch(`${CONFIG.baseUrl}/`, { headers: { "Cookie": `cf_clearance=${cf_clearance}`, "User-Agent": browserHeaders()["User-Agent"] } });
        const dbOk = db.query("SELECT 1").get() !== undefined;
        const status = test.ok && dbOk ? "healthy" : "degraded";
        return json({ status, buckeye: test.ok, database: dbOk, uptime: Math.round(process.uptime()) + "s" }, status === "healthy" ? 200 : 503);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ status: "degraded", buckeye: false, database: true, error: msg }, 503);
      }
    }

    return json({ error: "Not found" }, 404);
  },
});

// ==========================================
// 7. GRACEFUL SHUTDOWN
// ==========================================
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", msg: `${signal} received, draining connections`, subscribers: subscribers.size, ts: new Date().toISOString() }));

  for (const [, sub] of subscribers) {
    try { sub.ws.send(JSON.stringify({ type: "shutdown", reason: "server restart", delayMs: 5000 })); } catch {}
  }

  await new Promise(r => setTimeout(r, 5000));

  for (const [id, sub] of subscribers) {
    try { sub.ws.close(1000, "Graceful shutdown"); } catch {}
    stopTicker(id);
  }

  insertToken.finalize();
  getLatestToken.finalize();
  insertCache.finalize();
  getCache.finalize();
  logRequestStmt.finalize();
  db.close();
  if (dbRead !== db) dbRead.close();

  console.log(JSON.stringify({ level: "info", msg: "Shutdown complete", ts: new Date().toISOString() }));
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ==========================================
// 8. CONFIG HOT-RELOAD (dev only)
// ==========================================
if (!Bun.env.PROXY_PRODUCTION) {
  watch(".env", { persistent: false }, async (event) => {
    if (event !== "change") return;
    console.log(JSON.stringify({ level: "info", msg: ".env changed, reloading config", ts: new Date().toISOString() }));
    try {
      reloadFromEnv();
      console.log(JSON.stringify({ level: "info", msg: "Config reloaded", features: CONFIG.features, ts: new Date().toISOString() }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ level: "error", msg: "Config reload failed", error: msg, ts: new Date().toISOString() }));
    }
  });
}

console.log(`🚀 Enhanced Proxy running at http://localhost:${CONFIG.port}`);
console.log(`📡 WebSocket: ws://localhost:${CONFIG.port}/ws`);
console.log(`🔧 Features:`, CONFIG.features);
console.log(`📊 Metrics: http://localhost:${CONFIG.port}/metrics`);
console.log(`🔍 Ready probe: http://localhost:${CONFIG.port}/ready`);