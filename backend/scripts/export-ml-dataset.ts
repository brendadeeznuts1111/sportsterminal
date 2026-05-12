/**
 * export-ml-dataset.ts
 * Export enriched agent + player + wager data for ML training.
 * Produces JSONL files that can be loaded by Python/pandas or DuckDB.
 *
 * Usage:
 *   bun run scripts/export-ml-dataset.ts
 */
import { Database } from 'bun:sqlite';
import { resolve } from 'path';

const DB_PATH = resolve('./data/terminal.db');
const OUT_DIR = resolve('./data/ml');

async function main() {
  console.log('🚀 Exporting ML dataset from', DB_PATH);
  const db = new Database(DB_PATH);

  // Ensure output dir
  await Bun.write(resolve(OUT_DIR, '.gitkeep'), '');

  // ─── 1. Enriched Players (agent context) ────────────────────────────────
  console.log('\n📝 Exporting enriched players...');
  const players = db.query(`
    SELECT
      p.id AS customer_id,
      p.login AS player_login,
      p.name AS player_name,
      p.agent_login,
      p.status AS player_status,
      a.id AS agent_id,
      a.level AS agent_level,
      a.agent_type,
      a.seq_number AS agent_seq,
      a.head_count_rate_m,
      a.inet_head_count_rate_m,
      a.casino_head_count_rate_m,
      a.live_betting_rate_m,
      a.live_betting2_rate_m,
      a.live_casino_rate_m,
      a.prop_builder_rate_m,
      a.flash_bets_rate,
      a.ext_props_rate,
      a.crash_rate,
      a.fantasy_rate,
      a.amigo_tech_rate
    FROM players p
    LEFT JOIN agents a ON a.provider = 'buckeye' AND a.login = p.agent_login
    WHERE p.provider = 'buckeye'
  `).all() as Array<Record<string, unknown>>;

  const playersJsonl = players.map((row) => JSON.stringify(row)).join('\n');
  await Bun.write(resolve(OUT_DIR, 'players_enriched.jsonl'), playersJsonl);
  console.log(`   ✅ ${players.length} players → players_enriched.jsonl`);

  // ─── 2. Agent Hierarchy Summary ─────────────────────────────────────────
  console.log('\n📝 Exporting agent hierarchy...');
  const agents = db.query(`
    SELECT
      id AS agent_id,
      login,
      name,
      level,
      agent_type,
      seq_number,
      parent_agent_id,
      child_count,
      player_count,
      head_count_rate_m,
      inet_head_count_rate_m,
      live_betting_rate_m,
      prop_builder_rate_m,
      flash_bets_rate,
      crash_rate,
      fantasy_rate
    FROM agents
    WHERE provider = 'buckeye'
    ORDER BY seq_number
  `).all() as Array<Record<string, unknown>>;

  const agentsJsonl = agents.map((row) => JSON.stringify(row)).join('\n');
  await Bun.write(resolve(OUT_DIR, 'agents.jsonl'), agentsJsonl);
  console.log(`   ✅ ${agents.length} agents → agents.jsonl`);

  // ─── 3. Wager Summary by Player (for risk modeling) ─────────────────────
  console.log('\n📝 Exporting wager aggregates...');
  const wagerAgg = db.query(`
    SELECT
      w.customer_id,
      w.login,
      w.agent_login,
      COUNT(*) AS wager_count,
      SUM(COALESCE(w.amount_wagered, 0)) AS total_volume,
      AVG(COALESCE(w.amount_wagered, 0)) AS avg_wager,
      MAX(COALESCE(w.amount_wagered, 0)) AS max_wager,
      COUNT(DISTINCT w.sport) AS sport_count,
      MIN(w.insert_datetime) AS first_wager,
      MAX(w.insert_datetime) AS last_wager,
      a.level AS agent_level,
      a.agent_type,
      a.live_betting_rate_m,
      a.prop_builder_rate_m
    FROM wagers w
    LEFT JOIN agents a ON a.provider = 'buckeye' AND a.login = w.agent_login
    GROUP BY w.customer_id
    ORDER BY total_volume DESC
  `).all() as Array<Record<string, unknown>>;

  const wagerJsonl = wagerAgg.map((row) => JSON.stringify(row)).join('\n');
  await Bun.write(resolve(OUT_DIR, 'wager_aggregates.jsonl'), wagerJsonl);
  console.log(`   ✅ ${wagerAgg.length} player wager summaries → wager_aggregates.jsonl`);

  // ─── 4. Feature Matrix (flat CSV-friendly) ──────────────────────────────
  console.log('\n📝 Exporting feature matrix...');
  const features = db.query(`
    SELECT
      p.id AS customer_id,
      p.login AS player_login,
      a.level AS agent_level,
      a.agent_type,
      a.live_betting_rate_m,
      a.prop_builder_rate_m,
      a.inet_head_count_rate_m,
      COALESCE(w.wager_count, 0) AS wager_count,
      COALESCE(w.total_volume, 0) AS total_volume,
      COALESCE(w.avg_wager, 0) AS avg_wager,
      COALESCE(w.max_wager, 0) AS max_wager,
      COALESCE(w.sport_count, 0) AS sport_count,
      julianday('now') - julianday(COALESCE(w.first_wager, 'now')) AS days_since_first,
      julianday('now') - julianday(COALESCE(w.last_wager, 'now')) AS days_since_last,
      CASE WHEN p.status = 'active' THEN 1 ELSE 0 END AS is_active
    FROM players p
    LEFT JOIN agents a ON a.provider = 'buckeye' AND a.login = p.agent_login
    LEFT JOIN (
      SELECT
        customer_id,
        COUNT(*) AS wager_count,
        SUM(amount_wagered) AS total_volume,
        AVG(amount_wagered) AS avg_wager,
        MAX(amount_wagered) AS max_wager,
        COUNT(DISTINCT sport) AS sport_count,
        MIN(insert_datetime) AS first_wager,
        MAX(insert_datetime) AS last_wager
      FROM wagers
      GROUP BY customer_id
    ) w ON w.customer_id = p.id
    WHERE p.provider = 'buckeye'
  `).all() as Array<Record<string, unknown>>;

  const featureJsonl = features.map((row) => JSON.stringify(row)).join('\n');
  await Bun.write(resolve(OUT_DIR, 'feature_matrix.jsonl'), featureJsonl);
  console.log(`   ✅ ${features.length} feature rows → feature_matrix.jsonl`);

  // ─── 5. Summary Stats ───────────────────────────────────────────────────
  const summary = {
    exported_at: new Date().toISOString(),
    counts: {
      players: players.length,
      agents: agents.length,
      wager_aggregates: wagerAgg.length,
      feature_rows: features.length,
    },
    files: [
      'players_enriched.jsonl',
      'agents.jsonl',
      'wager_aggregates.jsonl',
      'feature_matrix.jsonl',
    ],
  };
  await Bun.write(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(summary, null, 2));
  console.log(`   ✅ manifest.json`);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('📊 ML Dataset Export Complete');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Output: ${OUT_DIR}`);
  console.log(`\nLoad in Python:`);
  console.log(`  import pandas as pd`);
  console.log(`  df = pd.read_json('${OUT_DIR.replace(/\\/g, '/')}/feature_matrix.jsonl', lines=True)`);
  console.log(`  print(df.shape)  # ${features.length} rows x ${Object.keys(features[0] || {}).length} cols`);

  db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Export failed:', err);
  process.exit(1);
});
