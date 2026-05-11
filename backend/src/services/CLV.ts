import type { Database } from '../database';

type WagerLike = {
  WagerNumber?: number;
  wager_number?: number;
  parsed_game?: string;
  parsed_market?: string;
  parsed_side?: string;
  parsed_price?: number;
};

export interface ClvResult {
  clvPercent: number;
  isBeater: boolean;
  closingOdds?: number;
  wagerOdds?: number;
  source: 'closing_lines' | 'line_movements' | 'none';
}

interface WagerLineRow {
  parsed_game?: string | null;
  parsed_market?: string | null;
  parsed_side?: string | null;
  parsed_price?: number | null;
  matched_event_id?: string | null;
}

interface ClosingLineRow {
  closing_odds: number | string;
}

export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) return 0;
  if (american > 0) return american / 100 + 1;
  return 100 / Math.abs(american) + 1;
}

export async function computeCLV(db: Database, wager: WagerLike): Promise<ClvResult> {
  const line = await resolveWagerLine(db, wager);
  if (!line?.parsed_game || !line.parsed_market || !line.parsed_side || !line.parsed_price) {
    return { clvPercent: 0, isBeater: false, source: 'none' };
  }

  const closing = await db.get<ClosingLineRow>(
    `SELECT closing_odds
     FROM closing_lines
     WHERE game_id = ?
       AND market = ?
       AND side = ?
     ORDER BY captured_at DESC
     LIMIT 1`,
    [line.parsed_game, line.parsed_market, line.parsed_side]
  );

  const closingOdds = Number(closing?.closing_odds);
  if (!Number.isFinite(closingOdds) || closingOdds === 0) {
    return { clvPercent: 0, isBeater: false, wagerOdds: Number(line.parsed_price), source: 'none' };
  }

  const wagerDec = americanToDecimal(Number(line.parsed_price));
  const closingDec = americanToDecimal(closingOdds);
  if (!wagerDec || !closingDec) {
    return { clvPercent: 0, isBeater: false, closingOdds, wagerOdds: Number(line.parsed_price), source: 'none' };
  }

  const clvPercent = Number(((wagerDec - closingDec) / closingDec * 100).toFixed(2));
  return {
    clvPercent,
    isBeater: clvPercent > 10,
    closingOdds,
    wagerOdds: Number(line.parsed_price),
    source: 'closing_lines',
  };
}

export async function fetchClosingLinesForGame(db: Database, gameId: string): Promise<number> {
  const rows = await db.all<{
    event_id: string;
    spread_home_price?: number | null;
    spread_away_price?: number | null;
    total_over_price?: number | null;
    total_under_price?: number | null;
    moneyline_home?: number | null;
    moneyline_away?: number | null;
  }>(
    `SELECT *
     FROM odds_snapshots
     WHERE event_id = ?
     ORDER BY scraped_at DESC`,
    [gameId]
  );

  let inserted = 0;
  for (const row of rows) {
    const candidates: Array<[string, string, number | null | undefined]> = [
      ['spread', 'home', row.spread_home_price],
      ['spread', 'away', row.spread_away_price],
      ['total', 'over', row.total_over_price],
      ['total', 'under', row.total_under_price],
      ['moneyline', 'home', row.moneyline_home],
      ['moneyline', 'away', row.moneyline_away],
    ];
    for (const [market, side, odds] of candidates) {
      if (!Number.isFinite(Number(odds)) || Number(odds) === 0) continue;
      const result = await db.run(
        `INSERT INTO closing_lines (game_id, market, side, closing_odds, source, captured_at)
         VALUES (?, ?, ?, ?, 'odds_snapshots', CURRENT_TIMESTAMP)
         ON CONFLICT(game_id, market, side) DO UPDATE SET
          closing_odds = excluded.closing_odds,
          source = excluded.source,
          captured_at = excluded.captured_at`,
        [gameId, market, side, Number(odds)]
      );
      inserted += result.changes;
    }
  }

  return inserted;
}

export async function refreshRecentClosingLines(db: Database): Promise<{ games: number; lines: number }> {
  const games = await db.all<{ id: string }>(
    `SELECT id
     FROM events
     WHERE start_time IS NOT NULL
       AND datetime(start_time) <= datetime('now')
       AND datetime(start_time) >= datetime('now', '-1 day')
     ORDER BY start_time DESC
     LIMIT 500`
  );

  let lines = 0;
  for (const game of games) {
    lines += await fetchClosingLinesForGame(db, game.id);
  }
  return { games: games.length, lines };
}

async function resolveWagerLine(db: Database, wager: WagerLike): Promise<WagerLineRow | null> {
  if (wager.parsed_game || wager.parsed_market || wager.parsed_side || wager.parsed_price) {
    return {
      parsed_game: String(wager.parsed_game || ''),
      parsed_market: String(wager.parsed_market || ''),
      parsed_side: String(wager.parsed_side || ''),
      parsed_price: Number(wager.parsed_price || 0),
    };
  }

  const wagerNumber = Number(wager.WagerNumber || wager.wager_number || 0);
  if (!wagerNumber) return null;
  return db.get<WagerLineRow>(
    `SELECT parsed_game, parsed_market, parsed_side, parsed_price, matched_event_id
     FROM wagers
     WHERE wager_number = ?
     LIMIT 1`,
    [wagerNumber]
  );
}
