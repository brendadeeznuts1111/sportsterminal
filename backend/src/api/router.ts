/**
 * API Router
 * Uses UrlPatternRouter for framework-agnostic URL routing.
 * Falls through to 404 if no route matches.
 */
import { corsHeaders } from './helpers';
import { RateLimiter } from './rateLimiter';
import { registerHealthRoutes } from './routes/health';
import { registerWagerRoutes } from './routes/wagers';
import { registerAgentRoutes } from './routes/agents';
import { registerPlayerRoutes } from './routes/players';
import { registerRiskRoutes } from './routes/risk';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerOddsRoutes } from './routes/odds';
import { registerBuckeyeRoutes } from './routes/buckeye';
import { registerStaticRoutes } from './routes/static';
import { registerPerformanceRoutes } from './routes/performance';
import { UrlPatternRouter } from './UrlPatternRouter';
import type { BuckeyeScraperManager } from '../scrapers/ScraperManager';
import type { OddsPoller } from '../odds/OddsPoller';
import type { BunSecretVault } from '../services/BunSecretVault';
import type { PerformanceCache } from '../services/PerformanceCache';

export interface RouterDeps {
  scraperManager: BuckeyeScraperManager;
  oddsPoller: OddsPoller;
  secretVault?: BunSecretVault;
  performanceCache?: PerformanceCache;
}

/**
 * Create and configure the URLPattern router with all registered routes.
 */
  const { performanceCache } = deps;
export function createRouter(deps: RouterDeps, rateLimiter?: RateLimiter): UrlPatternRouter {
  const router = new UrlPatternRouter();

  // CORS preflight handler
  router.options('/api/*', async (url, request) => {
    return new Response(null, { status: 204, headers: corsHeaders });
  });

  // Health / metrics (no auth needed)
  router.get('/health', async (url, request) => {
    return registerHealthRoutes(url, request, deps.scraperManager);
  });

  // API routes
  router.get('/api/wagers', async (url, request) => {
    return registerWagerRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/wagers/:wagerId', async (url, request) => {
    return registerWagerRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents', async (url, request) => {
    return registerAgentRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/:agentId', async (url, request) => {
    return registerAgentRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/:agentId/performance', async (url, request) => {
    return registerAgentRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/:agentId/exposure', async (url, request) => {
    return registerAgentRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/:agentId/hierarchy', async (url, request) => {
    return registerAgentRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players', async (url, request) => {
    return registerPlayerRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId', async (url, request) => {
    return registerPlayerRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/risk/alerts', async (url, request) => {
    return registerRiskRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/risk/alerts/:alertId', async (url, request) => {
    return registerRiskRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/webhooks', async (url, request) => {
    return registerWebhookRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/webhooks', async (url, request) => {
    return registerWebhookRoutes(url, request, deps.scraperManager);
  });

  router.put('/api/webhooks/:webhookId', async (url, request) => {
    return registerWebhookRoutes(url, request, deps.scraperManager);
  });

  router.delete('/api/webhooks/:webhookId', async (url, request) => {
    return registerWebhookRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/odds', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/odds/:bookId', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/buckeye/vault-status', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.delete('/api/buckeye/vault-status', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/access-logs', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/agent-performance', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/sports-types', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/manager-snapshot', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/hierarchy', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/player-details', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/exposure/sports', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/exposure/agents', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });Performance cache routes
  router.get('/api/performance/:agentId', async (url, request, params) => {
    return registerPerformanceRoutes(url, request, deps, params);
  });

  router.delete('/api/performance/:agentId', async (url, request, params) => {
    return registerPerformanceRoutes(url, request, deps, params);
  });

  router.get('/api/performance/status', async (url, request) => {
    return registerPerformanceRoutes(url, request, deps);
  });

  //

  // Static files (last resort)
  router.all('/*', async (url, request) => {
    return registerStaticRoutes(url);
  });

  return router;
}

/**
 * Route a request through the URLPattern router.
 * Returns a Response or null if no route matched.
 */
export async function routeRequest(
  url: URL,
  request: Request,
  deps: RouterDeps,
  rateLimiter?: RateLimiter
): Promise<Response | null> {
  const router = createRouter(deps, rateLimiter);

  // Rate limiting
  if (rateLimiter) {
    const ip = RateLimiter.getClientIp(request);
    const limitResult = rateLimiter.check(ip);
    if (!limitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            'Retry-After': String(limitResult.retryAfter),
          },
        }
      );
    }
  }

  return router.dispatch(request);
}
