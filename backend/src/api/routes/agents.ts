/**
 * Agent routes
 */
import { handleAsync, corsHeaders, loadLocalAgentHierarchy } from '../helpers';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export function registerAgentRoutes(
  url: URL,
  _request: Request,
  scraperManager: BuckeyeScraperManager
): Response | null {
  if (url.pathname === '/api/agents') {
    return handleAsync(async () => scraperManager.getAgents(), corsHeaders);
  }

  const agentExposureMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/exposure$/);
  if (agentExposureMatch) {
    const agentId = decodeURIComponent(agentExposureMatch[1]);
    return handleAsync(async () => scraperManager.getAgentData(agentId), corsHeaders);
  }

  const agentPerformanceMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/performance$/);
  if (agentPerformanceMatch) {
    const agentId = decodeURIComponent(agentPerformanceMatch[1]);
    return handleAsync(async () => scraperManager.getAgentPerformance(agentId), corsHeaders);
  }

  if (url.pathname === '/api/agents/downline') {
    return handleAsync(async () => scraperManager.getAgentDownline(), corsHeaders);
  }

  if (url.pathname === '/api/agents/hierarchy') {
    const agentId = url.searchParams.get('agentId') || undefined;
    return handleAsync(async () => {
      const liveHierarchy = await scraperManager.getAgentHierarchy(agentId);
      if (Array.isArray(liveHierarchy?.GENERAL) && liveHierarchy.GENERAL.length > 0) {
        return liveHierarchy;
      }
      const localHierarchy = await loadLocalAgentHierarchy();
      return localHierarchy.GENERAL.length > 0 ? localHierarchy : liveHierarchy;
    }, corsHeaders);
  }

  // Buckeye IP access logs
  if (url.pathname === '/api/agents/access-logs') {
    return handleAsync(async () => scraperManager.getAccessLogs(), corsHeaders);
  }

  return null;
}
