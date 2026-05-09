/**
 * BuckeyeAPI.ts
 * HTTP client for fantasy402.com Qubic/Buckeye PPH platform.
 *
 * Real endpoint discovered from browser cURL:
 * - POST /cloud/api/Manager/getBetTicker
 * - Auth: Bearer JWT
 * - Required cookies: cf_clearance, __cf_bm (Cloudflare)
 * - Required fields: agentID, agentOwner, agentSite=1, operation, RRO=1, wagerNumber
 */

import type { EnrichedWager } from '../risk/AlertEngine';

export interface BuckeyeCredentials {
  agentId: string;
  password: string;
  baseUrl?: string;
  cfCookie?: string; // cf_clearance from browser DevTools
  token?: string; // Pre-authenticated JWT token (from vault or browser)
}

export interface WagerChange {
  type: 'new' | 'updated';
  wager: EnrichedWager;
}

export interface BuckeyeUiString {
  path: string;
  key: string;
  value: string;
}

export interface BuckeyeBetTypeLabel {
  code?: string;
  label: string;
  path: string;
}

export interface BuckeyeFeatureFlag {
  path: string;
  key: string;
  value: boolean;
}

export interface ParsedBuckeyeUiConfig {
  betTypes: BuckeyeBetTypeLabel[];
  featureFlags: BuckeyeFeatureFlag[];
  sportsbookStrings: BuckeyeUiString[];
}

export interface BuckeyeUiConfigResult {
  url: string;
  fetchedAt: string;
  agentId: string;
  parsed: ParsedBuckeyeUiConfig;
  config?: unknown;
}

export interface BuckeyeWeeklyFigureOptions {
  week?: number;
  type?: string;
  layout?: string;
}

export interface BuckeyeWeeklyFigureResult {
  fetchedAt: string;
  agentId: string;
  params: {
    week: number;
    type: string;
    layout: string;
  };
  parsed: {
    thisWeek: number;
    active: number;
    today: number;
    info: string;
  };
  data: unknown;
}

export interface BuckeyeAgentPerformanceOptions {
  start: string;
  end: string;
  agentID?: string;
  type?: string;
  freePlay?: string;
  store?: string;
  sport?: string;
  subsport?: string;
  period?: string | number;
  wagerType?: string;
  betType?: string;
  tipo?: string | number;
  activity?: string | number;
  group?: string | number;
  debug?: string | number;
  agentOwner?: string;
}

export interface BuckeyeAgentPerformanceRow {
  customerId: string;
  agentId: string;
  login: string;
  wagerCount: number;
  risk: number;
  toWin: number;
  amountWon: number;
  amountLost: number;
  volume: number;
  net: number;
}

export interface BuckeyeAgentPerformanceResult {
  fetchedAt: string;
  agentId: string;
  params: {
    start: string;
    end: string;
    agentID: string;
    type: string;
    freePlay: string;
    store: string;
    sport: string;
    subsport: string;
    period: string;
    wagerType: string;
    betType: string;
    tipo: string;
    debug: string;
    operation: string;
    RRO: string;
    agentOwner: string;
    agentSite: string;
    group: string;
  };
  parsed: {
    rows: BuckeyeAgentPerformanceRow[];
    totals: {
      wagerCount: number;
      risk: number;
      toWin: number;
      amountWon: number;
      amountLost: number;
      volume: number;
      net: number;
    };
  };
  data: unknown;
  redactedFields: string[];
}

export interface BuckeyePlayerPerformanceOptions {
  acc?: string;
  period?: string | number;
  agentID?: string;
  agentOwner?: string;
}

export interface BuckeyeDepositRow {
  id: string;
  customerId: string;
  login: string;
  agentId: string;
  agentLogin: string;
  amount: number;
  currency: string;
  method: string;
  ipAddress: string;
  status: string;
  transactionTime: string;
  raw: Record<string, unknown>;
}

export interface BuckeyeDepositsResult {
  fetchedAt: string;
  agentId: string;
  customerId: string;
  operation?: string;
  rows: BuckeyeDepositRow[];
  data?: unknown;
  unavailable?: string;
}

export type BuckeyeTransactionCategory =
  | 'deposit'
  | 'withdrawal'
  | 'wager_win'
  | 'wager_loss'
  | 'credit'
  | 'debit'
  | 'hold'
  | 'adjustment'
  | 'freeplay_issued'
  | 'freeplay_redeemed'
  | 'freeplay_expired'
  | 'freeplay_adjustment'
  | 'other';

export interface BuckeyeTransactionRow {
  id: string;
  customerId: string;
  login: string;
  agentId: string;
  agentLogin: string;
  documentNumber: string;
  tranCode: string;
  tranType: string;
  amount: number;
  balance: number;
  holdAmount: number;
  gradeNum: string;
  description: string;
  enteredBy: string;
  category: BuckeyeTransactionCategory;
  transactionTime: string;
  raw: Record<string, unknown>;
}

export interface BuckeyeTransactionListResult {
  fetchedAt: string;
  agentId: string;
  customerId: string;
  operation: 'getTransactionList' | 'getTransactionHistory' | 'getReportDeletedTransactions';
  rows: BuckeyeTransactionRow[];
  data?: unknown;
}

export interface BuckeyeCustomerSnapshot {
  customerId: string;
  login: string;
  agentId: string;
  agentLogin: string;
  kycLevel: string;
  vipStatus: string;
  emailMasked: string;
  phoneMasked: string;
  currency: string;
  source: string;
  raw: Record<string, unknown>;
}

export interface BuckeyeCustomerSnapshotResult {
  fetchedAt: string;
  agentId: string;
  customerId: string;
  operation?: string;
  snapshot?: BuckeyeCustomerSnapshot;
  data?: unknown;
  unavailable?: string;
}

export type BuckeyeKnownManagerOperation =
  | 'getConfigWebReports'
  | 'getConfigWebReportsPending'
  | 'getSportsType'
  | 'getAuthorizations'
  | 'getMessage'
  | 'getNewEmailsCount';

export type BuckeyeManagerOperation = BuckeyeKnownManagerOperation | (string & {});

export interface BuckeyeManagerSnapshotResult {
  fetchedAt: string;
  agentId: string;
  configWebReports: unknown;
  configWebReportsPending: unknown;
  sportsType: unknown;
  authorizations: unknown;
  message: unknown;
  newEmailsCount: unknown;
}

export interface BuckeyeLogWriteResult {
  fetchedAt: string;
  agentId: string;
  data: unknown;
}

export type BuckeyeWebLogType = 'A' | 'B' | 'C' | 'I';

export interface BuckeyeWebLogOptions {
  customerID?: string | number;
  start: string;
  end: string;
  type: BuckeyeWebLogType;
  actions?: string;
  ip?: string;
}

export interface BuckeyeWebLogRow {
  LoginID: string;
  IPAddress: string;
  AccessDateTime: string;
  Operation: string;
  Data: string;
  raw: Record<string, unknown>;
}

export interface BuckeyeAccountFeatureFlag {
  key: string;
  value: boolean;
  raw: string | null;
}

export interface ParsedBuckeyeAccountInfo {
  accountId: string;
  login: string;
  agentType: string;
  office: string;
  skin: string;
  defaultSiteSkin: string;
  theme: string;
  language: string;
  currency: string;
  timezone: number | null;
  balances: {
    current: number;
    available: number;
    pendingWager: number;
    freePlay: number;
  };
  limits: Record<string, number>;
  featureFlags: BuckeyeAccountFeatureFlag[];
}

export interface BuckeyeAccountInfoResult {
  fetchedAt: string;
  agentId: string;
  parsed: ParsedBuckeyeAccountInfo;
  accountInfo: Record<string, unknown>;
  preferenceDate: unknown[];
  site: unknown[];
  server: unknown;
  redactedFields: string[];
}

interface LoginResponse {
  code?: string;
  token?: string;
  accountInfo?: {
    customerID?: string;
    AgentType?: string;
    Login?: string;
  };
}

export class BuckeyeAPI {
  private baseUrl: string;
  private agentId: string;
  private password: string;
  private cfCookie: string;
  token: string = '';
  private lastWagers: Map<number, EnrichedWager> = new Map();
  loggedIn: boolean = false;
  private debugMode: boolean;
  private lastWagerNumber: number = 0;

  constructor(credentials: BuckeyeCredentials, debugMode: boolean = false) {
    this.baseUrl = credentials.baseUrl?.replace(/\/$/, '') || 'https://fantasy402.com';
    this.agentId = credentials.agentId.toUpperCase().trim();
    this.password = credentials.password;
    this.cfCookie = credentials.cfCookie || '';
    this.debugMode = debugMode;

    // If a pre-authenticated token is provided, use it directly
    if (credentials.token) {
      this.token = credentials.token;
      this.loggedIn = true;
      this.log('Using pre-authenticated token from vault');
    }
  }

  /**
   * Inject a live token (e.g. captured from browser session) without re-authenticating.
   */
  setToken(token: string): void {
    this.token = token;
    this.loggedIn = true;
    this.log('Token injected via setToken()');
  }

  private log(...args: any[]) {
    if (this.debugMode) console.log('[BuckeyeAPI]', ...args);
  }

  /**
   * Build Cookie header from stored cf_clearance + any session cookies.
   */
  private getCookieHeader(): string {
    const parts: string[] = [];
    if (this.cfCookie) {
      parts.push(this.cfCookie);
    }
    return parts.join('; ');
  }

  /**
   * Authenticate with the Qubic login endpoint.
   * Returns a Bearer token in the response JSON.
   */
  async login(): Promise<boolean> {
    try {
      this.log('Attempting login for agent:', this.agentId);

      const body = new URLSearchParams({
        customerID: this.agentId,
        state: 'true',
        password: this.password.toUpperCase(),
        sufix: '',
        prefix: '',
        multiaccount: '1',
        response_type: 'code',
        client_id: this.agentId,
        domain: 'fantasy402.com',
        redirect_uri: 'fantasy402.com',
        token: '',
        operation: 'authenticateCustomer',
        RRO: '1',
      });

      const response = await fetch(`${this.baseUrl}/cloud/api/System/authenticateCustomer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': this.baseUrl,
          'Referer': `${this.baseUrl}/index.php`,
          ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
        },
        body,
      });

      const text = await response.text();
      this.log('Login response status:', response.status);

      // Try to capture any Set-Cookie headers (especially cf_clearance)
      const setCookie = response.headers.get('set-cookie');
      if (setCookie && !this.cfCookie) {
        this.cfCookie = setCookie;
        this.log('Captured cookie from login:', setCookie.substring(0, 80));
      }

      let data: LoginResponse = {};
      try {
        data = JSON.parse(text);
      } catch {
        this.log('Login response is not JSON:', text.substring(0, 200));
      }

      if (data.code || data.token) {
        this.token = data.code || data.token || '';
        this.loggedIn = true;
        console.log('[BuckeyeAPI] Login successful, token acquired');
        return true;
      }

      console.warn('[BuckeyeAPI] Login failed - no token in response');
      return false;
    } catch (error) {
      console.error('[BuckeyeAPI] Login error:', error);
      return false;
    }
  }

  /**
   * Test access by fetching bet ticker config.
   */
  async testAccess(): Promise<boolean> {
    if (!this.loggedIn) return false;
    try {
      const body = new URLSearchParams({
        agentID: this.agentId,
        operation: 'getBetTickerConfig',
        RRO: '1',
        agentOwner: this.agentId,
        agentSite: '1',
      });

      const response = await fetch(`${this.baseUrl}/cloud/api/Manager/getBetTickerConfig`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Authorization': `Bearer ${this.token}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': this.baseUrl,
          'Referer': `${this.baseUrl}/manager.html`,
          ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
        },
        body,
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch active wager ticker from the Manager API.
   */
  async getBetTicker(): Promise<EnrichedWager[]> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const body = new URLSearchParams({
      agentID: this.agentId,
      wagerNumber: String(this.lastWagerNumber),
      operation: 'getBetTicker',
      RRO: '1',
      agentOwner: this.agentId,
      agentSite: '1',
    });

    const response = await fetch(`${this.baseUrl}/cloud/api/Manager/getBetTicker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Authorization': `Bearer ${this.token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.baseUrl,
        'Referer': `${this.baseUrl}/manager.html?bet-ticker=active`,
        ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
      },
      body,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.loggedIn = false;
      }
      const text = await response.text().catch(() => '');
      throw new Error(`getBetTicker failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    const list: any[] = data?.LIST || [];

    this.log('getBetTicker returned', list.length, 'wagers');

    // Track highest wager number for incremental fetch
    for (const w of list) {
      const num = Number(w.WagerNumber) || 0;
      if (num > this.lastWagerNumber) {
        this.lastWagerNumber = num;
      }
    }

    const wagers = list.map((raw) => this.normalizeWager(raw));
    return wagers;
  }

  /**
   * Renew session token.
   */
  async renewToken(): Promise<boolean> {
    if (!this.loggedIn) return false;

    try {
      const body = new URLSearchParams({
        operation: 'renewToken',
        RRO: '1',
      });

      const response = await fetch(`${this.baseUrl}/cloud/api/System/renewToken`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${this.token}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
        },
        body,
      });

      if (response.ok) {
        const data = await response.json();
        if (data.code || data.token) {
          this.token = data.code || data.token || '';
          this.log('Token renewed');
          return true;
        }
      }

      return false;
    } catch (error) {
      console.error('[BuckeyeAPI] renewToken error:', error);
      return false;
    }
  }

  /**
   * Fetch agent hierarchy from the Manager API.
   * Returns the raw GENERAL array with agent tree data.
   */
  async getAgentHierarchy(): Promise<any> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const body = new URLSearchParams({
      agentID: this.agentId,
      agentType: 'M',
      operation: 'getListAgenstByAgent',
      RRO: '1',
      agentOwner: this.agentId,
      agentSite: '1',
    });

    const response = await fetch(`${this.baseUrl}/cloud/api/Manager/getListAgenstByAgent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Authorization': `Bearer ${this.token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.baseUrl,
        'Referer': `${this.baseUrl}/manager.html`,
        ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
      },
      body,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.loggedIn = false;
      }
      const text = await response.text().catch(() => '');
      throw new Error(`getAgentHierarchy failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    this.log('getAgentHierarchy returned', data?.GENERAL?.length || 0, 'agents,', data?.PLAYERS?.length || 0, 'players');
    return data;
  }

  /**
   * Fetch player/customer list from the Manager API.
   * Returns { LIST: [...] } with customerID, Login, NameFirst, Password, Agent.
   */
  async getPlayersList(): Promise<any> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const body = new URLSearchParams({
      agentID: this.agentId,
      agentType: 'M',
      operation: 'getPlayers',
      RRO: '1',
      agentOwner: this.agentId,
      agentSite: '1',
    });

    const response = await fetch(`${this.baseUrl}/cloud/api/Manager/getPlayers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Authorization': `Bearer ${this.token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.baseUrl,
        'Referer': `${this.baseUrl}/manager.html`,
        ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
      },
      body,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.loggedIn = false;
      }
      const text = await response.text().catch(() => '');
      throw new Error(`getPlayersList failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    this.log('getPlayersList returned', data?.LIST?.length || 0, 'players');
    return data;
  }

  /**
   * Fetch account info from the Manager API.
   */
  async getAccountInfoOwner(): Promise<BuckeyeAccountInfoResult> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const body = new URLSearchParams({
      agentID: this.agentId,
      operation: 'getAccountInfoOwner',
      RRO: '1',
      agentOwner: this.agentId,
      agentSite: '1',
    });

    const response = await fetch(`${this.baseUrl}/cloud/api/Manager/getAccountInfoOwner`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Authorization': `Bearer ${this.token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.baseUrl,
        'Referer': `${this.baseUrl}/manager.html`,
        ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
      },
      body,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.loggedIn = false;
      }
      const text = await response.text().catch(() => '');
      throw new Error(`getAccountInfoOwner failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    return buildAccountInfoResult(this.agentId, data);
  }

  /**
   * Fetch weekly figure report by agent from the Manager API.
   */
  async getWeeklyFigureByAgentLite(
    options: BuckeyeWeeklyFigureOptions = {}
  ): Promise<BuckeyeWeeklyFigureResult> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const week = Number.isInteger(options.week) ? options.week as number : 0;
    const type = (options.type || 'A').trim() || 'A';
    const layout = (options.layout || 'byDay').trim() || 'byDay';

    const body = new URLSearchParams({
      agentID: this.agentId,
      week: String(week),
      type,
      layout,
      operation: 'getWeeklyFigureByAgentLite',
      RRO: '1',
      agentOwner: this.agentId,
      agentSite: '1',
    });

    const response = await fetch(`${this.baseUrl}/cloud/api/Manager/getWeeklyFigureByAgentLite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Authorization': `Bearer ${this.token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.baseUrl,
        'Referer': `${this.baseUrl}/manager.html`,
        ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
      },
      body,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.loggedIn = false;
      }
      const text = await response.text().catch(() => '');
      throw new Error(`getWeeklyFigureByAgentLite failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    return {
      fetchedAt: new Date().toISOString(),
      agentId: this.agentId,
      params: { week, type, layout },
      parsed: parseWeeklyFigureSummary(data),
      data,
    };
  }

  async getAgentPerformanceReport(
    options: BuckeyeAgentPerformanceOptions
  ): Promise<BuckeyeAgentPerformanceResult> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const agentID = (options.agentID || this.agentId).trim().toUpperCase();
    const type = (options.type || 'CP').trim() || 'CP';
    const freePlay = (options.freePlay || 'Y').trim() || 'Y';
    const store = (options.store || agentID).trim() || agentID;
    const sport = (options.sport || '').trim();
    const subsport = (options.subsport || '').trim();
    const period = String(options.period ?? '-1');
    const wagerType = (options.wagerType || '').trim();
    const betType = (options.betType || '').trim();
    const tipo = String(options.tipo ?? options.activity ?? '-1');
    const group = String(options.group ?? '');
    const debug = String(options.debug ?? '0');
    const start = normalizeReportDate(options.start);
    const end = normalizeReportDate(options.end);
    validateReportDateRange(start, end);
    const agentOwner = (options.agentOwner || this.agentId).trim().toUpperCase();

    const body = new URLSearchParams({
      start,
      end,
      agentID,
      type,
      freePlay,
      store,
      sport,
      subsport,
      period,
      wagerType,
      betType,
      tipo,
      debug,
      operation: 'getAgentPerformance',
      RRO: '1',
      agentOwner,
      agentSite: '1',
    });
    if (group) {
      body.set('group', group);
    }
    const data = await this.postForm(
      `${this.baseUrl}/cloud/api/Manager/getAgentPerformance`,
      body,
      'getAgentPerformance'
    );
    const { sanitized, redactedFields } = sanitizeAgentPerformancePayload(data);

    return {
      fetchedAt: new Date().toISOString(),
      agentId: this.agentId,
      params: {
        start,
        end,
        agentID,
        type,
        freePlay,
        store,
        sport,
        subsport,
        period,
        wagerType,
        betType,
        tipo,
        debug,
        operation: 'getAgentPerformance',
        RRO: '1',
        agentOwner,
        agentSite: '1',
        group,
      },
      parsed: parseAgentPerformanceReport(sanitized),
      data: sanitized,
      redactedFields,
    };
  }

  async getPerformancePlayer(
    accountId: string,
    options: BuckeyePlayerPerformanceOptions = {}
  ): Promise<BuckeyeAgentPerformanceResult> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const acc = (options.acc || accountId).trim().toUpperCase();
    const agentID = (options.agentID || this.agentId).trim().toUpperCase();
    const agentOwner = (options.agentOwner || this.agentId).trim().toUpperCase();
    const period = String(options.period ?? 0);
    const body = new URLSearchParams({
      acc,
      period,
      operation: 'getPerformancePlayer',
      RRO: '1',
      agentID,
      agentOwner,
      agentSite: '1',
    });

    const data = await this.postForm(
      `${this.baseUrl}/cloud/api/Manager/getPerformancePlayer`,
      body,
      'getPerformancePlayer'
    );
    const { sanitized, redactedFields } = sanitizeAgentPerformancePayload(data);

    return {
      fetchedAt: new Date().toISOString(),
      agentId: this.agentId,
      params: {
        start: '',
        end: '',
        agentID,
        type: 'player',
        freePlay: '',
        store: acc,
        sport: '',
        subsport: '',
        period,
        wagerType: '',
        betType: '',
        tipo: '',
        debug: '0',
        operation: 'getPerformancePlayer',
        RRO: '1',
        agentOwner,
        agentSite: '1',
        group: '',
      },
      parsed: parsePlayerPerformanceReport(sanitized, { acc, agentID }),
      data: sanitized,
      redactedFields,
    };
  }

  async getConfigWebReports(): Promise<unknown> {
    return this.postManagerOperation('getConfigWebReports');
  }

  async getConfigWebReportsPending(): Promise<unknown> {
    return this.postManagerOperation('getConfigWebReportsPending');
  }

  async getSportsType(): Promise<unknown> {
    return this.postManagerOperation('getSportsType');
  }

  async getAuthorizations(): Promise<unknown> {
    return this.postManagerOperation('getAuthorizations');
  }

  async getMessage(type: string = '0'): Promise<unknown> {
    return this.postManagerOperation('getMessage', { acc: this.agentId, type });
  }

  async getNewEmailsCount(): Promise<unknown> {
    return this.postManagerOperation('getNewEmailsCount', { acc: this.agentId });
  }

  async getCustomerDeposits(customerId: string, options: {
    start?: string;
    end?: string;
  } = {}): Promise<BuckeyeDepositsResult> {
    const normalizedCustomerId = customerId.trim();
    const fetchedAt = new Date().toISOString();
    const end = normalizeReportDate(options.end || fetchedAt);
    const start = normalizeReportDate(options.start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    const endIso = normalizeIsoReportDate(options.end || fetchedAt);
    const startIso = normalizeIsoReportDate(options.start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    const operations = [
      'getCustomerDeposits',
      'getDepositHistory',
      'getCustomerTransactions',
      'getTransactionHistory',
      'getTransactions',
      'getTransactionList',
    ];

    let lastError = '';
    for (const operation of operations) {
      try {
        const data = await this.postManagerOperation(
          operation,
          operation === 'getTransactionHistory'
            ? buildTransactionHistoryExtra(normalizedCustomerId, startIso, endIso)
            : {
                customerID: normalizedCustomerId,
                customerId: normalizedCustomerId,
                login: normalizedCustomerId,
                acc: normalizedCustomerId,
                start,
                end,
              }
        );
        const rows = extractBuckeyeRows(data)
          .filter(isDepositLikeRow)
          .map((row) => normalizeDepositRow(row, {
            operation,
            customerId: normalizedCustomerId,
            agentId: this.agentId,
          }))
          .filter((row) => row.transactionTime);

        if (rows.length || payloadLooksUseful(data)) {
          return {
            fetchedAt,
            agentId: this.agentId,
            customerId: normalizedCustomerId,
            operation,
            rows,
            data,
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      fetchedAt,
      agentId: this.agentId,
      customerId: normalizedCustomerId,
      rows: [],
      unavailable: lastError || 'No Buckeye customer deposit endpoint returned data',
    };
  }

  async getTransactionHistory(customerId: string, options: {
    startDate?: string;
    endDate?: string;
  } = {}): Promise<BuckeyeTransactionListResult> {
    const normalizedCustomerId = customerId.trim();
    const fetchedAt = new Date().toISOString();
    const today = new Date().toISOString();
    const data = await this.postManagerOperation(
      'getTransactionHistory',
      buildTransactionHistoryExtra(
        normalizedCustomerId,
        normalizeIsoReportDate(options.startDate || today),
        normalizeIsoReportDate(options.endDate || today)
      )
    );
    const rows = parseTransactionList(data, {
      customerId: normalizedCustomerId,
      agentId: this.agentId,
      operation: 'getTransactionHistory',
    });

    return {
      fetchedAt,
      agentId: this.agentId,
      customerId: normalizedCustomerId,
      operation: 'getTransactionHistory',
      rows,
      data,
    };
  }

  async getReportDeletedTransactions(customerId: string, options: {
    startDate?: string;
    endDate?: string;
    reportCustomerId?: string;
  } = {}): Promise<BuckeyeTransactionListResult> {
    const normalizedCustomerId = customerId.trim();
    const fetchedAt = new Date().toISOString();
    const today = new Date().toISOString();
    const data = await this.postManagerOperation('getReportDeletedTransactions', {
      customerID: (options.reportCustomerId || this.agentId).trim(),
      startDate: normalizeIsoReportDate(options.startDate || today),
      endDate: normalizeIsoReportDate(options.endDate || today),
    });
    const rows = parseTransactionList(data, {
      customerId: normalizedCustomerId,
      agentId: this.agentId,
      operation: 'getReportDeletedTransactions',
    });

    return {
      fetchedAt,
      agentId: this.agentId,
      customerId: normalizedCustomerId,
      operation: 'getReportDeletedTransactions',
      rows,
      data,
    };
  }

  async getTransactionList(customerId: string, options: {
    start?: string;
  } = {}): Promise<BuckeyeTransactionListResult> {
    const normalizedCustomerId = customerId.trim();
    const fetchedAt = new Date().toISOString();
    const data = await this.postManagerOperation('getTransactionList', {
      acc: normalizedCustomerId,
      start: options.start || '',
    });
    const rows = parseTransactionList(data, {
      customerId: normalizedCustomerId,
      agentId: this.agentId,
      operation: 'getTransactionList',
    });

    return {
      fetchedAt,
      agentId: this.agentId,
      customerId: normalizedCustomerId,
      operation: 'getTransactionList',
      rows,
      data,
    };
  }

  async getTeaserProfile(customerId: string): Promise<unknown> {
    const normalizedCustomerId = customerId.trim();
    return this.postManagerOperation('getTeaserProfile', {
      customerID: normalizedCustomerId,
      customerId: normalizedCustomerId,
      login: normalizedCustomerId,
      acc: normalizedCustomerId,
    });
  }

  async getCustomerSnapshot(customerId: string): Promise<BuckeyeCustomerSnapshotResult> {
    const normalizedCustomerId = customerId.trim();
    const fetchedAt = new Date().toISOString();
    const operations = [
      'getInfoPlayer',
      'getCustomerInfo',
      'getCustomerDetails',
      'getCustomerProfile',
      'getCustomer',
    ];

    let lastError = '';
    for (const operation of operations) {
      try {
        const data = await this.postManagerOperation(operation, {
          customerID: normalizedCustomerId,
          customerId: normalizedCustomerId,
          login: normalizedCustomerId,
          acc: normalizedCustomerId,
        });
        const row = extractBuckeyeRows(data)[0] || objectPayload(data);
        if (row) {
          return {
            fetchedAt,
            agentId: this.agentId,
            customerId: normalizedCustomerId,
            operation,
            snapshot: normalizeCustomerSnapshot(row, {
              operation,
              customerId: normalizedCustomerId,
              agentId: this.agentId,
            }),
            data,
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      fetchedAt,
      agentId: this.agentId,
      customerId: normalizedCustomerId,
      unavailable: lastError || 'No Buckeye customer-info endpoint returned data',
    };
  }

  async getManagerSnapshot(): Promise<BuckeyeManagerSnapshotResult> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const [
      configWebReports,
      configWebReportsPending,
      sportsType,
      authorizations,
      message,
      newEmailsCount,
    ] = await Promise.all([
      this.getConfigWebReports(),
      this.getConfigWebReportsPending(),
      this.getSportsType(),
      this.getAuthorizations(),
      this.getMessage(),
      this.getNewEmailsCount(),
    ]);

    return {
      fetchedAt: new Date().toISOString(),
      agentId: this.agentId,
      configWebReports,
      configWebReportsPending,
      sportsType,
      authorizations,
      message,
      newEmailsCount,
    };
  }

  async writeLog(description: string, additional: string = ''): Promise<BuckeyeLogWriteResult> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const body = new URLSearchParams({
      customerID: `${this.agentId}  `,
      description,
      additional,
      operation: 'write',
      agentID: this.agentId,
      agentOwner: this.agentId,
      agentSite: '1',
    });

    return {
      fetchedAt: new Date().toISOString(),
      agentId: this.agentId,
      data: await this.postForm(`${this.baseUrl}/cloud/api/Log/write`, body, 'writeLog'),
    };
  }

  /**
   * Fetch Buckeye language/theme UI config and extract useful sportsbook labels.
   */
  async getUiConfig(includeRaw: boolean = false): Promise<BuckeyeUiConfigResult> {
    return this.getLanguageUiConfig({ includeRaw });
  }

  /**
   * Fetch the same UI language file loaded by app/language/language.js.
   */
  async getLanguageUiConfig(options: {
    includeRaw?: boolean;
    includeAgentParams?: boolean;
  } = {}): Promise<BuckeyeUiConfigResult> {
    const includeRaw = options.includeRaw === true;
    const query = new URLSearchParams({ v: String(Date.now()) });
    if (options.includeAgentParams) {
      query.set('agentID', this.agentId);
      query.set('agentOwner', this.agentId);
      query.set('agentSite', '1');
    }
    const endpoint = `${this.baseUrl}/app/language/ui.json?${query.toString()}`;
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${this.baseUrl}/manager.html`,
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const response = await fetch(endpoint, { method: 'GET', headers });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.loggedIn = false;
      }
      const text = await response.text().catch(() => '');
      throw new Error(`getUiConfig failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
    }

    const config = await response.json();
    return {
      url: endpoint,
      fetchedAt: new Date().toISOString(),
      agentId: this.agentId,
      parsed: parseBuckeyeUiConfig(config),
      ...(includeRaw ? { config } : {}),
    };
  }

  detectChanges(newWagers: EnrichedWager[]): WagerChange[] {
    const changes: WagerChange[] = [];
    for (const wager of newWagers) {
      const existing = this.lastWagers.get(wager.WagerNumber);
      if (!existing) {
        changes.push({ type: 'new', wager });
      } else if (
        existing.AmountWagered !== wager.AmountWagered ||
        existing.VolumeAmount !== wager.VolumeAmount ||
        existing.ToWinAmount !== wager.ToWinAmount
      ) {
        changes.push({ type: 'updated', wager });
      }
    }
    this.lastWagers.clear();
    for (const wager of newWagers) {
      this.lastWagers.set(wager.WagerNumber, wager);
    }
    return changes;
  }

  clearCache(): void {
    this.lastWagers.clear();
    this.lastWagerNumber = 0;
  }

  isAuthenticated(): boolean {
    return this.loggedIn;
  }

  getToken(): string {
    return this.token;
  }

  getCookie(): string {
    return this.cfCookie;
  }

  /**
   * Accept or decline a wager through the Buckeye bet ticker action API.
   * Endpoint: /cloud/api/Manager/betTickerAction
   */
  async betTickerAction(params: {
    wagerNumber: number;
    action: 'accept' | 'decline';
    agentId: string;
    reason?: string;
  }): Promise<{ success: boolean; message: string; error?: string }> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const body = new URLSearchParams({
      agentID: params.agentId,
      wagerNumber: String(params.wagerNumber),
      action: params.action === 'accept' ? '1' : '0',
      agentOwner: this.agentId,
      agentSite: '1',
      operation: 'betTickerAction',
      RRO: '1',
      ...(params.reason ? { reason: params.reason } : {}),
    });

    try {
      const response = await fetch(`${this.baseUrl}/cloud/api/Manager/betTickerAction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Authorization': `Bearer ${this.token}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': this.baseUrl,
          'Referer': `${this.baseUrl}/manager.html?bet-ticker=active`,
          ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
        },
        body,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.loggedIn = false;
        }
        const text = await response.text().catch(() => '');
        throw new Error(`betTickerAction failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
      }

      const data = await response.json();
      const success = data?.success === true || data?.code === 'OK' || response.ok;
      return {
        success,
        message: success ? `Wager #${params.wagerNumber} ${params.action}ed` : (data?.message || 'Unknown response'),
      };
    } catch (error) {
      return {
        success: false,
        message: 'Action failed',
        error: error instanceof Error ? error.message : 'Network error',
      };
    }
  }

  async getWebLog(options: BuckeyeWebLogOptions): Promise<BuckeyeWebLogRow[]> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    validateWebLogRange(options);
    const body = buildWebLogBody(this.agentId, options);
    const endpoints = [
      `${this.baseUrl}/qubic/api/Manager/getWebLog`,
      `${this.baseUrl}/cloud/api/Manager/getWebLog`,
    ];

    let lastError = '';
    for (const endpoint of endpoints) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Authorization': `Bearer ${this.token}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': this.baseUrl,
          'Referer': `${this.baseUrl}/manager.html`,
          ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
        },
        body,
      });

      const text = await response.text().catch(() => '');
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.loggedIn = false;
        }
        lastError = `${response.status} ${response.statusText} - ${text.substring(0, 160)}`;
        continue;
      }

      let data: any = {};
      try {
        data = JSON.parse(text);
      } catch {
        lastError = `Non-JSON getWebLog response from ${endpoint}: ${text.substring(0, 160)}`;
        continue;
      }

      const list = Array.isArray(data?.LIST) ? data.LIST : [];
      return list.map(normalizeWebLogRow);
    }

    throw new Error(`getWebLog failed: ${lastError || 'all endpoints failed'}`);
  }

  private async postManagerOperation(
    operation: BuckeyeManagerOperation,
    extra: Record<string, string> = {}
  ): Promise<unknown> {
    if (!this.loggedIn) {
      throw new Error('Not authenticated. Call login() first.');
    }

    const body = buildManagerOperationBody(this.agentId, operation, extra);
    return this.postForm(`${this.baseUrl}/cloud/api/Manager/${operation}`, body, operation);
  }

  private async postForm(endpoint: string, body: URLSearchParams, label: string): Promise<unknown> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Authorization': `Bearer ${this.token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': this.baseUrl,
        'Referer': `${this.baseUrl}/manager.html`,
        ...(this.cfCookie ? { 'Cookie': this.cfCookie } : {}),
      },
      body,
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.loggedIn = false;
      }
      throw new Error(`${label} failed: ${response.status} ${response.statusText} - ${text.substring(0, 200)}`);
    }

    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private normalizeWager(raw: any): EnrichedWager {
    // Buckeye API returns amounts in cents; convert to dollars
    const amountWagered = (Number(raw.AmountWagered) || 0) / 100;
    const toWinAmount = (Number(raw.ToWinAmount) || 0) / 100;
    const volumeAmount = (Number(raw.VolumeAmount) || 0) / 100;

    // Decode HTML entities in descriptions (e.g. &#189; → ½)
    let shortDesc = String(raw.ShortDesc || '').trim();
    shortDesc = shortDesc.replace(/&#189;/g, '½').replace(/&#188;/g, '¼').replace(/&#190;/g, '¾');
    shortDesc = shortDesc.replace(/&#038;/g, '&').replace(/&amp;/g, '&');

    return {
      WagerNumber: Number(raw.WagerNumber) || 0,
      AgentID: String(raw.AgentID || '').trim(),
      CustomerID: String(raw.CustomerID || '').trim(),
      Login: String(raw.Login || raw.CustomerID || '').trim(),
      WagerType: String(raw.WagerType || '').trim().toUpperCase(),
      AmountWagered: amountWagered,
      ToWinAmount: toWinAmount,
      VolumeAmount: volumeAmount,
      InsertDateTime: String(raw.InsertDateTime || '').trim(),
      TicketWriter: String(raw.TicketWriter || '').trim(),
      ShortDesc: shortDesc,
      VIP: String(raw.VIP || '0').trim(),
      AgentLogin: String(raw.AgentLogin || raw.AgentId || '').trim(),
    };
  }
}

const KNOWN_BET_TYPE_LABELS: Record<string, string> = {
  L: 'Line',
  M: 'Straight',
  S: 'Spread',
  P: 'Parlay',
  E: 'Exotic',
  T: 'Teaser',
  C: 'Custom',
  I: 'In-Play',
};

const SPORTSBOOK_TERMS = [
  'straight',
  'line',
  'spread',
  'parlay',
  'teaser',
  'exotic',
  'custom',
  'prop',
  'future',
  'futures',
  'moneyline',
  'total',
  'live',
  'wager',
  'bet',
  'bets',
  'ticket',
  'risk',
  'to win',
];

const FEATURE_KEY_PATTERN = /(?:^|\.|_)(enable|enabled|allow|allowed|show|visible|active|use|has)[A-Z_.-]?/i;
const BET_TYPE_KEY_PATTERN = /(wager|bet).*type|type.*(wager|bet)|straight|parlay|teaser|spread|line|exotic|prop|future|moneyline|total/i;

export function parseBuckeyeUiConfig(config: unknown): ParsedBuckeyeUiConfig {
  const strings: BuckeyeUiString[] = [];
  const featureFlags: BuckeyeFeatureFlag[] = [];
  walkUiConfig(config, [], strings, featureFlags);

  const sportsbookStrings = dedupeStrings(
    strings.filter((entry) => {
      const haystack = `${entry.path} ${entry.key} ${entry.value}`.toLowerCase();
      return SPORTSBOOK_TERMS.some((term) => haystack.includes(term));
    })
  );

  const betTypes = extractBetTypes(sportsbookStrings);

  return {
    betTypes,
    featureFlags,
    sportsbookStrings,
  };
}

function walkUiConfig(
  value: unknown,
  path: string[],
  strings: BuckeyeUiString[],
  featureFlags: BuckeyeFeatureFlag[]
): void {
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (normalized) {
      strings.push({
        path: path.join('.'),
        key: path[path.length - 1] || '',
        value: normalized,
      });
    }
    return;
  }

  if (typeof value === 'boolean') {
    const currentPath = path.join('.');
    const key = path[path.length - 1] || '';
    if (FEATURE_KEY_PATTERN.test(currentPath)) {
      featureFlags.push({ path: currentPath, key, value });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => walkUiConfig(item, [...path, String(index)], strings, featureFlags));
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkUiConfig(child, [...path, key], strings, featureFlags);
    }
  }
}

function extractBetTypes(entries: BuckeyeUiString[]): BuckeyeBetTypeLabel[] {
  const byLabel = new Map<string, BuckeyeBetTypeLabel>();

  for (const entry of entries) {
    const key = entry.key.trim().toUpperCase();
    const value = entry.value.trim();
    const path = entry.path;

    if (KNOWN_BET_TYPE_LABELS[key] && value.length <= 40) {
      byLabel.set(`${key}:${value.toLowerCase()}`, { code: key, label: value, path });
      continue;
    }

    const knownCode = Object.entries(KNOWN_BET_TYPE_LABELS).find(([, label]) => {
      return label.toLowerCase() === value.toLowerCase();
    })?.[0];
    if (knownCode) {
      byLabel.set(`${knownCode}:${value.toLowerCase()}`, { code: knownCode, label: value, path });
      continue;
    }

    if (BET_TYPE_KEY_PATTERN.test(`${path}.${entry.key}`) && value.length <= 40) {
      byLabel.set(`:${value.toLowerCase()}`, { label: value, path });
    }
  }

  return Array.from(byLabel.values()).sort((a, b) => {
    const codeA = a.code || '~';
    const codeB = b.code || '~';
    return codeA.localeCompare(codeB) || a.label.localeCompare(b.label);
  });
}

function dedupeStrings(entries: BuckeyeUiString[]): BuckeyeUiString[] {
  const seen = new Set<string>();
  const result: BuckeyeUiString[] = [];
  for (const entry of entries) {
    const key = `${entry.path}:${entry.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

const SENSITIVE_ACCOUNT_FIELDS = new Set([
  'Password',
  'PasswordFix',
  'SMSPhoneNumber',
  'Phone',
  'email',
]);

const LIMIT_FIELD_PATTERN = /(Limit|Max|Minimum|Balance|Payout|Wager|Credit)/i;
const FEATURE_FIELD_PATTERN = /^(Allow|Deny|Suspend|Can|Use|ReadOnly|PlaceWager|Always|Enforce|Display|Mute|Force|No|Notrue|ZeroBalance|FreePlay|CreditAcct)/;

export function buildAccountInfoResult(agentId: string, data: any): BuckeyeAccountInfoResult {
  const accountInfo = data?.accountInfo && typeof data.accountInfo === 'object'
    ? data.accountInfo as Record<string, unknown>
    : {};
  const { sanitized, redactedFields } = sanitizeAccountInfo(accountInfo);

  return {
    fetchedAt: new Date().toISOString(),
    agentId,
    parsed: parseBuckeyeAccountInfo(accountInfo),
    accountInfo: sanitized,
    preferenceDate: Array.isArray(data?.preferenceDate) ? data.preferenceDate : [],
    site: Array.isArray(data?.site) ? data.site : [],
    server: data?.SERVER || null,
    redactedFields,
  };
}

export function parseWeeklyFigureSummary(data: any): BuckeyeWeeklyFigureResult['parsed'] {
  const summary = Array.isArray(data?.LIST?.ARRAY) ? data.LIST.ARRAY[0] || {} : {};
  return {
    thisWeek: numberValue(summary.ThisWeek),
    active: numberValue(summary.Active),
    today: numberValue(summary.Today),
    info: stringValue(data?.LIST?.INFO),
  };
}

export function parseAgentPerformanceReport(data: any): BuckeyeAgentPerformanceResult['parsed'] {
  const rawRows = Array.isArray(data?.INFO?.LIST)
    ? data.INFO.LIST
    : Array.isArray(data?.LIST)
      ? data.LIST
      : [];
  const rows = rawRows.map(normalizeAgentPerformanceRow);
  const totals = rows.reduce(
    (acc, row) => {
      acc.wagerCount += row.wagerCount;
      acc.risk += row.risk;
      acc.toWin += row.toWin;
      acc.amountWon += row.amountWon;
      acc.amountLost += row.amountLost;
      acc.volume += row.volume;
      acc.net += row.net;
      return acc;
    },
    {
      wagerCount: 0,
      risk: 0,
      toWin: 0,
      amountWon: 0,
      amountLost: 0,
      volume: 0,
      net: 0,
    }
  );

  return { rows, totals };
}

export function parsePlayerPerformanceReport(
  data: any,
  context: { acc: string; agentID: string }
): BuckeyeAgentPerformanceResult['parsed'] {
  const rawRows = extractBuckeyeRows(data);
  const rows = (rawRows.length ? rawRows : [objectPayload(data)])
    .filter(isPlainRecord)
    .map((row) => normalizeAgentPerformanceRow({
      ...row,
      CustomerID: (row as Record<string, unknown>).CustomerID || (row as Record<string, unknown>).customerID || context.acc,
      Login: (row as Record<string, unknown>).Login || (row as Record<string, unknown>).login || context.acc,
      AgentID: (row as Record<string, unknown>).AgentID || (row as Record<string, unknown>).agentID || context.agentID,
    }));
  const totals = rows.reduce(
    (acc, row) => {
      acc.wagerCount += row.wagerCount;
      acc.risk += row.risk;
      acc.toWin += row.toWin;
      acc.amountWon += row.amountWon;
      acc.amountLost += row.amountLost;
      acc.volume += row.volume;
      acc.net += row.net;
      return acc;
    },
    {
      wagerCount: 0,
      risk: 0,
      toWin: 0,
      amountWon: 0,
      amountLost: 0,
      volume: 0,
      net: 0,
    }
  );

  return { rows, totals };
}

export function sanitizeBuckeyeLogin(value: string): string {
  return value.replace(/\s*\(\s*pw\s*:[^)]+\)\s*/gi, '').trim();
}

export function parseBuckeyeAccountInfo(accountInfo: Record<string, unknown>): ParsedBuckeyeAccountInfo {
  const limits: Record<string, number> = {};
  const featureFlags: BuckeyeAccountFeatureFlag[] = [];

  for (const [key, rawValue] of Object.entries(accountInfo)) {
    if (typeof rawValue === 'number' && LIMIT_FIELD_PATTERN.test(key)) {
      limits[key] = normalizeAccountAmount(key, rawValue);
    }

    if (FEATURE_FIELD_PATTERN.test(key)) {
      const normalized = normalizeYN(rawValue);
      if (normalized !== null) {
        featureFlags.push({
          key,
          value: normalized,
          raw: typeof rawValue === 'string' ? rawValue : String(rawValue),
        });
      }
    }
  }

  return {
    accountId: stringValue(accountInfo.customerID),
    login: stringValue(accountInfo.Login).trim(),
    agentType: stringValue(accountInfo.AgentType),
    office: stringValue(accountInfo.Office),
    skin: stringValue(accountInfo.Skin),
    defaultSiteSkin: stringValue(accountInfo.DefaultSiteSkin),
    theme: stringValue(accountInfo.DefaultSiteTheme),
    language: stringValue(accountInfo.Language),
    currency: stringValue(accountInfo.CurrencyCode || accountInfo.Currency),
    timezone: typeof accountInfo.TimeZone === 'number' ? accountInfo.TimeZone : null,
    balances: {
      current: normalizeAccountAmount('CurrentBalance', numberValue(accountInfo.CurrentBalance)),
      available: normalizeAccountAmount('AvailableBalance', numberValue(accountInfo.AvailableBalance)),
      pendingWager: normalizeAccountAmount('PendingWagerBalance', numberValue(accountInfo.PendingWagerBalance)),
      freePlay: normalizeAccountAmount('FreePlayBalance', numberValue(accountInfo.FreePlayBalance)),
    },
    limits,
    featureFlags: featureFlags.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function normalizeAgentPerformanceRow(row: Record<string, unknown>): BuckeyeAgentPerformanceRow {
  return {
    customerId: stringValue(row.CustomerID).trim(),
    agentId: stringValue(row.AgentID).trim(),
    login: sanitizeBuckeyeLogin(stringValue(row.Login)),
    wagerCount: numberValue(row.wagercount ?? row.WagerCount ?? row.wagerCount),
    risk: numberValue(row.Risk ?? row.risk),
    toWin: numberValue(row.ToWin ?? row.toWin),
    amountWon: numberValue(row.amountwon ?? row.AmountWon ?? row.amountWon),
    amountLost: numberValue(row.amountlost ?? row.AmountLost ?? row.amountLost),
    volume: numberValue(row.volume ?? row.Volume),
    net: numberValue(row.net ?? row.Net),
  };
}

function sanitizeAgentPerformancePayload(data: unknown): {
  sanitized: unknown;
  redactedFields: string[];
} {
  if (!data || typeof data !== 'object') {
    return { sanitized: data, redactedFields: [] };
  }

  const redactedFields: string[] = [];
  const clone = Array.isArray(data)
    ? [...data]
    : { ...(data as Record<string, unknown>) };
  const list = Array.isArray((clone as any)?.INFO?.LIST)
    ? (clone as any).INFO.LIST
    : Array.isArray((clone as any)?.LIST)
      ? (clone as any).LIST
      : null;

  if (!list) {
    return { sanitized: clone, redactedFields };
  }

  const sanitizedRows = list.map((row: unknown, index: number) => {
    if (!row || typeof row !== 'object') return row;
    const next = { ...(row as Record<string, unknown>) };
    if (typeof next.Login === 'string') {
      const sanitizedLogin = sanitizeBuckeyeLogin(next.Login);
      if (sanitizedLogin !== next.Login) {
        next.Login = sanitizedLogin;
        redactedFields.push(`LIST[${index}].Login`);
      }
    }
    return next;
  });

  if (Array.isArray((clone as any)?.INFO?.LIST)) {
    (clone as any).INFO = { ...(clone as any).INFO, LIST: sanitizedRows };
  } else if (Array.isArray((clone as any)?.LIST)) {
    (clone as any).LIST = sanitizedRows;
  }

  return { sanitized: clone, redactedFields };
}

function sanitizeAccountInfo(accountInfo: Record<string, unknown>): {
  sanitized: Record<string, unknown>;
  redactedFields: string[];
} {
  const sanitized: Record<string, unknown> = {};
  const redactedFields: string[] = [];

  for (const [key, value] of Object.entries(accountInfo)) {
    if (SENSITIVE_ACCOUNT_FIELDS.has(key)) {
      sanitized[key] = 'REDACTED';
      redactedFields.push(key);
      continue;
    }
    sanitized[key] = value;
  }

  return { sanitized, redactedFields };
}

function normalizeYN(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'Y' || normalized === 'YES' || normalized === 'TRUE') return true;
  if (normalized === 'N' || normalized === 'NO' || normalized === 'FALSE') return false;
  return null;
}

function normalizeAccountAmount(key: string, value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (/Balance|Limit|Payout|Wager|Credit|Bet/i.test(key)) {
    return value / 100;
  }
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : Number(value) || 0;
}

function extractBuckeyeRows(data: unknown): Record<string, unknown>[] {
  const candidates = [
    data,
    (data as any)?.INFO?.LIST,
    (data as any)?.LIST?.ARRAY,
    (data as any)?.LIST,
    (data as any)?.data,
    (data as any)?.Data,
    (data as any)?.results,
    (data as any)?.Rows,
    (data as any)?.rows,
    (data as any)?.transactions,
    (data as any)?.deposits,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isPlainRecord) as Record<string, unknown>[];
    }
  }

  const object = objectPayload(data);
  return object ? [object] : [];
}

function objectPayload(data: unknown): Record<string, unknown> | null {
  const candidates = [
    (data as any)?.accountInfo,
    (data as any)?.customerInfo,
    (data as any)?.customer,
    (data as any)?.profile,
    (data as any)?.INFO,
    data,
  ];
  for (const candidate of candidates) {
    if (isPlainRecord(candidate) && !Array.isArray((candidate as any).LIST)) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function payloadLooksUseful(data: unknown): boolean {
  if (Array.isArray(data)) return true;
  if (!isPlainRecord(data)) return false;
  const keys = Object.keys(data);
  return keys.some((key) => !/^(success|code|message|error)$/i.test(key));
}

function isDepositLikeRow(row: Record<string, unknown>): boolean {
  const text = [
    row.Type,
    row.type,
    row.TransactionType,
    row.transactionType,
    row.Method,
    row.method,
    row.Description,
    row.description,
    row.Operation,
    row.operation,
  ].map(stringValue).join(' ').toLowerCase();

  if (/withdraw|payout/.test(text)) return false;
  return !text || /deposit|transaction|credit|cash|card|wire|crypto|bitcoin|btc|ach|zelle|venmo|paypal/.test(text);
}

function normalizeDepositRow(row: Record<string, unknown>, context: {
  operation: string;
  customerId: string;
  agentId: string;
}): BuckeyeDepositRow {
  const transactionId = firstString(row, [
    'ID',
    'Id',
    'id',
    'TransactionID',
    'transactionID',
    'TransactionId',
    'Reference',
    'reference',
    'Confirmation',
    'confirmation',
  ]);
  const customerId = firstString(row, ['CustomerID', 'customerID', 'customer_id', 'customerId', 'Account', 'account'])
    || context.customerId;
  const login = sanitizeBuckeyeLogin(firstString(row, ['Login', 'login', 'CustomerLogin', 'customerLogin']) || customerId);
  const transactionTime = normalizeUnknownDate(firstString(row, [
    'TransactionTime',
    'transactionTime',
    'DateTime',
    'dateTime',
    'Date',
    'date',
    'CreatedAt',
    'createdAt',
    'InsertedAt',
    'insertedAt',
  ]));
  const amount = firstNumber(row, ['Amount', 'amount', 'TransactionAmount', 'transactionAmount', 'Credit', 'credit', 'Deposit', 'deposit']);
  const raw = { ...row, sourceOperation: context.operation };

  return {
    id: transactionId || stableBuckeyeId([context.operation, context.agentId, customerId, login, transactionTime, String(amount), JSON.stringify(row)]),
    customerId,
    login,
    agentId: firstString(row, ['AgentID', 'agentID', 'agent_id', 'agentId']) || context.agentId,
    agentLogin: firstString(row, ['AgentLogin', 'agentLogin', 'agent_login']) || context.agentId,
    amount,
    currency: firstString(row, ['Currency', 'currency', 'CurrencyCode', 'currencyCode']) || 'USD',
    method: firstString(row, ['Method', 'method', 'PaymentMethod', 'paymentMethod', 'Processor', 'processor', 'Type', 'type']),
    ipAddress: firstString(row, ['IPAddress', 'IP', 'ip', 'ipAddress', 'IP_Address', 'IpAddress']),
    status: firstString(row, ['Status', 'status', 'Result', 'result']) || 'captured',
    transactionTime,
    raw,
  };
}

function normalizeTransactionRow(row: Record<string, unknown>, context: {
  operation: string;
  customerId: string;
  agentId: string;
}): BuckeyeTransactionRow {
  const documentNumber = firstString(row, ['DocumentNumber', 'documentNumber', 'DocNo', 'docNo', 'DocumentNo', 'documentNo', 'DocumentID', 'documentID', 'ID', 'id']);
  const transactionTime = normalizeUnknownDate(firstString(row, [
    'TranDateTime',
    'tranDateTime',
    'TransactionDateTime',
    'transactionDateTime',
    'TransactionTime',
    'transactionTime',
    'TransactionDate',
    'transactionDate',
    'TranDate',
    'tranDate',
    'DateTime',
    'dateTime',
    'Date',
    'date',
  ]));
  const customerId = firstString(row, ['CustomerID', 'customerID', 'customer_id', 'customerId', 'Customer', 'customer', 'Account', 'account', 'acc'])
    || context.customerId;
  const login = sanitizeBuckeyeLogin(firstString(row, ['Login', 'login', 'CustomerLogin', 'customerLogin']) || customerId);
  const tranCode = firstString(row, ['TranCode', 'tranCode', 'TransactionCode', 'transactionCode', 'Code', 'code']);
  const tranType = firstString(row, ['TranType', 'tranType', 'TransactionType', 'transactionType', 'Type', 'type']);
  const description = firstString(row, ['Description', 'description', 'Desc', 'desc', 'Details', 'details']);
  const amount = normalizeTransactionAmount(firstNumber(row, ['Amount', 'amount', 'TransactionAmount', 'transactionAmount', 'Credit', 'credit', 'Debit', 'debit']));
  const balance = normalizeTransactionAmount(firstNumber(row, ['Balance', 'balance']));
  const holdAmount = normalizeTransactionAmount(firstNumber(row, ['HoldAmount', 'holdAmount']));
  const rawText = JSON.stringify(row);
  const category = classifyTransaction({ tranCode, tranType, description, amount, rawText });
  const raw = { ...row, sourceOperation: context.operation };

  return {
    id: context.operation === 'getReportDeletedTransactions' && documentNumber
      ? `deleted-${documentNumber}`
      : documentNumber || stableBuckeyeId([context.operation, context.agentId, customerId, login, transactionTime, String(amount), JSON.stringify(row)]),
    customerId,
    login,
    agentId: firstString(row, ['AgentID', 'AgentId', 'agentID', 'agentId', 'agent_id']) || context.agentId,
    agentLogin: firstString(row, ['AgentLogin', 'AgentId', 'agentLogin', 'agent_login', 'MasterAgentID', 'masterAgentID']) || context.agentId,
    documentNumber,
    tranCode,
    tranType,
    amount,
    balance,
    holdAmount,
    gradeNum: firstString(row, ['GradeNum', 'gradeNum']),
    description,
    enteredBy: firstString(row, ['EnteredBy', 'enteredBy', 'DeletedBy', 'deletedBy']),
    category,
    transactionTime,
    raw,
  };
}

export function parseTransactionList(data: unknown, context: {
  customerId: string;
  agentId: string;
  operation?: string;
}): BuckeyeTransactionRow[] {
  return extractBuckeyeRows(data)
    .map((row) => normalizeTransactionRow(row, {
      operation: context.operation || 'getTransactionList',
      customerId: context.customerId,
      agentId: context.agentId,
    }))
    .filter((row) => row.transactionTime);
}

function normalizeTransactionAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value / 100;
}

function classifyTransaction(input: {
  tranCode: string;
  tranType: string;
  description: string;
  amount: number;
  rawText?: string;
}): BuckeyeTransactionCategory {
  const text = `${input.tranCode} ${input.tranType} ${input.description} ${input.rawText || ''}`.toLowerCase();
  const hasFreePlaySignal = /\bfree[\s_-]*play\b|freeplay|\bfp\b|bonus\s+play|promo|credit\s*pct/.test(text);
  if (hasFreePlaySignal) {
    if (/expir|forfeit|void/.test(text)) return 'freeplay_expired';
    if (/redeem|redemption|used|wager(ed)?\s+free|free[\s_-]*play\s+used|fp\s+used/.test(text)) return 'freeplay_redeemed';
    if (/adjust|correction|manual|credit\s*pct|percentage/.test(text)) return 'freeplay_adjustment';
    return 'freeplay_issued';
  }
  if (/wager\s+won|bet\s+won/.test(text)) return 'wager_win';
  if (/wager\s+loss|bet\s+loss/.test(text)) return 'wager_loss';
  if (/deposit|cash\s*in|fund|payment|wire|ach|card|crypto|bitcoin|btc|zelle|venmo|paypal/.test(text)) return 'deposit';
  if (/withdraw|payout|cash\s*out|distribution/.test(text)) return 'withdrawal';
  if (/hold/.test(text)) return 'hold';
  if (/adjust|correction|manual/.test(text)) return 'adjustment';
  if (input.tranCode.toUpperCase() === 'C') return 'credit';
  if (input.tranCode.toUpperCase() === 'D') return 'debit';
  return 'other';
}

function normalizeCustomerSnapshot(row: Record<string, unknown>, context: {
  operation: string;
  customerId: string;
  agentId: string;
}): BuckeyeCustomerSnapshot {
  const customerId = firstString(row, ['customerID', 'CustomerID', 'customer_id', 'customerId', 'Account', 'account'])
    || context.customerId;
  const login = sanitizeBuckeyeLogin(firstString(row, ['Login', 'login', 'CustomerLogin', 'customerLogin']) || customerId);
  return {
    customerId,
    login,
    agentId: firstString(row, ['AgentID', 'agentID', 'agent_id', 'agentId']) || context.agentId,
    agentLogin: firstString(row, ['AgentLogin', 'agentLogin', 'agent_login', 'Office', 'office']) || context.agentId,
    kycLevel: firstString(row, ['KYCLevel', 'kycLevel', 'KycLevel', 'KYC', 'kyc', 'DocumentStatus', 'documentStatus']),
    vipStatus: firstString(row, ['VIPStatus', 'vipStatus', 'VipStatus', 'VIP', 'vip', 'Tier', 'tier', 'PlayerType', 'playerType']),
    emailMasked: maskEmail(firstString(row, ['Email', 'email', 'EmailAddress', 'emailAddress'])),
    phoneMasked: maskPhone(firstString(row, ['Phone', 'phone', 'PhoneNumber', 'phoneNumber', 'SMSPhoneNumber', 'smsPhoneNumber'])),
    currency: firstString(row, ['Currency', 'currency', 'CurrencyCode', 'currencyCode']),
    source: context.operation,
    raw: { ...row, sourceOperation: context.operation },
  };
}

function firstString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(row[key]).trim();
    if (value) return value;
  }
  return '';
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = row[key];
    if (value == null || value === '') continue;
    const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function normalizeUnknownDate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const dotNet = trimmed.match(/\/Date\((\d+)\)\//);
  if (dotNet) {
    const parsed = Number(dotNet[1]);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const date = parseWebLogDate(trimmed);
  return date ? date.toISOString() : trimmed;
}

function maskEmail(value: string): string {
  const [name, domain] = value.split('@');
  if (!name || !domain) return value ? 'REDACTED' : '';
  const head = name.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(2, name.length - 1))}@${domain}`;
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (!digits) return '';
  const tail = digits.slice(-4);
  return `${'*'.repeat(Math.max(3, digits.length - 4))}${tail}`;
}

function stableBuckeyeId(parts: string[]): string {
  const text = parts.join('|');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `buckeye-${Math.abs(hash).toString(36)}`;
}

export function buildWebLogBody(agentId: string, options: BuckeyeWebLogOptions): URLSearchParams {
  validateWebLogRange(options);
  return new URLSearchParams({
    agentID: agentId,
    customerID: String(options.customerID ?? ''),
    start: normalizeWebLogDate(options.start, options.type),
    end: normalizeWebLogDate(options.end, options.type),
    type: options.type,
    actions: options.actions || 'ALL',
    ip: options.ip || '',
    operation: 'getWebLog',
    RRO: '1',
    agentOwner: agentId,
    agentSite: '1',
  });
}

export function buildManagerOperationBody(
  agentId: string,
  operation: BuckeyeManagerOperation,
  extra: Record<string, string> = {}
): URLSearchParams {
  return new URLSearchParams({
    agentID: agentId,
    operation,
    RRO: '1',
    agentOwner: agentId,
    agentSite: '1',
    ...extra,
  });
}

export function validateWebLogRange(options: BuckeyeWebLogOptions): void {
  const start = parseWebLogDate(options.start);
  const end = parseWebLogDate(options.end);
  if (!start || !end) {
    throw new Error('Invalid getWebLog date range');
  }
  if (start.getTime() > end.getTime()) {
    throw new Error('getWebLog start date must be before end date');
  }
  const days = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
  const maxDays = options.type === 'I' ? 7 : 30;
  if (days > maxDays) {
    throw new Error(`getWebLog type ${options.type} supports a maximum ${maxDays}-day range`);
  }
}

function parseWebLogDate(value: string): Date | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isFinite(parsed.getTime())) return parsed;
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, mm, dd, yyyy] = slash;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  }
  return null;
}

function normalizeWebLogDate(value: string, type: BuckeyeWebLogType): string {
  const date = parseWebLogDate(value);
  if (!date) return value;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  if (type === 'C') return `${yyyy}-${mm}-${dd}`;
  return `${mm}/${dd}/${yyyy}`;
}

function normalizeReportDate(value: string): string {
  const date = parseWebLogDate(value);
  if (!date) return value;
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${date.getFullYear()}`;
}

function normalizeIsoReportDate(value: string): string {
  const date = parseWebLogDate(value);
  if (!date) return value;
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function buildTransactionHistoryExtra(customerId: string, startDate: string, endDate: string): Record<string, string> {
  return {
    customerID: customerId,
    startDate,
    endDate,
    deposits: 'checked',
    withdrawals: 'checked',
    adjustments: 'checked',
    transfers: 'checked',
    fess: 'checked',
    promotional: 'checked',
    balances: 'checked',
    distribution: 'unchecked',
    freeFlag: 'player',
  };
}

function validateReportDateRange(start: string, end: string): void {
  const startDate = parseWebLogDate(start);
  const endDate = parseWebLogDate(end);
  if (!startDate || !endDate) {
    throw new Error('Invalid getAgentPerformance date range');
  }
  if (startDate.getTime() > endDate.getTime()) {
    throw new Error('getAgentPerformance start date must be before end date');
  }
  const days = Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
  if (days > 366) {
    throw new Error('getAgentPerformance supports a maximum 366-day range');
  }
}

function normalizeWebLogRow(raw: any): BuckeyeWebLogRow {
  return {
    LoginID: String(raw.LoginID || raw.Login || raw.CustomerID || '').trim(),
    IPAddress: String(raw.IPAddress || raw.IP || raw.ip || '').trim(),
    AccessDateTime: String(raw.AccessDateTime || raw.DateTime || raw.CreatedAt || '').trim(),
    Operation: String(raw.Operation || '').trim(),
    Data: String(raw.Data || '').trim(),
    raw: raw && typeof raw === 'object' ? raw : {},
  };
}
