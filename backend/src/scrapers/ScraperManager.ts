/**
 * Scraper Manager
 * Manages HTTP polling lifecycle for Buckeye API clients.
 * Replaces Puppeteer-based scraper management.
 */

import type { Database } from '../database';
import {
  BuckeyeAPI,
  BuckeyeCredentials,
  type BuckeyeAgentPerformanceOptions,
  type BuckeyeAgentPerformanceResult,
  type BuckeyeManagerSnapshotResult,
  type BuckeyeWeeklyFigureOptions,
} from './BuckeyeAPI';
import { LiveAgentTree } from './LiveAgentTree';
import { evaluateWager, Alert } from '../risk/AlertEngine';
import { WebhookService } from '../services/WebhookService';
import { PatternService } from '../patterns/PatternService';
import { ActionQueue } from '../actions/ActionQueue';
import { backfillAgentsAndPlayers } from '../services/HierarchyBackfillService';
import type { BunSecretVault } from '../services/BunSecretVault';
import { PerformanceCache } from '../services/PerformanceCache';
import { RawApiLogger } from '../services/RawApiLogger';
import { createManagedInterval, type ManagedIntervalTask } from '../services/Scheduler';

interface AgentInstance {
  api: BuckeyeAPI;
  pollTask: ManagedIntervalTask;
  renewalTask: ManagedIntervalTask;
  masterSnapshotTask?: ManagedIntervalTask;
  accessLogTask?: ManagedIntervalTask;
  performanceTask?: ManagedIntervalTask;
  dailyArchiveTask?: ManagedIntervalTask;
  credentials: BuckeyeCredentials;
  lastPoll: number;
  errorCount: number;
  consecutiveErrors: number;
  currentPollMs: number;
  reloginAttempts: number;
  lastError?: string;
  liveTree?: LiveAgentTree;
  isPolling: boolean; // guard against concurrent polls
}

function getAgentPerformanceRawRows(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const payload = data as any;
  if (Array.isArray(payload?.INFO?.LIST)) return payload.INFO.LIST;
  if (Array.isArray(payload?.LIST)) return payload.LIST;
  return [];
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class BuckeyeScraperManager {
  private agents: Map<string, AgentInstance> = new Map();
  private db: Database;
  private broadcast: (msg: object) => void;
  private pollIntervalMs: number = 5000;
  private tokenRenewalMs: number = 15 * 60 * 1000; // 15 minutes
  private accessLogIntervalMs: number = 5 * 60 * 1000;
  private performanceIntervalMs: number = 15 * 60 * 1000;
  private webhookService: WebhookService;
  private patternService: PatternService;
  private actionQueue: ActionQueue;
  private accountInfoCache: Map<string, { data: any; timestamp: number }> = new Map();
  private accountInfoCacheTtlMs: number = 5 * 60 * 1000;
  private wagerCount: number = 0;
  private alertCount: number = 0;
  private errorCount: number = 0;
  private secretVault?: BunSecretVault;
  private performanceCache?: PerformanceCache;
  private rawApiLogger: RawApiLogger;

  private debugMode: boolean;

  constructor(
    db: Database,
    broadcast: (msg: object) => void,
    debugMode: boolean = false,
    secretVault?: BunSecretVault,
    performanceCache?: PerformanceCache
  ) {
    this.db = db;
    this.broadcast = broadcast;
    this.debugMode = debugMode;
    this.secretVault = secretVault;
    this.performanceCache = performanceCache;
    this.pollIntervalMs = readPositiveIntEnv('POLL_INTERVAL_MS', this.pollIntervalMs);
    this.tokenRenewalMs = readPositiveIntEnv('TOKEN_RENEWAL_MINUTES', 15) * 60 * 1000;
    this.accessLogIntervalMs = readPositiveIntEnv('ACCESS_LOG_INTERVAL_MS', this.accessLogIntervalMs);
    this.performanceIntervalMs = readPositiveIntEnv('AGENT_PERFORMANCE_INTERVAL_MS', this.performanceIntervalMs);
    this.webhookService = new WebhookService(db);
    this.patternService = new PatternService(db, broadcast);
    this.rawApiLogger = new RawApiLogger(db, true);
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

    // Pass token from credentials if available (from vault)
    const api = new BuckeyeAPI(credentials, this.debugMode);

    // If no pre-authenticated token, perform login
    if (!api.loggedIn) {
      const loginOk = await api.login();
      if (!loginOk) {
        throw new Error(`Login failed for agent ${agentId}`);
      }
    } else {
      console.log(`[Manager] Using pre-authenticated token for ${agentId}`);
    }

    const instance: AgentInstance = {
      api,
      pollTask: createManagedInterval(`buckeye.${agentId}.bets`, this.pollIntervalMs, () => this.pollAgent(agentId), {
        initialDelayMs: 0,
      }),
      renewalTask: createManagedInterval(`buckeye.${agentId}.renewal`, this.tokenRenewalMs, () => this.renewToken(agentId)),
      masterSnapshotTask: createManagedInterval(`buckeye.${agentId}.masterSnapshot`, 30 * 60 * 1000, () => this.pollMasterSnapshot(agentId), {
        initialDelayMs: 0,
      }),
      credentials,
      lastPoll: Date.now(),
      errorCount: 0,
      consecutiveErrors: 0,
      currentPollMs: this.pollIntervalMs,
      reloginAttempts: 0,
      lastError: undefined,
      isPolling: false,
    };

    this.agents.set(agentId, instance);
    await this.saveAgentSecrets(agentId, instance);
    await this.initializeLiveAgentTree(agentId, instance);
    this.startAccessLogPolling(agentId, instance);
    this.startPerformancePolling(agentId, instance);
    this.startDailyArchiveRefresh(agentId, instance);
    console.log(`[Manager] Started polling for ${agentId} every ${this.pollIntervalMs}ms`);

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
    api.setToken(token);

    // Test if token still works
    const accessOk = await api.testAccess();
    if (!accessOk) {
      console.log(`[Manager] Stored token invalid for ${agentId}, needs re-login`);
      return false;
    }

    const instance: AgentInstance = {
      api,
      pollTask: createManagedInterval(`buckeye.${agentId}.bets`, this.pollIntervalMs, () => this.pollAgent(agentId), {
        initialDelayMs: 0,
      }),
      renewalTask: createManagedInterval(`buckeye.${agentId}.renewal`, this.tokenRenewalMs, () => this.renewToken(agentId)),
      masterSnapshotTask: createManagedInterval(`buckeye.${agentId}.masterSnapshot`, 30 * 60 * 1000, () => this.pollMasterSnapshot(agentId), {
        initialDelayMs: 0,
      }),
      credentials,
      lastPoll: Date.now(),
      errorCount: 0,
      consecutiveErrors: 0,
      currentPollMs: this.pollIntervalMs,
      reloginAttempts: 0,
      lastError: undefined,
      isPolling: false,
    };

    this.agents.set(agentId, instance);
    await this.saveAgentSecrets(agentId, instance);
    await this.initializeLiveAgentTree(agentId, instance);
    this.startAccessLogPolling(agentId, instance);
    this.startPerformancePolling(agentId, instance);
    this.startDailyArchiveRefresh(agentId, instance);
    console.log(`[Manager] Resumed session for ${agentId}`);

    return true;
  }

  getAgentInstance(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }

  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  isAgentActive(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  getAgentLastError(agentId: string): string | undefined {
    return this.agents.get(agentId)?.lastError;
  }

  /**
   * Stop polling for an agent.
   */
  stopAgent(agentId: string): void {
    const instance = this.agents.get(agentId);
    if (!instance) return;

    instance.pollTask.stop();
    instance.renewalTask.stop();
    instance.masterSnapshotTask?.stop();
    instance.accessLogTask?.stop();
    instance.performanceTask?.stop();
    instance.dailyArchiveTask?.stop();
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

  async getPersistedAgentHierarchy(): Promise<any> {
    try {
      const rows = await this.db.all(
        `SELECT
          id,
          login,
          display_name,
          parent_agent_id,
          level,
          child_count,
          player_count,
          seq_number,
          agent_type,
          head_count_rate_m,
          inet_head_count_rate_m,
          casino_head_count_rate_m,
          live_betting_rate_m,
          live_betting2_rate_m,
          live_casino_rate_m,
          prop_builder_rate_m,
          flash_bets_rate,
          ext_props_rate,
          crash_rate,
          fantasy_rate,
          amigo_tech_rate
         FROM agents
         WHERE provider = 'buckeye'
         ORDER BY COALESCE(seq_number, 999999999), COALESCE(level, 99), login`
      );
      if (!rows.length) {
        return { GENERAL: [], source: 'database' };
      }

      return {
        GENERAL: rows.map((row: any) => ({
          AgentID: row.id,
          SeqNumber: row.seq_number,
          Level: row.level,
          AgentType: row.agent_type,
          Login: row.login || row.id,
          ParentAgentID: row.parent_agent_id || '',
          ChildCount: row.child_count || 0,
          PlayerCount: row.player_count || 0,
          HeadCountRateM: row.head_count_rate_m || 0,
          InetHeadCountRateM: row.inet_head_count_rate_m || 0,
          CasinoHeadCountRateM: row.casino_head_count_rate_m || 0,
          LiveBettingRateM: row.live_betting_rate_m || 0,
          LiveBetting2RateM: row.live_betting2_rate_m || 0,
          LiveCasinoRateM: row.live_casino_rate_m || 0,
          PropBuilderRateM: row.prop_builder_rate_m || 0,
          FlashBetsRate: row.flash_bets_rate || 0,
          ExtPropsRate: row.ext_props_rate || 0,
          CrashRate: row.crash_rate || 0,
          FantasyRate: row.fantasy_rate || 0,
          AmigoTechRate: row.amigo_tech_rate || 0,
        })),
        meta: {
          source: 'database',
          agentCount: rows.length,
        },
        source: 'database',
      };
    } catch (err: any) {
      console.error('[ScraperManager] getPersistedAgentHierarchy error:', err.message);
      return { GENERAL: [], source: 'database', error: err.message };
    }
  }

  async backfillAgentHierarchy(): Promise<any> {
    return backfillAgentsAndPlayers(this.db);
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
      const result = await instance.api.getWeeklyFigureByAgentLite(options);
      try {
        await this.persistWeeklyFigureReport(result);
      } catch (persistError) {
        console.warn(
          '[ScraperManager] weekly figure archive failed:',
          persistError instanceof Error ? persistError.message : persistError
        );
      }
      return result;
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
      const result = await instance.api.getManagerSnapshot();
      try {
        await this.persistManagerSnapshot(result);
      } catch (persistError) {
        console.warn(
          '[ScraperManager] manager snapshot archive failed:',
          persistError instanceof Error ? persistError.message : persistError
        );
      }
      return result;
    } catch (err: any) {
      console.error('[ScraperManager] getBuckeyeManagerSnapshot error:', err.message);
      return { data: null, error: err.message };
    }
  }

  private async persistManagerSnapshot(result: BuckeyeManagerSnapshotResult): Promise<void> {
    if (!result || !result.agentId) return;
    if (typeof (this.db as any).run !== 'function') return;
    await this.db.run(
      `INSERT INTO master_snapshots
        (provider, agent_id, timestamp, config_web_reports_json, config_web_reports_pending_json, sports_type_json, authorizations_json, message_json, new_emails_count_json, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'buckeye',
        result.agentId,
        result.fetchedAt || new Date().toISOString(),
        JSON.stringify(result.configWebReports || {}),
        JSON.stringify(result.configWebReportsPending || {}),
        JSON.stringify(result.sportsType || {}),
        JSON.stringify(result.authorizations || {}),
        JSON.stringify(result.message || {}),
        JSON.stringify(result.newEmailsCount || {}),
        JSON.stringify(result),
      ]
    );
    this.broadcast({
      type: 'masterSnapshot.new',
      timestamp: new Date().toISOString(),
      agentId: result.agentId,
      payload: { fetchedAt: result.fetchedAt },
    });
  }

  async getBuckeyeSportTypes(): Promise<any[]> {
    return this.db.all(
      `SELECT raw_value, label, sort_order, source, updated_at
       FROM buckeye_sport_types
       ORDER BY sort_order ASC`
    );
  }

  async getBuckeyeAgentPerformanceReport(
    agentId?: string,
    options: BuckeyeAgentPerformanceOptions = {
      start: '',
      end: '',
    }
  ): Promise<any> {
    const instance = this.resolveAgentInstance(agentId);

    if (!instance || !instance.api.isAuthenticated()) {
      return { data: null, message: 'Not authenticated to Buckeye' };
    }

    try {
      const result = await instance.api.getAgentPerformanceReport(options);
      await this.persistAgentPerformanceReport(result);
      return result;
    } catch (err: any) {
      console.error('[ScraperManager] getBuckeyeAgentPerformanceReport error:', err.message);
      return { data: null, error: err.message };
    }
  }

  async persistAgentPerformanceReport(report: BuckeyeAgentPerformanceResult): Promise<void> {
    const rows = report.parsed?.rows || [];
    if (rows.length === 0) return;

    const pulledAt = report.fetchedAt || new Date().toISOString();
    const rawRows = getAgentPerformanceRawRows(report.data);

    await this.db.run('BEGIN');
    try {
      for (const [index, row] of rows.entries()) {
        await this.db.run(
          `INSERT INTO agent_performance_snapshots
            (provider, report_agent_id, customer_id, agent_id, login, report_type,
             start_date, end_date, sport, subsport, period, wager_type, bet_type,
             activity_tipo, free_play, wager_count, risk, to_win, amount_won,
             amount_lost, volume, net, pulled_at, raw_json)
           VALUES ('buckeye', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            report.params.agentID,
            row.customerId,
            row.agentId,
            row.login,
            report.params.type,
            report.params.start,
            report.params.end,
            report.params.sport,
            report.params.subsport,
            report.params.period,
            report.params.wagerType,
            report.params.betType,
            report.params.tipo,
            report.params.freePlay,
            row.wagerCount,
            row.risk,
            row.toWin,
            row.amountWon,
            row.amountLost,
            row.volume,
            row.net,
            pulledAt,
            JSON.stringify(rawRows[index] || row),
          ]
        );
      }
      await this.persistAgentPerformanceAnalytics(report);
      await this.updateIngestionCheckpoint('agent_performance', Date.parse(pulledAt), {
        reportAgentId: report.params.agentID,
        start: report.params.start,
        end: report.params.end,
        type: report.params.type,
        rowCount: rows.length,
        redactedFields: report.redactedFields,
      });
      await this.db.run('COMMIT');
    } catch (error) {
      await this.db.run('ROLLBACK').catch(() => ({ lastID: 0, changes: 0 }));
      throw error;
    }
  }

  async persistWeeklyFigureReport(report: any): Promise<void> {
    if (!report || report.data === null) return;
    if (typeof (this.db as any).run !== 'function') return;

    const weekStart = this.resolveWeeklyFigureDate(report.params?.week ?? 0);
    const parsed = report.parsed || {};
    const params = report.params || {};
    await this.db.run(
      `INSERT INTO weekly_figures
        (provider, agent_id, week, type, layout, week_start_date, sport, handle, win_loss, this_week, active, today, info, wager_type, raw_json, pulled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'buckeye',
        report.agentId || '',
        params.week || 0,
        params.type || 'A',
        params.layout || 'byDay',
        weekStart,
        '',
        Number(parsed.thisWeek || 0),
        Number(parsed.today || 0),
        Number(parsed.thisWeek || 0),
        Number(parsed.active || 0),
        Number(parsed.today || 0),
        parsed.info || '',
        params.type || '',
        JSON.stringify(report.data ?? {}),
        report.fetchedAt || new Date().toISOString(),
      ]
    );

    await this.setWatermark(
      `last_weekly_figures_poll.${report.agentId || 'unknown'}`,
      JSON.stringify({
        week: report.params?.week ?? 0,
        type: report.params?.type || 'A',
        layout: report.params?.layout || 'byDay',
        fetchedAt: report.fetchedAt || new Date().toISOString(),
      })
    );

    this.broadcast({
      type: 'weeklyFigure.new',
      timestamp: new Date().toISOString(),
      agentId: report.agentId || '',
      payload: parsed,
    });
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

    const result = await instance.api.betTickerAction({
      wagerNumber: request.wagerNumber,
      action: request.action,
      agentId: request.agentId,
    });

    return { id: request.id, ...result };
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

      // Log raw getBetTicker response
      await this.rawApiLogger.log({
        endpoint: 'getBetTicker',
        responseJson: JSON.stringify({ wagerCount: wagers.length, wagers }),
        agentId,
        durationMs: Date.now() - instance.lastPoll,
      });

      // Reset poll interval to normal on success
      if (instance.currentPollMs !== this.pollIntervalMs) {
        instance.currentPollMs = this.pollIntervalMs;
        instance.pollTask.restart(instance.currentPollMs);
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
      instance.lastError = error instanceof Error ? error.message : String(error);
      console.error(`[Manager] Poll error for ${agentId}:`, error);

      // Backoff: increase poll interval on consecutive errors
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, instance.consecutiveErrors),
        60000 // cap at 60s
      );
      if (backoffMs !== instance.currentPollMs) {
        instance.currentPollMs = backoffMs;
        instance.pollTask.restart(instance.currentPollMs);
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
    if (ok) {
      instance.lastError = undefined;
      await this.saveAgentSecrets(agentId, instance);
      return;
    }

    console.warn(`[Manager] Token renewal failed for ${agentId}, attempting password re-login`);
    const reloginOk = await instance.api.login();
    if (reloginOk) {
      instance.lastError = undefined;
      await this.saveAgentSecrets(agentId, instance);
    } else {
      instance.lastError = 'Token renewal and password re-login failed';
      console.warn(`[Manager] Password re-login failed for ${agentId}; will retry on next renewal`);
    }
  }

  private async saveAgentSecrets(agentId: string, instance: AgentInstance): Promise<void> {
    if (!this.secretVault) return;
    await this.secretVault.saveBuckeyeSecrets({
      agentId,
      password: instance.credentials.password || undefined,
      cfCookie: instance.api.getCookie() || instance.credentials.cfCookie,
      token: instance.api.getToken(),
    });
  }

  /**
   * Insert or replace wager in database.
   */
  private async persistWager(wager: any): Promise<Awaited<ReturnType<PatternService['correlateWager']>>> {
    const correlation = await this.patternService.correlateWager(wager);
    const parsed = correlation.parsed;

    // Insert into main wagers table
    await this.db.run(
      `INSERT OR REPLACE INTO wagers
      (wager_number, agent_id, customer_id, login, wager_type,
       amount_wagered, to_win_amount, volume_amount, insert_datetime,
       ticket_writer, short_desc, vip, agent_login, sport,
       parsed_game, parsed_market, parsed_side, parsed_price, parsed_period,
       matched_event_id, pin_reference_json, scraped_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(wager),
      ]
    );

    const archiveInsert = await this.db.run(
      `INSERT OR IGNORE INTO wager_archive
      (wager_number, agent_id, customer_id, login, wager_type,
       amount_wagered, to_win_amount, insert_date_time, ticket_writer,
       volume_amount, short_desc_raw, vip, agent_login, ingested_at, raw_json, sport, league, price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        wager.WagerNumber,
        wager.AgentID,
        wager.CustomerID,
        wager.Login,
        wager.WagerType,
        wager.AmountWagered,
        wager.ToWinAmount,
        wager.InsertDateTime,
        wager.TicketWriter,
        wager.VolumeAmount,
        wager.ShortDesc,
        wager.VIP,
        wager.AgentLogin,
        new Date().toISOString(),
        JSON.stringify(wager),
        null,
        null,
        null,
      ]
    );
    if (archiveInsert.changes > 0) {
      this.deferWagerArchiveParse(wager.WagerNumber, wager.ShortDesc, parsed.price);
    }

    await this.updateIngestionCheckpoint('wagers', Number(wager.WagerNumber) || 0, {
      agentId: wager.AgentID,
      agentLogin: wager.AgentLogin,
      scrapedAt: new Date().toISOString(),
    });

    return correlation;
  }

  private deferWagerArchiveParse(wagerNumber: unknown, shortDesc: unknown, parsedPrice: number | null): void {
    const archiveId = Number(wagerNumber);
    if (!Number.isFinite(archiveId)) return;

    const sport = this.parseSport(String(shortDesc || ''));
    const league = this.parseLeague(String(shortDesc || ''));
    const price = parsedPrice ?? this.parsePrice(String(shortDesc || ''));

    queueMicrotask(() => {
      void this.db.run(
        `UPDATE wager_archive
         SET sport = COALESCE(?, sport),
             league = COALESCE(?, league),
             price = COALESCE(?, price)
         WHERE wager_number = ?`,
        [sport || null, league || null, price || null, archiveId]
      ).catch((err) => {
        console.warn('[Manager] Deferred wager archive parse failed:', err instanceof Error ? err.message : err);
      });
    });
  }

  private async updateIngestionCheckpoint(
    entityType: string,
    lastSeq: number,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    if (!lastSeq) return;
    await this.db.run(
      `INSERT INTO ingestion_checkpoints (provider, entity_type, last_seq, last_pull, metadata)
       VALUES ('buckeye', ?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(provider, entity_type) DO UPDATE SET
        last_seq = MAX(COALESCE(ingestion_checkpoints.last_seq, 0), excluded.last_seq),
        last_pull = excluded.last_pull,
        metadata = excluded.metadata`,
      [entityType, lastSeq, JSON.stringify(metadata)]
    );
  }

  private async getWatermark(key: string): Promise<string | undefined> {
    const row = await this.db.get<{ value: string }>(
      `SELECT value FROM watermarks WHERE key = ?`,
      [key]
    );
    return row?.value;
  }

  private async setWatermark(key: string, value: string): Promise<void> {
    await this.db.run(
      `INSERT INTO watermarks (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at`,
      [key, value]
    );
  }

  async getAccessLogs(limit: number = 200): Promise<any[]> {
    return this.db.all(
      `SELECT * FROM access_logs ORDER BY access_datetime DESC LIMIT ?`,
      [Math.min(Math.max(limit, 1), 500)]
    );
  }

  private startAccessLogPolling(agentId: string, instance: AgentInstance): void {
    instance.accessLogTask?.stop();
    instance.accessLogTask = createManagedInterval(
      `buckeye.${agentId}.accessLogs`,
      this.accessLogIntervalMs,
      () => this.refreshAccessLogs(agentId).then(() => undefined),
      {
        initialDelayMs: 1000,
        onError: (err) => console.warn(`[Manager] Access log refresh failed for ${agentId}:`, err instanceof Error ? err.message : err),
      }
    );
  }

  private startPerformancePolling(agentId: string, instance: AgentInstance): void {
    instance.performanceTask?.stop();
    instance.performanceTask = createManagedInterval(
      `buckeye.${agentId}.performance`,
      this.performanceIntervalMs,
      () => this.refreshAgentPerformance(agentId).then(() => undefined),
      {
        initialDelayMs: 2000,
        onError: (err) => console.warn(`[Manager] Agent performance refresh failed for ${agentId}:`, err instanceof Error ? err.message : err),
      }
    );
  }

  private startDailyArchiveRefresh(agentId: string, instance: AgentInstance): void {
    instance.dailyArchiveTask?.stop();
    instance.dailyArchiveTask = createManagedInterval(
      `buckeye.${agentId}.dailyArchive`,
      24 * 60 * 60 * 1000,
      () => this.refreshDailyArchives(agentId).then(() => undefined),
      {
        initialDelayMs: 30_000,
        onError: (err) => console.warn(`[Manager] Daily archive refresh failed for ${agentId}:`, err instanceof Error ? err.message : err),
      }
    );
  }

  private async refreshDailyArchives(agentId: string): Promise<void> {
    const instance = this.agents.get(agentId);
    if (!instance || !instance.api.isAuthenticated()) {
      throw new Error(`Agent ${agentId} is not active`);
    }

    const weekly = await instance.api.getWeeklyFigureByAgentLite({ week: 0, type: 'A', layout: 'byDay' });
    await this.persistWeeklyFigureReport(weekly);
    await this.refreshAgentPerformance(agentId);

    await this.setWatermark(`last_daily_archive_refresh.${agentId}`, new Date().toISOString());
  }

  private async refreshAgentPerformance(agentId: string): Promise<{ rows: number; checkpointed: boolean }> {
    const instance = this.agents.get(agentId);
    if (!instance || !instance.api.isAuthenticated()) {
      throw new Error(`Agent ${agentId} is not active`);
    }

    const { start, end } = this.getDefaultPerformanceWindow();

    // Check Redis cache first if available
    if (this.performanceCache) {
      const cached = await this.performanceCache.get(agentId);
      if (cached.source === 'cache') {
        return { rows: 0, checkpointed: true };
      }
    }

    const perfStart = Date.now();
    const result = await instance.api.getAgentPerformanceReport({
      start,
      end,
      agentID: agentId,
      type: 'CP',
      freePlay: 'Y',
      store: agentId,
      sport: '',
      subsport: '',
      period: '-1',
      wagerType: '',
      betType: '',
      tipo: '-1',
      debug: '0',
      agentOwner: agentId,
    });
    await this.rawApiLogger.log({
      endpoint: 'getAgentPerformanceReport',
      responseJson: JSON.stringify({ rowCount: result.parsed?.rows?.length || 0, totals: result.parsed?.totals }),
      agentId,
      durationMs: Date.now() - perfStart,
    });
    await this.persistAgentPerformanceReport(result);

    // Seed the Redis cache
    if (this.performanceCache && result.parsed?.rows?.length) {
      await this.performanceCache.set(agentId, {
        totals: result.parsed.totals,
        rows: result.parsed.rows.length,
        start,
        end,
      });
    }

    this.broadcast({
      type: 'agentPerformance.update',
      timestamp: new Date().toISOString(),
      agentId,
      payload: {
        rows: result.parsed.rows.length,
        totals: result.parsed.totals,
        start,
        end,
      },
    });
    return { rows: result.parsed.rows.length, checkpointed: result.parsed.rows.length > 0 };
  }

  /**
   * Persist agent performance report to weekly_figures and agent_performance tables.
   */
  private async persistAgentPerformanceAnalytics(result: BuckeyeAgentPerformanceResult): Promise<void> {
    const { parsed } = result;
    const rows = parsed?.rows || [];

    // Insert into weekly_figures table
    for (const row of rows) {
      await this.db.run(
        `INSERT OR IGNORE INTO weekly_figures
        (agent_id, week_start_date, sport, handle, win_loss, wager_type, raw_json, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          result.agentId || result.params?.agentID || '',
          result.params?.start || '',
          result.params?.sport || '',
          row.volume || 0,
          row.net || 0,
          result.params?.wagerType || '',
          JSON.stringify(row),
          new Date().toISOString(),
        ]
      );
    }

    // Insert into agent_performance table
    await this.db.run(
      `INSERT OR REPLACE INTO agent_performance
      (agent_id, recorded_at, performance_json)
      VALUES (?, ?, ?)`,
      [
        result.agentId || result.params?.agentID || '',
        new Date().toISOString(),
        JSON.stringify(parsed),
      ]
    );
    await this.setWatermark(
      `last_agent_performance_poll.${result.agentId || result.params?.agentID || 'unknown'}`,
      JSON.stringify({
        start: result.params?.start,
        end: result.params?.end,
        type: result.params?.type,
        rows: rows.length,
        fetchedAt: result.fetchedAt || new Date().toISOString(),
      })
    );
  }

  private getDefaultPerformanceWindow(): { start: string; end: string } {
    const end = new Date();
    const start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);
    return {
      start: this.formatReportDate(start),
      end: this.formatReportDate(end),
    };
  }

  private formatReportDate(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}/${day}/${date.getFullYear()}`;
  }

  private resolveWeeklyFigureDate(weekOffset: number): string {
    const date = new Date();
    date.setDate(date.getDate() - Math.max(0, Number(weekOffset) || 0) * 7);
    const day = date.getDay();
    date.setDate(date.getDate() - day);
    return date.toISOString().split('T')[0];
  }

  private async refreshAccessLogs(agentId: string): Promise<{ fetched: number; inserted: number; patterns: number }> {
    const instance = this.agents.get(agentId);
    if (!instance) throw new Error(`Agent ${agentId} is not active`);

    const end = new Date();
    const watermarkKey = `last_access_log_poll.${agentId}`;
    const previousWatermark = await this.getWatermark(watermarkKey);
    const start = previousWatermark
      ? new Date(previousWatermark)
      : new Date(end.getTime() - 24 * 60 * 60 * 1000);
    const rows = await instance.api.getWebLog({
      start: this.formatWebLogDate(start),
      end: this.formatWebLogDate(end),
      type: 'A',
      actions: 'ALL',
    });

    // Log raw web log response
    await this.rawApiLogger.log({
      endpoint: 'getWebLog',
      responseJson: JSON.stringify({ rowCount: rows.length, rows }),
      agentId,
      durationMs: Date.now() - end.getTime(),
    });

    const inserted = await this.patternService.persistAccessLogs(agentId, rows, 'A');
    const patterns = await this.patternService.analyzeAccessLogs(agentId);
    const persisted = await this.patternService.persistPatterns(patterns);

    const newestAccess = rows
      .map((row) => Date.parse(row.AccessDateTime || ''))
      .filter((time) => Number.isFinite(time))
      .sort((a, b) => b - a)[0];
    await this.setWatermark(
      watermarkKey,
      newestAccess ? new Date(newestAccess).toISOString() : end.toISOString()
    );

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

  private parseLeague(desc: string): string | null {
    if (!desc) return null;
    const decoded = this.decodeEntities(desc);
    const leagueMatch = decoded.match(/#([A-Z0-9 ]{2,20})(?:\s+Futures|\s+-|\s+#|\s+[A-Z][a-z])/);
    if (leagueMatch) {
      const candidate = leagueMatch[1].trim();
      if (/^[A-Z0-9 ]+$/.test(candidate) && /[A-Z]/.test(candidate)) return candidate;
    }

    for (const league of ['NBA', 'WNBA', 'NFL', 'NCAAF', 'NCAAB', 'MLB', 'NHL', 'MLS', 'EPL', 'UFC']) {
      if (decoded.includes(league)) return league;
    }
    return null;
  }

  private parsePrice(desc: string): number | null {
    if (!desc) return null;
    const decoded = this.decodeEntities(desc);
    const prices = Array.from(decoded.matchAll(/(?:^|\s)([+-]\d{2,4})(?=\s|$)/g))
      .map((match) => Number.parseInt(match[1], 10))
      .filter((price) => Number.isFinite(price));
    return prices.length ? prices[prices.length - 1] : null;
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

  /**
   * Poll one agent's master account info and insert into master_snapshots table.
   * Runs every 30 minutes per active agent.
   */
  private async pollMasterSnapshot(agentId: string): Promise<void> {
    const instance = this.agents.get(agentId);
    if (!instance || !instance.api.isAuthenticated()) {
      throw new Error(`Agent ${agentId} is not active`);
    }

    const result = await instance.api.getAccountInfoOwner();
    const accountInfo = result.accountInfo || {};
    const parsed = result.parsed || {};

    const balance = parsed.balances?.current || accountInfo.balance || 0;
    const availableBalance = parsed.balances?.available || accountInfo.availableBalance || 0;
    const percentBook = parsed.balances?.percentBook || accountInfo.percentBook || 0;
    const openWagerRow = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM wagers WHERE agent_login = ?`,
      [agentId]
    );

    const timestamp = new Date().toISOString();
    await this.db.run(
      `INSERT INTO master_snapshots
        (provider, agent_id, timestamp, balance, available_balance, percent_book, open_wager_count, account_info_json, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'buckeye',
        agentId,
        timestamp,
        balance,
        availableBalance,
        percentBook,
        Number(openWagerRow?.count || 0),
        JSON.stringify({ agentId, accountInfo, parsed }),
        JSON.stringify({ agentId, accountInfo, parsed }),
      ]
    );
    await this.setWatermark(`last_master_snapshot.${agentId}`, timestamp);
    console.log(`[Manager] Master snapshot inserted for ${agentId}`);
  }

  /**
   * Get the database instance.
   */
  getDatabase(): Database {
    return this.db;
  }
}
