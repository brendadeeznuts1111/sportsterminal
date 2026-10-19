/**
 * MarketDriftAlert
 *
 * Compares each Odds Grid book side with fairPrice() and paints HOUSE / +EV
 * when the edge exceeds the BPS threshold. SSE deltas patch the changed cell
 * only. The REST poll and /ws socket stay in place as fallbacks.
 */

import {
  MARKET_DRIFT_CONFIG,
  bookAmerican,
  computeEdgeBps,
  createFairPriceProvider,
  nextDriftState,
  readStoredThreshold,
  shouldApplyEvent,
} from './fair-price.js';
import { OddsStreamClient } from './odds-stream.js';

const SIDES = {
  moneyline: ['away', 'home'],
  spread: ['away', 'home'],
  total: ['over', 'under'],
};

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function blankQuote(book) {
  return {
    book,
    spreadHome: null,
    spreadAway: null,
    spreadHomePrice: null,
    spreadAwayPrice: null,
    totalOver: null,
    totalUnder: null,
    totalOverPrice: null,
    totalUnderPrice: null,
    moneylineHome: null,
    moneylineAway: null,
  };
}

function applyChange(quote, change) {
  if (change.market === 'moneyline' && change.side === 'home') quote.moneylineHome = change.price;
  if (change.market === 'moneyline' && change.side === 'away') quote.moneylineAway = change.price;
  if (change.market === 'spread' && change.side === 'home') {
    if (change.line != null) quote.spreadHome = change.line;
    if (change.price != null) quote.spreadHomePrice = change.price;
  }
  if (change.market === 'spread' && change.side === 'away') {
    if (change.line != null) quote.spreadAway = change.line;
    if (change.price != null) quote.spreadAwayPrice = change.price;
  }
  if (change.market === 'total' && change.side === 'over') {
    if (change.line != null) quote.totalOver = change.line;
    if (change.price != null) quote.totalOverPrice = change.price;
  }
  if (change.market === 'total' && change.side === 'under') {
    if (change.line != null) quote.totalUnder = change.line;
    if (change.price != null) quote.totalUnderPrice = change.price;
  }
}

function keep(complete, value, previous) {
  if (value == null && !complete) return previous ?? null;
  return value;
}

function quoteFromMatrix(book, matrixBook) {
  const quote = blankQuote(book);
  if (!matrixBook) return quote;
  quote.moneylineHome = matrixBook.moneyline?.home ?? null;
  quote.moneylineAway = matrixBook.moneyline?.away ?? null;
  quote.spreadHome = matrixBook.spread?.home ?? null;
  quote.spreadAway = matrixBook.spread?.away ?? null;
  quote.spreadHomePrice = matrixBook.spread?.homePrice ?? null;
  quote.spreadAwayPrice = matrixBook.spread?.awayPrice ?? null;
  quote.totalOver = matrixBook.total?.over ?? null;
  quote.totalUnder = matrixBook.total?.under ?? null;
  quote.totalOverPrice = matrixBook.total?.overPrice ?? null;
  quote.totalUnderPrice = matrixBook.total?.underPrice ?? null;
  return quote;
}

function projectQuote(game, quote) {
  const prev = game.books[quote.book] || {};
  const complete = quote.complete === true;
  const stamp = new Date().toISOString();
  const moneyline = prev.moneyline || {};
  const spread = prev.spread || {};
  const total = prev.total || {};
  game.books[quote.book] = {
    ...prev,
    moneyline: {
      ...moneyline,
      home: keep(complete, quote.moneylineHome, moneyline.home),
      away: keep(complete, quote.moneylineAway, moneyline.away),
      lastUpdated: stamp,
    },
    spread: {
      ...spread,
      home: keep(complete, quote.spreadHome, spread.home),
      away: keep(complete, quote.spreadAway, spread.away),
      homePrice: keep(complete, quote.spreadHomePrice, spread.homePrice),
      awayPrice: keep(complete, quote.spreadAwayPrice, spread.awayPrice),
      lastUpdated: stamp,
    },
    total: {
      ...total,
      over: keep(complete, quote.totalOver, total.over),
      under: keep(complete, quote.totalUnder, total.under),
      overPrice: keep(complete, quote.totalOverPrice, total.overPrice),
      underPrice: keep(complete, quote.totalUnderPrice, total.underPrice),
      lastUpdated: stamp,
    },
    openLine: prev.openLine || null,
    recentMoves: prev.recentMoves,
  };
  if (quote.book === 'PIN') {
    const consensus = game.consensus || {};
    const consSpread = consensus.spread || {};
    const consMl = consensus.moneyline || {};
    const consTotal = consensus.total || {};
    game.consensus = {
      spread: {
        ...consSpread,
        home: keep(complete, quote.spreadHome, consSpread.home),
        away: keep(complete, quote.spreadAway, consSpread.away),
        homePrice: keep(complete, quote.spreadHomePrice, consSpread.homePrice),
        awayPrice: keep(complete, quote.spreadAwayPrice, consSpread.awayPrice),
      },
      moneyline: {
        ...consMl,
        home: keep(complete, quote.moneylineHome, consMl.home),
        away: keep(complete, quote.moneylineAway, consMl.away),
      },
      total: {
        ...consTotal,
        over: keep(complete, quote.totalOver, consTotal.over),
        under: keep(complete, quote.totalUnder, consTotal.under),
        overPrice: keep(complete, quote.totalOverPrice, consTotal.overPrice),
        underPrice: keep(complete, quote.totalUnderPrice, consTotal.underPrice),
      },
    };
  }
}

export class MarketDriftAlert {
  /**
   * @param {{
   *   getApiBaseUrl: () => string,
   *   getMatrix: () => { games?: object[] },
   *   getMarket: () => string,
   *   formatLine: (value: number | null, market: string) => string,
   *   formatAmerican: (value: number | null) => string,
   *   fairPrice?: (game: object, market: string, side: string) => (number | null),
   * }} deps
   */
  constructor(deps) {
    this.getApiBaseUrl = deps.getApiBaseUrl;
    this.getMatrix = deps.getMatrix;
    this.getMarket = deps.getMarket;
    this.formatLine = deps.formatLine;
    this.formatAmerican = deps.formatAmerican;
    this.fairPrice = deps.fairPrice || createFairPriceProvider();
    this.thresholdBps = MARKET_DRIFT_CONFIG.thresholdBps;
    this.hysteresisBps = MARKET_DRIFT_CONFIG.hysteresisBps;
    this.states = new Map();
    this.quotes = new Map();
    this.lastAppliedId = null;
    this.lastMessageAt = 0;
    this.openedAt = 0;
    this.streamStatus = 'closed';
    this.client = null;
    this.staleTimer = null;
    this.stopped = false;
  }

  mount() {
    try {
      const stored = localStorage.getItem(MARKET_DRIFT_CONFIG.storageKey);
      this.thresholdBps = readStoredThreshold(stored);
    } catch {
      this.thresholdBps = MARKET_DRIFT_CONFIG.thresholdBps;
    }
    const input = document.getElementById('driftThresholdBps');
    if (input) {
      input.value = String(this.thresholdBps);
      input.addEventListener('change', () => {
        const next = readStoredThreshold(input.value, this.thresholdBps);
        this.thresholdBps = next;
        input.value = String(next);
        try {
          localStorage.setItem(MARKET_DRIFT_CONFIG.storageKey, String(next));
        } catch {
          // Private mode can reject storage; the in-memory threshold still applies.
        }
        // A new threshold re-arms from scratch. Hysteresis is for quote chatter,
        // so the number the user just typed takes effect immediately.
        this.states.clear();
        this.paintAll();
      });
    }
    this.renderFeedStatus();
    this.staleTimer = setInterval(() => this.renderFeedStatus(), 5000);
    window.addEventListener('pagehide', () => this.stop());
  }

  connect() {
    const base = this.getApiBaseUrl().replace(/\/$/, '');
    this.client = new OddsStreamClient(`${base}${MARKET_DRIFT_CONFIG.ssePath}`, {
      onStatus: (status) => {
        this.streamStatus = status;
        if (status === 'open') this.openedAt = Date.now();
        this.renderFeedStatus();
      },
      onSnapshot: (data, eventId) => this.onStreamPayload(data, eventId, 'snapshot'),
      onOdds: (data, eventId) => this.onStreamPayload(data, eventId, 'odds'),
      onHeartbeat: () => {
        this.lastMessageAt = Date.now();
        this.renderFeedStatus();
      },
    });
    this.client.connect();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    this.client?.disconnect();
    this.client = null;
  }

  onStreamPayload(raw, eventId, kind) {
    this.lastMessageAt = Date.now();
    this.renderFeedStatus();
    if (!shouldApplyEvent(this.lastAppliedId, eventId)) return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.lastAppliedId = Number(eventId);
      return;
    }
    this.lastAppliedId = Number(eventId);
    if (kind === 'snapshot') this.ingestSnapshot(payload);
    else this.ingestDelta(payload);
  }

  ingestSnapshot(snapshot) {
    const touched = [];
    for (const row of snapshot?.games || []) {
      let books = this.quotes.get(row.eventId);
      if (!books) {
        books = new Map();
        this.quotes.set(row.eventId, books);
      }
      for (const quote of row.books || []) {
        books.set(quote.book, { ...quote, complete: true });
        touched.push([row.eventId, quote.book]);
      }
    }
    this.overlay(this.getMatrix());
    this.refreshTouched(touched);
  }

  ingestDelta(payload) {
    if (!payload?.eventId || !payload?.book) return;
    let books = this.quotes.get(payload.eventId);
    if (!books) {
      books = new Map();
      this.quotes.set(payload.eventId, books);
    }
    const game = this.findGame(payload.eventId);
    const quote = {
      ...(books.get(payload.book) || quoteFromMatrix(payload.book, game?.books?.[payload.book])),
    };
    for (const change of payload.changes || []) applyChange(quote, change);
    books.set(payload.book, quote);
    if (game) projectQuote(game, quote);
    this.refreshTouched([[payload.eventId, payload.book]]);
  }

  /** Copy streamed quotes onto the matrix the grid is about to draw. */
  overlay(matrix) {
    const games = matrix?.games || [];
    for (const game of games) {
      const books = this.quotes.get(game.id);
      if (!books) continue;
      if (!game.books) game.books = {};
      for (const quote of books.values()) projectQuote(game, quote);
    }
  }

  paintAll() {
    this.paint(document.getElementById('oddsGrid'));
    this.paint(document.getElementById('oddsGridMobile'));
  }

  /**
   * @param {ParentNode | null} root
   * @param {{ updateText?: boolean }} [options]
   */
  paint(root, options = {}) {
    if (!root) return;
    root.querySelectorAll('[data-game-id][data-book]').forEach((cell) => {
      this.paintCell(cell, options);
    });
  }

  refreshTouched(pairs) {
    const market = this.getMarket();
    for (const [eventId, book] of pairs) {
      const selector = `[data-game-id="${cssEscape(eventId)}"][data-book="${cssEscape(book)}"]`;
      document.querySelectorAll(selector).forEach((cell) => {
        const cellMarket = cell.getAttribute('data-market') || market;
        if (cellMarket !== market) return;
        this.paintCell(cell, { updateText: true });
      });
    }
  }

  paintCell(cell, options = {}) {
    const game = this.findGame(cell.getAttribute('data-game-id'));
    const book = cell.getAttribute('data-book');
    const market = cell.getAttribute('data-market') || this.getMarket();
    const sideEls = cell.hasAttribute('data-side')
      ? [cell]
      : [...cell.querySelectorAll('[data-side]')];
    for (const sideEl of sideEls) {
      if (options.updateText) this.updateSideText(sideEl, game, book, market);
      this.paintSide(sideEl, game, book, market);
    }
    this.syncRow(cell.closest('tr'));
  }

  updateSideText(sideEl, game, book, market) {
    const side = sideEl.getAttribute('data-side');
    const marketData = game?.books?.[book]?.[market];
    const line = market === 'moneyline' ? marketData?.[side] : marketData?.[side];
    const price = bookAmerican(marketData, market, side);
    const lineEl = sideEl.querySelector('.odds-line');
    if (lineEl) lineEl.textContent = this.formatLine(line ?? null, market);
    let americanEl = sideEl.querySelector('.odds-american');
    if (market === 'moneyline' || price == null) {
      americanEl?.remove();
      return;
    }
    const text = `(${this.formatAmerican(price)})`;
    if (!americanEl) {
      americanEl = document.createElement('span');
      americanEl.className = 'odds-american';
      americanEl.style.color = 'var(--text-dim)';
      americanEl.style.fontSize = '10px';
      const badge = sideEl.querySelector('.drift-badge');
      sideEl.insertBefore(americanEl, badge);
      sideEl.insertBefore(document.createTextNode(' '), badge);
    }
    americanEl.textContent = text;
  }

  paintSide(sideEl, game, book, market) {
    const side = sideEl.getAttribute('data-side');
    const badge = sideEl.querySelector('.drift-badge');
    const key = `${sideEl.closest('[data-game-id]')?.getAttribute('data-game-id')}:${book}:${market}:${side}`;
    const edge = game ? computeEdgeBps(game, book, market, side, this.fairPrice) : null;
    const next = nextDriftState(edge, this.states.get(key) || null, this.thresholdBps, this.hysteresisBps);
    if (next) this.states.set(key, next);
    else this.states.delete(key);

    sideEl.classList.remove('drift-house', 'drift-plus-ev');
    if (!badge) return;
    if (next === 'house') {
      const bps = Math.round(edge);
      sideEl.classList.add('drift-house');
      badge.textContent = `HOUSE +${bps}bp`;
      sideEl.setAttribute('aria-label', `House edge ${bps} basis points versus Pinnacle no-vig fair price`);
    } else if (next === 'plus-ev') {
      const bps = Math.round(edge);
      sideEl.classList.add('drift-plus-ev');
      badge.textContent = `+EV ${bps}bp`;
      sideEl.setAttribute('aria-label', `Plus EV ${Math.abs(bps)} basis points versus Pinnacle no-vig fair price`);
    } else {
      badge.textContent = '';
      sideEl.removeAttribute('aria-label');
    }
  }

  syncRow(tr) {
    if (!tr) return;
    const house = tr.querySelector('.drift-house');
    const plus = tr.querySelector('.drift-plus-ev');
    tr.classList.toggle('has-drift', Boolean(house || plus));
    tr.classList.toggle('drift-row-house', Boolean(house));
    tr.classList.toggle('drift-row-plus-ev', Boolean(plus) && !house);
  }

  /** True when the SSE feed has delivered a message inside the stale window. */
  isLive() {
    if (this.stopped || this.streamStatus !== 'open' || !this.lastMessageAt) return false;
    return Date.now() - this.lastMessageAt < MARKET_DRIFT_CONFIG.staleAfterMs;
  }

  findGame(eventId) {
    return (this.getMatrix()?.games || []).find((game) => game.id === eventId) || null;
  }

  renderFeedStatus() {
    const chip = document.getElementById('oddsFeedStatus');
    const text = document.getElementById('oddsFeedStatusText');
    if (!chip || !text) return;
    const now = Date.now();
    const silentFor = this.lastMessageAt ? now - this.lastMessageAt : (this.openedAt ? now - this.openedAt : 0);
    const stale = this.streamStatus === 'open' && this.lastMessageAt > 0
      ? silentFor > MARKET_DRIFT_CONFIG.staleAfterMs
      : this.streamStatus === 'open' && this.openedAt > 0 && silentFor > MARKET_DRIFT_CONFIG.staleAfterMs;
    let label = 'Odds offline';
    let tone = 'offline';
    if (stale) {
      label = 'Odds stale';
      tone = 'warn';
    } else if (this.streamStatus === 'open') {
      label = 'Odds live';
      tone = 'live';
    } else if (this.streamStatus === 'connecting' || this.streamStatus === 'error') {
      label = 'Odds reconnecting';
      tone = 'warn';
    }
    text.textContent = label;
    chip.classList.remove('live', 'warn', 'offline');
    chip.classList.add(tone);
  }
}

export { SIDES };
