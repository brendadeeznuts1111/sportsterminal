export interface AgentHierarchyRow {
  agent_id: string;
  login?: string | null;
  display_name?: string | null;
  parent_agent_id?: string | null;
  level?: number | null;
  agent_type?: string | null;
  seq_number?: number | null;
  child_count?: number | null;
  player_count?: number | null;
  head_count_rate_m?: number | null;
  inet_head_count_rate_m?: number | null;
  casino_head_count_rate_m?: number | null;
  live_betting_rate_m?: number | null;
  live_betting2_rate_m?: number | null;
  live_casino_rate_m?: number | null;
  prop_builder_rate_m?: number | null;
  flash_bets_rate?: number | null;
  ext_props_rate?: number | null;
  crash_rate?: number | null;
  fantasy_rate?: number | null;
  amigo_tech_rate?: number | null;
  last_refreshed?: string | null;
}

export type AgentNode = Record<string, unknown> & {
  agentId: string;
  parentAgentId: string;
  level?: number | null;
};

export function formatAgentNode(row: AgentHierarchyRow): AgentNode {
  return normalizeAgentNumbers({
    agentId: row.agent_id,
    login: row.login || row.agent_id,
    displayName: row.display_name || row.login || row.agent_id,
    parentAgentId: row.parent_agent_id || '',
    level: row.level,
    agentType: row.agent_type,
    seqNumber: row.seq_number,
    childCount: row.child_count,
    playerCount: row.player_count,
    rates: {
      HeadCountRateM: row.head_count_rate_m,
      InetHeadCountRateM: row.inet_head_count_rate_m,
      CasinoHeadCountRateM: row.casino_head_count_rate_m,
      LiveBettingRateM: row.live_betting_rate_m,
      LiveBetting2RateM: row.live_betting2_rate_m,
      LiveCasinoRateM: row.live_casino_rate_m,
      PropBuilderRateM: row.prop_builder_rate_m,
      FlashBetsRate: row.flash_bets_rate,
      ExtPropsRate: row.ext_props_rate,
      CrashRate: row.crash_rate,
      FantasyRate: row.fantasy_rate,
      AmigoTechRate: row.amigo_tech_rate,
    },
    lastRefreshed: row.last_refreshed,
  }) as AgentNode;
}

export function normalizeAgentNumbers<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (value === null || value === undefined) out[key] = value;
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : 0;
    else out[key] = value;
  }
  return out as T;
}
