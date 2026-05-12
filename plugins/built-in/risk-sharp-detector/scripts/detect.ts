// risk-sharp-detector/scripts/detect.ts
// Reads customer_id from stdin, writes risk JSON to stdout.
// Analyzes CLV (Closing Line Value), betting velocity, and odds movement.

interface WagerRow {
  bettorId: string;
  gameId: string;
  wagerType: string;
  side: string;
  line: number;
  odds: number;
  stake: number;
  profit: number;
  sport: string;
  timestamp: number;
}

interface LineMoveRow {
  gameId: string;
  lineType: string;
  side: string;
  oldLine: number;
  newLine: number;
  timestamp: number;
}

interface SharpResult {
  risk_score: number;
  confidence: number;
  factors: string[];
  details: {
    clv_score: number;
    velocity_score: number;
    odds_movement_score: number;
    wager_count: number;
    total_stake: number;
    win_rate: number;
  };
}

export default async function detect(
  input: { customer_id: string; lookback_hours?: number },
  ctx: { db: { query: (sql: string) => { all: (...args: unknown[]) => unknown[] } } },
): Promise<SharpResult> {
  const { customer_id, lookback_hours = 24 } = input;
  const db = ctx.db;

  const lookbackMs = lookback_hours * 3600 * 1000;
  const cutoff = Date.now() - lookbackMs;

  // Fetch wagers for this customer
  const wagers = db.query(`
    SELECT bettorId, gameId, wagerType, side, line, odds, stake, profit, sport, timestamp
    FROM wager_analytics
    WHERE bettorId = ?
    AND timestamp > ?
    ORDER BY timestamp DESC
  `).all(customer_id, Math.floor(cutoff / 1000)) as WagerRow[];

  if (wagers.length === 0) {
    return {
      risk_score: 0,
      confidence: 0,
      factors: ["insufficient_data"],
      details: {
        clv_score: 0,
        velocity_score: 0,
        odds_movement_score: 0,
        wager_count: 0,
        total_stake: 0,
        win_rate: 0,
      },
    };
  }

  // Compute CLV score: compare bet line to closing line movement
  let clvScore = 0;
  let clvCount = 0;
  for (const w of wagers) {
    const lineMoves = db.query(`
      SELECT gameId, lineType, side, oldLine, newLine, timestamp
      FROM line_history
      WHERE gameId = ? AND lineType = ? AND side = ?
      AND timestamp > ?
      ORDER BY timestamp
    `).all(w.gameId, w.wagerType, w.side, w.timestamp) as LineMoveRow[];

    if (lineMoves.length > 0) {
      const lastMove = lineMoves[lineMoves.length - 1];
      const movement = lastMove.newLine - lastMove.oldLine;
      // If line moved in bettor's favor, that's sharp
      const bettorFavorable = (w.side === "OVER" || w.side === "FAVORITE") ? movement > 0 : movement < 0;
      if (bettorFavorable) {
        clvScore += Math.abs(movement) * 10;
      }
      clvCount++;
    }
  }
  const normalizedClv = clvCount > 0 ? Math.min(100, (clvScore / clvCount) * 5) : 0;

  // Compute velocity score: bets per hour
  const hoursSpan = Math.max(1, lookback_hours);
  const betsPerHour = wagers.length / hoursSpan;
  const velocityScore = Math.min(100, betsPerHour * 20); // 5+ bets/hour = 100

  // Compute odds movement score: correlation between wager timing and line moves
  let oddsMovementScore = 0;
  const gameIds = [...new Set(wagers.map(w => w.gameId))];
  for (const gameId of gameIds) {
    const gameWagers = wagers.filter(w => w.gameId === gameId);
    const moves = db.query(`
      SELECT COUNT(*) as cnt FROM line_history
      WHERE gameId = ? AND timestamp > ?
    `).all(gameId, Math.floor(cutoff / 1000)) as Array<{ cnt: number }>;

    if (moves.length > 0 && moves[0].cnt > 3) {
      oddsMovementScore += Math.min(30, moves[0].cnt * 5);
    }
  }
  const normalizedOddsMovement = Math.min(100, oddsMovementScore);

  // Compute win rate
  const wins = wagers.filter(w => w.profit > 0).length;
  const winRate = wagers.length > 0 ? wins / wagers.length : 0;

  // Total stake
  const totalStake = wagers.reduce((sum, w) => sum + w.stake, 0);

  // Aggregate risk score (weighted)
  const riskScore = Math.round(
    normalizedClv * 0.4 +
    velocityScore * 0.3 +
    normalizedOddsMovement * 0.2 +
    (winRate > 0.55 ? 10 : 0)
  );

  // Confidence based on sample size
  const confidence = Math.min(100, Math.round(wagers.length * 5));

  // Factors
  const factors: string[] = [];
  if (normalizedClv > 50) factors.push("high_clv");
  if (velocityScore > 50) factors.push("high_velocity");
  if (normalizedOddsMovement > 50) factors.push("line_movement_correlation");
  if (winRate > 0.55) factors.push("high_win_rate");
  if (totalStake > 5000) factors.push("high_stakes");
  if (wagers.length < 5) factors.push("low_sample_size");

  return {
    risk_score: riskScore,
    confidence,
    factors,
    details: {
      clv_score: Math.round(normalizedClv),
      velocity_score: Math.round(velocityScore),
      odds_movement_score: Math.round(normalizedOddsMovement),
      wager_count: wagers.length,
      total_stake: Math.round(totalStake * 100) / 100,
      win_rate: Math.round(winRate * 1000) / 1000,
    },
  };
}
