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
