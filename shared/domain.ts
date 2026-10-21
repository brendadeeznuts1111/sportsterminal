/**
 * Wire shapes shared by the HTTP route map and socket messages.
 * Amounts that come from the database are already dollars.
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface EnrichedWager {
  WagerNumber: number;
  AgentID: string;
  CustomerID: string;
  Login: string;
  WagerType: string;
  AmountWagered: number;
  ToWinAmount: number;
  VolumeAmount: number;
  InsertDateTime: string;
  TicketWriter: string;
  ShortDesc: string;
  VIP: string;
  AgentLogin: string;
}

export interface Alert {
  ruleName: string;
  severity: Severity;
  message: string;
  wagerNumber: number;
}

export interface WagerRow {
  wager_number: number;
  agent_id: string;
  customer_id: string;
  login: string;
  wager_type: string | null;
  amount_wagered: number;
  to_win_amount: number;
  volume_amount: number;
  insert_datetime: string;
  ticket_writer: string;
  short_desc: string;
  vip: string;
  agent_login: string;
  sport: string | null;
  parsed_game: string | null;
  parsed_market: string | null;
  parsed_side: string | null;
  parsed_price: number | null;
  parsed_period: string | null;
  matched_event_id: string | null;
  pin_reference_json: string | null;
  raw_json: string | null;
  agent_level: number | null;
  agent_type: string | null;
  parent_agent_id: string | null;
  mapped_agent_id: string | null;
  mapped_agent_login: string | null;
  agent_path_json: string | null;
  hierarchy_source: string | null;
  scraped_at: string;
}

export interface AlertRow {
  alert_id: number;
  wager_number: number | null;
  rule_name: string;
  severity: Severity | null;
  message: string;
  is_resolved: number | boolean;
  created_at: string;
}

export interface StatsResponse {
  totalWagers: number;
  totalVolume: number;
  agentCount: number;
  alertCount: number;
  liveCount: number;
}

export interface AgentVolumeRow {
  agent_login: string | null;
  wager_count: number;
  total_volume: number | null;
  total_risk: number | null;
}

export interface AgentDownlineRow {
  agent_login: string | null;
  wager_count: number;
  player_count: number;
  total_volume: number | null;
  total_risk: number | null;
  alert_count: number | null;
  live_count: number | null;
  last_wager_at: string | null;
}

export interface AgentSummaryRow {
  agent_login: string | null;
  wager_count: number;
  total_volume: number | null;
}

export interface AgentDataResponse {
  agent: AgentSummaryRow | null;
  wagers: WagerRow[];
  alerts: AlertRow[];
}

export interface AgentHierarchyNode {
  AgentID?: string;
  SeqNumber?: number | null;
  Level?: number | null;
  AgentType?: string | null;
  Login?: string;
  ParentAgentID?: string;
  ChildCount?: number;
  PlayerCount?: number;
  HeadCountRateM?: number;
  InetHeadCountRateM?: number;
  CasinoHeadCountRateM?: number;
  LiveBettingRateM?: number;
  LiveBetting2RateM?: number;
  LiveCasinoRateM?: number;
  PropBuilderRateM?: number;
  FlashBetsRate?: number;
  ExtPropsRate?: number;
  CrashRate?: number;
  FantasyRate?: number;
  AmigoTechRate?: number;
}

export interface AgentHierarchyResponse {
  GENERAL: AgentHierarchyNode[];
  meta?: { source?: string; agentCount?: number; playerCount?: number };
  source?: string;
  message?: string;
  error?: string;
}

export interface HierarchyBackfillResponse {
  success: boolean;
  provider: string;
  agents: number;
  players: number;
  linkedPlayers: number;
  placeholderAgents: number;
  maxSeqNumber: number;
}

export interface AccessLogRow {
  id: string;
  agent_id: string;
  login_id: string;
  ip_address: string;
  access_datetime: string;
  operation: string | null;
  data: string | null;
  log_type: string;
  pulled_at: string;
  raw_json: string;
}

export interface AgentPerformanceOverview {
  wager_count: number;
  unique_players: number;
  total_volume: number | null;
  total_risk: number | null;
  total_potential_payout: number | null;
  avg_wager: number | null;
  max_wager: number | null;
  first_wager_at: string | null;
  last_wager_at: string | null;
}

export interface AgentPerformanceResponse {
  agentId: string;
  overview: AgentPerformanceOverview | Record<string, never>;
  typeBreakdown: Array<{ wager_type: string | null; count: number; volume: number | null }>;
  sourceBreakdown: Array<{ ticket_writer: string | null; count: number; volume: number | null }>;
}

export interface PlayerProfile {
  login: string | null;
  agent_login: string | null;
  wager_count: number;
  total_volume: number | null;
  total_risk: number | null;
  total_potential_payout: number | null;
  projected_net_exposure: number;
  avg_wager: number | null;
  max_wager: number | null;
  first_wager_at: string | null;
  last_wager_at: string | null;
}

export interface PlayerDetailsResponse {
  playerId: string;
  profile: PlayerProfile | Record<string, never>;
  agents: Array<string | null>;
}

export interface PlayerPnlDay {
  day: string;
  wager_count: number;
  volume: number | null;
  risk: number | null;
  potential_payout: number | null;
}

export interface SportExposureRow {
  sport: string;
  total: number;
  pct: string;
  live: number;
  wagerCount: number;
  topGame: string;
  side: string;
  price: string;
  gameTotal: number;
}

export interface AgentExposureRow {
  agent: string;
  total: number;
  pct: string;
  live: number;
  wagerCount: number;
  topCustomer: string;
  topCustomerVol: number;
  topGame: string;
  topGameVol: number;
  topGameCount: number;
}

export interface ScraperAgentMetric {
  agentId: string;
  lastPoll: number;
  errorCount: number;
  authenticated: boolean;
}

export interface ActionQueueMetrics {
  totalQueued: number;
  queues: Record<string, number>;
}

export interface ScraperMetrics {
  activeAgents: number;
  agents: ScraperAgentMetric[];
  actionQueue: ActionQueueMetrics;
  counters: {
    wagers_total: number;
    alerts_triggered_total: number;
    errors_total: number;
  };
}

export interface HealthResponse {
  status: 'ok';
  uptime: number;
  scrapers: ScraperMetrics;
}

export interface ApiErrorBody {
  error: string;
  details?: string;
}

export interface EventRow {
  id: string;
  sport: string;
  league: string | null;
  home_team: string;
  away_team: string;
  start_time: string | null;
  status: string | null;
  last_updated: string;
}

export interface OddsSnapshotRow {
  id: number;
  event_id: string;
  book: string;
  spread_home: number | null;
  spread_away: number | null;
  spread_home_price: number | null;
  spread_away_price: number | null;
  total_over: number | null;
  total_under: number | null;
  total_over_price: number | null;
  total_under_price: number | null;
  moneyline_home: number | null;
  moneyline_away: number | null;
  scraped_at: string;
}

export interface OddsSnapshotWithEvent extends OddsSnapshotRow {
  sport: string;
  league: string | null;
  home_team: string;
  away_team: string;
  start_time: string | null;
}

export interface LineMovementRow {
  id: number;
  event_id: string;
  book: string;
  market: string;
  side: string;
  old_value: number;
  new_value: number;
  delta: number;
  recorded_at: string;
}

export interface BookHealthRow {
  book: string;
  status: string | null;
  last_seen: string | null;
  error_count: number | null;
  last_error: string | null;
}

export interface BookListItem {
  key: string;
  name: string;
  status: string;
  category: string;
}

export interface BookMeta {
  key: string;
  name: string;
  status: string;
  lastSeen: string | null;
}

export interface DetectedPatternRow {
  id: string;
  event_id: string;
  type: string;
  market: string;
  side: string;
  severity: string;
  score: number;
  category: string;
  wager_number: number | null;
  agent_login: string | null;
  trigger_book: string | null;
  details_json: string;
  description: string | null;
  detected_at: string;
  created_at: string;
  sport: string | null;
  league: string | null;
  home_team: string | null;
  away_team: string | null;
  start_time: string | null;
}

export interface PatternSummaryRow {
  type: string;
  severity: string;
  category: string;
  count: number;
  last_detected_at: string | null;
}

export interface PatternSummaryResponse {
  sinceHours: number;
  total: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  rows: PatternSummaryRow[];
}

export interface PatternAgentCount {
  agent: string;
  pattern_count: number;
  critical_count: number | null;
  last_detected_at: string | null;
}

export interface QuoteSide {
  home: number | null;
  away: number | null;
}

export interface SpreadQuote extends QuoteSide {
  homePrice: number | null;
  awayPrice: number | null;
}

export interface TotalQuote {
  over: number | null;
  under: number | null;
  overPrice: number | null;
  underPrice: number | null;
}

export interface LiveBookQuote {
  moneyline: QuoteSide & { lastUpdated: string };
  spread: SpreadQuote & { lastUpdated: string };
  total: TotalQuote & { lastUpdated: string };
  openLine: { spread: SpreadQuote; moneyline: QuoteSide; total: TotalQuote } | null;
  recentMoves?: Record<string, LineMovementRow[]>;
}

export interface BestPrice {
  book: string;
  val: number;
}

export interface LiveOddsGame {
  id: string;
  sport: string;
  league: string | null;
  home: string;
  away: string;
  startTime: string | null;
  status: string | null;
  consensus: { spread: SpreadQuote; moneyline: QuoteSide; total: TotalQuote } | null;
  bestPrices: Record<string, Record<string, BestPrice | null>>;
  recentMovementCount: number;
  books: Record<string, LiveBookQuote>;
}

export interface OddsPatternPayload {
  id: string;
  eventId: string;
  type: string;
  market: string;
  side: string;
  severity: Severity;
  score: number;
  triggerBook: string;
  followedBy: Array<{ book: string; newValue: number; lagMs: number }>;
  detectedAt: string;
  description: string;
}

export interface LiveOddsMatrix {
  games: LiveOddsGame[];
  books: BookMeta[];
  movements: LineMovementRow[];
  patterns: OddsPatternPayload[];
}

export type WebhookPlatform = 'discord' | 'slack' | 'telegram' | 'generic';

export interface WebhookConfig {
  id?: number;
  name: string;
  platform: WebhookPlatform;
  url: string;
  triggers: string[];
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface WebhookDelivery {
  id?: number;
  webhookId: number;
  alertId?: number;
  payload: string;
  responseStatus?: number;
  responseBody?: string;
  success: boolean;
  attemptedAt?: string;
}

export interface WebhookDeleteResponse {
  success: boolean;
}

export interface VaultAgentStatus {
  agentId: string | null;
  hasPassword: boolean;
  hasCfCookie: boolean;
  hasToken: boolean;
  active: boolean;
  lastError?: string;
}

export type VaultStatusResponse =
  | { available: false; agents: [] }
  | { available: true; agents: VaultAgentStatus[] }
  | (VaultAgentStatus & { available: true });

export type VaultClearResponse =
  | { success: false; message: string }
  | { success: true; cleared: 'all'; count: number; message: string }
  | { success: true; agentId: string | null; message: string };

export interface BuckeyeFailure {
  data?: null;
  parsed?: null;
  accountInfo?: null;
  message?: string;
  error?: string;
  agentId?: string;
  sportsType?: unknown;
}

export interface BuckeyeAgentPerformanceRow {
  customerId: string;
  agentId: string;
  login: string;
  wagerCount: number;
  risk: number;
  toWin: number;
  amountWon: number;
  amountLost: number;
  volume: number;
  net: number;
}

export interface BuckeyeAgentPerformanceTotals {
  wagerCount: number;
  risk: number;
  toWin: number;
  amountWon: number;
  amountLost: number;
  volume: number;
  net: number;
}

export interface BuckeyeAgentPerformanceReport {
  fetchedAt: string;
  agentId: string;
  params: {
    start: string;
    end: string;
    agentID: string;
    type: string;
    freePlay: string;
    store: string;
    sport: string;
    subsport: string;
    period: string;
    wagerType: string;
    betType: string;
    tipo: string;
    debug: string;
    operation: string;
    RRO: string;
    agentOwner: string;
    agentSite: string;
    group: string;
  };
  parsed: {
    rows: BuckeyeAgentPerformanceRow[];
    totals: BuckeyeAgentPerformanceTotals;
  };
  data: unknown;
  redactedFields: string[];
  message?: string;
  error?: string;
}

export interface NamedValue {
  value: string;
  label: string;
}

export interface SportOption extends NamedValue {
  rawValue: string;
}

export interface OptionField {
  key: string;
  required: boolean;
  default: string;
  meaning: string;
  example?: string;
  alias?: string;
  valuesRef?: string;
  values?: NamedValue[];
}

export interface AgentPerformanceOptionsResponse {
  requestFields: OptionField[];
  reportTypes: NamedValue[];
  activities: NamedValue[];
  groups: NamedValue[];
  weekPresets: NamedValue[];
  sports: SportOption[];
  wagerTypes: NamedValue[];
  betTypes: NamedValue[];
  periods: NamedValue[];
}

export interface BuckeyeSportTypeItem {
  sportType: string;
  '0': string;
  label: string;
  value: string;
  sortOrder: number;
  source: string;
}

export interface BuckeyeSportTypesResponse {
  LIST: BuckeyeSportTypeItem[];
}

export interface ConnectResponse {
  success: true;
  message: string;
  wagerCount: number;
  sample: EnrichedWager | null;
}

export interface PerformanceStatusResponse {
  cacheEnabled: boolean;
  redisConnected: boolean;
  defaultTtlMs: number | undefined;
}

export interface PerformanceCacheResponse {
  agentId: string;
  source: 'cache' | 'api';
  data: unknown;
}

export interface PerformanceInvalidateResponse {
  message: string;
  agentId: string;
}

export interface RawLogRow {
  id: number;
  endpoint: string;
  fetched_at: string;
  agent_id: string | null;
  duration_ms: number | null;
  status_code: number | null;
  request_params: string | null;
  response_json?: string;
  request_params_summary: string;
}

export interface RawLogsResponse {
  logs: RawLogRow[];
  count: number;
  days: number;
  endpoint: string | null;
  agentId: string | null;
  status: string | null;
  includeBody: boolean;
}

export interface WeeklyFigureListRow {
  id: number;
  agent_id: string;
  week: number | null;
  type: string;
  layout: string;
  this_week: number | null;
  active: number | null;
  today: number | null;
  info: string | null;
  pulled_at: string;
}

export interface WeeklyFiguresResponse {
  figures: WeeklyFigureListRow[];
  count: number;
  agentId: string | null;
  week: string | null;
}

export interface MasterSnapshotListRow {
  id: number;
  provider?: string | null;
  agent_id: string;
  timestamp: string;
  balance: number | null;
  available_balance: number | null;
  percent_book: number | null;
  open_wager_count: number | null;
}

export interface MasterSnapshotsResponse {
  snapshots: MasterSnapshotListRow[];
  count: number;
  agentId?: string | null;
}

export interface PerformanceTrendRow {
  day: string;
  agent_id: string | null;
  daily_volume: number | null;
  daily_net: number | null;
  daily_wager_count: number | null;
}

export interface PerformanceTrendsResponse {
  days: number;
  trends: PerformanceTrendRow[];
}

export interface WagerVelocityRow {
  hour: string;
  wager_count: number;
  total_volume: number | null;
}

export interface AnalyticsWagerVelocityResponse {
  hours: number;
  velocity: WagerVelocityRow[];
}

export interface BettingVelocityPoint {
  timestamp: string | null;
  wagerCount: number;
  totalHandle: number;
}

export interface BettingVelocityResponse {
  minutes: number;
  velocity: BettingVelocityPoint[];
}

export interface LiveVsPreResponse {
  date: string;
  live: { count: number; volume: number };
  pregame: { count: number; volume: number };
}

export interface AccessLogListItem extends AccessLogRow {
  first_seen: string;
  is_new_ip: boolean;
}

export interface AccessLogsResponse {
  logs: AccessLogListItem[];
  count: number;
}

export interface PerformanceSummaryRow {
  agent_id: string;
  row_count: number;
  handle: number | null;
  win_loss: number | null;
  last_ingested_at: string | null;
}

export interface PerformanceSummaryResponse {
  week: string | null;
  summary: PerformanceSummaryRow[];
  count: number;
}

export interface WeeklyTrendRow {
  week_start_date: string | null;
  sport: string | null;
  handle: number | null;
  win_loss: number | null;
  wager_type: string | null;
  ingested_at: string | null;
}

export interface SportBreakdownRow {
  sport: string;
  rows: number;
  handle: number | null;
  win_loss: number | null;
}

export interface LatestPerformanceRaw {
  recorded_at: string;
  performance_json: string;
}

export interface PerformanceDetailsResponse {
  agentId: string;
  weeks: number;
  weeklyTrend: WeeklyTrendRow[];
  sportBreakdown: SportBreakdownRow[];
  latestRaw: LatestPerformanceRaw | null;
}

export interface AgentDelta {
  agent: string;
  total_volume: number;
  total_risk: number;
  wager_count: number;
  alert_count: number;
  live_count: number;
  top_game: string;
  top_customer: string;
}

export interface ActionResultPayload {
  id: string;
  success: boolean;
  action: 'accept' | 'decline';
  wagerNumber: number;
  message: string;
  error?: string;
}

export interface WagerPatternPayload {
  id: string;
  eventId: string;
  type: string;
  category: 'odds' | 'wagers' | 'agents' | 'ip' | 'live' | 'feed';
  market: string;
  side: string;
  severity: Severity;
  score: number;
  wagerNumber?: number | null;
  agentLogin?: string | null;
  triggerBook?: string | null;
  details: Record<string, unknown>;
  description: string;
  detectedAt: string;
}

export type PatternDetectedPayload = OddsPatternPayload | WagerPatternPayload;

export interface LineMovementPayload {
  eventId: string;
  book: string;
  market: 'spread' | 'total' | 'moneyline';
  side: 'home' | 'away' | 'over' | 'under';
  oldValue: number;
  newValue: number;
  delta: number;
  recordedAt: string;
}
