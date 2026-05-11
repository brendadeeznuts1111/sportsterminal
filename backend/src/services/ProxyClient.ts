import { CONFIG } from '../../../config';
import { parseJsonOrText } from '../utils/parseJson';

export interface EnhancedProxyCredentials {
  agentID?: string;
  token?: string;
  cf_clearance?: string;
  __cf_bm?: string;
}

export interface ProxyCredentialProvider {
  getEnhancedProxyCredentials(agentId?: string): Promise<EnhancedProxyCredentials | null>;
}

export interface ProxyCallOptions {
  endpoint: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  agentId?: string;
  includeBuckeyeAuth?: boolean;
  fetchImpl?: FetchLike;
  retries?: number;
  retryBackoffMs?: number;
}

export type BunProxyOption = string | {
  url: string;
  headers?: Record<string, string>;
};

export type ProxyFetchInit = RequestInit & {
  proxy?: BunProxyOption;
};

export type FetchLike = (input: RequestInfo | URL, init?: ProxyFetchInit) => Promise<Response>;

export class ProxyClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
  }
}

export function extractBuckeyeCookies(cookieHeader?: string): Pick<EnhancedProxyCredentials, 'cf_clearance' | '__cf_bm'> {
  const raw = (cookieHeader || '').trim();
  if (!raw) return {};
  if (!raw.includes('=')) return { cf_clearance: raw };

  const cookies = new Map<string, string>();
  for (const part of raw.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (!name || valueParts.length === 0) continue;
    cookies.set(name, valueParts.join('='));
  }

  return {
    cf_clearance: cookies.get('cf_clearance'),
    __cf_bm: cookies.get('__cf_bm'),
  };
}

export function getProxyInternalBase(): string {
  const url = Bun.env.PROXY_INTERNAL_URL || CONFIG.backendUrl || 'http://localhost:3001';
  return url.replace(/\/$/, '');
}

export function getProxyInternalApiKey(): string {
  return Bun.env.PROXY_API_KEY || CONFIG.apiKey || '';
}

function getProxyFetchProxy(apiKey: string): BunProxyOption | undefined {
  const proxyUrl = Bun.env.PROXY_FETCH_PROXY_URL?.trim();
  if (!proxyUrl) return undefined;

  const proxyToken = Bun.env.PROXY_FETCH_PROXY_TOKEN?.trim() || apiKey;
  return {
    url: proxyUrl,
    headers: {
      'X-API-Key': apiKey,
      ...(proxyToken ? { 'Proxy-Authorization': `Bearer ${proxyToken}` } : {}),
    },
  };
}

function withProxyFetchHeaders(options: RequestInit, apiKey: string): ProxyFetchInit {
  const proxy = getProxyFetchProxy(apiKey);
  return proxy ? { ...options, proxy } : options;
}

async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  options: ProxyFetchInit,
  retries: number,
  backoffMs: number
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, options);
      if (res.status < 500 || attempt === retries) return res;
      lastError = new ProxyClientError(`Proxy upstream 5xx (attempt ${attempt + 1}/${retries + 1})`, res.status, null);
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function proxyCall<T>(
  credentialProvider: ProxyCredentialProvider,
  opts: ProxyCallOptions
): Promise<T> {
  const method = opts.method || 'POST';
  const fetchImpl = opts.fetchImpl || fetch;
  const retries = opts.retries ?? 2;
  const retryBackoffMs = opts.retryBackoffMs ?? 1000;
  const body = { ...(opts.body || {}) };
  const includeBuckeyeAuth = opts.includeBuckeyeAuth !== false;

  if (includeBuckeyeAuth) {
    const credentials = await credentialProvider.getEnhancedProxyCredentials(opts.agentId || stringBodyValue(body.agentID || body.customerID));
    const token = stringBodyValue(body.token) || credentials?.token || '';
    const cfClearance = stringBodyValue(body.cf_clearance || body.cfClearance) || credentials?.cf_clearance || '';
    const cfBm = stringBodyValue(body.__cf_bm || body.cf_bm || body.cfBm) || credentials?.__cf_bm || '';

    if (!token || !cfClearance) {
      throw new ProxyClientError('No Buckeye token/cf_clearance available for internal proxy call', 401, {
        endpoint: opts.endpoint,
        agentId: opts.agentId || credentials?.agentID || null,
      });
    }

    body.token = token;
    body.cf_clearance = cfClearance;
    if (cfBm) body.__cf_bm = cfBm;
  }

  const apiKey = getProxyInternalApiKey();
  const response = await fetchWithRetry(
    fetchImpl,
    `${getProxyInternalBase()}${opts.endpoint}`,
    withProxyFetchHeaders({
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'X-Admin-Key': CONFIG.adminApiKey,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    }, apiKey),
    retries,
    retryBackoffMs
  );

  const text = await response.text();
  const payload = parseProxyPayload(text);
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : response.statusText || 'Proxy error';
    throw new ProxyClientError(`Proxy ${opts.endpoint} failed: ${detail}`, response.status, payload);
  }

  return payload as T;
}

export function proxyAgentDownline<T = unknown>(provider: ProxyCredentialProvider, agentID: string): Promise<T> {
  return proxyCall<T>(provider, { endpoint: '/api/proxy/agentDownline', agentId: agentID, body: { agentID } });
}

export function proxyAgentBilling<T = unknown>(
  provider: ProxyCredentialProvider,
  agentID: string,
  week = '0'
): Promise<T> {
  return proxyCall<T>(provider, { endpoint: '/api/proxy/agentBilling', agentId: agentID, body: { agentID, week } });
}

export function proxyPending<T = unknown>(
  provider: ProxyCredentialProvider,
  filters: Record<string, unknown>
): Promise<T> {
  return proxyCall<T>(provider, {
    endpoint: '/api/proxy/pending',
    agentId: stringBodyValue(filters.agentID || filters.agentId),
    body: filters,
  });
}

export function proxyDynamicLive<T = unknown>(
  provider: ProxyCredentialProvider,
  body: Record<string, unknown> = {}
): Promise<T> {
  return proxyCall<T>(provider, {
    endpoint: '/api/proxy/dynamicLive',
    agentId: stringBodyValue(body.agentID || body.agentId),
    body,
  });
}

export function proxyPlayerInfo<T = unknown>(
  provider: ProxyCredentialProvider,
  playerID: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  return proxyCall<T>(provider, {
    endpoint: '/api/proxy/playerInfo',
    agentId: stringBodyValue(body.agentID || body.agentId),
    body: { ...body, playerID },
  });
}

export function proxyTaxonomy<T = unknown>(
  provider: ProxyCredentialProvider,
  level: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  return proxyCall<T>(provider, {
    endpoint: `/api/proxy/taxonomy/${encodeURIComponent(level)}`,
    agentId: stringBodyValue(params.agentID || params.agentId || params.customerID),
    body: params,
  });
}

export function proxyManagerCall<T = unknown>(
  provider: ProxyCredentialProvider,
  operation: string,
  agentID: string,
  extra: Record<string, unknown> = {}
): Promise<T> {
  return proxyCall<T>(provider, {
    endpoint: `/api/proxy/Manager/${encodeURIComponent(operation)}`,
    agentId: agentID,
    body: { agentID, ...extra },
  });
}

function parseProxyPayload(text: string): unknown {
  if (!text) return null;
  return parseJsonOrText(text);
}

function stringBodyValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}
