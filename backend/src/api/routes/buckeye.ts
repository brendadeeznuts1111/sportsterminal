/**
 * Buckeye-specific routes: UI config, account info, weekly figures, connect test
 */
import { clampInt, readJsonBody, handleAsync, corsHeaders } from '../helpers';
import { BuckeyeAPI } from '../../scrapers/BuckeyeAPI';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import type { BuckeyeSecretStatus, BunSecretVault } from '../../services/BunSecretVault';

export function registerBuckeyeRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager,
  secretVault?: BunSecretVault
): Response | null {
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
          (api as any).token = body.token;
          (api as any).loggedIn = true;
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
          (api as any).token = body.token;
          (api as any).loggedIn = true;
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
          (api as any).token = body.token;
          (api as any).loggedIn = true;
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
          (api as any).token = body.token;
          (api as any).loggedIn = true;
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
          (api as any).token = body.token;
          (api as any).loggedIn = true;
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

  // Test Buckeye login (no polling — just validate credentials)
  if (url.pathname === '/api/connect' && request.method === 'POST') {
    return handleAsync(async () => {
      const body = await readJsonBody(request);
      const api = new BuckeyeAPI(
        {
          agentId: body.agentId,
          password: body.password,
          baseUrl: body.baseUrl,
          cfCookie: body.cfCookie,
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
          agentId: body.agentId,
          password: body.password || undefined,
          cfCookie: api.getCookie() || body.cfCookie || undefined,
          token: api.getToken(),
        });
      }
      return {
        success: true,
        message: 'Login successful',
        wagerCount: wagers.length,
        sample: wagers[0] || null,
      };
    }, corsHeaders);
  }

  return null;
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
