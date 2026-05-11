/**
 * CommandCenterDashboard — read-only aggregates for the trader command center.
 *
 * Heavy lift is done in SQLite via grouped aggregates. Each method maps to one
 * SQL query and returns a typed DTO. No transformation in JS beyond row → object.
 */

import type { Database } from '../database';

// ─── DTOs ────────────────────────────────────────────────────────────

export interface ExposureBucket {
  bucket: string;
  exposure: number;
  wager_count: number;
}

export interface BookExposureRow {
  agent_login: string;
  total_volume: number;
  total_risk: number;
  wager_count: number;
  unique_players: number;
}

export interface SharpAlertRow {
  customer_id: string;
  agent_login: string;
  total_volume: number;
  win_rate: number;
  flag_count: number;
  last_flagged_at: string | null;
  risk_level: string | null;
}

export interface PendingActionRow {
  id: number;
  customer_id: string;
  risk_level: string;
  suggested_action: string;
  suggested_max_exposure: number;
  ai_confidence: number;
  created_at: string;
  expires_at: string | null;
}

export interface PnlPoint {
  day: string;
  volume: number;
  risk: number;
  to_win: number;
  wager_count: number;
  net: number;
}

// ─── Service ─────────────────────────────────────────────────────────

export class CommandCenterDashboard {
  constructor(private readonly db: Database) { }

  /**
   * Summary counters for the top-of-dashboard cards.
   */
  async getSummary(): Promise<{
    open_positions: number;
    pending_review: number;
    auto_blocks_24h: number;
    breaches_24h: number;
    sse_subscribers?: number;
  }> {
    const [openRow, pendingRow, autoRow, breachesRow] = await Promise.all([
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM risk_positions WHERE status = 'applied'`
      ),
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM risk_positions WHERE status = 'pending'`
      ),
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM risk_positions
          WHERE status = 'applied'
            AND executed_by = 'system_auto'
            AND executed_at >= datetime('now', '-24 hours')`
      ),
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM agent_actions
          WHERE action = 'auto_enforce'
            AND created_at >= datetime('now', '-24 hours')`
      ),
    ]);

    return {
      open_positions: openRow?.n ?? 0,
      pending_review: pendingRow?.n ?? 0,
      auto_blocks_24h: autoRow?.n ?? 0,
      breaches_24h: breachesRow?.n ?? 0,
    };
  }

  /**
   * Book-level exposure heatmap (group by agent_login).
   */
  async getBookExposure(hours = 24, limit = 50): Promise<BookExposureRow[]> {
    return this.db.all<BookExposureRow>(
      `SELECT
         agent_login,
         COALESCE(SUM(volume_amount), 0) / 100.0 AS total_volume,
         COALESCE(SUM(amount_wagered), 0) / 100.0 AS total_risk,
         COUNT(*) AS wager_count,
         COUNT(DISTINCT customer_id) AS unique_players
       FROM wagers
      WHERE insert_datetime >= datetime('now', ?)
      GROUP BY agent_login
      ORDER BY total_risk DESC
      LIMIT ?`,
      [`-${hours} hours`, limit]
    );
  }

  /**
   * Sharp alerts: customers flagged RED/BLACK in the last N hours,
   * joined with their wager activity.
   */
  async getSharpAlerts(hours = 24, limit = 50): Promise<SharpAlertRow[]> {
    return this.db.all<SharpAlertRow>(
      `SELECT
         w.customer_id,
         MAX(w.agent_login) AS agent_login,
         COALESCE(SUM(w.amount_wagered), 0) / 100.0 AS total_volume,
         COALESCE(AVG(CASE WHEN w.amount_wagered > 0 THEN 1 ELSE 0 END), 0) AS win_rate,
         (SELECT COUNT(*) FROM ai_risk_flags f WHERE f.customer_id = w.customer_id) AS flag_count,
         (SELECT MAX(created_at) FROM ai_risk_flags f WHERE f.customer_id = w.customer_id) AS last_flagged_at,
         (SELECT risk_level FROM ai_risk_flags f WHERE f.customer_id = w.customer_id ORDER BY created_at DESC LIMIT 1) AS risk_level
       FROM wagers w
      WHERE w.insert_datetime >= datetime('now', ?)
      GROUP BY w.customer_id
      HAVING risk_level IN ('RED', 'BLACK')
      ORDER BY flag_count DESC, total_volume DESC
      LIMIT ?`,
      [`-${hours} hours`, limit]
    );
  }

  /**
   * Pending positions awaiting trader review.
   */
  async getPendingActions(limit = 50): Promise<PendingActionRow[]> {
    return this.db.all<PendingActionRow>(
      `SELECT id, customer_id, risk_level, suggested_action,
              suggested_max_exposure, ai_confidence, created_at, expires_at
         FROM risk_positions
        WHERE status = 'pending'
        ORDER BY
          CASE risk_level
            WHEN 'BLACK' THEN 1
            WHEN 'RED'   THEN 2
            WHEN 'YELLOW' THEN 3
            ELSE 4
          END,
          created_at DESC
        LIMIT ?`,
      [limit]
    );
  }

  /**
   * Exposure histogram for buckets like "0-1k", "1-5k", etc.
   */
  async getExposureBuckets(hours = 24): Promise<ExposureBucket[]> {
    const rows = await this.db.all<{ amount: number; wager_count: number }>(
      `SELECT amount_wagered AS amount, 1 AS wager_count
         FROM wagers
        WHERE insert_datetime >= datetime('now', ?)`,
      [`-${hours} hours`]
    );

    const buckets: Record<string, ExposureBucket> = {
      '< $100': { bucket: '< $100', exposure: 0, wager_count: 0 },
      '$100-1k': { bucket: '$100-1k', exposure: 0, wager_count: 0 },
      '$1k-5k': { bucket: '$1k-5k', exposure: 0, wager_count: 0 },
      '$5k-10k': { bucket: '$5k-10k', exposure: 0, wager_count: 0 },
      '$10k+': { bucket: '$10k+', exposure: 0, wager_count: 0 },
    };

    for (const r of rows) {
      const dollars = Number(r.amount) / 100;
      let key: keyof typeof buckets;
      if (dollars < 100) key = '< $100';
      else if (dollars < 1000) key = '$100-1k';
      else if (dollars < 5000) key = '$1k-5k';
      else if (dollars < 10000) key = '$5k-10k';
      else key = '$10k+';
      buckets[key].exposure += dollars;
      buckets[key].wager_count += 1;
    }

    return Object.values(buckets);
  }

  /**
   * Historical P&L chart for a customer or the entire book.
   * Groups by day for the last `days` days.
   */
  async getPnlHistory(opts: { customer_id?: string; days?: number } = {}): Promise<PnlPoint[]> {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
    const params: unknown[] = [`-${days} days`];
    let where = `WHERE insert_datetime >= datetime('now', ?)`;
    if (opts.customer_id) {
      where += ` AND customer_id = ?`;
      params.push(opts.customer_id);
    }

    return this.db.all<PnlPoint>(
      `SELECT
         date(insert_datetime) AS day,
         COALESCE(SUM(volume_amount), 0) / 100.0 AS volume,
         COALESCE(SUM(amount_wagered), 0) / 100.0 AS risk,
         COALESCE(SUM(to_win_amount), 0) / 100.0 AS to_win,
         COUNT(*) AS wager_count,
         (COALESCE(SUM(volume_amount), 0) - COALESCE(SUM(to_win_amount), 0)) / 100.0 AS net
       FROM wagers
       ${where}
      GROUP BY date(insert_datetime)
      ORDER BY day ASC`,
      params
    );
  }

  /**
   * Full dashboard payload — useful for a single fetch on page load.
   */
  async getFullDashboard(hours = 24): Promise<{
    summary: Awaited<ReturnType<CommandCenterDashboard['getSummary']>>;
    book_exposure: BookExposureRow[];
    sharp_alerts: SharpAlertRow[];
    pending_actions: PendingActionRow[];
    exposure_buckets: ExposureBucket[];
  }> {
    const [summary, book_exposure, sharp_alerts, pending_actions, exposure_buckets] = await Promise.all([
      this.getSummary(),
      this.getBookExposure(hours, 25),
      this.getSharpAlerts(hours, 25),
      this.getPendingActions(25),
      this.getExposureBuckets(hours),
    ]);
    return { summary, book_exposure, sharp_alerts, pending_actions, exposure_buckets };
  }
}
