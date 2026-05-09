/**
 * Agent routes
 */
import { createRouteHandler, createParamRouteHandler, createMethodRouteHandler } from './base';
import { loadLocalAgentHierarchy } from '../helpers';
import { logRequest } from '../../utils/logger';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export const registerAgentRoutes = createRouteHandler('/api/agents', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/agents');
  return scraperManager.getAgents();
});

export const registerAgentExposureRoutes = createParamRouteHandler(
  '/api/agents/:agentId/exposure',
  'agentId',
  async (_url, _req, scraperManager, params) => {
    logRequest('GET', `/api/agents/${params.agentId}/exposure`);
    return scraperManager.getAgentData(params.agentId);
  }
);

export const registerAgentPerformanceRoutes = createParamRouteHandler(
  '/api/agents/:agentId/performance',
  'agentId',
  async (_url, _req, scraperManager, params) => {
    logRequest('GET', `/api/agents/${params.agentId}/performance`);
    return scraperManager.getAgentPerformance(params.agentId);
  }
);

export const registerAgentDownlineRoutes = createRouteHandler('/api/agents/downline', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/agents/downline');
  return scraperManager.getAgentDownline();
});

export const registerAgentHierarchyRoutes = createRouteHandler('/api/agents/hierarchy', async (url, _req, scraperManager) => {
  logRequest('GET', '/api/agents/hierarchy');
  const agentId = url.searchParams.get('agentId') || undefined;
  const persistedHierarchy = await scraperManager.getPersistedAgentHierarchy();
  if (Array.isArray(persistedHierarchy?.GENERAL) && persistedHierarchy.GENERAL.length > 0) {
    return persistedHierarchy;
  }
  const liveHierarchy = await scraperManager.getAgentHierarchy(agentId);
  if (Array.isArray(liveHierarchy?.GENERAL) && liveHierarchy.GENERAL.length > 0) {
    return liveHierarchy;
  }
  const localHierarchy = await loadLocalAgentHierarchy();
  return localHierarchy.GENERAL.length > 0 ? localHierarchy : liveHierarchy;
});

export const registerAgentBackfillRoutes = createMethodRouteHandler(
  '/api/agents/backfill/hierarchy',
  'POST',
  async (_url, _req, scraperManager) => {
    logRequest('POST', '/api/agents/backfill/hierarchy');
    return scraperManager.backfillAgentHierarchy();
  }
);

export const registerAgentAccessLogRoutes = createRouteHandler('/api/agents/access-logs', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/agents/access-logs');
  return scraperManager.getAccessLogs();
});
