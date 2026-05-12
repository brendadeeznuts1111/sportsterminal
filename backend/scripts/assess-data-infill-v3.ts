/**
 * Data Infill Assessment (v3) — with clean table formatting
 *
 * Uses ScriptLogger and TableFormatter for structured, readable output.
 */

import { initDatabase } from '../src/database';
import { ScriptLogger } from '../src/utils/scriptLogger';
import { formatMemoryUsage, measureAsync } from '../src/utils/bunUtils';

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
  const log = new ScriptLogger();
  log.time('total');

  const db = await initDatabase(process.env.DATABASE_URL || './data/terminal.db');

  log.section('DATA INFILL ASSESSMENT (v3)');

  // ─── Table Row Counts ───────────────────────────────────────────────────
  log.subSection('Table Row Counts');
  log.time('table_counts');

  const tables = [
    { name: 'wagers', threshold: { low: 100, ok: 1000 } },
    { name: 'wager_archive', threshold: { low: 100, ok: 1000 } },
    { name: 'players', threshold: { low: 100, ok: 1000 } },
    { name: 'agent_hierarchy', threshold: { low: 10, ok: 100 } },
    { name: 'player_agent_map', threshold: { low: 100, ok: 1000 } },
    { name: 'customer_features', threshold: { low: 100, ok: 1000 } },
    { name: 'customer_snapshots', threshold: { low: 100, ok: 1000 } },
    { name: 'player_transactions', threshold: { low: 1000, ok: 10000 } },
    { name: 'deposits', threshold: { low: 100, ok: 1000 } },
    { name: 'player_flags', threshold: { low: 10, ok: 100 } },
    { name: 'player_notes', threshold: { low: 10, ok: 100 } },
    { name: 'player_links', threshold: { low: 100, ok: 1000 } },
    { name: 'wager_violations', threshold: { low: 10, ok: 100 } },
    { name: 'risk_positions', threshold: { low: 10, ok: 100 } },
    { name: 'enforcement_queue', threshold: { low: 1, ok: 10 } },
    { name: 'master_snapshots', threshold: { low: 10, ok: 100 } },
    { name: 'weekly_figures', threshold: { low: 1000, ok: 10000 } },
    { name: 'agent_performance_snapshots', threshold: { low: 1000, ok: 10000 } },
    { name: 'raw_api_logs', threshold: { low: 100, ok: 1000 } },
    { name: 'buckeye_write_log', threshold: { low: 1, ok: 10 } },
    { name: 'telegram_messages', threshold: { low: 1, ok: 10 } },
    { name: 'source_freshness', threshold: { low: 1, ok: 5 } },
    { name: 'agent_closure', threshold: { low: 100, ok: 1000 } },
  ];

  const tableResults: Array<{ name: string; count: number; threshold?: { low: number; ok: number } }> = [];

  for (const t of tables) {
    try {
      const row = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${t.name}`);
      tableResults.push({ name: t.name, count: row?.count || 0, threshold: t.threshold });
    } catch {
      tableResults.push({ name: t.name, count: 0 });
    }
  }

  log.statusTable(tableResults, { title: 'Database Tables' });
  log.timeEnd('table_counts');

  // ─── Customer Coverage ──────────────────────────────────────────────────
  log.subSection('Customer Profile Coverage');
  log.time('coverage');

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
    const dims = [
      { key: 'with_features' as const, table: 'customer_features' },
      { key: 'with_snapshots' as const, table: 'customer_snapshots' },
      { key: 'with_transactions' as const, table: 'player_transactions' },
      { key: 'with_deposits' as const, table: 'deposits' },
      { key: 'with_flags' as const, table: 'player_flags' },
      { key: 'with_notes' as const, table: 'player_notes' },
      { key: 'with_links' as const, table: 'player_links', col: 'player_a' },
      { key: 'with_violations' as const, table: 'wager_violations' },
      { key: 'with_positions' as const, table: 'risk_positions' },
    ];

    for (const dim of dims) {
      const col = dim.col ?? 'customer_id';
      const result = await db.get<{ count: number }>(
        `SELECT COUNT(DISTINCT ${col}) AS count FROM ${dim.table} WHERE ${col} IN (SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL)`
      );
      coverage[dim.key] = result?.count || 0;
    }

    const totalDimensions = 9;
    const totalFilled = Object.values(coverage).slice(1, -1).reduce((a, b) => a + b, 0);
    coverage.coverage_pct = Number(((totalFilled / (total * totalDimensions)) * 100).toFixed(2));
  }

  log.keyValue([
    { key: 'Total customers with wagers', value: coverage.total_customers },
    { key: 'With customer_features', value: `${coverage.with_features} (${pct(coverage.with_features, coverage.total_customers)})` },
    { key: 'With customer_snapshots', value: `${coverage.with_snapshots} (${pct(coverage.with_snapshots, coverage.total_customers)})` },
    { key: 'With player_transactions', value: `${coverage.with_transactions} (${pct(coverage.with_transactions, coverage.total_customers)})` },
    { key: 'With deposits', value: `${coverage.with_deposits} (${pct(coverage.with_deposits, coverage.total_customers)})` },
    { key: 'With player_flags', value: `${coverage.with_flags} (${pct(coverage.with_flags, coverage.total_customers)})` },
    { key: 'With player_notes', value: `${coverage.with_notes} (${pct(coverage.with_notes, coverage.total_customers)})` },
    { key: 'With player_links', value: `${coverage.with_links} (${pct(coverage.with_links, coverage.total_customers)})` },
    { key: 'With wager_violations', value: `${coverage.with_violations} (${pct(coverage.with_violations, coverage.total_customers)})` },
    { key: 'With risk_positions', value: `${coverage.with_positions} (${pct(coverage.with_positions, coverage.total_customers)})` },
    { key: 'Overall coverage', value: `${coverage.coverage_pct}%`, color: '\x1b[1m\x1b[36m' },
  ]);
  log.timeEnd('coverage');

  // ─── Freshness ──────────────────────────────────────────────────────────
  log.subSection('Data Freshness');

  const staleFeatures = await db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM customer_features WHERE extracted_at < datetime('now', '-24 hours')`
  );
  const totalFeatures = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM customer_features`);

  log.keyValue([
    { key: 'Stale features (>24h)', value: `${staleFeatures?.count || 0} / ${totalFeatures?.count || 0}` },
  ]);

  // ─── Agents ─────────────────────────────────────────────────────────────
  log.subSection('Agent Coverage');

  const perfAgents = await db.get<{ count: number }>(`SELECT COUNT(DISTINCT agent_id) AS count FROM agent_performance_snapshots`);
  const totalAgents = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM agents`);

  log.result('Agents with performance snapshots', `${perfAgents?.count || 0} / ${totalAgents?.count || 0}`);

  // ─── Summary ────────────────────────────────────────────────────────────
  const totalMs = log.timeEnd('total');

  log.summary([
    { label: 'Total customers', value: coverage.total_customers, status: 'ok' },
    { label: 'Feature coverage', value: `${pct(coverage.with_features, coverage.total_customers)}`, status: coverage.with_features === coverage.total_customers ? 'ok' : 'warn' },
    { label: 'Flag coverage', value: `${pct(coverage.with_flags, coverage.total_customers)}`, status: coverage.with_flags > 0 ? 'ok' : 'warn' },
    { label: 'Position coverage', value: `${pct(coverage.with_positions, coverage.total_customers)}`, status: coverage.with_positions > 0 ? 'ok' : 'warn' },
    { label: 'Overall coverage', value: `${coverage.coverage_pct}%`, status: coverage.coverage_pct > 50 ? 'ok' : 'warn' },
    { label: 'Assessment time', value: `${Math.round(totalMs ?? 0)}ms`, status: 'ok' },
    { label: 'Memory', value: formatMemoryUsage(), status: 'ok' },
  ]);

  await db.close();
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

main().catch((err) => {
  console.error('❌ Assessment failed:', err);
  process.exit(1);
});
