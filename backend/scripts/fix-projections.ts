/**
 * Data Infill — Fix Projection Tables
 *
 * Re-runs syncAgentProjectionTables and rebuildAgentClosure
 * for cases where the backfill populated agents/players but
 * not the projection tables.
 */

import { AppDatabase, migrateDatabase, normalizeDatabasePath } from '../src/database';
import { syncAgentProjectionTables, rebuildAgentClosure } from '../src/services/HierarchyBackfillService';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db'));
  await db.exec('PRAGMA foreign_keys = ON');
  await migrateDatabase(db);

  console.log('🔧 Fixing projection tables...\n');

  const before = {
    agents: (await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agents'))?.count || 0,
    players: (await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM players'))?.count || 0,
    hierarchy: (await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agent_hierarchy'))?.count || 0,
    pam: (await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM player_agent_map'))?.count || 0,
    closure: (await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agent_closure'))?.count || 0,
  };

  console.log('Before:');
  console.log(`  agents:          ${before.agents}`);
  console.log(`  players:         ${before.players}`);
  console.log(`  agent_hierarchy: ${before.hierarchy}`);
  console.log(`  player_agent_map: ${before.pam}`);
  console.log(`  agent_closure:   ${before.closure}`);

  await syncAgentProjectionTables(db, 'hierarchy_backfill');
  console.log('\n✅ Synced agent_hierarchy + player_agent_map');

  await rebuildAgentClosure(db);
  console.log('✅ Rebuilt agent_closure');

  const after = {
    hierarchy: (await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agent_hierarchy'))?.count || 0,
    pam: (await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM player_agent_map'))?.count || 0,
    closure: (await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agent_closure'))?.count || 0,
  };

  console.log('\nAfter:');
  console.log(`  agent_hierarchy: ${after.hierarchy} (+${after.hierarchy - before.hierarchy})`);
  console.log(`  player_agent_map: ${after.pam} (+${after.pam - before.pam})`);
  console.log(`  agent_closure:   ${after.closure} (+${after.closure - before.closure})`);

  await db.close();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
