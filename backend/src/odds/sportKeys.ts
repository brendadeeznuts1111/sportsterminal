/**
 * The Odds API sport keys (https://the-odds-api.com/sports-odds-data/sports-apis.html).
 * A key is `{group}_{league}`: `basketball_nba`, `icehockey_nhl`,
 * `soccer_mexico_ligamx`. The group gives the sport; the league comes from the
 * event's `sport_title`, or from the registry map below for the leagues the
 * team registry covers.
 */

/** Key prefix → sport. Groups not listed keep their own prefix as the sport. */
const GROUP_SPORT: Record<string, string> = {
  americanfootball: 'football',
  basketball: 'basketball',
  baseball: 'baseball',
  icehockey: 'hockey',
  soccer: 'soccer',
  tennis: 'tennis',
  golf: 'golf',
  mma: 'mma',
  boxing: 'boxing',
};

/** Sport key → team registry league, for the leagues `teams/` covers. */
export const REGISTRY_LEAGUE_OF_KEY: Readonly<Record<string, string>> = {
  americanfootball_nfl: 'NFL',
  americanfootball_ncaaf: 'NCAAF',
  basketball_nba: 'NBA',
  basketball_wnba: 'WNBA',
  basketball_ncaab: 'NCAAB',
  baseball_mlb: 'MLB',
  icehockey_nhl: 'NHL',
  soccer_epl: 'EPL',
  soccer_usa_mls: 'MLS',
  soccer_uefa_champs_league: 'UCL',
  soccer_mexico_ligamx: 'LIGA MX',
};

export const DEFAULT_SPORT_KEYS: readonly string[] = ['basketball_nba'];

/** `basketball_nba` → `basketball`, `icehockey_nhl` → `hockey`. */
export function sportOfKey(key: string): string {
  const group = key.trim().toLowerCase().split('_')[0] ?? '';
  return GROUP_SPORT[group] ?? group;
}

/**
 * `ODDS_API_SPORTS` as a list: comma or space separated keys, deduplicated.
 * Unset or empty keeps the previous single default, `basketball_nba`.
 */
export function parseSportKeys(raw: string | undefined | null): string[] {
  const keys = [...new Set((raw ?? '').split(/[\s,]+/).map((k) => k.trim().toLowerCase()).filter((k) => /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(k)))];
  return keys.length ? keys : [...DEFAULT_SPORT_KEYS];
}
