/**
 * Quick index check
 */
import { AppDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db'));

  const indexes = await db.all<{ name: string; tbl_name: string; sql: string }>(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('wagers', 'customer_features', 'closing_lines', 'access_logs')`
  );

  console.log('Key indexes:');
  for (const idx of indexes) {
    console.log(`  ${idx.tbl_name}.${idx.name}`);
  }

  await db.close();
}

main();
