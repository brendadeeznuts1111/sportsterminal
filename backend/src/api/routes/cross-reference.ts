import { createRouteHandler } from './base';
import { logRequest } from '../../utils/logger';
import { CrossReferenceService } from '../../services/CrossReferenceService';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export const registerCrossReferenceRoutes = createRouteHandler(
  '/api/cross-reference',
  async (url, _req, scraperManager: BuckeyeScraperManager) => {
    logRequest('GET', '/api/cross-reference');
    const service = new CrossReferenceService(scraperManager.getDatabase());
    return service.getSummary({
      playerId: url.searchParams.get('playerId') || '',
      agentId: url.searchParams.get('agentId') || '',
    });
  }
);
