import { AppDatabase, normalizeDatabasePath } from '../src/database';
import { ScriptLogger } from '../src/utils/scriptLogger';
import { formatMemoryUsage } from '../src/utils/bunUtils';

interface FeatureRow {
  customer_id: string;
  lifetime_wagers: number;
  avg_wager_size: number;
  max_wager_size: number;
  win_rate: number;
  sport_diversity_score: number;
  days_since_last_wager: number | null;
  sharp_score: number;
  feature_json: string;
  archetype: string;
}

interface ArchetypeProfile {
  volume: string;
  stake: string;
  win_rate: string;
  recency: string;
  diversity: string;
  consistency: string;
  composite: string;
}

function computeArchetype(f: FeatureRow): ArchetypeProfile {
  let volume: string;
  if (f.lifetime_wagers < 10) volume = 'casual';
  else if (f.lifetime_wagers < 50) volume = 'regular';
  else if (f.lifetime_wagers < 200) volume = 'grinder';
  else volume = 'high_volume';

  let stake: string;
  if (f.avg_wager_size < 5) stake = 'micro';
  else if (f.avg_wager_size < 25) stake = 'small';
  else if (f.avg_wager_size < 100) stake = 'medium';
  else if (f.avg_wager_size < 500) stake = 'large';
  else stake = 'whale';

  let winRate: string;
  if (f.win_rate < 0.35) winRate = 'unlucky';
  else if (f.win_rate < 0.45) winRate = 'below_avg';
  else if (f.win_rate < 0.50) winRate = 'avg';
  else if (f.win_rate < 0.55) winRate = 'lucky';
  else winRate = 'sharp';

  let recency: string;
  const days = f.days_since_last_wager;
  if (days === null) recency = 'unknown';
  else if (days < 7) recency = 'active';
  else if (days < 30) recency = 'warm';
  else if (days < 90) recency = 'dormant';
  else recency = 'churned';

  const sportCount = Math.round((f.sport_diversity_score || 0) * 5);
  const diversity = sportCount <= 1 ? 'specialist' : sportCount <= 3 ? 'focused' : 'diversified';

  let consistency: string;
  if (f.avg_wager_size > 0) {
    const ratio = f.max_wager_size / f.avg_wager_size;
    consistency = ratio < 2 ? 'consistent' : ratio < 5 ? 'moderate' : 'erratic';
  } else {
    consistency = 'unknown';
  }

  const parts = [volume, stake, winRate];
  if (recency !== 'active' && recency !== 'unknown') parts.push(recency);
  const composite = parts.join('_');

  return { volume, stake, win_rate: winRate, recency, diversity, consistency, composite };
}

async function main() {
  const log = new ScriptLogger();
  log.time('total');

  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));

  log.section('GENERATE ARCHETYPE LABELS');

  log.step('Loading customer features...');
  const customers = await db.all<FeatureRow>(
    `SELECT customer_id, lifetime_wagers, avg_wager_size, max_wager_size, win_rate,
            sport_diversity_score, days_since_last_wager, sharp_score, feature_json, archetype
     FROM customer_features ORDER BY customer_id`
  );
  log.result('Customers loaded', customers.length);

  log.subSection('Computing archetypes');
  let updated = 0;
  const distribution: Record<string, number> = {};

  for (const c of customers) {
    const profile = computeArchetype(c);
    distribution[profile.composite] = (distribution[profile.composite] || 0) + 1;

    let existingJson: Record<string, unknown> = {};
    try { existingJson = JSON.parse(c.feature_json || '{}'); } catch { /* ignore */ }

    const enrichedJson = {
      ...existingJson,
      archetype_profile: profile,
      previous_archetype: c.archetype,
    };

    await db.run(
      `UPDATE customer_features SET archetype = ?, feature_json = ? WHERE customer_id = ?`,
      [profile.composite, JSON.stringify(enrichedJson), c.customer_id]
    );
    updated++;
  }
  log.result('Archetypes updated', updated);

  log.subSection('Top 20 Archetype Distribution');
  const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]).slice(0, 20);
  log.table(
    sorted.map(([archetype, count]) => ({ archetype, count, pct: ((count / customers.length) * 100).toFixed(1) + '%' })),
    [
      { key: 'archetype', header: 'Archetype', format: (v) => String(v) },
      { key: 'count', header: 'Count', align: 'right', format: (v) => String(v) },
      { key: 'pct', header: '%', align: 'right' },
    ],
    { title: 'Archetype Distribution' }
  );

  if (distribution['casual_micro_sharp']) {
    log.info('Insight', `Casual micro sharp: ${distribution['casual_micro_sharp']} (${((distribution['casual_micro_sharp'] / customers.length) * 100).toFixed(1)}%) — sharp players at low stakes`);
  }

  log.subSection('Dimension Breakdowns');
  const dims = await db.all<{ dim: string; count: number }>(
    `SELECT json_extract(feature_json, '$.archetype_profile.volume') as dim, COUNT(*) as count FROM customer_features GROUP BY dim ORDER BY count DESC`
  );
  log.step(`Volume: ${dims.map(d => `${d.dim}:${d.count}`).join(', ')}`);

  const stakeDims = await db.all<{ dim: string; count: number }>(
    `SELECT json_extract(feature_json, '$.archetype_profile.stake') as dim, COUNT(*) as count FROM customer_features GROUP BY dim ORDER BY count DESC`
  );
  log.step(`Stake: ${stakeDims.map(d => `${d.dim}:${d.count}`).join(', ')}`);

  const recDims = await db.all<{ dim: string; count: number }>(
    `SELECT json_extract(feature_json, '$.archetype_profile.recency') as dim, COUNT(*) as count FROM customer_features GROUP BY dim ORDER BY count DESC`
  );
  log.step(`Recency: ${recDims.map(d => `${d.dim}:${d.count}`).join(', ')}`);

  log.timeEnd('total');
  log.summary([
    { label: 'Customers processed', value: customers.length, status: 'ok' },
    { label: 'Unique archetypes', value: Object.keys(distribution).length, status: 'ok' },
    { label: 'Top archetype', value: sorted[0]?.[0] ?? 'none', status: 'ok' },
    { label: 'Memory', value: formatMemoryUsage(), status: 'ok' },
  ]);

  await db.close();
}

main().catch((err) => {
  console.error('❌ Archetype generation failed:', err);
  process.exit(1);
});
