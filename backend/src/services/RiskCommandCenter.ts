/**
 * RiskCommandCenter — unified risk management surface.
 *
 * Consolidates positions, violations, risk summaries, timeseries,
 * and player detail fetching into one callable module.
 */

import type { Database } from '../database';
import { webhookCircuitBreaker } from './WebhookCircuitBreaker';

// ─── Types ───────────────────────────────────────────────────────────

export interface RiskSummary {
  checked_at: string;
  data_freshness: 'fresh' | 'stale' | 'disconnected';
  warning: string | null;
  positions: {
    total: number;
    pending: number;
    executed: number;
    expired: number;
    overridden: number;
  };
  violations: {
    total_24h: number;
    by_type: Record<string, number>;
  };
  alerts: {
    sent_24h: number;
    failed_24h: number;
    circuit_breaker_open: number;
  };
  features: {
    total_customers: number;
    stale_count: number;
    stale_threshold_hours: number;
  };
  health: 'healthy' | 'degraded' | 'critical';
}

export interface TimeseriesRow {
  date: string;
  gross_wagers: number;
  gross_wins: number;
  gross_losses: number;
  net: number;
  commission: number;
}

export interface ViolationRow {
  id: number;
  wager_id: number;
  customer_id: string;
  violation_type: string;
  details: string;
  detected_at: string;
}

export interface PlayerDetailResult {
  customer_id: string;
  features: Record<string, unknown> | null;
  latest_flag: Record<string, unknown> | null;
  positions: Array<Record<string, unknown>>;
  violations_24h: number;
  clv: number | null;
  link: string;
}

export interface RiskCommandCenterOptions {
  staleThresholdHours?: number;
  terminalBaseUrl?: string;
}

// ─── Service ─────────────────────────────────────────────────────────

export class RiskCommandCenter {
  private readonly staleThresholdHours: number;
  private readonly terminalBaseUrl: string;

  constructor(private readonly db: Database, opts: RiskCommandCenterOptions = {}) {
    this.staleThresholdHours = opts.staleThresholdHours ?? 1;
    this.terminalBaseUrl = opts.terminalBaseUrl ?? (Bun.env.TERMINAL_BASE_URL || 'http://localhost:3000');
  }

  // ─── Position Lifecycle ────────────────────────────────────────────

  async expireStalePositions(): Promise<number> {
    const result = await this.db.run(
      `UPDATE risk_positions
          SET status = 'expired',
              expires_at = datetime('now')
        WHERE status IN ('pending', 'active')
          AND expires_at IS NOT NULL
          AND expires_at < datetime('now')`
    );
    return result.changes;
  }

  // ─── Violations ────────────────────────────────────────────────────

  async recordViolation(
    wagerId: number,
    customerId: string,
    type: string,
    details: Record<string, unknown> = {}
  ): Promise<{ id: number; isNew: boolean }> {
    const result = await this.db.run(
      `INSERT OR IGNORE INTO wager_violations (wager_id, customer_id, violation_type, details)
       VALUES (?, ?, ?, ?)`,
      [wagerId, customerId, type, JSON.stringify(details)]
    );
    if (result.changes > 0) {
      return { id: result.lastID, isNew: true };
    }

    const row = await this.db.get<{ id: number }>(
      `SELECT id FROM wager_violations WHERE wager_id = ? AND violation_type = ?`,
      [wagerId, type]
    );
    return { id: row?.id ?? 0, isNew: false };
  }

  async getViolationsForCustomer(customerId: string, limit = 50): Promise<ViolationRow[]> {
    return this.db.all<ViolationRow>(
      `SELECT id, wager_id, customer_id, violation_type, details, detected_at
         FROM wager_violations
        WHERE customer_id = ?
        ORDER BY detected_at DESC
        LIMIT ?`,
      [customerId, limit]
    );
  }

  async getViolationCountsByType(hours = 24): Promise<Record<string, number>> {
    const rows = await this.db.all<{ violation_type: string; count: number }>(
      `SELECT violation_type, COUNT(*) AS count
         FROM wager_violations
        WHERE detected_at > datetime('now', ?)
        GROUP BY violation_type`,
      [`-${hours} hours`]
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.violation_type] = row.count;
    return out;
  }

  // ─── Risk Summary ──────────────────────────────────────────────────

  async generateRiskSummary(): Promise<RiskSummary> {
    const [
      positionCounts,
      violationTotal,
      violationTypes,
      alertCounts,
      featureCounts,
      freshness,
    ] = await Promise.all([
      this.getPositionCounts(),
      this.getViolationCount(24),
      this.getViolationCountsByType(24),
      this.getAlertCounts(24),
      this.getFeatureCounts(),
      this.checkDataFreshness(),
    ]);

    const circuitStates = webhookCircuitBreaker.getStates();
    const openCircuits = circuitStates.filter((s) => s.state === 'open').length;

    let health: RiskSummary['health'] = 'healthy';
    let warning: string | null = null;
    if (freshness.overall === 'disconnected') health = 'critical';
    else if (freshness.overall === 'stale') health = 'degraded';
    else if (openCircuits > 0 || positionCounts.pending > 20) health = 'degraded';
    if (freshness.overall === 'disconnected') {
      warning = 'DATA DISCONNECTED - risk analysis may be outdated.';
    } else if (freshness.overall === 'stale') {
      warning = 'Data is stale. Recent wagers may not be reflected.';
    }

    return {
      checked_at: new Date().toISOString(),
      data_freshness: freshness.overall,
      warning,
      positions: positionCounts,
      violations: {
        total_24h: violationTotal,
        by_type: violationTypes,
      },
      alerts: {
        sent_24h: alertCounts.sent,
        failed_24h: alertCounts.failed,
        circuit_breaker_open: openCircuits,
      },
      features: {
        total_customers: featureCounts.total,
        stale_count: featureCounts.stale,
        stale_threshold_hours: this.staleThresholdHours,
      },
      health,
    };
  }

  // ─── Timeseries ────────────────────────────────────────────────────

  async getBookPnLTimeseries(days = 30): Promise<TimeseriesRow[]> {
    return this.db.all<TimeseriesRow>(
      `SELECT
         date(insert_datetime) AS date,
         SUM(amount_wagered)   AS gross_wagers,
         SUM(CASE WHEN to_win_amount > 0 THEN to_win_amount ELSE 0 END) AS gross_wins,
         SUM(CASE WHEN to_win_amount < 0 THEN ABS(to_win_amount) ELSE 0 END) AS gross_losses,
         SUM(to_win_amount)    AS net,
         0                     AS commission
       FROM wagers
       WHERE insert_datetime > datetime('now', ?)
       GROUP BY date(insert_datetime)
       ORDER BY date ASC`,
      [`-${days} days`]
    );
  }

  // ─── Player Detail ─────────────────────────────────────────────────

  async getPlayerDetail(customerId: string): Promise<PlayerDetailResult> {
    const [features, latestFlag, positions, violations24h] = await Promise.all([
      this.db.get<Record<string, unknown>>(
        `SELECT * FROM customer_features WHERE customer_id = ? LIMIT 1`,
        [customerId]
      ),
      this.db.get<Record<string, unknown>>(
        `SELECT * FROM ai_risk_flags WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1`,
        [customerId]
      ),
      this.db.all<Record<string, unknown>>(
        `SELECT * FROM risk_positions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10`,
        [customerId]
      ),
      this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM wager_violations WHERE customer_id = ? AND detected_at > datetime('now', '-24 hours')`,
        [customerId]
      ),
    ]);

    const clv = features && typeof features.clv === 'number' ? features.clv : null;

    return {
      customer_id: customerId,
      features,
      latest_flag: latestFlag,
      positions,
      violations_24h: violations24h?.count ?? 0,
      clv,
      link: `${this.terminalBaseUrl}/player/${customerId}`,
    };
  }

  // ─── Circuit Breaker ───────────────────────────────────────────────

  getWebhookCircuitBreakerState(): ReturnType<typeof webhookCircuitBreaker.getStates> {
    return webhookCircuitBreaker.getStates();
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private async getPositionCounts(): Promise<RiskSummary['positions']> {
    const rows = await this.db.all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM risk_positions GROUP BY status`
    );
    const out: RiskSummary['positions'] = { total: 0, pending: 0, executed: 0, expired: 0, overridden: 0 };
    for (const row of rows) {
      out.total += row.count;
      if (row.status === 'pending') out.pending = row.count;
      else if (row.status === 'executed') out.executed = row.count;
      else if (row.status === 'expired') out.expired = row.count;
      else if (row.status === 'overridden') out.overridden = row.count;
    }
    return out;
  }

  private async getViolationCount(hours: number): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM wager_violations WHERE detected_at > datetime('now', ?)`,
      [`-${hours} hours`]
    );
    return row?.count ?? 0;
  }

  private async getAlertCounts(hours: number): Promise<{ sent: number; failed: number }> {
    const sent = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM risk_alert_log WHERE sent_at > datetime('now', ?) AND response_status BETWEEN 200 AND 299`,
      [`-${hours} hours`]
    );
    const failed = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM risk_alert_log WHERE sent_at > datetime('now', ?) AND (response_status < 200 OR response_status >= 300)`,
      [`-${hours} hours`]
    );
    return { sent: sent?.count ?? 0, failed: failed?.count ?? 0 };
  }

  private async getFeatureCounts(): Promise<{ total: number; stale: number }> {
    const total = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM customer_features`
    );
    const stale = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM customer_features WHERE extracted_at < datetime('now', ?)`,
      [`-${this.staleThresholdHours} hours`]
    );
    return { total: total?.count ?? 0, stale: stale?.count ?? 0 };
  }

  private async checkDataFreshness(): Promise<{ overall: 'fresh' | 'stale' | 'disconnected' }> {
    const latestWager = await this.db.get<{ insert_datetime: string }>(
      `SELECT insert_datetime FROM wagers ORDER BY insert_datetime DESC LIMIT 1`
    );
    if (!latestWager) return { overall: 'disconnected' };

    const ageMs = Date.now() - new Date(latestWager.insert_datetime).getTime();
    const staleThresholdMs = this.staleThresholdHours * 60 * 60 * 1000;

    if (ageMs > staleThresholdMs * 2) return { overall: 'disconnected' };
    if (ageMs > staleThresholdMs) return { overall: 'stale' };
    return { overall: 'fresh' };
  }
}
