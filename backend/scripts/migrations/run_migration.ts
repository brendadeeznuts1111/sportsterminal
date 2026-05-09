/**
 * Run database migration for audit analytics tables.
 */

import { initDatabase } from '../../src/database';

async function runMigration() {
  const db = await initDatabase();
  const migrationUrl = new URL('./add_audit_analytics_tables.sql', import.meta.url);
  const sql = await Bun.file(migrationUrl).text();

  await db.exec(sql);
  console.log('✅ Migration completed successfully');
  console.log(
    'Tables ensured: raw_api_logs, wager_archive, access_logs, master_snapshots, weekly_figures, agent_performance, scheduler_state, audit_logs'
  );

  await db.close();
}

runMigration().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
