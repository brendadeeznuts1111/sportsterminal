/**
 * Backfill normalized Buckeye agents/players from ignored local exports.
 * Run with: bun run backfill:hierarchy
 */

import { AppDatabase, migrateDatabase, normalizeDatabasePath } from '../src/database';
import { backfillAgentsAndPlayers } from '../src/services/HierarchyBackfillService';

const dbPath = normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db');
const args = parseArgs(Bun.argv.slice(2));

async function main() {
  const db = new AppDatabase(dbPath);

  await db.exec('PRAGMA foreign_keys = ON');
  await migrateDatabase(db);

  const result = await backfillAgentsAndPlayers(db, {
    agentPaths: args.agents ? [args.agents] : undefined,
    playerPaths: args.players ? [args.players] : undefined,
    source: args.agents || args.players ? 'local_seed_cli' : 'hierarchy_backfill',
  });
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

function parseArgs(argv: string[]): { agents?: string; players?: string } {
  const parsed: { agents?: string; players?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agents') parsed.agents = argv[++i];
    else if (arg.startsWith('--agents=')) parsed.agents = arg.slice('--agents='.length);
    else if (arg === '--players') parsed.players = argv[++i];
    else if (arg.startsWith('--players=')) parsed.players = arg.slice('--players='.length);
  }
  return parsed;
}
