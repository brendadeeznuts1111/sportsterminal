import { initDatabase } from '../../src/database';

async function main() {
  const db = await initDatabase();
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('deposits','customer_snapshots','player_links','player_flags','player_notes')");
  console.log('Tables found:', JSON.stringify(tables.map((t: any) => t.name)));
  for (const name of ['deposits', 'customer_snapshots', 'player_links', 'player_flags', 'player_notes']) {
    const cols = await db.all(`PRAGMA table_info(${name})`);
    if (cols.length > 0) console.log(`${name}:`, cols.map((c: any) => c.name).join(', '));
    else console.log(`${name}: NOT FOUND`);
  }
  await db.close();
}

main().catch(console.error);
