import { TerminalWebSocketClient } from './ws-client.js';
import { BUCKEYE_ARCHIVE_LIMIT, DATA_SOURCES, SIDEBAR_GROUP_STORAGE_KEY } from './state.js';
import { createPlayerDocsRenderer } from './player-docs.js';
import { createPlayerTransactionRenderer } from './player-transactions.js';
import { cssEscape, escapeHtml, escapeJs, formatCompactDollars, formatShortDateTime, money, setText, timeAgo } from './utils.js';

// ==================== STATE ====================
let currentSection = 'floor';
let oddsFormat = 'american';
let positions = [];
let alerts = [];
let buckeyeFilter = 'all';
let buckeyeWagers = [];
let vipOnly = false;
let autoScroll = true;
let incomingBets = [];
let renderFrameId = null;
const TABLE_RENDER_LIMIT = 150;
const FactoryWager = window.FactoryWager || {
  state: {},
  timers: {},
  charts: {},
};
FactoryWager.state.playerSearch = FactoryWager.state.playerSearch || {
  query: '',
  agent: '',
  from: '',
  to: '',
  sort: 'volume',
  players: [],
  agents: [],
  loading: false,
};
FactoryWager.state.playerProfile = FactoryWager.state.playerProfile || {
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
};
FactoryWager.state.ws = FactoryWager.state.ws || {
  subscribedPlayerId: null,
  lastEventAt: null,
};
FactoryWager.state.ui = FactoryWager.state.ui || {
  searchDebounceMs: 300,
};
FactoryWager.utils = FactoryWager.utils || {};
FactoryWager.actions = FactoryWager.actions || {};
window.FactoryWager = FactoryWager;
const playerSearchState = FactoryWager.state.playerSearch;
const playerProfileState = FactoryWager.state.playerProfile;
const playerDocsRenderer = createPlayerDocsRenderer({
  state: playerProfileState,
  escapeHtml,
  formatShortDateTime,
  profileStatusChip,
  profileEmptyRow,
  fetchIntelligenceMap: fetchPlayerIntelligenceMap,
});
const playerTransactionRenderer = createPlayerTransactionRenderer({
  state: playerProfileState,
  escapeHtml,
  formatShortDateTime,
  profileStatusChip,
  profileEmptyRow,
  profileStatCard,
  destroyChart: destroyPlayerProfileChart,
  getChart: () => window.Chart,
});
const CACHE_TTL = {
  odds: 30000,
  webhooks: 15000,
  downline: 30000,
  exposure: 10000,
  patterns: 15000,
  performance: 30000,
};
const SIDEBAR_GROUP_DEFAULTS = {
  trading: true,
  positions: true,
  pph: true,
  'agent-network': true,
  system: true,
  'coming-soon': false,
};
const sectionCache = {
  odds: { at: 0 },
  webhooks: { at: 0 },
  downline: { at: 0 },
  exposure: { at: 0 },
  patterns: { at: 0 },
  performance: { at: 0 },
};
const debouncedTasks = {};
let currentMovementIndex = {};
let masterAccountInfo = null;
let FEATURE_FLAGS = {
  allowFlashBets: false,
  allowPropBuilder: true,
  allowExtProps: true,
  allowLiveBetting: true,
};
window.MASTER_BALANCE = 0;
window.MASTER_BOOK_PERCENT = 100;

// Exposure data from backend
let sportExposureData = [];
let agentExposureData = [];
let sportExposureSort = { col: 'total', dir: 'desc' };
let agentExposureSort = { col: 'total', dir: 'desc' };
let patternsData = [];
let patternSummary = { byType: {}, bySeverity: {}, total: 0 };
let patternCatalog = [];
let patternCategory = 'all';
let patternFilterChoices = { agents: [], sports: [] };
let lastPatternRequestKey = '';
let patternsLoading = false;
let performanceState = {
  velocity: [],
  liveVsPre: null,
  master: [],
  accessLogs: [],
  performanceSummary: [],
  rawLogs: [],
  weeklyFigures: [],
  masterSnapshots: [],
  selectedAgent: null,
  rawLogFilters: { endpoint: '', agentId: '', status: '', days: '7' },
  selectedRawLogId: null,
};
let velocityChart = null;
let liveVsPreChart = null;
let wsClient = new TerminalWebSocketClient({
  getDefaultWsUrl,
  updateWSStatus,
  updateConnectionStatus,
  showToast,
  updateFromBackend,
  loadPersistedWagers,
});

function isCacheFresh(key) {
  const entry = sectionCache[key];
  return Boolean(entry && entry.at && Date.now() - entry.at < CACHE_TTL[key]);
}

function markCacheFresh(key) {
  if (sectionCache[key]) sectionCache[key].at = Date.now();
}

function getMasterBookBase() {
  return Math.abs(window.MASTER_BALANCE || 0);
}

function pctOfMasterBook(amount) {
  const base = getMasterBookBase();
  return base > 0 ? ((amount || 0) / base * 100) : 0;
}

function getExposurePct(amount, localTotal = 0) {
  const masterPct = pctOfMasterBook(amount);
  if (masterPct > 0) return masterPct.toFixed(2);
  return localTotal > 0 ? ((amount || 0) / localTotal * 100).toFixed(1) : '0.0';
}

function updateMasterAccountDisplay() {
  const balanceEl = document.getElementById('masterBalance');
  const bookEl = document.getElementById('masterBookPercent');
  if (balanceEl) {
    const balance = window.MASTER_BALANCE || 0;
    const sign = balance < 0 ? '-' : '';
    balanceEl.textContent = balance ? `${sign}$${(Math.abs(balance) / 1000).toFixed(1)}K` : '—';
    balanceEl.style.color = balance < 0 ? 'var(--red)' : 'var(--green)';
  }
  if (bookEl) {
    const pct = window.MASTER_BOOK_PERCENT || 0;
    const skin = masterAccountInfo?.parsed?.skin || masterAccountInfo?.parsed?.defaultSiteSkin || '—';
    bookEl.textContent = pct ? `${pct}% book · ${skin}` : `Book — · ${skin}`;
  }
}

async function refreshMasterAccountInfo(force = false) {
  const agentId = localStorage.getItem('agentId') || '';
  const url = new URL(`${getApiBaseUrl()}/api/buckeye/account-info`);
  if (agentId) url.searchParams.set('agentId', agentId);
  if (force) url.searchParams.set('force', '1');

  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Account info request failed: ${res.status}`);
    const data = await res.json();
    if (!data || !data.accountInfo) return null;

    masterAccountInfo = data;
    window.MASTER_BALANCE = Number(data.parsed?.balances?.current || 0);
    window.MASTER_BOOK_PERCENT = Number(data.accountInfo?.PercentBook || 100);
    FEATURE_FLAGS = {
      allowFlashBets: Boolean(data.parsed?.featureFlags?.find(f => f.key === 'AllowFlashBets')?.value),
      allowPropBuilder: Boolean(data.parsed?.featureFlags?.find(f => f.key === 'AllowPropBuilder')?.value),
      allowExtProps: Boolean(data.parsed?.featureFlags?.find(f => f.key === 'AllowExtProps')?.value),
      allowLiveBetting: Boolean(data.parsed?.featureFlags?.find(f => f.key === 'AllowUltraLive')?.value),
    };

    updateMasterAccountDisplay();
    return data;
  } catch (err) {
    console.log('[AccountInfo] Failed to load master account info:', err.message);
    updateMasterAccountDisplay();
    return null;
  }
}

function getDisabledFeatureReason(wager) {
  const type = detectWagerType(wager);
  const rawType = String(wager.WagerType || '').toUpperCase();
  const desc = String(wager.ShortDesc || '');

  if ((rawType === 'FLASHBET' || /flash\s*bet/i.test(desc)) && !FEATURE_FLAGS.allowFlashBets) {
    return 'Flash bets disabled';
  }
  if (type === 'PROP' && !FEATURE_FLAGS.allowPropBuilder && !FEATURE_FLAGS.allowExtProps) {
    return 'Props disabled';
  }
  if (wager.TicketWriter === 'GSLIVE' && !FEATURE_FLAGS.allowLiveBetting) {
    return 'Live betting disabled';
  }
  return '';
}

function isLegitimateWager(wager) {
  return getDisabledFeatureReason(wager) === '';
}

function scheduleTask(key, fn, delay = 100) {
  clearTimeout(debouncedTasks[key]);
  debouncedTasks[key] = setTimeout(fn, delay);
}

function scheduleRender(scope = 'all') {
  if (renderFrameId) return;
  renderFrameId = requestAnimationFrame(() => {
    renderFrameId = null;
    if (scope === 'all' || scope === 'buckeye') {
      if (currentSection === 'buckeye') renderBuckeyeWagers();
      renderBuckeyeAgentExposure();
      renderSportBreakdown();
      renderGameBreakdown();
    }
    if (scope === 'all' || scope === 'positions') {
      if (currentSection === 'positions') renderPositions();
    }
    if (scope === 'all' || scope === 'alerts') {
      if (currentSection === 'alerts') renderAlerts();
    }
  });
}

function indexMovements(movements) {
  currentMovementIndex = {};
  for (const m of movements || []) {
    const key = `${m.event_id}:${m.book}:${m.market}:${m.side}`;
    if (!currentMovementIndex[key] || m.recorded_at > currentMovementIndex[key].recorded_at) {
      currentMovementIndex[key] = m;
    }
  }
}

// Wager type mapping
const WAGER_TYPES = {
  'L': { label: 'Line', color: '#8b5cf6' },
  'M': { label: 'Straight', color: '#3b82f6' },
  'S': { label: 'Spread', color: '#06b6d4' },
  'P': { label: 'Parlay', color: '#f59e0b' },
  'E': { label: 'Exotic', color: '#ec4899' },
  'T': { label: 'Teaser', color: '#10b981' },
  'C': { label: 'Custom', color: '#6366f1' },
  'PROP': { label: 'Prop', color: '#d946ef' },
};

const WAGER_MARKETS = {
  moneyline: { label: 'Moneyline', color: '#22c55e' },
  spread: { label: 'Spread', color: '#06b6d4' },
  total: { label: 'Total', color: '#f59e0b' },
  prop: { label: 'Prop', color: '#d946ef' },
  parlay: { label: 'Parlay', color: '#f59e0b' },
  teaser: { label: 'Teaser', color: '#10b981' },
  future: { label: 'Future', color: '#a855f7' },
  custom: { label: 'Custom', color: '#6366f1' },
  straight: { label: 'Straight', color: '#3b82f6' },
  other: { label: 'Other', color: '#6b7280' },
};

// Prop bet detection patterns in ShortDesc
const PROP_STATS = ['Points', 'Assists', 'Rebounds', 'Threes', 'Blocks', 'Steals', 'Rushing', 'Passing', 'Receiving', 'Touchdowns', 'Sacks', 'Interceptions', 'Field Goals', 'Hits', 'Runs', 'Home Runs', 'Strikeouts'];

function detectWagerType(wager) {
  const raw = wager.WagerType?.toUpperCase() || '';
  const desc = wager.ShortDesc || '';

  // Check for player prop patterns: "PlayerName/Stat O/U X½"
  const hasPropPattern = PROP_STATS.some(stat => {
    // Match patterns like "Anthony Edwards/Points" or "Player/Assists"
    const regex = new RegExp(`\\b[A-Za-z][A-Za-z\\s'.-]{2,30}/${stat}\\b`, 'i');
    return regex.test(desc);
  });

  // Also catch "O 23½" or "U 4½" patterns near player names (alternative prop format)
  const hasOverUnderPlayer = /[A-Za-z][A-Za-z\s'.-]{2,30}\s+[OU]\s*\d+½?/.test(desc);
  const hasPlayerTotalPoints = /\bTotal Points\s*\/\s*[A-Za-z][A-Za-z\s'.-]+\s+(?:Over|Under|O|U)\s+\d/i.test(desc);
  const hasSlashStatOverUnder = /\/\s*[A-Za-z0-9][^/]{2,40}\s+(?:Over|Under|O|U)\s+\d/i.test(desc);

  if (hasPropPattern || hasOverUnderPlayer || hasPlayerTotalPoints || hasSlashStatOverUnder) {
    return 'PROP';
  }

  return raw;
}

function detectMarketType(wagerOrDesc) {
  const desc = decodeEntities(typeof wagerOrDesc === 'string' ? wagerOrDesc : (wagerOrDesc?.ShortDesc || ''));
  const raw = typeof wagerOrDesc === 'string' ? '' : (wagerOrDesc?.WagerType || '').toUpperCase();
  const clean = desc.replace(/\s+/g, ' ');

  if (raw === 'P' || /^P[.:]/i.test(clean) || /\s\/\s*Parlay\s\//i.test(clean)) return 'parlay';
  if (raw === 'T' || /\s\/\s*Teaser\s\//i.test(clean)) return 'teaser';
  if (raw === 'C' || /\s\/\s*Custom\s\//i.test(clean)) return 'custom';
  if (/#.*Futures/i.test(clean) || /\bto win outright\b/i.test(clean)) return 'future';
  if (detectWagerType(typeof wagerOrDesc === 'string' ? { ShortDesc: desc, WagerType: raw } : wagerOrDesc) === 'PROP') return 'prop';
  if (/\b(Total Points|Player Points|Player Assists|Player Rebounds)\b/i.test(clean)) return 'prop';
  if (/\b(Total|Total Runs|Total Goals)\b/i.test(clean) || /(?:^|[\s/])(Over|Under|O|U)\s+\d/i.test(clean)) return 'total';
  if (/\b(Point spread|Run Line|Puck Line|Spread)\b/i.test(clean)) return 'spread';
  if (/\bMoneyline\b/i.test(clean)) return 'moneyline';

  const selection = parseSelection(desc);
  if (selection && /\s[+-]\d{2,4}$/.test(selection) && !/\s[+-]\d+(?:\.|½)\d*\s+[+-]\d{2,4}$/.test(selection)) {
    return 'moneyline';
  }
  if (/\bWinner\s*\((?:2|3)\s*way\)/i.test(clean)) return 'moneyline';
  if (/^[MLS][.:](?:Basketball|Baseball|Hockey|Football|Soccer|Tennis|Golf|Martial Arts)\s+#\d+\s+.+\s[+-]\d{2,4}\s+-\s+For Game/i.test(clean)) return 'moneyline';
  if (raw === 'S') return 'spread';
  if (raw === 'L') return 'total';
  if (raw === 'M') return 'straight';
  return 'other';
}

function getSidebarGroupState() {
  try {
    return { ...SIDEBAR_GROUP_DEFAULTS, ...(JSON.parse(localStorage.getItem(SIDEBAR_GROUP_STORAGE_KEY) || '{}')) };
  } catch {
    return { ...SIDEBAR_GROUP_DEFAULTS };
  }
}

function saveSidebarGroupState(state) {
  localStorage.setItem(SIDEBAR_GROUP_STORAGE_KEY, JSON.stringify(state));
}

function initSidebarGroups() {
  const state = getSidebarGroupState();
  document.querySelectorAll('[data-sidebar-group]').forEach((group) => {
    const key = group.getAttribute('data-sidebar-group');
    const open = state[key] !== false;
    group.classList.toggle('collapsed', !open);
  });
  syncSidebarActiveGroup();
}

function toggleSidebarGroup(key) {
  const group = document.querySelector(`[data-sidebar-group="${key}"]`);
  if (!group) return;
  const state = getSidebarGroupState();
  const nextOpen = group.classList.contains('collapsed');
  state[key] = nextOpen;
  saveSidebarGroupState(state);
  group.classList.toggle('collapsed', !nextOpen);
  syncSidebarActiveGroup();
}

function syncSidebarActiveGroup() {
  document.querySelectorAll('[data-sidebar-group]').forEach((group) => {
    group.classList.toggle('has-active', Boolean(group.querySelector('.sidebar-item.active')));
  });
}

function getSidebarButton(section) {
  return document.querySelector(`.sidebar-item[data-section="${section}"]`);
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
  initSidebarGroups();

  // Load saved settings into form
  const savedAgent = localStorage.getItem('agentId') || '';
  const savedBase = localStorage.getItem('baseUrl') || 'https://fantasy402.com';
  const savedRetainedRisk = localStorage.getItem('retainedRiskPercent') || '100';
  localStorage.removeItem('password');
  localStorage.removeItem('cfCookie');
  const agentInput = document.getElementById('settingsAgentId');
  const passInput = document.getElementById('settingsPassword');
  const baseInput = document.getElementById('settingsBaseUrl');
  const cfInput = document.getElementById('settingsCfCookie');
  const retainedRiskInput = document.getElementById('retainedRiskPercent');
  if (agentInput) agentInput.value = savedAgent;
  if (passInput) passInput.value = '';
  if (baseInput) baseInput.value = savedBase;
  if (cfInput) cfInput.value = '';
  if (retainedRiskInput) retainedRiskInput.value = savedRetainedRisk;

  const playerSearchTable = document.getElementById('playerSearchTable');
  if (playerSearchTable) playerSearchTable.addEventListener('click', handlePlayerSearchClick);
  document.querySelectorAll('[data-player-sort]').forEach(th => {
    th.addEventListener('click', () => {
      playerSearchState.sort = th.dataset.playerSort || 'volume';
      loadPlayerSearch(true);
    });
  });
  window.addEventListener('popstate', (event) => {
    if (playerProfileState.playerId) {
      closePlayerProfileModal(false);
      event.preventDefault();
    }
  });

  const buckeyeWagerTable = document.getElementById('buckeyeWagerTable');
  if (buckeyeWagerTable) buckeyeWagerTable.addEventListener('click', handleBuckeyeWagerTableClick);

  const agentDownlineTable = document.getElementById('agentDownlineTable');
  if (agentDownlineTable) agentDownlineTable.addEventListener('click', handleAgentDownlineClick);

  // Load toggle states
  const autoConnectToggle = document.getElementById('autoConnectToggle');
  const toastToggle = document.getElementById('toastToggle');
  if (autoConnectToggle) autoConnectToggle.checked = localStorage.getItem('autoConnect') !== 'false';
  if (toastToggle) toastToggle.checked = localStorage.getItem('toastsEnabled') !== 'false';
  updateAlertsToastButton();
  updateTopBarStatus();
  refreshVaultStatus();

  // Buckeye secrets live in the backend OS vault; the browser no longer stores them.

  // Initialize WebSocket
  wsClient.connect();

  // Register WebSocket event handlers
  wsClient.on('wager.new', (msg) => {
    if (msg.payload) {
      const wager = normalizeBackendWager(msg.payload);
      buckeyeWagers = buckeyeWagers.filter(w => w.WagerNumber !== wager.WagerNumber);
      buckeyeWagers.unshift(wager);
      const disabledReason = getDisabledFeatureReason(wager);
      if (disabledReason) {
        showToast(`Anomaly: ${disabledReason} on wager ${wager.WagerNumber}`, 'error');
      }
      sectionCache.downline.at = 0;
      sectionCache.exposure.at = 0;
      updateBuckeyeStats();
      recordPerformanceWager(wager);
      handlePlayerProfileLiveWager(wager);
      scheduleRender('buckeye');
    }
  });

  wsClient.on('player360.update', (msg) => {
    const activePlayer = playerProfileState.playerId;
    if (!activePlayer) return;
    const touchedPlayers = msg?.payload?.players || [];
    if (!touchedPlayers.length || touchedPlayers.includes(activePlayer)) {
      refreshOpenPlayerProfile(activePlayer);
    }
  });

  wsClient.on('wager.alert', (msg) => {
    if (msg.payload) {
      showToast(msg.payload.message || 'Alert triggered', msg.payload.severity === 'critical' ? 'error' : 'warning');
      scheduleRender('alerts');
    }
  });

  wsClient.on('agentUpdate', (msg) => {
    mergeAgentDelta(msg.payload || msg);
  });

  wsClient.on('exposure.update', (msg) => {
    sectionCache.exposure.at = 0;
    scheduleRender('buckeye');
    if (currentSection === 'positions') fetchExposureData();
  });

  wsClient.on('auth_failed', (msg) => {
    showToast(msg.message || 'Session expired. Please reconnect.', 'error');
    wsClient.isAuthenticated = false;
    updateConnectionStatus('disconnected');
  });

  wsClient.on('odds.movement', (msg) => {
    const move = msg.payload || {};
    if (move.eventId && move.book) {
      currentMovementIndex[move.eventId] = currentMovementIndex[move.eventId] || {};
      currentMovementIndex[move.eventId][move.book] = move;
      if (currentSection === 'floor') renderOddsMatrix();
    }
  });

  wsClient.on('odds.update', (msg) => {
    sectionCache.odds.at = 0;
    if (currentSection === 'floor') loadOddsData();
  });

  wsClient.on('token_refreshed', (msg) => {
    if (msg.token) {
      localStorage.setItem('wsToken', msg.token);
    }
  });

  wsClient.on('token_refresh_error', (msg) => {
    console.warn('[WS] Token refresh failed:', msg.message);
  });

  wsClient.on('betAction_error', (msg) => {
    showToast(msg.message || 'Action failed', 'error');
  });

  wsClient.on('data_error', (msg) => {
    console.warn('[WS] Data fetch error:', msg.message);
    showToast('Failed to load data: ' + (msg.message || 'Unknown error'), 'warning');
  });

  wsClient.on('refresh_initiated', (msg) => {
    console.log('[WS] Refresh initiated for', msg.agentId);
  });

  wsClient.on('rawApiLog.new', (msg) => {
    if (currentSection === 'performance') {
      performanceState.rawLogs.unshift(msg.payload);
      renderRawLogsTable();
    }
  });

  wsClient.on('access_log.new', (msg) => {
    const payload = msg.payload || {};
    if (payload.count > 0) {
      showToast(`${payload.count} new access log${payload.count === 1 ? '' : 's'} from ${payload.agentId || 'agent'}`, 'info');
      // Refresh the access log monitor if on performance page
      if (currentSection === 'performance') {
        loadAccessLogsForPerformance(false);
      }
    }
  });

  wsClient.on('weeklyFigure.new', (msg) => {
    if (currentSection === 'performance') {
      performanceState.weeklyFigures.unshift(msg.payload);
      renderWeeklyFiguresTable();
    }
  });

  wsClient.on('masterSnapshot.new', (msg) => {
    if (currentSection === 'performance') {
      performanceState.masterSnapshots.unshift(msg.payload);
      renderMasterSnapshotsTable();
    }
  });

  wsClient.on('pattern.detected', (msg) => {
    sectionCache.patterns.at = 0;
    const pattern = msg.payload || {};
    if (pattern.severity === 'critical') {
      showToast(`${pattern.type || 'Pattern'} detected: ${pattern.description || pattern.eventId || ''}`, 'error');
    }

    // Cache live pattern for odds grid tooltips
    const pid = pattern.id || `ws_${pattern.eventId || pattern.event_id || 'unknown'}_${Date.now()}`;
    pattern.id = pid;
    livePatterns.set(pid, pattern);
    if (livePatterns.size > 500) {
      const firstKey = livePatterns.keys().next().value;
      if (firstKey) livePatterns.delete(firstKey);
    }

    // Re-render odds grid if pattern relates to a visible game
    if ((pattern.eventId || pattern.event_id) && currentSection === 'floor') {
      renderOddsMatrix();
    }

    // Update agent pattern badges and pulse the row for affected agents
    const affectedAgents = [
      pattern.agent,
      ...(Array.isArray(pattern.agents) ? pattern.agents : []),
      pattern.details?.agent,
      ...(Array.isArray(pattern.details?.agents) ? pattern.details.agents : [])
    ].filter(Boolean);
    for (const agent of affectedAgents) {
      const info = agentPatternCounts[agent] || { agent, pattern_count: 0, critical_count: 0 };
      info.pattern_count = (info.pattern_count || 0) + 1;
      if (pattern.severity === 'critical') {
        info.critical_count = (info.critical_count || 0) + 1;
      }
      agentPatternCounts[agent] = info;
      pulseAgentPatternBadge(agent);
    }

    if (currentSection === 'patterns') loadPatterns(true);
    updatePatternBadge();
  });

  wsClient.on('betAction', (msg) => {
    const result = msg.payload || {};
    if (result.success) {
      showToast(`${result.action === 'accept' ? 'Accepted' : 'Declined'} wager #${result.wagerNumber}`, 'success');
    } else {
      showToast(`Action failed for wager #${result.wagerNumber}: ${result.error || result.message || 'Unknown error'}`, 'error');
    }
  });

  wsClient.on('betAction_queued', (msg) => {
    showToast(`${msg.action === 'accept' ? 'Accept' : 'Decline'} queued for wager #${msg.wagerNumber}`, 'info');
  });

  // Request data on interval
  setInterval(() => {
    if (wsClient.isAuthenticated) {
      wsClient.requestData();
    }
    loadPersistedWagers(true);
  }, 10000); // Keep UI cards synced with backend ingestion even if browser WS is offline

  loadOddsData();
  renderPositions();
  updateSortHeaders();
  refreshMasterAccountInfo().then(() => {
    sectionCache.exposure.at = 0;
    updateBuckeyeStats();
    renderAgentExposure();
    renderSportExposure();
    renderAgentTree(agentTreeData);
  });
  scheduleRender('buckeye');
  renderBuckeyeAgentExposure();
  renderSportBreakdown();
  fetchExposureData();
  renderGameBreakdown();
  loadPatterns();
  renderAlerts();

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '1') switchSection('floor', getSidebarButton('floor'));
    if (e.key === '2') switchSection('patterns', getSidebarButton('patterns'));
    if (e.key === '3') switchSection('positions', getSidebarButton('positions'));
    if (e.key === '4') switchSection('buckeye', getSidebarButton('buckeye'));
    if (e.key === '5') switchSection('agentNetwork', getSidebarButton('agentNetwork'));
    if (e.key === '6') switchSection('playerSearch', getSidebarButton('playerSearch'));
    if (e.key === '7' && e.ctrlKey && playerProfileState.playerId) { e.preventDefault(); setPlayerProfileTab('agent'); return; }
    if (e.key === '7') switchSection('performance', getSidebarButton('performance'));
    if (e.key === 'Escape') { closePlayerProfileModal(); closeTradeModal(); closeAuthModal(); }
    if (e.key === '/' && e.ctrlKey) { e.preventDefault(); document.getElementById('globalSearch').focus(); }
  });

  // Buckeye screens use only live/persisted backend data.
  loadPersistedWagers(true).then(() => {
    scheduleRender('all');
    updateBuckeyeStats();
    loadPlayerSearch();
    const initialPlayerId = getHashPlayerId();
    if (initialPlayerId && !playerProfileState.playerId) {
      openPlayerProfileModal(initialPlayerId);
    }
  });
});

// ==================== BACKEND INTEGRATION ====================
function updateWSStatus(connected) {
  const statusEl = document.getElementById('wsStatus');
  if (statusEl) {
    const url = wsClient ? wsClient.url : 'unknown';
    statusEl.title = `WS: ${url}`;
    if (connected) {
      statusEl.style.color = 'var(--green)';
      statusEl.style.background = 'rgba(16,185,129,0.1)';
      statusEl.style.borderColor = 'rgba(16,185,129,0.3)';
      statusEl.innerHTML = '<div class="w-2 h-2 rounded-full pulse-dot" style="background:var(--green);"></div><span>WS Live</span>';
      if (FactoryWager.state.ws.subscribedPlayerId) {
        wsClient.send({ type: 'player.subscribe', playerId: FactoryWager.state.ws.subscribedPlayerId });
      }
    } else {
      statusEl.style.color = 'var(--text-dim)';
      statusEl.style.background = 'var(--bg)';
      statusEl.style.borderColor = 'var(--border)';
      statusEl.innerHTML = '<div class="w-2 h-2 rounded-full" style="background:var(--text-dim);"></div><span>WS Offline</span>';
    }
  }
  updateTopBarStatus();
}

function updateBuckeyeStatusBadge(state, label) {
  const badge = document.getElementById('buckeyeStatusBadge');
  if (!badge) return;
  const styles = {
    connected: { text: label || 'Live Polling', bg: 'var(--green)', border: 'rgba(16,185,129,0.35)', color: '#fff', dot: '#fff', pulse: true },
    connecting: { text: label || 'Connecting', bg: 'rgba(245,158,11,0.14)', border: 'rgba(245,158,11,0.35)', color: 'var(--yellow)', dot: 'var(--yellow)', pulse: true },
    ready: { text: label || 'Vault Ready', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.35)', color: 'var(--blue)', dot: 'var(--blue)', pulse: false },
    archive: { text: label || 'Archive Loaded', bg: 'rgba(34,211,238,0.10)', border: 'rgba(34,211,238,0.35)', color: 'var(--cyan)', dot: 'var(--cyan)', pulse: false },
    warning: { text: label || 'Vault Needs Login', bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.30)', color: 'var(--yellow)', dot: 'var(--yellow)', pulse: false },
    disconnected: { text: label || 'Not Connected', bg: 'var(--panel)', border: 'var(--border)', color: 'var(--text-dim)', dot: 'var(--text-dim)', pulse: false },
  };
  const s = styles[state] || styles.disconnected;
  badge.style.background = s.bg;
  badge.style.border = `1px solid ${s.border}`;
  badge.style.color = s.color;
  badge.innerHTML = `<div class="w-2 h-2 rounded-full ${s.pulse ? 'pulse-dot' : ''}" style="background:${s.dot};"></div><span>${escapeHtml(s.text)}</span>`;
}

function updateTopBarStatus() {
  const backend = document.getElementById('topBackendIngest');
  const freshness = document.getElementById('topWagerFreshness');
  const socket = document.getElementById('topUiSocket');
  const toast = document.getElementById('topToastToggle');
  const agent = localStorage.getItem('agentId') || '';
  if (backend) {
    const liveAgents = Number(window.backendLiveAgents || 0);
    const label = liveAgents > 0
      ? `Backend: ${liveAgents} agent${liveAgents === 1 ? '' : 's'} ingesting`
      : wsClient?.isAuthenticated
        ? `Backend: ${agent || 'agent'} ready`
        : 'Backend: no active ingest';
    backend.className = `topbar-chip ${liveAgents > 0 ? 'live' : wsClient?.isAuthenticated ? 'warn' : 'offline'}`;
    backend.innerHTML = `<span class="topbar-dot ${liveAgents > 0 ? 'pulse-dot' : ''}"></span><span>${escapeHtml(label)}</span>`;
    backend.title = liveAgents > 0
      ? 'Backend ingestion is active and continues even if this browser disconnects.'
      : 'No active backend ingest loop is reporting from /health.';
  }
  if (freshness) {
    const liveCount = buckeyeWagers.filter(w => w.TicketWriter === 'GSLIVE').length;
    const latestDate = buckeyeWagers[0]?.InsertDateTime ? new Date(buckeyeWagers[0].InsertDateTime) : null;
    const latest = latestDate ? latestDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'none';
    const stale = latestDate ? Date.now() - latestDate.getTime() > 10 * 60 * 1000 : true;
    freshness.className = `topbar-chip ${stale ? 'warn' : 'live'}`;
    freshness.innerHTML = `<span class="topbar-dot"></span><span>Wagers: <strong>${liveCount}</strong> live · latest ${escapeHtml(latest)}</span>`;
    freshness.title = latestDate ? `Latest persisted Buckeye wager: ${latestDate.toLocaleString()}` : 'No persisted Buckeye wager loaded yet.';
  }
  if (socket) {
    const connected = wsClient?.ws?.readyState === WebSocket.OPEN;
    socket.className = `topbar-chip ${connected ? 'live' : 'offline'}`;
    socket.innerHTML = `<span class="topbar-dot ${connected ? 'pulse-dot' : ''}"></span><span>UI socket: ${connected ? 'live' : 'offline'}</span>`;
    socket.title = connected
      ? 'Browser WebSocket is connected for UI deltas.'
      : 'Browser WebSocket is offline. Backend ingestion can still be live.';
  }
  if (toast) {
    const enabled = localStorage.getItem('toastsEnabled') !== 'false';
    toast.textContent = enabled ? 'Toasts: On' : 'Toasts: Off';
    toast.className = `topbar-chip ${enabled ? 'live' : 'offline'}`;
  }
}

function normalizeBackendWager(row) {
  const raw = row || {};
  const amount = raw.amount_wagered ?? raw.AmountWagered ?? 0;
  const toWin = raw.to_win_amount ?? raw.ToWinAmount ?? 0;
  const volume = raw.volume_amount ?? raw.VolumeAmount ?? amount;
  const agent = (raw.agent_login ?? raw.AgentLogin ?? raw.agent_id ?? raw.AgentID ?? '').toString().trim();
  const customer = (raw.customer_id ?? raw.CustomerID ?? raw.login ?? raw.Login ?? '').toString().trim();
  return {
    ...raw,
    WagerNumber: raw.wager_number ?? raw.WagerNumber,
    AgentID: (raw.agent_id ?? raw.AgentID ?? agent).toString().trim(),
    CustomerID: customer,
    Login: (raw.login ?? raw.Login ?? customer).toString().trim(),
    WagerType: (raw.wager_type ?? raw.WagerType ?? '').toString().trim(),
    AmountWagered: Number(amount) || 0,
    ToWinAmount: Number(toWin) || 0,
    VolumeAmount: Number(volume) || 0,
    InsertDateTime: raw.insert_datetime ?? raw.insert_date_time ?? raw.InsertDateTime ?? raw.scraped_at ?? new Date().toISOString(),
    TicketWriter: (raw.ticket_writer ?? raw.TicketWriter ?? '').toString().trim(),
    ShortDesc: raw.short_desc ?? raw.short_desc_raw ?? raw.ShortDesc ?? '',
    VIP: (raw.vip ?? raw.VIP ?? '0').toString().trim(),
    AgentLogin: agent,
    Sport: (raw.sport ?? raw.Sport ?? '').toString().trim(),
  };
}

function mergeWagers(rows) {
  const normalized = rows.map(normalizeBackendWager).filter(w => w.WagerNumber !== undefined && w.WagerNumber !== null);
  if (!normalized.length) return 0;
  const existing = new Map();
  for (const wager of buckeyeWagers) {
    existing.set(String(wager.WagerNumber), wager);
  }
  for (const wager of normalized) {
    existing.set(String(wager.WagerNumber), wager);
  }
  buckeyeWagers = Array.from(existing.values()).sort((a, b) => new Date(b.InsertDateTime) - new Date(a.InsertDateTime));
  sectionCache.downline.at = 0;
  sectionCache.exposure.at = 0;
  updateBuckeyeStats();
  scheduleRender('all');
  return normalized.length;
}

async function loadPersistedWagers(force = false) {
  if (!force && window.backendWagersLoaded) return buckeyeWagers.length > 0;
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/wagers?limit=${BUCKEYE_ARCHIVE_LIMIT}`);
    if (!res.ok) throw new Error(`Wager archive unavailable: ${res.status}`);
    const payload = await res.json();
    const rows = Array.isArray(payload) ? payload : (payload.wagers || payload.data || []);
    if (!rows.length) return false;
    window.backendWagersLoaded = true;
    window.lastWagerArchiveRefreshAt = Date.now();
    const merged = mergeWagers(rows);
    updateBuckeyeStatusBadge('archive', `${buckeyeWagers.length.toLocaleString()} Latest`);
    refreshVaultStatus();
    console.log('[Backend] Loaded persisted wagers:', merged);
    return true;
  } catch (err) {
    console.warn('[Backend] Persisted wager load failed:', err.message);
    return false;
  }
}

function updateFromBackend(data) {
  console.log('[Backend] Received data:', data);

  // Merge wagers from backend into frontend state
  if (data.wagers && Array.isArray(data.wagers)) {
    const added = mergeWagers(data.wagers);
    console.log('[Backend] Wagers merged:', added, 'rows');
  }

  // Update alerts
  if (data.alerts && Array.isArray(data.alerts)) {
    data.alerts.forEach(alert => {
      showToast(`${alert.severity}: ${alert.message}`, alert.severity === 'critical' ? 'error' : 'warning');
    });
    console.log('[Backend] Alerts:', data.alerts.length);
  }
}

async function refreshLiveStats() {
  await fetchExposureData(true);
  updateBuckeyeStats();
  scheduleRender('all');
}

// ==================== EXPOSURE FETCH ====================
async function fetchSportExposure() {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/exposure/sports`);
    if (!res.ok) throw new Error('Failed to fetch sport exposure');
    sportExposureData = await res.json();
    const totalVolume = sportExposureData.reduce((sum, row) => sum + (row.total || 0), 0);
    sportExposureData = sportExposureData.map(row => ({
      ...row,
      pct: getExposurePct(row.total || 0, totalVolume),
    }));
    renderSportExposure();
  } catch (err) {
    console.log('[Exposure] Sport fetch failed:', err.message);
    computeSportExposureLocal();
    renderSportExposure();
  }
}

async function fetchAgentExposure() {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/exposure/agents`);
    if (!res.ok) throw new Error('Failed to fetch agent exposure');
    agentExposureData = await res.json();
    const totalVolume = agentExposureData.reduce((sum, row) => sum + (row.total || 0), 0);
    agentExposureData = agentExposureData.map(row => ({
      ...row,
      pct: getExposurePct(row.total || 0, totalVolume),
    }));
    renderAgentExposure();
  } catch (err) {
    console.log('[Exposure] Agent fetch failed:', err.message);
    computeAgentExposureLocal();
    renderAgentExposure();
  }
}

async function fetchExposureData(force = false) {
  if (!force && isCacheFresh('exposure')) {
    renderSportExposure();
    renderAgentExposure();
    return;
  }
  await Promise.all([fetchSportExposure(), fetchAgentExposure()]);
  markCacheFresh('exposure');
}

function computeSportExposureLocal() {
  const sports = {};
  buckeyeWagers.forEach(w => {
    const sport = parseSport(w.ShortDesc);
    if (!sports[sport]) sports[sport] = { total: 0, live: 0, wagerCount: 0, wagers: [] };
    sports[sport].total += getHeldRisk(w);
    sports[sport].wagerCount++;
    if (w.TicketWriter === 'GSLIVE') sports[sport].live++;
    sports[sport].wagers.push(w);
  });

  const totalVolume = Object.values(sports).reduce((s, d) => s + d.total, 0);

  sportExposureData = Object.entries(sports).map(([sport, data]) => {
    // Find top game
    const games = {};
    data.wagers.forEach(w => {
      const g = parseGame(w.ShortDesc);
      games[g] = (games[g] || 0) + getHeldRisk(w);
    });
    let topGame = '';
    let gameTotal = 0;
    for (const [g, v] of Object.entries(games)) {
      if (v > gameTotal) { topGame = g; gameTotal = v; }
    }
    // Find top side in top game
    const sides = {};
    data.wagers.filter(w => parseGame(w.ShortDesc) === topGame).forEach(w => {
      const side = parseSide(w.ShortDesc) || w.ShortDesc;
      const price = extractPrice(w.ShortDesc);
      if (!sides[side]) sides[side] = { volume: 0, price };
      sides[side].volume += getHeldRisk(w);
    });
    let topSide = '';
    let topSideVol = 0;
    let topSidePrice = '';
    for (const [s, d] of Object.entries(sides)) {
      if (d.volume > topSideVol) { topSide = s; topSideVol = d.volume; topSidePrice = d.price; }
    }

    return {
      sport, total: data.total,
      pct: getExposurePct(data.total, totalVolume),
      live: data.live, wagerCount: data.wagerCount,
      topGame, side: topSide || '—', price: topSidePrice || '—', gameTotal
    };
  }).sort((a, b) => b.total - a.total);
}

function computeAgentExposureLocal() {
  const agents = {};
  buckeyeWagers.forEach(w => {
    const a = w.AgentLogin || 'Unknown';
    if (!agents[a]) agents[a] = { total: 0, live: 0, wagerCount: 0, wagers: [] };
    agents[a].total += getHeldRisk(w);
    agents[a].wagerCount++;
    if (w.TicketWriter === 'GSLIVE') agents[a].live++;
    agents[a].wagers.push(w);
  });

  const totalVolume = Object.values(agents).reduce((s, d) => s + d.total, 0);

  agentExposureData = Object.entries(agents).map(([agent, data]) => {
    const customers = {};
    const games = {};
    data.wagers.forEach(w => {
      customers[w.Login || 'Unknown'] = (customers[w.Login || 'Unknown'] || 0) + getHeldRisk(w);
      const g = parseGame(w.ShortDesc);
      games[g] = (games[g] || 0) + getHeldRisk(w);
    });
    let topCustomer = '';
    let topCustomerVol = 0;
    for (const [c, v] of Object.entries(customers)) {
      if (v > topCustomerVol) { topCustomer = c; topCustomerVol = v; }
    }
    let topGame = '';
    let topGameVol = 0;
    for (const [g, v] of Object.entries(games)) {
      if (v > topGameVol) { topGame = g; topGameVol = v; }
    }
    return {
      agent, total: data.total,
      pct: getExposurePct(data.total, totalVolume),
      live: data.live, wagerCount: data.wagerCount,
      topCustomer: topCustomer || '—', topCustomerVol,
      topGame: topGame || '—', topGameVol
    };
  }).sort((a, b) => b.total - a.total);
}

// ==================== SECTION SWITCHING ====================
function switchSection(section, btn) {
  if ((currentSection === 'agentNetwork' || currentSection === 'agentTree') && section !== 'agentNetwork' && section !== 'agentTree') {
    stopAgentCanvas();
  }

  document.querySelectorAll('.section-content').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById(section === 'agentTree' ? 'agentNetworkSection' : section + 'Section');
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
  const activeButton = btn || getSidebarButton(section);
  if (activeButton) activeButton.classList.add('active');
  syncSidebarActiveGroup();
  currentSection = section;

  switch (section) {
    case 'floor':
      if (isCacheFresh('odds')) renderOddsMatrix();
      else loadOddsData();
      break;
    case 'patterns':
      if (isCacheFresh('patterns')) renderPatterns();
      else loadPatterns();
      break;
    case 'buckeye':
      renderBuckeyeWagers();
      break;
    case 'positions':
      renderPositions();
      fetchExposureData();
      break;
    case 'agentNetwork':
      setAgentNetworkMode('table');
      refreshAgentDownline();
      break;
    case 'agentTree':
      setAgentNetworkMode('tree');
      refreshAgentDownline();
      break;
    case 'playerSearch':
      loadPlayerSearch();
      break;
    case 'alerts':
      updateAlertsToastButton();
      renderAlerts();
      break;
    case 'ipTracker':
      {
        const today = new Date().toISOString().split('T')[0];
        const startEl = document.getElementById('globalIpStart');
        const endEl = document.getElementById('globalIpEnd');
        if (startEl && !startEl.value) startEl.value = today;
        if (endEl && !endEl.value) endEl.value = today;
      }
      break;
    case 'webhooks':
      loadWebhooks();
      break;
    case 'status':
      loadStatusPage();
      break;
    case 'performance':
      if (isCacheFresh('performance')) renderPerformanceDashboard();
      else loadPerformancePage();
      break;
    case 'uptime':
      loadUptimePage();
      break;
  }
}

// ==================== BUCKEYE WAGER TABLE ====================
function renderBuckeyeWagers() {
  const tbody = document.getElementById('buckeyeWagerTable');
  if (!tbody) return;
  updateWagerFilterCounts();

  let filtered = [...buckeyeWagers];

  // Apply wager type filter
  if (buckeyeFilter !== 'all') {
    if (buckeyeFilter === 'alert') {
      filtered = filtered.filter(w => w.TicketWriter === 'ALERT');
    } else if (buckeyeFilter === 'live') {
      filtered = filtered.filter(w => w.TicketWriter === 'GSLIVE');
    } else {
      filtered = filtered.filter(w => detectWagerType(w) === buckeyeFilter);
    }
  }

  // Apply VIP filter
  if (vipOnly) {
    filtered = filtered.filter(w => w.VIP !== '0');
  }

  // Apply min bet filter
  const minBet = parseInt(document.getElementById('minBetFilter')?.value || 0);
  if (minBet > 0) {
    filtered = filtered.filter(w => w.AmountWagered >= minBet);
  }

  // Apply search
  const search = document.getElementById('wagerSearch')?.value?.toLowerCase() || '';
  if (search) {
    filtered = filtered.filter(w =>
      w.WagerNumber.toString().includes(search) ||
      w.AgentLogin.toLowerCase().includes(search) ||
      w.Login.toLowerCase().includes(search) ||
      w.ShortDesc.toLowerCase().includes(search)
    );
  }

  // Apply sorting
  filtered.sort((a, b) => {
    let cmp = 0;
    switch (sortColumn) {
      case 'time':
        cmp = new Date(a.InsertDateTime) - new Date(b.InsertDateTime);
        break;
      case 'customer':
        cmp = a.Login.localeCompare(b.Login);
        break;
      case 'agent':
        cmp = (a.AgentLogin || '').localeCompare(b.AgentLogin || '');
        break;
      case 'sport':
        cmp = parseSport(a.ShortDesc).localeCompare(parseSport(b.ShortDesc));
        break;
      case 'league':
        cmp = (parseLeague(a.ShortDesc) || '').localeCompare(parseLeague(b.ShortDesc) || '');
        break;
      case 'type':
        cmp = detectWagerType(a).localeCompare(detectWagerType(b));
        break;
      case 'risk':
        cmp = (a.AmountWagered || 0) - (b.AmountWagered || 0);
        break;
      case 'source':
        cmp = (a.TicketWriter || '').localeCompare(b.TicketWriter || '');
        break;
      default:
        cmp = new Date(a.InsertDateTime) - new Date(b.InsertDateTime);
    }
    return sortDirection === 'asc' ? cmp : -cmp;
  });

  const totalFiltered = filtered.length;
  const visibleRows = filtered.slice(0, TABLE_RENDER_LIMIT);

  tbody.innerHTML = visibleRows.map(w => {
    const rawTypeInfo = WAGER_TYPES[detectWagerType(w)] || { label: w.WagerType, color: '#6b7280' };
    const marketKey = detectMarketType(w);
    const typeInfo = WAGER_MARKETS[marketKey] || rawTypeInfo;
    const isAlert = w.TicketWriter === 'ALERT';
    const isLive = w.TicketWriter === 'GSLIVE';
    const disabledFeatureReason = getDisabledFeatureReason(w);
    const rowClass = disabledFeatureReason ? 'alert-row' : isAlert ? 'alert-row' : isLive ? 'gslive-row' : '';

    // Parse time
    const dt = new Date(w.InsertDateTime);
    const timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    // Clean description
    const cleanDesc = parseDescription(w.ShortDesc);
    const fullDesc = w.ShortDesc;
    const league = parseLeague(w.ShortDesc);
    const sport = parseSport(w.ShortDesc);

    // Price / Odds
    const price = extractPrice(w.ShortDesc);

    // Format amounts
    const wager = w.AmountWagered || w.VolumeAmount || 0;
    const risk = wager > 0 ? '$' + wager.toLocaleString() : '<span style="color:var(--red)">PENDING</span>';
    const win = '$' + Math.round(wager * 1.5).toLocaleString();

    // Source badge
    let sourceBadge = '';
    if (isAlert) {
      sourceBadge = '<span class="px-1.5 py-0.5 rounded text-xs font-bold" style="background:var(--red);color:#fff;">ALERT</span>';
    } else if (disabledFeatureReason) {
      sourceBadge = `<span class="px-1.5 py-0.5 rounded text-xs font-bold" title="${escapeHtml(disabledFeatureReason)}" style="background:var(--red);color:#fff;">ANOMALY</span>`;
    } else if (isLive) {
      sourceBadge = '<span class="px-1.5 py-0.5 rounded text-xs font-bold" style="background:var(--cyan);color:#fff;">GSLIVE</span>';
    } else {
      sourceBadge = '<span class="px-1.5 py-0.5 rounded text-xs" style="background:var(--bg);color:var(--text-dim);border:1px solid var(--border);">Internet</span>';
    }

    return `<tr class="${rowClass} border-b transition-colors hover:bg-opacity-50 cursor-pointer" data-wager-number="${Number(w.WagerNumber) || 0}" style="border-color:var(--border);" title="${escapeHtml(fullDesc)}">
      <td class="px-3 py-2 font-medium cursor-pointer hover:underline" style="color:var(--accent);" data-action="view-player" data-player="${escapeHtml(w.Login)}">${escapeHtml(w.Login)}</td>
      <td class="px-3 py-2 text-center"><span class="px-1.5 py-0.5 rounded text-xs font-bold" title="${escapeHtml(rawTypeInfo.label)}" style="background:${typeInfo.color}22;color:${typeInfo.color};">${escapeHtml(typeInfo.label)}</span></td>
      <td class="px-3 py-2 cursor-pointer hover:underline" data-action="filter-agent" data-agent="${escapeHtml(w.AgentLogin)}">${escapeHtml(w.AgentLogin)}</td>
      <td class="px-3 py-2"><span class="px-1.5 py-0.5 rounded text-xs" style="background:var(--bg);color:var(--text-dim);border:1px solid var(--border);">${escapeHtml(sport)}</span></td>
      <td class="px-3 py-2"><span class="px-1.5 py-0.5 rounded text-xs" style="background:var(--bg);color:var(--text-dim);border:1px solid var(--border);">${escapeHtml(league || '—')}</span></td>
      <td class="px-3 py-2" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(fullDesc)}">${escapeHtml(cleanDesc)}</td>
      <td class="px-3 py-2 text-right font-mono">${risk}</td>
      <td class="px-3 py-2 text-right font-mono">${win}</td>
      <td class="px-3 py-2 text-center">${price ? `<span class="font-mono">${escapeHtml(price)}</span>` : '—'}</td>
      <td class="px-3 py-2 text-center">${sourceBadge}</td>
      <td class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">${timeStr}</td>
    </tr>`;
  }).join('');

  if (totalFiltered > TABLE_RENDER_LIMIT) {
    tbody.innerHTML += `<tr><td colspan="11" class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">Showing ${TABLE_RENDER_LIMIT.toLocaleString()} of ${totalFiltered.toLocaleString()} matching wagers. Refine filters to narrow the table.</td></tr>`;
  }

  if (totalFiltered === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">No wagers match current filters</td></tr>';
  }
}

function filterWagerType(btn, type) {
  buckeyeFilter = type;
  document.querySelectorAll('#buckeyeSection button.active-tab').forEach(b => {
    b.style.background = 'var(--bg)';
    b.style.color = 'var(--text-dim)';
    b.classList.remove('active-tab');
  });
  btn.style.background = 'var(--accent)';
  btn.style.color = '#fff';
  btn.classList.add('active-tab');
  scheduleRender('buckeye');
}

function updateWagerFilterCounts() {
  document.querySelectorAll('[data-wager-filter]').forEach(btn => {
    const type = btn.dataset.wagerFilter;
    const count = buckeyeWagers.filter(w => {
      if (type === 'all') return true;
      if (type === 'alert') return w.TicketWriter === 'ALERT';
      if (type === 'live') return w.TicketWriter === 'GSLIVE';
      return detectWagerType(w) === type;
    }).length;
    const countEl = btn.querySelector('[data-count]');
    if (countEl) countEl.textContent = count;
  });
}

function toggleVIP() {
  vipOnly = !vipOnly;
  const btn = document.getElementById('vipToggle');
  const dot = btn.querySelector('div');
  if (vipOnly) {
    btn.style.background = 'var(--accent)';
    dot.style.transform = 'translateX(16px)';
    dot.style.background = '#fff';
  } else {
    btn.style.background = 'var(--border)';
    dot.style.transform = 'translateX(0)';
    dot.style.background = 'var(--text-dim)';
  }
  scheduleRender('buckeye');
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('autoScrollToggle');
  const dot = btn.querySelector('div');
  if (autoScroll) {
    btn.style.background = 'var(--green)';
    dot.style.transform = 'translateX(16px)';
  } else {
    btn.style.background = 'var(--border)';
    dot.style.transform = 'translateX(0)';
  }
}

function clearTicker() {
  buckeyeWagers = [];
  scheduleRender('buckeye');
  updateBuckeyeStats();
  showToast('Ticker cleared', 'info');
}

function updateBuckeyeStats() {
  const total = buckeyeWagers.length;
  const heldVolume = buckeyeWagers.reduce((sum, w) => sum + getHeldRisk(w), 0);
  const uniqueCustomers = new Set(buckeyeWagers.map(w => w.Login)).size;
  const agents = new Set(buckeyeWagers.map(w => w.AgentLogin)).size;
  const alerts = buckeyeWagers.filter(w => w.TicketWriter === 'ALERT').length;
  const live = buckeyeWagers.filter(w => w.TicketWriter === 'GSLIVE').length;
  const sorted = [...buckeyeWagers].sort((a, b) => new Date(b.InsertDateTime) - new Date(a.InsertDateTime));
  const latest = sorted[0] || null;
  const oldest = sorted[sorted.length - 1] || null;
  const maxWagerRow = buckeyeWagers.reduce((max, wager) => {
    return Number(wager.AmountWagered || 0) > Number(max?.AmountWagered || 0) ? wager : max;
  }, null);
  const maxWager = Number(maxWagerRow?.AmountWagered || 0);

  document.getElementById('buckeyeTotalWagers').textContent = total.toLocaleString();
  document.getElementById('buckeyeTotalVolume').textContent = formatCompactDollars(heldVolume);
  document.getElementById('buckeyeUniqueCustomers').textContent = uniqueCustomers.toLocaleString();
  document.getElementById('buckeyeActiveAgents').textContent = agents;
  document.getElementById('buckeyeAlertWagers').textContent = alerts;
  document.getElementById('buckeyeLiveWagers').textContent = live;
  document.getElementById('buckeyeMaxWager').textContent = formatCompactDollars(maxWager);
  setText('buckeyeWindowCaption', total ? `Latest ${total.toLocaleString()} archived wagers` : 'Waiting for archive rows');
  setText('buckeyeRiskCaption', `${getRetainedRiskPercent()}% retained risk`);
  setText('buckeyeCustomerCaption', 'Unique players in current window');
  setText('buckeyeAgentCaption', 'Agents with wagers in window');
  setText('buckeyeAlertCaption', alerts ? 'ALERT ticket writer rows' : 'No ALERT rows in window');
  setText('buckeyeLiveCaption', live ? 'GSLIVE ticket writer rows' : 'No GSLIVE rows in window');
  setText('buckeyeMaxWagerOwner', maxWagerRow ? `${maxWagerRow.Login || 'Unknown'} · ${maxWagerRow.AgentLogin || 'Unknown'}` : 'No wager yet');
  setText('buckeyeArchiveSource', `${DATA_SOURCES.wagerArchive} · ${window.backendWagersLoaded ? 'DB' : 'loading'}`);
  setText('buckeyeLatestSeen', latest?.InsertDateTime ? `${formatShortDateTime(latest.InsertDateTime)} · ${timeAgo(latest.InsertDateTime)}` : '—');
  setText('buckeyeWindowRange', latest?.InsertDateTime && oldest?.InsertDateTime ? `${formatShortDateTime(oldest.InsertDateTime)} → ${formatShortDateTime(latest.InsertDateTime)}` : '—');
  setText('buckeyeArchiveRefresh', window.lastWagerArchiveRefreshAt ? `${timeAgo(window.lastWagerArchiveRefreshAt)} · every 10s` : 'Waiting');
  const posCount = document.getElementById('posCount');
  if (posCount) posCount.textContent = total.toLocaleString();
  updateMasterAccountDisplay();
  updateTopBarStatus();
}

// ==================== AGENT EXPOSURE (Buckeye Tab) ====================
function renderBuckeyeAgentExposure() {
  const container = document.getElementById('agentExposureList');
  if (!container) return;

  const agentVolumes = {};
  buckeyeWagers.forEach(w => {
    const agent = w.AgentLogin;
    agentVolumes[agent] = (agentVolumes[agent] || 0) + getWagerExposure(w);
  });

  const sorted = Object.entries(agentVolumes).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxVol = sorted[0]?.[1] || 1;

  container.innerHTML = sorted.map(([agent, vol]) => {
    const pct = (vol / maxVol * 100).toFixed(0);
    const color = vol > 50000 ? 'var(--red)' : vol > 20000 ? 'var(--yellow)' : 'var(--green)';
    return `<div class="flex items-center gap-3">
      <span class="text-xs w-20 truncate">${agent}</span>
      <div class="flex-1 exposure-bar">
        <div class="exposure-bar-fill" style="width:${pct}%;background:${color};"></div>
        <div class="exposure-bar-label">$${(vol/1000).toFixed(1)}K</div>
      </div>
      <span class="text-xs font-mono w-16 text-right">$${vol.toLocaleString()}</span>
    </div>`;
  }).join('');
}

// ==================== SPORT BREAKDOWN ====================
function renderSportBreakdown() {
  const container = document.getElementById('sportBreakdown');
  if (!container) return;

  const sports = {};
  buckeyeWagers.forEach(w => {
    const sport = parseSport(w.ShortDesc);
    if (!sports[sport]) sports[sport] = { count: 0, volume: 0 };
    sports[sport].count++;
    sports[sport].volume += getHeldRisk(w);
  });

  const sorted = Object.entries(sports).sort((a, b) => b[1].volume - a[1].volume);
  const maxVol = sorted[0]?.[1].volume || 1;

  container.innerHTML = sorted.map(([sport, data]) => {
    const pct = (data.volume / maxVol * 100).toFixed(0);
    return `<div class="flex items-center gap-3">
      <span class="text-xs w-20 truncate">${sport}</span>
      <div class="flex-1 exposure-bar">
        <div class="exposure-bar-fill" style="width:${pct}%;background:var(--accent);"></div>
        <div class="exposure-bar-label">$${(data.volume/1000).toFixed(1)}K</div>
      </div>
      <span class="text-xs font-mono w-12 text-right">${data.count}</span>
      <span class="text-xs font-mono w-14 text-right">$${(data.volume/1000).toFixed(0)}K</span>
    </div>`;
  }).join('');
}

// ==================== GAME BREAKDOWN ====================
function renderGameBreakdown() {
  const container = document.getElementById('gameBreakdown');
  if (!container) return;

  const games = {};
  buckeyeWagers.forEach(w => {
    const game = parseGame(w.ShortDesc);
    if (!games[game]) games[game] = { count: 0, volume: 0, sport: parseSport(w.ShortDesc) };
    games[game].count++;
    games[game].volume += getHeldRisk(w);
  });

  const sorted = Object.entries(games).sort((a, b) => b[1].volume - a[1].volume).slice(0, 10);
  const maxVol = sorted[0]?.[1].volume || 1;

  container.innerHTML = sorted.map(([game, data]) => {
    const pct = (data.volume / maxVol * 100).toFixed(0);
    return `<div class="flex items-center gap-3">
      <span class="text-xs w-3 truncate" style="color:var(--text-dim);">${data.sport.substring(0,1)}</span>
      <span class="text-xs w-24 truncate" title="${game}">${game}</span>
      <div class="flex-1 exposure-bar">
        <div class="exposure-bar-fill" style="width:${pct}%;background:var(--green);"></div>
        <div class="exposure-bar-label">$${(data.volume/1000).toFixed(1)}K</div>
      </div>
      <span class="text-xs font-mono w-10 text-right">${data.count}</span>
      <span class="text-xs font-mono w-12 text-right">$${(data.volume/1000).toFixed(0)}K</span>
    </div>`;
  }).join('');
}

function decodeEntities(desc) {
  if (!desc) return desc;
  return desc.replace(/&#189;/g, '½').replace(/&#188;/g, '¼').replace(/&#190;/g, '¾').replace(/&#038;/g, '&').replace(/&amp;/g, '&');
}

function parseGame(desc) {
  if (!desc) return 'Unknown Game';
  desc = decodeEntities(desc);

  // Handle parlays with \r\n or multiple legs — show first leg summary
  if (desc.includes('\r\n') || (desc.includes(' - For Game ') && desc.match(/ - For Game /g).length > 1)) {
    const firstLeg = desc.split('\r\n')[0].split(' - For Game ')[0];
    const legCount = (desc.match(/ - For Game /g) || []).length;
    const game = parseGameSingle(firstLeg);
    return legCount > 1 ? `${game} (+${legCount - 1} legs)` : game;
  }

  return parseGameSingle(desc);
}

function parseGameSingle(desc) {
  desc = decodeEntities(desc);
  // GSLIVE format: "M.G123456 - Top Tennis - Simona Waltert vs Hailey... / 2nd Set / ..."
  const gsMatch = desc.match(/^[A-Z][.:]G?\d+\s+-\s+(?:Top\s+)?\w+\s+-\s+(.+?)(?:\s+\/|\s+-\s+For\s|$)/);
  if (gsMatch) return gsMatch[1].trim().substring(0, 35);

  // Standard format: "M.Soccer #203202 Lens -230 - For Game"
  const stdMatch = desc.match(/^[A-Z][.:\s][\w\s]+\s+#\d+\s+(.+?)(?:\s+-\s+For\s|\s+\/|\s+-\s+\d)/);
  if (stdMatch) return stdMatch[1].trim().substring(0, 35);

  // Futures format: "C:FOOTBALL - #NFL Futures - ... - New Orleans Saints +265 for Game"
  // Extract team/selection after last dash before price
  const futuresMatch = desc.match(/-\s+([A-Za-z][A-Za-z\s'.-]+?)(?:\s+[+-]\d+(?:\.\d+)?)\s+(?:for\s+Game|-\s+For\s+Game|$)/i);
  if (futuresMatch) return futuresMatch[1].trim().substring(0, 35);

  // Fallback: look for "vs" or "@" anywhere
  const vsMatch = desc.match(/([A-Za-z][A-Za-z\s'.-]{1,20}(?:\s+vs\.?|\s+VS\.?|\s+@)\s+[A-Za-z][A-Za-z\s'.-]{1,20})/);
  if (vsMatch) return vsMatch[1].trim().substring(0, 35);

  // Fallback 2: look for team names before "- For" or after sport
  const simpleMatch = desc.match(/^[A-Z][.:\s][\w\s]+\s+#?\d*\s*([^#-]{5,40}?)(?:\s+-\s+For|\s+for\s+Game|\s+\/|$)/i);
  if (simpleMatch) return simpleMatch[1].trim().substring(0, 35);

  return 'Unknown Game';
}

function parseSide(desc) {
  if (!desc) return '';
  desc = decodeEntities(desc);
  let clean = desc.replace(/^[A-Z][.:]\s*/, '');
  clean = clean.replace(/^G\d+\s*-\s*/, '');
  clean = clean.replace(/\s+-\s+For\s+.*$/i, '');
  clean = clean.replace(/\s+\/\s+(Teaser|Straight|Parlay)\s+\/\s+[^/]+$/i, '');
  clean = clean.replace(/^#\d+\s+/, '');

  // Try to extract side from prop patterns: "Player/Assists U 4½" or "Over 8.5"
  const propMatch = clean.match(/([A-Za-z][A-Za-z\s'.-]*\s+[OU]\s+\d+\.?\d*)/i);
  if (propMatch) return propMatch[1].trim().substring(0, 30);

  // Try spread/total: "Team -1½" or "Team +3"
  const spreadMatch = clean.match(/([A-Za-z][A-Za-z\s'.-]*\s+[+-]\d+\.?\d*)/i);
  if (spreadMatch) return spreadMatch[1].trim().substring(0, 30);

  // Over/Under standalone
  const ouMatch = clean.match(/\b(Over|Under)\s+\d+\.?\d*/i);
  if (ouMatch) return ouMatch[0].trim().substring(0, 30);

  // Last meaningful chunk
  const lastChunk = clean.match(/([^-]{3,30})(?:\s+[+-]\d+)?$/);
  if (lastChunk) return lastChunk[1].trim().substring(0, 30);

  return clean.substring(0, 30);
}

// Helper: ALERT tickets have VolumeAmount=0 but AmountWagered is the real stake
function getWagerExposure(w) {
  return (w.VolumeAmount > 0 ? w.VolumeAmount : w.AmountWagered) || 0;
}

function getRetainedRiskPercent() {
  const inputValue = document.getElementById('retainedRiskPercent')?.value;
  const storedValue = localStorage.getItem('retainedRiskPercent');
  const parsed = Number(inputValue || storedValue || 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(parsed, 0), 100);
}

function getHeldRisk(w) {
  return getWagerExposure(w) * (getRetainedRiskPercent() / 100);
}

function parseSport(desc) {
  if (!desc) return 'Other';
  desc = decodeEntities(desc);
  if (/^L[.:]LIVE\b/i.test(desc)) {
    const liveSport = inferSportFromTeams(desc);
    if (liveSport) return liveSport;
  }
  // Pattern 1: GSLIVE format: "M.G123456 - Top Soccer - Player vs Player..."
  const gsliveMatch = desc.match(/^[A-Z][.:]G?\d+\s*-\s*(?:Top\s+)?([A-Za-z]+)/);
  if (gsliveMatch) return gsliveMatch[1];

  // Pattern 2: Standard format: "M.Soccer #123..." or "P:Baseball #123..." or "C:FOOTBALL..."
  const directMatch = desc.match(/^[A-Z][.:]([A-Za-z\s]+?)(?:\s*#|\s*-|\s*$)/);
  if (directMatch) {
    const sport = directMatch[1].trim();
    if (sport.length > 1) return sport;
  }

  // Fallback keyword search
  if (desc.includes('Martial Arts')) return 'MMA';
  if (desc.includes('Basketball')) return 'Basketball';
  if (desc.includes('Baseball')) return 'Baseball';
  if (desc.includes('Tennis')) return 'Tennis';
  if (desc.includes('Soccer')) return 'Soccer';
  if (desc.includes('Hockey')) return 'Hockey';
  if (desc.includes('Golf')) return 'Golf';
  if (desc.includes('Football')) return 'Football';
  if (desc.includes('Rugby')) return 'Rugby';
  if (desc.includes('Boxing')) return 'Boxing';
  if (desc.includes('MMA')) return 'MMA';
  return 'Other';
}

const LEAGUE_TEAM_HINTS = [
  { league: 'WNBA', sport: 'Basketball', names: ['Seattle Storm', 'Golden State Valkyries', 'Minnesota Lynx', 'Las Vegas Aces', 'New York Liberty', 'Indiana Fever', 'Chicago Sky', 'Phoenix Mercury', 'Dallas Wings', 'Connecticut Sun', 'Atlanta Dream', 'Los Angeles Sparks', 'Washington Mystics'] },
  { league: 'NBA', sport: 'Basketball', names: ['Lakers', 'Timberwolves', 'Spurs', 'Warriors', 'Celtics', 'Knicks', 'Nuggets', 'Mavericks', 'Suns', 'Clippers', 'Heat', 'Bucks', '76ers', 'Sixers', 'Thunder', 'Grizzlies', 'Pelicans', 'Kings', 'Jazz', 'Trail Blazers', 'Rockets', 'Hawks', 'Magic', 'Pacers', 'Cavaliers', 'Bulls', 'Nets', 'Hornets', 'Pistons', 'Raptors', 'Wizards'] },
  { league: 'MLB', sport: 'Baseball', names: ['Diamondbacks', 'Mets', 'Giants', 'Pirates', 'Padres', 'Cardinals', 'Dodgers', 'Braves', 'Yankees', 'Red Sox', 'Cubs', 'White Sox', 'Phillies', 'Nationals', 'Marlins', 'Rays', 'Orioles', 'Blue Jays', 'Guardians', 'Tigers', 'Royals', 'Twins', 'Astros', 'Rangers', 'Mariners', 'Athletics', 'Angels', 'Rockies', 'Brewers', 'Reds'] },
  { league: 'NHL', sport: 'Hockey', names: ['Ducks', 'Golden Knights', 'Rangers', 'Islanders', 'Devils', 'Flyers', 'Penguins', 'Bruins', 'Sabres', 'Maple Leafs', 'Canadiens', 'Senators', 'Red Wings', 'Blackhawks', 'Blues', 'Predators', 'Jets', 'Wild', 'Avalanche', 'Stars', 'Oilers', 'Flames', 'Canucks', 'Kraken', 'Sharks', 'Kings', 'Coyotes', 'Utah', 'Hurricanes', 'Capitals', 'Lightning', 'Panthers', 'Blue Jackets'] },
  { league: 'NFL', sport: 'Football', names: ['Saints', 'Chiefs', 'Eagles', 'Cowboys', 'Giants', 'Jets', 'Patriots', 'Bills', 'Dolphins', 'Steelers', 'Ravens', 'Browns', 'Bengals', 'Texans', 'Colts', 'Titans', 'Jaguars', 'Broncos', 'Raiders', 'Chargers', 'Commanders', 'Packers', 'Bears', 'Lions', 'Vikings', 'Buccaneers', 'Falcons', 'Panthers', '49ers', 'Seahawks', 'Rams', 'Cardinals'] },
];

function inferLeagueFromTeams(desc) {
  const haystack = decodeEntities(desc || '').toLowerCase();
  for (const hint of LEAGUE_TEAM_HINTS) {
    if (hint.names.some(name => haystack.includes(name.toLowerCase()))) return hint.league;
  }
  return '';
}

function inferSportFromTeams(desc) {
  const league = inferLeagueFromTeams(desc);
  return LEAGUE_TEAM_HINTS.find(h => h.league === league)?.sport || '';
}

function parseLeague(desc) {
  desc = decodeEntities(desc || '');
  // Extract league from description
  const leagues = [
    { pattern: /\bNBA\b/i, name: 'NBA' },
    { pattern: /\bNFL\b/i, name: 'NFL' },
    { pattern: /\bNHL\b/i, name: 'NHL' },
    { pattern: /\bMLB\b/i, name: 'MLB' },
    { pattern: /\bNCAA\b|\bCollege\b/i, name: 'NCAA' },
    { pattern: /\bENG PREM\b|\bEPL\b|\bPremier League\b/i, name: 'EPL' },
    { pattern: /\bUEFA\b|\bChampions League\b/i, name: 'UCL' },
    { pattern: /\bLa Liga\b/i, name: 'La Liga' },
    { pattern: /\bBundesliga\b/i, name: 'Bundesliga' },
    { pattern: /\bSerie A\b/i, name: 'Serie A' },
    { pattern: /\bLigue 1\b/i, name: 'Ligue 1' },
    { pattern: /\bATP\b|\bWTA\b/i, name: 'Tennis' },
    { pattern: /\bUFC\b/i, name: 'UFC' },
    { pattern: /\bMLS\b/i, name: 'MLS' },
  ];

  for (const lg of leagues) {
    if (lg.pattern.test(desc)) return lg.name;
  }

  const inferred = inferLeagueFromTeams(desc);
  if (inferred) return inferred;

  const rotation = desc.match(/^[A-Z][.:](?:Basketball|Baseball|Football|Hockey)\s+#(\d+)/i);
  if (rotation) {
    const num = Number(rotation[1]);
    const sport = parseSport(desc);
    if (sport === 'Basketball' && num >= 500 && num < 600) return 'NBA';
    if (sport === 'Basketball' && num >= 600) return 'NCAA';
    if (sport === 'Baseball' && num >= 900) return 'MLB';
    if (sport === 'Hockey' && num >= 1) return 'NHL';
  }

  const sport = parseSport(desc);
  if (sport === 'Basketball') return 'Basketball';
  if (sport === 'Baseball') return 'Baseball';
  if (sport === 'Hockey') return 'NHL';
  if (sport === 'Soccer') return 'INTL';
  return '';
}

function parseSelection(desc) {
  if (!desc) return '';
  desc = decodeEntities(desc).replace(/\s+/g, ' ').trim();

  const slashParts = desc.split('/').map(p => p.trim()).filter(Boolean);
  if (slashParts.length >= 2) {
    const last = slashParts[slashParts.length - 1].replace(/\s+-\s+For Game.*$/i, '').trim();
    if (last) return last;
  }

  let clean = desc.replace(/^[A-Z][.:]\s*/, '');
  clean = clean.replace(/^G\d+\s*-\s*/, '');
  clean = clean.replace(/\s+-\s+For\s+.*$/i, '');
  clean = clean.replace(/\s+for\s+Game\s*$/i, '');
  clean = clean.replace(/^#\d+\s+/, '');
  clean = clean.replace(/^(?:Basketball|Baseball|Football|Hockey|Tennis|Soccer|Golf|Martial Arts|LIVE)\s+#\d+\s+/i, '');
  clean = clean.replace(/^(?:Top\s+)?(?:Basketball|Baseball|Football|Hockey|Tennis|Soccer|Golf|Martial Arts)\s+-\s+/i, '');

  const futures = clean.match(/-\s+([^#-]+?\s[+-]\d{2,4})$/);
  if (futures) return futures[1].trim();

  return clean.trim();
}

function parseDescription(desc) {
  if (!desc) return '';
  desc = decodeEntities(desc);

  const selection = parseSelection(desc);
  const market = detectMarketType(desc);
  if (selection && ['moneyline', 'spread', 'total', 'prop', 'future'].includes(market)) {
    const marketLabel = WAGER_MARKETS[market]?.label || 'Market';
    return `${marketLabel}: ${selection}`.substring(0, 80);
  }

  // Remove wager type prefix: M., P., L:, T., C., S., E.
  let clean = desc.replace(/^[A-Z][.:]\s*/, '');

  // Remove GSLIVE game ID: G123456 -
  clean = clean.replace(/^G\d+\s*-\s*/, '');

  // Remove sport prefix if present (e.g., "Tennis - " or "FOOTBALL - ")
  const sport = parseSport(desc);
  if (sport !== 'Other') {
    clean = clean.replace(new RegExp(`^${sport}\\s*-?\\s*`, 'i'), '');
  }

  // Remove " - For Game" / "for  Game" suffix
  clean = clean.replace(/\s+-\s+For\s+.*$/i, '');
  clean = clean.replace(/\s+for\s+Game\s*$/i, '');

  // Remove futures category markers (letter-only words, not game IDs with digits)
  clean = clean.replace(/#[A-Za-z]+(?:\s+[A-Za-z]+)*\s*-\s*/g, '');
  clean = clean.replace(/#[A-Za-z]+(?:\s+[A-Za-z]+)*\s*/g, '');

  // Remove " - buying ½ For Game" type suffixes
  clean = clean.replace(/\s+-\s+buying\s+.*$/i, '');

  // Remove " / Teaser / PLAYER_NAME" suffix
  clean = clean.replace(/\s+\/\s+Teaser\s+\/\s+[^/]+$/i, '');
  clean = clean.replace(/\s+\/\s+Straight\s+\/\s+[^/]+$/i, '');
  clean = clean.replace(/\s+\/\s+Parlay\s+\/\s+[^/]+$/i, '');

  // Remove #ID numbers at the start: "#21556 " or "#952 "
  clean = clean.replace(/^#\d+\s+/, '');

  // Remove league names that appear inline: "ENG PREM - " etc.
  clean = clean.replace(/\b(?:ENG PREM|EPL|NBA|NCAA|MLB|NFL|NHL|UCL|UEFA|MLS|ATP|WTA|UFC|La Liga|Bundesliga|Serie A|Ligue 1)\s*[-–]\s*/i, '');

  // Clean up double spaces
  clean = clean.replace(/\s{2,}/g, ' ');

  // Trim
  clean = clean.trim();

  return clean;
}

function extractPrice(desc) {
  if (!desc) return null;
  desc = decodeEntities(desc);
  // Look for price before " - For Game" or "for Game" or end of string
  const match = desc.match(/\s([+-]\d+(?:\.\d+)?)(?:\s+-\s+For|\s+for\s+Game|\s*$)/i);
  if (match) return match[1];

  // Slash-delimited ticker rows often end with "... / Player 180"; treat that
  // final token as American odds when it is not a game id.
  const slashPrice = desc.match(/\/\s*[^/]*?\s+([+-]?\d{2,4})(?:\s*$|\s+-\s+For|\s+for\s+Game)/i);
  if (slashPrice) {
    const raw = slashPrice[1];
    return raw.startsWith('+') || raw.startsWith('-') ? raw : `+${raw}`;
  }

  // Alternative: look for any price-like number in the description
  const altMatch = desc.match(/\s([+-]\d{2,4})\b/);
  if (altMatch) return altMatch[1];

  return null;
}

// ==================== SORTING ====================
let sortColumn = 'time';
let sortDirection = 'desc';

function setSort(column) {
  if (sortColumn === column) {
    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    sortColumn = column;
    sortDirection = 'desc';
  }
  updateSortHeaders();
  scheduleRender('buckeye');
}

function updateSortHeaders() {
  const headerRow = document.getElementById('wagerTableHeaders');
  if (!headerRow) return;
  headerRow.querySelectorAll('th[data-sort]').forEach(th => {
    const col = th.getAttribute('data-sort');
    const baseText = th.textContent.replace(/\s*[⇅↑↓]\s*$/, '').trim();
    if (sortColumn === col) {
      th.textContent = baseText + ' ' + (sortDirection === 'asc' ? '↑' : '↓');
    } else {
      th.textContent = baseText + ' ⇅';
    }
  });
}

// ==================== INCOMING BETS PANEL ====================
function toggleIncomingPanel() {
  const panel = document.getElementById('incomingPanel');
  const chevron = document.getElementById('incomingChevron');
  if (panel.classList.contains('collapsed')) {
    panel.classList.remove('collapsed');
    panel.classList.add('expanded');
    chevron.style.transform = 'rotate(180deg)';
  } else {
    panel.classList.remove('expanded');
    panel.classList.add('collapsed');
    chevron.style.transform = 'rotate(0deg)';
  }
}

function refreshIncomingBetsFromArchive() {
  incomingBets = buckeyeWagers.slice(0, 20);
  renderIncomingBets();
  updateIncomingBadges();
}

function updateIncomingBadges() {
  const alertCount = incomingBets.filter(w => w.TicketWriter === 'ALERT').length;
  const liveCount = incomingBets.filter(w => w.TicketWriter === 'GSLIVE').length;
  document.getElementById('incomingCount').textContent = incomingBets.length;
  const alertEl = document.getElementById('incomingAlertCount');
  const liveEl = document.getElementById('incomingLiveCount');
  if (alertEl) alertEl.textContent = alertCount;
  if (liveEl) liveEl.textContent = liveCount;
  updateTopBarStatus();
}

function renderIncomingBets() {
  const container = document.getElementById('incomingBetsList');
  if (!container) return;

  container.innerHTML = incomingBets.slice(0, 10).map(w => {
    const isAlert = w.TicketWriter === 'ALERT';
    const isLive = w.TicketWriter === 'GSLIVE';
    const borderColor = isAlert ? 'var(--red)' : isLive ? 'var(--cyan)' : 'var(--border)';
    const bgColor = isAlert ? 'rgba(239,68,68,0.1)' : isLive ? 'rgba(6,182,212,0.1)' : 'var(--bg)';

    return `<div class="flex items-center justify-between p-2 rounded border" style="background:${bgColor};border-color:${borderColor};">
      <div class="flex items-center gap-2">
        <span class="text-xs font-bold">${escapeHtml(w.Login)}</span>
        <span class="text-xs" style="color:var(--text-dim);">${escapeHtml(w.AgentLogin)}</span>
        <span class="text-xs px-1 rounded" style="background:${WAGER_TYPES[detectWagerType(w)]?.color || '#6b7280'}22;color:${WAGER_TYPES[detectWagerType(w)]?.color || '#6b7280'};">${escapeHtml(WAGER_TYPES[detectWagerType(w)]?.label || w.WagerType)}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs font-mono">$${w.AmountWagered.toLocaleString()}</span>
        ${isAlert ? '<span class="text-xs px-1 rounded" style="background:var(--red);color:#fff;">ALERT</span>' : ''}
        ${isLive ? '<span class="text-xs px-1 rounded" style="background:var(--cyan);color:#fff;">LIVE</span>' : ''}
      </div>
    </div>`;
  }).join('');
}

// ==================== ALERTS ====================
function renderAlerts() {
  const container = document.getElementById('alertsList');
  if (!container) return;

  // Generate alerts from real data
  const alertWagers = buckeyeWagers.filter(w => w.TicketWriter === 'ALERT' || w.AmountWagered >= 10000);

  const flagged = new Set(JSON.parse(localStorage.getItem('flaggedAlerts') || '[]'));
  container.innerHTML = alertWagers.slice(0, 20).map((w, idx) => {
    const severity = w.AmountWagered >= 50000 ? 'critical' : w.AmountWagered >= 10000 ? 'warning' : 'info';
    const severityClass = severity === 'critical' ? 'alert-critical' : severity === 'warning' ? 'alert-warning' : 'alert-info';
    const id = `alert-${w.WagerNumber || idx}`;
    const isFlagged = flagged.has(id);

    return `<div class="flex items-center justify-between p-3 rounded-lg ${severityClass}" id="${id}">
      <div class="flex-1 min-w-0">
        <div class="text-xs font-bold">${escapeHtml(w.AgentLogin)} → ${escapeHtml(w.Login)} ${isFlagged ? '<span class="ml-1 px-1 rounded text-[10px]" style="background:var(--yellow);color:#000;">FLAGGED</span>' : ''}</div>
        <div class="text-xs mt-0.5" style="color:var(--text-dim);">${escapeHtml(String(w.ShortDesc || '').substring(0, 60))}...</div>
      </div>
      <div class="text-right ml-3 shrink-0">
        <div class="text-xs font-mono font-bold">$${w.AmountWagered.toLocaleString()}</div>
        <div class="flex gap-1 mt-1 justify-end">
          <button class="text-[10px] px-1.5 py-0.5 rounded" style="background:var(--panel);border:1px solid var(--border);color:var(--text);" onclick="toggleAlertFlag('${id}')">${isFlagged ? 'Unflag' : 'Flag'}</button>
          <button class="text-[10px] px-1.5 py-0.5 rounded" style="background:var(--panel);border:1px solid var(--border);color:var(--text-dim);" onclick="dismissAlert('${id}')">Dismiss</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Update badge
  const badge = document.getElementById('alertBadge');
  if (alertWagers.length > 0) {
    badge.textContent = alertWagers.length;
    badge.classList.remove('hidden');
  }
}

function toggleAlertFlag(id) {
  const flagged = new Set(JSON.parse(localStorage.getItem('flaggedAlerts') || '[]'));
  if (flagged.has(id)) flagged.delete(id);
  else flagged.add(id);
  localStorage.setItem('flaggedAlerts', JSON.stringify(Array.from(flagged)));
  renderAlerts();
}

function dismissAlert(id) {
  const el = document.getElementById(id);
  if (el) {
    el.style.opacity = '0.4';
    el.style.pointerEvents = 'none';
  }
  const dismissed = new Set(JSON.parse(localStorage.getItem('dismissedAlerts') || '[]'));
  dismissed.add(id);
  localStorage.setItem('dismissedAlerts', JSON.stringify(Array.from(dismissed)));
}

function toggleAlertsToast() {
  const current = localStorage.getItem('toastsEnabled') !== 'false';
  const next = !current;
  localStorage.setItem('toastsEnabled', String(next));
  updateAlertsToastButton();
  showToast(next ? 'Alert toasts enabled' : 'Alert toasts muted', 'info');
}

function updateAlertsToastButton() {
  const enabled = localStorage.getItem('toastsEnabled') !== 'false';
  const icon = document.getElementById('alertsToastIcon');
  const label = document.getElementById('alertsToastLabel');
  const btn = document.getElementById('alertsToastToggle');
  if (icon) icon.textContent = enabled ? '🔔' : '🔕';
  if (label) label.textContent = enabled ? 'Toasts On' : 'Toasts Off';
  if (btn) {
    btn.style.opacity = enabled ? '1' : '0.6';
  }
  updateTopBarStatus();
}

// ==================== PATTERNS ====================
function setPatternCategory(category) {
  patternCategory = category || 'all';
  sectionCache.patterns.at = 0;
  document.querySelectorAll('.pattern-category-tab').forEach(btn => {
    const active = btn.dataset.category === patternCategory;
    btn.style.background = active ? 'var(--accent)' : 'var(--panel)';
    btn.style.border = `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`;
    btn.style.color = active ? '#fff' : 'var(--text)';
  });
  loadPatterns(true);
}

async function loadPatterns(force = false) {
  const filters = getPatternFilters();
  const requestKey = JSON.stringify(filters);

  if (!force && isCacheFresh('patterns') && requestKey === lastPatternRequestKey) {
    renderPatterns();
    return;
  }

  if (patternsLoading) return;
  patternsLoading = true;
  setPatternRefreshState(true);

  try {
    const historyUrl = new URL(`${getApiBaseUrl()}/api/patterns/history`);
    historyUrl.searchParams.set('limit', '150');
    historyUrl.searchParams.set('sinceHours', filters.sinceHours);
    if (filters.type !== 'all') historyUrl.searchParams.set('type', filters.type);
    if (filters.market !== 'all') historyUrl.searchParams.set('market', filters.market);
    if (filters.category !== 'all') historyUrl.searchParams.set('category', filters.category);
    if (filters.sport !== 'all') historyUrl.searchParams.set('sport', filters.sport);
    if (filters.agent !== 'all') historyUrl.searchParams.set('agent', filters.agent);

    const summaryUrl = new URL(`${getApiBaseUrl()}/api/patterns/summary`);
    summaryUrl.searchParams.set('sinceHours', filters.sinceHours);

    const catalogUrl = new URL(`${getApiBaseUrl()}/api/patterns/catalog`);

    const choicesUrl = new URL(`${getApiBaseUrl()}/api/patterns/history`);
    choicesUrl.searchParams.set('limit', '500');
    choicesUrl.searchParams.set('sinceHours', filters.sinceHours);

    const [historyRes, summaryRes, catalogRes, choicesRes] = await Promise.all([
      fetch(historyUrl.toString()),
      fetch(summaryUrl.toString()),
      fetch(catalogUrl.toString()),
      fetch(choicesUrl.toString()),
    ]);
    if (!historyRes.ok) throw new Error(`Pattern history failed: ${historyRes.status}`);
    if (!summaryRes.ok) throw new Error(`Pattern summary failed: ${summaryRes.status}`);

    patternsData = await historyRes.json();
    patternSummary = await summaryRes.json();
    if (catalogRes.ok) {
      const catalogBody = await catalogRes.json();
      patternCatalog = Array.isArray(catalogBody.patterns) ? catalogBody.patterns : [];
      renderPatternTypeOptions();
    }
    if (choicesRes.ok) {
      updatePatternFilterChoices(await choicesRes.json());
    }
    lastPatternRequestKey = requestKey;
    markCacheFresh('patterns');
  } catch (err) {
    console.log('[Patterns] Failed to load live patterns:', err.message);
    patternsData = [];
    patternSummary = { byType: {}, bySeverity: {}, total: 0 };
    renderPatternCatalogPanel();
  } finally {
    patternsLoading = false;
    setPatternRefreshState(false);
  }

  renderPatterns();
  updatePatternBadge();
}

function getPatternFilters() {
  return {
    sinceHours: document.getElementById('patternWindowFilter')?.value || '24',
    type: document.getElementById('patternTypeFilter')?.value || 'all',
    market: document.getElementById('patternMarketFilter')?.value || 'all',
    sport: document.getElementById('patternSportFilter')?.value || 'all',
    agent: document.getElementById('patternAgentFilter')?.value || 'all',
    category: patternCategory || 'all',
  };
}

function setPatternRefreshState(isLoading) {
  const btn = document.getElementById('patternRefreshBtn');
  if (!btn) return;
  btn.disabled = isLoading;
  btn.textContent = isLoading ? 'Refreshing...' : 'Refresh';
  btn.style.opacity = isLoading ? '0.65' : '1';
}

function updatePatternFilterChoices(rows) {
  const agents = new Set();
  const sports = new Set(['Basketball', 'Baseball', 'Football', 'Hockey', 'Soccer', 'Tennis', 'MMA', 'System']);

  for (const row of rows || []) {
    if (row.sport) sports.add(row.sport);
    const details = parsePatternDetails(row);
    const directAgents = [
      details.agent,
      ...(Array.isArray(details.agents) ? details.agents : []),
      details.correlation?.wager?.AgentLogin,
    ].filter(Boolean);
    directAgents.forEach(agent => agents.add(String(agent)));
  }

  patternFilterChoices = {
    agents: Array.from(agents).sort((a, b) => a.localeCompare(b)),
    sports: Array.from(sports).sort((a, b) => a.localeCompare(b)),
  };
  renderPatternFilterOptions();
}

function renderPatternFilterOptions() {
  const sportSelect = document.getElementById('patternSportFilter');
  const agentSelect = document.getElementById('patternAgentFilter');
  if (sportSelect) {
    const selected = sportSelect.value || 'all';
    sportSelect.innerHTML = `<option value="all">All sports</option>${patternFilterChoices.sports.map(sport => `<option value="${escapeHtml(sport)}">${escapeHtml(sport)}</option>`).join('')}`;
    sportSelect.value = patternFilterChoices.sports.includes(selected) ? selected : 'all';
  }
  if (agentSelect) {
    const selected = agentSelect.value || 'all';
    agentSelect.innerHTML = `<option value="all">All agents</option>${patternFilterChoices.agents.map(agent => `<option value="${escapeHtml(agent)}">${escapeHtml(agent)}</option>`).join('')}`;
    agentSelect.value = patternFilterChoices.agents.includes(selected) ? selected : 'all';
  }
}

function renderPatternTypeOptions() {
  const select = document.getElementById('patternTypeFilter');
  if (!select || !patternCatalog.length) return;
  const selected = select.value || 'all';
  const options = patternCatalog
    .slice()
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.label || a.type).localeCompare(b.label || b.type))
    .map(def => `<option value="${escapeHtml(def.type)}">${escapeHtml(def.label || def.type)}</option>`)
    .join('');
  select.innerHTML = `<option value="all">All active detectors</option>${options}`;
  select.value = patternCatalog.some(def => def.type === selected) ? selected : 'all';
}

function renderPatterns() {
  const tbody = document.getElementById('patternsTable');
  if (!tbody) return;

  syncPatternCategoryTabs();
  updatePatternSummaryCards();
  renderPatternCatalogPanel();

  if (!patternsData.length) {
    const filterNote = describePatternFilters();
    tbody.innerHTML = `<tr><td colspan="5" class="px-3 py-6 text-center" style="color:var(--text-dim);">
      <div>No patterns found for this slice.</div>
      <div class="text-[10px] mt-1">${escapeHtml(filterNote || 'The detector starts filling once odds, wagers, IP logs, or live timing evidence is persisted.')}</div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = patternsData.map(p => {
    const score = Number(p.score || severityToScore(p.severity));
    const color = score > 80 ? 'var(--red)' : score > 60 ? 'var(--yellow)' : 'var(--green)';
    const detailsJson = parsePatternDetails(p);
    const game = [p.away_team, p.home_team].filter(Boolean).join(' vs ') || detailsJson?.correlation?.parsed?.game || p.event_id || 'Unknown game';
    const time = p.detected_at ? timeAgo(p.detected_at) : '-';
    const details = p.description || `${p.market} ${p.side} triggered by ${p.trigger_book || 'book move'}`;
    const category = p.category || 'odds';
    return `<tr class="border-b cursor-pointer" style="border-color:var(--border);" onclick="showPatternDetail('${escapeHtml(p.id)}')">
      <td class="px-3 py-2">
        <span class="px-1.5 py-0.5 rounded text-xs font-bold" style="background:${color}22;color:${color};">${escapeHtml(displayPatternType(p.type))}</span>
        <div class="text-[10px] mt-1 uppercase" style="color:var(--text-dim);">${escapeHtml(category)}</div>
      </td>
      <td class="px-3 py-2">
        <div class="font-medium">${escapeHtml(game)}</div>
        <div class="text-[10px]" style="color:var(--text-dim);">${escapeHtml([p.sport, p.league, p.market].filter(Boolean).join(' | '))}</div>
      </td>
      <td class="px-3 py-2 text-xs" style="color:var(--text-dim);">${escapeHtml(details)}</td>
      <td class="px-3 py-2 text-center">
        <div class="flex items-center justify-center gap-1">
          <div class="w-16 h-1.5 rounded-full" style="background:var(--border);"><div class="h-full rounded-full" style="width:${score}%;background:${color};"></div></div>
          <span class="text-xs">${score}%</span>
        </div>
      </td>
      <td class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">${escapeHtml(time)}</td>
    </tr>`;
  }).join('');
}

function renderPatternCatalogPanel() {
  const panel = document.getElementById('patternCatalogPanel');
  if (!panel) return;
  if (!patternCatalog.length) {
    panel.innerHTML = '<div class="text-xs" style="color:var(--text-dim);">Detector catalog unavailable. Pattern rows still show persisted evidence and reason codes.</div>';
    return;
  }

  const filters = getPatternFilters();
  const visibleDefs = patternCatalog
    .filter(def => filters.category === 'all' || def.category === filters.category)
    .filter(def => filters.type === 'all' || def.type === filters.type);
  const categoryCounts = patternCatalog.reduce((acc, def) => {
    acc[def.category] = (acc[def.category] || 0) + 1;
    return acc;
  }, {});
  const chips = Object.entries(categoryCounts)
    .map(([category, count]) => `<span class="px-2 py-0.5 rounded text-[10px]" style="background:var(--bg);color:var(--text-dim);">${escapeHtml(category)} ${count}</span>`)
    .join('');
  const defs = visibleDefs.slice(0, 6).map(def => `
    <button type="button" class="text-left rounded border p-2" style="background:var(--bg);border-color:var(--border);" onclick="showPatternDefinition('${escapeJs(def.type)}')">
      <div class="text-xs font-semibold">${escapeHtml(def.label || def.type)}</div>
      <div class="text-[10px] mt-1" style="color:var(--text-dim);">${escapeHtml(def.trigger)}</div>
    </button>
  `).join('');

  panel.innerHTML = `
    <div class="flex items-center justify-between gap-3 mb-2">
      <div>
        <div class="text-xs font-semibold">Active Detector Catalog</div>
        <div class="text-[10px]" style="color:var(--text-dim);">${patternCatalog.length} active detectors. Rules are derived from local live wager, odds movement, event, and access-log tables.</div>
      </div>
      <div class="flex flex-wrap gap-1 justify-end">${chips}</div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-2">${defs || '<div class="text-xs" style="color:var(--text-dim);">No detector definitions match this filter.</div>'}</div>
  `;
}

function syncPatternCategoryTabs() {
  document.querySelectorAll('.pattern-category-tab').forEach(btn => {
    const active = btn.dataset.category === patternCategory;
    btn.style.background = active ? 'var(--accent)' : 'var(--panel)';
    btn.style.border = `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`;
    btn.style.color = active ? '#fff' : 'var(--text)';
  });
}

function parsePatternDetails(pattern) {
  if (!pattern) return {};
  if (pattern.details_json && typeof pattern.details_json === 'string') {
    try { return JSON.parse(pattern.details_json); } catch { return {}; }
  }
  return pattern.details_json || pattern.details || {};
}

function showPatternDetail(patternId) {
  const pattern = patternsData.find(p => String(p.id) === String(patternId));
  const drawer = document.getElementById('patternDetailDrawer');
  if (!pattern || !drawer) return;

  const details = parsePatternDetails(pattern);
  const correlation = details.correlation || {};
  const parsed = correlation.parsed || {};
  const match = correlation.match || {};
  const pin = correlation.pinReference || details.pinReference || null;
  const reasonCodes = details.reasonCodes || [];
  const score = Number(pattern.score || severityToScore(pattern.severity));
  const definition = getPatternDefinition(pattern.type);

  drawer.innerHTML = `
    <div class="flex items-start justify-between gap-2 mb-3">
      <div>
        <h3 class="text-sm font-semibold">${escapeHtml(displayPatternType(pattern.type))}</h3>
        <div class="text-[10px] uppercase mt-1" style="color:var(--text-dim);">${escapeHtml(pattern.category || 'odds')} | ${escapeHtml(pattern.severity || 'info')} | ${score}%</div>
      </div>
      <button class="px-2 py-1 rounded text-xs" style="background:var(--bg);border:1px solid var(--border);" onclick="resetPatternDetail()">Clear</button>
    </div>
    <div class="text-xs mb-3" style="color:var(--text);">${escapeHtml(pattern.description || '')}</div>
    ${patternDetailRow('Detected', pattern.detected_at ? new Date(pattern.detected_at).toLocaleString() : '-')}
    ${patternDetailRow('Game', parsed.game || [pattern.away_team, pattern.home_team].filter(Boolean).join(' vs ') || pattern.event_id || '-')}
    ${patternDetailRow('Market / Side', [pattern.market, pattern.side].filter(Boolean).join(' / '))}
    ${patternDetailRow('Wager', details.wagerNumber || '-')}
    ${patternDetailRow('Player / Agent', [details.player || details.players?.join(', '), details.agent || details.agents?.join(', ')].filter(Boolean).join(' / ') || '-')}
    ${patternDetailRow('IP', details.ip || '-')}
    ${patternDetailRow('Event Match', match.eventId ? `${match.eventId} (${match.confidence || 0}%)` : '-')}
    ${patternDetailRow('PIN Reference', pin ? compactJson(pin) : '-')}
    ${patternDetailRow('Reason Codes', reasonCodes.length ? reasonCodes.join(', ') : '-')}
    ${definition ? patternDefinitionBlock(definition) : ''}
    <div class="mt-3 pt-3 border-t" style="border-color:var(--border);">
      <div class="text-[10px] uppercase mb-1" style="color:var(--text-dim);">Raw Evidence</div>
      <pre class="text-[10px] overflow-auto max-h-64 p-2 rounded" style="background:var(--bg);color:var(--text-dim);">${escapeHtml(JSON.stringify(details, null, 2))}</pre>
    </div>`;
}

function showPatternDefinition(type) {
  const drawer = document.getElementById('patternDetailDrawer');
  const definition = getPatternDefinition(type);
  if (!drawer || !definition) return;
  drawer.innerHTML = `
    <div class="flex items-start justify-between gap-2 mb-3">
      <div>
        <h3 class="text-sm font-semibold">${escapeHtml(definition.label || definition.type)}</h3>
        <div class="text-[10px] uppercase mt-1" style="color:var(--text-dim);">${escapeHtml(definition.category)} | ${escapeHtml(definition.confidence)} | ${escapeHtml(definition.detector)}</div>
      </div>
      <button class="px-2 py-1 rounded text-xs" style="background:var(--bg);border:1px solid var(--border);" onclick="resetPatternDetail()">Clear</button>
    </div>
    ${patternDefinitionBlock(definition)}
  `;
}

function resetPatternDetail() {
  const drawer = document.getElementById('patternDetailDrawer');
  if (!drawer) return;
  drawer.innerHTML = `<h3 class="text-sm font-semibold mb-3">Evidence</h3>
    <div class="text-xs" style="color:var(--text-dim);">Select a pattern row to inspect wager timing, matched event, PIN reference, agents, players, IPs, and reason codes.</div>
    <div class="pt-3 mt-3 border-t text-xs" style="border-color:var(--border);color:var(--text-dim);">
      <span id="patternHealthText">${patternSummary.total || 0} patterns in window | ${(patternSummary.bySeverity || {}).critical || 0} critical</span>
    </div>`;
}

function patternDetailRow(label, value) {
  return `<div class="flex justify-between gap-3 border-b py-1.5 text-xs" style="border-color:var(--border);">
    <span style="color:var(--text-dim);">${escapeHtml(label)}</span>
    <span class="text-right break-all" style="color:var(--text);">${escapeHtml(value)}</span>
  </div>`;
}

function patternDefinitionBlock(definition) {
  const severityRows = Object.entries(definition.severity || {})
    .map(([level, text]) => `<div><strong>${escapeHtml(level)}:</strong> ${escapeHtml(text)}</div>`)
    .join('');
  return `<div class="mt-3 pt-3 border-t text-xs" style="border-color:var(--border);">
    <div class="text-[10px] uppercase mb-1" style="color:var(--text-dim);">Detector Definition</div>
    ${patternDetailRow('Trigger', definition.trigger || '-')}
    ${patternDetailRow('Source Tables', (definition.sourceTables || []).join(', ') || '-')}
    ${patternDetailRow('Evidence Fields', (definition.evidenceFields || []).join(', ') || '-')}
    ${patternDetailRow('Confidence', definition.confidence || '-')}
    <div class="mt-2 p-2 rounded" style="background:var(--bg);color:var(--text-dim);">${severityRows || 'Severity is fixed for this detector.'}</div>
  </div>`;
}

function compactJson(value) {
  return JSON.stringify(value, null, 0).slice(0, 220);
}

function getPatternDefinition(type) {
  return patternCatalog.find(def => def.type === type);
}

function displayPatternType(type) {
  const definition = getPatternDefinition(type);
  if (definition) return definition.label || definition.type;
  const labels = {
    cross_agent_steam: 'Cross-Agent Steam',
    agent_reversal: 'Agent Reversal',
    late_money: 'Late Money',
    velocity_spike: 'Velocity Spike',
  };
  return labels[type] || type || 'Pattern';
}

function describePatternFilters() {
  const filters = getPatternFilters();
  const active = [];
  if (filters.category !== 'all') active.push(filters.category);
  if (filters.type !== 'all') active.push(filters.type);
  if (filters.market !== 'all') active.push(filters.market);
  if (filters.sport !== 'all') active.push(filters.sport);
  if (filters.agent !== 'all') active.push(filters.agent);
  active.push(`${filters.sinceHours}h`);
  return active.length ? `Active filters: ${active.join(' / ')}` : '';
}

function updatePatternSummaryCards() {
  const byType = patternSummary.byType || {};
  setText('patternSteamCount', byType['Steam Move'] || 0);
  setText('patternReverseCount', (byType['Agent Swarm'] || 0) + (byType.cross_agent_steam || 0) + (byType['Cross-Agent Swarm'] || 0));
  setText('patternSyndicateCount', (byType['Live Past-Post Risk'] || 0) + (byType['Late Live Spike'] || 0));
  setText('patternArbCount', (byType['Pinnacle Drift Bet'] || 0) + (byType['Post-PIN Move Bet'] || 0) + (byType['Repeat Timing Signature'] || 0) + (byType['Steam Chase'] || 0));
  const health = document.getElementById('patternHealthText');
  if (health) {
    const critical = patternSummary.bySeverity?.critical || 0;
    health.textContent = `${patternSummary.total || 0} patterns in window | ${critical} critical`;
  }
}

function updatePatternBadge() {
  const badge = document.getElementById('patternBadge');
  if (!badge) return;
  const count = patternSummary.bySeverity?.critical || 0;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function severityToScore(severity) {
  if (severity === 'critical') return 90;
  if (severity === 'warning') return 70;
  return 45;
}

FactoryWager.utils.debounce = function debounce(key, fn, wait = FactoryWager.state.ui.searchDebounceMs) {
  clearTimeout(FactoryWager.timers[key]);
  FactoryWager.timers[key] = setTimeout(fn, wait);
};

function debounce(fn, wait = FactoryWager.state.ui.searchDebounceMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

FactoryWager.apiFetch = async function apiFetch(endpoint, options = {}) {
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const query = options.query || {};
  const candidates = [
    `/api/v1${normalizedEndpoint}`,
    options.fallbackEndpoint || `/api${normalizedEndpoint}`,
  ];
  let lastError;
  for (const candidate of [...new Set(candidates)]) {
    const url = new URL(`${getApiBaseUrl()}${candidate}`);
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    });
    try {
      const token = localStorage.getItem('apiToken');
      const init = {
        method: options.method || 'GET',
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          ...(options.headers || {}),
        },
      };
      if (options.body) init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      const res = await fetch(url, init);
      if (res.ok) {
        if (options.responseType === 'response') return res;
        return res.json();
      }
      lastError = new Error(`${candidate} failed: ${res.status}`);
      if (res.status !== 404) break;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`API request failed: ${normalizedEndpoint}`);
};

FactoryWager.apiUrl = function apiUrl(endpoint, query = {}) {
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = new URL(`${getApiBaseUrl()}/api/v1${normalizedEndpoint}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  return url.toString();
};

// ==================== ODDS MATRIX ====================
let currentMatrixData = { games: [], books: [], movements: [] };
let currentBookHealth = {};
let matrixState = {
  sport: 'all',
  market: 'spread',
  search: '',
  sort: 'startTime',
  showConsensus: true,
  expandedGame: null,
};

const DEFAULT_BOOK_ORDER = ['PIN','BOL','BOV','BUC','ACE','MET','DK','FD','MGM','CZR','PB','BR','BS','SBO','STK','NIT'];
const ALL_SPORTS = ['all','NBA','NCAAB','MLB','NHL','NFL','Soccer'];

let bookPreferences = loadBookPreferences();

function loadBookPreferences() {
  try {
    const raw = localStorage.getItem('bookPreferences');
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    order: [...DEFAULT_BOOK_ORDER],
    visible: ['PIN','BOL','BOV','BUC','ACE','MET'],
  };
}

function saveBookPreferences(prefs) {
  localStorage.setItem('bookPreferences', JSON.stringify(prefs));
  bookPreferences = prefs;
}

async function loadOddsData(force = false) {
  if (!force && isCacheFresh('odds')) {
    renderOddsMatrix();
    return;
  }

  let url = '';
  try {
    const visibleBooks = bookPreferences.visible.join(',');
    const sportParam = matrixState.sport !== 'all' ? `&sport=${encodeURIComponent(matrixState.sport)}` : '';
    url = `${getApiBaseUrl()}/api/odds/live?books=${visibleBooks}${sportParam}`;
    const oddsRes = await fetch(url);

    if (oddsRes.ok) {
      currentMatrixData = await oddsRes.json();
      currentBookHealth = {};
      (currentMatrixData.books || []).forEach(h => { currentBookHealth[h.key] = h.status; });
      indexMovements(currentMatrixData.movements);
      markCacheFresh('odds');
    }

    renderOddsMatrix();
  } catch (err) {
    console.error('Failed to load odds:', err?.message || err, '| URL:', url);
    renderDemoOddsMatrix();
  }
}

function renderDemoOddsMatrix() {
  indexMovements([]);
  const grid = document.getElementById('oddsGrid');
  const mobile = document.getElementById('oddsGridMobile');
  if (grid) grid.innerHTML = '<div class="p-4 text-sm" style="color:var(--text-dim);">Odds backend unavailable. Start the backend to see live odds.</div>';
  if (mobile) mobile.innerHTML = '<div class="p-4 text-sm" style="color:var(--text-dim);">Odds backend unavailable.</div>';
}

function getVisibleBooks() {
  if (!currentMatrixData.books || currentMatrixData.books.length === 0) {
    return bookPreferences.visible.map(b => ({ key: b, name: b, status: currentBookHealth[b] || 'unknown' }));
  }
  const ordered = [];
  for (const key of bookPreferences.order) {
    const meta = currentMatrixData.books.find(b => b.key === key);
    if (meta && bookPreferences.visible.includes(key)) ordered.push(meta);
  }
  // Append any visible books not in order
  for (const meta of currentMatrixData.books) {
    if (bookPreferences.visible.includes(meta.key) && !ordered.find(b => b.key === meta.key)) {
      ordered.push(meta);
    }
  }
  return ordered;
}

function getFilteredGames() {
  let games = currentMatrixData.games || [];
  if (matrixState.search) {
    const q = matrixState.search.toLowerCase();
    games = games.filter(g => g.home.toLowerCase().includes(q) || g.away.toLowerCase().includes(q));
  }
  games = [...games];
  if (matrixState.sort === 'startTime') {
    games.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  } else if (matrixState.sort === 'sport') {
    games.sort((a, b) => a.sport.localeCompare(b.sport) || new Date(a.startTime) - new Date(b.startTime));
  } else if (matrixState.sort === 'name') {
    games.sort((a, b) => a.away.localeCompare(b.away));
  }
  return games;
}

function getMovement(gameId, book, market, side) {
  return currentMovementIndex[`${gameId}:${book}:${market}:${side}`] || null;
}

function formatOddsValue(val, type) {
  if (val === null || val === undefined) return '—';
  if (oddsFormat === 'decimal') {
    if (val === 0) return '—';
    const dec = val > 0 ? (val / 100) + 1 : (100 / Math.abs(val)) + 1;
    return dec.toFixed(2);
  }
  if (type === 'spread' || type === 'total') {
    return (val > 0 ? '+' : '') + val.toFixed(1);
  }
  return (val > 0 ? '+' : '') + Math.round(val);
}

function formatOddsCell(awayVal, homeVal, type, awayPrice, homePrice) {
  const awayStr = formatOddsValue(awayVal, type);
  const homeStr = formatOddsValue(homeVal, type);
  const awayPriceStr = (type === 'spread' || type === 'total') && awayPrice != null ? ` <span style="color:var(--text-dim);font-size:10px;">(${formatOddsValue(awayPrice, 'moneyline')})</span>` : '';
  const homePriceStr = (type === 'spread' || type === 'total') && homePrice != null ? ` <span style="color:var(--text-dim);font-size:10px;">(${formatOddsValue(homePrice, 'moneyline')})</span>` : '';
  return `<div class="odds-price">${awayStr}${awayPriceStr}</div><div class="odds-juice">${homeStr}${homePriceStr}</div>`;
}

function findBestBook(games, market, side) {
  const bestByGame = {};
  for (const g of games) {
    let best = null;
    for (const book of Object.keys(g.books)) {
      const bookData = g.books[book];
      if (!bookData || !bookData[market]) continue;
      const val = bookData[market][side];
      if (val === null || val === undefined) continue;
      // For spreads/totals, lower absolute value is often better for dogs; for moneyline, higher is better for dogs
      const isBetter = (market === 'moneyline')
        ? (best === null || val > best.val)
        : (best === null || val > best.val);
      if (isBetter) best = { book, val };
    }
    bestByGame[g.id] = best?.book || null;
  }
  return bestByGame;
}

// ==================== TOOLTIP SYSTEM ====================
const tooltipEl = document.getElementById('globalTooltip');
const tooltipContentEl = document.getElementById('globalTooltipContent');
let tooltipHideTimer = null;
let tooltipCache = {};
let tooltipIdCounter = 0;

function cacheTooltip(html) {
  const id = 'tt_' + (tooltipIdCounter++);
  tooltipCache[id] = html;
  return id;
}

function getCachedTooltip(id) {
  return tooltipCache[id] || '';
}

function clearTooltipCache() {
  tooltipCache = {};
  tooltipIdCounter = 0;
}

function showTooltip(targetEl, htmlContent) {
  if (!tooltipEl || !tooltipContentEl) return;
  tooltipContentEl.innerHTML = htmlContent;
  tooltipEl.classList.add('visible');

  const rect = targetEl.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - Math.min(tipRect.width, 320) / 2;

  // Keep within viewport
  if (left < 8) left = 8;
  if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
  if (top + tipRect.height > window.innerHeight - 8) top = rect.top - tipRect.height - 8;

  tooltipEl.style.top = top + 'px';
  tooltipEl.style.left = left + 'px';
}

function hideTooltip() {
  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(() => {
    if (tooltipEl) tooltipEl.classList.remove('visible');
  }, 150);
}

function keepTooltip() {
  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
}

if (tooltipEl) {
  tooltipEl.addEventListener('mouseenter', keepTooltip);
  tooltipEl.addEventListener('mouseleave', hideTooltip);
}

function buildOddsCellTooltip(gameId, bookKey, market, side) {
  const game = currentMatrixData.games.find(g => g.id === gameId);
  if (!game) return '';
  const bookData = game.books[bookKey];
  if (!bookData) return '';
  const mktData = bookData[market];
  if (!mktData) return '';

  const val = side === 'over' ? mktData.over : side === 'under' ? mktData.under : side === 'home' ? mktData.home : mktData.away;
  const otherSide = side === 'over' ? 'under' : side === 'under' ? 'over' : side === 'home' ? 'away' : 'home';
  const otherVal = side === 'over' ? mktData.under : side === 'under' ? mktData.over : side === 'home' ? mktData.away : mktData.home;
  const lastUpdated = mktData.lastUpdated ? new Date(mktData.lastUpdated).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '—';

  const price = (market === 'spread' || market === 'total') ? (side === 'over' ? mktData.overPrice : side === 'under' ? mktData.underPrice : side === 'home' ? mktData.homePrice : mktData.awayPrice) : null;
  const otherPrice = (market === 'spread' || market === 'total') ? (side === 'over' ? mktData.underPrice : side === 'under' ? mktData.overPrice : side === 'home' ? mktData.awayPrice : mktData.homePrice) : null;
  let html = `<div class="tooltip-header">${bookKey} — ${market.charAt(0).toUpperCase() + market.slice(1)}</div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Current</span><span class="tooltip-value">${formatOddsValue(val, market)}${price != null ? ' (' + formatOddsValue(price, 'moneyline') + ')' : ''}</span></div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Other Side</span><span class="tooltip-value">${formatOddsValue(otherVal, market)}${otherPrice != null ? ' (' + formatOddsValue(otherPrice, 'moneyline') + ')' : ''}</span></div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Last Update</span><span class="tooltip-value">${lastUpdated}</span></div>`;

  // Recent moves
  const msk = `${market}:${side}`;
  const recent = bookData.recentMoves?.[msk];
  if (recent && recent.length > 0) {
    html += `<div class="tooltip-section"><div class="tooltip-section-title">Recent Moves</div>`;
    for (const mov of recent.slice(0, 5)) {
      const t = new Date(mov.recorded_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      const arrow = mov.delta > 0 ? '▲' : '▼';
      html += `<div class="tooltip-move-row"><span class="tooltip-move-time">${t}</span><span class="tooltip-move-val">${formatOddsValue(mov.new_value, market)} ${arrow}${Math.abs(mov.delta).toFixed(1)}</span></div>`;
    }
    html += `</div>`;
  }

  // vs Consensus
  const cons = game.consensus?.[market];
  if (cons) {
    const consVal = side === 'over' ? cons.over : side === 'under' ? cons.under : side === 'home' ? cons.home : cons.away;
    if (consVal !== null && val !== null) {
      const diff = val - consVal;
      const diffStr = diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
      const diffColor = diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--text-dim)';
      html += `<div class="tooltip-section"><div class="tooltip-section-title">vs Consensus</div>`;
      html += `<div class="tooltip-row"><span class="tooltip-label">PIN Line</span><span class="tooltip-value">${formatOddsValue(consVal, market)}</span></div>`;
      html += `<div class="tooltip-row"><span class="tooltip-label">Diff</span><span class="tooltip-value" style="color:${diffColor};">${diffStr}</span></div></div>`;
    }
  }

  // vs Open
  const openLine = bookData.openLine?.[market];
  if (openLine) {
    const openVal = side === 'over' ? openLine.over : side === 'under' ? openLine.under : side === 'home' ? openLine.home : openLine.away;
    if (openVal !== null && val !== null) {
      const diff = val - openVal;
      const diffStr = diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
      html += `<div class="tooltip-section"><div class="tooltip-section-title">vs Open</div>`;
      html += `<div class="tooltip-row"><span class="tooltip-label">Open</span><span class="tooltip-value">${formatOddsValue(openVal, market)}</span></div>`;
      html += `<div class="tooltip-row"><span class="tooltip-label">Change</span><span class="tooltip-value">${diffStr}</span></div></div>`;
    }
  }

  return html;
}

function buildMovementTooltip(movement) {
  if (!movement) return '';
  const t = new Date(movement.recorded_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const market = movement.market;
  const arrow = movement.delta > 0 ? '▲' : '▼';
  return `<div class="tooltip-header">Line Movement</div>
    <div class="tooltip-row"><span class="tooltip-label">Book</span><span class="tooltip-value">${movement.book}</span></div>
    <div class="tooltip-row"><span class="tooltip-label">From</span><span class="tooltip-value">${formatOddsValue(movement.old_value, market)}</span></div>
    <div class="tooltip-row"><span class="tooltip-label">To</span><span class="tooltip-value">${formatOddsValue(movement.new_value, market)}</span></div>
    <div class="tooltip-row"><span class="tooltip-label">Time</span><span class="tooltip-value">${t}</span></div>
    <div class="tooltip-alert">${arrow} ${Math.abs(movement.delta).toFixed(1)} at ${t}</div>`;
}

function buildPatternTooltip(patternId) {
  let pattern = currentMatrixData.patterns?.find(p => p.id === patternId);
  if (!pattern) pattern = livePatterns.get(patternId);
  if (!pattern) return '';
  const t = new Date(pattern.detectedAt || pattern.detected_at || Date.now()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  let html = `<div class="tooltip-header">${escapeHtml(pattern.type || 'Pattern')}</div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Detected</span><span class="tooltip-value">${t}</span></div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Trigger</span><span class="tooltip-value">${escapeHtml(pattern.triggerBook || pattern.trigger_book || '—')}</span></div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Severity</span><span class="tooltip-value" style="color:${pattern.severity === 'critical' ? 'var(--red)' : pattern.severity === 'warning' ? 'var(--yellow)' : 'var(--green)'}">${escapeHtml(pattern.severity || 'info')}</span></div>`;

  const followedBy = pattern.followedBy || pattern.followed_by || [];
  if (followedBy.length > 0) {
    html += `<div class="tooltip-section"><div class="tooltip-section-title">Followed By</div>`;
    for (const fb of followedBy) {
      const lagMs = fb.lagMs || fb.lag_ms || 0;
      const lag = lagMs > 60000 ? `${(lagMs / 60000).toFixed(1)}m` : `${(lagMs / 1000).toFixed(0)}s`;
      html += `<div class="tooltip-move-row"><span class="tooltip-move-time">${escapeHtml(fb.book || '—')}</span><span class="tooltip-move-val">${formatOddsValue(fb.newValue || fb.new_value, pattern.market || 'moneyline')} (+${lag} lag)</span></div>`;
    }
    html += `</div>`;
  }

  html += `<div class="tooltip-section" style="font-size:10px;color:var(--text-dim);">${escapeHtml(pattern.description || '')}</div>`;
  return html;
}

function buildConsensusTooltip(gameId, market) {
  const game = currentMatrixData.games.find(g => g.id === gameId);
  if (!game) return '';
  const cons = game.consensus?.[market];
  if (!cons) return '';
  const sides = market === 'total' ? ['over', 'under'] : ['away', 'home'];
  let html = `<div class="tooltip-header">Consensus — ${market.charAt(0).toUpperCase() + market.slice(1)}</div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Source</span><span class="tooltip-value">Pinnacle</span></div>`;

  for (const side of sides) {
    const consVal = cons[side];
    const best = game.bestPrices?.[market]?.[side];
    html += `<div class="tooltip-section"><div class="tooltip-section-title">${side.charAt(0).toUpperCase() + side.slice(1)} Side</div>`;
    const consPrice = (market === 'spread' || market === 'total') ? cons[side === 'over' ? 'overPrice' : side === 'under' ? 'underPrice' : side === 'home' ? 'homePrice' : 'awayPrice'] : null;
    html += `<div class="tooltip-row"><span class="tooltip-label">Consensus</span><span class="tooltip-value">${formatOddsValue(consVal, market)}${consPrice != null ? ' (' + formatOddsValue(consPrice, 'moneyline') + ')' : ''}</span></div>`;
    if (best) {
      const diff = best.val - consVal;
      const diffStr = diff >= 0 ? `+${diff.toFixed(1)}c` : `${diff.toFixed(1)}c`;
      html += `<div class="tooltip-row"><span class="tooltip-label">Best Price</span><span class="tooltip-value">${best.book} ${formatOddsValue(best.val, market)}</span></div>`;
      html += `<div class="tooltip-best">Value: ${diffStr} vs consensus</div>`;
    }
    html += `</div>`;
  }

  return html;
}

function buildTimelineTooltip(gameId) {
  const game = currentMatrixData.games.find(g => g.id === gameId);
  if (!game) return '';
  let html = `<div class="tooltip-header">${game.away} @ ${game.home} — Movement Timeline</div>`;
  const movements = currentMatrixData.movements?.filter(m => m.event_id === gameId) || [];
  if (movements.length === 0) {
    html += `<div style="color:var(--text-dim);font-size:10px;">No recent movements</div>`;
    return html;
  }

  movements.sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
  html += `<div class="tooltip-section">`;
  for (const m of movements.slice(0, 8)) {
    const t = new Date(m.recorded_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const arrow = m.delta > 0 ? '▲' : '▼';
    html += `<div class="tooltip-move-row"><span class="tooltip-move-time">${t}</span><span class="tooltip-move-val">${m.book} ${m.market} ${formatOddsValue(m.new_value, m.market)} ${arrow}${Math.abs(m.delta).toFixed(1)}</span></div>`;
  }
  html += `</div>`;
  return html;
}

function getGamePatterns(gameId) {
  const apiPatterns = currentMatrixData.patterns?.filter(p => p.eventId === gameId) || [];
  const wsPatterns = [];
  livePatterns.forEach(p => {
    if (p.eventId === gameId || p.event_id === gameId) wsPatterns.push(p);
  });
  return [...apiPatterns, ...wsPatterns];
}

function renderOddsMatrix() {
  const grid = document.getElementById('oddsGrid');
  const mobile = document.getElementById('oddsGridMobile');
  if (!grid || !mobile) return;

  clearTooltipCache();
  const games = getFilteredGames();
  const visibleBooks = getVisibleBooks();
  const market = matrixState.market;

  if (games.length === 0) {
    grid.innerHTML = '<div class="p-4 text-sm" style="color:var(--text-dim);">No games match the current filters.</div>';
    mobile.innerHTML = '<div class="p-4 text-sm" style="color:var(--text-dim);">No games match.</div>';
    return;
  }

  // Compute best lines per game for highlighting
  const bestAway = findBestBook(games, market, market === 'total' ? 'over' : 'away');
  const bestHome = findBestBook(games, market, market === 'total' ? 'under' : 'home');

  // Desktop matrix
  let html = '<div class="matrix-container"><table class="matrix-table">';
  html += '<thead><tr>';
  html += '<th class="sticky-col text-left" style="min-width:140px;">Game</th>';
  if (matrixState.showConsensus) {
    html += '<th class="sticky-col-2 text-center" style="min-width:80px;">Consensus</th>';
  }
  for (const book of visibleBooks) {
    const status = book.status || currentBookHealth[book.key] || 'unknown';
    const dotColor = status === 'online' ? 'var(--green)' : status === 'offline' ? 'var(--red)' : 'var(--text-dim)';
    html += `<th class="book-header text-center" style="min-width:68px;"><div class="flex items-center justify-center gap-1">${book.key}<span class="health-dot" style="background:${dotColor};"></span></div></th>`;
  }
  html += '</tr></thead><tbody>';

  for (const g of games) {
    const timeStr = g.startTime ? new Date(g.startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
    const isExpanded = matrixState.expandedGame === g.id;
    const patterns = getGamePatterns(g.id);
    const hasRecentMoves = g.recentMovementCount > 0;

    // Main row
    html += `<tr class="cursor-pointer ${hasRecentMoves ? 'pulse-recent' : ''}" onclick="toggleDetailDrawer('${g.id}')">`;

    // Game cell with pattern icons and sparkline
    let patternIcons = '';
    for (const p of patterns) {
      const icon = p.type === 'Steam Move' ? '🔥' : p.type === 'Reverse Line' ? '🚨' : '⚠️';
      const ptId = cacheTooltip(buildPatternTooltip(p.id));
      patternIcons += `<span class="pattern-icon" onclick="event.stopPropagation();" data-pt="${ptId}" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.pt))" onmouseleave="hideTooltip()">${icon}</span>`;
    }
    const tlId = cacheTooltip(buildTimelineTooltip(g.id));
    patternIcons += `<span class="sparkline-icon" onclick="event.stopPropagation();" data-tt="${tlId}" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.tt))" onmouseleave="hideTooltip()">📊</span>`;

    html += `<td class="sticky-col"><div class="font-bold text-xs">${g.away} @ ${g.home} ${patternIcons}</div><div class="text-[10px]" style="color:var(--text-dim);">${g.sport} • ${timeStr}</div></td>`;

    if (matrixState.showConsensus) {
      const cons = g.consensus?.[market];
      const awayVal = cons ? (market === 'total' ? cons.over : cons.away) : null;
      const homeVal = cons ? (market === 'total' ? cons.under : cons.home) : null;
      const awayPrice = cons ? (market === 'total' ? cons.overPrice : cons.awayPrice) : null;
      const homePrice = cons ? (market === 'total' ? cons.underPrice : cons.homePrice) : null;
      const ctId = cacheTooltip(buildConsensusTooltip(g.id, market));
      html += `<td class="sticky-col-2 consensus-cell text-center" data-tt="${ctId}" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.tt))" onmouseleave="hideTooltip()">${formatOddsCell(awayVal, homeVal, market, awayPrice, homePrice)}</td>`;
    }

    for (const book of visibleBooks) {
      const bookData = g.books[book.key];
      const val = bookData?.[market];
      const awayVal = val ? (market === 'total' ? val.over : val.away) : null;
      const homeVal = val ? (market === 'total' ? val.under : val.home) : null;
      const awayPrice = (market === 'spread' || market === 'total') && val ? (market === 'total' ? val.overPrice : val.awayPrice) : null;
      const homePrice = (market === 'spread' || market === 'total') && val ? (market === 'total' ? val.underPrice : val.homePrice) : null;
      const isBestAway = bestAway[g.id] === book.key;
      const isBestHome = bestHome[g.id] === book.key;
      const isBest = (isBestAway || isBestHome) && (awayVal !== null || homeVal !== null);
      const status = book.status || currentBookHealth[book.key] || 'unknown';
      const offlineClass = status === 'offline' ? 'offline-book' : '';

      // Movement indicator
      const awaySide = market === 'total' ? 'over' : 'away';
      const homeSide = market === 'total' ? 'under' : 'home';
      const movAway = getMovement(g.id, book.key, market, awaySide);
      const movHome = getMovement(g.id, book.key, market, homeSide);
      const movAwayHtml = movAway ? `<span class="movement-arrow movement-up" data-tt="${cacheTooltip(buildMovementTooltip(movAway))}" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.tt))" onmouseleave="hideTooltip()">▲${Math.abs(movAway.delta).toFixed(1)}</span>` : '<span class="movement-none">—</span>';
      const movHomeHtml = movHome ? `<span class="movement-arrow movement-down" data-tt="${cacheTooltip(buildMovementTooltip(movHome))}" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.tt))" onmouseleave="hideTooltip()">▼${Math.abs(movHome.delta).toFixed(1)}</span>` : '<span class="movement-none">—</span>';

      // Tooltip data for the whole cell
      const cellTooltipAway = buildOddsCellTooltip(g.id, book.key, market, awaySide);
      const ttId = cacheTooltip(cellTooltipAway);

      const awayPriceStr = awayPrice != null ? ` <span style="color:var(--text-dim);font-size:10px;">(${formatOddsValue(awayPrice, 'moneyline')})</span>` : '';
      const homePriceStr = homePrice != null ? ` <span style="color:var(--text-dim);font-size:10px;">(${formatOddsValue(homePrice, 'moneyline')})</span>` : '';

      html += `<td class="text-center ${isBest ? 'best-line' : ''} ${offlineClass}" data-tt="${ttId}" onclick="event.stopPropagation();openTradeModal('${g.away} @ ${g.home}','${book.key}',${awayVal ?? 0})" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.tt))" onmouseleave="hideTooltip()">`;
      html += `<div class="odds-price">${formatOddsValue(awayVal, market)}${awayPriceStr} ${movAwayHtml}</div>`;
      html += `<div class="odds-juice">${formatOddsValue(homeVal, market)}${homePriceStr} ${movHomeHtml}</div>`;
      html += `</td>`;
    }
    html += '</tr>';

    // Detail drawer row
    html += `<tr><td colspan="${visibleBooks.length + (matrixState.showConsensus ? 2 : 1)}" style="padding:0;border:0;">`;
    html += `<div id="drawer-${g.id}" class="detail-drawer ${isExpanded ? 'open' : ''}">`;
    html += renderDetailDrawer(g);
    html += '</div></td></tr>';
  }

  html += '</tbody></table></div>';
  grid.innerHTML = html;

  // Mobile card view
  renderOddsMatrixMobile(games, visibleBooks, bestAway, bestHome, market);
}

function renderOddsMatrixMobile(games, visibleBooks, bestAway, bestHome, market) {
  const mobile = document.getElementById('oddsGridMobile');
  if (!mobile) return;

  mobile.innerHTML = games.map(g => {
    const timeStr = g.startTime ? new Date(g.startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
    const isExpanded = matrixState.expandedGame === g.id;

    let booksHtml = visibleBooks.map(book => {
      const bookData = g.books[book.key];
      const val = bookData?.[market];
      const awayVal = val ? (market === 'total' ? val.over : val.away) : null;
      const awayPrice = (market === 'spread' || market === 'total') && val ? (market === 'total' ? val.overPrice : val.awayPrice) : null;
      const isBest = bestAway[g.id] === book.key || bestHome[g.id] === book.key;
      const activeClass = isBest ? 'active' : '';
      const priceStr = awayPrice != null ? ` (${formatOddsValue(awayPrice, 'moneyline')})` : '';
      return `<button class="book-pill ${activeClass}" onclick="event.stopPropagation();openTradeModal('${g.away} @ ${g.home}','${book.key}',${awayVal ?? 0})">${book.key}<br><span class="text-[10px]">${formatOddsValue(awayVal, market)}${priceStr}</span></button>`;
    }).join('');

    return `<div class="game-card" onclick="toggleDetailDrawer('${g.id}')">
      <div class="game-card-header">
        <div><div class="font-bold text-xs">${g.away} @ ${g.home}</div><div class="text-[10px]" style="color:var(--text-dim);">${g.sport} • ${timeStr}</div></div>
        <div class="text-xs" style="color:var(--accent);" onclick="event.stopPropagation();openConsensusModal('${g.id}')">Consensus</div>
      </div>
      <div class="flex flex-wrap gap-1">${booksHtml}</div>
      ${isExpanded ? `<div class="mt-2 pt-2 border-t" style="border-color:var(--border);">${renderDetailDrawer(g)}</div>` : ''}
    </div>`;
  }).join('');
}

function renderDetailDrawer(g) {
  const cons = g.consensus;
  let html = `<div class="p-3">`;
  html += `<div class="flex items-center justify-between mb-2"><span class="text-xs font-bold">${g.away} @ ${g.home}</span><span class="text-[10px]" style="color:var(--text-dim);">${g.sport} • ${g.league || ''}</span></div>`;
  html += `<div class="grid grid-cols-3 gap-2 mb-2">`;
  html += `<div class="rounded p-2" style="background:var(--panel);border:1px solid var(--border);"><div class="text-[10px]" style="color:var(--text-dim);">Spread</div><div class="text-xs font-mono">${cons?.spread?.away ?? '—'}${cons?.spread?.awayPrice != null ? ' (' + formatOddsValue(cons.spread.awayPrice, 'moneyline') + ')' : ''} / ${cons?.spread?.home ?? '—'}${cons?.spread?.homePrice != null ? ' (' + formatOddsValue(cons.spread.homePrice, 'moneyline') + ')' : ''}</div></div>`;
  html += `<div class="rounded p-2" style="background:var(--panel);border:1px solid var(--border);"><div class="text-[10px]" style="color:var(--text-dim);">Moneyline</div><div class="text-xs font-mono">${cons?.moneyline?.away ?? '—'} / ${cons?.moneyline?.home ?? '—'}</div></div>`;
  html += `<div class="rounded p-2" style="background:var(--panel);border:1px solid var(--border);"><div class="text-[10px]" style="color:var(--text-dim);">Total</div><div class="text-xs font-mono">${cons?.total?.over ?? '—'}${cons?.total?.overPrice != null ? ' (' + formatOddsValue(cons.total.overPrice, 'moneyline') + ')' : ''} / ${cons?.total?.under ?? '—'}${cons?.total?.underPrice != null ? ' (' + formatOddsValue(cons.total.underPrice, 'moneyline') + ')' : ''}</div></div>`;
  html += `</div>`;
  html += `<div class="flex gap-2">`;
  html += `<button class="flex-1 py-1.5 rounded text-xs font-medium" style="background:var(--accent);color:#fff;" onclick="openTradeModal('${g.away}','PIN',${cons?.moneyline?.away ?? 0})">Bet ${g.away}</button>`;
  html += `<button class="flex-1 py-1.5 rounded text-xs font-medium" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" onclick="openConsensusModal('${g.id}')">Compare Lines</button>`;
  html += `</div>`;
  html += `</div>`;
  return html;
}

function toggleDetailDrawer(gameId) {
  if (matrixState.expandedGame === gameId) {
    matrixState.expandedGame = null;
  } else {
    matrixState.expandedGame = gameId;
  }
  renderOddsMatrix();
}

function filterBySport(sport, btn) {
  matrixState.sport = sport;
  document.querySelectorAll('.sport-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadOddsData(true);
}

function searchGames(q) {
  matrixState.search = q.trim();
  scheduleTask('gameSearch', renderOddsMatrix, 100);
}

function sortGames(val) {
  matrixState.sort = val;
  renderOddsMatrix();
}

function setMarketTab(btn, market) {
  matrixState.market = market;
  document.querySelectorAll('.market-tab').forEach(b => {
    b.style.background = 'var(--panel)';
    b.style.color = 'var(--text-dim)';
    b.classList.remove('active');
  });
  btn.style.background = 'var(--accent)';
  btn.style.color = '#fff';
  btn.classList.add('active');
  renderOddsMatrix();
}

// Book Settings Modal
function openBookSettings() {
  renderBookSettingsList();
  const modal = document.getElementById('bookSettingsModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeBookSettings() {
  const modal = document.getElementById('bookSettingsModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function renderBookSettingsList() {
  const container = document.getElementById('bookSettingsList');
  const allBooks = bookPreferences.order.length > 0 ? bookPreferences.order : DEFAULT_BOOK_ORDER;
  container.innerHTML = allBooks.map((book, idx) => {
    const isVisible = bookPreferences.visible.includes(book);
    return `<div class="book-list-item" draggable="true" ondragstart="bookDragStart(event,'${book}')" ondragover="bookDragOver(event)" ondrop="bookDrop(event,'${book}')">
      <span class="book-drag-handle">≡</span>
      <input type="checkbox" ${isVisible ? 'checked' : ''} onchange="toggleBookVisibility('${book}',this.checked)" class="accent-orange-500">
      <span class="text-xs font-medium">${book}</span>
      <span class="text-[10px] ml-auto" style="color:var(--text-dim);">${idx + 1}</span>
    </div>`;
  }).join('');
}

let draggedBook = null;
function bookDragStart(e, book) { draggedBook = book; e.dataTransfer.effectAllowed = 'move'; }
function bookDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
function bookDrop(e, targetBook) {
  e.preventDefault();
  if (!draggedBook || draggedBook === targetBook) return;
  const order = [...bookPreferences.order];
  const from = order.indexOf(draggedBook);
  const to = order.indexOf(targetBook);
  if (from === -1 || to === -1) return;
  order.splice(from, 1);
  order.splice(to, 0, draggedBook);
  bookPreferences.order = order;
  renderBookSettingsList();
}

function toggleBookVisibility(book, visible) {
  if (visible) {
    if (!bookPreferences.visible.includes(book)) bookPreferences.visible.push(book);
  } else {
    bookPreferences.visible = bookPreferences.visible.filter(b => b !== book);
  }
}

function saveBookSettings() {
  saveBookPreferences(bookPreferences);
  closeBookSettings();
  loadOddsData(true);
  showToast('Book preferences saved', 'success');
}

function resetBookSettings() {
  bookPreferences = { order: [...DEFAULT_BOOK_ORDER], visible: ['PIN','BOL','BOV','BUC','ACE','MET'] };
  renderBookSettingsList();
}

// Consensus Modal
function openConsensusModal(gameId) {
  const g = currentMatrixData.games.find(x => x.id === gameId);
  if (!g) return;
  document.getElementById('consensusModalTitle').textContent = `${g.away} @ ${g.home} — Consensus`;
  const cons = g.consensus;
  const markets = ['spread','moneyline','total'];
  let html = '<table class="w-full text-xs"><thead><tr style="background:var(--bg);"><th class="text-left px-2 py-1">Book</th><th class="text-center px-2 py-1">Spread</th><th class="text-center px-2 py-1">ML</th><th class="text-center px-2 py-1">Total</th><th class="text-center px-2 py-1">Last Move</th></tr></thead><tbody>';

  // Consensus row
  html += `<tr style="border-bottom:1px solid var(--accent);"><td class="px-2 py-1 font-bold" style="color:var(--accent);">Consensus</td>`;
  html += `<td class="text-center px-2 py-1">${formatOddsValue(cons?.spread?.away, 'spread')} / ${formatOddsValue(cons?.spread?.home, 'spread')}</td>`;
  html += `<td class="text-center px-2 py-1">${formatOddsValue(cons?.moneyline?.away, 'moneyline')} / ${formatOddsValue(cons?.moneyline?.home, 'moneyline')}</td>`;
  html += `<td class="text-center px-2 py-1">${formatOddsValue(cons?.total?.over, 'total')} / ${formatOddsValue(cons?.total?.under, 'total')}</td>`;
  html += `<td class="text-center px-2 py-1" style="color:var(--text-dim);">${formatLastMovement(getLastMovementForGame(g.id))}</td>`;
  html += '</tr>';

  const visibleBooks = getVisibleBooks();
  for (const book of visibleBooks) {
    const b = g.books[book.key];
    const lastMove = getLastMovementForBook(g.id, book.key);
    html += `<tr class="border-b" style="border-color:var(--border);"><td class="px-2 py-1">${book.key}</td>`;
    html += `<td class="text-center px-2 py-1">${b?.spread ? formatOddsValue(b.spread.away, 'spread') + ' / ' + formatOddsValue(b.spread.home, 'spread') : '—'}</td>`;
    html += `<td class="text-center px-2 py-1">${b?.moneyline ? formatOddsValue(b.moneyline.away, 'moneyline') + ' / ' + formatOddsValue(b.moneyline.home, 'moneyline') : '—'}</td>`;
    html += `<td class="text-center px-2 py-1">${b?.total ? formatOddsValue(b.total.over, 'total') + ' / ' + formatOddsValue(b.total.under, 'total') : '—'}</td>`;
    html += `<td class="text-center px-2 py-1" style="color:var(--text-dim);">${formatLastMovement(lastMove)}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('consensusModalContent').innerHTML = html;
  const modal = document.getElementById('consensusModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function getLastMovementForBook(gameId, bookKey) {
  return (currentMatrixData.movements || [])
    .filter(m => m.event_id === gameId && m.book === bookKey)
    .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0] || null;
}

function getLastMovementForGame(gameId) {
  return (currentMatrixData.movements || [])
    .filter(m => m.event_id === gameId)
    .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0] || null;
}

function formatLastMovement(move) {
  if (!move?.recorded_at) return '—';
  const t = new Date(move.recorded_at);
  const time = t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const delta = move.delta != null ? ` ${move.delta > 0 ? '+' : ''}${Number(move.delta).toFixed(1)}` : '';
  return `${time}${delta}`;
}

function closeConsensusModal() {
  const modal = document.getElementById('consensusModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

// Poll odds every 30s
setInterval(() => {
  if (currentSection === 'floor') {
    loadOddsData(true);
  }
}, 30000);

// ==================== POSITIONS ====================
function updatePositionStats(wagers = [], sportRows = [], agentRows = {}) {
  setText('posTotalWagers', String(wagers.length || 0));
  setText('posTotalExposure', '$0');
  setText('posActiveAgents', String(Array.isArray(agentRows) ? agentRows.length : Object.keys(agentRows || {}).length));
  setText('posAvgWager', '$0');
  setText('posTopSport', sportRows[0]?.sport || '—');
}

function renderPositions() {
  const tbody = document.getElementById('positionsTable');
  if (!tbody) return;

  if (buckeyeWagers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">No positions. Connect to Buckeye to see live positions.</td></tr>';
    updatePositionStats([], [], {});
    return;
  }

  // Use top 50 recent wagers as "positions"
  const recent = [...buckeyeWagers].sort((a, b) => new Date(b.InsertDateTime) - new Date(a.InsertDateTime)).slice(0, 50);

  tbody.innerHTML = recent.map(w => {
    const typeInfo = WAGER_TYPES[detectWagerType(w)] || { label: w.WagerType, color: '#6b7280' };
    const game = parseGame(w.ShortDesc);
    const sport = parseSport(w.ShortDesc);
    const price = extractPrice(w.ShortDesc);
    const priceDisplay = price ? `<span class="font-mono">${price}</span>` : '—';
    const isAlert = w.TicketWriter === 'ALERT';
    const isLive = w.TicketWriter === 'GSLIVE';
    const sourceBadge = isAlert ? '<span class="px-1 py-0.5 rounded text-xs" style="background:var(--red);color:#fff;">ALERT</span>' : isLive ? '<span class="px-1 py-0.5 rounded text-xs" style="background:var(--cyan);color:#fff;">LIVE</span>' : '<span class="px-1 py-0.5 rounded text-xs" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">Net</span>';

    return `<tr class="border-b" style="border-color:var(--border);">
      <td class="px-3 py-2 font-medium" style="color:var(--accent);">${w.Login}</td>
      <td class="px-3 py-2">${w.AgentLogin}</td>
      <td class="px-3 py-2" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${game}</td>
      <td class="px-3 py-2 text-center"><span class="px-1.5 py-0.5 rounded text-xs font-bold" style="background:${typeInfo.color}22;color:${typeInfo.color};">${typeInfo.label}</span></td>
      <td class="px-3 py-2 text-right font-mono">$${(w.AmountWagered || 0).toLocaleString()}</td>
      <td class="px-3 py-2 text-center">${priceDisplay}</td>
      <td class="px-3 py-2 text-center"><span class="px-1.5 py-0.5 rounded text-xs" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">${sport}</span></td>
      <td class="px-3 py-2 text-center">${sourceBadge}</td>
    </tr>`;
  }).join('');

  // Calculate stats
  const totalExposure = recent.reduce((s, w) => s + getHeldRisk(w), 0);
  const totalWagers = recent.length;
  const avgWager = totalWagers > 0 ? totalExposure / totalWagers : 0;

  // Agent breakdown
  const agentMap = {};
  recent.forEach(w => {
    const a = w.AgentLogin;
    if (!agentMap[a]) agentMap[a] = { volume: 0, count: 0, players: new Set() };
    agentMap[a].volume += getHeldRisk(w);
    agentMap[a].count++;
    agentMap[a].players.add(w.Login);
  });

  // Sport breakdown
  const sportMap = {};
  recent.forEach(w => {
    const s = parseSport(w.ShortDesc);
    if (!sportMap[s]) sportMap[s] = { volume: 0, count: 0 };
    sportMap[s].volume += getHeldRisk(w);
    sportMap[s].count++;
  });

  // Update stats cards
  document.getElementById('posTotalWagers').textContent = totalWagers.toLocaleString();
  document.getElementById('posTotalExposure').textContent = '$' + totalExposure.toLocaleString();
  document.getElementById('posActiveAgents').textContent = Object.keys(agentMap).length;
  document.getElementById('posAvgWager').textContent = '$' + Math.round(avgWager).toLocaleString();

  const topSport = Object.entries(sportMap).sort((a, b) => b[1].volume - a[1].volume)[0];
  document.getElementById('posTopSport').textContent = topSport ? topSport[0] : '—';

  // Ensure exposure data is computed if empty, then render
  if (sportExposureData.length === 0) computeSportExposureLocal();
  if (agentExposureData.length === 0) computeAgentExposureLocal();
  renderAgentExposure();
  renderSportExposure();
}

// ==================== EXPOSURE PANELS (Positions Tab) ====================
function renderSportExposure() {
  const container = document.getElementById('sportExposureBreakdown');
  if (!container) return;

  if (sportExposureData.length === 0) {
    computeSportExposureLocal();
  }
  if (sportExposureData.length === 0) {
    container.innerHTML = '<div class="text-xs text-center py-4" style="color:var(--text-dim);">No exposure data</div>';
    return;
  }

  const maxTotal = sportExposureData[0].total || 1;
  const sortKey = sportExposureSort.col;
  const sortDir = sportExposureSort.dir;

  const sorted = [...sportExposureData].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir === 'asc' ? av - bv : bv - av;
    }
    return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });

  container.innerHTML = `
    <table class="exposure-table">
      <thead>
        <tr>
          <th onclick="sortSportExposure('sport')" data-sort="sport">Sport ${sortKey === 'sport' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
          <th onclick="sortSportExposure('total')" data-sort="total" class="text-right">Total ${sortKey === 'total' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
          <th onclick="sortSportExposure('pct')" data-sort="pct" class="text-right">% ${sortKey === 'pct' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
          <th onclick="sortSportExposure('live')" data-sort="live" class="text-center">Live ${sortKey === 'live' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
          <th>Top Game</th>
          <th>Side</th>
          <th class="text-center">Price</th>
          <th onclick="sortSportExposure('gameTotal')" data-sort="gameTotal" class="text-right">Game $ ${sortKey === 'gameTotal' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(row => {
          const barPct = Math.min(100, (row.total / maxTotal * 100)).toFixed(0);
          const color = row.pct > 30 ? 'var(--red)' : row.pct > 15 ? 'var(--yellow)' : 'var(--green)';
          return `<tr>
            <td class="font-medium">${row.sport}</td>
            <td class="text-right">
              <div class="exposure-bar" style="width:120px;display:inline-block;vertical-align:middle;margin-right:6px;">
                <div class="exposure-bar-fill" style="width:${barPct}%;background:${color};"></div>
                <div class="exposure-bar-label">$${(row.total/1000).toFixed(1)}K</div>
              </div>
            </td>
            <td class="text-right font-mono" style="color:var(--text-dim);">${row.pct}%</td>
            <td class="text-center">${row.live > 0 ? `<span class="px-1.5 py-0.5 rounded text-xs" style="background:var(--cyan);color:#fff;">${row.live}</span>` : '—'}</td>
            <td class="truncate" style="max-width:140px;" title="${row.topGame}">${row.topGame || '—'}</td>
            <td class="truncate" style="max-width:100px;" title="${row.side}">${row.side || '—'}</td>
            <td class="text-center font-mono" style="color:var(--accent);">${row.price || '—'}</td>
            <td class="text-right font-mono">$${(row.gameTotal || 0).toLocaleString()}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function sortSportExposure(col) {
  if (sportExposureSort.col === col) {
    sportExposureSort.dir = sportExposureSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sportExposureSort.col = col;
    sportExposureSort.dir = 'desc';
  }
  renderSportExposure();
}

function renderAgentExposure() {
  const container = document.getElementById('agentExposureBreakdown');
  if (!container) return;

  if (agentExposureData.length === 0) {
    computeAgentExposureLocal();
  }
  if (agentExposureData.length === 0) {
    container.innerHTML = '<div class="text-xs text-center py-4" style="color:var(--text-dim);">No exposure data</div>';
    return;
  }

  const maxTotal = agentExposureData[0].total || 1;
  const sortKey = agentExposureSort.col;
  const sortDir = agentExposureSort.dir;

  const sorted = [...agentExposureData].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir === 'asc' ? av - bv : bv - av;
    }
    return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  }).slice(0, 10);

  container.innerHTML = `
    <table class="exposure-table">
      <thead>
        <tr>
          <th onclick="sortAgentExposure('agent')" data-sort="agent">Agent ${sortKey === 'agent' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
          <th onclick="sortAgentExposure('total')" data-sort="total" class="text-right">Total ${sortKey === 'total' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
          <th onclick="sortAgentExposure('pct')" data-sort="pct" class="text-right">% ${sortKey === 'pct' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
          <th onclick="sortAgentExposure('live')" data-sort="live" class="text-center">Live ${sortKey === 'live' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
          <th>Top Customer</th>
          <th onclick="sortAgentExposure('topCustomerVol')" data-sort="topCustomerVol" class="text-right">Cust. $ ${sortKey === 'topCustomerVol' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
          <th>Top Game</th>
          <th onclick="sortAgentExposure('topGameVol')" data-sort="topGameVol" class="text-right">Game $ ${sortKey === 'topGameVol' ? (sortDir === 'asc' ? '↑' : '↓') : ''}</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(row => {
          const barPct = Math.min(100, (row.total / maxTotal * 100)).toFixed(0);
          const color = parseFloat(row.pct) > 30 ? 'var(--red)' : parseFloat(row.pct) > 15 ? 'var(--yellow)' : 'var(--green)';
          return `<tr>
            <td class="font-medium">${row.agent}</td>
            <td class="text-right">
              <div class="exposure-bar" style="width:100px;display:inline-block;vertical-align:middle;margin-right:6px;">
                <div class="exposure-bar-fill" style="width:${barPct}%;background:${color};"></div>
                <div class="exposure-bar-label">$${(row.total/1000).toFixed(1)}K</div>
              </div>
            </td>
            <td class="text-right font-mono" style="color:var(--text-dim);">${row.pct}%</td>
            <td class="text-center">${row.live > 0 ? `<span class="px-1.5 py-0.5 rounded text-xs" style="background:var(--cyan);color:#fff;">${row.live}</span>` : '—'}</td>
            <td class="truncate" style="max-width:100px;" title="${row.topCustomer}">${row.topCustomer || '—'}</td>
            <td class="text-right font-mono">$${(row.topCustomerVol || 0).toLocaleString()}</td>
            <td class="truncate" style="max-width:120px;" title="${row.topGame}">${row.topGame || '—'}</td>
            <td class="text-right font-mono">$${(row.topGameVol || 0).toLocaleString()}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function sortAgentExposure(col) {
  if (agentExposureSort.col === col) {
    agentExposureSort.dir = agentExposureSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    agentExposureSort.col = col;
    agentExposureSort.dir = 'desc';
  }
  renderAgentExposure();
}

// ==================== MODALS & UTILS ====================
function openTradeModal(selection, book, odds) {
  const modal = document.getElementById('tradeModal');
  const content = document.getElementById('tradeModalContent');
  content.innerHTML = `
    <div class="space-y-3">
      <div class="flex justify-between text-sm"><span>Selection:</span><span class="font-bold">${selection}</span></div>
      <div class="flex justify-between text-sm"><span>Book:</span><span class="font-bold">${book}</span></div>
      <div class="flex justify-between text-sm"><span>Odds:</span><span class="font-bold">${odds > 0 ? '+' : ''}${odds}</span></div>
      <div><label class="text-xs" style="color:var(--text-dim);">Stake ($)</label><input type="number" id="stakeInput" value="100" class="w-full mt-1 text-sm px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);"></div>
      <div class="flex gap-2"><button class="flex-1 py-2 rounded-lg text-sm font-medium" style="background:var(--accent);color:#fff;" onclick="executeTrade('${selection}','${book}',${odds})">Execute</button><button class="flex-1 py-2 rounded-lg text-sm" style="background:var(--panel);border:1px solid var(--border);color:var(--text);" onclick="closeTradeModal()">Cancel</button></div>
    </div>`;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeTradeModal() {
  const modal = document.getElementById('tradeModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function executeTrade(selection, book, odds) {
  const stake = parseFloat(document.getElementById('stakeInput').value) || 100;
  showToast(`Trade executed: ${selection} @ ${book} for $${stake}`, 'success');
  closeTradeModal();
}

function toggleAuthModal() {
  const modal = document.getElementById('authModal');
  const content = document.getElementById('authModalContent');
  const savedAgent = localStorage.getItem('agentId') || '';
  content.innerHTML = `
    <div class="space-y-3">
      <div><label class="text-xs" style="color:var(--text-dim);">Agent ID</label><input id="modalAgentId" type="text" value="${escapeHtml(savedAgent)}" class="w-full mt-1 text-sm px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" placeholder="Enter agent ID"></div>
      <div><label class="text-xs" style="color:var(--text-dim);">Password</label><input id="modalPassword" type="password" value="" class="w-full mt-1 text-sm px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" placeholder="Enter password"></div>
      <div><label class="text-xs" style="color:var(--text-dim);">Cloudflare Cookie (optional)</label><input id="modalCfCookie" type="text" value="" class="w-full mt-1 text-sm px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" placeholder="Paste cf_clearance"></div>
      <button class="w-full py-2 rounded-lg text-sm font-medium" style="background:var(--accent);color:#fff;" onclick="modalSignIn()">Connect to Buckeye</button>
      <button class="w-full py-2 rounded-lg text-sm font-medium" style="background:var(--panel);border:1px solid var(--border);color:var(--text);" onclick="openBuckeyeForCookie()">Open Buckeye to Get Cookie</button>
    </div>`;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function modalSignIn() {
  const agentId = document.getElementById('modalAgentId').value.trim();
  const password = document.getElementById('modalPassword').value;
  const cfCookie = document.getElementById('modalCfCookie')?.value?.trim() || '';
  if (!agentId || !password) {
    showToast('Please enter both Agent ID and Password', 'error');
    return;
  }
  closeAuthModal();
  saveAndConnect(agentId, password, null, cfCookie);
}

function openBuckeyeForCookie() {
  window.open('https://fantasy402.com/index.php', '_blank');
  showToast('Log into Buckeye in the new tab, then copy cf_clearance from DevTools > Application > Cookies', 'info');
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function showToast(message, type = 'info') {
  if (localStorage.getItem('toastsEnabled') === 'false') return;
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  const colors = { success: 'var(--green)', error: 'var(--red)', warning: 'var(--yellow)', info: 'var(--blue)' };
  toast.className = 'toast pointer-events-auto px-4 py-3 rounded-lg border text-sm flex items-center gap-2';
  toast.style.cssText = `background:var(--panel);border-color:${colors[type] || colors.info};color:var(--text);`;
  toast.innerHTML = `<div class="w-2 h-2 rounded-full" style="background:${colors[type] || colors.info};"></div><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function refreshData() {
  showToast('Data refreshed', 'success');
  sectionCache.odds.at = 0;
  sectionCache.exposure.at = 0;
  loadOddsData(true);
  scheduleRender('all');
  fetchExposureData(true);
  if (currentSection === 'performance') loadPerformancePage(true);
}

function exportWagers() {
  const csv = buckeyeWagers.map(w => `${w.WagerNumber},${w.Login},${w.AgentLogin},${w.WagerType},${w.AmountWagered},${w.VolumeAmount},${w.TicketWriter},${w.InsertDateTime}`).join('\n');
  const blob = new Blob(['WagerNumber,Login,Agent,Type,Wagered,Volume,Source,Time\n' + csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'buckeye_wagers.csv';
  a.click();
  showToast('Wagers exported to CSV', 'success');
}

function exportPositions() {
  showToast('Positions exported', 'success');
}

function closePosition(game) {
  showToast(`Position closed: ${game}`, 'info');
}

function connectBuckeye() {
  showBuckeyeSettings();
  showToast('Enter credentials once; the backend stores them in the OS vault after login.', 'info');
}

function disconnectBuckeye() {
  if (wsClient.ws) {
    wsClient.ws.close();
  }
  updateConnectionStatus('disconnected');
  showToast('Disconnected from Buckeye', 'info');
}

function resyncBuckeye() {
  if (wsClient.isAuthenticated) {
    wsClient.send({ type: 'refresh', agentId: wsClient.agentId });
    showToast('Resyncing with Buckeye...', 'info');
  } else {
    showToast('Not connected — connect first', 'warning');
  }
}

function showBuckeyeSettings() {
  switchSection('settings', getSidebarButton('settings'));
}

function saveSettings() {
  const agentId = document.getElementById('settingsAgentId').value.trim();
  const password = document.getElementById('settingsPassword').value;
  const baseUrl = document.getElementById('settingsBaseUrl').value.trim();
  const cfCookie = document.getElementById('settingsCfCookie').value.trim();
  const retainedRisk = getRetainedRiskPercent();

  if (!agentId || !password) {
    showToast('Agent ID and Password are required', 'error');
    return;
  }

  localStorage.setItem('agentId', agentId);
  localStorage.setItem('baseUrl', baseUrl);
  localStorage.removeItem('password');
  localStorage.removeItem('cfCookie');
  localStorage.setItem('retainedRiskPercent', String(retainedRisk));
  computeSportExposureLocal();
  computeAgentExposureLocal();
  renderPositions();

  saveAndConnect(agentId, password, baseUrl, cfCookie);
}

function getDefaultWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host || 'localhost:3000';
  return `${protocol}//${host}/ws`;
}

function getApiBaseUrl() {
  if (window.location.protocol === 'file:') {
    return 'http://localhost:3000';
  }
  return `${window.location.protocol}//${window.location.host}`;
}

async function refreshVaultStatus() {
  const el = document.getElementById('vaultStatusText');
  const listEl = document.getElementById('vaultAgentList');
  if (!el) return;
  try {
    const url = new URL(`${getApiBaseUrl()}/api/buckeye/vault-status`);
    const res = await fetch(url);
    const status = await res.json();
    if (listEl) listEl.innerHTML = '';
    if (!status.available) {
      el.textContent = 'OS vault unavailable';
      el.style.color = 'var(--yellow)';
      updateBuckeyeStatusBadge('warning', 'Vault Unavailable');
      return;
    }
    const agents = Array.isArray(status.agents) ? status.agents : (status.agentId ? [status] : []);
    if (!agents.length) {
      el.textContent = 'No Buckeye secrets stored';
      el.style.color = 'var(--text-dim)';
      updateBuckeyeStatusBadge(buckeyeWagers.length ? 'archive' : 'disconnected', buckeyeWagers.length ? `${buckeyeWagers.length.toLocaleString()} Latest` : 'No Vault');
      return;
    }
    const activeCount = agents.filter(agent => agent.active).length;
    const readyCount = agents.filter(agent => agent.hasToken || (agent.hasPassword && agent.hasCfCookie)).length;
    window.backendLiveAgents = activeCount;
    window.backendVaultReadyAgents = readyCount;
    el.textContent = `${agents.length} vaulted agent${agents.length === 1 ? '' : 's'} | ${activeCount} ingesting`;
    el.style.color = activeCount ? 'var(--green)' : 'var(--yellow)';
    if (activeCount) {
      updateBuckeyeStatusBadge('connected', `${activeCount} Agent${activeCount === 1 ? '' : 's'} Live`);
    } else if (readyCount) {
      updateBuckeyeStatusBadge('ready', `${readyCount} Vault Ready`);
    } else {
      updateBuckeyeStatusBadge('warning', 'Vault Needs Cookie');
    }
    if (listEl) {
      listEl.innerHTML = agents.map(agent => {
        const flags = [
          agent.hasPassword ? 'password' : null,
          agent.hasCfCookie ? 'cookie' : null,
          agent.hasToken ? 'token' : null,
          agent.active ? 'active' : null,
        ].filter(Boolean);
        const flagText = flags.length ? flags.join(' + ') : 'no usable secrets';
        const color = agent.active ? 'var(--green)' : (flags.length ? 'var(--yellow)' : 'var(--text-dim)');
        const error = agent.lastError ? `<span style="color:var(--red);"> | ${escapeHtml(agent.lastError)}</span>` : '';
        return `<div class="flex items-center justify-between gap-2 rounded px-2 py-1" style="background:var(--panel);border:1px solid var(--border);">
          <span class="font-mono" style="color:var(--text);">${escapeHtml(agent.agentId || 'Unknown')}</span>
          <span style="color:${color};">${escapeHtml(flagText)}${error}</span>
        </div>`;
      }).join('');
    }
  } catch {
    el.textContent = 'Vault status unavailable';
    el.style.color = 'var(--yellow)';
    if (listEl) listEl.innerHTML = '';
  }
}

async function logoutBuckeyeVault() {
  const agentId = document.getElementById('settingsAgentId')?.value?.trim() || localStorage.getItem('agentId') || '';
  if (!agentId) {
    showToast('Select an agent before logging out of the vault', 'warning');
    return;
  }
  try {
    const url = new URL(`${getApiBaseUrl()}/api/buckeye/vault-status`);
    url.searchParams.set('agentId', agentId);
    await fetch(url, { method: 'DELETE' });
    if (wsClient?.ws) wsClient.ws.close();
    localStorage.removeItem('buckeyeToken');
    localStorage.removeItem('lastAuthTime');
    updateConnectionStatus('disconnected');
    await refreshVaultStatus();
    showToast(`Buckeye vault credentials cleared for ${agentId}`, 'success');
  } catch {
    showToast('Could not clear Buckeye vault credentials', 'error');
  }
}

async function testConnection() {
  const agentId = document.getElementById('settingsAgentId').value.trim();
  const password = document.getElementById('settingsPassword').value;
  const baseUrl = document.getElementById('settingsBaseUrl').value.trim();

  if (!agentId || !password) {
    showToast('Agent ID and Password are required', 'error');
    return;
  }

  showToast('Testing login to fantasy402.com...', 'info');
  updateConnectionStatus('testing');

  try {
    const res = await fetch(`${getApiBaseUrl()}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, password, baseUrl }),
    });
    const data = await res.json();
    if (data.success) {
      if (data.token) localStorage.setItem('apiToken', data.token);
      showToast(`Login OK — ${data.wagerCount} wagers on site`, 'success');
      updateConnectionStatus('ready');
    } else {
      showToast(data.error || 'Login failed', 'error');
      updateConnectionStatus('disconnected');
    }
  } catch (err) {
    showToast('Backend unreachable — is the server running?', 'error');
    updateConnectionStatus('disconnected');
  }
}

function saveAndConnect(agentId, password, baseUrl, cfCookie) {
  localStorage.setItem('agentId', agentId);
  if (baseUrl) localStorage.setItem('baseUrl', baseUrl);
  localStorage.removeItem('password');
  localStorage.removeItem('cfCookie');

  updateConnectionStatus('connecting');
  showToast('Connecting to Buckeye...', 'info');
  refreshMasterAccountInfo(true);

  if (!wsClient.ws || wsClient.ws.readyState !== WebSocket.OPEN) {
    wsClient.connect();
    setTimeout(() => {
      wsClient.authenticate(agentId, agentId, password, cfCookie);
    }, 1000);
  } else {
    wsClient.authenticate(agentId, agentId, password, cfCookie);
  }
}

function resumeSession(agentId, password, baseUrl, cfCookie, token) {
  localStorage.setItem('agentId', agentId);
  if (baseUrl) localStorage.setItem('baseUrl', baseUrl);
  localStorage.removeItem('password');
  localStorage.removeItem('cfCookie');

  updateConnectionStatus('connecting');
  showToast('Resuming session...', 'info');
  refreshMasterAccountInfo(true);

  if (!wsClient.ws || wsClient.ws.readyState !== WebSocket.OPEN) {
    wsClient.connect();
    setTimeout(() => {
      wsClient.authenticateWithToken(agentId, token, cfCookie);
    }, 1000);
  } else {
    wsClient.authenticateWithToken(agentId, token, cfCookie);
  }
}

function attemptAutoReconnect() {
  const agentId = localStorage.getItem('agentId');
  if (agentId) {
    showToast('Reconnect from Settings if the backend vault has not restored the session.', 'info');
  }
}

function updateConnectionStatus(state) {
  const el = document.getElementById('connectionStatus');
  if (!el) return;
  const token = localStorage.getItem('apiToken');
  const authIndicator = token ? '🔒 ' : '🔓 ';
  const styles = {
    connected:    { text: authIndicator + '● Live Polling', color: 'var(--green)' },
    connecting:   { text: authIndicator + '● Connecting...', color: 'var(--yellow)' },
    testing:      { text: authIndicator + '● Testing...', color: 'var(--yellow)' },
    ready:        { text: authIndicator + '● Login OK', color: 'var(--blue)' },
    disconnected: { text: authIndicator + '● Disconnected', color: 'var(--text-dim)' },
  };
  const s = styles[state] || styles.disconnected;
  el.textContent = s.text;
  el.style.color = s.color;
  el.title = token ? 'Authenticated to backend API' : 'No API token — some features may be unavailable';
  const liveAgents = Number(window.backendLiveAgents || 0);
  if (state === 'disconnected' && liveAgents > 0) {
    updateBuckeyeStatusBadge('connected', `${liveAgents} Agent${liveAgents === 1 ? '' : 's'} Live`);
  } else {
    updateBuckeyeStatusBadge(state, s.text.replace('● ', ''));
  }
  updateTopBarStatus();
}

// ==================== WEBHOOKS ====================
let editingWebhookId = null;

function showWebhookForm() {
  editingWebhookId = null;
  document.getElementById('webhookFormTitle').textContent = 'Add Webhook';
  document.getElementById('whName').value = '';
  document.getElementById('whPlatform').value = 'discord';
  document.getElementById('whUrl').value = '';
  document.getElementById('whEnabled').checked = true;
  document.getElementById('webhookForm').classList.remove('hidden');
}

function hideWebhookForm() {
  document.getElementById('webhookForm').classList.add('hidden');
  editingWebhookId = null;
}

async function saveWebhook() {
  const name = document.getElementById('whName').value.trim();
  const platform = document.getElementById('whPlatform').value;
  const url = document.getElementById('whUrl').value.trim();
  const enabled = document.getElementById('whEnabled').checked;
  const triggerSelect = document.getElementById('whTriggers');
  const triggers = Array.from(triggerSelect.selectedOptions).map(o => o.value);

  if (!name || !url) {
    showToast('Name and URL are required', 'error');
    return;
  }

  const payload = { name, platform, url, triggers, enabled };

  try {
    let res;
    if (editingWebhookId) {
      res = await fetch(`${getApiBaseUrl()}/api/webhooks/${editingWebhookId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetch(`${getApiBaseUrl()}/api/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    if (res.ok) {
      showToast(editingWebhookId ? 'Webhook updated' : 'Webhook created', 'success');
      hideWebhookForm();
      loadWebhooks(true);
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Failed to save webhook', 'error');
    }
  } catch (err) {
    showToast('Backend unreachable', 'error');
  }
}

async function loadWebhooks(force = false) {
  const container = document.getElementById('webhooksList');
  if (!container) return;

  if (!force && isCacheFresh('webhooks')) return;

  try {
    const res = await fetch(`${getApiBaseUrl()}/api/webhooks`);
    const webhooks = await res.json();
    markCacheFresh('webhooks');

    if (webhooks.length === 0) {
      container.innerHTML = '<div class="text-sm p-4 rounded-lg border" style="background:var(--panel);border-color:var(--border);color:var(--text-dim);">No webhooks configured. Add one to start receiving alerts.</div>';
      return;
    }

    container.innerHTML = webhooks.map(wh => {
      const platformColor = wh.platform === 'discord' ? '#5865F2' : wh.platform === 'slack' ? '#4A154B' : wh.platform === 'telegram' ? '#0088cc' : '#6b7280';
      const triggerBadges = wh.triggers.map(t => `<span class="text-xs px-1.5 py-0.5 rounded" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">${t}</span>`).join(' ');
      return `<div class="rounded-lg border p-3" style="background:var(--panel);border-color:var(--border);">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold px-2 py-0.5 rounded" style="background:${platformColor}22;color:${platformColor};">${wh.platform.toUpperCase()}</span>
            <span class="text-sm font-semibold">${wh.name}</span>
            ${wh.enabled ? '' : '<span class="text-xs px-1.5 py-0.5 rounded" style="background:var(--border);color:var(--text-dim);">OFF</span>'}
          </div>
          <div class="flex items-center gap-2">
            <button class="px-2 py-1 rounded text-xs" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" onclick="editWebhook(${wh.id})">Edit</button>
            <button class="px-2 py-1 rounded text-xs" style="background:var(--red);color:#fff;" onclick="deleteWebhook(${wh.id})">Delete</button>
          </div>
        </div>
        <div class="mt-2 text-xs font-mono" style="color:var(--text-dim);">${wh.url}</div>
        <div class="mt-1 flex gap-1">${triggerBadges}</div>
      </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = '<div class="text-sm p-4 rounded-lg border" style="background:var(--panel);border-color:var(--border);color:var(--text-dim);">Failed to load webhooks. Is the backend running?</div>';
  }
}

async function loadStatusPage(force = false) {
  const summary = document.getElementById('statusSummaryGrid');
  const agentsEl = document.getElementById('statusAgentsList');
  const booksEl = document.getElementById('statusBooksList');
  const countersEl = document.getElementById('statusCountersList');
  const queueEl = document.getElementById('statusQueueList');
  const dataFlowEl = document.getElementById('statusDataFlowStrip');
  const issuesEl = document.getElementById('statusIssuesList');
  const issuesSummaryEl = document.getElementById('statusIssuesSummary');
  if (!summary || !agentsEl || !booksEl || !countersEl || !queueEl || !issuesEl) return;

  summary.innerHTML = statusLoadingCards();
  if (dataFlowEl) dataFlowEl.innerHTML = statusLoadingRow('Checking data flows...');
  issuesEl.innerHTML = statusLoadingRow('Checking recent failures...');
  if (issuesSummaryEl) issuesSummaryEl.textContent = 'Checking...';
  agentsEl.innerHTML = statusLoadingRow('Loading Buckeye agents...');
  booksEl.innerHTML = statusLoadingRow('Loading books...');
  countersEl.innerHTML = statusLoadingRow('Loading counters...');
  queueEl.innerHTML = statusLoadingRow('Loading queue...');

  try {
    const player360Id = getStatusPlayerId();
    const [healthRes, systemRes, vaultRes, booksRes, patternsRes, player360Res] = await Promise.all([
      fetch(`${getApiBaseUrl()}/health`),
      fetch(`${getApiBaseUrl()}/api/health/system-status`),
      fetch(`${getApiBaseUrl()}/api/buckeye/vault-status`),
      fetch(`${getApiBaseUrl()}/api/books/status`),
      fetch(`${getApiBaseUrl()}/api/patterns/summary?sinceHours=24`),
      fetch(`${getApiBaseUrl()}/api/v1/players/${encodeURIComponent(player360Id)}/intelligence-map`),
    ]);

    if (!healthRes.ok) throw new Error(`Health request failed: ${healthRes.status}`);
    const health = await healthRes.json();
    const system = systemRes.ok ? await systemRes.json() : null;
    const vault = vaultRes.ok ? await vaultRes.json() : { available: false, agents: [] };
    const books = booksRes.ok ? await booksRes.json() : [];
    const patterns = patternsRes.ok ? await patternsRes.json() : { total: 0, bySeverity: {} };
    const player360 = player360Res.ok ? await player360Res.json() : null;

    const agents = Array.isArray(vault.agents) ? vault.agents : [];
    const activeAgents = Number(health.scrapers?.activeAgents || 0);
    const totalQueued = Number(health.scrapers?.actionQueue?.totalQueued || 0);
    const onlineBooks = (Array.isArray(books) ? books : []).filter(book => book.status === 'online').length;
    const criticalPatterns = Number(patterns.bySeverity?.critical || 0);
    const statusOk = health.status === 'ok';
    const systemIssues = system?.issues || [];
    const criticalIssues = Number(system?.summary?.critical || 0);
    const warningIssues = Number(system?.summary?.warning || 0);
    const player360Poll = player360?.freshness?.watermarks?.player360;
    const player360PollValue = player360Poll?.value || {};
    const coldBackfillLabel = player360PollValue.coldBackfillPlayers != null
      ? `${Number(player360PollValue.coldBackfillPlayers || 0).toLocaleString()}/${Number(player360PollValue.coldBackfillLimit || 0).toLocaleString()} this poll`
      : '-';

    summary.innerHTML = [
      statusCard('Backend', statusOk ? 'Online' : 'Issue', formatUptime(health.uptime), statusOk ? 'var(--green)' : 'var(--red)'),
      statusCard('Buckeye', String(activeAgents), `${agents.length} vaulted`, activeAgents > 0 ? 'var(--green)' : 'var(--yellow)'),
      statusCard('Books', `${onlineBooks}/${Array.isArray(books) ? books.length : 0}`, 'online', onlineBooks > 0 ? 'var(--green)' : 'var(--yellow)'),
      statusCard('Patterns', String(patterns.total || 0), `${criticalPatterns} critical`, criticalPatterns > 0 ? 'var(--red)' : 'var(--green)'),
      statusCard('Player 360', player360 ? 'Mapped' : 'Issue', player360 ? `${player360.coverage?.missingSourceCount || 0} missing/probe gaps` : `${player360Id} unavailable`, player360 ? 'var(--green)' : 'var(--red)'),
      statusCard('System Issues', String(systemIssues.length), `${criticalIssues} critical / ${warningIssues} warning`, criticalIssues > 0 ? 'var(--red)' : warningIssues > 0 ? 'var(--yellow)' : 'var(--green)'),
    ].join('');

    if (dataFlowEl) {
      dataFlowEl.innerHTML = renderStatusDataFlowStrip(system?.dataFlows || {});
    }

    issuesEl.innerHTML = renderStatusIssues(system);
    if (issuesSummaryEl) {
      issuesSummaryEl.textContent = system
        ? `${system.status.toUpperCase()} · ${systemIssues.length} tracked issue${systemIssues.length === 1 ? '' : 's'}`
        : 'System issue endpoint unavailable';
      issuesSummaryEl.style.color = criticalIssues > 0 ? 'var(--red)' : warningIssues > 0 ? 'var(--yellow)' : 'var(--text-dim)';
    }

    agentsEl.innerHTML = agents.length
      ? agents.map(agent => statusAgentRow(agent, player360)).join('')
      : '<div style="color:var(--text-dim);">No vaulted Buckeye agents. Add one from Settings to enable always-on ingestion.</div>';

    booksEl.innerHTML = Array.isArray(books) && books.length
      ? books.map(book => statusBookPill(book)).join('')
      : '<div class="col-span-full" style="color:var(--text-dim);">No book health rows yet.</div>';

    const counters = health.scrapers?.counters || {};
    countersEl.innerHTML = [
      statusKeyValue('Wagers seen', counters.wagers_total || 0),
      statusKeyValue('Alerts triggered', counters.alerts_triggered_total || 0),
      statusKeyValue('Errors', counters.errors_total || 0),
      ...(system ? [
        statusKeyValue('Raw API failures 24h', `${system.summary?.rawApiFailures24h || 0}/${system.summary?.rawApiCalls24h || 0}`),
        statusKeyValue('Player source errors', `${system.summary?.playerSourceErrors || 0}/${system.summary?.playerSourcesTracked || 0}`),
      ] : []),
      statusKeyValue('WebSocket', wsClient?.isConnected ? 'connected' : 'offline'),
      ...(player360 ? [
        statusKeyValue('Player 360 player', player360.playerId),
        statusKeyValue('Wager archive latest', player360.freshness?.wager_archive?.lastSeen ? formatShortDateTime(player360.freshness.wager_archive.lastSeen) : '-'),
        statusKeyValue('Access log latest', player360.freshness?.access_logs?.lastSeen ? formatShortDateTime(player360.freshness.access_logs.lastSeen) : '-'),
        statusKeyValue('Player 360 poll', player360Poll?.updatedAt ? formatShortDateTime(player360Poll.updatedAt) : '-'),
        statusKeyValue('Cold backfill', coldBackfillLabel),
        statusKeyValue('Transaction ledger', sourceStatusLabelFromMap(player360, 'player_transactions')),
        statusKeyValue('Deleted transactions', sourceStatusLabelFromMap(player360, 'deleted_transactions')),
        statusKeyValue('Deposits', sourceStatusLabelFromMap(player360, 'deposits')),
        statusKeyValue('Customer snapshots', sourceStatusLabelFromMap(player360, 'customer_snapshots')),
        statusKeyValue('Teaser profile', sourceStatusLabelFromMap(player360, 'teaser_profile')),
        statusKeyValue('Player performance', sourceStatusLabelFromMap(player360, 'agent_performance_snapshots')),
        statusKeyValue('Missing source count', player360.coverage?.missingSourceCount || 0),
      ] : []),
    ].join('');

    const queues = health.scrapers?.actionQueue?.queues || {};
    const queueRows = Object.entries(queues);
    queueEl.innerHTML = [
      statusKeyValue('Total queued', totalQueued),
      ...(queueRows.length
        ? queueRows.map(([agent, count]) => statusKeyValue(agent, count))
        : [statusKeyValue('Per-agent queues', 'empty')]),
    ].join('');

    // Check API endpoint health
    checkApiEndpoints();
    checkPlayer360Status();

    updateStatusBadge(statusOk, activeAgents, criticalPatterns);
  } catch (error) {
    summary.innerHTML = statusCard('Backend', 'Offline', error instanceof Error ? error.message : 'Status unavailable', 'var(--red)');
    if (dataFlowEl) dataFlowEl.innerHTML = '';
    issuesEl.innerHTML = '<div style="color:var(--red);">Could not load system issues.</div>';
    if (issuesSummaryEl) issuesSummaryEl.textContent = 'Unavailable';
    agentsEl.innerHTML = '<div style="color:var(--red);">Could not load status. Is the backend running?</div>';
    booksEl.innerHTML = '';
    countersEl.innerHTML = '';
    queueEl.innerHTML = '';
    updateStatusBadge(false, 0, 0);
  }
}

function statusLoadingCards() {
  return [
    statusCard('Backend', 'Loading', '', 'var(--text-dim)'),
    statusCard('Buckeye', 'Loading', '', 'var(--text-dim)'),
    statusCard('Books', 'Loading', '', 'var(--text-dim)'),
    statusCard('Patterns', 'Loading', '', 'var(--text-dim)'),
    statusCard('System Issues', 'Loading', '', 'var(--text-dim)'),
  ].join('');
}

function statusLoadingRow(text) {
  return `<div style="color:var(--text-dim);">${escapeHtml(text)}</div>`;
}

function statusCard(label, value, subtext, color) {
  return `<div class="rounded-lg border p-3" style="background:var(--panel);border-color:var(--border);">
    <div class="text-[10px] uppercase tracking-wider" style="color:var(--text-dim);">${escapeHtml(label)}</div>
    <div class="text-xl font-bold mt-1" style="color:${color};">${escapeHtml(value)}</div>
    <div class="text-xs mt-1" style="color:var(--text-dim);">${escapeHtml(subtext || '')}</div>
  </div>`;
}

function renderStatusDataFlowStrip(dataFlows) {
  const items = [
    ['Wagers', dataFlows.wagerArchive || dataFlows.liveWagers],
    ['Players', dataFlows.playerAgentMap],
    ['Agents', dataFlows.agentHierarchy],
    ['Access Logs', {
      ...(dataFlows.crossReferences || {}),
      rowCount: dataFlows.crossReferences?.accessRows,
      lastSeen: dataFlows.crossReferences?.accessLastSeen,
      status: Number(dataFlows.crossReferences?.accessRows || 0) > 0 ? 'live' : 'empty',
    }],
    ['Free-Play', dataFlows.playerTransactions],
    ['Patterns', dataFlows.patterns],
    ['Cross-Refs', dataFlows.crossReferences],
  ];
  return items.map(([label, flow]) => statusDataFlowPill(label, flow || {})).join('');
}

function statusDataFlowPill(label, flow) {
  const rowCount = Number(flow.rowCount || 0);
  const status = flow.status || (rowCount > 0 ? 'live' : 'empty');
  const color = status === 'live' ? 'var(--green)' : status === 'empty' ? 'var(--yellow)' : 'var(--text-dim)';
  return `<div class="rounded-lg border px-2 py-2" style="background:var(--panel);border-color:var(--border);">
    <div class="flex items-center justify-between gap-2">
      <span class="text-[10px] uppercase tracking-wider" style="color:var(--text-dim);">${escapeHtml(label)}</span>
      <span class="w-2 h-2 rounded-full" style="background:${color};"></span>
    </div>
    <div class="font-mono text-sm mt-1" style="color:var(--text);">${rowCount.toLocaleString()}</div>
    <div class="text-[10px] truncate" style="color:var(--text-dim);">${flow.lastSeen ? escapeHtml(formatShortDateTime(flow.lastSeen)) : 'no rows'}</div>
  </div>`;
}

function getStatusPlayerId() {
  return getActivePlayerProfileId() || 'A17566';
}

function getHashPlayerId() {
  const hashMatch = String(window.location.hash || '').match(/player=([^&]+)/);
  return hashMatch ? decodeURIComponent(hashMatch[1]) : '';
}

function getActivePlayerProfileId() {
  if (playerProfileState.playerId) return playerProfileState.playerId;
  const headerPlayer = document.getElementById('playerProfileTitle')?.textContent?.trim() || '';
  if (headerPlayer && headerPlayer !== 'Player') return headerPlayer;
  return getHashPlayerId();
}

function sourceStatusFromMap(map, key) {
  const source = (map?.sources || []).find(row => row.key === key);
  return source?.freshnessState || source?.status || 'missing';
}

function sourceStatusLabelFromMap(map, key) {
  const source = (map?.sources || []).find(row => row.key === key);
  if (!source) return 'missing';
  const status = source.freshnessState || source.status || 'missing';
  const policy = source.refreshPolicy || 'unknown';
  const last = source.lastSuccessAt || source.lastSeen || source.lastAttemptAt;
  return `${status} / ${policy}${last ? ` / ${formatShortDateTime(last)}` : ''}`;
}

function statusAgentRow(agent, player360 = null) {
  const flags = [
    agent.hasPassword ? 'password' : null,
    agent.hasCfCookie ? 'cookie' : null,
    agent.hasToken ? 'token' : null,
  ].filter(Boolean).join(' + ') || 'no usable secrets';
  const color = agent.active ? 'var(--green)' : 'var(--yellow)';
  const error = agent.lastError ? `<div class="mt-1" style="color:var(--red);">${escapeHtml(agent.lastError)}</div>` : '';
  const coverage = player360 ? `<div class="status-coverage-row">
    ${statusCoverageChip('Wagers', sourceStatusFromMap(player360, 'wager_archive'))}
    ${statusCoverageChip('Access', sourceStatusFromMap(player360, 'access_logs'))}
    ${statusCoverageChip('Ledger', sourceStatusFromMap(player360, 'player_transactions'))}
    ${statusCoverageChip('Deleted Tx', sourceStatusFromMap(player360, 'deleted_transactions'))}
    ${statusCoverageChip('Deposits', sourceStatusFromMap(player360, 'deposits'))}
    ${statusCoverageChip('Customer', sourceStatusFromMap(player360, 'customer_snapshots'))}
    ${statusCoverageChip('Teaser', sourceStatusFromMap(player360, 'teaser_profile'))}
    ${statusCoverageChip('Perf', sourceStatusFromMap(player360, 'agent_performance_snapshots'))}
  </div>` : '';
  return `<div class="rounded border p-2" style="background:var(--bg);border-color:var(--border);">
    <div class="flex items-center justify-between gap-2">
      <span class="font-mono" style="color:var(--text);">${escapeHtml(agent.agentId || 'Unknown')}</span>
      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold" style="background:${color}22;color:${color};">${agent.active ? 'ACTIVE' : 'VAULTED'}</span>
    </div>
    <div class="mt-1" style="color:var(--text-dim);">${escapeHtml(flags)}</div>
    ${coverage}
    ${error}
  </div>`;
}

function statusCoverageChip(label, status) {
  const normalized = String(status || 'missing').toLowerCase();
  return `<span class="status-coverage-chip ${normalized}">${escapeHtml(label)}: ${escapeHtml(normalized)}</span>`;
}

function statusBookPill(book) {
  const color = book.status === 'online' ? 'var(--green)' : book.status === 'offline' ? 'var(--red)' : 'var(--yellow)';
  return `<div class="rounded border px-2 py-1 flex items-center justify-between gap-2" style="background:var(--bg);border-color:var(--border);">
    <span class="font-mono" style="color:var(--text);">${escapeHtml(book.book || book.key || 'Book')}</span>
    <span class="w-2 h-2 rounded-full" style="background:${color};"></span>
  </div>`;
}

function statusKeyValue(label, value) {
  return `<div class="flex items-center justify-between gap-3 rounded px-2 py-1" style="background:var(--bg);border:1px solid var(--border);">
    <span style="color:var(--text-dim);">${escapeHtml(label)}</span>
    <span class="font-mono" style="color:var(--text);">${escapeHtml(String(value))}</span>
  </div>`;
}

function renderStatusIssues(system) {
  if (!system) {
    return '<div style="color:var(--yellow);">System issue rollup is unavailable. Check /api/health/system-status.</div>';
  }
  const issues = Array.isArray(system.issues) ? system.issues : [];
  if (!issues.length) {
    return '<div class="rounded border p-3" style="background:var(--bg);border-color:var(--border);color:var(--green);">No tracked system issues in the current window.</div>';
  }
  return issues.map((issue) => {
    const color = issue.severity === 'critical' ? 'var(--red)' : issue.severity === 'warning' ? 'var(--yellow)' : 'var(--text-dim)';
    const lastSeen = issue.lastSeen ? formatShortDateTime(issue.lastSeen) : '-';
    return `<div class="rounded border p-3" style="background:var(--bg);border-color:var(--border);">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase" style="background:${color}22;color:${color};">${escapeHtml(issue.severity || 'info')}</span>
          <span class="font-semibold truncate" style="color:var(--text);">${escapeHtml(issue.title || 'System issue')}</span>
        </div>
        <span class="font-mono text-[10px]" style="color:var(--text-dim);">${escapeHtml(lastSeen)}</span>
      </div>
      <div class="mt-1" style="color:var(--text-dim);">${escapeHtml(issue.detail || '')}</div>
      <div class="mt-2 flex flex-wrap gap-2">
        <span class="status-coverage-chip ${escapeHtml(issue.category || 'system')}">${escapeHtml(issue.category || 'system')}</span>
        <span class="status-coverage-chip">${escapeHtml(issue.source || 'unknown')}</span>
        ${issue.count != null ? `<span class="status-coverage-chip">count: ${Number(issue.count).toLocaleString()}</span>` : ''}
      </div>
      ${issue.action ? `<div class="mt-2 text-[11px]" style="color:var(--text);">${escapeHtml(issue.action)}</div>` : ''}
    </div>`;
  }).join('');
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m uptime`;
  return `${minutes}m uptime`;
}

function updateStatusBadge(ok, activeAgents, criticalPatterns) {
  const badge = document.getElementById('statusBadge');
  if (!badge) return;
  if (!ok) {
    badge.textContent = 'Down';
    badge.style.background = 'var(--red)';
    badge.style.color = '#fff';
    return;
  }
  if (criticalPatterns > 0) {
    badge.textContent = String(criticalPatterns);
    badge.style.background = 'var(--red)';
    badge.style.color = '#fff';
    return;
  }
  badge.textContent = activeAgents > 0 ? 'Live' : 'OK';
  badge.style.background = activeAgents > 0 ? 'rgba(16,185,129,0.18)' : 'var(--border)';
  badge.style.color = activeAgents > 0 ? 'var(--green)' : 'var(--text-dim)';
}

// ==================== API ENDPOINT STATUS ====================
const API_ENDPOINTS = [
  { path: '/health', label: 'Health', group: 'System' },
  { path: '/api/health/system-status', label: 'System Issues', group: 'System' },
  { path: '/api/stats', label: 'Stats', group: 'System' },
  { path: '/api/wagers?limit=1', label: 'Wagers', group: 'Data' },
  { path: '/api/wagers/alerts', label: 'Alerts', group: 'Data' },
  { path: '/api/wagers/live', label: 'Live Wagers', group: 'Data' },
  { path: '/api/players/search?q=A17566', label: 'Player Search', group: 'Player 360' },
  { path: '/api/players/A17566/profile', label: 'Player Profile', group: 'Player 360' },
  { path: '/api/players/A17566/agent-context', label: 'Agent Context', group: 'Player 360' },
  { path: '/api/players/A17566/intelligence-map', label: 'Intel Map', group: 'Player 360' },
  { path: '/api/cross-reference?playerId=A17566', label: 'Cross-Refs', group: 'Player 360' },
  { path: '/api/players/A17566/deposits', label: 'Deposits', group: 'Player 360' },
  { path: '/api/players/A17566/account-snapshots', label: 'Snapshots', group: 'Player 360' },
  { path: '/api/players/A17566/links', label: 'Links', group: 'Player 360' },
  { path: '/api/players/A17566/flags', label: 'Flags', group: 'Player 360' },
  { path: '/api/players/A17566/notes', label: 'Notes', group: 'Player 360' },
  { path: '/api/players/A17566/export/wagers', label: 'Export Wagers', group: 'Player 360' },
  { path: '/api/players/A17566/export/access-logs', label: 'Export Access', group: 'Player 360' },
  { path: '/api/agents', label: 'Agents', group: 'Data' },
  { path: '/api/agents/downline', label: 'Downline', group: 'Data' },
  { path: '/api/agents/access-logs', label: 'Agent Access', group: 'Data' },
  { path: '/api/risk/alerts', label: 'Risk Alerts', group: 'Risk' },
  { path: '/api/exposure/sports', label: 'Sport Exposure', group: 'Risk' },
  { path: '/api/exposure/agents', label: 'Agent Exposure', group: 'Risk' },
  { path: '/api/odds/live', label: 'Odds Live', group: 'Odds' },
  { path: '/api/odds/events', label: 'Odds Events', group: 'Odds' },
  { path: '/api/odds/snapshots', label: 'Odds Snapshots', group: 'Odds' },
  { path: '/api/odds/movements', label: 'Odds Movements', group: 'Odds' },
  { path: '/api/books/status', label: 'Books Status', group: 'Odds' },
  { path: '/api/patterns/summary', label: 'Patterns', group: 'Odds' },
  { path: '/api/buckeye/vault-status', label: 'Vault Status', group: 'Buckeye' },
  { path: '/api/buckeye/ui-config', label: 'UI Config', group: 'Buckeye' },
  { path: '/api/buckeye/account-info', label: 'Account Info', group: 'Buckeye' },
  { path: '/api/buckeye/weekly-figures', label: 'Weekly Figures', group: 'Buckeye' },
  { path: '/api/buckeye/agent-performance', label: 'Agent Perf', group: 'Buckeye' },
  { path: '/api/buckeye/sports-types', label: 'Sports Types', group: 'Buckeye' },
  { path: '/api/buckeye/manager-snapshot', label: 'Manager Snapshot', group: 'Buckeye' },
  { path: '/api/webhooks', label: 'Webhooks', group: 'System' },
  { path: '/api/performance/status', label: 'Perf Cache', group: 'System' },
  { path: '/api/betting/velocity?minutes=5', label: 'Bet Velocity', group: 'Analytics' },
  { path: '/api/betting/live-vs-pre', label: 'Live vs Pre', group: 'Analytics' },
  { path: '/api/logs/access?limit=1', label: 'Access Logs', group: 'Analytics' },
  { path: '/api/master/history?limit=1', label: 'Master History', group: 'Analytics' },
  { path: '/api/performance/summary', label: 'Perf Summary', group: 'Analytics' },
  { path: '/api/performance/details?agent=BILLY666&weeks=1', label: 'Perf Details', group: 'Analytics' },
  { path: '/api/analytics/raw-logs?limit=1', label: 'Raw API Archive', group: 'Analytics' },
];

function getApiEndpoints(playerId = getStatusPlayerId()) {
  const safePlayer = encodeURIComponent(playerId || 'A17566');
  return API_ENDPOINTS.map((endpoint) => {
    let path = endpoint.path.replaceAll('A17566', safePlayer);
    if (endpoint.group === 'Player 360') path = path.replace('/api/players', '/api/v1/players');
    return { ...endpoint, path };
  });
}

function getPlayer360EndpointRegistry(playerId = getStatusPlayerId()) {
  const safePlayer = encodeURIComponent(playerId || 'A17566');
  return [
    { path: `/api/v1/players/search?q=${safePlayer}`, label: 'Search', group: 'Player 360', tab: 'Search', aspect: 'Player lookup', sources: ['wager_archive'] },
    { path: `/api/v1/players/${safePlayer}/profile`, label: 'Profile', group: 'Player 360', tab: 'Overview', aspect: 'Overview, wagers, performance, account shell', sources: ['wager_archive', 'agent_performance_snapshots', 'access_logs', 'player_transactions', 'deleted_transactions', 'deposits', 'customer_snapshots', 'player_links', 'player_flags', 'player_notes'] },
    { path: `/api/v1/players/${safePlayer}/intelligence-map`, label: 'Intel Map', group: 'Player 360', tab: 'Status / Docs', aspect: 'Coverage, status, freshness, gaps', sources: ['all'] },
    { path: `/api/v1/players/${safePlayer}/deposits`, label: 'Deposits', group: 'Player 360', tab: 'Deposits', aspect: 'Deposit-like transaction rows and IP match', sources: ['deposits', 'access_logs'] },
    { path: `/api/v1/players/${safePlayer}/transactions`, label: 'Transactions', group: 'Player 360', tab: 'Deposits', aspect: 'Full getTransactionList/getTransactionHistory/getReportDeletedTransactions account ledger', sources: ['player_transactions', 'deleted_transactions'] },
    { path: `/api/v1/players/${safePlayer}/account-snapshots`, label: 'Snapshots', group: 'Player 360', tab: 'Account', aspect: 'KYC, VIP, masked contact, currency', sources: ['customer_snapshots'] },
    { path: `/api/v1/players/${safePlayer}/links`, label: 'Links', group: 'Player 360', tab: 'Links', aspect: 'Multi-account evidence', sources: ['player_links', 'access_logs'] },
    { path: `/api/v1/players/${safePlayer}/flags`, label: 'Flags', group: 'Player 360', tab: 'Notes', aspect: 'Compliance flags', sources: ['player_flags'] },
    { path: `/api/v1/players/${safePlayer}/notes`, label: 'Notes', group: 'Player 360', tab: 'Notes', aspect: 'Operator notes', sources: ['player_notes'] },
    { path: `/api/v1/players/${safePlayer}/export/wagers`, label: 'Export Wagers', group: 'Player 360', tab: 'Wager History', aspect: 'Wager CSV export', sources: ['wager_archive'] },
    { path: `/api/v1/players/${safePlayer}/export/access-logs`, label: 'Export Access', group: 'Player 360', tab: 'Access Logs', aspect: 'Access CSV export', sources: ['access_logs'] },
    { path: `/api/v1/logs/access?limit=1`, label: 'Audit Access', group: 'Player 360', tab: 'Access Logs', aspect: 'Audit access-log fallback', sources: ['access_logs'] },
  ];
}

async function checkApiEndpoints() {
  const container = document.getElementById('apiEndpointList');
  const summary = document.getElementById('apiEndpointSummary');
  if (!container) return;

  container.innerHTML = '<div class="col-span-full" style="color:var(--text-dim);">Checking endpoints...</div>';

  const results = await Promise.allSettled(
    getApiEndpoints().map(async (ep) => {
      const start = performance.now();
      const res = await fetch(`${getApiBaseUrl()}${ep.path}`);
      const ms = Math.round(performance.now() - start);
      return { ...ep, status: res.status, ms };
    })
  );

  const entries = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { ...getApiEndpoints()[results.indexOf(r)], status: 0, ms: 0 }
  );

  const ok = entries.filter((e) => e.status >= 200 && e.status < 400).length;
  const total = entries.length;
  summary.textContent = `${ok}/${total} endpoints OK`;

  // Group by group
  const groups = {};
  for (const ep of entries) {
    if (!groups[ep.group]) groups[ep.group] = [];
    groups[ep.group].push(ep);
  }

  container.innerHTML = Object.entries(groups).map(([groupName, eps]) => `
    <div class="col-span-full">
      <div class="text-[10px] uppercase tracking-wider font-semibold mb-1 mt-1" style="color:var(--text-dim);">${groupName}</div>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
        ${eps.map((ep) => {
          const isOk = ep.status >= 200 && ep.status < 400;
          const color = isOk ? 'var(--green)' : ep.status === 0 ? 'var(--red)' : 'var(--yellow)';
          return `<div class="flex items-center gap-1.5 px-2 py-1.5 rounded" style="background:var(--bg);border:1px solid var(--border);" title="${ep.path} — ${ep.status} in ${ep.ms}ms">
            <div class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${color};"></div>
            <span class="truncate">${ep.label}</span>
            <span class="ml-auto text-[10px] shrink-0" style="color:var(--text-dim);">${ep.status}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

// ==================== PLAYER 360 STATUS ====================
const PLAYER360_MODEL = [
  { key: 'stats', label: 'Stats', desc: 'Volume, risk, wager count, avg/max wager, first/last active, favorite sport, risk score, CLV %, stale line hits, past posting rate' },
  { key: 'recentWagers', label: 'Wager History', desc: '200 most recent wagers with pattern flags (stale, pastpost, clv, burst)' },
  { key: 'weeklyPnl', label: 'Weekly P&L', desc: '28-day weekly volume and projected P&L' },
  { key: 'sportBreakdown', label: 'Sport Breakdown', desc: 'Top 12 sports by volume with wager count and P&L' },
  { key: 'patternSummary', label: 'Pattern Summary', desc: 'Aggregate CLV %, stale line hits, past posting rate, pattern hit count' },
  { key: 'transactions', label: 'Transactions', desc: 'Full getTransactionList/getTransactionHistory/getReportDeletedTransactions account ledger: wager wins/losses, credits/debits, deleted rows, balance and document numbers' },
  { key: 'deposits', label: 'Deposits', desc: 'Deposit-like rows filtered from transaction candidates with IP-matched login flag' },
  { key: 'accountSnapshots', label: 'Account Snapshots', desc: 'KYC level, VIP status, masked email/phone, currency, source' },
  { key: 'links', label: 'Linked Accounts', desc: 'Multi-account detection via shared IP/device, with reason, confidence, evidence' },
  { key: 'flags', label: 'Flags', desc: 'Manual compliance flags with type, severity, label, details, resolution state' },
  { key: 'notes', label: 'Notes', desc: 'Manual operator notes with type, body, created_by, archived state' },
  { key: 'accessLogs', label: 'Access Logs', desc: '10 most recent logins with IP, operation, new-IP detection, device/geo metadata' },
];

async function checkPlayer360Status() {
  const summary = document.getElementById('player360Summary');
  const modelEl = document.getElementById('player360Model');
  const sourcesEl = document.getElementById('player360Sources');
  const endpointsEl = document.getElementById('player360Endpoints');
  if (!summary || !modelEl || !sourcesEl || !endpointsEl) return;

  const playerId = getStatusPlayerId();
  const player360Endpoints = getPlayer360EndpointRegistry(playerId);
  const results = await Promise.allSettled(
    player360Endpoints.map(async (ep) => {
      const start = performance.now();
      const res = await fetch(`${getApiBaseUrl()}${ep.path}`);
      const ms = Math.round(performance.now() - start);
      return { ...ep, status: res.status, ms };
    })
  );

  const entries = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { ...player360Endpoints[i], status: 0, ms: 0 }
  );

  const ok = entries.filter(e => e.status >= 200 && e.status < 400).length;
  let map = null;
  try {
    const mapRes = await fetch(`${getApiBaseUrl()}/api/v1/players/${encodeURIComponent(playerId)}/intelligence-map`);
    if (mapRes.ok) map = await mapRes.json();
  } catch {
    map = null;
  }
  const sources = map?.sources || [];
  const missingCount = sources.filter(source => sourceHealth(source).state === 'missing').length;
  summary.textContent = map
    ? `${playerId}: ${ok}/${entries.length} endpoints OK · ${missingCount} missing sources`
    : `${playerId}: ${ok}/${entries.length} endpoints OK · intelligence map unavailable`;

  // Render model
  modelEl.innerHTML = PLAYER360_MODEL.map(m => `
    <div class="flex items-start gap-2 py-1 border-b" style="border-color:var(--border);">
      <div class="w-1.5 h-1.5 rounded-full mt-1 shrink-0" style="background:var(--green);"></div>
      <div>
        <span class="font-semibold">${m.label}</span>
        <span style="color:var(--text-dim);"> — ${m.desc}</span>
      </div>
    </div>
  `).join('');

  // Render sources
  sourcesEl.innerHTML = sources.length ? sources.map(s => {
    const health = sourceHealth(s);
    const color = health.state === 'live' ? 'var(--green)' : health.state === 'derived' ? 'var(--blue)' : health.state === 'missing' ? 'var(--red)' : 'var(--yellow)';
    return `<div class="flex items-center gap-2 py-1 border-b" style="border-color:var(--border);">
      <div class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${color};"></div>
      <div class="flex-1">
        <div class="flex items-center justify-between">
          <span class="font-semibold">${escapeHtml(s.name || s.key || s.label)}</span>
          <span class="text-[10px] px-1 py-0.5 rounded" style="background:${color}20;color:${color};">${health.state}</span>
        </div>
        <div style="color:var(--text-dim);font-size:10px;">${escapeHtml(s.buckeyeEndpoint || s.source || '-')} • ${Number(s.rowCount || 0).toLocaleString()} rows • last seen ${s.lastSeen ? formatShortDateTime(s.lastSeen) : '-'}</div>
        <div style="color:var(--text-dim);font-size:10px;">${escapeHtml(s.gap || s.desc || '')}</div>
      </div>
    </div>`;
  }).join('') : '<div class="text-xs" style="color:var(--red);">No source coverage available because /api/v1/players/:id/intelligence-map did not return a live contract.</div>';

  // Render endpoint health
  endpointsEl.innerHTML = entries.map(ep => {
    const isOk = ep.status >= 200 && ep.status < 400;
    const color = isOk ? 'var(--green)' : ep.status === 0 ? 'var(--red)' : 'var(--yellow)';
    return `<div class="flex items-center gap-1.5 px-2 py-1.5 rounded" style="background:var(--bg);border:1px solid var(--border);" title="${ep.path} — ${ep.status} in ${ep.ms}ms">
      <div class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${color};"></div>
      <span class="truncate">${ep.label}</span>
      <span class="ml-auto text-[10px] shrink-0" style="color:var(--text-dim);">${ep.status}</span>
    </div>`;
  }).join('');
}

// ==================== UP TAB (ERROR TRACKING & RECOVERY) ====================
async function loadUptimePage(force = false) {
  const backendEl = document.getElementById('uptimeBackendStatus');
  const agentsEl = document.getElementById('uptimeAgentList');
  const watermarksEl = document.getElementById('uptimeWatermarks');
  const errorsEl = document.getElementById('uptimeErrorRows');
  if (!backendEl) return;

  try {
    // Fetch health + watermarks + error history in parallel
    const [healthRes, watermarksRes] = await Promise.all([
      fetch(`${getApiBaseUrl()}/health`),
      fetch(`${getApiBaseUrl()}/api/buckeye/vault-status`),
    ]);

    const health = healthRes.ok ? await healthRes.json() : null;
    const vault = watermarksRes.ok ? await watermarksRes.json() : { agents: [] };

    // Backend status
    const isOk = health?.status === 'ok';
    backendEl.textContent = isOk ? 'Online' : 'Offline';
    backendEl.style.color = isOk ? 'var(--green)' : 'var(--red)';
    document.getElementById('uptimeBackendUptime').textContent = health ? formatUptime(health.uptime) : 'Unknown';

    // Active agents
    const activeAgents = health?.scrapers?.activeAgents || 0;
    const agents = health?.scrapers?.agents || [];
    const totalErrors = health?.scrapers?.counters?.errors_total || 0;
    document.getElementById('uptimeActiveAgents').textContent = String(activeAgents);
    document.getElementById('uptimeAgentErrors').textContent = `${totalErrors} total errors`;

    // Poller health
    const pollerOk = agents.every(a => a.errorCount === 0);
    document.getElementById('uptimePollerHealth').textContent = pollerOk ? 'All Healthy' : `${agents.filter(a => a.errorCount > 0).length} Degraded`;
    document.getElementById('uptimePollerHealth').style.color = pollerOk ? 'var(--green)' : 'var(--yellow)';
    document.getElementById('uptimePollerDetail').textContent = `${agents.length} agents, ${agents.filter(a => a.authenticated).length} authenticated`;

    // API endpoints
    const apiResults = await Promise.allSettled(
      getApiEndpoints().slice(0, 10).map(async (ep) => {
        const res = await fetch(`${getApiBaseUrl()}${ep.path}`);
        return res.status;
      })
    );
    const apiOk = apiResults.filter(r => r.status === 'fulfilled' && r.value >= 200 && r.value < 400).length;
    const apiTotal = apiResults.length;
    document.getElementById('uptimeApiOk').textContent = `${apiOk}/${apiTotal}`;
    document.getElementById('uptimeApiOk').style.color = apiOk === apiTotal ? 'var(--green)' : apiOk > 0 ? 'var(--yellow)' : 'var(--red)';
    document.getElementById('uptimeApiErrors').textContent = `${apiTotal - apiOk} non-200 responses`;

    // Agent poller details
    if (agentsEl) {
      if (agents.length === 0) {
        agentsEl.innerHTML = '<div style="color:var(--text-dim);">No active agents. Connect from Settings.</div>';
      } else {
        agentsEl.innerHTML = agents.map(a => {
          const statusColor = a.errorCount === 0 ? 'var(--green)' : a.errorCount > 5 ? 'var(--red)' : 'var(--yellow)';
          const lastPollAgo = a.lastPoll ? Math.round((Date.now() - a.lastPoll) / 1000) + 's ago' : 'never';
          return `<div class="flex items-center justify-between py-2 border-b" style="border-color:var(--border);">
            <div class="flex items-center gap-2">
              <div class="w-2 h-2 rounded-full" style="background:${statusColor};"></div>
              <span class="font-mono font-semibold">${escapeHtml(a.agentId)}</span>
              <span class="px-1.5 py-0.5 rounded text-[10px]" style="background:${a.authenticated ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'};color:${a.authenticated ? 'var(--green)' : 'var(--red)'};">${a.authenticated ? 'auth' : 'no-auth'}</span>
            </div>
            <div class="flex items-center gap-3">
              <span style="color:var(--text-dim);">errors: ${a.errorCount}</span>
              <span style="color:var(--text-dim);">last: ${lastPollAgo}</span>
            </div>
          </div>`;
        }).join('');
      }
    }

    // Watermarks
    if (watermarksEl) {
      try {
        const wmRes = await fetch(`${getApiBaseUrl()}/api/buckeye/vault-status`);
        const wmData = wmRes.ok ? await wmRes.json() : {};
        const vaultedAgents = Array.isArray(wmData.agents) ? wmData.agents : [];
        if (vaultedAgents.length === 0) {
          watermarksEl.innerHTML = '<div style="color:var(--text-dim);">No vaulted agents — watermarks will appear after first poll cycle.</div>';
        } else {
          watermarksEl.innerHTML = vaultedAgents.map(a => {
            const agentId = a.agentId || 'unknown';
            return `<div class="rounded p-2" style="background:var(--bg);border:1px solid var(--border);">
              <div class="font-semibold mb-1">${escapeHtml(agentId)}</div>
              <div style="color:var(--text-dim);">bets: ${a.wagerCount || 0}</div>
              <div style="color:var(--text-dim);">status: ${a.status || 'active'}</div>
            </div>`;
          }).join('');
        }
      } catch {
        watermarksEl.innerHTML = '<div style="color:var(--text-dim);">Watermarks unavailable.</div>';
      }
    }

    // Error history from audit_logs
    if (errorsEl) {
      try {
        const auditRes = await fetch(`${getApiBaseUrl()}/api/logs/access?limit=20`);
        const auditData = auditRes.ok ? await auditRes.json() : { logs: [] };
        const logs = auditData.logs || [];
        if (logs.length === 0) {
          errorsEl.innerHTML = '<tr><td colspan="4" class="px-2 py-6 text-center" style="color:var(--text-dim);">No errors recorded. All systems nominal.</td></tr>';
        } else {
          errorsEl.innerHTML = logs.slice(0, 20).map(log => {
            const isError = log.result === 'fail' || log.operation === 'ERROR';
            return `<tr class="border-b" style="border-color:var(--border);${isError ? 'background:rgba(239,68,68,0.05);' : ''}">
              <td class="px-2 py-2" style="color:var(--text-dim);">${log.access_datetime ? timeAgo(log.access_datetime) : '—'}</td>
              <td class="px-2 py-2 font-mono">${escapeHtml(log.agent_id || log.login_id || '—')}</td>
              <td class="px-2 py-2">${escapeHtml(log.operation || log.log_type || 'access')}</td>
              <td class="px-2 py-2 text-center">
                <span class="px-1.5 py-0.5 rounded text-[10px]" style="background:${isError ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)'};color:${isError ? 'var(--red)' : 'var(--green)'};">${isError ? 'auto' : 'ok'}</span>
              </td>
            </tr>`;
          }).join('');
        }
      } catch {
        errorsEl.innerHTML = '<tr><td colspan="4" class="px-2 py-6 text-center" style="color:var(--red);">Error history unavailable.</td></tr>';
      }
    }

    // Update badge
    const badge = document.getElementById('uptimeBadge');
    if (badge) {
      if (!isOk) { badge.textContent = 'Down'; badge.style.background = 'var(--red)'; badge.style.color = '#fff'; }
      else if (totalErrors > 0) { badge.textContent = String(totalErrors); badge.style.background = 'var(--yellow)'; badge.style.color = '#000'; }
      else { badge.textContent = 'OK'; badge.style.background = 'rgba(16,185,129,0.18)'; badge.style.color = 'var(--green)'; }
    }
  } catch (error) {
    backendEl.textContent = 'Offline';
    backendEl.style.color = 'var(--red)';
    document.getElementById('uptimeBackendUptime').textContent = error instanceof Error ? error.message : 'Unreachable';
    if (agentsEl) agentsEl.innerHTML = '<div style="color:var(--red);">Backend unreachable. Is the server running?</div>';
  }
}

// ==================== PERFORMANCE ANALYTICS ====================
async function loadPerformancePage(force = false) {
  if (!force && isCacheFresh('performance')) {
    renderPerformanceDashboard();
    return;
  }

  setText('perfLiveIndicator', 'Loading archive...');
  setText('agentPerformanceRows', '');
  const today = new Date().toISOString().split('T')[0];

  try {
    const [velocityRes, liveRes, masterRes, performanceRes, weeklyRes, snapshotsRes] = await Promise.all([
      fetch(`${getApiBaseUrl()}/api/betting/velocity?minutes=30`),
      fetch(`${getApiBaseUrl()}/api/betting/live-vs-pre?date=${today}`),
      fetch(`${getApiBaseUrl()}/api/master/history?limit=40`),
      fetch(`${getApiBaseUrl()}/api/performance/summary`),
      fetch(`${getApiBaseUrl()}/api/analytics/weekly-figures?limit=20`),
      fetch(`${getApiBaseUrl()}/api/analytics/master-snapshots?limit=20`),
    ]);

    performanceState.velocity = velocityRes.ok ? (await velocityRes.json()).velocity || [] : [];
    performanceState.liveVsPre = liveRes.ok ? await liveRes.json() : null;
    performanceState.master = masterRes.ok ? (await masterRes.json()).snapshots || [] : [];
    performanceState.performanceSummary = performanceRes.ok ? (await performanceRes.json()).summary || [] : [];
    performanceState.weeklyFigures = weeklyRes.ok ? (await weeklyRes.json()).figures || [] : [];
    performanceState.masterSnapshots = snapshotsRes.ok ? (await snapshotsRes.json()).snapshots || [] : [];
    await loadRawApiArchive(false);
    await loadAccessLogsForPerformance(false);
    markCacheFresh('performance');
    renderPerformanceDashboard();
  } catch (error) {
    showToast('Performance analytics unavailable', 'warning');
    renderPerformanceError(error);
  }
}

async function loadRawApiArchive(render = true, includeBody = false, logId = null) {
  const endpoint = document.getElementById('rawLogEndpointFilter')?.value || performanceState.rawLogFilters.endpoint || '';
  const agentId = document.getElementById('rawLogAgentFilter')?.value?.trim() || performanceState.rawLogFilters.agentId || '';
  const status = document.getElementById('rawLogStatusFilter')?.value || performanceState.rawLogFilters.status || '';
  const days = document.getElementById('rawLogDaysFilter')?.value || performanceState.rawLogFilters.days || '7';
  performanceState.rawLogFilters = { endpoint, agentId, status, days };

  const url = new URL(`${getApiBaseUrl()}/api/analytics/raw-logs`);
  url.searchParams.set('limit', includeBody ? '200' : '75');
  url.searchParams.set('days', days);
  if (endpoint) url.searchParams.set('endpoint', endpoint);
  if (agentId) url.searchParams.set('agentId', agentId);
  if (status) url.searchParams.set('status', status);
  if (includeBody) url.searchParams.set('includeBody', '1');

  try {
    const res = await fetch(url.toString());
    const payload = res.ok ? await res.json() : { logs: [] };
    const logs = payload.logs || [];
    if (includeBody && logId !== null) {
      const selected = logs.find(row => String(row.id) === String(logId));
      showRawJsonDrawer(selected);
      return;
    }
    performanceState.rawLogs = logs;
    if (render) {
      renderRawLogsTable();
      renderRawApiFreshness();
    }
  } catch {
    performanceState.rawLogs = [];
    if (render) {
      renderRawLogsTable();
      renderRawApiFreshness();
    }
  }
}

async function loadAccessLogsForPerformance(render = true) {
  const ip = document.getElementById('accessIpFilter')?.value?.trim() || '';
  const url = new URL(`${getApiBaseUrl()}/api/logs/access`);
  url.searchParams.set('limit', '120');
  if (ip) url.searchParams.set('ip', ip);
  try {
    const res = await fetch(url.toString());
    performanceState.accessLogs = res.ok ? (await res.json()).logs || [] : [];
    if (render) renderAccessLogMonitor();
  } catch {
    performanceState.accessLogs = [];
    if (render) renderAccessLogMonitor();
  }
}

function renderPerformanceDashboard() {
  renderMasterHealth();
  renderVelocityChart();
  renderLiveVsPreChart();
  renderAccessLogMonitor();
  renderAgentPerformanceTable();
  renderRawLogsTable();
  renderRawApiFreshness();
  renderWeeklyFiguresTable();
  renderMasterSnapshotsTable();
}

function renderPerformanceError(error) {
  setText('perfMasterAge', error instanceof Error ? error.message : 'Unable to load');
  const rows = document.getElementById('agentPerformanceRows');
  if (rows) rows.innerHTML = '<tr><td colspan="5" class="px-2 py-6 text-center" style="color:var(--red);">Performance endpoints are not available.</td></tr>';
  const access = document.getElementById('accessLogMonitorRows');
  if (access) access.innerHTML = '<tr><td colspan="4" class="px-2 py-6 text-center" style="color:var(--red);">Access logs unavailable.</td></tr>';
}

function renderMasterHealth() {
  const latest = performanceState.master[0] || {};
  const live = performanceState.liveVsPre || { live: { count: 0, volume: 0 }, pregame: { count: 0, volume: 0 } };
  const liveCount = Number(live.live?.count || 0);
  const preCount = Number(live.pregame?.count || 0);
  const liveVolume = Number(live.live?.volume || 0);
  const preVolume = Number(live.pregame?.volume || 0);
  const archiveRows = liveCount + preCount;

  setText('perfMasterBalance', money(latest.balance));
  setText('perfAvailableBalance', money(latest.available_balance));
  setText('perfOpenWagers', String(Number(latest.open_wager_count || 0)));
  setText('perfArchiveRows', String(archiveRows));
  setText('perfLiveSplit', `Live ${liveCount} (${money(liveVolume)}) / Pregame ${preCount} (${money(preVolume)})`);
  setText('perfBookPercent', `Book percent ${latest.percent_book ?? '--'}`);
  setText('perfMasterAge', latest.timestamp ? `Last snapshot ${timeAgo(latest.timestamp)}` : 'No snapshot');
  setText('perfLiveIndicator', archiveRows > 0 ? 'Archive live' : 'Waiting for wagers');
}

function renderVelocityChart() {
  const canvas = document.getElementById('velocityChart');
  if (!canvas || !window.Chart) return;
  const labels = performanceState.velocity.map(row => row.timestamp || '');
  const counts = performanceState.velocity.map(row => Number(row.wagerCount || 0));
  const handle = performanceState.velocity.map(row => Number(row.totalHandle || 0));

  const data = {
    labels,
    datasets: [
      { type: 'bar', label: 'Wagers', data: counts, backgroundColor: 'rgba(255,102,0,0.45)', yAxisID: 'y' },
      { type: 'line', label: 'Handle', data: handle, borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.12)', tension: 0.25, yAxisID: 'y1' },
    ],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#e5e7eb', boxWidth: 10 } } },
    scales: {
      x: { ticks: { color: '#6b7280', maxRotation: 0, autoSkip: true }, grid: { color: '#1f2937' } },
      y: { ticks: { color: '#6b7280' }, grid: { color: '#1f2937' } },
      y1: { position: 'right', ticks: { color: '#6b7280', callback: value => `$${Number(value).toLocaleString()}` }, grid: { drawOnChartArea: false } },
    },
  };
  if (velocityChart) {
    velocityChart.data = data;
    velocityChart.options = options;
    velocityChart.update();
    return;
  }
  velocityChart = new Chart(canvas, { type: 'bar', data, options });
}

function renderLiveVsPreChart() {
  const canvas = document.getElementById('liveVsPreChart');
  if (!canvas || !window.Chart) return;
  const live = performanceState.liveVsPre || { date: new Date().toISOString().split('T')[0], live: {}, pregame: {} };
  setText('liveVsPreDate', live.date || 'Today');
  const data = {
    labels: ['Live', 'Pregame'],
    datasets: [{
      data: [Number(live.live?.volume || 0), Number(live.pregame?.volume || 0)],
      backgroundColor: ['rgba(6,182,212,0.75)', 'rgba(59,130,246,0.65)'],
      borderColor: ['#06b6d4', '#3b82f6'],
      borderWidth: 1,
    }],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#e5e7eb' } } },
    onClick: (_, elements) => {
      if (!elements.length) return;
      const label = data.labels[elements[0].index];
      showToast(`${label} position filter selected`, 'info');
      switchSection('positions', getSidebarButton('positions'));
    },
  };
  if (liveVsPreChart) {
    liveVsPreChart.data = data;
    liveVsPreChart.options = options;
    liveVsPreChart.update();
    return;
  }
  liveVsPreChart = new Chart(canvas, { type: 'doughnut', data, options });
}

function renderAccessLogMonitor() {
  const tbody = document.getElementById('accessLogMonitorRows');
  if (!tbody) return;
  const rows = performanceState.accessLogs || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="px-2 py-6 text-center" style="color:var(--text-dim);">No access logs in the archive yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.slice(0, 120).map(row => {
    const isNew = Boolean(row.is_new_ip);
    return `<tr class="border-b" style="border-color:var(--border);">
      <td class="px-2 py-2 font-mono">${escapeHtml(row.login_id || row.customer_id || row.agent_id || '—')}</td>
      <td class="px-2 py-2">
        <button class="font-mono hover:underline" style="color:${isNew ? 'var(--red)' : 'var(--text)'};" onclick="filterAccessIp('${escapeHtml(row.ip_address || '')}')">${escapeHtml(row.ip_address || '—')}</button>
        ${isNew ? `<span class="new-ip-pill ml-1 px-1 py-0.5 rounded text-[10px]" title="First seen ${escapeHtml(row.first_seen || '')}">NEW</span>` : ''}
      </td>
      <td class="px-2 py-2">${escapeHtml(row.operation || row.log_type || 'access')}</td>
      <td class="px-2 py-2 text-right" style="color:var(--text-dim);">${row.access_datetime ? timeAgo(row.access_datetime) : '—'}</td>
    </tr>`;
  }).join('');
}

function filterAccessIp(ip) {
  const input = document.getElementById('accessIpFilter');
  if (!input || !ip) return;
  input.value = ip;
  loadAccessLogsForPerformance();
}

function renderAgentPerformanceTable() {
  const tbody = document.getElementById('agentPerformanceRows');
  if (!tbody) return;
  const sortKey = document.getElementById('agentPerformanceSort')?.value || 'handle';
  const rows = [...(performanceState.performanceSummary || [])].sort((a, b) => {
    if (sortKey === 'agent_id') return String(a.agent_id || '').localeCompare(String(b.agent_id || ''));
    return Number(b[sortKey] || 0) - Number(a[sortKey] || 0);
  });
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="px-2 py-6 text-center" style="color:var(--text-dim);">No archived performance rows yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.slice(0, 500).map(row => {
    const net = Number(row.win_loss || 0);
    return `<tr class="border-b hover:bg-opacity-50" style="border-color:var(--border);">
      <td class="px-2 py-2 font-mono">${escapeHtml(row.agent_id || 'Unknown')}</td>
      <td class="px-2 py-2 text-right">${Number(row.row_count || 0)}</td>
      <td class="px-2 py-2 text-right">${money(row.handle)}</td>
      <td class="px-2 py-2 text-right" style="color:${net >= 0 ? 'var(--green)' : 'var(--red)'};">${money(net)}</td>
      <td class="px-2 py-2 text-center"><button class="px-2 py-1 rounded text-xs" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" onclick="loadAgentPerformanceDetail('${escapeHtml(row.agent_id || '')}')">Open</button></td>
    </tr>`;
  }).join('');
}

function renderRawLogsTable() {
  const tbody = document.getElementById('perfRawLogsRows');
  const countEl = document.getElementById('perfRawLogsCount');
  const coverage = document.getElementById('rawRedactionCoverage');
  if (!tbody) return;
  const rows = performanceState.rawLogs || [];
  if (countEl) countEl.textContent = `${rows.length} entries`;
  if (coverage) coverage.textContent = rows.length ? `Redaction active · ${rows.length} checked` : 'Redaction active · waiting for logs';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-2 py-6 text-center" style="color:var(--text-dim);">No raw API archive rows match these filters.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.slice(0, 100).map(row => {
    const code = Number(row.status_code || 0);
    const color = code >= 500 ? 'var(--red)' : code >= 400 ? 'var(--yellow)' : 'var(--green)';
    const params = row.request_params_summary || row.request_params || '';
    return `
    <tr class="border-b hover:bg-opacity-5" style="border-color:var(--border);">
      <td class="px-2 py-1.5 font-mono" title="${escapeHtml(row.endpoint || '')}">${escapeHtml(row.endpoint || '')}</td>
      <td class="px-2 py-1.5">${escapeHtml(row.agent_id || '')}</td>
      <td class="px-2 py-1.5 text-center"><span class="px-1.5 py-0.5 rounded text-[10px]" style="background:${color}22;color:${color};">${escapeHtml(row.status_code ?? '—')}</span></td>
      <td class="px-2 py-1.5 text-right">${row.duration_ms != null ? row.duration_ms + 'ms' : '-'}</td>
      <td class="px-2 py-1.5 max-w-[280px] truncate" title="${escapeHtml(params)}">${escapeHtml(params || '—')}</td>
      <td class="px-2 py-1.5">${timeAgo(row.fetched_at)}</td>
      <td class="px-2 py-1.5 text-center"><button class="px-2 py-1 rounded text-[10px]" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" onclick="openRawJsonDrawer('${escapeHtml(String(row.id))}')">View</button></td>
    </tr>
  `}).join('');
}

function renderRawApiFreshness() {
  const container = document.getElementById('rawApiFreshnessCards');
  if (!container) return;
  const rows = performanceState.rawLogs || [];
  const targets = [
    { label: 'Wagers', endpoint: 'local:wagers' },
    { label: 'Access', endpoint: '/api/buckeye/access-logs' },
    { label: 'Manager', endpoint: '/api/buckeye/manager-snapshot' },
    { label: 'Weekly', endpoint: '/api/buckeye/weekly-figures' },
    { label: 'Performance', endpoint: '/api/buckeye/agent-performance' },
    { label: 'Sports', endpoint: '/api/buckeye/sports-types' },
  ];
  container.innerHTML = targets.map((target) => {
    const isWagers = target.endpoint === 'local:wagers';
    const match = isWagers
      ? { status_code: buckeyeWagers.length ? 'live' : '—', fetched_at: buckeyeWagers[0]?.InsertDateTime || '' }
      : rows.find((row) => row.endpoint === target.endpoint || row.endpoint?.includes(target.endpoint));
    const status = match?.status_code ?? '—';
    const age = match?.fetched_at ? timeAgo(match.fetched_at) : 'No recent log';
    const code = Number(status || 0);
    const color = !match ? 'var(--text-dim)' : status === 'live' ? 'var(--green)' : code >= 500 ? 'var(--red)' : code >= 400 ? 'var(--yellow)' : 'var(--green)';
    return `<div class="rounded p-2" style="background:var(--bg);border:1px solid var(--border);">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[10px] uppercase tracking-wider" style="color:var(--text-dim);">${escapeHtml(target.label)}</span>
        <span class="w-2 h-2 rounded-full" style="background:${color};"></span>
      </div>
      <div class="mt-1 font-semibold" style="color:${color};">${escapeHtml(String(status))}</div>
      <div class="text-[10px] mt-1" style="color:var(--text-dim);">${escapeHtml(age)}</div>
    </div>`;
  }).join('');
}

function openRawJsonDrawer(logId) {
  performanceState.selectedRawLogId = logId;
  setText('rawJsonBody', 'Loading redacted JSON...');
  document.getElementById('rawJsonDrawer')?.classList.remove('hidden');
  loadRawApiArchive(false, true, logId);
}

function closeRawJsonDrawer() {
  performanceState.selectedRawLogId = null;
  document.getElementById('rawJsonDrawer')?.classList.add('hidden');
  setText('rawJsonBody', '');
}

function showRawJsonDrawer(row) {
  const body = document.getElementById('rawJsonBody');
  if (!body) return;
  if (!row) {
    body.textContent = 'Raw log row no longer exists for the current filters.';
    return;
  }
  const payload = row.response_json || '{}';
  try {
    body.textContent = JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    body.textContent = String(payload);
  }
}

function renderWeeklyFiguresTable() {
  const tbody = document.getElementById('perfWeeklyFiguresRows');
  const countEl = document.getElementById('perfWeeklyFiguresCount');
  if (!tbody) return;
  const rows = performanceState.weeklyFigures || [];
  if (countEl) countEl.textContent = `${rows.length} entries`;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="px-2 py-6 text-center" style="color:var(--text-dim);">No weekly figures yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.slice(0, 100).map(row => `
    <tr class="border-b hover:bg-opacity-5" style="border-color:var(--border);">
      <td class="px-2 py-1.5">${escapeHtml(row.agent_id || '')}</td>
      <td class="px-2 py-1.5 text-right">${row.week ?? '-'}</td>
      <td class="px-2 py-1.5 text-right">${money(row.this_week || 0)}</td>
      <td class="px-2 py-1.5 text-right">${money(row.active || 0)}</td>
      <td class="px-2 py-1.5 text-right">${money(row.today || 0)}</td>
      <td class="px-2 py-1.5">${timeAgo(row.pulled_at)}</td>
    </tr>
  `).join('');
}

function renderMasterSnapshotsTable() {
  const tbody = document.getElementById('perfMasterSnapshotsRows');
  const countEl = document.getElementById('perfMasterSnapshotsCount');
  if (!tbody) return;
  const rows = performanceState.masterSnapshots || [];
  if (countEl) countEl.textContent = `${rows.length} entries`;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="px-2 py-6 text-center" style="color:var(--text-dim);">No master snapshots yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.slice(0, 100).map(row => `
    <tr class="border-b hover:bg-opacity-5" style="border-color:var(--border);">
      <td class="px-2 py-1.5">${escapeHtml(row.agent_id || '')}</td>
      <td class="px-2 py-1.5 text-right">${money(row.balance || 0)}</td>
      <td class="px-2 py-1.5 text-right">${money(row.available_balance || 0)}</td>
      <td class="px-2 py-1.5 text-right">${row.open_wager_count ?? 0}</td>
      <td class="px-2 py-1.5">${timeAgo(row.timestamp)}</td>
    </tr>
  `).join('');
}

async function loadAgentPerformanceDetail(agentId) {
  if (!agentId) return;
  performanceState.selectedAgent = agentId;
  const detail = document.getElementById('agentPerformanceDetail');
  if (detail) {
    detail.classList.remove('hidden');
    detail.innerHTML = '<span style="color:var(--text-dim);">Loading detail...</span>';
  }
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/performance/details?agent=${encodeURIComponent(agentId)}&weeks=8`);
    const payload = res.ok ? await res.json() : { weeklyTrend: [], sportBreakdown: [] };
    renderAgentPerformanceDetail(payload);
  } catch {
    if (detail) detail.innerHTML = '<span style="color:var(--red);">Unable to load agent detail.</span>';
  }
}

function renderAgentPerformanceDetail(payload) {
  const detail = document.getElementById('agentPerformanceDetail');
  if (!detail) return;
  const trend = payload.weeklyTrend || [];
  const sports = payload.sportBreakdown || [];
  detail.classList.remove('hidden');
  detail.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <span class="font-semibold">${escapeHtml(payload.agentId || performanceState.selectedAgent || 'Agent')}</span>
      <span style="color:var(--text-dim);">${trend.length} trend rows</span>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <div class="text-[10px] uppercase mb-1" style="color:var(--text-dim);">Weekly Trend</div>
        ${trend.slice(0, 8).map(row => `<div class="flex justify-between gap-2 py-1 border-b" style="border-color:var(--border);"><span>${escapeHtml(row.week_start_date || '—')}</span><span>${money(row.handle)} / ${money(row.win_loss)}</span></div>`).join('') || '<div style="color:var(--text-dim);">No trend rows.</div>'}
      </div>
      <div>
        <div class="text-[10px] uppercase mb-1" style="color:var(--text-dim);">Sport Breakdown</div>
        ${sports.slice(0, 8).map(row => `<div class="flex justify-between gap-2 py-1 border-b" style="border-color:var(--border);"><span>${escapeHtml(row.sport || 'Unknown')}</span><span>${money(row.handle)} / ${money(row.win_loss)}</span></div>`).join('') || '<div style="color:var(--text-dim);">No sport rows.</div>'}
      </div>
    </div>`;
}

function recordPerformanceWager(wager) {
  if (!wager) return;
  const ts = new Date(wager.InsertDateTime || wager.insert_date_time || Date.now());
  if (!Number.isFinite(ts.getTime())) return;
  const bucket = ts.toISOString().slice(0, 16).replace('T', ' ');
  const velocity = performanceState.velocity || [];
  let row = velocity.find(item => item.timestamp === bucket);
  if (!row) {
    row = { timestamp: bucket, wagerCount: 0, totalHandle: 0 };
    velocity.push(row);
    velocity.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    if (velocity.length > 40) velocity.shift();
  }
  row.wagerCount = Number(row.wagerCount || 0) + 1;
  row.totalHandle = Number(row.totalHandle || 0) + Number(wager.AmountWagered || wager.amount_wagered || 0);
  performanceState.velocity = velocity;
  if (currentSection === 'performance') renderVelocityChart();
}

async function exportAnalytics(kind) {
  const labels = { wagers: 'wagers', 'access-logs': 'access logs', performance: 'performance' };
  try {
    showToast(`Preparing ${labels[kind] || kind} export...`, 'info');
    const res = await fetch(`${getApiBaseUrl()}/api/export/${kind}`);
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${kind}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Export ready (${Math.round(blob.size / 1024)} KB)`, 'success');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Export failed', 'error');
  }
}

async function editWebhook(id) {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/webhooks/${id}`);
    const wh = await res.json();
    if (!wh) return;

    editingWebhookId = id;
    document.getElementById('webhookFormTitle').textContent = 'Edit Webhook';
    document.getElementById('whName').value = wh.name;
    document.getElementById('whPlatform').value = wh.platform;
    document.getElementById('whUrl').value = wh.url;
    document.getElementById('whEnabled').checked = wh.enabled;

    const triggerSelect = document.getElementById('whTriggers');
    Array.from(triggerSelect.options).forEach(opt => {
      opt.selected = wh.triggers.includes(opt.value);
    });

    document.getElementById('webhookForm').classList.remove('hidden');
  } catch (err) {
    showToast('Failed to load webhook', 'error');
  }
}

async function deleteWebhook(id) {
  if (!confirm('Delete this webhook?')) return;
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/webhooks/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Webhook deleted', 'success');
      loadWebhooks(true);
    } else {
      showToast('Failed to delete webhook', 'error');
    }
  } catch (err) {
    showToast('Backend unreachable', 'error');
  }
}

function showFallbackBanner(show, message) {
  const banner = document.getElementById('fallbackBanner');
  if (!banner) return;
  if (show) {
    banner.textContent = '⚠️ ' + (message || 'Live feed disconnected - showing latest persisted Buckeye data');
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function showWagerDetail(wagerNumber) {
  const wager = buckeyeWagers.find(w => w.WagerNumber === wagerNumber);
  if (!wager) return;

  const risk = w.VolumeAmount > 0 ? '$' + w.VolumeAmount.toLocaleString() : 'PENDING';
  const win = '$' + (w.ToWinAmount || 0).toLocaleString();
  const typeLabel = getWagerTypeLabel(w.WagerType);
  const sport = parseSport(w.ShortDesc);

  // Build detail toast with Accept/Decline buttons
  showWagerDetailModal(wager, risk, win, typeLabel, sport);
}

function showWagerDetailModal(wager, risk, win, typeLabel, sport) {
  // Remove any existing modal
  const existing = document.getElementById('wagerDetailModal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'wagerDetailModal';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center';
  overlay.style.background = 'rgba(0,0,0,0.6)';
  overlay.innerHTML = `
    <div class="rounded-lg shadow-2xl p-6 max-w-md w-full mx-4" style="background:var(--panel);border:1px solid var(--border);animation: slideUp 0.2s ease-out;">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold">Wager #${wager.WagerNumber}</h3>
        <button class="text-lg hover:opacity-70" style="color:var(--text-dim);" onclick="document.getElementById('wagerDetailModal').remove()">&times;</button>
      </div>
      <div class="space-y-2 text-sm mb-5">
        <div class="flex justify-between"><span style="color:var(--text-dim);">Player</span><span class="font-medium">${escapeHtml(w.Login)}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">Agent</span><span class="font-medium">${escapeHtml(w.AgentLogin)}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">Type</span><span class="font-medium">${escapeHtml(typeLabel)}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">Sport</span><span class="font-medium">${escapeHtml(sport)}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">Risk</span><span class="font-mono font-medium">${risk}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">To Win</span><span class="font-mono font-medium">${win}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">Source</span><span class="font-medium">${escapeHtml(w.TicketWriter)}</span></div>
      </div>
      <div class="border-t pt-4 mb-3" style="border-color:var(--border);">
        <div class="text-xs mb-2" style="color:var(--text-dim);">${escapeHtml(w.ShortDesc || '')}</div>
      </div>
      <div class="flex gap-3">
        <button class="flex-1 py-2 rounded-lg text-sm font-bold" style="background:var(--green);color:#fff;"
          onclick="handleWagerAction(${w.WagerNumber}, 'accept');document.getElementById('wagerDetailModal').remove()">
          Accept
        </button>
        <button class="flex-1 py-2 rounded-lg text-sm font-bold" style="background:var(--red);color:#fff;"
          onclick="handleWagerAction(${w.WagerNumber}, 'decline');document.getElementById('wagerDetailModal').remove()">
          Decline
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

function handleWagerAction(wagerNumber, action) {
  if (!wsClient || !wsClient.isAuthenticated) {
    showToast('Not connected. Please connect first.', 'error');
    return;
  }
  wsClient.send({
    type: 'betAction',
    agentId: wsClient.agentId,
    wagerNumber,
    action,
  });
  showToast(`${action === 'accept' ? 'Accepting' : 'Declining'} wager #${wagerNumber}...`, 'info');
}

function filterBooks() {
  renderOddsMatrix();
}

function toggleOddsFormat() {
  oddsFormat = oddsFormat === 'american' ? 'decimal' : 'american';
  const btn = document.getElementById('oddsFormatBtn');
  if (btn) btn.textContent = oddsFormat === 'american' ? 'American' : 'Decimal';
  renderOddsMatrix();
}

// ==================== AGENT NETWORK ====================
let agentTreeData = []; // nested tree from real API
let agentTreeFlat = []; // flattened for search
let agentStatsMap = {}; // agent_login -> stats from wager data
let agentPatternCounts = {};
let livePatterns = new Map(); // WebSocket patterns for odds grid tooltips
let agentPatternSortEnabled = false;
let previousSection = 'floor';
let agentDownlineRequestId = 0;
let agentTreeStatusMessage = 'No agent hierarchy loaded yet. Refresh after connecting or use Downline data.';

function setAgentTreeLoading(isLoading, message = 'Loading agent hierarchy...') {
  agentTreeStatusMessage = message;
  if (isLoading) {
    const tbody = document.getElementById('agentDownlineTable');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="10" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">${message}</td></tr>`;
    }
  }
  if (currentSection === 'agentTree') {
    computeTreeLayout(agentTreeData);
    if (treeLayoutNodes.length > 0) fitTreeToCanvas();
  }
}

async function refreshAgentDownline(force = false) {
  if (!force && isCacheFresh('downline') && agentTreeData.length > 0) {
    await loadAgentPatternCounts();
    renderAgentTree(agentTreeData);
    updateAgentSummary(agentTreeFlat);
    if (currentSection === 'agentTree') initAgentCanvas();
    return;
  }

  const requestId = ++agentDownlineRequestId;
  if (agentTreeData.length === 0 || force) {
    setAgentTreeLoading(true);
  }

  try {
    // Fetch the cached real hierarchy projection. The v1 shape is shared with
    // Player Intelligence, then adapted into this view's legacy node shape.
    const hierarchyRes = await fetch(`${getApiBaseUrl()}/api/v1/agents/hierarchy`);
    if (!hierarchyRes.ok) throw new Error(`Hierarchy request failed: ${hierarchyRes.status}`);
    const hierarchyData = await hierarchyRes.json();
    const cachedTree = Array.isArray(hierarchyData?.tree) ? normalizeCachedAgentTree(hierarchyData.tree) : [];
    const general = Array.isArray(hierarchyData) ? hierarchyData : (hierarchyData.GENERAL || []);

    // Fetch wager-derived stats
    const statsRes = await fetch(`${getApiBaseUrl()}/api/agents/downline`);
    if (!statsRes.ok) throw new Error(`Downline stats request failed: ${statsRes.status}`);
    const statsData = await statsRes.json();
    await loadAgentPatternCounts();
    if (requestId !== agentDownlineRequestId) return;
    agentStatsMap = {};
    (Array.isArray(statsData) ? statsData : []).forEach(s => { agentStatsMap[s.agent_login] = s; });

    if (cachedTree.length > 0 || general.length > 0) {
      // Build tree from cached nodes when available; fall back to raw GENERAL.
      agentTreeData = cachedTree.length ? cachedTree : buildAgentTree(general);
      agentTreeFlat = flattenAgentTree(agentTreeData);
      // Merge stats into tree nodes
      mergeAgentStats(agentTreeData);
      computeDownlineStats(agentTreeData);
      renderAgentTree(agentTreeData);
      updateAgentSummary(agentTreeFlat);
      if (currentSection === 'agentTree') initAgentCanvas();
      markCacheFresh('downline');
    } else {
      // Fallback: derive from loaded Buckeye archive wagers.
      const fallbackCount = deriveAgentDownlineFromStatic();
      if (currentSection === 'agentTree') initAgentCanvas();
      if (fallbackCount > 0) markCacheFresh('downline');
    }
  } catch (err) {
    console.error('Failed to load agent hierarchy:', err?.message || err);
    const fallbackCount = deriveAgentDownlineFromStatic();
    if (currentSection === 'agentTree') initAgentCanvas();
    if (fallbackCount > 0) {
      markCacheFresh('downline');
    } else {
      setAgentTreeLoading(false, 'No agent hierarchy loaded. Check seeded hierarchy data or connect to Buckeye.');
    }
  }
}

function normalizeCachedAgentTree(nodes) {
  return (nodes || []).map(node => {
    const rates = node.rates || {};
    const level = Number(node.level) || Number(node.Level) || 1;
    return {
      ...node,
      AgentID: node.agentId || node.AgentID || node.login,
      Login: node.login || node.agentId || node.AgentID,
      AgentType: node.agentType || node.AgentType || 'A',
      HeadCountRateM: Number(rates.HeadCountRateM ?? rates.headCount ?? node.HeadCountRateM ?? 0),
      InetHeadCountRateM: Number(rates.InetHeadCountRateM ?? rates.inetHeadCount ?? node.InetHeadCountRateM ?? 0),
      CasinoHeadCountRateM: Number(rates.CasinoHeadCountRateM ?? rates.casinoHeadCount ?? node.CasinoHeadCountRateM ?? 0),
      LiveBettingRateM: Number(rates.LiveBettingRateM ?? rates.liveBetting ?? node.LiveBettingRateM ?? 0),
      SeqNumber: Number(node.seqNumber ?? node.SeqNumber ?? 0),
      Level: level,
      agent: node.login || node.agentId || node.AgentID,
      type: node.agentType || node.AgentType || 'A',
      commission: Number(rates.HeadCountRateM ?? rates.headCount ?? node.HeadCountRateM ?? 0),
      level,
      playerCount: Number(node.playerCount ?? node.PlayerCount ?? 0),
      children: normalizeCachedAgentTree(node.children || []),
      expanded: level <= 2,
    };
  });
}

async function loadAgentPatternCounts() {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/patterns/agents?sinceHours=24`);
    if (!res.ok) throw new Error(`Pattern counts failed: ${res.status}`);
    const rows = await res.json();
    agentPatternCounts = {};
    (Array.isArray(rows) ? rows : []).forEach(row => {
      if (row.agent) agentPatternCounts[row.agent] = row;
    });
  } catch (err) {
    console.warn('[Agent Network] Pattern counts unavailable:', err.message);
  }
}

// Build tree: each agent's parent is the most recent agent with Level = currentLevel - 1
function buildAgentTree(flatList) {
  const root = { children: [] };
  const stack = [{ level: 0, node: root }];
  [...flatList].sort((a, b) => (Number(a.SeqNumber) || 0) - (Number(b.SeqNumber) || 0)).forEach(agent => {
    const level = Number(agent.Level) || 1;
    const newNode = {
      ...agent,
      agent: (agent.Login || agent.AgentID || '').trim(),
      type: agent.AgentType || 'A',
      commission: Number(agent.HeadCountRateM) || 0,
      level: level,
      children: [],
      expanded: level <= 2, // auto-expand top 2 levels
      playerCount: Number(agent.PlayerCount) || (agent.PLAYERS ? agent.PLAYERS.length : 0),
    };
    // Find correct parent by popping until we find level < current
    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].node;
    parent.children.push(newNode);
    stack.push({ level, node: newNode });
  });
  return root.children;
}

function flattenAgentTree(nodes, depth = 0) {
  let flat = [];
  const renderNodes = agentPatternSortEnabled
    ? [...nodes].sort((a, b) => getAgentPatternCount(b.agent) - getAgentPatternCount(a.agent))
    : nodes;

  renderNodes.forEach(node => {
    node.depth = depth;
    flat.push(node);
    if (node.children && node.children.length) {
      flat = flat.concat(flattenAgentTree(node.children, depth + 1));
    }
  });
  return flat;
}

function mergeAgentStats(nodes) {
  nodes.forEach(node => {
    const stats = agentStatsMap[node.agent];
    if (stats) {
      node.wager_count = stats.wager_count || 0;
      node.total_volume = stats.total_volume || 0;
      node.total_risk = stats.total_risk || 0;
      node.alert_count = stats.alert_count || 0;
      node.live_count = stats.live_count || 0;
      node.player_count = stats.player_count || node.playerCount || 0;
    } else {
      node.wager_count = 0;
      node.total_volume = 0;
      node.total_risk = 0;
      node.alert_count = 0;
      node.live_count = 0;
      node.player_count = node.playerCount || 0;
    }
    if (node.children && node.children.length) {
      mergeAgentStats(node.children);
    }
  });
}

function computeDownlineStats(nodes) {
  nodes.forEach(node => {
    computeDownlineStats(node.children || []);
    const childVolume = (node.children || []).reduce((sum, child) => sum + (child.downline_volume || child.total_volume || 0), 0);
    const childRisk = (node.children || []).reduce((sum, child) => sum + (child.downline_risk || child.total_risk || 0), 0);
    const childPlayers = (node.children || []).reduce((sum, child) => sum + (child.downline_players || child.player_count || 0), 0);
    const childWagers = (node.children || []).reduce((sum, child) => sum + (child.downline_wagers || child.wager_count || 0), 0);
    node.downline_volume = (node.total_volume || 0) + childVolume;
    node.downline_risk = (node.total_risk || 0) + childRisk;
    node.downline_players = (node.player_count || 0) + childPlayers;
    node.downline_wagers = (node.wager_count || 0) + childWagers;
  });
}

function mergeAgentDelta(delta) {
  if (!delta) return;
  const agentId = delta.agent || delta.agentId;
  if (!agentId) return;

  let agent = agentTreeFlat.find(a => a.agent === agentId || String(a.AgentID || '').trim() === agentId);
  if (!agent) {
    agent = {
      agent: agentId,
      AgentID: agentId,
      type: delta.type || 'A',
      level: Number(delta.level) || 1,
      children: [],
      expanded: true,
      player_count: 0,
    };
    agentTreeData.push(agent);
    agentTreeFlat = flattenAgentTree(agentTreeData);
  }

  applyAgentDelta(agent, delta);
  computeDownlineStats(agentTreeData);
  updateAgentSummary(agentTreeFlat);
  updateAgentRow(agent);

  if (currentSection === 'agentTree' && treeCanvas) {
    computeTreeLayout(agentTreeData);
    drawTree();
  }
}

function applyAgentDelta(agent, delta) {
  if (delta.total_volume !== undefined) agent.total_volume = Number(delta.total_volume) || 0;
  if (delta.volume !== undefined) agent.total_volume = Number(delta.volume) || 0;
  if (delta.total_risk !== undefined) agent.total_risk = Number(delta.total_risk) || 0;
  if (delta.risk !== undefined) agent.total_risk = Number(delta.risk) || 0;
  if (delta.wager_count !== undefined) agent.wager_count = Number(delta.wager_count) || 0;
  if (delta.alert_count !== undefined) agent.alert_count = Number(delta.alert_count) || 0;
  if (delta.alerts !== undefined) agent.alert_count = Number(delta.alerts) || 0;
  if (delta.live_count !== undefined) agent.live_count = Number(delta.live_count) || 0;
  if (delta.live !== undefined) agent.live_count = Number(delta.live) || 0;
  if (delta.top_game !== undefined) agent.top_game = delta.top_game;
  if (delta.topGame !== undefined) agent.top_game = delta.topGame;
  if (delta.top_customer !== undefined) agent.top_customer = delta.top_customer;
  if (delta.topCustomer !== undefined) agent.top_customer = delta.topCustomer;
}

function updateAgentRow(agent) {
  const row = document.querySelector(`tr.agent-row[data-agent="${cssEscape(agent.agent)}"]`);
  if (!row) {
    if (currentSection === 'agentNetwork' || currentSection === 'agentTree') {
      renderAgentTree(agentTreeData);
    }
    return;
  }

  const totalVolume = agentTreeFlat.reduce((s, a) => s + (a.total_volume || 0), 0);
  const displayVolume = agent.downline_volume || agent.total_volume || 0;
  const displayRisk = agent.downline_risk || agent.total_risk || 0;
  const displayPlayers = agent.downline_players || agent.player_count || 0;
  const displayWagers = agent.downline_wagers || agent.wager_count || 0;
  const bookPct = getExposurePct(displayRisk, totalVolume);
  const alertBadge = agent.alert_count > 0 ? `<span class="ml-1 text-[10px] px-1 py-0.5 rounded-full" style="background:var(--red);color:#fff;">${agent.alert_count}</span>` : '—';

  const playersCell = row.querySelector('[data-agent-field="players"]');
  const wagersCell = row.querySelector('[data-agent-field="wagers"]');
  const volumeCell = row.querySelector('[data-agent-field="volume"]');
  const riskCell = row.querySelector('[data-agent-field="risk"]');
  const alertsCell = row.querySelector('[data-agent-field="alerts"]');
  const patternsCell = row.querySelector('[data-agent-field="patterns"]');
  if (playersCell) playersCell.textContent = displayPlayers;
  if (wagersCell) wagersCell.textContent = displayWagers;
  if (volumeCell) volumeCell.textContent = displayVolume > 0 ? '$' + Math.round(displayVolume).toLocaleString() : '—';
  if (riskCell) {
    riskCell.innerHTML = `${displayRisk > 0 ? '$' + Math.round(displayRisk).toLocaleString() : '—'} <span style="color:var(--text-dim);font-size:10px;">${bookPct}%</span>`;
    riskCell.title = `${bookPct}% of master book`;
  }
  if (alertsCell) alertsCell.innerHTML = alertBadge;
  if (patternsCell) {
    const patternInfo = agentPatternCounts[agent.agent] || {};
    const patternCount = Number(patternInfo.pattern_count || 0);
    const criticalPatternCount = Number(patternInfo.critical_count || 0);
    patternsCell.innerHTML = patternCount > 0
      ? `<button type="button" class="agent-pattern-badge text-[10px] px-1.5 py-0.5 rounded-full" style="background:${criticalPatternCount > 0 ? 'var(--red)' : 'var(--yellow)'};color:${criticalPatternCount > 0 ? '#fff' : '#111'};" data-action="filter-agent-patterns" data-agent="${escapeHtml(agent.agent)}" title="${criticalPatternCount} critical">${patternIconForAgent(patternInfo)} ${patternCount}</button>`
      : '—';
  }
  row.classList.add('flash-green');
  setTimeout(() => row.classList.remove('flash-green'), 900);
}

function updateAgentSummary(flatAgents) {
  const totalAgents = flatAgents.length;
  const totalPlayers = flatAgents.reduce((s, a) => s + (a.player_count || 0), 0);
  const totalVolume = flatAgents.reduce((s, a) => s + (a.total_volume || 0), 0);
  const totalRisk = flatAgents.reduce((s, a) => s + (a.total_risk || 0), 0);
  document.getElementById('downlineAgentCount').textContent = totalAgents;
  document.getElementById('downlinePlayerCount').textContent = totalPlayers;
  document.getElementById('downlineVolume').textContent = '$' + (totalVolume / 1000000).toFixed(2) + 'M';
  document.getElementById('downlineRisk').textContent = '$' + (totalRisk / 1000000).toFixed(2) + 'M';
}

function renderAgentTree(nodes, parentElement, depth = 0, budget) {
  const tbody = parentElement || document.getElementById('agentDownlineTable');
  if (!tbody) return;
  if (depth === 0) {
    tbody.innerHTML = '';
    budget = { count: 0, truncated: false };
  }

  const totalVolume = agentTreeFlat.reduce((s, a) => s + (a.total_volume || 0), 0);

  nodes.forEach(node => {
    if (budget.count >= TABLE_RENDER_LIMIT) {
      budget.truncated = true;
      return;
    }
    const indent = '&nbsp;'.repeat(depth * 3);
    const agentAttr = escapeHtml(node.agent);
    const agentLabel = escapeHtml(node.agent);
    const expandIcon = node.children && node.children.length
      ? (node.expanded
        ? `<span style="cursor:pointer;color:var(--accent);" data-action="toggle-agent" data-agent="${agentAttr}">▼</span>`
        : `<span style="cursor:pointer;color:var(--accent);" data-action="toggle-agent" data-agent="${agentAttr}">▶</span>`)
      : '<span style="color:var(--text-dim);">•</span>';
    const typeBadge = node.type === 'M'
      ? '<span class="text-[10px] px-1 py-0.5 rounded" style="background:var(--purple);color:#fff;">M</span>'
      : '<span class="text-[10px] px-1 py-0.5 rounded" style="background:var(--border);color:var(--text-dim);">A</span>';
    const alertBadge = node.alert_count > 0 ? `<span class="ml-1 text-[10px] px-1 py-0.5 rounded-full" style="background:var(--red);color:#fff;">${node.alert_count}</span>` : '';
    const patternInfo = agentPatternCounts[node.agent] || {};
    const patternCount = Number(patternInfo.pattern_count || 0);
    const criticalPatternCount = Number(patternInfo.critical_count || 0);
    const patternBadge = patternCount > 0
      ? `<button type="button" class="agent-pattern-badge text-[10px] px-1.5 py-0.5 rounded-full" style="background:${criticalPatternCount > 0 ? 'var(--red)' : 'var(--yellow)'};color:${criticalPatternCount > 0 ? '#fff' : '#111'};" data-action="filter-agent-patterns" data-agent="${agentAttr}" title="${criticalPatternCount} critical">${patternIconForAgent(patternInfo)} ${patternCount}</button>`
      : '—';
    const displayVolume = node.downline_volume || node.total_volume || 0;
    const displayRisk = node.downline_risk || node.total_risk || 0;
    const displayPlayers = node.downline_players || node.player_count || 0;
    const displayWagers = node.downline_wagers || node.wager_count || 0;
    const volumeStr = displayVolume > 0 ? '$' + Math.round(displayVolume).toLocaleString() : '—';
    const riskStr = displayRisk > 0 ? '$' + Math.round(displayRisk).toLocaleString() : '—';
    const commStr = node.commission > 0 ? node.commission + '%' : '—';
    const bookPct = getExposurePct(displayRisk, totalVolume);

    const row = document.createElement('tr');
    row.className = 'agent-row border-b';
    row.dataset.agent = node.agent;
    row.style.borderColor = 'var(--border)';
    row.innerHTML = `
      <td class="px-3 py-2">
        <div class="flex items-center gap-1.5">
          ${expandIcon}
          <span class="font-medium">${indent}${agentLabel}</span>
        </div>
      </td>
      <td class="px-3 py-2 text-center">${node.level}</td>
      <td class="px-3 py-2 text-center">${typeBadge}</td>
      <td class="px-3 py-2 text-center">${commStr}</td>
      <td class="px-3 py-2 text-center" data-agent-field="players">${displayPlayers}</td>
      <td class="px-3 py-2 text-center" data-agent-field="wagers">${displayWagers}</td>
      <td class="px-3 py-2 text-right font-mono" data-agent-field="volume">${volumeStr}</td>
      <td class="px-3 py-2 text-right font-mono" data-agent-field="risk" title="${bookPct}% of master book">${riskStr} <span style="color:var(--text-dim);font-size:10px;">${bookPct}%</span></td>
      <td class="px-3 py-2 text-center" data-agent-field="alerts">${alertBadge || '—'}</td>
      <td class="px-3 py-2 text-center" data-agent-field="patterns">${patternBadge}</td>
      <td class="px-3 py-2 text-center">
        <button type="button" class="px-2 py-1 rounded text-xs" style="background:var(--accent);color:#fff;" data-action="filter-agent" data-agent="${agentAttr}">Wagers</button>
      </td>
    `;
    tbody.appendChild(row);
    budget.count++;

    if (node.expanded && node.children && node.children.length) {
      renderAgentTree(node.children, tbody, depth + 1, budget);
    }
  });

  if (depth === 0 && nodes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">No agents found. Connect to backend or wait for Buckeye archive data.</td></tr>';
  } else if (depth === 0 && budget.truncated) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="11" class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">Showing ${TABLE_RENDER_LIMIT.toLocaleString()} agents. Search to narrow the downline.</td>`;
    tbody.appendChild(row);
  }
}

function getAgentPatternCount(agent) {
  return Number(agentPatternCounts[agent]?.pattern_count || 0);
}

function patternIconForAgent(info) {
  return Number(info.critical_count || 0) > 0 ? '!' : '*';
}

function toggleAgentPatternSort() {
  agentPatternSortEnabled = !agentPatternSortEnabled;
  const icon = document.getElementById('agentPatternSortIcon');
  if (icon) icon.textContent = agentPatternSortEnabled ? '↓' : '';
  renderAgentTree(agentTreeData);
}

function pulseAgentPatternRow(agent) {
  const row = document.querySelector(`tr.agent-row[data-agent="${cssEscape(agent)}"]`);
  if (!row) return;
  row.classList.add('agent-pattern-pulse');
  setTimeout(() => row.classList.remove('agent-pattern-pulse'), 3000);
}

function pulseAgentPatternBadge(agent) {
  const row = document.querySelector(`tr.agent-row[data-agent="${cssEscape(agent)}"]`);
  if (!row) return;
  const badge = row.querySelector('[data-agent-field="patterns"] .agent-pattern-badge');
  if (badge) {
    badge.classList.add('pattern-badge-pulse');
    setTimeout(() => badge.classList.remove('pattern-badge-pulse'), 2000);
  }
  // Also pulse the row for visibility
  row.classList.add('agent-pattern-pulse');
  setTimeout(() => row.classList.remove('agent-pattern-pulse'), 3000);
}

function toggleAgentExpand(agentLogin, event) {
  if (event) event.stopPropagation();
  const node = agentTreeFlat.find(a => a.agent === agentLogin);
  if (node && node.children && node.children.length) {
    node.expanded = !node.expanded;
    renderAgentTree(agentTreeData);
  }
}

function handleAgentDownlineClick(event) {
  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget || !event.currentTarget.contains(actionTarget)) return;
  event.preventDefault();
  event.stopPropagation();

  if (actionTarget.dataset.action === 'toggle-agent') {
    toggleAgentExpand(actionTarget.dataset.agent);
  } else if (actionTarget.dataset.action === 'filter-agent') {
    filterTickerByAgent(actionTarget.dataset.agent);
  } else if (actionTarget.dataset.action === 'filter-agent-patterns') {
    openPatternsForAgent(actionTarget.dataset.agent);
  }
}

function openPatternsForAgent(agent) {
  switchSection('patterns', getSidebarButton('patterns'));
  const agentSelect = document.getElementById('patternAgentFilter');
  if (agentSelect) {
    if (![...agentSelect.options].some(opt => opt.value === agent)) {
      agentSelect.add(new Option(agent, agent));
    }
    agentSelect.value = agent;
  }
  patternCategory = 'all';
  sectionCache.patterns.at = 0;
  loadPatterns(true);
}

function searchAgentTree() {
  scheduleTask('agentSearch', runAgentTreeSearch, 100);
}

function runAgentTreeSearch() {
  const query = (document.getElementById('agentSearchInput')?.value || '').toLowerCase().trim();
  if (!query) {
    renderAgentTree(agentTreeData);
    return;
  }
  const filtered = agentTreeFlat.filter(a => a.agent.toLowerCase().includes(query));
  const tbody = document.getElementById('agentDownlineTable');
  if (!tbody) return;
  tbody.innerHTML = '';
  const visible = filtered.slice(0, TABLE_RENDER_LIMIT);
  visible.forEach(node => {
    const agentAttr = escapeHtml(node.agent);
    const agentLabel = escapeHtml(node.agent);
    const typeBadge = node.type === 'M'
      ? '<span class="text-[10px] px-1 py-0.5 rounded" style="background:var(--purple);color:#fff;">M</span>'
      : '<span class="text-[10px] px-1 py-0.5 rounded" style="background:var(--border);color:var(--text-dim);">A</span>';
    const alertBadge = node.alert_count > 0 ? `<span class="ml-1 text-[10px] px-1 py-0.5 rounded-full" style="background:var(--red);color:#fff;">${node.alert_count}</span>` : '';
    const volumeStr = node.total_volume > 0 ? '$' + Math.round(node.total_volume).toLocaleString() : '—';
    const riskStr = node.total_risk > 0 ? '$' + Math.round(node.total_risk).toLocaleString() : '—';
    const commStr = node.commission > 0 ? node.commission + '%' : '—';
    const row = document.createElement('tr');
    row.className = 'border-b';
    row.style.borderColor = 'var(--border)';
    row.innerHTML = `
      <td class="px-3 py-2"><span class="font-medium">${agentLabel}</span></td>
      <td class="px-3 py-2 text-center">${node.level}</td>
      <td class="px-3 py-2 text-center">${typeBadge}</td>
      <td class="px-3 py-2 text-center">${commStr}</td>
      <td class="px-3 py-2 text-center">${node.player_count || 0}</td>
      <td class="px-3 py-2 text-center">${node.wager_count || 0}</td>
      <td class="px-3 py-2 text-right font-mono">${volumeStr}</td>
      <td class="px-3 py-2 text-right font-mono">${riskStr}</td>
      <td class="px-3 py-2 text-center">${alertBadge || '—'}</td>
      <td class="px-3 py-2 text-center">
        <button type="button" class="px-2 py-1 rounded text-xs" style="background:var(--accent);color:#fff;" data-action="filter-agent" data-agent="${agentAttr}">Wagers</button>
      </td>
    `;
    tbody.appendChild(row);
  });
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">No agents match your search.</td></tr>';
  } else if (filtered.length > TABLE_RENDER_LIMIT) {
    tbody.innerHTML += `<tr><td colspan="10" class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">Showing ${TABLE_RENDER_LIMIT.toLocaleString()} of ${filtered.length.toLocaleString()} matching agents.</td></tr>`;
  }
}

function deriveAgentDownlineFromStatic() {
  const map = {};
  buckeyeWagers.forEach(w => {
    const a = w.AgentLogin;
    if (!map[a]) {
      map[a] = { agent_login: a, wager_count: 0, player_count: 0, total_volume: 0, total_risk: 0, alert_count: 0, live_count: 0, last_wager_at: w.InsertDateTime, players: {} };
    }
    map[a].wager_count++;
    map[a].total_volume += w.AmountWagered;
    map[a].total_risk += getWagerExposure(w);
    if (w.TicketWriter === 'ALERT') map[a].alert_count++;
    if (w.TicketWriter === 'GSLIVE') map[a].live_count++;
    const p = w.Login;
    if (!map[a].players[p]) map[a].players[p] = 0;
    map[a].players[p] += getWagerExposure(w);
  });
  Object.keys(map).forEach(a => {
    map[a].player_count = Object.keys(map[a].players).length;
  });
  // Convert flat map to simple tree (all at level 1)
  agentTreeData = Object.values(map).map(s => ({
    agent: s.agent_login,
    type: 'A',
    commission: 0,
    level: 1,
    children: [],
    expanded: false,
    playerCount: s.player_count,
    wager_count: s.wager_count,
    total_volume: s.total_volume,
    total_risk: s.total_risk,
    alert_count: s.alert_count,
    live_count: s.live_count,
    player_count: s.player_count,
  }));
  agentTreeFlat = agentTreeData;
  renderAgentTree(agentTreeData);
  updateAgentSummary(agentTreeFlat);
  return agentTreeFlat.length;
}

// ==================== CANVAS TREE VIEW ====================
let treeCanvas = null;
let treeCtx = null;
let treeLayoutNodes = []; // nodes with computed x,y,parent
let treeView = { x: 0, y: 0, scale: 1 };
let treeIsDragging = false;
let treeDidDrag = false;
let treeDragStart = { x: 0, y: 0 };
let treeDragViewStart = { x: 0, y: 0 };
let treeHoveredNode = null;
let treeAnimFrame = null;
const NODE_RADIUS = 14;
const VERTICAL_SPACING = 55;
const HORIZONTAL_SPACING = 22;

function toggleAgentView() {
  const tableContainer = document.getElementById('agentTableContainer');
  const canvasContainer = document.getElementById('agentCanvasContainer');
  const btn = document.getElementById('toggleAgentViewBtn');
  const title = document.getElementById('agentNetworkTitle');
  if (!tableContainer || !canvasContainer || !btn) return;
  if (tableContainer.style.display !== 'none') {
    tableContainer.style.display = 'none';
    canvasContainer.style.display = 'block';
    btn.textContent = 'Table View';
    if (title) title.textContent = 'Agent Tree Hierarchy';
    initAgentCanvas();
  } else {
    canvasContainer.style.display = 'none';
    tableContainer.style.display = 'block';
    btn.textContent = 'Tree View';
    if (title) title.textContent = 'Agent Downline';
    stopAgentCanvas();
  }
}

function setAgentNetworkMode(mode) {
  const tableContainer = document.getElementById('agentTableContainer');
  const canvasContainer = document.getElementById('agentCanvasContainer');
  const btn = document.getElementById('toggleAgentViewBtn');
  const title = document.getElementById('agentNetworkTitle');
  if (!tableContainer || !canvasContainer) return;

  if (mode === 'tree') {
    tableContainer.style.display = 'none';
    canvasContainer.style.display = 'block';
    if (btn) btn.textContent = 'Table View';
    if (title) title.textContent = 'Agent Tree Hierarchy';
    if (agentTreeData.length === 0) setAgentTreeLoading(true);
    initAgentCanvas();
  } else {
    canvasContainer.style.display = 'none';
    tableContainer.style.display = 'block';
    if (btn) btn.textContent = 'Tree View';
    if (title) title.textContent = 'Agent Downline';
    stopAgentCanvas();
  }
}

function stopAgentCanvas() {
  if (treeAnimFrame) {
    cancelAnimationFrame(treeAnimFrame);
    treeAnimFrame = null;
  }
  if (tooltipEl) tooltipEl.classList.remove('visible');
}

function initAgentCanvas() {
  const canvas = document.getElementById('agentCanvas');
  if (!canvas) return;
  const container = document.getElementById('agentCanvasContainer');
  if (!container) return;
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  treeCanvas = canvas;
  treeCtx = canvas.getContext('2d');

  // Compute layout from current agentTreeData
  computeTreeLayout(agentTreeData);

  // Center view on the computed tree bounds
  if (treeLayoutNodes.length > 0) {
    fitTreeToCanvas();
  }

  // Bind events once
  if (!canvas._treeEventsBound) {
    canvas.addEventListener('mousedown', onTreeCanvasMouseDown);
    canvas.addEventListener('mousemove', onTreeCanvasMouseMove);
    canvas.addEventListener('mouseup', onTreeCanvasMouseUp);
    canvas.addEventListener('mouseleave', onTreeCanvasMouseUp);
    canvas.addEventListener('wheel', onTreeCanvasWheel, { passive: false });
    canvas._treeEventsBound = true;
  }

  if (!treeAnimFrame) {
    treeAnimFrame = requestAnimationFrame(renderTreeLoop);
  }
}

function computeTreeLayout(treeRoots) {
  treeLayoutNodes = [];
  const roots = Array.isArray(treeRoots) ? treeRoots.filter(Boolean) : [];
  if (roots.length === 0) return;

  const layoutRoot = roots.length === 1
    ? roots[0]
    : {
        agent: localStorage.getItem('agentId') || 'DOWNLINE',
        type: 'M',
        level: 0,
        total_volume: roots.reduce((s, n) => s + (n.total_volume || 0), 0),
        total_risk: roots.reduce((s, n) => s + (n.total_risk || 0), 0),
        player_count: roots.reduce((s, n) => s + (n.player_count || 0), 0),
        wager_count: roots.reduce((s, n) => s + (n.wager_count || 0), 0),
        children: roots,
        virtualRoot: true,
      };

  const getVisibleChildren = node => (node.children || []).filter(Boolean);
  const childNodes = getVisibleChildren(layoutRoot);
  const flatDownline = childNodes.length > 12 && childNodes.every(n => !n.children || n.children.length === 0);
  if (flatDownline) {
    const columnWidth = 78;
    const rowHeight = 76;
    const canvasWidth = treeCanvas?.width || 900;
    const columns = Math.max(6, Math.min(14, Math.floor((canvasWidth - 120) / columnWidth)));
    const totalWidth = (Math.min(columns, childNodes.length) - 1) * columnWidth;
    layoutRoot.x = totalWidth / 2;
    layoutRoot.y = 58;
    layoutRoot.depth = 0;
    layoutRoot.parent = null;
    treeLayoutNodes.push(layoutRoot);
    childNodes.forEach((node, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      node.x = col * columnWidth;
      node.y = 160 + row * rowHeight;
      node.depth = row + 1;
      node.parent = layoutRoot;
      treeLayoutNodes.push(node);
    });
    return;
  }

  let cursorX = 0;
  function walk(node, depth, parent) {
    const children = node.expanded === false && !node.virtualRoot ? [] : getVisibleChildren(node);
    if (children.length === 0) {
      node.x = cursorX;
      cursorX += NODE_RADIUS * 3 + HORIZONTAL_SPACING;
    } else {
      const startX = cursorX;
      for (const child of children) {
        walk(child, depth + 1, node);
      }
      const endX = cursorX - (NODE_RADIUS * 3 + HORIZONTAL_SPACING);
      node.x = (startX + endX) / 2;
    }
    node.y = depth * VERTICAL_SPACING + 58;
    node.depth = depth;
    node.parent = parent;
    treeLayoutNodes.push(node);
  }
  walk(layoutRoot, 0, null);
}

function fitTreeToCanvas() {
  if (!treeCanvas || treeLayoutNodes.length === 0) return;
  const xs = treeLayoutNodes.map(n => n.x);
  const ys = treeLayoutNodes.map(n => n.y);
  const minX = Math.min(...xs) - 70;
  const maxX = Math.max(...xs) + 70;
  const minY = Math.min(...ys) - 55;
  const maxY = Math.max(...ys) + 75;
  const treeWidth = Math.max(1, maxX - minX);
  const treeHeight = Math.max(1, maxY - minY);
  treeView.scale = Math.min(1, treeCanvas.width / treeWidth, treeCanvas.height / treeHeight);
  treeView.scale = Math.max(0.18, treeView.scale);
  treeView.x = (treeCanvas.width - treeWidth * treeView.scale) / 2 - minX * treeView.scale;
  treeView.y = (treeCanvas.height - treeHeight * treeView.scale) / 2 - minY * treeView.scale;
}

function renderTreeLoop() {
  const canvasContainer = document.getElementById('agentCanvasContainer');
  const isAgentSection = currentSection === 'agentNetwork' || currentSection === 'agentTree';
  if (!isAgentSection || (canvasContainer && canvasContainer.style.display === 'none')) {
    treeAnimFrame = null;
    return;
  }
  treeAnimFrame = requestAnimationFrame(renderTreeLoop);
  if (!treeCanvas || !treeCtx) return;
  const canvas = treeCanvas;
  const container = canvasContainer;
  if (container && (canvas.width !== container.clientWidth || canvas.height !== container.clientHeight)) {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
  }

  treeCtx.setTransform(1, 0, 0, 1, 0, 0);
  treeCtx.clearRect(0, 0, canvas.width, canvas.height);

  if (treeLayoutNodes.length === 0) {
    treeCtx.fillStyle = 'rgba(148,163,184,0.9)';
    treeCtx.font = '13px sans-serif';
    treeCtx.textAlign = 'center';
    treeCtx.textBaseline = 'middle';
    treeCtx.fillText(agentTreeStatusMessage, canvas.width / 2, canvas.height / 2);
    return;
  }

  treeCtx.save();
  treeCtx.translate(treeView.x, treeView.y);
  treeCtx.scale(treeView.scale, treeView.scale);

  // Compute viewport bounds for culling
  const margin = NODE_RADIUS * 4;
  const invScale = 1 / treeView.scale;
  const vMinX = -treeView.x * invScale - margin;
  const vMaxX = (canvas.width - treeView.x) * invScale + margin;
  const vMinY = -treeView.y * invScale - margin;
  const vMaxY = (canvas.height - treeView.y) * invScale + margin;

  // Draw edges first
  treeCtx.strokeStyle = 'rgba(100,116,139,0.35)';
  treeCtx.lineWidth = 1.2;
  for (const node of treeLayoutNodes) {
    if (!node.parent) continue;
    if (node.x < vMinX || node.x > vMaxX || node.y < vMinY || node.y > vMaxY) continue;
    treeCtx.beginPath();
    treeCtx.moveTo(node.x, node.y);
    treeCtx.lineTo(node.parent.x, node.parent.y);
    treeCtx.stroke();
  }

  // Draw nodes
  for (const node of treeLayoutNodes) {
    if (node.x < vMinX || node.x > vMaxX || node.y < vMinY || node.y > vMaxY) continue;

    const isHover = treeHoveredNode === node;
    const isMaster = node.type === 'M';

    // Glow for hover
    if (isHover) {
      treeCtx.beginPath();
      treeCtx.arc(node.x, node.y, NODE_RADIUS + 6, 0, Math.PI * 2);
      treeCtx.fillStyle = 'rgba(59,130,246,0.25)';
      treeCtx.fill();
    }

    // Circle
    treeCtx.beginPath();
    treeCtx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
    if (isHover) {
      treeCtx.fillStyle = '#3b82f6';
    } else if (isMaster) {
      treeCtx.fillStyle = '#7c3aed'; // purple for Master
    } else {
      treeCtx.fillStyle = '#0d9488'; // teal for Agent
    }
    treeCtx.fill();

    // Border
    treeCtx.strokeStyle = isHover ? '#fff' : 'rgba(255,255,255,0.4)';
    treeCtx.lineWidth = isHover ? 2 : 1;
    treeCtx.stroke();

    // Label
    treeCtx.fillStyle = '#fff';
    treeCtx.font = `bold ${10}px sans-serif`;
    treeCtx.textAlign = 'center';
    treeCtx.textBaseline = 'middle';
    const label = node.agent.substring(0, node.virtualRoot ? 6 : 4).toUpperCase();
    treeCtx.fillText(label, node.x, node.y);

    // Level / Type label below
    treeCtx.fillStyle = 'rgba(148,163,184,0.9)';
    treeCtx.font = `${9}px sans-serif`;
    const subLabel = node.virtualRoot ? `${node.children?.length || 0} agents` : `L${node.level} ${node.type}`;
    treeCtx.fillText(subLabel, node.x, node.y + NODE_RADIUS + 11);

    if (node.children && node.children.length > 0 && !node.virtualRoot) {
      treeCtx.beginPath();
      treeCtx.arc(node.x + NODE_RADIUS - 1, node.y - NODE_RADIUS + 1, 6, 0, Math.PI * 2);
      treeCtx.fillStyle = node.expanded ? '#f97316' : '#1d4ed8';
      treeCtx.fill();
      treeCtx.fillStyle = '#fff';
      treeCtx.font = 'bold 9px sans-serif';
      treeCtx.fillText(node.expanded ? '-' : '+', node.x + NODE_RADIUS - 1, node.y - NODE_RADIUS + 1);
    }
  }

  treeCtx.restore();
}

function treeScreenToWorld(sx, sy) {
  return {
    x: (sx - treeView.x) / treeView.scale,
    y: (sy - treeView.y) / treeView.scale
  };
}

function findTreeNodeAt(worldX, worldY) {
  const threshold = NODE_RADIUS + 3;
  for (let i = treeLayoutNodes.length - 1; i >= 0; i--) {
    const n = treeLayoutNodes[i];
    const dx = n.x - worldX;
    const dy = n.y - worldY;
    if (dx * dx + dy * dy <= threshold * threshold) return n;
  }
  return null;
}

function onTreeCanvasMouseDown(e) {
  treeIsDragging = true;
  treeDidDrag = false;
  treeDragStart = { x: e.offsetX, y: e.offsetY };
  treeDragViewStart = { x: treeView.x, y: treeView.y };
}

function onTreeCanvasMouseMove(e) {
  const world = treeScreenToWorld(e.offsetX, e.offsetY);
  const prevHover = treeHoveredNode;
  treeHoveredNode = findTreeNodeAt(world.x, world.y);

  if (treeIsDragging) {
    const dx = e.offsetX - treeDragStart.x;
    const dy = e.offsetY - treeDragStart.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) treeDidDrag = true;
    treeView.x = treeDragViewStart.x + (e.offsetX - treeDragStart.x);
    treeView.y = treeDragViewStart.y + (e.offsetY - treeDragStart.y);
  }
  e.currentTarget.style.cursor = treeHoveredNode
    ? (treeHoveredNode.children?.length ? 'pointer' : 'grab')
    : (treeIsDragging ? 'grabbing' : 'grab');

  // Tooltip
  if (treeHoveredNode) {
    const n = treeHoveredNode;
    const html = `<div class="font-semibold">${n.agent}</div>
      <div class="text-[10px] mt-0.5" style="color:var(--text-dim);">Level ${n.level} • ${n.type === 'M' ? 'Master' : 'Agent'}</div>
      <div class="text-[10px]" style="color:var(--text-dim);">Commission: ${n.commission || 0}%</div>
      <div class="text-[10px]" style="color:var(--text-dim);">Children: ${n.children?.length || 0}</div>
      <div class="text-[10px]" style="color:var(--text-dim);">Players: ${n.downline_players || n.player_count || 0}</div>
      ${(n.downline_volume || n.total_volume) > 0 ? `<div class="text-[10px]" style="color:var(--text-dim);">Volume: $${Math.round(n.downline_volume || n.total_volume).toLocaleString()}</div>` : ''}`;
    if (tooltipContentEl) tooltipContentEl.innerHTML = html;
    if (tooltipEl) {
      tooltipEl.classList.add('visible');
      const tipRect = tooltipEl.getBoundingClientRect();
      let left = e.clientX + 12;
      let top = e.clientY + 12;
      if (left + tipRect.width > window.innerWidth - 8) left = e.clientX - tipRect.width - 12;
      if (top + tipRect.height > window.innerHeight - 8) top = e.clientY - tipRect.height - 12;
      tooltipEl.style.left = left + 'px';
      tooltipEl.style.top = top + 'px';
    }
  } else if (prevHover) {
    if (tooltipEl) tooltipEl.classList.remove('visible');
  }
}

function onTreeCanvasMouseUp(e) {
  if (!treeDidDrag && treeHoveredNode && treeHoveredNode.children && treeHoveredNode.children.length > 0 && !treeHoveredNode.virtualRoot) {
    treeHoveredNode.expanded = !treeHoveredNode.expanded;
    computeTreeLayout(agentTreeData);
    fitTreeToCanvas();
    renderAgentTree(agentTreeData);
  }
  treeIsDragging = false;
}

function onTreeCanvasWheel(e) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.88 : 1.14;
  const worldBefore = treeScreenToWorld(e.offsetX, e.offsetY);
  treeView.scale *= delta;
  // Clamp zoom
  if (treeView.scale < 0.2) treeView.scale = 0.2;
  if (treeView.scale > 3) treeView.scale = 3;
  const worldAfter = treeScreenToWorld(e.offsetX, e.offsetY);
  treeView.x += (worldAfter.x - worldBefore.x) * treeView.scale;
  treeView.y += (worldAfter.y - worldBefore.y) * treeView.scale;
}

function filterTickerByAgent(agentLogin) {
  switchSection('buckeye', getSidebarButton('buckeye'));
  // Filter the wager table to this agent
  const originalFilter = buckeyeFilter;
  buckeyeFilter = 'all';
  // Temporarily override render to filter by agent
  const tbody = document.getElementById('buckeyeWagerTable');
  if (!tbody) return;
  let filtered = buckeyeWagers.filter(w => w.AgentLogin === agentLogin);
  filtered.sort((a, b) => new Date(b.InsertDateTime) - new Date(a.InsertDateTime));
  const totalFiltered = filtered.length;
  filtered = filtered.slice(0, TABLE_RENDER_LIMIT);
  tbody.innerHTML = filtered.map(w => {
    const typeInfo = WAGER_TYPES[detectWagerType(w)] || { label: w.WagerType, color: '#6b7280' };
    const isAlert = w.TicketWriter === 'ALERT';
    const isLive = w.TicketWriter === 'GSLIVE';
    const rowClass = isAlert ? 'alert-row' : isLive ? 'gslive-row' : '';
    const dt = new Date(w.InsertDateTime);
    const timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const cleanDesc = parseDescription(w.ShortDesc);
    const fullDesc = w.ShortDesc;
    const sport = parseSport(w.ShortDesc);
    const league = parseLeague(w.ShortDesc);
    const price = extractPrice(w.ShortDesc);
    const risk = w.VolumeAmount > 0 ? '$' + w.VolumeAmount.toLocaleString() : '<span style="color:var(--red)">PENDING</span>';
    const win = '$' + w.ToWinAmount.toLocaleString();
    let sourceBadge = '';
    if (isAlert) sourceBadge = '<span class="px-1.5 py-0.5 rounded text-xs font-bold" style="background:var(--red);color:#fff;">ALERT</span>';
    else if (isLive) sourceBadge = '<span class="px-1.5 py-0.5 rounded text-xs font-bold" style="background:var(--cyan);color:#fff;">GSLIVE</span>';
    else sourceBadge = '<span class="px-1.5 py-0.5 rounded text-xs" style="background:var(--bg);color:var(--text-dim);border:1px solid var(--border);">Internet</span>';
    return `<tr class="${rowClass} border-b transition-colors hover:bg-opacity-50 cursor-pointer" data-player="${escapeHtml(w.Login)}" style="border-color:var(--border);" title="${escapeHtml(fullDesc)}">
      <td class="px-3 py-2 font-medium hover:underline" style="color:var(--accent);" data-action="view-player" data-player="${escapeHtml(w.Login)}">${escapeHtml(w.Login)}</td>
      <td class="px-3 py-2 text-center"><span class="px-1.5 py-0.5 rounded text-xs font-bold" style="background:${typeInfo.color}22;color:${typeInfo.color};">${escapeHtml(typeInfo.label)}</span></td>
      <td class="px-3 py-2">${escapeHtml(w.AgentLogin)}</td>
      <td class="px-3 py-2"><span class="px-1.5 py-0.5 rounded text-xs" style="background:var(--bg);color:var(--text-dim);border:1px solid var(--border);">${escapeHtml(sport)}</span></td>
      <td class="px-3 py-2"><span class="px-1.5 py-0.5 rounded text-xs" style="background:var(--bg);color:var(--text-dim);border:1px solid var(--border);">${escapeHtml(league || '—')}</span></td>
      <td class="px-3 py-2" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(fullDesc)}">${escapeHtml(cleanDesc)}</td>
      <td class="px-3 py-2 text-right font-mono">${risk}</td>
      <td class="px-3 py-2 text-right font-mono">${win}</td>
      <td class="px-3 py-2 text-center">${price ? `<span class="font-mono">${escapeHtml(price)}</span>` : '—'}</td>
      <td class="px-3 py-2 text-center">${sourceBadge}</td>
      <td class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">${timeStr}</td>
    </tr>`;
  }).join('');
  if (totalFiltered > TABLE_RENDER_LIMIT) {
    tbody.innerHTML += `<tr><td colspan="11" class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">Showing ${TABLE_RENDER_LIMIT.toLocaleString()} of ${totalFiltered.toLocaleString()} wagers for ${agentLogin}.</td></tr>`;
  }
  showToast(`Showing wagers for agent: ${agentLogin}`, 'info');
}

// ==================== PLAYER SEARCH & DETAIL ====================
function searchPlayers() {
  playerSearchState.query = document.getElementById('playerSearchInput')?.value?.trim() || '';
  FactoryWager.utils.debounce('playerSearch', () => loadPlayerSearch(true));
}

async function loadPlayerSearch(force = false) {
  const tbody = document.getElementById('playerSearchTable');
  if (!tbody) return;
  const agent = document.getElementById('playerAgentFilter')?.value || '';
  const from = document.getElementById('playerFromFilter')?.value || '';
  const to = document.getElementById('playerToFilter')?.value || '';
  playerSearchState.agent = agent;
  playerSearchState.from = from;
  playerSearchState.to = to;
  if (playerSearchState.loading && !force) return;

  playerSearchState.loading = true;
  tbody.innerHTML = '<tr><td colspan="7" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">Searching archived players...</td></tr>';

  try {
    const payload = await FactoryWager.apiFetch('/players/search', {
      query: {
        q: playerSearchState.query,
        agent,
        from,
        to,
        sort: playerSearchState.sort || 'volume',
      },
    });
    playerSearchState.players = payload.players || [];
    playerSearchState.agents = payload.agentOptions || payload.agents || playerSearchState.agents || [];
    renderPlayerAgentFilter();
    renderPlayerSearch();
    renderPlayerSearchSuggestions();
  } catch (err) {
    console.warn('[Players] Search failed, falling back to loaded wagers:', err?.message || err);
    renderPlayerSearchFallback(playerSearchState.query.toLowerCase());
  } finally {
    playerSearchState.loading = false;
  }
}

function renderPlayerAgentFilter() {
  const select = document.getElementById('playerAgentFilter');
  if (!select) return;
  const selected = select.value;
  const agents = normalizePlayerSearchAgents(playerSearchState.agents);
  select.innerHTML = '<option value="">All agents</option>' + agents.map(agent => {
    const label = `${agent.agentLogin || agent.agentId}${agent.level ? ` · L${agent.level}` : ''}${agent.agentType ? ` ${agent.agentType}` : ''}`;
    return `<option value="${escapeHtml(agent.agentId || agent.agentLogin)}">${escapeHtml(label)}</option>`;
  }).join('');
  select.value = agents.some(agent => (agent.agentId || agent.agentLogin) === selected) ? selected : '';
}

function normalizePlayerSearchAgents(agents) {
  const seen = new Set();
  return (agents || []).map(agent => {
    if (typeof agent === 'string') return { agentId: agent, agentLogin: agent, level: null, agentType: '' };
    return {
      agentId: agent.agentId || agent.id || agent.agentLogin || '',
      agentLogin: agent.agentLogin || agent.login || agent.agentId || '',
      level: agent.level || agent.Level || null,
      agentType: agent.agentType || agent.AgentType || '',
    };
  }).filter(agent => {
    const key = agent.agentId || agent.agentLogin;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderPlayerSearch() {
  const tbody = document.getElementById('playerSearchTable');
  if (!tbody) return;
  const players = playerSearchState.players || [];
  const meta = document.getElementById('playerSearchMeta');
  if (meta) {
    meta.textContent = `${players.length.toLocaleString()} player${players.length === 1 ? '' : 's'} from wager archive · sorted by ${playerSearchState.sort}`;
  }

  tbody.innerHTML = players.map(p => playerSearchRow(p)).join('');
  renderPlayerSearchSuggestions();

  if (players.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">No players found.</td></tr>';
  }
}

function renderPlayerSearchFallback(query = '') {
  const tbody = document.getElementById('playerSearchTable');
  if (!tbody) return;
  const playerMap = {};
  buckeyeWagers.forEach(w => {
    const p = w.Login;
    if (!playerMap[p]) {
      playerMap[p] = { login: p, agent_login: w.AgentLogin, wager_count: 0, total_volume: 0, total_risk: 0 };
    }
    playerMap[p].wager_count++;
    playerMap[p].total_volume += w.AmountWagered;
    playerMap[p].total_risk += getWagerExposure(w);
  });

  let players = Object.values(playerMap);
  if (query) {
    players = players.filter(p => p.login.toLowerCase().includes(query));
  }
  players.sort((a, b) => b.total_volume - a.total_volume);
  playerSearchState.players = players.map(p => ({
    login: p.login,
    customerId: p.login,
    agentLogin: p.agent_login,
    wagerCount: p.wager_count,
    totalVolume: p.total_volume,
    totalRisk: p.total_risk,
    riskScore: Math.min(100, Math.round(p.total_risk / 1000)),
    lastWagerAt: '',
  }));

  const visiblePlayers = playerSearchState.players.slice(0, TABLE_RENDER_LIMIT);
  tbody.innerHTML = visiblePlayers.map(p => playerSearchRow(p)).join('');

  if (playerSearchState.players.length > TABLE_RENDER_LIMIT) {
    tbody.innerHTML += `<tr><td colspan="7" class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">Showing ${TABLE_RENDER_LIMIT.toLocaleString()} of ${playerSearchState.players.length.toLocaleString()} players. Search to narrow results.</td></tr>`;
  }

  if (playerSearchState.players.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">No players found.</td></tr>';
  }
  renderPlayerSearchSuggestions();
}

function renderPlayerSearchSuggestions() {
  const list = document.getElementById('playerSearchSuggestions');
  if (!list) return;
  list.innerHTML = (playerSearchState.players || [])
    .slice(0, 40)
    .map(p => `<option value="${escapeHtml(p.login || p.customerId || '')}">${escapeHtml(p.agentLogin || '')}</option>`)
    .join('');
}

function playerSearchRow(p) {
  const playerId = p.login || p.customerId || '';
  const risk = Number(p.riskScore || 0);
  const riskColor = risk >= 80 ? 'var(--red)' : risk >= 55 ? 'var(--yellow)' : 'var(--green)';
  const agentLabel = p.agentLogin || p.agentId || '';
  const agentMeta = [p.agentId && p.agentId !== p.agentLogin ? p.agentId : '', p.agentLevel ? `L${p.agentLevel}` : '', p.agentType || ''].filter(Boolean).join(' · ');
  return `<tr class="border-b cursor-pointer" data-player="${escapeHtml(playerId)}" style="border-color:var(--border);">
    <td class="px-3 py-2 font-medium hover:underline" style="color:var(--accent);">${escapeHtml(playerId)}</td>
    <td class="px-3 py-2"><div class="font-mono">${escapeHtml(agentLabel)}</div>${agentMeta ? `<div class="text-[10px]" style="color:var(--text-dim);">${escapeHtml(agentMeta)}</div>` : ''}</td>
    <td class="px-3 py-2 text-center">${Number(p.wagerCount || 0).toLocaleString()}</td>
    <td class="px-3 py-2 text-right font-mono">$${Math.round(Number(p.totalVolume || 0)).toLocaleString()}</td>
    <td class="px-3 py-2 text-right font-mono"><span style="color:${riskColor};">${risk}</span></td>
    <td class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">${p.lastWagerAt ? formatShortDateTime(p.lastWagerAt) : '-'}</td>
    <td class="px-3 py-2 text-center">
      <button type="button" class="px-2 py-1 rounded text-xs" style="background:var(--accent);color:#fff;" data-player="${escapeHtml(playerId)}">View</button>
    </td>
  </tr>`;
}

function viewPlayer(playerLogin, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!playerLogin) return false;
  openPlayerProfileModal(playerLogin);
  return false;
}

function handlePlayerSearchClick(event) {
  const playerTarget = event.target.closest('[data-player]');
  if (!playerTarget || !event.currentTarget.contains(playerTarget)) return;
  event.preventDefault();
  event.stopPropagation();
  viewPlayer(playerTarget.dataset.player);
}

function handleBuckeyeWagerTableClick(event) {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget && event.currentTarget.contains(actionTarget)) {
    event.preventDefault();
    event.stopPropagation();
    if (actionTarget.dataset.action === 'view-player') {
      viewPlayer(actionTarget.dataset.player);
    } else if (actionTarget.dataset.action === 'filter-agent') {
      filterTickerByAgent(actionTarget.dataset.agent);
    }
    return;
  }

  const playerRow = event.target.closest('tr[data-player]');
  if (playerRow && event.currentTarget.contains(playerRow)) {
    event.preventDefault();
    viewPlayer(playerRow.dataset.player);
    return;
  }

  const wagerRow = event.target.closest('tr[data-wager-number]');
  if (wagerRow && event.currentTarget.contains(wagerRow)) {
    const wagerNumber = Number(wagerRow.dataset.wagerNumber);
    if (Number.isFinite(wagerNumber) && wagerNumber > 0) showWagerDetail(wagerNumber);
  }
}

function backFromPlayerDetail() {
  switchSection(previousSection, null);
}

async function openPlayerProfileModal(playerId) {
  const modal = document.getElementById('playerProfileModal');
  if (!modal) return;
  playerProfileState.playerId = playerId;
  playerProfileState.profile = null;
  playerProfileState.intelligenceMap = null;
  playerProfileState.docsLoading = false;
  playerProfileState.statusLoading = false;
  playerProfileState.statusMap = null;
  playerProfileState.statusEndpointChecks = [];
  playerProfileState.tab = 'overview';
  playerProfileState.transactionTab = 'all';
  playerProfileState.wagerPage = 1;
  playerProfileState.accessLogLive = [];
  playerProfileState.accessLogFilters = { actions: 'A', customerId: '', start: '', end: '', ip: '' };
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.getElementById('playerProfileTitle').textContent = playerId;
  document.getElementById('playerProfileSubhead').textContent = 'Loading archive profile...';
  renderPlayerProfileLoading();
  FactoryWager.actions.subscribePlayerWagers(playerId);
  if (!history.state?.playerProfile) {
    history.pushState({ playerProfile: true, playerId }, '', `#player=${encodeURIComponent(playerId)}`);
  }

  try {
    playerProfileState.profile = await fetchPlayerProfile(playerId);
    configurePlayerProfileExports(playerId);
    renderPlayerProfile();
  } catch (err) {
    console.warn('[Players] Profile failed:', err?.message || err);
    playerProfileState.profile = null;
    configurePlayerProfileExports(playerId);
    renderPlayerProfileError(playerId, err);
  }
}

function renderPlayerProfileError(playerId, err) {
  const message = err?.message || String(err || 'Profile unavailable');
  const panels = ['playerProfileOverview', 'playerProfileWagers', 'playerProfileAccess', 'playerProfilePerformance', 'playerProfileDeposits', 'playerProfileTransactions', 'playerProfileAccount', 'playerProfileAgent', 'playerProfileLinks', 'playerProfileNotes', 'playerProfileStatus', 'playerProfileDocs'];
  panels.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<div class="profile-doc-panel">
      <h3>Real API profile unavailable</h3>
      <p class="text-sm" style="color:var(--text-dim);">Player 360 does not render mock profile data. The live profile endpoint failed for <span class="font-mono">${escapeHtml(playerId)}</span>.</p>
      <div class="mt-3 text-xs font-mono" style="color:var(--red);">${escapeHtml(message)}</div>
      <div class="profile-status-actions mt-3">
        <button type="button" class="profile-action-button" onclick="openPlayerProfileModal(decodeURIComponent('${encodeURIComponent(playerId)}'))">Retry Profile API</button>
        <button type="button" class="profile-action-button" onclick="setPlayerProfileTab('status')">Open Status Map</button>
      </div>
    </div>`;
  });
}

async function fetchBuckeyePlayerLiveData(playerId) {
  const [infoRes, perfRes] = await Promise.allSettled([
    FactoryWager.apiFetch(`/buckeye/player-info?customerId=${encodeURIComponent(playerId)}`),
    FactoryWager.apiFetch(`/buckeye/player-performance?acc=${encodeURIComponent(playerId)}&period=0`),
  ]);
  const info = infoRes.status === 'fulfilled' ? infoRes.value : null;
  const performance = perfRes.status === 'fulfilled' ? perfRes.value : null;
  if (infoRes.status === 'rejected') {
    console.warn('[Players] Buckeye player-info failed:', infoRes.reason?.message || infoRes.reason);
  }
  if (perfRes.status === 'rejected') {
    console.warn('[Players] Buckeye player-performance failed:', perfRes.reason?.message || perfRes.reason);
  }
  return { info, performance, hasLiveData: Boolean(info?.snapshot || performance?.data) };
}

async function fetchBuckeyePlayerTransactions(playerId, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/buckeye/player-transactions?customerId=${encodeURIComponent(playerId)}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    console.warn('[Players] Buckeye player-transactions failed:', err?.message || err);
    return null;
  }
}

async function fetchPlayerProfile(playerId) {
  const profile = await FactoryWager.apiFetch(`/players/${encodeURIComponent(playerId)}/profile`);
  try {
    profile.crossReference = await fetchPlayerCrossReference(playerId);
    playerProfileState.crossReference = profile.crossReference;
  } catch (err) {
    console.warn('[Players] Cross-reference summary failed:', err?.message || err);
    profile.crossReference = null;
    playerProfileState.crossReference = null;
  }
  try {
    const live = await fetchBuckeyePlayerLiveData(playerId);
    profile.buckeye = live;
  } catch (err) {
    console.warn('[Players] Live data fetch failed:', err?.message || err);
    profile.buckeye = { info: null, performance: null, transactions: null, hasLiveData: false };
  }
  try {
    const txLive = await fetchBuckeyePlayerTransactions(playerId, 15000);
    if (txLive && profile.buckeye) {
      profile.buckeye.transactions = txLive;
      profile.buckeye.hasLiveData = Boolean(profile.buckeye.hasLiveData || txLive.rows?.length);
    }
  } catch (err) {
    console.warn('[Players] Live transactions fetch failed:', err?.message || err);
  }
  if (!Array.isArray(profile.accessLogs) || profile.accessLogs.length === 0) {
    try {
      const audit = await FactoryWager.apiFetch('/logs/access', { query: { limit: 100 } });
      const logs = (audit.logs || []).filter(row => {
        const login = row.login || row.customer_id || row.customerId || row.player_id || row.playerId || '';
        return login === playerId;
      });
      if (logs.length) {
        profile.accessLogs = logs.map(row => ({
          ...row,
          isNewIp: Boolean(row.isNewIp || row.is_new_ip),
        }));
      }
    } catch (err) {
      console.warn('[Players] Access audit fallback unavailable:', err?.message || err);
    }
  }
  return profile;
}

async function fetchPlayerIntelligenceMap(playerId) {
  return FactoryWager.apiFetch(`/players/${encodeURIComponent(playerId)}/intelligence-map`);
}

async function fetchPlayerCrossReference(playerId) {
  return FactoryWager.apiFetch('/cross-reference', { query: { playerId } });
}

async function refreshOpenPlayerProfile(playerId) {
  try {
    const profile = await fetchPlayerProfile(playerId);
    if (playerProfileState.playerId !== playerId) return;
    playerProfileState.profile = profile;
    configurePlayerProfileExports(playerId);
    renderPlayerProfile();
  } catch (err) {
    console.warn('[Players] Live profile refresh failed:', err?.message || err);
  }
}

function closePlayerProfileModal(updateHistory = true) {
  const modal = document.getElementById('playerProfileModal');
  if (!modal || modal.classList.contains('hidden')) return;
  FactoryWager.actions.unsubscribePlayerWagers(playerProfileState.playerId);
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  destroyPlayerProfileCharts();
  playerProfileState.playerId = null;
  playerProfileState.profile = null;
  playerProfileState.intelligenceMap = null;
  playerProfileState.crossReference = null;
  playerProfileState.crossReferenceLoading = false;
  playerProfileState.docsLoading = false;
  playerProfileState.statusLoading = false;
  playerProfileState.statusMap = null;
  playerProfileState.statusEndpointChecks = [];
  playerProfileState.wagerPage = 1;
  if (updateHistory && history.state?.playerProfile) history.back();
}

FactoryWager.actions.subscribePlayerWagers = function subscribePlayerWagers(playerId) {
  FactoryWager.state.ws.subscribedPlayerId = playerId;
  if (wsClient?.isConnected) {
    wsClient.send({ type: 'player.subscribe', playerId });
  }
};

FactoryWager.actions.unsubscribePlayerWagers = function unsubscribePlayerWagers(playerId) {
  if (wsClient?.isConnected && playerId) {
    wsClient.send({ type: 'player.unsubscribe', playerId });
  }
  if (FactoryWager.state.ws.subscribedPlayerId === playerId) FactoryWager.state.ws.subscribedPlayerId = null;
};

function configurePlayerProfileExports(playerId) {
  const base = `${getApiBaseUrl()}/api/v1/players/${encodeURIComponent(playerId)}/export`;
  const wagers = document.getElementById('playerExportWagersBtn');
  const access = document.getElementById('playerExportAccessBtn');
  if (wagers) {
    wagers.href = `${base}/wagers`;
    wagers.download = `${playerId}-wagers.csv`;
  }
  if (access) {
    access.href = `${base}/access-logs`;
    access.download = `${playerId}-access-logs.csv`;
  }
}

function exportPlayerProfileCsv(kind) {
  const playerId = playerProfileState.playerId;
  if (!playerId) return false;
  const path = kind === 'access' ? 'access-logs' : 'wagers';
  window.location.href = FactoryWager.apiUrl(`/players/${encodeURIComponent(playerId)}/export/${path}`);
  return false;
}

function renderPlayerProfileLoading() {
  ['playerProfileOverview', 'playerProfileWagers', 'playerProfileAccess', 'playerProfilePerformance', 'playerProfileDeposits', 'playerProfileTransactions', 'playerProfileAccount', 'playerProfileAgent', 'playerProfileLinks', 'playerProfileNotes', 'playerProfileStatus', 'playerProfileDocs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div class="profile-skeleton-grid" aria-busy="true" aria-label="Loading Player 360 profile">
      <div class="profile-skeleton skeleton-tall"></div>
      <div class="profile-skeleton skeleton-wide"></div>
      <div class="profile-skeleton"></div>
      <div class="profile-skeleton"></div>
      <div class="profile-skeleton skeleton-wide"></div>
    </div>`;
  });
}

function openPlayerProfileDocs() {
  setPlayerProfileTab('docs');
}

function setPlayerProfileTab(tab) {
  playerProfileState.tab = tab;
  document.querySelectorAll('[data-player-profile-tab]').forEach(btn => {
    const active = btn.dataset.playerProfileTab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.setAttribute('tabindex', active ? '0' : '-1');
  });
  document.getElementById('playerProfileDocsBtn')?.classList.toggle('active', tab === 'docs');
  const panels = {
    overview: 'playerProfileOverview',
    wagers: 'playerProfileWagers',
    access: 'playerProfileAccess',
    performance: 'playerProfilePerformance',
    deposits: 'playerProfileDeposits',
    transactions: 'playerProfileTransactions',
    account: 'playerProfileAccount',
    agent: 'playerProfileAgent',
    links: 'playerProfileLinks',
    notes: 'playerProfileNotes',
    status: 'playerProfileStatus',
    docs: 'playerProfileDocs',
  };
  Object.entries(panels).forEach(([name, id]) => {
    const panel = document.getElementById(id);
    if (!panel) return;
    panel.classList.toggle('hidden', name !== tab);
    panel.setAttribute('aria-hidden', name === tab ? 'false' : 'true');
  });
  if (!playerProfileState.profile) {
    const playerId = getActivePlayerProfileId();
    if (playerId) {
      playerProfileState.playerId = playerId;
      if (tab === 'status') {
        renderPlayerProfileStatus({ playerId, stats: {} });
      } else if (tab === 'docs') {
        renderPlayerProfileDocs({ playerId, stats: {} });
      } else {
        refreshOpenPlayerProfile(playerId);
      }
    }
    return;
  }
  renderPlayerProfile();
}

function renderPlayerProfile() {
  const profile = playerProfileState.profile;
  if (!profile) return;
  const stats = profile.stats || {};
  const playerId = profile.playerId || playerProfileState.playerId;
  document.getElementById('playerProfileTitle').textContent = playerId;
  const subhead = document.getElementById('playerProfileSubhead');
  if (subhead) {
    subhead.innerHTML = `<div class="player-profile-meta">
      <span class="player-profile-pill">${escapeHtml(stats.agentLogin || 'No agent')}</span>
      <span class="player-profile-pill">${Number(stats.wagerCount || stats.openBets || 0).toLocaleString()} wagers</span>
      <span class="player-profile-pill">${escapeHtml(stats.favoriteSport || 'Unknown sport')}</span>
      <span class="player-profile-pill"><span class="profile-live-dot"></span>Live bridge</span>
    </div>`;
  }

  if (playerProfileState.tab === 'overview') renderPlayerProfileOverview(profile);
  if (playerProfileState.tab === 'wagers') renderPlayerProfileWagers(profile);
  if (playerProfileState.tab === 'access') renderPlayerProfileAccess(profile);
  if (playerProfileState.tab === 'performance') renderPlayerProfilePerformance(profile);
  if (playerProfileState.tab === 'deposits') renderPlayerProfileDeposits(profile);
  if (playerProfileState.tab === 'transactions') renderPlayerProfileTransactions(profile);
  if (playerProfileState.tab === 'account') renderPlayerProfileAccount(profile);
  if (playerProfileState.tab === 'agent') renderPlayerProfileAgent(profile);
  if (playerProfileState.tab === 'links') renderPlayerProfileLinks(profile);
  if (playerProfileState.tab === 'notes') renderPlayerProfileNotes(profile);
  if (playerProfileState.tab === 'status') renderPlayerProfileStatus(profile);
  if (playerProfileState.tab === 'docs') renderPlayerProfileDocs(profile);
}

function renderPlayerProfileOverview(profile) {
  const el = document.getElementById('playerProfileOverview');
  if (!el) return;
  const stats = profile.stats || {};
  const live = profile.buckeye || {};
  const liveInfo = live.info?.snapshot?.raw || live.info?.snapshot || {};
  const livePerf = live.performance?.data || [];
  const liveName = [liveInfo.NameFirst, liveInfo.NameLast].filter(Boolean).join(' ') || null;
  const liveStatus = liveInfo.Active === 'Y' ? 'Active' : (liveInfo.Active === 'N' ? 'Suspended' : null);
  const liveCurrency = liveInfo.Currency?.split(' ')[0] || liveInfo.Currency || null;
  const liveBalance = Number(liveInfo.CurrentBalance || 0) / 100;
  const livePending = Number(liveInfo.PendingWagerBalance || 0) / 100;
  const livePendingCount = Number(liveInfo.PendingWagerCount || 0);
  const liveCredit = Number(liveInfo.CreditLimit || 0) / 100;
  const liveSuspend = liveInfo.SuspendAccount === 'Y';
  const liveVip = liveInfo.VigDiscountPercent || liveInfo.VIP || null;
  const account = getLatestAccountSnapshot(profile);
  const playerId = profile.playerId || playerProfileState.playerId || 'Player';
  const accessLogs = profile.accessLogs || [];
  const flags = profile.flags || [];
  const notes = profile.notes || [];
  const wagers = profile.recentWagers || [];
  const weeklyPnl = profile.weeklyPnl || [];
  const sportBreakdown = profile.sportBreakdown || [];
  const agentContext = profile.agentContext || {};
  const assignedAgent = profile.agent || agentContext.assigned || {};
  const allAgents = Array.isArray(profile.allAgents) ? profile.allAgents : (agentContext.lineage || []);
  const displayName = liveName || playerId;
  const displayStatus = liveStatus || account.account_status || 'Active from wagers';
  const displayCurrency = liveCurrency || account.currency || 'Unknown';
  let liveRisk = Number(stats.riskScore || 0);
  if (live.hasLiveData) {
    liveRisk = Math.min(100, Math.round(
      (Number(stats.totalVolume || 0) >= 50000 ? 70 : Number(stats.totalVolume || 0) / 750)
      + (Math.max(Number(stats.totalRisk || 0), Number(liveInfo.CreditLimit || 0) / 100) >= 50000 ? 25 : Math.max(Number(stats.totalRisk || 0), Number(liveInfo.CreditLimit || 0) / 100) / 2500)
      + Math.min(10, Math.abs(liveBalance) / 5000)
      + (liveSuspend ? 15 : 0)
      + (livePendingCount > 5 ? 5 : 0)
    ));
  }
  const risk = liveRisk;

  el.innerHTML = `
    <div class="profile-intel-layout">
      <!-- LEFT COLUMN -->
      <section class="profile-intel-column">
        <!-- Identity Card -->
        <div class="intel-identity-card-v2">
          <div class="intel-identity-head">
            <div class="intel-avatar-v2">${escapeHtml(playerProfileInitials(displayName))}<div class="intel-avatar-status"></div></div>
            <div class="min-w-0">
              <div class="intel-eyebrow">Player Identity ${live.hasLiveData ? '<span class="intel-live-dot" style="margin-left:6px;display:inline-block;vertical-align:middle;"></span>' : ''}</div>
              <h3>${escapeHtml(displayName)}${live.hasLiveData ? ' <span class="intel-chip live" style="font-size:10px;vertical-align:middle;margin-left:6px;">Buckeye Live</span>' : ''}</h3>
              <div class="intel-pill-row">
                <span class="intel-chip ${accessLogs.length ? 'live' : 'probe'}">${accessLogs.length ? 'Active trail' : 'No access trail'}</span>
                <span class="intel-chip">${escapeHtml(assignedAgent.login || stats.agentLogin || account.agent_login || 'No agent')}</span>
                ${assignedAgent.level ? `<button type="button" class="intel-chip" onclick="setPlayerProfileTab('agent')">L${escapeHtml(assignedAgent.level)} ${escapeHtml(assignedAgent.agentType || '')}</button>` : ''}
              </div>
            </div>
          </div>
          <div class="intel-kv-list">
            ${intelKvRow('Account Status', displayStatus)}
            ${intelKvRow('AgentID', assignedAgent.agentId || stats.agentId || 'Not linked')}
            ${intelKvRow('Parent Agent', allAgents.length > 1 ? `${allAgents[allAgents.length - 2].login} (${allAgents[allAgents.length - 2].agentId})` : 'Root / none')}
            ${intelKvRow('Agent Players', assignedAgent.playerCount ? Number(assignedAgent.playerCount).toLocaleString() : '0')}
            ${intelKvRow('KYC Level', liveInfo.KycLevel || liveInfo.kycLevel || account.kyc_level || 'Needs customer-info probe')}
            ${intelKvRow('VIP Tier', liveVip || account.vip_status || 'Not captured')}
            ${intelKvRow('Last Active', latestPlayerActivity(profile))}
            ${intelKvRow('Currency', displayCurrency)}
            ${intelKvRow('App / Device', accessLogs[0]?.device || 'Access payload pending')}
          </div>
        </div>

        <!-- Risk Score -->
        <div class="intel-glass-card">
          <div class="intel-card-title">
            <span>Risk Score</span>
            <strong class="${risk >= 70 ? 'danger' : risk >= 40 ? 'warn' : 'good'}">${risk}<small>/100</small></strong>
          </div>
          <div class="intel-risk-meter-v2"><div class="intel-risk-meter-v2-fill" style="width:${Math.min(100, Math.max(0, risk))}%;"></div></div>
          <div class="intel-risk-scale"><span>Low</span><span>Medium</span><span>High</span></div>
          <div class="intel-risk-factors">${renderRiskFactors(profile)}</div>
        </div>

        <!-- Cross References -->
        ${renderCrossReferencePanel(profile)}

        <!-- Active Flags -->
        <div class="intel-glass-card">
          <div class="intel-section-header">
            <h3>Active Flags</h3>
            <button type="button" class="intel-text-action" onclick="setPlayerProfileTab('notes')">+ Add</button>
          </div>
          ${renderArtifactFlags(flags)}
        </div>

        <!-- Operator Notes -->
        <div class="intel-glass-card">
          <div class="intel-section-header">
            <h3>Operator Notes</h3>
            <button type="button" class="intel-text-action" onclick="focusPlayerNoteComposer()">+ Add</button>
          </div>
          ${renderArtifactNotes(notes)}
        </div>

        <!-- Key Statistics Grid -->
        <div class="intel-stat-grid">
          ${artifactStatCard('Total Volume', formatCompactDollars(stats.totalVolume), 'fa-coins', '#0ea5e9', 'up', '12.4% this month')}
          ${artifactStatCard('Open Bets', live.hasLiveData ? `${livePendingCount.toLocaleString()}` : Number(stats.openBets || 0).toLocaleString(), 'fa-fire', '#f43f5e', null, live.hasLiveData ? `${formatCompactDollars(livePending)} pending` : `${formatCompactDollars(stats.openExposure || 0)} exposure`)}
          ${artifactStatCard('Win Rate', `${Number(stats.winRate || 0).toFixed(1)}%`, 'fa-chart-pie', '#10b981', 'up', '3.2% vs avg')}
          ${artifactStatCard('Favorite Sport', stats.favoriteSport || 'Unknown', 'fa-trophy', '#8b5cf6', null, 'Volume leader')}
        </div>

        <!-- Advanced Metrics -->
        <div class="intel-glass-card">
          <div class="intel-card-title"><span>Advanced Metrics</span><small>derived</small></div>
          <div class="intel-advanced-grid">
            ${intelMiniMetric('Avg Stake', formatCompactDollars(stats.avgStake || stats.avgWager), '')}
            ${intelMiniMetric('CLV %', `${Number(stats.clvPercent || 0).toFixed(2)}%`, 'estimated')}
            ${intelMiniMetric('Past Posting', `${Number(stats.pastPostingRate || 0).toFixed(1)}%`, `${Number(stats.patternHits || 0)} flags`)}
            ${intelMiniMetric('Stale Hits', Number(stats.staleLineHits || 0).toLocaleString(), 'last archive')}
          </div>
        </div>

        <!-- Agent Assignment -->
        <div class="intel-glass-card">
          <div class="intel-section-header">
            <h3>Agent Assignment</h3>
            <button type="button" class="intel-text-action" onclick="setPlayerProfileTab('agent')">Open Tree</button>
          </div>
          ${renderAgentAssignmentCard(agentContext)}
        </div>

        <!-- Volume by Sport -->
        <div class="intel-glass-card">
          <div class="intel-card-title"><span>Volume By Sport</span><small>${Number(sportBreakdown.length).toLocaleString()} sports</small></div>
          ${renderSportVolumeBars(sportBreakdown)}
        </div>
      </section>

      <!-- MIDDLE COLUMN -->
      <section class="profile-intel-column">
        <!-- Live Wager Feed -->
        <div class="intel-glass-card intel-feed-panel">
          <div class="intel-card-title">
            <span>Live Wager Feed</span>
            <div class="intel-pill-row">
              <span class="intel-chip live"><span class="intel-live-dot"></span>Live</span>
              <button type="button" class="intel-text-action" onclick="exportPlayerProfileCsv('wagers')">CSV</button>
            </div>
          </div>
          <div class="intel-wager-feed-v2 intel-scroll">${renderArtifactWagerFeed(wagers)}</div>
        </div>

        <!-- 4-Week P&L Trend -->
        <div class="intel-glass-card">
          <div class="intel-card-title"><span>4-Week P&L Trend</span><small>${livePerf.length ? 'Buckeye live' : 'archive'}</small></div>
          <div class="intel-chart-container"><canvas id="playerMiniPnlChart"></canvas></div>
          ${livePerf.length ? renderLivePnlSummary(livePerf) : renderWeeklyPnlSummary(weeklyPnl)}
        </div>

        <!-- CLV Analysis -->
        <div class="intel-glass-card">
          <div class="intel-card-title"><span>Closing Line Value</span><strong class="${Number(stats.clvPercent || 0) >= 0 ? 'good' : 'danger'}">${Number(stats.clvPercent || 0).toFixed(2)}%</strong></div>
          ${renderClvBySport(profile)}
        </div>
      </section>

      <!-- RIGHT COLUMN -->
      <section class="profile-intel-column">
        <!-- Linked Accounts -->
        <div class="intel-glass-card">
          <div class="intel-section-header">
            <h3>Linked Accounts</h3>
            <span class="badge" style="background:rgba(244,63,94,.1);color:#f43f5e;border:1px solid rgba(244,63,94,.2);">${(profile.links || []).length} found</span>
          </div>
          ${renderArtifactLinkedAccounts(profile)}
        </div>

        <!-- Access Logs -->
        <div class="intel-glass-card intel-access-panel">
          <div class="intel-section-header">
            <h3>Access Logs</h3>
            <button type="button" class="intel-text-action" onclick="exportPlayerProfileCsv('access')">CSV</button>
          </div>
          <div class="intel-access-list intel-scroll">${renderArtifactAccessLogs(profile)}</div>
        </div>

        <!-- Login Locations -->
        <div class="intel-glass-card">
          <div class="intel-card-title"><span>Login Locations</span><small>last 10</small></div>
          ${renderArtifactGeoDistribution(profile)}
        </div>

        <!-- Quick Actions -->
        <div class="intel-glass-card">
          <div class="intel-card-title"><span>Quick Actions</span><small>profile</small></div>
          <div class="intel-action-list">
            <button type="button" class="intel-action-btn-v2" onclick="exportPlayerProfileCsv('wagers')"><span class="action-icon" style="color:#f43f5e;"><i class="fa-solid fa-ban"></i></span><span class="action-label">Suspend Account</span></button>
            <button type="button" class="intel-action-btn-v2" onclick="exportPlayerProfileCsv('wagers')"><span class="action-icon" style="color:#0ea5e9;"><i class="fa-solid fa-file-export"></i></span><span class="action-label">Export History</span></button>
            <button type="button" class="intel-action-btn-v2" onclick="focusPlayerFlagComposer()"><span class="action-icon" style="color:#8b5cf6;"><i class="fa-solid fa-user-shield"></i></span><span class="action-label">Escalate to Compliance</span></button>
            <button type="button" class="intel-action-btn-v2" onclick="checkPlayerMultiAccounts()"><span class="action-icon" style="color:#10b981;"><i class="fa-solid fa-envelope"></i></span><span class="action-label">Send Notification</span></button>
          </div>
        </div>
      </section>
    </div>`;
  renderPlayerMiniPnlChart(weeklyPnl);
}

function profileStatCard(label, value) {
  return `<div class="profile-stat-card"><div class="profile-stat-label">${label}</div><div class="profile-stat-value">${value}</div></div>`;
}

function renderCrossReferencePanel(profile) {
  const cross = profile.crossReference || playerProfileState.crossReference;
  if (!cross) {
    return `<div class="intel-glass-card">
      <div class="intel-section-header">
        <h3>Cross-Refs</h3>
        <span class="intel-chip probe">loading</span>
      </div>
      <div class="intel-empty">Cross-reference summary is not available yet.</div>
    </div>`;
  }
  const agent = cross.agentContext?.assigned || {};
  const lineage = cross.agentContext?.lineageLabel || agent.login || agent.agentId || 'No agent linked';
  const access = cross.accessContext || {};
  const freePlay = cross.freePlayContext || {};
  const patterns = cross.patternContext || {};
  const quality = cross.dataQuality || {};
  const latestIp = access.recent?.[0]?.ipAddress || access.recent?.[0]?.ip_address || '-';
  const latestGeo = access.latestGeo || 'Geo pending';
  return `<div class="intel-glass-card">
    <div class="intel-section-header">
      <h3>Cross-Refs</h3>
      <span class="intel-chip ${Object.values(quality).some(Boolean) ? 'probe' : 'live'}">${Object.values(quality).filter(Boolean).length} trust flags</span>
    </div>
    <div class="intel-kv-list">
      ${intelKvRow('Agent Lineage', lineage)}
      ${intelKvRow('Shared IPs', `${Number(access.sharedIpCount || 0).toLocaleString()} clusters · ${latestIp}`)}
      ${intelKvRow('Latest Geo', latestGeo)}
      ${intelKvRow('Free-Play', `${formatCompactDollars(freePlay.outstandingEstimate || 0)} outstanding · ${freePlay.sourceConfidence || 'confirmed'}`)}
      ${intelKvRow('Patterns', `${Number(patterns.total || 0).toLocaleString()} linked · ${Number(patterns.critical || 0)} critical`)}
    </div>
    <div class="mt-3 flex flex-wrap gap-2">
      ${crossRefQualityChip('Agent map', !quality.missingAgentMap)}
      ${crossRefQualityChip('Access logs', !quality.staleAccessLogs && Number(access.rowCount || 0) > 0)}
      ${crossRefQualityChip('Ledger', !quality.missingTransactions)}
      ${crossRefQualityChip('Patterns', quality.patternEvidencePresent)}
      ${crossRefQualityChip('Free-play', !quality.freePlayCandidateOnly)}
    </div>
    <div class="mt-3 grid grid-cols-2 gap-2">
      <button type="button" class="profile-action-button" onclick="viewPlayerRelated('agent')">Agent Tree</button>
      <button type="button" class="profile-action-button" onclick="viewPlayerRelated('access')">Access Logs</button>
      <button type="button" class="profile-action-button" onclick="viewPlayerRelated('patterns')">Patterns</button>
      <button type="button" class="profile-action-button" onclick="viewPlayerRelated('freeplay')">Free-Play</button>
    </div>
  </div>`;
}

function crossRefQualityChip(label, ok) {
  return `<span class="status-coverage-chip ${ok ? 'live' : 'probe'}">${escapeHtml(label)}: ${ok ? 'ok' : 'check'}</span>`;
}

function viewPlayerRelated(target) {
  const profile = playerProfileState.profile || {};
  const cross = profile.crossReference || playerProfileState.crossReference || {};
  const agent = cross.agentContext?.assigned?.login || cross.agentContext?.assigned?.agentId || profile.stats?.agentLogin || '';
  if (target === 'agent') {
    setPlayerProfileTab('agent');
    return false;
  }
  if (target === 'access') {
    setPlayerProfileTab('access');
    return false;
  }
  if (target === 'freeplay') {
    setPlayerProfileTab('transactions');
    setPlayerTransactionTab('freeplay');
    return false;
  }
  if (target === 'patterns') {
    if (agent) openPatternsForAgent(agent);
    else switchSection('patterns', getSidebarButton('patterns'));
    return false;
  }
  return false;
}

/* ===== ARTIFACT-STYLE RENDER HELPERS ===== */

function artifactStatCard(label, value, icon, color, deltaDir, deltaText) {
  const deltaHtml = deltaDir
    ? `<span class="delta ${deltaDir}"><i class="fa-solid fa-arrow-${deltaDir}"></i>${escapeHtml(deltaText)}</span>`
    : (deltaText ? `<span class="delta" style="color:var(--text-dim);">${escapeHtml(deltaText)}</span>` : '');
  return `<div class="intel-stat-card-v2">
    <div class="icon-wrap" style="background:${color}18;color:${color};"><i class="fa-solid ${icon}"></i></div>
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${escapeHtml(value || '0')}</div>
    ${deltaHtml}
  </div>`;
}

function renderArtifactFlags(flags) {
  if (!flags.length) return '<div class="intel-empty">No manual flags yet.</div>';
  const severityMap = { critical: 'critical', high: 'critical', warning: 'warning', warn: 'warning', medium: 'warning', info: 'info', low: 'info' };
  return `<div class="intel-stack">${flags.slice(0, 3).map(flag => {
    const sev = severityMap[(flag.severity || '').toLowerCase()] || 'info';
    const colors = { critical: '#f43f5e', warning: '#f59e0b', info: '#8b5cf6' };
    const c = colors[sev];
    return `<div class="intel-flag-badge-v2 ${sev}">
      <div class="flag-icon" style="color:${c};"><i class="fa-solid fa-flag"></i></div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
          <span style="font-size:11px;font-weight:800;color:${c};">${escapeHtml(flag.label || flag.flag_type || 'Flag')}</span>
          <span style="font-size:10px;color:var(--text-dim);">${escapeHtml(formatShortDateTime(flag.created_at))}</span>
        </div>
        <p style="margin:0;font-size:11px;color:var(--text);line-height:1.4;">${escapeHtml(flag.details || flag.status || 'Open')}</p>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderArtifactNotes(notes) {
  if (!notes.length) return '<div class="intel-empty">No notes yet. Add Telegram handles, VIP host context, or compliance notes from the Notes tab.</div>';
  const typeColors = { 'VIP Host Note': '#0ea5e9', 'Compliance': '#f59e0b', 'Investigation': '#f43f5e', 'General': '#64748b' };
  return `<div class="intel-stack">${notes.slice(0, 2).map(note => {
    const typeColor = typeColors[note.note_type] || '#64748b';
    return `<div class="intel-note-card-v2">
      <div class="note-header">
        <span class="note-type" style="color:${typeColor};">${escapeHtml(note.note_type || 'Note')}</span>
        <span class="note-time">${escapeHtml(formatShortDateTime(note.created_at))}</span>
      </div>
      <p class="note-body">${escapeHtml(note.body || '')}</p>
    </div>`;
  }).join('')}</div>`;
}

function renderArtifactWagerFeed(wagers) {
  if (!wagers.length) return '<div class="intel-empty">No wagers captured yet.</div>';
  return wagers.slice(0, 12).map(row => {
    const w = normalizeBackendWager(row);
    const flags = row.pattern_flags || row.patternFlags || [];
    const pattern = intelWagerPattern(row, flags);
    const clv = Number(row.clv_percent ?? row.clvPercent ?? 0);
    const sport = w.Sport || parseSport(w.ShortDesc) || 'Unknown';
    const sportColors = { NBA: '#f97316', NFL: '#f59e0b', Soccer: '#10b981', NHL: '#06b6d4', Tennis: '#84cc16', MLB: '#ef4444' };
    const sportBg = { NBA: 'rgba(249,115,22,.12)', NFL: 'rgba(245,158,11,.12)', Soccer: 'rgba(16,185,129,.12)', NHL: 'rgba(6,182,212,.12)', Tennis: 'rgba(132,204,22,.12)', MLB: 'rgba(239,68,68,.12)' };
    const sc = sportColors[sport] || '#64748b';
    const sb = sportBg[sport] || 'rgba(100,116,139,.12)';
    return `<div class="intel-wager-card-v2 ${pattern.className}">
      <div style="display:flex;align-items:start;gap:8px;">
        <div class="intel-sport-token-v2" style="background:${sb};color:${sc};">${escapeHtml(String(sport).slice(0, 3).toUpperCase())}</div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;justify-content:space-between;align-items:start;gap:8px;">
            <div style="min-width:0;">
              <strong style="font-size:12px;color:var(--text);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(parseDescription(w.ShortDesc) || w.WagerType || 'Wager')}</strong>
              <span style="font-size:10px;color:var(--text-dim);display:block;margin-top:2px;">${escapeHtml(w.WagerType || 'Ticket')} · #${escapeHtml(w.WagerNumber || '-')}</span>
            </div>
            <div style="text-align:right;flex:0 0 auto;">
              <strong style="font-size:12px;color:var(--text);font-family:var(--font-mono,monospace);">${formatCompactDollars(w.AmountWagered)}</strong>
            </div>
          </div>
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(148,163,184,.1);font-size:10px;color:var(--text-dim);">
            <span>${escapeHtml(formatShortDateTime(w.InsertDateTime))}</span>
            <span>To win ${escapeHtml(formatCompactDollars(w.ToWinAmount))}</span>
            ${pattern.label ? `<span class="intel-pattern-pill ${pattern.key}">${escapeHtml(pattern.label)}</span>` : ''}
            ${clv ? `<span class="${clv >= 0 ? 'good' : 'danger'}">CLV ${clv.toFixed(2)}%</span>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderArtifactLinkedAccounts(profile) {
  const links = profile.links || [];
  if (!links.length) return '<div class="intel-empty">No linked accounts detected yet. Run a check to compare shared IP and device evidence.</div>';
  return `<div class="intel-stack">${links.slice(0, 4).map(row => {
    const other = row.player_a === profile.playerId ? row.player_b : row.player_a;
    const encodedOther = encodeURIComponent(String(other || ''));
    const reasonColors = { 'IP Shared': '#f59e0b', 'Device Shared': '#8b5cf6', 'Email Match': '#f43f5e', 'Phone Match': '#0ea5e9' };
    const rc = reasonColors[row.reason] || '#64748b';
    return `<div class="intel-linked-card-v2" onclick="openPlayerProfileModal(decodeURIComponent('${encodedOther}'))">
      <div class="linked-header">
        <span class="linked-id">${escapeHtml(other || '-')}</span>
        <span class="linked-reason" style="background:${rc}18;color:${rc};border:1px solid ${rc}30;">${escapeHtml(row.reason || 'Link')}</span>
      </div>
      <p class="linked-meta">${escapeHtml(row.reason || 'Link evidence')}</p>
      <div class="linked-stats">
        <span>Risk: <strong style="color:${Number(row.confidence || 0) > 0.5 ? '#f43f5e' : '#f59e0b'};">${Math.round(Number(row.confidence || 0) * 100)}%</strong></span>
        <span>Conf: <strong>${Math.round(Number(row.confidence || 0) * 100)}%</strong></span>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderArtifactAccessLogs(profile) {
  const logs = profile.accessLogs || [];
  if (!logs.length) return '<div class="intel-empty">No access logs captured yet.</div>';
  return logs.slice(0, 8).map(log => `<div class="intel-access-card-v2 ${log.isNewIp ? 'novel' : ''}">
    <div class="access-header">
      <div style="display:flex;align-items:center;gap:6px;">
        <i class="fa-solid fa-location-dot" style="color:#0ea5e9;font-size:10px;"></i>
        <span class="access-ip">${escapeHtml(log.ip_address || '-')}</span>
        ${log.isNewIp ? '<span style="font-size:10px;padding:2px 6px;border-radius:999px;background:rgba(244,63,94,.1);color:#f43f5e;border:1px solid rgba(244,63,94,.2);font-weight:800;">NEW IP</span>' : ''}
      </div>
      <span class="access-status" style="color:${log.status === 'success' ? '#10b981' : '#f43f5e'};"><i class="fa-solid ${log.status === 'success' ? 'fa-check-circle' : 'fa-circle-xmark'}"></i></span>
    </div>
    <p class="access-meta">${escapeHtml(log.geo || 'Unknown geo')} · ${escapeHtml(log.isp || 'Unknown ISP')} · ${escapeHtml(log.device || 'Unknown device')}</p>
    <div class="access-footer">
      <span style="color:var(--text-dim);">${escapeHtml(formatShortDateTime(log.access_datetime))}</span>
      <span style="padding:2px 6px;border-radius:999px;background:rgba(100,116,139,.15);color:var(--text-dim);font-weight:800;font-size:10px;">${escapeHtml(log.operation || log.log_type || 'access')}</span>
    </div>
  </div>`).join('');
}

function renderArtifactGeoDistribution(profile) {
  const logs = profile.accessLogs || [];
  if (!logs.length) return '<div class="intel-empty">No geo distribution available.</div>';
  const counts = new Map();
  for (const log of logs) counts.set(log.geo || 'Unknown', (counts.get(log.geo || 'Unknown') || 0) + 1);
  const max = Math.max(...counts.values(), 1);
  const colors = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981', '#f43f5e', '#06b6d4'];
  return `<div class="intel-stack">${[...counts.entries()].slice(0, 5).map(([geo, count], i) => {
    const pct = Math.round((count / max) * 100);
    const c = colors[i % colors.length];
    const code = geo.split(',')[0]?.slice(0, 2).toUpperCase() || '??';
    return `<div class="intel-geo-row-v2">
      <div class="intel-geo-flag" style="background:${c}18;color:${c};">${escapeHtml(code)}</div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
          <span style="font-size:11px;color:var(--text);font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(geo)}</span>
          <span style="font-size:11px;color:var(--text-dim);font-family:var(--font-mono,monospace);">${count}</span>
        </div>
        <div class="intel-geo-bar-track"><div class="intel-geo-bar-fill" style="width:${pct}%;background:${c};"></div></div>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderMiniWagerList(wagers) {
  if (!wagers.length) return '<div class="text-sm" style="color:var(--text-dim);">No wagers yet.</div>';
  return `<div class="space-y-2">${wagers.slice(0, 8).map(row => {
    const w = normalizeBackendWager(row);
    return `<div class="flex items-center justify-between gap-3 text-xs border-b pb-2" style="border-color:var(--border);">
      <div class="min-w-0"><div class="font-mono">#${escapeHtml(w.WagerNumber)}</div><div class="truncate" style="color:var(--text-dim);">${escapeHtml(parseDescription(w.ShortDesc))}</div></div>
      <div class="font-mono">$${Math.round(w.AmountWagered).toLocaleString()}</div>
    </div>`;
  }).join('')}</div>`;
}

function renderSportVolumeBars(sports) {
  if (!sports.length) return '<div class="text-sm" style="color:var(--text-dim);">No sport volume yet.</div>';
  const max = Math.max(...sports.map(row => Number(row.volume || 0)), 1);
  return `<div class="space-y-3">${sports.slice(0, 7).map(row => {
    const volume = Number(row.volume || 0);
    const pct = Math.max(3, Math.round((volume / max) * 100));
    return `<div>
      <div class="flex items-center justify-between text-xs mb-1">
        <span>${escapeHtml(row.sport || 'Unknown')}</span>
        <span class="font-mono" style="color:var(--text-dim);">$${Math.round(volume).toLocaleString()}</span>
      </div>
      <div class="sport-volume-track"><div class="sport-volume-fill" style="width:${pct}%;"></div></div>
    </div>`;
  }).join('')}</div>`;
}

function getLatestAccountSnapshot(profile) {
  return (profile.accountSnapshots || [])[0] || {};
}

function playerProfileInitials(playerId) {
  const clean = String(playerId || 'PL').replace(/[^a-z0-9]/gi, '');
  return (clean.slice(0, 2) || 'PL').toUpperCase();
}

function latestPlayerActivity(profile) {
  const latestAccess = profile.accessLogs?.[0]?.access_datetime;
  const latestWager = profile.stats?.lastWagerAt || profile.recentWagers?.[0]?.insert_datetime || profile.recentWagers?.[0]?.insert_date_time;
  const latest = latestAccess || latestWager;
  return latest ? timeAgo(latest) : 'No activity captured';
}

function intelKvRow(label, value) {
  return `<div class="intel-kv-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></div>`;
}

function intelStatCard(label, value, subtext) {
  return `<div class="intel-stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '0')}</strong><small>${escapeHtml(subtext || '')}</small></div>`;
}

function intelMiniMetric(label, value, subtext) {
  return `<div class="intel-mini-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '0')}</strong>${subtext ? `<small>${escapeHtml(subtext)}</small>` : ''}</div>`;
}

function renderAgentAssignmentCard(agentContext) {
  const agent = agentContext?.assigned;
  if (!agent) return '<div class="intel-empty">No real agent row is linked to this player yet.</div>';
  const parent = (agentContext.lineage || []).length > 1 ? agentContext.lineage[agentContext.lineage.length - 2] : null;
  const rates = agent.rates || {};
  return `<div class="agent-assignment-card">
    <div class="agent-assignment-head">
      <div>
        <div class="intel-eyebrow">Assigned Agent</div>
        <strong>${escapeHtml(agent.login || agent.agentId)}</strong>
        <small>${escapeHtml(agent.agentId || '')}</small>
      </div>
      <button type="button" class="profile-action-button" onclick="openAgentTreeFromProfile('${escapeJs(agent.agentId || agent.login || '')}')">Tree</button>
    </div>
    <div class="intel-advanced-grid">
      ${intelMiniMetric('Level', agent.level ? `L${agent.level}` : '-', agent.agentType === 'M' ? 'Master' : 'Agent')}
      ${intelMiniMetric('Parent', parent ? parent.login : 'Root', parent ? parent.agentId : '')}
      ${intelMiniMetric('Players', Number(agent.playerCount || 0).toLocaleString(), `${Number(agent.childCount || 0)} child agents`)}
      ${intelMiniMetric('Head Rate', `${Number(rates.headCount || 0).toFixed(2)}%`, `Inet ${Number(rates.inetHeadCount || 0).toFixed(2)}%`)}
    </div>
  </div>`;
}

async function refreshPlayerAgentContext(playerId) {
  if (!playerId || playerProfileState.agentContextLoading) return;
  playerProfileState.agentContextLoading = true;
  try {
    const payload = await fetchJson(`${getApiBaseUrl()}/api/players/${encodeURIComponent(playerId)}/agent-context`);
    if (playerProfileState.profile && payload?.agentContext) {
      playerProfileState.profile.agentContext = payload.agentContext;
      playerProfileState.profile.stats = {
        ...(playerProfileState.profile.stats || {}),
        agentId: payload.agentContext.assigned?.agentId || playerProfileState.profile.stats?.agentId || '',
        agentLogin: payload.agentContext.assigned?.login || playerProfileState.profile.stats?.agentLogin || '',
        agentLevel: payload.agentContext.assigned?.level || playerProfileState.profile.stats?.agentLevel || null,
        agentType: payload.agentContext.assigned?.agentType || playerProfileState.profile.stats?.agentType || '',
        parentAgentId: payload.agentContext.assigned?.parentAgentId || playerProfileState.profile.stats?.parentAgentId || '',
        parentAgentLogin: payload.agentContext.lineage?.length > 1 ? payload.agentContext.lineage[payload.agentContext.lineage.length - 2]?.login || '' : '',
        agentPlayerCount: payload.agentContext.assigned?.playerCount || 0,
      };
      if (['overview', 'agent'].includes(playerProfileState.tab)) renderPlayerProfile();
    }
  } catch (err) {
    console.warn('[Players] Agent context refresh failed:', err?.message || err);
  } finally {
    playerProfileState.agentContextLoading = false;
  }
}

function renderPlayerProfileAgent(profile) {
  const el = document.getElementById('playerProfileAgent');
  if (!el) return;
  const context = profile.agentContext || {};
  const agent = profile.agent || context.assigned;
  if (!agent) {
    refreshPlayerAgentContext(profile.playerId || playerProfileState.playerId);
    el.innerHTML = '<div class="profile-doc-panel"><h3>No Agent Link</h3><p class="text-sm" style="color:var(--text-dim);">Checking the real Buckeye agent-context endpoint for this player.</p></div>';
    return;
  }
  const lineage = Array.isArray(profile.allAgents) ? profile.allAgents : (context.lineage || []);
  const children = context.children || [];
  const siblings = context.siblings || [];
  const roots = context.roots || [];
  const stats = context.treeStats || {};
  const filter = String(playerProfileState.agentFilter || '').trim().toLowerCase();
  const filteredChildren = filterAgentNodes(children, filter);
  const filteredSiblings = filterAgentNodes(siblings, filter);
  el.innerHTML = `<div class="profile-chart-card mb-3">
    <div class="profile-action-row">
      <div>
        <h3 class="text-sm font-semibold mb-1">Real Agent Hierarchy</h3>
        <div class="text-xs" style="color:var(--text-dim);">${Number(stats.totalAgents || 0).toLocaleString()} real agents · ${Number(stats.maxLevel || 0)} levels · roots ${roots.map(r => r.login).join(', ')}</div>
      </div>
      <button type="button" class="profile-action-button" onclick="openAgentTreeFromProfile('${escapeJs(agent.agentId)}')">Open Network Tree</button>
    </div>
    <div class="mt-3">
      <input class="profile-filter-input" type="search" aria-label="Filter agent hierarchy" placeholder="Search child or sibling agents" value="${escapeHtml(playerProfileState.agentFilter || '')}" oninput="setPlayerAgentFilter(this.value)">
    </div>
  </div>
  <div class="grid grid-cols-3 gap-3 mb-3">
    ${profileStatCard('Assigned Agent', `${escapeHtml(agent.login)}<small class="block font-mono">${escapeHtml(agent.agentId)}</small>`)}
    ${profileStatCard('Level / Type', `L${escapeHtml(agent.level)} ${escapeHtml(agent.agentType)}`)}
    ${profileStatCard('Player Count', Number(agent.playerCount || 0).toLocaleString())}
  </div>
  <div class="grid grid-cols-2 gap-4">
    <div class="profile-chart-card">
      <h3 class="text-sm font-semibold mb-3">Root To Player Agent</h3>
      ${renderAgentLineage(lineage, agent.agentId)}
    </div>
    <div class="profile-chart-card">
      <h3 class="text-sm font-semibold mb-3">Commission Rates</h3>
      ${renderAgentRates(agent)}
    </div>
  </div>
  <div class="grid grid-cols-2 gap-4 mt-4">
    <div class="profile-chart-card">
      <h3 class="text-sm font-semibold mb-3">Direct Child Agents</h3>
      ${renderAgentNodeList(filteredChildren, 'No direct child agents.')}
    </div>
    <div class="profile-chart-card">
      <h3 class="text-sm font-semibold mb-3">Sibling Agents</h3>
      ${renderAgentNodeList(filteredSiblings, 'No sibling agents under the same parent.')}
    </div>
  </div>
  ${renderAgentComplianceSection([...lineage, ...children, ...siblings, ...roots])}`;
}

function filterAgentNodes(nodes, filter) {
  if (!filter) return nodes || [];
  return (nodes || []).filter(node => `${node.login || ''} ${node.agentId || ''} ${node.agentType || ''} ${node.level || ''}`.toLowerCase().includes(filter));
}

const setPlayerAgentFilter = debounce((value) => {
  playerProfileState.agentFilter = value || '';
  if (playerProfileState.tab === 'agent') renderPlayerProfile();
}, 150);

function renderAgentLineage(lineage, activeAgentId) {
  if (!lineage.length) return '<div class="intel-empty">Lineage unavailable.</div>';
  return `<div class="agent-lineage-list" role="tree" aria-label="Agent lineage">${lineage.map((node, index) => `<div class="agent-lineage-row ${node.agentId === activeAgentId ? 'active' : ''}" role="treeitem" aria-level="${index + 1}" aria-expanded="true">
    <span class="agent-lineage-depth">${index + 1}</span>
    <div>
      <strong>${escapeHtml(node.login || node.agentId)}</strong>
      <small>${escapeHtml(node.agentId)} · L${escapeHtml(node.level)} · ${escapeHtml(node.agentType)}</small>
    </div>
    <span class="font-mono">${Number(node.playerCount || 0).toLocaleString()}</span>
  </div>`).join('')}</div>`;
}

function renderAgentRates(agent) {
  const rates = agent.rates || {};
  const rows = [
    ['HeadCountRateM', rates.headCount],
    ['InetHeadCountRateM', rates.inetHeadCount],
    ['CasinoHeadCountRateM', rates.casinoHeadCount],
    ['LiveBettingRateM', rates.liveBetting],
    ['LiveBetting2RateM', rates.liveBetting2],
    ['LiveCasinoRateM', rates.liveCasino],
    ['PropBuilderRateM', rates.propBuilder],
    ['FlashBetsRate', rates.flashBets],
    ['ExtPropsRate', rates.extProps],
    ['CrashRate', rates.crash],
    ['FantasyRate', rates.fantasy],
    ['AmigoTechRate', rates.amigoTech],
  ];
  return `<div class="agent-rate-grid">${rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${Number(value || 0).toFixed(2)}</strong></div>`).join('')}</div>`;
}

function renderAgentComplianceSection(nodes) {
  const unique = new Map();
  (nodes || []).forEach(node => {
    if (node?.agentId) unique.set(node.agentId, node);
  });
  const flat = [...unique.values()];
  const topPlayers = [...flat].sort((a, b) => Number(b.playerCount || 0) - Number(a.playerCount || 0)).slice(0, 6);
  const unusualRates = flat
    .map(node => {
      const rates = node.rates || {};
      const maxRate = Math.max(
        Number(rates.headCount || rates.HeadCountRateM || 0),
        Number(rates.inetHeadCount || rates.InetHeadCountRateM || 0),
        Number(rates.liveCasino || rates.LiveCasinoRateM || 0),
        Number(rates.propBuilder || rates.PropBuilderRateM || 0)
      );
      return { ...node, maxRate };
    })
    .filter(node => node.maxRate >= 10)
    .sort((a, b) => b.maxRate - a.maxRate)
    .slice(0, 6);
  const levels = flat.reduce((acc, node) => {
    const level = `L${Number(node.level || 0) || '?'}`;
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {});
  const maxLevelCount = Math.max(1, ...Object.values(levels));
  return `<div class="profile-chart-card mt-4">
    <div class="profile-action-row mb-3">
      <div>
        <h3 class="text-sm font-semibold mb-1">Agent Risk</h3>
        <div class="text-xs" style="color:var(--text-dim);">Compliance view from the flattened available agent branch.</div>
      </div>
    </div>
    <div class="grid grid-cols-3 gap-3">
      <div>
        <div class="intel-eyebrow mb-2">Top Player Counts</div>
        ${renderAgentNodeList(topPlayers, 'No agent player counts available.')}
      </div>
      <div>
        <div class="intel-eyebrow mb-2">Unusual Rates</div>
        ${unusualRates.length ? `<div class="agent-node-list">${unusualRates.map(node => `<div class="agent-node-row"><span><strong>${escapeHtml(node.login || node.agentId)}</strong><small>L${escapeHtml(node.level)} · max rate ${Number(node.maxRate || 0).toFixed(2)}</small></span></div>`).join('')}</div>` : '<div class="intel-empty">No unusual rates in this branch.</div>'}
      </div>
      <div>
        <div class="intel-eyebrow mb-2">Level Distribution</div>
        <div class="agent-level-bars">${Object.entries(levels).sort().map(([level, count]) => `<div><span>${escapeHtml(level)}</span><div class="exposure-bar"><div class="exposure-bar-fill" style="width:${(Number(count) / maxLevelCount) * 100}%;"></div></div><strong>${Number(count).toLocaleString()}</strong></div>`).join('')}</div>
      </div>
    </div>
  </div>`;
}

function renderAgentNodeList(nodes, emptyText) {
  if (!nodes.length) return `<div class="intel-empty">${escapeHtml(emptyText)}</div>`;
  return `<div class="agent-node-list" role="tree" aria-label="Agent branch">${nodes.slice(0, 80).map(node => `<button type="button" class="agent-node-row" role="treeitem" aria-expanded="${Number(node.childCount || 0) > 0 ? 'false' : 'undefined'}" onclick="openAgentTreeFromProfile('${escapeJs(node.agentId)}')">
    <span><strong>${escapeHtml(node.login || node.agentId)}</strong><small>${escapeHtml(node.agentId)} · L${escapeHtml(node.level)} · ${escapeHtml(node.agentType)}</small></span>
    <span class="font-mono">${Number(node.playerCount || 0).toLocaleString()}</span>
  </button>`).join('')}</div>`;
}

function openAgentTreeFromProfile(agentId) {
  closePlayerProfileModal(false);
  switchSection('agentTree', getSidebarButton('agentTree'));
  setTimeout(() => {
    refreshAgentDownline(true).then(() => {
      const target = agentTreeFlat.find(node => node.AgentID === agentId || node.agent === agentId);
      if (target) {
        let current = target;
        while (current) {
          current.expanded = true;
          current = agentTreeFlat.find(node => (node.children || []).includes(current));
        }
        renderAgentTree(agentTreeData);
        if (currentSection === 'agentTree') initAgentCanvas();
      }
    }).catch(() => {});
  }, 0);
}

function renderRiskFactors(profile) {
  const stats = profile.stats || {};
  const accessLogs = profile.accessLogs || [];
  const deposits = profile.deposits || [];
  const agentContext = profile.agentContext || {};
  const assignedAgent = agentContext.assigned || {};
  const live = profile.buckeye || {};
  const liveInfo = live.info?.snapshot?.raw || {};
  const factors = [];
  if (Number(stats.patternHits || 0) > 0) factors.push(['warn', `${Number(stats.patternHits || 0)} wager pattern flag${Number(stats.patternHits || 0) === 1 ? '' : 's'} detected`]);
  if (accessLogs.some(row => row.isNewIp)) factors.push(['danger', `${accessLogs.filter(row => row.isNewIp).length} new IP login${accessLogs.filter(row => row.isNewIp).length === 1 ? '' : 's'} in profile window`]);
  if (deposits.some(row => !row.ip_matched_login)) factors.push(['warn', 'Deposit IP mismatch needs review']);
  if (liveInfo.SuspendAccount === 'Y') factors.push(['danger', 'Account suspended in Buckeye']);
  if (Number(liveInfo.CurrentBalance || 0) < -1000000) factors.push(['danger', `Negative balance ${formatCompactDollars(Number(liveInfo.CurrentBalance || 0) / 100)}`]);
  if (Number(liveInfo.PendingWagerCount || 0) > 5) factors.push(['warn', `${Number(liveInfo.PendingWagerCount || 0)} pending wagers`]);
  if (assignedAgent.playerCount >= 250) factors.push(['warn', `Assigned agent carries ${Number(assignedAgent.playerCount).toLocaleString()} seeded players`]);
  if ((agentContext.children || []).length >= 25) factors.push(['probe', `Agent has ${(agentContext.children || []).length} direct child agents; inspect cluster risk`]);
  if (!profile.accountSnapshots?.length && !live.info?.snapshot) factors.push(['probe', 'Customer profile/KYC endpoint still needs probe confirmation']);
  if (!factors.length) factors.push(['good', 'No high-signal risk factors in captured data']);
  return factors.slice(0, 4).map(([level, text]) => `<div class="intel-risk-factor ${level}"><span></span>${escapeHtml(text)}</div>`).join('');
}

function renderCompactFlags(flags) {
  if (!flags.length) return '<div class="intel-empty">No manual flags yet.</div>';
  return `<div class="intel-stack">${flags.slice(0, 3).map(flag => `<div class="intel-flag-card ${escapeHtml(flag.severity || 'info')}">
    <div><strong>${escapeHtml(flag.label || flag.flag_type || 'Flag')}</strong><small>${escapeHtml(formatShortDateTime(flag.created_at))}</small></div>
    <p>${escapeHtml(flag.details || flag.status || 'Open')}</p>
  </div>`).join('')}</div>`;
}

function renderCompactNotes(notes) {
  if (!notes.length) return '<div class="intel-empty">No notes yet. Add Telegram handles, VIP host context, or compliance notes from the Notes tab.</div>';
  return `<div class="intel-stack">${notes.slice(0, 2).map(note => `<div class="intel-note-card">
    <div><strong>${escapeHtml(note.note_type || 'Note')}</strong><small>${escapeHtml(formatShortDateTime(note.created_at))}</small></div>
    <p>${escapeHtml(note.body || '')}</p>
  </div>`).join('')}</div>`;
}

function renderIntelWagerFeed(wagers) {
  if (!wagers.length) return '<div class="intel-empty">No wagers captured yet.</div>';
  return wagers.slice(0, 12).map(row => renderIntelWagerCard(row)).join('');
}

function renderIntelWagerCard(row) {
  const w = normalizeBackendWager(row);
  const flags = row.pattern_flags || row.patternFlags || [];
  const pattern = intelWagerPattern(row, flags);
  const clv = Number(row.clv_percent ?? row.clvPercent ?? 0);
  const sport = w.Sport || parseSport(w.ShortDesc) || 'Unknown';
  return `<div class="intel-wager-card ${pattern.className}">
    <div class="intel-wager-main">
      <div class="intel-sport-token">${escapeHtml(String(sport).slice(0, 3).toUpperCase())}</div>
      <div class="min-w-0">
        <strong>${escapeHtml(parseDescription(w.ShortDesc) || w.WagerType || 'Wager')}</strong>
        <span>${escapeHtml(w.WagerType || 'Ticket')} · #${escapeHtml(w.WagerNumber || '-')}</span>
      </div>
      <div class="intel-wager-amount">${formatCompactDollars(w.AmountWagered)}</div>
    </div>
    <div class="intel-wager-meta">
      <span>${escapeHtml(formatShortDateTime(w.InsertDateTime))}</span>
      <span>To win ${escapeHtml(formatCompactDollars(w.ToWinAmount))}</span>
      ${pattern.label ? `<span class="intel-pattern-pill ${pattern.key}">${escapeHtml(pattern.label)}</span>` : ''}
      ${clv ? `<span class="${clv >= 0 ? 'good' : 'danger'}">CLV ${clv.toFixed(2)}%</span>` : ''}
    </div>
  </div>`;
}

function intelWagerPattern(row, flags) {
  const text = Array.isArray(flags) ? flags.join(' ').toLowerCase() : '';
  const clv = Math.abs(Number(row.clv_percent ?? row.clvPercent ?? 0));
  if (text.includes('past')) return { key: 'pastpost', label: 'Past post', className: 'pattern-pastpost' };
  if (text.includes('stale')) return { key: 'stale', label: 'Stale', className: 'pattern-stale' };
  if (text.includes('burst')) return { key: 'burst', label: 'Burst', className: 'pattern-burst' };
  if (text.includes('clv') || clv >= 3) return { key: 'clv', label: 'CLV', className: 'pattern-clv' };
  return { key: '', label: '', className: '' };
}

function renderWeeklyPnlSummary(weeklyPnl) {
  if (!weeklyPnl.length) return '<div class="intel-empty mt-3">No weekly P&L buckets yet.</div>';
  const total = weeklyPnl.reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const best = weeklyPnl.reduce((max, row) => Math.max(max, Number(row.pnl || 0)), Number.NEGATIVE_INFINITY);
  const worst = weeklyPnl.reduce((min, row) => Math.min(min, Number(row.pnl || 0)), Number.POSITIVE_INFINITY);
  return `<div class="intel-summary-strip">
    <span>Net <strong class="${total >= 0 ? 'good' : 'danger'}">${formatCompactDollars(total)}</strong></span>
    <span>Best <strong class="good">${formatCompactDollars(best)}</strong></span>
    <span>Worst <strong class="danger">${formatCompactDollars(worst)}</strong></span>
  </div>`;
}

function renderLivePnlSummary(livePerf) {
  if (!livePerf.length) return '<div class="intel-empty mt-3">No live P&L data.</div>';
  const entries = livePerf.map(row => ({
    date: row.Date || '',
    pnl: (Number(row.Won || 0) - Number(row.Lost || 0)) / 100,
  }));
  const total = entries.reduce((sum, row) => sum + row.pnl, 0);
  const best = entries.reduce((max, row) => Math.max(max, row.pnl), Number.NEGATIVE_INFINITY);
  const worst = entries.reduce((min, row) => Math.min(min, row.pnl), Number.POSITIVE_INFINITY);
  return `<div class="intel-summary-strip">
    <span>Net <strong class="${total >= 0 ? 'good' : 'danger'}">${formatCompactDollars(total)}</strong></span>
    <span>Best <strong class="good">${formatCompactDollars(best)}</strong></span>
    <span>Worst <strong class="danger">${formatCompactDollars(worst)}</strong></span>
    <span style="color:var(--text-dim);font-size:10px;">${entries.length} days</span>
  </div>`;
}

function renderClvBySport(profile) {
  const wagers = profile.recentWagers || [];
  const bySport = new Map();
  for (const row of wagers) {
    const w = normalizeBackendWager(row);
    const sport = w.Sport || parseSport(w.ShortDesc) || 'Unknown';
    const clv = Number(row.clv_percent ?? row.clvPercent ?? 0);
    if (!bySport.has(sport)) bySport.set(sport, { count: 0, clv: 0 });
    const bucket = bySport.get(sport);
    bucket.count += 1;
    bucket.clv += clv;
  }
  const rows = [...bySport.entries()].slice(0, 5);
  if (!rows.length) return '<div class="intel-empty">No CLV samples yet. True CLV remains estimated until closing-line fields are confirmed.</div>';
  return `<div class="intel-stack">${rows.map(([sport, row]) => {
    const avg = row.count ? row.clv / row.count : 0;
    return `<div class="intel-clv-row">
      <span>${escapeHtml(sport)}</span>
      <strong class="${avg >= 0 ? 'good' : 'danger'}">${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%</strong>
      <small>${row.count} bets</small>
    </div>`;
  }).join('')}</div>
  <div class="intel-footnote">Estimated from archived wager payloads unless Buckeye returns confirmed closing-line fields.</div>`;
}

function renderLinkedAccountCards(profile) {
  const links = profile.links || [];
  if (!links.length) return '<div class="intel-empty">No linked accounts detected yet. Run a check to compare shared IP and device evidence.</div>';
  return `<div class="intel-stack">${links.slice(0, 4).map(row => {
    const other = row.player_a === profile.playerId ? row.player_b : row.player_a;
    const encodedOther = encodeURIComponent(String(other || ''));
    return `<button type="button" class="intel-linked-card" onclick="openPlayerProfileModal(decodeURIComponent('${encodedOther}'))">
      <span>${escapeHtml(other || '-')}</span>
      <small>${escapeHtml(row.reason || 'Link evidence')}</small>
      <strong>${Math.round(Number(row.confidence || 0) * 100)}%</strong>
    </button>`;
  }).join('')}</div>`;
}

function renderAccessLogCards(profile) {
  const logs = profile.accessLogs || [];
  if (!logs.length) return '<div class="intel-empty">No access logs captured yet.</div>';
  return logs.slice(0, 8).map(log => `<div class="intel-access-card ${log.isNewIp ? 'novel' : ''}">
    <div><strong>${escapeHtml(log.ip_address || '-')}</strong>${log.isNewIp ? '<span>New IP</span>' : ''}</div>
    <p>${escapeHtml(log.geo || 'Unknown geo')} · ${escapeHtml(log.device || 'Unknown device')}</p>
    <small>${escapeHtml(formatShortDateTime(log.access_datetime))} · ${escapeHtml(log.operation || log.log_type || 'access')}</small>
  </div>`).join('');
}

function renderGeoDistribution(profile) {
  const logs = profile.accessLogs || [];
  if (!logs.length) return '<div class="intel-empty">No geo distribution available.</div>';
  const counts = new Map();
  for (const log of logs) counts.set(log.geo || 'Unknown', (counts.get(log.geo || 'Unknown') || 0) + 1);
  const max = Math.max(...counts.values(), 1);
  return `<div class="intel-stack">${[...counts.entries()].slice(0, 4).map(([geo, count]) => {
    const pct = Math.round((count / max) * 100);
    return `<div class="intel-location-row">
      <div><span>${escapeHtml(geo)}</span><strong>${count}</strong></div>
      <div class="intel-location-track"><div style="width:${pct}%;"></div></div>
    </div>`;
  }).join('')}</div>`;
}

function focusPlayerFlagComposer() {
  setPlayerProfileTab('notes');
  setTimeout(() => document.getElementById('playerFlagLabel')?.focus(), 0);
}

function focusPlayerNoteComposer() {
  setPlayerProfileTab('notes');
  setTimeout(() => document.getElementById('playerNoteBody')?.focus(), 0);
}

function renderPlayerProfileWagers(profile) {
  const el = document.getElementById('playerProfileWagers');
  if (!el) return;
  const virtual = getVirtualHistoryRows(profile.recentWagers || [], 'wagers');
  const wagers = virtual.rows;
  const pageSize = playerProfileState.wagerPageSize;
  const pageCount = Math.max(1, Math.ceil(wagers.length / pageSize));
  playerProfileState.wagerPage = Math.min(playerProfileState.wagerPage, pageCount);
  const start = (playerProfileState.wagerPage - 1) * pageSize;
  const rows = wagers.slice(start, start + pageSize);
  el.innerHTML = `
    <div class="rounded-lg border overflow-auto" style="border-color:var(--border);">
      <table class="profile-table">
        <thead><tr><th>#</th><th>Type</th><th>Description</th><th>Flags</th><th class="text-right">CLV</th><th class="text-right">Wagered</th><th class="text-right">To Win</th><th>Sport</th><th>Time</th></tr></thead>
        <tbody>${rows.map((row, idx) => playerProfileWagerRow(row, idx === 0 && row.__live)).join('') || '<tr><td colspan="9" class="text-center" style="color:var(--text-dim);">No wagers found.</td></tr>'}</tbody>
      </table>
    </div>
    ${virtual.moreHtml}
    <div class="profile-pager">
      <button class="px-2 py-1 rounded text-xs" style="background:var(--panel);border:1px solid var(--border);" onclick="setPlayerWagerPage(${playerProfileState.wagerPage - 1})">Prev</button>
      <span class="text-xs" style="color:var(--text-dim);">Page ${playerProfileState.wagerPage} of ${pageCount}</span>
      <button class="px-2 py-1 rounded text-xs" style="background:var(--panel);border:1px solid var(--border);" onclick="setPlayerWagerPage(${playerProfileState.wagerPage + 1})">Next</button>
    </div>`;
}

function playerProfileWagerRow(row, isLive = false) {
  const w = normalizeBackendWager(row);
  const flags = row.pattern_flags || row.patternFlags || [];
  const clv = Number(row.clv_percent ?? row.clvPercent ?? 0);
  return `<tr class="${[isLive ? 'player-live-row' : '', patternRowClass(row)].filter(Boolean).join(' ')}">
    <td class="font-mono">${escapeHtml(w.WagerNumber)}</td>
    <td>${escapeHtml(w.WagerType || '-')}</td>
    <td style="max-width:520px;"><div class="truncate" title="${escapeHtml(w.ShortDesc)}">${escapeHtml(parseDescription(w.ShortDesc))}</div></td>
    <td>${renderPatternPills(flags)}</td>
    <td class="text-right font-mono ${clv >= 0 ? 'clv-positive' : 'clv-negative'}">${clv ? `${clv.toFixed(2)}%` : '-'}</td>
    <td class="text-right font-mono">$${Math.round(w.AmountWagered).toLocaleString()}</td>
    <td class="text-right font-mono">$${Math.round(w.ToWinAmount).toLocaleString()}</td>
    <td>${escapeHtml(w.Sport || parseSport(w.ShortDesc))}</td>
    <td style="color:var(--text-dim);">${formatShortDateTime(w.InsertDateTime)}</td>
  </tr>`;
}

function renderPatternPills(flags) {
  if (!Array.isArray(flags) || !flags.length) return '<span style="color:var(--text-dim);">-</span>';
  return flags.slice(0, 3).map(flag => `<span class="pattern-flag-pill">${escapeHtml(String(flag).replace(/_/g, ' '))}</span>`).join('');
}

function patternRowClass(row) {
  const severity = row.pattern_severity || row.patternSeverity || '';
  if (severity === 'critical') return 'pattern-row-critical';
  if (severity === 'warning') return 'pattern-row-warning';
  if (severity === 'watch') return 'pattern-row-watch';
  return '';
}

function setPlayerWagerPage(page) {
  const wagers = playerProfileState.profile?.recentWagers || [];
  const pageCount = Math.max(1, Math.ceil(wagers.length / playerProfileState.wagerPageSize));
  playerProfileState.wagerPage = Math.min(Math.max(1, page), pageCount);
  renderPlayerProfileWagers(playerProfileState.profile);
}

function renderPlayerProfileAccess(profile) {
  const el = document.getElementById('playerProfileAccess');
  if (!el) return;
  const filters = playerProfileState.accessLogFilters || {};
  const liveLogs = playerProfileState.accessLogLive || [];
  const displayLogs = liveLogs.length ? liveLogs : (profile.accessLogs || []);
  const virtual = getVirtualHistoryRows(displayLogs, 'access');
  const logs = virtual.rows;

  const today = new Date().toISOString().split('T')[0];
  const defaultStart = filters.start || today;
  const defaultEnd = filters.end || today;
  const defaultCustomer = filters.customerId || profile.playerId || '';

  el.innerHTML = `
    <div class="mb-3" style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;">
      <div>
        <label class="text-[10px] uppercase tracking-wider" style="color:var(--text-dim);display:block;margin-bottom:2px;">Actions</label>
        <select id="accessActionsFilter" class="text-xs px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);min-width:150px;">
          <option value="A" ${filters.actions === 'A' ? 'selected' : ''}>Web Access Log</option>
          <option value="B" ${filters.actions === 'B' ? 'selected' : ''}>Global IP Matcher</option>
          <option value="C" ${filters.actions === 'C' ? 'selected' : ''}>Acct IP Match</option>
          <option value="I" ${filters.actions === 'I' ? 'selected' : ''}>Users by IP</option>
        </select>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-wider" style="color:var(--text-dim);display:block;margin-bottom:2px;">Customer</label>
        <input id="accessCustomerFilter" type="text" value="${escapeHtml(defaultCustomer)}" placeholder="Player ID" class="text-xs px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);width:120px;">
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-wider" style="color:var(--text-dim);display:block;margin-bottom:2px;">Start</label>
        <input id="accessStart" type="date" value="${defaultStart}" class="text-xs px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);">
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-wider" style="color:var(--text-dim);display:block;margin-bottom:2px;">End</label>
        <input id="accessEnd" type="date" value="${defaultEnd}" class="text-xs px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);">
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-wider" style="color:var(--text-dim);display:block;margin-bottom:2px;">IP</label>
        <input id="accessIpFilter" type="text" value="${escapeHtml(filters.ip || '')}" placeholder="Filter IP" class="text-xs px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);width:120px;">
      </div>
      <button id="accessFetchBtn" class="px-3 py-1.5 rounded text-xs font-medium" style="background:var(--accent);color:#fff;" onclick="loadPlayerProfileAccessLogs()">Fetch Live</button>
    </div>
    <div class="rounded-lg border overflow-auto" style="border-color:var(--border);">
      <table class="profile-table">
        <thead><tr><th>Time</th><th>Login</th><th>IP</th><th>Flag</th><th>Geo</th><th>Operation</th><th>Data</th></tr></thead>
        <tbody>${logs.map(log => {
          const geoLabel = log.geo ? [log.geo.city, log.geo.region, log.geo.country].filter(Boolean).join(', ') : '';
          return `<tr class="${log.isNewIp ? 'new-ip-row' : ''}">
          <td style="color:var(--text-dim);">${formatShortDateTime(log.access_datetime || log.AccessDateTime)}</td>
          <td class="font-mono">${escapeHtml(log.login_id || log.LoginID || log.customer_id || '')}</td>
          <td class="font-mono">${escapeHtml(log.ip_address || log.IPAddress || '')}</td>
          <td>${log.isNewIp ? '<span class="new-ip-pill px-2 py-0.5 rounded text-xs">New IP</span>' : '<span style="color:var(--text-dim);">Known</span>'}</td>
          <td style="color:var(--text-dim);font-size:11px;">${escapeHtml(geoLabel) || '-'}</td>
          <td>${escapeHtml(log.operation || log.log_type || log.Operation || '-')}</td>
          <td>${escapeHtml(log.data || log.Data || '-')}</td>
        </tr>`}).join('') || '<tr><td colspan="7" class="text-center" style="color:var(--text-dim);">No access logs found. Click Fetch Live to load from Buckeye.</td></tr>'}</tbody>
      </table>
    </div>${virtual.moreHtml}`;

  // Wire up action-dependent field enable/disable
  const actionsSelect = document.getElementById('accessActionsFilter');
  if (actionsSelect) {
    actionsSelect.addEventListener('change', function () {
      const action = this.value;
      const customerField = document.getElementById('accessCustomerFilter');
      const ipField = document.getElementById('accessIpFilter');
      if (!customerField || !ipField) return;
      if (action === 'B' || action === 'I') {
        customerField.disabled = true;
        ipField.disabled = false;
      } else if (action === 'C') {
        customerField.disabled = false;
        ipField.disabled = true;
      } else {
        customerField.disabled = false;
        ipField.disabled = false;
      }
    });
    actionsSelect.dispatchEvent(new Event('change'));
  }
}

async function loadPlayerProfileAccessLogs() {
  const actions = document.getElementById('accessActionsFilter')?.value || 'A';
  const customerId = document.getElementById('accessCustomerFilter')?.value?.trim() || '';
  const startInput = document.getElementById('accessStart')?.value || '';
  const endInput = document.getElementById('accessEnd')?.value || '';
  const ip = document.getElementById('accessIpFilter')?.value?.trim() || '';

  // Convert YYYY-MM-DD to MM/DD/YYYY for Buckeye API
  function fmtDate(d) {
    if (!d) return '';
    const [y, m, day] = d.split('-');
    return `${m}/${day}/${y}`;
  }
  const start = fmtDate(startInput);
  const end = fmtDate(endInput);

  playerProfileState.accessLogFilters = { actions, customerId, start: startInput, end: endInput, ip };

  const btn = document.getElementById('accessFetchBtn');
  if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }

  try {
    const url = new URL(`${getApiBaseUrl()}/api/buckeye/web-log`);
    if (customerId) url.searchParams.set('customerId', customerId);
    if (start) url.searchParams.set('start', start);
    if (end) url.searchParams.set('end', end);
    url.searchParams.set('type', 'B');
    url.searchParams.set('actions', actions);
    if (ip) url.searchParams.set('ip', ip);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const novel = json.novel || {};
    const rows = (json.data || []).map(row => {
      const key = `${row.LoginID}|${row.IPAddress}`;
      return {
        login_id: row.LoginID,
        ip_address: row.IPAddress,
        access_datetime: row.AccessDateTime,
        operation: row.Operation,
        data: row.Data,
        isNewIp: Boolean(novel[key]),
        geo: row.geo,
      };
    });
    playerProfileState.accessLogLive = rows;
    renderPlayerProfileAccess(playerProfileState.profile);
  } catch (err) {
    console.error('[Access Logs] Live fetch failed:', err);
    alert('Failed to fetch access logs: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    if (btn) { btn.textContent = 'Fetch Live'; btn.disabled = false; }
  }
}

function exportGlobalIpTrackerCsv() {
  const rows = window._globalIpTrackerRows || [];
  if (!rows.length) return;
  const header = 'Time,Login,IP,Geo,Operation,Data\n';
  const csv = rows.map(r => {
    const geoLabel = r.geo ? [r.geo.city, r.geo.region, r.geo.country].filter(Boolean).join(' ') : '';
    return `${r.access_datetime || ''},${r.login_id || ''},${r.ip_address || ''},${geoLabel},${(r.operation || '').replace(/,/g, ' ')},${(r.data || '').replace(/,/g, ' ')}`;
  }).join('\n');
  const blob = new Blob([header + csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ip-tracker-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  showToast('IP Tracker results exported to CSV', 'success');
}

async function loadGlobalIpTracker() {
  const actions = document.getElementById('globalIpActionsFilter')?.value || 'B';
  const ip = document.getElementById('globalIpFilter')?.value?.trim() || '';
  const startInput = document.getElementById('globalIpStart')?.value || '';
  const endInput = document.getElementById('globalIpEnd')?.value || '';

  if (!ip) {
    alert('IP address is required');
    return;
  }

  function fmtDate(d) {
    if (!d) return '';
    const [y, m, day] = d.split('-');
    return `${m}/${day}/${y}`;
  }
  const start = fmtDate(startInput);
  const end = fmtDate(endInput);
  const today = new Date().toISOString().split('T')[0];
  const effectiveStart = start || today;
  const effectiveEnd = end || today;

  const btn = document.getElementById('globalIpFetchBtn');
  if (btn) { btn.textContent = 'Searching...'; btn.disabled = true; }

  try {
    const url = new URL(`${getApiBaseUrl()}/api/buckeye/web-log`);
    url.searchParams.set('start', effectiveStart);
    url.searchParams.set('end', effectiveEnd);
    url.searchParams.set('type', 'B');
    url.searchParams.set('actions', actions);
    url.searchParams.set('ip', ip);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rows = (json.data || []).map(row => ({
      login_id: row.LoginID,
      ip_address: row.IPAddress,
      access_datetime: row.AccessDateTime,
      operation: row.Operation,
      data: row.Data,
      geo: row.geo,
    }));

    const tbody = document.getElementById('globalIpTrackerRows');
    if (tbody) {
      tbody.innerHTML = rows.map(log => {
        const geoLabel = log.geo ? [log.geo.city, log.geo.region, log.geo.country].filter(Boolean).join(', ') : '';
        return `<tr>
        <td class="px-3 py-2" style="color:var(--text-dim);">${formatShortDateTime(log.access_datetime)}</td>
        <td class="px-3 py-2 font-mono">${escapeHtml(log.login_id)}</td>
        <td class="px-3 py-2 font-mono">${escapeHtml(log.ip_address)}</td>
        <td class="px-3 py-2" style="color:var(--text-dim);">${escapeHtml(geoLabel) || '-'}</td>
        <td class="px-3 py-2">${escapeHtml(log.operation || '-')}</td>
        <td class="px-3 py-2">${escapeHtml(log.data || '-')}</td>
      </tr>`}).join('') || '<tr><td colspan="6" class="px-3 py-6 text-center" style="color:var(--text-dim);">No accounts found for this IP.</td></tr>';
    }
    const exportBtn = document.getElementById('globalIpExportBtn');
    if (exportBtn) exportBtn.classList.toggle('hidden', rows.length === 0);
    window._globalIpTrackerRows = rows;
  } catch (err) {
    console.error('[IP Tracker] Search failed:', err);
    alert('Failed to search IP: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    if (btn) { btn.textContent = 'Investigate'; btn.disabled = false; }
  }
}

function renderPlayerProfilePerformance(profile) {
  const el = document.getElementById('playerProfilePerformance');
  if (!el) return;
  const live = profile.buckeye || {};
  const livePerf = live.performance?.data || [];
  const liveChartHtml = livePerf.length ? `
    <div class="profile-chart-card mb-4">
      <h3 class="text-sm font-semibold mb-3">30-Day P&L (Buckeye Live) <span class="intel-live-dot" style="display:inline-block;vertical-align:middle;margin-left:6px;"></span></h3>
      <div class="profile-chart-box"><canvas id="playerLivePnlChart"></canvas></div>
      ${renderLivePnlSummary(livePerf)}
    </div>` : '';
  el.innerHTML = `
    ${liveChartHtml}
    <div class="grid grid-cols-2 gap-4">
      <div class="profile-chart-card">
        <h3 class="text-sm font-semibold mb-3">4-Week P&L</h3>
        <div class="profile-chart-box"><canvas id="playerPerformanceLineChart"></canvas></div>
      </div>
      <div class="profile-chart-card">
        <h3 class="text-sm font-semibold mb-3">Sport Breakdown</h3>
        <div class="profile-chart-box"><canvas id="playerSportDonutChart"></canvas></div>
      </div>
    </div>`;
  renderPlayerPerformanceCharts(profile);
  if (livePerf.length) renderPlayerLivePnlChart(livePerf);
}

function renderPlayerProfileDeposits(profile) {
  const el = document.getElementById('playerProfileDeposits');
  if (!el) return;
  const virtual = getVirtualHistoryRows(profile.deposits || [], 'deposits');
  const deposits = virtual.rows;
  const txVirtual = getVirtualHistoryRows(profile.transactions || [], 'transactions');
  const transactions = txVirtual.rows;
  el.innerHTML = `<div class="profile-chart-card mb-3">
    <h3 class="text-sm font-semibold mb-1">Deposit Intelligence</h3>
    <div class="text-xs" style="color:var(--text-dim);">Deposits are filtered from real Buckeye transaction candidates. The combined transaction ledger is shown below for audit context.</div>
  </div>
  <div class="rounded-lg border overflow-auto" style="border-color:var(--border);">
    <table class="profile-table">
      <thead><tr><th>Time</th><th class="text-right">Amount</th><th>Method</th><th>Currency</th><th>IP</th><th>Login IP Match</th><th>Status</th></tr></thead>
      <tbody>${deposits.map(row => `<tr class="${row.ip_matched_login ? '' : 'deposit-mismatch-row'}">
        <td style="color:var(--text-dim);">${formatShortDateTime(row.transaction_time)}</td>
        <td class="text-right font-mono">$${Math.round(Number(row.amount || 0)).toLocaleString()}</td>
        <td>${escapeHtml(row.method || '-')}</td>
        <td>${escapeHtml(row.currency || '-')}</td>
        <td class="font-mono">${escapeHtml(row.ip_address || '-')}</td>
        <td>${row.ip_matched_login ? '<span style="color:var(--green);">Matched</span>' : '<span style="color:var(--yellow);">Unmatched</span>'}</td>
        <td>${escapeHtml(row.status || '-')}</td>
      </tr>`).join('') || profileEmptyRow('No deposits captured yet. Run the Buckeye transaction probe before enabling a poller.', 7)}</tbody>
    </table>
  </div>${virtual.moreHtml}
  <div class="profile-chart-card mt-4 mb-3">
    <h3 class="text-sm font-semibold mb-1">Transaction Ledger</h3>
    <div class="text-xs" style="color:var(--text-dim);">Raw account movements from Buckeye getTransactionList/getTransactionHistory/getReportDeletedTransactions, normalized to dollars and classified without fabricating deposit rows.</div>
  </div>
  <div class="rounded-lg border overflow-auto" style="border-color:var(--border);">
    <table class="profile-table">
      <thead><tr><th>Time</th><th>Document</th><th>Category</th><th>Description</th><th class="text-right">Amount</th><th class="text-right">Balance</th><th>Entered By</th></tr></thead>
      <tbody>${transactions.map(row => `<tr>
        <td style="color:var(--text-dim);">${formatShortDateTime(row.transaction_time)}</td>
        <td class="font-mono">${escapeHtml(row.document_number || row.id || '-')}</td>
        <td>${profileStatusChip(row.category || 'other')}</td>
        <td>${escapeHtml(row.description || '-')}</td>
        <td class="text-right font-mono">$${Math.round(Number(row.amount || 0)).toLocaleString()}</td>
        <td class="text-right font-mono">$${Math.round(Number(row.balance || 0)).toLocaleString()}</td>
        <td>${escapeHtml(row.entered_by || '-')}</td>
      </tr>`).join('') || profileEmptyRow('No transaction ledger rows captured yet for this player.', 7)}</tbody>
    </table>
  </div>${txVirtual.moreHtml}`;
}

function renderPlayerProfileTransactions(profile) {
  playerTransactionRenderer.renderTransactions(profile);
}

function setPlayerTransactionTab(tab) {
  playerTransactionRenderer.setTransactionTab(tab);
}

function renderPlayerProfileAccount(profile) {
  const el = document.getElementById('playerProfileAccount');
  if (!el) return;
  const snapshots = profile.accountSnapshots || [];
  const live = profile.buckeye || {};
  const liveInfo = live.info?.snapshot?.raw || {};
  const hasLive = Boolean(liveInfo.CreditLimit);
  const liveSummary = hasLive ? `
    <div class="profile-chart-card mb-3">
      <h3 class="text-sm font-semibold mb-2">Live Account Summary <span class="intel-live-dot" style="display:inline-block;vertical-align:middle;margin-left:6px;"></span></h3>
      <div class="grid grid-cols-3 gap-3">
        ${profileStatCard('Credit Limit', formatCompactDollars(Number(liveInfo.CreditLimit || 0) / 100))}
        ${profileStatCard('Current Balance', `<span class="${Number(liveInfo.CurrentBalance || 0) < 0 ? 'danger' : 'good'}">${formatCompactDollars(Number(liveInfo.CurrentBalance || 0) / 100)}</span>`)}
        ${profileStatCard('Pending Wagers', `${Number(liveInfo.PendingWagerCount || 0).toLocaleString()} <small>($${formatCompactDollars(Number(liveInfo.PendingWagerBalance || 0) / 100)})</small>`)}
        ${profileStatCard('Carry Over', formatCompactDollars(Number(liveInfo.CarryOverAmount || 0) / 100))}
        ${profileStatCard('Settle Figure', formatCompactDollars(Number(liveInfo.SettleFigure || 0) / 100))}
        ${profileStatCard('Temp Credit', formatCompactDollars(Number(liveInfo.TempCreditAdj || 0) / 100))}
      </div>
    </div>` : '';
  el.innerHTML = `${liveSummary}
  <div class="profile-chart-card mb-3">
    <h3 class="text-sm font-semibold mb-1">Customer Account Snapshots</h3>
    <div class="text-xs" style="color:var(--text-dim);">PII fields are stored masked for display. Raw source payloads remain preserved server-side.</div>
  </div>
  <div class="profile-chart-card mb-3">
    <h3 class="text-sm font-semibold mb-2">KYC Document Status</h3>
    ${renderKycTimeline(snapshots)}
  </div>
  <div class="rounded-lg border overflow-auto" style="border-color:var(--border);">
    <table class="profile-table">
      <thead><tr><th>Snapshot</th><th>KYC</th><th>VIP</th><th>Email</th><th>Phone</th><th>Currency</th><th>Source</th></tr></thead>
      <tbody>${snapshots.map(row => `<tr>
        <td style="color:var(--text-dim);">${formatShortDateTime(row.snapshot_time)}</td>
        <td>${escapeHtml(row.kyc_level || '-')}</td>
        <td>${escapeHtml(row.vip_status || '-')}</td>
        <td>${escapeHtml(row.email_masked || '-')}</td>
        <td>${escapeHtml(row.phone_masked || '-')}</td>
        <td>${escapeHtml(row.currency || '-')}</td>
        <td>${escapeHtml(row.source || '-')}</td>
      </tr>`).join('') || profileEmptyRow('No account snapshots captured yet. Use the customer-info probe to validate source fields.', 7)}</tbody>
    </table>
  </div>`;
}

function renderKycTimeline(snapshots) {
  if (!snapshots.length) return '<div class="text-xs" style="color:var(--text-dim);">No KYC documents or verification timeline captured yet.</div>';
  return `<div class="space-y-2">${snapshots.slice(0, 5).map(row => `<div class="flex items-center justify-between gap-3 text-xs">
    <div><span class="font-semibold">${escapeHtml(row.kyc_level || 'Unspecified')}</span><span style="color:var(--text-dim);"> · ${escapeHtml(row.source || 'snapshot')}</span></div>
    <div class="font-mono" style="color:var(--text-dim);">${formatShortDateTime(row.snapshot_time)}</div>
  </div>`).join('')}</div>`;
}

function renderPlayerProfileLinks(profile) {
  const el = document.getElementById('playerProfileLinks');
  if (!el) return;
  const links = profile.links || [];
  el.innerHTML = `<div class="profile-chart-card mb-3">
    <div class="profile-action-row">
      <div>
        <h3 class="text-sm font-semibold mb-1">Possible Linked Accounts</h3>
        <div class="text-xs" style="color:var(--text-dim);">Shared-IP detection checks the last 30 days of access logs and stores matches in player_links.</div>
      </div>
      <button type="button" class="profile-action-button" onclick="checkPlayerMultiAccounts()">Check Multi-Accounts</button>
    </div>
  </div>
  <div class="rounded-lg border overflow-auto" style="border-color:var(--border);">
    <table class="profile-table">
      <thead><tr><th>Detected</th><th>Other Player</th><th>Reason</th><th>Confidence</th><th>Status</th></tr></thead>
      <tbody>${links.map(row => {
        const other = row.player_a === profile.playerId ? row.player_b : row.player_a;
        return `<tr>
          <td style="color:var(--text-dim);">${formatShortDateTime(row.detected_at)}</td>
          <td class="font-mono">${escapeHtml(other || '-')}</td>
          <td>${escapeHtml(row.reason || '-')}</td>
          <td class="font-mono">${Math.round(Number(row.confidence || 0) * 100)}%</td>
          <td>${escapeHtml(row.status || '-')}</td>
        </tr>`;
      }).join('') || profileEmptyRow('No linked accounts detected yet.', 5)}</tbody>
    </table>
  </div>`;
}

function renderPlayerProfileNotes(profile) {
  const el = document.getElementById('playerProfileNotes');
  if (!el) return;
  const flagVirtual = getVirtualHistoryRows(profile.flags || [], 'notes');
  const noteVirtual = getVirtualHistoryRows(profile.notes || [], 'notes');
  const flags = flagVirtual.rows;
  const notes = noteVirtual.rows;
  el.innerHTML = `
  <div class="profile-mini-form">
    <select id="playerFlagSeverity">
      <option value="info">Info</option>
      <option value="warning">Warning</option>
      <option value="high">High</option>
      <option value="critical">Critical</option>
    </select>
    <input id="playerFlagLabel" placeholder="Flag label">
    <input id="playerFlagDetails" placeholder="Compliance detail">
    <button type="button" onclick="createPlayerFlag()">Add Flag</button>
  </div>
  <div class="profile-mini-form">
    <select id="playerNoteType">
      <option value="general">General</option>
      <option value="telegram">Telegram</option>
      <option value="vip_host">VIP Host</option>
      <option value="kyc">KYC</option>
    </select>
    <input id="playerNoteBody" placeholder="Note, Telegram handle, or operator context">
    <span></span>
    <button type="button" onclick="createPlayerNote()">Add Note</button>
  </div>
  <div class="grid grid-cols-2 gap-4">
    <div class="profile-chart-card">
      <h3 class="text-sm font-semibold mb-3">Manual Flags</h3>
      <table class="profile-table">
        <thead><tr><th>Created</th><th>Severity</th><th>Label</th><th>Status</th></tr></thead>
        <tbody>${flags.map(row => `<tr>
          <td style="color:var(--text-dim);">${formatShortDateTime(row.created_at)}</td>
          <td>${escapeHtml(row.severity || '-')}</td>
          <td>${escapeHtml(row.label || '-')}</td>
          <td>${escapeHtml(row.status || '-')}</td>
        </tr>`).join('') || profileEmptyRow('No manual flags yet.', 4)}</tbody>
      </table>
      ${flagVirtual.moreHtml}
    </div>
    <div class="profile-chart-card">
      <h3 class="text-sm font-semibold mb-3">Operator Notes</h3>
      <table class="profile-table">
        <thead><tr><th>Created</th><th>Type</th><th>Note</th></tr></thead>
        <tbody>${notes.map(row => `<tr>
          <td style="color:var(--text-dim);">${formatShortDateTime(row.created_at)}</td>
          <td>${escapeHtml(row.note_type || '-')}</td>
          <td>${escapeHtml(row.body || '')}</td>
        </tr>`).join('') || profileEmptyRow('No notes yet.', 3)}</tbody>
      </table>
      ${noteVirtual.moreHtml}
    </div>
  </div>`;
}

function renderPlayerProfileStatus(profile) {
  const el = document.getElementById('playerProfileStatus');
  if (!el) return;
  profile = profile || { playerId: getActivePlayerProfileId(), stats: {} };
  const playerId = profile.playerId || playerProfileState.playerId || getStatusPlayerId();
  const mapReady = playerProfileState.statusMap?.playerId === playerId;
  const checksReady = Array.isArray(playerProfileState.statusEndpointChecks) && playerProfileState.statusEndpointChecks.length > 0;
  if (!mapReady || !checksReady) {
    el.innerHTML = `<div class="profile-skeleton-grid" aria-busy="true" aria-label="Checking Player 360 status">
      <div class="profile-skeleton"></div>
      <div class="profile-skeleton skeleton-wide"></div>
      <div class="profile-skeleton skeleton-wide"></div>
    </div>`;
    if (!playerProfileState.statusLoading) loadPlayerProfileStatus(playerId);
    return;
  }

  const map = playerProfileState.statusMap;
  const checks = playerProfileState.statusEndpointChecks;
  const missingSources = (map.sources || []).filter(source => sourceHealth(source).state === 'missing');
  const staleSources = (map.sources || []).filter(source => sourceHealth(source).state === 'stale');
  const downEndpoints = checks.filter(check => !check.ok);
  const latestSeen = latestProfileSourceSeen(map.sources || []);
  const tabRows = buildProfileTabCoverage(map, checks);

  el.innerHTML = `
    <div class="profile-status-header">
      <div>
        <h3>Player 360 Status</h3>
        <p>Endpoint health, source freshness, last seen data, and coverage gaps for ${escapeHtml(playerId)}.</p>
      </div>
      <div class="profile-status-actions">
        <button type="button" class="profile-action-button" onclick="refreshPlayerProfileStatus()">Recheck</button>
        <button type="button" class="profile-action-button" onclick="openSidebarStatusForPlayer()">Open Sidebar Status</button>
      </div>
    </div>

    <div class="profile-status-summary">
      ${profileStatusSummaryCard('Endpoints', `${checks.length - downEndpoints.length}/${checks.length}`, downEndpoints.length ? `${downEndpoints.length} down` : 'all reachable', downEndpoints.length ? 'danger' : 'good')}
      ${profileStatusSummaryCard('Missing Sources', String(missingSources.length), missingSources.length ? 'coverage gaps' : 'none', missingSources.length ? 'danger' : 'good')}
      ${profileStatusSummaryCard('Stale Sources', String(staleSources.length), staleSources.length ? 'check pollers' : 'fresh enough', staleSources.length ? 'warn' : 'good')}
      ${profileStatusSummaryCard('Latest Seen', latestSeen ? formatShortDateTime(latestSeen) : '-', latestSeen ? timeAgo(latestSeen) : 'no source rows', latestSeen ? 'good' : 'warn')}
    </div>

    <div class="profile-doc-grid">
      <div class="profile-doc-panel profile-doc-wide">
        <h3>Profile Tab Coverage</h3>
        <table class="profile-table">
          <thead><tr><th>Tab</th><th>Status</th><th>Endpoints</th><th>Sources</th><th>Recent Update</th><th>Refresh Policy</th><th>Coverage Action</th></tr></thead>
          <tbody>${tabRows.map(row => `<tr>
            <td class="font-mono">${escapeHtml(row.tab)}</td>
            <td>${profileStatusChip(row.status)}</td>
            <td>${row.endpoints.map(endpoint => endpointHealthPill(endpoint)).join(' ')}</td>
            <td>${row.sources.map(source => sourceHealthPill(source)).join(' ')}</td>
            <td>${row.recentUpdateAt ? `${formatShortDateTime(row.recentUpdateAt)} <span style="color:var(--text-dim);">(${escapeHtml(row.recentUpdateSource || '')})</span>` : '-'}</td>
            <td>${escapeHtml(row.refreshPolicySummary || '-')}</td>
            <td>${escapeHtml(row.action)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>

      <div class="profile-doc-panel profile-doc-wide">
        <h3>Endpoint Health</h3>
        <table class="profile-table">
          <thead><tr><th>Aspect</th><th>Route</th><th>Tab</th><th>Status</th><th>Latency</th><th>Sources</th></tr></thead>
          <tbody>${checks.map(check => `<tr>
            <td>${escapeHtml(check.aspect || check.label)}</td>
            <td class="font-mono">${escapeHtml(check.path)}</td>
            <td>${escapeHtml(check.tab || '-')}</td>
            <td>${endpointHealthPill(check)}</td>
            <td class="font-mono">${Number(check.ms || 0)}ms</td>
            <td>${(check.sources || []).map(source => `<span class="profile-status-chip derived">${escapeHtml(source)}</span>`).join(' ')}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>

      <div class="profile-doc-panel">
        <h3>Source Freshness</h3>
        <table class="profile-table">
          <thead><tr><th>Source</th><th>Buckeye Endpoint</th><th>Status</th><th>Refresh Policy</th><th>Rows</th><th>Last Seen</th><th>Last Attempt</th><th>Next Refresh</th><th>Gap / Action</th></tr></thead>
          <tbody>${(map.sources || []).map(source => {
            const health = sourceHealth(source);
            return `<tr>
              <td class="font-mono">${escapeHtml(source.key || source.label)}</td>
              <td>${escapeHtml(source.buckeyeEndpoint || '-')}</td>
              <td>${profileStatusChip(health.state)}</td>
              <td>${escapeHtml(source.refreshPolicy || '-')} / ${escapeHtml(source.scaleClass || '-')}</td>
              <td class="font-mono">${Number(source.rowCount || 0).toLocaleString()}</td>
              <td>${source.lastSeen ? `${formatShortDateTime(source.lastSeen)} <span style="color:var(--text-dim);">(${timeAgo(source.lastSeen)})</span>` : '-'}</td>
              <td>${source.lastAttemptAt ? formatShortDateTime(source.lastAttemptAt) : '-'}</td>
              <td>${source.nextRefreshAt ? formatShortDateTime(source.nextRefreshAt) : '-'}</td>
              <td>${escapeHtml(source.gap || sourceStatusAction(source.key))}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>

      <div class="profile-doc-panel">
        <h3>Coverage Gaps</h3>
        <table class="profile-table">
          <thead><tr><th>Gap</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${statusGapRows(map).map(gap => `<tr>
            <td>${escapeHtml(gap.label)}</td>
            <td>${profileStatusChip(gap.status)}</td>
            <td>${escapeHtml(gap.action)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="profile-doc-panel profile-doc-wide">
        <h3>Contract Mismatches</h3>
        <table class="profile-table">
          <thead><tr><th>Severity</th><th>Source</th><th>Status</th><th>Impacted Field</th><th>Correction</th></tr></thead>
          <tbody>${(map.contractMismatches || []).map(row => `<tr>
            <td>${escapeHtml(row.severity || '-')}</td>
            <td class="font-mono">${escapeHtml(row.source || '-')}</td>
            <td>${profileStatusChip(row.status || 'missing')}</td>
            <td>${escapeHtml(row.field || '-')}</td>
            <td>${escapeHtml(row.action || '-')}</td>
          </tr>`).join('') || profileEmptyRow('No contract mismatches detected.', 5)}</tbody>
        </table>
      </div>
    </div>`;
}

async function loadPlayerProfileStatus(playerId) {
  playerProfileState.statusLoading = true;
  try {
    const [map, checks] = await Promise.all([
      playerProfileState.intelligenceMap?.playerId === playerId ? playerProfileState.intelligenceMap : fetchPlayerIntelligenceMap(playerId),
      checkPlayerProfileEndpoints(playerId),
    ]);
    if (playerProfileState.playerId !== playerId) return;
    playerProfileState.intelligenceMap = map;
    playerProfileState.statusMap = map;
    playerProfileState.statusEndpointChecks = checks;
    playerProfileState.statusLoading = false;
    if (playerProfileState.tab === 'status') renderPlayerProfileStatus(playerProfileState.profile || { playerId, stats: {} });
  } catch (err) {
    playerProfileState.statusLoading = false;
    const el = document.getElementById('playerProfileStatus');
    if (el) el.innerHTML = `<div class="text-sm" style="color:var(--red);">Failed to load Player 360 status: ${escapeHtml(err?.message || err)}</div>`;
  }
}

function refreshPlayerProfileStatus() {
  const playerId = getActivePlayerProfileId();
  if (!playerId) return;
  playerProfileState.playerId = playerId;
  playerProfileState.statusMap = null;
  playerProfileState.statusEndpointChecks = [];
  renderPlayerProfileStatus(playerProfileState.profile || { playerId, stats: {} });
}

async function checkPlayerProfileEndpoints(playerId) {
  const endpoints = getPlayer360EndpointRegistry(playerId);
  const results = await Promise.allSettled(endpoints.map(async (endpoint) => {
    const start = performance.now();
    const res = await fetch(`${getApiBaseUrl()}${endpoint.path}`);
    return { ...endpoint, status: res.status, ok: res.status >= 200 && res.status < 400, ms: Math.round(performance.now() - start) };
  }));
  return results.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : { ...endpoints[index], status: 0, ok: false, ms: 0 });
}

function buildProfileTabCoverage(map, checks) {
  const byLabel = Object.fromEntries(checks.map(check => [check.label, check]));
  const sourceMap = Object.fromEntries((map.sources || []).map(source => [source.key, source]));
  const defaultRows = [
    { tab: 'Overview', endpoints: ['Profile', 'Intel Map'], sources: ['wager_archive', 'agent_performance_snapshots', 'customer_snapshots', 'player_flags', 'player_notes'] },
    { tab: 'Wager History', endpoints: ['Profile', 'Export Wagers'], sources: ['wager_archive'] },
    { tab: 'Access Logs', endpoints: ['Profile', 'Export Access', 'Audit Access'], sources: ['access_logs'] },
    { tab: 'Performance', endpoints: ['Profile'], sources: ['wager_archive', 'agent_performance_snapshots'] },
    { tab: 'Deposits', endpoints: ['Deposits', 'Transactions'], sources: ['player_transactions', 'deleted_transactions', 'deposits', 'access_logs'] },
    { tab: 'Account', endpoints: ['Snapshots'], sources: ['customer_snapshots'] },
    { tab: 'Links', endpoints: ['Links'], sources: ['player_links', 'access_logs'] },
    { tab: 'Notes', endpoints: ['Flags', 'Notes'], sources: ['player_flags', 'player_notes'] },
    { tab: 'Status / Docs', endpoints: ['Intel Map'], sources: ['all'] },
  ];
  const rows = (map.tabCoverage || defaultRows).map(row => ({
    ...row,
    endpoints: row.endpoints || defaultRows.find(defaultRow => defaultRow.tab === row.tab)?.endpoints || ['Profile'],
    sources: row.sources || defaultRows.find(defaultRow => defaultRow.tab === row.tab)?.sources || [],
  }));
  return rows.map(row => {
    const endpoints = row.endpoints.map(label => byLabel[label]).filter(Boolean);
    const sources = row.sources.includes('all') ? (map.sources || []) : row.sources.map(key => sourceMap[key]).filter(Boolean);
    const down = endpoints.some(endpoint => !endpoint.ok);
    const missing = sources.some(source => sourceHealth(source).state === 'missing');
    const stale = sources.some(source => sourceHealth(source).state === 'stale');
    const probe = sources.some(source => sourceHealth(source).state === 'probe');
    const status = down || missing ? 'missing' : stale ? 'probe' : probe ? 'probe' : 'live';
    return {
      ...row,
      endpoints,
      sources,
      status,
      recentUpdateAt: row.recentUpdateAt || oldestSourceUpdate(sources)?.timestamp || null,
      recentUpdateSource: row.recentUpdateSource || oldestSourceUpdate(sources)?.key || '',
      weakestSource: row.weakestSource || weakestCoverageSource(sources)?.key || '',
      refreshPolicySummary: row.refreshPolicySummary || Array.from(new Set(sources.map(source => source.refreshPolicy).filter(Boolean))).join(', '),
      action: profileCoverageAction(row.tab, endpoints, sources),
    };
  });
}

function oldestSourceUpdate(sources) {
  const timestamps = sources
    .map(source => ({ key: source.key, value: source.lastSuccessAt || source.lastSeen }))
    .filter(row => row.value)
    .map(row => ({ key: row.key, value: row.value, time: new Date(row.value).getTime() }))
    .filter(row => Number.isFinite(row.time))
    .sort((a, b) => a.time - b.time);
  return timestamps[0] ? { key: timestamps[0].key, timestamp: timestamps[0].value } : null;
}

function weakestCoverageSource(sources) {
  return sources.find(source => ['error', 'missing', 'stale', 'probe'].includes(sourceHealth(source).state)) || sources[0] || null;
}

function profileCoverageAction(tab, endpoints, sources) {
  const failedEndpoint = endpoints.find(endpoint => !endpoint.ok);
  if (failedEndpoint) return `Repair route ${failedEndpoint.path}; ${tab} cannot fully hydrate while it returns ${failedEndpoint.status}.`;
  const missingSource = sources.find(source => sourceHealth(source).state === 'missing');
  if (missingSource) return sourceCoverageAction(missingSource);
  const staleSource = sources.find(source => sourceHealth(source).state === 'stale');
  if (staleSource) return `Latest ${staleSource.key} row is stale; inspect the Buckeye poller and watermarks.`;
  const probeSource = sources.find(source => sourceHealth(source).state === 'probe');
  if (probeSource) return sourceCoverageAction(probeSource);
  return 'Coverage healthy for this tab.';
}

function sourceCoverageAction(source) {
  const key = source?.key || '';
  if (key === 'access_logs') return 'Run or repair getWebLog access polling for this player/agent; Access Logs and new-IP flags depend on it.';
  if (key === 'deposits') return 'Probe Buckeye transaction endpoints, then enable deposit polling once a candidate returns rows.';
  if (key === 'player_transactions') return 'Probe getTransactionList with acc=<player/account>&start= plus getTransactionHistory and getReportDeletedTransactions with customerID/startDate/endDate to populate the account ledger and classify deposit/withdrawal-like rows.';
  if (key === 'deleted_transactions') return 'Probe getReportDeletedTransactions with customerID/startDate/endDate to surface deleted withdrawals, deposits, adjustments, DeletedBy, and Telegram Bot AID evidence.';
  if (key === 'customer_snapshots') return 'Probe getInfoPlayer first, then customer-info endpoints to populate KYC, VIP, masked contact, and currency fields.';
  if (key === 'agent_performance_snapshots') return 'Run getPerformancePlayer with acc=<player/account>&period=0, falling back to getAgentPerformance for broader agent context.';
  if (key === 'player_links') return 'Run Check Multi-Accounts after access logs exist to derive shared-IP/device links.';
  if (key === 'player_flags' || key === 'player_notes') return 'Manual overlay is available; add flags or notes when operators have context.';
  return source?.gap || 'Investigate source freshness and endpoint coverage.';
}

function sourceHealth(source) {
  if (source?.freshnessState) return { state: source.freshnessState };
  const status = String(source?.status || 'missing').toLowerCase();
  if (status === 'live' && source?.lastSeen) {
    const age = Date.now() - new Date(source.lastSeen).getTime();
    if (Number.isFinite(age) && age > 30 * 60 * 1000) return { state: 'stale' };
  }
  if (status === 'manual') return { state: 'manual' };
  if (status === 'derived') return { state: 'derived' };
  if (status === 'probe') return { state: 'probe' };
  if (status === 'live') return { state: 'live' };
  return { state: 'missing' };
}

function endpointHealthPill(endpoint) {
  const status = endpoint?.ok ? 'live' : 'missing';
  return `<span class="profile-status-chip ${status}" title="${escapeHtml(endpoint?.path || '')}">${escapeHtml(endpoint?.label || endpoint?.status || '-')}: ${escapeHtml(String(endpoint?.status ?? '-'))}</span>`;
}

function sourceHealthPill(source) {
  const health = sourceHealth(source);
  return `<span class="profile-status-chip ${health.state}" title="${escapeHtml(source?.gap || '')}">${escapeHtml(source?.key || '-')}</span>`;
}

function profileStatusSummaryCard(label, value, subtext, tone) {
  return `<div class="profile-status-card ${tone}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    <small>${escapeHtml(subtext)}</small>
  </div>`;
}

function latestProfileSourceSeen(sources) {
  const timestamps = sources.map(source => source.lastSeen ? new Date(source.lastSeen).getTime() : 0).filter(Boolean);
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function statusGapRows(map) {
  const sourceGaps = (map.sources || [])
    .filter(source => ['missing', 'probe', 'stale'].includes(sourceHealth(source).state))
    .map(source => ({
      label: source.label || source.key,
      status: sourceHealth(source).state,
      action: sourceCoverageAction(source),
    }));
  const explicitGaps = (map.gaps || []).map(gap => ({
    label: gap.label || gap.key,
    status: gap.status || 'missing',
    action: gap.detail || 'Investigate missing source.',
  }));
  return [...sourceGaps, ...explicitGaps];
}

function openSidebarStatusForPlayer() {
  closePlayerProfileModal(false);
  switchSection('status', getSidebarButton('status'));
  loadStatusPage(true);
}

async function checkPlayerMultiAccounts() {
  const playerId = playerProfileState.playerId;
  if (!playerId) return;
  try {
    const body = await FactoryWager.apiFetch(`/players/${encodeURIComponent(playerId)}/links/check`, { method: 'POST' });
    showToast(`Multi-account check complete: ${Number(body.inserted || 0)} new link${Number(body.inserted || 0) === 1 ? '' : 's'}`, 'success');
    await refreshOpenPlayerProfile(playerId);
    setPlayerProfileTab('links');
  } catch (err) {
    showToast(err?.message || 'Multi-account check failed', 'error');
  }
}

async function createPlayerFlag() {
  const playerId = playerProfileState.playerId;
  if (!playerId) return;
  const severity = document.getElementById('playerFlagSeverity')?.value || 'info';
  const label = document.getElementById('playerFlagLabel')?.value?.trim() || 'Manual Review';
  const details = document.getElementById('playerFlagDetails')?.value?.trim() || '';
  try {
    await FactoryWager.apiFetch(`/players/${encodeURIComponent(playerId)}/flags`, {
      method: 'POST',
      body: { flag_type: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), severity, label, details, created_by: 'terminal' },
    });
    showToast('Player flag added', 'success');
    await refreshOpenPlayerProfile(playerId);
    setPlayerProfileTab('notes');
  } catch (err) {
    showToast(err?.message || 'Flag create failed', 'error');
  }
}

async function createPlayerNote() {
  const playerId = playerProfileState.playerId;
  if (!playerId) return;
  const noteType = document.getElementById('playerNoteType')?.value || 'general';
  const body = document.getElementById('playerNoteBody')?.value?.trim() || '';
  if (!body) {
    showToast('Note body is required', 'warning');
    return;
  }
  try {
    await FactoryWager.apiFetch(`/players/${encodeURIComponent(playerId)}/notes`, {
      method: 'POST',
      body: { note_type: noteType, body, created_by: 'terminal' },
    });
    showToast('Player note added', 'success');
    await refreshOpenPlayerProfile(playerId);
    setPlayerProfileTab('notes');
  } catch (err) {
    showToast(err?.message || 'Note create failed', 'error');
  }
}

function renderPlayerProfileDocs(profile) {
  playerDocsRenderer.renderDocs(profile);
}

function profileStatusChip(status) {
  const normalized = String(status || 'missing').toLowerCase();
  const labels = { fresh: 'Fresh', live: 'Live', derived: 'Derived', manual: 'Manual', probe: 'Probe', stale: 'Stale', error: 'Error', missing: 'Missing' };
  return `<span class="profile-status-chip ${normalized}">${escapeHtml(labels[normalized] || normalized)}</span>`;
}

function profileEmptyRow(message, colspan) {
  return `<tr><td colspan="${colspan}" class="text-center" style="color:var(--text-dim);">${escapeHtml(message)}</td></tr>`;
}

function getVirtualHistoryRows(rows, key) {
  const limit = Number(playerProfileState.virtualLimits?.[key] || 100);
  const safeRows = Array.isArray(rows) ? rows : [];
  const visible = safeRows.slice(0, limit);
  return {
    rows: visible,
    total: safeRows.length,
    limit,
    moreHtml: safeRows.length > limit
      ? `<div class="profile-virtual-note">Virtualized list: showing ${limit.toLocaleString()} of ${safeRows.length.toLocaleString()} newest rows. Use filters or export for the full history.</div>`
      : '',
  };
}

function renderPlayerMiniPnlChart(weeklyPnl) {
  const canvas = document.getElementById('playerMiniPnlChart');
  if (!canvas || !window.Chart) return;
  destroyPlayerProfileChart('mini');
  requestAnimationFrame(() => {
    if (!document.getElementById('playerMiniPnlChart')) return;
    destroyPlayerProfileChart('mini');
    playerProfileState.charts.mini = new Chart(canvas, {
      type: 'line',
      data: {
        labels: weeklyPnl.map(row => row.weekStart || row.week),
        datasets: [{ data: weeklyPnl.map(row => Number(row.pnl || 0)), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.12)', fill: true, tension: .35, pointRadius: 2 }],
      },
      options: chartBaseOptions(false),
    });
  });
}

function renderPlayerPerformanceCharts(profile) {
  if (!window.Chart) return;
  destroyPlayerProfileChart('line');
  destroyPlayerProfileChart('donut');
  const weeklyPnl = profile.weeklyPnl || [];
  const sports = profile.sportBreakdown || [];
  const lineCanvas = document.getElementById('playerPerformanceLineChart');
  const donutCanvas = document.getElementById('playerSportDonutChart');
  requestAnimationFrame(() => {
  if (lineCanvas) {
    playerProfileState.charts.line = new Chart(lineCanvas, {
      type: 'line',
      data: {
        labels: weeklyPnl.map(row => row.weekStart || row.week),
        datasets: [{ label: 'P&L', data: weeklyPnl.map(row => Number(row.pnl || 0)), borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,.12)', fill: true, tension: .3 }],
      },
      options: chartBaseOptions(true),
    });
  }
  if (donutCanvas) {
    playerProfileState.charts.donut = new Chart(donutCanvas, {
      type: 'doughnut',
      data: {
        labels: sports.map(row => row.sport || 'Unknown'),
        datasets: [{ data: sports.map(row => Number(row.volume || 0)), backgroundColor: ['#ff6600', '#06b6d4', '#10b981', '#f59e0b', '#8b5cf6', '#3b82f6', '#ef4444'] }],
      },
      options: chartBaseOptions(true),
    });
  }
  });
}

function chartBaseOptions(showLegend) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: showLegend, labels: { color: '#e5e7eb' } } },
    scales: { x: { ticks: { color: '#6b7280' }, grid: { color: 'rgba(31,41,55,.45)' } }, y: { ticks: { color: '#6b7280' }, grid: { color: 'rgba(31,41,55,.45)' } } },
  };
}

function destroyPlayerProfileChart(key) {
  if (playerProfileState.charts[key]) {
    playerProfileState.charts[key].destroy();
    delete playerProfileState.charts[key];
  }
}

function destroyPlayerProfileCharts() {
  Object.keys(playerProfileState.charts).forEach(destroyPlayerProfileChart);
}

function renderPlayerLivePnlChart(livePerf) {
  if (!window.Chart) return;
  destroyPlayerProfileChart('livePnl');
  const canvas = document.getElementById('playerLivePnlChart');
  if (!canvas) return;
  const entries = livePerf.map(row => ({
    date: row.Date || '',
    pnl: (Number(row.Won || 0) - Number(row.Lost || 0)) / 100,
  })).reverse();
  requestAnimationFrame(() => {
    playerProfileState.charts.livePnl = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: entries.map(row => row.date.split(' ')[0] || row.date),
        datasets: [{
          label: 'Daily P&L',
          data: entries.map(row => row.pnl),
          backgroundColor: entries.map(row => row.pnl >= 0 ? 'rgba(16,185,129,.5)' : 'rgba(244,63,94,.5)'),
          borderColor: entries.map(row => row.pnl >= 0 ? '#10b981' : '#f43f5e'),
          borderWidth: 1,
        }],
      },
      options: {
        ...chartBaseOptions(false),
        plugins: { legend: { display: false } },
      },
    });
  });
}

function handlePlayerProfileLiveWager(wager) {
  const profile = playerProfileState.profile;
  const playerId = playerProfileState.playerId;
  if (!profile || !playerId) return;
  const normalized = normalizeBackendWager(wager);
  if (normalized.Login !== playerId && normalized.CustomerID !== playerId) return;
  const liveWager = { ...wager, ...normalized, __live: true };
  profile.recentWagers = [liveWager, ...(profile.recentWagers || []).filter(row => String(normalizeBackendWager(row).WagerNumber) !== String(normalized.WagerNumber))].slice(0, 200);
  profile.stats = profile.stats || {};
  profile.stats.wagerCount = Number(profile.stats.wagerCount || 0) + 1;
  profile.stats.openBets = Number(profile.stats.openBets || 0) + 1;
  profile.stats.totalVolume = Number(profile.stats.totalVolume || 0) + Number(normalized.AmountWagered || 0);
  profile.stats.riskScore = Math.min(100, Number(profile.stats.riskScore || 0) + 1);
  FactoryWager.state.ws.lastEventAt = new Date().toISOString();
  playerProfileState.liveRegionMessage = `New wager ${normalized.WagerNumber || ''} for ${playerId} added to live feed`;
  const liveRegion = document.getElementById('playerProfileLiveRegion');
  if (liveRegion) liveRegion.textContent = playerProfileState.liveRegionMessage;
  if (playerProfileState.tab === 'wagers' || playerProfileState.tab === 'overview') renderPlayerProfile();
}

async function renderPlayerDetail(playerLogin) {
  document.getElementById('playerDetailTitle').textContent = 'Player: ' + playerLogin;

  // Try backend first, then fall back to the already-loaded wager archive for this player.
  let details = null;
  let wagers = [];
  let pnl = [];

  try {
    const [dRes, wRes, pRes] = await Promise.all([
      fetch(`${getApiBaseUrl()}/api/players/${encodeURIComponent(playerLogin)}/details`),
      fetch(`${getApiBaseUrl()}/api/players/${encodeURIComponent(playerLogin)}/wagers`),
      fetch(`${getApiBaseUrl()}/api/players/${encodeURIComponent(playerLogin)}/pnl?days=7`),
    ]);
    if (dRes.ok) details = await dRes.json();
    if (wRes.ok) wagers = await wRes.json();
    if (pRes.ok) pnl = await pRes.json();
  } catch (err) {
    console.log('Backend player detail unavailable, using loaded Buckeye archive:', err?.message || err);
  }

  const localPlayerWagers = buckeyeWagers.filter(w => w.Login === playerLogin);
  const hasBackendPlayerData = Number(details?.profile?.wager_count || 0) > 0;

  // Fall back to loaded Buckeye archive rows when the player endpoint has no row yet.
  if (!details || (!hasBackendPlayerData && localPlayerWagers.length > 0)) {
    const playerWagers = localPlayerWagers;
    const totalVolume = playerWagers.reduce((s, w) => s + w.AmountWagered, 0);
    const totalRisk = playerWagers.reduce((s, w) => s + getWagerExposure(w), 0);
    const totalPotentialPayout = playerWagers.reduce((s, w) => s + (Number(w.ToWinAmount) || 0), 0);
    const avgWager = playerWagers.length > 0 ? totalVolume / playerWagers.length : 0;
    const maxWager = Math.max(...playerWagers.map(w => w.AmountWagered), 0);
    details = {
      profile: {
        wager_count: playerWagers.length,
        total_volume: totalVolume,
        total_risk: totalRisk,
        total_potential_payout: totalPotentialPayout,
        projected_net_exposure: totalVolume - totalPotentialPayout,
        avg_wager: avgWager,
        max_wager: maxWager,
      },
      agents: [...new Set(playerWagers.map(w => w.AgentLogin))],
    };
    wagers = playerWagers;
  }

  // Update stats cards
  const p = details.profile || {};
  document.getElementById('pdWagerCount').textContent = p.wager_count || 0;
  document.getElementById('pdVolume').textContent = '$' + (p.total_volume || 0).toLocaleString();
  document.getElementById('pdRisk').textContent = '$' + (p.total_risk || 0).toLocaleString();
  document.getElementById('pdAvgWager').textContent = '$' + Math.round(p.avg_wager || 0).toLocaleString();
  document.getElementById('pdMaxWager').textContent = '$' + (p.max_wager || 0).toLocaleString();
  const projectedNet = Number(p.projected_net_exposure ?? ((p.total_volume || 0) - (p.total_potential_payout || 0))) || 0;
  const projectedNetEl = document.getElementById('pdProjectedNet');
  if (projectedNetEl) {
    projectedNetEl.textContent = (projectedNet < 0 ? '-' : '') + '$' + Math.abs(Math.round(projectedNet)).toLocaleString();
    projectedNetEl.style.color = projectedNet < 0 ? 'var(--red)' : projectedNet > 0 ? 'var(--green)' : 'var(--text)';
    projectedNetEl.title = 'Projection only: wagered amount minus potential payout from loaded wagers. This is not settled lifetime P/L.';
  }

  // Render P&L chart
  renderPlayerPnlChart(pnl);

  // Render wager breakdown
  renderPlayerWagerBreakdown(wagers);

  // Render wager table
  const tbody = document.getElementById('playerWagerTable');
  if (tbody) {
    tbody.innerHTML = wagers.slice(0, 50).map(w => {
      const typeInfo = WAGER_TYPES[detectWagerType(w)] || { label: w.WagerType, color: '#6b7280' };
      const dt = new Date(w.InsertDateTime);
      const timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      const cleanDesc = parseDescription(w.ShortDesc);
      const fullDesc = w.ShortDesc;
      const price = extractPrice(w.ShortDesc);
      const priceDisplay = price ? `<span class="font-mono">${price}</span>` : '—';
      return `<tr class="border-b" style="border-color:var(--border);" title="${fullDesc.replace(/"/g, '&quot;')}">
        <td class="px-3 py-2 font-mono">${w.WagerNumber}</td>
        <td class="px-3 py-2 text-center"><span class="px-1.5 py-0.5 rounded text-xs font-bold" style="background:${typeInfo.color}22;color:${typeInfo.color};">${typeInfo.label}</span></td>
        <td class="px-3 py-2" style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${fullDesc.replace(/"/g, '&quot;')}">${cleanDesc}</td>
        <td class="px-3 py-2 text-right font-mono">$${w.AmountWagered.toLocaleString()}</td>
        <td class="px-3 py-2 text-right font-mono">$${w.ToWinAmount.toLocaleString()}</td>
        <td class="px-3 py-2 text-center">${priceDisplay}</td>
        <td class="px-3 py-2 text-center">${w.TicketWriter}</td>
        <td class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">${timeStr}</td>
      </tr>`;
    }).join('');
    if (wagers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">No wagers found for this player.</td></tr>';
    }
  }
}

function renderPlayerPnlChart(pnlData) {
  const container = document.getElementById('playerPnlChart');
  if (!container) return;

  if (!pnlData || pnlData.length === 0) {
    container.innerHTML = '<div class="text-sm" style="color:var(--text-dim);">No P&L history available.</div>';
    return;
  }

  const maxVal = Math.max(...pnlData.map(d => Math.max(d.volume || 0, d.risk || 0)), 1);

  container.innerHTML = pnlData.map(d => {
    const volPct = ((d.volume || 0) / maxVal * 100).toFixed(0);
    const riskPct = ((d.risk || 0) / maxVal * 100).toFixed(0);
    return `<div class="flex items-center gap-2">
      <span class="text-xs w-20" style="color:var(--text-dim);">${d.day}</span>
      <div class="flex-1 flex items-center gap-1">
        <div class="h-2 rounded-full" style="width:${volPct}%;background:var(--green);"></div>
        <span class="text-xs font-mono">$${(d.volume || 0).toLocaleString()}</span>
      </div>
      <div class="flex items-center gap-1 w-24">
        <div class="h-2 rounded-full" style="width:${riskPct}%;background:var(--red);"></div>
        <span class="text-xs font-mono">$${(d.risk || 0).toLocaleString()}</span>
      </div>
      <span class="text-xs w-8 text-right" style="color:var(--text-dim);">${d.wager_count || 0}</span>
    </div>`;
  }).join('');
}

function renderPlayerWagerBreakdown(wagers) {
  const container = document.getElementById('playerWagerBreakdown');
  if (!container) return;

  const typeMap = {};
  const sourceMap = {};
  wagers.forEach(w => {
    const t = detectWagerType(w);
    const s = w.TicketWriter;
    typeMap[t] = (typeMap[t] || 0) + w.AmountWagered;
    sourceMap[s] = (sourceMap[s] || 0) + w.AmountWagered;
  });

  const typeRows = Object.entries(typeMap).sort((a, b) => b[1] - a[1]);
  const sourceRows = Object.entries(sourceMap).sort((a, b) => b[1] - a[1]);
  const maxType = typeRows[0]?.[1] || 1;
  const maxSource = sourceRows[0]?.[1] || 1;

  let html = '<div class="text-xs font-semibold mb-1" style="color:var(--text-dim);">By Type</div>';
  html += typeRows.map(([t, vol]) => {
    const info = WAGER_TYPES[t] || { label: t, color: '#6b7280' };
    const pct = (vol / maxType * 100).toFixed(0);
    return `<div class="flex items-center gap-2 mb-1">
      <span class="text-xs w-16">${info.label}</span>
      <div class="flex-1 exposure-bar"><div class="exposure-bar-fill" style="width:${pct}%;background:${info.color};"></div></div>
      <span class="text-xs font-mono w-16 text-right">$${vol.toLocaleString()}</span>
    </div>`;
  }).join('');

  html += '<div class="text-xs font-semibold mb-1 mt-3" style="color:var(--text-dim);">By Source</div>';
  html += sourceRows.map(([s, vol]) => {
    const color = s === 'ALERT' ? 'var(--red)' : s === 'GSLIVE' ? 'var(--cyan)' : 'var(--text-dim)';
    const pct = (vol / maxSource * 100).toFixed(0);
    return `<div class="flex items-center gap-2 mb-1">
      <span class="text-xs w-16">${s}</span>
      <div class="flex-1 exposure-bar"><div class="exposure-bar-fill" style="width:${pct}%;background:${color};"></div></div>
      <span class="text-xs font-mono w-16 text-right">$${vol.toLocaleString()}</span>
    </div>`;
  }).join('');

  container.innerHTML = html;
}



// Compatibility layer: existing markup still uses inline event attributes while the SPA is split into modules.
// New code should import from focused modules instead of adding more inline handlers.
Object.assign(window, {
  applyAgentDelta,
  attemptAutoReconnect,
  backFromPlayerDetail,
  bookDragOver,
  bookDragStart,
  bookDrop,
  buildAgentTree,
  buildConsensusTooltip,
  buildMovementTooltip,
  buildOddsCellTooltip,
  buildPatternTooltip,
  buildTimelineTooltip,
  cacheTooltip,
  clearTicker,
  clearTooltipCache,
  closeAuthModal,
  closeBookSettings,
  closeConsensusModal,
  closePlayerProfileModal,
  closePosition,
  closeRawJsonDrawer,
  closeTradeModal,
  compactJson,
  computeAgentExposureLocal,
  computeDownlineStats,
  computeSportExposureLocal,
  computeTreeLayout,
  connectBuckeye,
  checkPlayerMultiAccounts,
  createPlayerFlag,
  createPlayerNote,
  cssEscape,
  decodeEntities,
  deriveAgentDownlineFromStatic,
  describePatternFilters,
  detectMarketType,
  detectWagerType,
  disconnectBuckeye,
  displayPatternType,
  escapeHtml,
  executeTrade,
  exportPlayerProfileCsv,
  exportPositions,
  exportWagers,
  FactoryWager,
  extractPrice,
  filterAccessIp,
  filterBooks,
  filterBySport,
  filterTickerByAgent,
  filterWagerType,
  focusPlayerFlagComposer,
  focusPlayerNoteComposer,
  findBestBook,
  findTreeNodeAt,
  fitTreeToCanvas,
  flattenAgentTree,
  formatCompactDollars,
  formatLastMovement,
  formatOddsCell,
  formatOddsValue,
  formatShortDateTime,
  formatUptime,
  getAgentPatternCount,
  getApiBaseUrl,
  getCachedTooltip,
  getDefaultWsUrl,
  getDisabledFeatureReason,
  getExposurePct,
  getFilteredGames,
  getGamePatterns,
  getActivePlayerProfileId,
  getHashPlayerId,
  getHeldRisk,
  getLastMovementForBook,
  getLastMovementForGame,
  getMasterBookBase,
  getMovement,
  getPatternFilters,
  getRetainedRiskPercent,
  getSidebarButton,
  getSidebarGroupState,
  getVisibleBooks,
  getWagerExposure,
  handleAgentDownlineClick,
  handleBuckeyeWagerTableClick,
  handlePlayerSearchClick,
  handlePlayerProfileLiveWager,
  handleWagerAction,
  hideTooltip,
  hideWebhookForm,
  indexMovements,
  inferLeagueFromTeams,
  inferSportFromTeams,
  initAgentCanvas,
  initSidebarGroups,
  isCacheFresh,
  isLegitimateWager,
  keepTooltip,
  loadBookPreferences,
  loadPlayerSearch,
  markCacheFresh,
  mergeAgentDelta,
  mergeAgentStats,
  mergeWagers,
  modalSignIn,
  money,
  normalizeBackendWager,
  onTreeCanvasMouseDown,
  onTreeCanvasMouseMove,
  onTreeCanvasMouseUp,
  onTreeCanvasWheel,
  openBookSettings,
  openBuckeyeForCookie,
  openConsensusModal,
  openPatternsForAgent,
  openAgentTreeFromProfile,
  openPlayerProfileModal,
  openRawJsonDrawer,
  openTradeModal,
  parseDescription,
  parseGame,
  parseGameSingle,
  parseLeague,
  parsePatternDetails,
  parseSelection,
  parseSide,
  parseSport,
  patternDetailRow,
  patternIconForAgent,
  pctOfMasterBook,
  pulseAgentPatternBadge,
  pulseAgentPatternRow,
  recordPerformanceWager,
  refreshData,
  refreshIncomingBetsFromArchive,
  renderAccessLogMonitor,
  renderAgentExposure,
  renderAgentPerformanceDetail,
  renderAgentPerformanceTable,
  renderAgentTree,
  renderAlerts,
  renderBookSettingsList,
  renderBuckeyeAgentExposure,
  renderBuckeyeWagers,
  renderDemoOddsMatrix,
  renderDetailDrawer,
  renderGameBreakdown,
  renderIncomingBets,
  renderLiveVsPreChart,
  renderMasterHealth,
  renderMasterSnapshotsTable,
  renderOddsMatrix,
  renderOddsMatrixMobile,
  renderPatternFilterOptions,
  renderPatternCatalogPanel,
  renderPatterns,
  renderPerformanceDashboard,
  renderPerformanceError,
  renderPlayerPnlChart,
  renderPlayerProfile,
  renderPlayerProfileAccess,
  loadGlobalIpTracker,
  exportGlobalIpTrackerCsv,
  renderPlayerProfileOverview,
  renderPlayerProfilePerformance,
  renderPlayerProfileStatus,
  renderPlayerProfileWagers,
  refreshPlayerAgentContext,
  renderPlayerSearch,
  renderPlayerWagerBreakdown,
  renderPositions,
  renderRawApiFreshness,
  renderRawLogsTable,
  renderSportBreakdown,
  renderSportExposure,
  renderTreeLoop,
  renderVelocityChart,
  renderWeeklyFiguresTable,
  resetBookSettings,
  refreshPlayerProfileStatus,
  resetPatternDetail,
  resumeSession,
  resyncBuckeye,
  runAgentTreeSearch,
  saveAndConnect,
  saveBookPreferences,
  saveBookSettings,
  saveSettings,
  saveSidebarGroupState,
  scheduleRender,
  scheduleTask,
  searchAgentTree,
  searchGames,
  searchPlayers,
  openPlayerProfileDocs,
  openSidebarStatusForPlayer,
  setPlayerAgentFilter,
  setPlayerProfileTab,
  setPlayerTransactionTab,
  setPlayerWagerPage,
  setAgentNetworkMode,
  setAgentTreeLoading,
  setMarketTab,
  setPatternCategory,
  setPatternRefreshState,
  setSort,
  setText,
  severityToScore,
  showBuckeyeSettings,
  showFallbackBanner,
  showPatternDefinition,
  showPatternDetail,
  showRawJsonDrawer,
  showToast,
  showTooltip,
  showWagerDetail,
  showWagerDetailModal,
  showWebhookForm,
  sortAgentExposure,
  sortGames,
  sortSportExposure,
  statusAgentRow,
  statusBookPill,
  statusCard,
  statusKeyValue,
  statusLoadingCards,
  statusLoadingRow,
  stopAgentCanvas,
  switchSection,
  syncPatternCategoryTabs,
  syncSidebarActiveGroup,
  timeAgo,
  toggleAgentExpand,
  toggleAgentPatternSort,
  toggleAgentView,
  toggleAlertsToast,
  toggleAuthModal,
  toggleAutoScroll,
  toggleBookVisibility,
  toggleDetailDrawer,
  toggleIncomingPanel,
  toggleOddsFormat,
  toggleSidebarGroup,
  toggleVIP,
  treeScreenToWorld,
  updateAgentRow,
  updateAgentSummary,
  updateAlertsToastButton,
  updateBuckeyeStats,
  updateBuckeyeStatusBadge,
  updateConnectionStatus,
  updateFromBackend,
  updateIncomingBadges,
  updateMasterAccountDisplay,
  updatePatternBadge,
  updatePatternFilterChoices,
  updatePatternSummaryCards,
  updatePositionStats,
  updateSortHeaders,
  updateStatusBadge,
  updateTopBarStatus,
  updateWagerFilterCounts,
  updateWSStatus,
  viewPlayerRelated,
  viewPlayer
});
Object.assign(window, {
  matrixState,
  wsClient,
  buckeyeWagers,
  performanceState,
});
