import type { Database } from '../database';
import { COMMAND_CENTER_MAP } from '../config/commandCenterMap';
import type { BuckeyeScraperManager } from '../scrapers/ScraperManager';
import { streamHub } from './StreamHub';

interface CountRow {
  count: number;
}

interface LatestWagerRow {
  wager_number: number;
  customer_id: string;
  agent_login: string;
  insert_datetime: string;
}

interface LatestFeatureRow {
  customer_id: string;
  risk_tier: string;
  extracted_at: string;
}

interface DistinctCustomerRow {
  count: number;
}

export class CommandCenterStatusService {
  constructor(
    private readonly db: Database,
    private readonly scraperManager: BuckeyeScraperManager
  ) { }

  async getStatus(): Promise<Record<string, unknown>> {
    const [tableCounts, latestWager, latestFeature, distinctCustomers] = await Promise.all([
      this.getTableCounts(),
      this.getLatestWager(),
      this.getLatestFeature(),
      this.getDistinctWagerCustomers(),
    ]);

    const metrics = this.scraperManager.getMetrics();
    const features = Number(tableCounts.customer_features || 0);
    const wagerCustomers = distinctCustomers?.count || 0;
    const featureCoverage = wagerCustomers > 0 ? features / wagerCustomers : 0;
    const latestWagerAgeSeconds = latestWager
      ? Math.max(0, (Date.now() - new Date(latestWager.insert_datetime).getTime()) / 1000)
      : null;

    return {
      ok: true,
      checked_at: new Date().toISOString(),
      map: {
        endpoints: Object.keys(COMMAND_CENTER_MAP.endpoints).length,
        sse_events: Object.keys(COMMAND_CENTER_MAP.sse.events).length,
        tables: COMMAND_CENTER_MAP.database.tables.length,
        schedules: COMMAND_CENTER_MAP.schedules,
      },
      live_data: {
        table_counts: tableCounts,
        latest_wager: latestWager,
        latest_wager_age_seconds: latestWagerAgeSeconds,
        latest_feature: latestFeature,
        distinct_wager_customers: wagerCustomers,
        feature_coverage_ratio: Number(featureCoverage.toFixed(4)),
        flowing: Boolean(latestWager),
      },
      streams: {
        subscribers: streamHub.count,
        wagers: streamHub.countForTopic(COMMAND_CENTER_MAP.sse.topics.wagers),
        alerts: streamHub.countForTopic(COMMAND_CENTER_MAP.sse.topics.alerts),
        positions: streamHub.countForTopic(COMMAND_CENTER_MAP.sse.topics.positions),
        ticker: streamHub.countForTopic(COMMAND_CENTER_MAP.sse.topics.ticker),
      },
      ingestion: {
        active_agents: metrics.activeAgents,
        authenticated_agents: metrics.agents.filter((agent) => agent.authenticated).length,
        polling_agents: metrics.agents.filter((agent) => agent.pollingScheduled).length,
        polls_in_flight: metrics.agents.filter((agent) => agent.isPolling).length,
        last_poll: latestAgentPoll(metrics.agents),
        counters: metrics.counters,
      },
      routes: COMMAND_CENTER_MAP.endpoints,
      flags: COMMAND_CENTER_MAP.flags,
      errors: COMMAND_CENTER_MAP.errors,
    };
  }

  private async getTableCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of COMMAND_CENTER_MAP.database.tables) {
      const row = await this.db.get<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`);
      out[table] = row?.count || 0;
    }
    return out;
  }

  private getLatestWager(): Promise<LatestWagerRow | null> {
    return this.db.get<LatestWagerRow>(
      `SELECT wager_number, customer_id, agent_login, insert_datetime
         FROM wagers
        ORDER BY insert_datetime DESC
        LIMIT 1`
    );
  }

  private getLatestFeature(): Promise<LatestFeatureRow | null> {
    return this.db.get<LatestFeatureRow>(
      `SELECT customer_id, risk_tier, extracted_at
         FROM customer_features
        ORDER BY extracted_at DESC
        LIMIT 1`
    );
  }

  private getDistinctWagerCustomers(): Promise<DistinctCustomerRow | null> {
    return this.db.get<DistinctCustomerRow>(
      `SELECT COUNT(DISTINCT customer_id) AS count
         FROM wagers
        WHERE customer_id IS NOT NULL
          AND customer_id <> ''`
    );
  }
}

function latestAgentPoll(agents: ReturnType<BuckeyeScraperManager['getMetrics']>['agents']): string | null {
  const timestamps = agents
    .map((agent) => agent.lastPoll)
    .filter((value): value is string => Boolean(value))
    .sort();
  return timestamps.at(-1) || null;
}
