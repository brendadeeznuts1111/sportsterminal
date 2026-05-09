/**
 * Risk / Alert / Exposure routes
 */
import { createRouteHandler } from './base';
import { logRequest } from '../../utils/logger';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export const registerRiskAlertRoutes = createRouteHandler('/api/risk/alerts', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/risk/alerts');
  return scraperManager.getAlerts();
});

export const registerExposureSportsRoutes = createRouteHandler('/api/exposure/sports', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/exposure/sports');
  return scraperManager.getSportExposure();
});

export const registerExposureAgentsRoutes = createRouteHandler('/api/exposure/agents', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/exposure/agents');
  return scraperManager.getAgentExposure();
});
