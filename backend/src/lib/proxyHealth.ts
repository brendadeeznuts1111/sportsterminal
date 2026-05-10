import { getEnhancedProxyReadiness } from '../services/EnhancedProxyHealth';
import type { FetchLike } from '../services/ProxyClient';

export type EnhancedProxyHealthCompatStatus = 'ok' | 'degraded' | 'critical' | 'unknown';

export interface EnhancedProxyHealthCompatResult {
  status: EnhancedProxyHealthCompatStatus;
  ready: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  lastChecked: string;
  details: unknown;
}

export async function checkEnhancedProxyHealth(fetchImpl: FetchLike = fetch): Promise<EnhancedProxyHealthCompatResult> {
  const startedAt = performance.now();
  try {
    const health = await getEnhancedProxyReadiness(fetchImpl);
    return {
      status: health.status,
      ready: health.ready,
      statusCode: health.statusCode,
      responseTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
      lastChecked: health.checkedAt,
      details: health.details,
    };
  } catch (error) {
    return {
      status: 'unknown',
      ready: false,
      statusCode: null,
      responseTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
      lastChecked: new Date().toISOString(),
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export type ProxyHealthCompatStatus = EnhancedProxyHealthCompatStatus;
export type ProxyHealthCompatResult = EnhancedProxyHealthCompatResult;

export function checkProxyHealth(fetchImpl: FetchLike = fetch): Promise<ProxyHealthCompatResult> {
  return checkEnhancedProxyHealth(fetchImpl);
}
