/**
 * Buckeye Integration Module
 * Extracted from app.js lines ~757-1160.
 * Handles WebSocket status, Buckeye status badge, top bar status,
 * backend wager normalization, merging, and rendering of Buckeye wagers,
 * pending wagers, and exposure breakdowns.
 */

import { escapeHtml, money } from '../utils.js';
import { get, set } from './state.js';

// ==================== WS STATUS ====================
export function updateWSStatus(connected) {
  const statusEl = document.getElementById('wsStatus');
  if (statusEl) {
    const url = (typeof wsClient !== 'undefined' && wsClient?.url) ? wsClient.url : 'unknown';
    statusEl.title = `WS: ${url}`;
    if (connected) {
      statusEl.style.color = 'var(--green)';
      statusEl.style.background = 'rgba(16,185,129,0.1)';
      statusEl.style.borderColor = 'rgba(16,185,129,0.3)';
      statusEl.innerHTML = '<div class="w-2 h-2 rounded-full pulse-dot" style="background:var(--green);"></div><span>WS Live</span>';
      const subscribedPlayerId = get('ws.subscribedPlayerId');
      if (subscribedPlayerId && typeof wsClient !== 'undefined' && wsClient?.send) {
        wsClient.send({ type: 'player.subscribe', playerId: subscribedPlayerId });
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

export function updateBuckeyeStatusBadge(state, label) {
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

export function updateTopBarStatus() {
  const backend = document.getElementById('topBackendIngest');
  const freshness = document.getElementById('topWagerFreshness');
  const socket = document.getElementById('topUiSocket');
  const toast = document.getElementById('topToastToggle');
  const agent = localStorage.getItem('agentId') || '';
  const buckeyeWagers = get('buckeyeWagers') || [];
  const liveAgents = Number(window.backendLiveAgents || 0);
  const wsConnected = (typeof wsClient !== 'undefined' && wsClient?.ws?.readyState === WebSocket.OPEN);

  if (backend) {
    const label = liveAgents > 0
      ? `Backend: ${liveAgents} agent${liveAgents === 1 ? '' : 's'} ingesting`
      : wsConnected
        ? `Backend: ${agent || 'agent'} ready`
        : 'Backend: no active ingest';
    backend.className = `topbar-chip ${liveAgents > 0 ? 'live' : wsConnected ? 'warn' : 'offline'}`;
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
    socket.className = `topbar-chip ${wsConnected ? 'live' : 'offline'}`;
    socket.innerHTML = `<span class="topbar-dot ${wsConnected ? 'pulse-dot' : ''}"></span><span>UI socket: ${wsConnected ? 'live' : 'offline'}</span>`;
    socket.title = wsConnected
      ? 'Browser WebSocket is connected for UI deltas.'
      : 'Browser WebSocket is offline. Backend ingestion can still be live.';
  }
  if (toast) {
    const enabled = localStorage.getItem('toastsEnabled') !== 'false';
    toast.textContent = enabled ? 'Toasts: On' : 'Toasts: Off';
    toast.className = `topbar-chip ${enabled ? 'live' : 'offline'}`;
  }
}

// ==================== WAGER NORMALIZATION ====================
export function normalizeBackendWager(row) {
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

export function mergeWagers(rows) {
  const normalized = rows.map(normalizeBackendWager).filter(w => w.WagerNumber !== undefined && w.WagerNumber !== null);
  if (!normalized.length) return 0;
  const existing = new Map();
  const buckeyeWagers = get('buckeyeWagers') || [];
  for (const wager of buckeyeWagers) {
    existing.set(String(wager.WagerNumber), wager);
  }
  for (const wager of normalized) {
    existing.set(String(wager.WagerNumber), wager);
  }
  const merged = Array.from(existing.values()).sort((a, b) => new Date(b.InsertDateTime) - new Date(a.InsertDateTime));
  set('buckeyeWagers', merged);
  if (typeof sectionCache !== 'undefined') {
    if (sectionCache?.downline) sectionCache.downline.at = 0;
    if (sectionCache?.exposure) sectionCache.exposure.at = 0;
  }
  updateBuckeyeStats();
  if (typeof scheduleRender === 'function') scheduleRender('all');
  return normalized.length;
}

export function updateFromBackend(data) {
  console.log('[Backend] Received data:', data);
  if (data.wagers && Array.isArray(data.wagers)) {
    const added = mergeWagers(data.wagers);
    console.log('[Backend] Wagers merged:', added, 'rows');
  }
  if (data.alerts && Array.isArray(data.alerts)) {
    data.alerts.forEach(alert => {
      if (typeof showToast === 'function') {
        showToast(`${alert.severity}: ${alert.message}`, alert.severity === 'critical' ? 'error' : 'warning');
      }
    });
    console.log('[Backend] Alerts:', data.alerts.length);
  }
}

// ==================== BUCKEYE WAGER TABLE ====================
export function renderBuckeyeWagers() {
  const tbody = document.getElementById('buckeyeWagerTable');
  if (!tbody) return;
  ensurePendingWagersPanel();
  updateWagerFilterCounts();

  let filtered = [...(get('buckeyeWagers') || [])];
  const buckeyeFilter = get('buckeyeFilter') || 'all';
  const vipOnly = get('vipOnly') || false;

  if (buckeyeFilter !== 'all') {
    if (buckeyeFilter === 'alert') {
      filtered = filtered.filter(w => w.TicketWriter === 'ALERT');
    } else if (buckeyeFilter === 'live') {
      filtered = filtered.filter(w => w.TicketWriter === 'GSLIVE');
    } else if (typeof detectWagerType === 'function') {
      filtered = filtered.filter(w => detectWagerType(w) === buckeyeFilter);
    }
  }

  if (vipOnly) {
    filtered = filtered.filter(w => w.VIP !== '0');
  }

  const minBet = parseInt(document.getElementById('minBetFilter')?.value || 0);
  if (minBet > 0) {
    filtered = filtered.filter(w => w.AmountWagered >= minBet);
  }

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
  const sortColumn = get('sortColumn') || 'time';
  const sortDirection = get('sortDirection') || 'desc';
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
        cmp = (typeof parseSport === 'function' ? parseSport(a.ShortDesc).localeCompare(parseSport(b.ShortDesc)) : 0);
        break;
      case 'league':
        cmp = ((typeof parseLeague === 'function' ? parseLeague(a.ShortDesc) : '') || '').localeCompare((typeof parseLeague === 'function' ? parseLeague(b.ShortDesc) : '') || '');
        break;
      case 'type':
        cmp = (typeof detectWagerType === 'function' ? detectWagerType(a).localeCompare(detectWagerType(b)) : 0);
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

  const TABLE_RENDER_LIMIT = 150;
  const totalFiltered = filtered.length;
  const visibleRows = filtered.slice(0, TABLE_RENDER_LIMIT);

  tbody.innerHTML = visibleRows.map(w => {
    const rawTypeInfo = (typeof WAGER_TYPES !== 'undefined' && WAGER_TYPES[typeof detectWagerType === 'function' ? detectWagerType(w) : w.WagerType]) || { label: w.WagerType, color: '#6b7280' };
    const marketKey = typeof detectMarketType === 'function' ? detectMarketType(w) : w.WagerType;
    const typeInfo = (typeof WAGER_MARKETS !== 'undefined' && WAGER_MARKETS[marketKey]) || rawTypeInfo;
    const isAlert = w.TicketWriter === 'ALERT';
    const isLive = w.TicketWriter === 'GSLIVE';
    const disabledFeatureReason = typeof getDisabledFeatureReason === 'function' ? getDisabledFeatureReason(w) : '';
    const rowClass = disabledFeatureReason ? 'alert-row' : isAlert ? 'alert-row' : isLive ? 'gslive-row' : '';

    const dt = new Date(w.InsertDateTime);
    const timeStr = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const cleanDesc = typeof parseDescription === 'function' ? parseDescription(w.ShortDesc) : w.ShortDesc;
    const fullDesc = w.ShortDesc;
    const league = typeof parseLeague === 'function' ? parseLeague(w.ShortDesc) : '';
    const sport = typeof parseSport === 'function' ? parseSport(w.ShortDesc) : '';
    const price = typeof extractPrice === 'function' ? extractPrice(w.ShortDesc) : '';
    const wager = w.AmountWagered || w.VolumeAmount || 0;
    const risk = wager > 0 ? '$' + wager.toLocaleString() : '<span style="color:var(--red)">PENDING</span>';
    const win = '$' + Math.round(wager * 1.5).toLocaleString();

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

  renderPendingWagers();
  const pendingWagerLoading = get('pendingWagerLoading');
  const pendingWagers = get('pendingWagers') || [];
  const pendingWagerLastError = get('pendingWagerLastError') || '';
  if (!pendingWagerLoading && !pendingWagers.length && !pendingWagerLastError) {
    loadPendingWagers(false);
  }
}

// ==================== PENDING WAGERS ====================
export function ensurePendingWagersPanel() {
  if (document.getElementById('pendingWagersPanel')) return;
  const table = document.getElementById('buckeyeWagerTable');
  const tickerCard = table?.closest('.rounded-lg.border.overflow-hidden') || table?.closest('.rounded-lg');
  if (!tickerCard) return;

  const panel = document.createElement('div');
  panel.id = 'pendingWagersPanel';
  panel.className = 'rounded-lg border overflow-hidden mt-4';
  panel.style.background = 'var(--panel)';
  panel.style.borderColor = 'var(--border)';
  panel.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3 p-3 border-b" style="border-color:var(--border);">
      <div>
        <div class="text-sm font-semibold">Pending Wagers</div>
        <div id="pendingWagersMeta" class="text-xs mt-1" style="color:var(--text-dim);">Grouped by ticket and wager number. Parlays expand into legs.</div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <input id="pendingWagersDate" type="date" class="text-xs px-2 py-1 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);">
        <select id="pendingWagersType" class="text-xs px-2 py-1 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);">
          <option value="">All Types</option>
          <option value="S">Straight</option>
          <option value="P">Parlay</option>
          <option value="I">If Bets</option>
          <option value="T">Teaser</option>
          <option value="G">Racebook</option>
          <option value="A">Manual Plays</option>
          <option value="C">Contest</option>
          <option value="N">Live/Props</option>
        </select>
        <select id="pendingWagersTime" class="text-xs px-2 py-1 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);">
          <option value="730">All</option>
          <option value="0" selected>Today</option>
          <option value="3">3 Days</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
        </select>
        <select id="pendingWagersAmount" class="text-xs px-2 py-1 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);">
          <option value="">All Amounts</option>
          <option value="100">$100+</option>
          <option value="500">$500+</option>
          <option value="1000">$1,000+</option>
          <option value="5000">$5,000+</option>
          <option value="10000">$10,000+</option>
        </select>
        <button id="pendingWagersRefresh" type="button" class="px-3 py-1 rounded text-xs font-medium" style="background:var(--accent);color:#fff;">Refresh</button>
      </div>
    </div>
    <div id="pendingWagersStats" class="grid grid-cols-2 md:grid-cols-6 gap-2 p-3 border-b text-xs" style="border-color:var(--border);"></div>
    <div id="pendingWagersList" class="text-xs"></div>
  `;
  tickerCard.insertAdjacentElement('afterend', panel);

  const dateInput = panel.querySelector('#pendingWagersDate');
  if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
  panel.querySelector('#pendingWagersRefresh')?.addEventListener('click', () => loadPendingWagers(true));
  panel.querySelector('#pendingWagersDate')?.addEventListener('change', () => loadPendingWagers(true));
  panel.querySelector('#pendingWagersType')?.addEventListener('change', () => loadPendingWagers(true));
  panel.querySelector('#pendingWagersTime')?.addEventListener('change', () => loadPendingWagers(true));
  panel.querySelector('#pendingWagersAmount')?.addEventListener('change', () => loadPendingWagers(true));
  panel.querySelector('#pendingWagersList')?.addEventListener('click', (event) => {
    const target = event.target.closest('[data-pending-toggle]');
    if (!target) return;
    const key = target.dataset.pendingToggle;
    const expanded = get('pendingWagerExpanded') || new Set();
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    set('pendingWagerExpanded', expanded);
    renderPendingWagers();
  });
}

export async function loadPendingWagers(force = false) {
  ensurePendingWagersPanel();
  if (get('pendingWagerLoading')) return;
  const lastFetchAt = get('pendingWagerLastFetchAt');
  if (!force && lastFetchAt && Date.now() - lastFetchAt < 30000) return;

  const proxy = getZone2ProxyCredentials();
  const agentID = localStorage.getItem('agentId') || 'BILLY666';
  const date = document.getElementById('pendingWagersDate')?.value || new Date().toISOString().split('T')[0];
  const wagerType = document.getElementById('pendingWagersType')?.value || '';
  const week = document.getElementById('pendingWagersTime')?.value || '0';
  const amount = document.getElementById('pendingWagersAmount')?.value || '';

  if (!proxy.token || !proxy.cf) {
    set('pendingWagerLastError', 'Set buckeye_token and cf_clearance in localStorage to load enhanced proxy pending wagers.');
    renderPendingWagers();
    return;
  }

  set('pendingWagerLoading', true);
  set('pendingWagerLastError', '');
  renderPendingWagers();

  try {
    const headers = { 'Content-Type': 'application/json' };
    const proxyApiKey = localStorage.getItem('proxyApiKey');
    if (proxyApiKey) headers['X-API-Key'] = proxyApiKey;
    const res = await fetch(`${proxy.baseUrl}/api/proxy/pending`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token: proxy.token,
        cf_clearance: proxy.cf,
        __cf_bm: localStorage.getItem('__cf_bm') || '',
        agentID,
        path: '/qubic/api/Manager/getPending',
        RRO: '1',
        date,
        wagerType,
        amount,
        sort: '1',
        typeSort: '2',
        week,
        customerID: '0',
        agentOwner: agentID,
        agentSite: '1',
      }),
    });
    const payload = await res.json();
    if (!res.ok || payload.error) throw new Error(payload.error || `Proxy ${res.status}`);
    set('pendingWagers', payload.data?.wagers || payload.wagers || []);
    set('pendingWagerLastFetchAt', Date.now());
  } catch (err) {
    set('pendingWagerLastError', err?.message || 'Pending wagers unavailable');
  } finally {
    set('pendingWagerLoading', false);
    renderPendingWagers();
  }
}

export function renderPendingWagers() {
  const statsEl = document.getElementById('pendingWagersStats');
  const listEl = document.getElementById('pendingWagersList');
  const metaEl = document.getElementById('pendingWagersMeta');
  if (!statsEl || !listEl) return;

  const pendingWagers = get('pendingWagers') || [];
  const totalStake = pendingWagers.reduce((sum, row) => sum + Number(row.wager?.stake || 0), 0);
  const totalToWin = pendingWagers.reduce((sum, row) => sum + Number(row.wager?.toWin || 0), 0);
  const totalLegs = pendingWagers.reduce((sum, row) => sum + (row.legs?.length || 0), 0);
  const parlays = pendingWagers.filter(row => row.wager?.typeName === 'PARLAY').length;
  const singles = pendingWagers.filter(row => !['PARLAY', 'TEASER'].includes(row.wager?.typeName)).length;
  const lastFetchAt = get('pendingWagerLastFetchAt');
  const latest = lastFetchAt ? new Date(lastFetchAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'not loaded';

  if (metaEl) {
    metaEl.textContent = get('pendingWagerLastError') || (get('pendingWagerLoading') ? 'Loading pending wagers...' : `Last refresh ${latest}`);
    metaEl.style.color = get('pendingWagerLastError') ? 'var(--red)' : 'var(--text-dim)';
  }

  statsEl.innerHTML = [
    pendingStat('Wagers', pendingWagers.length),
    pendingStat('Legs', totalLegs),
    pendingStat('Stake', money(totalStake)),
    pendingStat('To Win', money(totalToWin), 'var(--green)'),
    pendingStat('Parlays', parlays, 'var(--yellow)'),
    pendingStat('Singles', singles, 'var(--cyan)'),
  ].join('');

  if (get('pendingWagerLoading') && !pendingWagers.length) {
    listEl.innerHTML = '<div class="p-6 text-center" style="color:var(--text-dim);">Loading pending wagers...</div>';
    return;
  }
  if (get('pendingWagerLastError') && !pendingWagers.length) {
    listEl.innerHTML = `<div class="p-6 text-center" style="color:var(--red);">${escapeHtml(get('pendingWagerLastError'))}</div>`;
    return;
  }
  if (!pendingWagers.length) {
    listEl.innerHTML = '<div class="p-6 text-center" style="color:var(--text-dim);">No pending wagers for the selected filters.</div>';
    return;
  }

  listEl.innerHTML = pendingWagers.slice(0, 100).map(renderPendingWagerRow).join('');
}

function pendingStat(label, value, color = 'var(--text)') {
  return `<div class="rounded p-2" style="background:var(--bg);border:1px solid var(--border);">
    <div class="uppercase tracking-wider" style="color:var(--text-dim);">${escapeHtml(label)}</div>
    <div class="font-mono font-bold mt-1" style="color:${color};">${escapeHtml(value)}</div>
  </div>`;
}

function renderPendingWagerRow(row) {
  const wager = row.wager || {};
  const player = row.player || {};
  const legs = row.legs || [];
  const isParlay = wager.typeName === 'PARLAY';
  const isTeaser = wager.typeName === 'TEASER';
  const expanded = (get('pendingWagerExpanded') || new Set()).has(row.key);
  const accent = isParlay ? 'var(--yellow)' : isTeaser ? 'var(--cyan)' : 'var(--green)';
  const firstLeg = legs[0] || {};
  const description = isParlay
    ? `${Number(wager.totalPicks || legs.length).toLocaleString()} legs ${wager.parlayName ? `· ${wager.parlayName}` : ''}`
    : `${firstLeg.chosenTeam || 'Single leg'} · ${firstLeg.wagerTypeName || ''}`;

  return `<div class="border-b" style="border-color:var(--border);">
    <button type="button" data-pending-toggle="${escapeHtml(row.key)}" class="w-full text-left px-3 py-2 grid gap-3 items-center" style="grid-template-columns:70px minmax(120px,160px) 110px minmax(180px,1fr) 90px 90px 70px;border-left:3px solid ${accent};">
      <span class="font-mono text-[10px]">${escapeHtml(wager.ticketNumber || wager.wagerNumber || '-')}</span>
      <span class="text-xs font-medium">${escapeHtml(player.login || player.customerId || '-')}</span>
      <span class="text-[10px]" style="color:var(--text-dim);">${escapeHtml(wager.typeName || '-')}</span>
      <span class="text-xs truncate">${escapeHtml(description)}</span>
      <span class="text-right font-mono text-xs">${money(wager.stake || 0)}</span>
      <span class="text-right font-mono text-xs" style="color:var(--green);">${money(wager.toWin || 0)}</span>
      <span class="text-right text-[10px]">${expanded ? '▼' : '▶'}</span>
    </button>
    ${expanded ? `<div class="px-3 pb-2">${renderPendingLegs(legs)}</div>` : ''}
  </div>`;
}

function renderPendingLegs(legs) {
  if (!legs?.length) return '<div class="text-[10px]" style="color:var(--text-dim);">No legs</div>';
  return `<div class="space-y-1">${legs.map(leg => `<div class="flex items-center justify-between gap-2 text-[10px]">
    <span>${escapeHtml(leg.chosenTeam || '-')}</span>
    <span style="color:var(--text-dim);">${escapeHtml(leg.wagerTypeName || '-')}</span>
    <span class="font-mono">${escapeHtml(leg.line || leg.points || '-')}</span>
    <span class="font-mono" style="color:var(--accent);">${leg.odds || '-'}</span>
  </div>`).join('')}</div>`;
}

function getZone2ProxyCredentials() {
  return {
    token: localStorage.getItem('buckeye_token') || localStorage.getItem('buckeyeToken') || '',
    cf: localStorage.getItem('cf_clearance') || '',
    cfBm: localStorage.getItem('__cf_bm') || '',
    baseUrl: localStorage.getItem('proxyBaseUrl') || 'http://localhost:3001',
  };
}

export function filterWagerType(type) {
  set('buckeyeFilter', type);
  renderBuckeyeWagers();
}

export function updateWagerFilterCounts() {
  const buckeyeWagers = get('buckeyeWagers') || [];
  const counts = {
    all: buckeyeWagers.length,
    alert: buckeyeWagers.filter(w => w.TicketWriter === 'ALERT').length,
    live: buckeyeWagers.filter(w => w.TicketWriter === 'GSLIVE').length,
  };
  const elAll = document.getElementById('filterCountAll');
  const elAlert = document.getElementById('filterCountAlert');
  const elLive = document.getElementById('filterCountLive');
  if (elAll) elAll.textContent = counts.all;
  if (elAlert) elAlert.textContent = counts.alert;
  if (elLive) elLive.textContent = counts.live;
}

export function toggleVIP() {
  const current = get('vipOnly') || false;
  set('vipOnly', !current);
  renderBuckeyeWagers();
}

export function toggleAutoScroll() {
  const current = get('autoScroll') !== false;
  set('autoScroll', !current);
}

export function clearTicker() {
  set('buckeyeWagers', []);
  renderBuckeyeWagers();
}

export function updateBuckeyeStats() {
  const buckeyeWagers = get('buckeyeWagers') || [];
  const totalWagers = buckeyeWagers.length;
  const totalVolume = buckeyeWagers.reduce((sum, w) => sum + (w.AmountWagered || 0), 0);
  const liveCount = buckeyeWagers.filter(w => w.TicketWriter === 'GSLIVE').length;
  const alertCount = buckeyeWagers.filter(w => w.TicketWriter === 'ALERT').length;

  const elTotal = document.getElementById('buckeyeTotalWagers');
  const elVolume = document.getElementById('buckeyeTotalVolume');
  const elLive = document.getElementById('buckeyeLiveCount');
  const elAlert = document.getElementById('buckeyeAlertCount');

  if (elTotal) elTotal.textContent = totalWagers.toLocaleString();
  if (elVolume) elVolume.textContent = '$' + (totalVolume / 1000).toFixed(1) + 'K';
  if (elLive) elLive.textContent = liveCount.toLocaleString();
  if (elAlert) elAlert.textContent = alertCount.toLocaleString();
}

export function renderBuckeyeAgentExposure() {
  // Placeholder — detailed agent exposure is handled by positions-exposure.js
}

export function renderSportBreakdown() {
  // Placeholder — sport breakdown is handled by positions-exposure.js
}

export function renderGameBreakdown() {
  // Placeholder — game breakdown is handled by positions-exposure.js
}

// Window exports
window.updateWSStatus = updateWSStatus;
window.updateBuckeyeStatusBadge = updateBuckeyeStatusBadge;
window.updateTopBarStatus = updateTopBarStatus;
window.updateFromBackend = updateFromBackend;
window.renderBuckeyeWagers = renderBuckeyeWagers;
window.ensurePendingWagersPanel = ensurePendingWagersPanel;
window.renderPendingWagers = renderPendingWagers;
window.filterWagerType = filterWagerType;
window.updateWagerFilterCounts = updateWagerFilterCounts;
window.toggleVIP = toggleVIP;
window.toggleAutoScroll = toggleAutoScroll;
window.clearTicker = clearTicker;
window.updateBuckeyeStats = updateBuckeyeStats;
window.renderBuckeyeAgentExposure = renderBuckeyeAgentExposure;
window.renderSportBreakdown = renderSportBreakdown;
window.renderGameBreakdown = renderGameBreakdown;
