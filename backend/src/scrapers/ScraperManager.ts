/**
 * Scraper Manager
 * Manages HTTP polling lifecycle for Buckeye API clients.
 * Replaces Puppeteer-based scraper management.
 */

import { ActionQueue, type ActionResult } from '../actions/ActionQueue';
import { clearAgentHierarchyTreeCache } from '../api/routes/agentHierarchyTree';
import type { Database } from '../database';
import { PatternService } from '../patterns/PatternService';
import {
  getPlayer360SourcePolicy,
  nextRefreshAt,
  shouldRefreshPlayer360Source,
} from '../player360/policies';
import { Alert, evaluateWager, type EnrichedWager } from '../risk/AlertEngine';
import type { BunSecretVault } from '../services/BunSecretVault';
import { getGlobalTickerBuffer } from '../services/TickerBuffer';
import type { PluginContext } from '../services/PluginLoader';
import { computeCLV, refreshRecentClosingLines } from '../services/CLV';
import { enrichIpGeo } from '../services/GeoIpService';
import { backfillAgentsAndPlayers, upsertLiveAgentHierarchy } from '../services/HierarchyBackfillService';
import { IPTracker } from '../services/IPTracker';
import { PerformanceCache } from '../services/PerformanceCache';
import { extractBuckeyeCookies, type EnhancedProxyCredentials } from '../services/ProxyClient';
import { RawApiLogger } from '../services/RawApiLogger';
import { evaluateRules, takeAction } from '../services/RulesEngine';
import { createManagedInterval, type ManagedIntervalTask } from '../services/Scheduler';
import { WebhookService } from '../services/WebhookService';
import { decodeEntities } from '../utils/decodeEntities';
import { logger } from '../utils/logger';
import {
  BuckeyeAPI,
  BuckeyeCredentials,
  type BuckeyeAccountInfoResult,
  type BuckeyeAgentHierarchy,
  type BuckeyeAgentPerformanceOptions,
  type BuckeyeAgentPerformanceResult,
  type BuckeyeCustomerSnapshot,
  type BuckeyeCustomerSnapshotResult,
  type BuckeyeDepositRow,
  type BuckeyeManagerSnapshotResult,
  type BuckeyePlayersList,
  type BuckeyeTransactionListResult,
  type BuckeyeTransactionRow,
  type BuckeyeUiConfigResult,
  type BuckeyeWebLogOptions,
  type BuckeyeWebLogRow,
  type BuckeyeWeeklyFigureOptions,
  type BuckeyeWeeklyFigureResult,
} from './BuckeyeAPI';
import { LiveAgentTree } from './LiveAgentTree';

interface AgentInstance {
  api: BuckeyeAPI;
  pollTask: ManagedIntervalTask;
  renewalTask: ManagedIntervalTask;
  masterSnapshotTask?: ManagedIntervalTask;
  accessLogTask?: ManagedIntervalTask;
  performanceTask?: ManagedIntervalTask;
  dailyArchiveTask?: ManagedIntervalTask;
  player360Task?: ManagedIntervalTask;
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

interface Player360Candidate {
  customerId: string;
  login: string;
  agentId: string;
  agentLogin: string;
}

type SqlRow = Record<string, unknown>;

const WAGER_LIST_COLUMNS = `
  wager_number,
  agent_id,
  customer_id,
  login,
  wager_type,
  amount_wagered,
  to_win_amount,
  volume_amount,
  insert_datetime,
  ticket_writer,
  short_desc,
  vip,
  agent_login,
  sport,
  scraped_at,
  parsed_game,
  parsed_market,
  parsed_side,
  parsed_price,
  parsed_period,
  matched_event_id,
  agent_level,
  agent_type,
  parent_agent_id,
  mapped_agent_id,
  mapped_agent_login,
  agent_path_json,
  hierarchy_source
`;

interface CountRow {
  count: number;
}

interface TotalRow {
  total: number | null;
}

interface HierarchySyncConfigRow {
  enabled: number;
  interval_minutes: number;
  updated_at?: string;
}

interface HierarchyImportResult {
  success: boolean;
  total_imported: number;
  clusters_found: number;
  players: number;
  linked_players: number;
  errors: string[];
  job_id: number;
  source: string;
}

interface PersistedAgentHierarchyRow {
  id: string;
  login: string | null;
  parent_agent_id: string | null;
  level: number | null;
  child_count: number | null;
  player_count: number | null;
  seq_number: number | null;
  agent_type: string | null;
  head_count_rate_m: number | null;
  inet_head_count_rate_m: number | null;
  casino_head_count_rate_m: number | null;
  live_betting_rate_m: number | null;
  live_betting2_rate_m: number | null;
  live_casino_rate_m: number | null;
  prop_builder_rate_m: number | null;
  flash_bets_rate: number | null;
  ext_props_rate: number | null;
  crash_rate: number | null;
  fantasy_rate: number | null;
  amigo_tech_rate: number | null;
}

interface BuckeyeSportTypeRow {
  raw_value: string;
  label: string;
  sort_order: number;
  source: string;
  updated_at: string;
}

interface ExposureWagerRow {
  volume_amount?: number | null;
  amount_wagered?: number | null;
  sport?: string | null;
  short_desc?: string | null;
  ticket_writer?: string | null;
  agent_login?: string | null;
  login?: string | null;
}

interface PlayerLinkRow {
  ip_address: string;
  players: string | null;
  playerCount: number;
  lastSeen: string | null;
}

interface LooseBuckeyeRow {
  [key: string]: unknown;
  Agent?: unknown;
  agent?: unknown;
}

type LooseBuckeyeData = Record<string, unknown> & {
  GENERAL: LooseBuckeyeRow[];
  [index: number]: LooseBuckeyeRow;
};

type ManagerAgentHierarchyResult = Omit<BuckeyeAgentHierarchy, 'PLAYERS'> & {
  PLAYERS?: BuckeyeAgentHierarchy['PLAYERS'];
  message?: string;
  error?: string;
};

type ManagerPlayersListResult = BuckeyePlayersList & {
  message?: string;
  error?: string;
};

type ManagerWeeklyFigureResult = Partial<Omit<BuckeyeWeeklyFigureResult, 'data'>> & {
  data: LooseBuckeyeData | null;
  message?: string;
  error?: string;
};

type ManagerSnapshotResult = Partial<Omit<BuckeyeManagerSnapshotResult, 'message' | 'sportsType'>> & {
  data?: null;
  message?: unknown;
  error?: string;
  sportsType: LooseBuckeyeData;
};

type ManagerAgentPerformanceResult = Partial<Omit<BuckeyeAgentPerformanceResult, 'data'>> & {
  data: LooseBuckeyeData | null;
  message?: string;
  error?: string;
};

interface PlayerProfileRow extends SqlRow {
  wager_count?: number;
  total_volume?: number;
}

interface WagerHierarchyContext {
  agentLevel: number | null;
  agentType: string | null;
  parentAgentId: string | null;
  mappedAgentId: string | null;
  mappedAgentLogin: string | null;
  agentPathJson: string;
  hierarchySource: string;
}

interface PlayerDetailsResult {
  playerId: string;
  profile: PlayerProfileRow;
  agents: string[];
}

interface ScraperAgentMetrics {
  agentId: string;
  isPolling: boolean;
  pollingScheduled: boolean;
  lastPoll: string | null;
  errorCount: number;
  consecutiveErrors: number;
  lastError: string | null;
  authenticated: boolean;
  currentPollMs: number;
  reloginAttempts: number;
  player360Active: boolean;
}

interface ScraperMetrics {
  activeAgents: number;
  agents: ScraperAgentMetrics[];
  actionQueue: ReturnType<ActionQueue['getMetrics']>;
  counters: {
    wagers_total: number;
    alerts_triggered_total: number;
    errors_total: number;
  };
}

interface ParsedBalanceSnapshot {
  balances?: {
    current?: number;
    available?: number;
    percentBook?: number;
  };
}

function asRecord(value: unknown): SqlRow | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SqlRow
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringOrNull(value: unknown): string | null {
  const text = String(value || '').trim();
  return text || null;
}

function emptyBuckeyeData(): LooseBuckeyeData {
  return { GENERAL: [] };
}

function getAgentPerformanceRawRows(data: unknown): unknown[] {
  const payload = asRecord(data);
  const info = asRecord(payload?.INFO);
  if (Array.isArray(info?.LIST)) return info.LIST;
  if (Array.isArray(payload?.LIST)) return payload.LIST;
  return [];
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function transactionRowToDeposit(row: BuckeyeTransactionRow): BuckeyeDepositRow {
  return {
    id: `txn-${row.id}`,
    customerId: row.customerId,
    login: row.login,
    agentId: row.agentId,
    agentLogin: row.agentLogin,
    amount: row.amount,
    currency: 'USD',
    method: row.description || row.tranType || 'Buckeye transaction ledger',
    ipAddress: '',
    status: row.category,
    transactionTime: row.transactionTime,
    raw: row.raw,
  };
}

function transactionDedupeKey(row: BuckeyeTransactionRow): string {
  return [
    row.raw?.sourceOperation || '',
    row.documentNumber || row.id,
    row.transactionTime,
    row.amount,
    row.balance,
    row.category,
  ].join('|');
}

export class BuckeyeScraperManager {
  private agents: Map<string, AgentInstance> = new Map();
  private db: Database;
  private broadcast: (msg: object) => void;
  private pollIntervalMs: number = 5000;
  private tokenRenewalMs: number = 5 * 60 * 1000; // 5 minutes (matches Buckeye frontend)
  private accessLogIntervalMs: number = 5 * 60 * 1000;
  private performanceIntervalMs: number = 15 * 60 * 1000;
  private player360IntervalMs: number = 10 * 60 * 1000;
  private player360MaxPlayersPerPoll: number = 50;
  private player360ColdBackfillPerPoll: number = 2;
  private customerSnapshotTtlMs: number = 24 * 60 * 60 * 1000;
  private webhookService: WebhookService;
  private patternService: PatternService;
  private actionQueue: ActionQueue;
  private accountInfoCache: Map<string, { data: BuckeyeAccountInfoResult; timestamp: number }> = new Map();
  private accountInfoCacheTtlMs: number = 5 * 60 * 1000;
  private wagerCount: number = 0;
  private alertCount: number = 0;
  private errorCount: number = 0;
  private secretVault?: BunSecretVault;
  private performanceCache?: PerformanceCache;
  private rawApiLogger: RawApiLogger;
  private hierarchyRefreshTask?: ManagedIntervalTask;
  private staticHierarchyRefreshTask?: ManagedIntervalTask;
  private closingLineTask?: ManagedIntervalTask;
  private hierarchyRefreshIntervalMs: number;
  private hierarchySyncEnabled: boolean = true;
  private readonly staticHierarchyRefreshIntervalMs: number;
  private readonly closingLineIntervalMs: number;

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
    this.player360IntervalMs = readPositiveIntEnv('PLAYER360_INTERVAL_MS', this.player360IntervalMs);
    this.player360MaxPlayersPerPoll = readPositiveIntEnv('PLAYER360_MAX_PLAYERS_PER_POLL', this.player360MaxPlayersPerPoll);
    this.player360ColdBackfillPerPoll = readPositiveIntEnv('PLAYER360_COLD_BACKFILL_PER_POLL', this.player360ColdBackfillPerPoll);
    this.customerSnapshotTtlMs = readPositiveIntEnv('CUSTOMER_SNAPSHOT_TTL_MS', this.customerSnapshotTtlMs);
    this.hierarchyRefreshIntervalMs = readPositiveIntEnv('HIERARCHY_REFRESH_INTERVAL_MS', 30 * 60 * 1000);
    this.staticHierarchyRefreshIntervalMs = readPositiveIntEnv('STATIC_HIERARCHY_REFRESH_INTERVAL_MS', 7 * 24 * 60 * 60 * 1000);
    this.closingLineIntervalMs = readPositiveIntEnv('CLOSING_LINE_INTERVAL_MS', 60 * 60 * 1000);
    this.webhookService = new WebhookService(db);
    this.patternService = new PatternService(db, broadcast);
    this.rawApiLogger = new RawApiLogger(db, true);
    void this.initializeHierarchySyncConfig();
    this.actionQueue = new ActionQueue(db, broadcast, 30_000, async (request) => this.executeBetAction(request));
    this.closingLineTask = createManagedInterval(
      'closing-lines.refresh',
      this.closingLineIntervalMs,
      () => this.refreshClosingLines(),
      {
        initialDelayMs: this.closingLineIntervalMs,
        onError: (error) => logger.warn('CLV closing-line refresh failed', error instanceof Error ? error.message : error),
      }
    );
    if (this.staticHierarchyRefreshIntervalMs > 0) {
      this.staticHierarchyRefreshTask = createManagedInterval(
        'buckeye.hierarchy.staticSeed',
        this.staticHierarchyRefreshIntervalMs,
        () => this.refreshStaticHierarchySeed(),
        {
          initialDelayMs: this.staticHierarchyRefreshIntervalMs,
          onError: (error) => logger.warn('Static hierarchy seed refresh failed', error instanceof Error ? error.message : error),
        }
      );
    }
  }

  private async initializeHierarchySyncConfig(): Promise<void> {
    await this.ensureHierarchySyncTables();
    const config = await this.readHierarchySyncConfig();
    this.hierarchySyncEnabled = config.enabled;
    this.hierarchyRefreshIntervalMs = config.intervalMinutes * 60 * 1000;
  }

  private async ensureHierarchySyncTables(): Promise<void> {
    this.db.run(`CREATE TABLE IF NOT EXISTS background_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_name TEXT NOT NULL,
        status TEXT CHECK(status IN ('running','completed','failed')) NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        details TEXT
      )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_background_jobs_name_started
        ON background_jobs(job_name, started_at DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_background_jobs_status_started
        ON background_jobs(status, started_at DESC)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS hierarchy_sync_config (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        interval_minutes INTEGER NOT NULL DEFAULT 30,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    this.db.run(
      `INSERT OR IGNORE INTO hierarchy_sync_config (id, enabled, interval_minutes)
       VALUES (1, 1, 30)`
    );
  }

  private async readHierarchySyncConfig(): Promise<{ enabled: boolean; intervalMinutes: number; updatedAt: string | null }> {
    await this.ensureHierarchySyncTables();
    const row = await this.db.get<HierarchySyncConfigRow>(
      `SELECT enabled, interval_minutes, updated_at
       FROM hierarchy_sync_config
       WHERE id = 1`
    );
    const intervalMinutes = Math.min(Math.max(Number(row?.interval_minutes || 30), 1), 1440);
    return {
      enabled: Number(row?.enabled ?? 1) === 1,
      intervalMinutes,
      updatedAt: row?.updated_at || null,
    };
  }

  /**
   * Start polling for an agent.
   */
  async startAgent(agentId: string, credentials: BuckeyeCredentials): Promise<void> {
    if (this.agents.has(agentId)) {
      logger.info(`Agent ${agentId} already active`);
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
      logger.info(`Using pre-authenticated token for ${agentId}`);
    }

    const instance: AgentInstance = {
      api,
      pollTask: createManagedInterval(`buckeye.${agentId}.bets`, this.pollIntervalMs, () => this.pollAgent(agentId), {
        initialDelayMs: 100,
      }),
      renewalTask: createManagedInterval(`buckeye.${agentId}.renewal`, this.tokenRenewalMs, () => this.renewToken(agentId)),
      masterSnapshotTask: createManagedInterval(`buckeye.${agentId}.masterSnapshot`, 30 * 60 * 1000, () => this.pollMasterSnapshot(agentId), {
        initialDelayMs: 500,
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
    this.startPlayer360Polling(agentId, instance);
    this.startHierarchyBackgroundRefresh();
    logger.success(`Started polling for ${agentId} every ${this.pollIntervalMs}ms`);

  }

  /**
   * Resume polling for an agent using a stored JWT token.
   * Skips login if the token is still valid.
   */
  async resumeAgent(agentId: string, credentials: BuckeyeCredentials, token: string): Promise<boolean> {
    if (this.agents.has(agentId)) {
      logger.info(`Agent ${agentId} already active`);
      return true;
    }

    const api = new BuckeyeAPI(credentials, this.debugMode);
    api.setToken(token);

    // Test if token still works
    const accessOk = await api.testAccess();
    if (!accessOk) {
      logger.warn(`Stored token invalid for ${agentId}, needs re-login`);
      return false;
    }

    const instance: AgentInstance = {
      api,
      pollTask: createManagedInterval(`buckeye.${agentId}.bets`, this.pollIntervalMs, () => this.pollAgent(agentId), {
        initialDelayMs: 100,
      }),
      renewalTask: createManagedInterval(`buckeye.${agentId}.renewal`, this.tokenRenewalMs, () => this.renewToken(agentId)),
      masterSnapshotTask: createManagedInterval(`buckeye.${agentId}.masterSnapshot`, 30 * 60 * 1000, () => this.pollMasterSnapshot(agentId), {
        initialDelayMs: 500,
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
    this.startPlayer360Polling(agentId, instance);
    this.startHierarchyBackgroundRefresh();
    logger.success(`Resumed session for ${agentId}`);

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
    instance.player360Task?.stop();
    this.actionQueue.clearAgent(agentId);
    this.agents.delete(agentId);
    logger.info(`Stopped polling for ${agentId}`);

    if (this.agents.size === 0) {
      this.stopHierarchyBackgroundRefresh();
    }
  }

  /**
   * Force immediate refresh.
   */
  async forceRefresh(agentId: string): Promise<void> {
    await this.pollAgent(agentId);
  }

  async forceAccessLogRefresh(agentId: string): Promise<{ fetched: number; inserted: number; patterns: number }> {
    return this.refreshAccessLogs(agentId);
  }

  private startHierarchyBackgroundRefresh(): void {
    if (!this.hierarchySyncEnabled || this.hierarchyRefreshIntervalMs <= 0) {
      this.stopHierarchyBackgroundRefresh();
      return;
    }
    if (this.hierarchyRefreshTask?.isRunning()) return;
    this.hierarchyRefreshTask?.stop();
    this.hierarchyRefreshTask = createManagedInterval(
      'buckeye.hierarchy.background',
      this.hierarchyRefreshIntervalMs,
      () => this.refreshHierarchyInBackground(),
      {
        initialDelayMs: this.hierarchyRefreshIntervalMs,
        onError: (err) => logger.warn('Hierarchy background refresh failed', err instanceof Error ? err.message : err),
      }
    );
    logger.info(`Hierarchy background refresh started (every ${Math.round(this.hierarchyRefreshIntervalMs / 1000)}s)`);
  }

  private stopHierarchyBackgroundRefresh(): void {
    this.hierarchyRefreshTask?.stop();
    this.hierarchyRefreshTask = undefined;
    logger.info('Hierarchy background refresh stopped');
  }

  private async refreshHierarchyInBackground(): Promise<void> {
    if (!this.hierarchySyncEnabled) return;
    await this.runHierarchyImport('background_refresh');
  }

  async runHierarchyImport(source: string = 'manual_import', agentId?: string): Promise<HierarchyImportResult> {
    await this.ensureHierarchySyncTables();
    const jobId = await this.startBackgroundJob('agent_flat_refresh', { source, agentId: agentId || null });
    try {
      const instance = agentId
        ? this.agents.get(agentId)
        : Array.from(this.agents.values()).find((agent) => agent.api.isAuthenticated());
      if (!instance || !instance.api.isAuthenticated()) {
        throw new Error('No authenticated Buckeye agent available for hierarchy import');
      }
      const hierarchy = await instance.api.getAgentHierarchy();
      if (!Array.isArray(hierarchy?.GENERAL) || hierarchy.GENERAL.length === 0) {
        throw new Error('Buckeye hierarchy import returned an empty GENERAL array');
      }
      const result = await upsertLiveAgentHierarchy(this.db, hierarchy, source);
      clearAgentHierarchyTreeCache();
      await this.finishBackgroundJob(jobId, 'completed', {
        source,
        agents: result.agents,
        players: result.players,
        linkedPlayers: result.linkedPlayers,
      });
      logger.success(`Hierarchy ${source} complete: ${result.agents} agents, ${result.players} players, ${result.linkedPlayers} linked`);
      return {
        success: true,
        total_imported: result.agents,
        clusters_found: result.topAgentsByPlayers?.length || 0,
        players: result.players,
        linked_players: result.linkedPlayers,
        errors: [],
        job_id: jobId,
        source,
      };
    } catch (err) {
      const message = errorMessage(err);
      await this.finishBackgroundJob(jobId, 'failed', { source }, message);
      this.broadcast({ type: 'sync_error', channel: 'agent-updates', status: 'failed', error: message, job_id: jobId });
      logger.error(`Hierarchy ${source} failed`, message);
      throw err;
    }
  }

  async getHierarchySyncStatus(): Promise<Record<string, unknown>> {
    const config = await this.readHierarchySyncConfig();
    const latest = await this.db.get<SqlRow>(
      `SELECT id, job_name, status, started_at, finished_at, error, details
       FROM background_jobs
       WHERE job_name = 'agent_flat_refresh'
       ORDER BY datetime(COALESCE(started_at, finished_at)) DESC, id DESC
       LIMIT 1`
    );
    const recentErrors = await this.db.all<SqlRow>(
      `SELECT id, job_name, status, started_at, finished_at, error, details
       FROM background_jobs
       WHERE job_name = 'agent_flat_refresh' AND status = 'failed'
       ORDER BY datetime(COALESCE(finished_at, started_at)) DESC, id DESC
       LIMIT 5`
    );
    const lastFinished = stringOrNull(latest?.finished_at) || stringOrNull(latest?.started_at);
    const nextRun = config.enabled && lastFinished
      ? new Date(new Date(lastFinished).getTime() + config.intervalMinutes * 60 * 1000).toISOString()
      : null;
    return {
      enabled: config.enabled,
      interval_minutes: config.intervalMinutes,
      last_run: latest || null,
      last_error: stringOrNull(latest?.error),
      recent_errors: recentErrors,
      next_run: nextRun,
      running: latest?.status === 'running',
    };
  }

  async updateHierarchySyncConfig(input: { enabled?: unknown; interval_minutes?: unknown }): Promise<Record<string, unknown>> {
    const enabled = input.enabled === undefined ? this.hierarchySyncEnabled : Boolean(input.enabled);
    const intervalMinutes = input.interval_minutes === undefined
      ? Math.max(1, Math.round(this.hierarchyRefreshIntervalMs / 60_000))
      : Math.min(Math.max(Number(input.interval_minutes) || 30, 1), 1440);
    await this.ensureHierarchySyncTables();
    await this.db.run(
      `INSERT INTO hierarchy_sync_config (id, enabled, interval_minutes, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        interval_minutes = excluded.interval_minutes,
        updated_at = excluded.updated_at`,
      [enabled ? 1 : 0, intervalMinutes, new Date().toISOString()]
    );
    this.hierarchySyncEnabled = enabled;
    this.hierarchyRefreshIntervalMs = intervalMinutes * 60 * 1000;
    if (enabled && this.agents.size > 0) {
      if (this.hierarchyRefreshTask?.isRunning()) {
        this.hierarchyRefreshTask.restart(this.hierarchyRefreshIntervalMs, Math.min(60_000, this.hierarchyRefreshIntervalMs));
      } else {
        this.startHierarchyBackgroundRefresh();
      }
    } else {
      this.stopHierarchyBackgroundRefresh();
    }
    return this.getHierarchySyncStatus();
  }

  private async startBackgroundJob(jobName: string, details: Record<string, unknown>): Promise<number> {
    const startedAt = new Date().toISOString();
    const result = await this.db.run(
      `INSERT INTO background_jobs (job_name, status, started_at, details)
       VALUES (?, 'running', ?, ?)`,
      [jobName, startedAt, JSON.stringify(details)]
    );
    const jobId = Number(result.lastID || 0);
    this.broadcast({ type: 'sync_status', channel: 'agent-updates', status: 'running', job_name: jobName, job_id: jobId, started_at: startedAt });
    return jobId;
  }

  private async finishBackgroundJob(
    jobId: number,
    status: 'completed' | 'failed',
    details: Record<string, unknown>,
    error?: string
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    await this.db.run(
      `UPDATE background_jobs
       SET status = ?, finished_at = ?, error = ?, details = ?
       WHERE id = ?`,
      [status, finishedAt, error || null, JSON.stringify(details), jobId]
    );
    this.broadcast({
      type: 'sync_status',
      channel: 'agent-updates',
      status,
      job_name: 'agent_flat_refresh',
      job_id: jobId,
      finished_at: finishedAt,
      error: error || null,
    });
  }

  private async refreshStaticHierarchySeed(): Promise<void> {
    try {
      const result = await backfillAgentsAndPlayers(this.db, { source: 'static_seed_refresh' });
      if (result.agents > 0) {
        clearAgentHierarchyTreeCache();
        logger.success(`Static hierarchy seed refresh complete: ${result.agents} agents, ${result.players} players`);
      } else {
        logger.warn('Static hierarchy seed refresh found no local agent export rows');
      }
    } catch (err) {
      logger.warn('Static hierarchy seed refresh skipped', err instanceof Error ? err.message : err);
    }
  }

  requestPlayer360Refresh(playerId: string, reason: string = 'profile_open'): void {
    void this.refreshPlayer360OnDemand(playerId, reason).catch((error) => {
      logger.warn(`Player 360 on-demand refresh failed for ${playerId}`, error instanceof Error ? error.message : error);
    });
  }

  private async refreshPlayer360OnDemand(playerId: string, _reason: string): Promise<void> {
    const row = await this.db.get<Player360Candidate>(
      `SELECT
        COALESCE(NULLIF(customer_id, ''), NULLIF(login, '')) AS customerId,
        COALESCE(NULLIF(login, ''), NULLIF(customer_id, '')) AS login,
        COALESCE(NULLIF(agent_id, ''), NULLIF(agent_login, '')) AS agentId,
        COALESCE(NULLIF(agent_login, ''), NULLIF(agent_id, '')) AS agentLogin
       FROM wager_archive
       WHERE login = ? OR customer_id = ?
       ORDER BY insert_date_time DESC
       LIMIT 1`,
      [playerId, playerId]
    );
    const agentId = String(row?.agentLogin || row?.agentId || '').trim();
    const instance = this.resolveAgentInstance(agentId);
    if (!row || !agentId || !instance || !instance.api.isAuthenticated()) return;
    const pollingAgentId = instance.credentials.agentId;
    const player = {
      customerId: String(row.customerId || playerId).trim(),
      login: String(row.login || playerId).trim(),
      agentId: String(row.agentId || agentId).trim(),
      agentLogin: agentId,
    };

    if (await this.shouldRefreshPlayerSource(player.customerId, player.login, 'access_logs')) {
      await this.markPlayerSourceAttempt(player, 'access_logs');
      try {
        await this.refreshAccessLogs(pollingAgentId);
        await this.markPlayerSourceSuccess(player, 'access_logs');
      } catch (error) {
        await this.markPlayerSourceError(player, 'access_logs', error);
      }
    }

    const refreshTransactions = await this.shouldRefreshPlayerSource(player.customerId, player.login, 'player_transactions');
    const refreshDeletedTransactions = await this.shouldRefreshPlayerSource(player.customerId, player.login, 'deleted_transactions');
    if (refreshTransactions || refreshDeletedTransactions) {
      if (refreshTransactions) {
        await this.markPlayerSourceAttempt(player, 'player_transactions');
        await this.markPlayerSourceAttempt(player, 'deposits');
      }
      if (refreshDeletedTransactions) {
        await this.markPlayerSourceAttempt(player, 'deleted_transactions');
      }
      try {
        const refreshResult = await this.refreshPlayerTransactionLedger(instance, player, {
          includeCore: refreshTransactions,
          includeDeleted: refreshDeletedTransactions,
        });
        await this.markTransactionRefreshStatus(player, refreshResult, refreshTransactions, refreshDeletedTransactions);
      } catch (error) {
        if (refreshTransactions) {
          await this.markPlayerSourceError(player, 'player_transactions', error);
          await this.markPlayerSourceError(player, 'deposits', error);
        }
        if (refreshDeletedTransactions) {
          await this.markPlayerSourceError(player, 'deleted_transactions', error);
        }
      }
    }

    if (await this.shouldRefreshPlayerSource(player.customerId, player.login, 'customer_snapshots')) {
      await this.markPlayerSourceAttempt(player, 'customer_snapshots');
      try {
        const snapshot = await instance.api.getCustomerSnapshot(player.customerId);
        if (snapshot.snapshot) {
          await this.persistCustomerSnapshot(snapshot.snapshot);
          await this.markPlayerSourceSuccess(player, 'customer_snapshots');
        }
      } catch (error) {
        await this.markPlayerSourceError(player, 'customer_snapshots', error);
      }
    }

    if (await this.shouldRefreshPlayerSource(player.customerId, player.login, 'teaser_profile')) {
      await this.markPlayerSourceAttempt(player, 'teaser_profile');
      try {
        await instance.api.getTeaserProfile(player.customerId);
      } catch (error) {
        await this.markPlayerSourceError(player, 'teaser_profile', error);
      }
    }

    if (await this.shouldRefreshPlayerSource(player.customerId, player.login, 'agent_performance_snapshots')) {
      await this.markPlayerSourceAttempt(player, 'agent_performance_snapshots');
      try {
        const performance = await instance.api.getPerformancePlayer(player.customerId, {
          acc: player.customerId,
          period: 0,
          agentID: pollingAgentId,
          agentOwner: pollingAgentId,
        });
        await this.persistPlayerPerformanceSnapshot(performance, player.customerId, player.login);
        await this.markPlayerSourceSuccess(player, 'agent_performance_snapshots');
      } catch (error) {
        await this.markPlayerSourceError(player, 'agent_performance_snapshots', error);
      }
    }
  }

  /**
   * Get agent data from database.
   */
  async getAgentData(agentId: string): Promise<SqlRow> {
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
  async getStats(): Promise<SqlRow> {
    const totalWagers = await this.db.get<CountRow>('SELECT COUNT(*) as count FROM wagers');
    const totalVolume = await this.db.get<TotalRow>('SELECT SUM(amount_wagered) as total FROM wagers');
    const agentCount = await this.db.get<CountRow>('SELECT COUNT(DISTINCT agent_login) as count FROM wagers');
    const alertCount = await this.db.get<CountRow>('SELECT COUNT(*) as count FROM alerts WHERE is_resolved = 0');
    const liveCount = await this.db.get<CountRow>("SELECT COUNT(*) as count FROM wagers WHERE ticket_writer = 'GSLIVE'");

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
  async getWagers(limit: number = 200, offset: number = 0): Promise<SqlRow[]> {
    return this.db.all(
      `SELECT ${WAGER_LIST_COLUMNS} FROM wagers ORDER BY insert_datetime DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
  }

  /**
   * Get alert wagers.
   */
  async getAlertWagers(): Promise<SqlRow[]> {
    return this.db.all(
      `SELECT ${WAGER_LIST_COLUMNS} FROM wagers WHERE ticket_writer = 'ALERT' ORDER BY insert_datetime DESC LIMIT 200`
    );
  }

  /**
   * Get live (GSLIVE) wagers.
   */
  async getLiveWagers(): Promise<SqlRow[]> {
    return this.db.all(
      `SELECT ${WAGER_LIST_COLUMNS} FROM wagers WHERE ticket_writer = 'GSLIVE' ORDER BY insert_datetime DESC LIMIT 200`
    );
  }

  /**
   * Get top agents by volume.
   */
  async getAgents(): Promise<SqlRow[]> {
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
  async getAlerts(): Promise<SqlRow[]> {
    return this.db.all(
      'SELECT * FROM alerts WHERE is_resolved = 0 ORDER BY created_at DESC LIMIT 100'
    );
  }

  /**
   * Get agent downline derived from wager data.
   */
  async getAgentDownline(): Promise<SqlRow[]> {
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
  async getAgentHierarchy(agentId?: string): Promise<ManagerAgentHierarchyResult> {
    const instance = agentId
      ? this.agents.get(agentId)
      : Array.from(this.agents.values()).find((agent) => agent.api.isAuthenticated());

    if (!instance || !instance.api.isAuthenticated()) {
      return { GENERAL: [], PLAYERS: [], message: 'Not authenticated to Buckeye' };
    }
    try {
      const data = await instance.api.getAgentHierarchy();
      return data;
    } catch (err) {
      logger.error('getAgentHierarchy error', errorMessage(err));
      return { GENERAL: [], PLAYERS: [], error: errorMessage(err) };
    }
  }

  async getBuckeyePlayersList(agentId?: string): Promise<ManagerPlayersListResult> {
    const instance = agentId
      ? this.agents.get(agentId)
      : Array.from(this.agents.values()).find((agent) => agent.api.isAuthenticated());

    if (!instance || !instance.api.isAuthenticated()) {
      return { LIST: [], message: 'Not authenticated to Buckeye' };
    }
    try {
      const data = await instance.api.getPlayersList();
      return data;
    } catch (err) {
      logger.error('getBuckeyePlayersList error', errorMessage(err));
      return { LIST: [], error: errorMessage(err) };
    }
  }

  async getPersistedAgentHierarchy(): Promise<SqlRow> {
    try {
      const rows = await this.db.all<PersistedAgentHierarchyRow>(
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
           AND seq_number IS NOT NULL
           AND level IS NOT NULL
           AND COALESCE(raw_json, '') NOT LIKE '%placeholder%'
         ORDER BY COALESCE(seq_number, 999999999), COALESCE(level, 99), login`
      );
      if (!rows.length) {
        return { GENERAL: [], source: 'database' };
      }

      return {
        GENERAL: rows.map((row) => ({
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
    } catch (err) {
      logger.error('getPersistedAgentHierarchy error', errorMessage(err));
      return { GENERAL: [], source: 'database', error: errorMessage(err) };
    }
  }

  async backfillAgentHierarchy(): Promise<unknown> {
    return backfillAgentsAndPlayers(this.db);
  }

  /**
   * Fetch language/theme UI config through an active Buckeye session.
   */
  async getBuckeyeUiConfig(
    agentId?: string,
    includeRaw: boolean = false,
    includeAgentParams: boolean = false
  ): Promise<Partial<Omit<BuckeyeUiConfigResult, 'parsed'>> & { parsed: BuckeyeUiConfigResult['parsed'] | null; message?: string; error?: string }> {
    const instance = agentId
      ? this.agents.get(agentId)
      : Array.from(this.agents.values()).find((agent) => agent.api.isAuthenticated());

    if (!instance || !instance.api.isAuthenticated()) {
      return { parsed: null, message: 'Not authenticated to Buckeye' };
    }

    try {
      return await instance.api.getLanguageUiConfig({ includeRaw, includeAgentParams });
    } catch (err) {
      logger.error('getBuckeyeUiConfig error', errorMessage(err));
      return { parsed: null, error: errorMessage(err) };
    }
  }

  /**
   * Fetch sanitized account info through an active Buckeye session.
   */
  async getBuckeyeAccountInfo(
    agentId?: string,
    force: boolean = false
  ): Promise<Partial<Omit<BuckeyeAccountInfoResult, 'accountInfo'>> & { accountInfo: BuckeyeAccountInfoResult['accountInfo'] | null; message?: string; error?: string }> {
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
    } catch (err) {
      logger.error('getBuckeyeAccountInfo error', errorMessage(err));
      return { accountInfo: null, error: errorMessage(err) };
    }
  }

  /**
   * Fetch weekly figure report through an active Buckeye session.
   */
  async getWeeklyFigureByAgentLite(
    agentId?: string,
    options: BuckeyeWeeklyFigureOptions = {}
  ): Promise<ManagerWeeklyFigureResult> {
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
        logger.warn('Weekly figure archive failed', persistError instanceof Error ? persistError.message : persistError);
      }
      return result as ManagerWeeklyFigureResult;
    } catch (err) {
      logger.error('getWeeklyFigureByAgentLite error', errorMessage(err));
      return { data: null, error: errorMessage(err) };
    }
  }

  /**
   * Fetch Buckeye manager bootstrap/report payloads discovered from manager.html.
   */
  async getBuckeyeManagerSnapshot(
    agentId?: string
  ): Promise<ManagerSnapshotResult> {
    const instance = this.resolveAgentInstance(agentId);

    if (!instance || !instance.api.isAuthenticated()) {
      return { data: null, sportsType: emptyBuckeyeData(), message: 'Not authenticated to Buckeye' };
    }

    try {
      const result = await instance.api.getManagerSnapshot();
      try {
        await this.persistManagerSnapshot(result);
      } catch (persistError) {
        logger.warn('Manager snapshot archive failed', persistError instanceof Error ? persistError.message : persistError);
      }
      return result as ManagerSnapshotResult;
    } catch (err) {
      logger.error('getBuckeyeManagerSnapshot error', errorMessage(err));
      return { data: null, sportsType: emptyBuckeyeData(), error: errorMessage(err) };
    }
  }

  private async persistManagerSnapshot(result: BuckeyeManagerSnapshotResult): Promise<void> {
    if (!result || !result.agentId) return;
    try {
      await this.db.run(
        `INSERT INTO master_snapshots
          (provider, agent_id, timestamp, config_web_reports_json, config_web_reports_pending_json, sports_type_json, authorizations_json, message_json, new_emails_count_json, account_info_json, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(result),
        ]
      );
    } catch (err) {
      logger.error(`persistManagerSnapshot failed for ${result.agentId}`, err instanceof Error ? err.message : err);
      throw err;
    }
    this.broadcast({
      type: 'masterSnapshot.new',
      timestamp: new Date().toISOString(),
      agentId: result.agentId,
      payload: { fetchedAt: result.fetchedAt },
    });
  }

  async getBuckeyeSportTypes(): Promise<BuckeyeSportTypeRow[]> {
    return this.db.all<BuckeyeSportTypeRow>(
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
  ): Promise<ManagerAgentPerformanceResult> {
    const instance = this.resolveAgentInstance(agentId);

    if (!instance || !instance.api.isAuthenticated()) {
      return { data: null, message: 'Not authenticated to Buckeye' };
    }

    try {
      const result = await instance.api.getAgentPerformanceReport(options);
      await this.persistAgentPerformanceReport(result);
      return result as ManagerAgentPerformanceResult;
    } catch (err) {
      logger.error('getBuckeyeAgentPerformanceReport error', errorMessage(err));
      return { data: null, error: errorMessage(err) };
    }
  }

  async getBuckeyePlayerPerformance(
    customerId: string,
    period: string | number = 0,
    agentId?: string
  ): Promise<ManagerAgentPerformanceResult> {
    const instance = this.resolveAgentInstance(agentId);

    if (!instance || !instance.api.isAuthenticated()) {
      return { data: emptyBuckeyeData(), message: 'Not authenticated to Buckeye' };
    }

    try {
      const result = await instance.api.getPerformancePlayer(customerId, {
        acc: customerId,
        period,
        agentID: agentId || instance.credentials.agentId,
        agentOwner: agentId || instance.credentials.agentId,
      });
      await this.persistPlayerPerformanceSnapshot(result, customerId, customerId);
      await this.setWatermark(
        `last_player_performance.${instance.credentials.agentId}.${customerId}`,
        result.fetchedAt || new Date().toISOString()
      );
      return result as ManagerAgentPerformanceResult;
    } catch (err) {
      logger.error('getBuckeyePlayerPerformance error', errorMessage(err));
      return { data: emptyBuckeyeData(), error: errorMessage(err) };
    }
  }

  async getBuckeyePlayerInfo(
    customerId: string,
    agentId?: string
  ): Promise<BuckeyeCustomerSnapshotResult | { data: null; message?: string; error?: string }> {
    const instance = this.resolveAgentInstance(agentId);

    if (!instance || !instance.api.isAuthenticated()) {
      return { data: null, message: 'Not authenticated to Buckeye' };
    }

    try {
      const result = await instance.api.getCustomerSnapshot(customerId);
      if (result.snapshot) {
        await this.persistCustomerSnapshot(result.snapshot);
      }
      return result;
    } catch (err) {
      logger.error('getBuckeyePlayerInfo error', errorMessage(err));
      return { data: null, error: errorMessage(err) };
    }
  }

  async getBuckeyePlayerTransactions(
    customerId: string,
    agentId?: string
  ): Promise<BuckeyeTransactionListResult | { data: null; message?: string; error?: string }> {
    const instance = this.resolveAgentInstance(agentId);

    if (!instance || !instance.api.isAuthenticated()) {
      return { data: null, message: 'Not authenticated to Buckeye' };
    }

    try {
      const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const result = await instance.api.getTransactionList(customerId, { start });
      return result;
    } catch (err) {
      logger.error('getBuckeyePlayerTransactions error', errorMessage(err));
      return { data: null, error: errorMessage(err) };
    }
  }

  async getWebLogLive(
    options: BuckeyeWebLogOptions,
    agentId?: string
  ): Promise<{ data: BuckeyeWebLogRow[]; total: number; novel: Record<string, boolean> }> {
    const instance = this.resolveAgentInstance(agentId);

    if (!instance || !instance.api.isAuthenticated()) {
      throw new Error('No active Buckeye agent available');
    }

    const resolvedAgentId = instance.credentials.agentId;
    const rows = await instance.api.getWebLog(options);

    // Geo-IP enrichment
    const geoPromises = rows.map(async (row) => {
      if (row.IPAddress) {
        const geo = await enrichIpGeo(row.IPAddress);
        if (geo) {
          row.geo = {
            country: geo.country,
            region: geo.region,
            city: geo.city,
            timezone: geo.timezone,
            lat: geo.ll[0],
            lon: geo.ll[1],
          };
        }
      }
    });
    await Promise.all(geoPromises);

    // Novelty check: is this the first time we've seen (login_id, ip_address)?
    const novel: Record<string, boolean> = {};
    for (const row of rows) {
      if (!row.LoginID || !row.IPAddress) continue;
      const key = `${row.LoginID}|${row.IPAddress}`;
      const existing = await this.db.get(
        `SELECT 1 FROM access_logs WHERE login_id = ? AND ip_address = ? LIMIT 1`,
        [row.LoginID, row.IPAddress]
      );
      novel[key] = !existing;
    }

    // Persist to access_logs and run pattern analysis
    await this.patternService.persistAccessLogs(resolvedAgentId, rows, options.type || 'A');
    await new IPTracker(this.db, this).processWebLogRows(resolvedAgentId, rows, options.type || 'A');
    const patterns = await this.patternService.analyzeAccessLogs(resolvedAgentId);
    await this.patternService.persistPatterns(patterns);
    await this.broadcastIpTrackerAlerts(resolvedAgentId);

    return { data: rows, total: rows.length, novel };
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

  async persistWeeklyFigureReport(report: BuckeyeWeeklyFigureResult): Promise<void> {
    if (!report || report.data === null) return;

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
  async getAgentPerformance(agentId: string): Promise<SqlRow> {
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
  async getPlayerDetails(playerId: string): Promise<PlayerDetailsResult> {
    const profile = await this.db.get<PlayerProfileRow>(
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

    const agents = await this.db.all<{ agent_login: string }>(
      `SELECT DISTINCT agent_login FROM wagers WHERE login = ?`,
      [playerId]
    );

    return {
      playerId,
      profile: profile && Number(profile.wager_count || 0) > 0 ? profile : {},
      agents: agents.map((a) => a.agent_login),
    };
  }

  /**
   * Get all wagers for a specific player.
   */
  async getPlayerWagers(playerId: string): Promise<SqlRow[]> {
    return this.db.all(
      `SELECT * FROM wagers WHERE login = ? ORDER BY insert_datetime DESC LIMIT 200`,
      [playerId]
    );
  }

  /**
   * Get player P&L history over N days.
   * Returns daily buckets with volume, risk, and wager count.
   */
  async getPlayerPnlHistory(playerId: string, days: number = 7): Promise<SqlRow[]> {
    const rows = await this.db.all<SqlRow & { day: string }>(
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
    const result: SqlRow[] = [];
    const seenDays = new Set(rows.map((r) => r.day));
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().split('T')[0];
      if (seenDays.has(dayStr)) {
        const existingRow = rows.find((r) => r.day === dayStr);
        if (existingRow) result.push(existingRow);
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
  private getWagerExposure(w: ExposureWagerRow): number {
    const volume = Number(w.volume_amount || 0);
    return (volume > 0 ? volume : Number(w.amount_wagered || 0)) || 0;
  }

  async getSportExposure(): Promise<SqlRow[]> {
    const wagers = await this.db.all<ExposureWagerRow>(
      `SELECT * FROM wagers ORDER BY insert_datetime DESC LIMIT 500`
    );

    if (wagers.length === 0) return [];

    const totalVolume = wagers.reduce((s, w) => s + this.getWagerExposure(w), 0);

    // Group by sport
    const sportGroups: Record<string, ExposureWagerRow[]> = {};
    for (const w of wagers) {
      const sport = w.sport || this.parseSport(w.short_desc || '');
      if (!sportGroups[sport]) sportGroups[sport] = [];
      sportGroups[sport].push(w);
    }

    const result: SqlRow[] = [];
    for (const [sport, sws] of Object.entries(sportGroups)) {
      const sportVolume = sws.reduce((s, w) => s + this.getWagerExposure(w), 0);
      const liveCount = sws.filter(w => w.ticket_writer === 'GSLIVE').length;

      // Group by game within sport
      const gameGroups: Record<string, ExposureWagerRow[]> = {};
      for (const w of sws) {
        const game = this.parseGame(w.short_desc || '');
        if (!gameGroups[game]) gameGroups[game] = [];
        gameGroups[game].push(w);
      }

      // Find top game by volume
      let topGame = '';
      let topGameVolume = 0;
      let topGameWagers: ExposureWagerRow[] = [];
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
        const side = this.parseSide(w.short_desc || '');
        const price = this.extractPrice(w.short_desc || '');
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

    return result.sort((a, b) => Number(b.total || 0) - Number(a.total || 0));
  }

  /**
   * Get agent exposure breakdown with top customer and top game per agent.
   */
  async getAgentExposure(): Promise<SqlRow[]> {
    const wagers = await this.db.all<ExposureWagerRow>(
      `SELECT * FROM wagers ORDER BY insert_datetime DESC LIMIT 500`
    );

    if (wagers.length === 0) return [];

    const totalVolume = wagers.reduce((s, w) => s + this.getWagerExposure(w), 0);

    // Group by agent
    const agentGroups: Record<string, ExposureWagerRow[]> = {};
    for (const w of wagers) {
      const agent = w.agent_login || 'Unknown';
      if (!agentGroups[agent]) agentGroups[agent] = [];
      agentGroups[agent].push(w);
    }

    const result: SqlRow[] = [];
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
        const game = this.parseGame(w.short_desc || '');
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

    return result.sort((a, b) => Number(b.total || 0) - Number(a.total || 0));
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
  }): Promise<ActionResult> {
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

    return {
      id: request.id,
      action: request.action,
      wagerNumber: request.wagerNumber,
      ...result,
    };
  }

  getMetrics(): ScraperMetrics {
    return {
      activeAgents: this.agents.size,
      agents: Array.from(this.agents.entries()).map(([id, inst]) => ({
        agentId: id,
        isPolling: inst.isPolling,
        pollingScheduled: Boolean(inst.pollTask),
        lastPoll: inst.lastPoll ? new Date(inst.lastPoll).toISOString() : null,
        errorCount: inst.errorCount,
        consecutiveErrors: inst.consecutiveErrors,
        lastError: inst.lastError || null,
        authenticated: inst.api.isAuthenticated(),
        currentPollMs: inst.currentPollMs,
        reloginAttempts: inst.reloginAttempts,
        player360Active: Boolean(inst.player360Task),
      })),
      actionQueue: this.actionQueue.getMetrics(),
      counters: {
        wagers_total: this.wagerCount,
        alerts_triggered_total: this.alertCount,
        errors_total: this.errorCount,
      },
    };
  }

  resolveAgentInstance(agentId?: string): AgentInstance | undefined {
    if (agentId) {
      const direct = this.agents.get(agentId);
      if (direct) return direct;
    }
    return Array.from(this.agents.values()).find((agent) => agent.api.isAuthenticated());
  }

  async getEnhancedProxyCredentials(agentId?: string): Promise<EnhancedProxyCredentials | null> {
    const instance = this.resolveAgentInstance(agentId);
    if (instance?.api.isAuthenticated()) {
      const cookieParts = extractBuckeyeCookies(instance.api.getCookie() || instance.credentials.cfCookie);
      return {
        agentID: instance.credentials.agentId,
        token: instance.api.getToken() || instance.credentials.token,
        ...cookieParts,
      };
    }

    const secrets = await this.secretVault?.getBuckeyeSecrets(agentId);
    if (!secrets) return null;
    return {
      agentID: secrets.agentId,
      token: secrets.token,
      ...extractBuckeyeCookies(secrets.cfCookie),
    };
  }

  private async initializeLiveAgentTree(agentId: string, instance: AgentInstance): Promise<void> {
    try {
      const hierarchy = await instance.api.getAgentHierarchy();
      const agents = Array.isArray(hierarchy?.GENERAL) ? hierarchy.GENERAL : [];
      instance.liveTree = new LiveAgentTree(agents);
    } catch {
      logger.warn(`Live agent tree hierarchy unavailable for ${agentId}; using wager-only deltas`);
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
      logger.warn(`Skipping poll for ${agentId} — previous poll still running`);
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

          // 🔌 Feed new wager into plugin pipeline via TickerBuffer
          await this.feedWagerToPlugins(change.wager);
        }
      }

      // Evaluate alerts on new wagers
      const newChanges = changes.filter((c) => c.type === 'new');
      if (newChanges.length > 0) {
        for (const change of newChanges) {
          const alerts = evaluateWager(change.wager);
          await this.evaluateAgentRules(change.wager);
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
      logger.error(`Poll error for ${agentId}`, error);

      // Backoff: increase poll interval on consecutive errors
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, instance.consecutiveErrors),
        60000 // cap at 60s
      );
      if (backoffMs !== instance.currentPollMs) {
        instance.currentPollMs = backoffMs;
        instance.pollTask.restart(instance.currentPollMs);
        logger.info(`Backing off ${agentId} to ${backoffMs}ms`);
      }

      // Re-auth if session expired
      if (!instance.api.isAuthenticated() || instance.consecutiveErrors >= 3) {
        if (instance.reloginAttempts < 3) {
          instance.reloginAttempts++;
          logger.info(`Re-authenticating ${agentId} (attempt ${instance.reloginAttempts})...`);
          const ok = await instance.api.login();
          if (!ok) {
            logger.warn(`Re-login failed for ${agentId}`);
          }
        } else {
          logger.error(`Max re-login attempts reached for ${agentId}. Stopping.`);
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

    logger.warn(`Token renewal failed for ${agentId}, attempting password re-login`);
    const reloginOk = await instance.api.login();
    if (reloginOk) {
      instance.lastError = undefined;
      await this.saveAgentSecrets(agentId, instance);
    } else {
      instance.lastError = 'Token renewal and password re-login failed';
      logger.warn(`Password re-login failed for ${agentId}; will retry on next renewal`);
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
  private async persistWager(wager: EnrichedWager): Promise<Awaited<ReturnType<PatternService['correlateWager']>>> {
    const correlation = await this.patternService.correlateWager(wager);
    const parsed = correlation.parsed;
    const hierarchy = await this.resolveWagerHierarchyContext(wager);

    try {
      // Insert into main wagers table
      await this.db.run(
        `INSERT OR REPLACE INTO wagers
        (wager_number, agent_id, customer_id, login, wager_type,
         amount_wagered, to_win_amount, volume_amount, insert_datetime,
         ticket_writer, short_desc, vip, agent_login, sport,
         parsed_game, parsed_market, parsed_side, parsed_price, parsed_period,
         matched_event_id, pin_reference_json, raw_json, agent_level, agent_type,
         parent_agent_id, mapped_agent_id, mapped_agent_login, agent_path_json,
         hierarchy_source, scraped_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(wager),
          hierarchy.agentLevel,
          hierarchy.agentType,
          hierarchy.parentAgentId,
          hierarchy.mappedAgentId,
          hierarchy.mappedAgentLogin,
          hierarchy.agentPathJson,
          hierarchy.hierarchySource,
          new Date().toISOString(),
        ]
      );
    } catch (err) {
      logger.error(`persistWager INSERT failed for wager #${wager.WagerNumber}`, err instanceof Error ? err.message : err);
      throw err;
    }

    try {
      const archiveInsert = await this.db.run(
        `INSERT OR IGNORE INTO wager_archive
        (wager_number, agent_id, customer_id, login, wager_type,
         amount_wagered, to_win_amount, insert_date_time, ticket_writer,
         volume_amount, short_desc_raw, vip, agent_login, ingested_at, raw_json,
         sport, league, price, agent_level, agent_type, parent_agent_id,
         mapped_agent_id, mapped_agent_login, agent_path_json, hierarchy_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          hierarchy.agentLevel,
          hierarchy.agentType,
          hierarchy.parentAgentId,
          hierarchy.mappedAgentId,
          hierarchy.mappedAgentLogin,
          hierarchy.agentPathJson,
          hierarchy.hierarchySource,
        ]
      );
      if (archiveInsert.changes > 0) {
        this.deferWagerArchiveParse(wager.WagerNumber, wager.ShortDesc, parsed.price);
      }
    } catch (err) {
      logger.warn(`wager_archive INSERT failed for wager #${wager.WagerNumber}`, err instanceof Error ? err.message : err);
    }

    try {
      await this.updateIngestionCheckpoint('wagers', Number(wager.WagerNumber) || 0, {
        agentId: wager.AgentID,
        agentLogin: wager.AgentLogin,
        scrapedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(`Ingestion checkpoint update failed for wager #${wager.WagerNumber}`, err instanceof Error ? err.message : err);
    }

    return correlation;
  }

  private async resolveWagerHierarchyContext(wager: EnrichedWager): Promise<WagerHierarchyContext> {
    const playerId = String(wager.CustomerID || '').trim();
    const login = String(wager.Login || '').trim();
    const wagerAgent = String(wager.AgentLogin || wager.AgentID || '').trim();
    const mapped = await this.db.get<{
      mapped_agent_id: string | null;
      mapped_agent_login: string | null;
      agent_level: number | null;
      agent_type: string | null;
      parent_agent_id: string | null;
      source: string | null;
    }>(
      `SELECT
        m.agent_id AS mapped_agent_id,
        COALESCE(ah.login, m.agent_login, m.agent_id) AS mapped_agent_login,
        ah.level AS agent_level,
        ah.agent_type AS agent_type,
        ah.parent_agent_id AS parent_agent_id,
        m.source AS source
       FROM player_agent_map m
       LEFT JOIN agent_hierarchy ah ON ah.provider = m.provider AND ah.agent_id = m.agent_id
       WHERE m.provider = 'buckeye'
        AND (m.player_id = ? OR m.player_login = ? OR m.player_id = ? OR m.player_login = ?)
       ORDER BY CASE WHEN m.player_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      [playerId, playerId, login, login, playerId]
    );

    const fallback = mapped?.mapped_agent_id ? null : await this.db.get<{
      mapped_agent_id: string | null;
      mapped_agent_login: string | null;
      agent_level: number | null;
      agent_type: string | null;
      parent_agent_id: string | null;
    }>(
      `SELECT
        agent_id AS mapped_agent_id,
        login AS mapped_agent_login,
        level AS agent_level,
        agent_type,
        parent_agent_id
       FROM agent_hierarchy
       WHERE provider = 'buckeye'
        AND (agent_id = ? OR login = ?)
       LIMIT 1`,
      [wagerAgent, wagerAgent]
    );

    const row = mapped?.mapped_agent_id ? mapped : fallback;
    const mappedAgentId = String(row?.mapped_agent_id || wagerAgent || '').trim() || null;
    const mappedAgentLogin = String(row?.mapped_agent_login || wagerAgent || '').trim() || mappedAgentId;
    const path = mappedAgentId ? await this.getAgentPath(mappedAgentId) : [];

    return {
      agentLevel: numberOrNull(row?.agent_level),
      agentType: row?.agent_type ? String(row.agent_type) : null,
      parentAgentId: row?.parent_agent_id ? String(row.parent_agent_id) : null,
      mappedAgentId,
      mappedAgentLogin,
      agentPathJson: JSON.stringify(path),
      hierarchySource: mapped?.mapped_agent_id ? `player_agent_map:${mapped.source || 'unknown'}` : fallback ? 'wager_agent' : 'wager_fallback',
    };
  }

  private async getAgentPath(agentId: string): Promise<Array<{ agentId: string; login: string; level: number | null }>> {
    const rows = await this.db.all<{ agent_id: string; login: string | null; level: number | null; depth: number }>(
      `SELECT ah.agent_id, ah.login, ah.level, ac.depth
       FROM agent_closure ac
       JOIN agent_hierarchy ah ON ah.provider = ac.provider AND ah.agent_id = ac.ancestor
       WHERE ac.provider = 'buckeye' AND ac.descendant = ?
       ORDER BY ac.depth DESC`,
      [agentId]
    );
    if (rows.length > 0) {
      return rows.map((row) => ({
        agentId: row.agent_id,
        login: row.login || row.agent_id,
        level: numberOrNull(row.level),
      }));
    }
    const self = await this.db.get<{ agent_id: string; login: string | null; level: number | null }>(
      `SELECT agent_id, login, level FROM agent_hierarchy WHERE provider = 'buckeye' AND agent_id = ? LIMIT 1`,
      [agentId]
    );
    return self ? [{ agentId: self.agent_id, login: self.login || self.agent_id, level: numberOrNull(self.level) }] : [];
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
        logger.warn('Deferred wager archive parse failed', err instanceof Error ? err.message : err);
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

  async getAccessLogs(limit: number = 200): Promise<SqlRow[]> {
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
        onError: (err) => logger.warn(`Access log refresh failed for ${agentId}`, err instanceof Error ? err.message : err),
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
        onError: (err) => logger.warn(`Agent performance refresh failed for ${agentId}`, err instanceof Error ? err.message : err),
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
        onError: (err) => logger.warn(`Daily archive refresh failed for ${agentId}`, err instanceof Error ? err.message : err),
      }
    );
  }

  private startPlayer360Polling(agentId: string, instance: AgentInstance): void {
    instance.player360Task?.stop();
    instance.player360Task = createManagedInterval(
      `buckeye.${agentId}.player360`,
      this.player360IntervalMs,
      () => this.refreshPlayer360(agentId).then(() => undefined),
      {
        initialDelayMs: 10_000,
        onError: (err) => logger.warn(`Player 360 refresh failed for ${agentId}`, err instanceof Error ? err.message : err),
      }
    );
  }

  private async refreshPlayer360(agentId: string): Promise<{
    players: number;
    hotPlayers?: number;
    coldBackfillPlayers?: number;
    deposits: number;
    transactions: number;
    snapshots: number;
    performance: number;
    links: number;
  }> {
    const instance = this.agents.get(agentId);
    if (!instance || !instance.api.isAuthenticated()) {
      throw new Error(`Agent ${agentId} is not active`);
    }

    const hotPlayers = await this.getHotPlayersFor360(agentId);
    const hotKeys = new Set(hotPlayers.map((player) => this.player360CandidateKey(player)));
    const coldBackfillPlayers = this.player360ColdBackfillPerPoll > 0
      ? await this.getColdBackfillPlayersFor360(agentId, hotKeys, this.player360ColdBackfillPerPoll)
      : [];
    const players = [...hotPlayers, ...coldBackfillPlayers];
    let depositRows = 0;
    let transactionRows = 0;
    let snapshots = 0;
    let performanceRows = 0;
    const touchedPlayers: string[] = [];

    for (const player of players) {
      const customerId = player.customerId || player.login;
      if (!customerId) continue;

      const refreshTransactions = await this.shouldRefreshPlayerSource(customerId, player.login, 'player_transactions');
      const refreshDeletedTransactions = await this.shouldRefreshPlayerSource(customerId, player.login, 'deleted_transactions');
      if (refreshTransactions || refreshDeletedTransactions) {
        if (refreshTransactions) {
          await this.markPlayerSourceAttempt(player, 'player_transactions');
          await this.markPlayerSourceAttempt(player, 'deposits');
        }
        if (refreshDeletedTransactions) {
          await this.markPlayerSourceAttempt(player, 'deleted_transactions');
        }
        try {
          const refreshResult = await this.refreshPlayerTransactionLedger(instance, player, {
            includeCore: refreshTransactions,
            includeDeleted: refreshDeletedTransactions,
          });
          transactionRows += refreshResult.transactions;
          depositRows += refreshResult.deposits;
          await this.markTransactionRefreshStatus(player, refreshResult, refreshTransactions, refreshDeletedTransactions);
        } catch (error) {
          if (refreshTransactions) {
            await this.markPlayerSourceError(player, 'player_transactions', error);
            await this.markPlayerSourceError(player, 'deposits', error);
          }
          if (refreshDeletedTransactions) {
            await this.markPlayerSourceError(player, 'deleted_transactions', error);
          }
          logger.warn(`Transaction ledger probe failed for ${customerId}`, error instanceof Error ? error.message : error);
        }
      }

      if (await this.shouldRefreshPlayerSource(customerId, player.login, 'customer_snapshots')) {
        await this.markPlayerSourceAttempt(player, 'customer_snapshots');
        try {
          const snapshot = await instance.api.getCustomerSnapshot(customerId);
          if (snapshot.snapshot) {
            await this.persistCustomerSnapshot(snapshot.snapshot);
            snapshots += 1;
            await this.markPlayerSourceSuccess(player, 'customer_snapshots');
          }
        } catch (error) {
          await this.markPlayerSourceError(player, 'customer_snapshots', error);
        }
      }

      if (await this.shouldRefreshPlayerSource(customerId, player.login, 'teaser_profile')) {
        await this.markPlayerSourceAttempt(player, 'teaser_profile');
        try {
          await instance.api.getTeaserProfile(customerId);
        } catch (error) {
          await this.markPlayerSourceError(player, 'teaser_profile', error);
          logger.warn(`getTeaserProfile probe failed for ${customerId}`, error instanceof Error ? error.message : error);
        }
      }

      if (await this.shouldRefreshPlayerSource(customerId, player.login, 'agent_performance_snapshots')) {
        await this.markPlayerSourceAttempt(player, 'agent_performance_snapshots');
        try {
          const performance = await instance.api.getPerformancePlayer(customerId, {
            acc: customerId,
            period: 0,
            agentID: agentId,
            agentOwner: agentId,
          });
          performanceRows += await this.persistPlayerPerformanceSnapshot(performance, customerId, player.login);
          await this.markPlayerSourceSuccess(player, 'agent_performance_snapshots');
        } catch (error) {
          await this.markPlayerSourceError(player, 'agent_performance_snapshots', error);
          logger.warn(`getPerformancePlayer probe failed for ${customerId}`, error instanceof Error ? error.message : error);
        }
      }

      touchedPlayers.push(customerId);
    }

    const links = await this.refreshPlayerLinks(agentId);
    const fetchedAt = new Date().toISOString();
    await this.setWatermark(
      `last_player360_poll.${agentId}`,
      JSON.stringify({
        players: players.length,
        hotPlayers: hotPlayers.length,
        coldBackfillPlayers: coldBackfillPlayers.length,
        coldBackfillLimit: this.player360ColdBackfillPerPoll,
        deposits: depositRows,
        transactions: transactionRows,
        snapshots,
        performance: performanceRows,
        links,
        fetchedAt,
      })
    );

    this.broadcast({
      type: 'player360.update',
      timestamp: fetchedAt,
      agentId,
      payload: {
        players: touchedPlayers,
        hotPlayers: hotPlayers.length,
        coldBackfillPlayers: coldBackfillPlayers.length,
        deposits: depositRows,
        transactions: transactionRows,
        snapshots,
        performance: performanceRows,
        links,
      },
    });

    return {
      players: players.length,
      hotPlayers: hotPlayers.length,
      coldBackfillPlayers: coldBackfillPlayers.length,
      deposits: depositRows,
      transactions: transactionRows,
      snapshots,
      performance: performanceRows,
      links,
    };
  }

  private async getHotPlayersFor360(agentId: string): Promise<Player360Candidate[]> {
    const rows = await this.db.all<Player360Candidate>(
      `SELECT
        COALESCE(NULLIF(wager_archive.customer_id, ''), NULLIF(wager_archive.login, '')) AS customerId,
        COALESCE(NULLIF(wager_archive.login, ''), NULLIF(wager_archive.customer_id, '')) AS login,
        COALESCE(NULLIF(wager_archive.agent_id, ''), NULLIF(wager_archive.agent_login, ''), ?) AS agentId,
        COALESCE(NULLIF(wager_archive.agent_login, ''), NULLIF(wager_archive.agent_id, ''), ?) AS agentLogin,
        MAX(wager_archive.insert_date_time) AS lastWager
       FROM wager_archive
       LEFT JOIN player_flags pf
        ON pf.customer_id = COALESCE(NULLIF(wager_archive.customer_id, ''), NULLIF(wager_archive.login, ''))
        AND pf.status = 'active'
       LEFT JOIN player_source_status pss
        ON pss.customer_id = COALESCE(NULLIF(wager_archive.customer_id, ''), NULLIF(wager_archive.login, ''))
        AND pss.agent_id = ?
        AND pss.last_error IS NOT NULL
       WHERE (
        wager_archive.agent_login = ?
        OR wager_archive.agent_id = ?
        OR NOT EXISTS (
          SELECT 1
          FROM wager_archive scoped
          WHERE scoped.agent_login = ? OR scoped.agent_id = ?
        )
       )
         AND COALESCE(NULLIF(wager_archive.customer_id, ''), NULLIF(wager_archive.login, '')) IS NOT NULL
         AND (
          wager_archive.insert_date_time >= datetime('now', '-24 hours')
          OR pf.id IS NOT NULL
          OR pss.id IS NOT NULL
         )
       GROUP BY COALESCE(NULLIF(wager_archive.customer_id, ''), NULLIF(wager_archive.login, ''))
       ORDER BY MAX(wager_archive.insert_date_time) DESC
       LIMIT ?`,
      [agentId, agentId, agentId, agentId, agentId, agentId, agentId, this.player360MaxPlayersPerPoll]
    );

    return rows
      .map((row) => ({
        customerId: String(row.customerId || '').trim(),
        login: String(row.login || '').trim(),
        agentId: String(row.agentId || agentId).trim(),
        agentLogin: String(row.agentLogin || agentId).trim(),
      }))
      .filter((row) => row.customerId || row.login);
  }

  private player360CandidateKey(player: Pick<Player360Candidate, 'customerId' | 'login'>): string {
    return String(player.customerId || player.login || '').trim().toUpperCase();
  }

  private async getColdBackfillPlayersFor360(
    agentId: string,
    excludeKeys: Set<string>,
    limit: number
  ): Promise<Player360Candidate[]> {
    if (limit <= 0) return [];

    const sourceKeys = [
      'player_transactions',
      'deleted_transactions',
      'customer_snapshots',
      'teaser_profile',
      'agent_performance_snapshots',
    ];
    const placeholders = sourceKeys.map(() => '?').join(', ');
    const rows = await this.db.all<Player360Candidate>(
      `SELECT
        COALESCE(NULLIF(wager_archive.customer_id, ''), NULLIF(wager_archive.login, '')) AS customerId,
        COALESCE(NULLIF(wager_archive.login, ''), NULLIF(wager_archive.customer_id, '')) AS login,
        COALESCE(NULLIF(wager_archive.agent_id, ''), NULLIF(wager_archive.agent_login, ''), ?) AS agentId,
        COALESCE(NULLIF(wager_archive.agent_login, ''), NULLIF(wager_archive.agent_id, ''), ?) AS agentLogin,
        MAX(wager_archive.insert_date_time) AS lastWager
       FROM wager_archive
       LEFT JOIN player_source_status pss
        ON pss.customer_id = COALESCE(NULLIF(wager_archive.customer_id, ''), NULLIF(wager_archive.login, ''))
        AND pss.agent_id = ?
        AND pss.source_key IN (${placeholders})
       WHERE (
        wager_archive.agent_login = ?
        OR wager_archive.agent_id = ?
        OR NOT EXISTS (
          SELECT 1
          FROM wager_archive scoped
          WHERE scoped.agent_login = ? OR scoped.agent_id = ?
        )
       )
         AND COALESCE(NULLIF(wager_archive.customer_id, ''), NULLIF(wager_archive.login, '')) IS NOT NULL
       GROUP BY COALESCE(NULLIF(wager_archive.customer_id, ''), NULLIF(wager_archive.login, ''))
       HAVING COUNT(DISTINCT pss.source_key) < ?
          OR MAX(CASE WHEN pss.last_error IS NOT NULL THEN 1 ELSE 0 END) = 1
          OR MIN(pss.last_attempt_at) IS NULL
          OR MIN(pss.last_attempt_at) <= datetime('now', '-6 hours')
       ORDER BY
        COUNT(DISTINCT pss.source_key) ASC,
        COALESCE(MIN(pss.last_attempt_at), '1970-01-01') ASC,
        MAX(wager_archive.insert_date_time) DESC
       LIMIT ?`,
      [
        agentId,
        agentId,
        agentId,
        ...sourceKeys,
        agentId,
        agentId,
        agentId,
        agentId,
        sourceKeys.length,
        Math.max(limit * 10, limit),
      ]
    );

    const candidates = rows
      .map((row) => ({
        customerId: String(row.customerId || '').trim(),
        login: String(row.login || '').trim(),
        agentId: String(row.agentId || agentId).trim(),
        agentLogin: String(row.agentLogin || agentId).trim(),
      }))
      .filter((row) => row.customerId || row.login)
      .filter((row) => !excludeKeys.has(this.player360CandidateKey(row)));

    return candidates.slice(0, limit);
  }

  private async refreshPlayerTransactionLedger(instance: AgentInstance, player: {
    customerId: string;
    login: string;
    agentId: string;
    agentLogin: string;
  }, options: {
    includeCore: boolean;
    includeDeleted: boolean;
  } = { includeCore: true, includeDeleted: true }): Promise<{
    transactions: number;
    deposits: number;
    coreSucceeded: boolean;
    deletedSucceeded: boolean;
    errors: string[];
  }> {
    const customerId = player.customerId || player.login;
    const rowsByKey = new Map<string, BuckeyeTransactionRow>();
    const errors: string[] = [];
    let coreSucceeded = false;
    let deletedSucceeded = false;

    if (options.includeCore) {
      try {
        const transactionList = await instance.api.getTransactionList(customerId);
        coreSucceeded = true;
        for (const row of transactionList.rows.filter((entry) => this.isPlayerTransactionRow(entry, customerId, player.login))) {
          rowsByKey.set(transactionDedupeKey(row), row);
        }
      } catch (error) {
        errors.push(`getTransactionList: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const transactionHistory = await instance.api.getTransactionHistory(customerId);
        coreSucceeded = true;
        for (const row of transactionHistory.rows.filter((entry) => this.isPlayerTransactionRow(entry, customerId, player.login))) {
          if (!rowsByKey.has(transactionDedupeKey(row))) {
            rowsByKey.set(transactionDedupeKey(row), row);
          }
        }
      } catch (error) {
        errors.push(`getTransactionHistory: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (options.includeDeleted) {
      try {
        const deletedTransactions = await instance.api.getReportDeletedTransactions(customerId);
        deletedSucceeded = true;
        for (const row of deletedTransactions.rows.filter((entry) => this.isPlayerTransactionRow(entry, customerId, player.login))) {
          rowsByKey.set(transactionDedupeKey(row), row);
        }
      } catch (error) {
        errors.push(`getReportDeletedTransactions: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!coreSucceeded && !deletedSucceeded) {
      throw new Error(errors.join('; ') || 'No Buckeye transaction ledger endpoint responded');
    }

    if (errors.length) {
      logger.warn(`Partial transaction ledger refresh for ${customerId}`, errors.join('; '));
    }

    let transactionRows = 0;
    let depositRows = 0;
    for (const row of rowsByKey.values()) {
      transactionRows += await this.persistPlayerTransaction(row);
      if (row.category === 'deposit') {
        depositRows += await this.persistDepositRow(transactionRowToDeposit(row));
      }
    }

    return { transactions: transactionRows, deposits: depositRows, coreSucceeded, deletedSucceeded, errors };
  }

  private async markTransactionRefreshStatus(player: {
    customerId: string;
    login: string;
    agentId: string;
    agentLogin: string;
  }, refreshResult: {
    coreSucceeded: boolean;
    deletedSucceeded: boolean;
    errors: string[];
  }, refreshTransactions: boolean, refreshDeletedTransactions: boolean): Promise<void> {
    const error = new Error(refreshResult.errors.join('; ') || 'Transaction source refresh failed');
    if (refreshTransactions) {
      if (refreshResult.coreSucceeded) {
        await this.markPlayerSourceSuccess(player, 'player_transactions');
        await this.markPlayerSourceSuccess(player, 'deposits');
      } else {
        await this.markPlayerSourceError(player, 'player_transactions', error);
        await this.markPlayerSourceError(player, 'deposits', error);
      }
    }
    if (refreshDeletedTransactions) {
      if (refreshResult.deletedSucceeded) {
        await this.markPlayerSourceSuccess(player, 'deleted_transactions');
      } else {
        await this.markPlayerSourceError(player, 'deleted_transactions', error);
      }
    }
  }

  private isPlayerTransactionRow(row: BuckeyeTransactionRow, customerId: string, login: string): boolean {
    const expected = new Set([customerId, login].map((value) => String(value || '').trim().toUpperCase()).filter(Boolean));
    if (!expected.size) return true;
    return [row.customerId, row.login]
      .map((value) => String(value || '').trim().toUpperCase())
      .some((value) => expected.has(value));
  }

  private async persistDepositRow(row: BuckeyeDepositRow): Promise<number> {
    const result = await this.db.run(
      `INSERT INTO deposits
        (id, provider, customer_id, login, agent_id, agent_login, amount, currency, method, ip_address, status, transaction_time, pulled_at, raw_json)
       VALUES (?, 'buckeye', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(id) DO UPDATE SET
        customer_id = excluded.customer_id,
        login = excluded.login,
        agent_id = excluded.agent_id,
        agent_login = excluded.agent_login,
        amount = excluded.amount,
        currency = excluded.currency,
        method = excluded.method,
        ip_address = excluded.ip_address,
        status = excluded.status,
        transaction_time = excluded.transaction_time,
        pulled_at = excluded.pulled_at,
        raw_json = excluded.raw_json`,
      [
        row.id,
        row.customerId,
        row.login,
        row.agentId,
        row.agentLogin,
        row.amount,
        row.currency,
        row.method,
        row.ipAddress,
        row.status,
        row.transactionTime,
        JSON.stringify(row.raw || {}),
      ]
    );
    return result.changes > 0 ? 1 : 0;
  }

  private async persistPlayerTransaction(row: BuckeyeTransactionRow): Promise<number> {
    const result = await this.db.run(
      `INSERT INTO player_transactions
        (id, provider, customer_id, login, agent_id, agent_login, document_number,
         tran_code, tran_type, amount, balance, hold_amount, grade_num, description,
         entered_by, category, transaction_time, pulled_at, raw_json)
       VALUES (?, 'buckeye', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(id) DO UPDATE SET
        customer_id = excluded.customer_id,
        login = excluded.login,
        agent_id = excluded.agent_id,
        agent_login = excluded.agent_login,
        document_number = excluded.document_number,
        tran_code = excluded.tran_code,
        tran_type = excluded.tran_type,
        amount = excluded.amount,
        balance = excluded.balance,
        hold_amount = excluded.hold_amount,
        grade_num = excluded.grade_num,
        description = excluded.description,
        entered_by = excluded.entered_by,
        category = excluded.category,
        transaction_time = excluded.transaction_time,
        pulled_at = excluded.pulled_at,
        raw_json = excluded.raw_json`,
      [
        row.id,
        row.customerId,
        row.login,
        row.agentId,
        row.agentLogin,
        row.documentNumber,
        row.tranCode,
        row.tranType,
        row.amount,
        row.balance,
        row.holdAmount,
        row.gradeNum,
        row.description,
        row.enteredBy,
        row.category,
        row.transactionTime,
        JSON.stringify(row.raw || {}),
      ]
    );
    return result.changes > 0 ? 1 : 0;
  }

  private async shouldRefreshPlayerSource(customerId: string, login: string, sourceKey: string): Promise<boolean> {
    const policy = getPlayer360SourcePolicy(sourceKey);
    if (policy.refreshPolicy === 'live' || policy.refreshPolicy === 'manual' || policy.refreshPolicy === 'derived') {
      return false;
    }
    const row = await this.db.get<{
      last_success_at: string | null;
      last_attempt_at: string | null;
      last_error: string | null;
    }>(
      `SELECT last_success_at, last_attempt_at, last_error
       FROM player_source_status
       WHERE source_key = ?
        AND (customer_id = ? OR login = ?)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [sourceKey, customerId, login || customerId]
    );
    return shouldRefreshPlayer360Source({
      ttlSeconds: policy.ttlSeconds,
      lastSuccessAt: row?.last_success_at || null,
      lastAttemptAt: row?.last_attempt_at || null,
      lastError: row?.last_error || null,
    });
  }

  private async markPlayerSourceAttempt(player: {
    customerId: string;
    login: string;
    agentId: string;
    agentLogin: string;
  }, sourceKey: string): Promise<void> {
    const policy = getPlayer360SourcePolicy(sourceKey);
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO player_source_status
        (provider, customer_id, login, agent_id, source_key, refresh_policy, ttl_seconds, scale_class,
         last_attempt_at, last_error, next_refresh_at, updated_at)
       VALUES ('buckeye', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT(provider, customer_id, source_key) DO UPDATE SET
        login = excluded.login,
        agent_id = excluded.agent_id,
        refresh_policy = excluded.refresh_policy,
        ttl_seconds = excluded.ttl_seconds,
        scale_class = excluded.scale_class,
        last_attempt_at = excluded.last_attempt_at,
        last_error = NULL,
        updated_at = excluded.updated_at`,
      [
        player.customerId,
        player.login || player.customerId,
        player.agentLogin || player.agentId,
        sourceKey,
        policy.refreshPolicy,
        policy.ttlSeconds,
        policy.scaleClass,
        now,
      ]
    );
  }

  private async markPlayerSourceSuccess(player: {
    customerId: string;
    login: string;
    agentId: string;
    agentLogin: string;
  }, sourceKey: string): Promise<void> {
    const policy = getPlayer360SourcePolicy(sourceKey);
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO player_source_status
        (provider, customer_id, login, agent_id, source_key, refresh_policy, ttl_seconds, scale_class,
         last_attempt_at, last_success_at, last_error, next_refresh_at, updated_at)
       VALUES ('buckeye', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(provider, customer_id, source_key) DO UPDATE SET
        login = excluded.login,
        agent_id = excluded.agent_id,
        refresh_policy = excluded.refresh_policy,
        ttl_seconds = excluded.ttl_seconds,
        scale_class = excluded.scale_class,
        last_attempt_at = COALESCE(player_source_status.last_attempt_at, excluded.last_attempt_at),
        last_success_at = excluded.last_success_at,
        last_error = NULL,
        next_refresh_at = excluded.next_refresh_at,
        updated_at = excluded.updated_at`,
      [
        player.customerId,
        player.login || player.customerId,
        player.agentLogin || player.agentId,
        sourceKey,
        policy.refreshPolicy,
        policy.ttlSeconds,
        policy.scaleClass,
        now,
        now,
        nextRefreshAt(now, policy.ttlSeconds),
      ]
    );
  }

  private async markPlayerSourceError(player: {
    customerId: string;
    login: string;
    agentId: string;
    agentLogin: string;
  }, sourceKey: string, error: unknown): Promise<void> {
    const policy = getPlayer360SourcePolicy(sourceKey);
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    await this.db.run(
      `INSERT INTO player_source_status
        (provider, customer_id, login, agent_id, source_key, refresh_policy, ttl_seconds, scale_class,
         last_attempt_at, last_error, next_refresh_at, updated_at)
       VALUES ('buckeye', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(provider, customer_id, source_key) DO UPDATE SET
        login = excluded.login,
        agent_id = excluded.agent_id,
        refresh_policy = excluded.refresh_policy,
        ttl_seconds = excluded.ttl_seconds,
        scale_class = excluded.scale_class,
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        next_refresh_at = excluded.next_refresh_at,
        updated_at = excluded.updated_at`,
      [
        player.customerId,
        player.login || player.customerId,
        player.agentLogin || player.agentId,
        sourceKey,
        policy.refreshPolicy,
        policy.ttlSeconds,
        policy.scaleClass,
        now,
        message,
        nextRefreshAt(now, Math.min(policy.ttlSeconds || 300, 15 * 60)),
      ]
    );
  }

  private async shouldCaptureCustomerSnapshot(customerId: string, login: string): Promise<boolean> {
    const row = await this.db.get<{ snapshot_time: string }>(
      `SELECT snapshot_time
       FROM customer_snapshots
       WHERE customer_id = ? OR login = ?
       ORDER BY snapshot_time DESC
       LIMIT 1`,
      [customerId, login || customerId]
    );
    if (!row?.snapshot_time) return true;
    const timestamp = Date.parse(row.snapshot_time);
    return !Number.isFinite(timestamp) || Date.now() - timestamp >= this.customerSnapshotTtlMs;
  }

  private async persistCustomerSnapshot(snapshot: BuckeyeCustomerSnapshot): Promise<void> {
    await this.db.run(
      `INSERT INTO customer_snapshots
        (provider, customer_id, login, agent_id, agent_login, kyc_level, vip_status, email_masked, phone_masked, currency, source, snapshot_time, raw_json)
       VALUES ('buckeye', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [
        snapshot.customerId,
        snapshot.login,
        snapshot.agentId,
        snapshot.agentLogin,
        snapshot.kycLevel,
        snapshot.vipStatus,
        snapshot.emailMasked,
        snapshot.phoneMasked,
        snapshot.currency,
        snapshot.source,
        JSON.stringify(snapshot.raw || {}),
      ]
    );
  }

  private async persistPlayerPerformanceSnapshot(
    report: BuckeyeAgentPerformanceResult,
    customerId: string,
    login: string
  ): Promise<number> {
    const pulledAt = report.fetchedAt || new Date().toISOString();
    const rows = report.parsed?.rows?.length
      ? report.parsed.rows
      : [{
        customerId,
        login: login || customerId,
        agentId: report.params.agentID,
        wagerCount: 0,
        risk: 0,
        toWin: 0,
        amountWon: 0,
        amountLost: 0,
        volume: 0,
        net: 0,
      }];
    const rawRows = getAgentPerformanceRawRows(report.data);
    let inserted = 0;

    for (const [index, row] of rows.entries()) {
      const result = await this.db.run(
        `INSERT INTO agent_performance_snapshots
          (provider, report_agent_id, customer_id, agent_id, login, report_type,
           start_date, end_date, sport, subsport, period, wager_type, bet_type,
           activity_tipo, free_play, wager_count, risk, to_win, amount_won,
           amount_lost, volume, net, pulled_at, raw_json)
         VALUES ('buckeye', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          report.params.agentID,
          row.customerId || customerId,
          row.agentId || report.params.agentID,
          row.login || login || customerId,
          report.params.operation,
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
          JSON.stringify(rawRows[index] || report.data || row),
        ]
      );
      inserted += result.changes > 0 ? 1 : 0;
    }

    await this.setWatermark(
      `last_player_performance.${report.params.agentID}.${customerId}`,
      JSON.stringify({
        acc: customerId,
        operation: report.params.operation,
        period: report.params.period,
        rows: rows.length,
        fetchedAt: pulledAt,
      })
    );
    return inserted;
  }

  private async refreshPlayerLinks(agentId: string): Promise<number> {
    const rows = await this.db.all<PlayerLinkRow>(
      `SELECT
        ip_address,
        GROUP_CONCAT(DISTINCT login_id) AS players,
        COUNT(DISTINCT login_id) AS playerCount,
        MAX(access_datetime) AS lastSeen
       FROM access_logs
       WHERE agent_id = ?
         AND ip_address IS NOT NULL
         AND ip_address <> ''
         AND access_datetime >= datetime('now', '-30 days')
       GROUP BY ip_address
       HAVING COUNT(DISTINCT login_id) > 1
       ORDER BY MAX(access_datetime) DESC
       LIMIT 100`,
      [agentId]
    );

    let inserted = 0;
    let pairBudget = 500;
    for (const row of rows) {
      const players = String(row.players || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .sort();
      for (let i = 0; i < players.length && pairBudget > 0; i += 1) {
        for (let j = i + 1; j < players.length && pairBudget > 0; j += 1) {
          const result = await this.db.run(
            `INSERT OR IGNORE INTO player_links
              (provider, player_a, player_b, reason, confidence, evidence_json, detected_at, status)
             VALUES ('buckeye', ?, ?, 'shared_ip', 0.85, ?, CURRENT_TIMESTAMP, 'active')`,
            [
              players[i],
              players[j],
              JSON.stringify({
                ip_address: row.ip_address,
                last_seen: row.lastSeen,
                window_days: 30,
              }),
            ]
          );
          inserted += result.changes > 0 ? 1 : 0;
          pairBudget -= 1;
        }
      }
    }
    return inserted;
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
   * Persist the raw agent performance report summary.
   */
  private async persistAgentPerformanceAnalytics(result: BuckeyeAgentPerformanceResult): Promise<void> {
    const { parsed } = result;
    const rows = parsed?.rows || [];

    // NOTE: Per-row performance data belongs in agent_performance_snapshots
    // (populated by persistAgentPerformanceReport), NOT in weekly_figures.
    // Weekly_figures is reserved for weekly figure summary data only.

    // Insert summary into agent_performance table
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

    // Geo-IP enrichment
    const geoPromises = rows.map(async (row) => {
      if (row.IPAddress) {
        const geo = await enrichIpGeo(row.IPAddress);
        if (geo) {
          row.geo = {
            country: geo.country,
            region: geo.region,
            city: geo.city,
            timezone: geo.timezone,
            lat: geo.ll[0],
            lon: geo.ll[1],
          };
        }
      }
    });
    await Promise.all(geoPromises);

    // Log raw web log response
    await this.rawApiLogger.log({
      endpoint: 'getWebLog',
      responseJson: JSON.stringify({ rowCount: rows.length, rows }),
      agentId,
      durationMs: Date.now() - end.getTime(),
    });

    const inserted = await this.patternService.persistAccessLogs(agentId, rows, 'A');
    await new IPTracker(this.db, this).processWebLogRows(agentId, rows, 'A');
    const patterns = await this.patternService.analyzeAccessLogs(agentId);
    const persisted = await this.patternService.persistPatterns(patterns);

    if (inserted > 0) {
      this.broadcast({
        type: 'access_log.new',
        payload: { agentId, count: inserted, timestamp: new Date().toISOString() },
      });
      await this.broadcastIpTrackerAlerts(agentId);
    }

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

  private async broadcastIpTrackerAlerts(agentId: string): Promise<void> {
    try {
      const events = await new IPTracker(this.db, this).collectAlertEvents(agentId);
      for (const event of events) {
        this.broadcast(event);
      }
    } catch (error) {
      logger.warn('IPTracker alert broadcast failed', error instanceof Error ? error.message : String(error));
    }
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

  /**
   * Feed a raw Buckeye wager into the plugin pipeline via TickerBuffer.
   * Queries enriched context (customer_features, ai_risk_flags, agent_actions)
   * and builds a PluginContext for the risk-sharp-detector and other plugins.
   */
  private async feedWagerToPlugins(wager: EnrichedWager): Promise<void> {
    const tickerBuffer = getGlobalTickerBuffer();
    if (!tickerBuffer) return;

    try {
      // Fetch enriched context for this customer
      const enriched = await this.db.get<{
        archetype: string;
        risk_tier: string;
        sharp_score: number;
        lifetime_wagers: number;
        avg_wager_size: number;
        win_rate: number;
        violation_count: number;
        flag_count: number;
        ai_risk_level: string | null;
        ai_suggested_action: string | null;
        rule_action: string | null;
      }>(
        `SELECT
           cf.archetype,
           cf.risk_tier,
           cf.sharp_score,
           cf.lifetime_wagers,
           cf.avg_wager_size,
           cf.win_rate,
           COALESCE(v.violation_count, 0) as violation_count,
           COALESCE(f.flag_count, 0) as flag_count,
           ai.risk_level as ai_risk_level,
           ai.suggested_action as ai_suggested_action,
           aa.action as rule_action
         FROM (SELECT ? AS customer_id) AS src
         LEFT JOIN customer_features cf ON cf.customer_id = src.customer_id
         LEFT JOIN (SELECT customer_id, COUNT(*) as violation_count FROM wager_violations GROUP BY customer_id) v ON v.customer_id = src.customer_id
         LEFT JOIN (SELECT customer_id, COUNT(*) as flag_count FROM player_flags GROUP BY customer_id) f ON f.customer_id = src.customer_id
         LEFT JOIN (
           SELECT customer_id, risk_level, suggested_action
           FROM ai_risk_flags
           WHERE id IN (SELECT MAX(id) FROM ai_risk_flags GROUP BY customer_id)
         ) ai ON ai.customer_id = src.customer_id
         LEFT JOIN (
           SELECT player_id, action
           FROM agent_actions
           WHERE id IN (SELECT MAX(id) FROM agent_actions GROUP BY player_id)
         ) aa ON aa.player_id = src.customer_id`,
        [wager.CustomerID]
      );

      const ctx: PluginContext = {
        wager_number: wager.WagerNumber,
        customer_id: wager.CustomerID,
        login: wager.Login,
        agent_login: wager.AgentLogin,
        amount_wagered: wager.AmountWagered,
        to_win_amount: wager.ToWinAmount,
        sport: this.parseSport(wager.ShortDesc),
        wager_type: wager.WagerType,
        insert_datetime: wager.InsertDateTime,
        parsed_price: null,
        parsed_side: null,
        parsed_market: null,
        archetype: enriched?.archetype ?? 'UNKNOWN',
        risk_tier: enriched?.risk_tier ?? 'GREEN',
        sharp_score: enriched?.sharp_score ?? 0,
        lifetime_wagers: enriched?.lifetime_wagers ?? 0,
        avg_wager_size: enriched?.avg_wager_size ?? 0,
        win_rate: enriched?.win_rate ?? 0,
        violation_count: enriched?.violation_count ?? 0,
        flag_count: enriched?.flag_count ?? 0,
        ai_risk_level: enriched?.ai_risk_level ?? null,
        ai_suggested_action: enriched?.ai_suggested_action ?? null,
        rule_action: enriched?.rule_action ?? null,
      };

      tickerBuffer.feed(ctx);
    } catch (err) {
      logger.warn(`[ScraperManager] feedWagerToPlugins failed for wager #${wager.WagerNumber}:`, err instanceof Error ? err.message : String(err));
    }
  }

  private async evaluateAgentRules(wager: EnrichedWager): Promise<void> {
    try {
      const clvResult = await computeCLV(this.db, wager);
      const ipStats = await this.getWagerIpStats(wager);
      const triggeredRules = await evaluateRules(this.db, wager, null, ipStats, clvResult);
      for (const rule of triggeredRules) {
        await takeAction(this.db, rule, wager, { clvResult, ipStats }, this.broadcast);
      }
    } catch (error) {
      logger.warn('RulesEngine evaluation failed', error instanceof Error ? error.message : String(error));
    }
  }

  private async getWagerIpStats(wager: EnrichedWager): Promise<Record<string, unknown>> {
    const row = await this.db.get<{ sharedIpCount: number | string; recentIpCount: number | string }>(
      `SELECT
         COUNT(DISTINCT other.login_id) AS sharedIpCount,
         COUNT(DISTINCT mine.ip_address) AS recentIpCount
       FROM access_logs mine
       LEFT JOIN access_logs other
         ON other.ip_address = mine.ip_address
        AND other.login_id <> mine.login_id
       WHERE mine.login_id = ?
         AND mine.access_datetime >= datetime('now', '-1 day')`,
      [wager.Login || wager.CustomerID]
    );
    return {
      sharedIpCount: Number(row?.sharedIpCount || 0),
      recentIpCount: Number(row?.recentIpCount || 0),
    };
  }

  private async refreshClosingLines(): Promise<void> {
    const result = await refreshRecentClosingLines(this.db);
    if (result.lines > 0) {
      this.broadcast({
        type: 'closing_lines.updated',
        timestamp: new Date().toISOString(),
        payload: result,
      });
    }
  }

  private parseSport(desc: string): string {
    if (!desc) return 'Other';
    desc = decodeEntities(desc);
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
    const decoded = decodeEntities(desc);
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
    const decoded = decodeEntities(desc);
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
    desc = decodeEntities(desc);
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
    desc = decodeEntities(desc);
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
    desc = decodeEntities(desc);
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
    desc = decodeEntities(desc);
    // Look for price before " - For Game" / "for Game" or at the very end
    const m = desc.match(/\s([+-]\d+(?:\.\d+)?)(?:\s+-\s+For|\s+for\s+Game|\s*$)/i);
    return m ? m[1] : '';
  }

  /**
   * Poll one agent's master account info and insert into master_snapshots table.
   * Runs every 30 minutes per active agent.
   */
  private async pollMasterSnapshot(agentId: string): Promise<void> {
    try {
      const instance = this.agents.get(agentId);
      if (!instance || !instance.api.isAuthenticated()) {
        logger.warn(`pollMasterSnapshot: Agent ${agentId} not active, skipping`);
        return;
      }

      const result = await instance.api.getAccountInfoOwner();
      const accountInfo = result.accountInfo || {};
      const parsed: ParsedBalanceSnapshot = result.parsed || {};

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
      logger.success(`Master snapshot inserted for ${agentId}`);
    } catch (err) {
      logger.error(`pollMasterSnapshot failed for ${agentId}`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Get the database instance.
   */
  getDatabase(): Database {
    return this.db;
  }
}
