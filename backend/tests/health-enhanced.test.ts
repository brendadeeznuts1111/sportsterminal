import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ApiError, corsHeaders, handleAsync, requireAdminTokenIfConfigured } from '../src/api/helpers';
import { getPatternRiskRollup, registerHealthRoutes } from '../src/api/routes/health';
import type { Database } from '../src/database';
import { checkEnhancedProxyHealth } from '../src/lib/proxyHealth';
import type { BuckeyeScraperManager } from '../src/scrapers/ScraperManager';

function testScraperManager(db: object): BuckeyeScraperManager {
  return {
    getDatabase: () => db as Database,
    getMetrics: () => ({
      activeAgents: 1,
      agents: [{ agentId: 'BILLY666', lastPoll: new Date().toISOString(), errorCount: 0, authenticated: true }],
      actionQueue: { totalQueued: 0, queues: {} },
      counters: { wagers_total: 10, alerts_triggered_total: 0, errors_total: 0 },
    }),
  } as unknown as BuckeyeScraperManager;
}

function enhancedHealthDb(detectedAt = new Date().toISOString()): Database {
  return {
    all: async (sql: string) => {
      if (sql.includes('FROM detected_patterns') && sql.includes("severity = 'critical'")) {
        return [{ pattern_type: 'agent_reversal', count: 2, last_seen: detectedAt }];
      }
      if (sql.includes('FROM detected_patterns') && sql.includes("severity = 'warning'")) {
        return [{ pattern_type: 'line_velocity', count: 1, last_seen: detectedAt }];
      }
      if (sql.includes('FROM detected_patterns')) {
        return [{ type: 'agent_reversal', severity: 'critical', count: 2, last_seen: detectedAt }];
      }
      return [];
    },
    get: async (sql: string) => {
      if (sql.includes('FROM wagers') && sql.includes('COUNT(DISTINCT NULLIF(sport')) {
        return { wager_count: 10, sport_count: 2, agent_count: 1, total_amount: 1000, last_seen: detectedAt };
      }
      if (sql.includes('FROM wagers') && sql.includes('MAX(insert_datetime)')) {
        return { row_count: 10, last_seen: detectedAt, last_event_at: detectedAt };
      }
      if (sql.includes('FROM wager_archive')) {
        return { row_count: 10, distinct_wagers: 10, last_seen: detectedAt, last_event_at: detectedAt };
      }
      if (sql.includes('FROM player_transactions')) {
        return { row_count: 1, last_seen: detectedAt, last_event_at: detectedAt };
      }
      if (sql.includes('FROM agent_hierarchy')) {
        return { row_count: 1, roots: 1, max_level: 1, last_seen: detectedAt };
      }
      if (sql.includes('FROM player_agent_map')) {
        return { row_count: 1, orphan_count: 0, last_seen: detectedAt };
      }
      if (sql.includes('FROM detected_patterns')) {
        return { row_count: 2, last24h: 2, last_seen: detectedAt };
      }
      if (sql.includes('player_agent_rows')) {
        return {
          player_agent_rows: 1,
          player_agent_last_seen: detectedAt,
          access_rows: 0,
          unique_ips: 0,
          access_last_seen: null,
          player_link_rows: 0,
          player_link_last_seen: null,
          pattern_agent_rows: 0,
          pattern_agent_last_seen: null,
        };
      }
      if (sql.includes('FROM raw_api_logs')) return { total: 0, failures: 0, last_seen: null };
      if (sql.includes('FROM player_source_status')) return { total: 0, errors: 0, last_seen: null };
      return null;
    },
  } as unknown as Database;
}

describe('enhanced health system', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ready: true }), { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('risk status expires after 1 hour when critical', async () => {
    const result = await getPatternRiskRollup(enhancedHealthDb());

    expect(result.status).toBe('critical');
    expect(result.expiresAt).not.toBeNull();
    expect(new Date(result.expiresAt!).getTime()).toBeGreaterThan(Date.now());
    expect(result.totalCritical).toBeGreaterThan(0);
  });

  test('enhanced proxy health returns structured response', async () => {
    const health = await checkEnhancedProxyHealth(async () => new Response(JSON.stringify({ ready: true }), { status: 200 }) as Response);

    expect(['ok', 'degraded', 'critical', 'unknown']).toContain(health.status);
    expect(health.responseTimeMs).toBeDefined();
    expect(health.lastChecked).toBeDefined();
  });

  test('health endpoint returns composite status', async () => {
    const response = await registerHealthRoutes(
      new URL('http://localhost/api/health/system-status'),
      new Request('http://localhost/api/health/system-status'),
      testScraperManager(enhancedHealthDb())
    );
    const data = await response!.json();

    expect(response?.status).toBe(200);
    expect(data.status).toBeDefined();
    expect(data.operationalStatus).toBeDefined();
    expect(data.patternRiskStatus).toBeDefined();
    expect(data.criticalPatternRiskByType).toBeDefined();
    expect(data.enhancedProxyHealth).toBeDefined();
    expect(data.riskStatus).toBe(data.patternRiskStatus);
    expect(data.proxyHealth).toBe(data.enhancedProxyHealth);
    expect(data.proxy).toBeDefined();
    expect(data.proxy.status).toBe(data.enhancedProxyHealth);
    expect(typeof data.proxy.url).toBe('string');
    expect(Array.isArray(data.issues)).toBe(true);
  });

  test('backend ApiError envelope includes stable code', async () => {
    const response = await handleAsync(async () => {
      throw new ApiError(400, 'agentId is required');
    }, corsHeaders);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('agentId is required');
    expect(body.code).toBe('AGENT_ID_REQUIRED');
  });

  test('admin guard envelope includes stable code', async () => {
    const previous = process.env.ADMIN_API_TOKEN;
    process.env.ADMIN_API_TOKEN = 'secret';
    try {
      const response = requireAdminTokenIfConfigured(new Request('http://localhost/api/export/wagers'));
      const body = await response!.json();

      expect(response?.status).toBe(403);
      expect(body.code).toBe('ADMIN_TOKEN_REQUIRED');
    } finally {
      if (previous === undefined) {
        delete process.env.ADMIN_API_TOKEN;
      } else {
        process.env.ADMIN_API_TOKEN = previous;
      }
    }
  });
});
