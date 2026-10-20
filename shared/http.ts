/**
 * HTTP route map: method + path -> params, query, body, response.
 * Registration order lives in `routeCatalog` and is the order the router mounts.
 */
import type {
  AccessLogRow,
  AccessLogsResponse,
  AgentDataResponse,
  AgentDownlineRow,
  AgentExposureRow,
  AgentHierarchyResponse,
  AgentPerformanceOptionsResponse,
  AgentPerformanceResponse,
  AgentVolumeRow,
  AlertRow,
  AnalyticsWagerVelocityResponse,
  ApiErrorBody,
  BettingVelocityResponse,
  BookHealthRow,
  BookListItem,
  BuckeyeAgentPerformanceReport,
  BuckeyeFailure,
  BuckeyeSportTypesResponse,
  ConnectResponse,
  DetectedPatternRow,
  EventRow,
  HealthResponse,
  HierarchyBackfillResponse,
  LiveOddsMatrix,
  LiveVsPreResponse,
  MasterSnapshotsResponse,
  OddsSnapshotRow,
  OddsSnapshotWithEvent,
  PatternAgentCount,
  PatternSummaryResponse,
  PerformanceCacheResponse,
  PerformanceDetailsResponse,
  PerformanceInvalidateResponse,
  PerformanceStatusResponse,
  PerformanceSummaryResponse,
  PerformanceTrendsResponse,
  PlayerDetailsResponse,
  PlayerPnlDay,
  RawLogsResponse,
  ScraperMetrics,
  SportExposureRow,
  StatsResponse,
  VaultClearResponse,
  VaultStatusResponse,
  WagerRow,
  WebhookConfig,
  WebhookDeleteResponse,
  WebhookDelivery,
  WeeklyFiguresResponse,
  LineMovementRow,
} from './domain.ts';
import type { BuckeyeSessionBody, WebhookCreateBody, WebhookUpdateBody } from './schemas.ts';

export type NoParams = Record<string, never>;
export type NoQuery = Record<string, never>;
export type NoBody = undefined;

export interface RouteContract<TParams, TQuery, TBody, TResponse> {
  params: TParams;
  query: TQuery;
  body: TBody;
  response: TResponse;
}

type Spec<TParams, TQuery, TBody, TResponse> = RouteContract<TParams, TQuery, TBody, TResponse>;

export interface LimitQuery {
  limit?: string;
}

export interface LimitOffsetQuery {
  limit?: string;
  offset?: string;
}

export interface AgentIdQuery {
  agentId?: string;
}

export interface PlayerPnlQuery {
  days?: string;
}

export interface MovementsQuery {
  eventId?: string;
  limit?: string;
}

export interface PatternHistoryQuery {
  limit?: string;
  sinceHours?: string;
  type?: string;
  market?: string;
  severity?: string;
  category?: string;
  sport?: string;
  agent?: string;
  eventId?: string;
}

export interface SinceHoursQuery {
  sinceHours?: string;
}

export interface LiveOddsQuery {
  sport?: string;
  books?: string;
  includeBookMoves?: string;
}

export interface VaultStatusQuery {
  agentId?: string;
  all?: string;
}

export interface FlagQuery {
  agentId?: string;
  includeRaw?: string;
  includeAgentParams?: string;
}

export interface AccountInfoQuery {
  agentId?: string;
  force?: string;
}

export interface WeeklyFigureQuery {
  agentId?: string;
  week?: string;
  type?: string;
  layout?: string;
}

export interface AgentPerformanceQuery {
  agentId?: string;
  week?: string;
  start?: string;
  end?: string;
  reportAgentId?: string;
  type?: string;
  freePlay?: string;
  store?: string;
  sport?: string;
  subsport?: string;
  period?: string;
  wagerType?: string;
  betType?: string;
  tipo?: string;
  activity?: string;
  group?: string;
  debug?: string;
  agentOwner?: string;
}

export interface RawLogsQuery {
  endpoint?: string;
  agentId?: string;
  status?: string;
  includeBody?: string;
  limit?: string;
  days?: string;
}

export interface WeeklyFiguresQuery {
  agentId?: string;
  week?: string;
  limit?: string;
}

export interface DaysQuery {
  days?: string;
}

export interface HoursQuery {
  hours?: string;
}

export interface MinutesQuery {
  minutes?: string;
}

export interface DateQuery {
  date?: string;
}

export interface AccessQuery {
  agent?: string;
  ip?: string;
  limit?: string;
}

export interface WeekQuery {
  week?: string;
}

export interface PerformanceDetailsQuery {
  agent?: string;
  weeks?: string;
}

export interface BuckeyeUiConfigResponse {
  url?: string;
  fetchedAt?: string;
  agentId?: string;
  parsed: unknown;
  config?: unknown;
  message?: string;
  error?: string;
}

export interface BuckeyeAccountInfoResponse {
  fetchedAt?: string;
  agentId?: string;
  parsed?: unknown;
  accountInfo: Record<string, unknown> | null;
  preferenceDate?: unknown[];
  site?: unknown[];
  server?: unknown;
  redactedFields?: string[];
  message?: string;
  error?: string;
}

export type BuckeyeWeeklyFigureResponse =
  | {
      fetchedAt: string;
      agentId: string;
      params: { week: number; type: string; layout: string };
      parsed: { thisWeek: number; active: number; today: number; info: string };
      data: unknown;
      message?: string;
      error?: string;
    }
  | BuckeyeFailure;

export type BuckeyeAgentPerformanceResponse = BuckeyeAgentPerformanceReport | BuckeyeFailure;

export type BuckeyeManagerSnapshotResponse =
  | {
      fetchedAt: string;
      agentId: string;
      configWebReports: unknown;
      configWebReportsPending: unknown;
      sportsType: unknown;
      authorizations: unknown;
      message?: unknown;
      newEmailsCount: unknown;
      error?: string;
      data?: unknown;
    }
  | BuckeyeFailure;

export interface ApiRoutes {
  'OPTIONS /api/*': Spec<NoParams, NoQuery, NoBody, null>;
  'GET /health': Spec<NoParams, NoQuery, NoBody, HealthResponse>;
  'GET /metrics': Spec<NoParams, NoQuery, NoBody, ScraperMetrics>;
  'GET /api/stats': Spec<NoParams, NoQuery, NoBody, StatsResponse>;
  'GET /api/wagers': Spec<NoParams, LimitOffsetQuery, NoBody, WagerRow[]>;
  'GET /api/wagers/alerts': Spec<NoParams, NoQuery, NoBody, WagerRow[]>;
  'GET /api/wagers/live': Spec<NoParams, NoQuery, NoBody, WagerRow[]>;
  'GET /api/agents': Spec<NoParams, NoQuery, NoBody, AgentVolumeRow[]>;
  'GET /api/agents/downline': Spec<NoParams, NoQuery, NoBody, AgentDownlineRow[]>;
  'GET /api/agents/hierarchy': Spec<NoParams, AgentIdQuery, NoBody, AgentHierarchyResponse>;
  'POST /api/agents/backfill/hierarchy': Spec<NoParams, NoQuery, NoBody, HierarchyBackfillResponse>;
  'GET /api/agents/access-logs': Spec<NoParams, NoQuery, NoBody, AccessLogRow[]>;
  'GET /api/agents/:agentId/performance': Spec<{ agentId: string }, NoQuery, NoBody, AgentPerformanceResponse>;
  'GET /api/agents/:agentId/exposure': Spec<{ agentId: string }, NoQuery, NoBody, AgentDataResponse>;
  'GET /api/players/:playerId/details': Spec<{ playerId: string }, NoQuery, NoBody, PlayerDetailsResponse>;
  'GET /api/players/:playerId/wagers': Spec<{ playerId: string }, NoQuery, NoBody, WagerRow[]>;
  'GET /api/players/:playerId/pnl': Spec<{ playerId: string }, PlayerPnlQuery, NoBody, PlayerPnlDay[]>;
  'GET /api/risk/alerts': Spec<NoParams, NoQuery, NoBody, AlertRow[]>;
  'GET /api/exposure/sports': Spec<NoParams, NoQuery, NoBody, SportExposureRow[]>;
  'GET /api/exposure/agents': Spec<NoParams, NoQuery, NoBody, AgentExposureRow[]>;
  'GET /api/webhooks': Spec<NoParams, NoQuery, NoBody, WebhookConfig[]>;
  'POST /api/webhooks': Spec<NoParams, NoQuery, WebhookCreateBody, WebhookConfig>;
  'GET /api/webhooks/:webhookId': Spec<{ webhookId: string }, NoQuery, NoBody, WebhookConfig | null>;
  'PUT /api/webhooks/:webhookId': Spec<{ webhookId: string }, NoQuery, WebhookUpdateBody, WebhookConfig | null>;
  'DELETE /api/webhooks/:webhookId': Spec<{ webhookId: string }, NoQuery, NoBody, WebhookDeleteResponse>;
  'GET /api/webhooks/:webhookId/deliveries': Spec<{ webhookId: string }, NoQuery, NoBody, WebhookDelivery[]>;
  'GET /api/odds/live': Spec<NoParams, LiveOddsQuery, NoBody, LiveOddsMatrix>;
  'GET /api/odds/events': Spec<NoParams, NoQuery, NoBody, EventRow[]>;
  'GET /api/odds/events/:eventId': Spec<{ eventId: string }, NoQuery, NoBody, OddsSnapshotRow[]>;
  'GET /api/odds/snapshots': Spec<NoParams, NoQuery, NoBody, OddsSnapshotWithEvent[]>;
  'GET /api/odds/movements': Spec<NoParams, MovementsQuery, NoBody, LineMovementRow[]>;
  'GET /api/books': Spec<NoParams, NoQuery, NoBody, BookListItem[]>;
  'GET /api/books/status': Spec<NoParams, NoQuery, NoBody, BookHealthRow[]>;
  'GET /api/patterns/history': Spec<NoParams, PatternHistoryQuery, NoBody, DetectedPatternRow[]>;
  'GET /api/patterns/summary': Spec<NoParams, SinceHoursQuery, NoBody, PatternSummaryResponse>;
  'GET /api/patterns/agents': Spec<NoParams, SinceHoursQuery, NoBody, PatternAgentCount[]>;
  'GET /api/buckeye/vault-status': Spec<NoParams, VaultStatusQuery, NoBody, VaultStatusResponse>;
  'DELETE /api/buckeye/vault-status': Spec<NoParams, VaultStatusQuery, NoBody, VaultClearResponse>;
  'GET /api/buckeye/ui-config': Spec<NoParams, FlagQuery, NoBody, BuckeyeUiConfigResponse>;
  'GET /api/buckeye/account-info': Spec<NoParams, AccountInfoQuery, NoBody, BuckeyeAccountInfoResponse>;
  'GET /api/buckeye/weekly-figures': Spec<NoParams, WeeklyFigureQuery, NoBody, BuckeyeWeeklyFigureResponse>;
  'GET /api/buckeye/agent-performance/options': Spec<NoParams, NoQuery, NoBody, AgentPerformanceOptionsResponse>;
  'GET /api/buckeye/access-logs': Spec<NoParams, LimitQuery, NoBody, AccessLogRow[]>;
  'GET /api/buckeye/agent-performance': Spec<NoParams, AgentPerformanceQuery, NoBody, BuckeyeAgentPerformanceResponse>;
  'GET /api/buckeye/sports-types': Spec<NoParams, NoQuery, NoBody, BuckeyeSportTypesResponse>;
  'GET /api/buckeye/manager-snapshot': Spec<NoParams, AgentIdQuery, NoBody, BuckeyeManagerSnapshotResponse>;
  'POST /api/connect': Spec<NoParams, NoQuery, BuckeyeSessionBody, ConnectResponse>;
  'GET /api/performance/status': Spec<NoParams, NoQuery, NoBody, PerformanceStatusResponse>;
  'GET /api/betting/velocity': Spec<NoParams, MinutesQuery, NoBody, BettingVelocityResponse>;
  'GET /api/betting/live-vs-pre': Spec<NoParams, DateQuery, NoBody, LiveVsPreResponse>;
  'GET /api/logs/access': Spec<NoParams, AccessQuery, NoBody, AccessLogsResponse>;
  'GET /api/master/history': Spec<NoParams, LimitQuery, NoBody, MasterSnapshotsResponse>;
  'GET /api/performance/summary': Spec<NoParams, WeekQuery, NoBody, PerformanceSummaryResponse>;
  'GET /api/performance/details': Spec<NoParams, PerformanceDetailsQuery, NoBody, PerformanceDetailsResponse>;
  'GET /api/export/wagers': Spec<NoParams, NoQuery, NoBody, string | ApiErrorBody>;
  'GET /api/export/access-logs': Spec<NoParams, NoQuery, NoBody, string | ApiErrorBody>;
  'GET /api/export/performance': Spec<NoParams, NoQuery, NoBody, string | ApiErrorBody>;
  'GET /api/analytics/raw-logs': Spec<NoParams, RawLogsQuery, NoBody, RawLogsResponse>;
  'GET /api/analytics/weekly-figures': Spec<NoParams, WeeklyFiguresQuery, NoBody, WeeklyFiguresResponse>;
  'GET /api/analytics/master-snapshots': Spec<NoParams, WeeklyFiguresQuery, NoBody, MasterSnapshotsResponse>;
  'GET /api/analytics/performance-trends': Spec<NoParams, DaysQuery, NoBody, PerformanceTrendsResponse>;
  'GET /api/analytics/wager-velocity': Spec<NoParams, HoursQuery, NoBody, AnalyticsWagerVelocityResponse>;
  'GET /api/performance/:agentId': Spec<{ agentId: string }, NoQuery, NoBody, PerformanceCacheResponse | ApiErrorBody>;
  'DELETE /api/performance/:agentId': Spec<{ agentId: string }, NoQuery, NoBody, PerformanceInvalidateResponse | ApiErrorBody>;
  /** Static files. The handler returns bytes with a Content-Type, not JSON. */
  'ALL /*': Spec<NoParams, NoQuery, NoBody, Uint8Array | string>;
}

/** Mount order. More specific paths stay ahead of `:param` and the static catch-all. */
export const routeCatalog = [
  'OPTIONS /api/*',
  'GET /health',
  'GET /metrics',
  'GET /api/stats',
  'GET /api/wagers',
  'GET /api/wagers/alerts',
  'GET /api/wagers/live',
  'GET /api/agents',
  'GET /api/agents/downline',
  'GET /api/agents/hierarchy',
  'POST /api/agents/backfill/hierarchy',
  'GET /api/agents/access-logs',
  'GET /api/agents/:agentId/performance',
  'GET /api/agents/:agentId/exposure',
  'GET /api/players/:playerId/details',
  'GET /api/players/:playerId/wagers',
  'GET /api/players/:playerId/pnl',
  'GET /api/risk/alerts',
  'GET /api/exposure/sports',
  'GET /api/exposure/agents',
  'GET /api/webhooks',
  'POST /api/webhooks',
  'GET /api/webhooks/:webhookId',
  'PUT /api/webhooks/:webhookId',
  'DELETE /api/webhooks/:webhookId',
  'GET /api/webhooks/:webhookId/deliveries',
  'GET /api/odds/live',
  'GET /api/odds/events',
  'GET /api/odds/events/:eventId',
  'GET /api/odds/snapshots',
  'GET /api/odds/movements',
  'GET /api/books',
  'GET /api/books/status',
  'GET /api/patterns/history',
  'GET /api/patterns/summary',
  'GET /api/patterns/agents',
  'GET /api/buckeye/vault-status',
  'DELETE /api/buckeye/vault-status',
  'GET /api/buckeye/ui-config',
  'GET /api/buckeye/account-info',
  'GET /api/buckeye/weekly-figures',
  'GET /api/buckeye/agent-performance/options',
  'GET /api/buckeye/access-logs',
  'GET /api/buckeye/agent-performance',
  'GET /api/buckeye/sports-types',
  'GET /api/buckeye/manager-snapshot',
  'POST /api/connect',
  'GET /api/performance/status',
  'GET /api/betting/velocity',
  'GET /api/betting/live-vs-pre',
  'GET /api/logs/access',
  'GET /api/master/history',
  'GET /api/performance/summary',
  'GET /api/performance/details',
  'GET /api/export/wagers',
  'GET /api/export/access-logs',
  'GET /api/export/performance',
  'GET /api/analytics/raw-logs',
  'GET /api/analytics/weekly-figures',
  'GET /api/analytics/master-snapshots',
  'GET /api/analytics/performance-trends',
  'GET /api/analytics/wager-velocity',
  'GET /api/performance/:agentId',
  'DELETE /api/performance/:agentId',
  'ALL /*',
] as const satisfies readonly (keyof ApiRoutes)[];

export type RouteKey = (typeof routeCatalog)[number];

type MissingRoute = Exclude<keyof ApiRoutes, RouteKey>;
type ExtraRoute = Exclude<RouteKey, keyof ApiRoutes>;
type RoutesInSync = [MissingRoute] extends [never]
  ? [ExtraRoute] extends [never]
    ? true
    : never
  : never;

export const routesInSync: RoutesInSync = true;

export type RouteParams<K extends RouteKey> = ApiRoutes[K]['params'];
export type RouteQuery<K extends RouteKey> = ApiRoutes[K]['query'];
export type RouteBody<K extends RouteKey> = ApiRoutes[K]['body'];
export type RouteResponse<K extends RouteKey> = ApiRoutes[K]['response'];

export function splitRouteKey(key: RouteKey): { method: string; path: string } {
  const separator = key.indexOf(' ');
  return { method: key.slice(0, separator), path: key.slice(separator + 1) };
}
