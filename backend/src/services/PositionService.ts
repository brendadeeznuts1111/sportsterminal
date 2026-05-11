/**
 * PositionService
 * Manages risk position lifecycle: generation from AI analysis,
 * trader execution, override, and expiration.
 */

import type { Database } from '../database';
import { streamHub } from './StreamHub';

// ─── Types ───────────────────────────────────────────────────────────

export interface PositionLimits {
  maxExposure: number;
  wagerLimit: number;
  action: 'none' | 'reduce' | 'review' | 'block';
}

export interface RiskPosition {
  id: number;
  customer_id: string;
  scenario_id: number | null;
  risk_level: string;
  suggested_max_exposure: number | null;
  suggested_wager_limit: number | null;
  suggested_action: string | null;
  ai_confidence: number | null;
  ai_summary: string | null;
  executed_max_exposure: number | null;
  executed_wager_limit: number | null;
  executed_action: string | null;
  executed_by: string | null;
  executed_at: string | null;
  execution_note: string | null;
  status: string;
  expires_at: string | null;
  created_at: string;
}

export interface GeneratePositionInput {
  customer_id: string;
  analysis_id?: number;
}

export interface ExecutePositionInput {
  position_id: number;
  action: string;
  max_exposure?: number;
  wager_limit?: number;
  note?: string;
  trader_name?: string;
}

export interface OverridePositionInput {
  position_id: number;
  reason: string;
  trader_name?: string;
}

interface PositionRow {
  id: number;
  customer_id: string;
  scenario_id: number | null;
  risk_level: string;
  suggested_max_exposure: number | null;
  suggested_wager_limit: number | null;
  suggested_action: string | null;
  ai_confidence: number | null;
  ai_summary: string | null;
  executed_max_exposure: number | null;
  executed_wager_limit: number | null;
  executed_action: string | null;
  executed_by: string | null;
  executed_at: string | null;
  execution_note: string | null;
  status: string;
  expires_at: string | null;
  created_at: string;
}

// ─── Constants ───────────────────────────────────────────────────────

const POSITION_TTL_HOURS = 24;

// ─── Service ─────────────────────────────────────────────────────────

export class PositionService {
  constructor(private readonly db: Database) { }

  /**
   * Generate a position suggestion from the latest AI risk flag for a customer.
   * Auto-applies for BLACK tier (immediate block).
   */
  async generatePosition(input: GeneratePositionInput): Promise<{
    position_id: number;
    suggested: PositionLimits;
    auto_applied: boolean;
  }> {
    // Fetch the latest AI analysis for this customer
    const analysis = await this.db.get<{
      risk_level: string | null;
      confidence: number | null;
      summary: string | null;
      max_exposure: number | null;
    }>(
      `SELECT risk_level, confidence, summary, max_exposure
       FROM ai_risk_flags
       WHERE customer_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      [input.customer_id]
    );

    if (!analysis) {
      throw new Error('No AI analysis found for customer');
    }

    const riskLevel = analysis.risk_level || 'GREEN';
    const confidence = analysis.confidence ?? 0;
    const summary = analysis.summary || '';
    const aiMaxExposure = analysis.max_exposure ?? 0;

    const limits = riskLevelToLimits(riskLevel, aiMaxExposure);

    const result = await this.db.run(
      `INSERT INTO risk_positions (
        customer_id, risk_level, suggested_max_exposure, suggested_wager_limit,
        suggested_action, ai_confidence, ai_summary, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+${POSITION_TTL_HOURS} hours'))`,
      [
        input.customer_id,
        riskLevel,
        limits.maxExposure,
        limits.wagerLimit,
        limits.action,
        confidence,
        summary,
      ]
    );

    const positionId = result.lastID;
    let autoApplied = false;

    // Auto-apply for BLACK tier — no trader review needed
    if (riskLevel === 'BLACK') {
      await this.db.run(
        `UPDATE risk_positions SET
          status = 'applied',
          executed_max_exposure = 0,
          executed_wager_limit = 0,
          executed_action = 'block',
          executed_by = 'system_auto',
          executed_at = datetime('now'),
          execution_note = 'Auto-applied: BLACK tier triggers immediate block'
        WHERE id = ?`,
        [positionId]
      );
      autoApplied = true;
    }

    streamHub.publish('positions', {
      event: autoApplied ? 'position_auto_blocked' : 'position_generated',
      data: {
        position_id: positionId,
        customer_id: input.customer_id,
        risk_level: riskLevel,
        suggested: limits,
        auto_applied: autoApplied,
      },
    });

    return { position_id: positionId, suggested: limits, auto_applied: autoApplied };
  }

  /**
   * Execute (apply) a pending position with trader decisions.
   */
  async executePosition(input: ExecutePositionInput): Promise<{ ok: boolean; applied: boolean }> {
    const position = await this.db.get<PositionRow>(
      'SELECT * FROM risk_positions WHERE id = ? AND status = ?',
      [input.position_id, 'pending']
    );

    if (!position) {
      throw new Error('Position not found or not pending');
    }

    await this.db.run(
      `UPDATE risk_positions SET
        status = 'applied',
        executed_action = ?,
        executed_max_exposure = ?,
        executed_wager_limit = ?,
        executed_by = ?,
        executed_at = datetime('now'),
        execution_note = ?
      WHERE id = ?`,
      [
        input.action,
        input.max_exposure ?? position.suggested_max_exposure,
        input.wager_limit ?? position.suggested_wager_limit,
        input.trader_name || 'trader',
        input.note || '',
        input.position_id,
      ]
    );

    streamHub.publish('positions', {
      event: 'position_applied',
      data: {
        position_id: input.position_id,
        customer_id: position.customer_id,
        action: input.action,
        trader: input.trader_name || 'trader',
      },
    });

    return { ok: true, applied: true };
  }

  /**
   * Override a position — trader disagrees with AI suggestion.
   */
  async overridePosition(input: OverridePositionInput): Promise<{ ok: boolean; overridden: boolean }> {
    const position = await this.db.get<PositionRow>(
      'SELECT * FROM risk_positions WHERE id = ? AND status IN (?, ?)',
      [input.position_id, 'pending', 'applied']
    );

    if (!position) {
      throw new Error('Position not found or not actionable');
    }

    await this.db.run(
      `UPDATE risk_positions SET
        status = 'overridden',
        executed_by = ?,
        executed_at = datetime('now'),
        execution_note = ?
      WHERE id = ?`,
      [input.trader_name || 'trader', input.reason, input.position_id]
    );

    streamHub.publish('positions', {
      event: 'position_overridden',
      data: {
        position_id: input.position_id,
        customer_id: position.customer_id,
        reason: input.reason,
        trader: input.trader_name || 'trader',
      },
    });

    return { ok: true, overridden: true };
  }

  /**
   * Get the latest active position for a customer.
   */
  async getLatestPosition(customerId: string): Promise<RiskPosition | null> {
    const row = await this.db.get<PositionRow>(
      `SELECT * FROM risk_positions
       WHERE customer_id = ? AND status IN ('pending', 'applied')
       ORDER BY created_at DESC LIMIT 1`,
      [customerId]
    );
    return row ? this.rowToPosition(row) : null;
  }

  /**
   * List positions with optional filters.
   */
  async listPositions(filters: {
    customer_id?: string;
    status?: string;
    risk_level?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ positions: RiskPosition[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.customer_id) {
      conditions.push('customer_id = ?');
      params.push(filters.customer_id);
    }
    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.risk_level) {
      conditions.push('risk_level = ?');
      params.push(filters.risk_level);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit || 50, 200);
    const offset = filters.offset || 0;

    const [positions, countResult] = await Promise.all([
      this.db.all<PositionRow>(
        `SELECT * FROM risk_positions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ),
      this.db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM risk_positions ${where}`,
        params
      ),
    ]);

    return {
      positions: positions.map((r) => this.rowToPosition(r)),
      total: countResult?.count ?? 0,
    };
  }

  /**
   * Get a single position by ID.
   */
  async getPositionById(id: number): Promise<RiskPosition | null> {
    const row = await this.db.get<PositionRow>('SELECT * FROM risk_positions WHERE id = ?', [id]);
    return row ? this.rowToPosition(row) : null;
  }

  /**
   * Expire old pending positions (call from scheduler).
   */
  async expirePendingPositions(): Promise<number> {
    const result = await this.db.run(
      `UPDATE risk_positions SET status = 'expired'
       WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')`
    );
    return result.changes;
  }

  /**
   * Get position statistics for the dashboard.
   */
  async getPositionStats(): Promise<{
    total: number;
    pending: number;
    applied: number;
    overridden: number;
    expired: number;
    auto_blocked: number;
  }> {
    const rows = await this.db.all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count FROM risk_positions GROUP BY status`
    );

    const stats = { total: 0, pending: 0, applied: 0, overridden: 0, expired: 0, auto_blocked: 0 };
    for (const row of rows) {
      stats.total += row.count;
      if (row.status in stats) {
        (stats as Record<string, number>)[row.status] = row.count;
      }
    }

    // Count auto-blocked (applied by system_auto)
    const autoResult = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM risk_positions WHERE executed_by = 'system_auto'`
    );
    stats.auto_blocked = autoResult?.count ?? 0;

    return stats;
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private rowToPosition(row: PositionRow): RiskPosition {
    return {
      id: row.id,
      customer_id: row.customer_id,
      scenario_id: row.scenario_id,
      risk_level: row.risk_level,
      suggested_max_exposure: row.suggested_max_exposure,
      suggested_wager_limit: row.suggested_wager_limit,
      suggested_action: row.suggested_action,
      ai_confidence: row.ai_confidence,
      ai_summary: row.ai_summary,
      executed_max_exposure: row.executed_max_exposure,
      executed_wager_limit: row.executed_wager_limit,
      executed_action: row.executed_action,
      executed_by: row.executed_by,
      executed_at: row.executed_at,
      execution_note: row.execution_note,
      status: row.status,
      expires_at: row.expires_at,
      created_at: row.created_at,
    };
  }
}

// ─── Pure Functions ───────────────────────────────────────────────────

/**
 * Convert a risk level to suggested position limits.
 */
export function riskLevelToLimits(
  riskLevel: string,
  aiMaxExposure: number = 0
): PositionLimits {
  switch (riskLevel) {
    case 'BLACK':
      return { maxExposure: 0, wagerLimit: 0, action: 'block' };
    case 'RED':
      return {
        maxExposure: aiMaxExposure || 500,
        wagerLimit: aiMaxExposure ? aiMaxExposure * 0.5 : 250,
        action: 'review',
      };
    case 'YELLOW':
      return {
        maxExposure: aiMaxExposure || 2000,
        wagerLimit: aiMaxExposure ? aiMaxExposure * 0.3 : 600,
        action: 'reduce',
      };
    default:
      return {
        maxExposure: aiMaxExposure || 10000,
        wagerLimit: aiMaxExposure ? aiMaxExposure * 0.5 : 5000,
        action: 'none',
      };
  }
}
