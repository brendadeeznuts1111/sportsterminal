import { initDatabase } from '../../src/database';

async function main() {
  const db = await initDatabase();
  const cols = await db.all('PRAGMA table_info(watermarks)');
  console.log('watermarks columns:', JSON.stringify(cols, null, 2));
  const rows = await db.all('SELECT * FROM watermarks');
  console.log('watermarks rows:', JSON.stringify(rows, null, 2));
  await db.close();
}

main().catch(console.error);
