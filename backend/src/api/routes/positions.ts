/**
 * Risk Command Center routes
 * Position management + risk alert dispatch endpoints.
 */
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import { PositionService } from '../../services/PositionService';
import { RiskAlertService } from '../../services/RiskAlertService';
import { ApiError, corsHeaders, handleAsync, readJsonBody, requireAdminTokenIfConfigured } from '../helpers';

// ─── Position Routes ─────────────────────────────────────────────────

export function registerPositionRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  const service = new PositionService(scraperManager.getDatabase());

  // POST /api/positions/generate — Generate position from latest AI analysis
  if (url.pathname === '/api/positions/generate' && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody<{ customer_id?: string }>(request);
      if (!body.customer_id) throw new ApiError(400, 'customer_id is required');
      return service.generatePosition({ customer_id: body.customer_id });
    }, corsHeaders);
  }

  // POST /api/positions/execute — Trader applies a position
  if (url.pathname === '/api/positions/execute' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const body = await readJsonBody<{
        position_id?: number;
        action?: string;
        max_exposure?: number;
        wager_limit?: number;
        note?: string;
        trader_name?: string;
      }>(request);
      if (!body.position_id) throw new ApiError(400, 'position_id is required');
      if (!body.action) throw new ApiError(400, 'action is required');
      return service.executePosition({
        position_id: body.position_id,
        action: body.action,
        max_exposure: body.max_exposure,
        wager_limit: body.wager_limit,
        note: body.note,
        trader_name: body.trader_name,
      });
    }, corsHeaders);
  }

  // POST /api/positions/override — Trader overrides AI suggestion
  if (url.pathname === '/api/positions/override' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const body = await readJsonBody<{
        position_id?: number;
        reason?: string;
        trader_name?: string;
      }>(request);
      if (!body.position_id) throw new ApiError(400, 'position_id is required');
      if (!body.reason) throw new ApiError(400, 'reason is required');
      return service.overridePosition({
        position_id: body.position_id,
        reason: body.reason,
        trader_name: body.trader_name,
      });
    }, corsHeaders);
  }

  // GET /api/positions/latest — Latest active position for a customer
  if (url.pathname === '/api/positions/latest' && request.method === 'GET') {
    return handleAsync(async () => {
      const customerId = url.searchParams.get('customerId');
      if (!customerId) throw new ApiError(400, 'customerId query parameter is required');
      return service.getLatestPosition(customerId);
    }, corsHeaders);
  }

  // GET /api/positions — List positions with filters
  if (url.pathname === '/api/positions' && request.method === 'GET') {
    return handleAsync(async () => {
      return service.listPositions({
        customer_id: url.searchParams.get('customer_id') || undefined,
        status: url.searchParams.get('status') || undefined,
        risk_level: url.searchParams.get('risk_level') || undefined,
        limit: Number(url.searchParams.get('limit')) || 50,
        offset: Number(url.searchParams.get('offset')) || 0,
      });
    }, corsHeaders);
  }

  // GET /api/positions/stats — Position dashboard stats
  if (url.pathname === '/api/positions/stats' && request.method === 'GET') {
    return handleAsync(async () => service.getPositionStats(), corsHeaders);
  }

  // GET /api/positions/:id — Single position
  const positionIdMatch = url.pathname.match(/^\/api\/positions\/(\d+)$/);
  if (positionIdMatch && request.method === 'GET') {
    return handleAsync(async () => {
      const id = Number(positionIdMatch[1]);
      const position = await service.getPositionById(id);
      if (!position) throw new ApiError(404, 'Position not found');
      return position;
    }, corsHeaders);
  }

  return null;
}

// ─── Risk Alert Routes ───────────────────────────────────────────────

export function registerRiskAlertCommandRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  const service = new RiskAlertService(scraperManager.getDatabase());

  // POST /api/risk-alerts/dispatch — Manually trigger alerts for a customer
  if (url.pathname === '/api/risk-alerts/dispatch' && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody<{
        customer_id?: string;
        risk_level?: string;
        confidence?: number;
        summary?: string;
        suggested_action?: string;
      }>(request);
      if (!body.customer_id || !body.risk_level) {
        throw new ApiError(400, 'customer_id and risk_level are required');
      }
      return service.sendAlerts({
        customer_id: body.customer_id,
        risk_level: body.risk_level,
        confidence: body.confidence ?? 0,
        summary: body.summary || '',
        suggested_action: body.suggested_action,
      });
    }, corsHeaders);
  }

  // POST /api/risk-alerts/test — Test a webhook with sample data
  if (url.pathname === '/api/risk-alerts/test' && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody<{ webhook_id?: number }>(request);
      if (!body.webhook_id) throw new ApiError(400, 'webhook_id is required');
      return service.testWebhook(body.webhook_id);
    }, corsHeaders);
  }

  // GET /api/risk-alerts/log — Alert delivery log
  if (url.pathname === '/api/risk-alerts/log' && request.method === 'GET') {
    return handleAsync(async () => {
      return service.getAlertLog({
        customer_id: url.searchParams.get('customer_id') || undefined,
        webhook_id: url.searchParams.get('webhook_id')
          ? Number(url.searchParams.get('webhook_id'))
          : undefined,
        limit: Number(url.searchParams.get('limit')) || 100,
      });
    }, corsHeaders);
  }

  return null;
}
