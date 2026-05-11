import { AppDatabase, normalizeDatabasePath } from '../src/database';
import crypto from 'crypto';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));

  console.log('═══════════════════════════════════════════════════');
  console.log('📊 BACKFILLING SNAPSHOTS + TRANSACTIONS + DEPOSITS');
  console.log('═══════════════════════════════════════════════════\n');

  // ─── 1. CUSTOMER SNAPSHOTS ─────────────────────────────────────────────
  console.log('Step 1: Customer Snapshots');
  let snapInserted = 0;

  const missingSnapshots = await db.all<{ customer_id: string; login: string; agent_login: string; agent_id: string }>(
    `SELECT DISTINCT w.customer_id, w.login, w.agent_login, w.agent_id
     FROM wagers w
     LEFT JOIN customer_snapshots cs ON cs.customer_id = w.customer_id
     WHERE w.customer_id IS NOT NULL AND cs.customer_id IS NULL`
  );

  for (const c of missingSnapshots) {
    try {
      await db.run(
        `INSERT INTO customer_snapshots (provider, customer_id, login, agent_id, agent_login, source, snapshot_time, raw_json)
         VALUES ('buckeye', ?, ?, ?, ?, 'backfill', datetime('now'), ?)`,
        [c.customer_id, c.login || c.customer_id, c.agent_id, c.agent_login,
         JSON.stringify({ source: 'backfilled_from_wagers', backfilled_at: new Date().toISOString() })]
      );
      snapInserted++;
    } catch { /* skip */ }
  }
  console.log(`   Inserted ${snapInserted} snapshots`);

  // ─── 2. PLAYER TRANSACTIONS ────────────────────────────────────────────
  console.log('\nStep 2: Player Transactions (synthetic from wagers)');
  let txInserted = 0;

  const missingTxCustomers = await db.all<{ customer_id: string }>(
    `SELECT DISTINCT w.customer_id
     FROM wagers w
     LEFT JOIN player_transactions pt ON pt.customer_id = w.customer_id
     WHERE w.customer_id IS NOT NULL AND pt.customer_id IS NULL`
  );

  for (const { customer_id } of missingTxCustomers) {
    const stats = await db.get<{
      total_wagered: number;
      total_won: number;
      total_lost: number;
      wager_count: number;
      first_wager_dt: string;
      agent_login: string;
      agent_id: string;
    }>(
      `SELECT
        SUM(amount_wagered) as total_wagered,
        SUM(CASE WHEN to_win_amount > 0 THEN to_win_amount ELSE 0 END) as total_won,
        SUM(CASE WHEN to_win_amount <= 0 THEN amount_wagered ELSE 0 END) as total_lost,
        COUNT(*) as wager_count,
        MIN(insert_datetime) as first_wager_dt,
        MAX(agent_login) as agent_login,
        MAX(agent_id) as agent_id
      FROM wagers WHERE customer_id = ?`,
      [customer_id]
    );

    if (!stats || stats.wager_count === 0) continue;

    const totalWagered = (stats.total_wagered || 0) / 100;
    const totalWon = (stats.total_won || 0) / 100;
    const totalLost = (stats.total_lost || 0) / 100;
    const netPnl = totalWon - totalLost;

    // Insert a wager summary transaction
    try {
      await db.run(
        `INSERT INTO player_transactions (
          id, provider, customer_id, agent_id, agent_login, tran_type, tran_code,
          amount, balance, description, category, transaction_time, pulled_at, raw_json
        ) VALUES (?, 'buckeye', ?, ?, ?, 'W', 'S', ?, ?, ?, 'wager_summary', ?, datetime('now'), ?)`,
        [
          crypto.randomUUID(),
          customer_id,
          stats.agent_id,
          stats.agent_login,
          totalWagered,
          netPnl,
          `${stats.wager_count} wagers totaling $${totalWagered.toFixed(2)}`,
          stats.first_wager_dt,
          JSON.stringify({ backfilled: true, wager_count: stats.wager_count, total_wagered: totalWagered, total_won: totalWon, total_lost: totalLost }),
        ]
      );
      txInserted++;
    } catch { /* skip */ }
  }
  console.log(`   Inserted ${txInserted} synthetic transactions`);

  // ─── 3. DEPOSITS ───────────────────────────────────────────────────────
  console.log('\nStep 3: Deposits (synthetic from wager data)');
  let depInserted = 0;

  const missingDepCustomers = await db.all<{ customer_id: string }>(
    `SELECT DISTINCT w.customer_id
     FROM wagers w
     LEFT JOIN deposits dep ON dep.customer_id = w.customer_id
     WHERE w.customer_id IS NOT NULL AND dep.customer_id IS NULL`
  );

  for (const { customer_id } of missingDepCustomers) {
    const stats = await db.get<{
      max_wager: number;
      avg_wager: number;
      first_wager_dt: string;
      agent_login: string;
      agent_id: string;
    }>(
      `SELECT MAX(amount_wagered) as max_wager, AVG(amount_wagered) as avg_wager,
              MIN(insert_datetime) as first_wager_dt, MAX(agent_login) as agent_login, MAX(agent_id) as agent_id
       FROM wagers WHERE customer_id = ?`,
      [customer_id]
    );

    if (!stats) continue;

    // Estimate initial deposit as max(2x avg wager, max wager) to have enough balance
    const estimatedDeposit = Math.max((stats.avg_wager || 0) * 2, stats.max_wager || 0) / 100;
    if (estimatedDeposit <= 0) continue;

    try {
      await db.run(
        `INSERT INTO deposits (
          id, provider, customer_id, agent_id, agent_login, amount, currency, method, status, transaction_time, pulled_at, raw_json
        ) VALUES (?, 'buckeye', ?, ?, ?, ?, 'USD', 'Customer Deposit', 'deposit', ?, datetime('now'), ?)`,
        [
          crypto.randomUUID(),
          customer_id,
          stats.agent_id,
          stats.agent_login,
          estimatedDeposit,
          stats.first_wager_dt,
          JSON.stringify({ backfilled: true, estimated: true, basis: 'max(2x_avg_wager, max_wager)' }),
        ]
      );
      depInserted++;
    } catch { /* skip */ }
  }
  console.log(`   Inserted ${depInserted} synthetic deposits`);

  // Summary
  const s = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM customer_snapshots');
  const t = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM player_transactions');
  const de = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM deposits');
  console.log('\n═══════════════════════════════════════════════════');
  console.log('✅ DONE');
  console.log(`   customer_snapshots:   ${s?.c || 0}`);
  console.log(`   player_transactions:  ${t?.c || 0}`);
  console.log(`   deposits:            ${de?.c || 0}`);
  console.log('═══════════════════════════════════════════════════');

  await db.close();
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err);
  process.exit(1);
});
