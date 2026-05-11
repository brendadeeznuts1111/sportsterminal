/**
 * Wager routes
 */
import { createRouteHandler } from './base';
import { clampInt } from '../helpers';
import { logRequest } from '../../utils/logger';
import { getEnrichedLiveWagers, getEnrichedRecentWagers } from '../../services/EnrichedWagerService';

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

export const registerWagerLiveRoutes = createRouteHandler('/api/wagers/live', async (url, _req, scraperManager) => {
  logRequest('GET', '/api/wagers/live');
  const enriched = url.searchParams.get('enriched') !== 'false'; // enriched by default
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 200);

  if (!enriched) {
    return scraperManager.getLiveWagers();
  }

  // Try GSLIVE first, fall back to recent wagers if sparse
  const db = (scraperManager as unknown as { db: import('../../database').AppDatabase }).db;
  let wagers = await getEnrichedLiveWagers(db, limit);
  if (wagers.length < 10) {
    wagers = await getEnrichedRecentWagers(db, limit);
  }

  return {
    wagers,
    meta: {
      count: wagers.length,
      enriched: true,
      source: wagers.length > 0 && wagers[0]?.insert_datetime ? 'live' : 'recent',
      timestamp: new Date().toISOString(),
    },
  };
});
