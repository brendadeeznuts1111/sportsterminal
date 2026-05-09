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
    this.log('getAgentHierarchy returned', data?.GENERAL?.length || 0, 'agents');
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

    return {
      fetchedAt: new Date().toISOString(),
      agentId: this.agentId,
      params: { week, type, layout },
      data: await response.json(),
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

export function buildWebLogBody(agentId: string, options: BuckeyeWebLogOptions): URLSearchParams {
  validateWebLogRange(options);
  return new URLSearchParams({
    agentID: agentId,
    customerID: String(options.customerID ?? 0),
    start: normalizeWebLogDate(options.start, options.type),
    end: normalizeWebLogDate(options.end, options.type),
    type: options.type,
    actions: options.actions || 'ALL',
    ip: options.ip || '',
    operation: 'getWebLog',
    RRO: '1',
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
