import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initDatabase, type Database } from '../src/database';
import { RiskCommandCenter } from '../src/services/RiskCommandCenter';
import { WebhookCircuitBreaker, webhookCircuitBreaker } from '../src/services/WebhookCircuitBreaker';
import { PositionService } from '../src/services/PositionService';
import { EnforcementQueueService } from '../src/services/EnforcementQueueService';

describe('RiskCommandCenter', () => {
  let db: Database | null = null;

  beforeEach(async () => {
    db = await initDatabase(':memory:');
  });

  afterEach(async () => {
    if (db) {
      await db.close();
      db = null;
    }
  });
  test('expires stale positions', async () => {
    const rcc = new RiskCommandCenter(db!);
    const ps = new PositionService(db!);

    await db!.run(
      `INSERT INTO risk_positions (customer_id, risk_level, suggested_action, status, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '-1 hour'))`,
      ['CUST1', 'RED', 'block', 'pending']
    );
    await db!.run(
      `INSERT INTO risk_positions (customer_id, risk_level, suggested_action, status, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+1 hour'))`,
      ['CUST2', 'YELLOW', 'review', 'pending']
    );

    const expired = await rcc.expireStalePositions();
    expect(expired).toBe(1);

    const rows = await db!.all<{ status: string }>(`SELECT status FROM risk_positions WHERE customer_id = 'CUST1'`);
    expect(rows[0]?.status).toBe('expired');
  });

  test('records violation with deduplication', async () => {
    const rcc = new RiskCommandCenter(db!);

    const first = await rcc.recordViolation(1001, 'CUST1', 'max_exposure', { limit: 5000 });
    expect(first.isNew).toBe(true);
    expect(first.id).toBeGreaterThan(0);

    const second = await rcc.recordViolation(1001, 'CUST1', 'max_exposure', { limit: 5000 });
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);

    const third = await rcc.recordViolation(1001, 'CUST1', 'sharp_activity', { limit: 5000 });
    expect(third.isNew).toBe(true);
    expect(third.id).not.toBe(first.id);
  });

  test('queues manual enforcement when a risk position is generated', async () => {
    await db!.run(
      `INSERT INTO ai_risk_flags (customer_id, risk_level, confidence, summary, max_exposure)
       VALUES (?, ?, ?, ?, ?)`,
      ['CUSTQ', 'RED', 0.91, 'Manual review needed', 500]
    );

    const positions = new PositionService(db!);
    const generated = await positions.generatePosition({ customer_id: 'CUSTQ' });
    expect(generated.auto_applied).toBe(false);

    const queue = new EnforcementQueueService(db!);
    const result = await queue.list({ status: 'pending' });
    expect(result.count).toBe(1);
    expect(result.queue[0]?.position_id).toBe(generated.position_id);
    expect(result.queue[0]?.buckeye_admin_url).toContain('CUSTQ');
  });

  test('marks manual enforcement applied and updates parent position', async () => {
    await db!.run(
      `INSERT INTO risk_positions (customer_id, risk_level, suggested_action, suggested_max_exposure, suggested_wager_limit, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['CUSTA', 'RED', 'review', 500, 250, 'pending']
    );
    const row = await db!.get<{ id: number }>(`SELECT id FROM risk_positions WHERE customer_id = ?`, ['CUSTA']);
    const queue = new EnforcementQueueService(db!);
    const enqueued = await queue.enqueuePosition(row!.id);
    expect(enqueued.queued).toBe(true);

    const applied = await queue.markApplied({
      id: enqueued.id!,
      traderName: 'desk1',
      actualMaxExposure: 400,
      actualWagerLimit: 200,
    });
    expect(applied.ok).toBe(true);

    const parent = await db!.get<{ status: string; executed_by: string; executed_wager_limit: number }>(
      `SELECT status, executed_by, executed_wager_limit FROM risk_positions WHERE id = ?`,
      [row!.id]
    );
    expect(parent?.status).toBe('applied');
    expect(parent?.executed_by).toBe('desk1');
    expect(parent?.executed_wager_limit).toBe(200);
  });

  test('gets violations for customer', async () => {
    const rcc = new RiskCommandCenter(db!);
    await rcc.recordViolation(1001, 'CUST1', 'max_exposure');
    await rcc.recordViolation(1002, 'CUST1', 'sharp_activity');

    const violations = await rcc.getViolationsForCustomer('CUST1');
    expect(violations.length).toBe(2);
    expect(violations[0]?.customer_id).toBe('CUST1');
  });

  test('generates risk summary with freshness check', async () => {
    const rcc = new RiskCommandCenter(db!);

    await db!.run(`INSERT INTO wagers (wager_number, agent_id, customer_id, login, wager_type, amount_wagered, to_win_amount, volume_amount, insert_datetime, ticket_writer, short_desc, vip, agent_login, sport, scraped_at)
                    VALUES (?, ?, ?, ?, 'M', ?, ?, ?, datetime('now'), 'Internet', 'Test', '0', ?, 'Basketball', datetime('now'))`,
      [1, 'AG1', 'CUST1', 'CUST1', 100, 90, 100, 'AG1']);

    const summary = await rcc.generateRiskSummary();
    expect(summary.checked_at).toBeTruthy();
    expect(['fresh', 'stale', 'disconnected']).toContain(summary.data_freshness);
    expect(summary.positions).toBeDefined();
    expect(summary.violations).toBeDefined();
    expect(summary.alerts).toBeDefined();
    expect(summary.features).toBeDefined();
    expect(['healthy', 'degraded', 'critical']).toContain(summary.health);
  });

  test('gets book P&L timeseries', async () => {
    const rcc = new RiskCommandCenter(db!);

    await db!.run(`INSERT INTO wagers (wager_number, agent_id, customer_id, login, wager_type, amount_wagered, to_win_amount, volume_amount, insert_datetime, ticket_writer, short_desc, vip, agent_login, sport, scraped_at)
                    VALUES (?, ?, ?, ?, 'M', ?, ?, ?, date('now', '-1 day'), 'Internet', 'Test', '0', ?, 'Basketball', datetime('now'))`,
      [1, 'AG1', 'CUST1', 'CUST1', 100, 90, 100, 'AG1']);

    const series = await rcc.getBookPnLTimeseries(7);
    expect(Array.isArray(series)).toBe(true);
    if (series.length > 0) {
      expect(series[0]!.date).toBeTruthy();
      expect(typeof series[0]!.gross_wagers).toBe('number');
    }
  });

  test('gets player detail with clv and link', async () => {
    const rcc = new RiskCommandCenter(db!);

    await db!.run(
      `INSERT INTO customer_features (customer_id, lifetime_wagers, avg_wager_size, sport_diversity_score, deposit_velocity_30d, withdrawal_ratio, bonus_dependency, sharp_score, chase_flag, archetype, risk_tier, clv)
       VALUES (?, 10, 100, 5, 0, 0, 0, 0, 0, 'test', 'GREEN', 12.5)`
    , ['CUST1']);

    const detail = await rcc.getPlayerDetail('CUST1');
    expect(detail.customer_id).toBe('CUST1');
    expect(detail.features).toBeDefined();
    expect(detail.clv).toBe(12.5);
    expect(detail.link).toContain('/player/CUST1');
  });
});

describe('WebhookCircuitBreaker', () => {
  test('allows delivery when closed', () => {
    const cb = webhookCircuitBreaker;
    expect(cb.canDeliver('http://test.webhook')).toBe(true);
  });

  test('opens after threshold failures', () => {
    const cb = webhookCircuitBreaker;
    const url = 'http://fail.webhook';

    for (let i = 0; i < 5; i++) {
      cb.recordFailure(url);
    }

    expect(cb.canDeliver(url)).toBe(false);
    const state = cb.getState(url);
    expect(state?.state).toBe('open');
  });

  test('recovers after successes', () => {
    const cb = new WebhookCircuitBreaker({
      failureThreshold: 5,
      successThreshold: 2,
      cooldownMs: 0,
      windowMs: 300_000,
    });
    const url = 'http://recover.webhook';

    for (let i = 0; i < 5; i++) cb.recordFailure(url);
    expect(cb.getState(url)?.state).toBe('open');

    // After cooldown, circuit is half-open
    expect(cb.canDeliver(url)).toBe(true);

    cb.recordSuccess(url);
    cb.recordSuccess(url);
    const state = cb.getState(url);
    expect(state?.state).toBe('closed');
  });
});
