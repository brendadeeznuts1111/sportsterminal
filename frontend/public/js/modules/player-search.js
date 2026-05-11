/**
 * Player Search & Profile Module
 * Extracted from app.js lines ~7578-10588.
 * Handles player search, player profile modal, all profile tabs,
 * FactoryWager integration, and player detail rendering.
 */

import { fetchJson, fetchWithTimeout, getApiBaseUrl } from '../api.js?v=5.32.14';
import { escapeHtml, escapeJs, formatCompactDollars, formatShortDateTime, timeAgo } from '../utils.js';
import { get, set } from './state.js';

// ==================== STATE INITIALIZATION ====================
if (!get('playerSearchState')) {
  set('playerSearchState', {
    query: '',
    agent: '',
    from: '',
    to: '',
    sort: 'volume',
    players: [],
    agents: [],
    loading: false,
  });
}

if (!get('playerProfileState')) {
  set('playerProfileState', {
    playerId: null,
    profile: null,
    intelligenceMap: null,
    crossReference: null,
    crossReferenceLoading: false,
    docsLoading: false,
    statusLoading: false,
    statusMap: null,
    statusEndpointChecks: [],
    tab: 'overview',
    transactionTab: 'all',
    wagerPage: 1,
    wagerPageSize: 20,
    accessLogLive: [],
    accessLogFilters: { actions: 'A', customerId: '', start: '', end: '', ip: '' },
    agentFilter: '',
    agentContextLoading: false,
    liveRegionMessage: '',
    virtualLimits: { wagers: 100, access: 100, deposits: 100, transactions: 100, notes: 100, flags: 100 },
    charts: {},
  });
}

// ==================== PLAYER SEARCH ====================
export function searchPlayers() {
  const playerSearchState = get('playerSearchState');
  playerSearchState.query = document.getElementById('playerSearchInput')?.value?.trim() || '';
  set('playerSearchState', playerSearchState);
  if (typeof FactoryWager !== 'undefined' && FactoryWager.utils?.debounce) {
    FactoryWager.utils.debounce('playerSearch', () => loadPlayerSearch(true));
  } else {
    loadPlayerSearch(true);
  }
}

export async function loadPlayerSearch(force = false) {
  const tbody = document.getElementById('playerSearchTable');
  if (!tbody) return;
  const playerSearchState = get('playerSearchState');
  const agent = document.getElementById('playerAgentFilter')?.value || '';
  const from = document.getElementById('playerFromFilter')?.value || '';
  const to = document.getElementById('playerToFilter')?.value || '';
  playerSearchState.agent = agent;
  playerSearchState.from = from;
  playerSearchState.to = to;
  set('playerSearchState', playerSearchState);
  if (playerSearchState.loading && !force) return;

  playerSearchState.loading = true;
  set('playerSearchState', playerSearchState);
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
    set('playerSearchState', playerSearchState);
    renderPlayerAgentFilter();
    renderPlayerSearch();
    renderPlayerSearchSuggestions();
  } catch (err) {
    console.warn('[Players] Search failed, falling back to loaded wagers:', err?.message || err);
    renderPlayerSearchFallback(playerSearchState.query.toLowerCase());
  } finally {
    playerSearchState.loading = false;
    set('playerSearchState', playerSearchState);
  }
}

export function renderPlayerAgentFilter() {
  const select = document.getElementById('playerAgentFilter');
  if (!select) return;
  const selected = select.value;
  const playerSearchState = get('playerSearchState');
  const agents = normalizePlayerSearchAgents(playerSearchState.agents);
  select.innerHTML = '<option value="">All agents</option>' + agents.map(agent => {
    const label = `${agent.agentLogin || agent.agentId}${agent.level ? ` · L${agent.level}` : ''}${agent.agentType ? ` ${agent.agentType}` : ''}`;
    return `<option value="${escapeHtml(agent.agentId || agent.agentLogin)}">${escapeHtml(label)}</option>`;
  }).join('');
  select.value = agents.some(agent => (agent.agentId || agent.agentLogin) === selected) ? selected : '';
}

export function normalizePlayerSearchAgents(agents) {
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

export function renderPlayerSearch() {
  const tbody = document.getElementById('playerSearchTable');
  if (!tbody) return;
  const playerSearchState = get('playerSearchState');
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

export function renderPlayerSearchFallback(query = '') {
  const tbody = document.getElementById('playerSearchTable');
  if (!tbody) return;
  const buckeyeWagers = get('buckeyeWagers') || [];
  const playerMap = {};
  buckeyeWagers.forEach(w => {
    const p = w.Login;
    if (!playerMap[p]) {
      playerMap[p] = { login: p, agent_login: w.AgentLogin, wager_count: 0, total_volume: 0, total_risk: 0 };
    }
    playerMap[p].wager_count++;
    playerMap[p].total_volume += w.AmountWagered;
    playerMap[p].total_risk += typeof getWagerExposure === 'function' ? getWagerExposure(w) : w.AmountWagered;
  });

  let players = Object.values(playerMap);
  if (query) {
    players = players.filter(p => p.login.toLowerCase().includes(query));
  }
  players.sort((a, b) => b.total_volume - a.total_volume);
  const playerSearchState = get('playerSearchState');
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
  set('playerSearchState', playerSearchState);

  const limit = typeof TABLE_RENDER_LIMIT !== 'undefined' ? TABLE_RENDER_LIMIT : 150;
  const visiblePlayers = playerSearchState.players.slice(0, limit);
  tbody.innerHTML = visiblePlayers.map(p => playerSearchRow(p)).join('');

  if (playerSearchState.players.length > limit) {
    tbody.innerHTML += `<tr><td colspan="7" class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">Showing ${limit.toLocaleString()} of ${playerSearchState.players.length.toLocaleString()} players. Search to narrow results.</td></tr>`;
  }

  if (playerSearchState.players.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">No players found.</td></tr>';
  }
  renderPlayerSearchSuggestions();
}

export function renderPlayerSearchSuggestions() {
  const list = document.getElementById('playerSearchSuggestions');
  if (!list) return;
  const playerSearchState = get('playerSearchState');
  list.innerHTML = (playerSearchState.players || [])
    .slice(0, 40)
    .map(p => `<option value="${escapeHtml(p.login || p.customerId || '')}">${escapeHtml(p.agentLogin || '')}</option>`)
    .join('');
}

export function playerSearchRow(p) {
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

export function viewPlayer(playerLogin, event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!playerLogin) return false;
  openPlayerProfileModal(playerLogin);
  return false;
}

export function handlePlayerSearchClick(event) {
  const playerTarget = event.target.closest('[data-player]');
  if (!playerTarget || !event.currentTarget.contains(playerTarget)) return;
  event.preventDefault();
  event.stopPropagation();
  viewPlayer(playerTarget.dataset.player);
}

export function handleBuckeyeWagerTableClick(event) {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget && event.currentTarget.contains(actionTarget)) {
    event.preventDefault();
    event.stopPropagation();
    if (actionTarget.dataset.action === 'view-player') {
      viewPlayer(actionTarget.dataset.player);
    } else if (actionTarget.dataset.action === 'filter-agent') {
      if (typeof filterTickerByAgent === 'function') filterTickerByAgent(actionTarget.dataset.agent);
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
    if (Number.isFinite(wagerNumber) && wagerNumber > 0 && typeof showWagerDetail === 'function') showWagerDetail(wagerNumber);
  }
}

export function backFromPlayerDetail() {
  if (typeof switchSection === 'function' && typeof previousSection !== 'undefined') switchSection(previousSection, null);
}

// ==================== PLAYER PROFILE MODAL ====================
export async function openPlayerProfileModal(playerId) {
  const modal = document.getElementById('playerProfileModal');
  if (!modal) return;
  const playerProfileState = get('playerProfileState');
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
  set('playerProfileState', playerProfileState);

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  document.getElementById('playerProfileTitle').textContent = playerId;
  document.getElementById('playerProfileSubhead').textContent = 'Loading archive profile...';
  renderPlayerProfileLoading();

  if (typeof FactoryWager !== 'undefined' && FactoryWager.actions?.subscribePlayerWagers) {
    FactoryWager.actions.subscribePlayerWagers(playerId);
  }
  if (!history.state?.playerProfile) {
    history.pushState({ playerProfile: true, playerId }, '', `#player=${encodeURIComponent(playerId)}`);
  }

  try {
    const profile = await fetchPlayerProfile(playerId);
    playerProfileState.profile = profile;
    set('playerProfileState', playerProfileState);
    configurePlayerProfileExports(playerId);
    renderPlayerProfile();
  } catch (err) {
    console.warn('[Players] Profile failed:', err?.message || err);
    playerProfileState.profile = null;
    set('playerProfileState', playerProfileState);
    configurePlayerProfileExports(playerId);
    renderPlayerProfileError(playerId, err);
  }
}

export function renderPlayerProfileError(playerId, err) {
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

export async function fetchBuckeyePlayerLiveData(playerId) {
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

export async function fetchBuckeyePlayerTransactions(playerId, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchWithTimeout(
      `${getApiBaseUrl()}/api/buckeye/player-transactions?customerId=${encodeURIComponent(playerId)}`,
      { signal: controller.signal, timeoutMs }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    console.warn('[Players] Buckeye player-transactions failed:', err?.message || err);
    return null;
  }
}

export async function fetchPlayerProfile(playerId) {
  const profile = await FactoryWager.apiFetch(`/players/${encodeURIComponent(playerId)}/profile`);
  try {
    profile.crossReference = await fetchPlayerCrossReference(playerId);
    const playerProfileState = get('playerProfileState');
    playerProfileState.crossReference = profile.crossReference;
    set('playerProfileState', playerProfileState);
  } catch (err) {
    console.warn('[Players] Cross-reference summary failed:', err?.message || err);
    profile.crossReference = null;
    const playerProfileState = get('playerProfileState');
    playerProfileState.crossReference = null;
    set('playerProfileState', playerProfileState);
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

export async function fetchPlayerIntelligenceMap(playerId) {
  return FactoryWager.apiFetch(`/players/${encodeURIComponent(playerId)}/intelligence-map`);
}

export async function fetchPlayerCrossReference(playerId) {
  return FactoryWager.apiFetch('/cross-reference', { query: { playerId } });
}

export async function refreshOpenPlayerProfile(playerId) {
  try {
    const profile = await fetchPlayerProfile(playerId);
    const playerProfileState = get('playerProfileState');
    if (playerProfileState.playerId !== playerId) return;
    playerProfileState.profile = profile;
    set('playerProfileState', playerProfileState);
    configurePlayerProfileExports(playerId);
    renderPlayerProfile();
  } catch (err) {
    console.warn('[Players] Live profile refresh failed:', err?.message || err);
  }
}

export function closePlayerProfileModal(updateHistory = true) {
  const modal = document.getElementById('playerProfileModal');
  if (!modal || modal.classList.contains('hidden')) return;
  const playerProfileState = get('playerProfileState');
  if (typeof FactoryWager !== 'undefined' && FactoryWager.actions?.unsubscribePlayerWagers) {
    FactoryWager.actions.unsubscribePlayerWagers(playerProfileState.playerId);
  }
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
  set('playerProfileState', playerProfileState);
  if (updateHistory && history.state?.playerProfile) history.back();
}

// FactoryWager action stubs (will be overridden if app.js defines them)
if (typeof FactoryWager !== 'undefined') {
  FactoryWager.actions = FactoryWager.actions || {};
  FactoryWager.actions.subscribePlayerWagers = function subscribePlayerWagers(playerId) {
    if (FactoryWager.state?.ws) FactoryWager.state.ws.subscribedPlayerId = playerId;
    if (typeof wsClient !== 'undefined' && wsClient?.isConnected) {
      wsClient.send({ type: 'player.subscribe', playerId });
    }
  };
  FactoryWager.actions.unsubscribePlayerWagers = function unsubscribePlayerWagers(playerId) {
    if (typeof wsClient !== 'undefined' && wsClient?.isConnected && playerId) {
      wsClient.send({ type: 'player.unsubscribe', playerId });
    }
    if (FactoryWager.state?.ws && FactoryWager.state.ws.subscribedPlayerId === playerId) {
      FactoryWager.state.ws.subscribedPlayerId = null;
    }
  };
}

export function configurePlayerProfileExports(playerId) {
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

export function exportPlayerProfileCsv(kind) {
  const playerProfileState = get('playerProfileState');
  const playerId = playerProfileState.playerId;
  if (!playerId) return false;
  const path = kind === 'access' ? 'access-logs' : 'wagers';
  window.location.href = FactoryWager.apiUrl(`/players/${encodeURIComponent(playerId)}/export/${path}`);
  return false;
}

export function renderPlayerProfileLoading() {
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

export function openPlayerProfileDocs() {
  setPlayerProfileTab('docs');
}

export function setPlayerProfileTab(tab) {
  const playerProfileState = get('playerProfileState');
  playerProfileState.tab = tab;
  set('playerProfileState', playerProfileState);
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
    const activeId = getActivePlayerProfileId();
    if (activeId) {
      playerProfileState.playerId = activeId;
      set('playerProfileState', playerProfileState);
      if (tab === 'status') {
        renderPlayerProfileStatus({ playerId: activeId, stats: {} });
      } else if (tab === 'docs') {
        renderPlayerProfileDocs({ playerId: activeId, stats: {} });
      } else {
        refreshOpenPlayerProfile(activeId);
      }
    }
    return;
  }
  renderPlayerProfile();
}

export function renderPlayerProfile() {
  const playerProfileState = get('playerProfileState');
  const profile = playerProfileState.profile;
  if (!profile) return;
  const stats = profile.stats || {};
  const playerId = profile.playerId || playerProfileState.playerId || 'Player';
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

// ==================== PROFILE OVERVIEW ====================
export function renderPlayerProfileOverview(profile) {
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
  const playerId = profile.playerId || get('playerProfileState').playerId || 'Player';
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
      <section class="profile-intel-column">
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

        <div class="intel-glass-card">
          <div class="intel-card-title">
            <span>Risk Score</span>
            <strong class="${risk >= 70 ? 'danger' : risk >= 40 ? 'warn' : 'good'}">${risk}<small>/100</small></strong>
          </div>
          <div class="intel-risk-meter-v2"><div class="intel-risk-meter-v2-fill" style="width:${Math.min(100, Math.max(0, risk))}%;"></div></div>
          <div class="intel-risk-scale"><span>Low</span><span>Medium</span><span>High</span></div>
          <div class="intel-risk-factors">${renderRiskFactors(profile)}</div>
        </div>

        ${renderCrossReferencePanel(profile)}

        <div class="intel-glass-card">
          <div class="intel-section-header">
            <h3>Active Flags</h3>
            <button type="button" class="intel-text-action" onclick="setPlayerProfileTab('notes')">+ Add</button>
          </div>
          ${renderArtifactFlags(flags)}
        </div>

        <div class="intel-glass-card">
          <div class="intel-section-header">
            <h3>Operator Notes</h3>
            <button type="button" class="intel-text-action" onclick="focusPlayerNoteComposer()">+ Add</button>
          </div>
          ${renderArtifactNotes(notes)}
        </div>

        <div class="intel-stat-grid">
          ${artifactStatCard('Total Volume', formatCompactDollars(stats.totalVolume), 'fa-coins', '#0ea5e9', 'up', '12.4% this month')}
          ${artifactStatCard('Open Bets', live.hasLiveData ? `${livePendingCount.toLocaleString()}` : Number(stats.openBets || 0).toLocaleString(), 'fa-fire', '#f43f5e', null, live.hasLiveData ? `${formatCompactDollars(livePending)} pending` : `${formatCompactDollars(stats.openExposure || 0)} exposure`)}
          ${artifactStatCard('Win Rate', `${Number(stats.winRate || 0).toFixed(1)}%`, 'fa-chart-pie', '#10b981', 'up', '3.2% vs avg')}
          ${artifactStatCard('Favorite Sport', stats.favoriteSport || 'Unknown', 'fa-trophy', '#8b5cf6', null, 'Volume leader')}
        </div>

        <div class="intel-glass-card">
          <div class="intel-card-title"><span>Advanced Metrics</span><small>derived</small></div>
          <div class="intel-advanced-grid">
            ${intelMiniMetric('Avg Stake', formatCompactDollars(stats.avgStake || stats.avgWager), '')}
            ${intelMiniMetric('CLV %', `${Number(stats.clvPercent || 0).toFixed(2)}%`, 'estimated')}
            ${intelMiniMetric('Past Posting', `${Number(stats.pastPostingRate || 0).toFixed(1)}%`, `${Number(stats.patternHits || 0)} flags`)}
            ${intelMiniMetric('Stale Hits', Number(stats.staleLineHits || 0).toLocaleString(), 'last archive')}
          </div>
        </div>

        <div class="intel-glass-card">
          <div class="intel-section-header">
            <h3>Agent Assignment</h3>
            <button type="button" class="intel-text-action" onclick="setPlayerProfileTab('agent')">Open Tree</button>
          </div>
          ${renderAgentAssignmentCard(agentContext)}
        </div>

        <div class="intel-glass-card">
          <div class="intel-card-title"><span>Volume By Sport</span><small>${Number(sportBreakdown.length).toLocaleString()} sports</small></div>
          ${renderSportVolumeBars(sportBreakdown)}
        </div>
      </section>

      <section class="profile-intel-column">
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

        <div class="intel-glass-card">
          <div class="intel-card-title"><span>4-Week P&L Trend</span><small>${livePerf.length ? 'Buckeye live' : 'archive'}</small></div>
          <div class="intel-chart-container"><canvas id="playerMiniPnlChart"></canvas></div>
          ${livePerf.length ? renderLivePnlSummary(livePerf) : renderWeeklyPnlSummary(weeklyPnl)}
        </div>

        <div class="intel-glass-card">
          <div class="intel-card-title"><span>Closing Line Value</span><strong class="${Number(stats.clvPercent || 0) >= 0 ? 'good' : 'danger'}">${Number(stats.clvPercent || 0).toFixed(2)}%</strong></div>
          ${renderClvBySport(profile)}
        </div>
      </section>

      <section class="profile-intel-column">
        <div class="intel-glass-card">
          <div class="intel-section-header">
            <h3>Linked Accounts</h3>
            <span class="badge" style="background:rgba(244,63,94,.1);color:#f43f5e;border:1px solid rgba(244,63,94,.2);">${(profile.links || []).length} found</span>
          </div>
          ${renderArtifactLinkedAccounts(profile)}
        </div>

        <div class="intel-glass-card intel-access-panel">
          <div class="intel-section-header">
            <h3>Access Logs</h3>
            <button type="button" class="intel-text-action" onclick="exportPlayerProfileCsv('access')">CSV</button>
          </div>
          <div class="intel-access-list intel-scroll">${renderArtifactAccessLogs(profile)}</div>
        </div>

        <div class="intel-glass-card">
          <div class="intel-card-title"><span>Login Locations</span><small>last 10</small></div>
          ${renderArtifactGeoDistribution(profile)}
        </div>

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

export function profileStatCard(label, value) {
  return `<div class="profile-stat-card"><div class="profile-stat-label">${label}</div><div class="profile-stat-value">${value}</div></div>`;
}

export function renderCrossReferencePanel(profile) {
  const playerProfileState = get('playerProfileState');
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

export function crossRefQualityChip(label, ok) {
  return `<span class="status-coverage-chip ${ok ? 'live' : 'probe'}">${escapeHtml(label)}: ${ok ? 'ok' : 'check'}</span>`;
}

export function viewPlayerRelated(target) {
  const playerProfileState = get('playerProfileState');
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
    if (agent && typeof openPatternsForAgent === 'function') openPatternsForAgent(agent);
    else if (typeof switchSection === 'function') switchSection('patterns', typeof getSidebarButton === 'function' ? getSidebarButton('patterns') : null);
    return false;
  }
  return false;
}

export function artifactStatCard(label, value, icon, color, deltaDir, deltaText) {
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

export function renderArtifactFlags(flags) {
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

export function renderArtifactNotes(notes) {
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

export function renderArtifactWagerFeed(wagers) {
  if (!wagers.length) return '<div class="intel-empty">No wagers captured yet.</div>';
  return wagers.slice(0, 12).map(row => {
    const w = typeof normalizeBackendWager === 'function' ? normalizeBackendWager(row) : row;
    const flags = row.pattern_flags || row.patternFlags || [];
    const pattern = intelWagerPattern(row, flags);
    const clv = Number(row.clv_percent ?? row.clvPercent ?? 0);
    const sport = w.Sport || (typeof parseSport === 'function' ? parseSport(w.ShortDesc) : 'Unknown');
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
              <strong style="font-size:12px;color:var(--text);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml((typeof parseDescription === 'function' ? parseDescription(w.ShortDesc) : w.ShortDesc) || w.WagerType || 'Wager')}</strong>
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

export function renderArtifactLinkedAccounts(profile) {
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

export function renderArtifactAccessLogs(profile) {
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

export function renderArtifactGeoDistribution(profile) {
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

export function renderMiniWagerList(wagers) {
  if (!wagers.length) return '<div class="text-sm" style="color:var(--text-dim);">No wagers yet.</div>';
  return `<div class="space-y-2">${wagers.slice(0, 8).map(row => {
    const w = typeof normalizeBackendWager === 'function' ? normalizeBackendWager(row) : row;
    return `<div class="flex items-center justify-between gap-3 text-xs border-b pb-2" style="border-color:var(--border);">
      <div class="min-w-0"><div class="font-mono">#${escapeHtml(w.WagerNumber)}</div><div class="truncate" style="color:var(--text-dim);">${escapeHtml(typeof parseDescription === 'function' ? parseDescription(w.ShortDesc) : w.ShortDesc)}</div></div>
      <div class="font-mono">$${Math.round(w.AmountWagered).toLocaleString()}</div>
    </div>`;
  }).join('')}</div>`;
}

export function renderSportVolumeBars(sports) {
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

export function getLatestAccountSnapshot(profile) {
  return (profile.accountSnapshots || [])[0] || {};
}

export function playerProfileInitials(playerId) {
  const clean = String(playerId || 'PL').replace(/[^a-z0-9]/gi, '');
  return (clean.slice(0, 2) || 'PL').toUpperCase();
}

export function latestPlayerActivity(profile) {
  const latestAccess = profile.accessLogs?.[0]?.access_datetime;
  const latestWager = profile.stats?.lastWagerAt || profile.recentWagers?.[0]?.insert_datetime || profile.recentWagers?.[0]?.insert_date_time;
  const latest = latestAccess || latestWager;
  return latest ? timeAgo(latest) : 'No activity captured';
}

export function intelKvRow(label, value) {
  return `<div class="intel-kv-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></div>`;
}

export function intelStatCard(label, value, subtext) {
  return `<div class="intel-stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '0')}</strong><small>${escapeHtml(subtext || '')}</small></div>`;
}

export function intelMiniMetric(label, value, subtext) {
  return `<div class="intel-mini-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '0')}</strong>${subtext ? `<small>${escapeHtml(subtext)}</small>` : ''}</div>`;
}

export function renderAgentAssignmentCard(agentContext) {
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

export async function refreshPlayerAgentContext(playerId) {
  const playerProfileState = get('playerProfileState');
  if (!playerId || playerProfileState.agentContextLoading) return;
  playerProfileState.agentContextLoading = true;
  set('playerProfileState', playerProfileState);
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
      set('playerProfileState', playerProfileState);
      if (['overview', 'agent'].includes(playerProfileState.tab)) renderPlayerProfile();
    }
  } catch (err) {
    console.warn('[Players] Agent context refresh failed:', err?.message || err);
  } finally {
    playerProfileState.agentContextLoading = false;
    set('playerProfileState', playerProfileState);
  }
}

export function renderPlayerProfileAgent(profile) {
  const el = document.getElementById('playerProfileAgent');
  if (!el) return;
  const context = profile.agentContext || {};
  const agent = profile.agent || context.assigned;
  if (!agent) {
    refreshPlayerAgentContext(profile.playerId || get('playerProfileState').playerId);
    el.innerHTML = '<div class="profile-doc-panel"><h3>No Agent Link</h3><p class="text-sm" style="color:var(--text-dim);">Checking the real Buckeye agent-context endpoint for this player.</p></div>';
    return;
  }
  const lineage = Array.isArray(profile.allAgents) ? profile.allAgents : (context.lineage || []);
  const children = context.children || [];
  const siblings = context.siblings || [];
  const roots = context.roots || [];
  const stats = context.treeStats || {};
  const playerProfileState = get('playerProfileState');
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

export function filterAgentNodes(nodes, filter) {
  if (!filter) return nodes || [];
  return (nodes || []).filter(node => `${node.login || ''} ${node.agentId || ''} ${node.agentType || ''} ${node.level || ''}`.toLowerCase().includes(filter));
}

export function setPlayerAgentFilter(value) {
  const playerProfileState = get('playerProfileState');
  playerProfileState.agentFilter = value || '';
  set('playerProfileState', playerProfileState);
  if (playerProfileState.tab === 'agent') renderPlayerProfile();
}

export function renderAgentLineage(lineage, activeAgentId) {
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

export function renderAgentRates(agent) {
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

export function renderAgentComplianceSection(nodes) {
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

export function renderAgentNodeList(nodes, emptyText) {
  if (!nodes.length) return `<div class="intel-empty">${escapeHtml(emptyText)}</div>`;
  return `<div class="agent-node-list" role="tree" aria-label="Agent branch">${nodes.slice(0, 80).map(node => `<button type="button" class="agent-node-row" role="treeitem" aria-expanded="${Number(node.childCount || 0) > 0 ? 'false' : 'undefined'}" onclick="openAgentTreeFromProfile('${escapeJs(node.agentId)}')">
    <span><strong>${escapeHtml(node.login || node.agentId)}</strong><small>${escapeHtml(node.agentId)} · L${escapeHtml(node.level)} · ${escapeHtml(node.agentType)}</small></span>
    <span class="font-mono">${Number(node.playerCount || 0).toLocaleString()}</span>
  </button>`).join('')}</div>`;
}

export function openAgentTreeFromProfile(agentId) {
  closePlayerProfileModal(false);
  if (typeof switchSection === 'function') switchSection('agentTree', typeof getSidebarButton === 'function' ? getSidebarButton('agentTree') : null);
  setTimeout(() => {
    if (typeof refreshAgentDownline === 'function') {
      refreshAgentDownline(true).then(() => {
        const agentTreeFlat = get('agentTreeFlat') || [];
        const target = agentTreeFlat.find(node => node.AgentID === agentId || node.agent === agentId);
        if (target) {
          let current = target;
          while (current) {
            current.expanded = true;
            current = agentTreeFlat.find(node => (node.children || []).includes(current));
          }
          if (typeof renderAgentTree === 'function') renderAgentTree(get('agentTreeData') || []);
          if (typeof currentSection !== 'undefined' && currentSection === 'agentTree' && typeof initAgentCanvas === 'function') initAgentCanvas();
        }
      }).catch(() => { });
    }
  }, 0);
}

export function renderRiskFactors(profile) {
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

export function renderCompactFlags(flags) {
  if (!flags.length) return '<div class="intel-empty">No manual flags yet.</div>';
  return `<div class="intel-stack">${flags.slice(0, 3).map(flag => `<div class="intel-flag-card ${escapeHtml(flag.severity || 'info')}">
    <div><strong>${escapeHtml(flag.label || flag.flag_type || 'Flag')}</strong><small>${escapeHtml(formatShortDateTime(flag.created_at))}</small></div>
    <p>${escapeHtml(flag.details || flag.status || 'Open')}</p>
  </div>`).join('')}</div>`;
}

export function renderCompactNotes(notes) {
  if (!notes.length) return '<div class="intel-empty">No notes yet. Add Telegram handles, VIP host context, or compliance notes from the Notes tab.</div>';
  return `<div class="intel-stack">${notes.slice(0, 2).map(note => `<div class="intel-note-card">
    <div><strong>${escapeHtml(note.note_type || 'Note')}</strong><small>${escapeHtml(formatShortDateTime(note.created_at))}</small></div>
    <p>${escapeHtml(note.body || '')}</p>
  </div>`).join('')}</div>`;
}

export function renderIntelWagerFeed(wagers) {
  if (!wagers.length) return '<div class="intel-empty">No wagers captured yet.</div>';
  return wagers.slice(0, 12).map(row => renderIntelWagerCard(row)).join('');
}

export function renderIntelWagerCard(row) {
  const w = typeof normalizeBackendWager === 'function' ? normalizeBackendWager(row) : row;
  const flags = row.pattern_flags || row.patternFlags || [];
  const pattern = intelWagerPattern(row, flags);
  const clv = Number(row.clv_percent ?? row.clvPercent ?? 0);
  return `<div class="intel-wager-card ${pattern.className}">
    <div class="intel-wager-main">
      <div class="intel-sport-token">${escapeHtml(String(sport).slice(0, 3).toUpperCase())}</div>
      <div class="min-w-0">
        <strong>${escapeHtml((typeof parseDescription === 'function' ? parseDescription(w.ShortDesc) : w.ShortDesc) || w.WagerType || 'Wager')}</strong>
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

export function intelWagerPattern(row, flags) {
  const text = Array.isArray(flags) ? flags.join(' ').toLowerCase() : '';
  const clv = Math.abs(Number(row.clv_percent ?? row.clvPercent ?? 0));
  if (text.includes('past')) return { key: 'pastpost', label: 'Past post', className: 'pattern-pastpost' };
  if (text.includes('stale')) return { key: 'stale', label: 'Stale', className: 'pattern-stale' };
  if (text.includes('burst')) return { key: 'burst', label: 'Burst', className: 'pattern-burst' };
  if (text.includes('clv') || clv >= 3) return { key: 'clv', label: 'CLV', className: 'pattern-clv' };
  return { key: '', label: '', className: '' };
}

export function renderWeeklyPnlSummary(weeklyPnl) {
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

export function renderLivePnlSummary(livePerf) {
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

export function renderClvBySport(profile) {
  const wagers = profile.recentWagers || [];
  const bySport = new Map();
  for (const row of wagers) {
    const w = typeof normalizeBackendWager === 'function' ? normalizeBackendWager(row) : row;
    const sport = w.Sport || (typeof parseSport === 'function' ? parseSport(w.ShortDesc) : 'Unknown');
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

export function renderLinkedAccountCards(profile) {
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

export function renderAccessLogCards(profile) {
  const logs = profile.accessLogs || [];
  if (!logs.length) return '<div class="intel-empty">No access logs captured yet.</div>';
  return logs.slice(0, 8).map(log => `<div class="intel-access-card ${log.isNewIp ? 'novel' : ''}">
    <div><strong>${escapeHtml(log.ip_address || '-')}</strong>${log.isNewIp ? '<span>New IP</span>' : ''}</div>
    <p>${escapeHtml(log.geo || 'Unknown geo')} · ${escapeHtml(log.device || 'Unknown device')}</p>
    <small>${escapeHtml(formatShortDateTime(log.access_datetime))} · ${escapeHtml(log.operation || log.log_type || 'access')}</small>
  </div>`).join('');
}

export function renderGeoDistribution(profile) {
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

export function profileStatusChip(status) {
  const normalized = String(status || 'missing').toLowerCase();
  const labels = { fresh: 'Fresh', live: 'Live', derived: 'Derived', manual: 'Manual', probe: 'Probe', stale: 'Stale', error: 'Error', missing: 'Missing' };
  return `<span class="profile-status-chip ${normalized}">${escapeHtml(labels[normalized] || normalized)}</span>`;
}

export function profileEmptyRow(message, colspan) {
  return `<tr><td colspan="${colspan}" class="text-center" style="color:var(--text-dim);">${escapeHtml(message)}</td></tr>`;
}

export function destroyPlayerProfileChart(key) {
  const playerProfileState = get('playerProfileState');
  if (playerProfileState.charts[key]) {
    playerProfileState.charts[key].destroy();
    delete playerProfileState.charts[key];
  }
}

export function destroyPlayerProfileCharts() {
  Object.keys(get('playerProfileState').charts).forEach(destroyPlayerProfileChart);
}

export function focusPlayerFlagComposer() {
  setPlayerProfileTab('notes');
  setTimeout(() => document.getElementById('playerFlagLabel')?.focus(), 0);
}

export function focusPlayerNoteComposer() {
  setPlayerProfileTab('notes');
  setTimeout(() => document.getElementById('playerNoteBody')?.focus(), 0);
}

// ==================== WINDOW EXPORTS ====================
window.profileStatusChip = profileStatusChip;
window.profileEmptyRow = profileEmptyRow;
window.destroyPlayerProfileChart = destroyPlayerProfileChart;
window.destroyPlayerProfileCharts = destroyPlayerProfileCharts;
