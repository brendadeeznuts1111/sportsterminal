import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createRouter, routeRequest } from '../src/api/router';
import { RateLimiter } from '../src/api/rateLimiter';

function createTestRouter() {
  return createRouter({
    scraperManager: {} as any,
    oddsPoller: {} as any,
  });
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

function createWebhookRouteDeps() {
  const webhooks: any[] = [];
  return {
    scraperManager: {
      getDatabase: () => ({ run: async () => ({ lastID: 1, changes: 1 }) }),
      getMetrics: () => ({ activeAgents: 0, agents: [], actionQueue: { totalQueued: 0, queues: {} }, counters: {} }),
      getWebhookService: () => ({
        createWebhook: async (body: any) => {
          const webhook = { id: webhooks.length + 1, ...body };
          webhooks.push(webhook);
          return webhook;
        },
      }),
    } as any,
    oddsPoller: {} as any,
  };
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
    const deps = {
      scraperManager: {
        getDatabase: () => ({ run: async () => ({ lastID: 1, changes: 1 }) }),
        getMetrics: () => ({ activeAgents: 0, agents: [], actionQueue: { totalQueued: 0, queues: {} }, counters: {} }),
      } as any,
      oddsPoller: {} as any,
    };
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
    const body = await response?.json();

    expect(response?.status).toBe(401);
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
    const body = await response?.json();

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
    const body = await response?.json();

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
    const depsFor = (marker: string) => ({
      scraperManager: {
        getDatabase: () => ({ run: async () => ({ lastID: 1, changes: 1 }) }),
        getLiveWagers: () => [{ marker }],
      } as any,
      oddsPoller: {} as any,
    });
    const request = new Request('http://localhost/api/wagers/live');

    const first = await routeRequest(new URL('http://localhost/api/wagers/live'), request, depsFor('first'));
    const second = await routeRequest(new URL('http://localhost/api/wagers/live'), request, depsFor('second'));
    const firstBody = await first?.json();
    const secondBody = await second?.json();

    expect(firstBody[0].marker).toBe('first');
    expect(secondBody[0].marker).toBe('second');
  });
});
