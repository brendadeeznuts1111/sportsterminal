import { describe, expect, test } from 'bun:test';

import { registerHealthRoutes } from '../src/api/routes/health';

describe('system status health route', () => {
  test('rolls up scraper, raw API, player source, book, pattern, and queue issues', async () => {
    const db = {
      all: async (sql: string) => {
        if (sql.includes('FROM raw_api_logs') && sql.includes('GROUP BY endpoint')) {
          return [{ endpoint: 'getBetTicker', agent_id: 'BILLY666', status_code: 500, count: 2, last_seen: '2026-05-09T20:00:00Z' }];
        }
        if (sql.includes('FROM player_source_status') && sql.includes('GROUP BY source_key')) {
          return [{ source_key: 'player_transactions', agent_id: 'BILLY666', count: 3, last_seen: '2026-05-09T20:05:00Z', last_error: 'timeout' }];
        }
        if (sql.includes('FROM book_health')) {
          return [{ book: 'Pinnacle', status: 'offline', error_count: 4, last_error: 'provider timeout', last_seen: '2026-05-09T20:10:00Z' }];
        }
        if (sql.includes('FROM detected_patterns')) {
          return [{ type: 'agent_swarm', severity: 'critical', count: 1, last_seen: '2026-05-09T20:15:00Z' }];
        }
        return [];
      },
      get: async (sql: string) => {
        if (sql.includes('FROM raw_api_logs')) return { total: 10, failures: 2, last_seen: '2026-05-09T20:00:00Z' };
        if (sql.includes('FROM player_source_status')) return { total: 12, errors: 3, last_seen: '2026-05-09T20:05:00Z' };
        return null;
      },
    };
    const scraperManager = {
      getDatabase: () => db,
      getMetrics: () => ({
        activeAgents: 1,
        agents: [{ agentId: 'BILLY666', lastPoll: '2026-05-09T20:20:00Z', errorCount: 2, authenticated: false }],
        actionQueue: { totalQueued: 2, queues: { BILLY666: 2 } },
        counters: { wagers_total: 100, alerts_triggered_total: 5, errors_total: 2 },
      }),
    } as any;

    const response = await registerHealthRoutes(
      new URL('http://localhost/api/health/system-status'),
      new Request('http://localhost/api/health/system-status'),
      scraperManager
    );

    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.status).toBe('critical');
    expect(body.summary.rawApiFailures24h).toBe(2);
    expect(body.summary.playerSourceErrors).toBe(3);
    expect(body.issues.some((issue: any) => issue.source === 'raw_api_logs')).toBe(true);
    expect(body.issues.some((issue: any) => issue.source === 'ActionQueue')).toBe(true);
    expect(body.issues.some((issue: any) => issue.source === 'book_health')).toBe(true);
  });
});
