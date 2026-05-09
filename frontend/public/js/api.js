import { BUCKEYE_ARCHIVE_LIMIT } from './state.js';

export function getApiBaseUrl() {
  if (window.location.protocol === 'file:') return 'http://localhost:3000';
  return `${window.location.protocol}//${window.location.host}`;
}

export async function fetchJson(path, options = {}) {
  const res = await fetch(`${getApiBaseUrl()}${path}`, options);
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${path}`);
  return res.json();
}

export function fetchWagerArchive(limit = BUCKEYE_ARCHIVE_LIMIT) {
  return fetchJson(`/api/wagers?limit=${encodeURIComponent(limit)}`);
}

export function fetchVaultStatus() {
  return fetchJson('/api/buckeye/vault-status');
}

export function fetchRawLogs(params = {}) {
  const query = new URLSearchParams(params);
  return fetchJson(`/api/analytics/raw-logs?${query}`);
}
