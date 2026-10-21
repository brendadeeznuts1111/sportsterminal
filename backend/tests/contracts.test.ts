import { describe, expect, expectTypeOf, test } from 'bun:test';
import {
  routeCatalog,
  routesInSync,
  type ApiRoutes,
  type RouteBody,
  type RouteKey,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
} from '../../shared/http.ts';
import type {
  ClientSocketMessage,
  OddsGridFeedEvent,
  ServerMessage,
} from '../../shared/messages.ts';
import { clientSocketMessageSchema } from '../../shared/schemas.ts';
import { createRouter } from '../src/api/router.ts';
import type { BuckeyeScraperManager } from '../src/scrapers/ScraperManager.ts';
import type { OddsPoller } from '../src/odds/OddsPoller.ts';

describe('shared route and message contracts', () => {
  test('route catalog is the route map', () => {
    expect(routesInSync).toBe(true);
    expectTypeOf<RouteKey>().toEqualTypeOf<keyof ApiRoutes>();
    expect(routeCatalog.length).toBe(66);
  });

  test('sample route slots stay aligned with handlers', () => {
    expectTypeOf<RouteParams<'GET /api/agents/:agentId/exposure'>>().toEqualTypeOf<{ agentId: string }>();
    expectTypeOf<RouteQuery<'GET /api/odds/movements'>>().toHaveProperty('eventId');
    expectTypeOf<RouteBody<'POST /api/webhooks'>>().toHaveProperty('platform');
    expectTypeOf<RouteBody<'POST /api/connect'>>().toHaveProperty('agentId');
    expectTypeOf<RouteResponse<'GET /api/odds/live'>>().toHaveProperty('games');
    expectTypeOf<RouteResponse<'GET /health'>>().toHaveProperty('status');
    expectTypeOf<RouteParams<'GET /api/performance/status'>>().toEqualTypeOf<Record<string, never>>();
  });

  test('socket unions discriminate on type', () => {
    expectTypeOf<ClientSocketMessage['type']>().toEqualTypeOf<
      'auth' | 'request_data' | 'refresh' | 'betAction' | 'token_refresh'
    >();
    expectTypeOf<OddsGridFeedEvent['type']>().toEqualTypeOf<'odds.update' | 'odds.movement' | 'pattern.detected'>();
    expectTypeOf<Extract<ServerMessage, { type: 'rawApiLog.new' }>>().toHaveProperty('type');
    expectTypeOf<Extract<ServerMessage, { type: 'telegram' }>>().toBeNever();
  });

  test('zod accepts an auth frame and rejects an unknown type', () => {
    const parsed = clientSocketMessageSchema.parse({
      type: 'auth',
      agentId: 'A1',
      username: 'desk',
      extra: true,
    });
    expect(parsed).toEqual({ type: 'auth', agentId: 'A1', username: 'desk' });
    expect(clientSocketMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  test('the router mounts every catalog key in order', () => {
    const router = createRouter({
      scraperManager: {} as BuckeyeScraperManager,
      oddsPoller: {} as OddsPoller,
    });

    for (const key of routeCatalog) {
      const space = key.indexOf(' ');
      const method = key.slice(0, space);
      let path = key.slice(space + 1)
        .replaceAll(':agentId', 'agent-1')
        .replaceAll(':playerId', 'player-1')
        .replaceAll(':webhookId', '9')
        .replaceAll(':eventId', 'evt-1');
      if (path === '/api/*') path = '/api/stats';
      if (path === '/*') path = '/index.html';
      const matched = router.match(method === 'ALL' ? 'GET' : method, path);
      expect(matched, key).not.toBeNull();
    }
  });
});
