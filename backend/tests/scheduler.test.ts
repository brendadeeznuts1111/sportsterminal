import { afterEach, describe, test, expect, jest } from 'bun:test';
import { loadEnv } from '../src/config/env';
import { createManagedInterval } from '../src/services/Scheduler';

afterEach(() => {
  jest.useRealTimers();
});

describe('managed scheduler', () => {
  test('runs interval tasks and stops cleanly', async () => {
    jest.useFakeTimers();
    let count = 0;
    const task = createManagedInterval('test.fast', 20, () => {
      count++;
    }, { initialDelayMs: 0 });

    await Promise.resolve();
    jest.advanceTimersByTime(55);
    await Promise.resolve();
    task.stop();
    const stoppedAt = count;
    jest.advanceTimersByTime(35);
    await Promise.resolve();

    expect(stoppedAt).toBeGreaterThanOrEqual(2);
    expect(count).toBe(stoppedAt);
  });

  test('restarts with a new interval', async () => {
    jest.useFakeTimers();
    let count = 0;
    const task = createManagedInterval('test.restart', 100, () => {
      count++;
    }, { initialDelayMs: 100 });

    await Promise.resolve();
    jest.advanceTimersByTime(30);
    await Promise.resolve();
    task.restart(10, 0);
    await Promise.resolve();
    jest.advanceTimersByTime(35);
    await Promise.resolve();
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
