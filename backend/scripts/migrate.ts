/**
 * Standalone database migration script.
 * Run with: bun run db:migrate
 */
import { initDatabase, migrateDatabase, normalizeDatabasePath } from '../src/database';
const dbPath = normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db');
async function main() {
  const db = await initDatabase(dbPath);
  console.log('📊 Database opened:', dbPath);
  await migrateDatabase(db);
  await db.close();
  console.log('✅ Migration complete');
}
main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
