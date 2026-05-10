import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createRouter, routeRequest, type RouterDeps } from '../src/api/router';
import { RateLimiter } from '../src/api/rateLimiter';

function createTestRouter() {
  return createRouter(minimalDeps());
}

const originalAdminToken = process.env.ADMIN_API_TOKEN;
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.NODE_ENV = 'development';
});

afterEach(() => {
  if (originalAdminToken === undefined) {
    delete process.env.ADMIN_API_TOKEN;
  } else {
    process.env.ADMIN_API_TOKEN = originalAdminToken;
  }
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

interface TestWebhook {
  id: number;
  name?: string;
  platform?: string;
  url?: string;
  triggers?: unknown[];
}

type TestRouterDeps = {
  scraperManager?: Record<string, unknown>;
  oddsPoller?: Record<string, unknown>;
  secretVault?: unknown;
  performanceCache?: unknown;
};

function minimalDeps(overrides: TestRouterDeps = {}): RouterDeps {
  return {
    scraperManager: {},
    oddsPoller: {},
    ...overrides,
  } as unknown as RouterDeps;
}

function createWebhookRouteDeps(): RouterDeps {
  const webhooks: TestWebhook[] = [];
  return minimalDeps({
    scraperManager: {
      getDatabase: () => ({ run: async () => ({ lastID: 1, changes: 1 }) }),
      getMetrics: () => ({
        activeAgents: 0,
        agents: [],
        actionQueue: { totalQueued: 0, queues: {} },
        counters: { wagers_total: 0, alerts_triggered_total: 0, errors_total: 0 },
      }),
      getWebhookService: () => ({
        createWebhook: async (body: Omit<TestWebhook, 'id'>) => {
          const webhook = { id: webhooks.length + 1, enabled: true, ...body };
          webhooks.push(webhook);
          return webhook;
        },
      }),
    },
  });
}

describe('API route registration', () => {
  it('registers health, wager, agent, player, risk, and webhook routes', () => {
    const router = createTestRouter();
    const routes: Array<[string, string]> = [
      ['GET', '/health'],
      ['GET', '/metrics'],
      ['GET', '/api/health/system-status'],
      ['GET', '/api/stats'],
      ['GET', '/api/wagers'],
      ['GET', '/api/wagers/alerts'],
      ['GET', '/api/wagers/live'],
      ['GET', '/api/agents'],
      ['GET', '/api/agents/downline'],
      ['GET', '/api/agents/hierarchy'],
      ['GET', '/api/agents/hierarchy/tree'],
      ['POST', '/api/agents/refresh'],
      ['POST', '/api/agents/backfill/hierarchy'],
      ['GET', '/api/agents/access-logs'],
      ['GET', '/api/agents/BILLY666/performance'],
      ['GET', '/api/agents/BILLY666/exposure'],
      ['GET', '/api/agents/BILLY666/players'],
      ['GET', '/api/agents/BILLY666'],
      ['GET', '/api/players/CF346/details'],
      ['GET', '/api/players/CF346/wagers'],
      ['GET', '/api/players/CF346/pnl'],
      ['GET', '/api/freeplay/analysis'],
      ['GET', '/api/cross-reference'],
      ['GET', '/api/risk/alerts'],
      ['GET', '/api/exposure/sports'],
      ['GET', '/api/exposure/agents'],
      ['GET', '/api/webhooks'],
      ['POST', '/api/webhooks'],
      ['GET', '/api/webhooks/1'],
      ['PUT', '/api/webhooks/1'],
      ['DELETE', '/api/webhooks/1'],
      ['GET', '/api/webhooks/1/deliveries'],
    ];

    for (const [method, pathname] of routes) {
      expect(router.match(method, pathname), `${method} ${pathname}`).not.toBeNull();
    }
  });

  it('registers odds, patterns, Buckeye, and performance routes', () => {
    const router = createTestRouter();
    const routes: Array<[string, string]> = [
      ['GET', '/api/odds/live'],
      ['GET', '/api/odds/events'],
      ['GET', '/api/odds/events/nba-1'],
      ['GET', '/api/odds/snapshots'],
      ['GET', '/api/odds/movements'],
      ['GET', '/api/books'],
      ['GET', '/api/books/status'],
      ['GET', '/api/patterns/history'],
      ['GET', '/api/patterns/catalog'],
      ['GET', '/api/patterns/summary'],
      ['GET', '/api/patterns/agents'],
      ['GET', '/api/buckeye/vault-status'],
      ['DELETE', '/api/buckeye/vault-status'],
      ['GET', '/api/buckeye/ui-config'],
      ['GET', '/api/buckeye/account-info'],
      ['GET', '/api/buckeye/weekly-figures'],
      ['GET', '/api/buckeye/agent-performance/options'],
      ['GET', '/api/buckeye/access-logs'],
      ['GET', '/api/buckeye/agent-performance'],
      ['GET', '/api/buckeye/sports-types'],
      ['GET', '/api/buckeye/manager-snapshot'],
      ['POST', '/api/connect'],
      ['GET', '/api/proxy/status'],
      ['GET', '/api/proxy/endpoints'],
      ['GET', '/api/proxy/logs'],
      ['GET', '/api/proxy/tokens'],
      ['POST', '/api/proxy/renewToken'],
      ['POST', '/api/proxy/agentDownline'],
      ['POST', '/api/proxy/pending'],
      ['POST', '/api/proxy/taxonomy/sports'],
      ['POST', '/api/proxy/Manager/getBetTicker'],
      ['POST', '/api/proxy/System/renewToken'],
      ['POST', '/api/proxy/Log/write'],
      ['GET', '/api/performance/status'],
      ['GET', '/api/betting/velocity'],
      ['GET', '/api/betting/live-vs-pre'],
      ['GET', '/api/logs/access'],
      ['GET', '/api/master/history'],
      ['GET', '/api/performance/summary'],
      ['GET', '/api/performance/details'],
      ['GET', '/api/export/wagers'],
      ['GET', '/api/export/access-logs'],
      ['GET', '/api/export/performance'],
      ['GET', '/api/analytics/raw-logs'],
      ['GET', '/api/analytics/weekly-figures'],
      ['GET', '/api/analytics/master-snapshots'],
      ['GET', '/api/analytics/performance-trends'],
      ['GET', '/api/analytics/wager-velocity'],
      ['GET', '/api/health/data-pipeline'],
      ['GET', '/api/performance/BILLY666'],
      ['DELETE', '/api/performance/BILLY666'],
    ];

    for (const [method, pathname] of routes) {
      expect(router.match(method, pathname), `${method} ${pathname}`).not.toBeNull();
    }
  });

  it('matches performance status before dynamic agent performance cache routes', () => {
    const router = createTestRouter();

    expect(router.match('GET', '/api/performance/status')?.params.agentId).toBeUndefined();
    expect(router.match('GET', '/api/performance/summary')?.params.agentId).toBeUndefined();
    expect(router.match('GET', '/api/performance/details')?.params.agentId).toBeUndefined();
    expect(router.match('GET', '/api/performance/BILLY666')?.params.agentId).toBe('BILLY666');
  });

  it('registers the versioned API bridge before static fallback', () => {
    const router = createTestRouter();

    expect(router.match('GET', '/api/v1/players/A17566/profile')).not.toBeNull();
    expect(router.match('POST', '/api/v1/agents/refresh')).not.toBeNull();
    expect(router.match('GET', '/api/v1/agents/hierarchy')).not.toBeNull();
    expect(router.match('GET', '/api/v1/agents/BILLY666/players')).not.toBeNull();
    expect(router.match('GET', '/api/v1/freeplay/analysis')).not.toBeNull();
    expect(router.match('GET', '/api/v1/cross-reference')).not.toBeNull();
    expect(router.match('GET', '/api/v1/logs/access')).not.toBeNull();
    expect(router.match('GET', '/api/v1/patterns/catalog')).not.toBeNull();
    expect(router.match('POST', '/api/v1/players/A17566/flags')).not.toBeNull();
  });

  it('applies local rate limiting before dispatching routes', async () => {
    process.env.NODE_ENV = 'production';
    const deps = minimalDeps({
      scraperManager: {
        getDatabase: () => ({ run: async () => ({ lastID: 1, changes: 1 }) }),
        getMetrics: () => ({
          activeAgents: 0,
          agents: [],
          actionQueue: { totalQueued: 0, queues: {} },
          counters: { wagers_total: 0, alerts_triggered_total: 0, errors_total: 0 },
        }),
      },
    });
    const limiter = new RateLimiter(1, 60_000);
    const request = new Request('http://localhost/health', { headers: { 'x-real-ip': '198.51.100.10' } });

    const first = await routeRequest(new URL('http://localhost/health'), request, deps, limiter);
    const second = await routeRequest(new URL('http://localhost/health'), request, deps, limiter);

    expect(first?.status).toBe(200);
    expect(second?.status).toBe(429);
    expect(second?.headers.get('Retry-After')).toBeTruthy();
  });

  it('requires the optional admin token for sensitive mutations when configured', async () => {
    process.env.ADMIN_API_TOKEN = 'local-secret';
    const deps = createWebhookRouteDeps();
    const request = new Request('http://localhost/api/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Audit', platform: 'generic', url: 'https://example.com', triggers: [] }),
    });

    const response = await routeRequest(new URL('http://localhost/api/webhooks'), request, deps);
    const body = await response?.json() as { error: string };

    expect(response?.status).toBe(403);
    expect(body.error).toBe('Admin token required');
  });

  it('allows sensitive mutations with x-admin-token when the optional guard is configured', async () => {
    process.env.ADMIN_API_TOKEN = 'local-secret';
    const deps = createWebhookRouteDeps();
    const request = new Request('http://localhost/api/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'local-secret' },
      body: JSON.stringify({ name: 'Audit', platform: 'generic', url: 'https://example.com', triggers: [] }),
    });

    const response = await routeRequest(new URL('http://localhost/api/webhooks'), request, deps);
    const body = await response?.json() as TestWebhook;

    expect(response?.status).toBe(200);
    expect(body.id).toBe(1);
    expect(body.name).toBe('Audit');
  });

  it('keeps local default behavior unchanged when no admin token is configured', async () => {
    delete process.env.ADMIN_API_TOKEN;
    const deps = createWebhookRouteDeps();
    const request = new Request('http://localhost/api/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Local Audit', platform: 'generic', url: 'https://example.com', triggers: [] }),
    });

    const response = await routeRequest(new URL('http://localhost/api/webhooks'), request, deps);
    const body = await response?.json() as TestWebhook;

    expect(response?.status).toBe(200);
    expect(body.name).toBe('Local Audit');
  });

  it('allows CORS preflight for all registered mutation methods and admin token headers', async () => {
    const router = createTestRouter();
    const response = await router.match('OPTIONS', '/api/webhooks')?.handler(
      new URL('http://localhost/api/webhooks'),
      new Request('http://localhost/api/webhooks'),
      {}
    );

    expect(response?.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(response?.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
    expect(response?.headers.get('Access-Control-Allow-Headers')).toContain('X-Admin-Token');
  });

  it('does not reuse cached routers across different dependency instances', async () => {
    const depsFor = (marker: string): RouterDeps => minimalDeps({
      scraperManager: {
        getDatabase: () => ({ run: async () => ({ lastID: 1, changes: 1 }) }),
        getLiveWagers: async () => [{ marker }],
      },
    });
    const request = new Request('http://localhost/api/wagers/live');

    const first = await routeRequest(new URL('http://localhost/api/wagers/live'), request, depsFor('first'));
    const second = await routeRequest(new URL('http://localhost/api/wagers/live'), request, depsFor('second'));
    const firstBody = await first?.json() as Array<{ marker: string }>;
    const secondBody = await second?.json() as Array<{ marker: string }>;

    expect(firstBody[0].marker).toBe('first');
    expect(secondBody[0].marker).toBe('second');
  });

  it('bridges enhanced proxy aliases to the internal proxy service', async () => {
    const originalFetch = globalThis.fetch;
    const originalProxyUrl = Bun.env.PROXY_INTERNAL_URL;
    const originalProxyKey = Bun.env.PROXY_API_KEY;
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    Bun.env.PROXY_INTERNAL_URL = 'http://internal-proxy.test';
    Bun.env.PROXY_API_KEY = 'bridge-key';
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({ source: 'live', alias: 'agentDownline', data: { agents: [] } });
    }) as typeof fetch;

    try {
      const deps = minimalDeps({
        scraperManager: {
          getEnhancedProxyCredentials: async () => ({
            agentID: 'BILLY666',
            token: 'buckeye-token',
            cf_clearance: 'cf-token',
          }),
        },
      });
      const request = new Request('http://localhost/api/proxy/agentDownline', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentID: 'BILLY666' }),
      });

      const response = await routeRequest(new URL('http://localhost/api/proxy/agentDownline'), request, deps);
      const body = await response?.json() as { source: string; alias: string };
      const forwardedBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;

      expect(response?.status).toBe(200);
      expect(body.alias).toBe('agentDownline');
      expect(capturedUrl).toBe('http://internal-proxy.test/api/proxy/agentDownline');
      expect((capturedInit?.headers as Record<string, string>)['X-API-Key']).toBe('bridge-key');
      expect(forwardedBody.token).toBe('buckeye-token');
      expect(forwardedBody.cf_clearance).toBe('cf-token');
      expect(forwardedBody.agentID).toBe('BILLY666');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProxyUrl === undefined) {
        delete Bun.env.PROXY_INTERNAL_URL;
      } else {
        Bun.env.PROXY_INTERNAL_URL = originalProxyUrl;
      }
      if (originalProxyKey === undefined) {
        delete Bun.env.PROXY_API_KEY;
      } else {
        Bun.env.PROXY_API_KEY = originalProxyKey;
      }
    }
  });
});
