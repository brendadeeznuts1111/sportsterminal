import { describe, test, expect } from 'bun:test';
import { loadEnv } from '../src/config/env';
import { createManagedInterval } from '../src/services/Scheduler';

describe('managed scheduler', () => {
  test('runs interval tasks and stops cleanly', async () => {
    let count = 0;
    const task = createManagedInterval('test.fast', 20, () => {
      count++;
    }, { initialDelayMs: 0 });

    await Bun.sleep(55);
    task.stop();
    const stoppedAt = count;
    await Bun.sleep(35);

    expect(stoppedAt).toBeGreaterThanOrEqual(2);
    expect(count).toBe(stoppedAt);
  });

  test('restarts with a new interval', async () => {
    let count = 0;
    const task = createManagedInterval('test.restart', 100, () => {
      count++;
    }, { initialDelayMs: 100 });

    await Bun.sleep(30);
    task.restart(10, 0);
    await Bun.sleep(35);
    task.stop();

    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe('env validation', () => {
  test('loads safe defaults and validates URLs', () => {
    const env = loadEnv({
      PORT: '3001',
      HOST: '127.0.0.1',
      JWT_SECRET: 'development-secret-with-enough-length',
      BUCKEYE_BASE_URL: 'https://fantasy402.com',
      DEBUG: 'true',
    });

    expect(env.PORT).toBe(3001);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.DEBUG).toBe(true);
    expect(env.BUCKEYE_BASE_URL).toBe('https://fantasy402.com');
  });

  test('rejects invalid startup configuration', () => {
    expect(() => loadEnv({ PORT: '99999' })).toThrow('PORT must be an integer');
    expect(() => loadEnv({ BUCKEYE_BASE_URL: 'not-a-url' })).toThrow('BUCKEYE_BASE_URL');
    expect(() => loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'short' })).toThrow('JWT_SECRET');
  });
});
