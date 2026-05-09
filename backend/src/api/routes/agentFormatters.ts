export function formatAgentNode(row: any): any {
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
  });
}

export function normalizeAgentNumbers(row: any): any {
  const out: any = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (value === null || value === undefined) out[key] = value;
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : 0;
    else out[key] = value;
  }
  return out;
}
