/**
 * Wager routes
 */
import { createRouteHandler } from './base';
import { clampInt } from '../helpers';
import { logRequest } from '../../utils/logger';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export const registerWagerStatsRoutes = createRouteHandler('/api/stats', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/stats');
  return scraperManager.getStats();
});

export const registerWagerListRoutes = createRouteHandler('/api/wagers', async (url, _req, scraperManager) => {
  logRequest('GET', '/api/wagers');
  const limit = clampInt(url.searchParams.get('limit'), 200, 1, 500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
  return scraperManager.getWagers(limit, offset);
});

export const registerWagerAlertRoutes = createRouteHandler('/api/wagers/alerts', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/wagers/alerts');
  return scraperManager.getAlertWagers();
});

export const registerWagerLiveRoutes = createRouteHandler('/api/wagers/live', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/wagers/live');
  return scraperManager.getLiveWagers();
});
