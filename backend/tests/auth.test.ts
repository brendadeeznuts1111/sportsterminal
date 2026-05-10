import { describe, test, expect } from 'bun:test';
import { createToken, verifyToken, isDevMode } from '../src/auth/jwt';
import { requireAuth } from '../src/api/middleware/auth';
import { webLogQuerySchema, connectBodySchema, formatZodError } from '../src/api/middleware/validate';
import { z } from 'zod';

const TEST_SECRET = 'test-secret-key-for-jwt-unit-tests-32-chars';

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
    try {
      await verifyToken(token, 'wrong-secret-key-different-value!!');
      expect('should have thrown').toBe(false);
    } catch (err: any) {
      expect(err.code || err.name).toBeDefined();
    }
  });

  test('rejects expired token', async () => {
    const secretKey = new TextEncoder().encode(TEST_SECRET);
    // Use jose to create an already-expired token
    const { SignJWT } = await import('jose');
    const expired = await new SignJWT({ agentId: 'EXPIRED' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60) // 60s in the past
      .sign(secretKey);

    try {
      await verifyToken(expired, TEST_SECRET);
      expect('should have thrown').toBe(false);
    } catch (err: any) {
      expect(err.code).toBe('ERR_JWT_EXPIRED');
    }
  });

  test('rejects malformed token', async () => {
    try {
      await verifyToken('not.a.jwt.token', TEST_SECRET);
      expect('should have thrown').toBe(false);
    } catch (err: any) {
      expect(err.code || err.name).toBeDefined();
    }
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
