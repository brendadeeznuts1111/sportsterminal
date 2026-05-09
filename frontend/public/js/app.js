import { TerminalWebSocketClient } from './ws-client.js';
import { BUCKEYE_ARCHIVE_LIMIT, DATA_SOURCES, SIDEBAR_GROUP_STORAGE_KEY } from './state.js';

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
      scheduleRender('buckeye');
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
    if (e.key === '7') switchSection('performance', getSidebarButton('performance'));
    if (e.key === 'Escape') { closeTradeModal(); closeAuthModal(); }
    if (e.key === '/' && e.ctrlKey) { e.preventDefault(); document.getElementById('globalSearch').focus(); }
  });

  // Buckeye screens use only live/persisted backend data.
  loadPersistedWagers(true).then(() => {
    scheduleRender('all');
    updateBuckeyeStats();
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
      renderPlayerSearch();
      break;
    case 'alerts':
      updateAlertsToastButton();
      renderAlerts();
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
        <span class="text-xs font-bold">${w.Login}</span>
        <span class="text-xs" style="color:var(--text-dim);">${w.AgentLogin}</span>
        <span class="text-xs px-1 rounded" style="background:${WAGER_TYPES[detectWagerType(w)]?.color || '#6b7280'}22;color:${WAGER_TYPES[detectWagerType(w)]?.color || '#6b7280'};">${WAGER_TYPES[detectWagerType(w)]?.label || w.WagerType}</span>
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

  container.innerHTML = alertWagers.slice(0, 20).map(w => {
    const severity = w.AmountWagered >= 50000 ? 'critical' : w.AmountWagered >= 10000 ? 'warning' : 'info';
    const severityClass = severity === 'critical' ? 'alert-critical' : severity === 'warning' ? 'alert-warning' : 'alert-info';

    return `<div class="flex items-center justify-between p-3 rounded-lg ${severityClass}">
      <div>
        <div class="text-xs font-bold">${w.AgentLogin} → ${w.Login}</div>
        <div class="text-xs mt-0.5" style="color:var(--text-dim);">${w.ShortDesc.substring(0, 60)}...</div>
      </div>
      <div class="text-right">
        <div class="text-xs font-mono font-bold">$${w.AmountWagered.toLocaleString()}</div>
        <div class="text-xs" style="color:var(--text-dim);">${w.TicketWriter}</div>
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

    const choicesUrl = new URL(`${getApiBaseUrl()}/api/patterns/history`);
    choicesUrl.searchParams.set('limit', '500');
    choicesUrl.searchParams.set('sinceHours', filters.sinceHours);

    const [historyRes, summaryRes, choicesRes] = await Promise.all([
      fetch(historyUrl.toString()),
      fetch(summaryUrl.toString()),
      fetch(choicesUrl.toString()),
    ]);
    if (!historyRes.ok) throw new Error(`Pattern history failed: ${historyRes.status}`);
    if (!summaryRes.ok) throw new Error(`Pattern summary failed: ${summaryRes.status}`);

    patternsData = await historyRes.json();
    patternSummary = await summaryRes.json();
    if (choicesRes.ok) {
      updatePatternFilterChoices(await choicesRes.json());
    }
    lastPatternRequestKey = requestKey;
    markCacheFresh('patterns');
  } catch (err) {
    console.log('[Patterns] Failed to load live patterns:', err.message);
    patternsData = [];
    patternSummary = { byType: {}, bySeverity: {}, total: 0 };
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

function renderPatterns() {
  const tbody = document.getElementById('patternsTable');
  if (!tbody) return;

  syncPatternCategoryTabs();
  updatePatternSummaryCards();

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
    <div class="mt-3 pt-3 border-t" style="border-color:var(--border);">
      <div class="text-[10px] uppercase mb-1" style="color:var(--text-dim);">Raw Evidence</div>
      <pre class="text-[10px] overflow-auto max-h-64 p-2 rounded" style="background:var(--bg);color:var(--text-dim);">${escapeHtml(JSON.stringify(details, null, 2))}</pre>
    </div>`;
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

function compactJson(value) {
  return JSON.stringify(value, null, 0).slice(0, 220);
}

function displayPatternType(type) {
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
  setText('patternReverseCount', byType['Reverse Line'] || 0);
  setText('patternSyndicateCount', byType['Syndicate Play'] || 0);
  setText('patternArbCount', byType.Arbitrage || 0);
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

function timeAgo(value) {
  const diffMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'now';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatShortDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCompactDollars(value) {
  const amount = Number(value || 0);
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(2)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: abs < 100 ? 2 : 0 })}`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

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
      <div><label class="text-xs" style="color:var(--text-dim);">Agent ID</label><input id="modalAgentId" type="text" value="${savedAgent}" class="w-full mt-1 text-sm px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" placeholder="Enter agent ID"></div>
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
  toast.innerHTML = `<div class="w-2 h-2 rounded-full" style="background:${colors[type] || colors.info};"></div><span>${message}</span>`;
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
  const styles = {
    connected:    { text: '● Live Polling', color: 'var(--green)' },
    connecting:   { text: '● Connecting...', color: 'var(--yellow)' },
    testing:      { text: '● Testing...', color: 'var(--yellow)' },
    ready:        { text: '● Login OK (not polling)', color: 'var(--blue)' },
    disconnected: { text: '● Disconnected', color: 'var(--text-dim)' },
  };
  const s = styles[state] || styles.disconnected;
  el.textContent = s.text;
  el.style.color = s.color;
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
  if (!summary || !agentsEl || !booksEl || !countersEl || !queueEl) return;

  summary.innerHTML = statusLoadingCards();
  agentsEl.innerHTML = statusLoadingRow('Loading Buckeye agents...');
  booksEl.innerHTML = statusLoadingRow('Loading books...');
  countersEl.innerHTML = statusLoadingRow('Loading counters...');
  queueEl.innerHTML = statusLoadingRow('Loading queue...');

  try {
    const [healthRes, vaultRes, booksRes, patternsRes] = await Promise.all([
      fetch(`${getApiBaseUrl()}/health`),
      fetch(`${getApiBaseUrl()}/api/buckeye/vault-status`),
      fetch(`${getApiBaseUrl()}/api/books/status`),
      fetch(`${getApiBaseUrl()}/api/patterns/summary?sinceHours=24`),
    ]);

    if (!healthRes.ok) throw new Error(`Health request failed: ${healthRes.status}`);
    const health = await healthRes.json();
    const vault = vaultRes.ok ? await vaultRes.json() : { available: false, agents: [] };
    const books = booksRes.ok ? await booksRes.json() : [];
    const patterns = patternsRes.ok ? await patternsRes.json() : { total: 0, bySeverity: {} };

    const agents = Array.isArray(vault.agents) ? vault.agents : [];
    const activeAgents = Number(health.scrapers?.activeAgents || 0);
    const totalQueued = Number(health.scrapers?.actionQueue?.totalQueued || 0);
    const onlineBooks = (Array.isArray(books) ? books : []).filter(book => book.status === 'online').length;
    const criticalPatterns = Number(patterns.bySeverity?.critical || 0);
    const statusOk = health.status === 'ok';

    summary.innerHTML = [
      statusCard('Backend', statusOk ? 'Online' : 'Issue', formatUptime(health.uptime), statusOk ? 'var(--green)' : 'var(--red)'),
      statusCard('Buckeye', String(activeAgents), `${agents.length} vaulted`, activeAgents > 0 ? 'var(--green)' : 'var(--yellow)'),
      statusCard('Books', `${onlineBooks}/${Array.isArray(books) ? books.length : 0}`, 'online', onlineBooks > 0 ? 'var(--green)' : 'var(--yellow)'),
      statusCard('Patterns', String(patterns.total || 0), `${criticalPatterns} critical`, criticalPatterns > 0 ? 'var(--red)' : 'var(--green)'),
    ].join('');

    agentsEl.innerHTML = agents.length
      ? agents.map(agent => statusAgentRow(agent)).join('')
      : '<div style="color:var(--text-dim);">No vaulted Buckeye agents. Add one from Settings to enable always-on ingestion.</div>';

    booksEl.innerHTML = Array.isArray(books) && books.length
      ? books.map(book => statusBookPill(book)).join('')
      : '<div class="col-span-full" style="color:var(--text-dim);">No book health rows yet.</div>';

    const counters = health.scrapers?.counters || {};
    countersEl.innerHTML = [
      statusKeyValue('Wagers seen', counters.wagers_total || 0),
      statusKeyValue('Alerts triggered', counters.alerts_triggered_total || 0),
      statusKeyValue('Errors', counters.errors_total || 0),
      statusKeyValue('WebSocket', wsClient?.isConnected ? 'connected' : 'offline'),
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

    updateStatusBadge(statusOk, activeAgents, criticalPatterns);
  } catch (error) {
    summary.innerHTML = statusCard('Backend', 'Offline', error instanceof Error ? error.message : 'Status unavailable', 'var(--red)');
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

function statusAgentRow(agent) {
  const flags = [
    agent.hasPassword ? 'password' : null,
    agent.hasCfCookie ? 'cookie' : null,
    agent.hasToken ? 'token' : null,
  ].filter(Boolean).join(' + ') || 'no usable secrets';
  const color = agent.active ? 'var(--green)' : 'var(--yellow)';
  const error = agent.lastError ? `<div class="mt-1" style="color:var(--red);">${escapeHtml(agent.lastError)}</div>` : '';
  return `<div class="rounded border p-2" style="background:var(--bg);border-color:var(--border);">
    <div class="flex items-center justify-between gap-2">
      <span class="font-mono" style="color:var(--text);">${escapeHtml(agent.agentId || 'Unknown')}</span>
      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold" style="background:${color}22;color:${color};">${agent.active ? 'ACTIVE' : 'VAULTED'}</span>
    </div>
    <div class="mt-1" style="color:var(--text-dim);">${escapeHtml(flags)}</div>
    ${error}
  </div>`;
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
  { path: '/api/stats', label: 'Stats', group: 'System' },
  { path: '/api/wagers?limit=1', label: 'Wagers', group: 'Data' },
  { path: '/api/wagers/alerts', label: 'Alerts', group: 'Data' },
  { path: '/api/wagers/live', label: 'Live Wagers', group: 'Data' },
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

async function checkApiEndpoints() {
  const container = document.getElementById('apiEndpointList');
  const summary = document.getElementById('apiEndpointSummary');
  if (!container) return;

  container.innerHTML = '<div class="col-span-full" style="color:var(--text-dim);">Checking endpoints...</div>';

  const results = await Promise.allSettled(
    API_ENDPOINTS.map(async (ep) => {
      const start = performance.now();
      const res = await fetch(`${getApiBaseUrl()}${ep.path}`);
      const ms = Math.round(performance.now() - start);
      return { ...ep, status: res.status, ms };
    })
  );

  const entries = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { ...API_ENDPOINTS[results.indexOf(r)], status: 0, ms: 0 }
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
      API_ENDPOINTS.slice(0, 10).map(async (ep) => {
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

function money(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
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
    // Fetch real hierarchy from Buckeye
    const hierarchyRes = await fetch(`${getApiBaseUrl()}/api/agents/hierarchy`);
    if (!hierarchyRes.ok) throw new Error(`Hierarchy request failed: ${hierarchyRes.status}`);
    const hierarchyData = await hierarchyRes.json();
    const general = Array.isArray(hierarchyData) ? hierarchyData : (hierarchyData.GENERAL || []);

    // Fetch wager-derived stats
    const statsRes = await fetch(`${getApiBaseUrl()}/api/agents/downline`);
    if (!statsRes.ok) throw new Error(`Downline stats request failed: ${statsRes.status}`);
    const statsData = await statsRes.json();
    await loadAgentPatternCounts();
    if (requestId !== agentDownlineRequestId) return;
    agentStatsMap = {};
    (Array.isArray(statsData) ? statsData : []).forEach(s => { agentStatsMap[s.agent_login] = s; });

    if (general.length > 0) {
      // Build tree from flat GENERAL array using Level field
      agentTreeData = buildAgentTree(general);
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

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  const query = document.getElementById('playerSearchInput')?.value?.toLowerCase() || '';
  scheduleTask('playerSearch', () => renderPlayerSearch(query), 100);
}

function renderPlayerSearch(query = '') {
  const tbody = document.getElementById('playerSearchTable');
  if (!tbody) return;

  // Derive players from buckeyeWagers
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

  const totalPlayers = players.length;
  const visiblePlayers = players.slice(0, TABLE_RENDER_LIMIT);

  tbody.innerHTML = visiblePlayers.map(p => {
    const playerLabel = escapeHtml(p.login);
    const agentLabel = escapeHtml(p.agent_login);
    return `<tr class="border-b cursor-pointer hover:bg-opacity-50" data-player="${escapeHtml(p.login)}" style="border-color:var(--border);">
    <td class="px-3 py-2 font-medium hover:underline" style="color:var(--accent);">${playerLabel}</td>
    <td class="px-3 py-2">${agentLabel}</td>
    <td class="px-3 py-2 text-center">${p.wager_count}</td>
    <td class="px-3 py-2 text-right font-mono">$${p.total_volume.toLocaleString()}</td>
    <td class="px-3 py-2 text-right font-mono">$${p.total_risk.toLocaleString()}</td>
    <td class="px-3 py-2 text-center">
      <button type="button" class="px-2 py-1 rounded text-xs" style="background:var(--accent);color:#fff;" data-player="${escapeHtml(p.login)}">View</button>
    </td>
  </tr>`;
  }).join('');

  if (totalPlayers > TABLE_RENDER_LIMIT) {
    tbody.innerHTML += `<tr><td colspan="6" class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">Showing ${TABLE_RENDER_LIMIT.toLocaleString()} of ${totalPlayers.toLocaleString()} players. Search to narrow results.</td></tr>`;
  }

  if (totalPlayers === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">No players found.</td></tr>';
  }
}

function viewPlayer(playerLogin, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!playerLogin) return false;
  previousSection = currentSection;
  switchSection('playerDetail', null);
  renderPlayerDetail(playerLogin);
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
  closePosition,
  closeRawJsonDrawer,
  closeTradeModal,
  compactJson,
  computeAgentExposureLocal,
  computeDownlineStats,
  computeSportExposureLocal,
  computeTreeLayout,
  connectBuckeye,
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
  exportPositions,
  exportWagers,
  extractPrice,
  filterAccessIp,
  filterBooks,
  filterBySport,
  filterTickerByAgent,
  filterWagerType,
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
  renderPatterns,
  renderPerformanceDashboard,
  renderPerformanceError,
  renderPlayerPnlChart,
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
  viewPlayer
});
Object.assign(window, {
  matrixState,
  wsClient,
  buckeyeWagers,
  performanceState,
});
