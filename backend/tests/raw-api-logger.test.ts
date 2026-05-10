import { describe, expect, it } from 'bun:test';

import { registerAnalyticsRoutes } from '../src/api/routes/analytics';
import { RawApiLogger, redactSensitiveFields } from '../src/services/RawApiLogger';

describe('RawApiLogger', () => {
  it('redacts sensitive nested fields without removing ordinary values', () => {
    const redacted = redactSensitiveFields({
      Login: 'CF346',
      password: 'fixes',
      nested: {
        cf_clearance: 'secret-cookie',
        amount: 25,
        tokenValue: 'jwt',
      },
      wagers: [{ PIN: '1234', WagerNumber: 750038740 }],
    }) as any;

    expect(redacted.Login).toBe('CF346');
    expect(redacted.password).toBe('REDACTED');
    expect(redacted.nested.cf_clearance).toBe('REDACTED');
    expect(redacted.nested.tokenValue).toBe('REDACTED');
    expect(redacted.nested.amount).toBe(25);
    expect(redacted.wagers[0].PIN).toBe('REDACTED');
    expect(redacted.wagers[0].WagerNumber).toBe(750038740);
  });

  it('logs status code and leaves the response body readable', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const logger = new RawApiLogger({
      run: async (sql: string, params: unknown[] = []) => {
        writes.push({ sql, params });
        return { lastID: 1, changes: 1 };
      },
    } as any);

    const response = new Response(JSON.stringify({ ok: true, token: 'secret' }), { status: 202 });

    await logger.logWithTiming('/api/buckeye/account-info', response, 'BILLY666', Date.now(), '{"q":"x"}');
    await logger.flush();

    expect(await response.text()).toContain('"ok":true');
    const insert = writes.find((write) => write.sql.includes('INSERT INTO raw_api_logs'));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('status_code');
    expect(insert!.params[1]).toContain('"token":"REDACTED"');
    expect(insert!.params[4]).toContain('"q":"x"');
    expect(insert!.params[5]).toBe(202);
  });

  it('redacts sensitive request params before insert', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const logger = new RawApiLogger({
      run: async (sql: string, params: unknown[] = []) => {
        writes.push({ sql, params });
        return { lastID: 1, changes: 1 };
      },
    } as any);

    await logger.log({
      endpoint: '/api/buckeye/agent-performance',
      responseJson: { ok: true },
      requestParams: JSON.stringify({ agentId: 'BILLY666', PasswordFix: 'secret', cf_clearance: 'cookie' }),
      statusCode: 200,
    });
    await logger.flush();

    const insert = writes.find((write) => write.sql.includes('INSERT INTO raw_api_logs'));
    expect(insert).toBeDefined();
    expect(insert!.params[4]).toContain('"PasswordFix":"REDACTED"');
    expect(insert!.params[4]).toContain('"cf_clearance":"REDACTED"');
    expect(insert!.params[4]).not.toContain('secret');
    expect(insert!.params[4]).not.toContain('cookie');
  });

  it('redacts bearer tokens, jwt values, and Cloudflare cookies from plain text', () => {
    const redacted = redactSensitiveFields({
      text: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJCSUxMWSJ9.signature; Cookie: cf_clearance=abc123; __cf_bm=def456',
      nested: 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJCSUxMWSJ9.signature&cf_clearance=abc123',
    }) as any;

    expect(redacted.text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redacted.text).not.toContain('abc123');
    expect(redacted.text).not.toContain('def456');
    expect(redacted.nested).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redacted.nested).not.toContain('abc123');
    expect(redacted.nested).toContain('token=REDACTED');
    expect(redacted.nested).toContain('cf_clearance=REDACTED');
  });

  it('filters raw API logs and only includes body when requested', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      all: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [
          {
            id: 1,
            endpoint: '/api/buckeye/account-info',
            fetched_at: '2026-05-09 12:00:00',
            agent_id: 'BILLY666',
            duration_ms: 42,
            status_code: 500,
            request_params: '{"agentId":"BILLY666","PasswordFix":"REDACTED"}',
            response_json: '{"token":"REDACTED","ok":false}',
          },
        ];
      },
    };
    const scraperManager = { getDatabase: () => db };

    const url = new URL('http://127.0.0.1/api/analytics/raw-logs?agentId=BILLY666&status=error&days=3&limit=5&includeBody=1');
    const response = await registerAnalyticsRoutes(url, new Request(url), scraperManager as any) as Response;
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(calls[0].sql).toContain('status_code >= 500');
    expect(calls[0].sql).toContain('response_json');
    expect(calls[0].params).toEqual([3, 'BILLY666', 5]);
    expect(payload.logs[0].response_json).toContain('REDACTED');
    expect(payload.logs[0].request_params_summary).toContain('PasswordFix=REDACTED');
  });
});
