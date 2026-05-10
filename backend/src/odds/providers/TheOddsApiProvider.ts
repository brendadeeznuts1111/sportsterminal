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

interface TheOddsOutcome {
  name: string;
  price?: number;
  point?: number;
}

interface TheOddsMarket {
  key: 'h2h' | 'spreads' | 'totals' | string;
  outcomes?: TheOddsOutcome[];
}

interface TheOddsBookmaker {
  key: string;
  markets?: TheOddsMarket[];
}

interface TheOddsEvent {
  id: string;
  sport_title?: string;
  sport_key?: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers?: TheOddsBookmaker[];
}

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

    const data = await response.json() as TheOddsEvent[];
    return data.map((item) => this.mapEvent(item));
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

  private mapEvent(item: TheOddsEvent): EventOdds {
    const event: GameEvent = {
      id: item.id,
      sport: item.sport_title || 'Unknown',
      league: item.sport_key || '',
      homeTeam: item.home_team,
      awayTeam: item.away_team,
      startTime: item.commence_time,
      status: new Date(item.commence_time) > new Date() ? 'upcoming' : 'live',
    };

    const books: BookOdds[] = (item.bookmakers || []).map((bm) => {
      const bookCode = BOOK_MAP[bm.key] || bm.key.toUpperCase().substring(0, 3);
      const h2h = bm.markets?.find((m) => m.key === 'h2h');
      const spreads = bm.markets?.find((m) => m.key === 'spreads');
      const totals = bm.markets?.find((m) => m.key === 'totals');

      const h2hOutcomes = h2h?.outcomes || [];
      const spreadOutcomes = spreads?.outcomes || [];
      const totalOutcomes = totals?.outcomes || [];
      const homeSpread = spreadOutcomes.find((o) => o.name === event.homeTeam);
      const awaySpread = spreadOutcomes.find((o) => o.name === event.awayTeam);
      const overTotal = totalOutcomes.find((o) => o.name === 'Over');
      const underTotal = totalOutcomes.find((o) => o.name === 'Under');
      const homeMoneyline = h2hOutcomes.find((o) => o.name === event.homeTeam);
      const awayMoneyline = h2hOutcomes.find((o) => o.name === event.awayTeam);

      return {
        book: bookCode,
        spreadHome: homeSpread?.point ?? null,
        spreadAway: awaySpread?.point ?? null,
        spreadHomePrice: homeSpread?.price ?? null,
        spreadAwayPrice: awaySpread?.price ?? null,
        totalOver: overTotal?.point ?? null,
        totalUnder: underTotal?.point ?? null,
        totalOverPrice: overTotal?.price ?? null,
        totalUnderPrice: underTotal?.price ?? null,
        moneylineHome: homeMoneyline?.price ?? null,
        moneylineAway: awayMoneyline?.price ?? null,
      };
    });

    return { event, books };
  }
}
