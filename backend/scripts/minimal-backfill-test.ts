/**
 * Minimal feature backfill test
 */
import { AppDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db'));

  console.log('Getting customers...');
  const customers = await db.all<{ customer_id: string }>(
    `SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL LIMIT 10`
  );
  console.log(`Found ${customers.length} customers`);

  for (const { customer_id } of customers) {
    const start = Date.now();
    const wagers = await db.all(
      `SELECT amount_wagered, agent_login FROM wagers WHERE customer_id = ? LIMIT 100`,
      [customer_id]
    );
    console.log(`${customer_id}: ${wagers.length} wagers (${Date.now() - start}ms)`);
  }

  await db.close();
}

main();
