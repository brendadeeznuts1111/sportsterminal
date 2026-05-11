import { AppDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));

  console.log('═══════════════════════════════════════════════════');
  console.log('🚩 EXPANDED PLAYER FLAGS BACKFILL');
  console.log('═══════════════════════════════════════════════════\n');

  let inserted = 0;

  // Flag 1: Sharp customers (win_rate > 50% AND avg_wager > $20)
  console.log('Flag 1: Sharp bettors (win_rate > 50% + avg > $20)');
  const sharpBettors = await db.all<{ customer_id: string; win_rate: number; avg_wager_size: number }>(
    `SELECT customer_id, win_rate, avg_wager_size FROM customer_features
     WHERE win_rate > 0.50 AND avg_wager_size > 20
     AND customer_id NOT IN (SELECT customer_id FROM player_flags WHERE flag_type = 'sharp_bettor')`
  );
  for (const c of sharpBettors) {
    await db.run(
      `INSERT INTO player_flags (customer_id, flag_type, severity, label, details, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.customer_id, 'sharp_bettor', 'warning',
       `Sharp bettor: ${(c.win_rate * 100).toFixed(1)}% win rate`,
       JSON.stringify({ win_rate: c.win_rate, avg_wager: c.avg_wager_size }), 'active']
    );
    inserted++;
  }
  console.log(`   Inserted ${sharpBettors.length} sharp bettor flags`);

  // Flag 2: High volume customers (> 100 wagers)
  console.log('\nFlag 2: High volume (> 100 wagers)');
  const highVolume = await db.all<{ customer_id: string; lifetime_wagers: number }>(
    `SELECT customer_id, lifetime_wagers FROM customer_features
     WHERE lifetime_wagers > 100
     AND customer_id NOT IN (SELECT customer_id FROM player_flags WHERE flag_type = 'high_volume')`
  );
  for (const c of highVolume) {
    await db.run(
      `INSERT INTO player_flags (customer_id, flag_type, severity, label, details, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.customer_id, 'high_volume', 'info',
       `High volume: ${c.lifetime_wagers} wagers`,
       JSON.stringify({ lifetime_wagers: c.lifetime_wagers }), 'active']
    );
    inserted++;
  }
  console.log(`   Inserted ${highVolume.length} high volume flags`);

  // Flag 3: Whale customers (max_wager > $100)
  console.log('\nFlag 3: Whale bettors (max > $100)');
  const whales = await db.all<{ customer_id: string; max_wager_size: number }>(
    `SELECT customer_id, max_wager_size FROM customer_features
     WHERE max_wager_size > 100
     AND customer_id NOT IN (SELECT customer_id FROM player_flags WHERE flag_type = 'whale')`
  );
  for (const c of whales) {
    await db.run(
      `INSERT INTO player_flags (customer_id, flag_type, severity, label, details, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.customer_id, 'whale', c.max_wager_size > 500 ? 'critical' : 'warning',
       `Whale: $${c.max_wager_size.toFixed(2)} max stake`,
       JSON.stringify({ max_wager: c.max_wager_size }), 'active']
    );
    inserted++;
  }
  console.log(`   Inserted ${whales.length} whale flags`);

  // Flag 4: Dormant customers (no wager in 60+ days)
  console.log('\nFlag 4: Dormant customers (60+ days)');
  const dormant = await db.all<{ customer_id: string; days_since_last_wager: number }>(
    `SELECT customer_id, days_since_last_wager FROM customer_features
     WHERE days_since_last_wager > 60
     AND customer_id NOT IN (SELECT customer_id FROM player_flags WHERE flag_type = 'dormant')`
  );
  for (const c of dormant) {
    await db.run(
      `INSERT INTO player_flags (customer_id, flag_type, severity, label, details, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.customer_id, 'dormant', 'info',
       `Dormant: ${Math.round(c.days_since_last_wager)} days inactive`,
       JSON.stringify({ days_since_last_wager: c.days_since_last_wager }), 'active']
    );
    inserted++;
  }
  console.log(`   Inserted ${dormant.length} dormant flags`);

  // Flag 5: Low win rate + high volume (potential problem customer)
  console.log('\nFlag 5: Low win rate + high volume (suspicious)');
  const suspicious = await db.all<{ customer_id: string; win_rate: number; lifetime_wagers: number }>(
    `SELECT customer_id, win_rate, lifetime_wagers FROM customer_features
     WHERE win_rate < 0.35 AND lifetime_wagers > 20
     AND customer_id NOT IN (SELECT customer_id FROM player_flags WHERE flag_type = 'suspicious_pattern')`
  );
  for (const c of suspicious) {
    await db.run(
      `INSERT INTO player_flags (customer_id, flag_type, severity, label, details, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.customer_id, 'suspicious_pattern', 'warning',
       `Low win rate: ${(c.win_rate * 100).toFixed(1)}% over ${c.lifetime_wagers} wagers`,
       JSON.stringify({ win_rate: c.win_rate, lifetime_wagers: c.lifetime_wagers }), 'active']
    );
    inserted++;
  }
  console.log(`   Inserted ${suspicious.length} suspicious pattern flags`);

  // Flag 6: Sport specialists (< 2 sports but high volume)
  console.log('\nFlag 6: Sport specialists (< 2 sports, > 20 wagers)');
  const specialists = await db.all<{ customer_id: string; sport_diversity_score: number; lifetime_wagers: number }>(
    `SELECT customer_id, sport_diversity_score, lifetime_wagers FROM customer_features
     WHERE sport_diversity_score < 0.4 AND lifetime_wagers > 20
     AND customer_id NOT IN (SELECT customer_id FROM player_flags WHERE flag_type = 'sport_specialist')`
  );
  for (const c of specialists) {
    await db.run(
      `INSERT INTO player_flags (customer_id, flag_type, severity, label, details, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.customer_id, 'sport_specialist', 'info',
       `Sport specialist: ${c.lifetime_wagers} wagers`,
       JSON.stringify({ sport_diversity: c.sport_diversity_score, lifetime_wagers: c.lifetime_wagers }), 'active']
    );
    inserted++;
  }
  console.log(`   Inserted ${specialists.length} sport specialist flags`);

  // Summary
  const total = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM player_flags');
  const byType = await db.all<{ flag_type: string; count: number }>(
    'SELECT flag_type, COUNT(*) as count FROM player_flags GROUP BY flag_type ORDER BY count DESC'
  );

  console.log('\n═══════════════════════════════════════════════════');
  console.log('✅ PLAYER FLAGS BACKFILL COMPLETE');
  console.log(`   Total flags: ${total?.c || 0}`);
  console.log(`   New flags:   ${inserted}`);
  console.log('\n   By type:');
  for (const t of byType) {
    console.log(`      ${t.flag_type.padEnd(25)} ${String(t.count).padStart(4)}`);
  }
  console.log('═══════════════════════════════════════════════════');

  await db.close();
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
