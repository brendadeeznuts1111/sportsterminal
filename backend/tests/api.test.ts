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

describe('BuckeyeAPI ui config parser', () => {
  test('extracts bet type labels from nested UI language JSON', async () => {
    const { parseBuckeyeUiConfig } = await import('../src/scrapers/BuckeyeAPI');

    const parsed = parseBuckeyeUiConfig({
      manager: {
        wagerTypes: {
          M: 'Straight',
          P: 'Parlay',
          T: 'Teaser',
        },
        markets: {
          betTypeFuture: 'Future',
        },
      },
    });

    expect(parsed.betTypes).toContainEqual({
      code: 'M',
      label: 'Straight',
      path: 'manager.wagerTypes.M',
    });
    expect(parsed.betTypes.some((type) => type.label === 'Future')).toBe(true);
  });

  test('extracts boolean feature flags and sportsbook strings', async () => {
    const { parseBuckeyeUiConfig } = await import('../src/scrapers/BuckeyeAPI');

    const parsed = parseBuckeyeUiConfig({
      features: {
        enableLiveBetting: true,
        showPropBuilder: false,
      },
      labels: {
        liveBetTicket: 'Live Bet Ticket',
        account: 'Account',
      },
    });

    expect(parsed.featureFlags).toContainEqual({
      path: 'features.enableLiveBetting',
      key: 'enableLiveBetting',
      value: true,
    });
    expect(parsed.featureFlags).toContainEqual({
      path: 'features.showPropBuilder',
      key: 'showPropBuilder',
      value: false,
    });
    expect(parsed.sportsbookStrings.some((entry) => entry.value === 'Live Bet Ticket')).toBe(true);
    expect(parsed.sportsbookStrings.some((entry) => entry.value === 'Account')).toBe(false);
  });
});

describe('BuckeyeAPI account info parser', () => {
  test('redacts sensitive fields and extracts account capabilities', async () => {
    const { buildAccountInfoResult } = await import('../src/scrapers/BuckeyeAPI');

    const result = buildAccountInfoResult('BILLY666', {
      accountInfo: {
        customerID: 'BILLY666',
        Login: 'BILLY666  ',
        AgentType: 'M',
        Office: 'NOLAROSE',
        Skin: 'skin-e',
        DefaultSiteSkin: 'RiseOfSnake',
        Language: 'English',
        CurrencyCode: 'USD',
        TimeZone: 1,
        CurrentBalance: -163545500,
        AvailableBalance: -1635455,
        Password: 'secret',
        PasswordFix: 'secret-fix',
        SMSPhoneNumber: 5551234567,
        AllowPropBuilder: 'Y',
        DenyLiveBetting: 'Y',
        AllowFlashBets: 'N',
        MaxPropPayout: 10000,
      },
      preferenceDate: [{ Theme: 'theme1/theme1.css' }],
      site: [],
      SERVER: { date: '2026-05-08 23:41:52.680' },
    });

    expect(result.accountInfo.Password).toBe('REDACTED');
    expect(result.accountInfo.PasswordFix).toBe('REDACTED');
    expect(result.accountInfo.SMSPhoneNumber).toBe('REDACTED');
    expect(result.redactedFields).toContain('Password');
    expect(result.parsed.accountId).toBe('BILLY666');
    expect(result.parsed.login).toBe('BILLY666');
    expect(result.parsed.balances.current).toBe(-1635455);
    expect(result.parsed.balances.available).toBe(-16354.55);
    expect(result.parsed.limits.MaxPropPayout).toBe(100);
    expect(result.parsed.featureFlags).toContainEqual({
      key: 'AllowPropBuilder',
      value: true,
      raw: 'Y',
    });
    expect(result.parsed.featureFlags).toContainEqual({
      key: 'DenyLiveBetting',
      value: true,
      raw: 'Y',
    });
    expect(result.parsed.featureFlags).toContainEqual({
      key: 'AllowFlashBets',
      value: false,
      raw: 'N',
    });
  });
});

describe('LiveAgentTree', () => {
  test('processes a wager and propagates risk to parent agents', async () => {
    const { LiveAgentTree } = await import('../src/scrapers/LiveAgentTree');
    const tree = new LiveAgentTree([
      { AgentID: 'M1', Login: 'MASTER', AgentType: 'M', Level: 1, SeqNumber: 1 },
      { AgentID: 'A1', Login: 'AGENT1', AgentType: 'A', Level: 2, SeqNumber: 2 },
    ]);
    const updates: any[] = [];
    tree.onUpdate((delta: any) => updates.push(delta));

    tree.processWager({
      WagerNumber: 1,
      AgentID: 'A1',
      CustomerID: 'C1',
      Login: 'PLAYER1',
      WagerType: 'M',
      AmountWagered: 100,
      ToWinAmount: 90,
      VolumeAmount: 100,
      InsertDateTime: '2026-05-09 00:00:00.000',
      TicketWriter: 'Internet',
      ShortDesc: 'M.Football #123 Eagles - For Game',
      VIP: '0',
      AgentLogin: 'AGENT1',
    });

    const agent = updates.find((u) => u.agent === 'AGENT1');
    const master = updates.find((u) => u.agent === 'MASTER');
    expect(agent.total_volume).toBe(100);
    expect(agent.total_risk).toBe(100);
    expect(agent.wager_count).toBe(1);
    expect(agent.top_game).toBe('Eagles');
    expect(master.total_volume).toBe(100);
    expect(master.total_risk).toBe(100);
  });

  test('increments alert counts up the tree', async () => {
    const { LiveAgentTree } = await import('../src/scrapers/LiveAgentTree');
    const tree = new LiveAgentTree([
      { AgentID: 'M1', Login: 'MASTER', AgentType: 'M', Level: 1, SeqNumber: 1 },
      { AgentID: 'A1', Login: 'AGENT1', AgentType: 'A', Level: 2, SeqNumber: 2 },
    ]);

    const deltas = tree.processAlert('AGENT1');

    expect(deltas.find((d: any) => d.agent === 'AGENT1').alert_count).toBe(1);
    expect(deltas.find((d: any) => d.agent === 'MASTER').alert_count).toBe(1);
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

describe('BuckeyeScraperManager weekly figures', () => {
  test('returns unauthenticated response without an active Buckeye agent', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager({} as any, () => {}, false);

    const result = await manager.getWeeklyFigureByAgentLite(undefined, { week: 0 });

    expect(result.data).toBeNull();
    expect(result.message).toContain('Not authenticated');
  });

  test('uses requested active agent for weekly figure lookups', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager({} as any, () => {}, false);
    const calls: string[] = [];

    (manager as any).agents.set('A1', {
      api: {
        isAuthenticated: () => true,
        getWeeklyFigureByAgentLite: async () => {
          calls.push('A1');
          return { data: { GENERAL: [{ agent: 'A1' }] } };
        },
      },
    });
    (manager as any).agents.set('A2', {
      api: {
        isAuthenticated: () => true,
        getWeeklyFigureByAgentLite: async (options: any) => {
          calls.push(`A2:${options.week}:${options.type}:${options.layout}`);
          return { data: { GENERAL: [{ agent: 'A2' }] } };
        },
      },
    });

    const result = await manager.getWeeklyFigureByAgentLite('A2', {
      week: 0,
      type: 'A',
      layout: 'byDay',
    });

    expect(calls).toEqual(['A2:0:A:byDay']);
    expect(result.data.GENERAL[0].agent).toBe('A2');
  });
});

describe('BuckeyeScraperManager player details', () => {
  test('returns projected net exposure from the player detail endpoint data', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const getSql: string[] = [];
    const fakeDb = {
      get: async (sql: string) => {
        getSql.push(sql);
        return {
          login: 'PLAYER1',
          agent_login: 'AGENT1',
          wager_count: 2,
          total_volume: 300,
          total_potential_payout: 250,
          projected_net_exposure: 50,
        };
      },
      all: async () => [{ agent_login: 'AGENT1' }],
    };
    const manager = new BuckeyeScraperManager(fakeDb as any, () => {}, false);

    const result = await manager.getPlayerDetails('PLAYER1');

    expect(getSql[0]).toContain('projected_net_exposure');
    expect(result.profile.projected_net_exposure).toBe(50);
  });
});
