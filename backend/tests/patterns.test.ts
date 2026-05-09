import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { AppDatabase, type Database } from '../src/database';
import { buildManagerOperationBody, buildWebLogBody, validateWebLogRange } from '../src/scrapers/BuckeyeAPI';
import { PatternService } from '../src/patterns/PatternService';
import { parseWagerDescription } from '../src/patterns/wagerParser';
import type { EnrichedWager } from '../src/risk/AlertEngine';

let db: Database;

beforeEach(async () => {
  db = new AppDatabase(':memory:');
  await db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      league TEXT,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      start_time TEXT,
      status TEXT DEFAULT 'upcoming',
      last_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      book TEXT NOT NULL,
      spread_home REAL,
      spread_away REAL,
      spread_home_price REAL,
      spread_away_price REAL,
      total_over REAL,
      total_under REAL,
      total_over_price REAL,
      total_under_price REAL,
      moneyline_home REAL,
      moneyline_away REAL,
      scraped_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE line_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      book TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      old_value REAL NOT NULL,
      new_value REAL NOT NULL,
      delta REAL NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE wagers (
      wager_number INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      login TEXT NOT NULL,
      wager_type TEXT,
      amount_wagered INTEGER NOT NULL,
      to_win_amount INTEGER NOT NULL,
      volume_amount INTEGER NOT NULL,
      insert_datetime TEXT NOT NULL,
      ticket_writer TEXT NOT NULL,
      short_desc TEXT NOT NULL,
      vip TEXT NOT NULL,
      agent_login TEXT NOT NULL,
      sport TEXT,
      parsed_game TEXT,
      parsed_market TEXT,
      parsed_side TEXT,
      parsed_price REAL,
      parsed_period TEXT,
      matched_event_id TEXT,
      pin_reference_json TEXT,
      scraped_at TEXT NOT NULL
    );

    CREATE TABLE detected_patterns (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      severity TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'odds',
      wager_number INTEGER,
      agent_login TEXT,
      trigger_book TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      description TEXT,
      detected_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE pattern_agents (
      pattern_id TEXT NOT NULL,
      agent_login TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (pattern_id, agent_login)
    );

    CREATE TABLE access_logs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      login_id TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      access_datetime TEXT NOT NULL,
      operation TEXT,
      data TEXT,
      log_type TEXT NOT NULL,
      pulled_at TEXT NOT NULL,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
});

afterEach(async () => {
  await db.close();
});

describe('ShortDesc pattern parsing', () => {
  test('parses spread with price', () => {
    const parsed = parseWagerDescription('M:Basketball #123 76ers vs Knicks -4½ -110');
    expect(parsed.market).toBe('spread');
    expect(parsed.game).toContain('76ers vs Knicks');
    expect(parsed.price).toBe(-110);
    expect(parsed.teams).toEqual(['76ers', 'Knicks']);
  });

  test('parses total and live period', () => {
    const parsed = parseWagerDescription('M.G123456 - Top Soccer - Arsenal vs Chelsea / Over 2½ -105');
    expect(parsed.market).toBe('total');
    expect(parsed.side).toBe('over');
    expect(parsed.period).toBe('live');
  });
});

describe('Buckeye getWebLog helpers', () => {
  test('builds Buckeye IP tracker request body', () => {
    const body = buildWebLogBody('AGENT1', {
      customerID: 0,
      start: '2026-05-01',
      end: '2026-05-02',
      type: 'A',
      actions: 'LOGIN',
      ip: '1.2.3.4',
    });
    expect(body.get('operation')).toBe('getWebLog');
    expect(body.get('agentID')).toBe('AGENT1');
    expect(body.get('start')).toBe('05/01/2026');
    expect(body.get('RRO')).toBe('1');
  });

  test('enforces users-by-IP 7 day limit', () => {
    expect(() => validateWebLogRange({ start: '2026-05-01', end: '2026-05-09', type: 'I' })).toThrow();
    expect(() => validateWebLogRange({ start: '2026-05-01', end: '2026-05-09', type: 'A' })).not.toThrow();
  });
});

describe('Buckeye manager operation helpers', () => {
  test('builds manager bootstrap request body', () => {
    const body = buildManagerOperationBody('AGENT1', 'getSportsType');

    expect(body.get('agentID')).toBe('AGENT1');
    expect(body.get('operation')).toBe('getSportsType');
    expect(body.get('agentOwner')).toBe('AGENT1');
    expect(body.get('agentSite')).toBe('1');
    expect(body.get('RRO')).toBe('1');
  });

  test('adds account parameters for message-style operations', () => {
    const body = buildManagerOperationBody('AGENT1', 'getMessage', {
      acc: 'AGENT1',
      type: '0',
    });

    expect(body.get('acc')).toBe('AGENT1');
    expect(body.get('type')).toBe('0');
  });
});

describe('PatternService detectors', () => {
  test('detects agent swarm and past-post risk from correlated wagers', async () => {
    const service = new PatternService(db);
    const start = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const wagerTime = new Date().toISOString();

    await db.run(
      `INSERT INTO events (id, sport, league, home_team, away_team, start_time, status, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['evt-1', 'Basketball', 'NBA', 'Knicks', '76ers', start, 'live', wagerTime]
    );

    for (let i = 1; i <= 4; i++) {
      await db.run(
        `INSERT INTO wagers
          (wager_number, agent_id, customer_id, login, wager_type, amount_wagered, to_win_amount, volume_amount,
           insert_datetime, ticket_writer, short_desc, vip, agent_login, sport, parsed_game, parsed_market, parsed_side,
           parsed_price, parsed_period, matched_event_id, pin_reference_json, scraped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          i,
          'A1',
          `C${i}`,
          `player${i}`,
          'M',
          100,
          90,
          100,
          wagerTime,
          i === 4 ? 'ONLINE' : 'GSLIVE',
          'M:Basketball #123 76ers vs Knicks -4½ -110',
          '0',
          'agent-one',
          'Basketball',
          '76ers vs Knicks',
          'spread',
          '76ers',
          -110,
          'game',
          'evt-1',
          '{}',
          wagerTime,
        ]
      );
    }

    const wager = makeWager(4, wagerTime);
    const correlation = await service.correlateWager(wager);
    const patterns = await service.analyzeWager(wager, correlation);

    expect(patterns.some(p => p.type === 'Agent Swarm')).toBe(true);
    expect(patterns.some(p => p.type === 'Live Past-Post Risk' && p.severity === 'critical')).toBe(true);
  });

  test('detects shared IP clusters from access logs', async () => {
    const service = new PatternService(db);
    await service.persistAccessLogs('agent-one', [
      { LoginID: 'player1', IPAddress: '10.10.10.10', AccessDateTime: new Date().toISOString(), Operation: 'login', Data: '', raw: {} },
      { LoginID: 'player2', IPAddress: '10.10.10.10', AccessDateTime: new Date().toISOString(), Operation: 'login', Data: '', raw: {} },
    ], 'A');

    const patterns = await service.analyzeAccessLogs('agent-one');
    expect(patterns.some(p => p.type === 'Shared IP Cluster' && p.category === 'ip')).toBe(true);
  });
});

function makeWager(wagerNumber: number, insertDateTime: string): EnrichedWager {
  return {
    WagerNumber: wagerNumber,
    AgentID: 'A1',
    CustomerID: `C${wagerNumber}`,
    Login: `player${wagerNumber}`,
    WagerType: 'M',
    AmountWagered: 100,
    ToWinAmount: 90,
    VolumeAmount: 100,
    InsertDateTime: insertDateTime,
    TicketWriter: 'ONLINE',
    ShortDesc: 'M:Basketball #123 76ers vs Knicks -4½ -110',
    VIP: '0',
    AgentLogin: 'agent-one',
  };
}
