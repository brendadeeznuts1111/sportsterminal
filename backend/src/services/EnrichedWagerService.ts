import { AppDatabase } from '../database';

export interface EnrichedWager {
  wager_number: number;
  customer_id: string;
  login: string;
  agent_login: string;
  amount_wagered: number;
  to_win_amount: number;
  sport: string;
  wager_type: string;
  insert_datetime: string;
  parsed_price: number;
  parsed_side: string;
  parsed_market: string;
  // Enriched context
  archetype: string;
  risk_tier: string;
  sharp_score: number;
  lifetime_wagers: number;
  avg_wager_size: number;
  win_rate: number;
  violation_count: number;
  flag_count: number;
  ai_risk_level: string | null;
  ai_suggested_action: string | null;
  rule_action: string | null;
}

/**
 * Get live wagers enriched with full customer historical context.
 * This powers the live ticker dashboard with risk indicators per wager.
 */
export async function getEnrichedLiveWagers(db: AppDatabase, limit: number = 100): Promise<EnrichedWager[]> {
  return db.all<EnrichedWager>(
    `SELECT
       w.wager_number,
       w.customer_id,
       w.login,
       w.agent_login,
       w.amount_wagered,
       w.to_win_amount,
       w.sport,
       w.wager_type,
       w.insert_datetime,
       w.parsed_price,
       w.parsed_side,
       w.parsed_market,
       cf.archetype,
       cf.risk_tier,
       cf.sharp_score,
       cf.lifetime_wagers,
       cf.avg_wager_size,
       cf.win_rate,
       COALESCE(v.violation_count, 0) as violation_count,
       COALESCE(f.flag_count, 0) as flag_count,
       ai.risk_level as ai_risk_level,
       ai.suggested_action as ai_suggested_action,
       aa.action as rule_action
     FROM wagers w
     LEFT JOIN customer_features cf ON cf.customer_id = w.customer_id
     LEFT JOIN (SELECT customer_id, COUNT(*) as violation_count FROM wager_violations GROUP BY customer_id) v ON v.customer_id = w.customer_id
     LEFT JOIN (SELECT customer_id, COUNT(*) as flag_count FROM player_flags GROUP BY customer_id) f ON f.customer_id = w.customer_id
     LEFT JOIN (
       SELECT customer_id, risk_level, suggested_action
       FROM ai_risk_flags
       WHERE id IN (SELECT MAX(id) FROM ai_risk_flags GROUP BY customer_id)
     ) ai ON ai.customer_id = w.customer_id
     LEFT JOIN (
       SELECT player_id, action
       FROM agent_actions
       WHERE id IN (SELECT MAX(id) FROM agent_actions GROUP BY player_id)
     ) aa ON aa.player_id = w.customer_id
     WHERE w.ticket_writer = 'GSLIVE'
     ORDER BY w.insert_datetime DESC
     LIMIT ?`,
    [limit]
  );
}

/**
 * Get recent wagers enriched with context (for when GSLIVE is sparse).
 */
export async function getEnrichedRecentWagers(db: AppDatabase, limit: number = 100): Promise<EnrichedWager[]> {
  return db.all<EnrichedWager>(
    `SELECT
       w.wager_number,
       w.customer_id,
       w.login,
       w.agent_login,
       w.amount_wagered,
       w.to_win_amount,
       w.sport,
       w.wager_type,
       w.insert_datetime,
       w.parsed_price,
       w.parsed_side,
       w.parsed_market,
       cf.archetype,
       cf.risk_tier,
       cf.sharp_score,
       cf.lifetime_wagers,
       cf.avg_wager_size,
       cf.win_rate,
       COALESCE(v.violation_count, 0) as violation_count,
       COALESCE(f.flag_count, 0) as flag_count,
       ai.risk_level as ai_risk_level,
       ai.suggested_action as ai_suggested_action,
       aa.action as rule_action
     FROM wagers w
     LEFT JOIN customer_features cf ON cf.customer_id = w.customer_id
     LEFT JOIN (SELECT customer_id, COUNT(*) as violation_count FROM wager_violations GROUP BY customer_id) v ON v.customer_id = w.customer_id
     LEFT JOIN (SELECT customer_id, COUNT(*) as flag_count FROM player_flags GROUP BY customer_id) f ON f.customer_id = w.customer_id
     LEFT JOIN (
       SELECT customer_id, risk_level, suggested_action
       FROM ai_risk_flags
       WHERE id IN (SELECT MAX(id) FROM ai_risk_flags GROUP BY customer_id)
     ) ai ON ai.customer_id = w.customer_id
     LEFT JOIN (
       SELECT player_id, action
       FROM agent_actions
       WHERE id IN (SELECT MAX(id) FROM agent_actions GROUP BY player_id)
     ) aa ON aa.player_id = w.customer_id
     ORDER BY w.insert_datetime DESC
     LIMIT ?`,
    [limit]
  );
}
