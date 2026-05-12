import type { Database } from '../../database';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import { logRequest } from '../../utils/logger';
import { ApiError, corsHeaders, handleAsync, readJsonBody, requireAdminTokenIfConfigured } from '../helpers';

const RATE_SUM_SQL = `(
  ABS(COALESCE(head_count_rate_m, 0)) +
  ABS(COALESCE(inet_head_count_rate_m, 0)) +
  ABS(COALESCE(casino_head_count_rate_m, 0)) +
  ABS(COALESCE(live_betting_rate_m, 0)) +
  ABS(COALESCE(live_betting2_rate_m, 0)) +
  ABS(COALESCE(live_casino_rate_m, 0)) +
  ABS(COALESCE(prop_builder_rate_m, 0)) +
  ABS(COALESCE(flash_bets_rate, 0)) +
  ABS(COALESCE(ext_props_rate, 0)) +
  ABS(COALESCE(crash_rate, 0)) +
  ABS(COALESCE(fantasy_rate, 0)) +
  ABS(COALESCE(amigo_tech_rate, 0))
)`;

const TEST_SQL = `(
  LOWER(COALESCE(login, '')) LIKE '%test%' OR
  LOWER(COALESCE(login, '')) LIKE '%sandbox%' OR
  LOWER(COALESCE(login, '')) LIKE '%demo%' OR
  LOWER(COALESCE(display_name, '')) LIKE '%test%' OR
  LOWER(COALESCE(display_name, '')) LIKE '%sandbox%'
)`;

const RISK_SCORE_SQL = `MIN(1.0,
  CASE WHEN ${TEST_SQL} THEN 0.65 ELSE 0 END +
  CASE WHEN ${RATE_SUM_SQL} = 0 THEN 0.25 ELSE 0 END +
  CASE WHEN COALESCE(child_count, 0) > 0 AND COALESCE(player_count, 0) = 0 THEN 0.20 ELSE 0 END +
  CASE WHEN COALESCE(level, 0) >= 12 THEN 0.10 ELSE 0 END
)`;

const SCORED_AGENT_SQL = `
  SELECT
    agent_id,
    login,
    display_name,
    parent_agent_id,
    level,
    agent_type,
    seq_number,
    child_count,
    player_count,
    last_refreshed,
    ${RATE_SUM_SQL} AS commission_rate,
    ${RATE_SUM_SQL} AS rate_sum,
    ${RISK_SCORE_SQL} AS risk_score,
    CASE
      WHEN ${RATE_SUM_SQL} = 0 THEN 'zero'
      WHEN ${RATE_SUM_SQL} < 5 THEN 'low'
      WHEN ${RATE_SUM_SQL} < 15 THEN 'standard'
      ELSE 'premium'
    END AS commission_tier
  FROM agent_hierarchy
  WHERE provider = 'buckeye'
`;

type SqlRow = Record<string, unknown>;

export async function registerHierarchyRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/hierarchy/')) return null;
  const path = url.pathname;
  const db = scraperManager.getDatabase();

  if (request.method === 'GET' && path === '/api/hierarchy/stats') {
    logRequest('GET', path);
    return handleAsync(() => getHierarchyStats(db), corsHeaders);
  }
  if (request.method === 'GET' && path === '/api/hierarchy/search') {
    logRequest('GET', path);
    return handleAsync(() => searchHierarchy(db, url.searchParams.get('q') || ''), corsHeaders);
  }
  if (request.method === 'GET' && path === '/api/hierarchy/hubs') {
    logRequest('GET', path);
    return handleAsync(() => getHierarchyHubs(db), corsHeaders);
  }
  if (request.method === 'GET' && path === '/api/hierarchy/hub') {
    logRequest('GET', path);
    return handleAsync(() => getHierarchyHub(db, url.searchParams.get('id') || '', Number(url.searchParams.get('maxLevel') || 3)), corsHeaders);
  }
  if (request.method === 'GET' && path === '/api/hierarchy/risk') {
    logRequest('GET', path);
    const threshold = Math.min(Math.max(Number(url.searchParams.get('threshold') || 0.5), 0), 1);
    return handleAsync(() => listAgents(db, `risk_score >= ?`, [threshold]), corsHeaders);
  }
  if (request.method === 'GET' && path === '/api/hierarchy/tests') {
    logRequest('GET', path);
    return handleAsync(() => listAgents(db, `is_test_agent = 1`, []), corsHeaders);
  }
  if (request.method === 'GET' && path === '/api/hierarchy/zero-commission') {
    logRequest('GET', path);
    return handleAsync(() => listAgents(db, `rate_sum = 0`, []), corsHeaders);
  }
  if (request.method === 'POST' && path === '/api/hierarchy/import') {
    logRequest('POST', path);
    const denied = requireAdminTokenIfConfigured(request);
    if (denied) return denied;
    return handleAsync(async () => scraperManager.runHierarchyImport('manual_import', url.searchParams.get('agentId') || undefined), corsHeaders);
  }
  if (request.method === 'GET' && path === '/api/hierarchy/sync-status') {
    logRequest('GET', path);
    return handleAsync(() => scraperManager.getHierarchySyncStatus(), corsHeaders);
  }
  if (request.method === 'PUT' && path === '/api/hierarchy/sync-config') {
    logRequest('PUT', path);
    const denied = requireAdminTokenIfConfigured(request);
    if (denied) return denied;
    return handleAsync(async () => scraperManager.updateHierarchySyncConfig(await readJsonBody(request)), corsHeaders);
  }

  return null;
}

async function getHierarchyStats(db: Database): Promise<Record<string, unknown>> {
  const row = await db.get<SqlRow>(
    `WITH scored AS (${SCORED_AGENT_SQL})
     SELECT
      (SELECT COUNT(*) FROM scored) AS total_agents,
      (SELECT COUNT(*) FROM scored WHERE COALESCE(child_count, 0) > 0) AS hubs,
      (SELECT COUNT(*) FROM scored WHERE risk_score >= 0.5) AS risk_agents,
      (SELECT COUNT(*) FROM scored WHERE rate_sum = 0) AS zero_rate_agents,
      (SELECT MAX(last_refreshed) FROM agent_hierarchy WHERE provider = 'buckeye') AS last_imported`
  );
  return {
    total_agents: Number(row?.total_agents || 0),
    hubs: Number(row?.hubs || 0),
    risk_agents: Number(row?.risk_agents || 0),
    zero_rate_agents: Number(row?.zero_rate_agents || 0),
    last_imported: row?.last_imported || null,
  };
}

async function searchHierarchy(db: Database, query: string): Promise<Record<string, unknown>> {
  const q = query.trim();
  if (q.length < 2) return { agents: [] };
  const like = `%${q}%`;
  const rows = await db.all<SqlRow>(
    `WITH scored AS (${SCORED_AGENT_SQL})
     SELECT
      s.agent_id,
      s.login,
      s.display_name,
      s.level,
      s.commission_rate,
      s.risk_score,
      COALESCE(parent.login, parent.agent_id, '') AS hub_name
     FROM scored s
     LEFT JOIN agent_hierarchy parent
      ON parent.provider = 'buckeye'
      AND parent.agent_id = s.parent_agent_id
     WHERE s.login LIKE ? OR s.agent_id LIKE ? OR COALESCE(s.display_name, '') LIKE ?
     ORDER BY s.level, s.login
     LIMIT 50`,
    [like, like, like]
  );
  return { agents: rows };
}

async function getHierarchyHubs(db: Database): Promise<Record<string, unknown>> {
  let rows = await db.all<SqlRow>(
    `WITH scored AS (${SCORED_AGENT_SQL}),
      hub_rows AS (
        SELECT
          h.agent_id AS hub_id,
          h.login AS hub_name,
          h.level,
          COUNT(c.descendant) AS agent_count,
          SUM(CASE WHEN s.risk_score >= 0.5 THEN 1 ELSE 0 END) AS risk_agent_count,
          MAX(s.rate_sum) AS max_rate
        FROM scored h
        JOIN agent_closure c
          ON c.provider = 'buckeye'
         AND c.ancestor = h.agent_id
         AND c.depth BETWEEN 1 AND 17
        JOIN scored s
          ON s.agent_id = c.descendant
        WHERE COALESCE(h.child_count, 0) > 0
        GROUP BY h.agent_id, h.login, h.level
      )
     SELECT
      hub_id,
      hub_name,
      agent_count,
      level,
      risk_agent_count,
      CASE
        WHEN COALESCE(max_rate, 0) = 0 THEN 'zero'
        WHEN max_rate < 5 THEN 'low'
        WHEN max_rate < 15 THEN 'standard'
        ELSE 'premium'
      END AS commission_tier
     FROM hub_rows
     ORDER BY agent_count DESC, risk_agent_count DESC, hub_name`
  );
  if (rows.length === 0) {
    rows = await db.all<SqlRow>(
      `WITH scored AS (${SCORED_AGENT_SQL})
       SELECT
        agent_id AS hub_id,
        login AS hub_name,
        COALESCE(child_count, 0) AS agent_count,
        level,
        CASE WHEN risk_score >= 0.5 THEN 1 ELSE 0 END AS risk_agent_count,
        commission_tier
       FROM scored
       WHERE COALESCE(child_count, 0) > 0
       ORDER BY agent_count DESC, hub_name`
    );
  }
  return { hubs: rows };
}

async function getHierarchyHub(db: Database, hubId: string, rawMaxLevel: number): Promise<Record<string, unknown>> {
  const id = hubId.trim();
  if (!id) throw new ApiError(400, 'Hub id is required', 'HUB_ID_REQUIRED');
  const maxLevel = Math.min(Math.max(Number.isFinite(rawMaxLevel) ? Math.round(rawMaxLevel) : 3, 1), 17);
  const params = [id, id, maxLevel];
  let rows = await db.all<SqlRow>(
    `WITH hub AS (
        SELECT agent_id, login, level
        FROM agent_hierarchy
        WHERE provider = 'buckeye' AND (agent_id = ? OR login = ?)
        LIMIT 1
      ),
      scored AS (${SCORED_AGENT_SQL})
     SELECT
      s.agent_id,
      s.login,
      s.display_name,
      s.level,
      s.agent_type,
      s.commission_rate,
      s.risk_score,
      s.commission_tier,
      c.depth AS relative_depth
     FROM hub
     JOIN agent_closure c
      ON c.provider = 'buckeye'
      AND c.ancestor = hub.agent_id
      AND c.depth BETWEEN 0 AND ?
     JOIN scored s ON s.agent_id = c.descendant
     ORDER BY c.depth, s.level, s.login
     LIMIT 500`,
    params
  );
  if (rows.length === 0) {
    rows = await db.all<SqlRow>(
      `WITH scored AS (${SCORED_AGENT_SQL})
       SELECT
        agent_id,
        login,
        display_name,
        level,
        agent_type,
        commission_rate,
        risk_score,
        commission_tier,
        1 AS relative_depth
       FROM scored
       WHERE parent_agent_id = ? OR agent_id = ? OR login = ?
       ORDER BY level, login
       LIMIT 500`,
      [id, id, id]
    );
  }
  const hub = rows[0]
    ? { hub_name: rows[0].login || id, hub_id: id, agents: rows }
    : { hub_name: id, hub_id: id, agents: [] };
  return { hub, maxLevel };
}

async function listAgents(db: Database, whereSql: string, params: unknown[]): Promise<Record<string, unknown>> {
  const rows = await db.all<SqlRow>(
    `WITH scored AS (
      SELECT *, CASE WHEN ${TEST_SQL} THEN 1 ELSE 0 END AS is_test_agent
      FROM (${SCORED_AGENT_SQL})
    )
     SELECT
      agent_id,
      login,
      display_name,
      level,
      agent_type,
      commission_rate,
      risk_score,
      commission_tier,
      player_count,
      child_count,
      last_refreshed
     FROM scored
     WHERE ${whereSql}
     ORDER BY risk_score DESC, level, login
     LIMIT 250`,
    params
  );
  return { agents: rows };
}
