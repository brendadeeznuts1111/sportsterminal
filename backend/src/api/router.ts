/**
 * API Router
 * Uses UrlPatternRouter for framework-agnostic URL routing.
 * Falls through to 404 if no route matches.
 */
import { ProxyClient } from '../lib/proxyClient';
import type { OddsPoller } from '../odds/OddsPoller';
import type { BuckeyeScraperManager } from '../scrapers/ScraperManager';
import type { BunSecretVault } from '../services/BunSecretVault';
import type { PerformanceCache } from '../services/PerformanceCache';
import { corsHeaders, requireAdminTokenIfConfigured } from './helpers';
import { wrapRouterWithLogging } from './middleware/apiLogger';
import { requireAuth } from './middleware/auth';
import { RateLimiter } from './rateLimiter';
import {
  registerAgentAccessLogRoutes,
  registerAgentBackfillRoutes,
  registerAgentDownlineRoutes,
  registerAgentExposureRoutes,
  registerAgentHierarchyRoutes,
  registerAgentPerformanceRoutes,
  registerAgentPlayersRoutes,
  registerAgentProfileRoutes,
  registerAgentRefreshRoutes,
  registerAgentRoutes,
  registerCachedAgentHierarchyTreeRoutes,
} from './routes/agents';
import { registerAnalyticsRoutes } from './routes/analytics';
import { registerBuckeyeRoutes } from './routes/buckeye';
import { registerCommandCenterRoutes } from './routes/command-center';
import { registerCrossReferenceRoutes } from './routes/cross-reference';
import { registerFreePlayAnalysisRoutes } from './routes/freeplay';
import { registerHealthRoutes } from './routes/health';
import { registerOddsRoutes } from './routes/odds';
import { registerPerformanceRoutes } from './routes/performance';
import {
  registerPlayerAccountSnapshotsRoutes,
  registerPlayerAgentContextRoutes,
  registerPlayerDepositsRoutes,
  registerPlayerDetailsRoutes,
  registerPlayerExportRoutes,
  registerPlayerFlagCreateRoutes,
  registerPlayerFlagResolveRoutes,
  registerPlayerFlagsRoutes,
  registerPlayerIntelligenceMapRoutes,
  registerPlayerLinkCheckRoutes,
  registerPlayerLinksRoutes,
  registerPlayerNoteCreateRoutes,
  registerPlayerNotesRoutes,
  registerPlayerPnlRoutes,
  registerPlayerProfileRoutes,
  registerPlayerSearchRoutes,
  registerPlayerTransactionsRoutes,
  registerPlayerWagersRoutes,
} from './routes/players';
import { registerPositionRoutes, registerRiskAlertCommandRoutes } from './routes/positions';
import {
  registerExposureAgentsRoutes,
  registerExposureSportsRoutes,
  registerRiskAlertRoutes,
} from './routes/risk';
import { registerSandboxRoutes } from './routes/sandbox';
import { registerStaticRoutes } from './routes/static';
import { registerKimiStreamRoutes, registerStreamRoutes } from './routes/stream';
import {
  registerWagerAlertRoutes,
  registerWagerListRoutes,
  registerWagerLiveRoutes,
  registerWagerStatsRoutes,
} from './routes/wagers';
import { registerWebhookRoutes } from './routes/webhooks';
import type { RouteHandler } from './UrlPatternRouter';
import { UrlPatternRouter } from './UrlPatternRouter';

export interface RouterDeps {
  scraperManager: BuckeyeScraperManager;
  oddsPoller?: OddsPoller;
  secretVault?: BunSecretVault;
  performanceCache?: PerformanceCache;
}

/**
 * Create and configure the URLPattern router with all registered routes.
 */
export function createRouter(deps: RouterDeps, _rateLimiter?: RateLimiter): UrlPatternRouter {
  const router = new UrlPatternRouter();

  // CORS preflight handler
  router.options('/api/*', async (_url, _request) => {
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

  router.get('/api/cross-reference', async (url, request) => {
    return registerCrossReferenceRoutes(url, request, deps.scraperManager);
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

  router.get('/api/patterns/catalog', async (url, request) => {
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

  // ========== PROXY-COMPATIBLE ROUTES (/api/proxy/*) ==========
  router.get('/api/proxy/status', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });
  router.get('/api/proxy/endpoints', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });
  router.get('/api/proxy/logs', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });
  router.get('/api/proxy/tokens', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });
  router.post('/api/proxy/renewToken', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });
  // Enhanced proxy aliases bridged from backend port 3000 to the internal
  // standalone proxy on port 3001.
  router.post('/api/proxy/taxonomy/:level', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });
  router.post('/api/proxy/:alias', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });
  // Manager operations (POST only)
  router.post('/api/proxy/Manager/:operation', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });
  // System operations
  router.post('/api/proxy/System/:operation', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });
  // Log operations
  router.post('/api/proxy/Log/:operation', async (url, request) => {
    return registerBuckeyeRoutes(url, request, deps.scraperManager, deps.secretVault);
  });

  // ========== LIVE PROXY ROUTES (/api/live/*) ==========
  // These bypass local caching and return fresh proxy data.
  // Old /api/agents/downline still returns cached local data.
  router.post('/api/live/agentDownline', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.agentDownline(agentID));
  });

  router.post('/api/live/agentBilling', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const week = String(body.week || url.searchParams.get('week') || '0');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.agentBilling(agentID, week));
  });

  router.post('/api/live/playerInfo', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const playerID = String(body.playerID || body.playerId || url.searchParams.get('playerID') || '');
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.playerInfo(playerID, agentID));
  });

  router.post('/api/live/dynamicLive', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.dynamicLive(agentID));
  });

  router.post('/api/live/leagueLines', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const league = String(body.league || url.searchParams.get('league') || '');
    const sport = String(body.sport || url.searchParams.get('sport') || '');
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.leagueLines(league, sport, agentID));
  });

  router.post('/api/live/sportsLeagues', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.sportsLeagues(agentID));
  });

  router.post('/api/live/gameVolume', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const gameId = String(body.gameId || body.gameID || url.searchParams.get('gameId') || '');
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.gameVolume(gameId, agentID));
  });

  router.post('/api/live/pending', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const date = String(body.date || url.searchParams.get('date') || '');
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.pending(date, agentID));
  });

  router.post('/api/live/betTicker', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.betTicker(agentID));
  });

  router.post('/api/live/scoresLive', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.scoresLive(agentID));
  });

  router.post('/api/live/Manager/:operation', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const operation = url.pathname.replace('/api/live/Manager/', '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.manager(operation, body));
  });

  // Zone 3 — Prop Builder live routes
  router.post('/api/live/props', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.getProps(agentID));
  });

  router.post('/api/live/extendedProps', async (url, request) => {
    const body = await request.json() as Record<string, unknown>;
    const agentID = String(body.agentID || body.agentId || url.searchParams.get('agentID') || '');
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.getExtendedProps(agentID));
  });

  router.post('/api/live/propBuilderURL', async () => {
    const client = new ProxyClient(deps.scraperManager);
    return Response.json(await client.getPropBuilderURL());
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

  router.get('/api/agent/ip-suspicious', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agent/ip-lookup', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/agent/ip-block', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agent/ip-export', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/agent/rules', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/agent/rules', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.delete('/api/agent/rules/:id', async (url, request) => {
    return registerAnalyticsRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/sandbox/list', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/sandbox/load', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/sandbox/save', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/sandbox/delete', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/sandbox/archive', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/sandbox/restore', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/sandbox/hard-delete', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.delete('/api/sandbox/scenarios/:id', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/sandbox/generate-summaries', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/sandbox/queue-status', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/sandbox/customer-summary', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/sandbox/ab-tests', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/sandbox/ab-test', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/sandbox/ab-test/:id', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/sandbox/export/csv', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/sandbox/export/features', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/sandbox/stats', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/sandbox/health', async (url, request) => {
    return registerSandboxRoutes(url, request, deps.scraperManager);
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

  // Risk Command Center: Position management
  router.post('/api/positions/generate', async (url, request) => {
    return registerPositionRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/positions/execute', async (url, request) => {
    return registerPositionRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/positions/override', async (url, request) => {
    return registerPositionRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/positions/latest', async (url, request) => {
    return registerPositionRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/positions', async (url, request) => {
    return registerPositionRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/positions/stats', async (url, request) => {
    return registerPositionRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/positions/:id', async (url, request) => {
    return registerPositionRoutes(url, request, deps.scraperManager);
  });

  // Risk Command Center: Alert dispatch
  router.post('/api/risk-alerts/dispatch', async (url, request) => {
    return registerRiskAlertCommandRoutes(url, request, deps.scraperManager);
  });

  router.post('/api/risk-alerts/test', async (url, request) => {
    return registerRiskAlertCommandRoutes(url, request, deps.scraperManager);
  });

  router.get('/api/risk-alerts/log', async (url, request) => {
    return registerRiskAlertCommandRoutes(url, request, deps.scraperManager);
  });

  // ─── Risk Command Center: SSE streaming ─────────────────────────
  router.get('/api/stream/live-wagers', async (url, request) => {
    return registerStreamRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/stream/wagers', async (url, request) => {
    return registerStreamRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/stream/positions', async (url, request) => {
    return registerStreamRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/stream/all', async (url, request) => {
    return registerStreamRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/stream/topic/:topic', async (url, request) => {
    return registerStreamRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/stream/stats', async (url, request) => {
    return registerStreamRoutes(url, request, deps.scraperManager);
  });

  // Streaming Kimi analysis
  router.post('/api/analysis/stream', async (url, request) => {
    return registerKimiStreamRoutes(url, request, deps.scraperManager);
  });

  // ─── Risk Command Center: Dashboard ─────────────────────────────
  router.get('/api/command-center/map', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/command-center/status', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/dashboard', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/dashboard/summary', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/dashboard/exposure', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/dashboard/sharp-alerts', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/dashboard/pending', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/dashboard/positions-pending', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/dashboard/buckets', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/dashboard/pnl', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });

  // ─── Player intelligence ────────────────────────────────────────
  router.get('/api/players/suggest', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/players/intel-search', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });

  // ─── Auto-enforcement ───────────────────────────────────────────
  router.get('/api/enforcement/breaches', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.post('/api/enforcement/check', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.post('/api/enforcement/run', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });

  // ─── AB test ────────────────────────────────────────────────────
  router.post('/api/ab-test/run', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.post('/api/agent/analyze-live', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.post('/api/agent/shadow-ab', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/risk/summary', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/risk/positions', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.post('/api/risk/positions', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/risk/violations', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/risk/timeseries', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/risk/players/:id', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
  });
  router.get('/api/risk/webhooks/health', async (url, request) => {
    return registerCommandCenterRoutes(url, request, deps.scraperManager);
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
  router.all('/*', async (url, _request) => {
    return registerStaticRoutes(url);
  });

  return router;
}

/**
 * Route a request through the URLPattern router.
 * Returns a Response or null if no route matched.
 *
 * Router is created once per deps/rateLimiter combo and cached
 * to avoid rebuilding 60+ route patterns on every request.
 */
const routerCache = new WeakMap<
  RouterDeps,
  WeakMap<object, { router: UrlPatternRouter; loggedDispatch: RouteHandler }>
>();
const noRateLimiterCacheKey = {};

function getCachedRouter(deps: RouterDeps, rateLimiter?: RateLimiter) {
  const limiterKey = rateLimiter || noRateLimiterCacheKey;
  let limiterCache = routerCache.get(deps);
  if (!limiterCache) {
    limiterCache = new WeakMap();
    routerCache.set(deps, limiterCache);
  }

  let cached = limiterCache.get(limiterKey);
  if (!cached) {
    const router = createRouter(deps, rateLimiter);
    const loggedDispatch = wrapRouterWithLogging((_url, request) => router.dispatch(request), {
      db: deps.scraperManager?.getDatabase?.(),
      enabled: true,
    });
    cached = { router, loggedDispatch };
    limiterCache.set(limiterKey, cached);
  }
  return cached!;
}

export async function routeRequest(
  url: URL,
  request: Request,
  deps: RouterDeps,
  rateLimiter?: RateLimiter,
  clientIp?: string
): Promise<Response | null> {
  const { loggedDispatch } = getCachedRouter(deps, rateLimiter);

  // Rate limiting — use Bun's server.requestIP() when available, fall back to header parsing
  if (rateLimiter) {
    const ip = clientIp || RateLimiter.getClientIp(request);
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

  // JWT authentication (lenient: some read routes are public)
  const authResult = await requireAuth(request, url.pathname);
  if (authResult instanceof Response) return authResult;

  if (isSensitiveMutation(request.method, url.pathname)) {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
  }

  return loggedDispatch(url, request, {});
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
