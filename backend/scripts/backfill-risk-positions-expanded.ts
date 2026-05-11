import { AppDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));

  console.log('═══════════════════════════════════════════════════');
  console.log('🎯 EXPANDED RISK POSITIONS BACKFILL (Zone 4)');
  console.log('═══════════════════════════════════════════════════\n');

  let inserted = 0;

  // Position 1: All YELLOW tier customers
  console.log('Position 1: YELLOW tier customers');
  const yellowCustomers = await db.all<{
    customer_id: string;
    avg_wager_size: number;
    max_wager_size: number;
    win_rate: number;
    sharp_score: number;
    archetype: string;
    lifetime_wagers: number;
  }>(
    `SELECT customer_id, avg_wager_size, max_wager_size, win_rate, sharp_score, archetype, lifetime_wagers
     FROM customer_features
     WHERE risk_tier = 'YELLOW'
     AND customer_id NOT IN (SELECT customer_id FROM risk_positions WHERE status = 'pending')`
  );
  for (const c of yellowCustomers) {
    const limit = Math.max(50, c.avg_wager_size * 3);
    const exposure = Math.max(200, c.avg_wager_size * 10);
    await db.run(
      `INSERT INTO risk_positions (
        customer_id, risk_level, suggested_max_exposure, suggested_wager_limit, suggested_action,
        ai_confidence, ai_summary, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))`,
      [
        c.customer_id, 'YELLOW', exposure, limit, 'reduce',
        Math.min(100, c.sharp_score + 20),
        `YELLOW | ${c.archetype} | sharp=${c.sharp_score.toFixed(1)} | win_rate=${(c.win_rate * 100).toFixed(1)}% | wagers=${c.lifetime_wagers}`,
        'pending',
      ]
    );
    inserted++;
  }
  console.log(`   Inserted ${yellowCustomers.length} YELLOW positions`);

  // Position 2: GREEN tier with sharp indicators (sharp_score > 40)
  console.log('\nPosition 2: GREEN tier with sharp indicators (> 40)');
  const greenSharp = await db.all<{
    customer_id: string;
    avg_wager_size: number;
    max_wager_size: number;
    win_rate: number;
    sharp_score: number;
    archetype: string;
    lifetime_wagers: number;
  }>(
    `SELECT customer_id, avg_wager_size, max_wager_size, win_rate, sharp_score, archetype, lifetime_wagers
     FROM customer_features
     WHERE risk_tier = 'GREEN' AND sharp_score > 40
     AND customer_id NOT IN (SELECT customer_id FROM risk_positions WHERE status = 'pending')`
  );
  for (const c of greenSharp) {
    const limit = Math.max(100, c.avg_wager_size * 4);
    const exposure = Math.max(500, c.avg_wager_size * 15);
    await db.run(
      `INSERT INTO risk_positions (
        customer_id, risk_level, suggested_max_exposure, suggested_wager_limit, suggested_action,
        ai_confidence, ai_summary, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))`,
      [
        c.customer_id, 'GREEN-SHARP', exposure, limit, 'review',
        Math.min(100, c.sharp_score + 10),
        `GREEN-SHARP | ${c.archetype} | sharp=${c.sharp_score.toFixed(1)} | win_rate=${(c.win_rate * 100).toFixed(1)}%`,
        'pending',
      ]
    );
    inserted++;
  }
  console.log(`   Inserted ${greenSharp.length} GREEN-SHARP positions`);

  // Position 3: High volume GREEN (> 200 wagers)
  console.log('\nPosition 3: High volume GREEN (> 200 wagers)');
  const greenVolume = await db.all<{
    customer_id: string;
    avg_wager_size: number;
    win_rate: number;
    sharp_score: number;
    archetype: string;
    lifetime_wagers: number;
  }>(
    `SELECT customer_id, avg_wager_size, win_rate, sharp_score, archetype, lifetime_wagers
     FROM customer_features
     WHERE risk_tier = 'GREEN' AND lifetime_wagers > 200
     AND customer_id NOT IN (SELECT customer_id FROM risk_positions WHERE status = 'pending')`
  );
  for (const c of greenVolume) {
    const limit = Math.max(100, c.avg_wager_size * 3);
    const exposure = Math.max(500, c.avg_wager_size * 12);
    await db.run(
      `INSERT INTO risk_positions (
        customer_id, risk_level, suggested_max_exposure, suggested_wager_limit, suggested_action,
        ai_confidence, ai_summary, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))`,
      [
        c.customer_id, 'GREEN-VOLUME', exposure, limit, 'review',
        50,
        `GREEN-VOLUME | ${c.archetype} | ${c.lifetime_wagers} wagers | avg=$${c.avg_wager_size.toFixed(2)}`,
        'pending',
      ]
    );
    inserted++;
  }
  console.log(`   Inserted ${greenVolume.length} GREEN-VOLUME positions`);

  // Position 4: Whale customers (max > $50)
  console.log('\nPosition 4: Whale customers (max > $50)');
  const whales = await db.all<{
    customer_id: string;
    avg_wager_size: number;
    max_wager_size: number;
    win_rate: number;
    sharp_score: number;
    archetype: string;
  }>(
    `SELECT customer_id, avg_wager_size, max_wager_size, win_rate, sharp_score, archetype
     FROM customer_features
     WHERE max_wager_size > 50
     AND customer_id NOT IN (SELECT customer_id FROM risk_positions WHERE status = 'pending')`
  );
  for (const c of whales) {
    const limit = Math.max(100, c.avg_wager_size * 2);
    const exposure = Math.max(300, c.max_wager_size * 5);
    await db.run(
      `INSERT INTO risk_positions (
        customer_id, risk_level, suggested_max_exposure, suggested_wager_limit, suggested_action,
        ai_confidence, ai_summary, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))`,
      [
        c.customer_id, 'WHALE', exposure, limit, 'review',
        Math.min(100, c.sharp_score + 30),
        `WHALE | ${c.archetype} | max=$${c.max_wager_size.toFixed(2)} | avg=$${c.avg_wager_size.toFixed(2)}`,
        'pending',
      ]
    );
    inserted++;
  }
  console.log(`   Inserted ${whales.length} WHALE positions`);

  // Summary
  const total = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM risk_positions');
  const byTier = await db.all<{ risk_level: string; count: number }>(
    'SELECT risk_level, COUNT(*) as count FROM risk_positions GROUP BY risk_level ORDER BY count DESC'
  );
  const pending = await db.get<{ c: number }>("SELECT COUNT(*) as c FROM risk_positions WHERE status = 'pending'");

  console.log('\n═══════════════════════════════════════════════════');
  console.log('✅ RISK POSITIONS BACKFILL COMPLETE');
  console.log(`   Total positions:   ${total?.c || 0}`);
  console.log(`   New positions:     ${inserted}`);
  console.log(`   Pending status:    ${pending?.c || 0}`);
  console.log('\n   By tier:');
  for (const t of byTier) {
    console.log(`      ${t.risk_level.padEnd(20)} ${String(t.count).padStart(4)}`);
  }
  console.log('═══════════════════════════════════════════════════');

  await db.close();
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
