/**
 * API Router
 * Uses UrlPatternRouter for framework-agnostic URL routing.
 * Falls through to 404 if no route matches.
 */
import { corsHeaders } from './helpers';
import { RateLimiter } from './rateLimiter';
import { registerHealthRoutes } from './routes/health';
import {
  registerWagerStatsRoutes,
  registerWagerListRoutes,
  registerWagerAlertRoutes,
  registerWagerLiveRoutes,
} from './routes/wagers';
import {
  registerAgentRoutes,
  registerAgentExposureRoutes,
  registerAgentPerformanceRoutes,
  registerAgentDownlineRoutes,
  registerAgentHierarchyRoutes,
  registerAgentBackfillRoutes,
  registerAgentAccessLogRoutes,
} from './routes/agents';
import {
  registerPlayerDetailsRoutes,
  registerPlayerWagersRoutes,
  registerPlayerPnlRoutes,
} from './routes/players';
import {
  registerRiskAlertRoutes,
  registerExposureSportsRoutes,
  registerExposureAgentsRoutes,
} from './routes/risk';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerOddsRoutes } from './routes/odds';
import { registerBuckeyeRoutes } from './routes/buckeye';
import { registerStaticRoutes } from './routes/static';
import { registerPerformanceRoutes } from './routes/performance';
import { registerAnalyticsRoutes } from './routes/analytics';
import { UrlPatternRouter, type RouteHandler } from './UrlPatternRouter';
import type { BuckeyeScraperManager } from '../scrapers/ScraperManager';
import type { OddsPoller } from '../odds/OddsPoller';
import type { BunSecretVault } from '../services/BunSecretVault';
import type { PerformanceCache } from '../services/PerformanceCache';
import { wrapRouterWithLogging } from './middleware/apiLogger';
import { routeCatalog, splitRouteKey, type RouteKey } from '../../../shared/http.ts';

export interface RouterDeps {
  scraperManager: BuckeyeScraperManager;
  oddsPoller: OddsPoller;
  secretVault?: BunSecretVault;
  performanceCache?: PerformanceCache;
}

function mount(router: UrlPatternRouter, key: RouteKey, handler: RouteHandler): void {
  const { method, path } = splitRouteKey(key);
  if (method === 'GET') router.get(path, handler);
  else if (method === 'POST') router.post(path, handler);
  else if (method === 'PUT') router.put(path, handler);
  else if (method === 'DELETE') router.delete(path, handler);
  else if (method === 'OPTIONS') router.options(path, handler);
  else if (method === 'ALL') router.all(path, handler);
  else throw new Error(`Unknown route method for ${key}`);
}

/**
 * Create and configure the URLPattern router with all registered routes.
 */
export function createRouter(deps: RouterDeps, _rateLimiter?: RateLimiter): UrlPatternRouter {
  const router = new UrlPatternRouter();
  const handlers: { [K in RouteKey]: RouteHandler } = {
    'OPTIONS /api/*': async () => new Response(null, { status: 204, headers: corsHeaders }),
    'GET /health': async (url, request) => registerHealthRoutes(url, request, deps.scraperManager),
    'GET /metrics': async (url, request) => registerHealthRoutes(url, request, deps.scraperManager),
    'GET /api/stats': async (url, request) => registerWagerStatsRoutes(url, request, deps.scraperManager),
    'GET /api/wagers': async (url, request) => registerWagerListRoutes(url, request, deps.scraperManager),
    'GET /api/wagers/alerts': async (url, request) => registerWagerAlertRoutes(url, request, deps.scraperManager),
    'GET /api/wagers/live': async (url, request) => registerWagerLiveRoutes(url, request, deps.scraperManager),
    'GET /api/agents': async (url, request) => registerAgentRoutes(url, request, deps.scraperManager),
    'GET /api/agents/downline': async (url, request) => registerAgentDownlineRoutes(url, request, deps.scraperManager),
    'GET /api/agents/hierarchy': async (url, request) => registerAgentHierarchyRoutes(url, request, deps.scraperManager),
    'POST /api/agents/backfill/hierarchy': async (url, request) => registerAgentBackfillRoutes(url, request, deps.scraperManager),
    'GET /api/agents/access-logs': async (url, request) => registerAgentAccessLogRoutes(url, request, deps.scraperManager),
    'GET /api/agents/:agentId/performance': async (url, request) => registerAgentPerformanceRoutes(url, request, deps.scraperManager),
    'GET /api/agents/:agentId/exposure': async (url, request) => registerAgentExposureRoutes(url, request, deps.scraperManager),
    'GET /api/players/:playerId/details': async (url, request) => registerPlayerDetailsRoutes(url, request, deps.scraperManager),
    'GET /api/players/:playerId/wagers': async (url, request) => registerPlayerWagersRoutes(url, request, deps.scraperManager),
    'GET /api/players/:playerId/pnl': async (url, request) => registerPlayerPnlRoutes(url, request, deps.scraperManager),
    'GET /api/risk/alerts': async (url, request) => registerRiskAlertRoutes(url, request, deps.scraperManager),
    'GET /api/exposure/sports': async (url, request) => registerExposureSportsRoutes(url, request, deps.scraperManager),
    'GET /api/exposure/agents': async (url, request) => registerExposureAgentsRoutes(url, request, deps.scraperManager),
    'GET /api/webhooks': async (url, request) => registerWebhookRoutes(url, request, deps.scraperManager),
    'POST /api/webhooks': async (url, request) => registerWebhookRoutes(url, request, deps.scraperManager),
    'GET /api/webhooks/:webhookId': async (url, request) => registerWebhookRoutes(url, request, deps.scraperManager),
    'PUT /api/webhooks/:webhookId': async (url, request) => registerWebhookRoutes(url, request, deps.scraperManager),
    'DELETE /api/webhooks/:webhookId': async (url, request) => registerWebhookRoutes(url, request, deps.scraperManager),
    'GET /api/webhooks/:webhookId/deliveries': async (url, request) => registerWebhookRoutes(url, request, deps.scraperManager),
    'GET /api/odds/live': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/odds/stream': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/odds/events': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/odds/events/:eventId': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/odds/snapshots': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/odds/movements': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/books': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/books/status': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/patterns/history': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/patterns/summary': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/patterns/agents': async (url, request) => registerOddsRoutes(url, request, deps.oddsPoller),
    'GET /api/buckeye/vault-status': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'DELETE /api/buckeye/vault-status': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'GET /api/buckeye/ui-config': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'GET /api/buckeye/account-info': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'GET /api/buckeye/weekly-figures': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'GET /api/buckeye/agent-performance/options': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'GET /api/buckeye/access-logs': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'GET /api/buckeye/agent-performance': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'GET /api/buckeye/sports-types': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'GET /api/buckeye/manager-snapshot': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'POST /api/connect': async (url, request) => registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault),
    'GET /api/performance/status': async (url, request) => registerPerformanceRoutes(url, request, deps),
    'GET /api/betting/velocity': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/betting/live-vs-pre': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/logs/access': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/master/history': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/performance/summary': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/performance/details': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/export/wagers': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/export/access-logs': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/export/performance': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/analytics/raw-logs': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/analytics/weekly-figures': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/analytics/master-snapshots': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/analytics/performance-trends': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/analytics/wager-velocity': async (url, request) => registerAnalyticsRoutes(url, request, deps.scraperManager),
    'GET /api/performance/:agentId': async (url, request, params) => registerPerformanceRoutes(url, request, deps, params),
    'DELETE /api/performance/:agentId': async (url, request, params) => registerPerformanceRoutes(url, request, deps, params),
    'ALL /*': async (url) => registerStaticRoutes(url),
  };

  for (const key of routeCatalog) {
    mount(router, key, handlers[key]);
  }

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

  const loggedDispatch = wrapRouterWithLogging((_url, req) => router.dispatch(req), {
    db: deps.scraperManager?.getDatabase?.(),
    enabled: true,
  });

  return loggedDispatch(url, request);
}
