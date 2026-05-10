import type { Database } from '../database';
import { FREEPLAY_CATEGORIES, freePlaySourceConfidence, summarizeFreePlay } from '../api/routes/freeplay';

export interface CrossReferenceFilters {
  playerId?: string;
  agentId?: string;
}

interface AgentSummary {
  agentId: string;
  login: string;
  displayName?: string | null;
  parentAgentId?: string | null;
  level?: number | null;
  agentType?: string | null;
  playerCount?: number | null;
  headCountRateM?: number | null;
  inetHeadCountRateM?: number | null;
  casinoHeadCountRateM?: number | null;
  liveBettingRateM?: number | null;
  propBuilderRateM?: number | null;
  lastRefreshed?: string | null;
}

interface FreePlayContext {
  issued: number;
  redeemed: number;
  expired: number;
  adjustments: number;
  outstandingEstimate: number;
  transactionCount: number;
  sourceConfidence: 'confirmed' | 'candidate';
  recent: any[];
}

export class CrossReferenceService {
  private readonly tableCache = new Map<string, Promise<boolean>>();

  constructor(private readonly db: Database) {}

  async getSummary(filters: CrossReferenceFilters): Promise<any> {
    const playerId = (filters.playerId || '').trim();
    const agentId = (filters.agentId || '').trim();
    const resolvedAgent = agentId || await this.resolveAgentForPlayer(playerId);
    const [
      agentContext,
      playerContext,
      wagerContext,
      accessContext,
      freePlayContext,
      patternContext,
      sourceContext,
    ] = await Promise.all([
      this.getAgentContext(resolvedAgent),
      this.getPlayerContext(playerId, resolvedAgent),
      this.getWagerContext(playerId, resolvedAgent),
      this.getAccessContext(playerId, resolvedAgent),
      this.getFreePlayContext(playerId, resolvedAgent),
      this.getPatternContext(resolvedAgent),
      this.getSourceContext(playerId),
    ]);

    const dataQuality = {
      missingAgentMap: Boolean(playerId && !playerContext.agentMap),
      staleAccessLogs: Boolean(accessContext.lastSeen && daysOld(accessContext.lastSeen) > 2),
      missingTransactions: Boolean(playerId && freePlayContext.transactionCount === 0 && sourceContext.playerTransactions?.status !== 'live'),
      orphanPlayerAgentMap: Boolean(playerContext.agentMap && !agentContext.assigned),
      patternEvidencePresent: Number(patternContext.total || 0) > 0,
      freePlayCandidateOnly: freePlayContext.sourceConfidence === 'candidate',
    };

    return {
      entity: {
        playerId: playerId || null,
        agentId: resolvedAgent || agentId || null,
        requestedAgentId: agentId || null,
        type: playerId ? 'player' : agentId ? 'agent' : 'unknown',
      },
      agentContext,
      playerContext,
      wagerContext,
      accessContext,
      freePlayContext,
      patternContext,
      dataQuality,
      links: {
        profile: playerId ? `/api/v1/players/${encodeURIComponent(playerId)}/profile` : null,
        agent: resolvedAgent ? `/api/v1/agents/${encodeURIComponent(resolvedAgent)}` : null,
        hierarchy: '/api/v1/agents/hierarchy',
        accessLogs: playerId ? `/api/v1/players/${encodeURIComponent(playerId)}/export/access-logs` : null,
        freePlay: `/api/v1/freeplay/analysis?${new URLSearchParams({ ...(playerId ? { playerId } : {}), ...(resolvedAgent ? { agentId: resolvedAgent } : {}) }).toString()}`,
        patterns: resolvedAgent ? `/api/v1/patterns/history?agent=${encodeURIComponent(resolvedAgent)}` : '/api/v1/patterns/history',
      },
      generatedAt: new Date().toISOString(),
    };
  }

  private async resolveAgentForPlayer(playerId: string): Promise<string> {
    if (!playerId) return '';
    if (await this.hasTable('player_agent_map')) {
      const row = await this.db.get<any>(
        `SELECT agent_id AS agentId, agent_login AS agentLogin
         FROM player_agent_map
         WHERE player_id = ? OR player_login = ?
         ORDER BY last_refreshed DESC
         LIMIT 1`,
        [playerId, playerId]
      );
      if (row?.agentId || row?.agentLogin) return String(row.agentId || row.agentLogin).trim();
    }
    if (await this.hasTable('wager_archive')) {
      const row = await this.db.get<any>(
        `SELECT COALESCE(MAX(agent_id), MAX(agent_login), '') AS agentId
         FROM wager_archive
         WHERE login = ? OR customer_id = ?`,
        [playerId, playerId]
      );
      return String(row?.agentId || '').trim();
    }
    return '';
  }

  private async getAgentContext(agentId: string): Promise<any> {
    if (!agentId || !(await this.hasTable('agent_hierarchy'))) {
      return { assigned: null, lineage: [], playerCount: 0 };
    }
    const assigned = await this.db.get<AgentSummary>(
      `SELECT agent_id AS agentId, login, display_name AS displayName, parent_agent_id AS parentAgentId,
              level, agent_type AS agentType, player_count AS playerCount,
              head_count_rate_m AS headCountRateM, inet_head_count_rate_m AS inetHeadCountRateM,
              casino_head_count_rate_m AS casinoHeadCountRateM, live_betting_rate_m AS liveBettingRateM,
              prop_builder_rate_m AS propBuilderRateM, last_refreshed AS lastRefreshed
       FROM agent_hierarchy
       WHERE agent_id = ? OR login = ?
       LIMIT 1`,
      [agentId, agentId]
    );
    const lineage: AgentSummary[] = [];
    let current = assigned;
    const seen = new Set<string>();
    while (current && !seen.has(current.agentId)) {
      seen.add(current.agentId);
      lineage.unshift(current);
      if (!current.parentAgentId) break;
      current = await this.db.get<AgentSummary>(
        `SELECT agent_id AS agentId, login, display_name AS displayName, parent_agent_id AS parentAgentId,
                level, agent_type AS agentType, player_count AS playerCount
         FROM agent_hierarchy
         WHERE agent_id = ?
         LIMIT 1`,
        [current.parentAgentId]
      );
    }
    return {
      assigned: assigned || null,
      lineage,
      lineageLabel: lineage.map((row) => row.login || row.agentId).join(' > '),
      playerCount: Number(assigned?.playerCount || 0),
    };
  }

  private async getPlayerContext(playerId: string, agentId: string): Promise<any> {
    if (!playerId) return { playerId: null, agentMap: null, relatedPlayers: [], linkCount: 0 };
    const agentMap = await this.getPlayerAgentMap(playerId);
    const relatedPlayers = await this.getRelatedPlayers(playerId);
    return {
      playerId,
      agentId: agentMap?.agentId || agentId || null,
      agentLogin: agentMap?.agentLogin || null,
      agentMap,
      relatedPlayers,
      linkCount: relatedPlayers.length,
    };
  }

  private async getPlayerAgentMap(playerId: string): Promise<any | null> {
    if (!(await this.hasTable('player_agent_map'))) return null;
    return this.db.get<any>(
      `SELECT player_id AS playerId, player_login AS playerLogin, agent_id AS agentId,
              agent_login AS agentLogin, source, last_refreshed AS lastRefreshed
       FROM player_agent_map
       WHERE player_id = ? OR player_login = ?
       ORDER BY last_refreshed DESC
       LIMIT 1`,
      [playerId, playerId]
    );
  }

  private async getRelatedPlayers(playerId: string): Promise<any[]> {
    if (!(await this.hasTable('player_links'))) return [];
    return this.db.all<any>(
      `SELECT player_a AS playerA, player_b AS playerB, reason, confidence, evidence_json AS evidenceJson,
              detected_at AS detectedAt, status
       FROM player_links
       WHERE status = 'active' AND (player_a = ? OR player_b = ?)
       ORDER BY confidence DESC, detected_at DESC
       LIMIT 10`,
      [playerId, playerId]
    );
  }

  private async getWagerContext(playerId: string, agentId: string): Promise<any> {
    if (!(await this.hasTable('wager_archive'))) {
      return { rowCount: 0, totalVolume: 0, openExposure: 0, lastSeen: null, recent: [] };
    }
    const where = [];
    const params: unknown[] = [];
    if (playerId) {
      where.push('(login = ? OR customer_id = ?)');
      params.push(playerId, playerId);
    } else if (agentId) {
      where.push('(agent_id = ? OR agent_login = ?)');
      params.push(agentId, agentId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const summary = await this.db.get<any>(
      `SELECT COUNT(*) AS rowCount, SUM(COALESCE(amount_wagered, 0)) AS totalVolume,
              SUM(COALESCE(volume_amount, amount_wagered, 0)) AS openExposure,
              MAX(insert_date_time) AS lastSeen,
              COUNT(DISTINCT COALESCE(sport, 'Unknown')) AS sportCount
       FROM wager_archive ${clause}`,
      params
    );
    const recent = await this.db.all<any>(
      `SELECT wager_number AS wagerNumber, login, customer_id AS customerId, agent_id AS agentId,
              agent_login AS agentLogin, sport, league, amount_wagered AS amountWagered,
              to_win_amount AS toWinAmount, insert_date_time AS insertDateTime, short_desc_raw AS description
       FROM wager_archive ${clause}
       ORDER BY insert_date_time DESC
       LIMIT 8`,
      params
    );
    return {
      rowCount: Number(summary?.rowCount || 0),
      totalVolume: Number(summary?.totalVolume || 0),
      openExposure: Number(summary?.openExposure || 0),
      sportCount: Number(summary?.sportCount || 0),
      lastSeen: summary?.lastSeen || null,
      recent,
    };
  }

  private async getAccessContext(playerId: string, agentId: string): Promise<any> {
    if (!(await this.hasTable('access_logs'))) {
      return { rowCount: 0, uniqueIps: 0, sharedIpCount: 0, lastSeen: null, latestGeo: null, recent: [] };
    }
    const where = [];
    const params: unknown[] = [];
    if (playerId) {
      where.push('login_id = ?');
      params.push(playerId);
    } else if (agentId) {
      where.push('agent_id = ?');
      params.push(agentId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const summary = await this.db.get<any>(
      `SELECT COUNT(*) AS rowCount, COUNT(DISTINCT ip_address) AS uniqueIps, MAX(access_datetime) AS lastSeen
       FROM access_logs ${clause}`,
      params
    );
    const recent = await this.db.all<any>(
      `SELECT login_id AS loginId, agent_id AS agentId, ip_address AS ipAddress, access_datetime AS accessDateTime,
              operation, data, raw_json AS rawJson
       FROM access_logs ${clause}
       ORDER BY access_datetime DESC
       LIMIT 8`,
      params
    );
    const shared = playerId
      ? await this.db.all<any>(
        `SELECT ip_address AS ipAddress, COUNT(DISTINCT login_id) AS playerCount,
                GROUP_CONCAT(DISTINCT login_id) AS players, MAX(access_datetime) AS lastSeen
         FROM access_logs
         WHERE ip_address IN (SELECT DISTINCT ip_address FROM access_logs WHERE login_id = ?)
         GROUP BY ip_address
         HAVING COUNT(DISTINCT login_id) > 1
         ORDER BY playerCount DESC, lastSeen DESC
         LIMIT 8`,
        [playerId]
      )
      : [];
    return {
      rowCount: Number(summary?.rowCount || 0),
      uniqueIps: Number(summary?.uniqueIps || 0),
      sharedIpCount: shared.length,
      lastSeen: summary?.lastSeen || null,
      latestGeo: extractGeo(recent[0]),
      recent,
      shared,
    };
  }

  private async getFreePlayContext(playerId: string, agentId: string): Promise<FreePlayContext> {
    if (!(await this.hasTable('player_transactions'))) {
      return { ...summarizeFreePlay([]), transactionCount: 0, recent: [] };
    }
    const where = [`category IN (${FREEPLAY_CATEGORIES.map(() => '?').join(',')})`];
    const params: unknown[] = [...FREEPLAY_CATEGORIES];
    if (playerId) {
      where.push('(customer_id = ? OR login = ?)');
      params.push(playerId, playerId);
    } else if (agentId) {
      where.push('(agent_id = ? OR agent_login = ?)');
      params.push(agentId, agentId);
    }
    const rows = await this.db.all<any>(
      `SELECT id, customer_id AS customerId, login, agent_id AS agentId, agent_login AS agentLogin,
              document_number AS documentNumber, tran_type AS tranType, amount, balance, description,
              category, transaction_time AS transactionTime, raw_json AS rawJson
       FROM player_transactions
       WHERE ${where.join(' AND ')}
       ORDER BY transaction_time DESC
       LIMIT 500`,
      params
    );
    const normalized = rows.map((row) => ({
      ...row,
      amount: Number(row.amount || 0),
      balance: Number(row.balance || 0),
      sourceConfidence: freePlaySourceConfidence(row),
    }));
    return {
      ...summarizeFreePlay(normalized),
      recent: normalized.slice(0, 8),
    };
  }

  private async getPatternContext(agentId: string): Promise<any> {
    if (!(await this.hasTable('detected_patterns'))) {
      return { total: 0, critical: 0, warning: 0, recent: [] };
    }
    const agentKeys = await this.getAgentLookupKeys(agentId);
    const hasPatternAgents = await this.hasTable('pattern_agents');
    const placeholders = agentKeys.map(() => '?').join(',');
    const where = agentKeys.length
      ? hasPatternAgents
        ? `WHERE (dp.agent_login IN (${placeholders}) OR pa.agent_login IN (${placeholders}))`
        : `WHERE dp.agent_login IN (${placeholders})`
      : '';
    const params = agentKeys.length ? hasPatternAgents ? [...agentKeys, ...agentKeys] : agentKeys : [];
    const join = hasPatternAgents ? 'LEFT JOIN pattern_agents pa ON pa.pattern_id = dp.id' : '';
    const summary = await this.db.get<any>(
      `SELECT COUNT(DISTINCT dp.id) AS total,
              SUM(CASE WHEN dp.severity = 'critical' THEN 1 ELSE 0 END) AS critical,
              SUM(CASE WHEN dp.severity = 'warning' THEN 1 ELSE 0 END) AS warning,
              MAX(dp.detected_at) AS lastSeen
       FROM detected_patterns dp
       ${join}
       ${where}`,
      params
    );
    const recent = await this.db.all<any>(
      `SELECT DISTINCT dp.id, dp.type, dp.category, dp.severity, dp.score,
              dp.agent_login AS agentLogin, dp.description, dp.detected_at AS detectedAt
       FROM detected_patterns dp
       ${join}
       ${where}
       ORDER BY dp.detected_at DESC
       LIMIT 8`,
      params
    );
    return {
      total: Number(summary?.total || 0),
      critical: Number(summary?.critical || 0),
      warning: Number(summary?.warning || 0),
      lastSeen: summary?.lastSeen || null,
      recent,
    };
  }

  private async getAgentLookupKeys(agentId: string): Promise<string[]> {
    const keys = new Set<string>();
    if (agentId) keys.add(agentId);
    if (agentId && await this.hasTable('agent_hierarchy')) {
      const row = await this.db.get<any>(
        `SELECT agent_id AS agentId, login FROM agent_hierarchy WHERE agent_id = ? OR login = ? LIMIT 1`,
        [agentId, agentId]
      );
      if (row?.agentId) keys.add(String(row.agentId));
      if (row?.login) keys.add(String(row.login));
    }
    return [...keys].filter(Boolean);
  }

  private async getSourceContext(playerId: string): Promise<any> {
    if (!playerId || !(await this.hasTable('player_source_status'))) return {};
    const rows = await this.db.all<any>(
      `SELECT source_key AS sourceKey, last_success_at AS lastSuccessAt, last_attempt_at AS lastAttemptAt,
              last_error AS lastError
       FROM player_source_status
       WHERE customer_id = ? OR login = ?`,
      [playerId, playerId]
    );
    return Object.fromEntries(rows.map((row) => [
      row.sourceKey,
      {
        status: row.lastSuccessAt ? 'live' : row.lastAttemptAt ? 'probe' : 'missing',
        lastSuccessAt: row.lastSuccessAt || null,
        lastAttemptAt: row.lastAttemptAt || null,
        lastError: row.lastError || null,
      },
    ]));
  }

  private async hasTable(name: string): Promise<boolean> {
    let cached = this.tableCache.get(name);
    if (!cached) {
      cached = this.db.get<any>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
        [name]
      ).then(Boolean);
      this.tableCache.set(name, cached);
    }
    return cached;
  }
}

function extractGeo(row: any): string | null {
  if (!row) return null;
  const raw = parseJson(row.rawJson) || parseJson(row.data);
  const geo = raw?.geo || raw?.Geo || raw?.location;
  if (typeof geo === 'string') return geo;
  if (geo && typeof geo === 'object') {
    return [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || null;
  }
  return null;
}

function parseJson(value: unknown): any {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function daysOld(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 0;
  return (Date.now() - parsed) / 86400000;
}
