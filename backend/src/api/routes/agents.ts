/**
 * Agent routes
 */
import { createRouteHandler, createParamRouteHandler, createMethodRouteHandler } from './base';
import { corsHeaders, loadLocalAgentHierarchy } from '../helpers';
import { logRequest } from '../../utils/logger';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import { syncAgentProjectionTables, upsertLiveAgentHierarchy } from '../../services/HierarchyBackfillService';

const HIERARCHY_TREE_CACHE_TTL_MS = 60_000;

let hierarchyTreeCache:
  | {
      json: string;
      gzip: Uint8Array;
      etag: string;
      generatedAt: number;
      responseMeta: {
        agentCount: number;
        rootCount: number;
        maxLastRefreshed: string;
      };
    }
  | null = null;

export function clearAgentHierarchyTreeCache(): void {
  hierarchyTreeCache = null;
}

export const registerAgentRoutes = createRouteHandler('/api/agents', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/agents');
  return scraperManager.getAgents();
});

export const registerAgentExposureRoutes = createParamRouteHandler(
  '/api/agents/:agentId/exposure',
  'agentId',
  async (_url, _req, scraperManager, params) => {
    logRequest('GET', `/api/agents/${params.agentId}/exposure`);
    return scraperManager.getAgentData(params.agentId);
  }
);

export const registerAgentPerformanceRoutes = createParamRouteHandler(
  '/api/agents/:agentId/performance',
  'agentId',
  async (_url, _req, scraperManager, params) => {
    logRequest('GET', `/api/agents/${params.agentId}/performance`);
    return scraperManager.getAgentPerformance(params.agentId);
  }
);

export const registerAgentDownlineRoutes = createRouteHandler('/api/agents/downline', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/agents/downline');
  return scraperManager.getAgentDownline();
});

export const registerAgentHierarchyRoutes = createRouteHandler('/api/agents/hierarchy', async (url, _req, scraperManager) => {
  logRequest('GET', '/api/agents/hierarchy');
  const agentId = url.searchParams.get('agentId') || undefined;
  const persistedHierarchy = await scraperManager.getPersistedAgentHierarchy();
  if (Array.isArray(persistedHierarchy?.GENERAL) && persistedHierarchy.GENERAL.length > 0) {
    return persistedHierarchy;
  }
  const liveHierarchy = await scraperManager.getAgentHierarchy(agentId);
  if (Array.isArray(liveHierarchy?.GENERAL) && liveHierarchy.GENERAL.length > 0) {
    return liveHierarchy;
  }
  const localHierarchy = await loadLocalAgentHierarchy();
  return localHierarchy.GENERAL.length > 0 ? localHierarchy : liveHierarchy;
});

export const registerAgentRefreshRoutes = createMethodRouteHandler(
  '/api/agents/refresh',
  'POST',
  async (url, _req, scraperManager) => {
    logRequest('POST', '/api/agents/refresh');
    const agentId = url.searchParams.get('agentId') || undefined;
    const db = scraperManager.getDatabase();
    const liveHierarchy = await withTimeout(
      scraperManager.getAgentHierarchy(agentId),
      10000,
      { GENERAL: [], error: 'Buckeye hierarchy refresh timed out after 10s' }
    );
    if (Array.isArray(liveHierarchy?.GENERAL) && liveHierarchy.GENERAL.length > 0) {
      clearAgentHierarchyTreeCache();
      return {
        ...(await upsertLiveAgentHierarchy(db, liveHierarchy, 'buckeye_api')),
        source: 'buckeye_api',
      };
    }
    const warning = liveHierarchy?.message || liveHierarchy?.error || 'Live Buckeye hierarchy unavailable; cached projection was left unchanged.';
    return {
      success: false,
      provider: 'buckeye',
      source: 'live_refresh_unavailable',
      agents: 0,
      players: 0,
      warning,
    };
  }
);

export const registerAgentHierarchyTreeRoutes = createRouteHandler('/api/agents/hierarchy/tree', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/agents/hierarchy/tree');
  return getAgentHierarchyTree(scraperManager.getDatabase());
});

export async function registerCachedAgentHierarchyTreeRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Promise<Response | null> {
  if (url.pathname !== '/api/agents/hierarchy/tree') return null;
  logRequest('GET', '/api/agents/hierarchy/tree');
  const payload = await getCachedAgentHierarchyTree(scraperManager.getDatabase());
  const headers = new Headers(corsHeaders);
  headers.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  headers.set('ETag', payload.etag);
  headers.set('X-Cache', payload.cacheHit ? 'HIT' : 'MISS');
  headers.set('X-Agent-Count', String(payload.agentCount));

  if (request.headers.get('if-none-match') === payload.etag) {
    return new Response(null, { status: 304, headers });
  }

  if ((request.headers.get('accept-encoding') || '').includes('gzip')) {
    headers.set('Content-Encoding', 'gzip');
    headers.set('Vary', 'Accept-Encoding');
    return new Response(payload.gzip, { headers });
  }

  return new Response(payload.json, { headers });
}

export const registerAgentProfileRoutes = createParamRouteHandler(
  '/api/agents/:agentId',
  'agentId',
  async (_url, _req, scraperManager, params) => {
    const agentId = decodeURIComponent(params.agentId);
    logRequest('GET', `/api/agents/${agentId}`);
    return getAgentProfile(scraperManager.getDatabase(), agentId);
  }
);

export const registerAgentPlayersRoutes = createParamRouteHandler(
  '/api/agents/:agentId/players',
  'agentId',
  async (url, _req, scraperManager, params) => {
    const agentId = decodeURIComponent(params.agentId);
    logRequest('GET', `/api/agents/${agentId}/players`);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 250), 1), 1000);
    const rows = await scraperManager.getDatabase().all(
      `SELECT
        m.player_id AS playerId,
        m.player_login AS login,
        m.agent_id AS agentId,
        m.agent_login AS agentLogin,
        m.linked_accounts_json AS linkedAccountsJson,
        m.last_refreshed AS lastRefreshed,
        COALESCE(SUM(w.amount_wagered), 0) AS totalVolume,
        COUNT(w.id) AS wagerCount,
        MAX(w.insert_date_time) AS lastWagerAt
       FROM player_agent_map m
       LEFT JOIN wager_archive w ON w.login = m.player_login OR w.customer_id = m.player_login
       WHERE m.provider = 'buckeye'
        AND (m.agent_id = ? OR m.agent_login = ?)
       GROUP BY m.player_id, m.player_login, m.agent_id, m.agent_login, m.linked_accounts_json, m.last_refreshed
       ORDER BY totalVolume DESC, m.player_login ASC
       LIMIT ?`,
      [agentId, agentId, limit]
    );
    return { agentId, players: rows.map(normalizeAgentNumbers), count: rows.length };
  }
);

export const registerAgentBackfillRoutes = createMethodRouteHandler(
  '/api/agents/backfill/hierarchy',
  'POST',
  async (_url, _req, scraperManager) => {
    logRequest('POST', '/api/agents/backfill/hierarchy');
    const result = await scraperManager.backfillAgentHierarchy();
    clearAgentHierarchyTreeCache();
    return result;
  }
);

export const registerAgentAccessLogRoutes = createRouteHandler('/api/agents/access-logs', async (_url, _req, scraperManager) => {
  logRequest('GET', '/api/agents/access-logs');
  return scraperManager.getAccessLogs();
});

async function getAgentHierarchyTree(db: any): Promise<any> {
  await syncAgentProjectionTables(db, 'read_through');
  const rows = await db.all(
    `SELECT *
     FROM agent_hierarchy
     WHERE provider = 'buckeye'
     ORDER BY COALESCE(seq_number, 999999999), COALESCE(level, 99), login`
  );
  const nodes = rows.map(formatAgentNode);
  const byId = new Map(nodes.map((node: any) => [node.agentId, { ...node, children: [] }]));
  const roots: any[] = [];
  for (const node of byId.values()) {
    const parent = node.parentAgentId ? byId.get(node.parentAgentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return {
    tree: roots,
    agents: nodes,
    meta: {
      source: 'agent_hierarchy',
      agentCount: nodes.length,
      rootCount: roots.length,
      maxLevel: nodes.reduce((max: number, node: any) => Math.max(max, Number(node.level || 0)), 0),
      refreshedAt: new Date().toISOString(),
    },
  };
}

async function getCachedAgentHierarchyTree(db: any): Promise<{
  json: string;
  gzip: Uint8Array;
  etag: string;
  agentCount: number;
  cacheHit: boolean;
}> {
  const now = Date.now();
  if (hierarchyTreeCache && now - hierarchyTreeCache.generatedAt < HIERARCHY_TREE_CACHE_TTL_MS) {
    return {
      json: hierarchyTreeCache.json,
      gzip: hierarchyTreeCache.gzip,
      etag: hierarchyTreeCache.etag,
      agentCount: hierarchyTreeCache.responseMeta.agentCount,
      cacheHit: true,
    };
  }

  const version = await db.get(
    `SELECT
       COUNT(*) AS agentCount,
       MAX(last_refreshed) AS maxLastRefreshed
     FROM agent_hierarchy
     WHERE provider = 'buckeye'`
  );
  const agentCount = Number(version?.agentCount || 0);
  const maxLastRefreshed = String(version?.maxLastRefreshed || '');

  if (
    hierarchyTreeCache
    && hierarchyTreeCache.responseMeta.agentCount === agentCount
    && hierarchyTreeCache.responseMeta.maxLastRefreshed === maxLastRefreshed
  ) {
    hierarchyTreeCache.generatedAt = now;
    return {
      json: hierarchyTreeCache.json,
      gzip: hierarchyTreeCache.gzip,
      etag: hierarchyTreeCache.etag,
      agentCount: hierarchyTreeCache.responseMeta.agentCount,
      cacheHit: true,
    };
  }

  const tree = await getAgentHierarchyTree(db);
  const json = JSON.stringify(tree);
  const gzip = Bun.gzipSync(json);
  hierarchyTreeCache = {
    json,
    gzip,
    etag: `W/"agents-${tree.meta.agentCount}-${tree.meta.rootCount}-${tree.meta.maxLevel}-${gzip.byteLength}"`,
    generatedAt: now,
    responseMeta: {
      agentCount: tree.meta.agentCount,
      rootCount: tree.meta.rootCount,
      maxLastRefreshed,
    },
  };

  return {
    json: hierarchyTreeCache.json,
    gzip: hierarchyTreeCache.gzip,
    etag: hierarchyTreeCache.etag,
    agentCount: hierarchyTreeCache.responseMeta.agentCount,
    cacheHit: false,
  };
}

async function getAgentProfile(db: any, agentId: string): Promise<any> {
  await syncAgentProjectionTables(db, 'read_through');
  const row = await db.get(
    `SELECT *
     FROM agent_hierarchy
     WHERE provider = 'buckeye'
      AND (agent_id = ? OR login = ?)
     LIMIT 1`,
    [agentId, agentId]
  );
  if (!row) {
    return { agentId, agent: null, players: [], children: [], message: 'Agent not found' };
  }
  const agent = formatAgentNode(row);
  const [children, players] = await Promise.all([
    db.all(
      `SELECT *
       FROM agent_hierarchy
       WHERE provider = 'buckeye' AND parent_agent_id = ?
       ORDER BY COALESCE(seq_number, 999999999), login`,
      [agent.agentId]
    ),
    db.all(
      `SELECT player_id AS playerId, player_login AS login, agent_id AS agentId, agent_login AS agentLogin, linked_accounts_json AS linkedAccountsJson, last_refreshed AS lastRefreshed
       FROM player_agent_map
       WHERE provider = 'buckeye' AND agent_id = ?
       ORDER BY player_login
       LIMIT 250`,
      [agent.agentId]
    ),
  ]);
  return {
    agent,
    children: children.map(formatAgentNode),
    players: players.map(normalizeAgentNumbers),
    counts: {
      children: children.length,
      players: players.length,
    },
  };
}

function formatAgentNode(row: any): any {
  return normalizeAgentNumbers({
    agentId: row.agent_id,
    login: row.login || row.agent_id,
    displayName: row.display_name || row.login || row.agent_id,
    parentAgentId: row.parent_agent_id || '',
    level: row.level,
    agentType: row.agent_type,
    seqNumber: row.seq_number,
    childCount: row.child_count,
    playerCount: row.player_count,
    rates: {
      HeadCountRateM: row.head_count_rate_m,
      InetHeadCountRateM: row.inet_head_count_rate_m,
      CasinoHeadCountRateM: row.casino_head_count_rate_m,
      LiveBettingRateM: row.live_betting_rate_m,
      LiveBetting2RateM: row.live_betting2_rate_m,
      LiveCasinoRateM: row.live_casino_rate_m,
      PropBuilderRateM: row.prop_builder_rate_m,
      FlashBetsRate: row.flash_bets_rate,
      ExtPropsRate: row.ext_props_rate,
      CrashRate: row.crash_rate,
      FantasyRate: row.fantasy_rate,
      AmigoTechRate: row.amigo_tech_rate,
    },
    lastRefreshed: row.last_refreshed,
  });
}

function normalizeAgentNumbers(row: any): any {
  const out: any = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (value === null || value === undefined) out[key] = value;
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : 0;
    else out[key] = value;
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        resolve({ ...(fallback as any), error: err?.message || String(err) });
      });
  });
}
