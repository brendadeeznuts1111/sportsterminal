/**
 * Analytics Routes
 * Provides endpoints for audit analytics, performance metrics, and CSV export.
 */

import { ApiError, clampInt, corsHeaders, handleAsync, requireAdminTokenIfConfigured } from '../helpers';
import { logDebug } from '../../utils/logger';
import { IPTracker } from '../../services/IPTracker';
import { deleteRule, listRules, upsertRule, type RuleInput } from '../../services/RulesEngine';
import type { Database } from '../../database';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

type SqlRow = Record<string, unknown>;

interface RawApiLogRow extends SqlRow {
  request_params?: string | null;
}

interface VelocityRow {
  bucket: string;
  wagerCount: number;
  totalHandle: number;
}

interface LivePreRow {
  bucket: string;
  count: number;
  volume: number;
}

interface AccessLogRow extends SqlRow {
  ip_address: string;
  access_datetime: string;
}

export function registerAnalyticsRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  const db = scraperManager.getDatabase();

  // Health check for data pipeline
  if (url.pathname === '/api/health/data-pipeline' && request.method === 'GET') {
    return handleAsync(async () => {
      const rawLogs = await db.get<{ count: number; lastAt: string | null }>(
        `SELECT COUNT(*) as count, MAX(fetched_at) as lastAt FROM raw_api_logs WHERE endpoint = 'getBetTicker'`,
        []
      );
      const weeklyCount = await db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM weekly_figures`,
        []
      );
      const masterCount = await db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM master_snapshots`,
        []
      );
      const wagersWithRaw = await db.get<{ count: number; total: number }>(
        `SELECT COUNT(*) as total, COUNT(raw_json) as count FROM wagers`,
        []
      );
      const perfCount = await db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM agent_performance_snapshots`,
        []
      );
      const accessCount = await db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM access_logs`,
        []
      );
      const activeAgents = scraperManager.getAgentIds();
      return {
        pipeline: {
          rawApiLogs: { getBetTickerCount: rawLogs?.count || 0, lastFetchedAt: rawLogs?.lastAt || null },
          weeklyFigures: { count: weeklyCount?.count || 0 },
          masterSnapshots: { count: masterCount?.count || 0 },
          wagers: { total: wagersWithRaw?.total || 0, withRawJson: wagersWithRaw?.count || 0 },
          agentPerformance: { count: perfCount?.count || 0 },
          accessLogs: { count: accessCount?.count || 0 },
        },
        agents: {
          active: activeAgents,
          count: activeAgents.length,
        },
        timestamp: new Date().toISOString(),
      };
    }, corsHeaders);
  }

  // Analytics endpoints for the Performance tab
  if (url.pathname === '/api/analytics/raw-logs' && request.method === 'GET') {
    return handleAsync(async () => {
      const endpoint = url.searchParams.get('endpoint') || undefined;
      const agentId = url.searchParams.get('agentId') || undefined;
      const status = url.searchParams.get('status') || undefined;
      const includeBody = url.searchParams.get('includeBody') === '1';
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
      const days = clampInt(url.searchParams.get('days'), 7, 1, 90);
      const where: string[] = [`fetched_at >= datetime('now', '-' || ? || ' days')`];
      const params: unknown[] = [days];

      if (endpoint) {
        where.push('endpoint = ?');
        params.push(endpoint);
      }
      if (agentId) {
        where.push('agent_id = ?');
        params.push(agentId);
      }
      if (status) {
        if (/^\d+$/.test(status)) {
          where.push('status_code = ?');
          params.push(Number(status));
        } else if (status === 'success') {
          where.push('(status_code IS NULL OR (status_code >= 200 AND status_code < 400))');
        } else if (status === 'warning') {
          where.push('status_code >= 400 AND status_code < 500');
        } else if (status === 'error') {
          where.push('status_code >= 500');
        }
      }
      params.push(limit);

      const logs = await db.all<RawApiLogRow>(
        `SELECT id, endpoint, fetched_at, agent_id, duration_ms, status_code, request_params${includeBody ? ', response_json' : ''}
         FROM raw_api_logs
         WHERE ${where.join(' AND ')}
         ORDER BY fetched_at DESC
         LIMIT ?`,
        params
      );
      return {
        logs: logs.map((row) => ({
          ...row,
          request_params_summary: summarizeParams(row.request_params),
        })),
        count: logs.length,
        days,
        endpoint: endpoint || null,
        agentId: agentId || null,
        status: status || null,
        includeBody,
      };
    }, corsHeaders);
  }

  if (url.pathname === '/api/analytics/weekly-figures' && request.method === 'GET') {
    return handleAsync(async () => {
      const agentId = url.searchParams.get('agentId') || undefined;
      const week = url.searchParams.get('week') || undefined;
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 500);
      const where: string[] = [];
      const params: unknown[] = [];

      if (agentId) {
        where.push('agent_id = ?');
        params.push(agentId);
      }
      if (week) {
        where.push('week = ?');
        params.push(Number(week));
      }
      params.push(limit);

      const figures = await db.all(
        `SELECT id, agent_id, week, type, layout, this_week, active, today, info, pulled_at
         FROM weekly_figures
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY pulled_at DESC
         LIMIT ?`,
        params
      );
      return { figures, count: figures.length, agentId: agentId || null, week: week || null };
    }, corsHeaders);
  }

  if (url.pathname === '/api/analytics/master-snapshots' && request.method === 'GET') {
    return handleAsync(async () => {
      const agentId = url.searchParams.get('agentId') || undefined;
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 500);
      const where: string[] = [];
      const params: unknown[] = [];

      if (agentId) {
        where.push('agent_id = ?');
        params.push(agentId);
      }
      params.push(limit);

      const snapshots = await db.all(
        `SELECT id, provider, agent_id, timestamp, balance, available_balance, percent_book, open_wager_count
         FROM master_snapshots
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY timestamp DESC
         LIMIT ?`,
        params
      );
      return { snapshots, count: snapshots.length, agentId: agentId || null };
    }, corsHeaders);
  }

  if (url.pathname === '/api/analytics/performance-trends' && request.method === 'GET') {
    return handleAsync(async () => {
      const days = clampInt(url.searchParams.get('days'), 14, 1, 90);
      const rows = await db.all<VelocityRow>(
        `SELECT
          date(pulled_at) AS day,
          report_agent_id AS agent_id,
          SUM(COALESCE(volume, 0)) AS daily_volume,
          SUM(COALESCE(net, 0)) AS daily_net,
          SUM(COALESCE(wager_count, 0)) AS daily_wager_count
         FROM agent_performance_snapshots
         WHERE pulled_at >= date('now', '-' || ? || ' days')
         GROUP BY day, report_agent_id
         ORDER BY day DESC`,
        [days]
      );
      return { days, trends: rows };
    }, corsHeaders);
  }

  if (url.pathname === '/api/analytics/wager-velocity' && request.method === 'GET') {
    return handleAsync(async () => {
      const hours = clampInt(url.searchParams.get('hours'), 24, 1, 168);
      const rows = await db.all<SqlRow>(
        `SELECT
          strftime('%Y-%m-%d %H:00', insert_datetime) AS hour,
          COUNT(*) AS wager_count,
          SUM(COALESCE(amount_wagered, 0)) AS total_volume
         FROM wagers
         WHERE insert_datetime >= datetime('now', '-' || ? || ' hours')
         GROUP BY hour
         ORDER BY hour ASC`,
        [hours]
      );
      return { hours, velocity: rows };
    }, corsHeaders);
  }

  if (url.pathname === '/api/betting/velocity' && request.method === 'GET') {
    return handleAsync(async () => {
      const minutes = clampInt(url.searchParams.get('minutes'), 30, 1, 240);
      const rows = await db.all<VelocityRow>(
        `SELECT
          substr(replace(insert_date_time, 'T', ' '), 1, 16) AS bucket,
          COUNT(*) AS wagerCount,
          SUM(COALESCE(amount_wagered, 0)) AS totalHandle
         FROM wager_archive
         WHERE insert_date_time >= datetime('now', '-' || ? || ' minutes')
         GROUP BY bucket
         ORDER BY bucket ASC`,
        [minutes]
      );

      return {
        minutes,
        velocity: rows.map((row) => ({
          timestamp: row.bucket,
          wagerCount: Number(row.wagerCount || 0),
          totalHandle: Number(row.totalHandle || 0),
        })),
      };
    }, corsHeaders);
  }

  if (url.pathname === '/api/betting/live-vs-pre' && request.method === 'GET') {
    return handleAsync(async () => {
      const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      const rows = await db.all<LivePreRow>(
        `SELECT
          CASE WHEN ticket_writer = 'GSLIVE' THEN 'live' ELSE 'pregame' END AS bucket,
          COUNT(*) AS count,
          SUM(COALESCE(amount_wagered, 0)) AS volume
         FROM wager_archive
         WHERE substr(insert_date_time, 1, 10) = ?
         GROUP BY bucket`,
        [date]
      );
      const summary = {
        date,
        live: { count: 0, volume: 0 },
        pregame: { count: 0, volume: 0 },
      };
      for (const row of rows) {
        const bucket = row.bucket === 'live' ? 'live' : 'pregame';
        summary[bucket] = {
          count: Number(row.count || 0),
          volume: Number(row.volume || 0),
        };
      }
      return summary;
    }, corsHeaders);
  }

  if (url.pathname === '/api/logs/access' && request.method === 'GET') {
    return handleAsync(async () => {
      const agentId = url.searchParams.get('agent') || undefined;
      const ip = url.searchParams.get('ip') || undefined;
      const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
      const where: string[] = [];
      const params: unknown[] = [];

      if (agentId) {
        where.push('agent_id = ?');
        params.push(agentId);
      }
      if (ip) {
        where.push('ip_address = ?');
        params.push(ip);
      }

      params.push(limit);
      const logs = await db.all(
        `SELECT *
         FROM access_logs
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY access_datetime DESC
         LIMIT ?`,
        params
      );

      const firstSeenRows = await db.all<{ ip_address: string; first_seen: string }>(
        `SELECT ip_address, MIN(access_datetime) AS first_seen
         FROM access_logs
         WHERE ip_address IS NOT NULL AND ip_address <> ''
         GROUP BY ip_address`
      );
      const firstSeen = Object.fromEntries(firstSeenRows.map((row) => [row.ip_address, row.first_seen]));

      return {
        logs: (logs as AccessLogRow[]).map((row) => ({
          ...row,
          first_seen: firstSeen[row.ip_address] || row.access_datetime,
          is_new_ip: firstSeen[row.ip_address] === row.access_datetime,
        })),
        count: logs.length,
      };
    }, corsHeaders);
  }

  if (url.pathname === '/api/agent/ip-suspicious' && request.method === 'GET') {
    return handleAsync(async () => {
      const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100);
      return new IPTracker(db, scraperManager).getSuspiciousIPs(limit);
    }, corsHeaders);
  }

  if (url.pathname === '/api/agent/ip-lookup' && request.method === 'GET') {
    return handleAsync(async () => {
      const tracker = new IPTracker(db, scraperManager);
      const ip = (url.searchParams.get('ip') || '').trim();
      const player = (url.searchParams.get('player') || url.searchParams.get('playerId') || '').trim();
      const agentId = (url.searchParams.get('agentId') || '').trim() || undefined;
      const live = url.searchParams.get('live') !== '0';
      const start = url.searchParams.get('start') || undefined;
      const end = url.searchParams.get('end') || undefined;
      const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);

      if (ip) {
        return tracker.getAccountsByIP(ip, { agentId, start, end, live, limit });
      }
      if (player) {
        return tracker.getIPsForPlayer(player, { agentId, start, end, live, limit });
      }
      throw new ApiError(400, 'ip or player parameter is required');
    }, corsHeaders);
  }

  if (url.pathname === '/api/agent/ip-block' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const tracker = new IPTracker(db, scraperManager);
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const ip = String(body.ip || '').trim();
      const reason = String(body.reason || 'Operator block').trim();
      if (!ip) throw new ApiError(400, 'ip is required');
      await tracker.blockIP(ip, reason);
      return { success: true, ip, reason };
    }, corsHeaders);
  }

  if (url.pathname === '/api/agent/ip-export' && request.method === 'GET') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleIpExport(db, scraperManager, url);
  }

  if (url.pathname === '/api/agent/rules' && request.method === 'GET') {
    return handleAsync(async () => ({ rules: await listRules(db) }), corsHeaders);
  }

  if (url.pathname === '/api/agent/rules' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      return { success: true, ...(await upsertRule(db, body as unknown as RuleInput)) };
    }, corsHeaders);
  }

  if (/^\/api\/agent\/rules\/\d+$/.test(url.pathname) && request.method === 'DELETE') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const id = Number(url.pathname.split('/').pop());
      return { success: await deleteRule(db, id), id };
    }, corsHeaders);
  }

  if (url.pathname === '/api/master/history' && request.method === 'GET') {
    return handleAsync(async () => {
      const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
      const snapshots = await db.all(
        `SELECT *
         FROM master_snapshots
         ORDER BY timestamp DESC
         LIMIT ?`,
        [limit]
      );
      return { snapshots, count: snapshots.length };
    }, corsHeaders);
  }

  if (url.pathname === '/api/performance/summary' && request.method === 'GET') {
    return handleAsync(async () => {
      const week = url.searchParams.get('week') || undefined;
      const params: unknown[] = [];
      let where = '';
      if (week) {
        where = 'WHERE week_start_date = ?';
        params.push(week);
      }

      const summary = await db.all(
        `SELECT
          agent_id,
          COUNT(*) AS row_count,
          SUM(COALESCE(handle, 0)) AS handle,
          SUM(COALESCE(win_loss, 0)) AS win_loss,
          MAX(ingested_at) AS last_ingested_at
         FROM weekly_figures
         ${where}
         GROUP BY agent_id
         ORDER BY handle DESC`,
        params
      );

      return { week: week || null, summary, count: summary.length };
    }, corsHeaders);
  }

  if (url.pathname === '/api/performance/details' && request.method === 'GET') {
    return handleAsync(async () => {
      const agentId = url.searchParams.get('agent');
      if (!agentId) throw new ApiError(400, 'agent parameter is required');
      const weeks = clampInt(url.searchParams.get('weeks'), 8, 1, 52);

      const weeklyTrend = await db.all(
        `SELECT week_start_date, sport, handle, win_loss, wager_type, ingested_at
         FROM weekly_figures
         WHERE agent_id = ?
         ORDER BY week_start_date DESC
         LIMIT ?`,
        [agentId, weeks]
      );

      const sportBreakdown = await db.all(
        `SELECT
          COALESCE(sport, 'Unknown') AS sport,
          COUNT(*) AS rows,
          SUM(COALESCE(handle, 0)) AS handle,
          SUM(COALESCE(win_loss, 0)) AS win_loss
         FROM weekly_figures
         WHERE agent_id = ?
         GROUP BY sport
         ORDER BY handle DESC`,
        [agentId]
      );

      const latestRaw = await db.get(
        `SELECT recorded_at, performance_json
         FROM agent_performance
         WHERE agent_id = ?
         ORDER BY recorded_at DESC
         LIMIT 1`,
        [agentId]
      );

      return { agentId, weeks, weeklyTrend, sportBreakdown, latestRaw };
    }, corsHeaders);
  }

  if (url.pathname === '/api/export/wagers' && request.method === 'GET') {
    return csvExport(
      db,
      `SELECT *
       FROM wager_archive
       ORDER BY insert_date_time DESC`,
      [],
      'wagers.csv'
    );
  }

  if (url.pathname === '/api/export/access-logs' && request.method === 'GET') {
    return csvExport(
      db,
      `SELECT *
       FROM access_logs
       ORDER BY access_datetime DESC`,
      [],
      'access_logs.csv'
    );
  }

  if (url.pathname === '/api/export/performance' && request.method === 'GET') {
    return csvExport(
      db,
      `SELECT *
       FROM weekly_figures
       ORDER BY week_start_date DESC`,
      [],
      'performance.csv'
    );
  }

  return null;
}

async function handleIpExport(
  db: Database,
  scraperManager: BuckeyeScraperManager,
  url: URL
): Promise<Response> {
  try {
    const format = (url.searchParams.get('format') || 'json').toLowerCase();
    const rows = await new IPTracker(db, scraperManager).getExportData();
    if (format === 'csv') {
      return new Response(toCsv(rows), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="ip_intelligence_export.csv"',
        },
      });
    }

    return new Response(JSON.stringify({
      data: rows,
      count: rows.length,
      generatedAt: new Date().toISOString(),
    }), { headers: corsHeaders });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'IP export failed' }),
      { status: 500, headers: corsHeaders }
    );
  }
}

function summarizeParams(value: unknown): string {
  if (!value) return '';
  const text = String(value);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed)
        .slice(0, 8)
        .map(([key, child]) => `${key}=${child === null || child === undefined ? '' : String(child)}`)
        .join(' · ');
    }
  } catch (err) {
    logDebug('Analytics param parse: JSON failed, trying URLSearchParams', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const params = new URLSearchParams(text);
    return Array.from(params.entries())
      .slice(0, 8)
      .map(([key, child]) => `${key}=${child}`)
      .join(' · ');
  } catch (err) {
    logDebug('Analytics param parse: URLSearchParams failed, falling back to slice', {
      error: err instanceof Error ? err.message : String(err),
    });
    return text.slice(0, 160);
  }
}

async function csvExport(db: Database, sql: string, params: unknown[], filename: string): Promise<Response> {
  try {
    const rows = await db.all<SqlRow>(sql, params);
    const csv = toCsv(rows);
    return new Response(csv, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Export failed' }),
      { status: 500, headers: corsHeaders }
    );
  }
}

function toCsv(rows: SqlRow[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ].join('\n');
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const source = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const text = source.replace(/"/g, '""');
  return /[",\r\n]/.test(text) ? `"${text}"` : text;
}
