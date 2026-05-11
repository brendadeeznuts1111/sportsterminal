/**
 * EnforcementQueueService
 * Tracks manual Buckeye-side enforcement work while upstream write endpoints
 * remain unverified. Positions can be applied locally, but this queue preserves
 * trader accountability for the real sportsbook admin action.
 */

import type { Database } from '../database';
import { COMMAND_CENTER_MAP } from '../config/commandCenterMap';
import { RiskAlertService } from './RiskAlertService';
import { streamHub } from './StreamHub';

export interface EnforcementQueueItem {
  id: number;
  position_id: number;
  customer_id: string;
  risk_level: string;
  suggested_max_exposure: number | null;
  suggested_wager_limit: number | null;
  suggested_action: string | null;
  ai_confidence: number | null;
  ai_summary: string | null;
  status: string;
  viewed_at: string | null;
  viewed_by: string | null;
  applied_at: string | null;
  applied_by: string | null;
  buckeye_admin_url: string | null;
  reminder_count: number;
  last_reminder_at: string | null;
  created_at: string;
  expires_at: string | null;
  executed_action?: string | null;
  execution_note?: string | null;
}

export interface QueueFilters {
  status?: string;
  risk_level?: string;
  limit?: number;
  offset?: number;
}

interface PositionForQueue {
  id: number;
  customer_id: string;
  risk_level: string;
  suggested_max_exposure: number | null;
  suggested_wager_limit: number | null;
  suggested_action: string | null;
  ai_confidence: number | null;
  ai_summary: string | null;
}

const QUEUEABLE_RISK_LEVELS = new Set(['BLACK', 'RED', 'YELLOW']);

export class EnforcementQueueService {
  constructor(private readonly db: Database) { }

  async enqueuePosition(positionId: number): Promise<{ queued: boolean; id?: number }> {
    const position = await this.db.get<PositionForQueue>(
      `SELECT id, customer_id, risk_level, suggested_max_exposure, suggested_wager_limit,
              suggested_action, ai_confidence, ai_summary
         FROM risk_positions
        WHERE id = ?`,
      [positionId]
    );

    if (!position || !QUEUEABLE_RISK_LEVELS.has(position.risk_level)) {
      return { queued: false };
    }

    const result = await this.db.run(
      `INSERT OR IGNORE INTO enforcement_queue (
         position_id, customer_id, risk_level, suggested_max_exposure,
         suggested_wager_limit, suggested_action, ai_confidence, ai_summary,
         buckeye_admin_url
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        position.id,
        position.customer_id,
        position.risk_level,
        position.suggested_max_exposure,
        position.suggested_wager_limit,
        position.suggested_action,
        position.ai_confidence,
        position.ai_summary,
        buildBuckeyeAdminUrl(position.customer_id),
      ]
    );

    if (result.changes === 0) {
      const existing = await this.db.get<{ id: number }>(
        `SELECT id FROM enforcement_queue WHERE position_id = ?`,
        [position.id]
      );
      return { queued: false, id: existing?.id };
    }

    const queueId = result.lastID;
    streamHub.publish('positions', {
      event: COMMAND_CENTER_MAP.sse.events.position,
      data: {
        type: 'manual_enforcement_queued',
        queue_id: queueId,
        position_id: position.id,
        customer_id: position.customer_id,
        risk_level: position.risk_level,
        at: Date.now(),
      },
    });

    return { queued: true, id: queueId };
  }

  async list(filters: QueueFilters = {}): Promise<{ count: number; total: number; queue: EnforcementQueueItem[] }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status) {
      conditions.push('eq.status = ?');
      params.push(filters.status);
    }
    if (filters.risk_level) {
      conditions.push('eq.risk_level = ?');
      params.push(filters.risk_level.toUpperCase());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit || 50, 1), 200);
    const offset = Math.min(Math.max(filters.offset || 0, 0), 10_000);

    const [queue, countRow] = await Promise.all([
      this.db.all<EnforcementQueueItem>(
        `SELECT eq.*, rp.executed_action, rp.execution_note
           FROM enforcement_queue eq
           LEFT JOIN risk_positions rp ON rp.id = eq.position_id
          ${where}
          ORDER BY
            CASE eq.risk_level WHEN 'BLACK' THEN 1 WHEN 'RED' THEN 2 WHEN 'YELLOW' THEN 3 ELSE 4 END,
            eq.created_at DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ),
      this.db.get<{ total: number }>(
        `SELECT COUNT(*) AS total FROM enforcement_queue eq ${where}`,
        params
      ),
    ]);

    return { count: queue.length, total: countRow?.total ?? 0, queue };
  }

  async markViewed(id: number, traderName = 'trader'): Promise<{ ok: boolean }> {
    const result = await this.db.run(
      `UPDATE enforcement_queue
          SET status = 'viewed', viewed_at = datetime('now'), viewed_by = ?
        WHERE id = ? AND status = 'pending'`,
      [traderName, id]
    );
    return { ok: result.changes > 0 };
  }

  async markApplied(input: {
    id: number;
    traderName?: string;
    actualMaxExposure?: number;
    actualWagerLimit?: number;
    note?: string;
  }): Promise<{ ok: boolean }> {
    const item = await this.db.get<EnforcementQueueItem>(
      `SELECT * FROM enforcement_queue WHERE id = ?`,
      [input.id]
    );
    if (!item) return { ok: false };

    const trader = input.traderName || 'trader';
    const maxExposure = input.actualMaxExposure ?? item.suggested_max_exposure;
    const wagerLimit = input.actualWagerLimit ?? item.suggested_wager_limit;

    await this.db.run(
      `UPDATE enforcement_queue
          SET status = 'applied', applied_at = datetime('now'), applied_by = ?
        WHERE id = ?`,
      [trader, input.id]
    );

    await this.db.run(
      `UPDATE risk_positions
          SET status = 'applied',
              executed_by = ?,
              executed_at = datetime('now'),
              executed_max_exposure = ?,
              executed_wager_limit = ?,
              executed_action = COALESCE(suggested_action, 'review'),
              execution_note = ?
        WHERE id = ?`,
      [
        trader,
        maxExposure,
        wagerLimit,
        input.note || 'Manual Buckeye enforcement marked applied locally',
        item.position_id,
      ]
    );

    streamHub.publish('positions', {
      event: COMMAND_CENTER_MAP.sse.events.position,
      data: {
        type: 'manual_enforcement_applied',
        queue_id: input.id,
        position_id: item.position_id,
        customer_id: item.customer_id,
        risk_level: item.risk_level,
        at: Date.now(),
      },
    });

    return { ok: true };
  }

  async escalate(id: number, traderName = 'trader', note = 'Escalated from enforcement queue'): Promise<{ ok: boolean }> {
    const result = await this.db.run(
      `UPDATE enforcement_queue
          SET status = 'escalated',
              viewed_at = COALESCE(viewed_at, datetime('now')),
              viewed_by = COALESCE(viewed_by, ?)
        WHERE id = ? AND status IN ('pending', 'viewed')`,
      [traderName, id]
    );
    if (result.changes > 0) {
      await this.db.run(
        `UPDATE risk_positions
            SET execution_note = ?
          WHERE id = (SELECT position_id FROM enforcement_queue WHERE id = ?)`,
        [note, id]
      );
    }
    return { ok: result.changes > 0 };
  }

  async expirePending(): Promise<number> {
    const result = await this.db.run(
      `UPDATE enforcement_queue
          SET status = 'expired'
        WHERE status = 'pending'
          AND expires_at IS NOT NULL
          AND expires_at <= datetime('now')`
    );
    return result.changes;
  }

  async sendUrgentReminders(): Promise<number> {
    const urgent = await this.db.all<EnforcementQueueItem>(
      `SELECT *
         FROM enforcement_queue
        WHERE status = 'pending'
          AND risk_level = 'BLACK'
          AND (viewed_at IS NULL OR viewed_at < datetime('now', '-5 minutes'))
          AND reminder_count < 3
          AND (last_reminder_at IS NULL OR last_reminder_at < datetime('now', '-5 minutes'))`
    );

    if (urgent.length === 0) return 0;

    const alerts = new RiskAlertService(this.db);
    for (const item of urgent) {
      await alerts.sendAlerts({
        customer_id: item.customer_id,
        risk_level: item.risk_level,
        confidence: item.ai_confidence ?? 0.95,
        summary: `UNENFORCED BLACK position pending manual Buckeye action. Suggested wager limit $${Number(item.suggested_wager_limit || 0).toFixed(2)}.`,
        suggested_action: item.suggested_action || 'block',
      });
      await this.db.run(
        `UPDATE enforcement_queue
            SET reminder_count = reminder_count + 1,
                last_reminder_at = datetime('now')
          WHERE id = ?`,
        [item.id]
      );
    }

    return urgent.length;
  }
}

function buildBuckeyeAdminUrl(customerId: string): string {
  const configured = (Bun.env.BUCKEYE_ADMIN_PLAYER_URL || '').trim();
  if (configured) {
    return configured.replace('{customer_id}', encodeURIComponent(customerId));
  }
  const base = (Bun.env.BUCKEYE_ADMIN_BASE_URL || 'https://fantasy402.com').replace(/\/+$/, '');
  return `${base}/manager.html?player=${encodeURIComponent(customerId)}&tab=limits`;
}
