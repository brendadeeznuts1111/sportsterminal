import { BUCKEYE_ARCHIVE_LIMIT } from './state.js';

const DEFAULT_TIMEOUT_MS = 30000;

export function getApiBaseUrl() {
  if (window.location.protocol === 'file:') return 'http://localhost:3000';
  return `${window.location.protocol}//${window.location.host}`;
}

/**
 * Generic fetch with timeout and consistent error logging.
 */
export async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[Frontend] Request timeout: ${url}`);
      throw new Error(`Request timeout: ${url}`);
    }
    console.error(`[Frontend] Request failed: ${url}`, err);
    throw err;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Fetch JSON with timeout and standard error handling.
 */
export async function fetchJson(path, options = {}) {
  const url = path.startsWith('http') ? path : `${getApiBaseUrl()}${path}`;
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${path}`);
  return res.json();
}

/**
 * POST JSON body and return JSON response.
 */
export async function fetchPost(path, body, options = {}) {
  return fetchJson(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(body),
    ...options,
  });
}

/**
 * DELETE request returning JSON.
 */
export async function fetchDelete(path, options = {}) {
  return fetchJson(path, { method: 'DELETE', ...options });
}

/**
 * Fetch plain text.
 */
export async function fetchText(path, options = {}) {
  const url = path.startsWith('http') ? path : `${getApiBaseUrl()}${path}`;
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${path}`);
  return res.text();
}

/**
 * Fetch binary blob.
 */
export async function fetchBlob(path, options = {}) {
  const url = path.startsWith('http') ? path : `${getApiBaseUrl()}${path}`;
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${path}`);
  return res.blob();
}

/**
 * Fire multiple fetches in parallel; each is individually timed out.
 * Returns array of results in order. If any fails, the error is logged
 * and re-thrown so the caller can handle it.
 */
export async function fetchAll(items) {
  return Promise.all(
    items.map(({ path, options }) => fetchJson(path, options))
  );
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
