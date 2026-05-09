import { describe, expect, it } from 'bun:test';

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
    expect(insert!.params[5]).toBe(202);
  });
});
