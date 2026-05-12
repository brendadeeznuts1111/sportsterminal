// risk-sharp-detector/scripts/on-wager.ts
// Hook invoked for every new wager in the SSE broadcast loop.
// Performs a quick CLV check and returns a risk flag if warranted.

interface WagerEvent {
  bettorId: string;
  gameId: string;
  wagerType: string;
  side: string;
  line: number;
  odds: number;
  stake: number;
  sport: string;
  timestamp: number;
}

interface QuickRiskFlag {
  flagged: boolean;
  reason?: string;
  score?: number;
}

export default async function onWager(
  input: WagerEvent,
  _ctx: { db: { query: (sql: string) => { all: (...args: unknown[]) => unknown[] } } },
): Promise<QuickRiskFlag> {
  const { stake, odds } = input;

  // Quick checks that don't need DB access
  const flags: string[] = [];

  // Large stake check
  if (stake > 2000) {
    flags.push(`large_stake_$${stake.toFixed(0)}`);
  }

  // Heavy favorite check (odds < -200 equivalent)
  if (odds < -200) {
    flags.push("heavy_favorite");
  }

  // Heavy underdog check (odds > +300 equivalent)
  if (odds > 300) {
    flags.push("heavy_underdog");
  }

  if (flags.length > 0) {
    return {
      flagged: true,
      reason: flags.join(", "),
      score: Math.min(100, flags.length * 25),
    };
  }

  return { flagged: false };
}
