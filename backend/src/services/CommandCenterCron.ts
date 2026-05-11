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
import { LiveFeatureService } from './LiveFeatureService';
import { PositionService } from './PositionService';
import { streamHub } from './StreamHub';

export interface CommandCenterCronOptions {
  featureCandidateMs?: number;
  featureExtractMs?: number;
  portfolioRefreshMs?: number;
  heartbeatMs?: number;
  emitTicker?: boolean;
}

export class CommandCenterCron {
  private tasks: ManagedIntervalTask[] = [];
  private readonly positionService: PositionService;
  private readonly enforcement: AutoEnforcementService;
  private readonly liveFeatures: LiveFeatureService;

  constructor(private readonly db: Database, private readonly opts: CommandCenterCronOptions = {}) {
    this.positionService = new PositionService(db);
    this.enforcement = new AutoEnforcementService(db);
    this.liveFeatures = new LiveFeatureService(db);
  }

  start(): void {
    this.stop();

    const featureCandidateMs = this.opts.featureCandidateMs ?? COMMAND_CENTER_MAP.schedules.featureCandidateMs;
    const featureExtractMs = this.opts.featureExtractMs ?? COMMAND_CENTER_MAP.schedules.featureExtractMs;
    const portfolioRefreshMs = this.opts.portfolioRefreshMs ?? COMMAND_CENTER_MAP.schedules.portfolioRefreshMs;
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
      'command-center.portfolio-refresh',
      portfolioRefreshMs,
      async () => {
        const [expired, enforcement] = await Promise.all([
          this.positionService.expirePendingPositions(),
          this.enforcement.enforceAll(),
        ]);
        streamHub.publish('positions', {
          event: COMMAND_CENTER_MAP.sse.events.position,
          data: {
            type: 'portfolio_refresh',
            expired,
            enforcement,
            at: Date.now(),
          },
        });
      },
      { initialDelayMs: portfolioRefreshMs, onError: logSchedulerError('portfolio-refresh') }
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
      `[${COMMAND_CENTER_MAP.logEvents.cronStarted}] featureCandidates=${featureCandidateMs}ms features=${featureExtractMs}ms portfolio=${portfolioRefreshMs}ms heartbeat=${heartbeatMs}ms`
    );
  }

  stop(): void {
    for (const task of this.tasks) {
      try { task.stop(); } catch { /* ignore */ }
    }
    this.tasks = [];
  }
}

function logSchedulerError(name: string): (error: unknown) => void {
  return (error: unknown) => {
    console.warn(`[CommandCenterCron] ${name} failed:`, error instanceof Error ? error.message : error);
  };
}
