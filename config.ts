// config.ts — Validated Proxy Configuration
// Imports the Zod-parsed env from preload.ts and exports backward-compatible shapes.

import { ENV as initialEnv, parseProxyEnv, type ParsedEnv } from "./scripts/preload";
import { PROXY_SECRET_NAMES, extractCfClearanceValue, getManagedSecret } from "./utils/secrets";

// ==========================================
// TYPE DEFINITIONS (backward-compatible)
// ==========================================
export interface FeatureFlags {
  wsCompression: boolean;
  metrics: boolean;
  requestLogging: boolean;
  responseNormalize: boolean;
  responseCompression: boolean;
  rateLimiting: boolean;
  wsBatching: boolean;
  autoRetry: boolean;
  gracefulShutdown: boolean;
  walCheckpoint: boolean;
  tokenPreRenewal: boolean;
  idempotency: boolean;
  streamMode: boolean;
  tokenExpiryCheck: boolean;
  wsValidation: boolean;
  wsClientBatching: boolean;
  memoryCache: boolean;
  requestDedupe: boolean;
  tokenCache: boolean;
  adminApi: boolean;
  analytics: boolean;
  riskEngine: boolean;
  requestSampling: boolean;
  demoMode: boolean;
  tokenMemCache: boolean;
}

export interface RateLimitConfig {
  limit: number;
  window: number;
}

export interface TokenRenewalConfig {
  renewalIntervalMs: number;
  renewalThresholdMs: number;
  maxRenewalAttempts: number;
}

export interface OpenTelemetryConfig {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  exportIntervalMs: number;
}

export interface ProxyConfig {
  production: boolean;
  port: number;
  baseUrl: string;
  authEndpoint: string;
  dbPath: string;
  apiKey: string;
  adminApiKey: string;
  buckeyeApiKey?: string;
  customerId?: string;
  password?: string;
  agentId?: string;
  agentOwner?: string;
  kimiApiKey?: string;
  cfClearance?: string;
  backendUrl: string;
  jwtSecret: string;
  jwtAuthEnabled: boolean;
  demoMode: boolean;
  corsOrigin?: string;
  features: FeatureFlags;
  wsBatchIntervalMs: number;
  maxRetries: number;
  retryBaseMs: number;
  tokenCacheTtlMs: number;
  memoryCacheTtlMs: number;
  sampleRate: number;
  defaultRateLimit: RateLimitConfig;
  tokenRenewal: TokenRenewalConfig;
  otel: OpenTelemetryConfig;
}

// ==========================================
// BUILD CONFIG FROM PARSED ENV
// ==========================================
function buildConfig(env: ParsedEnv = parseProxyEnv(Bun.env)): ProxyConfig {
  const autoRetry = env.ENABLE_AUTO_RETRY;
  const rateLimiting = env.ENABLE_RATE_LIMITING;
  const tokenPreRenewal = env.ENABLE_TOKEN_PRE_RENEWAL;
  const demoMode = env.DEMO_MODE;

  return {
    production: env.PROXY_PRODUCTION,
    port: env.PROXY_PORT,
    baseUrl: env.BUCKEYE_BASE_URL,
    authEndpoint: "/cloud/api/System/authenticateCustomer",
    dbPath: env.DB_PATH,
    apiKey: env.PROXY_API_KEY,
    adminApiKey: env.ADMIN_API_KEY || env.PROXY_API_KEY,
    buckeyeApiKey: Bun.env.BUCKEYE_API_KEY,
    customerId: Bun.env.BUCKEYE_CUSTOMER_ID,
    password: Bun.env.BUCKEYE_PASSWORD,
    agentId: Bun.env.AGENT_ID || Bun.env.BUCKEYE_CUSTOMER_ID,
    agentOwner: Bun.env.AGENT_OWNER || Bun.env.BUCKEYE_CUSTOMER_ID,
    kimiApiKey: Bun.env.KIMI_API_KEY,
    cfClearance: extractCfClearanceValue(Bun.env.CF_CLEARANCE || Bun.env.BUCKEYE_CF_CLEARANCE || Bun.env.BUCKEYE_CF_COOKIE || ""),
    backendUrl: env.PROXY_INTERNAL_URL,
    jwtSecret: env.JWT_SECRET || env.BACKEND_JWT_SECRET || "",
    jwtAuthEnabled: env.ENABLE_JWT_AUTH,
    demoMode,
    corsOrigin: env.CORS_ORIGIN,

    features: {
      wsCompression: env.ENABLE_WS_COMPRESSION,
      metrics: env.ENABLE_METRICS,
      requestLogging: env.ENABLE_REQUEST_LOGGING,
      responseNormalize: env.ENABLE_RESPONSE_NORMALIZE,
      responseCompression: env.ENABLE_RESPONSE_COMPRESSION,
      rateLimiting,
      wsBatching: env.ENABLE_WS_BATCHING,
      autoRetry,
      gracefulShutdown: true,
      walCheckpoint: true,
      tokenPreRenewal,
      idempotency: env.ENABLE_IDEMPOTENCY,
      streamMode: env.ENABLE_STREAM_MODE,
      tokenExpiryCheck: env.ENABLE_TOKEN_EXPIRY_CHECK,
      wsValidation: env.ENABLE_WS_VALIDATION,
      wsClientBatching: env.ENABLE_WS_CLIENT_BATCHING,
      memoryCache: env.ENABLE_MEMORY_CACHE,
      requestDedupe: env.ENABLE_REQUEST_DEDUPE,
      tokenCache: env.ENABLE_TOKEN_MEM_CACHE,
      tokenMemCache: env.ENABLE_TOKEN_MEM_CACHE,
      adminApi: env.ENABLE_ADMIN_API,
      analytics: env.ENABLE_ANALYTICS,
      riskEngine: env.ENABLE_RISK_ENGINE,
      requestSampling: env.SAMPLE_RATE < 1,
      demoMode,
    },

    wsBatchIntervalMs: env.WS_BATCH_INTERVAL_MS,
    maxRetries: env.MAX_RETRIES,
    retryBaseMs: env.RETRY_BASE_MS,
    tokenCacheTtlMs: env.TOKEN_CACHE_TTL_MS,
    memoryCacheTtlMs: env.MEMORY_CACHE_TTL_MS,
    sampleRate: env.SAMPLE_RATE,
    defaultRateLimit: {
      limit: env.RATE_LIMIT_PER_MIN,
      window: 60,
    },

    tokenRenewal: {
      renewalIntervalMs: env.TOKEN_RENEWAL_INTERVAL_MS,
      renewalThresholdMs: env.TOKEN_RENEWAL_THRESHOLD_MS,
      maxRenewalAttempts: env.TOKEN_MAX_RENEWAL_ATTEMPTS,
    },

    otel: {
      enabled: env.ENABLE_OTEL,
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
      serviceName: env.OTEL_SERVICE_NAME || "buckeye-proxy",
      exportIntervalMs: env.OTEL_EXPORT_INTERVAL_MS || 10000,
    },
  };
}

// ==========================================
// EXPORTS
// ==========================================

/** Legacy `config` export — backward-compatible with proxy-enhanced.ts */
export const config: ProxyConfig = buildConfig(initialEnv);

/** Legacy reload helper */
export function reloadFromEnv(): ProxyConfig {
  const secretBacked = {
    apiKey: config.apiKey,
    adminApiKey: config.adminApiKey,
    buckeyeApiKey: config.buckeyeApiKey,
    customerId: config.customerId,
    password: config.password,
    agentId: config.agentId,
    agentOwner: config.agentOwner,
    kimiApiKey: config.kimiApiKey,
    cfClearance: config.cfClearance,
  };
  Object.assign(config, buildConfig(), secretBacked);
  return config;
}

async function loadSecret(name: string, envVars: string | string[] = []): Promise<string | undefined> {
  const secret = await getManagedSecret(name);
  if (secret) return secret;

  const keys = Array.isArray(envVars) ? envVars : [envVars];
  for (const key of keys) {
    if (key && Bun.env[key]) return Bun.env[key];
  }
  return undefined;
}

/** Load dynamic proxy secrets into the live CONFIG singleton before startup. */
export async function initConfig(): Promise<ProxyConfig> {
  const proxyAdminKey = await loadSecret(PROXY_SECRET_NAMES.proxyAdminKey, "PROXY_API_KEY");
  const buckeyeApiKey = await loadSecret(PROXY_SECRET_NAMES.buckeyeApiKey, "BUCKEYE_API_KEY");
  const customerId = await loadSecret(PROXY_SECRET_NAMES.buckeyeCustomerId, "BUCKEYE_CUSTOMER_ID");
  const password = await loadSecret(PROXY_SECRET_NAMES.password, "BUCKEYE_PASSWORD");
  const agentId = await loadSecret(PROXY_SECRET_NAMES.agentId, "AGENT_ID");
  const agentOwner = await loadSecret(PROXY_SECRET_NAMES.agentOwner, "AGENT_OWNER");
  const kimiApiKey = await loadSecret(PROXY_SECRET_NAMES.kimiApiKey, "KIMI_API_KEY");
  const cfClearance = extractCfClearanceValue(
    await loadSecret(PROXY_SECRET_NAMES.cfClearance, ["CF_CLEARANCE", "BUCKEYE_CF_CLEARANCE", "BUCKEYE_CF_COOKIE"]) || ""
  );

  Object.assign(config, {
    apiKey: proxyAdminKey || config.apiKey || "dev-key-123",
    adminApiKey: proxyAdminKey || config.adminApiKey || config.apiKey,
    buckeyeApiKey,
    customerId,
    password,
    agentId: agentId || customerId,
    agentOwner: agentOwner || customerId,
    kimiApiKey,
    cfClearance,
  });

  return config;
}

/** New unified CONFIG export — same live singleton as legacy config. */
export const CONFIG: ProxyConfig = config;

/** Type-safe feature flag helper */
export function isEnabled(flag: keyof FeatureFlags): boolean {
  return CONFIG.features[flag];
}

/** Environment-aware path resolution */
export function resolveDbPath(filename: string): string {
  return CONFIG.production
    ? `/data/${filename}`
    : `./${filename}`;
}
