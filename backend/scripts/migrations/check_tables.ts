/**
 * Check if audit analytics tables exist.
 */

import { initDatabase } from '../../src/database';

async function checkTables() {
  const db = await initDatabase();

  const tables = await db.all<{ name: string }>(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND (
        name LIKE '%audit%'
        OR name LIKE '%archive%'
        OR name LIKE '%logs%'
        OR name LIKE '%snapshots%'
        OR name LIKE '%figures%'
        OR name LIKE '%performance%'
        OR name = 'scheduler_state'
        OR name = 'watermarks'
        OR name = 'schema_migrations'
      )
    ORDER BY name
  `);

  console.log('Existing tables:');
  for (const table of tables) {
    console.log(`  - ${table.name}`);

    const columns = await db.all<{ name: string }>(`PRAGMA table_info(${table.name})`);
    console.log(`    Columns: ${columns.map((c) => c.name).join(', ')}`);
  }

  await db.close();
}

checkTables().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
