/**
 * Health & metrics routes
 */
import { corsHeaders } from '../helpers';
import { logRequest } from '../../utils/logger';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export function registerHealthRoutes(
  url: URL,
  _request: Request,
  scraperManager: BuckeyeScraperManager
): Response | null {
  if (url.pathname === '/health') {
    logRequest('GET', '/health');
    return new Response(
      JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        scrapers: scraperManager.getMetrics(),
      }),
      { headers: corsHeaders }
    );
  }

  if (url.pathname === '/metrics') {
    logRequest('GET', '/metrics');
    return new Response(
      JSON.stringify(scraperManager.getMetrics()),
      { headers: corsHeaders }
    );
  }

  return null;
}
