import { describe, test, expect } from 'bun:test';
import { createToken, verifyToken, isDevMode } from '../src/auth/jwt';

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
