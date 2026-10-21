import { describe, expect, test } from 'bun:test';
import { mapOddsApiEvent, TheOddsProvider } from '../src/odds/providers/TheOddsApiProvider';
import { parseSportKeys, sportOfKey } from '../src/odds/sportKeys';
import { resolveTeam } from '../src/odds/teams/team-registry';

const NOW = new Date('2026-10-21T18:00:00Z');
const item = (over: Record<string, unknown> = {}) => ({
  id: 'e1', sport_key: 'basketball_nba', sport_title: 'NBA', commence_time: '2026-10-22T00:00:00Z',
  home_team: 'Los Angeles Lakers', away_team: 'Golden State Warriors', bookmakers: [], ...over,
});

describe('sport vs league', () => {
  test('sport is the key group and league the competition, no longer swapped', () => {
    const e = mapOddsApiEvent(item(), NOW);
    expect([e.sport, e.league, e.sportKey]).toEqual(['basketball', 'NBA', 'basketball_nba']);
    expect(sportOfKey('americanfootball_ncaaf')).toBe('football');
    expect(sportOfKey('icehockey_nhl')).toBe('hockey');
    expect(mapOddsApiEvent(item({ sport_key: 'soccer_mexico_ligamx', sport_title: 'Liga MX' }), NOW).league).toBe('LIGA MX');
    // A league outside the registry keeps the provider's title.
    expect(mapOddsApiEvent(item({ sport_key: 'aussierules_afl', sport_title: 'AFL', home_team: 'X', away_team: 'Y' }), NOW)).toMatchObject({ sport: 'aussierules', league: 'AFL' });
  });

  test('status: completed games are finished, not live', () => {
    expect(mapOddsApiEvent(item(), NOW).status).toBe('upcoming');
    expect(mapOddsApiEvent(item({ commence_time: '2026-10-21T16:00:00Z' }), NOW).status).toBe('live');
    expect(mapOddsApiEvent(item({ commence_time: '2026-10-21T16:00:00Z', completed: true }), NOW).status).toBe('finished');
  });

  test('ODDS_API_SPORTS is configurable and defaults to the old single key', () => {
    expect(parseSportKeys(undefined)).toEqual(['basketball_nba']);
    expect(parseSportKeys(' americanfootball_nfl, icehockey_nhl  basketball_nba,icehockey_nhl ')).toEqual(['americanfootball_nfl', 'icehockey_nhl', 'basketball_nba']);
    expect(parseSportKeys('not a key!')).toEqual(['basketball_nba']);
  });

  test('the provider polls every configured key', async () => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seen.push(new URL(url).pathname);
      const key = new URL(url).pathname.split('/')[3];
      return new Response(JSON.stringify([item({ id: key, sport_key: key, sport_title: key === 'icehockey_nhl' ? 'NHL' : 'NBA', home_team: key === 'icehockey_nhl' ? 'Montreal Canadiens' : 'Los Angeles Lakers', away_team: key === 'icehockey_nhl' ? 'Ottawa Senators' : 'Golden State Warriors' })]));
    }) as typeof fetch;
    try {
      const odds = await new TheOddsProvider('test-key', ['basketball_nba', 'icehockey_nhl']).fetchOdds();
      expect(seen).toEqual(['/v4/sports/basketball_nba/odds', '/v4/sports/icehockey_nhl/odds']);
      expect(odds.map((o) => [o.event.league, o.event.homeTeamId?.abbr, o.event.awayTeamId?.abbr])).toEqual([['NBA', 'LAL', 'GSW'], ['NHL', 'MTL', 'OTT']]);
    } finally { globalThis.fetch = real; }
  });
});

describe('registry names and logos', () => {
  test('provider team names resolve to registry abbreviations, ESPN ids and logos', () => {
    const e = mapOddsApiEvent(item(), NOW);
    expect(e.homeTeamId).toMatchObject({ abbr: 'LAL', displayName: 'Los Angeles Lakers' });
    expect(e.homeTeamId?.logo).toMatch(/^https:\/\/a\.espncdn\.com\/i\/teamlogos\/nba\/500\/lal\.png$/);
    expect(e.awayTeamId?.abbr).toBe('GSW');
    expect(e.homeTeam).toBe('Los Angeles Lakers');
  });

  test('league scoping: KC is the Chiefs in the NFL and the Royals in MLB, never guessed in the NBA', () => {
    expect(resolveTeam('NFL', 'KC')?.displayName).toBe('Kansas City Chiefs');
    expect(resolveTeam('MLB', 'KC')?.displayName).toBe('Kansas City Royals');
    expect(resolveTeam('NBA', 'KC')).toBeNull();
    expect(resolveTeam('MLB', 'Oakland Athletics')?.abbr).toBe('ATH');
    expect(resolveTeam('NFL', 'Los Angeles Chargers')?.abbr).toBe('LAC');
  });

  test('an unknown name keeps the raw string and no identity', () => {
    const e = mapOddsApiEvent(item({ home_team: 'Seattle SuperSonics' }), NOW);
    expect(e.homeTeam).toBe('Seattle SuperSonics');
    expect(e.homeTeamId).toBeUndefined();
  });
});
