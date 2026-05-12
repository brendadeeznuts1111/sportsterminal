/**
 * Quick DB Check
 */
import { AppDatabase, migrateDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db'));
  await migrateDatabase(db);

  const agents = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agents');
  const players = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM players');
  const hierarchy = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agent_hierarchy');
  const pam = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM player_agent_map');
  const closure = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agent_closure');
  const features = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM customer_features');
  const snapshots = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM customer_snapshots');
  const checkpoints = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM ingestion_checkpoints');

  console.log('agents:', agents?.count);
  console.log('players:', players?.count);
  console.log('agent_hierarchy:', hierarchy?.count);
  console.log('player_agent_map:', pam?.count);
  console.log('agent_closure:', closure?.count);
  console.log('customer_features:', features?.count);
  console.log('customer_snapshots:', snapshots?.count);
  console.log('ingestion_checkpoints:', checkpoints?.count);

  await db.close();
}

main();
