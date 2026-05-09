/**
 * Standalone database migration script.
 * Run with: bun run db:migrate
 */

import { open } from 'sqlite';
import Database from 'sqlite3';
import { migrateDatabase } from '../src/database';

const dbPath = process.env.DATABASE_URL || './data/terminal.db';

async function main() {
  const db = await open({
    filename: dbPath,
    driver: Database.Database,
  });

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
