/**
 * Standalone database migration script.
 * Run with: bun run db:migrate
 */

import { AppDatabase, migrateDatabase, normalizeDatabasePath } from '../src/database';

const dbPath = normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db');

async function main() {
  const db = new AppDatabase(dbPath);

  await db.exec('PRAGMA foreign_keys = ON');
  console.log('📊 Database opened:', dbPath);

  await migrateDatabase(db);

  await db.close();
  console.log('✅ Migration complete');
}

main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
