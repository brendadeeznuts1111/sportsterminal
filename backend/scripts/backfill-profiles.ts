/**
 * Data Infill — Backfill Customer Profiles
 *
 * Fills missing data for all customers with wagers:
 *   1. customer_features (ML feature vectors)
 *   2. wager_violations (basic anomaly detection)
 *   3. risk_positions (for high-risk customers)
 *   4. player_flags (auto-generated from violations)
 *
 * Run with: bun run backend/scripts/backfill-profiles.ts
 */

import { AppDatabase, migrateDatabase, normalizeDatabasePath } from '../src/database';
import { LiveFeatureService } from '../src/services/LiveFeatureService';
import { RiskCommandCenter } from '../src/services/RiskCommandCenter';
import { PositionService } from '../src/services/PositionService';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db'));
  await db.exec('PRAGMA foreign_keys = ON');
  await migrateDatabase(db);

  console.log('═══════════════════════════════════════════════════');
  console.log('📊 BACKFILLING CUSTOMER PROFILES');
  console.log('═══════════════════════════════════════════════════\n');

  const customers = await db.all<{ customer_id: string }>(
    `SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL AND customer_id <> '' ORDER BY customer_id`
  );
  const totalCustomers = customers.length;
  console.log(`Found ${totalCustomers} unique customers with wagers\n`);

  // ─── Step 1: Extract Features ───────────────────────────────────────────
  console.log('🧠 Step 1: Extracting customer features...');
  const liveFeatures = new LiveFeatureService(db);
  let featuresDone = 0;
  let featuresFailed = 0;

  for (let i = 0; i < customers.length; i++) {
    const customerId = customers[i].customer_id;
    try {
      await liveFeatures.extractFeaturesForCustomer(customerId);
      featuresDone++;
    } catch (err) {
      featuresFailed++;
      if (featuresFailed <= 5) {
        console.warn(`   ⚠️  Failed for ${customerId}:`, err instanceof Error ? err.message : err);
      }
    }
    if ((i + 1) % 50 === 0) {
      console.log(`   ${i + 1}/${totalCustomers} features extracted (${featuresFailed} failed)`);
    }
  }
  console.log(`   ✅ Features: ${featuresDone} done, ${featuresFailed} failed\n`);

  // ─── Step 2: Generate Violations ────────────────────────────────────────
  console.log('🚨 Step 2: Generating wager violations...');
  const rcc = new RiskCommandCenter(db);
  let violationsCreated = 0;

  // Basic anomaly detection from wager data
  const suspiciousWagers = await db.all<{
    id: number;
    customer_id: string;
    amount_wagered: number;
    agent_login: string;
    insert_datetime: string;
  }>(
    `SELECT id, customer_id, amount_wagered, agent_login, insert_datetime
     FROM wagers
     WHERE amount_wagered > 5000 OR vip = 'Y'
     ORDER BY insert_datetime DESC
     LIMIT 1000`
  );

  for (const wager of suspiciousWagers) {
    const types: string[] = [];
    if (wager.amount_wagered > 10000) types.push('high_wager');
    if (wager.amount_wagered > 5000) types.push('elevated_wager');

    for (const type of types) {
      try {
        await rcc.recordViolation(wager.id, wager.customer_id, type, {
          amount: wager.amount_wagered,
          agent: wager.agent_login,
          time: wager.insert_datetime,
        });
        violationsCreated++;
      } catch {
        // ignore duplicates
      }
    }
  }
  console.log(`   ✅ ${violationsCreated} violations created\n`);

  // ─── Step 3: Create Risk Positions ──────────────────────────────────────
  console.log('🎯 Step 3: Creating risk positions...');
  const positionService = new PositionService(db);
  let positionsCreated = 0;

  const riskyCustomers = await db.all<{
    customer_id: string;
    risk_tier: string;
    sharp_score: number;
    win_rate: number;
    lifetime_wagers: number;
  }>(
    `SELECT customer_id, risk_tier, sharp_score, win_rate, lifetime_wagers
     FROM customer_features
     WHERE risk_tier IN ('RED', 'BLACK') OR sharp_score > 70 OR win_rate > 0.6`
  );

  for (const customer of riskyCustomers) {
    try {
      const riskLevel = customer.risk_tier === 'BLACK' ? 'BLACK' : 'RED';
      const suggestedAction = customer.risk_tier === 'BLACK' ? 'block' : 'reduce';
      const maxExposure = customer.risk_tier === 'BLACK' ? 0 : 1000;
      const wagerLimit = customer.risk_tier === 'BLACK' ? 0 : 500;

      await db.run(
        `INSERT INTO risk_positions (customer_id, risk_level, suggested_max_exposure, suggested_wager_limit, suggested_action, ai_confidence, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
         ON CONFLICT DO NOTHING`,
        [customer.customer_id, riskLevel, maxExposure, wagerLimit, suggestedAction, 0.85]
      );
      positionsCreated++;
    } catch (err) {
      console.warn(`   ⚠️  Position failed for ${customer.customer_id}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`   ✅ ${positionsCreated} risk positions created\n`);

  // ─── Step 4: Create Player Flags ────────────────────────────────────────
  console.log('🚩 Step 4: Creating player flags...');
  let flagsCreated = 0;

  const customersWithViolations = await db.all<{ customer_id: string; count: number }>(
    `SELECT customer_id, COUNT(*) AS count FROM wager_violations GROUP BY customer_id HAVING count >= 2`
  );

  for (const cv of customersWithViolations) {
    try {
      await db.run(
        `INSERT INTO player_flags (customer_id, flag_type, severity, label, details, status)
         VALUES (?, 'auto_violation', ?, ?, ?, 'active')
         ON CONFLICT DO NOTHING`,
        [cv.customer_id, cv.count >= 5 ? 'high' : 'medium', `${cv.count} violations`, `Auto-detected ${cv.count} violations`]
      );
      flagsCreated++;
    } catch {
      // ignore
    }
  }
  console.log(`   ✅ ${flagsCreated} player flags created\n`);

  // ─── Summary ────────────────────────────────────────────────────────────
  const afterFeatures = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM customer_features');
  const afterViolations = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM wager_violations');
  const afterPositions = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM risk_positions');
  const afterFlags = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM player_flags');

  console.log('═══════════════════════════════════════════════════');
  console.log('📊 BACKFILL SUMMARY');
  console.log('═══════════════════════════════════════════════════');
  console.log(`customer_features: ${afterFeatures?.count || 0} (was 0)`);
  console.log(`wager_violations:  ${afterViolations?.count || 0} (was 0)`);
  console.log(`risk_positions:    ${afterPositions?.count || 0} (was 0)`);
  console.log(`player_flags:      ${afterFlags?.count || 0} (was 0)`);
  console.log('═══════════════════════════════════════════════════');

  await db.close();
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
