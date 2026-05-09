/**
 * Agent routes
 */
import { createRouteHandler, createParamRouteHandler, createMethodRouteHandler } from './base';
import { corsHeaders, loadLocalAgentHierarchy } from '../helpers';
import { logRequest } from '../../utils/logger';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import { syncAgentProjectionTables, upsertLiveAgentHierarchy } from '../../services/HierarchyBackfillService';
import { formatAgentNode, normalizeAgentNumbers } from './agentFormatters';
import {
  clearAgentHierarchyTreeCache,
  getAgentHierarchyTree,
  getCachedAgentHierarchyTree,
} from './agentHierarchyTree';

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
