/**
 * Positions & Exposure Module
 * Extracted from app.js — handles position stats, sport/agent exposure rendering.
 */

import { get, set } from './state.js';

function updatePositionStats(wagers = [], sportRows = [], agentRows = {}) {
  const elTotal = document.getElementById('posTotalWagers');
  const elExposure = document.getElementById('posTotalExposure');
  const elAgents = document.getElementById('posActiveAgents');
  const elAvg = document.getElementById('posAvgWager');
  const elTopSport = document.getElementById('posTopSport');
  if (elTotal) elTotal.textContent = String(wagers.length || 0);
  if (elExposure) elExposure.textContent = '$0';
  if (elAgents) elAgents.textContent = String(Array.isArray(agentRows) ? agentRows.length : Object.keys(agentRows || {}).length);
  if (elAvg) elAvg.textContent = '$0';
  if (elTopSport) elTopSport.textContent = sportRows[0]?.sport || '—';
}

function renderSportExposure() {
  const container = document.getElementById('sportExposureBreakdown');
  if (!container) return;

  let data = get('sportExposureData') || [];
  if (data.length === 0) {
    // Fallback: compute locally if empty
    data = computeSportExposureLocal();
    set('sportExposureData', data);
  }
  if (data.length === 0) {
    container.innerHTML = '<div class="text-xs text-center py-4" style="color:var(--text-dim);">No exposure data</div>';
    return;
  }

  const maxTotal = data[0].total || 1;
  const sortKey = get('sportExposureSort').col;
  const sortDir = get('sportExposureSort').dir;

  const sorted = [...data].sort((a, b) => {
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
                <div class="exposure-bar-label">$${(row.total / 1000).toFixed(1)}K</div>
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
  const current = get('sportExposureSort');
  if (current.col === col) {
    set('sportExposureSort', { ...current, dir: current.dir === 'asc' ? 'desc' : 'asc' });
  } else {
    set('sportExposureSort', { col, dir: 'desc' });
  }
  renderSportExposure();
}

function renderAgentExposure() {
  const container = document.getElementById('agentExposureBreakdown');
  if (!container) return;

  let data = get('agentExposureData') || [];
  if (data.length === 0) {
    // Fallback: compute locally if empty
    data = computeAgentExposureLocal();
    set('agentExposureData', data);
  }
  if (data.length === 0) {
    container.innerHTML = '<div class="text-xs text-center py-4" style="color:var(--text-dim);">No exposure data</div>';
    return;
  }

  const maxTotal = data[0].total || 1;
  const sortKey = get('agentExposureSort').col;
  const sortDir = get('agentExposureSort').dir;

  const sorted = [...data].sort((a, b) => {
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
                <div class="exposure-bar-label">$${(row.total / 1000).toFixed(1)}K</div>
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
  const current = get('agentExposureSort');
  if (current.col === col) {
    set('agentExposureSort', { ...current, dir: current.dir === 'asc' ? 'desc' : 'asc' });
  } else {
    set('agentExposureSort', { col, dir: 'desc' });
  }
  renderAgentExposure();
}

function renderExposureBars() {
  // Placeholder — bars are rendered inline in renderSportExposure / renderAgentExposure
}

function renderExposureTable() {
  // Placeholder — tables are rendered inline
}

function renderExposureBreakdown() {
  renderSportExposure();
  renderAgentExposure();
}

// Local computation fallbacks (simplified — these reference app-level helpers that will remain in app.js)
function computeSportExposureLocal() {
  // This is a stub — the real implementation stays in app.js for now
  // because it depends on buckeyeWagers and parseSport/parseGame/getHeldRisk
  return get('sportExposureData') || [];
}

function computeAgentExposureLocal() {
  // This is a stub — the real implementation stays in app.js for now
  return get('agentExposureData') || [];
}

// Window exports
window.updatePositionStats = updatePositionStats;
window.renderSportExposure = renderSportExposure;
window.renderAgentExposure = renderAgentExposure;
window.sortSportExposure = sortSportExposure;
window.sortAgentExposure = sortAgentExposure;
