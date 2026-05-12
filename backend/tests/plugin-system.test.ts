import { afterEach, describe, expect, test } from 'bun:test';
import { initDatabase, type AppDatabase } from '../src/database';
import { registerBuiltinPlugins } from '../src/services/BuiltinPlugins';
import { pluginLoader, type PluginContext } from '../src/services/PluginLoader';
import { TickerBuffer } from '../src/services/TickerBuffer';

const BUILTIN_PLUGIN_NAMES = [
  'risk-sharp-detector',
  'volume-spike-detector',
  'archetype-profiler',
];

function unregisterBuiltinPlugins(): void {
  for (const name of BUILTIN_PLUGIN_NAMES) {
    pluginLoader.unregister(name);
  }
}

function sampleContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    wager_number: 999999,
    customer_id: 'TEST001',
    login: 'TEST001',
    agent_login: 'TESTAGENT',
    amount_wagered: 500,
    to_win_amount: 450,
    sport: 'Football',
    wager_type: 'S',
    insert_datetime: '2026-05-11 12:00:00',
    parsed_price: -110,
    parsed_side: 'team_a',
    parsed_market: 'spread',
    archetype: 'casual_micro_sharp',
    risk_tier: 'RED',
    sharp_score: 45,
    lifetime_wagers: 50,
    avg_wager_size: 25,
    win_rate: 0.52,
    violation_count: 0,
    flag_count: 0,
    ai_risk_level: null,
    ai_suggested_action: null,
    rule_action: null,
    ...overrides,
  };
}

describe('plugin ticker pipeline', () => {
  let db: AppDatabase | null = null;
  let tickerBuffer: TickerBuffer | null = null;

  afterEach(async () => {
    tickerBuffer?.stop();
    tickerBuffer = null;
    unregisterBuiltinPlugins();
    await db?.close();
    db = null;
  });

  test('dispatches built-in plugins and writes execution audit rows', async () => {
    db = await initDatabase(':memory:');
    unregisterBuiltinPlugins();
    registerBuiltinPlugins((plugin) => pluginLoader.register(plugin));

    tickerBuffer = new TickerBuffer(db, { maxBufferSize: 10, flushIntervalMs: 60_000 });
    tickerBuffer.feed(sampleContext());
    await tickerBuffer.flush();

    const logs = await db.all<{
      plugin_name: string;
      hook_name: string;
      status: string;
      result_json: string;
    }>(
      `SELECT plugin_name, hook_name, status, result_json
       FROM plugin_execution_log
       WHERE wager_number = ?
       ORDER BY plugin_name`,
      [999999]
    );

    expect(logs.map((row) => row.plugin_name)).toEqual([
      'archetype-profiler',
      'risk-sharp-detector',
      'volume-spike-detector',
    ]);
    expect(logs.every((row) => row.hook_name === 'on_wager')).toBe(true);
    expect(logs.every((row) => row.status === 'success')).toBe(true);

    const riskResult = JSON.parse(
      logs.find((row) => row.plugin_name === 'risk-sharp-detector')!.result_json
    );
    expect(riskResult).toMatchObject({
      action: 'review',
      severity: 'high',
    });
  });
});
