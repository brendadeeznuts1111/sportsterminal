// types/env.d.ts — Global type augmentation for preload

export {};

declare global {
  var __ENV: import("../scripts/preload").EnvType;
  var __LOGGER: import("../scripts/preload").StructuredLogger;
  var sportsTerminalFetch: typeof fetch;

  interface Window {
    __ENV: typeof globalThis.__ENV;
    __LOGGER: typeof globalThis.__LOGGER;
    sportsTerminalFetch: typeof globalThis.sportsTerminalFetch;
  }
}

// Make Bun.env strongly typed
declare module "bun" {
  interface Env {
    PROXY_PORT?: string;
    PROXY_PRODUCTION?: "true" | "false";
    PROXY_API_KEY?: string;
    BUCKEYE_BASE_URL?: string;
    DB_PATH?: string;
    DEMO_MODE?: "true" | "false";
    ENABLE_METRICS?: "true" | "false";
    ENABLE_REQUEST_LOGGING?: "true" | "false";
    ENABLE_AUTO_RETRY?: "true" | "false";
    ENABLE_RATE_LIMITING?: "true" | "false";
    ENABLE_WS_BATCHING?: "true" | "false";
    ENABLE_TOKEN_MEM_CACHE?: "true" | "false";
    ENABLE_MEMORY_CACHE?: "true" | "false";
    ENABLE_RESPONSE_NORMALIZE?: "true" | "false";
    ENABLE_REQUEST_DEDUPE?: "true" | "false";
    ENABLE_IDEMPOTENCY?: "true" | "false";
    ENABLE_WS_COMPRESSION?: "true" | "false";
    ENABLE_RESPONSE_COMPRESSION?: "true" | "false";
    ENABLE_TOKEN_PRE_RENEWAL?: "true" | "false";
    ENABLE_RISK_ENGINE?: "true" | "false";
    ENABLE_ANALYTICS?: "true" | "false";
    ENABLE_ADMIN_API?: "true" | "false";
    ENABLE_STREAM_MODE?: "true" | "false";
    ENABLE_TOKEN_EXPIRY_CHECK?: "true" | "false";
    ENABLE_WS_VALIDATION?: "true" | "false";
    ENABLE_WS_CLIENT_BATCHING?: "true" | "false";
    ENABLE_OTEL?: "true" | "false";
    WS_BATCH_INTERVAL_MS?: string;
    MAX_RETRIES?: string;
    RETRY_BASE_MS?: string;
    SAMPLE_RATE?: string;
    TOKEN_CACHE_TTL_MS?: string;
    MEMORY_CACHE_TTL_MS?: string;
    RATE_LIMIT_PER_MIN?: string;
    TOKEN_RENEWAL_INTERVAL_MS?: string;
    TOKEN_RENEWAL_THRESHOLD_MS?: string;
    TOKEN_MAX_RENEWAL_ATTEMPTS?: string;
    BACKEND_PORT?: string;
    BACKEND_JWT_SECRET?: string;
    ADMIN_API_TOKEN?: string;
    PROXY_INTERNAL_URL?: string;
    VITE_BACKEND_URL?: string;
    VITE_WS_URL?: string;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string;
    OTEL_SERVICE_NAME?: string;
    OTEL_EXPORT_INTERVAL_MS?: string;
  }
}
