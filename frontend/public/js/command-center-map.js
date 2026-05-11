export const COMMAND_CENTER_MAP = Object.freeze({
  endpoints: Object.freeze({
    liveWagersStream: '/api/stream/live-wagers',
    dashboardExposure: '/api/dashboard/exposure',
    dashboardSharpAlerts: '/api/dashboard/sharp-alerts',
    dashboardPositionsPending: '/api/dashboard/positions-pending',
    analyzeLive: '/api/agent/analyze-live',
    shadowAb: '/api/agent/shadow-ab',
    enforcementQueue: '/api/enforcement/queue',
    enforcementMarkViewed: '/api/enforcement/mark-viewed',
    enforcementMarkApplied: '/api/enforcement/mark-applied',
    enforcementEscalate: '/api/enforcement/escalate',
    backendMap: '/api/command-center/map',
    backendStatus: '/api/command-center/status',
  }),
  auth: Object.freeze({
    queryTokenParam: 'token',
    tokenStorageKeys: Object.freeze(['apiToken', 'wsToken']),
  }),
  sse: Object.freeze({
    events: Object.freeze(['connected', 'wager', 'risk_alert', 'position', 'heartbeat']),
    browserEventPrefix: 'sports-terminal:sse',
  }),
});
