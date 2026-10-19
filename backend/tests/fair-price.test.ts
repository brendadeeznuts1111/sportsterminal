import { describe, expect, test } from 'bun:test';
import {
  MARKET_DRIFT_CONFIG,
  americanToImpliedProb,
  bookAmerican,
  computeEdgeBps,
  createFairPriceProvider,
  edgeBps,
  multiplicativeNoVig,
  nextDriftState,
  pinnacleNoVigFairPrice,
  readStoredThreshold,
  shouldApplyEvent,
} from '../../frontend/public/js/fair-price.js';

describe('american odds to implied probability', () => {
  test('even money is 50%', () => {
    expect(americanToImpliedProb(100)).toBeCloseTo(0.5, 10);
  });

  test('positive price uses 100 / (price + 100)', () => {
    expect(americanToImpliedProb(150)).toBeCloseTo(100 / 250, 10);
  });

  test('negative price uses |price| / (|price| + 100)', () => {
    expect(americanToImpliedProb(-110)).toBeCloseTo(110 / 210, 10);
    expect(americanToImpliedProb(-200)).toBeCloseTo(200 / 300, 10);
  });

  test('zero, missing, and non-finite prices are not a probability', () => {
    expect(americanToImpliedProb(0)).toBeNull();
    expect(americanToImpliedProb(null)).toBeNull();
    expect(americanToImpliedProb(undefined)).toBeNull();
    expect(americanToImpliedProb(Number.NaN)).toBeNull();
  });
});

describe('multiplicative no-vig', () => {
  test('splits a symmetric market back to 50/50', () => {
    const fair = multiplicativeNoVig(110 / 210, 110 / 210);
    expect(fair?.a).toBeCloseTo(0.5, 10);
    expect(fair?.b).toBeCloseTo(0.5, 10);
  });

  test('divides each raw probability by the overround', () => {
    const fair = multiplicativeNoVig(0.55, 0.5);
    expect(fair?.a).toBeCloseTo(0.55 / 1.05, 10);
    expect(fair?.b).toBeCloseTo(0.5 / 1.05, 10);
  });

  test('a missing side produces no fair price', () => {
    expect(multiplicativeNoVig(null, 0.5)).toBeNull();
    expect(multiplicativeNoVig(0.5, null)).toBeNull();
    expect(multiplicativeNoVig(0, 0)).toBeNull();
  });
});

describe('Pinnacle fair price and edge bps', () => {
  const game = {
    consensus: {
      moneyline: { home: -135, away: 115 },
      spread: { home: -2.5, away: 2.5, homePrice: -105, awayPrice: -105 },
      total: { over: 214, under: 214, overPrice: null, underPrice: -110 },
    },
    books: {
      DK: {
        spread: { home: -2.5, away: 2.5, homePrice: -115, awayPrice: -115 },
        moneyline: { home: -150, away: 130 },
      },
      ACE: {
        spread: { home: -2.5, away: 2.5, homePrice: 115, awayPrice: -130 },
      },
    },
  };

  test('edge_bps is (book implied − fair) × 10_000', () => {
    expect(edgeBps(0.6, 0.5)).toBeCloseTo(1000, 8);
    expect(edgeBps(0.45, 0.5)).toBeCloseTo(-500, 8);
    expect(edgeBps(null, 0.5)).toBeNull();
  });

  test('-110/-110 against a 50% fair is about 238 bps of house edge', () => {
    expect(edgeBps(110 / 210, 0.5)).toBeCloseTo(((110 / 210) - 0.5) * 10000, 6);
  });

  test('symmetric -105 Pinnacle juice devigs to 50%', () => {
    expect(pinnacleNoVigFairPrice(game, 'spread', 'home')).toBeCloseTo(0.5, 10);
    expect(pinnacleNoVigFairPrice(game, 'spread', 'away')).toBeCloseTo(0.5, 10);
  });

  test('a missing Pinnacle side shows no edge', () => {
    expect(pinnacleNoVigFairPrice(game, 'total', 'over')).toBeNull();
    expect(pinnacleNoVigFairPrice(game, 'total', 'under')).toBeNull();
    expect(pinnacleNoVigFairPrice({}, 'spread', 'home')).toBeNull();
    expect(pinnacleNoVigFairPrice(game, 'player-prop', 'home')).toBeNull();
  });

  test('book juice worse than fair is positive and better than fair is negative', () => {
    const house = computeEdgeBps(game, 'DK', 'spread', 'home');
    const plusEv = computeEdgeBps(game, 'ACE', 'spread', 'home');
    expect(house).toBeGreaterThan(150);
    expect(plusEv).toBeLessThan(-150);
    expect(bookAmerican(game.books.DK.spread, 'spread', 'home')).toBe(-115);
  });

  test('moneyline fair uses the American prices, not a separate juice field', () => {
    const home = americanToImpliedProb(-135);
    const away = americanToImpliedProb(115);
    const fairHome = pinnacleNoVigFairPrice(game, 'moneyline', 'home');
    expect(fairHome).toBeCloseTo((home as number) / ((home as number) + (away as number)), 10);
  });

  test('the provider interface can be replaced without touching the edge formula', () => {
    const provider = createFairPriceProvider(() => 0.4);
    expect(provider(game, 'spread', 'home')).toBe(0.4);
    const edge = computeEdgeBps(game, 'DK', 'spread', 'home', provider);
    expect(edge).toBeCloseTo(edgeBps(115 / 215, 0.4) as number, 6);
  });
});

describe('threshold hysteresis and event order', () => {
  const threshold = MARKET_DRIFT_CONFIG.thresholdBps;
  const hysteresis = MARKET_DRIFT_CONFIG.hysteresisBps;

  test('defaults are 150 bps to enter and 25 bps of hysteresis', () => {
    expect(threshold).toBe(150);
    expect(hysteresis).toBe(25);
    expect(MARKET_DRIFT_CONFIG.storageKey).toBe('marketDriftThresholdBps');
  });

  test('arms only when the edge exceeds the threshold', () => {
    expect(nextDriftState(150, null, threshold, hysteresis)).toBeNull();
    expect(nextDriftState(150.01, null, threshold, hysteresis)).toBe('house');
    expect(nextDriftState(-150, null, threshold, hysteresis)).toBeNull();
    expect(nextDriftState(-150.01, null, threshold, hysteresis)).toBe('plus-ev');
    expect(nextDriftState(0, null, threshold, hysteresis)).toBeNull();
  });

  test('stays armed through the hysteresis band and clears once it falls back under', () => {
    expect(nextDriftState(125.01, 'house', threshold, hysteresis)).toBe('house');
    expect(nextDriftState(125, 'house', threshold, hysteresis)).toBeNull();
    expect(nextDriftState(-125.01, 'plus-ev', threshold, hysteresis)).toBe('plus-ev');
    expect(nextDriftState(-125, 'plus-ev', threshold, hysteresis)).toBeNull();
  });

  test('a crossing of the other threshold switches style instead of flickering off', () => {
    expect(nextDriftState(-150.01, 'house', threshold, hysteresis)).toBe('plus-ev');
    expect(nextDriftState(150.01, 'plus-ev', threshold, hysteresis)).toBe('house');
  });

  test('a missing price clears the highlight', () => {
    expect(nextDriftState(null, 'house', threshold, hysteresis)).toBeNull();
    expect(nextDriftState(Number.NaN, 'plus-ev', threshold, hysteresis)).toBeNull();
  });

  test('drops out-of-order and duplicate SSE ids', () => {
    expect(shouldApplyEvent(null, 1)).toBe(true);
    expect(shouldApplyEvent(4, 5)).toBe(true);
    expect(shouldApplyEvent(4, 4)).toBe(false);
    expect(shouldApplyEvent(4, 3)).toBe(false);
    expect(shouldApplyEvent(4, 'nope')).toBe(false);
  });

  test('localStorage threshold falls back when the stored value is unusable', () => {
    expect(readStoredThreshold(null)).toBe(150);
    expect(readStoredThreshold('')).toBe(150);
    expect(readStoredThreshold('-5')).toBe(150);
    expect(readStoredThreshold('200')).toBe(200);
  });
});
