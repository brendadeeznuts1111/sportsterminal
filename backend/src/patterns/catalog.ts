export type PatternCategory = 'odds' | 'wagers' | 'agents' | 'ip' | 'live' | 'feed';

export interface PatternDefinition {
  type: string;
  label: string;
  category: PatternCategory;
  status: 'active';
  sourceTables: string[];
  detector: string;
  summary: string;
  trigger: string;
  severity: {
    info?: string;
    warning?: string;
    critical?: string;
  };
  reasonCodes: string[];
  evidenceFields: string[];
  confidence: 'confirmed' | 'derived' | 'correlated';
}

export const PATTERN_CATALOG: PatternDefinition[] = [
  {
    type: 'Steam Move',
    label: 'Steam Move',
    category: 'odds',
    status: 'active',
    sourceTables: ['line_movements', 'detected_patterns'],
    detector: 'OddsPoller.detectPatterns',
    summary: 'Multiple books move the same event, market, and side together in a short window.',
    trigger: '3 or more line movements for the same event/market/side inside 90 seconds.',
    severity: {
      info: '3 books moved together.',
      warning: '4 books moved together.',
      critical: '5 or more books moved together.',
    },
    reasonCodes: ['multi_book_move', 'same_event_market_side', '90_second_window'],
    evidenceFields: ['eventId', 'market', 'side', 'triggerBook', 'followedBy', 'detectedAt'],
    confidence: 'confirmed',
  },
  {
    type: 'Reverse Line',
    label: 'Reverse Line',
    category: 'odds',
    status: 'active',
    sourceTables: ['line_movements', 'detected_patterns'],
    detector: 'OddsPoller.detectPatterns',
    summary: 'Sharp books and public books moved in opposite directions.',
    trigger: 'At least one sharp book movement and one public book movement have opposite delta signs.',
    severity: {
      warning: 'Opposing sharp/public movement is detected.',
    },
    reasonCodes: ['sharp_public_divergence', 'opposite_delta'],
    evidenceFields: ['eventId', 'market', 'side', 'triggerBook', 'followedBy', 'detectedAt'],
    confidence: 'confirmed',
  },
  {
    type: 'Agent Swarm',
    label: 'Agent Swarm',
    category: 'agents',
    status: 'active',
    sourceTables: ['wagers', 'detected_patterns', 'pattern_agents'],
    detector: 'PatternService.analyzeWager',
    summary: 'Players under the same agent cluster on the same game, market, and side.',
    trigger: 'Same agent has 4 or more matching wagers, or 3 or more distinct players, inside 10 minutes.',
    severity: {
      warning: '3 distinct same-agent players, or 4 matching same-agent wagers.',
      critical: '4 or more distinct same-agent players.',
    },
    reasonCodes: ['same_agent', 'same_game_side', 'tight_window'],
    evidenceFields: ['wagerNumber', 'agent', 'players', 'wagerCount', 'windowMinutes', 'correlation'],
    confidence: 'derived',
  },
  {
    type: 'cross_agent_steam',
    label: 'Cross-Agent Steam',
    category: 'agents',
    status: 'active',
    sourceTables: ['wagers', 'detected_patterns', 'pattern_agents'],
    detector: 'PatternService.analyzeWager',
    summary: 'Multiple agents hit the same game, market, and side together.',
    trigger: '2 or more agents and at least 3 matching wagers inside 10 minutes.',
    severity: {
      warning: '2 agents in the matching cluster.',
      critical: '3 or more agents in the matching cluster.',
    },
    reasonCodes: ['two_plus_agents', 'same_game_side', 'steam_window'],
    evidenceFields: ['wagerNumber', 'agent', 'agents', 'wagerCount', 'windowMinutes', 'correlation'],
    confidence: 'derived',
  },
  {
    type: 'Cross-Agent Swarm',
    label: 'Cross-Agent Swarm',
    category: 'agents',
    status: 'active',
    sourceTables: ['wagers', 'detected_patterns', 'pattern_agents'],
    detector: 'PatternService.analyzeWager',
    summary: 'Three or more agents cluster on the same game, market, and side.',
    trigger: '3 or more agents hit the same game, market, and side inside 10 minutes.',
    severity: {
      warning: '3 agents in the matching cluster.',
      critical: '4 or more agents in the matching cluster.',
    },
    reasonCodes: ['multiple_agents', 'same_game_side', 'tight_window'],
    evidenceFields: ['wagerNumber', 'agents', 'wagerCount', 'windowMinutes', 'correlation'],
    confidence: 'derived',
  },
  {
    type: 'Live Past-Post Risk',
    label: 'Live Past-Post Risk',
    category: 'live',
    status: 'active',
    sourceTables: ['wagers', 'events', 'detected_patterns'],
    detector: 'PatternService.addLivePatterns',
    summary: 'A wager lands after the matched event start time.',
    trigger: 'Wager time is more than 1 minute after the matched event start time.',
    severity: {
      warning: 'Ticket writer is GSLIVE.',
      critical: 'Ticket writer is not GSLIVE.',
    },
    reasonCodes: ['after_event_start', 'live_writer', 'not_gslive'],
    evidenceFields: ['wagerNumber', 'wagerTime', 'eventStart', 'ticketWriter', 'minutesAfterStart', 'correlation'],
    confidence: 'correlated',
  },
  {
    type: 'Late Live Spike',
    label: 'Late Live Spike',
    category: 'live',
    status: 'active',
    sourceTables: ['wagers', 'events', 'detected_patterns'],
    detector: 'PatternService.addLivePatterns',
    summary: 'Live tickets cluster on the same matched event.',
    trigger: '5 or more GSLIVE wagers on the same matched event/game inside 10 minutes.',
    severity: {
      warning: 'Live wager cluster threshold reached.',
    },
    reasonCodes: ['gslive_cluster', 'tight_window'],
    evidenceFields: ['wagerNumber', 'liveWagerCount', 'windowMinutes', 'correlation'],
    confidence: 'derived',
  },
  {
    type: 'agent_reversal',
    label: 'Agent Reversal',
    category: 'agents',
    status: 'active',
    sourceTables: ['wagers', 'events', 'detected_patterns', 'pattern_agents'],
    detector: 'PatternService.addAgentReversalPattern',
    summary: 'An agent flips side tendency compared with their recent wagers in the same sport/market.',
    trigger: 'Last 5 comparable agent wagers have a 3+ majority side, and the current side is opposite.',
    severity: {
      warning: '3 of last 5 comparable wagers were on the prior side.',
      critical: '4 or more of last 5 comparable wagers were on the prior side.',
    },
    reasonCodes: ['agent_side_reversal', 'last_five_sport_wagers'],
    evidenceFields: ['wagerNumber', 'agent', 'currentSide', 'priorMajoritySide', 'priorSampleSize', 'priorMajorityCount', 'correlation'],
    confidence: 'derived',
  },
  {
    type: 'late_money',
    label: 'Late Money',
    category: 'agents',
    status: 'active',
    sourceTables: ['wagers', 'events', 'detected_patterns', 'pattern_agents'],
    detector: 'PatternService.addLateMoneyPattern',
    summary: 'An agent places an above-average wager close to event start.',
    trigger: 'Wager is within 15 minutes before start and above that agent sport average, with at least 3 prior samples.',
    severity: {
      warning: 'Current amount is above agent average.',
      critical: 'Current amount is at least 3x agent average.',
    },
    reasonCodes: ['near_game_start', 'above_agent_average'],
    evidenceFields: ['wagerNumber', 'agent', 'amount', 'agentAverageAmount', 'ratio', 'minutesToStart', 'eventStart', 'correlation'],
    confidence: 'correlated',
  },
  {
    type: 'velocity_spike',
    label: 'Velocity Spike',
    category: 'agents',
    status: 'active',
    sourceTables: ['wagers', 'detected_patterns', 'pattern_agents'],
    detector: 'PatternService.addVelocityPattern',
    summary: 'An agent wager count spikes versus their prior 24-hour hourly baseline.',
    trigger: 'Current hour has at least 6 wagers and at least 3x the prior 24-hour hourly baseline.',
    severity: {
      warning: 'Velocity is at least 3x baseline.',
      critical: 'Velocity is at least 5x baseline or 12+ wagers this hour.',
    },
    reasonCodes: ['agent_velocity_spike', 'three_x_baseline'],
    evidenceFields: ['wagerNumber', 'agent', 'currentHourCount', 'baselineHourlyCount', 'correlation'],
    confidence: 'derived',
  },
  {
    type: 'Pinnacle Drift Bet',
    label: 'Pinnacle Drift Bet',
    category: 'wagers',
    status: 'active',
    sourceTables: ['wagers', 'odds_snapshots', 'events', 'detected_patterns'],
    detector: 'PatternService.addPinPatterns',
    summary: 'A wager accepts a price materially away from the PIN reference price.',
    trigger: 'Accepted price differs from comparable PIN price by 20 or more points.',
    severity: {
      warning: '20 to 34 points away from PIN.',
      critical: '35 or more points away from PIN.',
    },
    reasonCodes: ['off_market_price', 'pin_reference'],
    evidenceFields: ['wagerNumber', 'acceptedPrice', 'pinPrice', 'priceDiff', 'pinReference', 'correlation'],
    confidence: 'correlated',
  },
  {
    type: 'Post-PIN Move Bet',
    label: 'Post-PIN Move Bet',
    category: 'wagers',
    status: 'active',
    sourceTables: ['wagers', 'line_movements', 'events', 'detected_patterns'],
    detector: 'PatternService.addPinPatterns',
    summary: 'A wager follows a recent PIN movement on the same market.',
    trigger: 'At least one PIN movement for the same matched event/market in the previous 5 minutes.',
    severity: {
      warning: 'Recent PIN movement exists before the wager.',
    },
    reasonCodes: ['pin_moved_first', 'short_lag'],
    evidenceFields: ['wagerNumber', 'moves', 'windowMinutes', 'correlation'],
    confidence: 'correlated',
  },
  {
    type: 'Repeat Timing Signature',
    label: 'Repeat Timing Signature',
    category: 'wagers',
    status: 'active',
    sourceTables: ['wagers', 'line_movements', 'detected_patterns'],
    detector: 'PatternService.addRepeatTimingPattern',
    summary: 'A player repeatedly places wagers shortly after PIN movements.',
    trigger: '3 or more recent player wagers in the last hour are within 2 minutes after a PIN move.',
    severity: {
      warning: '3 to 4 timing hits.',
      critical: '5 or more timing hits.',
    },
    reasonCodes: ['repeat_player_timing', 'pin_move_lag'],
    evidenceFields: ['wagerNumber', 'player', 'timingHits', 'windowMinutes', 'correlation'],
    confidence: 'correlated',
  },
  {
    type: 'Steam Chase',
    label: 'Steam Chase',
    category: 'wagers',
    status: 'active',
    sourceTables: ['wagers', 'detected_patterns'],
    detector: 'PatternService.addSteamChasePattern',
    summary: 'A wager follows an already detected steam move on the same event and market.',
    trigger: 'Existing Steam Move pattern for the same event/market in the previous 10 minutes.',
    severity: {
      warning: 'Steam follow detected.',
    },
    reasonCodes: ['existing_steam', 'customer_followed'],
    evidenceFields: ['wagerNumber', 'steamPatternId', 'correlation'],
    confidence: 'correlated',
  },
  {
    type: 'Shared IP Cluster',
    label: 'Shared IP Cluster',
    category: 'ip',
    status: 'active',
    sourceTables: ['access_logs', 'detected_patterns'],
    detector: 'PatternService.analyzeAccessLogs',
    summary: 'Multiple players use the same IP address in the last 24 hours.',
    trigger: '2 or more players share an IP address.',
    severity: {
      warning: '2 to 3 players share an IP.',
      critical: '4 or more players share an IP.',
    },
    reasonCodes: ['shared_ip', 'multiple_players'],
    evidenceFields: ['ip', 'players', 'accessCount'],
    confidence: 'confirmed',
  },
  {
    type: 'IP Follow Pattern',
    label: 'IP Follow Pattern',
    category: 'ip',
    status: 'active',
    sourceTables: ['access_logs', 'wagers', 'detected_patterns'],
    detector: 'PatternService.findIpFollowPattern',
    summary: 'Players sharing an IP also bet the same game, market, and side in a tight window.',
    trigger: '2 or more same-IP players bet the same game/market/side inside 10 minutes.',
    severity: {
      warning: '2 same-IP players follow the same spot.',
      critical: '3 or more same-IP players follow the same spot.',
    },
    reasonCodes: ['shared_ip', 'same_game_side', 'tight_wager_window'],
    evidenceFields: ['ip', 'players', 'wagerNumbers', 'accessRows'],
    confidence: 'derived',
  },
];

export function getPatternCatalog(): { generatedAt: string; count: number; patterns: PatternDefinition[] } {
  return {
    generatedAt: new Date().toISOString(),
    count: PATTERN_CATALOG.length,
    patterns: PATTERN_CATALOG,
  };
}

export function getPatternDefinition(type: string | null | undefined): PatternDefinition | undefined {
  if (!type) return undefined;
  return PATTERN_CATALOG.find((pattern) => pattern.type === type);
}
