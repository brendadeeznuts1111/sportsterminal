/**
 * Simple DB responsiveness test
 */
import { AppDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  console.log('Opening DB...');
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db'));
  console.log('DB opened');

  console.log('Querying wagers count...');
  const start = Date.now();
  const row = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM wagers');
  console.log(`Wagers: ${row?.count} (${Date.now() - start}ms)`);

  console.log('Querying customers...');
  const start2 = Date.now();
  const customers = await db.all('SELECT DISTINCT customer_id FROM wagers LIMIT 5');
  console.log(`Customers: ${customers.length} (${Date.now() - start2}ms)`);

  await db.close();
  console.log('Done');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
