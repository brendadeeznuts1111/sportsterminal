/**
 * Command Center routes
 *
 * - GET /api/dashboard                — full dashboard payload
 * - GET /api/dashboard/summary        — counters
 * - GET /api/dashboard/exposure       — book exposure heatmap
 * - GET /api/dashboard/sharp-alerts   — sharp player alerts
 * - GET /api/dashboard/pending        — pending positions
 * - GET /api/dashboard/buckets        — exposure histogram
 * - GET /api/dashboard/pnl            — historical P&L (whole book or per-customer)
 * - GET /api/players/suggest          — autocomplete
 * - GET /api/players/search           — full search hits (overrides existing path,
 *                                       so register AFTER the legacy registration)
 * - GET /api/enforcement/breaches     — recent enforcement events
 * - POST /api/enforcement/check       — pre-flight check for a single wager
 * - POST /api/ab-test/run             — run paired Kimi prompt test
 */
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import { COMMAND_CENTER_MAP, getPublicCommandCenterMap } from '../../config/commandCenterMap';
import { getAbTestRunner } from '../../services/AbTestRunner';
import { AutoEnforcementService } from '../../services/AutoEnforcementService';
import { CommandCenterDashboard } from '../../services/CommandCenterDashboard';
import { CommandCenterStatusService } from '../../services/CommandCenterStatusService';
import { LiveFeatureService } from '../../services/LiveFeatureService';
import { PlayerSearchService } from '../../services/PlayerSearchService';
import { PositionService } from '../../services/PositionService';
import { ShadowAgentService } from '../../services/ShadowAgentService';
import { RiskCommandCenter } from '../../services/RiskCommandCenter';
import { ApiError, corsHeaders, handleAsync, readJsonBody, requireAdminTokenIfConfigured } from '../helpers';

export function registerCommandCenterRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  const db = scraperManager.getDatabase();
  const dashboard = new CommandCenterDashboard(db);

  // ─── Dashboard ────────────────────────────────────────────────────
  if (url.pathname === COMMAND_CENTER_MAP.endpoints.commandCenterMap.path && request.method === 'GET') {
    return handleAsync(async () => getPublicCommandCenterMap(), corsHeaders);
  }

  if (url.pathname === COMMAND_CENTER_MAP.endpoints.commandCenterStatus.path && request.method === 'GET') {
    const status = new CommandCenterStatusService(db, scraperManager);
    return handleAsync(async () => status.getStatus(), corsHeaders);
  }

  if (url.pathname === '/api/dashboard' && request.method === 'GET') {
    const hours = clampInt(url.searchParams.get('hours'), 24, 1, 720);
    return handleAsync(async () => dashboard.getFullDashboard(hours), corsHeaders);
  }
  if (url.pathname === '/api/dashboard/summary' && request.method === 'GET') {
    return handleAsync(async () => dashboard.getSummary(), corsHeaders);
  }
  if (url.pathname === COMMAND_CENTER_MAP.endpoints.dashboardExposure.path && request.method === 'GET') {
    const hours = windowToHours(url.searchParams.get('window'), clampInt(url.searchParams.get('hours'), 24, 1, 720));
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent_id') || undefined;
    const sport = url.searchParams.get('sport') || undefined;
    return handleAsync(async () => dashboard.getBookExposure(hours, limit, { agentId, sport }), corsHeaders);
  }
  if (url.pathname === COMMAND_CENTER_MAP.endpoints.dashboardSharpAlerts.path && request.method === 'GET') {
    const hours = clampInt(url.searchParams.get('hours'), 24, 1, 720);
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const riskLevel = url.searchParams.get('riskLevel') || url.searchParams.get('risk_level') || undefined;
    return handleAsync(async () => dashboard.getSharpAlerts(hours, limit, riskLevel), corsHeaders);
  }
  if (url.pathname === '/api/dashboard/pending' && request.method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    return handleAsync(async () => dashboard.getPendingActions(limit), corsHeaders);
  }
  if (url.pathname === COMMAND_CENTER_MAP.endpoints.dashboardPositionsPending.path && request.method === 'GET') {
    const service = new PositionService(db);
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 10_000);
    return handleAsync(async () => service.listPositions({
      status: url.searchParams.get('status') || undefined,
      risk_level: url.searchParams.get('risk_level') || undefined,
      limit,
      offset,
    }), corsHeaders);
  }
  if (url.pathname === '/api/dashboard/buckets' && request.method === 'GET') {
    const hours = clampInt(url.searchParams.get('hours'), 24, 1, 720);
    return handleAsync(async () => dashboard.getExposureBuckets(hours), corsHeaders);
  }
  if (url.pathname === '/api/dashboard/pnl' && request.method === 'GET') {
    const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
    const customerId = url.searchParams.get('customer_id') || undefined;
    return handleAsync(async () => dashboard.getPnlHistory({ customer_id: customerId, days }), corsHeaders);
  }

  // ─── Player intelligence ──────────────────────────────────────────
  if (url.pathname === '/api/players/suggest' && request.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const limit = clampInt(url.searchParams.get('limit'), 8, 1, 30);
    const service = new PlayerSearchService(db);
    return handleAsync(async () => service.suggest(q, limit), corsHeaders);
  }
  if (url.pathname === '/api/players/intel-search' && request.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const limit = clampInt(url.searchParams.get('limit'), 10, 1, 50);
    const service = new PlayerSearchService(db);
    return handleAsync(async () => service.search(q, limit), corsHeaders);
  }

  // ─── Auto-enforcement ─────────────────────────────────────────────
  if (url.pathname === '/api/enforcement/breaches' && request.method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const service = new AutoEnforcementService(db);
    return handleAsync(async () => service.listRecentBreaches(limit), corsHeaders);
  }
  if (url.pathname === '/api/enforcement/check' && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody<{ customer_id?: string; amount?: number }>(request);
      if (!body.customer_id) throw new ApiError(400, 'customer_id is required');
      const amount = Number(body.amount ?? 0);
      const service = new AutoEnforcementService(db);
      return service.evaluateWager({
        customer_id: body.customer_id,
        amount_wagered_dollars: amount,
      });
    }, corsHeaders);
  }
  if (url.pathname === '/api/enforcement/run' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    const service = new AutoEnforcementService(db);
    return handleAsync(async () => service.enforceAll(), corsHeaders);
  }

  // ─── AB test (Worker-based) ───────────────────────────────────────
  if (url.pathname === '/api/ab-test/run' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const body = await readJsonBody<{
        customer_id?: string;
        prompt_a?: string;
        prompt_b?: string;
        snapshot?: Record<string, unknown>;
      }>(request);
      if (!body.customer_id || !body.prompt_a || !body.prompt_b) {
        throw new ApiError(400, 'customer_id, prompt_a, and prompt_b are required');
      }
      const runner = getAbTestRunner();
      return runner.run({
        customer_id: body.customer_id,
        prompt_a: body.prompt_a,
        prompt_b: body.prompt_b,
        snapshot: body.snapshot || {},
      });
    }, corsHeaders);
  }

  // ─── Live AI analysis ─────────────────────────────────────────────
  if (url.pathname === COMMAND_CENTER_MAP.endpoints.analyzeLive.path && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody<{ customer_id?: string; forceRefresh?: boolean }>(request);
      if (!body.customer_id) throw commandCenterError(400, COMMAND_CENTER_MAP.errors.customerIdRequired);
      const service = new LiveFeatureService(db);
      return service.analyzeLiveCustomer({
        customer_id: body.customer_id,
        forceRefresh: Boolean(body.forceRefresh),
      });
    }, corsHeaders);
  }

  // ─── Live shadow A/B (Worker-backed) ──────────────────────────────
  if (url.pathname === COMMAND_CENTER_MAP.endpoints.shadowAb.path && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody<{
        customer_ids?: string[];
        prompt_a?: string;
        prompt_b?: string;
        name?: string;
      }>(request);
      if (!Array.isArray(body.customer_ids) || body.customer_ids.length === 0) {
        throw commandCenterError(400, COMMAND_CENTER_MAP.errors.customerIdsRequired);
      }
      if (!body.prompt_a || !body.prompt_b) {
        throw commandCenterError(400, COMMAND_CENTER_MAP.errors.promptsRequired);
      }
      const service = new ShadowAgentService(db);
      return service.start({
        customer_ids: body.customer_ids,
        prompt_a: body.prompt_a,
        prompt_b: body.prompt_b,
        name: body.name,
      });
    }, corsHeaders);
  }

  // ─── Risk Command Center ───────────────────────────────────────────
  const rcc = new RiskCommandCenter(db);

  if (url.pathname === '/api/risk/summary' && request.method === 'GET') {
    return handleAsync(async () => rcc.generateRiskSummary(), corsHeaders);
  }

  if (url.pathname === '/api/risk/positions' && request.method === 'GET') {
    const status = url.searchParams.get('status') || undefined;
    const customerId = url.searchParams.get('customer_id') || undefined;
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 10_000);
    const service = new PositionService(db);
    return handleAsync(async () => service.listPositions({ status, customer_id: customerId, limit, offset }), corsHeaders);
  }

  if (url.pathname === '/api/risk/positions' && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody<{
        position_id?: number;
        action?: string;
        max_exposure?: number;
        wager_limit?: number;
        note?: string;
        trader_name?: string;
      }>(request);
      if (!body.position_id || !body.action) throw new ApiError(400, 'position_id and action required');
      const service = new PositionService(db);
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

  if (url.pathname === '/api/risk/violations' && request.method === 'GET') {
    const customerId = url.searchParams.get('customer_id') || undefined;
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
    if (customerId) {
      return handleAsync(async () => rcc.getViolationsForCustomer(customerId, limit), corsHeaders);
    }
    return handleAsync(async () => rcc.getViolationCountsByType(24), corsHeaders);
  }

  if (url.pathname === '/api/risk/timeseries' && request.method === 'GET') {
    const days = clampInt(url.searchParams.get('days'), 30, 1, 90);
    return handleAsync(async () => rcc.getBookPnLTimeseries(days), corsHeaders);
  }

  if (/^\/api\/risk\/players\/[^/]+$/.test(url.pathname) && request.method === 'GET') {
    const customerId = url.pathname.split('/').pop();
    if (!customerId) throw new ApiError(400, 'customer_id required');
    return handleAsync(async () => rcc.getPlayerDetail(decodeURIComponent(customerId)), corsHeaders);
  }

  if (url.pathname === '/api/risk/webhooks/health' && request.method === 'GET') {
    return handleAsync(async () => rcc.getWebhookCircuitBreakerState(), corsHeaders);
  }

  return null;
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function windowToHours(value: string | null, fallback: number): number {
  if (value === 'day') return COMMAND_CENTER_MAP.windows.day.hours;
  if (value === 'week') return COMMAND_CENTER_MAP.windows.week.hours;
  if (value === 'month') return COMMAND_CENTER_MAP.windows.month.hours;
  return fallback;
}

function commandCenterError(status: number, error: { code: string; message: string }): ApiError {
  return new ApiError(status, `${error.code}: ${error.message}`);
}
