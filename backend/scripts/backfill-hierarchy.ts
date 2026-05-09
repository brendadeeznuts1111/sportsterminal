/**
 * Backfill normalized Buckeye agents/players from ignored local exports.
 * Run with: bun run backfill:hierarchy
 */

import { AppDatabase, migrateDatabase, normalizeDatabasePath } from '../src/database';
import { backfillAgentsAndPlayers } from '../src/services/HierarchyBackfillService';

const dbPath = normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db');

async function main() {
  const db = new AppDatabase(dbPath);

  await db.exec('PRAGMA foreign_keys = ON');
  await migrateDatabase(db);

  const result = await backfillAgentsAndPlayers(db);
  await db.close();

  console.log(
    `✅ Backfilled ${result.agents} agents, ${result.players} players, ` +
    `${result.placeholderAgents} placeholder agents. Max seq: ${result.maxSeqNumber}`
  );
}

main().catch((err) => {
  console.error('❌ Hierarchy backfill failed:', err);
  process.exit(1);
});
