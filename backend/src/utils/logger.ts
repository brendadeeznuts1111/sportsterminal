/**
 * Logger Utility
 * Structured logging with Bun's built-in logger.
 */

import { logger as bunLogger } from 'bun';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogMeta {
  [key: string]: any;
}

/**
 * Log an info message.
 */
export function logInfo(message: string, meta?: LogMeta): void {
  const logMeta: LogMeta = { ...meta };
  bunLogger.info(message, logMeta);
}

/**
 * Log a warning message.
 */
export function logWarn(message: string, meta?: LogMeta): void {
  const logMeta: LogMeta = { ...meta };
  bunLogger.warn(message, logMeta);
}

/**
 * Log an error message.
 */
export function logError(message: string, meta?: LogMeta): void {
  const logMeta: LogMeta = { ...meta };
  bunLogger.error(message, logMeta);
}

/**
 * Log a debug message (only if DEBUG=true).
 */
export function logDebug(message: string, meta?: LogMeta): void {
  const logMeta: LogMeta = { ...meta };
  bunLogger.debug(message, logMeta);
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
  bunLogger.info('HTTP request', logMeta);
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
    bunLogger.debug('Database query', logMeta);
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
  bunLogger.info('Webhook dispatched', logMeta);
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
  bunLogger.info('Pattern detected', logMeta);
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
    bunLogger.error('Scraper error', logMeta);
  } else {
    bunLogger.info('Scraper operation', logMeta);
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
  bunLogger.debug('Cache operation', logMeta);
}
