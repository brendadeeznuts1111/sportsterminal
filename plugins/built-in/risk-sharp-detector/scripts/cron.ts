// risk-sharp-detector/scripts/cron.ts
// Periodic cron job: scans recent wagers for sharp patterns.
// Runs every 15 minutes.

interface CronResult {
  players_analyzed: number;
  high_risk_count: number;
  alerts_generated: number;
  top_risks: Array<{ player_id: string; score: number; factors: string[] }>;
}

export default async function cron(
  _input: Record<string, never>,
  ctx: { db: { query: (sql: string) => { all: (...args: unknown[]) => unknown[] } } },
): Promise<CronResult> {
  const db = ctx.db;
  const cutoff = Math.floor((Date.now() - 15 * 60 * 1000) / 1000); // Last 15 min

  // Get distinct bettors with recent activity
  const activeBettors = db.query(`
    SELECT DISTINCT bettorId, COUNT(*) as wager_count, SUM(stake) as total_stake
    FROM wager_analytics
    WHERE timestamp > ?
    GROUP BY bettorId
    HAVING wager_count >= 3
    ORDER BY total_stake DESC
    LIMIT 50
  `).all(cutoff) as Array<{
    bettorId: string;
    wager_count: number;
    total_stake: number;
  }>;

  const topRisks: Array<{ player_id: string; score: number; factors: string[] }> = [];
  let highRiskCount = 0;

  for (const bettor of activeBettors) {
    const factors: string[] = [];

    // Velocity check
    if (bettor.wager_count >= 10) factors.push("extreme_velocity");
    else if (bettor.wager_count >= 5) factors.push("high_velocity");

    // Stake check
    if (bettor.total_stake > 10000) factors.push("very_high_stakes");
    else if (bettor.total_stake > 5000) factors.push("high_stakes");

    if (factors.length > 0) {
      const score = Math.min(100, factors.length * 30 + bettor.wager_count * 2);
      if (score > 40) highRiskCount++;
      topRisks.push({
        player_id: bettor.bettorId,
        score,
        factors,
      });
    }
  }

  // Sort by score descending
  topRisks.sort((a, b) => b.score - a.score);

  return {
    players_analyzed: activeBettors.length,
    high_risk_count: highRiskCount,
    alerts_generated: topRisks.length,
    top_risks: topRisks.slice(0, 10),
  };
}
