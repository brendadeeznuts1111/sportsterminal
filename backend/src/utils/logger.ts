/**
 * Logger Utility
 * Small structured logger wrapper. Bun does not expose a stable logger object
 * across all supported versions, so keep this on top of console methods.
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogMeta {
  [key: string]: any;
}

function writeLog(level: LogLevel, message: string, meta?: LogMeta): void {
  if (level === 'debug' && process.env.DEBUG !== 'true') return;
  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(meta || {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Log an info message.
 */
export function logInfo(message: string, meta?: LogMeta): void {
  const logMeta: LogMeta = { ...meta };
  writeLog('info', message, logMeta);
}

/**
 * Log a warning message.
 */
export function logWarn(message: string, meta?: LogMeta): void {
  const logMeta: LogMeta = { ...meta };
  writeLog('warn', message, logMeta);
}

/**
 * Log an error message.
 */
export function logError(message: string, meta?: LogMeta): void {
  const logMeta: LogMeta = { ...meta };
  writeLog('error', message, logMeta);
}

/**
 * Log a debug message (only if DEBUG=true).
 */
export function logDebug(message: string, meta?: LogMeta): void {
  const logMeta: LogMeta = { ...meta };
  writeLog('debug', message, logMeta);
}

/**
 * Log an HTTP request.
 */
export function logRequest(
  method: string,
  path: string,
  status?: number,
  duration?: number,
  meta?: LogMeta
): void {
  const logMeta: LogMeta = {
    operation: 'http_request',
    method,
    path,
    status,
    duration,
    ...meta,
  };
  writeLog('info', 'HTTP request', logMeta);
}

/**
 * Log a database query.
 */
export function logQuery(sql: string, params?: any[]): void {
  if (process.env.DEBUG === 'true') {
    const logMeta: LogMeta = {
      operation: 'database_query',
      query: sql,
      params,
    };
    writeLog('debug', 'Database query', logMeta);
  }
}

/**
 * Log a webhook dispatch.
 */
export function logWebhook(
  platform: string,
  url: string,
  success: boolean,
  responseStatus?: number,
  meta?: LogMeta
): void {
  const logMeta: LogMeta = {
    operation: 'webhook_dispatch',
    platform,
    url,
    success,
    responseStatus,
    ...meta,
  };
  writeLog('info', 'Webhook dispatched', logMeta);
}

/**
 * Log a pattern detection.
 */
export function logPattern(
  type: string,
  severity: string,
  details?: LogMeta
): void {
  const logMeta: LogMeta = {
    operation: 'pattern_detected',
    type,
    severity,
    ...details,
  };
  writeLog('info', 'Pattern detected', logMeta);
}

/**
 * Log a scraper operation.
 */
export function logScraper(
  agentId: string,
  operation: string,
  error?: string,
  meta?: LogMeta
): void {
  const logMeta: LogMeta = {
    operation: 'scraper_operation',
    agentId,
    operation,
    error,
    ...meta,
  };
  if (error) {
    writeLog('error', 'Scraper error', logMeta);
  } else {
    writeLog('info', 'Scraper operation', logMeta);
  }
}

/**
 * Log a cache operation.
 */
export function logCache(
  operation: string,
  key: string,
  meta?: LogMeta
): void {
  const logMeta: LogMeta = {
    operation: 'cache_operation',
    operation,
    key,
    ...meta,
  };
  writeLog('debug', 'Cache operation', logMeta);
}
