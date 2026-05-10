import { getProxyInternalBase, getProxyInternalApiKey, type FetchLike } from './ProxyClient';

export type EnhancedProxyReadinessStatus = 'ok' | 'degraded' | 'critical';

export interface EnhancedProxyReadinessResult {
  status: EnhancedProxyReadinessStatus;
  ready: boolean;
  statusCode: number | null;
  checkedAt: string;
  details: unknown;
}

export async function getEnhancedProxyReadiness(fetchImpl: FetchLike = fetch): Promise<EnhancedProxyReadinessResult> {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(`${getProxyInternalBase()}/ready`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-API-Key': getProxyInternalApiKey(),
      },
      signal: AbortSignal.timeout(3000),
    });
    const details = await parseEnhancedProxyReadyBody(response);

    if (response.ok) {
      return { status: 'ok', ready: true, statusCode: response.status, checkedAt, details };
    }

    return {
      status: response.status === 503 ? 'degraded' : 'critical',
      ready: false,
      statusCode: response.status,
      checkedAt,
      details,
    };
  } catch (error) {
    return {
      status: 'critical',
      ready: false,
      statusCode: null,
      checkedAt,
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function parseEnhancedProxyReadyBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
