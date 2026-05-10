/**
 * Health & metrics routes
 */
import { corsHeaders, handleAsync } from '../helpers';
import { logRequest, logWarn } from '../../utils/logger';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export function registerHealthRoutes(
  url: URL,
  _request: Request,
  scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  if (url.pathname === '/health') {
    logRequest('GET', '/health');
    return new Response(
      JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        scrapers: scraperManager.getMetrics(),
      }),
      { headers: corsHeaders }
    );
  }

  if (url.pathname === '/metrics') {
    logRequest('GET', '/metrics');
    return new Response(
      JSON.stringify(scraperManager.getMetrics()),
      { headers: corsHeaders }
    );
  }

  if (url.pathname === '/api/health/system-status') {
    logRequest('GET', '/api/health/system-status');
    return handleAsync(async () => buildSystemStatus(scraperManager), corsHeaders);
  }

  return null;
}

async function buildSystemStatus(scraperManager: BuckeyeScraperManager): Promise<any> {
  const db = scraperManager.getDatabase();
  const metrics = scraperManager.getMetrics();
  const issues: any[] = [];

  for (const agent of metrics.agents || []) {
    if (Number(agent.errorCount || 0) > 0) {
      issues.push({
        severity: Number(agent.errorCount) >= 3 ? 'critical' : 'warning',
        category: 'buckeye',
        title: `${agent.agentId} has scraper errors`,
        detail: `${agent.errorCount} consecutive poll error${Number(agent.errorCount) === 1 ? '' : 's'}.`,
        source: 'ScraperManager',
        count: Number(agent.errorCount),
        lastSeen: agent.lastPoll || null,
        action: 'Open Settings or vault status, refresh Cloudflare cookie/token, then watch /health.',
      });
    }
    if (agent.authenticated === false) {
      issues.push({
        severity: 'warning',
        category: 'buckeye',
        title: `${agent.agentId} is not authenticated`,
        detail: 'Agent instance exists but Buckeye API authentication is currently false.',
        source: 'ScraperManager',
        count: 1,
        lastSeen: agent.lastPoll || null,
        action: 'Reconnect the agent or restore credentials from the Buckeye vault.',
      });
    }
  }

  const totalQueued = Number(metrics.actionQueue?.totalQueued || 0);
  if (totalQueued > 0) {
    issues.push({
      severity: totalQueued > 10 ? 'critical' : 'warning',
      category: 'queue',
      title: 'Bet action queue has pending work',
      detail: `${totalQueued} queued action${totalQueued === 1 ? '' : 's'} across ${Object.keys(metrics.actionQueue?.queues || {}).length} agent queue${Object.keys(metrics.actionQueue?.queues || {}).length === 1 ? '' : 's'}.`,
      source: 'ActionQueue',
      count: totalQueued,
      lastSeen: new Date().toISOString(),
      action: 'Check the Action Queue panel for the affected agent and verify bet-action responses.',
    });
  }

  const rawApiFailures = await safeAll(db,
    `SELECT endpoint, agent_id, status_code, COUNT(*) AS count, MAX(fetched_at) AS last_seen
       FROM raw_api_logs
       WHERE fetched_at >= datetime('now', '-24 hours') AND status_code IS NOT NULL AND status_code >= 400
       GROUP BY endpoint, agent_id, status_code
       ORDER BY count DESC, last_seen DESC
       LIMIT 8`, []);
  for (const row of rawApiFailures) {
    const statusCode = Number(row.status_code || 0);
    const upstreamCategory = categorizeUpstreamFailure(statusCode);
    issues.push({
      severity: statusCode >= 500 ? 'critical' : 'warning',
      category: 'api',
      title: `${row.endpoint} returned ${row.status_code}`,
      detail: `${row.count} ${upstreamCategory} call${Number(row.count) === 1 ? '' : 's'} in the last 24 hours${row.agent_id ? ` for ${row.agent_id}` : ''}.`,
      source: 'raw_api_logs',
      count: Number(row.count || 0),
      lastSeen: row.last_seen || null,
      action: statusCode === 401 || statusCode === 403
        ? 'Refresh Buckeye credentials/Cloudflare cookie, then verify the agent returns to authenticated state.'
        : statusCode === 504
          ? 'Treat as upstream timeout: retry after backoff and inspect Raw API Archive if it persists.'
          : 'Open the Raw API Archive and inspect the redacted response body for the endpoint.',
    });
  }

  const playerSourceErrors = await safeAll(db,
    `SELECT source_key, agent_id, COUNT(*) AS count, MAX(updated_at) AS last_seen, MAX(last_error) AS last_error
       FROM player_source_status
       WHERE last_error IS NOT NULL AND updated_at >= datetime('now', '-24 hours')
       GROUP BY source_key, agent_id
       ORDER BY count DESC, last_seen DESC
       LIMIT 8`, []);
  const authBuckets = new Map<string, any>();
  for (const row of playerSourceErrors) {
    if (isBuckeyeAuthFailure(row.last_error)) {
      const key = row.agent_id || 'unknown-agent';
      const bucket = authBuckets.get(key) || {
        severity: 'warning',
        category: 'player360',
        title: `Player 360 probes paused by Buckeye auth for ${key}`,
        detail: '',
        source: 'player_source_status',
        count: 0,
        lastSeen: null,
        action: 'Refresh the Buckeye session/Cloudflare cookie once, then retry Player 360 probes; repeated per-player failures are grouped here.',
        sourceKeys: new Set<string>(),
      };
      bucket.count += Number(row.count || 0);
      bucket.lastSeen = latestTimestamp(bucket.lastSeen, row.last_seen);
      bucket.sourceKeys.add(row.source_key || 'unknown_source');
      authBuckets.set(key, bucket);
      continue;
    }
    issues.push({
      severity: Number(row.count) >= 5 ? 'critical' : 'warning',
      category: 'player360',
      title: `${row.source_key} refresh errors`,
      detail: `${row.count} player source error${Number(row.count) === 1 ? '' : 's'}${row.agent_id ? ` under ${row.agent_id}` : ''}: ${row.last_error || 'unknown error'}`,
      source: 'player_source_status',
      count: Number(row.count || 0),
      lastSeen: row.last_seen || null,
      action: 'Open the Player 360 Status tab for an affected player and check source freshness.',
    });
  }
  for (const bucket of authBuckets.values()) {
    const sourceKeys = [...bucket.sourceKeys].sort();
    delete bucket.sourceKeys;
    bucket.detail = `${bucket.count} source refresh error${bucket.count === 1 ? '' : 's'} were caused by an expired or missing Buckeye session across ${sourceKeys.join(', ')}.`;
    if (bucket.count >= 20) bucket.severity = 'critical';
    issues.push(bucket);
  }

  const offlineBooks = await safeAll(db,
    `SELECT book, status, error_count, last_error, last_seen
       FROM book_health
       WHERE status IS NOT NULL AND status != 'online'
       ORDER BY error_count DESC, last_seen DESC
       LIMIT 8`, []);
  for (const row of offlineBooks) {
    issues.push({
      severity: row.status === 'offline' ? 'critical' : 'warning',
      category: 'odds',
      title: `${row.book} book is ${row.status}`,
      detail: row.last_error || `${row.book} last reported ${row.status}.`,
      source: 'book_health',
      count: Number(row.error_count || 0),
      lastSeen: row.last_seen || null,
      action: 'Check odds provider credentials/connectivity and the Trading Floor book health chips.',
    });
  }

  const criticalPatterns = await safeAll(db,
    `SELECT type, severity, COUNT(*) AS count, MAX(detected_at) AS last_seen
       FROM detected_patterns
       WHERE detected_at >= datetime('now', '-24 hours') AND severity IN ('critical', 'high')
       GROUP BY type, severity
       ORDER BY count DESC, last_seen DESC
       LIMIT 8`, []);
  for (const row of criticalPatterns) {
    issues.push({
      severity: row.severity === 'critical' ? 'critical' : 'warning',
      category: 'patterns',
      title: `${row.type || 'Pattern'} ${row.severity}`,
      detail: `${row.count} detection${Number(row.count) === 1 ? '' : 's'} in the last 24 hours.`,
      source: 'detected_patterns',
      count: Number(row.count || 0),
      lastSeen: row.last_seen || null,
      action: 'Open the Patterns tab and review evidence for the latest detections.',
    });
  }

  const recentRawApi = await safeGet(db,
    `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status_code IS NOT NULL AND status_code >= 400 THEN 1 ELSE 0 END) AS failures,
              MAX(fetched_at) AS last_seen
       FROM raw_api_logs
       WHERE fetched_at >= datetime('now', '-24 hours')`, []);
  const playerSourceSummary = await safeGet(db,
    `SELECT COUNT(*) AS total,
              SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
              MAX(updated_at) AS last_seen
       FROM player_source_status`, []);
  const dataFlows = await buildDataFlowSummary(db);

  addDataFlowIssues(issues, dataFlows, Number(metrics.activeAgents || 0));

  issues.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || Number(b.count || 0) - Number(a.count || 0));
  const critical = issues.filter((issue) => issue.severity === 'critical').length;
  const warning = issues.filter((issue) => issue.severity === 'warning').length;
  const operationalIssues = issues.filter((issue) => issue.category !== 'patterns');
  const operationalCritical = operationalIssues.filter((issue) => issue.severity === 'critical').length;
  const operationalWarning = operationalIssues.filter((issue) => issue.severity === 'warning').length;
  const riskIssues = issues.filter((issue) => issue.category === 'patterns');
  const riskCritical = riskIssues.filter((issue) => issue.severity === 'critical').length;
  const riskWarning = riskIssues.filter((issue) => issue.severity === 'warning').length;

  return {
    status: critical > 0 ? 'critical' : warning > 0 ? 'warning' : 'ok',
    operationalStatus: operationalCritical > 0 ? 'critical' : operationalWarning > 0 ? 'warning' : 'ok',
    riskStatus: riskCritical > 0 ? 'critical' : riskWarning > 0 ? 'warning' : 'ok',
    generatedAt: new Date().toISOString(),
    summary: {
      activeAgents: metrics.activeAgents || 0,
      scraperErrors: metrics.counters?.errors_total || 0,
      actionQueue: totalQueued,
      rawApiFailures24h: Number(recentRawApi?.failures || 0),
      rawApiCalls24h: Number(recentRawApi?.total || 0),
      playerSourceErrors: Number(playerSourceSummary?.errors || 0),
      playerSourcesTracked: Number(playerSourceSummary?.total || 0),
      issues: issues.length,
      critical,
      warning,
      operationalCritical,
      operationalWarning,
      riskCritical,
      riskWarning,
    },
    dataFlows,
    issues: issues.slice(0, 25),
    metrics,
    rawApi: {
      lastSeen: recentRawApi?.last_seen || null,
    },
    playerSources: {
      lastSeen: playerSourceSummary?.last_seen || null,
    },
  };
}

async function safeAll(db: any, sql: string, params: unknown[] = []): Promise<any[]> {
  if (!sql) return [];
  try {
    return await db.all(sql, params);
  } catch (err: any) {
    logWarn('safeAll query failed', { sql: sql?.slice(0, 120), error: err?.message });
    return [];
  }
}

async function safeGet(db: any, sql: string, params: unknown[] = []): Promise<any | null> {
  if (!sql) return null;
  try {
    return await db.get(sql, params);
  } catch (err: any) {
    logWarn('safeGet query failed', { sql: sql?.slice(0, 120), error: err?.message });
    return null;
  }
}

function severityRank(severity: string): number {
  if (severity === 'critical') return 3;
  if (severity === 'warning') return 2;
  return 1;
}

function isBuckeyeAuthFailure(error: unknown): boolean {
  const text = String(error || '').toLowerCase();
  return text.includes('not authenticated')
    || text.includes('401 unauthorized')
    || text.includes('403 forbidden')
    || text.includes('authorization required')
    || text.includes('cloudflare');
}

function categorizeUpstreamFailure(statusCode: number): string {
  if (statusCode === 401 || statusCode === 403) return 'Buckeye auth/session failure';
  if (statusCode === 504) return 'upstream timeout';
  if (statusCode >= 500) return 'upstream/server failure';
  return 'failed';
}

function latestTimestamp(current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return String(candidate) > String(current) ? candidate : current;
}

async function buildDataFlowSummary(db: any): Promise<any> {
  const [
    liveWagers,
    wagerArchive,
    playerTransactions,
    hierarchy,
    playerAgentMap,
    patterns,
    exposure,
  ] = await Promise.all([
    safeGet(db,
      `SELECT COUNT(*) AS row_count, MAX(scraped_at) AS last_seen, MAX(insert_datetime) AS last_event_at
       FROM wagers`, []),
    safeGet(db,
      `SELECT COUNT(*) AS row_count,
              COUNT(DISTINCT wager_number) AS distinct_wagers,
              MAX(ingested_at) AS last_seen,
              MAX(insert_date_time) AS last_event_at
       FROM wager_archive`, []),
    safeGet(db,
      `SELECT COUNT(*) AS row_count, MAX(pulled_at) AS last_seen, MAX(transaction_time) AS last_event_at
       FROM player_transactions`, []),
    safeGet(db,
      `SELECT COUNT(*) AS row_count,
              SUM(CASE WHEN COALESCE(parent_agent_id, '') = '' THEN 1 ELSE 0 END) AS roots,
              MAX(level) AS max_level,
              MAX(last_refreshed) AS last_seen
       FROM agent_hierarchy`, []),
    safeGet(db,
      `SELECT COUNT(*) AS row_count,
              SUM(CASE WHEN ah.agent_id IS NULL THEN 1 ELSE 0 END) AS orphan_count,
              MAX(pam.last_refreshed) AS last_seen
       FROM player_agent_map pam
       LEFT JOIN agent_hierarchy ah ON ah.agent_id = pam.agent_id AND ah.provider = pam.provider`, []),
    safeGet(db,
      `SELECT COUNT(*) AS row_count,
              SUM(CASE WHEN detected_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS last24h,
              MAX(detected_at) AS last_seen
       FROM detected_patterns`, []),
    safeGet(db,
      `SELECT COUNT(*) AS wager_count,
              COUNT(DISTINCT NULLIF(sport, '')) AS sport_count,
              COUNT(DISTINCT NULLIF(agent_login, '')) AS agent_count,
              SUM(amount_wagered) AS total_amount,
              MAX(scraped_at) AS last_seen
       FROM wagers`, []),
  ]);

  return {
    liveWagers: flow('liveWagers', liveWagers?.row_count, liveWagers?.last_seen, {
      lastEventAt: liveWagers?.last_event_at || null,
    }),
    wagerArchive: flow('wagerArchive', wagerArchive?.row_count, wagerArchive?.last_seen, {
      distinctWagers: Number(wagerArchive?.distinct_wagers || 0),
      lastEventAt: wagerArchive?.last_event_at || null,
      reconciled: Number(wagerArchive?.row_count || 0) === Number(wagerArchive?.distinct_wagers || 0),
    }),
    playerTransactions: flow('playerTransactions', playerTransactions?.row_count, playerTransactions?.last_seen, {
      lastEventAt: playerTransactions?.last_event_at || null,
    }),
    agentHierarchy: flow('agentHierarchy', hierarchy?.row_count, hierarchy?.last_seen, {
      roots: Number(hierarchy?.roots || 0),
      maxLevel: Number(hierarchy?.max_level || 0),
    }),
    playerAgentMap: flow('playerAgentMap', playerAgentMap?.row_count, playerAgentMap?.last_seen, {
      orphanCount: Number(playerAgentMap?.orphan_count || 0),
    }),
    patterns: flow('patterns', patterns?.row_count, patterns?.last_seen, {
      last24h: Number(patterns?.last24h || 0),
    }),
    exposureInputs: flow('exposureInputs', exposure?.wager_count, exposure?.last_seen, {
      sportCount: Number(exposure?.sport_count || 0),
      agentCount: Number(exposure?.agent_count || 0),
      totalAmount: Number(exposure?.total_amount || 0),
    }),
  };
}

function flow(name: string, count: unknown, lastSeen: unknown, extra: Record<string, unknown> = {}): any {
  const rowCount = Number(count || 0);
  return {
    name,
    status: rowCount > 0 ? 'live' : 'empty',
    rowCount,
    lastSeen: lastSeen || null,
    ...extra,
  };
}

function addDataFlowIssues(issues: any[], dataFlows: any, activeAgents: number): void {
  if (activeAgents > 0 && dataFlows.liveWagers.rowCount === 0) {
    issues.push(dataFlowIssue('critical', 'Live wager table is empty', 'Active agents are present, but the live wagers table has no rows.', dataFlows.liveWagers));
  }
  if (dataFlows.wagerArchive.rowCount > 0 && !dataFlows.wagerArchive.reconciled) {
    issues.push(dataFlowIssue('warning', 'Wager archive has duplicate wager numbers', 'Archive row count does not match distinct wager numbers.', dataFlows.wagerArchive));
  }
  if (dataFlows.agentHierarchy.rowCount > 0 && (dataFlows.agentHierarchy.roots !== 3 || dataFlows.agentHierarchy.maxLevel !== 17)) {
    issues.push(dataFlowIssue('warning', 'Agent hierarchy shape changed', `Expected 3 roots and max level 17; saw ${dataFlows.agentHierarchy.roots} roots and max level ${dataFlows.agentHierarchy.maxLevel}.`, dataFlows.agentHierarchy));
  }
  if (dataFlows.playerAgentMap.orphanCount > 0) {
    issues.push(dataFlowIssue('critical', 'Player-agent map has orphan rows', `${dataFlows.playerAgentMap.orphanCount} mapping row(s) reference a missing agent.`, dataFlows.playerAgentMap));
  }
  if (activeAgents > 0 && dataFlows.exposureInputs.rowCount === 0) {
    issues.push(dataFlowIssue('warning', 'Exposure inputs are empty', 'Positions and exposure need live wager rows before they can render meaningful totals.', dataFlows.exposureInputs));
  }
}

function dataFlowIssue(severity: string, title: string, detail: string, flowSummary: any): any {
  return {
    severity,
    category: 'data-flow',
    title,
    detail,
    source: flowSummary.name,
    count: Number(flowSummary.rowCount || flowSummary.orphanCount || 0),
    lastSeen: flowSummary.lastSeen || null,
    action: 'Run bun run integrity:check, then compare the affected API endpoint with the data flow summary.',
  };
}
