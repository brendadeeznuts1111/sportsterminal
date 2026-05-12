// backend/src/lib/proxyClient.ts — Unified Proxy Client v3
// Reuses the validated CONFIG from root config.ts.
// Provides typed wrappers for all 68+ proxy endpoints.

import { CONFIG } from '../../../config';
import { parseJsonOrText } from '../utils/parseJson';
import {
  type ProxyCredentialProvider,
  type EnhancedProxyCredentials,
  type ProxyCallOptions,
  ProxyClientError,
  extractBuckeyeCookies,
} from '../services/ProxyClient';

// ==========================================
// TYPES
// ==========================================

export type { ProxyCredentialProvider, EnhancedProxyCredentials, ProxyCallOptions };
export { ProxyClientError, extractBuckeyeCookies };

export interface ProxyClientConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retries: number;
  retryBackoffMs: number;
  fetchProxyUrl?: string;
  fetchProxyToken?: string;
}

type BunProxyOption = string | {
  url: string;
  headers?: Record<string, string>;
};

type ProxyFetchInit = RequestInit & {
  proxy?: BunProxyOption;
};

// Generic JSON response shape used by most proxy endpoints
export interface ProxyResponse<T = unknown> {
  source: string;
  data: T;
  cached_at?: number;
  stale?: boolean;
}

// ==========================================
// CONFIG BUILDER (root CONFIG)
// ==========================================

function buildClientConfig(): ProxyClientConfig {
  return {
    baseUrl: (Bun.env.PROXY_INTERNAL_URL || CONFIG.backendUrl || 'http://localhost:3001').replace(/\/$/, ''),
    apiKey: Bun.env.PROXY_API_KEY || CONFIG.apiKey || '',
    timeoutMs: 30000,
    retries: CONFIG.maxRetries || 3,
    retryBackoffMs: CONFIG.retryBaseMs || 1000,
    fetchProxyUrl: Bun.env.PROXY_FETCH_PROXY_URL?.trim() || undefined,
    fetchProxyToken: Bun.env.PROXY_FETCH_PROXY_TOKEN?.trim() || undefined,
  };
}

// ==========================================
// INTERNAL FETCH WITH TIMEOUT + RETRY
// ==========================================

async function fetchWithRetry(
  url: string,
  options: ProxyFetchInit,
  cfg: ProxyClientConfig
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let lastError: unknown;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: controller.signal } as ProxyFetchInit);
      if (res.status < 500 || attempt === cfg.retries) {
        clearTimeout(timeout);
        return res;
      }
      lastError = new ProxyClientError(
        `Proxy upstream 5xx (attempt ${attempt + 1}/${cfg.retries + 1})`,
        res.status,
        null
      );
    } catch (err) {
      lastError = err;
      if (attempt === cfg.retries) {
        clearTimeout(timeout);
        throw err;
      }
    }
    if (attempt < cfg.retries) {
      await new Promise((r) => setTimeout(r, cfg.retryBackoffMs * (attempt + 1)));
    }
  }
  clearTimeout(timeout);
  throw lastError;
}

function withProxyFetchHeaders(options: RequestInit, cfg: ProxyClientConfig): ProxyFetchInit {
  if (!cfg.fetchProxyUrl) return options;

  const proxyToken = cfg.fetchProxyToken || cfg.apiKey;
  return {
    ...options,
    proxy: {
      url: cfg.fetchProxyUrl,
      headers: {
        'X-API-Key': cfg.apiKey,
        ...(proxyToken ? { 'Proxy-Authorization': `Bearer ${proxyToken}` } : {}),
      },
    },
  };
}

function parsePayload(text: string): unknown {
  if (!text) return null;
  return parseJsonOrText(text);
}

// ==========================================
// CORE CALL FUNCTION
// ==========================================

export async function proxyClientCall<T = unknown>(
  credentialProvider: ProxyCredentialProvider,
  opts: ProxyCallOptions & { cfg?: ProxyClientConfig }
): Promise<T> {
  const cfg = opts.cfg || buildClientConfig();
  const method = opts.method || 'POST';
  const body = { ...(opts.body || {}) };
  const includeBuckeyeAuth = opts.includeBuckeyeAuth !== false;

  if (includeBuckeyeAuth) {
    const credentials = await credentialProvider.getEnhancedProxyCredentials(
      opts.agentId || String(body.agentID || body.customerID || '')
    );
    const token = String(body.token || credentials?.token || '');
    const cfClearance = String(body.cf_clearance || body.cfClearance || credentials?.cf_clearance || '');
    const cfBm = String(body.__cf_bm || body.cf_bm || body.cfBm || credentials?.__cf_bm || '');

    if (!token || !cfClearance) {
      throw new ProxyClientError(
        'No Buckeye token/cf_clearance available for proxy call',
        401,
        { endpoint: opts.endpoint }
      );
    }
    body.token = token;
    body.cf_clearance = cfClearance;
    if (cfBm) body.__cf_bm = cfBm;
  }

  const response = await fetchWithRetry(
    `${cfg.baseUrl}${opts.endpoint}`,
    withProxyFetchHeaders({
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-API-Key': cfg.apiKey,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    }, cfg),
    cfg
  );

  const text = await response.text();
  const payload = parsePayload(text);

  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : response.statusText || 'Proxy error';
    throw new ProxyClientError(
      `Proxy ${opts.endpoint} failed: ${detail}`,
      response.status,
      payload
    );
  }

  return payload as T;
}

// ==========================================
// PROXY CLIENT CLASS (all 68+ endpoints)
// ==========================================

export class ProxyClient {
  private cfg: ProxyClientConfig;

  constructor(
    private provider: ProxyCredentialProvider,
    cfg?: Partial<ProxyClientConfig>
  ) {
    this.cfg = { ...buildClientConfig(), ...cfg };
  }

  // --- Generic call ---
  async call<T>(endpoint: string, body?: Record<string, unknown>, agentId?: string): Promise<T> {
    return proxyClientCall<T>(this.provider, {
      endpoint,
      body,
      agentId,
      cfg: this.cfg,
    });
  }

  async callGet<T>(endpoint: string, agentId?: string): Promise<T> {
    return proxyClientCall<T>(this.provider, {
      endpoint,
      method: 'GET',
      includeBuckeyeAuth: false,
      agentId,
      cfg: this.cfg,
    });
  }

  // ==========================================
  // 1. PROXY ALIASES (cached via proxy SWR)
  // ==========================================

  async agentDownline(agentID: string) {
    return this.call<ProxyResponse>('/api/proxy/agentDownline', { agentID }, agentID);
  }

  async agentBilling(agentID: string, week = '0') {
    return this.call<ProxyResponse>('/api/proxy/agentBilling', { agentID, week }, agentID);
  }

  async playerInfo(playerID: string, agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/playerInfo', { playerID, agentID }, agentID);
  }

  async dynamicLive(agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/dynamicLive', { agentID }, agentID);
  }

  async sportsLeagues(agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/sportsLeagues', { agentID }, agentID);
  }

  async leagueLines(league: string, sport: string, agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/leagueLines', { league, sport, agentID }, agentID);
  }

  async gameVolume(gameId: string, agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/gameVolume', { gameId, agentID }, agentID);
  }

  async pending(date: string, agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/pending', { date, agentID }, agentID);
  }

  async betTicker(agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/betTicker', { agentID }, agentID);
  }

  async liveTicker(agentID?: string) {
    const query = agentID ? `?customerID=${encodeURIComponent(agentID)}` : '';
    return this.callGet<ProxyResponse>(`/api/live/ticker${query}`, agentID);
  }

  async scoresLive(agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/scoresLive', { agentID }, agentID);
  }

  async sportsTypesLive(agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/sportsTypesLive', { agentID }, agentID);
  }

  async liveGame(agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/liveGame', { agentID }, agentID);
  }

  async pendingReportConfig(agentID: string) {
    return this.call<ProxyResponse>('/api/proxy/pendingReportConfig', { agentID }, agentID);
  }

  async updatePendingReportConfig(agentID: string, config: Record<string, string>) {
    return this.call<ProxyResponse>('/api/proxy/updatePendingReportConfig', { agentID, ...config }, agentID);
  }

  // ==========================================
  // 2. MANAGER OPERATIONS (direct Buckeye passthrough)
  // ==========================================

  async manager<T = unknown>(operation: string, body: Record<string, unknown>) {
    return this.call<T>(`/api/proxy/Manager/${operation}`, body, String(body.agentID || body.customerID || ''));
  }

  async getAccountInfoOwner(agentID: string) {
    return this.manager<ProxyResponse>('getAccountInfoOwner', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getInfoPlayer(playerLogin: string, agentID: string) {
    return this.manager<ProxyResponse>('getInfoPlayer', { playerLogin, agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getBetTicker(agentID: string) {
    return this.manager<ProxyResponse>('getBetTicker', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getAgentPerformance(agentID: string, startDate?: string, endDate?: string) {
    return this.manager<ProxyResponse>('getAgentPerformance', {
      agentID, agentOwner: agentID, agentSite: '1',
      startDate: startDate || '', endDate: endDate || '', type: 'CP', RRO: '1',
    });
  }

  async getListAgenstByAgent(agentID: string) {
    return this.manager<ProxyResponse>('getListAgenstByAgent', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getAgentBilling(agentID: string, week = '0') {
    return this.manager<ProxyResponse>('getAgentBilling', { agentID, agentOwner: agentID, agentSite: '1', week });
  }

  async getAgentManagement(agentID: string) {
    return this.manager<ProxyResponse>('getAgentManagement', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getListVip(agentID: string) {
    return this.manager<ProxyResponse>('getListVip', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getSportsType(agentID: string) {
    return this.manager<ProxyResponse>('getSportsType', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getAuthorizations(agentID: string) {
    return this.manager<ProxyResponse>('getAuthorizations', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getConfigWebReports(agentID: string) {
    return this.manager<ProxyResponse>('getConfigWebReports', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getConfigWebReportsPending(agentID: string) {
    return this.manager<ProxyResponse>('getConfigWebReportsPending', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async updateReportConfigPending(agentID: string, toggles: Record<string, string>) {
    return this.manager<ProxyResponse>('updateReportConfigPending', { agentID, agentOwner: agentID, agentSite: '1', ...toggles });
  }

  async getMessage(agentID: string) {
    return this.manager<ProxyResponse>('getMessage', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getNewEmailsCount(agentID: string) {
    return this.manager<ProxyResponse>('getNewEmailsCount', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getCryptoInfo(agentID: string) {
    return this.manager<ProxyResponse>('getCryptoInfo', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getCryptoAvailable(agentID: string) {
    return this.manager<ProxyResponse>('getCryptoAvailable', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getBetTickerConfig(agentID: string) {
    return this.manager<ProxyResponse>('getBetTickerConfig', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getReportPlayerAnalysis(playerLogin: string, agentID: string) {
    return this.manager<ProxyResponse>('getReportPlayerAnalysis', { playerLogin, agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getEnterTransactions(playerLogin: string, agentID: string) {
    return this.manager<ProxyResponse>('getEnterTransactions', { playerLogin, agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getTeaserProfile(agentID: string) {
    return this.manager<ProxyResponse>('getTeaserProfile', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getSportsCustomerAdmin(agentID: string) {
    return this.manager<ProxyResponse>('getSportsCustomerAdmin', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getSportsVigSetup(agentID: string) {
    return this.manager<ProxyResponse>('getSportsVigSetup', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getSportsMaxWager(agentID: string) {
    return this.manager<ProxyResponse>('getSportsMaxWager', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getColorsSelections(agentID: string) {
    return this.manager<ProxyResponse>('getColorsSelections', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getStores(agentID: string) {
    return this.manager<ProxyResponse>('getStores', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getCircleLimits(agentID: string) {
    return this.manager<ProxyResponse>('getCircleLimits', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getOpenBets(agentID: string) {
    return this.manager<ProxyResponse>('getOpenBets', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getPending(date: string, agentID: string) {
    return this.manager<ProxyResponse>('getPending', { date, agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getWebLog(agentID: string, start: string, end: string, type = 'A') {
    return this.manager<ProxyResponse>('getWebLog', { agentID, customerID: agentID, start, end, type, actions: 'ALL', RRO: '1' });
  }

  async getWeeklyFigureByAgentLite(agentID: string, startDate: string, endDate: string) {
    return this.manager<ProxyResponse>('getWeeklyFigureByAgentLite', { agentID, agentOwner: agentID, agentSite: '1', startDate, endDate });
  }

  async getGames(sport: string) {
    return this.manager<ProxyResponse>('getGames', { sport, RRO: '1' });
  }

  async getGameVolume(gameId: string) {
    return this.manager<ProxyResponse>('getGameVolume', { gameId, RRO: '1' });
  }

  async getDynamicLive(agentID: string) {
    return this.manager<ProxyResponse>('getDynamicLive', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getSportsTypesLive(agentID: string) {
    return this.manager<ProxyResponse>('getSportsTypesLive', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getProps(agentID: string) {
    return this.manager<ProxyResponse>('getProps', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  async getExtendedProps(agentID: string) {
    return this.manager<ProxyResponse>('getExtendedProps', { agentID, agentOwner: agentID, agentSite: '1' });
  }

  // ==========================================
  // 3. SYSTEM OPERATIONS
  // ==========================================

  async system<T = unknown>(operation: string, body: Record<string, unknown>) {
    return this.call<T>(`/api/proxy/System/${operation}`, body, String(body.agentID || body.customerID || ''));
  }

  async authenticateCustomer(customerID: string, password: string, cf_clearance: string) {
    return this.system<ProxyResponse>('authenticateCustomer', { customerID, password, cf_clearance });
  }

  async renewToken(agentID: string) {
    return this.system<ProxyResponse>('renewToken', { operation: 'renewToken', agentID, agentOwner: agentID, agentSite: '1' });
  }

  // ==========================================
  // 4. REPORT OPERATIONS
  // ==========================================

  async report<T = unknown>(operation: string, body: Record<string, unknown>) {
    return this.call<T>(`/api/proxy/Report/${operation}`, body, String(body.agentID || body.customerID || ''));
  }

  async getScoresLiveDynamic() {
    return this.report<ProxyResponse>('getScoresLiveDynamic', { RRO: '1' });
  }

  // ==========================================
  // 5. TAXONOMY / LINES
  // ==========================================

  async taxonomy(level: string, params: Record<string, unknown> = {}) {
    return this.call<ProxyResponse>(`/api/proxy/taxonomy/${encodeURIComponent(level)}`, params);
  }

  async getSportsLeagues() {
    return this.call<ProxyResponse>('/api/proxy/sportsLeagues', { RRO: '1' });
  }

  async getLeagueLines2(league: string, sport: string) {
    return this.call<ProxyResponse>('/api/proxy/leagueLines', { league, sport, RRO: '1' });
  }

  async getLinesPlusData() {
    return this.call<ProxyResponse>('/api/proxy/linesPlus', { RRO: '1' });
  }

  async getBuyPointsGroup() {
    return this.call<ProxyResponse>('/api/proxy/buyPoints', { RRO: '1' });
  }

  async getAmountLimitGroup() {
    return this.call<ProxyResponse>('/api/proxy/amountLimits', { RRO: '1' });
  }

  async getPeriodsBySport(sport: string) {
    return this.call<ProxyResponse>('/api/proxy/periodsBySport', { sport, RRO: '1' });
  }

  async getPropBuilderURL() {
    return this.call<ProxyResponse>('/api/proxy/propBuilderURL', { RRO: '1' });
  }

  // ==========================================
  // 6. ANALYTICS & RISK
  // ==========================================

  async analyticsSyndicates(agentID: string, lookbackHours = 24, minBettors = 2, minStake = 1000) {
    return this.call<ProxyResponse>('/api/proxy/analytics/syndicates', { agentID, lookbackHours, minBettors, minStake }, agentID);
  }

  async analyticsSharpMoney(agentID: string, gameId?: string, minutesBefore = 60) {
    return this.call<ProxyResponse>('/api/proxy/analytics/sharp-money', { agentID, gameId, minutesBefore }, agentID);
  }

  async analyticsEvSimulation(agentID: string, bettorID?: string, lookbackDays = 30) {
    return this.call<ProxyResponse>('/api/proxy/analytics/ev-simulation', { agentID, bettorID, lookbackDays }, agentID);
  }

  async analyticsPredictiveSharpness(agentID: string, bettorID?: string, lookbackDays = 30) {
    return this.call<ProxyResponse>('/api/proxy/analytics/predictive-sharpness', { agentID, bettorID, lookbackDays }, agentID);
  }

  async analyticsBacktest(agentID: string, days = 30) {
    return this.call<ProxyResponse>('/api/proxy/analytics/backtest', { agentID, days }, agentID);
  }

  async riskAlerts(agentID: string, thresholds: Record<string, unknown>, webhookUrl?: string) {
    return this.call<ProxyResponse>('/api/proxy/risk/alerts', { agentID, thresholds, webhookUrl }, agentID);
  }

  async riskConfig(agentID: string) {
    return this.call<ProxyResponse>('/api/proxy/risk/config', { agentID }, agentID);
  }

  async riskSyndicates(agentID: string, since?: string) {
    return this.call<ProxyResponse>('/api/proxy/risk/syndicates', { agentID, since }, agentID);
  }

  // ==========================================
  // 7. LINE RULES
  // ==========================================

  async lineRules(agentID?: string) {
    return this.call<ProxyResponse>('/api/proxy/line-rules', { agentID });
  }

  async lineAdjustmentLog(gameId?: string, since?: string, limit = 100) {
    return this.call<ProxyResponse>('/api/proxy/line-adjustments/log', { gameId, since, limit });
  }

  // ==========================================
  // 8. ADMIN / UTILITY
  // ==========================================

  async proxyStatus() {
    return this.call<Record<string, unknown>>('/api/proxy/status', {}, undefined);
  }

  async proxyEndpoints() {
    return this.call<Record<string, unknown>>('/api/proxy/endpoints', {}, undefined);
  }

  async proxyTokens(customerID: string) {
    return this.call<ProxyResponse>('/api/proxy/tokens', { customerID });
  }

  async proxyLogs() {
    return this.call<Record<string, unknown>>('/api/proxy/logs', {}, undefined);
  }

  async agentHeatmap(agentID: string, days = 30) {
    return this.call<ProxyResponse>('/api/proxy/agent/heatmap', { agentID, days }, agentID);
  }

  async integrityCases(agentID: string, status?: string, limit = 100) {
    return this.call<ProxyResponse>('/api/proxy/integrity/cases', { agentID, status, limit }, agentID);
  }
}

// ==========================================
// FACTORY
// ==========================================

export function createProxyClient(
  provider: ProxyCredentialProvider,
  cfg?: Partial<ProxyClientConfig>
): ProxyClient {
  return new ProxyClient(provider, cfg);
}
