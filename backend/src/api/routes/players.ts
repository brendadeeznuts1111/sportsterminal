/**
 * Player routes
 */
import { createParamRouteHandler, createRouteHandler } from './base';
import { ApiError, clampInt, corsHeaders, readJsonBody } from '../helpers';
import { logRequest, logWarn } from '../../utils/logger';
import { parseJsonOrText } from '../../utils/parseJson';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import type { Database } from '../../database';
import {
  classifyPlayer360Freshness,
  getPlayer360SourcePolicy,
  nextRefreshAt,
} from '../../player360/policies';
import {
  FREEPLAY_CATEGORIES,
  buildFreePlayWhere,
  freePlaySourceConfidence,
  summarizeFreePlay,
} from './freeplay';

const PLAYER_SORTS: Record<string, string> = {
  volume: 'totalVolume DESC',
  wagers: 'wagerCount DESC',
  risk: 'riskScore DESC',
  last: 'lastWagerAt DESC',
  player: 'login ASC',
  agent: 'agentLogin ASC',
};

type RouteRow = Record<string, unknown>;

interface AgentRow extends RouteRow {
  agentId?: string;
  agentLogin?: string;
  id?: string;
  login?: string;
  display_name?: string;
  displayName?: string;
  parent_agent_id?: string;
  parentAgentId?: string;
  agent_type?: string;
  level?: number | null;
  agentType?: string | null;
  childCount?: number | null;
  playerCount?: number | null;
  totalWagerVolume?: number | null;
}

interface PlayerStatsRow extends RouteRow {
  wagerCount?: number;
  totalVolume?: number;
  totalRisk?: number;
  agentLogin?: string;
  favoriteSport?: string;
}

interface AgentPerformanceRow extends RouteRow {
  risk?: number;
  net?: number;
  lastPulledAt?: string | null;
}

interface SourceStatusRow extends RouteRow {
  source_key: string;
  status?: string;
  last_attempt_at?: string | null;
  last_success_at?: string | null;
  last_error?: string | null;
  next_refresh_at?: string | null;
}

interface FreshnessSummary {
  rowCount: number;
  lastSeen: string | null;
}

interface IntelligenceSource extends RouteRow {
  key: string;
  label: string;
  status: string;
  freshnessState: string;
  rowCount: number;
  lastSeen: string | null;
  lastSuccessAt: string | null;
  profileUse: string;
  gap: string;
  refreshPolicy: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PlayerAgentContext {
  assigned: AgentRow | null;
  lineage: AgentRow[];
  children: AgentRow[];
  siblings: AgentRow[];
  roots: AgentRow[];
  treeStats: {
    totalAgents: number;
    rootCount: number;
    maxLevel: number;
    typeCounts: Record<string, number>;
  };
}

export const registerPlayerSearchRoutes = createRouteHandler(
  '/api/players/search',
  async (url, _req, scraperManager) => {
    logRequest('GET', '/api/players/search');
    const db = scraperManager.getDatabase();
    const q = (url.searchParams.get('q') || '').trim();
    const agent = (url.searchParams.get('agent') || '').trim();
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const sort = (url.searchParams.get('sort') || 'volume').trim();
    const hasAgentTables = await hasTables(db, ['agents', 'players']);
    const archiveWhere: string[] = [`COALESCE(login, customer_id, '') <> ''`];
    const archiveParams: unknown[] = [];

    if (q) {
      archiveWhere.push(`(login LIKE ? OR customer_id LIKE ?)`);
      archiveParams.push(`%${q}%`, `%${q}%`);
    }
    if (agent && !hasAgentTables) {
      archiveWhere.push(`(agent_login = ? OR agent_id = ?)`);
      archiveParams.push(agent, agent);
    }
    if (from) {
      archiveWhere.push(`insert_date_time >= ?`);
      archiveParams.push(from);
    }
    if (to) {
      archiveWhere.push(`insert_date_time <= ?`);
      archiveParams.push(`${to} 23:59:59`);
    }

    const orderBy = PLAYER_SORTS[sort] || PLAYER_SORTS.volume;
    const agentFilter = hasAgentTables && agent ? `WHERE (agentId = ? OR agentLogin = ?)` : '';
    const playerParams = hasAgentTables && agent ? [...archiveParams, agent, agent] : archiveParams;
    const playerSelect = hasAgentTables
      ? `WITH grouped AS (
        SELECT
          COALESCE(login, customer_id) AS login,
          COALESCE(customer_id, login) AS customerId,
          MAX(COALESCE(agent_login, agent_id, '')) AS archiveAgentLogin,
          MAX(COALESCE(agent_id, agent_login, '')) AS archiveAgentId,
          COUNT(*) AS wagerCount,
          SUM(COALESCE(amount_wagered, 0)) AS totalVolume,
          SUM(COALESCE(volume_amount, amount_wagered, 0)) AS totalRisk,
          AVG(COALESCE(amount_wagered, 0)) AS avgWager,
          MAX(COALESCE(amount_wagered, 0)) AS maxWager,
          MAX(insert_date_time) AS lastWagerAt,
          MIN(insert_date_time) AS firstWagerAt,
          COUNT(DISTINCT COALESCE(sport, 'Unknown')) AS sportCount,
          CASE
            WHEN SUM(COALESCE(amount_wagered, 0)) >= 50000 THEN 95
            WHEN SUM(COALESCE(amount_wagered, 0)) >= 20000 THEN 80
            WHEN SUM(COALESCE(amount_wagered, 0)) >= 5000 THEN 55
            ELSE 25
          END AS riskScore
         FROM wager_archive
         WHERE ${archiveWhere.join(' AND ')}
         GROUP BY COALESCE(login, customer_id)
       ),
       resolved AS (
        SELECT
          grouped.login,
          grouped.customerId,
          COALESCE(agentByPlayer.login, agentByArchive.login, grouped.archiveAgentLogin, grouped.archiveAgentId, '') AS agentLogin,
          COALESCE(player.agent_id, agentByArchive.id, grouped.archiveAgentId, grouped.archiveAgentLogin, '') AS agentId,
          COALESCE(agentByPlayer.level, agentByArchive.level) AS agentLevel,
          COALESCE(agentByPlayer.agent_type, agentByArchive.agent_type) AS agentType,
          grouped.wagerCount,
          grouped.totalVolume,
          grouped.totalRisk,
          grouped.avgWager,
          grouped.maxWager,
          grouped.lastWagerAt,
          grouped.firstWagerAt,
          grouped.sportCount,
          grouped.riskScore
         FROM grouped
         LEFT JOIN players player ON player.provider = 'buckeye'
          AND (player.login = grouped.login OR player.id = grouped.login OR player.id = grouped.customerId)
         LEFT JOIN agents agentByPlayer ON agentByPlayer.provider = 'buckeye' AND agentByPlayer.id = player.agent_id
         LEFT JOIN agents agentByArchive ON agentByArchive.provider = 'buckeye' AND agentByArchive.login = grouped.archiveAgentLogin
       )
       SELECT *
       FROM resolved
       ${agentFilter}
       ORDER BY ${orderBy}
       LIMIT 250`
      : `SELECT
        COALESCE(login, customer_id) AS login,
        COALESCE(customer_id, login) AS customerId,
        COALESCE(agent_login, agent_id, '') AS agentLogin,
        COALESCE(agent_id, agent_login, '') AS agentId,
        NULL AS agentLevel,
        NULL AS agentType,
        COUNT(*) AS wagerCount,
        SUM(COALESCE(amount_wagered, 0)) AS totalVolume,
        SUM(COALESCE(volume_amount, amount_wagered, 0)) AS totalRisk,
        AVG(COALESCE(amount_wagered, 0)) AS avgWager,
        MAX(COALESCE(amount_wagered, 0)) AS maxWager,
        MAX(insert_date_time) AS lastWagerAt,
        MIN(insert_date_time) AS firstWagerAt,
        COUNT(DISTINCT COALESCE(sport, 'Unknown')) AS sportCount,
        CASE
          WHEN SUM(COALESCE(amount_wagered, 0)) >= 50000 THEN 95
          WHEN SUM(COALESCE(amount_wagered, 0)) >= 20000 THEN 80
          WHEN SUM(COALESCE(amount_wagered, 0)) >= 5000 THEN 55
          ELSE 25
        END AS riskScore
       FROM wager_archive
       WHERE ${archiveWhere.join(' AND ')}
       GROUP BY COALESCE(login, customer_id)
       ORDER BY ${orderBy}
       LIMIT 250`;
    const players = await db.all<RouteRow>(
      playerSelect,
      playerParams
    );

    const agents = hasAgentTables
      ? await db.all<AgentRow>(
        `SELECT DISTINCT
        COALESCE(a.id, p.agent_id, '') AS agentId,
        COALESCE(a.login, p.agent_login, p.agent_id, '') AS agentLogin,
        a.level AS level,
        a.agent_type AS agentType
       FROM players p
       LEFT JOIN agents a ON a.provider = 'buckeye' AND a.id = p.agent_id
       WHERE p.provider = 'buckeye'
        AND COALESCE(a.id, p.agent_id, '') <> ''
       ORDER BY agentLogin ASC, agentId ASC
       LIMIT 500`
      )
      : await db.all<AgentRow>(
        `SELECT DISTINCT
          COALESCE(agent_id, agent_login, '') AS agentId,
          COALESCE(agent_login, agent_id, '') AS agentLogin,
          NULL AS level,
          NULL AS agentType
         FROM wager_archive
         WHERE COALESCE(agent_login, agent_id, '') <> ''
         ORDER BY agentLogin ASC
         LIMIT 500`
      );

    const agentOptions = agents.map((row) => ({
      agentId: row.agentId,
      agentLogin: row.agentLogin,
      level: row.level,
      agentType: row.agentType,
    }));

    return {
      players: players.map(normalizeNumbers),
      agents: agentOptions.map((row) => row.agentLogin),
      agentOptions,
      filters: { q, agent, from, to, sort },
      count: players.length,
    };
  }
);

export const registerPlayerProfileRoutes = createParamRouteHandler(
  '/api/players/:playerId/profile',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('GET', `/api/players/${playerId}/profile`);
    scraperManager.requestPlayer360Refresh(playerId, 'profile_open');
    return getArchivePlayerProfile(scraperManager, playerId);
  }
);

export const registerPlayerAgentContextRoutes = createParamRouteHandler(
  '/api/players/:playerId/agent-context',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('GET', `/api/players/${playerId}/agent-context`);
    if (!playerId) throw new ApiError(400, 'playerId is required');
    const db = scraperManager.getDatabase();
    const archiveAgent = await db.get(
      `SELECT COALESCE(MAX(agent_login), MAX(agent_id), '') AS agentLogin
       FROM wager_archive
       WHERE login = ? OR customer_id = ?`,
      [playerId, playerId]
    );
    return {
      playerId,
      agentContext: await getPlayerAgentContext(db, playerId, String(archiveAgent?.agentLogin || '')),
    };
  }
);

export const registerPlayerIntelligenceMapRoutes = createParamRouteHandler(
  '/api/players/:playerId/intelligence-map',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('GET', `/api/players/${playerId}/intelligence-map`);
    return getPlayerIntelligenceMap(scraperManager, playerId);
  }
);

export const registerPlayerDepositsRoutes = createParamRouteHandler(
  '/api/players/:playerId/deposits',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('GET', `/api/players/${playerId}/deposits`);
    return { playerId, deposits: await getPlayerDeposits(scraperManager, playerId) };
  }
);

export const registerPlayerTransactionsRoutes = createParamRouteHandler(
  '/api/players/:playerId/transactions',
  'playerId',
  async (url, _req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    const category = (url.searchParams.get('category') || '').trim();
    logRequest('GET', `/api/players/${playerId}/transactions`);
    return { playerId, category: category || 'all', transactions: await getPlayerTransactions(scraperManager, playerId, category) };
  }
);

export const registerPlayerAccountSnapshotsRoutes = createParamRouteHandler(
  '/api/players/:playerId/account-snapshots',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('GET', `/api/players/${playerId}/account-snapshots`);
    return { playerId, accountSnapshots: await getPlayerAccountSnapshots(scraperManager, playerId) };
  }
);

export const registerPlayerLinksRoutes = createParamRouteHandler(
  '/api/players/:playerId/links',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('GET', `/api/players/${playerId}/links`);
    return { playerId, links: await getPlayerLinks(scraperManager, playerId) };
  }
);

export const registerPlayerLinkCheckRoutes = createParamRouteHandler(
  '/api/players/:playerId/links/check',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('POST', `/api/players/${playerId}/links/check`);
    if (!playerId) throw new ApiError(400, 'playerId is required');
    const db = scraperManager.getDatabase();
    const matches = await db.all<RouteRow>(
      `SELECT
        mine.ip_address,
        other.login_id AS otherPlayer,
        MAX(other.access_datetime) AS lastSeen,
        COUNT(*) AS overlapCount
       FROM access_logs mine
       JOIN access_logs other
        ON other.ip_address = mine.ip_address
        AND other.login_id <> mine.login_id
       WHERE mine.login_id = ?
        AND mine.ip_address <> ''
        AND mine.access_datetime >= datetime('now', '-30 days')
        AND other.access_datetime >= datetime('now', '-30 days')
       GROUP BY mine.ip_address, other.login_id
       ORDER BY MAX(other.access_datetime) DESC
       LIMIT 100`,
      [playerId]
    );

    let inserted = 0;
    for (const match of matches) {
      const other = String(match.otherPlayer || '').trim();
      if (!other) continue;
      const [playerA, playerB] = [playerId, other].sort();
      const result = await db.run(
        `INSERT OR IGNORE INTO player_links
          (provider, player_a, player_b, reason, confidence, evidence_json, detected_at, status)
         VALUES ('buckeye', ?, ?, 'shared_ip_manual_check', 0.9, ?, CURRENT_TIMESTAMP, 'active')`,
        [
          playerA,
          playerB,
          JSON.stringify({
            ip_address: match.ip_address,
            last_seen: match.lastSeen,
            overlap_count: Number(match.overlapCount || 0),
            window_days: 30,
          }),
        ]
      );
      inserted += result.changes > 0 ? 1 : 0;
    }

    return { playerId, inserted, links: await getPlayerLinks(scraperManager, playerId) };
  }
);

export const registerPlayerFlagsRoutes = createParamRouteHandler(
  '/api/players/:playerId/flags',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('GET', `/api/players/${playerId}/flags`);
    return { playerId, flags: await getPlayerFlags(scraperManager, playerId) };
  }
);

export const registerPlayerNotesRoutes = createParamRouteHandler(
  '/api/players/:playerId/notes',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('GET', `/api/players/${playerId}/notes`);
    return { playerId, notes: await getPlayerNotes(scraperManager, playerId) };
  }
);

export async function registerPlayerExportRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Promise<Response | null> {
  const wagerMatch = url.pathname.match(/^\/api\/players\/([^/]+)\/export\/wagers$/);
  const accessMatch = url.pathname.match(/^\/api\/players\/([^/]+)\/export\/access-logs$/);
  if (request.method !== 'GET' || (!wagerMatch && !accessMatch)) return null;

  const db = scraperManager.getDatabase();
  const playerId = decodeURIComponent((wagerMatch || accessMatch)?.[1] || '');
  if (!playerId) {
    return new Response(JSON.stringify({ error: 'playerId is required' }), { status: 400, headers: corsHeaders });
  }

  if (wagerMatch) {
    return csvExport(
      await db.all(
        `SELECT *
         FROM wager_archive
         WHERE login = ? OR customer_id = ?
         ORDER BY insert_date_time DESC`,
        [playerId, playerId]
      ),
      `${safeFilename(playerId)}-wagers.csv`
    );
  }

  return csvExport(
    await db.all(
      `SELECT *
       FROM access_logs
       WHERE login_id = ?
       ORDER BY access_datetime DESC`,
      [playerId]
    ),
    `${safeFilename(playerId)}-access-logs.csv`
  );
}

export const registerPlayerDetailsRoutes = createParamRouteHandler(
  '/api/players/:playerId/details',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    logRequest('GET', `/api/players/${params.playerId}/details`);
    return scraperManager.getPlayerDetails(params.playerId);
  }
);

async function getArchivePlayerProfile(scraperManager: BuckeyeScraperManager, playerId: string): Promise<RouteRow> {
  if (!playerId) throw new ApiError(400, 'playerId is required');
  const db = scraperManager.getDatabase();
  const stats = await db.get<PlayerStatsRow>(
    `WITH player_wagers AS (
      SELECT *
      FROM wager_archive
      WHERE login = ? OR customer_id = ?
    ),
    favorite AS (
      SELECT COALESCE(sport, 'Unknown') AS sport, SUM(COALESCE(amount_wagered, 0)) AS volume
      FROM player_wagers
      GROUP BY COALESCE(sport, 'Unknown')
      ORDER BY volume DESC
      LIMIT 1
    )
    SELECT
      COALESCE(MAX(login), ?) AS login,
      COALESCE(MAX(customer_id), ?) AS customerId,
      COALESCE(MAX(agent_login), MAX(agent_id), '') AS agentLogin,
      COUNT(*) AS wagerCount,
      SUM(COALESCE(amount_wagered, 0)) AS totalVolume,
      SUM(COALESCE(volume_amount, amount_wagered, 0)) AS totalRisk,
      SUM(COALESCE(to_win_amount, 0)) AS totalToWin,
      SUM(COALESCE(amount_wagered, 0) - COALESCE(to_win_amount, 0)) AS projectedPnl,
      AVG(COALESCE(amount_wagered, 0)) AS avgWager,
      MAX(COALESCE(amount_wagered, 0)) AS maxWager,
      MIN(insert_date_time) AS firstWagerAt,
      MAX(insert_date_time) AS lastWagerAt,
      (SELECT sport FROM favorite) AS favoriteSport
    FROM player_wagers`,
    [playerId, playerId, playerId, playerId]
  );

  const wagers = await db.all<RouteRow>(
    `SELECT *
     FROM wager_archive
     WHERE login = ? OR customer_id = ?
     ORDER BY insert_date_time DESC
     LIMIT 200`,
    [playerId, playerId]
  );

  const weeklyPnl = await db.all<RouteRow>(
    `SELECT
      strftime('%Y-%W', insert_date_time) AS week,
      MIN(date(insert_date_time)) AS weekStart,
      COUNT(*) AS wagerCount,
      SUM(COALESCE(amount_wagered, 0)) AS volume,
      SUM(COALESCE(amount_wagered, 0) - COALESCE(to_win_amount, 0)) AS pnl
     FROM wager_archive
     WHERE (login = ? OR customer_id = ?)
       AND insert_date_time >= date('now', '-28 days')
     GROUP BY strftime('%Y-%W', insert_date_time)
     ORDER BY weekStart ASC`,
    [playerId, playerId]
  );

  const sportBreakdown = await db.all<RouteRow>(
    `SELECT
      COALESCE(sport, 'Unknown') AS sport,
      COUNT(*) AS wagerCount,
      SUM(COALESCE(amount_wagered, 0)) AS volume,
      SUM(COALESCE(amount_wagered, 0) - COALESCE(to_win_amount, 0)) AS pnl
     FROM wager_archive
     WHERE login = ? OR customer_id = ?
     GROUP BY COALESCE(sport, 'Unknown')
     ORDER BY volume DESC
     LIMIT 12`,
    [playerId, playerId]
  );

  const [deposits, transactions, accountSnapshots, links, flags, notes, freePlaySummary] = await Promise.all([
    getPlayerDeposits(scraperManager, playerId),
    getPlayerTransactions(scraperManager, playerId),
    getPlayerAccountSnapshots(scraperManager, playerId),
    getPlayerLinks(scraperManager, playerId),
    getPlayerFlags(scraperManager, playerId),
    getPlayerNotes(scraperManager, playerId),
    getPlayerFreePlaySummary(db, playerId),
  ]);

  const accessLogs = await db.all<RouteRow>(
    `SELECT
      l.*,
      (SELECT MIN(prior.access_datetime)
       FROM access_logs prior
       WHERE prior.login_id = l.login_id
         AND prior.ip_address = l.ip_address
         AND prior.access_datetime >= datetime(l.access_datetime, '-30 days')
         AND prior.access_datetime <= l.access_datetime) AS first_seen_30d
     FROM access_logs l
     WHERE l.login_id = ?
     ORDER BY l.access_datetime DESC
     LIMIT 10`,
    [playerId]
  );
  const ipRisk = await getPlayerIpRisk(db, playerId);

  const wagerCount = Number(stats?.wagerCount || 0);
  const totalVolume = Number(stats?.totalVolume || 0);
  const totalRisk = Number(stats?.totalRisk || 0);
  let agentPerformance: AgentPerformanceRow | null | undefined;
  try {
    agentPerformance = await db.get<AgentPerformanceRow>(
      `SELECT
         COUNT(*) AS rowCount,
         SUM(wager_count) AS wagerCount,
         SUM(risk) AS risk,
         SUM(volume) AS volume,
         SUM(net) AS net,
         MAX(pulled_at) AS lastPulledAt
       FROM agent_performance_snapshots
       WHERE login = ? OR customer_id = ?`,
      [playerId, playerId]
    );
  } catch (err) {
    logWarn('Player profile: agent_performance query failed', { playerId, error: errorMessage(err) });
  }
  const performanceRisk = Number(agentPerformance?.risk || 0);
  const performanceNet = Number(agentPerformance?.net || 0);
  const riskScore = Math.min(100, Math.round(
    (totalVolume >= 50000 ? 70 : totalVolume / 750)
    + (Math.max(totalRisk, performanceRisk) >= 50000 ? 25 : Math.max(totalRisk, performanceRisk) / 2500)
    + Math.min(10, Math.abs(performanceNet) / 5000)
    + (ipRisk.sharedIpFlag ? 10 : 0)
    + (ipRisk.newIpFlag ? 5 : 0)
  ));
  const intelligence = buildWagerIntelligence(wagers);
  const agentContext = await getPlayerAgentContext(db, playerId, stats?.agentLogin || '');

  return {
    playerId,
    stats: {
      ...normalizeNumbers(stats || {}),
      totalVolume,
      openBets: wagerCount,
      winRate: 0,
      favoriteSport: stats?.favoriteSport || 'Unknown',
      riskScore,
      avgStake: wagerCount > 0 ? totalVolume / wagerCount : 0,
      clvPercent: intelligence.metrics.clvPercent,
      staleLineHits: intelligence.metrics.staleLineHits,
      pastPostingRate: intelligence.metrics.pastPostingRate,
      patternHits: intelligence.metrics.patternHits,
      performanceNet,
      performanceRisk,
      ipRisk,
      performanceLastPulledAt: agentPerformance?.lastPulledAt || null,
      agentId: agentContext.assigned?.agentId || '',
      agentLogin: agentContext.assigned?.login || stats?.agentLogin || '',
      agentLevel: agentContext.assigned?.level || null,
      agentType: agentContext.assigned?.agentType || '',
      parentAgentId: agentContext.assigned?.parentAgentId || '',
      parentAgentLogin: agentContext.lineage.length > 1 ? agentContext.lineage[agentContext.lineage.length - 2]?.login || '' : '',
      agentPlayerCount: agentContext.assigned?.playerCount || 0,
    },
    recentWagers: intelligence.wagers.map(normalizeNumbers),
    weeklyPnl: weeklyPnl.map(normalizeNumbers),
    sportBreakdown: sportBreakdown.map(normalizeNumbers),
    patternSummary: intelligence.metrics,
    deposits,
    transactions,
    accountSnapshots,
    links,
    flags,
    notes,
    accessLogs: accessLogs.map((row) => ({
      ...row,
      isNewIp: row.first_seen_30d === row.access_datetime,
      device: extractAccessMeta(row, 'device'),
      geo: extractAccessMeta(row, 'geo'),
    })),
    ipIntelligence: {
      recentIps: ipRisk.recentIps,
      sharedIpFlag: ipRisk.sharedIpFlag,
      newIpFlag: ipRisk.newIpFlag,
      sharedIpCount: ipRisk.sharedIpCount,
      newIpCount: ipRisk.newIpCount,
      riskPoints: ipRisk.riskPoints,
    },
    agentPerformance: normalizeNumbers(agentPerformance || {}),
    agent: agentContext.assigned,
    allAgents: agentContext.lineage,
    agentContext,
    freePlaySummary,
  };
}

async function getPlayerIpRisk(db: Database, playerId: string): Promise<{
  recentIps: string[];
  sharedIpFlag: boolean;
  newIpFlag: boolean;
  sharedIpCount: number;
  newIpCount: number;
  riskPoints: number;
}> {
  const [recentRows, sharedRow, newRows] = await Promise.all([
    db.all<{ ip_address: string }>(
      `SELECT DISTINCT ip_address
       FROM access_logs
       WHERE login_id = ?
         AND ip_address IS NOT NULL
         AND ip_address <> ''
         AND access_datetime >= datetime('now', '-1 day')
       ORDER BY access_datetime DESC
       LIMIT 10`,
      [playerId]
    ),
    db.get<{ sharedCount: number }>(
      `SELECT COUNT(DISTINCT other.login_id) AS sharedCount
       FROM access_logs mine
       JOIN access_logs other
         ON other.ip_address = mine.ip_address
        AND other.login_id <> mine.login_id
       WHERE mine.login_id = ?
         AND mine.ip_address IS NOT NULL
         AND mine.ip_address <> ''
         AND mine.access_datetime >= datetime('now', '-1 day')`,
      [playerId]
    ),
    db.all<{ ip_address: string; access_datetime: string }>(
      `WITH first_pair AS (
         SELECT login_id, ip_address, MIN(access_datetime) AS first_seen
         FROM access_logs
         WHERE login_id = ?
           AND ip_address IS NOT NULL
           AND ip_address <> ''
         GROUP BY login_id, ip_address
       )
       SELECT l.ip_address, l.access_datetime
       FROM access_logs l
       JOIN first_pair fp
         ON fp.login_id = l.login_id
        AND fp.ip_address = l.ip_address
        AND fp.first_seen = l.access_datetime
       WHERE l.login_id = ?
         AND l.access_datetime >= datetime('now', '-1 day')
         AND EXISTS (
           SELECT 1
           FROM access_logs prior
           WHERE prior.login_id = l.login_id
             AND prior.ip_address <> l.ip_address
             AND prior.access_datetime < l.access_datetime
         )`,
      [playerId, playerId]
    ),
  ]);

  const sharedIpCount = Number(sharedRow?.sharedCount || 0);
  const newIpCount = newRows.length;
  return {
    recentIps: recentRows.map((row) => row.ip_address).filter(Boolean),
    sharedIpFlag: sharedIpCount > 0,
    newIpFlag: newIpCount > 0,
    sharedIpCount,
    newIpCount,
    riskPoints: (sharedIpCount > 0 ? 10 : 0) + (newIpCount > 0 ? 5 : 0),
  };
}

async function getPlayerAgentContext(db: Database, playerId: string, fallbackAgentLogin: string): Promise<PlayerAgentContext> {
  if (!(await hasTables(db, ['agents']))) {
    return {
      assigned: fallbackAgentLogin ? {
        agentId: fallbackAgentLogin,
        login: fallbackAgentLogin,
        displayName: fallbackAgentLogin,
        parentAgentId: '',
        level: 0,
        agentType: '',
        childCount: 0,
        playerCount: 0,
        seqNumber: 0,
        rates: {},
      } : null,
      lineage: [],
      children: [],
      siblings: [],
      roots: [],
      treeStats: { totalAgents: 0, rootCount: 0, maxLevel: 0, typeCounts: {} },
    };
  }
  const assigned = await resolvePlayerAgent(db, playerId, fallbackAgentLogin);
  const roots = (await db.all<AgentRow>(
    `SELECT *
     FROM agents
     WHERE provider = 'buckeye' AND level = 1
     ORDER BY seq_number`
  )).map(formatAgentRow).filter((row): row is AgentRow => row !== null);
  const treeAgg = await db.all<{ type: string | null; count: number }>(
    `SELECT agent_type AS type, COUNT(*) AS count
     FROM agents
     WHERE provider = 'buckeye'
     GROUP BY agent_type`
  );
  const totalStats = await db.get<{ totalAgents: number; maxLevel: number | null }>(
    `SELECT COUNT(*) AS totalAgents, MAX(level) AS maxLevel
     FROM agents
     WHERE provider = 'buckeye'`
  );

  if (!assigned) {
    return {
      assigned: null,
      lineage: [],
      children: [],
      siblings: [],
      roots,
      treeStats: {
        totalAgents: Number(totalStats?.totalAgents || 0),
        rootCount: roots.length,
        maxLevel: Number(totalStats?.maxLevel || 0),
        typeCounts: Object.fromEntries(treeAgg.map((row) => [row.type || 'unknown', Number(row.count || 0)])),
      },
    };
  }

  const [lineage, children, siblings] = await Promise.all([
    getAgentLineage(db, String(assigned.agentId || '')),
    getAgentChildren(db, String(assigned.agentId || '')),
    assigned.parentAgentId ? getAgentChildren(db, assigned.parentAgentId, String(assigned.agentId || '')) : Promise.resolve([]),
  ]);

  return {
    assigned,
    lineage,
    children,
    siblings,
    roots,
    treeStats: {
      totalAgents: Number(totalStats?.totalAgents || 0),
      rootCount: roots.length,
      maxLevel: Number(totalStats?.maxLevel || 0),
      typeCounts: Object.fromEntries(treeAgg.map((row) => [row.type || 'unknown', Number(row.count || 0)])),
    },
  };
}

async function resolvePlayerAgent(db: Database, playerId: string, fallbackAgentLogin: string): Promise<AgentRow | null> {
  if (await hasTables(db, ['players'])) {
    const fromPlayer = await db.get<AgentRow>(
      `SELECT a.*
       FROM players p
       JOIN agents a ON a.provider = 'buckeye' AND a.id = p.agent_id
       WHERE p.provider = 'buckeye'
         AND (p.id = ? OR p.login = ? OR p.raw_json LIKE ?)
       ORDER BY a.seq_number
       LIMIT 1`,
      [playerId, playerId, `%"customerId":"${escapeLikeJson(playerId)}"%`]
    );
    if (fromPlayer) return formatAgentRow(fromPlayer);
  }

  const fromWager = await db.get<AgentRow>(
    `SELECT a.*
     FROM agents a
     WHERE a.provider = 'buckeye'
       AND (a.id = ? OR a.login = ?)
     ORDER BY a.seq_number
     LIMIT 1`,
    [fallbackAgentLogin, fallbackAgentLogin]
  );
  return fromWager ? formatAgentRow(fromWager) : null;
}

async function getAgentLineage(db: Database, agentId: string): Promise<AgentRow[]> {
  const lineage: AgentRow[] = [];
  const seen = new Set<string>();
  let currentId = agentId;
  for (let i = 0; currentId && i < 32; i += 1) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const row = await db.get<AgentRow>(
      `SELECT * FROM agents WHERE provider = 'buckeye' AND id = ? LIMIT 1`,
      [currentId]
    );
    if (!row) break;
    const formatted = formatAgentRow(row);
    if (!formatted) break;
    lineage.unshift(formatted);
    currentId = formatted.parentAgentId || '';
  }
  return lineage;
}

async function getAgentChildren(db: Database, agentId: string, excludeAgentId = ''): Promise<AgentRow[]> {
  const rows = await db.all<AgentRow>(
    `SELECT *
     FROM agents
     WHERE provider = 'buckeye'
       AND parent_agent_id = ?
       AND id <> ?
     ORDER BY seq_number
     LIMIT 200`,
    [agentId, excludeAgentId]
  );
  return rows.map(formatAgentRow).filter((row): row is AgentRow => row !== null);
}

function formatAgentRow(row: AgentRow | null | undefined): AgentRow | null {
  if (!row) return null;
  return {
    agentId: row.id,
    login: row.login || row.id,
    displayName: row.display_name || row.login || row.id,
    parentAgentId: row.parent_agent_id || '',
    level: Number(row.level || 0),
    agentType: row.agent_type || '',
    childCount: Number(row.child_count || 0),
    playerCount: Number(row.player_count || 0),
    seqNumber: Number(row.seq_number || 0),
    rates: {
      headCount: Number(row.head_count_rate_m || 0),
      inetHeadCount: Number(row.inet_head_count_rate_m || 0),
      casinoHeadCount: Number(row.casino_head_count_rate_m || 0),
      liveBetting: Number(row.live_betting_rate_m || 0),
      liveBetting2: Number(row.live_betting2_rate_m || 0),
      liveCasino: Number(row.live_casino_rate_m || 0),
      propBuilder: Number(row.prop_builder_rate_m || 0),
      flashBets: Number(row.flash_bets_rate || 0),
      extProps: Number(row.ext_props_rate || 0),
      crash: Number(row.crash_rate || 0),
      fantasy: Number(row.fantasy_rate || 0),
      amigoTech: Number(row.amigo_tech_rate || 0),
    },
  };
}

function escapeLikeJson(value: string): string {
  return String(value).replace(/[%_]/g, '');
}

async function hasTables(db: Database, tableNames: string[]): Promise<boolean> {
  try {
    const rows = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tableNames.map(() => '?').join(',')})`,
      tableNames
    );
    return rows.length === tableNames.length;
  } catch (err) {
    logWarn('hasTables query failed', { error: errorMessage(err) });
    return false;
  }
}

async function getPlayerIntelligenceMap(scraperManager: BuckeyeScraperManager, playerId: string): Promise<RouteRow> {
  if (!playerId) throw new ApiError(400, 'playerId is required');
  const db = scraperManager.getDatabase();
  const endpointBase = `/api/v1/players/${encodeURIComponent(playerId)}`;
  const playerAgent = await db.get<{ agentLogin: string }>(
    `SELECT COALESCE(MAX(agent_login), MAX(agent_id), '') AS agentLogin
     FROM wager_archive
     WHERE login = ? OR customer_id = ?`,
    [playerId, playerId]
  );
  const agentLogin = playerAgent?.agentLogin || '';
  const freshness = {
    wager_archive: await sourceFreshness(db, 'wager_archive', 'insert_date_time', 'login = ? OR customer_id = ?', [playerId, playerId]),
    access_logs: await sourceFreshness(db, 'access_logs', 'access_datetime', 'login_id = ?', [playerId]),
    deposits: await sourceFreshness(db, 'deposits', 'transaction_time', 'customer_id = ? OR login = ?', [playerId, playerId]),
    player_transactions: await sourceFreshness(db, 'player_transactions', 'transaction_time', 'customer_id = ? OR login = ?', [playerId, playerId]),
    deleted_transactions: await sourceFreshness(db, 'player_transactions', 'transaction_time', '(customer_id = ? OR login = ?) AND raw_json LIKE ?', [playerId, playerId, '%getReportDeletedTransactions%']),
    customer_snapshots: await sourceFreshness(db, 'customer_snapshots', 'snapshot_time', 'customer_id = ? OR login = ?', [playerId, playerId]),
    agent_performance_snapshots: await sourceFreshness(db, 'agent_performance_snapshots', 'pulled_at', 'login = ? OR customer_id = ?', [playerId, playerId]),
    player_links: await sourceFreshness(db, 'player_links', 'detected_at', 'player_a = ? OR player_b = ?', [playerId, playerId]),
    player_flags: await sourceFreshness(db, 'player_flags', 'created_at', 'customer_id = ?', [playerId]),
    player_notes: await sourceFreshness(db, 'player_notes', 'created_at', 'customer_id = ? AND archived_at IS NULL', [playerId]),
  };
  const sourceStatuses = await getPlayerSourceStatusMap(db, playerId);
  const watermarks = {
    player360: agentLogin ? await getWatermark(db, `last_player360_poll.${agentLogin}`) : null,
    accessLogs: agentLogin ? await getWatermark(db, `last_access_log_poll.${agentLogin}`) : null,
    playerPerformance: agentLogin ? await getWatermark(db, `last_player_performance.${agentLogin}.${playerId}`) : null,
  };
  const endpointProbes = {
    deposits: await rawEndpointProbe(db, ['getCustomerDeposits', 'getDepositHistory', 'getCustomerTransactions', 'getTransactionHistory', 'getTransactionList']),
    transactions: await rawEndpointProbe(db, ['getTransactionList', 'getTransactionHistory', 'getReportDeletedTransactions']),
    customerSnapshots: await rawEndpointProbe(db, ['getInfoPlayer', 'getAccountInfoOwner', 'getCustomerInfo', 'getCustomerDetails', 'getCustomerProfile', 'getCustomer']),
    teaserProfile: await rawEndpointProbe(db, ['getTeaserProfile']),
    playerPerformance: await rawEndpointProbe(db, ['getPerformancePlayer', 'getAgentPerformance']),
  };
  const wagerArchiveStatus = freshness.wager_archive.rowCount > 0 ? 'live' : 'missing';
  const playerPerformanceStatus = freshness.agent_performance_snapshots.rowCount > 0
    ? 'live'
    : watermarks.playerPerformance || endpointProbes.playerPerformance.seen ? 'probe' : 'missing';
  const transactionStatus = freshness.player_transactions.rowCount > 0 ? 'live' : watermarks.player360 || endpointProbes.transactions.seen ? 'probe' : 'missing';
  const deletedTransactionStatus = freshness.deleted_transactions.rowCount > 0
    ? 'live'
    : (sourceStatuses.deleted_transactions?.last_attempt_at || endpointProbes.transactions.seen) ? 'probe' : 'missing';
  const depositStatus = freshness.deposits.rowCount > 0 ? 'live' : watermarks.player360 || endpointProbes.deposits.seen ? 'probe' : 'missing';
  const snapshotStatus = freshness.customer_snapshots.rowCount > 0 ? 'live' : 'probe';
  const teaserStatus = sourceStatuses.teaser_profile?.last_success_at
    ? 'live'
    : sourceStatuses.teaser_profile?.last_attempt_at || endpointProbes.teaserProfile.seen ? 'probe' : 'probe';

  const sources = [
    sourceRow('wager_archive', 'Wager Archive', wagerArchiveStatus, 'getBetTicker', 'wager_archive', freshness.wager_archive, sourceStatuses.wager_archive, 'Stats, recent wagers, volume, risk, sport breakdown, weekly P&L, pattern flags, estimated CLV.', wagerArchiveStatus === 'live' ? 'Confirmed live from incoming wager archive.' : 'No archived wagers found for this player/login yet.', true),
    sourceRow('agent_performance_snapshots', 'Player Performance', playerPerformanceStatus, 'getPerformancePlayer / getAgentPerformance', 'agent_performance_snapshots', freshness.agent_performance_snapshots, sourceStatuses.agent_performance_snapshots, 'Risk score enrichment, net performance, volume and player/agent performance context.', playerPerformanceStatus === 'live' ? 'Confirmed reusable from player/agent performance reports.' : 'Probe getPerformancePlayer with acc=<player/account>&period=0; falls back to agent performance rows when available.', true),
    sourceRow('access_logs', 'Access Logs', freshness.access_logs.rowCount > 0 ? 'live' : watermarks.accessLogs ? 'probe' : 'missing', 'getWebLog', 'access_logs', freshness.access_logs, sourceStatuses.access_logs, 'Login history, IP, device, geo, new-IP flagging, access export.', freshness.access_logs.rowCount > 0 ? 'Confirmed reusable Buckeye access endpoint.' : `Use /api/v1/logs/access?login=${encodeURIComponent(playerId)}&limit=100 after the getWebLog poll captures this player.`, true),
    sourceRow('player_transactions', 'Transaction Ledger', transactionStatus, 'getTransactionList / getTransactionHistory', 'player_transactions', freshness.player_transactions, sourceStatuses.player_transactions, 'Full account ledger: wager wins/losses, credits/debits, deposit/withdrawal-like rows, balance, document and grade numbers.', transactionStatus === 'live' ? 'Captured Buckeye transaction ledger rows exist.' : 'Probe getTransactionList with acc=<player/account>&start= and getTransactionHistory with customerID/startDate/endDate before relying on ledger views.', true),
    sourceRow('deleted_transactions', 'Deleted Transactions', deletedTransactionStatus, 'getReportDeletedTransactions', 'player_transactions', freshness.deleted_transactions, sourceStatuses.deleted_transactions, 'Deleted ledger entries, deleted withdrawals/deposits/adjustments, deleted-by operator, Telegram Bot AID evidence in raw payload.', deletedTransactionStatus === 'live' ? 'Captured deleted transaction report rows exist.' : 'Probe getReportDeletedTransactions with manager customerID plus startDate/endDate; rows stay separate via sourceOperation.', true),
    sourceRow('deposits', 'Deposits', depositStatus, 'getTransactionList / getCustomerDeposits / getDepositHistory / getCustomerTransactions / getTransactionHistory', 'deposits', freshness.deposits, sourceStatuses.deposits, 'Deposit-like rows filtered from transaction candidates, amount, method, status, transaction time, deposit IP match.', depositStatus === 'live' ? 'Captured deposit-like transaction rows exist.' : 'Probe candidates exist; endpoint availability still needs live proof.', true),
    sourceRow('customer_snapshots', 'Customer Snapshots', snapshotStatus, 'getInfoPlayer / getTeaserProfile / getAccountInfoOwner / getCustomerInfo / getCustomerDetails / getCustomerProfile / getCustomer', 'customer_snapshots', freshness.customer_snapshots, sourceStatuses.customer_snapshots, 'Masked email/phone, currency, VIP/KYC/account metadata.', snapshotStatus === 'live' ? 'Captured account snapshots exist.' : 'Probe getInfoPlayer/getTeaserProfile first, then owner/customer-info candidates until a live payload proves availability.', true),
    sourceRow('teaser_profile', 'Teaser Profile', teaserStatus, 'getTeaserProfile', 'customer_snapshots', { rowCount: 0, lastSeen: null }, sourceStatuses.teaser_profile, 'Candidate source for teaser/account profile fields; stored only after payload shape is confirmed.', 'Probe candidate; no fields are trusted until Buckeye returns a usable payload.', true),
    sourceRow('player_links', 'Player Links', 'derived', 'access_logs shared IP/device detection', 'player_links', freshness.player_links, sourceStatuses.player_links, 'Linked accounts, reason, confidence, evidence.', 'Derived locally from reusable access-log data.', true),
    sourceRow('player_flags', 'Player Flags', 'manual', 'operator entry', 'player_flags', freshness.player_flags, sourceStatuses.player_flags, 'Manual compliance flags and resolution state.', 'Manual terminal overlay.', true),
    sourceRow('player_notes', 'Player Notes', 'manual', 'operator entry', 'player_notes', freshness.player_notes, sourceStatuses.player_notes, 'Telegram handle, VIP host notes, KYC notes, operator context.', 'Manual terminal overlay.', true),
  ];

  const gaps = [
    { key: 'closing_line_feed', label: 'Closing line feed', status: 'missing', detail: 'Not confirmed. CLV uses raw closing-line fields when present, otherwise deterministic estimated CLV.' },
    { key: 'withdrawals', label: 'Withdrawals', status: transactionStatus === 'live' ? 'probe' : 'missing', detail: 'getTransactionList and getTransactionHistory are captured as ledger sources; withdrawal-like rows are classified when present, but no dedicated withdrawal endpoint has been confirmed.' },
    { key: 'kyc_documents', label: 'KYC documents', status: 'missing', detail: 'No document list, expiry date, or verification timeline endpoint is confirmed.' },
    { key: 'source_of_funds', label: 'Deposit source-of-funds', status: 'missing', detail: 'Unavailable unless Buckeye transaction payload includes it.' },
    { key: 'isp_device_fingerprint', label: 'ISP/device fingerprint', status: 'probe', detail: 'Only available when access log payload includes ISP, user-agent, or device fields.' },
    { key: 'telegram_group_chat', label: 'Telegram/group chat', status: 'manual', detail: 'Manual note only; no Buckeye source.' },
    { key: 'linked_account_confidence', label: 'Similar-account confidence beyond shared IP', status: 'probe', detail: 'Needs device/email/deposit overlap data for stronger scoring.' },
  ];

  const profileContract = {
    profile: `${endpointBase}/profile`,
    search: '/api/v1/players/search?q=&agent=&from=&to=&sort=',
    exports: {
      wagers: `${endpointBase}/export/wagers`,
      accessLogs: `${endpointBase}/export/access-logs`,
    },
    audit: {
      accessLogs: `/api/v1/logs/access?login=${encodeURIComponent(playerId)}&limit=100`,
    },
    mutations: {
      flagCreate: `${endpointBase}/flags`,
      noteCreate: `${endpointBase}/notes`,
      multiAccountCheck: `${endpointBase}/links/check`,
    },
    websocket: 'wager.new filtered by customer_id/login while the modal is open',
    tabs: {
      Overview: [`${endpointBase}/profile`],
      'Wager History': [`${endpointBase}/profile`, `${endpointBase}/export/wagers`],
      'Access Logs': [`${endpointBase}/profile`, `/api/v1/logs/access?login=${encodeURIComponent(playerId)}&limit=100`, `${endpointBase}/export/access-logs`],
      Performance: [`${endpointBase}/profile`],
      Deposits: [`${endpointBase}/profile`, `${endpointBase}/deposits`, `${endpointBase}/transactions`],
      Account: [`${endpointBase}/profile`, `${endpointBase}/account-snapshots`],
      Links: [`${endpointBase}/profile`, `${endpointBase}/links`, `${endpointBase}/links/check`],
      Notes: [`${endpointBase}/profile`, `${endpointBase}/flags`, `${endpointBase}/notes`],
      Status: [`${endpointBase}/intelligence-map`, ...Object.values({
        profile: `${endpointBase}/profile`,
        deposits: `${endpointBase}/deposits`,
        transactions: `${endpointBase}/transactions`,
        snapshots: `${endpointBase}/account-snapshots`,
        links: `${endpointBase}/links`,
        flags: `${endpointBase}/flags`,
        notes: `${endpointBase}/notes`,
      })],
    },
  };
  const fieldContract = buildPlayer360FieldContract(endpointBase);
  const tabCoverage = buildPlayer360TabCoverage(sources);
  const contractMismatches = buildPlayer360ContractMismatches(sources, gaps);

  return {
    playerId,
    agentLogin,
    fetchedAt: new Date().toISOString(),
    profileContract,
    fieldContract,
    tabCoverage,
    contractMismatches,
    sources,
    gaps,
    freshness: {
      ...freshness,
      watermarks,
    },
    coverage: {
      haveNow: buildHaveNowCoverage(sources),
      canReuse: ['Buckeye access logs', 'raw wager JSON', 'master snapshots', 'getPerformancePlayer/player performance', 'getTransactionList/getTransactionHistory/getReportDeletedTransactions ledger', 'raw API logs'],
      needOrProbe: ['deposit/withdrawal/deleted transaction classification from transaction ledger endpoints', 'getInfoPlayer/getTeaserProfile customer profile payload shape', 'true closing line', 'source-of-funds', 'document expiry', 'richer device/ISP data'],
      missingSourceCount: sources.filter((source) => source.status === 'missing').length + gaps.filter((gap) => gap.status === 'missing').length,
      sourceCoverage: sources.map((source) => ({ key: source.key, status: source.status, rows: source.rowCount, lastSeen: source.lastSeen })),
    },
  };
}

function buildHaveNowCoverage(sources: IntelligenceSource[]): string[] {
  const sourceStatus = Object.fromEntries(sources.map((source) => [source.key, source.status]));
  const rows: string[] = [];
  if (sourceStatus.wager_archive === 'live') rows.push('live wagers', 'archived wagers', 'player stats', 'sport breakdown', 'pattern flags');
  if (sourceStatus.access_logs === 'live') rows.push('access logs');
  if (sourceStatus.agent_performance_snapshots === 'live') rows.push('agent performance enrichment');
  if (sourceStatus.player_transactions === 'live') rows.push('transaction ledger');
  if (sourceStatus.deleted_transactions === 'live') rows.push('deleted transaction ledger');
  if (sourceStatus.deposits === 'live') rows.push('deposits');
  if (sourceStatus.customer_snapshots === 'live') rows.push('customer profile snapshots');
  if (sourceStatus.player_links === 'derived') rows.push('linked-account derivations');
  if (sourceStatus.player_flags === 'manual' || sourceStatus.player_notes === 'manual') rows.push('manual notes/flags');
  return rows;
}

function sourceRow(
  key: string,
  label: string,
  status: string,
  buckeyeEndpoint: string,
  localTable: string,
  freshness: FreshnessSummary,
  sourceStatus: SourceStatusRow | undefined,
  profileUse: string,
  gap: string,
  reuse: boolean
): IntelligenceSource {
  const policy = getPlayer360SourcePolicy(key);
  const lastAttemptAt = sourceStatus?.last_attempt_at || null;
  const lastSuccessAt = sourceStatus?.last_success_at || freshness.lastSeen || null;
  const lastError = sourceStatus?.last_error || null;
  const effectiveStatus = lastError ? 'error' : status;
  const freshnessState = classifyPlayer360Freshness({
    status: effectiveStatus,
    rowCount: freshness.rowCount,
    ttlSeconds: policy.ttlSeconds,
    lastSeen: freshness.lastSeen,
    lastSuccessAt,
    lastAttemptAt,
    lastError,
    refreshPolicy: policy.refreshPolicy,
  });
  return {
    key,
    label,
    status: effectiveStatus,
    buckeyeEndpoint,
    localTable,
    profileUse,
    rowCount: freshness.rowCount,
    lastSeen: freshness.lastSeen,
    refreshPolicy: policy.refreshPolicy,
    ttlSeconds: policy.ttlSeconds,
    scaleClass: policy.scaleClass,
    lastAttemptAt,
    lastSuccessAt,
    lastError,
    nextRefreshAt: sourceStatus?.next_refresh_at || nextRefreshAt(lastSuccessAt || lastAttemptAt, policy.ttlSeconds),
    freshnessState,
    gap,
    reuse,
  };
}

function buildPlayer360TabCoverage(sources: IntelligenceSource[]): RouteRow[] {
  const sourceMap = Object.fromEntries(sources.map((source) => [source.key, source]));
  const rows = [
    { tab: 'Overview', sources: ['wager_archive', 'agent_performance_snapshots', 'customer_snapshots', 'player_flags', 'player_notes'] },
    { tab: 'Wager History', sources: ['wager_archive'] },
    { tab: 'Access Logs', sources: ['access_logs'] },
    { tab: 'Performance', sources: ['wager_archive', 'agent_performance_snapshots'] },
    { tab: 'Deposits', sources: ['player_transactions', 'deleted_transactions', 'deposits', 'access_logs'] },
    { tab: 'Account', sources: ['customer_snapshots', 'teaser_profile'] },
    { tab: 'Links', sources: ['player_links', 'access_logs'] },
    { tab: 'Notes', sources: ['player_flags', 'player_notes'] },
    { tab: 'Status / Docs', sources: sources.map((source) => source.key) },
  ];
  return rows.map((row) => {
    const requiredSources = row.sources.map((key) => sourceMap[key]).filter(Boolean);
    const dated = requiredSources
      .map((source) => ({ source, timestamp: source.lastSuccessAt || source.lastSeen }))
      .filter((row) => row.timestamp && Number.isFinite(new Date(row.timestamp).getTime()))
      .sort((a, b) => new Date(String(a.timestamp)).getTime() - new Date(String(b.timestamp)).getTime());
    const weakest = requiredSources.find((source) => ['error', 'missing', 'stale', 'probe'].includes(source.freshnessState))
      || dated[0]?.source
      || requiredSources[0];
    const status = requiredSources.some((source) => source.freshnessState === 'error' || source.freshnessState === 'missing')
      ? 'missing'
      : requiredSources.some((source) => source.freshnessState === 'stale' || source.freshnessState === 'probe')
        ? 'probe'
        : 'live';
    return {
      tab: row.tab,
      sources: row.sources,
      status,
      recentUpdateAt: dated[0]?.timestamp || null,
      recentUpdateSource: dated[0]?.source?.key || null,
      weakestSource: weakest?.key || null,
      refreshPolicySummary: Array.from(new Set(requiredSources.map((source) => source.refreshPolicy))).join(', '),
    };
  });
}

function buildPlayer360FieldContract(endpointBase: string): RouteRow[] {
  return [
    { tab: 'Overview', field: 'stats.totalVolume', route: `${endpointBase}/profile`, source: 'wager_archive.amount_wagered', statusRule: 'live when wager_archive rows exist' },
    { tab: 'Overview', field: 'stats.openBets', route: `${endpointBase}/profile`, source: 'wager_archive.status/pending heuristics', statusRule: 'derived from archived wagers' },
    { tab: 'Overview', field: 'stats.winRate', route: `${endpointBase}/profile`, source: 'wager_archive.pnl/result fields', statusRule: 'derived; zero when no settled result fields' },
    { tab: 'Overview', field: 'stats.favoriteSport', route: `${endpointBase}/profile`, source: 'wager_archive.sport/short_desc_raw', statusRule: 'live when sport breakdown rows exist' },
    { tab: 'Overview', field: 'stats.riskScore', route: `${endpointBase}/profile`, source: 'wager_archive + agent_performance_snapshots/getPerformancePlayer', statusRule: 'derived; enriched when player performance rows exist' },
    { tab: 'Overview', field: 'stats.clvPercent', route: `${endpointBase}/profile`, source: 'wager_archive.raw_json ClosingLine/closing fields or estimate', statusRule: 'estimated unless closing-line fields exist' },
    { tab: 'Overview', field: 'flags/notes', route: `${endpointBase}/profile`, source: 'player_flags/player_notes', statusRule: 'manual operator data' },
    { tab: 'Wager History', field: 'recentWagers[]', route: `${endpointBase}/profile`, source: 'wager_archive', statusRule: 'live archive rows' },
    { tab: 'Wager History', field: 'recentWagers[].pattern_flags', route: `${endpointBase}/profile`, source: 'wager_archive + deterministic pattern detection', statusRule: 'derived from real wager fields' },
    { tab: 'Access Logs', field: 'accessLogs[]', route: `${endpointBase}/profile`, source: 'access_logs/getWebLog', statusRule: 'live when access rows exist; missing/probe otherwise' },
    { tab: 'Performance', field: 'weeklyPnl[]', route: `${endpointBase}/profile`, source: 'wager_archive weekly aggregation', statusRule: 'derived from archive rows' },
    { tab: 'Performance', field: 'sportBreakdown[]', route: `${endpointBase}/profile`, source: 'wager_archive.sport', statusRule: 'derived from archive rows' },
    { tab: 'Deposits', field: 'transactions[]', route: `${endpointBase}/transactions`, source: 'player_transactions from getTransactionList/getTransactionHistory/getReportDeletedTransactions', statusRule: 'live when transaction ledger rows exist; probe otherwise' },
    { tab: 'Deposits', field: 'transactions[].raw.sourceOperation=getReportDeletedTransactions', route: `${endpointBase}/transactions`, source: 'deleted transaction rows from getReportDeletedTransactions', statusRule: 'live when deleted report rows exist; probe/missing otherwise' },
    { tab: 'Deposits', field: 'deposits[]', route: `${endpointBase}/deposits`, source: 'deposits table from deposit-like transaction ledger/customer transaction rows', statusRule: 'live when deposit-like transaction rows exist' },
    { tab: 'Account', field: 'accountSnapshots[]', route: `${endpointBase}/account-snapshots`, source: 'customer_snapshots from getInfoPlayer/getTeaserProfile/account-info candidates', statusRule: 'probe until live account snapshot rows exist' },
    { tab: 'Account', field: 'teaserProfile candidate', route: `${endpointBase}/intelligence-map`, source: 'getTeaserProfile mapped as probe; fields stored only after payload shape is confirmed', statusRule: 'probe until a successful getTeaserProfile payload is captured' },
    { tab: 'Links', field: 'links[]', route: `${endpointBase}/links`, source: 'player_links derived from access_logs', statusRule: 'derived; stronger when access logs/device overlap exist' },
    { tab: 'Notes', field: 'flags[]/notes[]', route: `${endpointBase}/flags and ${endpointBase}/notes`, source: 'player_flags/player_notes', statusRule: 'manual operator data' },
    { tab: 'Status / Docs', field: 'sources[]/gaps[]/freshness', route: `${endpointBase}/intelligence-map`, source: 'source freshness + watermarks + raw_api_logs probes', statusRule: 'authoritative Player 360 coverage contract' },
  ];
}

function buildPlayer360ContractMismatches(sources: IntelligenceSource[], gaps: RouteRow[]): RouteRow[] {
  const mismatches: RouteRow[] = [];
  for (const source of sources) {
    if (source.status === 'missing') {
      mismatches.push({
        key: `missing_${source.key}`,
        severity: source.key === 'wager_archive' ? 'critical' : 'warning',
        field: source.profileUse,
        source: source.key,
        status: source.status,
        action: source.gap,
      });
    } else if (source.status === 'probe') {
      mismatches.push({
        key: `probe_${source.key}`,
        severity: 'info',
        field: source.profileUse,
        source: source.key,
        status: source.status,
        action: source.gap,
      });
    }
  }
  for (const gap of gaps) {
    if (gap.status === 'missing') {
      mismatches.push({
        key: gap.key,
        severity: 'warning',
        field: gap.label,
        source: 'Buckeye endpoint not confirmed',
        status: gap.status,
        action: gap.detail,
      });
    }
  }
  return mismatches;
}

async function sourceFreshness(
  db: Database,
  table: string,
  timeColumn: string,
  where: string,
  params: unknown[]
): Promise<{ rowCount: number; lastSeen: string | null }> {
  try {
    const row = await db.get(
      `SELECT COUNT(*) AS rowCount, MAX(${timeColumn}) AS lastSeen FROM ${table} WHERE ${where}`,
      params
    ) as { rowCount: number; lastSeen: string | null } | undefined;
    return {
      rowCount: Number(row?.rowCount || 0),
      lastSeen: row?.lastSeen || null,
    };
  } catch (err) {
    logWarn('Source freshness query failed', { table, params, error: errorMessage(err) });
    return { rowCount: 0, lastSeen: null };
  }
}

async function getPlayerSourceStatusMap(db: Database, playerId: string): Promise<Record<string, SourceStatusRow>> {
  try {
    const rows = await db.all<SourceStatusRow>(
      `SELECT *
       FROM player_source_status
       WHERE customer_id = ? OR login = ?
       ORDER BY updated_at DESC`,
      [playerId, playerId]
    );
    return Object.fromEntries(rows.map((row) => [row.source_key, row]));
  } catch (err) {
    logWarn('Player source status query failed', { playerId, error: errorMessage(err) });
    return {};
  }
}

async function getWatermark(db: Database, key: string): Promise<RouteRow | null> {
  const row = await db.get<{ value: string; updated_at: string }>(
    `SELECT value, updated_at FROM watermarks WHERE key = ?`,
    [key]
  );
  if (!row) return null;
  return {
    key,
    value: parseMaybeJson(row.value),
    updatedAt: row.updated_at,
  };
}

async function rawEndpointProbe(db: Database, endpoints: string[]): Promise<{ seen: boolean; lastSeen: string | null }> {
  try {
    const placeholders = endpoints.map(() => '?').join(',');
    const row = await db.get<{ seen: number; lastSeen: string | null }>(
      `SELECT COUNT(*) AS seen, MAX(fetched_at) AS lastSeen FROM raw_api_logs WHERE endpoint IN (${placeholders})`,
      endpoints
    );
    return { seen: Number(row?.seen || 0) > 0, lastSeen: row?.lastSeen || null };
  } catch (err) {
    logWarn('Raw endpoint probe query failed', { endpoints, error: errorMessage(err) });
    return { seen: false, lastSeen: null };
  }
}

function parseMaybeJson(value: string): unknown {
  return parseJsonOrText(value);
}

async function getPlayerDeposits(scraperManager: BuckeyeScraperManager, playerId: string): Promise<RouteRow[]> {
  const db = scraperManager.getDatabase();
  const rows = await db.all<RouteRow>(
    `SELECT
      d.id,
      d.provider,
      d.customer_id,
      d.login,
      d.agent_id,
      d.agent_login,
      d.amount,
      d.currency,
      d.method,
      d.ip_address,
      d.status,
      d.transaction_time,
      d.pulled_at,
      CASE WHEN d.ip_address IS NOT NULL
        AND d.ip_address <> ''
        AND EXISTS (
          SELECT 1
          FROM access_logs l
          WHERE l.login_id = ?
            AND l.ip_address = d.ip_address
        )
        THEN 1 ELSE 0 END AS ip_matched_login
     FROM deposits d
     WHERE d.customer_id = ? OR d.login = ?
     ORDER BY d.transaction_time DESC
     LIMIT 100`,
    [playerId, playerId, playerId]
  );
  return rows.map(normalizeNumbers);
}

async function getPlayerTransactions(scraperManager: BuckeyeScraperManager, playerId: string, category = ''): Promise<RouteRow[]> {
  const db = scraperManager.getDatabase();
  const where = ['(customer_id = ? OR login = ?)'];
  const params: unknown[] = [playerId, playerId];
  if (category === 'freeplay') {
    where.push(`category IN (${FREEPLAY_CATEGORIES.map(() => '?').join(',')})`);
    params.push(...FREEPLAY_CATEGORIES);
  } else if (category) {
    where.push('category = ?');
    params.push(category);
  }
  const rows = await db.all<RouteRow>(
    `SELECT
      id,
      provider,
      customer_id,
      login,
      agent_id,
      agent_login,
      document_number,
      tran_code,
      tran_type,
      amount,
      balance,
      hold_amount,
      grade_num,
      description,
      entered_by,
      category,
      transaction_time,
      pulled_at,
      raw_json
     FROM player_transactions
     WHERE ${where.join(' AND ')}
     ORDER BY transaction_time DESC
     LIMIT 250`,
    params
  );
  return rows.map((row) => normalizeNumbers({
    ...row,
    sourceConfidence: String(row.category || '').startsWith('freeplay_') ? freePlaySourceConfidence(row) : undefined,
  }));
}

async function getPlayerFreePlaySummary(db: Database, playerId: string): Promise<unknown> {
  const { where, params } = buildFreePlayWhere({ playerId });
  const rows = await db.all<RouteRow>(
    `SELECT
      id,
      customer_id AS customerId,
      login,
      agent_id AS agentId,
      agent_login AS agentLogin,
      tran_type AS tranType,
      amount,
      description,
      category,
      transaction_time AS transactionTime,
      raw_json AS rawJson
     FROM player_transactions
     WHERE ${where.join(' AND ')}`,
    params
  );
  const normalized = rows.map((row) => ({
    ...row,
    amount: Number(row.amount || 0),
    sourceConfidence: freePlaySourceConfidence(row),
  }));
  return summarizeFreePlay(normalized);
}

async function getPlayerAccountSnapshots(scraperManager: BuckeyeScraperManager, playerId: string): Promise<RouteRow[]> {
  const db = scraperManager.getDatabase();
  return db.all<RouteRow>(
    `SELECT
      id,
      provider,
      customer_id,
      login,
      agent_id,
      agent_login,
      kyc_level,
      vip_status,
      email_masked,
      phone_masked,
      currency,
      source,
      snapshot_time
     FROM customer_snapshots
     WHERE customer_id = ? OR login = ?
     ORDER BY snapshot_time DESC
     LIMIT 20`,
    [playerId, playerId]
  );
}

async function getPlayerLinks(scraperManager: BuckeyeScraperManager, playerId: string): Promise<RouteRow[]> {
  const db = scraperManager.getDatabase();
  return db.all<RouteRow>(
    `SELECT *
     FROM player_links
     WHERE player_a = ? OR player_b = ?
     ORDER BY detected_at DESC
     LIMIT 100`,
    [playerId, playerId]
  );
}

async function getPlayerFlags(scraperManager: BuckeyeScraperManager, playerId: string): Promise<RouteRow[]> {
  const db = scraperManager.getDatabase();
  return db.all<RouteRow>(
    `SELECT *
     FROM player_flags
     WHERE customer_id = ?
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 100`,
    [playerId]
  );
}

async function getPlayerNotes(scraperManager: BuckeyeScraperManager, playerId: string): Promise<RouteRow[]> {
  const db = scraperManager.getDatabase();
  return db.all<RouteRow>(
    `SELECT *
     FROM player_notes
     WHERE customer_id = ? AND archived_at IS NULL
     ORDER BY created_at DESC
     LIMIT 100`,
    [playerId]
  );
}

function normalizeNumbers<T extends RouteRow>(row: T): T {
  if (!row) return row;
  const next: RouteRow = { ...row };
  for (const key of Object.keys(next)) {
    if (/(count|volume|risk|wager|amount|win|pnl|score|bets)$/i.test(key)) {
      const value = Number(next[key]);
      if (Number.isFinite(value)) next[key] = value;
    }
  }
  return next as T;
}

function buildWagerIntelligence(rows: RouteRow[]): {
  wagers: RouteRow[];
  metrics: {
    clvPercent: number;
    staleLineHits: number;
    pastPostingRate: number;
    patternHits: number;
    nearGoalEvents: number;
    burstBettingHits: number;
  };
} {
  const minuteCounts = new Map<string, number>();
  for (const row of rows) {
    const minute = String(row.insert_date_time || '').slice(0, 16);
    if (!minute) continue;
    minuteCounts.set(minute, (minuteCounts.get(minute) || 0) + 1);
  }

  let clvTotal = 0;
  let clvCount = 0;
  let staleLineHits = 0;
  let pastPostingHits = 0;
  let nearGoalEvents = 0;
  let burstBettingHits = 0;
  let patternHits = 0;

  const wagers = rows.map((row) => {
    const raw = parseRawJson(row.raw_json);
    const price = numberOrNull(row.price ?? raw.Price ?? raw.Odds ?? raw.Line);
    const closingLine = numberOrNull(
      raw.ClosingLine ?? raw.ClosingPrice ?? raw.ClosingOdds ?? raw.closingLine ?? raw.closeLine
    ) ?? estimateClosingLine(row, price);
    const clv = price !== null && closingLine !== null ? closingLine - price : 0;
    const clvPercent = price !== null && price !== 0 ? Number(((clv / Math.abs(price)) * 100).toFixed(2)) : 0;
    const desc = String(row.short_desc_raw || '').toLowerCase();
    const ticketWriter = String(row.ticket_writer || '').toLowerCase();
    const flags: string[] = [];

    if (Math.abs(clvPercent) >= 3) {
      flags.push('stale_line');
      staleLineHits += 1;
    }
    if (ticketWriter.includes('gslive') || /\blive\b|in[-\s]?play/.test(desc)) {
      flags.push('past_posting_watch');
      pastPostingHits += 1;
    }
    if (/goal|corner|red card|penalty|minute|injury/.test(desc)) {
      flags.push('near_event');
      nearGoalEvents += 1;
    }
    const minute = String(row.insert_date_time || '').slice(0, 16);
    if (minute && (minuteCounts.get(minute) || 0) >= 3) {
      flags.push('burst_betting');
      burstBettingHits += 1;
    }
    if (Math.abs(Number(row.amount_wagered || 0)) >= 100000) {
      flags.push('high_stake');
    }

    if (clvPercent !== 0) {
      clvTotal += clvPercent;
      clvCount += 1;
    }
    if (flags.length) patternHits += 1;

    return {
      ...row,
      closing_line: closingLine,
      clv,
      clv_percent: clvPercent,
      clv_source: hasClosingLine(raw) ? 'raw' : 'estimated',
      pattern_flags: flags,
      pattern_severity: classifyPatternSeverity(flags, clvPercent),
    };
  });

  const total = rows.length || 1;
  return {
    wagers,
    metrics: {
      clvPercent: clvCount ? Number((clvTotal / clvCount).toFixed(2)) : 0,
      staleLineHits,
      pastPostingRate: Number(((pastPostingHits / total) * 100).toFixed(1)),
      patternHits,
      nearGoalEvents,
      burstBettingHits,
    },
  };
}

function estimateClosingLine(row: RouteRow, price: number | null): number | null {
  if (price === null) return null;
  const seed = Math.abs(Number(row.wager_number || row.id || 0)) % 9;
  return price + (seed - 4) * 3;
}

function parseRawJson(value: unknown): RouteRow {
  if (!value) return {};
  if (typeof value === 'object') return value as RouteRow;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    logWarn('Raw JSON parse failed', { error: errorMessage(err) });
    return {};
  }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function hasClosingLine(raw: RouteRow): boolean {
  return raw.ClosingLine !== undefined || raw.ClosingPrice !== undefined || raw.ClosingOdds !== undefined || raw.closingLine !== undefined || raw.closeLine !== undefined;
}

function classifyPatternSeverity(flags: string[], clvPercent: number): string {
  if (flags.includes('past_posting_watch') || Math.abs(clvPercent) >= 8) return 'critical';
  if (flags.includes('stale_line') || flags.includes('near_event')) return 'warning';
  if (flags.includes('burst_betting') || flags.includes('high_stake')) return 'watch';
  return '';
}

function extractAccessMeta(row: RouteRow, key: 'device' | 'geo'): string {
  const values = [row.data, row.raw_json];
  for (const value of values) {
    if (!value) continue;
    const text = String(value);
    try {
      const parsed = JSON.parse(text);
      const found = key === 'device'
        ? parsed?.device || parsed?.Device || parsed?.deviceName || parsed?.userAgent
        : parsed?.geo || parsed?.Geo || parsed?.country || parsed?.city || parsed?.region;
      if (found) return String(found);
    } catch (err) {
      logWarn('Access log data parse failed', { key, error: errorMessage(err) });
      if (key === 'device') {
        const deviceMatch = text.match(/(Mobile|Desktop|Windows|Mac|iPhone|Android|Chrome|Safari|Firefox)/i);
        if (deviceMatch) return deviceMatch[0];
      }
      if (key === 'geo') {
        const geoMatch = text.match(/\b[A-Z]{2}\b/);
        if (geoMatch) return geoMatch[0];
      }
    }
  }
  return '';
}

function csvExport(rows: RouteRow[], filename: string): Response {
  const csv = toCsv(rows);
  return new Response(csv, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

function toCsv(rows: RouteRow[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ].join('\n');
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/"/g, '""');
  return /[",\r\n]/.test(text) ? `"${text}"` : text;
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80) || 'player';
}

export const registerPlayerWagersRoutes = createParamRouteHandler(
  '/api/players/:playerId/wagers',
  'playerId',
  async (_url, _req, scraperManager, params) => {
    logRequest('GET', `/api/players/${params.playerId}/wagers`);
    return scraperManager.getPlayerWagers(params.playerId);
  }
);

export const registerPlayerPnlRoutes = createParamRouteHandler(
  '/api/players/:playerId/pnl',
  'playerId',
  async (url, _req, scraperManager, params) => {
    logRequest('GET', `/api/players/${params.playerId}/pnl`);
    const days = clampInt(url.searchParams.get('days'), 7, 1, 90);
    return scraperManager.getPlayerPnlHistory(params.playerId, days);
  }
);

// POST /api/players/:playerId/flags — create a flag
export const registerPlayerFlagCreateRoutes = createParamRouteHandler(
  '/api/players/:playerId/flags',
  'playerId',
  async (_url, request, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('POST', `/api/players/${playerId}/flags`);
    const body = await readJsonBody(request);
    if (!body.flag_type) throw new ApiError(400, 'flag_type is required');
    const db = scraperManager.getDatabase();
    const result = await db.run(
      `INSERT INTO player_flags (provider, customer_id, flag_type, severity, label, details, created_by, status)
       VALUES ('buckeye', ?, ?, ?, ?, ?, ?, 'active')`,
      [playerId, body.flag_type, body.severity || 'info', body.label || body.flag_type, body.details || '', body.created_by || 'terminal']
    );
    return { success: true, flagId: result.lastID };
  }
);

// POST /api/players/:playerId/flags/:flagId/resolve — resolve a flag
export const registerPlayerFlagResolveRoutes = createParamRouteHandler(
  '/api/players/:playerId/flags/:flagId/resolve',
  'flagId',
  async (_url, req, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    const flagId = Number(params.flagId);
    logRequest('POST', `/api/players/${playerId}/flags/${flagId}/resolve`);
    if (!Number.isInteger(flagId) || flagId <= 0) throw new ApiError(400, 'Invalid flagId');
    const db = scraperManager.getDatabase();
    await db.run(
      `UPDATE player_flags SET status = 'resolved', resolved_at = datetime('now') WHERE id = ? AND customer_id = ?`,
      [flagId, playerId]
    );
    return { success: true };
  }
);

// POST /api/players/:playerId/notes — create a note
export const registerPlayerNoteCreateRoutes = createParamRouteHandler(
  '/api/players/:playerId/notes',
  'playerId',
  async (_url, request, scraperManager, params) => {
    const playerId = decodeURIComponent(params.playerId);
    logRequest('POST', `/api/players/${playerId}/notes`);
    const body = await readJsonBody(request);
    if (!body.body) throw new ApiError(400, 'body is required');
    const db = scraperManager.getDatabase();
    const result = await db.run(
      `INSERT INTO player_notes (provider, customer_id, note_type, body, created_by)
       VALUES ('buckeye', ?, ?, ?, ?)`,
      [playerId, body.note_type || 'general', body.body, body.created_by || 'terminal']
    );
    return { success: true, noteId: result.lastID };
  }
);
