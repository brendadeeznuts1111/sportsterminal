/**
 * Analytics Routes
 * Provides endpoints for audit analytics, performance metrics, and CSV export.
 */

import { ApiError, corsHeaders, handleAsync } from '../helpers';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export function registerAnalyticsRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  const db = scraperManager.getDatabase();

  // Analytics endpoints for the Performance tab
  if (url.pathname === '/api/analytics/raw-logs' && request.method === 'GET') {
    return handleAsync(async () => {
      const endpoint = url.searchParams.get('endpoint') || undefined;
      const agentId = url.searchParams.get('agentId') || undefined;
      const limit = clamp(url.searchParams.get('limit'), 50, 1, 500);
      const days = clamp(url.searchParams.get('days'), 7, 1, 90);
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
      params.push(limit);

      const logs = await db.all(
        `SELECT id, endpoint, fetched_at, agent_id, duration_ms, status_code
         FROM raw_api_logs
         WHERE ${where.join(' AND ')}
         ORDER BY fetched_at DESC
         LIMIT ?`,
        params
      );
      return { logs, count: logs.length, days, endpoint: endpoint || null, agentId: agentId || null };
    }, corsHeaders);
  }

  if (url.pathname === '/api/analytics/weekly-figures' && request.method === 'GET') {
    return handleAsync(async () => {
      const agentId = url.searchParams.get('agentId') || undefined;
      const week = url.searchParams.get('week') || undefined;
      const limit = clamp(url.searchParams.get('limit'), 20, 1, 500);
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
      const limit = clamp(url.searchParams.get('limit'), 20, 1, 500);
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
      const days = clamp(url.searchParams.get('days'), 14, 1, 90);
      const rows = await db.all(
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
      const hours = clamp(url.searchParams.get('hours'), 24, 1, 168);
      const rows = await db.all(
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
      const minutes = clamp(url.searchParams.get('minutes'), 30, 1, 240);
      const rows = await db.all(
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
        velocity: rows.map((row: any) => ({
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
      const rows = await db.all(
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
      for (const row of rows as any[]) {
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
      const limit = clamp(url.searchParams.get('limit'), 100, 1, 500);
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
        logs: logs.map((row: any) => ({
          ...row,
          first_seen: firstSeen[row.ip_address] || row.access_datetime,
          is_new_ip: firstSeen[row.ip_address] === row.access_datetime,
        })),
        count: logs.length,
      };
    }, corsHeaders);
  }

  if (url.pathname === '/api/master/history' && request.method === 'GET') {
    return handleAsync(async () => {
      const limit = clamp(url.searchParams.get('limit'), 100, 1, 500);
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
      const weeks = clamp(url.searchParams.get('weeks'), 8, 1, 52);

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

function clamp(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

async function csvExport(db: any, sql: string, params: unknown[], filename: string): Promise<Response> {
  try {
    const rows = await db.all(sql, params);
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

function toCsv(rows: any[]): string {
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

