// scripts/preload.ts — Production Preload Hook
// Runs before EVERY bun script (test, run, build)

import { Database } from "bun:sqlite";
import { z } from "zod";

// ==========================================
// 1. BANNER
// ==========================================
console.log(`\n┌─────────────────────────────────────────┐`);
console.log(`│  Sports Terminal Preload v3.0            │`);
console.log(`│  Bun ${Bun.version} | ${new Date().toISOString()}          │`);
console.log(`└─────────────────────────────────────────┘\n`);

// ==========================================
// 2. ENV VALIDATION (Zod)
// ==========================================
const NumberEnv = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === "") return undefined;
    return Number(value);
  },
  z.number().finite()
);

const BoolEnv = z.preprocess(
  (value) => value === "true",
  z.boolean()
);

const EnvSchema = z.object({
  // Proxy
  PROXY_PORT: NumberEnv.default(3001),
  PROXY_PRODUCTION: BoolEnv.default(false),
  PROXY_API_KEY: z.string().min(8, "API key must be >= 8 chars").default("dev-key-123"),
  BUCKEYE_BASE_URL: z.string().url().default("https://fantasy402.com"),
  DB_PATH: z.string().default("buckeye_cache.sqlite"),
  ADMIN_API_KEY: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  PROXY_API_KEY_HASH: z.string().optional(),

  // Feature flags
  ENABLE_METRICS: BoolEnv.default(true),
  ENABLE_REQUEST_LOGGING: BoolEnv.default(true),
  ENABLE_RETRY: BoolEnv.optional(),
  ENABLE_AUTO_RETRY: BoolEnv.default(true),
  ENABLE_PER_CUSTOMER_RATE_LIMIT: BoolEnv.optional(),
  ENABLE_RATE_LIMITING: BoolEnv.default(false),
  ENABLE_WS_BATCHING: BoolEnv.default(true),
  ENABLE_TOKEN_MEM_CACHE: BoolEnv.default(true),
  ENABLE_MEMORY_CACHE: BoolEnv.default(true),
  ENABLE_RESPONSE_NORMALIZE: BoolEnv.default(true),
  ENABLE_REQUEST_DEDUPE: BoolEnv.default(true),
  ENABLE_IDEMPOTENCY: BoolEnv.default(false),
  ENABLE_WS_COMPRESSION: BoolEnv.default(false),
  ENABLE_RESPONSE_COMPRESSION: BoolEnv.default(false),
  ENABLE_AUTO_RENEWAL: BoolEnv.optional(),
  ENABLE_TOKEN_PRE_RENEWAL: BoolEnv.default(true),
  ENABLE_RISK_ENGINE: BoolEnv.default(true),
  ENABLE_ANALYTICS: BoolEnv.default(true),
  ENABLE_ADMIN_API: BoolEnv.default(false),
  ENABLE_STREAM_MODE: BoolEnv.default(true),
  ENABLE_TOKEN_EXPIRY_CHECK: BoolEnv.default(true),
  ENABLE_WS_VALIDATION: BoolEnv.default(true),
  ENABLE_WS_CLIENT_BATCHING: BoolEnv.default(true),
  ENABLE_JWT_AUTH: BoolEnv.default(false),
  ENABLE_OTEL: BoolEnv.default(false),
  ENABLE_DEMO_MODE: BoolEnv.optional(),
  DEMO_MODE: BoolEnv.default(false),

  // Tunables
  WS_BATCH_INTERVAL_MS: NumberEnv.default(200),
  MAX_RETRIES: NumberEnv.default(3),
  RETRY_BASE_MS: NumberEnv.default(1000),
  SAMPLE_RATE: NumberEnv.default(0.01),
  TOKEN_CACHE_TTL_MS: NumberEnv.default(5000),
  MEMORY_CACHE_TTL_MS: NumberEnv.default(2000),
  RATE_LIMIT_PER_MIN: NumberEnv.default(60),
  TOKEN_RENEWAL_INTERVAL_MS: NumberEnv.default(300000),
  TOKEN_RENEWAL_THRESHOLD_MS: NumberEnv.default(600000),
  TOKEN_MAX_RENEWAL_ATTEMPTS: NumberEnv.default(3),

  // Backend
  BACKEND_PORT: NumberEnv.default(3000),
  BACKEND_JWT_SECRET: z.string().min(16).optional(),
  ADMIN_API_TOKEN: z.string().optional(),
  PROXY_INTERNAL_URL: z.string().url().default("http://localhost:3001"),

  // Frontend
  VITE_BACKEND_URL: z.string().url().default("http://localhost:3000"),
  VITE_WS_URL: z.string().default("ws://localhost:3000"),

  // OTel
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_EXPORT_INTERVAL_MS: NumberEnv.optional(),
});

export type EnvType = z.infer<typeof EnvSchema>;
export type ParsedEnv = EnvType;

declare global {
  var __ENV: ParsedEnv;
  var __LOGGER: StructuredLogger;
}

function applyEnvAliases(source: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...source,
    ENABLE_AUTO_RETRY: source.ENABLE_AUTO_RETRY ?? source.ENABLE_RETRY,
    ENABLE_RATE_LIMITING: source.ENABLE_RATE_LIMITING ?? source.ENABLE_PER_CUSTOMER_RATE_LIMIT,
    ENABLE_TOKEN_PRE_RENEWAL: source.ENABLE_TOKEN_PRE_RENEWAL ?? source.ENABLE_AUTO_RENEWAL,
    DEMO_MODE: source.DEMO_MODE ?? source.ENABLE_DEMO_MODE,
  };
}

export function parseProxyEnv(source: Record<string, string | undefined> = Bun.env): ParsedEnv {
  try {
    return EnvSchema.parse(applyEnvAliases(source));
  } catch (err: any) {
    const messages = err instanceof z.ZodError
      ? err.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      : err?.message || String(err);
    throw new Error(`Invalid proxy environment: ${messages}`);
  }
}

let parsedEnv: ParsedEnv;
try {
  parsedEnv = parseProxyEnv(Bun.env);
  (globalThis as any).__ENV = parsedEnv;
} catch (err: any) {
  console.error("❌ Invalid proxy environment:");
  console.error(err.message);
  process.exit(1);
}

// ==========================================
// 2b. OPTIONAL PASSWORD-HASHED API KEY
// ==========================================
const hashedKey = parsedEnv.PROXY_API_KEY_HASH;
const plainKey = parsedEnv.PROXY_API_KEY;
if (hashedKey && !plainKey) {
  console.error("[preload] PROXY_API_KEY_HASH provided but no PROXY_API_KEY for verification");
  process.exit(1);
}
if (plainKey && hashedKey) {
  const valid = await Bun.password.verify(plainKey, hashedKey);
  if (!valid) {
    console.error("[preload] PROXY_API_KEY does not match PROXY_API_KEY_HASH");
    process.exit(1);
  }
}

// ==========================================
// 3. SQLITE WAL PATCH
// ==========================================
const OriginalDatabase = Database;
(globalThis as any).Database = class extends OriginalDatabase {
  constructor(filename: string, options?: any) {
    super(filename, options);
    try {
      this.run("PRAGMA journal_mode = WAL;");
      this.run("PRAGMA busy_timeout = 30000;");
      this.run("PRAGMA foreign_keys = ON;");
      this.run("PRAGMA synchronous = NORMAL;");
    } catch (e) {
      console.warn(`[preload] SQLite WAL init failed for ${filename}:`, e);
    }
  }
};

// ==========================================
// 4. FETCH TIMEOUT + RETRY PATCH
// NOTE: For a testable, non-global alternative see utils/fetchWithTimeout.ts
// ==========================================
const originalFetch = globalThis.fetch;
const fetchWithTimeout = async (input: any, init: RequestInit = {}) => {
  // Inject default timeout if none provided
  if (!init.signal && !(init as any).timeout) {
    (init as any).signal = AbortSignal.timeout(30000);
  }

  // Log in dev mode
  if (!parsedEnv.PROXY_PRODUCTION && parsedEnv.ENABLE_REQUEST_LOGGING) {
    const url = typeof input === "string" ? input : (input as Request).url;
    console.log(`[fetch] ${init.method || "GET"} ${url?.slice(0, 80)}`);
  }

  return originalFetch(input, init);
};

(globalThis as any).sportsTerminalFetch = fetchWithTimeout;
if (Bun.env.ENABLE_GLOBAL_FETCH_TIMEOUT === "true") {
  (globalThis as any).fetch = fetchWithTimeout;
}

// ==========================================
// 5. STRUCTURED LOGGER
// ==========================================
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  meta?: Record<string, any>;
}

export class StructuredLogger {
  private buffer: LogEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval>;
  private db?: Database;

  constructor() {
    // Flush to SQLite every 5 seconds
    this.flushInterval = setInterval(() => this.flush(), 5000);

    if (Bun.env.ENABLE_PRELOAD_LOG_DB === "true") {
      try {
        this.db = new Database("logs.sqlite", { create: true });
        this.db.run(`
          CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY,
            timestamp TEXT,
            level TEXT,
            source TEXT,
            message TEXT,
            meta TEXT
          )
        `);
      } catch {
        // Silent fail — console only
      }
    }
  }

  log(level: LogLevel, source: string, message: string, meta?: Record<string, any>) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      meta,
    };

    if (!parsedEnv.PROXY_PRODUCTION) {
      const color = { debug: "\x1b[36m", info: "\x1b[32m", warn: "\x1b[33m", error: "\x1b[31m" }[level] || "\x1b[0m";
      const prefix = `${color}[${level.toUpperCase().padStart(5)}] [${source.padStart(12)}]\x1b[0m ${message}`;
      if (meta) console.log(`${prefix} | %j`, meta);
      else console.log(prefix);
    } else {
      console.log(JSON.stringify(entry));
    }

    this.buffer.push(entry);
    if (this.buffer.length >= 100) this.flush();
  }

  private flush() {
    if (!this.db || this.buffer.length === 0) return;
    const stmt = this.db.prepare("INSERT INTO logs (timestamp, level, source, message, meta) VALUES (?, ?, ?, ?, ?)");
    for (const entry of this.buffer) {
      try { stmt.run(entry.timestamp, entry.level, entry.source, entry.message, JSON.stringify(entry.meta || {})); } catch {}
    }
    this.buffer = [];
  }

  dispose() {
    clearInterval(this.flushInterval);
    this.flush();
    this.db?.close();
  }
}

const logger = new StructuredLogger();
(globalThis as any).__LOGGER = logger;

// ==========================================
// 6. PERFORMANCE HOOKS
// ==========================================
if (parsedEnv.ENABLE_METRICS) {
  const startMem = process.memoryUsage();

  setInterval(() => {
    const current = process.memoryUsage();
    const delta = {
      rss: current.rss - startMem.rss,
      heapUsed: current.heapUsed - startMem.heapUsed,
      external: current.external - startMem.external,
    };

    // Only log if significant change
    if (Math.abs(delta.heapUsed) > 10 * 1024 * 1024) {
      logger.log("debug", "preload", "Memory delta", delta);
    }
  }, 30000);
}

// ==========================================
// 7. SIGNAL HANDLERS (Graceful)
// ==========================================
const shutdown = (signal: string) => {
  logger.log("info", "preload", `Received ${signal}, flushing logs...`);
  logger.dispose();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  logger.log("error", "preload", "Uncaught exception", { message: err.message, stack: err.stack });
  setTimeout(() => process.exit(1), 500);
});
process.on("unhandledRejection", (reason: any) => {
  logger.log("error", "preload", "Unhandled rejection", { reason: String(reason) });
});

// ==========================================
// 8. DEMO MODE WARNINGS
// ==========================================
if (parsedEnv.DEMO_MODE) {
  console.log("\n🎮 DEMO MODE ACTIVE — All Buckeye calls return synthetic data");
  console.log("   Mocked endpoints: accountInfo, agentDownline, agentBilling, betTicker, pending, dynamicLive, playerInfo, sportsLeagues\n");
}

// ==========================================
// 9. EXPORT FOR IMPORTERS
// ==========================================
export { parsedEnv as ENV, logger as LOGGER };

declare global {
  var __ENV: EnvType;
  var __LOGGER: StructuredLogger;
  var sportsTerminalFetch: typeof fetch;
}
