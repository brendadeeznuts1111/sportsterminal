/**
 * Check customer_features schema
 */
import { AppDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db'));
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(customer_features)`);
  console.log('customer_features columns:');
  for (const row of rows) {
    console.log(`  ${row.name}`);
  }
  await db.close();
}

main();
