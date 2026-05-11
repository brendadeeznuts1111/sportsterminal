/**
 * Optimized Customer Feature Backfill (v2)
 *
 * Skips migrateDatabase to avoid long migrations on 22GB DB.
 */

import { AppDatabase, normalizeDatabasePath } from '../src/database';

interface WagerRow {
  wager_number: number;
  customer_id: string;
  amount_wagered: number;
  to_win_amount: number;
  volume_amount: number;
  insert_datetime: string;
  sport: string | null;
  short_desc: string | null;
  parsed_price: number | null;
  wager_type: string | null;
  agent_login: string | null;
}

const BATCH_SIZE = 100;

async function main() {
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db'));

  console.log('═══════════════════════════════════════════════════');
  console.log('🧠 BACKFILLING CUSTOMER FEATURES (Optimized v2)');
  console.log('═══════════════════════════════════════════════════\n');

  const customers = await db.all<{ customer_id: string }>(
    `SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL AND customer_id <> '' ORDER BY customer_id`
  );
  const total = customers.length;
  console.log(`Found ${total} customers with wagers\n`);

  let done = 0;
  let failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = customers.slice(i, i + BATCH_SIZE);

    for (const { customer_id } of batch) {
      try {
        await backfillCustomer(db, customer_id);
        done++;
      } catch (err) {
        failed++;
        if (failed <= 10) {
          console.warn(`   ⚠️  ${customer_id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = done / elapsed;
    const remaining = (total - done) / rate;
    console.log(`   ${Math.min(i + BATCH_SIZE, total)}/${total} | ${done} ok ${failed} fail | ${rate.toFixed(1)}/s | ~${Math.ceil(remaining)}s left`);
  }

  const count = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM customer_features');
  console.log(`\n✅ Total customer_features: ${count?.count || 0}`);
  await db.close();
}

async function backfillCustomer(db: AppDatabase, customerId: string): Promise<void> {
  const wagers = await db.all<WagerRow>(
    `SELECT wager_number, amount_wagered, to_win_amount, volume_amount, insert_datetime,
            sport, short_desc, parsed_price, wager_type, agent_login
     FROM wagers WHERE customer_id = ? ORDER BY insert_datetime DESC LIMIT 5000`,
    [customerId]
  );

  if (!wagers.length) return;

  const amounts = wagers.map((w) => (w.amount_wagered || 0) / 100).filter((n) => n > 0);
  const avgStake = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
  const maxStake = amounts.length ? Math.max(...amounts) : 0;
  const totalWagers = wagers.length;

  const wins = wagers.filter((w) => (w.to_win_amount || 0) > 0 && w.to_win_amount < w.amount_wagered).length;
  const winRate = totalWagers > 0 ? wins / totalWagers : 0;

  const sports = new Set(wagers.map((w) => (w.sport || '').trim()).filter(Boolean));
  const sportDiversity = Math.min(sports.size / 5, 1);

  const lastWager = wagers[0]?.insert_datetime;
  const daysSince = lastWager ? (Date.now() - new Date(lastWager).getTime()) / 86_400_000 : null;

  const largeWagers = wagers.filter((w) => (w.amount_wagered || 0) > 50000).length;
  const sharpScore = Math.min(100, (largeWagers * 5) + (winRate > 0.55 ? 20 : 0) + (avgStake > 300 ? 15 : 0));

  let archetype = 'recreational';
  if (avgStake > 500 && winRate > 0.55) archetype = 'sharp';
  else if (avgStake > 200) archetype = 'semi_pro';
  else if (totalWagers > 100) archetype = 'grinder';

  let riskTier = 'GREEN';
  if (sharpScore > 80 || (avgStake > 1000 && winRate > 0.6)) riskTier = 'BLACK';
  else if (sharpScore > 60 || avgStake > 500) riskTier = 'RED';
  else if (sharpScore > 40 || totalWagers > 50) riskTier = 'YELLOW';

  const agentLogin = wagers[0]?.agent_login;
  const agent = agentLogin
    ? await db.get<{ level: number; agent_type: string; live_betting_rate_m: number; prop_builder_rate_m: number }>(
        `SELECT level, agent_type, live_betting_rate_m, prop_builder_rate_m FROM agents WHERE provider = 'buckeye' AND login = ? LIMIT 1`,
        [agentLogin.trim().toUpperCase()]
      )
    : null;

  const featureJson = JSON.stringify({ total_wagers_90d: totalWagers, avg_stake: avgStake, max_stake: maxStake, win_rate: winRate, sport_diversity: sportDiversity, large_wager_count: largeWagers });
  const sourceJson = JSON.stringify({ wager_count: wagers.length, agent_login: agentLogin, last_wager: lastWager });

  await db.run(
    `INSERT INTO customer_features (
      customer_id, extracted_at, feature_version, lifetime_wagers, avg_wager_size, max_wager_size, win_rate, days_since_last_wager,
      sport_diversity_score, deposit_velocity_30d, withdrawal_ratio, bonus_dependency, sharp_score, chase_flag, archetype, risk_tier, clv,
      agent_level, agent_type, agent_live_betting_rate, agent_prop_builder_rate, feature_json, source_json
    ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(customer_id) DO UPDATE SET
      extracted_at = excluded.extracted_at, feature_version = excluded.feature_version, lifetime_wagers = excluded.lifetime_wagers,
      avg_wager_size = excluded.avg_wager_size, max_wager_size = excluded.max_wager_size, win_rate = excluded.win_rate,
      days_since_last_wager = excluded.days_since_last_wager, sport_diversity_score = excluded.sport_diversity_score,
      deposit_velocity_30d = excluded.deposit_velocity_30d, withdrawal_ratio = excluded.withdrawal_ratio,
      bonus_dependency = excluded.bonus_dependency, sharp_score = excluded.sharp_score, chase_flag = excluded.chase_flag,
      archetype = excluded.archetype, risk_tier = excluded.risk_tier, clv = excluded.clv,
      agent_level = excluded.agent_level, agent_type = excluded.agent_type, agent_live_betting_rate = excluded.agent_live_betting_rate,
      agent_prop_builder_rate = excluded.agent_prop_builder_rate, feature_json = excluded.feature_json, source_json = excluded.source_json`,
    [
      customerId, 2, totalWagers, avgStake, maxStake, winRate, daysSince, sportDiversity, 0, 0, 0, sharpScore, 0, archetype, riskTier, 0,
      agent?.level ?? null, agent?.agent_type ?? null, agent?.live_betting_rate_m ?? null, agent?.prop_builder_rate_m ?? null,
      featureJson, sourceJson,
    ]
  );
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
