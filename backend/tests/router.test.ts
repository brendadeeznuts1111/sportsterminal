import { describe, expect, it } from 'bun:test';

import { createRouter } from '../src/api/router';

function createTestRouter() {
  return createRouter({
    scraperManager: {} as any,
    oddsPoller: {} as any,
  });
}

describe('API route registration', () => {
  it('registers health, wager, agent, player, risk, and webhook routes', () => {
    const router = createTestRouter();
    const routes: Array<[string, string]> = [
      ['GET', '/health'],
      ['GET', '/metrics'],
      ['GET', '/api/stats'],
      ['GET', '/api/wagers'],
      ['GET', '/api/wagers/alerts'],
      ['GET', '/api/wagers/live'],
      ['GET', '/api/agents'],
      ['GET', '/api/agents/downline'],
      ['GET', '/api/agents/hierarchy'],
      ['POST', '/api/agents/backfill/hierarchy'],
      ['GET', '/api/agents/access-logs'],
      ['GET', '/api/agents/BILLY666/performance'],
      ['GET', '/api/agents/BILLY666/exposure'],
      ['GET', '/api/players/CF346/details'],
      ['GET', '/api/players/CF346/wagers'],
      ['GET', '/api/players/CF346/pnl'],
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
    expect(router.match('GET', '/api/performance/BILLY666')?.params.agentId).toBe('BILLY666');
  });
});
