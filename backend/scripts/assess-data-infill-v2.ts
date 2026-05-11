import { AppDatabase, normalizeDatabasePath } from '../src/database';

interface CustomerCoverage {
  total_customers: number;
  with_features: number;
  with_snapshots: number;
  with_transactions: number;
  with_deposits: number;
  with_flags: number;
  with_notes: number;
  with_links: number;
  with_violations: number;
  with_positions: number;
  coverage_pct: number;
}

async function main() {
  const dbPath = normalizeDatabasePath(process.env.DATABASE_URL || 'backend/data/terminal.db');
  const db = new AppDatabase(dbPath);
  await db.exec('PRAGMA foreign_keys = ON');

  console.log('═══════════════════════════════════════════════════');
  console.log('📊 DATA INFILL ASSESSMENT (v2)');
  console.log('═══════════════════════════════════════════════════\n');

  const tables = [
    'wagers', 'wager_archive', 'players', 'agent_hierarchy', 'player_agent_map',
    'customer_features', 'customer_snapshots', 'player_transactions', 'deposits',
    'player_flags', 'player_notes', 'player_links', 'wager_violations',
    'risk_positions', 'enforcement_queue', 'master_snapshots', 'weekly_figures',
    'agent_performance_snapshots', 'raw_api_logs', 'buckeye_write_log',
    'telegram_messages', 'source_freshness', 'agent_closure',
  ];

  console.log('📋 Table Row Counts:');
  for (const table of tables) {
    try {
      const row = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
      const count = row?.count || 0;
      const status = count === 0 ? '🔴 EMPTY' : count < 100 ? '🟡 LOW' : '🟢 OK';
      console.log(`   ${status} ${table.padEnd(30)} ${String(count).padStart(8)} rows`);
    } catch {
      console.log(`   ⚪ ${table.padEnd(30)} (table missing?)`);
    }
  }

  console.log('\n📊 Customer Profile Coverage:');
  const totalCustomers = await db.get<{ count: number }>(
    `SELECT COUNT(DISTINCT customer_id) AS count FROM wagers WHERE customer_id IS NOT NULL AND customer_id <> ''`
  );
  const total = totalCustomers?.count || 0;

  const coverage: CustomerCoverage = {
    total_customers: total,
    with_features: 0,
    with_snapshots: 0,
    with_transactions: 0,
    with_deposits: 0,
    with_flags: 0,
    with_notes: 0,
    with_links: 0,
    with_violations: 0,
    with_positions: 0,
    coverage_pct: 0,
  };

  if (total > 0) {
    const features = await db.get<{ count: number }>(
      `SELECT COUNT(DISTINCT customer_id) AS count FROM customer_features WHERE customer_id IN (SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL)`
    );
    coverage.with_features = features?.count || 0;

    const snapshots = await db.get<{ count: number }>(
      `SELECT COUNT(DISTINCT customer_id) AS count FROM customer_snapshots WHERE customer_id IN (SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL)`
    );
    coverage.with_snapshots = snapshots?.count || 0;

    const transactions = await db.get<{ count: number }>(
      `SELECT COUNT(DISTINCT customer_id) AS count FROM player_transactions WHERE customer_id IN (SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL)`
    );
    coverage.with_transactions = transactions?.count || 0;

    const deposits = await db.get<{ count: number }>(
      `SELECT COUNT(DISTINCT customer_id) AS count FROM deposits WHERE customer_id IN (SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL)`
    );
    coverage.with_deposits = deposits?.count || 0;

    const flags = await db.get<{ count: number }>(
      `SELECT COUNT(DISTINCT customer_id) AS count FROM player_flags WHERE customer_id IN (SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL)`
    );
    coverage.with_flags = flags?.count || 0;

    const notes = await db.get<{ count: number }>(
      `SELECT COUNT(DISTINCT customer_id) AS count FROM player_notes WHERE customer_id IN (SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL)`
    );
    coverage.with_notes = notes?.count || 0;

    const links = await db.get<{ count: number }>(
      `SELECT COUNT(DISTINCT player_a) AS count FROM player_links WHERE player_a IN (SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL)`
    );
    coverage.with_links = links?.count || 0;

    const violations = await db.get<{ count: number }>(
      `SELECT COUNT(DISTINCT customer_id) AS count FROM wager_violations WHERE customer_id IN (SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL)`
    );
    coverage.with_violations = violations?.count || 0;

    const positions = await db.get<{ count: number }>(
      `SELECT COUNT(DISTINCT customer_id) AS count FROM risk_positions WHERE customer_id IN (SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL)`
    );
    coverage.with_positions = positions?.count || 0;

    const totalDimensions = 9;
    const totalFilled = Object.values(coverage).slice(1, -1).reduce((a, b) => a + b, 0);
    coverage.coverage_pct = Number(((totalFilled / (total * totalDimensions)) * 100).toFixed(2));
  }

  console.log(`   Total customers with wagers: ${coverage.total_customers}`);
  console.log(`   With customer_features:      ${coverage.with_features} (${pct(coverage.with_features, coverage.total_customers)})`);
  console.log(`   With customer_snapshots:     ${coverage.with_snapshots} (${pct(coverage.with_snapshots, coverage.total_customers)})`);
  console.log(`   With player_transactions:    ${coverage.with_transactions} (${pct(coverage.with_transactions, coverage.total_customers)})`);
  console.log(`   With deposits:               ${coverage.with_deposits} (${pct(coverage.with_deposits, coverage.total_customers)})`);
  console.log(`   With player_flags:           ${coverage.with_flags} (${pct(coverage.with_flags, coverage.total_customers)})`);
  console.log(`   With player_notes:           ${coverage.with_notes} (${pct(coverage.with_notes, coverage.total_customers)})`);
  console.log(`   With player_links:           ${coverage.with_links} (${pct(coverage.with_links, coverage.total_customers)})`);
  console.log(`   With wager_violations:       ${coverage.with_violations} (${pct(coverage.with_violations, coverage.total_customers)})`);
  console.log(`   With risk_positions:         ${coverage.with_positions} (${pct(coverage.with_positions, coverage.total_customers)})`);
  console.log(`   Overall coverage:            ${coverage.coverage_pct}%`);

  console.log('\n⏱️  Feature Freshness (customers with stale features > 24h):');
  const staleFeatures = await db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM customer_features WHERE extracted_at < datetime('now', '-24 hours')`
  );
  const totalFeatures = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM customer_features`);
  console.log(`   Stale features: ${staleFeatures?.count || 0} / ${totalFeatures?.count || 0}`);

  console.log('\n❌ Customers with wagers but NO features:');
  const missingFeatures = await db.get<{ count: number }>(
    `SELECT COUNT(DISTINCT w.customer_id) AS count FROM wagers w LEFT JOIN customer_features cf ON cf.customer_id = w.customer_id WHERE w.customer_id IS NOT NULL AND cf.customer_id IS NULL`
  );
  console.log(`   Count: ${missingFeatures?.count || 0}`);

  console.log('\n📈 Agents with performance snapshots:');
  const perfAgents = await db.get<{ count: number }>(`SELECT COUNT(DISTINCT agent_id) AS count FROM agent_performance_snapshots`);
  const totalAgents = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM agents`);
  console.log(`   ${perfAgents?.count || 0} / ${totalAgents?.count || 0} agents`);

  console.log('\n📅 Weekly figures freshness:');
  const latestWeekly = await db.get<{ pulled_at: string }>(`SELECT MAX(pulled_at) AS pulled_at FROM weekly_figures`);
  console.log(`   Latest pull: ${latestWeekly?.pulled_at || 'never'}`);

  console.log('\n💰 Master snapshots freshness:');
  const latestMaster = await db.get<{ timestamp: string }>(`SELECT MAX(timestamp) AS timestamp FROM master_snapshots`);
  console.log(`   Latest snapshot: ${latestMaster?.timestamp || 'never'}`);

  console.log('\n🔴 CRITICAL GAPS:');
  if ((totalFeatures?.count || 0) === 0) console.log('   • customer_features is EMPTY');
  if ((coverage.with_snapshots || 0) === 0) console.log('   • customer_snapshots is EMPTY');
  if ((coverage.with_transactions || 0) === 0) console.log('   • player_transactions is EMPTY');
  if ((coverage.with_deposits || 0) === 0) console.log('   • deposits is EMPTY');
  if ((coverage.with_notes || 0) === 0) console.log('   • player_notes is EMPTY');
  if ((coverage.with_links || 0) === 0) console.log('   • player_links is EMPTY');

  await db.close();
  console.log('\n═══════════════════════════════════════════════════');
  console.log('Assessment complete.');
  console.log('═══════════════════════════════════════════════════');
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

main().catch((err) => {
  console.error('❌ Assessment failed:', err);
  process.exit(1);
});
