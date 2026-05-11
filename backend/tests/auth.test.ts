import { describe, test, expect } from 'bun:test';
import { createToken, verifyToken, isDevMode } from '../src/auth/jwt';
import { requireAuth } from '../src/api/middleware/auth';
import { webLogQuerySchema, connectBodySchema, formatZodError } from '../src/api/middleware/validate';
import { z } from 'zod';
import * as jose from 'jose';

const TEST_SECRET = 'test-secret-key-for-jwt-unit-tests-32-chars';
const TEST_AGENT = 'TEST_AGENT';
const JWT_ALG = 'HS256';

function createExpiredToken(agentId: string, secret: string): string {
  const secretKey = new TextEncoder().encode(secret);
  return new jose.SignJWT({ agentId })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(secretKey);
}

function jwtErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; name?: unknown };
  return typeof candidate.code === 'string'
    ? candidate.code
    : typeof candidate.name === 'string'
      ? candidate.name
      : undefined;
}

describe('JWT auth', () => {
  test('creates and verifies a valid token', async () => {
    const token = await createToken('TEST_AGENT', TEST_SECRET);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // JWT structure: header.payload.signature

    const payload = await verifyToken(token, TEST_SECRET);
    expect(payload.agentId).toBe('TEST_AGENT');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  test('rejects token with wrong secret', async () => {
    const token = await createToken('TEST_AGENT', TEST_SECRET);
    await expect(verifyToken(token, 'wrong-secret-key-different-value!!')).rejects.toThrow();
  });

test('rejects expired token', async () => {
    const expired = createExpiredToken(TEST_AGENT, TEST_SECRET);
    await expect(verifyToken(expired, TEST_SECRET)).rejects.toThrow();
  });

  test('rejects malformed token', async () => {
    await expect(verifyToken('not.a.jwt.token', TEST_SECRET)).rejects.toThrow();
  });

  test('dev mode is false by default', () => {
    // Tests run without NODE_ENV set, so dev mode should be false
    expect(isDevMode()).toBe(false);
  });
});

describe('requireAuth middleware', () => {
  const TEST_SECRET = 'test-secret-key-for-jwt-unit-tests-32-chars';

  test('allows public paths without token', async () => {
    const req = new Request('http://localhost/api/health/system-status');
    const result = await requireAuth(req, '/api/health/system-status');
    expect(result).toBeNull();
  });

  test('allows /api/agents without token', async () => {
    const req = new Request('http://localhost/api/agents');
    const result = await requireAuth(req, '/api/agents');
    expect(result).toBeNull();
  });

  test('allows static frontend routes without token', async () => {
    const rootReq = new Request('http://localhost/');
    const rootResult = await requireAuth(rootReq, '/');
    expect(rootResult).toBeNull();

    const assetReq = new Request('http://localhost/js/app.js?v=5.32.11');
    const assetResult = await requireAuth(assetReq, '/js/app.js');
    expect(assetResult).toBeNull();
  });

  test('allows read-only hierarchy and downline routes without token', async () => {
    const hierarchyReq = new Request('http://localhost/api/agents/hierarchy/tree');
    const hierarchyResult = await requireAuth(hierarchyReq, '/api/agents/hierarchy/tree');
    expect(hierarchyResult).toBeNull();

    const downlineReq = new Request('http://localhost/api/agents/downline');
    const downlineResult = await requireAuth(downlineReq, '/api/agents/downline');
    expect(downlineResult).toBeNull();
  });

  test('allows read-only wager and player archive routes without token', async () => {
    const wagersReq = new Request('http://localhost/api/wagers?limit=50');
    const wagersResult = await requireAuth(wagersReq, '/api/wagers');
    expect(wagersResult).toBeNull();

    const liveReq = new Request('http://localhost/api/wagers/live');
    const liveResult = await requireAuth(liveReq, '/api/wagers/live');
    expect(liveResult).toBeNull();

    const profileReq = new Request('http://localhost/api/players/A17566/profile');
    const profileResult = await requireAuth(profileReq, '/api/players/A17566/profile');
    expect(profileResult).toBeNull();
  });

  test('still protects player mutations without token', async () => {
    const req = new Request('http://localhost/api/players/A17566/notes', { method: 'POST' });
    const result = await requireAuth(req, '/api/players/A17566/notes');
    expect(result instanceof Response).toBe(true);
    expect((result as Response).status).toBe(401);
  });

  test('allows public v1 compatibility paths without token', async () => {
    const req = new Request('http://localhost/api/v1/players/search?q=A17566');
    const result = await requireAuth(req, '/api/v1/players/search');
    expect(result).toBeNull();
  });

  test('rejects protected route without Authorization header', async () => {
    const req = new Request('http://localhost/api/buckeye/web-log');
    const result = await requireAuth(req, '/api/buckeye/web-log');
    expect(result instanceof Response).toBe(true);
    const res = result as Response;
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Bearer token required');
  });

  test('rejects protected route with invalid token', async () => {
    const req = new Request('http://localhost/api/buckeye/web-log', {
      headers: { Authorization: 'Bearer invalid.token.here' },
    });
    const result = await requireAuth(req, '/api/buckeye/web-log');
    expect(result instanceof Response).toBe(true);
    const res = result as Response;
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('invalid or expired token');
  });
});

describe('Zod validation middleware', () => {
  test('webLogQuerySchema accepts valid query', () => {
    const params = {
      start: '05/01/2026',
      end: '05/09/2026',
      type: 'B',
      actions: 'A',
    };
    const result = webLogQuerySchema.parse(params);
    expect(result.start).toBe('05/01/2026');
    expect(result.type).toBe('B');
  });

  test('webLogQuerySchema rejects invalid date format', () => {
    expect(() => webLogQuerySchema.parse({ start: '2026-05-01', end: '05/09/2026' })).toThrow(z.ZodError);
  });

  test('webLogQuerySchema rejects invalid type', () => {
    expect(() => webLogQuerySchema.parse({ start: '05/01/2026', end: '05/09/2026', type: 'X' })).toThrow(z.ZodError);
  });

  test('connectBodySchema requires agentId and password', () => {
    expect(() => connectBodySchema.parse({})).toThrow(z.ZodError);
    expect(() => connectBodySchema.parse({ agentId: '' })).toThrow(z.ZodError);
  });

  test('connectBodySchema accepts valid body', () => {
    const result = connectBodySchema.parse({ agentId: 'TEST', password: 'secret', baseUrl: 'https://example.com' });
    expect(result.agentId).toBe('TEST');
  });

  test('formatZodError returns structured details', () => {
    try {
      connectBodySchema.parse({});
    } catch (err) {
      if (err instanceof z.ZodError) {
        const formatted = formatZodError(err);
        expect(formatted.error).toBe('Validation failed');
        expect(Array.isArray(formatted.details)).toBe(true);
        expect(formatted.details.length).toBeGreaterThan(0);
      }
    }
  });
});
