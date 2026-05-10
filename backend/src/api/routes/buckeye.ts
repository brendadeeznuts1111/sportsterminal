/**
 * Buckeye-specific routes: UI config, account info, weekly figures, connect test
 */
import { clampInt, readJsonBody, handleAsync, corsHeaders } from '../helpers';
import { BuckeyeAPI, type BuckeyeWebLogType } from '../../scrapers/BuckeyeAPI';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import type { BuckeyeSecretStatus, BunSecretVault } from '../../services/BunSecretVault';
import { createToken } from '../../auth/jwt';
import { getEnv } from '../../config/env';
import { z } from 'zod';
import { validateQuery, formatZodError, webLogQuerySchema, connectBodySchema } from '../middleware/validate';

type ResumableBuckeyeAPI = BuckeyeAPI & {
  token: string;
  loggedIn: boolean;
};

type ProxyOperationParams = Record<string, string | number | boolean | null | undefined>;
type WebLogQuery = z.infer<typeof webLogQuerySchema>;
type ConnectBody = z.infer<typeof connectBodySchema>;

type BuckeyeProxyApi = BuckeyeAPI & {
  getBetTickerConfig?: () => Promise<unknown>;
  getListAgentsByAgent?: () => Promise<unknown>;
  getListVip?: () => Promise<unknown>;
  getInfoPlayer?: (playerLogin: string) => Promise<unknown>;
  getAgentManagement?: () => Promise<unknown>;
  getReportPlayerAnalysis?: (playerLogin: string) => Promise<unknown>;
  getEnterTransactions?: (playerLogin: string) => Promise<unknown>;
  getMail?: () => Promise<unknown>;
  getCryptoInfo?: () => Promise<unknown>;
  getCryptoAvailable?: () => Promise<unknown>;
  getConfigWebReportsCustomerAdmin?: () => Promise<unknown>;
};

export function registerBuckeyeRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager,
  secretVault?: BunSecretVault
): Promise<Response> | Response | null {
  if (url.pathname === '/api/buckeye/vault-status') {
    if (request.method === 'GET') {
      return handleAsync(async () => {
        if (!secretVault) {
          return {
            available: false,
            agents: [],
          };
        }
        const agentId = url.searchParams.get('agentId') || undefined;
        const status = await secretVault.getBuckeyeSecretStatus(agentId);

        if (Array.isArray(status)) {
          return {
            available: true,
            agents: status.map((entry) => decorateVaultStatus(entry, scraperManager)),
          };
        }

        return { available: true, ...decorateVaultStatus(status, scraperManager) };
      }, corsHeaders);
    }
    if (request.method === 'DELETE' || request.method === 'POST') {
      return handleAsync(async () => {
        if (!secretVault) {
          return { success: false, message: 'Secret vault unavailable' };
        }
        const body = request.method === 'POST' ? await readJsonBody(request) : {};
        const clearAll = url.searchParams.get('all') === '1' || body.all === true || body.all === '1';
        if (clearAll) {
          const agentIds = await secretVault.getBuckeyeAgentIds();
          await secretVault.clearAllBuckeyeSecrets();
          for (const agentId of agentIds) {
            scraperManager.stopAgent(agentId);
          }
          return {
            success: true,
            cleared: 'all',
            count: agentIds.length,
            message: 'All Buckeye vault credentials cleared',
          };
        }

        const agentId = url.searchParams.get('agentId') || body.agentId || undefined;
        const normalizedAgentId = agentId ? String(agentId).trim().toUpperCase() : undefined;
        await secretVault.clearBuckeyeSecrets(agentId);
        if (normalizedAgentId) {
          scraperManager.stopAgent(normalizedAgentId);
        }
        return {
          success: true,
          agentId: normalizedAgentId || null,
          message: 'Buckeye vault credentials cleared',
        };
      }, corsHeaders);
    }
  }

  // Buckeye language/theme config
  if (url.pathname === '/api/buckeye/ui-config') {
    if (request.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      const includeRaw = url.searchParams.get('includeRaw') === '1';
      const includeAgentParams = url.searchParams.get('includeAgentParams') === '1';
      return handleAsync(
        async () => scraperManager.getBuckeyeUiConfig(agentId, includeRaw, includeAgentParams),
        corsHeaders
      );
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        const api = new BuckeyeAPI(
          {
            agentId: body.agentId,
            password: body.password || '',
            baseUrl: body.baseUrl,
            cfCookie: body.cfCookie,
          },
          false
        );

        if (body.token) {
          resumeBuckeyeSession(api, String(body.token));
        } else {
          const ok = await api.login();
          if (!ok) {
            throw new Error('Login failed — invalid credentials or site unreachable');
          }
        }

        return api.getLanguageUiConfig({
          includeRaw: body.includeRaw === true,
          includeAgentParams: body.includeAgentParams === true,
        });
      }, corsHeaders);
    }
  }

  // Buckeye account info and capability flags
  if (url.pathname === '/api/buckeye/account-info') {
    if (request.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      const force = url.searchParams.get('force') === '1';
      return handleAsync(async () => scraperManager.getBuckeyeAccountInfo(agentId, force), corsHeaders);
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        const api = new BuckeyeAPI(
          {
            agentId: body.agentId,
            password: body.password || '',
            baseUrl: body.baseUrl,
            cfCookie: body.cfCookie,
          },
          false
        );

        if (body.token) {
          resumeBuckeyeSession(api, String(body.token));
        } else {
          const ok = await api.login();
          if (!ok) {
            throw new Error('Login failed — invalid credentials or site unreachable');
          }
        }

        return api.getAccountInfoOwner();
      }, corsHeaders);
    }
  }

  // Buckeye weekly figure report
  if (url.pathname === '/api/buckeye/weekly-figures') {
    if (request.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      const week = clampInt(url.searchParams.get('week'), 0, 0, 52);
      const type = url.searchParams.get('type') || 'A';
      const layout = url.searchParams.get('layout') || 'byDay';
      return handleAsync(
        async () => scraperManager.getWeeklyFigureByAgentLite(agentId, { week, type, layout }),
        corsHeaders
      );
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        const api = new BuckeyeAPI(
          {
            agentId: body.agentId,
            password: body.password || '',
            baseUrl: body.baseUrl,
            cfCookie: body.cfCookie,
          },
          false
        );

        if (body.token) {
          resumeBuckeyeSession(api, String(body.token));
        } else {
          const ok = await api.login();
          if (!ok) {
            throw new Error('Login failed — invalid credentials or site unreachable');
          }
        }

        return api.getWeeklyFigureByAgentLite({
          week: Number.isInteger(body.week) ? body.week : 0,
          type: body.type || 'A',
          layout: body.layout || 'byDay',
        });
      }, corsHeaders);
    }
  }

  if (url.pathname === '/api/buckeye/agent-performance/options' && request.method === 'GET') {
    return new Response(JSON.stringify(BUCKEYE_AGENT_PERFORMANCE_OPTIONS), { headers: corsHeaders });
  }

  if (url.pathname === '/api/buckeye/sports-types' && request.method === 'GET') {
    return handleAsync(async () => {
      const rows = await scraperManager.getBuckeyeSportTypes();
      if (rows.length > 0) {
        return {
          LIST: rows.map((row) => ({
            sportType: row.raw_value,
            '0': row.raw_value,
            label: row.label,
            value: row.label,
            sortOrder: row.sort_order,
            source: row.source,
          })),
        };
      }
      return {
        LIST: BUCKEYE_AGENT_PERFORMANCE_OPTIONS.sports.map((sport, index) => ({
          sportType: sport.rawValue,
          '0': sport.rawValue,
          label: sport.label,
          value: sport.value,
          sortOrder: index,
          source: 'constant',
        })),
      };
    }, corsHeaders);
  }

  // Buckeye agent performance report from Manager/getAgentPerformance
  if (url.pathname === '/api/buckeye/agent-performance') {
    if (request.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      const preset = resolveReportPreset(url.searchParams.get('week'), url.searchParams.get('start'), url.searchParams.get('end'));
      return handleAsync(
        async () => scraperManager.getBuckeyeAgentPerformanceReport(agentId, {
          start: preset.start,
          end: preset.end,
          agentID: url.searchParams.get('reportAgentId') || agentId,
          type: url.searchParams.get('type') || 'CP',
          freePlay: url.searchParams.get('freePlay') || 'Y',
          store: url.searchParams.get('store') || agentId,
          sport: url.searchParams.get('sport') || '',
          subsport: url.searchParams.get('subsport') || '',
          period: url.searchParams.get('period') || '-1',
          wagerType: url.searchParams.get('wagerType') || '',
          betType: url.searchParams.get('betType') || '',
          tipo: url.searchParams.get('tipo') || url.searchParams.get('activity') || '-1',
          activity: url.searchParams.get('activity') || undefined,
          group: url.searchParams.get('group') || '',
          debug: url.searchParams.get('debug') || '0',
          agentOwner: url.searchParams.get('agentOwner') || undefined,
        }),
        corsHeaders
      );
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        const api = new BuckeyeAPI(
          {
            agentId: body.agentId,
            password: body.password || '',
            baseUrl: body.baseUrl,
            cfCookie: body.cfCookie,
          },
          false
        );

        if (body.token) {
          resumeBuckeyeSession(api, String(body.token));
        } else {
          const ok = await api.login();
          if (!ok) {
            throw new Error('Login failed — invalid credentials or site unreachable');
          }
        }

        const result = await api.getAgentPerformanceReport({
          ...resolveReportPreset(body.week, body.start, body.end),
          agentID: body.reportAgentId || body.agentId,
          type: body.type || 'CP',
          freePlay: body.freePlay || 'Y',
          store: body.store || body.agentId,
          sport: body.sport || '',
          subsport: body.subsport || '',
          period: body.period ?? '-1',
          wagerType: body.wagerType || '',
          betType: body.betType || '',
          tipo: body.tipo ?? body.activity ?? '-1',
          activity: body.activity,
          group: body.group || '',
          debug: body.debug ?? '0',
          agentOwner: body.agentOwner,
        });
        await scraperManager.persistAgentPerformanceReport(result);
        return result;
      }, corsHeaders);
    }
  }

  // Buckeye manager bootstrap/report payloads (config reports, sports, auth flags, messages)
  if (url.pathname === '/api/buckeye/manager-snapshot') {
    if (request.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      return handleAsync(async () => scraperManager.getBuckeyeManagerSnapshot(agentId), corsHeaders);
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        const api = new BuckeyeAPI(
          {
            agentId: body.agentId,
            password: body.password || '',
            baseUrl: body.baseUrl,
            cfCookie: body.cfCookie,
          },
          false
        );

        if (body.token) {
          resumeBuckeyeSession(api, String(body.token));
        } else {
          const ok = await api.login();
          if (!ok) {
            throw new Error('Login failed — invalid credentials or site unreachable');
          }
        }

        return api.getManagerSnapshot();
      }, corsHeaders);
    }
  }

  // Player-specific performance (getPerformancePlayer)
  if (url.pathname === '/api/buckeye/player-performance') {
    if (request.method === 'GET') {
      const acc = url.searchParams.get('acc') || '';
      const period = url.searchParams.get('period') || '0';
      const agentId = url.searchParams.get('agentId') || undefined;
      if (!acc) throw new Error('acc parameter is required');
      return handleAsync(async () => scraperManager.getBuckeyePlayerPerformance(acc, period, agentId), corsHeaders);
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        if (!body.acc) throw new Error('acc is required');
        return scraperManager.getBuckeyePlayerPerformance(body.acc, body.period ?? '0', body.agentId);
      }, corsHeaders);
    }
  }

  // Player-specific info snapshot (getInfoPlayer)
  if (url.pathname === '/api/buckeye/player-info') {
    if (request.method === 'GET') {
      const customerId = url.searchParams.get('customerId') || '';
      const agentId = url.searchParams.get('agentId') || undefined;
      if (!customerId) throw new Error('customerId parameter is required');
      return handleAsync(async () => scraperManager.getBuckeyePlayerInfo(customerId, agentId), corsHeaders);
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        if (!body.customerId) throw new Error('customerId is required');
        return scraperManager.getBuckeyePlayerInfo(body.customerId, body.agentId);
      }, corsHeaders);
    }
  }

  // Player-specific transaction ledger (getTransactionList)
  if (url.pathname === '/api/buckeye/player-transactions') {
    if (request.method === 'GET') {
      const customerId = url.searchParams.get('customerId') || '';
      const agentId = url.searchParams.get('agentId') || undefined;
      if (!customerId) throw new Error('customerId parameter is required');
      return handleAsync(async () => scraperManager.getBuckeyePlayerTransactions(customerId, agentId), corsHeaders);
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        if (!body.customerId) throw new Error('customerId is required');
        return scraperManager.getBuckeyePlayerTransactions(body.customerId, body.agentId);
      }, corsHeaders);
    }
  }

  if (url.pathname === '/api/buckeye/access-logs') {
    if (request.method === 'GET') {
      const limit = clampInt(url.searchParams.get('limit'), 200, 1, 500);
      return handleAsync(async () => scraperManager.getAccessLogs(limit), corsHeaders);
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        if (!body.agentId) throw new Error('agentId is required');
        return scraperManager.forceAccessLogRefresh(body.agentId);
      }, corsHeaders);
    }
  }

  // Buckeye web-log live proxy (getWebLog with actions parameter)
  if (url.pathname === '/api/buckeye/web-log' && request.method === 'GET') {
    let params: WebLogQuery;
    try {
      params = validateQuery(webLogQuerySchema, url);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return new Response(JSON.stringify(formatZodError(err)), { status: 400, headers: corsHeaders });
      }
      throw err;
    }

    return handleAsync(async () =>
      scraperManager.getWebLogLive({
        customerID: params.customerId || '',
        start: params.start,
        end: params.end,
        type: params.type,
        actions: params.actions,
        ip: params.ip || '',
      }, params.agentId),
      corsHeaders
    );
  }

  // Buckeye players list (getPlayers)
  if (url.pathname === '/api/buckeye/players-list' && request.method === 'GET') {
    const agentId = url.searchParams.get('agentId') || undefined;
    return handleAsync(async () => scraperManager.getBuckeyePlayersList(agentId), corsHeaders);
  }

  // Test Buckeye login (no polling — just validate credentials)
  if (url.pathname === '/api/connect' && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody(request);
      let validated: ConnectBody;
      try {
        validated = connectBodySchema.parse(body);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return new Response(JSON.stringify(formatZodError(err)), { status: 400, headers: corsHeaders });
        }
        throw err;
      }
      const api = new BuckeyeAPI(
        {
          agentId: validated.agentId,
          password: validated.password,
          baseUrl: validated.baseUrl,
          cfCookie: validated.cfCookie,
        },
        false
      );
      const ok = await api.login();
      if (!ok) {
        throw new Error('Login failed — invalid credentials or site unreachable');
      }
      // Try one getBetTicker to confirm data access
      const wagers = await api.getBetTicker();
      if (secretVault) {
        await secretVault.saveBuckeyeSecrets({
          agentId: validated.agentId,
          password: validated.password || undefined,
          cfCookie: api.getCookie() || validated.cfCookie || undefined,
          token: api.getToken(),
        });
      }
      const env = getEnv();
      const jwt = await createToken(validated.agentId, env.JWT_SECRET);
      return {
        success: true,
        message: 'Login successful',
        wagerCount: wagers.length,
        sample: wagers[0] || null,
        token: jwt,
      };
    }, corsHeaders);
  }

  // ========== PROXY-COMPATIBLE ROUTES (/api/proxy/*) ==========
  // These provide unified access via the backend server
  if (url.pathname.startsWith('/api/proxy/')) {
    return handleProxyCompatibleRoute(url, request, scraperManager, secretVault, corsHeaders);
  }

  return null;
}

function handleProxyCompatibleRoute(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager,
  secretVault: BunSecretVault | undefined,
  corsHeaders: Record<string, string>
): Response | Promise<Response> {
  const path = url.pathname.replace('/api/proxy/', '');

  // Get token from header or query
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '') || url.searchParams.get('token') || '';
  const cfClearance = request.headers.get('X-CF-Clearance') || url.searchParams.get('cf_clearance') || '';
  const customerID = url.searchParams.get('customerID') || '';

  // Helper to get authenticated API instance
  async function getAuthenticatedApi(agentId?: string): Promise<BuckeyeProxyApi> {
    const targetAgent = agentId || customerID;
    if (!targetAgent) {
      throw new Error('customerID required');
    }

    let apiToken = token;
    let apiCf = cfClearance;

    // Try to get from vault if not provided
    if ((!apiToken || !apiCf) && secretVault) {
      const secrets = await secretVault.getBuckeyeSecrets(targetAgent);
      if (secrets) {
        apiToken = secrets.token || apiToken;
        apiCf = secrets.cfCookie || apiCf;
      }
    }

    const api = new BuckeyeAPI({
      agentId: targetAgent,
      password: '',
      cfCookie: apiCf,
      baseUrl: getEnv().BUCKEYE_BASE_URL,
    }, false);

    if (apiToken) {
      resumeBuckeyeSession(api, apiToken);
    }

    return api as BuckeyeProxyApi;
  }

  // Route based on path
  if (path === 'status' && request.method === 'GET') {
    return new Response(JSON.stringify({
      service: 'Buckeye Proxy (via Backend)',
      version: '1.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }), { headers: corsHeaders });
  }

  if (path === 'endpoints' && request.method === 'GET') {
    return new Response(JSON.stringify({
      service: 'Buckeye Proxy via Backend',
      version: '1.0',
      endpoints: {
        proxy: {
          '/api/proxy/status': 'GET — Service status',
          '/api/proxy/endpoints': 'GET — This docs',
          '/api/proxy/tokens': 'GET — Token status for customerID',
        },
        manager: {
          '/api/proxy/Manager/getBetTicker': 'POST — Live wager feed (141+ wagers)',
          '/api/proxy/Manager/getAccountInfoOwner': 'POST — Account info & balance',
          '/api/proxy/Manager/getAgentPerformance': 'POST — Performance report with date range',
          '/api/proxy/Manager/getListAgenstByAgent': 'POST — Player list under agent',
          '/api/proxy/Manager/getListVip': 'POST — VIP player list',
          '/api/proxy/Manager/getAgentManagement': 'POST — Full agent hierarchy (2288+)',
          '/api/proxy/Manager/getWebLog': 'POST — Web access logs',
          '/api/proxy/Manager/getSportsType': 'POST — Available sports (19)',
          '/api/proxy/Manager/getAuthorizations': 'POST — Agent permissions',
          '/api/proxy/Manager/getConfigWebReports': 'POST — Report config',
          '/api/proxy/Manager/getMessage': 'POST — Agent messages',
          '/api/proxy/Manager/getNewEmailsCount': 'POST — Unread email count',
          '/api/proxy/Manager/getCryptoInfo': 'POST — Crypto cashier config',
          '/api/proxy/Manager/getCryptoAvailable': 'POST — Available crypto currencies',
          '/api/proxy/Manager/getBetTickerConfig': 'POST — Ticker display settings',
          '/api/proxy/Manager/getInfoPlayer': 'POST — Player info lookup',
          '/api/proxy/Manager/getReportPlayerAnalysis': 'POST — Player betting analysis',
          '/api/proxy/Manager/getEnterTransactions': 'POST — Player transaction history',
          '/api/proxy/Manager/getTeaserProfile': 'POST — Teaser profile settings',
          '/api/proxy/Manager/getConfigWebReportsCustomerAdmin': 'POST — Admin reports config',
        },
        system: {
          '/api/proxy/System/renewToken': 'POST — Renew JWT token',
        },
      },
    }), { headers: corsHeaders });
  }

  if (path === 'logs' && request.method === 'GET') {
    return new Response(JSON.stringify({ logs: [] }), { headers: corsHeaders });
  }

  // Manager/* endpoints (proxy style)
  if (path.startsWith('Manager/') && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody(request);
      const operation = body.operation || path.replace('Manager/', '');
      const api = await getAuthenticatedApi(body.agentID || body.customerID);

      const result = await callManagerOperation(api, operation, body);
      return { source: 'live', data: result };
    }, corsHeaders);
  }

  // System/* endpoints
  if (path.startsWith('System/') && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody(request);
      const operation = body.operation || path.replace('System/', '');
      const api = await getAuthenticatedApi(body.agentID || body.customerID);

      if (operation === 'renewToken') {
        const result = await api.renewToken();
        return { success: true, data: result };
      }
      throw new Error(`Unknown System operation: ${operation}`);
    }, corsHeaders);
  }

  return new Response(JSON.stringify({ error: 'Unknown proxy route' }), { status: 404, headers: corsHeaders });
}

async function callManagerOperation(
  api: BuckeyeProxyApi,
  operation: string,
  params: ProxyOperationParams
): Promise<unknown> {
  const agentId = api.getAgentId();
  const baseParams = { agentID: agentId, agentOwner: agentId, agentSite: '1' };

  const opMap: Record<string, Record<string, string>> = {
    getBetTicker: { operation: 'getBetTicker', ...baseParams },
    getBetTickerConfig: { operation: 'getBetTickerConfig', ...baseParams },
    getAccountInfoOwner: { operation: 'getAccountInfoOwner', ...baseParams },
    getAuthorizations: { operation: 'getAuthorizations', ...baseParams },
    getListAgenstByAgent: { operation: 'getListAgenstByAgent', ...baseParams },
    getListVip: { operation: 'getListVip', ...baseParams },
    getInfoPlayer: { operation: 'getInfoPlayer', playerLogin: String(params.playerLogin || ''), ...baseParams },
    getAgentManagement: { operation: 'getAgentManagement', ...baseParams },
    getConfigWebReports: { operation: 'getConfigWebReports', ...baseParams },
    getConfigWebReportsCustomerAdmin: { operation: 'getConfigWebReportsCustomerAdmin', ...baseParams },
    getWeeklyFigureByAgentLite: { operation: 'getWeeklyFigureByAgentLite', ...baseParams },
    getAgentPerformance: { operation: 'getAgentPerformance', ...baseParams, ...getPerformanceParams(params) },
    getReportPlayerAnalysis: { operation: 'getReportPlayerAnalysis', playerLogin: String(params.playerLogin || ''), ...baseParams },
    getEnterTransactions: { operation: 'getEnterTransactions', playerLogin: String(params.playerLogin || ''), ...baseParams },
    getSportsType: { operation: 'getSportsType', ...baseParams },
    getWebLog: { operation: 'getWebLog', ...baseParams, ...getWebLogParams(params) },
    getMessage: { operation: 'getMessage', ...baseParams },
    getMail: { operation: 'getMail', ...baseParams },
    getNewEmailsCount: { operation: 'getNewEmailsCount', ...baseParams },
    getCryptoInfo: { operation: 'getCryptoInfo', ...baseParams },
    getCryptoAvailable: { operation: 'getCryptoAvailable', ...baseParams },
    getTeaserProfile: { operation: 'getTeaserProfile', customerID: String(params.customerID || params.playerLogin || ''), ...baseParams },
  };

  const extra = opMap[operation];
  if (!extra) {
    throw new Error(`Unknown operation: ${operation}`);
  }

  return api.callManagerOperation(operation, extra);
}

function getPerformanceParams(params: ProxyOperationParams): Record<string, string> {
  const result: Record<string, string> = {};
  const start = stringParam(params, 'start', 'startDate') || '05/01/2026';
  const end = stringParam(params, 'end', 'endDate') || '05/10/2026';
  const type = stringParam(params, 'type') || 'CP';
  const freePlay = stringParam(params, 'freePlay') || 'Y';
  const store = stringParam(params, 'store', 'agentOwner');
  if (store) result.store = store;
  const sport = stringParam(params, 'sport');
  if (sport) result.sport = sport;
  const subsport = stringParam(params, 'subsport');
  if (subsport) result.subsport = subsport;
  result.period = stringParam(params, 'period') || '-1';
  const wagerType = stringParam(params, 'wagerType');
  if (wagerType) result.wagerType = wagerType;
  const betType = stringParam(params, 'betType');
  if (betType) result.betType = betType;
  result.tipo = stringParam(params, 'tipo', 'activity') || '-1';
  result.debug = stringParam(params, 'debug') || '0';
  const group = stringParam(params, 'group');
  if (group) result.group = group;
  result.start = start;
  result.end = end;
  result.type = type;
  result.freePlay = freePlay;
  return result;
}

function getWebLogParams(params: ProxyOperationParams): Record<string, string> {
  const result: Record<string, string> = {};
  const customerID = stringParam(params, 'customerID');
  if (customerID) result.customerID = customerID;
  const start = stringParam(params, 'start', 'startDate');
  if (start) result.start = start;
  const end = stringParam(params, 'end', 'endDate');
  if (end) result.end = end;
  result.type = webLogTypeParam(params.type);
  result.actions = stringParam(params, 'actions') || 'ALL';
  const ip = stringParam(params, 'ip');
  if (ip) result.ip = ip;
  return result;
}
function decorateVaultStatus(status: BuckeyeSecretStatus, scraperManager: BuckeyeScraperManager): BuckeyeSecretStatus & {
  active: boolean;
  lastError?: string;
} {
  const agentId = status.agentId || '';
  const active = agentId ? scraperManager.isAgentActive(agentId) : false;
  const lastError = agentId ? scraperManager.getAgentLastError(agentId) : undefined;
  return lastError ? { ...status, active, lastError } : { ...status, active };
}

function resumeBuckeyeSession(api: BuckeyeAPI, token: string): void {
  const resumable = api as ResumableBuckeyeAPI;
  resumable.token = token;
  resumable.loggedIn = true;
}

function stringParam(params: ProxyOperationParams, key: string, fallbackKey?: string): string {
  const value = params[key] ?? (fallbackKey ? params[fallbackKey] : undefined);
  return value === undefined || value === null ? '' : String(value);
}

function webLogTypeParam(value: ProxyOperationParams[string]): BuckeyeWebLogType {
  return value === 'B' || value === 'C' || value === 'I' ? value : 'A';
}

const BUCKEYE_AGENT_PERFORMANCE_OPTIONS = {
  requestFields: [
    {
      key: 'start',
      required: true,
      default: '7 days ago',
      example: '04/28/2026',
      meaning: 'Report start date in MM/DD/YYYY format.',
    },
    {
      key: 'end',
      required: true,
      default: 'today',
      example: '05/09/2026',
      meaning: 'Report end date in MM/DD/YYYY format.',
    },
    {
      key: 'agentID',
      alias: 'reportAgentId',
      required: true,
      default: 'connected agent',
      meaning: 'Agent/account the report is scoped to.',
    },
    {
      key: 'type',
      required: true,
      default: 'CP',
      valuesRef: 'reportTypes',
      meaning: 'Performance report mode.',
    },
    {
      key: 'freePlay',
      required: false,
      default: 'Y',
      values: [
        { value: 'Y', label: 'Include free play' },
        { value: 'N', label: 'Exclude free play' },
      ],
      meaning: 'Whether free-play figures are included.',
    },
    {
      key: 'store',
      required: false,
      default: 'agentID',
      meaning: 'Store/book context used by Buckeye, usually the same value as agentID.',
    },
    {
      key: 'sport',
      required: false,
      default: '',
      valuesRef: 'sports',
      meaning: 'Sport filter. Empty string means all sports.',
    },
    {
      key: 'subsport',
      required: false,
      default: '',
      example: 'NBA',
      meaning: 'League/subsport filter. Empty string means all subsports.',
    },
    {
      key: 'period',
      required: false,
      default: '-1',
      valuesRef: 'periods',
      meaning: 'Game period filter.',
    },
    {
      key: 'wagerType',
      required: false,
      default: '',
      valuesRef: 'wagerTypes',
      meaning: 'Ticket/wager construction filter. Empty string means all wager types.',
    },
    {
      key: 'betType',
      required: false,
      default: '',
      valuesRef: 'betTypes',
      meaning: 'Market filter. Empty string means all bet types.',
    },
    {
      key: 'tipo',
      alias: 'activity',
      required: false,
      default: '-1',
      valuesRef: 'activities',
      meaning: 'Activity vertical filter. Buckeye calls this field tipo; activity is our friendly alias.',
    },
    {
      key: 'debug',
      required: false,
      default: '0',
      meaning: 'Buckeye debug flag. Keep 0 for normal use.',
    },
    {
      key: 'operation',
      required: true,
      default: 'getAgentPerformance',
      meaning: 'Buckeye operation name. The backend sets this automatically.',
    },
    {
      key: 'RRO',
      required: true,
      default: '1',
      meaning: 'Buckeye request flag. The backend sets this automatically.',
    },
    {
      key: 'agentOwner',
      required: false,
      default: 'connected agent',
      meaning: 'Owner/master account sent to Buckeye. Override only when the UI session requires a different owner.',
    },
    {
      key: 'agentSite',
      required: true,
      default: '1',
      meaning: 'Buckeye site id. The backend sets this automatically.',
    },
    {
      key: 'group',
      required: false,
      default: '',
      valuesRef: 'groups',
      meaning: 'Optional grouping mode from the Buckeye UI.',
    },
    {
      key: 'week',
      required: false,
      default: 'enter-dates',
      valuesRef: 'weekPresets',
      meaning: 'Convenience preset we translate into start/end before calling Buckeye.',
    },
  ],
  reportTypes: [
    { value: 'CP', label: 'Customer Performance' },
    { value: 'CPS', label: 'Sport Performance' },
    { value: 'CPV', label: 'Customer Volume' },
    { value: 'G', label: 'Graded Wagers' },
  ],
  activities: [
    { value: '-1', label: 'All Action' },
    { value: '0', label: 'Sports' },
    { value: '1', label: 'LV Digital Casino' },
    { value: '5', label: 'Poker' },
    { value: '2', label: 'Racebook' },
    { value: '3', label: 'Live Casino' },
    { value: '4', label: 'Live Betting' },
    { value: '6', label: 'Prop Builder' },
    { value: '7', label: 'Soccer 365' },
    { value: '8', label: 'Flash Bet' },
    { value: '9', label: 'Extended Props' },
    { value: '10', label: 'Crash' },
    { value: '11', label: 'Fantasy' },
    { value: '12', label: 'AC Digital Casino' },
  ],
  groups: [
    { value: '1', label: 'Group Agent' },
    { value: '2', label: 'Sorting Columns' },
  ],
  weekPresets: [
    { value: '-1', label: 'Today' },
    { value: '0', label: 'This Week' },
    { value: '1', label: 'Last Week' },
    { value: 'enter-dates', label: 'Entered Dates' },
  ],
  sports: [
    'Auto Racing         ',
    'Baseball            ',
    'Basketball          ',
    'Boxing              ',
    'Cricket             ',
    'Entertainment       ',
    'Esports             ',
    'Football            ',
    'Golf                ',
    'Hockey              ',
    'Horse Racing        ',
    'LIVE                ',
    'Martial Arts        ',
    'Olympics            ',
    'Other               ',
    'Rugby               ',
    'Soccer              ',
    'Tennis              ',
    'Virtual Sports      ',
  ].map((rawValue) => ({ value: rawValue.trim(), label: rawValue.trim(), rawValue })),
  wagerTypes: [
    { value: '-1', label: 'All Wager Types' },
    { value: 'S', label: 'Straights' },
    { value: 'P', label: 'Parlays' },
    { value: 'T', label: 'Teasers' },
    { value: 'I', label: 'If-Bets / Action Reverses' },
    { value: 'C', label: 'Contests' },
    { value: 'A', label: 'Manual Plays' },
  ],
  betTypes: [
    { value: '-1', label: 'All' },
    { value: 'S', label: 'Spread' },
    { value: 'M', label: 'Money Line' },
    { value: 'L', label: 'Total' },
    { value: 'E', label: 'Team Total' },
  ],
  periods: [
    { value: '-1', label: 'All Periods' },
    { value: '0', label: 'Game' },
    { value: '1', label: '1st Half' },
    { value: '2', label: '2nd Half' },
    { value: '3', label: '1st Qtr' },
    { value: '4', label: '2nd Qtr' },
    { value: '5', label: '3rd Qtr' },
    { value: '6', label: '4th Qtr' },
  ],
};

function resolveReportPreset(week: unknown, start?: string | null, end?: string | null): { start: string; end: string } {
  if (week === 'enter-dates' || week === undefined || week === null || week === '') {
    return {
      start: start || defaultReportStartDate(),
      end: end || defaultReportEndDate(),
    };
  }

  const today = new Date();
  const weekValue = String(week);
  if (weekValue === '-1') {
    const formatted = formatReportDate(today);
    return { start: formatted, end: formatted };
  }

  const currentWeekStart = startOfWeek(today);
  const currentWeekEnd = endOfWeek(currentWeekStart);
  if (weekValue === '0') {
    return { start: formatReportDate(currentWeekStart), end: formatReportDate(currentWeekEnd) };
  }
  if (weekValue === '1') {
    const lastWeekStart = new Date(currentWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);
    const lastWeekEnd = endOfWeek(lastWeekStart);
    return { start: formatReportDate(lastWeekStart), end: formatReportDate(lastWeekEnd) };
  }

  return {
    start: start || defaultReportStartDate(),
    end: end || defaultReportEndDate(),
  };
}

function defaultReportEndDate(): string {
  return formatReportDate(new Date());
}

function defaultReportStartDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return formatReportDate(date);
}

function formatReportDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${date.getFullYear()}`;
}

function startOfWeek(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function endOfWeek(start: Date): Date {
  const result = new Date(start);
  result.setDate(result.getDate() + 6);
  return result;
}
