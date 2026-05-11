/**
 * Centralized constants for poll intervals, timeouts, and thresholds
 */

// ========== POLL & SCHEDULER INTERVALS (ms) ==========
export const POLL_INTERVALS = {
  BET_TICKER: 5000,
  ODDS: 5000,
  CONFIG_WATCH: 5000,
  GRACEFUL_SHUTDOWN: 5000,
} as const;

// ========== HTTP TIMEOUTS & RETRIES (ms) ==========
export const HTTP_TIMEOUTS = {
  DEFAULT: 30000,
  SHORT: 15000,
  LONG: 60000,
  TOKEN_CACHE: 5000,
} as const;

export const RETRY_BACKOFF = {
  BASE_MS: 100,
  MAX_MS: 10000,
  JITTER_MS: 500,
} as const;

// ========== CACHE TTLs (seconds) ==========
export const CACHE_TTL = {
  ACCOUNT_INFO: 60,
  TAXONOMY: 3600,
  LINES: 60,
  PROPS: 300,
  AGENT_DATA: 300,
  LIVE_DATA: 15,
  CONFIG: 300,
  MEMORY_CAP: 10,
} as const;

// ========== RISK & ALERT THRESHOLDS (cents) ==========
export const RISK_THRESHOLDS = {
  HIGH_ROLLER_PARLAY: 100000,
  HIGH_ROLLER_EVENT: 50000,
  HIGH_ROLLER_TEASER: 5000,
  HIGH_ROLLER_TOTAL: 5000,
  GSLIVE_ALERT: 10000,
} as const;

// ========== AUTHENTICATION & TOKENS ==========
export const AUTH_TIMEOUTS = {
  TOKEN_LIFETIME_MINUTES: 21,
  TOKEN_RENEWAL_MINUTES: 15,
  TOKEN_CACHE_DURATION_MS: 5000,
  MAX_RELOGIN_ATTEMPTS: 3,
} as const;

// ========== RATE LIMITING ==========
export const RATE_LIMIT = {
  MAX_PER_MINUTE: 30,
  WINDOW_MS: 60000,
} as const;

// ========== BATCH & BUFFER SETTINGS ==========
export const BATCH_SETTINGS = {
  WEBSOCKET_BATCH_MS_MIN: 100,
  WEBSOCKET_BATCH_MS_MAX: 5000,
  WEBSOCKET_BATCH_MS_DEFAULT: 1000,
} as const;

// ========== CHECKPOINTS & PAGINATION ==========
export const PAGINATION = {
  DEFAULT_LIMIT: 100,
  MAX_OFFSET: 100000,
  MAX_PAGE: 10000,
} as const;

// ========== DATABASE & LOCKS ==========
export const DB_SETTINGS = {
  BUSY_TIMEOUT_MS: 5000,
  WAL_CHECKPOINT_MODE: 'TRUNCATE',
  PRAGMA_OPTIMIZE_INTERVAL: 3600000,
} as const;

// ========== WEBSOCKET ==========
export const WS_TIMEOUTS = {
  PING_INTERVAL_MS: 30000,
  STALE_TIMEOUT_MS: 45000,
  IDLE_TIMEOUT_SECONDS: 30,
  BACKPRESSURE_LIMIT_BYTES: 8 * 1024 * 1024,
} as const;

// ========== PERFORMANCE CACHE ==========
export const PERFORMANCE_CACHE = {
  DEFAULT_TTL_MS: 15 * 60 * 1000, // 15 minutes
  CACHE_PREFIX: 'sportsterminal:perf:',
  PUBSUB_CHANNEL: 'sportsterminal:perf:updates',
} as const;
