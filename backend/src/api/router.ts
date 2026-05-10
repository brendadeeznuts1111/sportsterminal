/**
 * API Router
 * Uses UrlPatternRouter for framework-agnostic URL routing.
 * Falls through to 404 if no route matches.
 */
import { corsHeaders, requireAdminTokenIfConfigured } from './helpers';
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
  registerCachedAgentHierarchyTreeRoutes,
  registerAgentRefreshRoutes,
  registerAgentProfileRoutes,
  registerAgentPlayersRoutes,
  registerAgentBackfillRoutes,
  registerAgentAccessLogRoutes,
} from './routes/agents';
import {
  registerPlayerSearchRoutes,
  registerPlayerProfileRoutes,
  registerPlayerAgentContextRoutes,
  registerPlayerIntelligenceMapRoutes,
  registerPlayerDepositsRoutes,
  registerPlayerTransactionsRoutes,
  registerPlayerAccountSnapshotsRoutes,
  registerPlayerLinksRoutes,
  registerPlayerLinkCheckRoutes,
  registerPlayerFlagsRoutes,
  registerPlayerFlagCreateRoutes,
  registerPlayerFlagResolveRoutes,
  registerPlayerNotesRoutes,
  registerPlayerNoteCreateRoutes,
  registerPlayerExportRoutes,
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
import { registerFreePlayAnalysisRoutes } from './routes/freeplay';
import { UrlPatternRouter } from './UrlPatternRouter';
import type { BuckeyeScraperManager } from '../scrapers/ScraperManager';
import type { OddsPoller } from '../odds/OddsPoller';
import type { BunSecretVault } from '../services/BunSecretVault';
import type { PerformanceCache } from '../services/PerformanceCache';
import { wrapRouterWithLogging } from './middleware/apiLogger';

export interface RouterDeps {
  scraperManager: BuckeyeScraperManager;
  oddsPoller: OddsPoller;
  secretVault?: BunSecretVault;
  performanceCache?: PerformanceCache;
}

/**
 * Create and configure the URLPattern router with all registered routes.
 */
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

  router.get('/metrics', async (url, request) => {
    return registerHealthRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/health/system-status', async (url, request) => {
    return registerHealthRoutes(url, request, deps.scraperManager);
  });

  // API routes
  router.get('/api/stats', async (url, request) => {
    return registerWagerStatsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/wagers', async (url, request) => {
    return registerWagerListRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/wagers/alerts', async (url, request) => {
    return registerWagerAlertRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/wagers/live', async (url, request) => {
    return registerWagerLiveRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents', async (url, request) => {
    return registerAgentRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/downline', async (url, request) => {
    return registerAgentDownlineRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/hierarchy', async (url, request) => {
    return registerAgentHierarchyRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/hierarchy/tree', async (url, request) => {
    return registerCachedAgentHierarchyTreeRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/agents/refresh', async (url, request) => {
    return registerAgentRefreshRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/agents/backfill/hierarchy', async (url, request) => {
    return registerAgentBackfillRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/access-logs', async (url, request) => {
    return registerAgentAccessLogRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/:agentId/performance', async (url, request) => {
    return registerAgentPerformanceRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/:agentId/exposure', async (url, request) => {
    return registerAgentExposureRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/:agentId/players', async (url, request) => {
    return registerAgentPlayersRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agents/:agentId', async (url, request) => {
    return registerAgentProfileRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/search', async (url, request) => {
    return registerPlayerSearchRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/profile', async (url, request) => {
    return registerPlayerProfileRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/agent-context', async (url, request) => {
    return registerPlayerAgentContextRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/intelligence-map', async (url, request) => {
    return registerPlayerIntelligenceMapRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/deposits', async (url, request) => {
    return registerPlayerDepositsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/transactions', async (url, request) => {
    return registerPlayerTransactionsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/account-snapshots', async (url, request) => {
    return registerPlayerAccountSnapshotsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/links', async (url, request) => {
    return registerPlayerLinksRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/players/:playerId/links/check', async (url, request) => {
    return registerPlayerLinkCheckRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/flags', async (url, request) => {
    return registerPlayerFlagsRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/players/:playerId/flags', async (url, request) => {
    return registerPlayerFlagCreateRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/players/:playerId/flags/:flagId/resolve', async (url, request) => {
    return registerPlayerFlagResolveRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/notes', async (url, request) => {
    return registerPlayerNotesRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/players/:playerId/notes', async (url, request) => {
    return registerPlayerNoteCreateRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/export/wagers', async (url, request) => {
    return registerPlayerExportRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/export/access-logs', async (url, request) => {
    return registerPlayerExportRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/details', async (url, request) => {
    return registerPlayerDetailsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/wagers', async (url, request) => {
    return registerPlayerWagersRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/players/:playerId/pnl', async (url, request) => {
    return registerPlayerPnlRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/freeplay/analysis', async (url, request) => {
    return registerFreePlayAnalysisRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/risk/alerts', async (url, request) => {
    return registerRiskAlertRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/exposure/sports', async (url, request) => {
    return registerExposureSportsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/exposure/agents', async (url, request) => {
    return registerExposureAgentsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/webhooks', async (url, request) => {
    return registerWebhookRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/webhooks', async (url, request) => {
    return registerWebhookRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/webhooks/:webhookId', async (url, request) => {
    return registerWebhookRoutes(url, request, deps.scraperManager);
  });

  router.put('/api/webhooks/:webhookId', async (url, request) => {
    return registerWebhookRoutes(url, request, deps.scraperManager);
  });

  router.delete('/api/webhooks/:webhookId', async (url, request) => {
    return registerWebhookRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/webhooks/:webhookId/deliveries', async (url, request) => {
    return registerWebhookRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/odds/live', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/odds/events', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/odds/events/:eventId', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/odds/snapshots', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/odds/movements', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/books', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/books/status', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/patterns/history', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/patterns/summary', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/patterns/agents', async (url, request) => {
    return registerOddsRoutes(url, request, deps.oddsPoller);
  });

  router.get('/api/buckeye/vault-status', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.delete('/api/buckeye/vault-status', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/ui-config', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/account-info', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/weekly-figures', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/agent-performance/options', async (url, request) => {
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

  router.get('/api/buckeye/player-performance', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.post('/api/buckeye/player-performance', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/player-info', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.post('/api/buckeye/player-info', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/player-transactions', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.post('/api/buckeye/player-transactions', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.get('/api/buckeye/players-list', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  router.post('/api/connect', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  // Performance cache routes. Keep status before :agentId so it does not
  // get interpreted as an agent login.
  router.get('/api/performance/status', async (url, request) => {
    return registerPerformanceRoutes(url, request, deps);
  });

  // Analytics routes
  router.get('/api/betting/velocity', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/betting/live-vs-pre', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/logs/access', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/master/history', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/performance/summary', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/performance/details', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/export/wagers', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/export/access-logs', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/export/performance', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  // New analytics routes for Performance tab
  router.get('/api/analytics/raw-logs', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/analytics/weekly-figures', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/analytics/master-snapshots', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/analytics/performance-trends', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/analytics/wager-velocity', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/health/data-pipeline', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/performance/:agentId', async (url, request, params) => {
    return registerPerformanceRoutes(url, request, deps, params);
  });

  router.delete('/api/performance/:agentId', async (url, request, params) => {
    return registerPerformanceRoutes(url, request, deps, params);
  });

  // Versioned API bridge. The SPA probes /api/v1 first while the existing route
  // handlers remain mounted at /api for compatibility with older terminals.
  router.all('/api/v1/*', async (url, request) => {
    const normalized = new URL(url);
    if (normalized.pathname === '/api/v1/agents/hierarchy') {
      normalized.pathname = '/api/agents/hierarchy/tree';
    } else {
      normalized.pathname = normalized.pathname.replace(/^\/api\/v1/, '/api');
    }
    return router.dispatch(new Request(normalized.toString(), request));
  });

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

  if (isSensitiveMutation(request.method, url.pathname)) {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
  }

  const loggedDispatch = wrapRouterWithLogging((url, request) => router.dispatch(request), {
    db: deps.scraperManager?.getDatabase?.(),
    enabled: true,
  });

  return loggedDispatch(url, request);
}

function isSensitiveMutation(method: string, pathname: string): boolean {
  if (!['POST', 'PUT', 'DELETE'].includes(method.toUpperCase())) return false;
  if (pathname === '/api/connect') return true;
  if (pathname.startsWith('/api/v1/')) {
    const normalizedPath = pathname === '/api/v1/agents/hierarchy'
      ? '/api/agents/hierarchy/tree'
      : pathname.replace(/^\/api\/v1/, '/api');
    return isSensitiveMutation(method, normalizedPath);
  }
  return pathname.startsWith('/api/buckeye/')
    || pathname.startsWith('/api/webhooks')
    || pathname.startsWith('/api/players/')
    || pathname.startsWith('/api/agents/')
    || pathname.startsWith('/api/performance/');
}
