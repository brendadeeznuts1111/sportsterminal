// config.ts — Centralized configuration for Buckeye PPH Proxy
// All feature flags, tunables, and environment-driven settings in one place.
// Import: import { config } from "./config";

export interface FeatureFlags {
  wsCompression: boolean;
  metrics: boolean;
  requestLogging: boolean;
  responseCompression: boolean;
  rateLimiting: boolean;
  wsBatching: boolean;
  autoRetry: boolean;
  gracefulShutdown: boolean;
  walCheckpoint: boolean;
  tokenPreRenewal: boolean;
  idempotency: boolean;
  streamMode: boolean;
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
  port: number;
  baseUrl: string;
  authEndpoint: string;
  dbPath: string;
  features: FeatureFlags;
  wsBatchIntervalMs: number;
  maxRetries: number;
  retryBaseMs: number;
  defaultRateLimit: RateLimitConfig;
  tokenRenewal: TokenRenewalConfig;
  otel: OpenTelemetryConfig;
}

function envBool(key: string, defaultValue: boolean, aliases: string[] = []): boolean {
  const val = [key, ...aliases]
    .map((name) => process.env[name] ?? Bun.env[name])
    .find((value) => value !== undefined);
  if (val === undefined) return defaultValue;
  return val === "true";
}

function envInt(key: string, defaultValue: number): number {
  const val = process.env[key] ?? Bun.env[key];
  if (val === undefined) return defaultValue;
  return parseInt(val, 10);
}

function envStr(key: string, defaultValue: string): string {
  return (process.env[key] ?? Bun.env[key]) ?? defaultValue;
}

export const config: ProxyConfig = {
  port: envInt("PROXY_PORT", 3001),
  baseUrl: envStr("BUCKEYE_BASE_URL", "https://fantasy402.com"),
  authEndpoint: "/cloud/api/System/authenticateCustomer",
  dbPath: envStr("DB_PATH", "buckeye_cache.sqlite"),

  features: {
    wsCompression: envBool("ENABLE_WS_COMPRESSION", false),
    metrics: envBool("ENABLE_METRICS", true),
    requestLogging: envBool("ENABLE_REQUEST_LOGGING", true),
    responseCompression: envBool("ENABLE_RESPONSE_COMPRESSION", false),
    rateLimiting: envBool("ENABLE_RATE_LIMITING", true, ["ENABLE_PER_CUSTOMER_RATE_LIMIT"]),
    wsBatching: envBool("ENABLE_WS_BATCHING", false),
    autoRetry: envBool("ENABLE_AUTO_RETRY", true, ["ENABLE_RETRY"]),
    gracefulShutdown: true,
    walCheckpoint: true,
    tokenPreRenewal: envBool("ENABLE_TOKEN_PRE_RENEWAL", true, ["ENABLE_AUTO_RENEWAL"]),
    idempotency: envBool("ENABLE_IDEMPOTENCY", true),
    streamMode: envBool("ENABLE_STREAM_MODE", true),
  },

  wsBatchIntervalMs: envInt("WS_BATCH_INTERVAL_MS", 200),
  maxRetries: envInt("MAX_RETRIES", 3),
  retryBaseMs: envInt("RETRY_BASE_MS", 1000),
  defaultRateLimit: {
    limit: envInt("RATE_LIMIT_PER_MIN", 60),
    window: 60,
  },

  tokenRenewal: {
    renewalIntervalMs: envInt("TOKEN_RENEWAL_INTERVAL_MS", 300000),
    renewalThresholdMs: envInt("TOKEN_RENEWAL_THRESHOLD_MS", 600000),
    maxRenewalAttempts: envInt("TOKEN_MAX_RENEWAL_ATTEMPTS", 3),
  },

  otel: {
    enabled: envBool("ENABLE_OTEL", false),
    endpoint: envStr("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318/v1/traces"),
    serviceName: envStr("OTEL_SERVICE_NAME", "buckeye-proxy"),
    exportIntervalMs: envInt("OTEL_EXPORT_INTERVAL_MS", 10000),
  },
};

export function reloadFromEnv(): ProxyConfig {
  const fresh: ProxyConfig = {
    port: envInt("PROXY_PORT", config.port),
    baseUrl: envStr("BUCKEYE_BASE_URL", config.baseUrl),
    authEndpoint: config.authEndpoint,
    dbPath: config.dbPath,
    features: {
      wsCompression: envBool("ENABLE_WS_COMPRESSION", config.features.wsCompression),
      metrics: envBool("ENABLE_METRICS", config.features.metrics),
      requestLogging: envBool("ENABLE_REQUEST_LOGGING", config.features.requestLogging),
      responseCompression: envBool("ENABLE_RESPONSE_COMPRESSION", config.features.responseCompression),
      rateLimiting: envBool("ENABLE_RATE_LIMITING", config.features.rateLimiting, ["ENABLE_PER_CUSTOMER_RATE_LIMIT"]),
      wsBatching: envBool("ENABLE_WS_BATCHING", config.features.wsBatching),
      autoRetry: envBool("ENABLE_AUTO_RETRY", config.features.autoRetry, ["ENABLE_RETRY"]),
      gracefulShutdown: config.features.gracefulShutdown,
      walCheckpoint: config.features.walCheckpoint,
      tokenPreRenewal: envBool("ENABLE_TOKEN_PRE_RENEWAL", config.features.tokenPreRenewal, ["ENABLE_AUTO_RENEWAL"]),
      idempotency: envBool("ENABLE_IDEMPOTENCY", config.features.idempotency),
      streamMode: envBool("ENABLE_STREAM_MODE", config.features.streamMode),
    },
    wsBatchIntervalMs: envInt("WS_BATCH_INTERVAL_MS", config.wsBatchIntervalMs),
    maxRetries: envInt("MAX_RETRIES", config.maxRetries),
    retryBaseMs: envInt("RETRY_BASE_MS", config.retryBaseMs),
    defaultRateLimit: {
      limit: envInt("RATE_LIMIT_PER_MIN", config.defaultRateLimit.limit),
      window: 60,
    },
    tokenRenewal: {
      renewalIntervalMs: envInt("TOKEN_RENEWAL_INTERVAL_MS", config.tokenRenewal.renewalIntervalMs),
      renewalThresholdMs: envInt("TOKEN_RENEWAL_THRESHOLD_MS", config.tokenRenewal.renewalThresholdMs),
      maxRenewalAttempts: envInt("TOKEN_MAX_RENEWAL_ATTEMPTS", config.tokenRenewal.maxRenewalAttempts),
    },
    otel: {
      enabled: envBool("ENABLE_OTEL", config.otel.enabled),
      endpoint: envStr("OTEL_EXPORTER_OTLP_ENDPOINT", config.otel.endpoint),
      serviceName: envStr("OTEL_SERVICE_NAME", config.otel.serviceName),
      exportIntervalMs: envInt("OTEL_EXPORT_INTERVAL_MS", config.otel.exportIntervalMs),
    },
  };
  Object.assign(config, fresh);
  return config;
}
