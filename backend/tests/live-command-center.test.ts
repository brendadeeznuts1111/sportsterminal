import { afterEach, describe, expect, test } from 'bun:test';
import { initDatabase, type Database } from '../src/database';
import { COMMAND_CENTER_MAP } from '../src/config/commandCenterMap';
import type { BuckeyeScraperManager } from '../src/scrapers/ScraperManager';
import { CommandCenterStatusService } from '../src/services/CommandCenterStatusService';
import { LiveFeatureService } from '../src/services/LiveFeatureService';
import { riskLevelToLimits } from '../src/services/PositionService';
import { StreamHub } from '../src/services/StreamHub';

let db: Database | null = null;
let oldKimiKey: string | undefined;

afterEach(async () => {
  if (db) {
    await db.close();
    db = null;
  }
  if (oldKimiKey === undefined) delete Bun.env.KIMI_API_KEY;
  else Bun.env.KIMI_API_KEY = oldKimiKey;
});

describe('live command center', () => {
  test('extracts live features from wager and player rows', async () => {
    db = await initDatabase(':memory:');
    await seedLiveCustomer(db, 'CUST1', 12, 150_00, 120);

    const service = new LiveFeatureService(db);
    const features = await service.extractFeaturesForCustomer('CUST1');

    expect(features.customer_id).toBe('CUST1');
    expect(features.lifetime_wagers).toBe(12);
    expect(features.avg_wager_size).toBe(150);
    expect(features.sport_diversity_score).toBeGreaterThan(0);
  });

  test('analyzes live customer with heuristic fallback and creates a position', async () => {
    oldKimiKey = Bun.env.KIMI_API_KEY;
    delete Bun.env.KIMI_API_KEY;

    db = await initDatabase(':memory:');
    await seedLiveCustomer(db, 'SHARP1', 60, 2_500_00, 150);

    const service = new LiveFeatureService(db);
    const result = await service.analyzeLiveCustomer({ customer_id: 'SHARP1', forceRefresh: true });
    const flagCount = await db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM ai_risk_flags WHERE customer_id = ?',
      ['SHARP1']
    );

    expect(result.live).toBe(true);
    expect(result.analysis.source).toBe('heuristic');
    expect(['YELLOW', 'RED', 'BLACK']).toContain(result.analysis.risk_level);
    expect(result.position).toBeDefined();
    expect(flagCount?.count).toBe(1);
  });

  test('replays SSE ring-buffer events with connected and heartbeat frames', async () => {
    const hub = new StreamHub();
    hub.publish('wagers', { event: 'wager', data: { wager_number: 1 } });
    hub.heartbeat({ test: true });

    const { stream } = hub.subscribe(['wagers', 'ticker']);
    const connected = await stream.next();
    const replayedWager = await stream.next();
    const replayedHeartbeat = await stream.next();
    hub.closeAll();

    expect(connected.value).toContain('event: connected');
    expect(replayedWager.value).toContain('event: wager');
    expect(replayedHeartbeat.value).toContain('event: heartbeat');
  });

  test('maps BLACK risk to local block-only limits', () => {
    expect(riskLevelToLimits('BLACK', 5000)).toEqual({
      maxExposure: 0,
      wagerLimit: 0,
      action: 'block',
    });
  });

  test('defines readonly command-center endpoint and event matrix', () => {
    expect(COMMAND_CENTER_MAP.endpoints.liveWagersStream.path).toBe('/api/stream/live-wagers');
    expect(COMMAND_CENTER_MAP.endpoints.analyzeLive.method).toBe('POST');
    expect(COMMAND_CENTER_MAP.endpoints.commandCenterStatus.path).toBe('/api/command-center/status');
    expect(COMMAND_CENTER_MAP.sse.events.riskAlert).toBe('risk_alert');
    expect(COMMAND_CENTER_MAP.params.exposure).toContain('window');
    expect(COMMAND_CENTER_MAP.database.tables).toContain('customer_features');
  });

  test('summarizes runtime command-center status from live tables', async () => {
    db = await initDatabase(':memory:');
    await seedLiveCustomer(db, 'STATUS1', 3, 100_00, -110);
    const live = new LiveFeatureService(db);
    await live.extractFeaturesForCustomer('STATUS1');

    const status = await new CommandCenterStatusService(db, fakeScraperManager()).getStatus();
    const liveData = status.live_data as { table_counts: Record<string, number>; flowing: boolean };

    expect(status.ok).toBe(true);
    expect(liveData.flowing).toBe(true);
    expect(liveData.table_counts.wagers).toBe(3);
    expect(liveData.table_counts.customer_features).toBe(1);
  });
});

async function seedLiveCustomer(
  database: Database,
  customerId: string,
  wagerCount: number,
  amountCents: number,
  price: number
): Promise<void> {
  await database.run(
    `INSERT INTO agents (id, name, provider, login) VALUES (?, ?, 'buckeye', ?)`,
    ['AGENT1', 'Agent One', 'AGENT1']
  );
  await database.run(
    `INSERT INTO players (id, agent_id, name, provider, login, exposure, net_pnl)
     VALUES (?, 'AGENT1', ?, 'buckeye', ?, ?, ?)`,
    [customerId, customerId, customerId, 20_000, 2500]
  );

  for (let i = 0; i < wagerCount; i++) {
    await database.run(
      `INSERT INTO wagers (
        wager_number, agent_id, customer_id, login, wager_type, amount_wagered,
        to_win_amount, volume_amount, insert_datetime, ticket_writer, short_desc,
        vip, agent_login, sport, parsed_game, parsed_market, parsed_side,
        parsed_price, parsed_period, scraped_at
      ) VALUES (?, 'AGENT1', ?, ?, 'M', ?, ?, ?, datetime('now', ?), 'Internet',
        'NBA test wager', '0', 'AGENT1', 'Basketball', 'Game', 'Side', 'Home',
        ?, 'Full', datetime('now'))`,
      [
        10_000 + i,
        customerId,
        customerId,
        amountCents,
        Math.floor(amountCents * 0.9),
        amountCents,
        `-${i} minutes`,
        price,
      ]
    );
  }
}

function fakeScraperManager(): BuckeyeScraperManager {
  return {
    getMetrics() {
      return {
        activeAgents: 1,
        agents: [{
          agentId: 'TEST',
          isPolling: true,
          pollingScheduled: true,
          lastPoll: new Date().toISOString(),
          errorCount: 0,
          consecutiveErrors: 0,
          lastError: null,
          authenticated: true,
          currentPollMs: 5000,
          reloginAttempts: 0,
          player360Active: false,
        }],
        actionQueue: { totalQueued: 0, queues: {} },
        counters: { wagers_total: 3, alerts_triggered_total: 0, errors_total: 0 },
      };
    },
  } as BuckeyeScraperManager;
}
