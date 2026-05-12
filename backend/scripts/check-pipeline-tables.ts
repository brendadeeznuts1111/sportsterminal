/**
 * Check data pipeline tables
 */
import { AppDatabase, migrateDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db'));
  await migrateDatabase(db);

  const tables = [
    'closing_lines',
    'access_logs',
    'failed_logins',
    'account_change_logs',
    'agent_rules',
    'agent_actions',
    'alerts',
  ];

  for (const table of tables) {
    try {
      const row = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
      console.log(`${table}: ${row?.count || 0}`);
    } catch (err) {
      console.log(`${table}: MISSING`);
    }
  }

  await db.close();
}

main();
