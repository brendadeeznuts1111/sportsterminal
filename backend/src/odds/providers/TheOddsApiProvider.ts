/**
 * TheOddsApiProvider
 * Skeleton for integrating with the-odds-api.com
 * Set ODDS_API_KEY env var to enable.
 */

import type { OddsProvider, GameEvent, EventOdds, BookOdds, BookHealth, TeamIdentity } from '../types';
import { DEFAULT_SPORT_KEYS, REGISTRY_LEAGUE_OF_KEY, sportOfKey } from '../sportKeys';
import { resolveTeam } from '../teams/team-registry';

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
  private sports: string[];

  /** `sports`: The Odds API sport keys to poll (see `ODDS_API_SPORTS`). */
  constructor(apiKey: string, sports: string | readonly string[] = DEFAULT_SPORT_KEYS) {
    this.apiKey = apiKey;
    this.sports = typeof sports === 'string' ? [sports] : [...sports];
  }

  async fetchOdds(): Promise<EventOdds[]> {
    const out: EventOdds[] = [];
    for (const sport of this.sports) {
      const url = `${API_BASE}/sports/${sport}/odds?apiKey=${this.apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`TheOddsAPI error: ${response.status} ${response.statusText} (${sport})`);
      }
      const data = await response.json() as unknown[];
      for (const item of data) out.push(this.mapEvent(item));
    }
    return out;
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
    const event = mapOddsApiEvent(item);

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

/**
 * One The Odds API event as a GameEvent. `sport_key` is `{group}_{league}`,
 * so the sport is its group and the league is `sport_title` (the two were
 * swapped before). A game is `finished` only when the API says `completed`
 * (scores endpoint); the odds endpoint lists upcoming and in-play games.
 */
export function mapOddsApiEvent(item: any, now: Date = new Date()): GameEvent {
  const key = String(item.sport_key || '');
  const registryLeague = REGISTRY_LEAGUE_OF_KEY[key] ?? null;
  const team = (name: string): TeamIdentity | undefined => {
    const hit = registryLeague && name ? resolveTeam(registryLeague, name) : null;
    return hit ? { abbr: hit.abbr, espnId: hit.espnId, displayName: hit.displayName, logo: hit.logo, color: hit.color } : undefined;
  };
  const home = team(item.home_team);
  const away = team(item.away_team);
  return {
    id: item.id,
    sport: key ? sportOfKey(key) : 'unknown',
    league: registryLeague ?? (item.sport_title || key),
    homeTeam: item.home_team,
    awayTeam: item.away_team,
    startTime: item.commence_time,
    status: item.completed === true ? 'finished' : new Date(item.commence_time) > now ? 'upcoming' : 'live',
    ...(key ? { sportKey: key } : {}),
    ...(home ? { homeTeamId: home } : {}),
    ...(away ? { awayTeamId: away } : {}),
  };
}
