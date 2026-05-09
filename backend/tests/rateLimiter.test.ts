import { describe, test, expect, beforeEach } from 'bun:test';
import { RateLimiter } from '../src/api/rateLimiter';

describe('RateLimiter', () => {
  test('allows requests within limit', () => {
    const limiter = new RateLimiter(5, 60000);

    for (let i = 0; i < 5; i++) {
      const result = limiter.check('192.168.1.1');
      expect(result.allowed).toBe(true);
      expect(result.retryAfter).toBe(0);
    }
  });

  test('blocks requests over limit', () => {
    const limiter = new RateLimiter(3, 60000);

    // Allow 3
    for (let i = 0; i < 3; i++) {
      expect(limiter.check('10.0.0.1').allowed).toBe(true);
    }

    // Block 4th
    const blocked = limiter.check('10.0.0.1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  test('tracks IPs independently', () => {
    const limiter = new RateLimiter(2, 60000);

    // IP 1 uses both slots
    expect(limiter.check('1.1.1.1').allowed).toBe(true);
    expect(limiter.check('1.1.1.1').allowed).toBe(true);
    expect(limiter.check('1.1.1.1').allowed).toBe(false);

    // IP 2 still has its slots
    expect(limiter.check('2.2.2.2').allowed).toBe(true);
    expect(limiter.check('2.2.2.2').allowed).toBe(true);
  });

  test('returns retryAfter in seconds', () => {
    const limiter = new RateLimiter(1, 10000); // 10s window, 1 req

    expect(limiter.check('10.0.0.1').allowed).toBe(true);

    const blocked = limiter.check('10.0.0.1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(10);
  });

  test('extracts IP from x-forwarded-for header', () => {
    const request = new Request('http://localhost/health', {
      headers: {
        'x-forwarded-for': '203.0.113.1, 10.0.0.1',
      },
    });
    expect(RateLimiter.getClientIp(request)).toBe('203.0.113.1');
  });

  test('extracts IP from x-real-ip header', () => {
    const request = new Request('http://localhost/health', {
      headers: {
        'x-real-ip': '198.51.100.1',
      },
    });
    expect(RateLimiter.getClientIp(request)).toBe('198.51.100.1');
  });
});
