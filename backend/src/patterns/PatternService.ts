import crypto from 'crypto';

import type { Database } from '../database';
import type { EnrichedWager, Severity } from '../risk/AlertEngine';
import type { BuckeyeWebLogRow, BuckeyeWebLogType } from '../scrapers/BuckeyeAPI';
import type { EventMatch, ParsedWager, PatternInsert } from './types';
import { normalizeName, parseWagerDescription } from './wagerParser';

interface WagerCorrelation {
  parsed: ParsedWager;
  match: EventMatch;
  pinReference: Record<string, unknown> | null;
}

interface EventRow {
  id: string;
  sport: string;
  league?: string;
  home_team: string;
  away_team: string;
  start_time?: string | null;
}

const GLOBAL_EVENT_ID = 'pattern-global';

export class PatternService {
  constructor(
    private readonly db: Database,
    private readonly broadcast?: (msg: object) => void
  ) {}

  async correlateWager(wager: EnrichedWager): Promise<WagerCorrelation> {
    const parsed = parseWagerDescription(wager.ShortDesc);
    const match = await this.matchEvent(parsed, this.parseSport(wager.ShortDesc));
    const pinReference = match.eventId ? await this.getPinReference(match.eventId) : null;

    return { parsed, match, pinReference };
  }

  async analyzeWager(wager: EnrichedWager, correlation: WagerCorrelation): Promise<PatternInsert[]> {
    const patterns: PatternInsert[] = [];
    const detectedAt = new Date().toISOString();
    const wagerTime = parseDate(wager.InsertDateTime) || new Date();
    const gameKey = gameKeyFor(correlation.parsed.game);
    const eventId = correlation.match.eventId || GLOBAL_EVENT_ID;

    const recent = await this.getRecentWagers(wagerTime, 10);
    const sameSpot = recent.filter((row: any) =>
      gameKeyFor(row.parsed_game || '') === gameKey &&
      row.parsed_market === correlation.parsed.market &&
      row.parsed_side === correlation.parsed.side
    );

    const sameAgent = sameSpot.filter((row: any) => row.agent_login === wager.AgentLogin);
    const sameAgentPlayers = new Set(sameAgent.map((row: any) => row.login).filter(Boolean));
    if (sameAgent.length >= 4 || sameAgentPlayers.size >= 3) {
      patterns.push(this.pattern({
        type: 'Agent Swarm',
        category: 'agents',
        eventId,
        parsed: correlation.parsed,
        severity: sameAgentPlayers.size >= 4 ? 'critical' : 'warning',
        score: Math.min(95, 68 + sameAgentPlayers.size * 6 + sameAgent.length * 2),
        description: `${wager.AgentLogin} players clustered on ${correlation.parsed.side} ${correlation.parsed.market}.`,
        detectedAt,
        parts: ['agent-swarm', wager.AgentLogin, gameKey, correlation.parsed.market, correlation.parsed.side, minuteBucket(wagerTime, 10)],
        details: {
          wagerNumber: wager.WagerNumber,
          agent: wager.AgentLogin,
          players: Array.from(sameAgentPlayers).slice(0, 12),
          wagerCount: sameAgent.length,
          windowMinutes: 10,
          reasonCodes: ['same_agent', 'same_game_side', 'tight_window'],
          correlation,
        },
      }));
    }

    const crossAgents = new Set(sameSpot.map((row: any) => row.agent_login).filter(Boolean));
    if (crossAgents.size >= 2 && sameSpot.length >= 3) {
      patterns.push(this.pattern({
        type: 'cross_agent_steam',
        category: 'agents',
        eventId,
        parsed: correlation.parsed,
        severity: crossAgents.size >= 3 ? 'critical' : 'warning',
        score: Math.min(96, 70 + crossAgents.size * 6 + sameSpot.length),
        description: `${crossAgents.size} agents steamed ${correlation.parsed.side} ${correlation.parsed.market} together.`,
        detectedAt,
        parts: ['cross-agent-steam', gameKey, correlation.parsed.market, correlation.parsed.side, minuteBucket(wagerTime, 10)],
        details: {
          wagerNumber: wager.WagerNumber,
          agent: wager.AgentLogin,
          agents: Array.from(crossAgents).slice(0, 12),
          wagerCount: sameSpot.length,
          windowMinutes: 10,
          reasonCodes: ['two_plus_agents', 'same_game_side', 'steam_window'],
          correlation,
        },
      }));
    }
    if (crossAgents.size >= 3) {
      patterns.push(this.pattern({
        type: 'Cross-Agent Swarm',
        category: 'agents',
        eventId,
        parsed: correlation.parsed,
        severity: crossAgents.size >= 4 ? 'critical' : 'warning',
        score: Math.min(96, 72 + crossAgents.size * 5 + sameSpot.length),
        description: `${crossAgents.size} agents hit ${correlation.parsed.side} ${correlation.parsed.market} inside 10 minutes.`,
        detectedAt,
        parts: ['cross-agent-swarm', gameKey, correlation.parsed.market, correlation.parsed.side, minuteBucket(wagerTime, 10)],
        details: {
          wagerNumber: wager.WagerNumber,
          agents: Array.from(crossAgents).slice(0, 12),
          wagerCount: sameSpot.length,
          windowMinutes: 10,
          reasonCodes: ['multiple_agents', 'same_game_side', 'tight_window'],
          correlation,
        },
      }));
    }

    await this.addLivePatterns(patterns, wager, correlation, detectedAt, wagerTime);
    await this.addAgentReversalPattern(patterns, wager, correlation, detectedAt, wagerTime);
    await this.addLateMoneyPattern(patterns, wager, correlation, detectedAt, wagerTime);
    await this.addVelocityPattern(patterns, wager, correlation, detectedAt, wagerTime);
    await this.addPinPatterns(patterns, wager, correlation, detectedAt, wagerTime);
    await this.addSteamChasePattern(patterns, wager, correlation, detectedAt, wagerTime);
    await this.applyOddsCorrelation(patterns, correlation, wagerTime);

    return patterns;
  }

  async persistAccessLogs(agentId: string, rows: BuckeyeWebLogRow[], logType: BuckeyeWebLogType): Promise<number> {
    const pulledAt = new Date().toISOString();
    let inserted = 0;

    for (const row of rows) {
      if (!row.LoginID || !row.IPAddress) continue;
      const id = hashId([agentId, logType, row.LoginID, row.IPAddress, row.AccessDateTime, row.Operation, row.Data]);
      const result = await this.db.run(
        `INSERT OR IGNORE INTO access_logs
          (id, agent_id, login_id, ip_address, access_datetime, operation, data, log_type, pulled_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          agentId,
          row.LoginID,
          row.IPAddress,
          normalizeAccessDate(row.AccessDateTime),
          row.Operation,
          row.Data,
          logType,
          pulledAt,
          JSON.stringify(row.raw || {}),
        ]
      );
      inserted += result.changes;
    }

    return inserted;
  }

  async analyzeAccessLogs(agentId?: string): Promise<PatternInsert[]> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const params: unknown[] = [cutoff];
    const agentWhere = agentId ? 'AND agent_id = ?' : '';
    if (agentId) params.push(agentId);

    const logs = await this.db.all(
      `SELECT * FROM access_logs
       WHERE access_datetime >= ? ${agentWhere}
       ORDER BY access_datetime DESC
       LIMIT 2000`,
      params
    );

    const patterns: PatternInsert[] = [];
    const byIp = groupBy(logs, (row: any) => row.ip_address || '');
    const detectedAt = new Date().toISOString();

    for (const [ip, rows] of byIp) {
      if (!ip) continue;
      const players = new Set(rows.map((row: any) => row.login_id).filter(Boolean));
      if (players.size >= 2) {
        patterns.push(this.pattern({
          type: 'Shared IP Cluster',
          category: 'ip',
          eventId: GLOBAL_EVENT_ID,
          parsed: { game: 'IP Access', market: 'other', side: ip, price: null, period: 'access', teams: [] },
          severity: players.size >= 4 ? 'critical' : 'warning',
          score: Math.min(94, 58 + players.size * 8),
          description: `${players.size} players used ${ip} in the last 24 hours.`,
          detectedAt,
          parts: ['shared-ip', ip, dateBucket(new Date())],
          details: {
            ip,
            players: Array.from(players).slice(0, 20),
            accessCount: rows.length,
            reasonCodes: ['shared_ip', 'multiple_players'],
          },
        }));
      }

      const followPattern = await this.findIpFollowPattern(ip, Array.from(players), rows);
      if (followPattern) {
        patterns.push({
          ...followPattern,
          detectedAt,
        });
      }
    }

    return patterns;
  }

  async persistPatterns(patterns: PatternInsert[]): Promise<PatternInsert[]> {
    const inserted: PatternInsert[] = [];
    await this.ensureGlobalEvent();

    for (const pattern of patterns) {
      if (!pattern.eventId) pattern.eventId = GLOBAL_EVENT_ID;
      if (pattern.eventId === GLOBAL_EVENT_ID) await this.ensureGlobalEvent();

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
          pattern.category,
          pattern.wagerNumber || null,
          pattern.agentLogin || null,
          pattern.triggerBook || null,
          JSON.stringify(pattern.details || {}),
          pattern.description,
          pattern.detectedAt,
        ]
      );

      if (result.changes > 0) {
        inserted.push(pattern);
        const participantAgents = getPatternAgents(pattern);
        await this.persistPatternAgents(pattern.id, participantAgents);
        this.broadcast?.({
          type: 'pattern.detected',
          timestamp: new Date().toISOString(),
          payload: pattern,
        });
        for (const agentLogin of participantAgents) {
          this.broadcast?.({
            type: 'patternUpdate',
            timestamp: new Date().toISOString(),
            payload: {
              agentLogin,
              increment: 1,
              severity: pattern.severity,
              type: pattern.type,
            },
          });
        }
      }
    }

    return inserted;
  }

  private async persistPatternAgents(patternId: string, agents: string[]): Promise<void> {
    for (const agent of agents) {
      await this.db.run(
        `INSERT OR IGNORE INTO pattern_agents (pattern_id, agent_login) VALUES (?, ?)`,
        [patternId, agent]
      );
    }
  }

  private async addLivePatterns(
    patterns: PatternInsert[],
    wager: EnrichedWager,
    correlation: WagerCorrelation,
    detectedAt: string,
    wagerTime: Date
  ): Promise<void> {
    if (!correlation.match.eventId) return;
    const event = await this.db.get<EventRow>('SELECT * FROM events WHERE id = ?', [correlation.match.eventId]);
    const start = event?.start_time ? parseDate(event.start_time) : null;
    const isLiveWriter = wager.TicketWriter === 'GSLIVE';

    if (start && wagerTime.getTime() > start.getTime() + 60_000) {
      const minutesAfterStart = Math.round((wagerTime.getTime() - start.getTime()) / 60000);
      patterns.push(this.pattern({
        type: 'Live Past-Post Risk',
        category: 'live',
        eventId: correlation.match.eventId,
        parsed: correlation.parsed,
        severity: isLiveWriter ? 'warning' : 'critical',
        score: isLiveWriter ? 74 : 93,
        description: `${wager.Login} wager landed ${minutesAfterStart}m after scheduled start${isLiveWriter ? '' : ' outside GSLIVE'}.`,
        detectedAt,
        parts: ['past-post', wager.WagerNumber],
        details: {
          wagerNumber: wager.WagerNumber,
          wagerTime: wager.InsertDateTime,
          eventStart: event.start_time,
          ticketWriter: wager.TicketWriter,
          minutesAfterStart,
          reasonCodes: ['after_event_start', isLiveWriter ? 'live_writer' : 'not_gslive'],
          correlation,
        },
      }));
    }

    if (isLiveWriter) {
      const recentLive = (await this.getRecentWagers(wagerTime, 10)).filter((row: any) =>
        row.ticket_writer === 'GSLIVE' &&
        (row.matched_event_id === correlation.match.eventId || gameKeyFor(row.parsed_game || '') === gameKeyFor(correlation.parsed.game))
      );
      if (recentLive.length >= 5) {
        patterns.push(this.pattern({
          type: 'Late Live Spike',
          category: 'live',
          eventId: correlation.match.eventId,
          parsed: correlation.parsed,
          severity: 'warning',
          score: Math.min(88, 62 + recentLive.length * 3),
          description: `${recentLive.length} live wagers clustered on this event in 10 minutes.`,
          detectedAt,
          parts: ['late-live-spike', correlation.match.eventId, minuteBucket(wagerTime, 10)],
          details: {
            wagerNumber: wager.WagerNumber,
            liveWagerCount: recentLive.length,
            windowMinutes: 10,
            reasonCodes: ['gslive_cluster', 'tight_window'],
            correlation,
          },
        }));
      }
    }
  }

  private async addAgentReversalPattern(
    patterns: PatternInsert[],
    wager: EnrichedWager,
    correlation: WagerCorrelation,
    detectedAt: string,
    wagerTime: Date
  ): Promise<void> {
    const recent = await this.db.all(
      `SELECT w.parsed_side, w.parsed_market, w.sport, w.wager_number, e.home_team, e.away_team
       FROM wagers w
       LEFT JOIN events e ON e.id = w.matched_event_id
       WHERE w.agent_login = ? AND w.wager_number != ? AND w.sport = ? AND w.parsed_market = ?
         AND w.parsed_side IS NOT NULL AND w.insert_datetime <= ?
       ORDER BY insert_datetime DESC
       LIMIT 5`,
      [wager.AgentLogin, wager.WagerNumber, this.parseSport(wager.ShortDesc), correlation.parsed.market, wagerTime.toISOString()]
    );
    if (recent.length < 5) return;

    const sides = recent
      .map((row: any) => classifyComparableSide(row.parsed_side, row.parsed_market, row.home_team, row.away_team))
      .filter(side => side && side !== 'unknown');
    const counts = new Map<string, number>();
    for (const side of sides) counts.set(side, (counts.get(side) || 0) + 1);
    const majority = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
    const currentEvent = correlation.match.eventId
      ? await this.db.get<EventRow>('SELECT * FROM events WHERE id = ?', [correlation.match.eventId])
      : null;
    const currentSide = classifyComparableSide(
      correlation.parsed.side,
      correlation.parsed.market,
      currentEvent?.home_team,
      currentEvent?.away_team
    );
    if (!majority || majority[1] < 3 || !currentSide || majority[0] === currentSide) return;

    patterns.push(this.pattern({
      type: 'agent_reversal',
      category: 'agents',
      eventId: correlation.match.eventId || GLOBAL_EVENT_ID,
      parsed: correlation.parsed,
      severity: majority[1] >= 4 ? 'critical' : 'warning',
      score: 68 + majority[1] * 6,
      description: `${wager.AgentLogin} reversed from recent ${majority[0]} action to ${currentSide}.`,
      detectedAt,
      parts: ['agent-reversal', wager.AgentLogin, wager.WagerNumber],
      details: {
        wagerNumber: wager.WagerNumber,
        agent: wager.AgentLogin,
        currentSide,
        priorMajoritySide: majority[0],
        priorSampleSize: recent.length,
        priorMajorityCount: majority[1],
        reasonCodes: ['agent_side_reversal', 'last_five_sport_wagers'],
        correlation,
      },
    }));
  }

  private async addLateMoneyPattern(
    patterns: PatternInsert[],
    wager: EnrichedWager,
    correlation: WagerCorrelation,
    detectedAt: string,
    wagerTime: Date
  ): Promise<void> {
    if (!correlation.match.eventId) return;
    const event = await this.db.get<EventRow>('SELECT * FROM events WHERE id = ?', [correlation.match.eventId]);
    const start = event?.start_time ? parseDate(event.start_time) : null;
    if (!start) return;
    const minutesToStart = Math.round((start.getTime() - wagerTime.getTime()) / 60000);
    if (minutesToStart < 0 || minutesToStart > 15) return;

    const avgRow = await this.db.get<any>(
      `SELECT AVG(amount_wagered) AS avg_amount, COUNT(*) AS count
       FROM wagers
       WHERE agent_login = ? AND sport = ? AND wager_number != ? AND insert_datetime < ?`,
      [wager.AgentLogin, this.parseSport(wager.ShortDesc), wager.WagerNumber, wagerTime.toISOString()]
    );
    const avgAmount = Number(avgRow?.avg_amount || 0);
    if (Number(avgRow?.count || 0) < 3 || wager.AmountWagered <= avgAmount) return;

    const ratio = avgAmount > 0 ? wager.AmountWagered / avgAmount : 1;
    patterns.push(this.pattern({
      type: 'late_money',
      category: 'agents',
      eventId: correlation.match.eventId,
      parsed: correlation.parsed,
      severity: ratio >= 3 ? 'critical' : 'warning',
      score: Math.min(96, 62 + Math.round(ratio * 10)),
      description: `${wager.AgentLogin} placed above-average money ${minutesToStart}m before start.`,
      detectedAt,
      parts: ['late-money', wager.AgentLogin, wager.WagerNumber],
      details: {
        wagerNumber: wager.WagerNumber,
        agent: wager.AgentLogin,
        amount: wager.AmountWagered,
        agentAverageAmount: avgAmount,
        ratio,
        minutesToStart,
        eventStart: event.start_time,
        reasonCodes: ['near_game_start', 'above_agent_average'],
        correlation,
      },
    }));
  }

  private async addVelocityPattern(
    patterns: PatternInsert[],
    wager: EnrichedWager,
    correlation: WagerCorrelation,
    detectedAt: string,
    wagerTime: Date
  ): Promise<void> {
    const hourStart = new Date(wagerTime);
    hourStart.setMinutes(0, 0, 0);
    const previousWindowStart = new Date(hourStart.getTime() - 24 * 60 * 60 * 1000);
    const current = await this.db.get<any>(
      `SELECT COUNT(*) AS count FROM wagers WHERE agent_login = ? AND insert_datetime >= ? AND insert_datetime <= ?`,
      [wager.AgentLogin, hourStart.toISOString(), wagerTime.toISOString()]
    );
    const previous = await this.db.get<any>(
      `SELECT COUNT(*) AS count FROM wagers WHERE agent_login = ? AND insert_datetime >= ? AND insert_datetime < ?`,
      [wager.AgentLogin, previousWindowStart.toISOString(), hourStart.toISOString()]
    );
    const currentCount = Number(current?.count || 0);
    const normalHourly = Number(previous?.count || 0) / 24;
    if (currentCount < 6 || currentCount < Math.max(3, normalHourly * 3)) return;

    patterns.push(this.pattern({
      type: 'velocity_spike',
      category: 'agents',
      eventId: correlation.match.eventId || GLOBAL_EVENT_ID,
      parsed: correlation.parsed,
      severity: currentCount >= Math.max(12, normalHourly * 5) ? 'critical' : 'warning',
      score: Math.min(98, 64 + Math.round(currentCount + normalHourly * 2)),
      description: `${wager.AgentLogin} velocity spiked to ${currentCount} wagers this hour.`,
      detectedAt,
      parts: ['velocity-spike', wager.AgentLogin, minuteBucket(wagerTime, 60)],
      details: {
        wagerNumber: wager.WagerNumber,
        agent: wager.AgentLogin,
        currentHourCount: currentCount,
        baselineHourlyCount: normalHourly,
        reasonCodes: ['agent_velocity_spike', 'three_x_baseline'],
        correlation,
      },
    }));
  }

  private async applyOddsCorrelation(
    patterns: PatternInsert[],
    correlation: WagerCorrelation,
    wagerTime: Date
  ): Promise<void> {
    if (!correlation.match.eventId) return;
    for (const pattern of patterns) {
      const moves = await this.db.all(
        `SELECT * FROM line_movements
         WHERE event_id = ? AND market = ? AND ABS(delta) >= 10 AND recorded_at >= ? AND recorded_at <= ?
         ORDER BY recorded_at DESC
         LIMIT 5`,
        [
          correlation.match.eventId,
          pattern.market,
          new Date(wagerTime.getTime() - 2 * 60 * 1000).toISOString(),
          new Date(wagerTime.getTime() + 2 * 60 * 1000).toISOString(),
        ]
      );
      if (!moves.length) continue;
      pattern.severity = 'critical';
      pattern.score = Math.max(pattern.score, 92);
      pattern.details = {
        ...pattern.details,
        oddsCorrelation: moves,
        reasonCodes: Array.from(new Set([...(pattern.details.reasonCodes as string[] || []), 'odds_move_correlation'])),
      };
    }
  }

  private async addPinPatterns(
    patterns: PatternInsert[],
    wager: EnrichedWager,
    correlation: WagerCorrelation,
    detectedAt: string,
    wagerTime: Date
  ): Promise<void> {
    if (!correlation.match.eventId) return;

    const comparable = getComparablePinPrice(correlation.parsed, correlation.pinReference);
    if (correlation.parsed.price !== null && comparable !== null) {
      const diff = Math.abs(correlation.parsed.price - comparable);
      if (diff >= 20) {
        patterns.push(this.pattern({
          type: 'Pinnacle Drift Bet',
          category: 'wagers',
          eventId: correlation.match.eventId,
          parsed: correlation.parsed,
          severity: diff >= 35 ? 'critical' : 'warning',
          score: Math.min(96, 64 + Math.round(diff)),
          triggerBook: 'PIN',
          description: `${wager.Login} accepted ${correlation.parsed.price} while PIN reference was ${comparable}.`,
          detectedAt,
          parts: ['pin-drift', wager.WagerNumber],
          details: {
            wagerNumber: wager.WagerNumber,
            acceptedPrice: correlation.parsed.price,
            pinPrice: comparable,
            priceDiff: diff,
            pinReference: correlation.pinReference,
            reasonCodes: ['off_market_price', 'pin_reference'],
            correlation,
          },
        }));
      }
    }

    const pinMoves = await this.db.all(
      `SELECT * FROM line_movements
       WHERE event_id = ? AND book = 'PIN' AND market = ? AND recorded_at >= ? AND recorded_at <= ?
       ORDER BY recorded_at DESC
       LIMIT 20`,
      [
        correlation.match.eventId,
        normalizeMarketForOdds(correlation.parsed.market),
        new Date(wagerTime.getTime() - 5 * 60 * 1000).toISOString(),
        wagerTime.toISOString(),
      ]
    );

    if (pinMoves.length > 0) {
      patterns.push(this.pattern({
        type: 'Post-PIN Move Bet',
        category: 'wagers',
        eventId: correlation.match.eventId,
        parsed: correlation.parsed,
        severity: 'warning',
        score: Math.min(90, 66 + pinMoves.length * 4),
        triggerBook: 'PIN',
        description: `${wager.Login} bet shortly after a material PIN ${correlation.parsed.market} move.`,
        detectedAt,
        parts: ['post-pin-move', wager.WagerNumber],
        details: {
          wagerNumber: wager.WagerNumber,
          moves: pinMoves.slice(0, 5),
          windowMinutes: 5,
          reasonCodes: ['pin_moved_first', 'short_lag'],
          correlation,
        },
      }));
    }

    await this.addRepeatTimingPattern(patterns, wager, correlation, detectedAt, wagerTime);
  }

  private async addRepeatTimingPattern(
    patterns: PatternInsert[],
    wager: EnrichedWager,
    correlation: WagerCorrelation,
    detectedAt: string,
    wagerTime: Date
  ): Promise<void> {
    if (!correlation.match.eventId) return;
    const recentPlayerWagers = (await this.db.all(
      `SELECT * FROM wagers
       WHERE login = ? AND matched_event_id IS NOT NULL AND insert_datetime >= ?
       ORDER BY insert_datetime DESC
       LIMIT 30`,
      [wager.Login, new Date(wagerTime.getTime() - 60 * 60 * 1000).toISOString()]
    )).filter((row: any) => row.parsed_market === correlation.parsed.market);

    let timingHits = 0;
    for (const row of recentPlayerWagers) {
      const rowTime = parseDate(row.insert_datetime);
      if (!rowTime) continue;
      const move = await this.db.get(
        `SELECT id FROM line_movements
         WHERE event_id = ? AND book = 'PIN' AND market = ? AND recorded_at >= ? AND recorded_at <= ?
         LIMIT 1`,
        [
          row.matched_event_id,
          normalizeMarketForOdds(row.parsed_market),
          new Date(rowTime.getTime() - 120_000).toISOString(),
          rowTime.toISOString(),
        ]
      );
      if (move) timingHits++;
    }

    if (timingHits >= 3) {
      patterns.push(this.pattern({
        type: 'Repeat Timing Signature',
        category: 'wagers',
        eventId: correlation.match.eventId,
        parsed: correlation.parsed,
        severity: timingHits >= 5 ? 'critical' : 'warning',
        score: Math.min(95, 64 + timingHits * 7),
        triggerBook: 'PIN',
        description: `${wager.Login} repeatedly bets within two minutes of PIN moves.`,
        detectedAt,
        parts: ['repeat-timing', wager.Login, correlation.parsed.market, minuteBucket(wagerTime, 60)],
        details: {
          wagerNumber: wager.WagerNumber,
          player: wager.Login,
          timingHits,
          windowMinutes: 60,
          reasonCodes: ['repeat_player_timing', 'pin_move_lag'],
          correlation,
        },
      }));
    }
  }

  private async addSteamChasePattern(
    patterns: PatternInsert[],
    wager: EnrichedWager,
    correlation: WagerCorrelation,
    detectedAt: string,
    wagerTime: Date
  ): Promise<void> {
    if (!correlation.match.eventId) return;
    const steam = await this.db.get(
      `SELECT * FROM detected_patterns
       WHERE event_id = ? AND type = 'Steam Move' AND market = ? AND detected_at >= ? AND detected_at <= ?
       ORDER BY detected_at DESC
       LIMIT 1`,
      [
        correlation.match.eventId,
        normalizeMarketForOdds(correlation.parsed.market),
        new Date(wagerTime.getTime() - 10 * 60 * 1000).toISOString(),
        wagerTime.toISOString(),
      ]
    );
    if (!steam) return;

    patterns.push(this.pattern({
      type: 'Steam Chase',
      category: 'wagers',
      eventId: correlation.match.eventId,
      parsed: correlation.parsed,
      severity: 'warning',
      score: 76,
      description: `${wager.Login} followed an existing steam move on ${correlation.parsed.market}.`,
      detectedAt,
      parts: ['steam-chase', wager.WagerNumber],
      details: {
        wagerNumber: wager.WagerNumber,
        steamPatternId: (steam as any).id,
        reasonCodes: ['existing_steam', 'customer_followed'],
        correlation,
      },
    }));
  }

  private async findIpFollowPattern(ip: string, players: string[], rows: any[]): Promise<PatternInsert | null> {
    if (players.length < 2) return null;
    const placeholders = players.map(() => '?').join(',');
    const wagers = await this.db.all(
      `SELECT * FROM wagers
       WHERE login IN (${placeholders}) AND parsed_game IS NOT NULL AND insert_datetime >= ?
       ORDER BY insert_datetime DESC
       LIMIT 500`,
      [...players, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
    );

    const grouped = groupBy(wagers, (row: any) =>
      [gameKeyFor(row.parsed_game || ''), row.parsed_market || 'other', row.parsed_side || 'unknown'].join('|')
    );

    for (const [key, group] of grouped) {
      const groupPlayers = new Set(group.map((row: any) => row.login).filter(Boolean));
      if (groupPlayers.size < 2) continue;
      const times = group.map((row: any) => parseDate(row.insert_datetime)?.getTime() || 0).filter(Boolean).sort();
      if (!times.length || times[times.length - 1] - times[0] > 10 * 60 * 1000) continue;
      const [game, market, side] = key.split('|');
      return this.pattern({
        type: 'IP Follow Pattern',
        category: 'ip',
        eventId: (group[0] as any).matched_event_id || GLOBAL_EVENT_ID,
        parsed: { game, market: market as ParsedWager['market'], side, price: null, period: 'game', teams: [] },
        severity: groupPlayers.size >= 3 ? 'critical' : 'warning',
        score: Math.min(94, 70 + groupPlayers.size * 7),
        description: `${groupPlayers.size} players sharing ${ip} bet ${side} ${market} in a tight window.`,
        detectedAt: new Date().toISOString(),
        parts: ['ip-follow', ip, game, market, side, minuteBucket(new Date(times[0]), 10)],
        details: {
          ip,
          players: Array.from(groupPlayers),
          wagerNumbers: group.map((row: any) => row.wager_number).slice(0, 20),
          accessRows: rows.slice(0, 10),
          reasonCodes: ['shared_ip', 'same_game_side', 'tight_wager_window'],
        },
      });
    }

    return null;
  }

  private async matchEvent(parsed: ParsedWager, sport: string): Promise<EventMatch> {
    const events = await this.db.all<EventRow>(
      `SELECT * FROM events
       WHERE start_time IS NULL OR start_time >= ?
       ORDER BY start_time ASC
       LIMIT 300`,
      [new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString()]
    );

    const parsedTeams = parsed.teams.map(normalizeName).filter(Boolean);
    let best: { event: EventRow; confidence: number; reason: string } | null = null;

    for (const event of events) {
      const eventTeams = [event.home_team, event.away_team].map(normalizeName);
      const hitCount = parsedTeams.filter(team => eventTeams.some(eventTeam => eventTeam.includes(team) || team.includes(eventTeam))).length;
      const sportBoost = sport && event.sport && normalizeName(event.sport).includes(normalizeName(sport)) ? 5 : 0;
      const confidence = hitCount >= 2 ? 90 + sportBoost : hitCount === 1 ? 58 + sportBoost : 0;
      if (confidence > (best?.confidence || 0)) {
        best = { event, confidence, reason: hitCount >= 2 ? 'matched both teams' : 'matched one team' };
      }
    }

    if (!best || best.confidence < 60) {
      return { eventId: null, confidence: best?.confidence || 0, reason: 'no confident match' };
    }
    return { eventId: best.event.id, confidence: Math.min(99, best.confidence), reason: best.reason };
  }

  private async getPinReference(eventId: string): Promise<Record<string, unknown> | null> {
    const row = await this.db.get<any>(
      `SELECT o.*, e.home_team, e.away_team
       FROM odds_snapshots o
       JOIN events e ON e.id = o.event_id
       WHERE o.event_id = ? AND o.book = 'PIN'
       LIMIT 1`,
      [eventId]
    );
    if (!row) return null;
    return {
      eventId,
      book: 'PIN',
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      spread: {
        home: row.spread_home,
        away: row.spread_away,
        homePrice: row.spread_home_price,
        awayPrice: row.spread_away_price,
      },
      total: {
        over: row.total_over,
        under: row.total_under,
        overPrice: row.total_over_price,
        underPrice: row.total_under_price,
      },
      moneyline: {
        home: row.moneyline_home,
        away: row.moneyline_away,
      },
      scrapedAt: row.scraped_at,
    };
  }

  private async getRecentWagers(anchor: Date, minutes: number): Promise<any[]> {
    const rows = await this.db.all(
      `SELECT * FROM wagers
       WHERE insert_datetime >= ?
       ORDER BY insert_datetime DESC
       LIMIT 1000`,
      [new Date(anchor.getTime() - minutes * 60 * 1000).toISOString()]
    );
    return rows.filter((row: any) => {
      const t = parseDate(row.insert_datetime);
      return t && t.getTime() >= anchor.getTime() - minutes * 60 * 1000 && t.getTime() <= anchor.getTime() + 60_000;
    });
  }

  private async ensureGlobalEvent(): Promise<void> {
    await this.db.run(
      `INSERT OR IGNORE INTO events (id, sport, league, home_team, away_team, start_time, status, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [GLOBAL_EVENT_ID, 'System', 'Patterns', 'Global', 'Pattern Layer', null, 'live', new Date().toISOString()]
    );
  }

  private pattern(input: {
    type: string;
    category: PatternInsert['category'];
    eventId: string;
    parsed: ParsedWager;
    severity: Severity;
    score: number;
    triggerBook?: string;
    description: string;
    detectedAt: string;
    parts: unknown[];
    details: Record<string, unknown>;
  }): PatternInsert {
    return {
      id: hashId(input.parts),
      eventId: input.eventId || GLOBAL_EVENT_ID,
      type: input.type,
      category: input.category,
      market: normalizeMarketForOdds(input.parsed.market),
      side: input.parsed.side || 'unknown',
      severity: input.severity,
      score: Math.max(1, Math.min(100, Math.round(input.score))),
      wagerNumber: inferWagerNumber(input.details),
      agentLogin: inferAgentLogin(input.details),
      triggerBook: input.triggerBook || null,
      details: input.details,
      description: input.description,
      detectedAt: input.detectedAt,
    };
  }

  private parseSport(desc: string): string {
    const match = (desc || '').match(/^[A-Z][.:]G?\d*\s*-?\s*(?:Top\s+)?([A-Za-z]+)/);
    return match?.[1] || '';
  }
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return map;
}

function hashId(parts: unknown[]): string {
  return crypto.createHash('sha1').update(parts.map(part => String(part ?? '')).join('|')).digest('hex');
}

function gameKeyFor(value: string): string {
  return normalizeName(value || 'unknown').replace(/\s+/g, '-');
}

function dateBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function minuteBucket(date: Date, spanMinutes: number): string {
  const ms = spanMinutes * 60 * 1000;
  return new Date(Math.floor(date.getTime() / ms) * ms).toISOString();
}

function normalizeMarketForOdds(market: string): string {
  return market === 'prop' || market === 'parlay' ? 'other' : market || 'other';
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const direct = new Date(value);
  if (Number.isFinite(direct.getTime())) return direct;
  const normalized = String(value).replace(' ', 'T');
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function normalizeAccessDate(value: string): string {
  return parseDate(value)?.toISOString() || new Date().toISOString();
}

function inferWagerNumber(details: Record<string, unknown>): number | null {
  const direct = Number(details.wagerNumber);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const first = Array.isArray(details.wagerNumbers) ? Number(details.wagerNumbers[0]) : NaN;
  return Number.isFinite(first) && first > 0 ? first : null;
}

function inferAgentLogin(details: Record<string, unknown>): string | null {
  if (typeof details.agent === 'string' && details.agent.trim()) return details.agent.trim();
  if (Array.isArray(details.agents) && details.agents.length > 0) return String(details.agents[0]);
  const correlation = details.correlation as any;
  if (typeof correlation?.wager?.AgentLogin === 'string') return correlation.wager.AgentLogin;
  return null;
}

function getPatternAgents(pattern: PatternInsert): string[] {
  const agents = new Set<string>();
  if (pattern.agentLogin) agents.add(pattern.agentLogin);
  const details = pattern.details || {};
  if (typeof details.agent === 'string' && details.agent.trim()) agents.add(details.agent.trim());
  if (Array.isArray(details.agents)) {
    for (const agent of details.agents) {
      const normalized = String(agent || '').trim();
      if (normalized) agents.add(normalized);
    }
  }
  return Array.from(agents);
}

function classifyComparableSide(
  side: string | null | undefined,
  market: string | null | undefined,
  homeTeam?: string | null,
  awayTeam?: string | null
): string | null {
  const normalizedSide = normalizeName(side || '');
  if (!normalizedSide || normalizedSide === 'unknown') return null;
  if (market === 'total' || normalizedSide === 'over' || normalizedSide === 'under') {
    return normalizedSide === 'under' ? 'under' : normalizedSide === 'over' ? 'over' : null;
  }
  const home = normalizeName(homeTeam || '');
  const away = normalizeName(awayTeam || '');
  if (home && (normalizedSide.includes(home) || home.includes(normalizedSide))) return 'home';
  if (away && (normalizedSide.includes(away) || away.includes(normalizedSide))) return 'away';
  return null;
}

function getComparablePinPrice(parsed: ParsedWager, pin: Record<string, unknown> | null): number | null {
  if (!pin) return null;
  const side = normalizeName(parsed.side);
  if (parsed.market === 'moneyline') {
    const moneyline = pin.moneyline as any;
    if (!moneyline) return null;
    const home = normalizeName(String((pin as any).homeTeam || 'home'));
    if (side.includes(home) && Number.isFinite(Number(moneyline.home))) return Number(moneyline.home);
    if (Number.isFinite(Number(moneyline.away))) return Number(moneyline.away);
  }
  if (parsed.market === 'spread') {
    const spread = pin.spread as any;
    if (!spread) return null;
    const homePrice = Number(spread.homePrice);
    const awayPrice = Number(spread.awayPrice);
    if (Number.isFinite(homePrice) && side !== 'unknown') return homePrice;
    if (Number.isFinite(awayPrice)) return awayPrice;
  }
  if (parsed.market === 'total' || parsed.market === 'prop') {
    const total = pin.total as any;
    if (!total) return null;
    const key = parsed.side === 'under' ? 'underPrice' : 'overPrice';
    const price = Number(total[key]);
    return Number.isFinite(price) ? price : null;
  }
  return null;
}
