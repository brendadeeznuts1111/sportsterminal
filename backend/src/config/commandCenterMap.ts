export const COMMAND_CENTER_MAP = {
  headers: {
    authorization: 'Authorization',
    contentType: 'Content-Type',
    adminToken: 'X-Admin-Token',
    apiKey: 'X-API-Key',
    sseContentType: 'text/event-stream',
    sseCacheControl: 'no-cache, no-transform',
    sseAccelBuffering: 'X-Accel-Buffering',
  },
  auth: {
    bearerPrefix: 'Bearer ',
    queryTokenParam: 'token',
    sseMode: 'bearer-or-token-query',
  },
  endpoints: {
    commandCenterMap: { method: 'GET', path: '/api/command-center/map', auth: 'jwt' },
    liveWagersStream: { method: 'GET', path: '/api/stream/live-wagers', auth: 'bearer-or-token-query' },
    dashboardExposure: { method: 'GET', path: '/api/dashboard/exposure', auth: 'jwt' },
    dashboardSharpAlerts: { method: 'GET', path: '/api/dashboard/sharp-alerts', auth: 'jwt' },
    dashboardPositionsPending: { method: 'GET', path: '/api/dashboard/positions-pending', auth: 'jwt' },
    analyzeLive: { method: 'POST', path: '/api/agent/analyze-live', auth: 'jwt' },
    shadowAb: { method: 'POST', path: '/api/agent/shadow-ab', auth: 'jwt' },
    enforcementRun: { method: 'POST', path: '/api/enforcement/run', auth: 'admin-if-configured' },
  },
  params: {
    exposure: ['agentId', 'agent_id', 'sport', 'window', 'hours', 'limit'],
    sharpAlerts: ['limit', 'hours', 'riskLevel', 'risk_level'],
    positionsPending: ['status', 'risk_level', 'limit', 'offset'],
    analyzeLiveBody: ['customer_id', 'forceRefresh'],
    shadowAbBody: ['customer_ids', 'prompt_a', 'prompt_b', 'name'],
  },
  windows: {
    day: { hours: 24 },
    week: { hours: 168 },
    month: { hours: 720 },
  },
  sse: {
    events: {
      connected: 'connected',
      wager: 'wager',
      riskAlert: 'risk_alert',
      position: 'position',
      heartbeat: 'heartbeat',
      featureRefresh: 'feature_refresh',
    },
    topics: {
      wagers: 'wagers',
      alerts: 'alerts',
      positions: 'positions',
      ticker: 'ticker',
      wagerAlertBridge: 'ws:wager.alert',
      agentRuleBridge: 'ws:agent_rule.triggered',
    },
    replayLimit: 100,
    ringLimit: 250,
  },
  schedules: {
    featureCandidateMs: 5 * 60_000,
    featureExtractMs: 10 * 60_000,
    portfolioRefreshMs: 15 * 60_000,
    heartbeatMs: 5_000,
  },
  flags: {
    kimiApiKey: 'KIMI_API_KEY',
    adminApiToken: 'ADMIN_API_TOKEN',
    redisUrl: 'REDIS_URL',
    enableGlobalFetchTimeout: 'ENABLE_GLOBAL_FETCH_TIMEOUT',
  },
  logEvents: {
    cronStarted: 'command_center.cron.started',
    featureRefresh: 'command_center.features.refreshed',
    portfolioRefresh: 'command_center.portfolio.refreshed',
    analyzeLive: 'command_center.analyze_live',
    shadowAbStarted: 'command_center.shadow_ab.started',
    shadowAbCompleted: 'command_center.shadow_ab.completed',
    shadowAbFailed: 'command_center.shadow_ab.failed',
  },
  errors: {
    customerIdRequired: { code: 'CUSTOMER_ID_REQUIRED', message: 'customer_id is required' },
    customerIdsRequired: { code: 'CUSTOMER_IDS_REQUIRED', message: 'customer_ids must be a non-empty array' },
    promptsRequired: { code: 'PROMPTS_REQUIRED', message: 'prompt_a and prompt_b are required' },
    shadowAbWorkerFailed: { code: 'SHADOW_AB_WORKER_FAILED', message: 'Shadow A/B worker failed' },
  },
  database: {
    tables: [
      'wagers',
      'wager_archive',
      'players',
      'customer_features',
      'ai_risk_flags',
      'risk_positions',
      'risk_alert_log',
      'live_shadow_ab_tests',
    ],
  },
} as const;

export type CommandCenterEndpointKey = keyof typeof COMMAND_CENTER_MAP.endpoints;
export type CommandCenterSseEvent = typeof COMMAND_CENTER_MAP.sse.events[keyof typeof COMMAND_CENTER_MAP.sse.events];
export type CommandCenterTopic = typeof COMMAND_CENTER_MAP.sse.topics[keyof typeof COMMAND_CENTER_MAP.sse.topics];
export type CommandCenterWindow = keyof typeof COMMAND_CENTER_MAP.windows;

export function getPublicCommandCenterMap(): typeof COMMAND_CENTER_MAP {
  return COMMAND_CENTER_MAP;
}
