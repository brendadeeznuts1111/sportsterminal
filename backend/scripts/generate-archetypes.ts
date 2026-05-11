import { AppDatabase, normalizeDatabasePath } from '../src/database';

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
  // Volume classification
  let volume: string;
  if (f.lifetime_wagers < 10) volume = 'casual';
  else if (f.lifetime_wagers < 50) volume = 'regular';
  else if (f.lifetime_wagers < 200) volume = 'grinder';
  else volume = 'high_volume';

  // Stake classification (in dollars)
  let stake: string;
  if (f.avg_wager_size < 5) stake = 'micro';
  else if (f.avg_wager_size < 25) stake = 'small';
  else if (f.avg_wager_size < 100) stake = 'medium';
  else if (f.avg_wager_size < 500) stake = 'large';
  else stake = 'whale';

  // Win rate classification
  let winRate: string;
  if (f.win_rate < 0.35) winRate = 'unlucky';
  else if (f.win_rate < 0.45) winRate = 'below_avg';
  else if (f.win_rate < 0.50) winRate = 'avg';
  else if (f.win_rate < 0.55) winRate = 'lucky';
  else winRate = 'sharp';

  // Recency classification
  let recency: string;
  const days = f.days_since_last_wager;
  if (days === null) recency = 'unknown';
  else if (days < 7) recency = 'active';
  else if (days < 30) recency = 'warm';
  else if (days < 90) recency = 'dormant';
  else recency = 'churned';

  // Sport diversity
  let diversity: string;
  const sportCount = Math.round((f.sport_diversity_score || 0) * 5);
  if (sportCount <= 1) diversity = 'specialist';
  else if (sportCount <= 3) diversity = 'focused';
  else diversity = 'diversified';

  // Consistency (based on max vs avg ratio)
  let consistency: string;
  if (f.avg_wager_size > 0) {
    const ratio = f.max_wager_size / f.avg_wager_size;
    if (ratio < 2) consistency = 'consistent';
    else if (ratio < 5) consistency = 'moderate';
    else consistency = 'erratic';
  } else {
    consistency = 'unknown';
  }

  // Composite archetype (most distinctive 3 dimensions)
  const parts = [volume, stake, winRate];
  if (recency !== 'active' && recency !== 'unknown') parts.push(recency);
  const composite = parts.join('_');

  return { volume, stake, win_rate: winRate, recency, diversity, consistency, composite };
}

async function main() {
  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));

  console.log('═══════════════════════════════════════════════════');
  console.log('🎭 GENERATING RICH ARCHETYPE LABELS');
  console.log('═══════════════════════════════════════════════════\n');

  const customers = await db.all<FeatureRow>(
    `SELECT customer_id, lifetime_wagers, avg_wager_size, max_wager_size, win_rate,
            sport_diversity_score, days_since_last_wager, sharp_score, feature_json, archetype
     FROM customer_features ORDER BY customer_id`
  );

  let updated = 0;
  const distribution: Record<string, number> = {};

  for (const c of customers) {
    const profile = computeArchetype(c);
    distribution[profile.composite] = (distribution[profile.composite] || 0) + 1;

    // Merge archetype breakdown into feature_json
    let existingJson: Record<string, unknown> = {};
    try {
      existingJson = JSON.parse(c.feature_json || '{}');
    } catch { /* ignore */ }

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

  console.log(`✅ Updated ${updated} customers with rich archetypes\n`);

  // Print distribution (top 20)
  const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log('📊 Top 20 Archetypes:');
  for (const [archetype, count] of sorted) {
    const pct = ((count / customers.length) * 100).toFixed(1);
    console.log(`   ${archetype.padEnd(35)} ${String(count).padStart(4)} (${pct}%)`);
  }

  // Summary stats
  console.log('\n📊 Dimension Breakdowns:');
  const dims = await db.all<{ dim: string; count: number }>(
    `SELECT json_extract(feature_json, '$.archetype_profile.volume') as dim, COUNT(*) as count
     FROM customer_features GROUP BY dim ORDER BY count DESC`
  );
  console.log('   Volume:', dims.map(d => `${d.dim}:${d.count}`).join(', '));

  const stakeDims = await db.all<{ dim: string; count: number }>(
    `SELECT json_extract(feature_json, '$.archetype_profile.stake') as dim, COUNT(*) as count
     FROM customer_features GROUP BY dim ORDER BY count DESC`
  );
  console.log('   Stake:', stakeDims.map(d => `${d.dim}:${d.count}`).join(', '));

  const recDims = await db.all<{ dim: string; count: number }>(
    `SELECT json_extract(feature_json, '$.archetype_profile.recency') as dim, COUNT(*) as count
     FROM customer_features GROUP BY dim ORDER BY count DESC`
  );
  console.log('   Recency:', recDims.map(d => `${d.dim}:${d.count}`).join(', '));

  await db.close();
}

main().catch((err) => {
  console.error('❌ Archetype generation failed:', err);
  process.exit(1);
});
