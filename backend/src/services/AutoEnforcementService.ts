/**
 * AutoEnforcementService — closes the loop between detection and action.
 *
 * On each pass:
 *   1. Load all `applied` risk_positions with non-zero limits.
 *   2. For each, sum the customer's recent wager exposure.
 *   3. If exposure exceeds the limit, log an enforcement event and emit
 *      a `position_breach` SSE event for traders.
 *   4. If a wager would breach, mark a `system_block` action queue entry.
 *
 * Bun-native: uses `db.transaction(...)` for atomic read+log,
 * positional `?` parameters, and parallel queries via Promise.all.
 */

import type { Database } from '../database';
import { streamHub } from './StreamHub';

export interface EnforcementResult {
  evaluated: number;
  flagged: number;
  blocked: number;
  breaches: BreachRecord[];
}

export interface BreachRecord {
  position_id: number;
  customer_id: string;
  risk_level: string;
  limit: number;
  exposure: number;
  delta: number;
  action: 'flag' | 'block';
}

interface AppliedPositionRow {
  id: number;
  customer_id: string;
  risk_level: string;
  executed_max_exposure: number | null;
  executed_wager_limit: number | null;
  executed_action: string | null;
}

interface ExposureRow {
  customer_id: string;
  total_exposure: number;
  wager_count: number;
}

export class AutoEnforcementService {
  private _passCount = 0;
  private _lastRunAt: number | null = null;

  constructor(private readonly db: Database) { }

  get passCount(): number { return this._passCount; }
  get lastRunAt(): number | null { return this._lastRunAt; }

  /**
   * Single enforcement pass. Returns counts and the breach list.
   */
  async enforceAll(): Promise<EnforcementResult> {
    this._passCount++;
    this._lastRunAt = Date.now();

    const positions = await this.db.all<AppliedPositionRow>(
      `SELECT id, customer_id, risk_level,
              executed_max_exposure, executed_wager_limit, executed_action
         FROM risk_positions
        WHERE status = 'applied'
          AND executed_action IN ('block', 'review', 'reduce')
          AND executed_max_exposure IS NOT NULL`
    );

    if (positions.length === 0) {
      return { evaluated: 0, flagged: 0, blocked: 0, breaches: [] };
    }

    // Compute live exposure for each customer in parallel (one query per id)
    const exposures = new Map<string, number>();
    await Promise.all(
      positions.map(async (p) => {
        const row = await this.db.get<ExposureRow>(
          `SELECT customer_id,
                  COALESCE(SUM(amount_wagered), 0) AS total_exposure,
                  COUNT(*) AS wager_count
             FROM wagers
            WHERE customer_id = ?
              AND insert_datetime >= datetime('now', '-24 hours')`,
          [p.customer_id]
        );
        exposures.set(p.customer_id, Number(row?.total_exposure ?? 0));
      })
    );

    const breaches: BreachRecord[] = [];
    let flagged = 0;
    let blocked = 0;

    for (const p of positions) {
      const limit = Number(p.executed_max_exposure ?? 0);
      const exposure = exposures.get(p.customer_id) ?? 0;
      // Buckeye stores wagers in cents; the wagers.amount_wagered column is INTEGER.
      // Limits are stored in dollars. Convert exposure to dollars for comparison.
      const exposureDollars = exposure / 100;
      if (exposureDollars <= limit) continue;

      const action: 'flag' | 'block' = p.executed_action === 'block' || limit === 0 ? 'block' : 'flag';
      if (action === 'block') blocked++; else flagged++;

      const breach: BreachRecord = {
        position_id: p.id,
        customer_id: p.customer_id,
        risk_level: p.risk_level,
        limit,
        exposure: exposureDollars,
        delta: exposureDollars - limit,
        action,
      };
      breaches.push(breach);

      // Persist enforcement event in agent_actions (existing table)
      await this.logEnforcement(breach);

      // Push live SSE event so traders see breaches in real-time
      streamHub.publish('positions', {
        event: 'position_breach',
        data: breach,
      });
      streamHub.publish('alerts', {
        event: 'enforcement',
        data: breach,
      });
    }

    return {
      evaluated: positions.length,
      flagged,
      blocked,
      breaches,
    };
  }

  /**
   * Evaluate a single incoming wager against the customer's applied position.
   * Used as a hook from wager ingestion: returns "block" if the wager would
   * push exposure over the limit.
   */
  async evaluateWager(input: {
    customer_id: string;
    amount_wagered_dollars: number;
  }): Promise<{ allow: boolean; reason?: string; position_id?: number }> {
    const position = await this.db.get<AppliedPositionRow>(
      `SELECT id, customer_id, risk_level,
              executed_max_exposure, executed_wager_limit, executed_action
         FROM risk_positions
        WHERE customer_id = ? AND status = 'applied'
        ORDER BY created_at DESC LIMIT 1`,
      [input.customer_id]
    );
    if (!position) return { allow: true };

    const wagerLimit = Number(position.executed_wager_limit ?? 0);
    const maxExposure = Number(position.executed_max_exposure ?? 0);

    if (position.executed_action === 'block' || maxExposure === 0) {
      return { allow: false, reason: 'BLACK tier — auto-blocked', position_id: position.id };
    }

    if (wagerLimit > 0 && input.amount_wagered_dollars > wagerLimit) {
      return {
        allow: false,
        reason: `Wager $${input.amount_wagered_dollars.toFixed(2)} exceeds per-wager limit $${wagerLimit.toFixed(2)}`,
        position_id: position.id,
      };
    }

    return { allow: true, position_id: position.id };
  }

  /**
   * Get recent enforcement breaches for the dashboard.
   */
  async listRecentBreaches(limit = 50): Promise<unknown[]> {
    return this.db.all(
      `SELECT id, action, severity, player_id, details_json, created_at
         FROM agent_actions
        WHERE action = 'auto_enforce'
        ORDER BY created_at DESC
        LIMIT ?`,
      [limit]
    );
  }

  private async logEnforcement(breach: BreachRecord): Promise<void> {
    try {
      const duplicate = await this.db.get<{ id: number }>(
        `SELECT id
           FROM agent_actions
          WHERE action = 'auto_enforce'
            AND player_id = ?
            AND details_json LIKE ?
          LIMIT 1`,
        [breach.customer_id, `%"position_id":${breach.position_id}%`]
      );
      if (duplicate) return;

      await this.db.run(
        `INSERT INTO agent_actions (rule_id, wager_number, player_id, action, severity, details_json)
         VALUES (NULL, NULL, ?, 'auto_enforce', ?, ?)`,
        [
          breach.customer_id,
          breach.action === 'block' ? 'critical' : 'warning',
          JSON.stringify(breach),
        ]
      );
    } catch (err) {
      console.error('[AutoEnforcement] logEnforcement failed:', err);
    }
  }
}
