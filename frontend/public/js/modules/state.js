/**
 * Centralized application state for Sports Terminal.
 * Replaces the scattered top-level `let`/`const` declarations in app.js
 * with a single reactive store. Backward-compatible with `window.FactoryWager.state`.
 */

import { logger } from '../logger.js';

// ==================== CORE STORE ====================

const subscribers = new Map();
let batching = false;
let pendingKeys = new Set();

function notify(key) {
  if (batching) {
    pendingKeys.add(key);
    return;
  }
  const cbs = subscribers.get(key);
  if (cbs) cbs.forEach((cb) => cb(state[key], key));
}

export function batch(fn) {
  batching = true;
  try {
    fn();
  } finally {
    batching = false;
    const keys = [...pendingKeys];
    pendingKeys.clear();
    keys.forEach((k) => notify(k));
  }
}

export function subscribe(key, cb) {
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key).add(cb);
  return () => subscribers.get(key).delete(cb);
}

export function set(key, value) {
  if (state[key] === value) return;
  state[key] = value;
  notify(key);
}

export function get(key) {
  return state[key];
}

export function update(key, updater) {
  const next = typeof updater === 'function' ? updater(state[key]) : updater;
  set(key, next);
}

// ==================== STATE OBJECT ====================

export const state = {
  // Navigation / UI
  currentSection: 'floor',
  oddsFormat: 'american',
  vipOnly: false,
  autoScroll: true,

  // Buckeye / Backend
  buckeyeFilter: 'all',
  buckeyeWagers: [],
  pendingWagers: [],
  pendingWagerExpanded: new Set(),
  pendingWagerLoading: false,
  pendingWagerLastError: '',
  pendingWagerLastFetchAt: null,
  incomingBets: [],
  positions: [],
  alerts: [],

  // Exposure
  sportExposureData: [],
  agentExposureData: [],
  sportExposureSort: { col: 'total', dir: 'desc' },
  agentExposureSort: { col: 'total', dir: 'desc' },

  // Patterns
  patternsData: [],
  patternSummary: { byType: {}, bySeverity: {}, total: 0 },
  patternCatalog: [],
  patternCategory: 'all',
  patternFilterChoices: { agents: [], sports: [] },
  lastPatternRequestKey: '',
  patternsLoading: false,

  // Syndicate / Integrity
  syndicateIntelState: {
    data: null,
    loading: false,
    error: '',
    agentId: '',
    lastFetchAt: null,
  },
  integrityCaseState: {
    cases: [],
    loading: false,
    error: '',
    lastFetchAt: null,
  },
  agentRulesState: {
    rules: [],
    loading: false,
    error: '',
    lastFetchAt: null,
  },

  // Performance
  performanceState: {
    summary: null,
    velocity: null,
    liveVsPre: null,
    ipHistory: null,
    loading: false,
    error: '',
    lastFetchAt: null,
  },

  // Odds Matrix
  currentMatrixData: { games: [], books: [], movements: [] },
  currentBookHealth: {},
  matrixState: {
    market: 'spread',
    sportFilter: 'all',
    searchQuery: '',
    sortBy: 'time',
    showConsensus: false,
    showMovements: true,
    showPatterns: true,
    detailDrawerGameId: null,
  },
  zone1TaxonomyState: {
    sport: null,
    league: null,
    game: null,
    market: 'spread',
  },
  bookPreferences: { order: [], visible: [] },

  // Player Search
  playerSearch: {
    query: '',
    agent: '',
    from: '',
    to: '',
    sort: 'volume',
    players: [],
    agents: [],
    loading: false,
  },

  // Player Profile
  playerProfile: {
    playerId: null,
    profile: null,
    intelligenceMap: null,
    docsLoading: false,
    statusLoading: false,
    statusMap: null,
    crossReference: null,
    crossReferenceLoading: false,
    statusEndpointChecks: [],
    tab: 'overview',
    transactionTab: 'all',
    wagerPage: 1,
    wagerPageSize: 25,
    charts: {},
    virtualLimits: { wagers: 75, access: 100, deposits: 100, transactions: 100, notes: 100 },
    liveRegionMessage: '',
    agentFilter: '',
    accessLogFilters: { actions: 'A', customerId: '', start: '', end: '', ip: '' },
    accessLogLive: [],
    agentContextLoading: false,
  },

  // WebSocket
  ws: {
    subscribedPlayerId: null,
    lastEventAt: null,
  },

  // UI config
  ui: {
    searchDebounceMs: 300,
  },

  // Feature flags
  featureFlags: {
    enablePlayer360: true,
    enableAgentNetwork: true,
    enablePatterns: true,
    enableSyndicateIntel: true,
    enableIntegrityCases: true,
    enablePerformance: true,
    enableLiveBetting: true,
    enablePropBuilder: true,
    enableSandbox: true,
    enableCommandCenter: true,
  },

  // Master / Misc
  masterAccountInfo: null,
  renderFrameId: null,
  currentMovementIndex: {},
  sortColumn: 'time',
  sortDirection: 'desc',
};

// ==================== BACKWARD COMPATIBILITY ====================

/**
 * Sync the legacy `window.FactoryWager.state` object so that
 * any external code or console debugging still works.
 */
export function initLegacyCompat() {
  const FactoryWager = window.FactoryWager || { state: {}, timers: {}, charts: {} };

  // Proxy legacy reads/writes to the new store
  Object.keys(state).forEach((key) => {
    if (key === 'playerSearch' || key === 'playerProfile' || key === 'ws' || key === 'ui') {
      FactoryWager.state[key] = state[key];
      return;
    }
    Object.defineProperty(FactoryWager.state, key, {
      get: () => state[key],
      set: (v) => { state[key] = v; },
      configurable: true,
      enumerable: true,
    });
  });

  window.FactoryWager = FactoryWager;
  logger.info('State', 'Legacy FactoryWager.state synced');
}
