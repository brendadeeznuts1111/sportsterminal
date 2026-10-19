/**
 * Fair-price math for the Odds Grid drift alert.
 *
 * Until a real Quant Model exists, the default provider is Pinnacle no-vig.
 * A later model replaces the function passed to createFairPriceProvider().
 *
 * Formula
 * -------
 * American odds → implied probability (vig included):
 *   price > 0:  100 / (price + 100)
 *   price < 0:  |price| / (|price| + 100)
 *   price = 0, missing, or non-finite → null
 *
 * Multiplicative (proportional) no-vig on a two-way market:
 *   fair(side) = implied(side) / (implied(side) + implied(other))
 *   If either Pinnacle American price is missing, fair is null. Do not guess.
 *
 * House edge in basis points, for one book side:
 *   edge_bps = (book implied probability − fair probability) × 10_000
 *   positive  → book is shorter than fair (worse for the bettor, house edge)
 *   negative  → book is longer than fair (+EV bet)
 *
 * Pinnacle prices come from game.consensus, which the backend copies from PIN:
 *   moneyline: consensus.moneyline[side]           (the American price)
 *   spread:    consensus.spread.homePrice/awayPrice
 *   total:     consensus.total.overPrice/underPrice
 *
 * Config keys
 * -----------
 *   MARKET_DRIFT_CONFIG.thresholdBps   default 150
 *   MARKET_DRIFT_CONFIG.hysteresisBps  default 25 (clear band, not a second UI control)
 *   MARKET_DRIFT_CONFIG.storageKey     localStorage key `marketDriftThresholdBps`
 *   MARKET_DRIFT_CONFIG.staleAfterMs   45000
 *   MARKET_DRIFT_CONFIG.ssePath        `/api/odds/stream`
 */

export const MARKET_DRIFT_CONFIG = {
  thresholdBps: 150,
  hysteresisBps: 25,
  staleAfterMs: 45000,
  storageKey: 'marketDriftThresholdBps',
  ssePath: '/api/odds/stream',
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
};

/**
 * @param {number | null | undefined} american
 * @returns {number | null}
 */
export function americanToImpliedProb(american) {
  if (typeof american !== 'number' || !Number.isFinite(american) || american === 0) return null;
  if (american > 0) return 100 / (american + 100);
  const abs = Math.abs(american);
  return abs / (abs + 100);
}

/**
 * Multiplicative devig. fair_i = raw_i / (raw_a + raw_b).
 * @param {number | null} probA
 * @param {number | null} probB
 * @returns {{ a: number, b: number } | null}
 */
export function multiplicativeNoVig(probA, probB) {
  if (probA == null || probB == null) return null;
  if (!Number.isFinite(probA) || !Number.isFinite(probB)) return null;
  const sum = probA + probB;
  if (!(sum > 0)) return null;
  return { a: probA / sum, b: probB / sum };
}

/**
 * @param {number | null} bookProb
 * @param {number | null} fairProb
 * @returns {number | null}
 */
export function edgeBps(bookProb, fairProb) {
  if (bookProb == null || fairProb == null) return null;
  if (!Number.isFinite(bookProb) || !Number.isFinite(fairProb)) return null;
  return (bookProb - fairProb) * 10000;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * American price posted by one book for a market side.
 * Spread and total use the juice fields, not the points line.
 * @param {object | null | undefined} bookMarket
 * @param {string} market
 * @param {string} side
 * @returns {number | null}
 */
export function bookAmerican(bookMarket, market, side) {
  if (!bookMarket) return null;
  if (market === 'moneyline') return finiteNumber(bookMarket[side]);
  if (market === 'spread') {
    if (side === 'home') return finiteNumber(bookMarket.homePrice);
    if (side === 'away') return finiteNumber(bookMarket.awayPrice);
  }
  if (market === 'total') {
    if (side === 'over') return finiteNumber(bookMarket.overPrice);
    if (side === 'under') return finiteNumber(bookMarket.underPrice);
  }
  return null;
}

/**
 * @param {object | null | undefined} game
 * @param {string} market
 * @param {string} side
 * @returns {number | null}
 */
export function pinnacleAmerican(game, market, side) {
  const cons = game?.consensus?.[market];
  if (!cons) return null;
  if (market === 'moneyline') return finiteNumber(cons[side]);
  if (market === 'spread') {
    if (side === 'home') return finiteNumber(cons.homePrice);
    if (side === 'away') return finiteNumber(cons.awayPrice);
  }
  if (market === 'total') {
    if (side === 'over') return finiteNumber(cons.overPrice);
    if (side === 'under') return finiteNumber(cons.underPrice);
  }
  return null;
}

const MARKET_SIDES = {
  moneyline: ['away', 'home'],
  spread: ['away', 'home'],
  total: ['over', 'under'],
};

/**
 * Pinnacle multiplicative no-vig fair probability for one side.
 * Returns null when PIN is missing for either side of the market.
 * @param {object | null | undefined} game
 * @param {string} market
 * @param {string} side
 * @returns {number | null}
 */
export function pinnacleNoVigFairPrice(game, market, side) {
  const sides = MARKET_SIDES[market];
  if (!sides || !sides.includes(side)) return null;
  const probA = americanToImpliedProb(pinnacleAmerican(game, market, sides[0]));
  const probB = americanToImpliedProb(pinnacleAmerican(game, market, sides[1]));
  const fair = multiplicativeNoVig(probA, probB);
  if (!fair) return null;
  return side === sides[0] ? fair.a : fair.b;
}

/**
 * @param {(game: object, market: string, side: string) => (number | null)} [source]
 * @returns {(game: object, market: string, side: string) => (number | null)}
 */
export function createFairPriceProvider(source = pinnacleNoVigFairPrice) {
  return function fairPrice(game, market, side) {
    return source(game, market, side);
  };
}

/** Default provider. Swap the argument when a Quant Model lands. */
export const fairPrice = createFairPriceProvider();

/**
 * @param {object} game
 * @param {string} bookKey
 * @param {string} market
 * @param {string} side
 * @param {(game: object, market: string, side: string) => (number | null)} [priceOf]
 * @returns {number | null}
 */
export function computeEdgeBps(game, bookKey, market, side, priceOf = fairPrice) {
  const fair = priceOf(game, market, side);
  const american = bookAmerican(game?.books?.[bookKey]?.[market], market, side);
  return edgeBps(americanToImpliedProb(american), fair);
}

/**
 * Hysteresis around the BPS threshold.
 * Arm when the edge exceeds the threshold (strict). Stay armed until it falls
 * back to the clear line at threshold − hysteresis, so a quote that chatters
 * around the threshold does not flicker.
 *
 * @param {number | null} edge
 * @param {'house' | 'plus-ev' | null} previous
 * @param {number} thresholdBps
 * @param {number} hysteresisBps
 * @returns {'house' | 'plus-ev' | null}
 */
export function nextDriftState(edge, previous, thresholdBps, hysteresisBps) {
  if (edge == null || !Number.isFinite(edge)) return null;
  const enter = thresholdBps;
  const exit = Math.max(0, thresholdBps - hysteresisBps);
  if (previous === 'house') {
    if (edge > exit) return 'house';
    if (edge < -enter) return 'plus-ev';
    return null;
  }
  if (previous === 'plus-ev') {
    if (edge < -exit) return 'plus-ev';
    if (edge > enter) return 'house';
    return null;
  }
  if (edge > enter) return 'house';
  if (edge < -enter) return 'plus-ev';
  return null;
}

/**
 * Drop SSE events that are older than or equal to the last applied id.
 * @param {number | null} lastAppliedId
 * @param {number | string | null | undefined} eventId
 * @returns {boolean}
 */
export function shouldApplyEvent(lastAppliedId, eventId) {
  const id = typeof eventId === 'number' ? eventId : Number(eventId);
  if (!Number.isFinite(id)) return false;
  if (lastAppliedId == null) return true;
  return id > lastAppliedId;
}

/**
 * @param {string | null | undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
export function readStoredThreshold(raw, fallback = MARKET_DRIFT_CONFIG.thresholdBps) {
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
