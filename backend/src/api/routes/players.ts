/**
 * Player routes
 */
import { clampInt, handleAsync, corsHeaders } from '../helpers';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export function registerPlayerRoutes(
  url: URL,
  _request: Request,
  scraperManager: BuckeyeScraperManager
): Response | null {
  const playerDetailsMatch = url.pathname.match(/^\/api\/players\/([^/]+)\/details$/);
  if (playerDetailsMatch) {
    const playerId = decodeURIComponent(playerDetailsMatch[1]);
    return handleAsync(async () => scraperManager.getPlayerDetails(playerId), corsHeaders);
  }

  const playerWagersMatch = url.pathname.match(/^\/api\/players\/([^/]+)\/wagers$/);
  if (playerWagersMatch) {
    const playerId = decodeURIComponent(playerWagersMatch[1]);
    return handleAsync(async () => scraperManager.getPlayerWagers(playerId), corsHeaders);
  }

  const playerPnlMatch = url.pathname.match(/^\/api\/players\/([^/]+)\/pnl$/);
  if (playerPnlMatch) {
    const playerId = decodeURIComponent(playerPnlMatch[1]);
    const days = clampInt(url.searchParams.get('days'), 7, 1, 90);
    return handleAsync(async () => scraperManager.getPlayerPnlHistory(playerId, days), corsHeaders);
  }

  return null;
}
