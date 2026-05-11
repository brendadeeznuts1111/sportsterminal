/**
 * Frontend centralized logger.
 * Reduces raw console noise and makes log tagging consistent.
 */

const DEBUG = location.hostname === 'localhost' || localStorage.getItem('debug') === 'true';

export const logger = {
  debug: (tag, msg, data) => { if (DEBUG) console.debug(`[${tag}] ${msg}`, data ?? ''); },
  info: (tag, msg, data) => console.info(`[${tag}] ${msg}`, data ?? ''),
  warn: (tag, msg, data) => console.warn(`[${tag}] ${msg}`, data ?? ''),
  error: (tag, msg, data) => console.error(`[${tag}] ${msg}`, data ?? ''),
};
