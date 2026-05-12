/**
 * Quick test of feature extraction speed
 */
import { AppDatabase, migrateDatabase, normalizeDatabasePath } from '../src/database';
import { LiveFeatureService } from '../src/services/LiveFeatureService';

async function main() {
  const db = new AppDatabase(normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db'));
  await migrateDatabase(db);
  const service = new LiveFeatureService(db);

  console.log('Testing feature extraction for 5 customers...');
  const customers = await db.all<{ customer_id: string }>(
    'SELECT DISTINCT customer_id FROM wagers WHERE customer_id IS NOT NULL LIMIT 5'
  );

  for (const c of customers) {
    const start = Date.now();
    try {
      await service.extractFeaturesForCustomer(c.customer_id);
      console.log(`  ${c.customer_id}: done in ${Date.now() - start}ms`);
    } catch (err) {
      console.log(`  ${c.customer_id}: failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const count = await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM customer_features');
  console.log(`Total features now: ${count?.count || 0}`);
  await db.close();
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
