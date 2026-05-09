/**
 * Scraper Manager
 * Manages HTTP polling lifecycle for Buckeye API clients.
 * Replaces Puppeteer-based scraper management.
 */

import type { Database } from '../database';
import {
  BuckeyeAPI,
  BuckeyeCredentials,
  type BuckeyeManagerSnapshotResult,
  type BuckeyeWeeklyFigureOptions,
} from './BuckeyeAPI';
import { LiveAgentTree } from './LiveAgentTree';
import { evaluateWager, Alert } from '../risk/AlertEngine';
import { WebhookService } from '../services/WebhookService';
import { PatternService } from '../patterns/PatternService';
import { ActionQueue } from '../actions/ActionQueue';

interface AgentInstance {
  api: BuckeyeAPI;
  intervalId: ReturnType<typeof setInterval>;
  renewalId: ReturnType<typeof setInterval>;
  accessLogId?: ReturnType<typeof setInterval>;
  credentials: BuckeyeCredentials;
  lastPoll: number;
  errorCount: number;
  consecutiveErrors: number;
  currentPollMs: number;
  reloginAttempts: number;
  liveTree?: LiveAgentTree;
  isPolling: boolean; // guard against concurrent polls
}

export class BuckeyeScraperManager {
  private agents: Map<string, AgentInstance> = new Map();
  private db: Database;
  private broadcast: (msg: object) => void;
  private pollIntervalMs: number = 5000;
  private tokenRenewalMs: number = 15 * 60 * 1000; // 15 minutes
  private accessLogIntervalMs: number = 10 * 60 * 1000;
  private webhookService: WebhookService;
  private patternService: PatternService;
  private actionQueue: ActionQueue;
  private accountInfoCache: Map<string, { data: any; timestamp: number }> = new Map();
  private accountInfoCacheTtlMs: number = 5 * 60 * 1000;
  private wagerCount: number = 0;
  private alertCount: number = 0;
  private errorCount: number = 0;

  private debugMode: boolean;

  constructor(db: Database, broadcast: (msg: object) => void, debugMode: boolean = false) {
    this.db = db;
    this.broadcast = broadcast;
    this.debugMode = debugMode;
    this.webhookService = new WebhookService(db);
    this.patternService = new PatternService(db, broadcast);
    this.actionQueue = new ActionQueue(db, broadcast, 30_000, async (request) => this.executeBetAction(request));
  }

  /**
   * Start polling for an agent.
   */
  async startAgent(agentId: string, credentials: BuckeyeCredentials): Promise<void> {
    if (this.agents.has(agentId)) {
      console.log(`[Manager] Agent ${agentId} already active`);
      return;
    }

    const api = new BuckeyeAPI(credentials, this.debugMode);
    const loginOk = await api.login();
    if (!loginOk) {
      throw new Error(`Login failed for agent ${agentId}`);
    }

    const instance: AgentInstance = {
      api,
      intervalId: setInterval(() => this.pollAgent(agentId), this.pollIntervalMs),
      renewalId: setInterval(() => this.renewToken(agentId), this.tokenRenewalMs),
      credentials,
      lastPoll: Date.now(),
      errorCount: 0,
      consecutiveErrors: 0,
      currentPollMs: this.pollIntervalMs,
      reloginAttempts: 0,
      isPolling: false,
    };

    this.agents.set(agentId, instance);
    await this.initializeLiveAgentTree(agentId, instance);
    this.startAccessLogPolling(agentId, instance);
    console.log(`[Manager] Started polling for ${agentId} every ${this.pollIntervalMs}ms`);

    // Fire first poll immediately (not via setImmediate to avoid microtask cascade)
    setTimeout(() => this.pollAgent(agentId), 0);
    setTimeout(() => this.refreshAccessLogs(agentId).catch(err => console.warn(`[Manager] Access log refresh failed for ${agentId}:`, err.message)), 1000);
  }

  /**
   * Resume polling for an agent using a stored JWT token.
   * Skips login if the token is still valid.
   */
  async resumeAgent(agentId: string, credentials: BuckeyeCredentials, token: string): Promise<boolean> {
    if (this.agents.has(agentId)) {
      console.log(`[Manager] Agent ${agentId} already active`);
      return true;
    }

    const api = new BuckeyeAPI(credentials, this.debugMode);
    // Inject the stored token directly
    (api as any).token = token;
    (api as any).loggedIn = true;

    // Test if token still works
    const accessOk = await api.testAccess();
    if (!accessOk) {
      console.log(`[Manager] Stored token invalid for ${agentId}, needs re-login`);
      return false;
    }

    const instance: AgentInstance = {
      api,
      intervalId: setInterval(() => this.pollAgent(agentId), this.pollIntervalMs),
      renewalId: setInterval(() => this.renewToken(agentId), this.tokenRenewalMs),
      credentials,
      lastPoll: Date.now(),
      errorCount: 0,
      consecutiveErrors: 0,
      currentPollMs: this.pollIntervalMs,
      reloginAttempts: 0,
      isPolling: false,
    };

    this.agents.set(agentId, instance);
    await this.initializeLiveAgentTree(agentId, instance);
    this.startAccessLogPolling(agentId, instance);
    console.log(`[Manager] Resumed session for ${agentId}`);

    // Fire first poll immediately
    setTimeout(() => this.pollAgent(agentId), 0);
    setTimeout(() => this.refreshAccessLogs(agentId).catch(err => console.warn(`[Manager] Access log refresh failed for ${agentId}:`, err.message)), 1000);
    return true;
  }

  getAgentInstance(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }

  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Stop polling for an agent.
   */
  stopAgent(agentId: string): void {
    const instance = this.agents.get(agentId);
    if (!instance) return;

    clearInterval(instance.intervalId);
    clearInterval(instance.renewalId);
    if (instance.accessLogId) clearInterval(instance.accessLogId);
    this.actionQueue.clearAgent(agentId);
    this.agents.delete(agentId);
    console.log(`[Manager] Stopped polling for ${agentId}`);
  }

  /**
   * Force immediate refresh.
   */
  async forceRefresh(agentId: string): Promise<void> {
    await this.pollAgent(agentId);
  }

  async forceAccessLogRefresh(agentId: string): Promise<any> {
    return this.refreshAccessLogs(agentId);
  }

  /**
   * Get agent data from database.
   */
  async getAgentData(agentId: string): Promise<any> {
    const wagers = await this.db.all(
      'SELECT * FROM wagers WHERE agent_login = ? ORDER BY insert_datetime DESC LIMIT 200',
      [agentId]
    );

    const alerts = await this.db.all(
      'SELECT * FROM alerts WHERE is_resolved = 0 ORDER BY created_at DESC LIMIT 50'
    );

    const agentRow = await this.db.get(
      'SELECT agent_login, COUNT(*) as wager_count, SUM(amount_wagered) as total_volume FROM wagers WHERE agent_login = ?',
      [agentId]
    );

    return {
      agent: agentRow || null,
      wagers,
      alerts,
    };
  }

  /**
   * Get global stats.
   */
  async getStats(): Promise<any> {
    const totalWagers = await this.db.get('SELECT COUNT(*) as count FROM wagers');
    const totalVolume = await this.db.get('SELECT SUM(amount_wagered) as total FROM wagers');
    const agentCount = await this.db.get('SELECT COUNT(DISTINCT agent_login) as count FROM wagers');
    const alertCount = await this.db.get('SELECT COUNT(*) as count FROM alerts WHERE is_resolved = 0');
    const liveCount = await this.db.get("SELECT COUNT(*) as count FROM wagers WHERE ticket_writer = 'GSLIVE'");

    return {
      totalWagers: totalWagers?.count || 0,
      totalVolume: totalVolume?.total || 0,
      agentCount: agentCount?.count || 0,
      alertCount: alertCount?.count || 0,
      liveCount: liveCount?.count || 0,
    };
  }

  /**
   * Get all wagers (paginated).
   */
  async getWagers(limit: number = 200, offset: number = 0): Promise<any[]> {
    return this.db.all(
      'SELECT * FROM wagers ORDER BY insert_datetime DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
  }

  /**
   * Get alert wagers.
   */
  async getAlertWagers(): Promise<any[]> {
    return this.db.all(
      "SELECT * FROM wagers WHERE ticket_writer = 'ALERT' ORDER BY insert_datetime DESC LIMIT 200"
    );
  }

  /**
   * Get live (GSLIVE) wagers.
   */
  async getLiveWagers(): Promise<any[]> {
    return this.db.all(
      "SELECT * FROM wagers WHERE ticket_writer = 'GSLIVE' ORDER BY insert_datetime DESC LIMIT 200"
    );
  }

  /**
   * Get top agents by volume.
   */
  async getAgents(): Promise<any[]> {
    return this.db.all(
      `SELECT agent_login,
        COUNT(*) as wager_count,
        SUM(amount_wagered) as total_volume,
        SUM(volume_amount) as total_risk
      FROM wagers
      GROUP BY agent_login
      ORDER BY total_volume DESC
      LIMIT 100`
    );
  }

  /**
   * Get active alerts.
   */
  async getAlerts(): Promise<any[]> {
    return this.db.all(
      'SELECT * FROM alerts WHERE is_resolved = 0 ORDER BY created_at DESC LIMIT 100'
    );
  }

  /**
   * Get agent downline derived from wager data.
   */
  async getAgentDownline(): Promise<any[]> {
    return this.db.all(
      `SELECT
        agent_login,
        COUNT(*) as wager_count,
        COUNT(DISTINCT login) as player_count,
        SUM(amount_wagered) as total_volume,
        SUM(volume_amount) as total_risk,
        SUM(CASE WHEN ticket_writer = 'ALERT' THEN 1 ELSE 0 END) as alert_count,
        SUM(CASE WHEN ticket_writer = 'GSLIVE' THEN 1 ELSE 0 END) as live_count,
        MAX(insert_datetime) as last_wager_at
      FROM wagers
      GROUP BY agent_login
      ORDER BY total_volume DESC
      LIMIT 200`
    );
  }

  /**
   * Get real agent hierarchy from Buckeye API.
   * Returns raw GENERAL array or empty object if not authenticated.
   */
  async getAgentHierarchy(agentId?: string): Promise<any> {
    const instance = agentId
      ? this.agents.get(agentId)
      : Array.from(this.agents.values()).find((agent) => agent.api.isAuthenticated());

    if (!instance || !instance.api.isAuthenticated()) {
      return { GENERAL: [], message: 'Not authenticated to Buckeye' };
    }
    try {
      const data = await instance.api.getAgentHierarchy();
      return data;
    } catch (err: any) {
      console.error('[ScraperManager] getAgentHierarchy error:', err.message);
      return { GENERAL: [], error: err.message };
    }
  }

  /**
   * Fetch language/theme UI config through an active Buckeye session.
   */
  async getBuckeyeUiConfig(
    agentId?: string,
    includeRaw: boolean = false,
    includeAgentParams: boolean = false
  ): Promise<any> {
    const instance = agentId
      ? this.agents.get(agentId)
      : Array.from(this.agents.values()).find((agent) => agent.api.isAuthenticated());

    if (!instance || !instance.api.isAuthenticated()) {
      return { parsed: null, message: 'Not authenticated to Buckeye' };
    }

    try {
      return await instance.api.getLanguageUiConfig({ includeRaw, includeAgentParams });
    } catch (err: any) {
      console.error('[ScraperManager] getBuckeyeUiConfig error:', err.message);
      return { parsed: null, error: err.message };
    }
  }

  /**
   * Fetch sanitized account info through an active Buckeye session.
   */
  async getBuckeyeAccountInfo(agentId?: string, force: boolean = false): Promise<any> {
    const instance = agentId
      ? this.agents.get(agentId)
      : Array.from(this.agents.values()).find((agent) => agent.api.isAuthenticated());

    if (!instance || !instance.api.isAuthenticated()) {
      return { accountInfo: null, message: 'Not authenticated to Buckeye' };
    }

    try {
      const cacheKey = agentId || instance.credentials.agentId;
      const cached = this.accountInfoCache.get(cacheKey);
      if (!force && cached && Date.now() - cached.timestamp < this.accountInfoCacheTtlMs) {
        return cached.data;
      }

      const data = await instance.api.getAccountInfoOwner();
      this.accountInfoCache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (err: any) {
      console.error('[ScraperManager] getBuckeyeAccountInfo error:', err.message);
      return { accountInfo: null, error: err.message };
    }
  }

  /**
   * Fetch weekly figure report through an active Buckeye session.
   */
  async getWeeklyFigureByAgentLite(
    agentId?: string,
    options: BuckeyeWeeklyFigureOptions = {}
  ): Promise<any> {
    const instance = agentId
      ? this.agents.get(agentId)
      : Array.from(this.agents.values()).find((agent) => agent.api.isAuthenticated());

    if (!instance || !instance.api.isAuthenticated()) {
      return { data: null, message: 'Not authenticated to Buckeye' };
    }

    try {
      return await instance.api.getWeeklyFigureByAgentLite(options);
    } catch (err: any) {
      console.error('[ScraperManager] getWeeklyFigureByAgentLite error:', err.message);
      return { data: null, error: err.message };
    }
  }

  /**
   * Fetch Buckeye manager bootstrap/report payloads discovered from manager.html.
   */
  async getBuckeyeManagerSnapshot(agentId?: string): Promise<BuckeyeManagerSnapshotResult | any> {
    const instance = this.resolveAgentInstance(agentId);

    if (!instance || !instance.api.isAuthenticated()) {
      return { data: null, message: 'Not authenticated to Buckeye' };
    }

    try {
      return await instance.api.getManagerSnapshot();
    } catch (err: any) {
      console.error('[ScraperManager] getBuckeyeManagerSnapshot error:', err.message);
      return { data: null, error: err.message };
    }
  }

  /**
   * Get per-agent performance metrics.
   */
  async getAgentPerformance(agentId: string): Promise<any> {
    const overview = await this.db.get(
      `SELECT
        COUNT(*) as wager_count,
        COUNT(DISTINCT login) as unique_players,
        SUM(amount_wagered) as total_volume,
        SUM(volume_amount) as total_risk,
        SUM(to_win_amount) as total_potential_payout,
        AVG(amount_wagered) as avg_wager,
        MAX(amount_wagered) as max_wager,
        MIN(insert_datetime) as first_wager_at,
        MAX(insert_datetime) as last_wager_at
      FROM wagers
      WHERE agent_login = ?`,
      [agentId]
    );

    const typeBreakdown = await this.db.all(
      `SELECT
        wager_type,
        COUNT(*) as count,
        SUM(amount_wagered) as volume
      FROM wagers
      WHERE agent_login = ?
      GROUP BY wager_type`,
      [agentId]
    );

    const sourceBreakdown = await this.db.all(
      `SELECT
        ticket_writer,
        COUNT(*) as count,
        SUM(amount_wagered) as volume
      FROM wagers
      WHERE agent_login = ?
      GROUP BY ticket_writer`,
      [agentId]
    );

    return {
      agentId,
      overview: overview || {},
      typeBreakdown,
      sourceBreakdown,
    };
  }

  /**
   * Get player details from wager data.
   */
  async getPlayerDetails(playerId: string): Promise<any> {
    const profile = await this.db.get(
      `SELECT
        login,
        agent_login,
        COUNT(*) as wager_count,
        SUM(amount_wagered) as total_volume,
        SUM(volume_amount) as total_risk,
        SUM(to_win_amount) as total_potential_payout,
        -- Projection only: wagered amount minus possible payout, not settled P/L.
        COALESCE(SUM(amount_wagered), 0) - COALESCE(SUM(to_win_amount), 0) as projected_net_exposure,
        AVG(amount_wagered) as avg_wager,
        MAX(amount_wagered) as max_wager,
        MIN(insert_datetime) as first_wager_at,
        MAX(insert_datetime) as last_wager_at
      FROM wagers
      WHERE login = ?`,
      [playerId]
    );

    const agents = await this.db.all(
      `SELECT DISTINCT agent_login FROM wagers WHERE login = ?`,
      [playerId]
    );

    return {
      playerId,
      profile: profile && profile.wager_count > 0 ? profile : {},
      agents: agents.map((a) => a.agent_login),
    };
  }

  /**
   * Get all wagers for a specific player.
   */
  async getPlayerWagers(playerId: string): Promise<any[]> {
    return this.db.all(
      `SELECT * FROM wagers WHERE login = ? ORDER BY insert_datetime DESC LIMIT 200`,
      [playerId]
    );
  }

  /**
   * Get player P&L history over N days.
   * Returns daily buckets with volume, risk, and wager count.
   */
  async getPlayerPnlHistory(playerId: string, days: number = 7): Promise<any[]> {
    const rows = await this.db.all(
      `SELECT
        date(insert_datetime) as day,
        COUNT(*) as wager_count,
        SUM(amount_wagered) as volume,
        SUM(volume_amount) as risk,
        SUM(to_win_amount) as potential_payout
      FROM wagers
      WHERE login = ? AND insert_datetime >= date('now', '-' || ? || ' days')
      GROUP BY date(insert_datetime)
      ORDER BY day DESC`,
      [playerId, days]
    );

    // Fill in missing days with zeros
    const result = [];
    const seenDays = new Set(rows.map((r) => r.day));
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().split('T')[0];
      if (seenDays.has(dayStr)) {
        result.push(rows.find((r) => r.day === dayStr));
      } else {
        result.push({
          day: dayStr,
          wager_count: 0,
          volume: 0,
          risk: 0,
          potential_payout: 0,
        });
      }
    }
    return result;
  }

  /**
   * Get metrics for health endpoint.
   */
  /**
   * Get sport exposure breakdown with top game per sport.
   */
  private getWagerExposure(w: any): number {
    return (w.volume_amount > 0 ? w.volume_amount : w.amount_wagered) || 0;
  }

  async getSportExposure(): Promise<any[]> {
    const wagers = await this.db.all(
      `SELECT * FROM wagers ORDER BY insert_datetime DESC LIMIT 500`
    );

    if (wagers.length === 0) return [];

    const totalVolume = wagers.reduce((s, w) => s + this.getWagerExposure(w), 0);

    // Group by sport
    const sportGroups: Record<string, any[]> = {};
    for (const w of wagers) {
      const sport = w.sport || this.parseSport(w.short_desc);
      if (!sportGroups[sport]) sportGroups[sport] = [];
      sportGroups[sport].push(w);
    }

    const result = [];
    for (const [sport, sws] of Object.entries(sportGroups)) {
      const sportVolume = sws.reduce((s, w) => s + this.getWagerExposure(w), 0);
      const liveCount = sws.filter(w => w.ticket_writer === 'GSLIVE').length;

      // Group by game within sport
      const gameGroups: Record<string, any[]> = {};
      for (const w of sws) {
        const game = this.parseGame(w.short_desc);
        if (!gameGroups[game]) gameGroups[game] = [];
        gameGroups[game].push(w);
      }

      // Find top game by volume
      let topGame = '';
      let topGameVolume = 0;
      let topGameWagers: any[] = [];
      for (const [game, gws] of Object.entries(gameGroups)) {
        const gv = gws.reduce((s, w) => s + this.getWagerExposure(w), 0);
        if (gv > topGameVolume) {
          topGameVolume = gv;
          topGame = game;
          topGameWagers = gws;
        }
      }

      // Find most popular side in top game
      const sideCounts: Record<string, { count: number; volume: number; price: string }> = {};
      for (const w of topGameWagers) {
        const side = this.parseSide(w.short_desc);
        const price = this.extractPrice(w.short_desc);
        if (!sideCounts[side]) sideCounts[side] = { count: 0, volume: 0, price };
        sideCounts[side].count++;
        sideCounts[side].volume += this.getWagerExposure(w);
      }

      let topSide = '';
      let topSideVolume = 0;
      let topSidePrice = '';
      for (const [side, data] of Object.entries(sideCounts)) {
        if (data.volume > topSideVolume) {
          topSideVolume = data.volume;
          topSide = side;
          topSidePrice = data.price;
        }
      }

      result.push({
        sport,
        total: sportVolume,
        pct: totalVolume > 0 ? ((sportVolume / totalVolume) * 100).toFixed(1) : '0.0',
        live: liveCount,
        wagerCount: sws.length,
        topGame,
        side: topSide || '—',
        price: topSidePrice || '—',
        gameTotal: topGameVolume,
      });
    }

    return result.sort((a, b) => b.total - a.total);
  }

  /**
   * Get agent exposure breakdown with top customer and top game per agent.
   */
  async getAgentExposure(): Promise<any[]> {
    const wagers = await this.db.all(
      `SELECT * FROM wagers ORDER BY insert_datetime DESC LIMIT 500`
    );

    if (wagers.length === 0) return [];

    const totalVolume = wagers.reduce((s, w) => s + this.getWagerExposure(w), 0);

    // Group by agent
    const agentGroups: Record<string, any[]> = {};
    for (const w of wagers) {
      const agent = w.agent_login || 'Unknown';
      if (!agentGroups[agent]) agentGroups[agent] = [];
      agentGroups[agent].push(w);
    }

    const result = [];
    for (const [agent, aws] of Object.entries(agentGroups)) {
      const agentVolume = aws.reduce((s, w) => s + this.getWagerExposure(w), 0);
      const liveCount = aws.filter(w => w.ticket_writer === 'GSLIVE').length;

      // Top customer
      const customerGroups: Record<string, number> = {};
      for (const w of aws) {
        const c = w.login || 'Unknown';
        customerGroups[c] = (customerGroups[c] || 0) + this.getWagerExposure(w);
      }
      let topCustomer = '';
      let topCustomerVol = 0;
      for (const [c, v] of Object.entries(customerGroups)) {
        if (v > topCustomerVol) {
          topCustomerVol = v;
          topCustomer = c;
        }
      }

      // Top game
      const gameGroups: Record<string, { volume: number; count: number }> = {};
      for (const w of aws) {
        const game = this.parseGame(w.short_desc);
        if (!gameGroups[game]) gameGroups[game] = { volume: 0, count: 0 };
        gameGroups[game].volume += this.getWagerExposure(w);
        gameGroups[game].count++;
      }
      let topGame = '';
      let topGameVol = 0;
      let topGameCount = 0;
      for (const [g, d] of Object.entries(gameGroups)) {
        if (d.volume > topGameVol) {
          topGameVol = d.volume;
          topGame = g;
          topGameCount = d.count;
        }
      }

      result.push({
        agent,
        total: agentVolume,
        pct: totalVolume > 0 ? ((agentVolume / totalVolume) * 100).toFixed(1) : '0.0',
        live: liveCount,
        wagerCount: aws.length,
        topCustomer: topCustomer || '—',
        topCustomerVol: topCustomerVol,
        topGame: topGame || '—',
        topGameVol: topGameVol,
        topGameCount,
      });
    }

    return result.sort((a, b) => b.total - a.total);
  }

  getWebhookService(): WebhookService {
    return this.webhookService;
  }

  getActionQueue(): ActionQueue {
    return this.actionQueue;
  }

  private async executeBetAction(request: {
    id: string;
    agentId: string;
    wagerNumber: number;
    action: 'accept' | 'decline';
  }): Promise<any> {
    const instance = this.agents.get(request.agentId);
    if (!instance || !instance.api.isAuthenticated()) {
      return {
        id: request.id,
        success: false,
        action: request.action,
        wagerNumber: request.wagerNumber,
        message: 'Agent is not connected',
        error: `Agent ${request.agentId} is not connected`,
      };
    }

    return {
      id: request.id,
      success: false,
      action: request.action,
      wagerNumber: request.wagerNumber,
      message: 'Bet action endpoint not configured',
      error: 'Buckeye accept/decline endpoint is not configured yet',
    };
  }

  getMetrics(): any {
    return {
      activeAgents: this.agents.size,
      agents: Array.from(this.agents.entries()).map(([id, inst]) => ({
        agentId: id,
        lastPoll: inst.lastPoll,
        errorCount: inst.errorCount,
        authenticated: inst.api.isAuthenticated(),
      })),
      actionQueue: this.actionQueue.getMetrics(),
      counters: {
        wagers_total: this.wagerCount,
        alerts_triggered_total: this.alertCount,
        errors_total: this.errorCount,
      },
    };
  }

  private resolveAgentInstance(agentId?: string): AgentInstance | undefined {
    return agentId
      ? this.agents.get(agentId)
      : Array.from(this.agents.values()).find((agent) => agent.api.isAuthenticated());
  }

  private async initializeLiveAgentTree(agentId: string, instance: AgentInstance): Promise<void> {
    try {
      const hierarchy = await instance.api.getAgentHierarchy();
      const agents = Array.isArray(hierarchy?.GENERAL) ? hierarchy.GENERAL : [];
      instance.liveTree = new LiveAgentTree(agents);
    } catch (err) {
      console.warn(`[Manager] Live agent tree hierarchy unavailable for ${agentId}; using wager-only deltas`);
      instance.liveTree = new LiveAgentTree([]);
    }

    instance.liveTree.onUpdate((delta) => {
      this.broadcast({
        type: 'agentUpdate',
        timestamp: new Date().toISOString(),
        agentId: delta.agent,
        payload: delta,
      });
    });
  }

  /**
   * Poll a single agent.
   */
  private async pollAgent(agentId: string): Promise<void> {
    const instance = this.agents.get(agentId);
    if (!instance) return;

    // Guard against concurrent polls (e.g., if a poll takes longer than the interval)
    if (instance.isPolling) {
      console.warn(`[Manager] Skipping poll for ${agentId} — previous poll still running`);
      return;
    }
    instance.isPolling = true;

    try {
      const wagers = await instance.api.getBetTicker();
      instance.lastPoll = Date.now();
      instance.errorCount = 0;
      instance.consecutiveErrors = 0;
      instance.reloginAttempts = 0;

      // Reset poll interval to normal on success
      if (instance.currentPollMs !== this.pollIntervalMs) {
        instance.currentPollMs = this.pollIntervalMs;
        clearInterval(instance.intervalId);
        instance.intervalId = setInterval(() => this.pollAgent(agentId), instance.currentPollMs);
      }

      const changes = instance.api.detectChanges(wagers);

      for (const change of changes) {
        const correlation = await this.persistWager(change.wager);

        if (change.type === 'new') {
          this.wagerCount++;
          const patterns = await this.patternService.analyzeWager(change.wager, correlation);
          await this.patternService.persistPatterns(patterns);

          instance.liveTree?.processWager(change.wager);
          this.broadcast({
            type: 'wager.new',
            timestamp: new Date().toISOString(),
            payload: change.wager,
          });
        }
      }

      // Evaluate alerts on new wagers
      const newChanges = changes.filter((c) => c.type === 'new');
      if (newChanges.length > 0) {
        for (const change of newChanges) {
          const alerts = evaluateWager(change.wager);
          for (const alert of alerts) {
            this.alertCount++;
            await this.persistAlert(alert);
            instance.liveTree?.processAlert(change.wager.AgentLogin || change.wager.AgentID);
            this.broadcast({
              type: 'wager.alert',
              timestamp: new Date().toISOString(),
              payload: alert,
            });
            // Dispatch to configured webhooks
            await this.webhookService.dispatchAlert(alert);
          }
        }

        // Recalculate exposure and broadcast
        this.broadcast({
          type: 'exposure.update',
          timestamp: new Date().toISOString(),
          payload: {},
        });
      }
    } catch (error) {
      instance.errorCount++;
      instance.consecutiveErrors++;
      this.errorCount++;
      console.error(`[Manager] Poll error for ${agentId}:`, error);

      // Backoff: increase poll interval on consecutive errors
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, instance.consecutiveErrors),
        60000 // cap at 60s
      );
      if (backoffMs !== instance.currentPollMs) {
        instance.currentPollMs = backoffMs;
        clearInterval(instance.intervalId);
        instance.intervalId = setInterval(() => this.pollAgent(agentId), instance.currentPollMs);
        console.log(`[Manager] Backing off ${agentId} to ${backoffMs}ms`);
      }

      // Re-auth if session expired
      if (!instance.api.isAuthenticated() || instance.consecutiveErrors >= 3) {
        if (instance.reloginAttempts < 3) {
          instance.reloginAttempts++;
          console.log(`[Manager] Re-authenticating ${agentId} (attempt ${instance.reloginAttempts})...`);
          const ok = await instance.api.login();
          if (!ok) {
            console.warn(`[Manager] Re-login failed for ${agentId}`);
          }
        } else {
          console.error(`[Manager] Max re-login attempts reached for ${agentId}. Stopping.`);
          this.broadcast({
            type: 'auth_failed',
            timestamp: new Date().toISOString(),
            agentId,
            message: 'Session expired. Please reconnect.',
          });
          this.stopAgent(agentId);
        }
      }
    } finally {
      instance.isPolling = false;
    }
  }

  /**
   * Renew session token.
   */
  private async renewToken(agentId: string): Promise<void> {
    const instance = this.agents.get(agentId);
    if (!instance) return;

    const ok = await instance.api.renewToken();
    if (!ok) {
      console.warn(`[Manager] Token renewal failed for ${agentId}, will re-auth on next poll`);
    }
  }

  /**
   * Insert or replace wager in database.
   */
  private async persistWager(wager: any): Promise<Awaited<ReturnType<PatternService['correlateWager']>>> {
    const correlation = await this.patternService.correlateWager(wager);
    const parsed = correlation.parsed;

    await this.db.run(
      `INSERT OR REPLACE INTO wagers
      (wager_number, agent_id, customer_id, login, wager_type,
       amount_wagered, to_win_amount, volume_amount, insert_datetime,
       ticket_writer, short_desc, vip, agent_login, sport,
       parsed_game, parsed_market, parsed_side, parsed_price, parsed_period,
       matched_event_id, pin_reference_json, scraped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        wager.WagerNumber,
        wager.AgentID,
        wager.CustomerID,
        wager.Login,
        wager.WagerType,
        wager.AmountWagered,
        wager.ToWinAmount,
        wager.VolumeAmount,
        wager.InsertDateTime,
        wager.TicketWriter,
        wager.ShortDesc,
        wager.VIP,
        wager.AgentLogin,
        this.parseSport(wager.ShortDesc),
        parsed.game,
        parsed.market,
        parsed.side,
        parsed.price,
        parsed.period,
        correlation.match.eventId,
        JSON.stringify(correlation.pinReference || {}),
        new Date().toISOString(),
      ]
    );

    return correlation;
  }

  async getAccessLogs(limit: number = 200): Promise<any[]> {
    return this.db.all(
      `SELECT * FROM access_logs ORDER BY access_datetime DESC LIMIT ?`,
      [Math.min(Math.max(limit, 1), 500)]
    );
  }

  private startAccessLogPolling(agentId: string, instance: AgentInstance): void {
    if (instance.accessLogId) clearInterval(instance.accessLogId);
    instance.accessLogId = setInterval(() => {
      this.refreshAccessLogs(agentId).catch(err => {
        console.warn(`[Manager] Access log refresh failed for ${agentId}:`, err.message);
      });
    }, this.accessLogIntervalMs);
  }

  private async refreshAccessLogs(agentId: string): Promise<{ fetched: number; inserted: number; patterns: number }> {
    const instance = this.agents.get(agentId);
    if (!instance) throw new Error(`Agent ${agentId} is not active`);

    const end = new Date();
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const rows = await instance.api.getWebLog({
      start: this.formatWebLogDate(start),
      end: this.formatWebLogDate(end),
      type: 'A',
      actions: 'ALL',
    });
    const inserted = await this.patternService.persistAccessLogs(agentId, rows, 'A');
    const patterns = await this.patternService.analyzeAccessLogs(agentId);
    const persisted = await this.patternService.persistPatterns(patterns);
    return { fetched: rows.length, inserted, patterns: persisted.length };
  }

  /**
   * Insert alert into database.
   */
  private async persistAlert(alert: Alert): Promise<void> {
    await this.db.run(
      `INSERT INTO alerts
      (wager_number, rule_name, severity, message, created_at)
      VALUES (?, ?, ?, ?, ?)`,
      [alert.wagerNumber, alert.ruleName, alert.severity, alert.message, new Date().toISOString()]
    );
  }

  private parseSport(desc: string): string {
    if (!desc) return 'Other';
    desc = this.decodeEntities(desc);
    // GSLIVE: "M.G123456 - Top Soccer - ..." or "M.G123456 - Tennis - ..."
    const match = desc.match(/^[A-Z][.:]G?\d+\s*-\s*(?:Top\s+)?([A-Za-z]+)/);
    if (match) return match[1];
    // Standard: "M.Soccer #123..." or "P:Baseball #123..." or "C:FOOTBALL..."
    const direct = desc.match(/^[A-Z][.:]([A-Za-z\s]+?)(?:\s*#|\s*-|\s*$)/);
    if (direct) {
      const s = direct[1].trim();
      if (s.length > 1) return s;
    }
    // Fallback keyword search
    if (desc.includes('Martial Arts') || desc.includes('MMA')) return 'MMA';
    if (desc.includes('Basketball')) return 'Basketball';
    if (desc.includes('Baseball')) return 'Baseball';
    if (desc.includes('Tennis')) return 'Tennis';
    if (desc.includes('Soccer')) return 'Soccer';
    if (desc.includes('Hockey')) return 'Hockey';
    if (desc.includes('Golf')) return 'Golf';
    if (desc.includes('Football')) return 'Football';
    return 'Other';
  }

  private formatWebLogDate(date: Date): string {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${date.getFullYear()}`;
  }

  private parseGame(desc: string): string {
    if (!desc) return 'Unknown';
    desc = this.decodeEntities(desc);
    // Handle parlays with \r\n
    if (desc.includes('\r\n')) {
      const firstLeg = desc.split('\r\n')[0];
      const legCount = (desc.match(/ - For Game /g) || []).length;
      const game = this.parseGameSingle(firstLeg);
      return legCount > 1 ? `${game} (+${legCount - 1} legs)` : game;
    }
    return this.parseGameSingle(desc);
  }

  private parseGameSingle(desc: string): string {
    desc = this.decodeEntities(desc);
    // GSLIVE: "M.G123456 - Top Tennis - Player vs Player..."
    const gs = desc.match(/^[A-Z][.:]G?\d+\s+-\s+(?:Top\s+)?\w+\s+-\s+(.+?)(?:\s+\/|\s+-\s+For\s|$)/);
    if (gs) return gs[1].trim().substring(0, 35);
    // Standard: "M.Soccer #203202 Lens -230 - For Game" or "P:Baseball #959 Braves +102 - For Game"
    const std = desc.match(/^[A-Z][.:\s][\w\s]+?\s+#\d+\s+(.+?)(?:\s+-\s+For\s|\s+for\s+Game|\s+\/|\s+-\s+\d)/i);
    if (std) return std[1].trim().substring(0, 35);
    // Futures: "C:FOOTBALL - #NFL Futures - ... - New Orleans Saints +265 for Game"
    const futures = desc.match(/-\s+([A-Za-z][A-Za-z\s'.-]+?)(?:\s+[+-]\d+(?:\.\d+)?)\s+(?:for\s+Game|-\s+For\s+Game|$)/i);
    if (futures) return futures[1].trim().substring(0, 35);
    // vs / @ pattern
    const vs = desc.match(/([A-Za-z][A-Za-z\s'.-]{1,20}(?:\s+vs\.?|\s+VS\.?|\s+@)\s+[A-Za-z][A-Za-z\s'.-]{1,20})/);
    if (vs) return vs[1].trim().substring(0, 35);
    return 'Unknown';
  }

  private parseSide(desc: string): string {
    if (!desc) return '';
    desc = this.decodeEntities(desc);
    // Remove prefix and suffix noise
    let clean = desc.replace(/^[A-Z][.:]\s*/, '');
    clean = clean.replace(/^G\d+\s*-\s*/, '');
    clean = clean.replace(/\s+-\s+For\s+.*$/i, '');
    clean = clean.replace(/\s+for\s+Game\s*$/i, '');
    clean = clean.replace(/\s+\/\s+(Teaser|Straight|Parlay)\s+\/\s+[^/]+$/i, '');
    clean = clean.replace(/^#\d+\s+/, '');

    // Remove futures category markers (letter-only words, not game IDs with digits)
    clean = clean.replace(/#[A-Za-z]+(?:\s+[A-Za-z]+)*\s*-\s*/g, '');
    clean = clean.replace(/#[A-Za-z]+(?:\s+[A-Za-z]+)*\s*/g, '');

    // Remove #ID numbers and sport prefix
    clean = clean.replace(/\s+#\d+\s*/g, ' ').trim();
    const sport = this.parseSport(desc);
    if (sport !== 'Other') {
      clean = clean.replace(new RegExp(`^${sport}\\s*`, 'i'), '');
    }
    clean = clean.replace(/^(Martial Arts|Boxing|Rugby)\s*/i, '');

    // Extract price first, then remove it from clean
    const price = this.extractPrice(clean);
    if (price) {
      clean = clean.replace(new RegExp(`\\s*[+-]\\d+\\s*$`), '');
    }

    // Extract side — look for team name or prop after the matchup
    // Handle ½, ¼, ¾ as numeric equivalents
    const propMatch = clean.match(/([A-Za-z][A-Za-z\s'.-]*\s+[OU]\s+\d+[½¼¾]?)/i);
    if (propMatch) return propMatch[1].trim().substring(0, 30);

    const spreadMatch = clean.match(/([A-Za-z][A-Za-z\s'.-]*\s+[+-]?\d+[½¼¾]?)/i);
    if (spreadMatch) return spreadMatch[1].trim().substring(0, 30);

    const ouMatch = clean.match(/\b(Over|Under)\s+\d+[½¼¾]?/i);
    if (ouMatch) return ouMatch[0].trim().substring(0, 30);

    // Try extracting just the last meaningful chunk
    const lastChunk = clean.match(/([^-]{3,30})$/);
    if (lastChunk) return lastChunk[1].trim().substring(0, 30);

    return clean.substring(0, 30);
  }

  private extractPrice(desc: string): string {
    if (!desc) return '';
    desc = this.decodeEntities(desc);
    // Look for price before " - For Game" / "for Game" or at the very end
    const m = desc.match(/\s([+-]\d+(?:\.\d+)?)(?:\s+-\s+For|\s+for\s+Game|\s*$)/i);
    return m ? m[1] : '';
  }

  private decodeEntities(desc: string): string {
    return desc.replace(/&#189;/g, '½').replace(/&#188;/g, '¼').replace(/&#190;/g, '¾').replace(/&#038;/g, '&').replace(/&amp;/g, '&');
  }
}
