/**
 * CommandCenterCron — recurring background jobs for the Risk Command Center.
 *
 * This intentionally uses the repo's managed scheduler instead of Bun.cron:
 * createManagedInterval runs tasks without overlap and keeps shutdown simple.
 */
import type { Database } from '../database';
import { COMMAND_CENTER_MAP } from '../config/commandCenterMap';
import { createManagedInterval, type ManagedIntervalTask } from './Scheduler';
import { AutoEnforcementService } from './AutoEnforcementService';
import { EnforcementQueueService } from './EnforcementQueueService';
import { LiveFeatureService } from './LiveFeatureService';
import { PositionService } from './PositionService';
import { RiskAlertService } from './RiskAlertService';
import { RiskCommandCenter } from './RiskCommandCenter';
import { streamHub } from './StreamHub';

export interface CommandCenterCronOptions {
  featureCandidateMs?: number;
  featureExtractMs?: number;
  positionExpiryMs?: number;
  portfolioRefreshMs?: number;
  alertCleanupMs?: number;
  heartbeatMs?: number;
  emitTicker?: boolean;
}

export class CommandCenterCron {
  private tasks: ManagedIntervalTask[] = [];
  private readonly positionService: PositionService;
  private readonly enforcement: AutoEnforcementService;
  private readonly enforcementQueue: EnforcementQueueService;
  private readonly liveFeatures: LiveFeatureService;
  private readonly riskAlerts: RiskAlertService;
  private readonly rcc: RiskCommandCenter;

  constructor(private readonly db: Database, private readonly opts: CommandCenterCronOptions = {}) {
    this.positionService = new PositionService(db);
    this.enforcement = new AutoEnforcementService(db);
    this.enforcementQueue = new EnforcementQueueService(db);
    this.liveFeatures = new LiveFeatureService(db);
    this.riskAlerts = new RiskAlertService(db);
    this.rcc = new RiskCommandCenter(db);
  }

  start(): void {
    this.stop();

    const featureCandidateMs = this.opts.featureCandidateMs ?? COMMAND_CENTER_MAP.schedules.featureCandidateMs;
    const featureExtractMs = this.opts.featureExtractMs ?? COMMAND_CENTER_MAP.schedules.featureExtractMs;
    const positionExpiryMs = this.opts.positionExpiryMs ?? COMMAND_CENTER_MAP.schedules.positionExpiryMs;
    const portfolioRefreshMs = this.opts.portfolioRefreshMs ?? COMMAND_CENTER_MAP.schedules.portfolioRefreshMs;
    const alertCleanupMs = this.opts.alertCleanupMs ?? COMMAND_CENTER_MAP.schedules.alertCleanupMs;
    const heartbeatMs = this.opts.heartbeatMs ?? COMMAND_CENTER_MAP.schedules.heartbeatMs;

    this.tasks.push(createManagedInterval(
      'command-center.feature-candidates',
      featureCandidateMs,
      async () => {
        const result = await this.liveFeatures.extractRecentFeatures(1);
        if (result.processed > 0) {
          streamHub.publish('ticker', {
            event: COMMAND_CENTER_MAP.sse.events.featureRefresh,
            data: { type: 'recent', processed: result.processed, at: Date.now() },
          });
        }
      },
      { initialDelayMs: featureCandidateMs, onError: logSchedulerError('feature-candidates') }
    ));

    this.tasks.push(createManagedInterval(
      'command-center.feature-extract',
      featureExtractMs,
      async () => {
        const result = await this.liveFeatures.refreshStaleFeatures(6);
        if (result.processed > 0) {
          streamHub.publish('ticker', {
            event: COMMAND_CENTER_MAP.sse.events.featureRefresh,
            data: { type: 'stale', processed: result.processed, at: Date.now() },
          });
        }
      },
      { initialDelayMs: featureExtractMs, onError: logSchedulerError('feature-extract') }
    ));

    this.tasks.push(createManagedInterval(
      'command-center.position-expiry',
      positionExpiryMs,
      async () => {
        const expired = await this.rcc.expireStalePositions();
        const expiredQueue = await this.enforcementQueue.expirePending();
        const reminders = await this.enforcementQueue.sendUrgentReminders();
        if (expired > 0 || expiredQueue > 0 || reminders > 0) {
          console.log(`[${COMMAND_CENTER_MAP.logEvents.positionExpiry}] expired=${expired} queueExpired=${expiredQueue} reminders=${reminders}`);
          streamHub.publish('positions', {
            event: COMMAND_CENTER_MAP.sse.events.position,
            data: { type: 'position_expiry', expired, queue_expired: expiredQueue, reminders, at: Date.now() },
          });
        }
      },
      { initialDelayMs: positionExpiryMs, onError: logSchedulerError('position-expiry') }
    ));

    this.tasks.push(createManagedInterval(
      'command-center.portfolio-refresh',
      portfolioRefreshMs,
      async () => {
        const enforcement = await this.enforcement.enforceAll();
        streamHub.publish('positions', {
          event: COMMAND_CENTER_MAP.sse.events.position,
          data: { type: 'portfolio_refresh', enforcement, at: Date.now() },
        });
      },
      { initialDelayMs: portfolioRefreshMs, onError: logSchedulerError('portfolio-refresh') }
    ));

    this.tasks.push(createManagedInterval(
      'command-center.alert-cleanup',
      alertCleanupMs,
      async () => {
        const deleted = await this.riskAlerts.cleanupOldAlerts(COMMAND_CENTER_MAP.schedules.alertRetentionDays);
        if (deleted > 0) {
          console.log(`[${COMMAND_CENTER_MAP.logEvents.alertCleanup}] deleted=${deleted}`);
        }
      },
      { initialDelayMs: alertCleanupMs, onError: logSchedulerError('alert-cleanup') }
    ));

    this.tasks.push(createManagedInterval(
      'command-center.violation-dedup',
      5 * 60_000,
      async () => {
        const result = await this.db.run(
          `DELETE FROM wager_violations
            WHERE rowid NOT IN (
              SELECT MIN(rowid)
                FROM wager_violations
               GROUP BY wager_id, violation_type
            )`
        );
        if (result.changes > 0) {
          console.log(`[command-center.violation-dedup] removed ${result.changes} duplicate violations`);
        }
      },
      { initialDelayMs: 60_000, onError: logSchedulerError('violation-dedup') }
    ));

    if (heartbeatMs > 0 && this.opts.emitTicker !== false) {
      this.tasks.push(createManagedInterval(
        'command-center.heartbeat',
        heartbeatMs,
        () => {
          streamHub.heartbeat({
            enforcement_passes: this.enforcement.passCount,
            last_enforcement_at: this.enforcement.lastRunAt,
          });
        },
        { initialDelayMs: heartbeatMs, onError: logSchedulerError('heartbeat') }
      ));
    }

    console.log(
      `[${COMMAND_CENTER_MAP.logEvents.cronStarted}] featureCandidates=${featureCandidateMs}ms features=${featureExtractMs}ms positionExpiry=${positionExpiryMs}ms portfolio=${portfolioRefreshMs}ms alertCleanup=${alertCleanupMs}ms heartbeat=${heartbeatMs}ms`
    );
  }

  stop(): void {
    for (const task of this.tasks) {
      try { task.stop(); } catch { /* ignore */ }
    }
    this.tasks = [];
  }
}

export function initRiskCommandCenterCron(
  db: Database,
  opts: CommandCenterCronOptions = {}
): CommandCenterCron {
  const cron = new CommandCenterCron(db, opts);
  cron.start();
  return cron;
}

function logSchedulerError(name: string): (error: unknown) => void {
  return (error: unknown) => {
    console.warn(`[CommandCenterCron] ${name} failed:`, error instanceof Error ? error.message : error);
  };
}
