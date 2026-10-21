// @ts-check
import { BUCKEYE_ARCHIVE_LIMIT } from './state.js';

/** @typedef {import('../../../shared/http.ts').RouteResponse<'GET /api/wagers'>} WagerArchiveResponse */
/** @typedef {import('../../../shared/http.ts').RouteResponse<'GET /api/buckeye/vault-status'>} VaultStatusResponse */
/** @typedef {import('../../../shared/http.ts').RouteResponse<'GET /api/analytics/raw-logs'>} RawLogsResponse */

export function getApiBaseUrl() {
  if (window.location.protocol === 'file:') return 'http://localhost:3000';
  return `${window.location.protocol}//${window.location.host}`;
}

/**
 * @param {string} path
 * @param {RequestInit} [options]
 */
export async function fetchJson(path, options = {}) {
  const res = await fetch(`${getApiBaseUrl()}${path}`, options);
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${path}`);
  return res.json();
}

/** @param {number} [limit] @returns {Promise<WagerArchiveResponse>} */
export function fetchWagerArchive(limit = BUCKEYE_ARCHIVE_LIMIT) {
  return /** @type {Promise<WagerArchiveResponse>} */ (fetchJson(`/api/wagers?limit=${encodeURIComponent(limit)}`));
}

/** @returns {Promise<VaultStatusResponse>} */
export function fetchVaultStatus() {
  return /** @type {Promise<VaultStatusResponse>} */ (fetchJson('/api/buckeye/vault-status'));
}

/** @param {Record<string, string>} [params] @returns {Promise<RawLogsResponse>} */
export function fetchRawLogs(params = {}) {
  const query = new URLSearchParams(params);
  return /** @type {Promise<RawLogsResponse>} */ (fetchJson(`/api/analytics/raw-logs?${query}`));
}
