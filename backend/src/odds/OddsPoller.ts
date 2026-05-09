/**
 * OddsPoller
 * Orchestrates odds polling from one or more providers,
 * persists snapshots, detects line movements, and tracks book health.
 */

import type { Database } from '../database';
import type { OddsProvider, EventOdds, LineMovement, BookHealth } from './types';
import { DemoOddsProvider } from './providers/DemoOddsProvider';
import { TheOddsProvider } from './providers/TheOddsApiProvider';
import { createManagedInterval, type ManagedIntervalTask } from '../services/Scheduler';

type PatternSeverity = 'info' | 'warning' | 'critical';

interface DetectedPattern {
  id: string;
  eventId: string;
  type: string;
  market: string;
  side: string;
  severity: PatternSeverity;
  score: number;
  triggerBook: string;
  followedBy: Array<{ book: string; newValue: number; lagMs: number }>;
  detectedAt: string;
  description: string;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class OddsPoller {
  private db: Database;
  private provider: OddsProvider;
  private pollTask: ManagedIntervalTask | null = null;
  private healthTask: ManagedIntervalTask | null = null;
  private pollIntervalMs: number = 30000; // 30 seconds
  private healthIntervalMs: number = 60000; // 60 seconds
  private lastOdds: EventOdds[] = [];
  private broadcast: (msg: object) => void;

  constructor(db: Database, broadcast: (msg: object) => void) {
    this.db = db;
    this.broadcast = broadcast;
    this.pollIntervalMs = readPositiveIntEnv('ODDS_POLL_INTERVAL_MS', this.pollIntervalMs);
    this.healthIntervalMs = readPositiveIntEnv('BOOK_HEALTH_INTERVAL_MS', this.healthIntervalMs);

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
    if (this.pollTask?.isRunning()) return;

    this.pollTask = createManagedInterval('odds.poll', this.pollIntervalMs, () => this.poll(), {
      initialDelayMs: 0,
    });
    this.healthTask = createManagedInterval('odds.health', this.healthIntervalMs, () => this.checkHealth(), {
      initialDelayMs: 100,
    });

    console.log(`[OddsPoller] Started polling every ${this.pollIntervalMs}ms`);
  }

  stop(): void {
    this.pollTask?.stop();
    this.healthTask?.stop();
    this.pollTask = null;
    this.healthTask = null;
    console.log('[OddsPoller] Stopped');
  }

  getLastOdds(): EventOdds[] {
    return this.lastOdds;
  }

  private isPolling = false;

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

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
        await this.detectAndPersistPatterns(movements);
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
    } finally {
      this.isPolling = false;
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

  private async detectAndPersistPatterns(movements: LineMovement[]): Promise<void> {
    const eventIds = Array.from(new Set(movements.map(m => m.eventId)));
    if (eventIds.length === 0) return;

    const placeholders = eventIds.map(() => '?').join(',');
    const cutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const recentMovements = await this.db.all(
      `SELECT * FROM line_movements
       WHERE event_id IN (${placeholders}) AND recorded_at >= ?
       ORDER BY recorded_at DESC
       LIMIT 1000`,
      [...eventIds, cutoff]
    );

    const patterns = this.detectPatterns(recentMovements, eventIds);
    const inserted = await this.persistPatterns(patterns);

    for (const pattern of inserted) {
      this.broadcast({
        type: 'pattern.detected',
        timestamp: new Date().toISOString(),
        payload: pattern,
      });
    }
  }

  private async persistPatterns(patterns: DetectedPattern[]): Promise<DetectedPattern[]> {
    const inserted: DetectedPattern[] = [];

    for (const pattern of patterns) {
      const result = await this.db.run(
        `INSERT OR IGNORE INTO detected_patterns
           (id, event_id, type, market, side, severity, score, category, wager_number, agent_login, trigger_book, details_json, description, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pattern.id,
          pattern.eventId,
          pattern.type,
          pattern.market,
          pattern.side,
          pattern.severity,
          pattern.score,
          'odds',
          null,
          null,
          pattern.triggerBook,
          JSON.stringify({ followedBy: pattern.followedBy }),
          pattern.description,
          pattern.detectedAt,
        ]
      );
      if (result.changes > 0) inserted.push(pattern);
    }

    return inserted;
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

  async getPatternHistory(filters: {
    type?: string;
    market?: string;
    severity?: string;
    category?: string;
    sport?: string;
    agent?: string;
    eventId?: string;
    sinceHours?: number;
    limit?: number;
  } = {}): Promise<any[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters.type && filters.type !== 'all') {
      where.push('p.type = ?');
      params.push(filters.type);
    }
    if (filters.market && filters.market !== 'all') {
      where.push('p.market = ?');
      params.push(filters.market);
    }
    if (filters.severity && filters.severity !== 'all') {
      where.push('p.severity = ?');
      params.push(filters.severity);
    }
    if (filters.category && filters.category !== 'all') {
      where.push('p.category = ?');
      params.push(filters.category);
    }
    if (filters.sport && filters.sport !== 'all') {
      where.push('e.sport = ?');
      params.push(filters.sport);
    }
    if (filters.agent && filters.agent !== 'all') {
      where.push(`(p.agent_login = ? OR EXISTS (
        SELECT 1 FROM pattern_agents pa WHERE pa.pattern_id = p.id AND pa.agent_login = ?
      ) OR p.details_json LIKE ? OR p.description LIKE ?)`);
      params.push(filters.agent, filters.agent, `%${filters.agent}%`, `%${filters.agent}%`);
    }
    if (filters.eventId) {
      where.push('p.event_id = ?');
      params.push(filters.eventId);
    }
    if (filters.sinceHours && filters.sinceHours > 0) {
      where.push('p.detected_at >= ?');
      params.push(new Date(Date.now() - filters.sinceHours * 60 * 60 * 1000).toISOString());
    }

    const sqlWhere = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit || 100, 1), 500);
    return this.db.all(
      `SELECT
         p.*,
         e.sport,
         e.league,
         e.home_team,
         e.away_team,
         e.start_time
       FROM detected_patterns p
       LEFT JOIN events e ON e.id = p.event_id
       ${sqlWhere}
       ORDER BY p.detected_at DESC
       LIMIT ?`,
      [...params, limit]
    );
  }

  async getPatternSummary(sinceHours: number = 24): Promise<any> {
    const hours = Math.min(Math.max(sinceHours, 1), 168);
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = await this.db.all(
      `SELECT type, severity, category, COUNT(*) AS count, MAX(detected_at) AS last_detected_at
       FROM detected_patterns
       WHERE detected_at >= ?
       GROUP BY type, severity, category
       ORDER BY category, type, severity`,
      [cutoff]
    );

    const totals: Record<string, number> = {
      'Steam Move': 0,
      'Reverse Line': 0,
      'Syndicate Play': 0,
      Arbitrage: 0,
    };
    const severity: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    const category: Record<string, number> = {
      odds: 0,
      wagers: 0,
      agents: 0,
      ip: 0,
      live: 0,
      feed: 0,
    };
    let total = 0;

    for (const row of rows) {
      totals[row.type] = (totals[row.type] || 0) + Number(row.count || 0);
      severity[row.severity] = (severity[row.severity] || 0) + Number(row.count || 0);
      category[row.category] = (category[row.category] || 0) + Number(row.count || 0);
      total += Number(row.count || 0);
    }

    return { sinceHours: hours, total, byType: totals, bySeverity: severity, byCategory: category, rows };
  }

  async getPatternAgentCounts(sinceHours: number = 24): Promise<any[]> {
    const hours = Math.min(Math.max(sinceHours, 1), 168);
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.db.all(
      `SELECT
         pa.agent_login AS agent,
         COUNT(*) AS pattern_count,
         SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical_count,
         MAX(detected_at) AS last_detected_at
       FROM detected_patterns
       JOIN pattern_agents pa ON pa.pattern_id = detected_patterns.id
       WHERE pa.agent_login IS NOT NULL AND pa.agent_login != '' AND detected_at >= ?
       GROUP BY pa.agent_login
       ORDER BY pattern_count DESC, last_detected_at DESC
       LIMIT 500`,
      [cutoff]
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
  private detectPatterns(movements: any[], eventIds: string[]): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];
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
            score: Math.min(100, 45 + cluster.length * 10 + Math.min(Math.abs(cluster.reduce((sum, m) => sum + Number(m.delta || 0), 0)) * 4, 25)),
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
            score: 70,
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
