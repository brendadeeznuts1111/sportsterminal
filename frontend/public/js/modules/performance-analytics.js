/**
 * Performance Analytics Module
 * Extracted from app.js lines ~5557-6140.
 * Handles performance dashboard, charts, raw API logs, access logs,
 * weekly figures, master snapshots, and agent performance detail.
 */

import { fetchBlob, fetchJson, getApiBaseUrl } from '../api.js';
import { escapeHtml, money, setText, timeAgo } from '../utils.js';
import { get, set } from './state.js';

// ==================== STATE INITIALIZATION ====================
if (!get('performanceState')) {
  set('performanceState', {
    velocity: [],
    liveVsPre: null,
    master: [],
    performanceSummary: [],
    weeklyFigures: [],
    masterSnapshots: [],
    rawLogs: [],
    accessLogs: [],
    rawLogFilters: { endpoint: '', agentId: '', status: '', days: '7' },
    selectedAgent: '',
    selectedRawLogId: null,
  });
}

// Chart instances (module-level to preserve across renders)
let velocityChart = null;
let liveVsPreChart = null;

// ==================== LOAD PERFORMANCE PAGE ====================
export async function loadPerformancePage(force = false) {
  if (!force && typeof isCacheFresh === 'function' && isCacheFresh('performance')) {
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

    const performanceState = get('performanceState');
    performanceState.velocity = velocityRes.ok ? (await velocityRes.json()).velocity || [] : [];
    performanceState.liveVsPre = liveRes.ok ? await liveRes.json() : null;
    performanceState.master = masterRes.ok ? (await masterRes.json()).snapshots || [] : [];
    performanceState.performanceSummary = performanceRes.ok ? (await performanceRes.json()).summary || [] : [];
    performanceState.weeklyFigures = weeklyRes.ok ? (await weeklyRes.json()).figures || [] : [];
    performanceState.masterSnapshots = snapshotsRes.ok ? (await snapshotsRes.json()).snapshots || [] : [];
    set('performanceState', performanceState);

    await loadRawApiArchive(false);
    await loadAccessLogsForPerformance(false);
    if (typeof markCacheFresh === 'function') markCacheFresh('performance');
    renderPerformanceDashboard();
  } catch (error) {
    showToast('Performance analytics unavailable', 'warning');
    renderPerformanceError(error);
  }
}

// ==================== RAW API LOGS ====================
export async function loadRawApiArchive(render = true, includeBody = false, logId = null) {
  const performanceState = get('performanceState');
  const endpoint = document.getElementById('rawLogEndpointFilter')?.value || performanceState.rawLogFilters.endpoint || '';
  const agentId = document.getElementById('rawLogAgentFilter')?.value?.trim() || performanceState.rawLogFilters.agentId || '';
  const status = document.getElementById('rawLogStatusFilter')?.value || performanceState.rawLogFilters.status || '';
  const days = document.getElementById('rawLogDaysFilter')?.value || performanceState.rawLogFilters.days || '7';
  performanceState.rawLogFilters = { endpoint, agentId, status, days };
  set('performanceState', performanceState);

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
    set('performanceState', performanceState);
    if (render) {
      renderRawLogsTable();
      renderRawApiFreshness();
    }
  } catch {
    performanceState.rawLogs = [];
    set('performanceState', performanceState);
    if (render) {
      renderRawLogsTable();
      renderRawApiFreshness();
    }
  }
}

// ==================== ACCESS LOGS ====================
export async function loadAccessLogsForPerformance(render = true) {
  const ip = document.getElementById('accessIpFilter')?.value?.trim() || '';
  const url = new URL(`${getApiBaseUrl()}/api/logs/access`);
  url.searchParams.set('limit', '120');
  if (ip) url.searchParams.set('ip', ip);
  try {
    const res = await fetch(url.toString());
    const performanceState = get('performanceState');
    performanceState.accessLogs = res.ok ? (await res.json()).logs || [] : [];
    set('performanceState', performanceState);
    if (render) renderAccessLogMonitor();
  } catch {
    const performanceState = get('performanceState');
    performanceState.accessLogs = [];
    set('performanceState', performanceState);
    if (render) renderAccessLogMonitor();
  }
}

// ==================== RENDER DASHBOARD ====================
export function renderPerformanceDashboard() {
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

export function renderPerformanceError(error) {
  setText('perfMasterAge', error instanceof Error ? error.message : 'Unable to load');
  const rows = document.getElementById('agentPerformanceRows');
  if (rows) rows.innerHTML = '<tr><td colspan="5" class="px-2 py-6 text-center" style="color:var(--red);">Performance endpoints are not available.</td></tr>';
  const access = document.getElementById('accessLogMonitorRows');
  if (access) access.innerHTML = '<tr><td colspan="4" class="px-2 py-6 text-center" style="color:var(--red);">Access logs unavailable.</td></tr>';
}

export function renderMasterHealth() {
  const performanceState = get('performanceState');
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

// ==================== CHARTS ====================
export function renderVelocityChart() {
  const canvas = document.getElementById('velocityChart');
  if (!canvas || !window.Chart) return;
  const performanceState = get('performanceState');
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

export function renderLiveVsPreChart() {
  const canvas = document.getElementById('liveVsPreChart');
  if (!canvas || !window.Chart) return;
  const performanceState = get('performanceState');
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
      if (typeof switchSection === 'function') switchSection('positions', typeof getSidebarButton === 'function' ? getSidebarButton('positions') : null);
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

// ==================== ACCESS LOG MONITOR ====================
export function renderAccessLogMonitor() {
  const tbody = document.getElementById('accessLogMonitorRows');
  if (!tbody) return;
  const performanceState = get('performanceState');
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

export function filterAccessIp(ip) {
  const input = document.getElementById('accessIpFilter');
  if (!input || !ip) return;
  input.value = ip;
  loadAccessLogsForPerformance();
}

// ==================== AGENT PERFORMANCE TABLE ====================
export function renderAgentPerformanceTable() {
  const tbody = document.getElementById('agentPerformanceRows');
  if (!tbody) return;
  const performanceState = get('performanceState');
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

// ==================== RAW LOGS TABLE ====================
export function renderRawLogsTable() {
  const tbody = document.getElementById('perfRawLogsRows');
  const countEl = document.getElementById('perfRawLogsCount');
  const coverage = document.getElementById('rawRedactionCoverage');
  if (!tbody) return;
  const performanceState = get('performanceState');
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

export function renderRawApiFreshness() {
  const container = document.getElementById('rawApiFreshnessCards');
  if (!container) return;
  const performanceState = get('performanceState');
  const rows = performanceState.rawLogs || [];
  const buckeyeWagers = get('buckeyeWagers') || [];
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

export function openRawJsonDrawer(logId) {
  const performanceState = get('performanceState');
  performanceState.selectedRawLogId = logId;
  set('performanceState', performanceState);
  setText('rawJsonBody', 'Loading redacted JSON...');
  document.getElementById('rawJsonDrawer')?.classList.remove('hidden');
  loadRawApiArchive(false, true, logId);
}

export function closeRawJsonDrawer() {
  const performanceState = get('performanceState');
  performanceState.selectedRawLogId = null;
  set('performanceState', performanceState);
  document.getElementById('rawJsonDrawer')?.classList.add('hidden');
  setText('rawJsonBody', '');
}

export function showRawJsonDrawer(row) {
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

// ==================== WEEKLY FIGURES & MASTER SNAPSHOTS ====================
export function renderWeeklyFiguresTable() {
  const tbody = document.getElementById('perfWeeklyFiguresRows');
  const countEl = document.getElementById('perfWeeklyFiguresCount');
  if (!tbody) return;
  const performanceState = get('performanceState');
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

export function renderMasterSnapshotsTable() {
  const tbody = document.getElementById('perfMasterSnapshotsRows');
  const countEl = document.getElementById('perfMasterSnapshotsCount');
  if (!tbody) return;
  const performanceState = get('performanceState');
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

// ==================== AGENT PERFORMANCE DETAIL ====================
export async function loadAgentPerformanceDetail(agentId) {
  if (!agentId) return;
  const performanceState = get('performanceState');
  performanceState.selectedAgent = agentId;
  set('performanceState', performanceState);
  const detail = document.getElementById('agentPerformanceDetail');
  if (detail) {
    detail.classList.remove('hidden');
    detail.innerHTML = '<span style="color:var(--text-dim);">Loading detail...</span>';
  }
  try {
    const payload = await fetchJson(`/api/performance/details?agent=${encodeURIComponent(agentId)}&weeks=8`);
    renderAgentPerformanceDetail(payload);
  } catch {
    if (detail) detail.innerHTML = '<span style="color:var(--red);">Unable to load agent detail.</span>';
  }
}

export function renderAgentPerformanceDetail(payload) {
  const detail = document.getElementById('agentPerformanceDetail');
  if (!detail) return;
  const performanceState = get('performanceState');
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

// ==================== WAGER RECORDING & EXPORT ====================
export function recordPerformanceWager(wager) {
  if (!wager) return;
  const ts = new Date(wager.InsertDateTime || wager.insert_date_time || Date.now());
  if (!Number.isFinite(ts.getTime())) return;
  const bucket = ts.toISOString().slice(0, 16).replace('T', ' ');
  const performanceState = get('performanceState');
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
  set('performanceState', performanceState);
  if (typeof currentSection !== 'undefined' && currentSection === 'performance') renderVelocityChart();
}

export async function exportAnalytics(kind) {
  const labels = { wagers: 'wagers', 'access-logs': 'access logs', performance: 'performance' };
  try {
    showToast(`Preparing ${labels[kind] || kind} export...`, 'info');
    const blob = await fetchBlob(`/api/export/${kind}`);
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

// ==================== WEBHOOKS ====================
export async function editWebhook(id) {
  try {
    const wh = await fetchJson(`/api/webhooks/${id}`);
    if (!wh) return;

    const editingWebhookId = id;
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

export async function deleteWebhook(id) {
  if (!confirm('Delete this webhook?')) return;
  try {
    await fetchDelete(`/api/webhooks/${id}`);
    showToast('Webhook deleted', 'success');
    if (typeof loadWebhooks === 'function') loadWebhooks(true);
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Failed to delete webhook', 'error');
  }
}

// ==================== FALLBACK & WAGER DETAIL ====================
export function showFallbackBanner(show, message) {
  const banner = document.getElementById('fallbackBanner');
  if (!banner) return;
  if (show) {
    banner.textContent = '⚠️ ' + (message || 'Live feed disconnected - showing latest persisted Buckeye data');
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

export function showWagerDetail(wagerNumber) {
  const buckeyeWagers = get('buckeyeWagers') || [];
  const wager = buckeyeWagers.find(w => w.WagerNumber === wagerNumber);
  if (!wager) return;

  const risk = wager.VolumeAmount > 0 ? '$' + wager.VolumeAmount.toLocaleString() : 'PENDING';
  const win = '$' + (wager.ToWinAmount || 0).toLocaleString();
  const typeLabel = typeof getWagerTypeLabel === 'function' ? getWagerTypeLabel(wager.WagerType) : wager.WagerType;
  const sport = typeof parseSport === 'function' ? parseSport(wager.ShortDesc) : '';

  showWagerDetailModal(wager, risk, win, typeLabel, sport);
}

export function showWagerDetailModal(wager, risk, win, typeLabel, sport) {
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
        <div class="flex justify-between"><span style="color:var(--text-dim);">Player</span><span class="font-medium">${escapeHtml(wager.Login)}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">Agent</span><span class="font-medium">${escapeHtml(wager.AgentLogin)}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">Type</span><span class="font-medium">${escapeHtml(typeLabel)}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">Sport</span><span class="font-medium">${escapeHtml(sport)}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">Risk</span><span class="font-mono font-medium">${risk}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">To Win</span><span class="font-mono font-medium">${win}</span></div>
        <div class="flex justify-between"><span style="color:var(--text-dim);">Source</span><span class="font-medium">${escapeHtml(wager.TicketWriter)}</span></div>
      </div>
      <div class="border-t pt-4 mb-3" style="border-color:var(--border);">
        <div class="text-xs mb-2" style="color:var(--text-dim);">${escapeHtml(wager.ShortDesc || '')}</div>
      </div>
      <div class="flex gap-3">
        <button class="flex-1 py-2 rounded-lg text-sm font-bold" style="background:var(--green);color:#fff;"
          onclick="handleWagerAction(${wager.WagerNumber}, 'accept');document.getElementById('wagerDetailModal').remove()">
          Accept
        </button>
        <button class="flex-1 py-2 rounded-lg text-sm font-bold" style="background:var(--red);color:#fff;"
          onclick="handleWagerAction(${wager.WagerNumber}, 'decline');document.getElementById('wagerDetailModal').remove()">
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

export function handleWagerAction(wagerNumber, action) {
  if (typeof wsClient === 'undefined' || !wsClient || !wsClient.isAuthenticated) {
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

export function filterBooks() {
  if (typeof renderOddsMatrix === 'function') renderOddsMatrix();
}

export function toggleOddsFormat() {
  const current = get('oddsFormat') || 'american';
  const oddsFormat = current === 'american' ? 'decimal' : 'american';
  set('oddsFormat', oddsFormat);
  const btn = document.getElementById('oddsFormatBtn');
  if (btn) btn.textContent = oddsFormat === 'american' ? 'American' : 'Decimal';
  if (typeof renderOddsMatrix === 'function') renderOddsMatrix();
}

// Window exports
window.loadPerformancePage = loadPerformancePage;
window.loadRawApiArchive = loadRawApiArchive;
window.loadAccessLogsForPerformance = loadAccessLogsForPerformance;
window.renderPerformanceDashboard = renderPerformanceDashboard;
window.renderPerformanceError = renderPerformanceError;
window.renderMasterHealth = renderMasterHealth;
window.renderVelocityChart = renderVelocityChart;
window.renderLiveVsPreChart = renderLiveVsPreChart;
window.renderAccessLogMonitor = renderAccessLogMonitor;
window.filterAccessIp = filterAccessIp;
window.renderAgentPerformanceTable = renderAgentPerformanceTable;
window.renderRawLogsTable = renderRawLogsTable;
window.renderRawApiFreshness = renderRawApiFreshness;
window.openRawJsonDrawer = openRawJsonDrawer;
window.closeRawJsonDrawer = closeRawJsonDrawer;
window.showRawJsonDrawer = showRawJsonDrawer;
window.renderWeeklyFiguresTable = renderWeeklyFiguresTable;
window.renderMasterSnapshotsTable = renderMasterSnapshotsTable;
window.loadAgentPerformanceDetail = loadAgentPerformanceDetail;
window.renderAgentPerformanceDetail = renderAgentPerformanceDetail;
window.recordPerformanceWager = recordPerformanceWager;
window.exportAnalytics = exportAnalytics;
window.editWebhook = editWebhook;
window.deleteWebhook = deleteWebhook;
window.showFallbackBanner = showFallbackBanner;
window.showWagerDetail = showWagerDetail;
window.showWagerDetailModal = showWagerDetailModal;
window.handleWagerAction = handleWagerAction;
window.filterBooks = filterBooks;
window.toggleOddsFormat = toggleOddsFormat;
