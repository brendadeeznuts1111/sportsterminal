/**
 * Performance Cache Routes
 * Expose Redis-backed agent performance cache via REST API.
 */

import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import type { PerformanceCache } from '../../services/PerformanceCache';

export interface PerformanceRoutesDeps {
  scraperManager: BuckeyeScraperManager;
  performanceCache: PerformanceCache;
}

/**
 * Register performance cache routes.
 * Returns a Response or null if no route matched.
 */
export async function registerPerformanceRoutes(
  url: URL,
  request: Request,
  deps: PerformanceRoutesDeps
): Promise<Response | null> {
  const { performanceCache } = deps;

  // GET /api/performance/:agentId
  if (request.method === 'GET' && url.pathname === '/api/performance/:agentId') {
    const agentId = url.pathname.split('/').pop();
    if (!agentId) {
      return new Response(
        JSON.stringify({ error: 'Missing agentId' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    try {
      const result = await performanceCache.get(agentId);
      return new Response(
        JSON.stringify({
          agentId,
          source: result.source,
          cachedAt: result.data?.cachedAt || null,
          ttlMs: result.data?.ttlMs || null,
          data: result.data,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Failed to fetch performance data', details: String(error) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // DELETE /api/performance/:agentId
  if (request.method === 'DELETE' && url.pathname === '/api/performance/:agentId') {
    const agentId = url.pathname.split('/').pop();
    if (!agentId) {
      return new Response(
        JSON.stringify({ error: 'Missing agentId' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    try {
      // Invalidate cache by deleting the key
      await performanceCache.set(agentId, null, 0);
      return new Response(
        JSON.stringify({ message: 'Cache invalidated', agentId }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Failed to invalidate cache', details: String(error) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // GET /api/performance/status
  if (request.method === 'GET' && url.pathname === '/api/performance/status') {
    return new Response(
      JSON.stringify({
        cacheEnabled: performanceCache !== undefined,
        redisConnected: performanceCache?.connected ?? false,
        defaultTtlMs: performanceCache?.defaultTtlMs ?? 0,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return null;
}