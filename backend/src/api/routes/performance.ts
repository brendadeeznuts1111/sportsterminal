/**
 * Performance Cache Routes
 * Expose Redis-backed agent performance cache via REST API.
 */

import { corsHeaders } from '../helpers';
import type { RouterDeps } from '../router';

/**
 * Register performance cache routes.
 * Returns a Response or null if no route matched.
 */
export async function registerPerformanceRoutes(
  url: URL,
  request: Request,
  deps: RouterDeps,
  params?: Record<string, string | undefined>
): Promise<Response | null> {
  const { performanceCache } = deps;

  // GET /api/performance/:agentId
  if (request.method === 'GET' && params?.agentId && performanceCache) {
    try {
      const result = await performanceCache.get(params.agentId);
      return new Response(
        JSON.stringify({
          agentId: params.agentId,
          source: result.source,
          data: result.data,
        }),
        { status: 200, headers: corsHeaders }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Failed to fetch performance data', details: String(error) }),
        { status: 500, headers: corsHeaders }
      );
    }
  }

  // DELETE /api/performance/:agentId
  if (request.method === 'DELETE' && params?.agentId && performanceCache) {
    try {
      await performanceCache.invalidate(params.agentId);
      return new Response(
        JSON.stringify({ message: 'Cache invalidated', agentId: params.agentId }),
        { status: 200, headers: corsHeaders }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Failed to invalidate cache', details: String(error) }),
        { status: 500, headers: corsHeaders }
      );
    }
  }

  // GET /api/performance/status
  if (request.method === 'GET' && url.pathname === '/api/performance/status') {
    return new Response(
      JSON.stringify({
        cacheEnabled: performanceCache !== undefined,
        redisConnected: performanceCache?.isConnected() ?? false,
        defaultTtlMs: performanceCache?.getDefaultTtlMs(),
      }),
      { status: 200, headers: corsHeaders }
    );
  }

  return null;
}
