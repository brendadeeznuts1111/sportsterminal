import { AppDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));
  await db.run("DELETE FROM player_notes WHERE created_by = 'system-backfill'");
  await db.run('DELETE FROM player_links');
  await db.run('DELETE FROM source_freshness');
  console.log('Cleared backfilled notes, links, and freshness');
  await db.close();
}
main();
