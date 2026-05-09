import { describe, test, expect } from 'bun:test';
import { evaluateWager, evaluateWagers } from '../src/risk/AlertEngine';
import type { EnrichedWager } from '../src/risk/AlertEngine';

describe('AlertEngine', () => {
  test('evaluates high volume wager as critical', () => {
    const wager: EnrichedWager = {
      WagerNumber: 1,
      AgentID: 'AGENT1',
      CustomerID: 'CUST1',
      Login: 'PLAYER1',
      WagerType: 'M',
      AmountWagered: 75000,
      ToWinAmount: 50000,
      VolumeAmount: 75000,
      InsertDateTime: '2026-05-08 10:00:00.000',
      TicketWriter: 'Internet',
      ShortDesc: 'Test wager',
      VIP: '0',
      AgentLogin: 'AGENT1',
    };

    const alerts = evaluateWager(wager);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts.some((a) => a.ruleName === 'High Volume Wager' && a.severity === 'critical')).toBe(true);
  });

  test('evaluates ALERT ticket writer as warning', () => {
    const wager: EnrichedWager = {
      WagerNumber: 2,
      AgentID: 'AGENT2',
      CustomerID: 'CUST2',
      Login: 'PLAYER2',
      WagerType: 'M',
      AmountWagered: 1000,
      ToWinAmount: 500,
      VolumeAmount: 1000,
      InsertDateTime: '2026-05-08 10:00:00.000',
      TicketWriter: 'ALERT',
      ShortDesc: 'Test wager',
      VIP: '0',
      AgentLogin: 'AGENT2',
    };

    const alerts = evaluateWager(wager);
    expect(alerts.some((a) => a.ruleName === 'ALERT Ticket Writer' && a.severity === 'warning')).toBe(true);
  });

  test('evaluates GSLIVE large wager as warning', () => {
    const wager: EnrichedWager = {
      WagerNumber: 3,
      AgentID: 'AGENT3',
      CustomerID: 'CUST3',
      Login: 'PLAYER3',
      WagerType: 'M',
      AmountWagered: 15000,
      ToWinAmount: 10000,
      VolumeAmount: 15000,
      InsertDateTime: '2026-05-08 10:00:00.000',
      TicketWriter: 'GSLIVE',
      ShortDesc: 'Test wager',
      VIP: '0',
      AgentLogin: 'AGENT3',
    };

    const alerts = evaluateWager(wager);
    expect(alerts.some((a) => a.ruleName === 'Live Large Wager' && a.severity === 'warning')).toBe(true);
  });

  test('evaluates VIP wager as info', () => {
    const wager: EnrichedWager = {
      WagerNumber: 4,
      AgentID: 'AGENT4',
      CustomerID: 'CUST4',
      Login: 'PLAYER4',
      WagerType: 'M',
      AmountWagered: 5000,
      ToWinAmount: 3000,
      VolumeAmount: 5000,
      InsertDateTime: '2026-05-08 10:00:00.000',
      TicketWriter: 'Internet',
      ShortDesc: 'Test wager',
      VIP: '1',
      AgentLogin: 'AGENT4',
    };

    const alerts = evaluateWager(wager);
    expect(alerts.some((a) => a.ruleName === 'VIP Wager' && a.severity === 'info')).toBe(true);
  });

  test('returns empty array for normal wager', () => {
    const wager: EnrichedWager = {
      WagerNumber: 5,
      AgentID: 'AGENT5',
      CustomerID: 'CUST5',
      Login: 'PLAYER5',
      WagerType: 'M',
      AmountWagered: 500,
      ToWinAmount: 300,
      VolumeAmount: 500,
      InsertDateTime: '2026-05-08 10:00:00.000',
      TicketWriter: 'Internet',
      ShortDesc: 'Test wager',
      VIP: '0',
      AgentLogin: 'AGENT5',
    };

    const alerts = evaluateWager(wager);
    expect(alerts.length).toBe(0);
  });

  test('evaluates multiple wagers', () => {
    const wagers: EnrichedWager[] = [
      {
        WagerNumber: 6,
        AgentID: 'A',
        CustomerID: 'C',
        Login: 'P',
        WagerType: 'M',
        AmountWagered: 100,
        ToWinAmount: 50,
        VolumeAmount: 100,
        InsertDateTime: '2026-05-08 10:00:00.000',
        TicketWriter: 'Internet',
        ShortDesc: 'Normal',
        VIP: '0',
        AgentLogin: 'A',
      },
      {
        WagerNumber: 7,
        AgentID: 'A',
        CustomerID: 'C',
        Login: 'P',
        WagerType: 'M',
        AmountWagered: 60000,
        ToWinAmount: 40000,
        VolumeAmount: 60000,
        InsertDateTime: '2026-05-08 10:00:00.000',
        TicketWriter: 'Internet',
        ShortDesc: 'High',
        VIP: '0',
        AgentLogin: 'A',
      },
    ];

    const alerts = evaluateWagers(wagers);
    expect(alerts.length).toBe(1);
    expect(alerts[0].ruleName).toBe('High Volume Wager');
  });
});

describe('BuckeyeAPI detectChanges', () => {
  test('detects new wagers', async () => {
    const { BuckeyeAPI } = await import('../src/scrapers/BuckeyeAPI');
    const api = new BuckeyeAPI({ agentId: 'TEST', password: 'test' });

    const wagers = [
      { WagerNumber: 100, AmountWagered: 1000, TicketWriter: 'Internet' } as any,
    ];

    const changes = api.detectChanges(wagers);
    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe('new');
  });

  test('detects no changes on identical data', async () => {
    const { BuckeyeAPI } = await import('../src/scrapers/BuckeyeAPI');
    const api = new BuckeyeAPI({ agentId: 'TEST', password: 'test' });

    const wagers = [
      {
        WagerNumber: 200,
        AgentID: 'A',
        CustomerID: 'C',
        Login: 'P',
        WagerType: 'M',
        AmountWagered: 2000,
        ToWinAmount: 1000,
        VolumeAmount: 2000,
        InsertDateTime: '2026-05-08 10:00:00.000',
        TicketWriter: 'Internet',
        ShortDesc: 'Test',
        VIP: '0',
        AgentLogin: 'A',
      },
    ];

    api.detectChanges(wagers);
    const changes2 = api.detectChanges(wagers);
    expect(changes2.length).toBe(0);
  });
});

describe('BuckeyeScraperManager hierarchy', () => {
  test('returns unauthenticated response without an active Buckeye agent', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager({} as any, () => {}, false);

    const result = await manager.getAgentHierarchy();

    expect(result.GENERAL).toEqual([]);
    expect(result.message).toContain('Not authenticated');
  });

  test('uses requested active agent for hierarchy lookups', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager({} as any, () => {}, false);
    const calls: string[] = [];

    (manager as any).agents.set('A1', {
      api: {
        isAuthenticated: () => true,
        getAgentHierarchy: async () => {
          calls.push('A1');
          return { GENERAL: [{ Login: 'A1' }] };
        },
      },
    });
    (manager as any).agents.set('A2', {
      api: {
        isAuthenticated: () => true,
        getAgentHierarchy: async () => {
          calls.push('A2');
          return { GENERAL: [{ Login: 'A2' }] };
        },
      },
    });

    const result = await manager.getAgentHierarchy('A2');

    expect(calls).toEqual(['A2']);
    expect(result.GENERAL[0].Login).toBe('A2');
  });
});
