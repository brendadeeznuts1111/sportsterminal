import { describe, test, expect } from 'bun:test';
import { evaluateWager, evaluateWagers } from '../src/risk/AlertEngine';
import { loadLocalAgentHierarchy } from '../src/api/helpers';
import { parseWeeklyFigureSummary } from '../src/scrapers/BuckeyeAPI';
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

describe('BuckeyeAPI weekly figure parser', () => {
  test('normalizes Buckeye LIST.ARRAY weekly summary', () => {
    const parsed = parseWeeklyFigureSummary({
      LIST: {
        ARRAY: [
          {
            ThisWeek: 463667.8025000004,
            Active: 4224,
            Today: 5469.419999999999,
          },
        ],
        INFO: 'INFO',
      },
    });

    expect(parsed.thisWeek).toBe(463667.8025000004);
    expect(parsed.active).toBe(4224);
    expect(parsed.today).toBe(5469.419999999999);
    expect(parsed.info).toBe('INFO');
  });
});

describe('BuckeyeScraperManager manager snapshot', () => {
  test('returns unauthenticated response without an active Buckeye agent', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager({} as any, () => {}, false);

    const result = await manager.getBuckeyeManagerSnapshot();

    expect(result.data).toBeNull();
    expect(result.message).toContain('Not authenticated');
  });

  test('uses requested active agent for manager snapshot lookups', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager({} as any, () => {}, false);
    const calls: string[] = [];

    (manager as any).agents.set('A1', {
      api: {
        isAuthenticated: () => true,
        getManagerSnapshot: async () => {
          calls.push('A1');
          return { agentId: 'A1', sportsType: [] };
        },
      },
    });
    (manager as any).agents.set('A2', {
      api: {
        isAuthenticated: () => true,
        getManagerSnapshot: async () => {
          calls.push('A2');
          return { agentId: 'A2', sportsType: [{ Sport: 'Baseball' }] };
        },
      },
    });

    const result = await manager.getBuckeyeManagerSnapshot('A2');

    expect(calls).toEqual(['A2']);
    expect(result.agentId).toBe('A2');
    expect(result.sportsType[0].Sport).toBe('Baseball');
  });
});

describe('BuckeyeScraperManager Buckeye agent performance report', () => {
  test('returns unauthenticated response without an active Buckeye agent', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager({} as any, () => {}, false);

    const result = await manager.getBuckeyeAgentPerformanceReport(undefined, {
      start: '04/28/2026',
      end: '05/09/2026',
    });

    expect(result.data).toBeNull();
    expect(result.message).toContain('Not authenticated');
  });

  test('uses requested active agent for Buckeye agent performance lookups', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager({} as any, () => {}, false);
    const calls: string[] = [];

    (manager as any).agents.set('A1', {
      api: {
        isAuthenticated: () => true,
        getAgentPerformanceReport: async () => {
          calls.push('A1');
          return { agentId: 'A1', data: [] };
        },
      },
    });
    (manager as any).agents.set('A2', {
      api: {
        isAuthenticated: () => true,
        getAgentPerformanceReport: async (options: any) => {
          calls.push(`A2:${options.start}:${options.end}:${options.type}`);
          return { agentId: 'A2', data: [{ Agent: 'A2' }] };
        },
      },
    });

    const result = await manager.getBuckeyeAgentPerformanceReport('A2', {
      start: '04/28/2026',
      end: '05/09/2026',
      type: 'CP',
    });

    expect(calls).toEqual(['A2:04/28/2026:05/09/2026:CP']);
    expect(result.data[0].Agent).toBe('A2');
  });
});

describe('Buckeye agent performance options', () => {
  test('documents all Buckeye getAgentPerformance form fields', async () => {
    const { registerBuckeyeRoutes } = await import('../src/api/routes/buckeye');
    const response = registerBuckeyeRoutes(
      new URL('http://localhost/api/buckeye/agent-performance/options'),
      new Request('http://localhost/api/buckeye/agent-performance/options'),
      {} as any
    );

    expect(response).not.toBeNull();
    const body = await response!.json();
    const keys = body.requestFields.map((field: any) => field.key);

    for (const key of [
      'start',
      'end',
      'agentID',
      'type',
      'freePlay',
      'store',
      'sport',
      'subsport',
      'period',
      'wagerType',
      'betType',
      'tipo',
      'debug',
      'operation',
      'RRO',
      'agentOwner',
      'agentSite',
    ]) {
      expect(keys).toContain(key);
    }
    expect(body.activities).toContainEqual({ value: '0', label: 'Sports' });
    expect(body.sports).toContainEqual({
      value: 'Basketball',
      label: 'Basketball',
      rawValue: 'Basketball          ',
    });
    expect(body.periods).toContainEqual({ value: '-1', label: 'All Periods' });
  });

  test('returns seeded Buckeye sports type payload shape', async () => {
    const { registerBuckeyeRoutes } = await import('../src/api/routes/buckeye');
    const response = await registerBuckeyeRoutes(
      new URL('http://localhost/api/buckeye/sports-types'),
      new Request('http://localhost/api/buckeye/sports-types'),
      {
        getBuckeyeSportTypes: async () => [
          {
            raw_value: 'Basketball          ',
            label: 'Basketball',
            sort_order: 2,
            source: 'seed',
          },
        ],
      } as any
    );

    expect(response).not.toBeNull();
    const body = await response!.json();
    expect(body.LIST[0]).toEqual({
      sportType: 'Basketball          ',
      '0': 'Basketball          ',
      label: 'Basketball',
      value: 'Basketball',
      sortOrder: 2,
      source: 'seed',
    });
  });
});

describe('local Buckeye hierarchy exports', () => {
  test('enriches raw hierarchy with parent links and player counts', async () => {
    const result = await loadLocalAgentHierarchy();

    expect(Array.isArray(result.GENERAL)).toBe(true);
    if (result.GENERAL.length === 0) return;

    const child = result.GENERAL.find((agent: any) => Number(agent.Level) > 1);
    expect(child?.ParentAgentID).toBeTruthy();
    expect(result.GENERAL.some((agent: any) => Number(agent.PlayerCount) > 0)).toBe(true);
    expect(result.meta?.hasPlayerPasswords).toBe(false);
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
