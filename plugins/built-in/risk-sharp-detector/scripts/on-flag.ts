// risk-sharp-detector/scripts/on-flag.ts
// Hook invoked when a risk flag is raised on a player.
// Correlates with existing syndicate data.

interface FlagEvent {
  player_id: string;
  flag_type: string;
  reason: string;
  timestamp: number;
}

interface FlagAnalysis {
  escalated: boolean;
  syndicate_match: boolean;
  recommendation: string;
}

export default async function onFlag(
  input: FlagEvent,
  ctx: { db: { query: (sql: string) => { all: (...args: unknown[]) => unknown[] } } },
): Promise<FlagAnalysis> {
  const { player_id } = input;
  const db = ctx.db;

  // Check if this player appears in any syndicate cache
  const syndicates = db.query(`
    SELECT id, pattern, members, riskScore
    FROM syndicate_cache
    WHERE members LIKE ?
    ORDER BY detected_at DESC
    LIMIT 5
  `).all(`%${player_id}%`) as Array<{
    id: string;
    pattern: string;
    members: string;
    riskScore: number;
  }>;

  if (syndicates.length > 0) {
    const maxRisk = Math.max(...syndicates.map(s => s.riskScore));
    return {
      escalated: maxRisk > 50,
      syndicate_match: true,
      recommendation: maxRisk > 70
        ? "IMMEDIATE_REVIEW: Player linked to high-risk syndicate"
        : "MONITOR: Player has syndicate associations",
    };
  }

  return {
    escalated: false,
    syndicate_match: false,
    recommendation: "STANDARD: No syndicate links found",
  };
}
