/**
 * Player routes
 */
import { createParamRouteHandler } from './base';
import { clampInt } from '../helpers';
import { logRequest } from '../../utils/logger';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export const registerPlayerDetailsRoutes = createParamRouteHandler(
  '/api/players/:playerId/details',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    logRequest('GET', `/api/players/${params.playerId}/details`);
    return scraperManager.getPlayerDetails(params.playerId);
  }
);

export const registerPlayerWagersRoutes = createParamRouteHandler(
  '/api/players/:playerId/wagers',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    logRequest('GET', `/api/players/${params.playerId}/wagers`);
    return scraperManager.getPlayerWagers(params.playerId);
  }
);

export const registerPlayerPnlRoutes = createParamRouteHandler(
  '/api/players/:playerId/pnl',
  'playerId',
  async (url, _req, scraperManager, params) => {
    logRequest('GET', `/api/players/${params.playerId}/pnl`);
    const days = clampInt(url.searchParams.get('days'), 7, 1, 90);
    return scraperManager.getPlayerPnlHistory(params.playerId, days);
  }
);
