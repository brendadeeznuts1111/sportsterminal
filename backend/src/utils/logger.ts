/**
 * Logger Utility
 * Color-coded, timestamped structured logger.
 * Keeps backward-compatible function signatures (logInfo, logWarn, etc.)
 * while adding a new `logger` object with .info(), .success(), .warn(), .error(), .debug().
 * Uses Bun.color() (v1.2+) for ANSI color generation.
 */

import { color } from 'bun';

const reset = '\x1b[0m';
const dim = '\x1b[2m';

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

function formatMessage(level: string, message: string, data?: unknown): string {
  let out = `${dim}[${timestamp()}]${reset} ${level} ${message}`;
  if (data !== undefined) {
    if (typeof data === 'object' && data !== null) {
      out += ' ' + Bun.inspect(data, { colors: true });
    } else {
      out += ' ' + String(data);
    }
  }
  return out;
}

// ─── New color-coded logger object ────────────────────────────────────────

export const logger = {
  info: (msg: string, data?: unknown) =>
    console.log(formatMessage(`${color('cyan', 'ansi')}INFO ${reset} `, msg, data)),
  success: (msg: string, data?: unknown) =>
    console.log(formatMessage(`${color('green', 'ansi')}SUCCESS${reset}`, msg, data)),
  warn: (msg: string, data?: unknown) =>
    console.warn(formatMessage(`${color('yellow', 'ansi')}WARN ${reset} `, msg, data)),
  error: (msg: string, data?: unknown) =>
    console.error(formatMessage(`${color('red', 'ansi')}ERROR${reset}`, msg, data)),
  debug: (msg: string, data?: unknown) => {
    if (process.env.DEBUG === 'true')
      console.log(formatMessage(`${color('gray', 'ansi')}DEBUG${reset}`, msg, data));
  },
};

// ─── Backward-compatible function signatures ──────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogMeta {
  [key: string]: unknown;
}

function writeLog(level: LogLevel, message: string, meta?: LogMeta): void {
  if (level === 'debug' && process.env.DEBUG !== 'true') return;
  const data = meta && Object.keys(meta).length > 0 ? meta : undefined;
  switch (level) {
    case 'error':
      logger.error(message, data);
      break;
    case 'warn':
      logger.warn(message, data);
      break;
    case 'debug':
      logger.debug(message, data);
      break;
    default:
      logger.info(message, data);
  }
}

export function logInfo(message: string, meta?: LogMeta): void {
  writeLog('info', message, meta);
}

export function logWarn(message: string, meta?: LogMeta): void {
  writeLog('warn', message, meta);
}

export function logError(message: string, meta?: LogMeta): void {
  writeLog('error', message, meta);
}

export function logDebug(message: string, meta?: LogMeta): void {
  writeLog('debug', message, meta);
}

export function logRequest(
  method: string,
  path: string,
  status?: number,
  duration?: number,
  meta?: LogMeta
): void {
  const logMeta: LogMeta = {
    method,
    path,
    ...(status !== undefined ? { status } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(meta || {}),
  };
  writeLog('info', 'HTTP request', logMeta);
}

export function logQuery(sql: string, params?: unknown[]): void {
  if (process.env.DEBUG === 'true') {
    writeLog('debug', 'Database query', { query: sql, params });
  }
}

export function logWebhook(
  platform: string,
  url: string,
  success: boolean,
  responseStatus?: number,
  meta?: LogMeta
): void {
  writeLog('info', 'Webhook dispatched', {
    platform,
    url,
    success,
    ...(responseStatus !== undefined ? { responseStatus } : {}),
    ...(meta || {}),
  });
}

export function logPattern(
  type: string,
  severity: string,
  details?: LogMeta
): void {
  writeLog('info', 'Pattern detected', { type, severity, ...(details || {}) });
}

export function logScraper(
  agentId: string,
  scraperOperation: string,
  error?: string,
  meta?: LogMeta
): void {
  const logMeta: LogMeta = {
    agentId,
    scraperOperation,
    ...(error ? { error } : {}),
    ...(meta || {}),
  };
  if (error) {
    writeLog('error', 'Scraper error', logMeta);
  } else {
    writeLog('info', 'Scraper operation', logMeta);
  }
}

export function logCache(
  cacheOperation: string,
  key: string,
  meta?: LogMeta
): void {
  writeLog('debug', 'Cache operation', { cacheOperation, key, ...(meta || {}) });
}
