/**
 * OddsPoller
 * Orchestrates odds polling from one or more providers,
 * persists snapshots, detects line movements, and tracks book health.
 */

import type { Database } from '../database';
import type { OddsProvider, EventOdds, LineMovement, BookHealth } from './types';
import { DemoOddsProvider } from './providers/DemoOddsProvider';
import { TheOddsProvider } from './providers/TheOddsApiProvider';

export class OddsPoller {
  private db: Database;
  private provider: OddsProvider;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private healthIntervalId: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number = 30000; // 30 seconds
  private healthIntervalMs: number = 60000; // 60 seconds
  private lastOdds: EventOdds[] = [];
  private broadcast: (msg: object) => void;

  constructor(db: Database, broadcast: (msg: object) => void) {
    this.db = db;
    this.broadcast = broadcast;

    const apiKey = process.env.ODDS_API_KEY;
    if (apiKey) {
      this.provider = new TheOddsProvider(apiKey);
      console.log('[OddsPoller] Using TheOddsAPI provider');
    } else {
      this.provider = new DemoOddsProvider();
      console.log('[OddsPoller] Using Demo provider (set ODDS_API_KEY for live data)');
    }
  }

  start(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
    this.healthIntervalId = setInterval(() => this.checkHealth(), this.healthIntervalMs);

    // Immediate first poll
    setImmediate(() => this.poll());
    setImmediate(() => this.checkHealth());

    console.log(`[OddsPoller] Started polling every ${this.pollIntervalMs}ms`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.healthIntervalId) {
      clearInterval(this.healthIntervalId);
      this.healthIntervalId = null;
    }
    console.log('[OddsPoller] Stopped');
  }

  getLastOdds(): EventOdds[] {
    return this.lastOdds;
  }

  private async poll(): Promise<void> {
    try {
      const odds = await this.provider.fetchOdds();
      this.lastOdds = odds;

      // Detect movements before storing (needs previous state)
      let movements: LineMovement[] = [];
      if (this.provider instanceof DemoOddsProvider) {
        movements = this.provider.detectMovements(odds);
      }

      // Persist
      await this.persistOdds(odds);

      if (movements.length > 0) {
        await this.persistMovements(movements);
        for (const m of movements) {
          this.broadcast({
            type: 'odds.movement',
            timestamp: new Date().toISOString(),
            payload: m,
          });
        }
      }

      // Broadcast updated odds
      this.broadcast({
        type: 'odds.update',
        timestamp: new Date().toISOString(),
        payload: { events: odds.length },
      });
    } catch (error) {
      console.error('[OddsPoller] Poll error:', error);
    }
  }

  private async checkHealth(): Promise<void> {
    try {
      const health = await this.provider.checkHealth();
      for (const h of health) {
        await this.db.run(
          `INSERT INTO book_health (book, status, last_seen, error_count, last_error)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(book) DO UPDATE SET
             status = excluded.status,
             last_seen = excluded.last_seen,
             error_count = excluded.error_count,
             last_error = excluded.last_error`,
          [h.book, h.status, h.lastSeen, h.errorCount, h.lastError]
        );
      }
    } catch (error) {
      console.error('[OddsPoller] Health check error:', error);
    }
  }

  private async persistOdds(odds: EventOdds[]): Promise<void> {
    for (const ev of odds) {
      await this.db.run(
        `INSERT INTO events (id, sport, league, home_team, away_team, start_time, status, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           last_updated = excluded.last_updated`,
        [ev.event.id, ev.event.sport, ev.event.league, ev.event.homeTeam, ev.event.awayTeam, ev.event.startTime, ev.event.status]
      );

      for (const book of ev.books) {
        await this.db.run(
          `INSERT INTO odds_snapshots (event_id, book, spread_home, spread_away, spread_home_price, spread_away_price, total_over, total_under, total_over_price, total_under_price, moneyline_home, moneyline_away, scraped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(event_id, book) DO UPDATE SET
             spread_home = excluded.spread_home,
             spread_away = excluded.spread_away,
             spread_home_price = excluded.spread_home_price,
             spread_away_price = excluded.spread_away_price,
             total_over = excluded.total_over,
             total_under = excluded.total_under,
             total_over_price = excluded.total_over_price,
             total_under_price = excluded.total_under_price,
             moneyline_home = excluded.moneyline_home,
             moneyline_away = excluded.moneyline_away,
             scraped_at = excluded.scraped_at`,
          [ev.event.id, book.book, book.spreadHome, book.spreadAway, book.spreadHomePrice, book.spreadAwayPrice, book.totalOver, book.totalUnder, book.totalOverPrice, book.totalUnderPrice, book.moneylineHome, book.moneylineAway]
        );
      }
    }
  }

  private async persistMovements(movements: LineMovement[]): Promise<void> {
    for (const m of movements) {
      await this.db.run(
        `INSERT INTO line_movements (event_id, book, market, side, old_value, new_value, delta, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.eventId, m.book, m.market, m.side, m.oldValue, m.newValue, m.delta, m.recordedAt]
      );
    }
  }

  // ==================== Query Helpers ====================

  async getEvents(): Promise<any[]> {
    return this.db.all(`SELECT * FROM events ORDER BY start_time ASC`);
  }

  async getOddsForEvent(eventId: string): Promise<any[]> {
    return this.db.all(
      `SELECT * FROM odds_snapshots WHERE event_id = ? ORDER BY book`,
      [eventId]
    );
  }

  async getAllOdds(): Promise<any[]> {
    return this.db.all(`
      SELECT o.*, e.sport, e.league, e.home_team, e.away_team, e.start_time
      FROM odds_snapshots o
      JOIN events e ON o.event_id = e.id
      ORDER BY e.start_time, o.book
    `);
  }

  async getMovements(eventId?: string, limit: number = 100): Promise<any[]> {
    if (eventId) {
      return this.db.all(
        `SELECT * FROM line_movements WHERE event_id = ? ORDER BY recorded_at DESC LIMIT ?`,
        [eventId, limit]
      );
    }
    return this.db.all(
      `SELECT * FROM line_movements ORDER BY recorded_at DESC LIMIT ?`,
      [limit]
    );
  }

  async getBookHealth(): Promise<any[]> {
    return this.db.all(`SELECT * FROM book_health ORDER BY book`);
  }

  /**
   * Return a structured odds matrix suitable for the Trading Floor grid.
   * Includes games, per-book odds, recent movements, open lines, and patterns.
   */
  async getLiveOddsMatrix(sport?: string, books?: string[], includeBookMoves: boolean = false): Promise<any> {
    // Fetch events
    let eventRows: any[];
    if (sport && sport !== 'all') {
      eventRows = await this.db.all(
        `SELECT * FROM events WHERE sport = ? OR league = ? ORDER BY start_time ASC`,
        [sport, sport]
      );
    } else {
      eventRows = await this.db.all(`SELECT * FROM events ORDER BY start_time ASC`);
    }

    const eventIds = eventRows.map(e => e.id);
    if (eventIds.length === 0) {
      return { games: [], books: [], movements: [], patterns: [] };
    }

    const placeholders = eventIds.map(() => '?').join(',');

    // Fetch odds snapshots
    const oddsRows = await this.db.all(
      `SELECT * FROM odds_snapshots WHERE event_id IN (${placeholders})`,
      eventIds
    );

    // Fetch recent movements for these events. The top-level list is enough for
    // grid arrows and tooltips; per-book expansion is opt-in because it balloons
    // the payload quickly.
    const allMovementRows = await this.db.all(
      `SELECT * FROM line_movements WHERE event_id IN (${placeholders}) ORDER BY recorded_at DESC LIMIT 500`,
      [...eventIds]
    );

    // Fetch open lines (first snapshot of the day per event/book)
    const today = new Date().toISOString().split('T')[0];
    const openLineRows = await this.db.all(
      `SELECT event_id, book, spread_home, spread_away, spread_home_price, spread_away_price, total_over, total_under, total_over_price, total_under_price, moneyline_home, moneyline_away, MIN(scraped_at) as open_at
       FROM odds_snapshots
       WHERE event_id IN (${placeholders}) AND scraped_at >= ?
       GROUP BY event_id, book`,
      [...eventIds, today]
    );

    // Group odds by event and book
    const booksSet = new Set<string>();
    const oddsByEvent: Record<string, Record<string, any>> = {};
    const lastUpdatedByEventBook: Record<string, string> = {};
    for (const row of oddsRows) {
      if (!oddsByEvent[row.event_id]) oddsByEvent[row.event_id] = {};
      oddsByEvent[row.event_id][row.book] = row;
      booksSet.add(row.book);
      const key = `${row.event_id}:${row.book}`;
      if (!lastUpdatedByEventBook[key] || row.scraped_at > lastUpdatedByEventBook[key]) {
        lastUpdatedByEventBook[key] = row.scraped_at;
      }
    }

    // Group open lines
    const openLinesByKey: Record<string, any> = {};
    for (const row of openLineRows) {
      const key = `${row.event_id}:${row.book}`;
      openLinesByKey[key] = row;
    }

    // Group all movements by event and book only when a caller explicitly needs
    // expanded per-cell history.
    const movementsByEventBook: Record<string, any[]> = {};
    if (includeBookMoves) {
      for (const m of allMovementRows) {
        const key = `${m.event_id}:${m.book}`;
        if (!movementsByEventBook[key]) movementsByEventBook[key] = [];
        movementsByEventBook[key].push(m);
      }
    }

    // Build latest movement lookup
    const latestMovementByKey: Record<string, any> = {};
    const recentMovementCountByEvent: Record<string, number> = {};
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    for (const m of allMovementRows) {
      const key = `${m.event_id}:${m.book}:${m.market}:${m.side}`;
      if (!latestMovementByKey[key] || m.recorded_at > latestMovementByKey[key].recorded_at) {
        latestMovementByKey[key] = m;
      }
      if (m.recorded_at >= fiveMinAgo) {
        recentMovementCountByEvent[m.event_id] = (recentMovementCountByEvent[m.event_id] || 0) + 1;
      }
    }

    // Filter books if requested
    let bookList = Array.from(booksSet).sort();
    if (books && books.length > 0) {
      bookList = bookList.filter(b => books.includes(b));
    }

    // Detect patterns from movements
    const patterns = this.detectPatterns(allMovementRows, eventIds);

    // Build games array
    const games = eventRows.map(ev => {
      const eventOdds = oddsByEvent[ev.id] || {};
      const booksData: Record<string, any> = {};

      for (const book of bookList) {
        const snap = eventOdds[book];
        if (!snap) continue;
        const openKey = `${ev.id}:${book}`;
        const openLine = openLinesByKey[openKey];
        const lastUpdated = lastUpdatedByEventBook[openKey] || snap.scraped_at;

        const bookPayload: any = {
          moneyline: {
            home: snap.moneyline_home,
            away: snap.moneyline_away,
            lastUpdated,
          },
          spread: {
            home: snap.spread_home,
            away: snap.spread_away,
            homePrice: snap.spread_home_price,
            awayPrice: snap.spread_away_price,
            lastUpdated,
          },
          total: {
            over: snap.total_over,
            under: snap.total_under,
            overPrice: snap.total_over_price,
            underPrice: snap.total_under_price,
            lastUpdated,
          },
          openLine: openLine ? {
            spread: { home: openLine.spread_home, away: openLine.spread_away, homePrice: openLine.spread_home_price, awayPrice: openLine.spread_away_price },
            moneyline: { home: openLine.moneyline_home, away: openLine.moneyline_away },
            total: { over: openLine.total_over, under: openLine.total_under, overPrice: openLine.total_over_price, underPrice: openLine.total_under_price },
          } : null,
        };

        if (includeBookMoves) {
          const bookMoves = movementsByEventBook[openKey] || [];
          const recentMoves: Record<string, any[]> = {};
          const marketSideKeys = ['spread:home', 'spread:away', 'moneyline:home', 'moneyline:away', 'total:over', 'total:under'];
          for (const msk of marketSideKeys) {
            const [mkt, side] = msk.split(':');
            const moves = bookMoves
              .filter((m: any) => m.market === mkt && m.side === side)
              .slice(0, 5);
            if (moves.length > 0) recentMoves[msk] = moves;
          }
          bookPayload.recentMoves = recentMoves;
        }

        booksData[book] = bookPayload;
      }

      // Compute consensus from Pinnacle
      let consensus: any = null;
      const pin = eventOdds['PIN'];
      if (pin) {
        consensus = {
          spread: { home: pin.spread_home, away: pin.spread_away, homePrice: pin.spread_home_price, awayPrice: pin.spread_away_price },
          moneyline: { home: pin.moneyline_home, away: pin.moneyline_away },
          total: { over: pin.total_over, under: pin.total_under, overPrice: pin.total_over_price, underPrice: pin.total_under_price },
        };
      }

      // Find best prices across visible books for each market
      const bestPrices: Record<string, any> = {};
      for (const market of ['spread', 'moneyline', 'total']) {
        const sides = market === 'total' ? ['over', 'under'] : ['home', 'away'];
        bestPrices[market] = {};
        for (const side of sides) {
          let best: any = null;
          for (const book of bookList) {
            const b = booksData[book];
            if (!b || !b[market]) continue;
            const val = b[market][side];
            if (val === null || val === undefined) continue;
            if (!best || val > best.val) best = { book, val };
          }
          bestPrices[market][side] = best;
        }
      }

      return {
        id: ev.id,
        sport: ev.sport,
        league: ev.league,
        home: ev.home_team,
        away: ev.away_team,
        startTime: ev.start_time,
        status: ev.status,
        consensus,
        bestPrices,
        recentMovementCount: recentMovementCountByEvent[ev.id] || 0,
        books: booksData,
      };
    });

    // Build book metadata
    const health = await this.getBookHealth();
    const healthMap: Record<string, any> = {};
    for (const h of health) healthMap[h.book] = h;

    const booksMeta = bookList.map(b => ({
      key: b,
      name: b,
      status: healthMap[b]?.status || 'unknown',
      lastSeen: healthMap[b]?.last_seen || null,
    }));

    return { games, books: booksMeta, movements: allMovementRows.slice(0, 50), patterns };
  }

  /**
   * Detect patterns from line movements.
   * Steam Move: 3+ books move same direction on same market within 90s.
   * Reverse Line: Public books move one way, sharp books move the other.
   */
  private detectPatterns(movements: any[], eventIds: string[]): any[] {
    const patterns: any[] = [];
    const sharpBooks = new Set(['PIN', 'SBO', 'STK', 'NIT']);
    const publicBooks = new Set(['DK', 'FD', 'MGM', 'CZR', 'PB', 'BR', 'BS', 'BOV']);

    // Group movements by event and market
    const byEventMarket: Record<string, any[]> = {};
    for (const m of movements) {
      const key = `${m.event_id}:${m.market}:${m.side}`;
      if (!byEventMarket[key]) byEventMarket[key] = [];
      byEventMarket[key].push(m);
    }

    for (const [key, moves] of Object.entries(byEventMarket)) {
      const [eventId, market, side] = key.split(':');
      if (!eventIds.includes(eventId)) continue;
      moves.sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());

      // Detect steam moves: cluster of 3+ moves within 90s
      for (let i = 0; i < moves.length; i++) {
        const cluster = [moves[i]];
        const startTime = new Date(moves[i].recorded_at).getTime();
        for (let j = i + 1; j < moves.length; j++) {
          const t = new Date(moves[j].recorded_at).getTime();
          if (t - startTime <= 90000) cluster.push(moves[j]);
          else break;
        }
        if (cluster.length >= 3) {
          const trigger = cluster[0];
          const followedBy = cluster.slice(1).map((m: any) => ({
            book: m.book,
            newValue: m.new_value,
            lagMs: new Date(m.recorded_at).getTime() - new Date(trigger.recorded_at).getTime(),
          }));
          patterns.push({
            id: `steam-${eventId}-${market}-${side}-${trigger.recorded_at}`,
            eventId,
            type: 'Steam Move',
            market,
            side,
            severity: cluster.length >= 5 ? 'critical' : cluster.length >= 4 ? 'warning' : 'info',
            triggerBook: trigger.book,
            followedBy,
            detectedAt: new Date(trigger.recorded_at).toISOString(),
            description: `Sharp money detected on ${side} ${market}. ${cluster.length} books moved within ${Math.round((followedBy[followedBy.length - 1]?.lagMs || 0) / 1000)}s.`,
          });
          i += cluster.length - 1;
        }
      }

      // Detect reverse line moves
      const sharpMoves = moves.filter((m: any) => sharpBooks.has(m.book));
      const publicMoves = moves.filter((m: any) => publicBooks.has(m.book));
      if (sharpMoves.length > 0 && publicMoves.length > 0) {
        const lastSharp = sharpMoves[sharpMoves.length - 1];
        const lastPublic = publicMoves[publicMoves.length - 1];
        if (lastSharp.delta * lastPublic.delta < 0) {
          patterns.push({
            id: `reverse-${eventId}-${market}-${side}-${lastSharp.recorded_at}`,
            eventId,
            type: 'Reverse Line',
            market,
            side,
            severity: 'warning',
            triggerBook: lastSharp.book,
            followedBy: publicMoves.slice(-2).map((m: any) => ({
              book: m.book,
              newValue: m.new_value,
              lagMs: new Date(m.recorded_at).getTime() - new Date(lastSharp.recorded_at).getTime(),
            })),
            detectedAt: new Date(lastSharp.recorded_at).toISOString(),
            description: `Public on ${lastPublic.book} moved opposite to sharp action on ${lastSharp.book}.`,
          });
        }
      }
    }

    return patterns;
  }

  async getBooksList(): Promise<any[]> {
    const health = await this.getBookHealth();
    const allBooks = new Set(health.map(h => h.book));
    // Also include books from current odds
    const oddsBooks = await this.db.all(`SELECT DISTINCT book FROM odds_snapshots`);
    for (const row of oddsBooks) allBooks.add(row.book);

    const list = Array.from(allBooks).sort().map(b => {
      const h = health.find(x => x.book === b);
      return {
        key: b,
        name: b,
        status: h?.status || 'unknown',
        category: guessBookCategory(b),
      };
    });
    return list;
  }
}

function guessBookCategory(book: string): string {
  const asian = ['PIN', 'SBO', 'STK', 'NIT'];
  const pph = ['BUC', 'ACE', 'MET'];
  const crypto = ['BR'];
  const traditional = ['DK', 'FD', 'MGM', 'CZR', 'PB'];
  if (asian.includes(book)) return 'asian';
  if (pph.includes(book)) return 'pph';
  if (crypto.includes(book)) return 'crypto';
  if (traditional.includes(book)) return 'traditional';
  return 'offshore';
}
