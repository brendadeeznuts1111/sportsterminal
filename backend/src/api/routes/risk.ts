/**
 * Risk / Alert / Exposure routes
 */
import { handleAsync, corsHeaders } from '../helpers';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export function registerRiskRoutes(
  url: URL,
  _request: Request,
  scraperManager: BuckeyeScraperManager
): Response | null {
  if (url.pathname === '/api/risk/alerts') {
    return handleAsync(async () => scraperManager.getAlerts(), corsHeaders);
  }

  if (url.pathname === '/api/exposure/sports') {
    return handleAsync(async () => scraperManager.getSportExposure(), corsHeaders);
  }

  if (url.pathname === '/api/exposure/agents') {
    return handleAsync(async () => scraperManager.getAgentExposure(), corsHeaders);
  }

  return null;
}
