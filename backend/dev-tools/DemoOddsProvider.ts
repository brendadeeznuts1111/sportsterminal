/**
 * DemoOddsProvider
 * Generates realistic odds data for development/demo mode.
 * Simulates line movements over time so the grid feels alive.
 *
 * Moved to dev-tools/ — not included in production builds.
 * Import conditionally via ODDS_DEMO_MODE env flag.
 */

import type { OddsProvider, GameEvent, EventOdds, BookOdds, BookHealth, LineMovement } from '../src/odds/types';

const BOOKS = ['DK', 'FD', 'MGM', 'CZR', 'PB', 'BR', 'BS', 'PIN', 'SBO', 'STK', 'NIT', 'BOL', 'BOV', 'BUC', 'ACE', 'MET'];

const GAMES: GameEvent[] = [
  { id: 'nba-001', sport: 'NBA', league: 'NBA', homeTeam: 'Knicks', awayTeam: '76ers', startTime: '2026-05-08T19:00:00Z', status: 'upcoming' },
  { id: 'nba-002', sport: 'NBA', league: 'NBA', homeTeam: 'Timberwolves', awayTeam: 'Spurs', startTime: '2026-05-08T19:30:00Z', status: 'upcoming' },
  { id: 'nba-003', sport: 'NBA', league: 'NBA', homeTeam: 'Celtics', awayTeam: 'Lakers', startTime: '2026-05-08T20:00:00Z', status: 'upcoming' },
  { id: 'ncaab-001', sport: 'NCAAB', league: 'NCAAB', homeTeam: 'Duke', awayTeam: 'North Carolina', startTime: '2026-05-08T18:00:00Z', status: 'upcoming' },
  { id: 'mlb-001', sport: 'MLB', league: 'MLB', homeTeam: 'Dodgers', awayTeam: 'Braves', startTime: '2026-05-08T20:00:00Z', status: 'upcoming' },
  { id: 'mlb-002', sport: 'MLB', league: 'MLB', homeTeam: 'Red Sox', awayTeam: 'Rays', startTime: '2026-05-08T20:05:00Z', status: 'upcoming' },
  { id: 'mlb-003', sport: 'MLB', league: 'MLB', homeTeam: 'Yankees', awayTeam: 'Astros', startTime: '2026-05-08T21:00:00Z', status: 'upcoming' },
  { id: 'nhl-001', sport: 'NHL', league: 'NHL', homeTeam: 'Oilers', awayTeam: 'Avalanche', startTime: '2026-05-08T21:00:00Z', status: 'upcoming' },
  { id: 'nhl-002', sport: 'NHL', league: 'NHL', homeTeam: 'Rangers', awayTeam: 'Lightning', startTime: '2026-05-08T21:30:00Z', status: 'upcoming' },
  { id: 'nfl-001', sport: 'NFL', league: 'NFL', homeTeam: 'Chiefs', awayTeam: '49ers', startTime: '2026-05-09T17:00:00Z', status: 'upcoming' },
  { id: 'soccer-001', sport: 'Soccer', league: 'EPL', homeTeam: 'Arsenal', awayTeam: 'Man City', startTime: '2026-05-09T14:00:00Z', status: 'upcoming' },
  { id: 'soccer-002', sport: 'Soccer', league: 'UCL', homeTeam: 'Real Madrid', awayTeam: 'Bayern Munich', startTime: '2026-05-09T19:45:00Z', status: 'upcoming' },
];

// Base lines for each game
const BASE_LINES: Record<string, { spread: number; total: number; mlHome: number; mlAway: number }> = {
  'nba-001': { spread: -2.5, total: 214, mlHome: -135, mlAway: 115 },
  'nba-002': { spread: -4.5, total: 217, mlHome: -200, mlAway: 170 },
  'nba-003': { spread: -3.0, total: 225, mlHome: -155, mlAway: 130 },
  'ncaab-001': { spread: -1.5, total: 145, mlHome: -125, mlAway: 105 },
  'mlb-001': { spread: -1.5, total: 8, mlHome: -115, mlAway: 101 },
  'mlb-002': { spread: 1.5, total: 8.5, mlHome: 105, mlAway: -125 },
  'mlb-003': { spread: -1.5, total: 7.5, mlHome: -140, mlAway: 120 },
  'nhl-001': { spread: -1.5, total: 5.5, mlHome: -140, mlAway: 120 },
  'nhl-002': { spread: 1.5, total: 6.0, mlHome: 110, mlAway: -130 },
  'nfl-001': { spread: -3.0, total: 47.5, mlHome: -165, mlAway: 140 },
  'soccer-001': { spread: 0.5, total: 2.5, mlHome: -110, mlAway: 100 },
  'soccer-002': { spread: -0.5, total: 3.0, mlHome: 120, mlAway: -140 },
};

export class DemoOddsProvider implements OddsProvider {
  name = 'demo';
  private tickCount = 0;
  private previousLines: Map<string, BookOdds> = new Map();

  async fetchOdds(): Promise<EventOdds[]> {
    this.tickCount++;
    const result: EventOdds[] = [];

    for (const game of GAMES) {
      const base = BASE_LINES[game.id];
      if (!base) continue;

      const spreadJitter = (Math.random() - 0.5) * 0.5;
      const totalJitter = (Math.random() - 0.5) * 1.0;
      const mlJitter = (Math.random() - 0.5) * 10;

      const books: BookOdds[] = BOOKS.map((book, idx) => {
        const isSharp = ['PIN', 'SBO', 'STK', 'BOL'].includes(book);
        const spread = base.spread + spreadJitter + (isSharp ? 0 : (Math.random() - 0.5) * 0.5);
        const total = base.total + totalJitter + (isSharp ? 0 : (Math.random() - 0.5) * 1.0);
        const mlHome = base.mlHome + mlJitter + (isSharp ? 0 : (Math.random() - 0.5) * 15);
        const mlAway = base.mlAway + mlJitter + (isSharp ? 0 : (Math.random() - 0.5) * 15);

        return {
          book,
          spreadHome: Math.round(spread * 10) / 10,
          spreadAway: Math.round(-spread * 10) / 10,
          spreadHomePrice: -110,
          spreadAwayPrice: -110,
          totalOver: Math.round(total * 10) / 10,
          totalUnder: Math.round(total * 10) / 10,
          totalOverPrice: -110,
          totalUnderPrice: -110,
          moneylineHome: Math.round(mlHome),
          moneylineAway: Math.round(mlAway),
        };
      });

      result.push({
        event: {
          id: game.id,
          sport: game.sport,
          league: game.league,
          homeTeam: game.homeTeam,
          awayTeam: game.awayTeam,
          startTime: game.startTime,
          status: game.status,
        },
        books,
      });
    }

    return result;
  }

  detectMovements(currentOdds: EventOdds[]): LineMovement[] {
    const movements: LineMovement[] = [];

    for (const event of currentOdds) {
      for (const book of event.books) {
        const key = `${event.event.id}:${book.book}`;
        const prev = this.previousLines.get(key);

        if (prev) {
          const spreadChange = prev.spreadHome !== book.spreadHome ? (book.spreadHome ?? 0) - (prev.spreadHome ?? 0) : 0;
          const totalChange = prev.totalOver !== book.totalOver ? (book.totalOver ?? 0) - (prev.totalOver ?? 0) : 0;
          const mlHomeChange = prev.moneylineHome !== book.moneylineHome ? (book.moneylineHome ?? 0) - (prev.moneylineHome ?? 0) : 0;

          if (spreadChange !== 0) {
            movements.push({
              eventId: event.event.id,
              book: book.book,
              market: 'spread',
              side: spreadChange > 0 ? 'home' : 'away',
              oldValue: prev.spreadHome ?? 0,
              newValue: book.spreadHome ?? 0,
              delta: spreadChange,
              recordedAt: new Date().toISOString(),
            });
          }
          if (totalChange !== 0) {
            movements.push({
              eventId: event.event.id,
              book: book.book,
              market: 'total',
              side: totalChange > 0 ? 'over' : 'under',
              oldValue: prev.totalOver ?? 0,
              newValue: book.totalOver ?? 0,
              delta: totalChange,
              recordedAt: new Date().toISOString(),
            });
          }
          if (mlHomeChange !== 0) {
            movements.push({
              eventId: event.event.id,
              book: book.book,
              market: 'moneyline',
              side: mlHomeChange > 0 ? 'home' : 'away',
              oldValue: prev.moneylineHome ?? 0,
              newValue: book.moneylineHome ?? 0,
              delta: mlHomeChange,
              recordedAt: new Date().toISOString(),
            });
          }
        }

        this.previousLines.set(key, { ...book });
      }
    }

    return movements;
  }

  async checkHealth(): Promise<BookHealth[]> {
    return BOOKS.map((book) => ({
      book,
      status: 'online' as const,
      lastSeen: new Date().toISOString(),
      errorCount: 0,
      lastError: null,
    }));
  }
}
