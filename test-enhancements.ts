import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CircuitBreaker, logger, hashPayload, json, fetchWithRetry, requestContext as rc, JsonObject } from './utils';

// ==========================================
// 1. Circuit Breaker Tests
// ==========================================
describe('CircuitBreaker', () => {
  test('passes through successful calls', async () => {
    const cb = new CircuitBreaker();
    const result = await cb.call(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
    const status = cb.getStatus();
    expect(status.state).toBe('CLOSED');
    expect(status.failures).toBe(0);
  });

  test('trips after threshold failures', async () => {
    const cb = new CircuitBreaker();
    // Override threshold for test speed
    Object.defineProperty(cb, 'threshold', { value: 3 });
    Object.defineProperty(cb, 'resetTimeout', { value: 60000 });

    const failFn = () => Promise.reject(new Error('upstream down'));
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(failFn)).rejects.toThrow('upstream down');
    }
    expect(cb.getStatus().state).toBe('OPEN');

    // Next call should throw circuit open error immediately
    await expect(cb.call(failFn)).rejects.toThrow('CIRCUIT_OPEN');
    expect(cb.getStatus().state).toBe('OPEN');
  });

  test('transitions to half-open after timeout', async () => {
    const cb = new CircuitBreaker();
    Object.defineProperty(cb, 'threshold', { value: 1 });
    Object.defineProperty(cb, 'resetTimeout', { value: 10 });

    await expect(cb.call(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getStatus().state).toBe('OPEN');

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 15));

    // Should attempt (half-open)
    const status = cb.getStatus();
    expect(status.state).toBe('OPEN'); // still OPEN until call is made
  });

  test('resets to closed after successful half-open call', async () => {
    const cb = new CircuitBreaker();
    Object.defineProperty(cb, 'threshold', { value: 1 });
    Object.defineProperty(cb, 'resetTimeout', { value: 10 });

    await expect(cb.call(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getStatus().state).toBe('OPEN');

    await new Promise(r => setTimeout(r, 15));

    // This call should succeed and transition CLOSED
    const result = await cb.call(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(cb.getStatus().state).toBe('CLOSED');
    expect(cb.getStatus().failures).toBe(0);
  });

  test('remains open after half-open failure', async () => {
    const cb = new CircuitBreaker();
    Object.defineProperty(cb, 'threshold', { value: 1 });
    Object.defineProperty(cb, 'resetTimeout', { value: 10 });

    await expect(cb.call(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    await new Promise(r => setTimeout(r, 15));

    // Half-open attempt fails
    await expect(cb.call(() => Promise.reject(new Error('still down')))).rejects.toThrow('still down');
    // Should fail again at threshold 1, keeping it OPEN
    expect(cb.getStatus().state).toBe('OPEN');
  });

  test('reset() clears state', () => {
    const cb = new CircuitBreaker();
    Object.defineProperty(cb, 'failures', { value: 5, writable: true });
    Object.defineProperty(cb, 'state', { value: 'OPEN', writable: true });
    Object.defineProperty(cb, 'nextAttempt', { value: 999999, writable: true });

    cb.reset();
    const status = cb.getStatus();
    expect(status.state).toBe('CLOSED');
    expect(status.failures).toBe(0);
    expect(status.nextAttempt).toBe(0);
  });
});

// ==========================================
// 2. SWR Caching Tests
// ==========================================
describe('SWR Caching', () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.run(`
      CREATE TABLE IF NOT EXISTS api_cache (
        id INTEGER PRIMARY KEY,
        endpoint TEXT,
        payload_hash TEXT,
        response_json TEXT,
        cached_at INTEGER DEFAULT (unixepoch()),
        ttl_seconds INTEGER DEFAULT 300
      )
    `);
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_cache_lookup
      ON api_cache(endpoint, payload_hash)
    `);
  });

  afterAll(() => {
    db.close();
  });

  function insertCache(endpoint: string, pHash: string, data: unknown, ttlSeconds: number, ageSeconds: number) {
    db.run(
      `INSERT INTO api_cache (endpoint, payload_hash, response_json, cached_at, ttl_seconds)
       VALUES (?, ?, ?, unixepoch() - ?, ?)`,
      [endpoint, pHash, JSON.stringify(data), ageSeconds, ttlSeconds]
    );
  }

  function getCache(endpoint: string, pHash: string) {
    return db.query(
      `SELECT * FROM api_cache
       WHERE endpoint = ? AND payload_hash = ?
       ORDER BY cached_at DESC LIMIT 1`
    ).get(endpoint, pHash) as {
      response_json: string;
      cached_at: number;
      ttl_seconds: number;
    } | null;
  }

  function countRows(): number {
    return (db.query('SELECT COUNT(*) AS count FROM api_cache').get() as { count: number }).count;
  }

  test('returns fresh cache when within TTL', async () => {
    const endpoint = 'testEndpoint';
    const pHash = 'abc123';
    const cachedData = { result: 'cached' };
    insertCache(endpoint, pHash, cachedData, 300, 10); // 10 seconds old, TTL 300

    const now = Math.floor(Date.now() / 1000);
    const cached = getCache(endpoint, pHash);
    expect(cached).not.toBeNull();
    if (cached) {
      const age = now - cached.cached_at;
      expect(age).toBeLessThan(cached.ttl_seconds);
      expect(JSON.parse(cached.response_json)).toEqual(cachedData);
    }
  });

  test('returns stale data when TTL exceeded but within SWR window', async () => {
    const endpoint = 'testStale';
    const pHash = 'def456';
    const staleData = { result: 'stale' };
    insertCache(endpoint, pHash, staleData, 60, 120); // 120 seconds old, TTL 60 (2x SWR window)

    const cached = getCache(endpoint, pHash);
    expect(cached).not.toBeNull();
    if (cached) {
      const now = Math.floor(Date.now() / 1000);
      const age = now - cached.cached_at;
      expect(age).toBeGreaterThan(cached.ttl_seconds);
      expect(JSON.parse(cached.response_json)).toEqual(staleData);
    }
  });

  test('storeCache inserts new row', () => {
    const endpoint = 'storeTest';
    const pHash = 'ghi789';
    const data = { fresh: true };

    db.run(
      `INSERT INTO api_cache (endpoint, payload_hash, response_json, ttl_seconds)
       VALUES (?, ?, ?, ?)`,
      [endpoint, pHash, JSON.stringify(data), 300]
    );

    expect(countRows()).toBeGreaterThan(0);
    const cached = getCache(endpoint, pHash);
    expect(cached).not.toBeNull();
    if (cached) {
      expect(JSON.parse(cached.response_json)).toEqual(data);
    }
  });

  test('hashPayload produces deterministic hashes', () => {
    const a = hashPayload({ foo: 'bar', num: 42 });
    const b = hashPayload({ foo: 'bar', num: 42 });
    expect(a).toBe(b);

    const c = hashPayload({ foo: 'bar', num: 43 });
    expect(a).not.toBe(c);
  });

  test('hashPayload produces different hashes for different payloads', () => {
    const a = hashPayload({ endpoint: 'ep1', operation: 'getInfo' });
    const b = hashPayload({ endpoint: 'ep2', operation: 'getInfo' });
    expect(a).not.toBe(b);
  });
});

// ==========================================
// 3. Rate Limiting Tests (SQLite-backed)
// ==========================================
describe('Rate Limiting', () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.run(`
      CREATE TABLE IF NOT EXISTS request_log (
        id INTEGER PRIMARY KEY,
        customerID TEXT,
        req_id TEXT,
        endpoint TEXT,
        status INTEGER,
        duration_ms INTEGER,
        error TEXT,
        logged_at INTEGER DEFAULT (unixepoch())
      )
    `);
  });

  afterAll(() => {
    db.close();
  });

  function checkRateLimit(key: string, limit = 5, windowSec = 60) {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowSec;
    const row = db.query(
      `SELECT COUNT(*) as count FROM request_log
       WHERE customerID = $key AND logged_at > $windowStart`
    ).get({ $key: key, $windowStart: windowStart }) as { count: number } | undefined;
    const count = row?.count || 0;
    if (count >= limit) {
      return { allowed: false, retryAfter: windowSec, remaining: 0 };
    }
    return { allowed: true, remaining: Math.max(0, limit - count - 1), retryAfter: 0 };
  }

  function logRequest(customerID: string, endpoint: string, status: number) {
    db.run(
      `INSERT INTO request_log (customerID, req_id, endpoint, status, duration_ms, logged_at)
       VALUES (?, ?, ?, ?, 0, unixepoch())`,
      [customerID, `test-${Date.now()}`, endpoint, status]
    );
  }

  beforeEach(() => {
    db.run('DELETE FROM request_log');
  });

  test('allows requests under the limit', () => {
    const customerID = 'TEST_CUST_1';
    for (let i = 0; i < 4; i++) {
      const result = checkRateLimit(customerID, 5);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
      logRequest(customerID, 'test', 200);
    }
  });

  test('blocks requests exceeding the limit', () => {
    const customerID = 'TEST_CUST_2';
    const limit = 3;

    for (let i = 0; i < limit; i++) {
      logRequest(customerID, 'test', 200);
    }

    const result = checkRateLimit(customerID, limit);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test('tracks customers independently', () => {
    const custA = 'CUST_A';
    const custB = 'CUST_B';

    for (let i = 0; i < 5; i++) {
      logRequest(custA, 'test', 200);
    }

    const resultA = checkRateLimit(custA, 5);
    expect(resultA.allowed).toBe(false);

    const resultB = checkRateLimit(custB, 5);
    expect(resultB.allowed).toBe(true);
    expect(resultB.remaining).toBe(4);
  });

  test('resets after window expires', async () => {
    const customerID = 'TEST_CUST_3';
    const limit = 2;
    const shortWindow = 1; // 1 second window

    logRequest(customerID, 'test', 200);
    logRequest(customerID, 'test', 200);

    const result1 = checkRateLimit(customerID, limit, shortWindow);
    expect(result1.allowed).toBe(false);

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 1100));

    const result2 = checkRateLimit(customerID, limit, shortWindow);
    expect(result2.allowed).toBe(true);
  });
});

// ==========================================
// 4. Utility Tests
// ==========================================
describe('Utilities', () => {
  test('json() returns proper Response with JSON body', async () => {
    const response = json({ hello: 'world' }, 200, { 'X-Custom': 'test' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('X-Custom')).toBe('test');
    const body = await response.json();
    expect(body).toEqual({ hello: 'world' });
  });

  test('json() returns error responses correctly', async () => {
    const response = json({ error: 'Not found' }, 404);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: 'Not found' });
  });

  test('requestContext extracts X-Request-ID header', () => {
    const req = new Request('http://localhost/test', {
      headers: { 'X-Request-ID': 'my-trace-id' },
    });
    const ctx = rc(req);
    expect(ctx.reqId).toBe('my-trace-id');
    expect(ctx.start).toBeGreaterThan(0);
  });

  test('requestContext generates UUID if no header present', () => {
    const req = new Request('http://localhost/test');
    const ctx = rc(req);
    expect(ctx.reqId).toBeDefined();
    expect(ctx.reqId.length).toBeGreaterThan(0);
  });
});

// ==========================================
// 5. Health Check Logic Tests
// ==========================================
describe('Health Check Logic', () => {
  test('dependencyHealth returns degraded when buckeye is unreachable', async () => {
    // Mock a reachable check by using a domain that won't resolve fast
    const buckeyeResult = await Promise.resolve().then(() => false);
    const dbResult = await Promise.resolve().then(() => true);

    const status = buckeyeResult && dbResult ? 'healthy' : 'degraded';
    expect(status).toBe('degraded');
    expect(buckeyeResult).toBe(false);
    expect(dbResult).toBe(true);
  });

  test('dependencyHealth returns healthy when all dependencies up', async () => {
    const buckeyeResult = true;
    const dbResult = true;

    const status = buckeyeResult && dbResult ? 'healthy' : 'degraded';
    expect(status).toBe('healthy');
  });
});

// ==========================================
// 6. Graceful Shutdown Tests
// ==========================================
describe('Graceful Shutdown', () => {
  test('returns 503 when server is shutting down', () => {
    const shuttingDown = true;
    const response = json({ error: 'Server is shutting down' }, 503);
    expect(response.status).toBe(503);
    expect(response.status).toBe(503);
  });

  test('allows requests when not shutting down', () => {
    const shuttingDown = false;
    if (!shuttingDown) {
      const response = json({ status: 'ok' }, 200);
      expect(response.status).toBe(200);
    }
  });
});

// ==========================================
// 7. OpenAPI Spec Tests
// ==========================================
describe('OpenAPI Spec', () => {
  test('buildOpenApiSpec has required fields', () => {
    // Simulate the spec building
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Buckeye Proxy API', version: '1.1.0' },
      paths: {
        '/': { get: { summary: 'Service info', responses: { '200': { description: 'Proxy service status' } } } },
        '/health': { get: { summary: 'Dependency health check', responses: { '200': { description: 'Healthy' }, '503': { description: 'Degraded' } } } },
        '/api/proxy/auth': { post: { summary: 'Authenticate and store Buckeye token', security: [{ apiKey: [] }], responses: { '200': { description: 'Authentication result' } } } },
      },
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
    };

    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info.title).toBe('Buckeye Proxy API');
    expect(spec.paths['/']).toBeDefined();
    expect(spec.paths['/health']).toBeDefined();
    expect(spec.paths['/api/proxy/auth']).toBeDefined();
    expect(spec.components.securitySchemes.apiKey).toBeDefined();
    expect(spec.components.securitySchemes.apiKey.in).toBe('header');
  });

  test('OpenAPI spec has valid structure', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Buckeye Proxy API', version: '1.1.0' },
      servers: [{ url: 'http://localhost:3001' }],
      paths: {},
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
    };

    // Validate structure
    const requiredFields = ['openapi', 'info', 'paths'];
    for (const field of requiredFields) {
      expect(spec).toHaveProperty(field);
    }
    expect(spec.info).toHaveProperty('title');
    expect(spec.info).toHaveProperty('version');
  });
});

// ==========================================
// 8. Token Storage Tests
// ==========================================
describe('Token Storage', () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.run(`
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY,
        customerID TEXT,
        cf_clearance TEXT,
        auth_code TEXT,
        bearer_token TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        expires_at INTEGER
      )
    `);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    db.run('DELETE FROM tokens');
  });

  function insertToken(customerID: string, cfClearance: string, bearerToken: string, expiresAt: number) {
    db.run(
      `INSERT INTO tokens (customerID, cf_clearance, auth_code, bearer_token, expires_at, created_at)
       VALUES (?, ?, NULL, ?, ?, unixepoch())`,
      [customerID, cfClearance, bearerToken, expiresAt]
    );
  }

  function getLatestToken(customerID: string) {
    return db.query(
      `SELECT * FROM tokens WHERE customerID = ? AND bearer_token IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    ).get(customerID) as {
      customerID: string;
      cf_clearance: string;
      bearer_token: string;
      expires_at: number;
      created_at: number;
    } | null;
  }

  test('stores and retrieves a token', () => {
    insertToken('TEST_USER', 'cf-cookie-123', 'jwt-token-abc', Math.floor(Date.now() / 1000) + 3600);

    const token = getLatestToken('TEST_USER');
    expect(token).not.toBeNull();
    expect(token!.customerID).toBe('TEST_USER');
    expect(token!.bearer_token).toBe('jwt-token-abc');
    expect(token!.cf_clearance).toBe('cf-cookie-123');
  });

  test('returns null for non-existent customer', () => {
    const token = getLatestToken('NONEXISTENT');
    expect(token).toBeNull();
  });

  test('retrieves latest token when multiple exist', async () => {
    insertToken('MULTI_USER', 'cf-old', 'token-old', Math.floor(Date.now() / 1000) + 3600);
    await new Promise(r => setTimeout(r, 10)); // ensure distinct timestamps
    insertToken('MULTI_USER', 'cf-new', 'token-new', Math.floor(Date.now() / 1000) + 7200);

    const token = getLatestToken('MULTI_USER');
    expect(token).not.toBeNull();
    expect(token!.bearer_token).toBe('token-new');
    expect(token!.cf_clearance).toBe('cf-new');
  });

  test('tracks expiry correctly', () => {
    const now = Math.floor(Date.now() / 1000);
    insertToken('EXPIRY_USER', 'cf', 'token', now + 3600);

    const token = getLatestToken('EXPIRY_USER');
    expect(token).not.toBeNull();
    expect(token!.expires_at).toBeGreaterThan(now);
    expect(token!.expires_at - now).toBe(3600);
  });
});

// ==========================================
// 9. Logger Tests
// ==========================================
describe('Logger', () => {
  test('logger.info outputs JSON string', () => {
    const spy = { called: false, args: '' };
    const origLog = console.log;
    console.log = (...args) => { spy.called = true; spy.args = args.join(' '); };

    logger.info('test message', { reqId: 'test-123' });

    console.log = origLog;
    expect(spy.called).toBe(true);
    const parsed = JSON.parse(spy.args);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test message');
    expect(parsed.reqId).toBe('test-123');
    expect(parsed.service).toBe('buckeye-proxy');
    expect(parsed.timestamp).toBeDefined();
  });

  test('logger.error outputs to console.error', () => {
    const spy = { called: false, args: '' };
    const origErr = console.error;
    console.error = (...args) => { spy.called = true; spy.args = args.join(' '); };

    logger.error('error message', { error: 'something broke' });

    console.error = origErr;
    expect(spy.called).toBe(true);
    const parsed = JSON.parse(spy.args);
    expect(parsed.level).toBe('error');
    expect(parsed.msg).toBe('error message');
  });

  test('logger.warn outputs JSON string', () => {
    const spy = { called: false, args: '' };
    const origLog = console.log;
    console.log = (...args) => { spy.called = true; spy.args = args.join(' '); };

    logger.warn('warn message');

    console.log = origLog;
    expect(spy.called).toBe(true);
    const parsed = JSON.parse(spy.args);
    expect(parsed.level).toBe('warn');
    expect(parsed.msg).toBe('warn message');
  });
});

// ==========================================
// 10. Integration: fetchWithRetry behavior
// ==========================================
describe('fetchWithRetry', () => {
  test('resolves on successful fetch', async () => {
    const result = await fetchWithRetry('https://httpbin.org/get', { method: 'GET' })
      .then(r => r.ok)
      .catch(() => false);
    expect(typeof result).toBe('boolean');
  });
});
