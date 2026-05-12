import { AppDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));

  console.log('Creating plugin_execution_log table...');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_execution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_name TEXT NOT NULL,
      hook_name TEXT NOT NULL,
      wager_number INTEGER,
      customer_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'success',
      duration_ms INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_plugin_exec_plugin ON plugin_execution_log(plugin_name, created_at DESC)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_plugin_exec_hook ON plugin_execution_log(hook_name, created_at DESC)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_plugin_exec_wager ON plugin_execution_log(wager_number, created_at DESC)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_plugin_exec_customer ON plugin_execution_log(customer_id, created_at DESC)`);

  // Also add trace_id to ai_risk_flags if not exists
  const cols = await db.all<{ name: string }>("PRAGMA table_info(ai_risk_flags)");
  const hasTraceId = cols.some((c: any) => c.name === 'trace_id');
  if (!hasTraceId) {
    console.log('Adding trace_id to ai_risk_flags...');
    await db.exec('ALTER TABLE ai_risk_flags ADD COLUMN trace_id TEXT');
  }

  console.log('✅ Migration complete');
  await db.close();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
