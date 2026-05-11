import { AppDatabase, normalizeDatabasePath } from '../src/database';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));
  console.log('Clearing existing risk data...');
  await db.run('DELETE FROM wager_violations');
  await db.run('DELETE FROM risk_positions');
  await db.run('DELETE FROM player_flags');
  console.log('Cleared wager_violations, risk_positions, player_flags');
  await db.close();
}
main();
