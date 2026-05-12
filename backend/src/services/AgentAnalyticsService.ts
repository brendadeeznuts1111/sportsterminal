/**
 * AgentAnalyticsService
 * Aggregate analytics for agent hierarchy, player distribution, and rate analysis.
 */
import type { Database } from '../database';

export interface AgentLevelStats {
  level: number;
  agent_count: number;
  player_count: number;
  avg_head_count_rate: number;
  avg_live_betting_rate: number;
  avg_prop_builder_rate: number;
  top_agents: Array<{ login: string; player_count: number }>;
}

export interface AgentTypeStats {
  agent_type: string;
  count: number;
  player_count: number;
  avg_level: number;
}

export interface RateDistribution {
  rate_name: string;
  non_zero_count: number;
  avg_rate: number;
  max_rate: number;
  min_rate: number;
}

export interface AgentAnalytics {
  summary: {
    total_agents: number;
    total_players: number;
    avg_players_per_agent: number;
    max_level: number;
    root_count: number;
  };
  by_level: AgentLevelStats[];
  by_type: AgentTypeStats[];
  rate_distribution: RateDistribution[];
  orphan_players: number;
  top_agents_by_players: Array<{ login: string; level: number; player_count: number }>;
}

export class AgentAnalyticsService {
  constructor(private readonly db: Database) {}

  async getAnalytics(): Promise<AgentAnalytics> {
    const summary = await this.db.get<{
      total_agents: number;
      total_players: number;
      avg_players_per_agent: number;
      max_level: number;
      root_count: number;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM agents WHERE provider = 'buckeye') AS total_agents,
        (SELECT COUNT(*) FROM players WHERE provider = 'buckeye') AS total_players,
        (SELECT ROUND(AVG(player_count), 1) FROM agents WHERE provider = 'buckeye') AS avg_players_per_agent,
        (SELECT MAX(level) FROM agents WHERE provider = 'buckeye') AS max_level,
        (SELECT COUNT(*) FROM agents WHERE provider = 'buckeye' AND level = 1) AS root_count`
    );

    const byLevel = await this.db.all<{
      level: number;
      agent_count: number;
      player_count: number;
      avg_head_count_rate: number;
      avg_live_betting_rate: number;
      avg_prop_builder_rate: number;
    }>(
      `SELECT
        a.level,
        COUNT(*) AS agent_count,
        SUM(a.player_count) AS player_count,
        ROUND(AVG(a.head_count_rate_m), 2) AS avg_head_count_rate,
        ROUND(AVG(a.live_betting_rate_m), 2) AS avg_live_betting_rate,
        ROUND(AVG(a.prop_builder_rate_m), 2) AS avg_prop_builder_rate
      FROM agents a
      WHERE a.provider = 'buckeye'
      GROUP BY a.level
      ORDER BY a.level`
    );

    const byType = await this.db.all<{
      agent_type: string;
      count: number;
      player_count: number;
      avg_level: number;
    }>(
      `SELECT
        a.agent_type,
        COUNT(*) AS count,
        SUM(a.player_count) AS player_count,
        ROUND(AVG(a.level), 1) AS avg_level
      FROM agents a
      WHERE a.provider = 'buckeye'
      GROUP BY a.agent_type`
    );

    const rateDistribution = await this.db.all<{
      rate_name: string;
      non_zero_count: number;
      avg_rate: number;
      max_rate: number;
      min_rate: number;
    }>(
      `SELECT 'head_count_rate_m' AS rate_name,
             COUNT(CASE WHEN head_count_rate_m > 0 THEN 1 END) AS non_zero_count,
             ROUND(AVG(head_count_rate_m), 2) AS avg_rate,
             MAX(head_count_rate_m) AS max_rate,
             MIN(head_count_rate_m) AS min_rate
      FROM agents WHERE provider = 'buckeye'
      UNION ALL
      SELECT 'inet_head_count_rate_m', COUNT(CASE WHEN inet_head_count_rate_m > 0 THEN 1 END),
             ROUND(AVG(inet_head_count_rate_m), 2), MAX(inet_head_count_rate_m), MIN(inet_head_count_rate_m)
      FROM agents WHERE provider = 'buckeye'
      UNION ALL
      SELECT 'live_betting_rate_m', COUNT(CASE WHEN live_betting_rate_m > 0 THEN 1 END),
             ROUND(AVG(live_betting_rate_m), 2), MAX(live_betting_rate_m), MIN(live_betting_rate_m)
      FROM agents WHERE provider = 'buckeye'
      UNION ALL
      SELECT 'prop_builder_rate_m', COUNT(CASE WHEN prop_builder_rate_m > 0 THEN 1 END),
             ROUND(AVG(prop_builder_rate_m), 2), MAX(prop_builder_rate_m), MIN(prop_builder_rate_m)
      FROM agents WHERE provider = 'buckeye'
      UNION ALL
      SELECT 'flash_bets_rate', COUNT(CASE WHEN flash_bets_rate > 0 THEN 1 END),
             ROUND(AVG(flash_bets_rate), 2), MAX(flash_bets_rate), MIN(flash_bets_rate)
      FROM agents WHERE provider = 'buckeye'
      UNION ALL
      SELECT 'crash_rate', COUNT(CASE WHEN crash_rate > 0 THEN 1 END),
             ROUND(AVG(crash_rate), 2), MAX(crash_rate), MIN(crash_rate)
      FROM agents WHERE provider = 'buckeye'`
    );

    const orphanPlayers = await this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM players
       WHERE provider = 'buckeye'
         AND agent_login NOT IN (SELECT login FROM agents WHERE provider = 'buckeye')`
    );

    const topAgents = await this.db.all<{
      login: string;
      level: number;
      player_count: number;
    }>(
      `SELECT login, level, player_count
       FROM agents
       WHERE provider = 'buckeye'
       ORDER BY player_count DESC
       LIMIT 20`
    );

    const levelTopAgents = await Promise.all(
      byLevel.map(async (lvl) => {
        const agents = await this.db.all<{ login: string; player_count: number }>(
          `SELECT login, player_count
           FROM agents
           WHERE provider = 'buckeye' AND level = ?
           ORDER BY player_count DESC
           LIMIT 3`,
          [lvl.level]
        );
        return { ...lvl, top_agents: agents };
      })
    );

    return {
      summary: {
        total_agents: summary?.total_agents ?? 0,
        total_players: summary?.total_players ?? 0,
        avg_players_per_agent: summary?.avg_players_per_agent ?? 0,
        max_level: summary?.max_level ?? 0,
        root_count: summary?.root_count ?? 0,
      },
      by_level: levelTopAgents,
      by_type: byType,
      rate_distribution: rateDistribution,
      orphan_players: orphanPlayers?.c ?? 0,
      top_agents_by_players: topAgents,
    };
  }
}
