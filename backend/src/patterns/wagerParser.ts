import type { ParsedWager } from './types';

const PRICE_RE = /([+-]\d{2,4})(?!.*[+-]\d{2,4})/;
const PROP_RE = /\b(points|assists|rebounds|shots|saves|strikeouts|hits|runs|yards|touchdowns)\b/i;

export function parseWagerDescription(raw: string): ParsedWager {
  const desc = decodeEntities(raw || '').replace(/\s+/g, ' ').trim();
  const price = extractPrice(desc);
  const game = extractGame(desc);
  const market = extractMarket(desc);
  const side = extractSide(desc, game, market);

  return {
    game,
    market,
    side,
    price,
    period: extractPeriod(desc),
    teams: extractTeams(game),
  };
}

export function normalizeName(value: string): string {
  return decodeEntities(value || '')
    .toLowerCase()
    .replace(/\b(the|fc|cf|sc|united|city)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function extractGame(desc: string): string {
  const live = desc.match(/^[A-Z][.:]G?\d+\s+-\s+(?:Top\s+)?[^-]+-\s+(.+?)(?:\s+\/|\s+-\s+For\s|$)/i);
  if (live) return cleanGame(live[1]);

  const standard = desc.match(/^[A-Z][.:][^#-]+(?:#\d+)?\s*(.+?)(?:\s+-\s+For\s|\s+\/|\s+[+-]\d{2,4}|$)/i);
  if (standard) return cleanGame(standard[1]);

  const vs = desc.match(/([A-Za-z0-9 .'&-]{2,40}\s+(?:vs|@)\s+[A-Za-z0-9 .'&-]{2,40})/i);
  if (vs) return cleanGame(vs[1]);
  return 'Unknown';
}

function cleanGame(value: string): string {
  return value
    .replace(/\s+#\d+\s*/g, ' ')
    .replace(/\s+[+-]\d+(?:\.\d|½|¼|¾)?(?:\s+[+-]\d{2,4})?\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 120) || 'Unknown';
}

function extractMarket(desc: string): ParsedWager['market'] {
  if (/\bparlay\b|\r?\n/.test(desc.toLowerCase())) return 'parlay';
  if (PROP_RE.test(desc) || /\bplayer\b/i.test(desc)) return 'prop';
  if (/\b(over|under|total|[ou]\s*\d)/i.test(desc)) return 'total';
  if (/\b(runline|puckline|spread)\b|(?:^|\s)[+-]\d+(?:\.\d|½|¼|¾)?(?:\s|$)/i.test(desc.replace(PRICE_RE, ''))) return 'spread';
  if (PRICE_RE.test(desc)) return 'moneyline';
  return 'other';
}

function extractSide(desc: string, game: string, market: ParsedWager['market']): string {
  if (market === 'total' || market === 'prop') {
    const ou = desc.match(/\b(over|under|o|u)\b/i);
    if (ou) return /^o/i.test(ou[1]) ? 'over' : 'under';
  }

  const teams = extractTeams(game);
  const normalizedDesc = normalizeName(desc);
  for (const team of teams) {
    if (team && normalizedDesc.includes(normalizeName(team))) return normalizeName(team);
  }
  return market === 'total' ? 'total' : 'unknown';
}

function extractPrice(desc: string): number | null {
  const match = desc.match(PRICE_RE);
  return match ? Number(match[1]) : null;
}

function extractPeriod(desc: string): string {
  const period = desc.match(/\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+(half|quarter|period|set|5 innings)\b/i);
  if (period) return period[0].toLowerCase();
  if (/\blive\b|^[A-Z][.:]G/i.test(desc)) return 'live';
  return 'game';
}

function extractTeams(game: string): string[] {
  if (!game || game === 'Unknown') return [];
  const parts = game.split(/\s+(?:vs|@)\s+/i).map(t => t.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.slice(0, 2) : [game.trim()];
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#189;/g, '½')
    .replace(/&#188;/g, '¼')
    .replace(/&#190;/g, '¾')
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&');
}
