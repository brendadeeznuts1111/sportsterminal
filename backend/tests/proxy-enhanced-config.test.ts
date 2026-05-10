import { afterEach, describe, expect, test } from 'bun:test';

import { config, reloadFromEnv } from '../../config';

const ENV_KEYS = [
  'ENABLE_METRICS',
  'ENABLE_RESPONSE_COMPRESSION',
  'ENABLE_RETRY',
  'ENABLE_AUTO_RETRY',
  'ENABLE_WS_COMPRESSION',
  'ENABLE_PER_CUSTOMER_RATE_LIMIT',
  'ENABLE_RATE_LIMITING',
  'ENABLE_AUTO_RENEWAL',
  'ENABLE_TOKEN_PRE_RENEWAL',
  'RATE_LIMIT_PER_MIN',
  'MAX_RETRIES',
  'RETRY_BASE_MS',
  'ENABLE_ANALYTICS',
  'ENABLE_RISK_ENGINE',
  'DEMO_MODE',
  'ENABLE_DEMO_MODE',
  'PROXY_PRODUCTION',
  'PROXY_PORT',
] as const;

const originalEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) {
  originalEnv.set(key, process.env[key]);
}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    delete process.env[key];
    delete Bun.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
    Bun.env[key] = value;
  }
  return reloadFromEnv();
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      delete Bun.env[key];
    } else {
      process.env[key] = value;
      Bun.env[key] = value;
    }
  }
  reloadFromEnv();
});

describe('enhanced proxy feature config', () => {
  test('supports requested ENABLE_* aliases for runtime flags', () => {
    const updated = setEnv({
      ENABLE_METRICS: 'true',
      ENABLE_RESPONSE_COMPRESSION: 'true',
      ENABLE_RETRY: 'false',
      ENABLE_WS_COMPRESSION: 'true',
      ENABLE_PER_CUSTOMER_RATE_LIMIT: 'false',
      ENABLE_AUTO_RENEWAL: 'false',
    });

    expect(updated.features.metrics).toBe(true);
    expect(updated.features.responseCompression).toBe(true);
    expect(updated.features.autoRetry).toBe(false);
    expect(updated.features.wsCompression).toBe(true);
    expect(updated.features.rateLimiting).toBe(false);
    expect(updated.features.tokenPreRenewal).toBe(false);
  });

  test('keeps original feature names working alongside aliases', () => {
    const updated = setEnv({
      ENABLE_AUTO_RETRY: 'false',
      ENABLE_RATE_LIMITING: 'false',
      ENABLE_TOKEN_PRE_RENEWAL: 'false',
      RATE_LIMIT_PER_MIN: '17',
      MAX_RETRIES: '5',
      RETRY_BASE_MS: '250',
    });

    expect(updated.features.autoRetry).toBe(false);
    expect(updated.features.rateLimiting).toBe(false);
    expect(updated.features.tokenPreRenewal).toBe(false);
    expect(updated.defaultRateLimit.limit).toBe(17);
    expect(updated.maxRetries).toBe(5);
    expect(updated.retryBaseMs).toBe(250);
  });

  test('mutates the exported singleton used by /features', () => {
    const updated = setEnv({
      ENABLE_METRICS: 'true',
      ENABLE_WS_COMPRESSION: 'true',
    });

    expect(config).toBe(updated);
    expect(config.features.metrics).toBe(true);
    expect(config.features.wsCompression).toBe(true);
  });

  test('validates Bun.env with zod and exposes production mode', () => {
    const updated = setEnv({
      PROXY_PRODUCTION: 'true',
      PROXY_PORT: '3105',
    });

    expect(updated.production).toBe(true);
    expect(updated.port).toBe(3105);
  });

  test('rejects malformed typed env values', () => {
    expect(() => setEnv({ PROXY_PORT: 'not-a-port' })).toThrow(/Invalid proxy environment/);
  });

  test('analytics and riskEngine feature flags default to true', () => {
    expect(config.features.analytics).toBe(true);
    expect(config.features.riskEngine).toBe(true);
  });

  test('analytics and riskEngine can be disabled via env', () => {
    const updated = setEnv({
      ENABLE_ANALYTICS: 'false',
      ENABLE_RISK_ENGINE: 'false',
    });

    expect(updated.features.analytics).toBe(false);
    expect(updated.features.riskEngine).toBe(false);
  });

  test('analytics and riskEngine can be re-enabled via env', () => {
    const updated = setEnv({
      ENABLE_ANALYTICS: 'true',
      ENABLE_RISK_ENGINE: 'true',
    });

    expect(updated.features.analytics).toBe(true);
    expect(updated.features.riskEngine).toBe(true);
  });

  test('demo mode can be enabled through either demo env name', () => {
    let updated = setEnv({ DEMO_MODE: 'true' });
    expect(updated.features.demoMode).toBe(true);

    updated = setEnv({ ENABLE_DEMO_MODE: 'true' });
    expect(updated.features.demoMode).toBe(true);
  });
});
