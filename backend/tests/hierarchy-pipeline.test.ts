import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDatabase, type Database } from '../src/database';
import { registerAnalyticsRoutes } from '../src/api/routes/analytics';
import { backfillAgentsAndPlayers } from '../src/services/HierarchyBackfillService';
import { BuckeyeScraperManager, type BuckeyeScraperManager as ScraperManagerType } from '../src/scrapers/ScraperManager';
import type { EnrichedWager } from '../src/risk/AlertEngine';

let db: Database;
const originalAdminToken = process.env.ADMIN_API_TOKEN;
const originalDuckDbBin = process.env.DUCKDB_BIN;

beforeEach(async () => {
  db = await initDatabase(':memory:');
});

afterEach(async () => {
  await db.close();
  if (originalAdminToken === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = originalAdminToken;
  if (originalDuckDbBin === undefined) delete process.env.DUCKDB_BIN;
  else process.env.DUCKDB_BIN = originalDuckDbBin;
});

describe('static hierarchy pipeline', () => {
  test('parses seed files, strips player passwords, and builds closure rows', async () => {
    const { agentsPath, playersPath } = await writeSeedFiles();

    const result = await backfillAgentsAndPlayers(db, {
      agentPaths: [agentsPath],
      playerPaths: [playersPath],
      source: 'test_seed',
    });

    expect(result.agents).toBe(3);
    expect(result.players).toBe(1);
    expect(result.linkedPlayers).toBe(1);

    const child = await db.get<{ agent_id: string; login: string; parent_agent_id: string; level: number }>(
      `SELECT agent_id, login, parent_agent_id, level FROM agent_hierarchy WHERE login = 'CHILD'`
    );
    expect(child).toEqual({
      agent_id: 'CHILD',
      login: 'CHILD',
      parent_agent_id: 'ROOT',
      level: 2,
    });

    const closure = await db.all<{ ancestor: string; descendant: string; depth: number }>(
      `SELECT ancestor, descendant, depth
       FROM agent_closure
       WHERE provider = 'buckeye' AND descendant = 'GRAND'
       ORDER BY depth DESC`
    );
    expect(closure).toEqual([
      { ancestor: 'ROOT', descendant: 'GRAND', depth: 2 },
      { ancestor: 'CHILD', descendant: 'GRAND', depth: 1 },
      { ancestor: 'GRAND', descendant: 'GRAND', depth: 0 },
    ]);

    const mapped = await db.get<{ player_id: string; agent_id: string; linked_accounts_json: string }>(
      `SELECT player_id, agent_id, linked_accounts_json FROM player_agent_map WHERE player_id = 'P1'`
    );
    expect(mapped?.agent_id).toBe('CHILD');
    expect(mapped?.linked_accounts_json).not.toContain('secret');
    expect(mapped?.linked_accounts_json).not.toContain('Password');
  });

  test('enriches persisted wagers from player-agent mapping', async () => {
    const { agentsPath, playersPath } = await writeSeedFiles();
    await backfillAgentsAndPlayers(db, {
      agentPaths: [agentsPath],
      playerPaths: [playersPath],
      source: 'test_seed',
    });

    const manager = Object.create(BuckeyeScraperManager.prototype) as {
      db: Database;
      patternService: { correlateWager: (wager: EnrichedWager) => Promise<Record<string, unknown>> };
      persistWager: (wager: EnrichedWager) => Promise<unknown>;
    };
    manager.db = db;
    manager.patternService = {
      correlateWager: async () => ({
        parsed: { game: 'Game', market: 'Spread', side: 'Home', price: -110, period: 'Game' },
        match: { eventId: 'event-1' },
        pinReference: {},
      }),
    };

    await manager.persistWager({
      WagerNumber: 9001,
      AgentID: 'UNKNOWN',
      CustomerID: 'P1',
      Login: 'P1',
      WagerType: 'L',
      AmountWagered: 25,
      ToWinAmount: 20,
      VolumeAmount: 25,
      InsertDateTime: '2026-05-11 10:00:00.000',
      TicketWriter: 'Internet',
      ShortDesc: 'L.Football Test -110',
      VIP: '0',
      AgentLogin: 'UNKNOWN',
    });

    const wager = await db.get<{
      mapped_agent_id: string;
      mapped_agent_login: string;
      agent_level: number;
      agent_type: string;
      parent_agent_id: string;
      hierarchy_source: string;
      agent_path_json: string;
    }>(`SELECT * FROM wagers WHERE wager_number = 9001`);
    expect(wager?.mapped_agent_id).toBe('CHILD');
    expect(wager?.mapped_agent_login).toBe('CHILD');
    expect(wager?.agent_level).toBe(2);
    expect(wager?.agent_type).toBe('M');
    expect(wager?.parent_agent_id).toBe('ROOT');
    expect(wager?.hierarchy_source.startsWith('player_agent_map:')).toBe(true);
    expect(JSON.parse(wager?.agent_path_json || '[]').map((row: { agentId: string }) => row.agentId)).toEqual(['ROOT', 'CHILD']);
  });
});

describe('Parquet export route', () => {
  test('requires admin token when configured', async () => {
    process.env.ADMIN_API_TOKEN = 'test-admin';
    const response = await registerAnalyticsRoutes(
      new URL('http://localhost/api/data/export-parquet'),
      new Request('http://localhost/api/data/export-parquet', { method: 'POST' }),
      testScraperManager()
    ) as Response;
    expect(response.status).toBe(403);
  });

  test('returns DUCKDB_UNAVAILABLE when DuckDB CLI is absent', async () => {
    process.env.ADMIN_API_TOKEN = 'test-admin';
    process.env.DUCKDB_BIN = 'duckdb-definitely-not-installed-for-test';
    const response = await registerAnalyticsRoutes(
      new URL('http://localhost/api/data/export-parquet'),
      new Request('http://localhost/api/data/export-parquet', {
        method: 'POST',
        headers: { 'x-admin-token': 'test-admin' },
      }),
      testScraperManager()
    ) as Response;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'DUCKDB_UNAVAILABLE' });
  });
});

async function writeSeedFiles(): Promise<{ agentsPath: string; playersPath: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const agentsPath = join(tmpdir(), `sports-terminal-agents-${suffix}.json`);
  const playersPath = join(tmpdir(), `sports-terminal-players-${suffix}.txt`);
  await Bun.write(agentsPath, JSON.stringify([
    { AgentID: 'ROOT      ', SeqNumber: 1, Level: 1, AgentType: 'A', Login: 'ROOT      ' },
    { AgentID: 'CHILD     ', SeqNumber: 2, Level: 2, AgentType: 'M', Login: 'CHILD     ' },
    { AgentID: 'GRAND     ', SeqNumber: 3, Level: 3, AgentType: 'A', Login: 'GRAND     ' },
  ]));
  await Bun.write(playersPath, `customerpreview\n\n${JSON.stringify([
    { customerID: 'P1        ', Login: 'P1        ', NameFirst: 'Player One', Password: 'secret', Agent: 'CHILD     ' },
  ])}`);
  return { agentsPath, playersPath };
}

function testScraperManager(): ScraperManagerType {
  return { getDatabase: () => db } as ScraperManagerType;
}
