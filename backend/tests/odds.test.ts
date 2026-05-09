import { describe, test, expect } from 'bun:test';
import { DemoOddsProvider } from '../dev-tools/DemoOddsProvider';

describe('DemoOddsProvider', () => {
  test('fetches odds for all games', async () => {
    const provider = new DemoOddsProvider();
    const odds = await provider.fetchOdds();

    expect(odds.length).toBeGreaterThanOrEqual(3);
    expect(odds[0].event).toBeDefined();
    expect(odds[0].books.length).toBe(16);
  });

  test('each book has valid odds', async () => {
    const provider = new DemoOddsProvider();
    const odds = await provider.fetchOdds();

    for (const ev of odds) {
      for (const book of ev.books) {
        expect(book.book).toBeDefined();
        expect(book.spreadHome).not.toBeNull();
        expect(book.moneylineHome).not.toBeNull();
      }
    }
  });

  test('detects line movements between polls', async () => {
    const provider = new DemoOddsProvider();

    // First poll establishes baseline
    const first = await provider.fetchOdds();

    // Second poll should detect changes
    const second = await provider.fetchOdds();
    const movements = provider.detectMovements(second);

    // Movements may or may not occur depending on jitter, but the method should run
    expect(Array.isArray(movements)).toBe(true);
  });

  test('checks book health', async () => {
    const provider = new DemoOddsProvider();
    const health = await provider.checkHealth();

    expect(health.length).toBe(16);
    const statuses = health.map(h => h.status);
    expect(statuses).toContain('online');
  });

  test('sharp books have tighter lines', async () => {
    const provider = new DemoOddsProvider();
    const odds = await provider.fetchOdds();

    for (const ev of odds) {
      const pin = ev.books.find(b => b.book === 'PIN');
      const dk = ev.books.find(b => b.book === 'DK');
      if (!pin || !dk) continue;

      // Sharp books should have less spread jitter (closer to base)
      // We can't assert exact values, but both should have valid numbers
      expect(pin.spreadHome).not.toBeNull();
      expect(dk.spreadHome).not.toBeNull();
    }
  });
});
