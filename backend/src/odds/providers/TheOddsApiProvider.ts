/**
 * TheOddsApiProvider
 * Skeleton for integrating with the-odds-api.com
 * Set ODDS_API_KEY env var to enable.
 */

import type { OddsProvider, GameEvent, EventOdds, BookOdds, BookHealth } from '../types';

const API_BASE = 'https://api.the-odds-api.com/v4';
const BOOK_MAP: Record<string, string> = {
  draftkings: 'DK',
  fanduel: 'FD',
  betmgm: 'MGM',
  caesars: 'CZR',
  pointsbetus: 'PB',
  betrivers: 'BR',
  betus: 'BS',
  pinnacle: 'PIN',
  bovada: 'BOV',
  mybookieag: 'MB',
  wynnbet: 'WYN',
};

export class TheOddsProvider implements OddsProvider {
  name = 'the-odds-api';
  private apiKey: string;
  private sport: string;

  constructor(apiKey: string, sport: string = 'basketball_nba') {
    this.apiKey = apiKey;
    this.sport = sport;
  }

  async fetchOdds(): Promise<EventOdds[]> {
    const url = `${API_BASE}/sports/${this.sport}/odds?apiKey=${this.apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`TheOddsAPI error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.map((item: any) => this.mapEvent(item));
  }

  async checkHealth(): Promise<BookHealth[]> {
    const books = Object.values(BOOK_MAP);
    return books.map((book) => ({
      book,
      status: 'unknown' as const,
      lastSeen: null,
      errorCount: 0,
      lastError: null,
    }));
  }

  private mapEvent(item: any): EventOdds {
    const event: GameEvent = {
      id: item.id,
      sport: item.sport_title || 'Unknown',
      league: item.sport_key || '',
      homeTeam: item.home_team,
      awayTeam: item.away_team,
      startTime: item.commence_time,
      status: new Date(item.commence_time) > new Date() ? 'upcoming' : 'live',
    };

    const books: BookOdds[] = (item.bookmakers || []).map((bm: any) => {
      const bookCode = BOOK_MAP[bm.key] || bm.key.toUpperCase().substring(0, 3);
      const h2h = bm.markets?.find((m: any) => m.key === 'h2h');
      const spreads = bm.markets?.find((m: any) => m.key === 'spreads');
      const totals = bm.markets?.find((m: any) => m.key === 'totals');

      const h2hOutcomes = h2h?.outcomes || [];
      const spreadOutcomes = spreads?.outcomes || [];
      const totalOutcomes = totals?.outcomes || [];

      return {
        book: bookCode,
        spreadHome: spreadOutcomes.find((o: any) => o.name === event.homeTeam)?.point ?? null,
        spreadAway: spreadOutcomes.find((o: any) => o.name === event.awayTeam)?.point ?? null,
        totalOver: totalOutcomes.find((o: any) => o.name === 'Over')?.point ?? null,
        totalUnder: totalOutcomes.find((o: any) => o.name === 'Under')?.point ?? null,
        moneylineHome: h2hOutcomes.find((o: any) => o.name === event.homeTeam)?.price ?? null,
        moneylineAway: h2hOutcomes.find((o: any) => o.name === event.awayTeam)?.price ?? null,
      };
    });

    return { event, books };
  }
}
