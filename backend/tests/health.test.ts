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
    expect(body.operationalStatus).toBe('critical');
    expect(body.riskStatus).toBe('critical');
    expect(body.issues.some((issue: any) => issue.source === 'raw_api_logs')).toBe(true);
    expect(body.issues.some((issue: any) => issue.source === 'ActionQueue')).toBe(true);
    expect(body.issues.some((issue: any) => issue.source === 'book_health')).toBe(true);
  });

  test('groups repeated Player 360 Buckeye auth failures into one operator issue', async () => {
    const db = {
      all: async (sql: string) => {
        if (sql.includes('FROM player_source_status') && sql.includes('GROUP BY source_key')) {
          return [
            { source_key: 'player_transactions', agent_id: 'BILLY666', count: 12, last_seen: '2026-05-09T20:05:00Z', last_error: 'Not authenticated. Call login() first.' },
            { source_key: 'teaser_profile', agent_id: 'BILLY666', count: 9, last_seen: '2026-05-09T20:06:00Z', last_error: 'getTransactionList failed: 401 Unauthorized' },
            { source_key: 'customer_snapshots', agent_id: 'BILLY666', count: 1, last_seen: '2026-05-09T20:07:00Z', last_error: 'parse error' },
          ];
        }
        return [];
      },
      get: async (sql: string) => {
        if (sql.includes('FROM raw_api_logs')) return { total: 0, failures: 0, last_seen: null };
        if (sql.includes('FROM player_source_status')) return { total: 3, errors: 22, last_seen: '2026-05-09T20:07:00Z' };
        return null;
      },
    };
    const scraperManager = {
      getDatabase: () => db,
      getMetrics: () => ({
        activeAgents: 1,
        agents: [{ agentId: 'BILLY666', lastPoll: '2026-05-09T20:20:00Z', errorCount: 0, authenticated: true }],
        actionQueue: { totalQueued: 0, queues: {} },
        counters: { wagers_total: 100, alerts_triggered_total: 5, errors_total: 0 },
      }),
    } as any;

    const response = await registerHealthRoutes(
      new URL('http://localhost/api/health/system-status'),
      new Request('http://localhost/api/health/system-status'),
      scraperManager
    );
    const body = await response!.json();
    const authIssues = body.issues.filter((issue: any) => issue.title.includes('Buckeye auth'));

    expect(authIssues).toHaveLength(1);
    expect(authIssues[0].count).toBe(21);
    expect(authIssues[0].detail).toContain('player_transactions');
    expect(authIssues[0].detail).toContain('teaser_profile');
    expect(body.issues.some((issue: any) => issue.detail.includes('parse error'))).toBe(true);
  });

  test('includes cheap data-flow evidence for wagers, hierarchy, player maps, patterns, and exposure', async () => {
    const db = {
      all: async () => [],
      get: async (sql: string) => {
        if (sql.includes('FROM wagers') && sql.includes('MAX(scraped_at)') && sql.includes('COUNT(DISTINCT NULLIF(sport')) {
          return { wager_count: 25, sport_count: 4, agent_count: 6, total_amount: 12500, last_seen: '2026-05-09T20:20:00Z' };
        }
        if (sql.includes('FROM wagers') && sql.includes('MAX(insert_datetime)')) {
          return { row_count: 25, last_seen: '2026-05-09T20:20:00Z', last_event_at: '2026-05-09T20:19:00Z' };
        }
        if (sql.includes('FROM wager_archive')) {
          return { row_count: 25, distinct_wagers: 25, last_seen: '2026-05-09T20:21:00Z', last_event_at: '2026-05-09T20:19:00Z' };
        }
        if (sql.includes('FROM player_transactions')) {
          return { row_count: 10, last_seen: '2026-05-09T20:22:00Z', last_event_at: '2026-05-09T20:18:00Z' };
        }
        if (sql.includes('FROM agent_hierarchy')) {
          return { row_count: 2288, roots: 3, max_level: 17, last_seen: '2026-05-09T20:23:00Z' };
        }
        if (sql.includes('player_agent_rows')) {
          return {
            player_agent_rows: 56019,
            player_agent_last_seen: '2026-05-09T20:24:00Z',
            access_rows: 120,
            unique_ips: 42,
            access_last_seen: '2026-05-09T20:26:00Z',
            player_link_rows: 8,
            player_link_last_seen: '2026-05-09T20:27:00Z',
            pattern_agent_rows: 12,
            pattern_agent_last_seen: '2026-05-09T20:28:00Z',
          };
        }
        if (sql.includes('FROM player_agent_map')) {
          return { row_count: 56019, orphan_count: 0, last_seen: '2026-05-09T20:24:00Z' };
        }
        if (sql.includes('FROM detected_patterns')) {
          return { row_count: 99, last24h: 12, last_seen: '2026-05-09T20:25:00Z' };
        }
        if (sql.includes('FROM raw_api_logs')) return { total: 0, failures: 0, last_seen: null };
        if (sql.includes('FROM player_source_status')) return { total: 0, errors: 0, last_seen: null };
        return null;
      },
    };
    const scraperManager = {
      getDatabase: () => db,
      getMetrics: () => ({
        activeAgents: 1,
        agents: [{ agentId: 'BILLY666', lastPoll: '2026-05-09T20:20:00Z', errorCount: 0, authenticated: true }],
        actionQueue: { totalQueued: 0, queues: {} },
        counters: { wagers_total: 25, alerts_triggered_total: 0, errors_total: 0 },
      }),
    } as any;

    const response = await registerHealthRoutes(
      new URL('http://localhost/api/health/system-status'),
      new Request('http://localhost/api/health/system-status'),
      scraperManager
    );
    const body = await response!.json();

    expect(body.dataFlows.liveWagers.rowCount).toBe(25);
    expect(body.dataFlows.wagerArchive.reconciled).toBe(true);
    expect(body.dataFlows.agentHierarchy.roots).toBe(3);
    expect(body.dataFlows.agentHierarchy.maxLevel).toBe(17);
    expect(body.dataFlows.playerAgentMap.rowCount).toBe(56019);
    expect(body.dataFlows.playerAgentMap.orphanCount).toBe(0);
    expect(body.dataFlows.patterns.last24h).toBe(12);
    expect(body.dataFlows.exposureInputs.sportCount).toBe(4);
    expect(body.dataFlows.crossReferences.playerAgentRows).toBe(56019);
    expect(body.dataFlows.crossReferences.playerAgentLastSeen).toBe('2026-05-09T20:24:00Z');
    expect(body.dataFlows.crossReferences.uniqueIps).toBe(42);
    expect(body.dataFlows.crossReferences.accessLastSeen).toBe('2026-05-09T20:26:00Z');
    expect(body.dataFlows.crossReferences.patternAgentRows).toBe(12);
    expect(body.dataFlows.crossReferences.patternAgentLastSeen).toBe('2026-05-09T20:28:00Z');
    expect(body.status).toBe('ok');
  });
});
