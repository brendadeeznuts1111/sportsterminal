import { describe, test, expect } from 'bun:test';
import { evaluateWager, evaluateWagers } from '../src/risk/AlertEngine';
import { loadLocalAgentHierarchy } from '../src/api/helpers';
import {
  parseAgentPerformanceReport,
  parsePlayerPerformanceReport,
  parseTransactionList,
  parseWeeklyFigureSummary,
  sanitizeBuckeyeLogin,
} from '../src/scrapers/BuckeyeAPI';
import type { EnrichedWager } from '../src/risk/AlertEngine';
import { classifyPlayer360Freshness } from '../src/player360/policies';
import type { AgentDelta } from '../src/scrapers/LiveAgentTree';
import type { BuckeyeAgentPerformanceOptions, BuckeyeWeeklyFigureOptions } from '../src/scrapers/BuckeyeAPI';
import type { Database } from '../src/database';
import type { BuckeyeScraperManager } from '../src/scrapers/ScraperManager';

interface TestAgentEntry {
  api: {
    isAuthenticated: () => boolean;
    getAgentHierarchy?: () => Promise<{ GENERAL: Array<Record<string, unknown>> }>;
    getWeeklyFigureByAgentLite?: (options: BuckeyeWeeklyFigureOptions) => Promise<{ data: { GENERAL: Array<Record<string, unknown>> } }>;
    getManagerSnapshot?: () => Promise<{ agentId: string; sportsType: Array<Record<string, unknown>> }>;
    getAgentPerformanceReport?: (options: BuckeyeAgentPerformanceOptions) => Promise<Record<string, unknown>>;
  };
}

interface ManagerAgentBridge {
  agents: Map<string, TestAgentEntry>;
}

interface BuckeyeRequestField {
  key: string;
}

interface LocalHierarchyAgent {
  Level?: unknown;
  PlayerCount?: unknown;
  ParentAgentID?: unknown;
}

function testDatabase(db: object): Database {
  return db as unknown as Database;
}

function managerAgents(manager: BuckeyeScraperManager): Map<string, TestAgentEntry> {
  return (manager as unknown as ManagerAgentBridge).agents;
}

function buckeyeRouteManager(manager: object): BuckeyeScraperManager {
  return manager as unknown as BuckeyeScraperManager;
}

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

    const wagers: EnrichedWager[] = [
      {
        WagerNumber: 100,
        AgentID: 'A',
        CustomerID: 'C',
        Login: 'P',
        WagerType: 'M',
        AmountWagered: 1000,
        ToWinAmount: 900,
        VolumeAmount: 1000,
        InsertDateTime: '2026-05-08 10:00:00.000',
        TicketWriter: 'Internet',
        ShortDesc: 'Test',
        VIP: '0',
        AgentLogin: 'A',
      },
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
    const updates: AgentDelta[] = [];
    tree.onUpdate((delta) => updates.push(delta));

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

    const agent = updates.find((u) => u.agent === 'AGENT1')!;
    const master = updates.find((u) => u.agent === 'MASTER')!;
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

    expect(deltas.find((d) => d.agent === 'AGENT1')!.alert_count).toBe(1);
    expect(deltas.find((d) => d.agent === 'MASTER')!.alert_count).toBe(1);
  });
});

describe('BuckeyeScraperManager hierarchy', () => {
  test('returns unauthenticated response without an active Buckeye agent', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager(testDatabase({}), () => {}, false);

    const result = await manager.getAgentHierarchy();

    expect(result.GENERAL).toEqual([]);
    expect(result.message).toContain('Not authenticated');
  });

  test('uses requested active agent for hierarchy lookups', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager(testDatabase({}), () => {}, false);
    const calls: string[] = [];

    managerAgents(manager).set('A1', {
      api: {
        isAuthenticated: () => true,
        getAgentHierarchy: async () => {
          calls.push('A1');
          return { GENERAL: [{ Login: 'A1' }] };
        },
      },
    });
    managerAgents(manager).set('A2', {
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
    const manager = new BuckeyeScraperManager(testDatabase({}), () => {}, false);

    const result = await manager.getWeeklyFigureByAgentLite(undefined, { week: 0 });

    expect(result.data).toBeNull();
    expect(result.message).toContain('Not authenticated');
  });

  test('uses requested active agent for weekly figure lookups', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager(testDatabase({}), () => {}, false);
    const calls: string[] = [];

    managerAgents(manager).set('A1', {
      api: {
        isAuthenticated: () => true,
        getWeeklyFigureByAgentLite: async () => {
          calls.push('A1');
          return { data: { GENERAL: [{ agent: 'A1' }] } };
        },
      },
    });
    managerAgents(manager).set('A2', {
      api: {
        isAuthenticated: () => true,
        getWeeklyFigureByAgentLite: async (options) => {
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
    expect(result.data?.GENERAL[0].agent).toBe('A2');
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

describe('BuckeyeAPI agent performance parser', () => {
  test('normalizes customer performance rows and redacts login password fragments', () => {
    const parsed = parseAgentPerformanceReport({
      INFO: {
        LIST: [
          {
            CustomerID: 'CF346     ',
            AgentID: 'CHEDDFAM',
            Login: 'CF346 (pw:secret)',
            wagercount: 1,
            Risk: 25.95,
            ToWin: 79.14,
            amountwon: 79.14,
            amountlost: 0,
            volume: 25.95,
            net: 79.14,
          },
          {
            CustomerID: 'CF303     ',
            AgentID: 'CHEDDFAM',
            Login: 'CF303',
            wagercount: '2',
            Risk: '33.5',
            ToWin: 27.91,
            amountwon: 0,
            amountlost: 33.5,
            volume: 27.91,
            net: -33.5,
          },
        ],
      },
    });

    expect(parsed.rows[0]).toEqual({
      customerId: 'CF346',
      agentId: 'CHEDDFAM',
      login: 'CF346',
      wagerCount: 1,
      risk: 25.95,
      toWin: 79.14,
      amountWon: 79.14,
      amountLost: 0,
      volume: 25.95,
      net: 79.14,
    });
    expect(parsed.rows[1].login).toBe('CF303');
    expect(parsed.totals.wagerCount).toBe(3);
    expect(parsed.totals.risk).toBe(59.45);
    expect(parsed.totals.net).toBe(45.64);
    expect(sanitizeBuckeyeLogin('CF999 (pw:anything)')).toBe('CF999');
  });
});

describe('BuckeyeAPI player performance parser', () => {
  test('normalizes getPerformancePlayer object payload with account fallback', () => {
    const parsed = parsePlayerPerformanceReport(
      {
        INFO: {
          Risk: 1500,
          ToWin: 1200,
          volume: 1500,
          net: -300,
        },
      },
      { acc: 'BB1152', agentID: 'BILLY666' }
    );

    expect(parsed.rows[0]).toMatchObject({
      customerId: 'BB1152',
      login: 'BB1152',
      agentId: 'BILLY666',
      risk: 1500,
      toWin: 1200,
      volume: 1500,
      net: -300,
    });
  });
});

describe('BuckeyeAPI transaction list parser', () => {
  test('normalizes getTransactionList ledger rows without treating wagers as deposits', () => {
    const rows = parseTransactionList(
      {
        LIST: [
          {
            DocumentNumber: 618181248,
            TranCode: 'C',
            TranType: 'W',
            Amount: 450000,
            Balance: 450000,
            Description: 'Wager Won',
            TranDateTime: '2022-04-30 22:17:29.480',
            HoldAmount: 0,
            GradeNum: 525520121,
            EnteredBy: 'Internet',
          },
          {
            DocumentNumber: 618276317,
            TranCode: 'D',
            TranType: 'L',
            Amount: 62500,
            Balance: 387500,
            Description: 'Wager Loss',
            TranDateTime: '2022-05-01 16:21:00.910',
            HoldAmount: 0,
            GradeNum: 525591931,
            EnteredBy: 'Internet',
          },
        ],
      },
      { customerId: 'BB1152', agentId: 'BILLY666' }
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: '618181248',
      customerId: 'BB1152',
      login: 'BB1152',
      tranCode: 'C',
      tranType: 'W',
      amount: 4500,
      balance: 4500,
      gradeNum: '525520121',
      category: 'wager_win',
    });
    expect(rows[1].amount).toBe(625);
    expect(rows[1].category).toBe('wager_loss');
  });

  test('normalizes getTransactionHistory aliases into the same ledger contract', () => {
    const rows = parseTransactionList(
      {
        LIST: [
          {
            DocumentNo: 'H-1001',
            TransactionCode: 'C',
            TransactionType: 'DEP',
            Credit: 125000,
            Balance: 225000,
            Details: 'Wire Deposit',
            TransactionDateTime: '2026-05-09 11:05:00',
            Customer: 'BB1152',
          },
          {
            DocumentNo: 'H-1002',
            TransactionCode: 'D',
            TransactionType: 'FEE',
            Debit: 5000,
            Balance: 220000,
            Details: 'Account fee',
            TransactionDate: '2026-05-09',
          },
        ],
      },
      { customerId: 'BB1152', agentId: 'BILLY666', operation: 'getTransactionHistory' }
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'H-1001',
      customerId: 'BB1152',
      login: 'BB1152',
      tranCode: 'C',
      tranType: 'DEP',
      amount: 1250,
      balance: 2250,
      category: 'deposit',
    });
    expect(rows[0].raw.sourceOperation).toBe('getTransactionHistory');
    expect(rows[1].amount).toBe(50);
    expect(rows[1].category).toBe('debit');
  });

  test('normalizes deleted transaction report rows without colliding with active ledger rows', () => {
    const rows = parseTransactionList(
      {
        LIST: [
          {
            DocumentNumber: 1008087067,
            TranDateTime: '2026-05-07 12:33:59.483',
            CustomerID: 'CMM335    ',
            AgentId: 'BMM218A   ',
            MasterAgentID: 'COOPMA',
            TranCode: 'D',
            TranType: 'D',
            Description: 'Customer Withdrawal pp via Telegram Bot (AID: 69fcbef632e128957ffff331)',
            Amount: 1005000,
            DeletedBy: 'SUSHIMATFD',
          },
        ],
      },
      { customerId: 'CMM335', agentId: 'BILLY666', operation: 'getReportDeletedTransactions' }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'deleted-1008087067',
      customerId: 'CMM335',
      login: 'CMM335',
      agentId: 'BMM218A',
      agentLogin: 'BMM218A',
      amount: 10050,
      enteredBy: 'SUSHIMATFD',
      category: 'withdrawal',
    });
    expect(rows[0].raw.sourceOperation).toBe('getReportDeletedTransactions');
  });

  test('classifies free-play rows only when text supports the mapping', () => {
    const rows = parseTransactionList(
      {
        LIST: [
          { DocumentNumber: 'W-1', TranCode: 'C', TranType: 'W', Amount: 5000, Description: 'Wager Won', TranDateTime: '2026-05-09 10:00:00' },
          { DocumentNumber: 'D-1', TranCode: 'C', TranType: 'E', Amount: 10000, Description: 'Customer deposit', TranDateTime: '2026-05-09 10:01:00' },
          { DocumentNumber: 'D-2', TranCode: 'C', TranType: 'E', Amount: 2500, Description: 'Free Play credit promo', TranDateTime: '2026-05-09 10:02:00' },
          { DocumentNumber: 'F-1', TranCode: 'C', TranType: 'F', Amount: 5000, Description: 'Free Play issued', TranDateTime: '2026-05-09 10:03:00' },
          { DocumentNumber: 'H-1', TranCode: 'D', TranType: 'H', Amount: 2000, Description: 'Freeplay redeemed', TranDateTime: '2026-05-09 10:04:00' },
          { DocumentNumber: 'F-2', TranCode: 'D', TranType: 'F', Amount: 1000, Description: 'Free play expired', TranDateTime: '2026-05-09 10:05:00' },
          { DocumentNumber: 'H-2', TranCode: 'C', TranType: 'H', Amount: 750, Description: 'Manual credit pct adjustment', TranDateTime: '2026-05-09 10:06:00' },
          { DocumentNumber: 'F-3', TranCode: 'D', TranType: 'F', Amount: 1200, Description: 'Ledger row', TranDateTime: '2026-05-09 10:07:00' },
          { DocumentNumber: 'M-1', TranCode: 'X', TranType: 'M', Amount: 500, Description: 'Misc row', TranDateTime: '2026-05-09 10:08:00' },
        ],
      },
      { customerId: 'BB1152', agentId: 'BILLY666' }
    );

    expect(rows.find(row => row.id === 'W-1')?.category).toBe('wager_win');
    expect(rows.find(row => row.id === 'D-1')?.category).toBe('deposit');
    expect(rows.find(row => row.id === 'D-2')?.category).toBe('freeplay_issued');
    expect(rows.find(row => row.id === 'F-1')?.category).toBe('freeplay_issued');
    expect(rows.find(row => row.id === 'H-1')?.category).toBe('freeplay_redeemed');
    expect(rows.find(row => row.id === 'F-2')?.category).toBe('freeplay_expired');
    expect(rows.find(row => row.id === 'H-2')?.category).toBe('freeplay_adjustment');
    expect(rows.find(row => row.id === 'F-3')?.category).toBe('debit');
    expect(rows.find(row => row.id === 'M-1')?.category).toBe('other');
  });
});

describe('Player 360 refresh policy classification', () => {
  test('keeps live wager archive fresh when rows exist', () => {
    expect(classifyPlayer360Freshness({
      status: 'live',
      rowCount: 1,
      ttlSeconds: 0,
      lastSeen: '2026-05-09T12:00:00.000Z',
      refreshPolicy: 'live',
    })).toBe('fresh');
  });

  test('marks stale transaction ledger when TTL expires', () => {
    expect(classifyPlayer360Freshness({
      status: 'live',
      rowCount: 4,
      ttlSeconds: 6 * 60 * 60,
      lastSuccessAt: '2026-05-09T00:00:00.000Z',
      refreshPolicy: 'on_open',
      nowMs: new Date('2026-05-09T07:00:00.000Z').getTime(),
    })).toBe('stale');
  });

  test('keeps missing account and teaser profile probes as probe after attempt', () => {
    for (const source of ['customer_snapshots', 'teaser_profile']) {
      expect(classifyPlayer360Freshness({
        status: 'probe',
        rowCount: 0,
        ttlSeconds: 24 * 60 * 60,
        lastAttemptAt: '2026-05-09T00:00:00.000Z',
        refreshPolicy: 'on_open',
      }), source).toBe('probe');
    }
  });

  test('probe endpoints use last attempt TTL instead of refreshing every profile open', async () => {
    const { shouldRefreshPlayer360Source } = await import('../src/player360/policies');
    const nowMs = new Date('2026-05-09T12:00:00.000Z').getTime();

    expect(shouldRefreshPlayer360Source({
      ttlSeconds: 24 * 60 * 60,
      lastAttemptAt: '2026-05-09T11:30:00.000Z',
      nowMs,
    })).toBe(false);

    expect(shouldRefreshPlayer360Source({
      ttlSeconds: 24 * 60 * 60,
      lastAttemptAt: '2026-05-08T11:00:00.000Z',
      nowMs,
    })).toBe(true);
  });
});

describe('BunSecretVault', () => {
  test('indexes multiple Buckeye agents and clears one without removing the other', async () => {
    const { BunSecretVault } = await import('../src/services/BunSecretVault');
    const values = new Map<string, string>();
    const vault = new BunSecretVault({
      get: async ({ service, name }) => values.get(`${service}:${name}`) || null,
      set: async ({ service, name, value }) => {
        values.set(`${service}:${name}`, value);
      },
      delete: async ({ service, name }) => {
        values.delete(`${service}:${name}`);
      },
    });

    await vault.saveBuckeyeSecrets({
      agentId: 'billy666',
      password: 'pw',
      cfCookie: 'cf_clearance=abc',
      token: 'token',
    });
    await vault.saveBuckeyeSecrets({
      agentId: 'second',
      password: 'pw2',
      cfCookie: 'cf_clearance=def',
      token: 'token2',
    });

    expect(await vault.getBuckeyeAgentIds()).toEqual(['BILLY666', 'SECOND']);

    const restored = await vault.getBuckeyeSecrets('billy666');

    expect(restored).toEqual({
      agentId: 'BILLY666',
      password: 'pw',
      cfCookie: 'cf_clearance=abc',
      token: 'token',
    });

    await vault.clearBuckeyeSecrets('BILLY666');

    expect(await vault.getBuckeyeSecrets('BILLY666')).toBeNull();
    expect(await vault.getBuckeyeAgentIds()).toEqual(['SECOND']);
    expect((await vault.getBuckeyeSecrets('SECOND'))?.token).toBe('token2');

    await vault.clearAllBuckeyeSecrets();

    expect(await vault.getBuckeyeAgentIds()).toEqual([]);
    expect(await vault.getBuckeyeSecrets('SECOND')).toBeNull();
  });
});

describe('Buckeye vault routes', () => {
  test('returns presence-only vault status for all agents and clears one stored agent', async () => {
    const { registerBuckeyeRoutes } = await import('../src/api/routes/buckeye');
    const { BunSecretVault } = await import('../src/services/BunSecretVault');
    const values = new Map<string, string>();
    const vault = new BunSecretVault({
      get: async ({ service, name }) => values.get(`${service}:${name}`) || null,
      set: async ({ service, name, value }) => {
        values.set(`${service}:${name}`, value);
      },
      delete: async ({ service, name }) => {
        values.delete(`${service}:${name}`);
      },
    });
    await vault.saveBuckeyeSecrets({
      agentId: 'BILLY666',
      password: 'secret',
      cfCookie: 'cf_clearance=abc',
      token: 'bearer',
    });
    await vault.saveBuckeyeSecrets({
      agentId: 'SECOND',
      password: 'secret2',
      token: 'bearer2',
    });
    const manager = {
      isAgentActive: (agentId: string) => agentId === 'BILLY666',
      getAgentLastError: (agentId: string) => (agentId === 'SECOND' ? 'bad cookie' : undefined),
      stopAgent: () => undefined,
    } as unknown as BuckeyeScraperManager;

    const statusResponse = await registerBuckeyeRoutes(
      new URL('http://localhost/api/buckeye/vault-status'),
      new Request('http://localhost/api/buckeye/vault-status'),
      manager,
      vault
    );
    const status = await statusResponse!.json();

    expect(status.available).toBe(true);
    expect(status.agents).toContainEqual({
      agentId: 'BILLY666',
      hasPassword: true,
      hasCfCookie: true,
      hasToken: true,
      active: true,
    });
    expect(status.agents).toContainEqual({
      agentId: 'SECOND',
      hasPassword: true,
      hasCfCookie: false,
      hasToken: true,
      active: false,
      lastError: 'bad cookie',
    });
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(JSON.stringify(status)).not.toContain('bearer');

    const clearResponse = await registerBuckeyeRoutes(
      new URL('http://localhost/api/buckeye/vault-status?agentId=BILLY666'),
      new Request('http://localhost/api/buckeye/vault-status?agentId=BILLY666', { method: 'DELETE' }),
      manager,
      vault
    );
    const clear = await clearResponse!.json();

    expect(clear.success).toBe(true);
    expect(await vault.getBuckeyeSecrets('BILLY666')).toBeNull();
    expect((await vault.getBuckeyeSecrets('SECOND'))?.token).toBe('bearer2');
  });
});

describe('Buckeye vault restore', () => {
  test('restores vaulted agents independently and falls back from token resume to password login', async () => {
    const { BunSecretVault } = await import('../src/services/BunSecretVault');
    const { restoreBuckeyeAgentsFromVault } = await import('../src/services/BuckeyeVaultRestore');
    const values = new Map<string, string>();
    const vault = new BunSecretVault({
      get: async ({ service, name }) => values.get(`${service}:${name}`) || null,
      set: async ({ service, name, value }) => {
        values.set(`${service}:${name}`, value);
      },
      delete: async ({ service, name }) => {
        values.delete(`${service}:${name}`);
      },
    });
    await vault.saveBuckeyeSecrets({ agentId: 'A1', password: 'pw1', token: 'token1' });
    await vault.saveBuckeyeSecrets({ agentId: 'A2', password: 'pw2', token: 'token2' });
    await vault.saveBuckeyeSecrets({ agentId: 'A3', password: 'pw3' });

    const calls: string[] = [];
    const manager = {
      resumeAgent: async (agentId: string) => {
        calls.push(`resume:${agentId}`);
        return agentId === 'A1';
      },
      startAgent: async (agentId: string) => {
        calls.push(`start:${agentId}`);
        if (agentId === 'A3') throw new Error('login failed');
      },
    } as unknown as BuckeyeScraperManager;

    const result = await restoreBuckeyeAgentsFromVault(vault, manager, 'https://example.test');

    expect(calls).toEqual(['resume:A1', 'resume:A2', 'start:A2', 'start:A3']);
    expect(result.restored).toEqual(['A1', 'A2']);
    expect(result.failed).toEqual([{ agentId: 'A3', error: 'login failed' }]);
  });
});

describe('BuckeyeScraperManager manager snapshot', () => {
  test('returns unauthenticated response without an active Buckeye agent', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager(testDatabase({}), () => {}, false);

    const result = await manager.getBuckeyeManagerSnapshot();

    expect(result.data).toBeNull();
    expect(result.message).toContain('Not authenticated');
  });

  test('uses requested active agent for manager snapshot lookups', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager(testDatabase({}), () => {}, false);
    const calls: string[] = [];

    managerAgents(manager).set('A1', {
      api: {
        isAuthenticated: () => true,
        getManagerSnapshot: async () => {
          calls.push('A1');
          return { agentId: 'A1', sportsType: [] };
        },
      },
    });
    managerAgents(manager).set('A2', {
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
    const manager = new BuckeyeScraperManager(testDatabase({}), () => {}, false);

    const result = await manager.getBuckeyeAgentPerformanceReport(undefined, {
      start: '04/28/2026',
      end: '05/09/2026',
    });

    expect(result.data).toBeNull();
    expect(result.message).toContain('Not authenticated');
  });

  test('uses requested active agent for Buckeye agent performance lookups', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const manager = new BuckeyeScraperManager(testDatabase({}), () => {}, false);
    const calls: string[] = [];

    managerAgents(manager).set('A1', {
      api: {
        isAuthenticated: () => true,
        getAgentPerformanceReport: async () => {
          calls.push('A1');
          return { agentId: 'A1', data: [] };
        },
      },
    });
    managerAgents(manager).set('A2', {
      api: {
        isAuthenticated: () => true,
        getAgentPerformanceReport: async (options) => {
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
    expect(result.data?.[0].Agent).toBe('A2');
  });

  test('persists parsed Buckeye agent performance snapshots and checkpoint', async () => {
    const { BuckeyeScraperManager } = await import('../src/scrapers/ScraperManager');
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      run: async (sql: string, params: unknown[] = []) => {
        writes.push({ sql, params });
        return { lastID: 0, changes: 1 };
      },
    };
    const manager = new BuckeyeScraperManager(testDatabase(db), () => {}, false);

    managerAgents(manager).set('A1', {
      api: {
        isAuthenticated: () => true,
        getAgentPerformanceReport: async () => ({
          fetchedAt: '2026-05-09T12:00:00.000Z',
          agentId: 'A1',
          params: {
            start: '04/28/2026',
            end: '05/09/2026',
            agentID: 'BILLY666',
            type: 'CP',
            freePlay: 'Y',
            store: 'BILLY666',
            sport: 'Basketball',
            subsport: 'NBA',
            period: '-1',
            wagerType: '',
            betType: '',
            tipo: '0',
            debug: '0',
            operation: 'getAgentPerformance',
            RRO: '1',
            agentOwner: 'SHARPTOBBY',
            agentSite: '1',
            group: '',
          },
          parsed: {
            rows: [
              {
                customerId: 'CF346',
                agentId: 'CHEDDFAM',
                login: 'CF346',
                wagerCount: 1,
                risk: 25.95,
                toWin: 79.14,
                amountWon: 79.14,
                amountLost: 0,
                volume: 25.95,
                net: 79.14,
              },
            ],
            totals: {
              wagerCount: 1,
              risk: 25.95,
              toWin: 79.14,
              amountWon: 79.14,
              amountLost: 0,
              volume: 25.95,
              net: 79.14,
            },
          },
          data: {
            INFO: {
              LIST: [
                {
                  CustomerID: 'CF346',
                  AgentID: 'CHEDDFAM',
                  Login: 'CF346',
                },
              ],
            },
          },
          redactedFields: ['LIST[0].Login'],
        }),
      },
    });

    await manager.getBuckeyeAgentPerformanceReport('A1', {
      start: '04/28/2026',
      end: '05/09/2026',
    });

    const snapshotWrite = writes.find((write) => write.sql.includes('agent_performance_snapshots'));
    const checkpointWrite = writes.find((write) => write.sql.includes('agent_performance'));

    expect(snapshotWrite).toBeDefined();
    expect(snapshotWrite!.params.slice(0, 5)).toEqual([
      'BILLY666',
      'CF346',
      'CHEDDFAM',
      'CF346',
      'CP',
    ]);
    expect(checkpointWrite).toBeDefined();
  });
});

describe('Buckeye agent performance options', () => {
  test('documents all Buckeye getAgentPerformance form fields', async () => {
    const { registerBuckeyeRoutes } = await import('../src/api/routes/buckeye');
    const response = await Promise.resolve(registerBuckeyeRoutes(
      new URL('http://localhost/api/buckeye/agent-performance/options'),
      new Request('http://localhost/api/buckeye/agent-performance/options'),
      buckeyeRouteManager({})
    ));

    expect(response).not.toBeNull();
    const body = await response!.json();
    const keys = body.requestFields.map((field: BuckeyeRequestField) => field.key);

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
      } as unknown as BuckeyeScraperManager
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

    const child = result.GENERAL.find((agent: LocalHierarchyAgent) => Number(agent.Level) > 1);
    expect(child?.ParentAgentID).toBeTruthy();
    expect(result.GENERAL.some((agent: LocalHierarchyAgent) => Number(agent.PlayerCount) > 0)).toBe(true);
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
    const manager = new BuckeyeScraperManager(testDatabase(fakeDb), () => {}, false);

    const result = await manager.getPlayerDetails('PLAYER1');

    expect(getSql[0]).toContain('projected_net_exposure');
    expect(result.profile.projected_net_exposure).toBe(50);
  });
});
