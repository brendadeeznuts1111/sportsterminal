v/**
 * Sports Terminal — App Orchestrator
 * Thin entry point that imports feature modules, wires up event handlers,
 * and exports global symbols for inline HTML onclick handlers.
 *
 * Previously a monolithic ~8,600-line file. Now delegates to modules under ./modules/
 */

// ==================== IMPORTS ====================
import { fetchBlob, fetchDelete, fetchJson, fetchPost, getApiBaseUrl } from './api.js';
import { COMMAND_CENTER_MAP } from './command-center-map.js';
import { createPlayerDocsRenderer } from './player-docs.js';
import { createPlayerTransactionRenderer } from './player-transactions.js';
import { initPropBuilder } from './prop-builder.js';
import { closeSandboxCreateModal, getSandboxState, initSandboxSection, loadSandboxScenario, loadSandboxScenarioList, submitCreateScenario } from './sandbox.js';
import { BUCKEYE_ARCHIVE_LIMIT, DATA_SOURCES, SIDEBAR_GROUP_STORAGE_KEY } from './state.js';
import { cssEscape, escapeHtml, escapeJs, formatCompactDollars, formatShortDateTime, money, setText, timeAgo } from './utils.js';
import { TerminalWebSocketClient } from './ws-client.js';

// Core infrastructure
import { state, get, set, update, initLegacyCompat } from './modules/state.js';
import { schedule, scheduleImmediate, cancelAll } from './modules/render-scheduler.js';

// Feature modules (side-effect: register window exports)
import './modules/odds-matrix.js';
import './modules/patterns.js';
import { normalizeBackendWager } from './modules/buckeye-integration.js';
import './modules/positions-exposure.js';
import './modules/webhooks-modals.js';
import {
  closePlayerProfileModal,
  destroyPlayerProfileCharts,
  fetchPlayerIntelligenceMap,
  handleBuckeyeWagerTableClick,
  handlePlayerSearchClick,
  loadPlayerSearch,
  openAgentTreeFromProfile,
  profileEmptyRow,
  profileStatCard,
  profileStatusChip,
  refreshOpenPlayerProfile,
  renderPlayerProfile,
  renderPlayerProfileAgent,
  renderPlayerProfileError,
  renderPlayerProfileLoading,
  renderPlayerProfileOverview,
  renderPlayerProfileWagers,
  renderPlayerSearch,
  renderPlayerSearchFallback,
  renderPlayerSearchSuggestions,
  searchPlayers,
  setPlayerAgentFilter,
  setPlayerProfileTab,
  viewPlayer,
} from './modules/player-search.js';
import './modules/performance-analytics.js';
import './modules/agent-network.js';
import './modules/api-status.js';
import './modules/settings-auth.js';
import './command-center.js';
import { renderEnforcementQueue, startPolling, stopPolling } from './modules/enforcement-queue.js';

// ==================== WEBSOCKET CLIENT ====================
const wsClient = new TerminalWebSocketClient({
  url: (() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  })(),
  reconnectInterval: 5000,
  maxReconnectAttempts: 10,
});

// ==================== LEGACY WINDOW EXPORTS (sandbox) ====================
window.initSandboxSection = initSandboxSection;
window.loadSandboxScenarioList = loadSandboxScenarioList;
window.loadSandboxScenario = loadSandboxScenario;
window.closeSandboxCreateModal = closeSandboxCreateModal;
window.submitCreateScenario = submitCreateScenario;
window.getSandboxState = getSandboxState;
window.viewPlayer = viewPlayer;
window.setPlayerProfileTab = setPlayerProfileTab;
window.refreshOpenPlayerProfile = refreshOpenPlayerProfile;
window.closePlayerProfileModal = closePlayerProfileModal;

// ==================== STATE INITIALIZATION ====================
initLegacyCompat();

// Re-export state accessors for modules that still expect them globally
const FactoryWager = window.FactoryWager;
const playerSearchState = FactoryWager.state.playerSearch;
const playerProfileState = FactoryWager.state.playerProfile;

// ==================== RENDERERS ====================
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
  destroyChart: destroyPlayerProfileCharts,
  getChart: () => window.Chart,
});

// ==================== CONSTANTS ====================
const TABLE_RENDER_LIMIT = 150;

const CACHE_TTL = {
  odds: 30000,
  exposure: 60000,
  patterns: 60000,
  performance: 120000,
  agentNetwork: 300000,
  apiStatus: 30000,
};

const SIDEBAR_GROUP_DEFAULTS = {
  trading: true,
  positions: true,
  pph: true,
  'agent-network': true,
  system: true,
  'risk-lab': true,
  'coming-soon': false,
};

const sectionCache = {
  downline: { at: 0, ttl: 60000 },
  exposure: { at: 0, ttl: 60000 },
  patterns: { at: 0, ttl: 60000 },
  performance: { at: 0, ttl: 120000 },
  agentNetwork: { at: 0, ttl: 300000 },
  apiStatus: { at: 0, ttl: 30000 },
};

const debouncedTasks = {};

// ==================== SHARED UTILITIES ====================

function isCacheFresh(key) {
  const cache = sectionCache[key];
  if (!cache) return false;
  return Date.now() - cache.at < cache.ttl;
}

function markCacheFresh(key) {
  if (sectionCache[key]) sectionCache[key].at = Date.now();
}

function getMasterBookBase() {
  return Number(get('masterAccountInfo')?.creditLimit || get('masterAccountInfo')?.balance || 0);
}

function pctOfMasterBook(amount) {
  const base = getMasterBookBase();
  if (!base) return '0%';
  return ((Number(amount || 0) / base) * 100).toFixed(1) + '%';
}

function getExposurePct(amount, localTotal = 0) {
  const total = localTotal || getMasterBookBase();
  if (!total) return '0%';
  return Math.min(100, ((Number(amount || 0) / total) * 100)).toFixed(1) + '%';
}

function updateMasterAccountDisplay() {
  const info = get('masterAccountInfo');
  if (!info) return;
  setText('masterBookBase', formatCompactDollars(info.creditLimit || info.balance || 0));
  setText('masterBookUsed', formatCompactDollars(info.used || 0));
  setText('masterBookAvail', formatCompactDollars(info.available || 0));
  setText('masterBookPct', pctOfMasterBook(info.used));
}

function getDisabledFeatureReason(wager) {
  const flags = get('featureFlags');
  if (!flags.enablePlayer360 && wager?.requiresPlayer360) return 'Player 360 disabled';
  if (!flags.enablePatterns && wager?.requiresPatterns) return 'Pattern detection disabled';
  return '';
}

function isLegitimateWager(wager) {
  return wager && wager.WagerNumber && wager.AmountWagered != null;
}

function scheduleTask(key, fn, delay = 100) {
  if (debouncedTasks[key]) clearTimeout(debouncedTasks[key]);
  debouncedTasks[key] = setTimeout(() => {
    try { fn(); } catch (e) { console.error(`[Task ${key}]`, e); }
    delete debouncedTasks[key];
  }, delay);
}

function scheduleRender(scope = 'all') {
  schedule(scope, () => {
    if (scope === 'all' || scope === 'buckeye') {
      if (typeof renderBuckeyeWagers === 'function') renderBuckeyeWagers();
      if (typeof renderPendingWagers === 'function') renderPendingWagers();
      if (typeof updateBuckeyeStats === 'function') updateBuckeyeStats();
    }
    if (scope === 'all' || scope === 'oddsMatrix') {
      if (typeof renderOddsMatrix === 'function') renderOddsMatrix();
    }
    if (scope === 'all' || scope === 'patterns') {
      if (typeof renderPatterns === 'function') renderPatterns();
    }
    if (scope === 'all' || scope === 'positions') {
      if (typeof updatePositionStats === 'function') updatePositionStats();
    }
    if (scope === 'all' || scope === 'playerProfile') {
      if (typeof renderPlayerProfile === 'function') renderPlayerProfile();
    }
    if (scope === 'all' || scope === 'agentNetwork') {
      if (typeof renderAgentNetwork === 'function') renderAgentNetwork();
    }
    if (scope === 'all' || scope === 'performance') {
      if (typeof renderPerformanceDashboard === 'function') renderPerformanceDashboard();
    }
    if (scope === 'all' || scope === 'alerts') {
      if (typeof renderAlerts === 'function') renderAlerts();
    }
  }, scope);
}

function indexMovements(movements) {
  const idx = {};
  for (const m of movements || []) {
    const key = `${m.event_id}:${m.book}:${m.market}:${m.side}`;
    idx[key] = m;
  }
  set('currentMovementIndex', idx);
}

// ==================== WAGER PARSING ====================
const WAGER_TYPES = {
  straight: ['Straight', 'STRAIGHT', 'straight'],
  parlay: ['Parlay', 'PARLAY', 'parlay', 'Round Robin', 'ROUND ROBIN'],
  teaser: ['Teaser', 'TEASER', 'teaser'],
  ifbet: ['If Bet', 'IF BET', 'if bet'],
  reverse: ['Reverse', 'REVERSE', 'reverse'],
  prop: ['Prop', 'PROP', 'prop', 'Player Prop', 'PLAYER PROP'],
  future: ['Future', 'FUTURE', 'future'],
  live: ['Live', 'LIVE', 'live', 'In-Game', 'IN-GAME'],
};

const WAGER_MARKETS = {
  spread: ['Spread', 'SPREAD', 'spread', 'Point Spread', 'POINT SPREAD'],
  moneyline: ['Moneyline', 'MONEYLINE', 'moneyline', 'ML', 'Money Line'],
  total: ['Total', 'TOTAL', 'total', 'Over/Under', 'OVER/UNDER'],
  prop: ['Prop', 'PROP', 'prop', 'Player Prop'],
  future: ['Future', 'FUTURE', 'future'],
};

const PROP_STATS = ['Points', 'Assists', 'Rebounds', 'Threes', 'Blocks', 'Steals', 'Rushing', 'Passing', 'Receiving', 'Touchdowns', 'Sacks', 'Interceptions', 'Field Goals', 'Hits', 'Runs', 'Home Runs', 'Strikeouts'];

function detectWagerType(wager) {
  const desc = wager?.WagerType || wager?.wagerType || '';
  for (const [type, aliases] of Object.entries(WAGER_TYPES)) {
    if (aliases.some(a => desc.includes(a))) return type;
  }
  return 'unknown';
}

function detectMarketType(wagerOrDesc) {
  const desc = typeof wagerOrDesc === 'string' ? wagerOrDesc : (wagerOrDesc?.WagerType || wagerOrDesc?.wagerType || '');
  for (const [market, aliases] of Object.entries(WAGER_MARKETS)) {
    if (aliases.some(a => desc.includes(a))) return market;
  }
  if (PROP_STATS.some(s => desc.includes(s))) return 'prop';
  return 'unknown';
}

// ==================== SIDEBAR ====================
function getSidebarGroupState() {
  try {
    const raw = localStorage.getItem(SIDEBAR_GROUP_STORAGE_KEY);
    if (raw) return { ...SIDEBAR_GROUP_DEFAULTS, ...JSON.parse(raw) };
  } catch { }
  return { ...SIDEBAR_GROUP_DEFAULTS };
}

function saveSidebarGroupState(state) {
  localStorage.setItem(SIDEBAR_GROUP_STORAGE_KEY, JSON.stringify(state));
}

function initSidebarGroups() {
  const state = getSidebarGroupState();
  for (const [key, expanded] of Object.entries(state)) {
    const body = document.querySelector(`.sidebar-group[data-sidebar-group="${key}"] .sidebar-group-body`);
    const chevron = document.querySelector(`.sidebar-group[data-sidebar-group="${key}"] .sidebar-group-chevron`);
    if (body) body.style.display = expanded ? '' : 'none';
    if (chevron) chevron.textContent = expanded ? '▾' : '▸';
  }
}

function toggleSidebarGroup(key) {
  const state = getSidebarGroupState();
  state[key] = !state[key];
  saveSidebarGroupState(state);
  initSidebarGroups();
}

function syncSidebarActiveGroup() {
  const section = get('currentSection');
  document.querySelectorAll('.sidebar-item').forEach(btn => {
    const active = btn.dataset.section === section;
    btn.classList.toggle('active', active);
  });
}

function getSidebarButton(section) {
  return document.querySelector(`.sidebar-item[data-section="${section}"]`);
}

// ==================== SECTION SWITCHING ====================
function switchSection(section, btn) {
  set('currentSection', section);
  syncSidebarActiveGroup();

  // Hide all sections
  document.querySelectorAll('.section-panel').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.section-panel').forEach(el => el.classList.remove('flex'));

  // Show target section
  const target = document.getElementById(`section-${section}`);
  if (target) {
    target.classList.remove('hidden');
    target.classList.add('flex');
  }

  // Section-specific init
  if (section === 'floor') {
    if (typeof loadOddsData === 'function') loadOddsData();
    if (typeof loadZone1Taxonomy === 'function') loadZone1Taxonomy();
  }
  if (section === 'patterns') {
    if (typeof loadPatterns === 'function') loadPatterns();
  }
  if (section === 'positions') {
    if (typeof fetchExposureData === 'function') fetchExposureData();
  }
  if (section === 'playerSearch') {
    if (typeof loadPlayerSearch === 'function') loadPlayerSearch();
  }
  if (section === 'agentTree' || section === 'agentNetwork') {
    if (typeof loadAgentNetworkData === 'function') loadAgentNetworkData();
  }
  if (section === 'performance') {
    if (typeof loadPerformanceData === 'function') loadPerformanceData();
  }
  if (section === 'status') {
    if (typeof refreshApiStatus === 'function') refreshApiStatus();
  }
  if (section === 'webhooks') {
    if (typeof renderWebhookList === 'function') renderWebhookList();
  }
  if (section === 'alerts') {
    if (typeof renderAlerts === 'function') renderAlerts();
  }
  if (section === 'settings') {
    if (typeof renderSettings === 'function') renderSettings();
  }
  if (section === 'sandbox') {
    if (typeof initSandboxSection === 'function') initSandboxSection();
  }
  if (section === 'command-center') {
    if (typeof renderCommandCenter === 'function') renderCommandCenter();
  }
  if (section === 'heatmap') {
    if (typeof renderHeatmap === 'function') renderHeatmap();
  }
  if (section === 'candlestick') {
    if (typeof renderCandlestick === 'function') renderCandlestick();
  }
  if (section === 'betbuilder') {
    if (typeof initPropBuilder === 'function') initPropBuilder();
  }
  if (section === 'ace') {
    if (typeof renderAceDashboard === 'function') renderAceDashboard();
  }
  if (section === 'metallic') {
    if (typeof renderMetallicDashboard === 'function') renderMetallicDashboard();
  }
  if (section === 'polymarket') {
    if (typeof renderPolymarketDashboard === 'function') renderPolymarketDashboard();
  }
  if (section === 'kalshi') {
    if (typeof renderKalshiDashboard === 'function') renderKalshiDashboard();
  }
  if (section === 'live') {
    if (typeof initLiveSection === 'function') initLiveSection();
  }
  if (section === 'enforcement') {
    renderEnforcementQueue('enforcementQueueContainer');
    startPolling();
  } else {
    stopPolling();
  }

  // Update URL hash for deep linking
  window.location.hash = section;
}

// ==================== ALERTS ====================
function renderAlerts() {
  const container = document.getElementById('alertsList');
  if (!container) return;

  const buckeyeWagers = get('buckeyeWagers') || [];
  const alertWagers = buckeyeWagers.filter(w => w.TicketWriter === 'ALERT' || w.AmountWagered >= 10000);

  container.innerHTML = alertWagers.slice(0, 20).map(w => {
    const severity = w.AmountWagered >= 50000 ? 'critical' : w.AmountWagered >= 10000 ? 'warning' : 'info';
    const severityClass = severity === 'critical' ? 'alert-critical' : severity === 'warning' ? 'alert-warning' : 'alert-info';

    return `<div class="flex items-center justify-between p-3 rounded-lg ${severityClass}">
      <div>
        <div class="text-xs font-bold">${w.AgentLogin || ''} → ${w.Login || ''}</div>
        <div class="text-xs mt-0.5" style="color:var(--text-dim);">${(w.ShortDesc || '').substring(0, 60)}...</div>
      </div>
      <div class="text-right">
        <div class="text-xs font-mono font-bold">$${(w.AmountWagered || 0).toLocaleString()}</div>
        <div class="text-xs" style="color:var(--text-dim);">${w.TicketWriter || ''}</div>
      </div>
    </div>`;
  }).join('');

  const badge = document.getElementById('alertBadge');
  if (badge) {
    if (alertWagers.length > 0) {
      badge.textContent = alertWagers.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

function updateAlertsToastButton() {
  const enabled = localStorage.getItem('toastsEnabled') !== 'false';
  const btn = document.getElementById('alertsToastBtn');
  if (btn) {
    btn.textContent = enabled ? '🔔' : '🔕';
    btn.title = enabled ? 'Alert toasts on' : 'Alert toasts muted';
  }
}

function toggleAlertsToast() {
  const current = localStorage.getItem('toastsEnabled') !== 'false';
  const next = !current;
  localStorage.setItem('toastsEnabled', String(next));
  updateAlertsToastButton();
  if (typeof showToast === 'function') showToast(next ? 'Alert toasts enabled' : 'Alert toasts muted', 'info');
}

// ==================== PLAYER PROFILE LIVE WAGER ====================
function handlePlayerProfileLiveWager(wager) {
  const playerProfileState = get('playerProfileState');
  const profile = playerProfileState.profile;
  const playerId = playerProfileState.playerId;
  if (!profile || !playerId) return;
  const normalized = normalizeBackendWager(wager);
  if (normalized.Login !== playerId && normalized.CustomerID !== playerId) return;
  const liveWager = { ...wager, ...normalized, __live: true };
  profile.recentWagers = [liveWager, ...(profile.recentWagers || []).filter(row => String((row.WagerNumber || row.wagerNumber)) !== String(normalized.WagerNumber))].slice(0, 200);
  profile.stats = profile.stats || {};
  profile.stats.wagerCount = Number(profile.stats.wagerCount || 0) + 1;
  profile.stats.openBets = Number(profile.stats.openBets || 0) + 1;
  profile.stats.totalVolume = Number(profile.stats.totalVolume || 0) + Number(normalized.AmountWagered || 0);
  profile.stats.riskScore = Math.min(100, Number(profile.stats.riskScore || 0) + 1);
  if (typeof FactoryWager !== 'undefined') FactoryWager.state.ws.lastEventAt = new Date().toISOString();
  playerProfileState.liveRegionMessage = `New wager ${normalized.WagerNumber || ''} for ${playerId} added to live feed`;
  const liveRegion = document.getElementById('playerProfileLiveRegion');
  if (liveRegion) liveRegion.textContent = playerProfileState.liveRegionMessage;
  if (playerProfileState.tab === 'wagers' || playerProfileState.tab === 'overview') {
    if (typeof renderPlayerProfile === 'function') renderPlayerProfile();
  }
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
  const proxySecretsBaseInput = document.getElementById('proxySecretsBaseUrl');
  const proxySecretsKeyInput = document.getElementById('proxySecretsApiKey');
  const retainedRiskInput = document.getElementById('retainedRiskPercent');
  if (agentInput) agentInput.value = savedAgent;
  if (passInput) passInput.value = '';
  if (baseInput) baseInput.value = savedBase;
  if (cfInput) cfInput.value = '';
  if (proxySecretsBaseInput) proxySecretsBaseInput.value = localStorage.getItem('proxyBaseUrl') || 'http://localhost:3001';
  if (proxySecretsKeyInput) proxySecretsKeyInput.value = localStorage.getItem('proxyApiKey') || 'dev-key-123';
  if (retainedRiskInput) retainedRiskInput.value = savedRetainedRisk;

  // Player search table click handler
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
  if (typeof updateAlertsToastButton === 'function') updateAlertsToastButton();
  if (typeof updateTopBarStatus === 'function') updateTopBarStatus();
  if (typeof refreshVaultStatus === 'function') refreshVaultStatus();

  // Initialize WebSocket
  wsClient.connect();

  // Register WebSocket event handlers
  wsClient.on('wager.new', (msg) => {
    if (msg.payload) {
      const wager = normalizeBackendWager(msg.payload);
      const currentWagers = get('buckeyeWagers') || [];
      const filtered = currentWagers.filter(w => w.WagerNumber !== wager.WagerNumber);
      filtered.unshift(wager);
      set('buckeyeWagers', filtered);
      const disabledReason = getDisabledFeatureReason(wager);
      if (disabledReason) {
        showToast(`Anomaly: ${disabledReason} on wager ${wager.WagerNumber}`, 'error');
      }
      sectionCache.downline.at = 0;
      sectionCache.exposure.at = 0;
      if (typeof updateBuckeyeStats === 'function') updateBuckeyeStats();
      if (typeof recordPerformanceWager === 'function') recordPerformanceWager(wager);
      if (typeof handlePlayerProfileLiveWager === 'function') handlePlayerProfileLiveWager(wager);
      scheduleRender('buckeye');
    }
  });

  wsClient.on('player360.update', (msg) => {
    const activePlayer = playerProfileState.playerId;
    if (!activePlayer) return;
    const touchedPlayers = msg?.payload?.players || [];
    if (!touchedPlayers.length || touchedPlayers.includes(activePlayer)) {
      if (typeof refreshOpenPlayerProfile === 'function') refreshOpenPlayerProfile(activePlayer);
    }
  });

  wsClient.on('wager.alert', (msg) => {
    if (msg.payload) {
      showToast(msg.payload.message || 'Alert triggered', msg.payload.severity === 'critical' ? 'error' : 'warning');
      scheduleRender('alerts');
    }
  });

  wsClient.on('agentUpdate', (msg) => {
    if (typeof mergeAgentDelta === 'function') mergeAgentDelta(msg.payload || msg);
  });

  wsClient.on('exposure.update', (msg) => {
    sectionCache.exposure.at = 0;
    scheduleRender('buckeye');
    if (get('currentSection') === 'positions' && typeof fetchExposureData === 'function') fetchExposureData();
  });

  wsClient.on('auth_failed', (msg) => {
    showToast(msg.message || 'Session expired. Please reconnect.', 'error');
    wsClient.isAuthenticated = false;
    if (typeof updateConnectionStatus === 'function') updateConnectionStatus('disconnected');
  });

  wsClient.on('odds.movement', (msg) => {
    const move = msg.payload || {};
    if (move.eventId && move.book) {
      const idx = get('currentMovementIndex') || {};
      idx[move.eventId] = idx[move.eventId] || {};
      idx[move.eventId][move.book] = move;
      set('currentMovementIndex', idx);
      if (get('currentSection') === 'floor') scheduleRender('oddsMatrix');
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
      e.preventDefault();
      document.getElementById('globalSearch')?.focus();
    }
    if (e.key === 'Escape') {
      if (typeof closePlayerProfileModal === 'function') closePlayerProfileModal(false);
      if (typeof closeTradeModal === 'function') closeTradeModal();
      if (typeof closeBookSettings === 'function') closeBookSettings();
    }
  });

  // Global search
  const globalSearch = document.getElementById('globalSearch');
  if (globalSearch) {
    globalSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = globalSearch.value.trim();
        if (q) {
          set('currentSection', 'playerSearch');
          switchSection('playerSearch', getSidebarButton('playerSearch'));
          playerSearchState.query = q;
          document.getElementById('playerSearchInput').value = q;
          loadPlayerSearch(true);
        }
      }
    });
  }

  // Deep link from URL hash
  const hash = window.location.hash.replace('#', '');
  if (hash && document.getElementById(`section-${hash}`)) {
    switchSection(hash, getSidebarButton(hash));
  } else {
    switchSection('floor', getSidebarButton('floor'));
  }

  // Periodic refresh
  setInterval(() => {
    if (get('currentSection') === 'floor') {
      if (typeof loadOddsData === 'function') loadOddsData(true);
    }
  }, 30000);

  // Initial data load
  if (typeof loadOddsData === 'function') loadOddsData();
  if (typeof updateTopBarStatus === 'function') updateTopBarStatus();
});

// ==================== GLOBAL WINDOW EXPORTS ====================
// These are needed for inline HTML onclick handlers until Phase 4 migration
window.switchSection = switchSection;
window.toggleSidebarGroup = toggleSidebarGroup;
window.getSidebarButton = getSidebarButton;
window.isCacheFresh = isCacheFresh;
window.markCacheFresh = markCacheFresh;
window.scheduleRender = scheduleRender;
window.scheduleTask = scheduleTask;
window.indexMovements = indexMovements;
window.detectWagerType = detectWagerType;
window.detectMarketType = detectMarketType;
window.getMasterBookBase = getMasterBookBase;
window.pctOfMasterBook = pctOfMasterBook;
window.getExposurePct = getExposurePct;
window.updateMasterAccountDisplay = updateMasterAccountDisplay;
window.getDisabledFeatureReason = getDisabledFeatureReason;
window.isLegitimateWager = isLegitimateWager;
window.refreshEnforcementQueue = () => renderEnforcementQueue('enforcementQueueContainer');
window.enforcementFilterChange = (value) => {
  const evt = new CustomEvent('enforcement-filter-change', { detail: { filter: value } });
  document.dispatchEvent(evt);
};
window.TABLE_RENDER_LIMIT = TABLE_RENDER_LIMIT;
window.CACHE_TTL = CACHE_TTL;
window.sectionCache = sectionCache;
window.debouncedTasks = debouncedTasks;

// Re-export utility functions used by inline handlers
window.escapeHtml = escapeHtml;
window.escapeJs = escapeJs;
window.formatShortDateTime = formatShortDateTime;
window.formatCompactDollars = formatCompactDollars;
window.money = money;
window.setText = setText;
window.timeAgo = timeAgo;
window.getApiBaseUrl = getApiBaseUrl;
window.fetchJson = fetchJson;
window.fetchPost = fetchPost;
window.fetchDelete = fetchDelete;
window.fetchBlob = fetchBlob;

// Player profile helpers (used by inline handlers and other modules)
window.playerSearchState = playerSearchState;
window.playerProfileState = playerProfileState;
window.playerDocsRenderer = playerDocsRenderer;
window.playerTransactionRenderer = playerTransactionRenderer;

// Feature flags
window.FEATURE_FLAGS = get('featureFlags');

// WS client
window.wsClient = wsClient;

// Logger for debugging
console.info('[App] Sports Terminal orchestrator loaded. Modules active:', [
  'state', 'render-scheduler', 'odds-matrix', 'patterns', 'buckeye-integration',
  'positions-exposure', 'webhooks-modals', 'player-search', 'performance-analytics',
  'agent-network', 'api-status', 'settings-auth',
]);
