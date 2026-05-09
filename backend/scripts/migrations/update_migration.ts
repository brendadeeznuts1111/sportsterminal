/**
 * Update migration to handle existing access_logs table.
 */

import { initDatabase } from '../../src/database';

async function updateMigration() {
  const db = await initDatabase();

  // Check if agent_performance table exists
  const agentPerfExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_performance'");

  if (!agentPerfExists) {
    // Create agent_performance table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        performance_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_perf_agent ON agent_performance(agent_id, recorded_at);
    `);
    console.log('✅ Created agent_performance table');
  } else {
    console.log('ℹ️  agent_performance table already exists');
  }

  // Check if weekly_figures table exists
  const weeklyFiguresExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='weekly_figures'");

  if (!weeklyFiguresExists) {
    // Create weekly_figures table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS weekly_figures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        week_start_date TEXT NOT NULL,
        sport TEXT,
        handle REAL,
        win_loss REAL,
        wager_type TEXT,
        raw_json TEXT NOT NULL,
        ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_weekly_figures_agent ON weekly_figures(agent_id, week_start_date);
    `);
    console.log('✅ Created weekly_figures table');
  } else {
    console.log('ℹ️  weekly_figures table already exists');
  }

  // Check if master_snapshots table exists
  const masterSnapshotsExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='master_snapshots'");

  if (!masterSnapshotsExists) {
    // Create master_snapshots table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS master_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        balance INTEGER,
        available_balance INTEGER,
        percent_book REAL,
        account_info_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_master_snapshots_time ON master_snapshots(timestamp);
    `);
    console.log('✅ Created master_snapshots table');
  } else {
    console.log('ℹ️  master_snapshots table already exists');
  }

  // Check if audit_logs table exists
  const auditLogsExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'");

  if (!auditLogsExists) {
    // Create audit_logs table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        actor_id TEXT,
        actor_type TEXT,
        old_values TEXT,
        new_values TEXT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        ip_address TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);
    `);
    console.log('✅ Created audit_logs table');
  } else {
    console.log('ℹ️  audit_logs table already exists');
  }

  await db.close();
  console.log('\n✅ Migration update completed successfully');
}

updateMigration().catch((error) => {
  console.error('Migration update failed:', error);
  process.exit(1);
});
