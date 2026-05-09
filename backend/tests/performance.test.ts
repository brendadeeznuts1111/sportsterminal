import { describe, test, expect } from 'bun:test';
import { evaluateWager } from '../src/risk/AlertEngine';
import { DemoOddsProvider } from '../src/odds/providers/DemoOddsProvider';
import { RateLimiter } from '../src/api/rateLimiter';
import type { EnrichedWager } from '../src/risk/AlertEngine';

const PERF_WAGER: EnrichedWager = {
  WagerNumber: 1,
  AgentID: 'AGENT1',
  CustomerID: 'CUST1',
  Login: 'PLAYER1',
  WagerType: 'M',
  AmountWagered: 75000,
  ToWinAmount: 50000,
  VolumeAmount: 75000,
  InsertDateTime: '2026-05-09 10:00:00.000',
  TicketWriter: 'Internet',
  ShortDesc: 'M.Basketball #123 Lakers vs Celtics -110',
  VIP: '0',
  AgentLogin: 'AGENT1',
};

describe('performance regression', () => {
  test('AlertEngine.evaluateWager completes 10,000 calls under 100ms', () => {
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      evaluateWager(PERF_WAGER);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  test('DemoOddsProvider.fetchOdds completes 100 calls under 500ms', async () => {
    const provider = new DemoOddsProvider();
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      await provider.fetchOdds();
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  }, 10_000);

  test('RateLimiter.check completes 100,000 calls under 200ms', () => {
    const limiter = new RateLimiter(100_000, 60_000);
    const start = performance.now();
    for (let i = 0; i < 100_000; i++) {
      limiter.check(`192.168.1.${i % 255}`);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  test('RateLimiter.getClientIp completes 10,000 calls under 50ms', () => {
    const request = new Request('http://localhost/health', {
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' },
    });
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      RateLimiter.getClientIp(request);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});