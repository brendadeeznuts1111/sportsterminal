/**
 * Migration: Add watermarks table for incremental polling.
 */
import { initDatabase } from '../../src/database';

async function run() {
  const db = await initDatabase();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS watermarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      last_value TEXT,
      last_pulled_at TEXT,
      metadata TEXT DEFAULT '{}',
      UNIQUE(provider, entity_type)
    );

    CREATE INDEX IF NOT EXISTS idx_watermarks_provider ON watermarks(provider, entity_type);
  `);

  console.log('✅ watermarks table created');

  // Seed initial watermarks
  await db.run(
    `INSERT OR IGNORE INTO watermarks (provider, entity_type, last_value, last_pulled_at, metadata)
     VALUES ('buckeye', 'access_logs', '0', NULL, '{}')`,
    []
  );

  console.log('✅ Initial watermarks seeded');
  await db.close();
}

run().catch((err) => { console.error(err); process.exit(1); });
