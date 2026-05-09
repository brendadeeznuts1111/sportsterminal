/**
 * DemoOddsProvider
 * Generates realistic odds data for development/demo mode.
 * Simulates line movements over time so the grid feels alive.
 */

import type { OddsProvider, GameEvent, EventOdds, BookOdds, BookHealth, LineMovement } from '../types';

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

    for (const event of GAMES) {
      const base = BASE_LINES[event.id];
      const books: BookOdds[] = [];

      for (const book of BOOKS) {
        const odds = this.generateBookOdds(event.id, book, base);
        books.push(odds);
        this.previousLines.set(`${event.id}:${book}`, odds);
      }

      result.push({ event, books });
    }

    return result;
  }

  async checkHealth(): Promise<BookHealth[]> {
    // Simulate occasional book degradation
    return BOOKS.map((book) => {
      const rand = Math.random();
      let status: BookHealth['status'] = 'online';
      if (rand > 0.95) status = 'offline';
      else if (rand > 0.90) status = 'degraded';

      return {
        book,
        status,
        lastSeen: new Date().toISOString(),
        errorCount: status === 'offline' ? Math.floor(Math.random() * 5) : 0,
        lastError: status === 'offline' ? 'Connection timeout' : null,
      };
    });
  }

  /**
   * Compare current odds with previous snapshot and return movements.
   */
  detectMovements(current: EventOdds[]): LineMovement[] {
    const movements: LineMovement[] = [];

    for (const ev of current) {
      for (const book of ev.books) {
        const key = `${ev.event.id}:${book.book}`;
        const prev = this.previousLines.get(key);
        if (!prev) continue;

        const now = new Date().toISOString();

        // Spread
        if (book.spreadHome !== null && prev.spreadHome !== null && book.spreadHome !== prev.spreadHome) {
          movements.push({
            eventId: ev.event.id, book: book.book, market: 'spread', side: 'home',
            oldValue: prev.spreadHome, newValue: book.spreadHome,
            delta: book.spreadHome - prev.spreadHome, recordedAt: now,
          });
        }

        // Total
        if (book.totalOver !== null && prev.totalOver !== null && book.totalOver !== prev.totalOver) {
          movements.push({
            eventId: ev.event.id, book: book.book, market: 'total', side: 'over',
            oldValue: prev.totalOver, newValue: book.totalOver,
            delta: book.totalOver - prev.totalOver, recordedAt: now,
          });
        }

        // Moneyline home
        if (book.moneylineHome !== null && prev.moneylineHome !== null && book.moneylineHome !== prev.moneylineHome) {
          movements.push({
            eventId: ev.event.id, book: book.book, market: 'moneyline', side: 'home',
            oldValue: prev.moneylineHome, newValue: book.moneylineHome,
            delta: book.moneylineHome - prev.moneylineHome, recordedAt: now,
          });
        }
      }
    }

    return movements;
  }

  private generateBookOdds(eventId: string, book: string, base: { spread: number; total: number; mlHome: number; mlAway: number }): BookOdds {
    // Each book has a slightly different line
    const spreadJitter = this.jitter(0.5, book);
    const totalJitter = this.jitter(1, book);
    const mlJitter = this.jitter(15, book);

    // Occasionally a book is significantly different (sharp vs square)
    const isSharp = ['PIN', 'SBO', 'STK'].includes(book);
    const sharpFactor = isSharp ? 0.3 : 1.0;

    // Simulate line movement over time
    const timeDrift = Math.sin(this.tickCount * 0.1 + book.charCodeAt(0)) * 0.3;

    const spreadHome = Math.round((base.spread + spreadJitter * sharpFactor + timeDrift) * 2) / 2;
    const spreadAway = -spreadHome;

    const totalOver = Math.round((base.total + totalJitter * sharpFactor + timeDrift) * 2) / 2;
    const totalUnder = totalOver;

    const mlHome = Math.round(base.mlHome + mlJitter * sharpFactor + timeDrift * 10);
    const mlAway = Math.round(base.mlAway - mlJitter * sharpFactor - timeDrift * 10);

    // Generate realistic prices (juice) for spreads and totals
    // Sharp books offer better prices; square books charge more vig
    const priceJitter = Math.round(this.jitter(5, book + 'price'));
    const basePrice = isSharp ? -105 : -110;
    const spreadHomePrice = basePrice + priceJitter;
    const spreadAwayPrice = basePrice + (isSharp ? priceJitter : priceJitter + 5);
    const totalOverPrice = basePrice + priceJitter;
    const totalUnderPrice = basePrice + (isSharp ? priceJitter : priceJitter + 5);

    return {
      book,
      spreadHome,
      spreadAway,
      spreadHomePrice,
      spreadAwayPrice,
      totalOver,
      totalUnder,
      totalOverPrice,
      totalUnderPrice,
      moneylineHome: mlHome,
      moneylineAway: mlAway,
    };
  }

  private jitter(max: number, seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(i);
      hash |= 0;
    }
    const pseudo = Math.abs(Math.sin(hash + this.tickCount * 0.05));
    return (pseudo - 0.5) * 2 * max;
  }
}
