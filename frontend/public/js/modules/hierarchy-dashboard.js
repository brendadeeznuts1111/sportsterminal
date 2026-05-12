import { fetchJson, fetchPost } from '../api.js';
import { escapeHtml, setText } from '../utils.js';

const nf = new Intl.NumberFormat();
const state = {
  initialized: false,
  importing: false,
  searchTimer: null,
  hubs: [],
  sort: { key: 'agent_count', dir: 'desc' },
  showAll: { hubs: false, risk: false, tests: false, zero: false, hub: false },
  panels: { risk: false, tests: false, zero: false },
  panelData: { risk: null, tests: null, zero: null },
  activeHubId: '',
};

function el(id) {
  return document.getElementById(id);
}

function fmt(value) {
  return nf.format(Number(value || 0));
}

function toast(message, type = 'info') {
  if (typeof window.showToast === 'function') window.showToast(message, type);
}

function setError(message) {
  const box = el('hierarchyError');
  if (!box) return;
  if (!message) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.textContent = message;
  box.classList.remove('hidden');
}

function setSyncBadge(kind, text) {
  const status = el('hierarchySyncStatus');
  if (status) {
    status.textContent = text;
    status.style.color = kind === 'failed' ? 'var(--red)' : kind === 'running' ? 'var(--yellow)' : 'var(--text-dim)';
  }
  const badge = el('hierarchySyncBadge');
  if (!badge) return;
  if (kind === 'failed') {
    badge.textContent = '!';
    badge.classList.remove('hidden');
    badge.style.background = 'var(--red)';
    badge.style.color = '#fff';
  } else if (kind === 'running') {
    badge.textContent = '...';
    badge.classList.remove('hidden');
    badge.style.background = 'var(--yellow)';
    badge.style.color = '#0a0e17';
  } else {
    badge.classList.add('hidden');
  }
}

async function loadStats() {
  const stats = await fetchJson('/api/hierarchy/stats');
  setText('hierarchyTotalAgents', fmt(stats.total_agents));
  setText('hierarchyActiveHubs', fmt(stats.hubs));
  setText('hierarchyRiskAgents', fmt(stats.risk_agents));
  setText('hierarchyZeroRateAgents', fmt(stats.zero_rate_agents));
  setText('hierarchyLastImported', `Last imported: ${stats.last_imported ? new Date(stats.last_imported).toLocaleString() : '--'}`);
}

async function loadHubs() {
  const data = await fetchJson('/api/hierarchy/hubs');
  state.hubs = Array.isArray(data.hubs) ? data.hubs : [];
  renderHubs();
}

async function loadSyncStatus() {
  const data = await fetchJson('/api/hierarchy/sync-status');
  if (data.running) setSyncBadge('running', 'Running');
  else if (data.last_error) setSyncBadge('failed', 'Failed');
  else setSyncBadge('completed', data.enabled ? `Every ${data.interval_minutes}m` : 'Paused');
}

function sortedRows(rows, sort) {
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (typeof av === 'number' || typeof bv === 'number') return (Number(av || 0) - Number(bv || 0)) * dir;
    return String(av || '').localeCompare(String(bv || '')) * dir;
  });
}

function renderHubs() {
  const tbody = el('hierarchyHubsTable');
  if (!tbody) return;
  const rows = sortedRows(state.hubs, state.sort);
  const visible = state.showAll.hubs ? rows : rows.slice(0, 25);
  tbody.innerHTML = visible.length
    ? visible.map((hub) => `
      <tr class="cursor-pointer" onclick="openHierarchyHub(decodeURIComponent('${encodeURIComponent(String(hub.hub_id || hub.hub_name || ''))}'))"
        style="border-top:1px solid var(--border);">
        <td class="px-3 py-2 font-semibold">${escapeHtml(hub.hub_name || hub.hub_id || '--')}</td>
        <td class="px-3 py-2 text-right">${fmt(hub.agent_count)}</td>
        <td class="px-3 py-2 text-right">${fmt(hub.level)}</td>
        <td class="px-3 py-2 text-right" style="color:${Number(hub.risk_agent_count || 0) > 0 ? 'var(--yellow)' : 'var(--text-dim)'};">${fmt(hub.risk_agent_count)}</td>
        <td class="px-3 py-2">${escapeHtml(hub.commission_tier || 'standard')}</td>
      </tr>
    `).join('')
    : `<tr><td colspan="5" class="px-3 py-8 text-center" style="color:var(--text-dim);">No hubs found.</td></tr>`;
  setText('hierarchyHubsLimitBtn', state.showAll.hubs ? 'Show 25' : `Show all (${fmt(rows.length)})`);
}

async function searchAgents() {
  const input = el('hierarchySearchInput');
  const results = el('hierarchySearchResults');
  const q = input?.value?.trim() || '';
  if (!results) return;
  if (q.length < 2) {
    results.classList.add('hidden');
    results.innerHTML = '';
    return;
  }
  try {
    const data = await fetchJson(`/api/hierarchy/search?q=${encodeURIComponent(q)}`);
    const rows = Array.isArray(data.agents) ? data.agents : [];
    results.innerHTML = rows.length ? `
      <table class="w-full text-xs">
        <tbody>${rows.map((agent) => `
          <tr style="border-top:1px solid var(--border);">
            <td class="px-3 py-2 font-semibold">${escapeHtml(agent.login || agent.agent_id || '--')}</td>
            <td class="px-3 py-2">${escapeHtml(agent.agent_id || '')}</td>
            <td class="px-3 py-2 text-right">L${fmt(agent.level)}</td>
            <td class="px-3 py-2 text-right">${Number(agent.risk_score || 0).toFixed(2)}</td>
            <td class="px-3 py-2">${escapeHtml(agent.hub_name || '')}</td>
          </tr>
        `).join('')}</tbody>
      </table>
    ` : `<div class="px-3 py-4 text-xs" style="color:var(--text-dim);">No agents found.</div>`;
    results.classList.remove('hidden');
  } catch (error) {
    results.innerHTML = `<div class="px-3 py-4 text-xs" style="color:var(--red);">${escapeHtml(error.message)}</div>`;
    results.classList.remove('hidden');
  }
}

function agentTable(rows, tableKey) {
  const visible = state.showAll[tableKey] ? rows : rows.slice(0, 25);
  return `
    <table class="w-full text-xs">
      <thead><tr style="background:var(--bg);">
        <th class="text-left px-3 py-2">Login</th>
        <th class="text-left px-3 py-2">Agent ID</th>
        <th class="text-right px-3 py-2">Level</th>
        <th class="text-right px-3 py-2">Commission</th>
        <th class="text-right px-3 py-2">Risk</th>
        <th class="text-left px-3 py-2">Tier</th>
      </tr></thead>
      <tbody>${visible.length ? visible.map((agent) => `
        <tr style="border-top:1px solid var(--border);">
          <td class="px-3 py-2 font-semibold">${escapeHtml(agent.login || '--')}</td>
          <td class="px-3 py-2">${escapeHtml(agent.agent_id || '')}</td>
          <td class="px-3 py-2 text-right">${fmt(agent.level)}</td>
          <td class="px-3 py-2 text-right">${Number(agent.commission_rate || 0).toFixed(2)}</td>
          <td class="px-3 py-2 text-right">${Number(agent.risk_score || 0).toFixed(2)}</td>
          <td class="px-3 py-2">${escapeHtml(agent.commission_tier || '')}</td>
        </tr>
      `).join('') : `<tr><td colspan="6" class="px-3 py-6 text-center" style="color:var(--text-dim);">No agents found.</td></tr>`}</tbody>
    </table>
    ${rows.length > 25 ? `<button type="button" class="m-3 text-xs px-2 py-1 rounded"
      style="background:var(--bg);border:1px solid var(--border);color:var(--text);"
      onclick="toggleHierarchyTableLimit('${tableKey}')">${state.showAll[tableKey] ? 'Show 25' : `Show all (${fmt(rows.length)})`}</button>` : ''}
  `;
}

async function loadPanel(name, force = false) {
  if (state.panelData[name] && !force) return state.panelData[name];
  const threshold = Number(el('hierarchyRiskThreshold')?.value || 0.5);
  const endpoints = {
    risk: `/api/hierarchy/risk?threshold=${encodeURIComponent(threshold)}`,
    tests: '/api/hierarchy/tests',
    zero: '/api/hierarchy/zero-commission',
  };
  const data = await fetchJson(endpoints[name]);
  state.panelData[name] = Array.isArray(data.agents) ? data.agents : [];
  return state.panelData[name];
}

async function renderPanel(name, force = false) {
  const panelId = name === 'zero' ? 'hierarchyPanelZero' : name === 'tests' ? 'hierarchyPanelTests' : 'hierarchyPanelRisk';
  const panel = el(panelId);
  if (!panel) return;
  panel.innerHTML = `<div class="px-3 py-6 text-center text-xs" style="color:var(--text-dim);">Loading...</div>`;
  try {
    const rows = await loadPanel(name, force);
    panel.innerHTML = agentTable(rows, name);
  } catch (error) {
    panel.innerHTML = `<div class="px-3 py-4 text-xs" style="color:var(--red);">${escapeHtml(error.message)}</div>`;
  }
}

async function refreshImport() {
  if (state.importing) return;
  state.importing = true;
  setError('');
  const btn = el('hierarchyRefreshBtn');
  if (btn) {
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Refreshing...';
  }
  setSyncBadge('running', 'Running');
  try {
    const result = await fetchPost('/api/hierarchy/import', {});
    toast(`Hierarchy import complete: ${fmt(result.total_imported)} agents`, 'success');
    state.panelData = { risk: null, tests: null, zero: null };
    await Promise.all([loadStats(), loadHubs(), loadSyncStatus()]);
  } catch (error) {
    setError(error.message);
    setSyncBadge('failed', 'Failed');
    toast(`Hierarchy import failed: ${error.message}`, 'error');
  } finally {
    state.importing = false;
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = 'Refresh from Buckeye';
    }
  }
}

async function openHub(id) {
  state.activeHubId = id;
  const modal = el('hierarchyHubModal');
  const content = el('hierarchyHubModalContent');
  if (!modal || !content) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  content.innerHTML = `<div class="px-3 py-6 text-center text-xs" style="color:var(--text-dim);">Loading hub...</div>`;
  await reloadHub();
}

async function reloadHub() {
  const content = el('hierarchyHubModalContent');
  if (!content || !state.activeHubId) return;
  const maxLevel = Number(el('hierarchyHubMaxLevel')?.value || 3);
  try {
    const data = await fetchJson(`/api/hierarchy/hub?id=${encodeURIComponent(state.activeHubId)}&maxLevel=${encodeURIComponent(maxLevel)}`);
    const hub = data.hub || {};
    setText('hierarchyHubModalTitle', hub.hub_name || state.activeHubId);
    content.innerHTML = agentTable(Array.isArray(hub.agents) ? hub.agents : [], 'hub');
  } catch (error) {
    content.innerHTML = `<div class="px-3 py-4 text-xs" style="color:var(--red);">${escapeHtml(error.message)}</div>`;
  }
}

function closeHub() {
  const modal = el('hierarchyHubModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

export async function initHierarchyDashboard(force = false) {
  if (state.initialized && !force) return;
  state.initialized = true;
  setError('');
  try {
    await Promise.all([loadStats(), loadHubs(), loadSyncStatus()]);
  } catch (error) {
    setError(error.message);
  }
}

function handleSyncMessage(msg) {
  if (!msg || (msg.channel && msg.channel !== 'agent-updates')) return;
  if (msg.type === 'sync_error' || msg.status === 'failed') {
    setSyncBadge('failed', 'Failed');
    setError(msg.error || 'Hierarchy sync failed.');
  } else if (msg.status === 'running') {
    setSyncBadge('running', 'Running');
  } else if (msg.status === 'completed') {
    setSyncBadge('completed', 'Complete');
    setError('');
    void Promise.all([loadStats(), loadHubs(), loadSyncStatus()]);
  }
}

window.initHierarchyDashboard = initHierarchyDashboard;
window.hierarchySearchChanged = function hierarchySearchChanged() {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(searchAgents, 300);
};
window.sortHierarchyTable = function sortHierarchyTable(table, key) {
  if (table !== 'hubs') return;
  state.sort = {
    key,
    dir: state.sort.key === key && state.sort.dir === 'desc' ? 'asc' : 'desc',
  };
  renderHubs();
};
window.toggleHierarchyTableLimit = function toggleHierarchyTableLimit(table) {
  state.showAll[table] = !state.showAll[table];
  if (table === 'hubs') renderHubs();
  else if (table === 'hub') void reloadHub();
  else if (table !== 'hub') void renderPanel(table);
};
window.toggleHierarchyPanel = async function toggleHierarchyPanel(name) {
  state.panels[name] = !state.panels[name];
  const panelId = name === 'zero' ? 'hierarchyPanelZero' : name === 'tests' ? 'hierarchyPanelTests' : 'hierarchyPanelRisk';
  const panel = el(panelId);
  if (!panel) return;
  panel.classList.toggle('hidden', !state.panels[name]);
  if (state.panels[name]) await renderPanel(name);
};
window.hierarchyRiskThresholdChanged = function hierarchyRiskThresholdChanged(event) {
  const value = Number(event.target.value || 0.5);
  setText('hierarchyRiskThresholdValue', value.toFixed(2));
  state.panelData.risk = null;
  if (state.panels.risk) void renderPanel('risk', true);
};
window.refreshHierarchyImport = refreshImport;
window.openHierarchyHub = openHub;
window.reloadHierarchyHubModal = reloadHub;
window.closeHierarchyHubModal = closeHub;
window.handleHierarchySyncMessage = handleSyncMessage;

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeHub();
});
