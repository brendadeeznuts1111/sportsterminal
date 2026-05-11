import { AppDatabase, normalizeDatabasePath } from '../src/database';

const BATCH_SIZE = 500;

interface FeatureRow {
  customer_id: string;
  lifetime_wagers: number;
  avg_wager_size: number;
  max_wager_size: number;
  win_rate: number;
  sharp_score: number;
  risk_tier: string;
  archetype: string;
  sport_diversity_score: number;
  days_since_last_wager: number | null;
}

interface WagerRow {
  wager_number: number;
  customer_id: string;
  amount_wagered: number;
  to_win_amount: number;
  sport: string | null;
  wager_type: string | null;
  agent_login: string | null;
  insert_datetime: string;
}

async function main() {
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || 'backend/data/terminal.db'));

  console.log('═══════════════════════════════════════════════════');
  console.log('🛡️  BACKFILLING RISK DATA (Violations, Positions, Flags)');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. WAGER VIOLATIONS
  console.log('📋 Step 1: Wager Violations');
  await backfillViolations(db);

  // 2. RISK POSITIONS
  console.log('\n📋 Step 2: Risk Positions');
  await backfillPositions(db);

  // 3. PLAYER FLAGS
  console.log('\n📋 Step 3: Player Flags');
  await backfillFlags(db);

  // Summary
  const v = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM wager_violations');
  const p = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM risk_positions');
  const f = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM player_flags');
  console.log('\n═══════════════════════════════════════════════════');
  console.log('✅ DONE');
  console.log(`   wager_violations: ${v?.c || 0}`);
  console.log(`   risk_positions:   ${p?.c || 0}`);
  console.log(`   player_flags:     ${f?.c || 0}`);
  console.log('═══════════════════════════════════════════════════');

  await db.close();
}

async function backfillViolations(db: AppDatabase) {
  // Detect violations from wager data
  // Violation types: high_wager (> $5000), sharp_win_rate (> 55%), large_volume (> $10K in 24h)

  let inserted = 0;
  let skipped = 0;

  // High individual wagers (> $500 = 50000 cents — adjusted for this dataset)
  const highWagers = await db.all<WagerRow>(
    `SELECT wager_number, customer_id, amount_wagered, to_win_amount, sport, wager_type, agent_login, insert_datetime
     FROM wagers WHERE amount_wagered > 50000 ORDER BY wager_number`
  );

  for (const w of highWagers) {
    try {
      const amount = (w.amount_wagered || 0) / 100;
      await db.run(
        `INSERT INTO wager_violations (wager_id, customer_id, violation_type, details)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(wager_id, violation_type) DO NOTHING`,
        [w.wager_number, w.customer_id, 'high_wager',
         JSON.stringify({ amount, sport: w.sport, wager_type: w.wager_type, threshold: 500 })]
      );
      inserted++;
    } catch { skipped++; }
  }

  // Sharp win rate customers (> 50% win rate and >= 10 wagers)
  const sharpCustomers = await db.all<{ customer_id: string; win_rate: number; lifetime_wagers: number }>(
    `SELECT customer_id, win_rate, lifetime_wagers FROM customer_features
     WHERE win_rate > 0.50 AND lifetime_wagers >= 10`
  );

  for (const c of sharpCustomers) {
    // Find their most recent wager to attach violation to
    const wager = await db.get<WagerRow>(
      `SELECT wager_number FROM wagers WHERE customer_id = ? ORDER BY insert_datetime DESC LIMIT 1`, [c.customer_id]
    );
    if (!wager) continue;
    try {
      await db.run(
        `INSERT INTO wager_violations (wager_id, customer_id, violation_type, details)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(wager_id, violation_type) DO NOTHING`,
        [wager.wager_number, c.customer_id, 'sharp_win_rate',
         JSON.stringify({ win_rate: c.win_rate, lifetime_wagers: c.lifetime_wagers, threshold: 0.55 })]
      );
      inserted++;
    } catch { skipped++; }
  }

  // Large volume in 24h window (>$2000) - approximate by day
  const dailyVolumes = await db.all<{ customer_id: string; day: string; total: number }>(
    `SELECT customer_id, date(insert_datetime) as day, SUM(amount_wagered) as total
     FROM wagers GROUP BY customer_id, date(insert_datetime) HAVING total > 200000`
  );

  for (const d of dailyVolumes) {
    const wager = await db.get<WagerRow>(
      `SELECT wager_number FROM wagers WHERE customer_id = ? AND date(insert_datetime) = ? ORDER BY insert_datetime DESC LIMIT 1`,
      [d.customer_id, d.day]
    );
    if (!wager) continue;
    try {
      await db.run(
        `INSERT INTO wager_violations (wager_id, customer_id, violation_type, details)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(wager_id, violation_type) DO NOTHING`,
        [wager.wager_number, d.customer_id, 'daily_volume_spike',
         JSON.stringify({ day: d.day, total_cents: d.total, threshold: 10000 })]
      );
      inserted++;
    } catch { skipped++; }
  }

  console.log(`   Inserted ${inserted} violations (${skipped} skipped/duplicates)`);
}

async function backfillPositions(db: AppDatabase) {
  // Create risk positions for YELLOW, RED and BLACK tier customers
  const risky = await db.all<FeatureRow>(
    `SELECT customer_id, lifetime_wagers, avg_wager_size, max_wager_size, win_rate, sharp_score, risk_tier, archetype, sport_diversity_score, days_since_last_wager
     FROM customer_features WHERE risk_tier IN ('YELLOW', 'RED', 'BLACK')`
  );

  let inserted = 0;
  for (const c of risky) {
    const action = c.risk_tier === 'BLACK' ? 'block' : 'review';
    const limit = c.risk_tier === 'BLACK' ? 100 : (c.avg_wager_size > 500 ? 300 : 500);
    const exposure = c.risk_tier === 'BLACK' ? 500 : (c.avg_wager_size > 500 ? 2000 : 5000);
    const confidence = Math.min(100, c.sharp_score + (c.win_rate > 0.55 ? 15 : 0));

    try {
      await db.run(
        `INSERT INTO risk_positions (
          customer_id, risk_level, suggested_max_exposure, suggested_wager_limit, suggested_action,
          ai_confidence, ai_summary, status, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))`,
        [
          c.customer_id,
          c.risk_tier,
          exposure,
          limit,
          action,
          confidence,
          `${c.risk_tier} tier | ${c.archetype} | sharp_score=${c.sharp_score.toFixed(1)} | win_rate=${(c.win_rate * 100).toFixed(1)}%`,
          'pending',
        ]
      );
      inserted++;
    } catch { /* skip */ }
  }
  console.log(`   Inserted ${inserted} positions for RED/BLACK customers`);
}

async function backfillFlags(db: AppDatabase) {
  // Flag customers with >= 2 violations
  const flagged = await db.all<{ customer_id: string; count: number }>(
    `SELECT customer_id, COUNT(*) as count FROM wager_violations GROUP BY customer_id HAVING count >= 2`
  );

  let inserted = 0;
  for (const f of flagged) {
    try {
      await db.run(
        `INSERT INTO player_flags (customer_id, flag_type, severity, label, details, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [f.customer_id, 'multiple_violations', f.count >= 5 ? 'critical' : 'warning',
         `${f.count} wager violations`, JSON.stringify({ violation_count: f.count }), 'active']
      );
      inserted++;
    } catch { /* skip */ }
  }

  // Also flag BLACK tier customers without needing violations
  const blackTier = await db.all<{ customer_id: string }>(
    `SELECT customer_id FROM customer_features WHERE risk_tier = 'BLACK'
     AND customer_id NOT IN (SELECT customer_id FROM player_flags WHERE flag_type = 'black_tier')`
  );
  for (const c of blackTier) {
    try {
      await db.run(
        `INSERT INTO player_flags (customer_id, flag_type, severity, label, details, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [c.customer_id, 'black_tier', 'critical', 'BLACK tier risk profile',
         JSON.stringify({ reason: 'Auto-flagged by risk tier' }), 'active']
      );
      inserted++;
    } catch { /* skip */ }
  }

  console.log(`   Inserted ${inserted} flags`);
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
