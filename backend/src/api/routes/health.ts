/**
 * Health & metrics routes
 */
import { corsHeaders, handleAsync } from '../helpers';
import { logRequest } from '../../utils/logger';
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
    issues.push({
      severity: Number(row.status_code) >= 500 ? 'critical' : 'warning',
      category: 'api',
      title: `${row.endpoint} returned ${row.status_code}`,
      detail: `${row.count} failed call${Number(row.count) === 1 ? '' : 's'} in the last 24 hours${row.agent_id ? ` for ${row.agent_id}` : ''}.`,
      source: 'raw_api_logs',
      count: Number(row.count || 0),
      lastSeen: row.last_seen || null,
      action: 'Open the Raw API Archive and inspect the redacted response body for the endpoint.',
    });
  }

  const playerSourceErrors = await safeAll(db,
    `SELECT source_key, agent_id, COUNT(*) AS count, MAX(updated_at) AS last_seen, MAX(last_error) AS last_error
       FROM player_source_status
       WHERE last_error IS NOT NULL AND updated_at >= datetime('now', '-24 hours')
       GROUP BY source_key, agent_id
       ORDER BY count DESC, last_seen DESC
       LIMIT 8`, []);
  for (const row of playerSourceErrors) {
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

  issues.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || Number(b.count || 0) - Number(a.count || 0));
  const critical = issues.filter((issue) => issue.severity === 'critical').length;
  const warning = issues.filter((issue) => issue.severity === 'warning').length;

  return {
    status: critical > 0 ? 'critical' : warning > 0 ? 'warning' : 'ok',
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
    },
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
  } catch {
    return [];
  }
}

async function safeGet(db: any, sql: string, params: unknown[] = []): Promise<any | null> {
  if (!sql) return null;
  try {
    return await db.get(sql, params);
  } catch {
    return null;
  }
}

function severityRank(severity: string): number {
  if (severity === 'critical') return 3;
  if (severity === 'warning') return 2;
  return 1;
}
