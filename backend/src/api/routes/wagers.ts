/**
 * Wager routes
 */
import { clampInt, handleAsync, corsHeaders } from '../helpers';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export function registerWagerRoutes(
  url: URL,
  _request: Request,
  scraperManager: BuckeyeScraperManager
): Response | null {
  if (url.pathname === '/api/stats') {
    return handleAsync(async () => scraperManager.getStats(), corsHeaders);
  }

  if (url.pathname === '/api/wagers') {
    const limit = clampInt(url.searchParams.get('limit'), 200, 1, 500);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
    return handleAsync(async () => scraperManager.getWagers(limit, offset), corsHeaders);
  }

  if (url.pathname === '/api/wagers/alerts') {
    return handleAsync(async () => scraperManager.getAlertWagers(), corsHeaders);
  }

  if (url.pathname === '/api/wagers/live') {
    return handleAsync(async () => scraperManager.getLiveWagers(), corsHeaders);
  }

  return null;
}
