/**
 * Socket, broadcast, webhook, and internal event messages.
 *
 * The odds grid still receives WebSocket frames (`odds.update`, `odds.movement`,
 * `pattern.detected`). Live price deltas also arrive on `GET /api/odds/stream`.
 */
import type {
  ActionResultPayload,
  AgentDataResponse,
  AgentDelta,
  Alert,
  EnrichedWager,
  LineMovementPayload,
  PatternDetectedPayload,
  Severity,
  WebhookPlatform,
} from './domain.ts';

export interface AuthClientMessage {
  type: 'auth';
  agentId?: string;
  username?: string;
  password?: string;
  cfCookie?: string;
  token?: string;
}

export interface RequestDataClientMessage {
  type: 'request_data';
  agentId?: string;
}

export interface RefreshClientMessage {
  type: 'refresh';
  agentId?: string;
}

export interface BetActionClientMessage {
  type: 'betAction';
  agentId?: string;
  action?: string;
  wagerNumber?: number | string;
  amount?: number;
  reason?: string;
}

export interface TokenRefreshClientMessage {
  type: 'token_refresh';
}

export type ClientSocketMessage =
  | AuthClientMessage
  | RequestDataClientMessage
  | RefreshClientMessage
  | BetActionClientMessage
  | TokenRefreshClientMessage;

export type ClientSocketKind = ClientSocketMessage['type'];

export interface AuthResponseMessage {
  type: 'auth_response';
  success: boolean;
  message: string;
  token?: string;
}

export interface DataResponseMessage {
  type: 'data_response';
  agentId?: string;
  data: AgentDataResponse;
}

export interface DataErrorMessage {
  type: 'data_error';
  agentId?: string;
  message: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface RefreshInitiatedMessage {
  type: 'refresh_initiated';
  agentId?: string;
}

export interface BetActionQueuedMessage {
  type: 'betAction_queued';
  actionId: string;
  agentId: string;
  wagerNumber: number;
  action: 'accept' | 'decline';
}

export interface BetActionErrorMessage {
  type: 'betAction_error';
  message: string;
}

export interface TokenRefreshedMessage {
  type: 'token_refreshed';
  token: string;
}

export interface TokenRefreshErrorMessage {
  type: 'token_refresh_error';
  message: string;
}

export type ServerSocketReply =
  | AuthResponseMessage
  | DataResponseMessage
  | DataErrorMessage
  | ErrorMessage
  | RefreshInitiatedMessage
  | BetActionQueuedMessage
  | BetActionErrorMessage
  | TokenRefreshedMessage
  | TokenRefreshErrorMessage;

export interface WagerNewMessage {
  type: 'wager.new';
  timestamp: string;
  payload: EnrichedWager;
}

export interface WagerAlertMessage {
  type: 'wager.alert';
  timestamp: string;
  payload: Alert;
}

export interface AgentUpdateMessage {
  type: 'agentUpdate';
  timestamp: string;
  agentId: string;
  payload: AgentDelta;
}

export interface ExposureUpdateMessage {
  type: 'exposure.update';
  timestamp: string;
  payload: Record<string, never>;
}

export interface AuthFailedMessage {
  type: 'auth_failed';
  timestamp: string;
  agentId: string;
  message: string;
}

export interface OddsMovementMessage {
  type: 'odds.movement';
  timestamp: string;
  payload: LineMovementPayload;
}

export interface OddsUpdateMessage {
  type: 'odds.update';
  timestamp: string;
  payload: { events: number };
}

export interface PatternDetectedMessage {
  type: 'pattern.detected';
  timestamp: string;
  payload: PatternDetectedPayload;
}

export interface PatternUpdateMessage {
  type: 'patternUpdate';
  timestamp: string;
  payload: {
    agentLogin: string;
    increment: number;
    severity: Severity;
    type: string;
  };
}

export interface WeeklyFigureMessage {
  type: 'weeklyFigure.new';
  timestamp: string;
  agentId: string;
  payload: {
    thisWeek?: number;
    active?: number;
    today?: number;
    info?: string;
  };
}

export interface MasterSnapshotMessage {
  type: 'masterSnapshot.new';
  timestamp: string;
  agentId: string;
  payload: { fetchedAt?: string };
}

export interface AgentPerformanceUpdateMessage {
  type: 'agentPerformance.update';
  timestamp: string;
  agentId: string;
  payload: {
    rows: number;
    totals: {
      wagerCount: number;
      risk: number;
      toWin: number;
      amountWon: number;
      amountLost: number;
      volume: number;
      net: number;
    };
    start: string;
    end: string;
  };
}

export interface BetActionResultMessage {
  type: 'betAction';
  timestamp: string;
  agentId: string;
  payload: ActionResultPayload;
}

/** Listened for by the performance tab. The server does not emit this today. */
export interface RawApiLogMessage {
  type: 'rawApiLog.new';
  timestamp?: string;
  payload?: unknown;
}

export type BroadcastMessage =
  | WagerNewMessage
  | WagerAlertMessage
  | AgentUpdateMessage
  | ExposureUpdateMessage
  | AuthFailedMessage
  | OddsMovementMessage
  | OddsUpdateMessage
  | PatternDetectedMessage
  | PatternUpdateMessage
  | WeeklyFigureMessage
  | MasterSnapshotMessage
  | AgentPerformanceUpdateMessage
  | BetActionResultMessage;

/** Every frame the browser socket client can receive. */
export type ServerMessage = ServerSocketReply | BroadcastMessage | RawApiLogMessage;

export type ServerMessageKind = ServerMessage['type'];

export type ExtractServer<T extends ServerMessageKind> = Extract<ServerMessage, { type: T }>;
export type ExtractClient<T extends ClientSocketKind> = Extract<ClientSocketMessage, { type: T }>;

/** Frames that invalidate or patch the Trading Floor odds grid. */
export type OddsGridFeedEvent = Extract<
  BroadcastMessage,
  { type: 'odds.update' | 'odds.movement' | 'pattern.detected' }
>;

export interface PerformanceCacheEvent {
  type: 'performance_update';
  agentId: string;
  timestamp: string;
}

/** Events that stay inside the process (Redis pub/sub) plus socket broadcasts. */
export type InternalEvent = BroadcastMessage | PerformanceCacheEvent;

export interface DiscordWebhookMessage {
  embeds: Array<{
    title: string;
    description: string;
    color: number;
    timestamp: string;
    footer: { text: string };
  }>;
}

export interface SlackWebhookMessage {
  blocks: Array<
    | { type: 'header'; text: { type: 'plain_text'; text: string; emoji: true } }
    | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
    | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> }
  >;
}

export interface TelegramWebhookMessage {
  text: string;
  parse_mode: 'Markdown';
}

export interface GenericWebhookMessage {
  rule: string;
  severity: Severity;
  message: string;
  wagerNumber: number;
  timestamp: string;
}

export type WebhookOutboundMessage =
  | DiscordWebhookMessage
  | SlackWebhookMessage
  | TelegramWebhookMessage
  | GenericWebhookMessage;

export interface WebhookDispatch {
  platform: WebhookPlatform;
  body: WebhookOutboundMessage;
}
