/**
 * Agent Network Module
 * Extracted from app.js lines ~6141-7143.
 * Handles agent hierarchy tree, downline rendering, pattern counts,
 * zone2 performance/billing, and agent search.
 */

import { fetchJson, getApiBaseUrl } from '../api.js';
import { escapeHtml, formatCompactDollars, money, setText } from '../utils.js';
import { get, set } from './state.js';

// ==================== STATE INITIALIZATION ====================
if (!get('agentTreeData')) set('agentTreeData', []);
if (!get('agentTreeFlat')) set('agentTreeFlat', []);
if (!get('agentStatsMap')) set('agentStatsMap', {});
if (!get('agentPatternCounts')) set('agentPatternCounts', {});
if (!get('agentPatternSortEnabled')) set('agentPatternSortEnabled', false);
if (!get('agentDownlineRequestId')) set('agentDownlineRequestId', 0);
if (!get('agentTreeStatusMessage')) set('agentTreeStatusMessage', 'No agent hierarchy loaded yet. Refresh after connecting or use Downline data.');
if (!get('zone2PerformanceState')) {
  set('zone2PerformanceState', {
    selectedAgent: '',
    view: 'weekly',
    start: '',
    end: '',
    rows: [],
    totals: { bets: 0, wager: 0, win: 0, loss: 0, net: 0, commission: 0 },
    source: '',
    loading: false,
  });
}
if (!get('zone2PanelTab')) set('zone2PanelTab', 'performance');
if (!get('zone2BillingState')) {
  set('zone2BillingState', {
    week: '0',
    figures: [],
    totals: { gross: 0, net: 0, wagers: 0, wins: 0, losses: 0, pending: 0, playersActive: 0 },
    period: '',
    source: '',
    loading: false,
  });
}

// ==================== AGENT TREE LOADING ====================
export function setAgentTreeLoading(isLoading, message = 'Loading agent hierarchy...') {
  set('agentTreeStatusMessage', message);
  if (isLoading) {
    const tbody = document.getElementById('agentDownlineTable');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="10" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">${message}</td></tr>`;
    }
  }
  if (typeof currentSection !== 'undefined' && currentSection === 'agentTree') {
    if (typeof computeTreeLayout === 'function') computeTreeLayout(get('agentTreeData') || []);
    if (typeof treeLayoutNodes !== 'undefined' && treeLayoutNodes.length > 0 && typeof fitTreeToCanvas === 'function') fitTreeToCanvas();
  }
}

export async function refreshAgentDownline(force = false) {
  const agentTreeData = get('agentTreeData') || [];
  if (!force && typeof isCacheFresh === 'function' && isCacheFresh('downline') && agentTreeData.length > 0) {
    await loadAgentPatternCounts();
    renderAgentTree(agentTreeData);
    const agentTreeFlat = get('agentTreeFlat') || [];
    updateAgentSummary(agentTreeFlat);
    if (typeof currentSection !== 'undefined' && currentSection === 'agentTree' && typeof initAgentCanvas === 'function') initAgentCanvas();
    return;
  }

  let agentDownlineRequestId = get('agentDownlineRequestId') || 0;
  const requestId = ++agentDownlineRequestId;
  set('agentDownlineRequestId', requestId);
  if (agentTreeData.length === 0 || force) {
    setAgentTreeLoading(true);
  }

  try {
    const hierarchyData = await fetchJson('/api/v1/agents/hierarchy');
    const cachedTree = Array.isArray(hierarchyData?.tree) ? normalizeCachedAgentTree(hierarchyData.tree) : [];
    const general = Array.isArray(hierarchyData) ? hierarchyData : (hierarchyData.GENERAL || []);

    const statsData = await fetchJson('/api/agents/downline');
    await loadAgentPatternCounts();
    if (requestId !== get('agentDownlineRequestId')) return;

    const agentStatsMap = {};
    (Array.isArray(statsData) ? statsData : []).forEach(s => { agentStatsMap[s.agent_login] = s; });
    set('agentStatsMap', agentStatsMap);

    if (cachedTree.length > 0 || general.length > 0) {
      const newTree = cachedTree.length ? cachedTree : buildAgentTree(general);
      const newFlat = flattenAgentTree(newTree);
      set('agentTreeData', newTree);
      set('agentTreeFlat', newFlat);
      mergeAgentStats(newTree);
      computeDownlineStats(newTree);
      renderAgentTree(newTree);
      updateAgentSummary(newFlat);
      if (typeof currentSection !== 'undefined' && currentSection === 'agentTree' && typeof initAgentCanvas === 'function') initAgentCanvas();
      if (typeof markCacheFresh === 'function') markCacheFresh('downline');
    } else {
      const fallbackCount = deriveAgentDownlineFromStatic();
      if (typeof currentSection !== 'undefined' && currentSection === 'agentTree' && typeof initAgentCanvas === 'function') initAgentCanvas();
      if (fallbackCount > 0 && typeof markCacheFresh === 'function') markCacheFresh('downline');
    }
  } catch (err) {
    console.error('Failed to load agent hierarchy:', err?.message || err);
    const fallbackCount = deriveAgentDownlineFromStatic();
    if (typeof currentSection !== 'undefined' && currentSection === 'agentTree' && typeof initAgentCanvas === 'function') initAgentCanvas();
    if (fallbackCount > 0 && typeof markCacheFresh === 'function') {
      markCacheFresh('downline');
    } else {
      setAgentTreeLoading(false, 'No agent hierarchy loaded. Check seeded hierarchy data or connect to Buckeye.');
    }
  }
}

export function normalizeCachedAgentTree(nodes) {
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

export async function loadAgentPatternCounts() {
  try {
    const rows = await fetchJson('/api/patterns/agents?sinceHours=24');
    const agentPatternCounts = {};
    (Array.isArray(rows) ? rows : []).forEach(row => {
      if (row.agent) agentPatternCounts[row.agent] = row;
    });
    set('agentPatternCounts', agentPatternCounts);
  } catch (err) {
    console.warn('[Agent Network] Pattern counts unavailable:', err.message);
  }
}

export function buildAgentTree(flatList) {
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
      expanded: level <= 2,
      playerCount: Number(agent.PlayerCount) || (agent.PLAYERS ? agent.PLAYERS.length : 0),
    };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].node;
    parent.children.push(newNode);
    stack.push({ level, node: newNode });
  });
  return root.children;
}

export function flattenAgentTree(nodes, depth = 0) {
  let flat = [];
  const agentPatternSortEnabled = get('agentPatternSortEnabled') || false;
  const agentPatternCounts = get('agentPatternCounts') || {};
  const renderNodes = agentPatternSortEnabled
    ? [...nodes].sort((a, b) => (Number(agentPatternCounts[b.agent]?.pattern_count || 0) - Number(agentPatternCounts[a.agent]?.pattern_count || 0)))
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

export function mergeAgentStats(nodes) {
  const agentStatsMap = get('agentStatsMap') || {};
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

export function computeDownlineStats(nodes) {
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

export function mergeAgentDelta(delta) {
  if (!delta) return;
  const agentId = delta.agent || delta.agentId;
  if (!agentId) return;

  let agentTreeData = get('agentTreeData') || [];
  let agentTreeFlat = get('agentTreeFlat') || [];

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
    set('agentTreeData', agentTreeData);
    set('agentTreeFlat', agentTreeFlat);
  }

  applyAgentDelta(agent, delta);
  computeDownlineStats(agentTreeData);
  updateAgentSummary(agentTreeFlat);
  updateAgentRow(agent);

  if (typeof currentSection !== 'undefined' && currentSection === 'agentTree' && typeof treeCanvas !== 'undefined' && treeCanvas) {
    if (typeof computeTreeLayout === 'function') computeTreeLayout(agentTreeData);
    if (typeof drawTree === 'function') drawTree();
  }
}

export function applyAgentDelta(agent, delta) {
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

export function updateAgentRow(agent) {
  const row = document.querySelector(`tr.agent-row[data-agent="${cssEscape(agent.agent)}"]`);
  if (!row) {
    if (typeof currentSection !== 'undefined' && (currentSection === 'agentNetwork' || currentSection === 'agentTree')) {
      renderAgentTree(get('agentTreeData') || []);
    }
    return;
  }

  const agentTreeFlat = get('agentTreeFlat') || [];
  const totalVolume = agentTreeFlat.reduce((s, a) => s + (a.total_volume || 0), 0);
  const displayVolume = agent.downline_volume || agent.total_volume || 0;
  const displayRisk = agent.downline_risk || agent.total_risk || 0;
  const displayPlayers = agent.downline_players || agent.player_count || 0;
  const displayWagers = agent.downline_wagers || agent.wager_count || 0;
  const bookPct = typeof getExposurePct === 'function' ? getExposurePct(displayRisk, totalVolume) : '0';
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
    const agentPatternCounts = get('agentPatternCounts') || {};
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

export function updateAgentSummary(flatAgents) {
  const totalAgents = flatAgents.length;
  const totalPlayers = flatAgents.reduce((s, a) => s + (a.player_count || 0), 0);
  const totalVolume = flatAgents.reduce((s, a) => s + (a.total_volume || 0), 0);
  const totalRisk = flatAgents.reduce((s, a) => s + (a.total_risk || 0), 0);
  const elCount = document.getElementById('downlineAgentCount');
  const elPlayers = document.getElementById('downlinePlayerCount');
  const elVolume = document.getElementById('downlineVolume');
  const elRisk = document.getElementById('downlineRisk');
  if (elCount) elCount.textContent = totalAgents;
  if (elPlayers) elPlayers.textContent = totalPlayers;
  if (elVolume) elVolume.textContent = '$' + (totalVolume / 1000000).toFixed(2) + 'M';
  if (elRisk) elRisk.textContent = '$' + (totalRisk / 1000000).toFixed(2) + 'M';
}

export function renderAgentTree(nodes, parentElement, depth = 0, budget) {
  const tbody = parentElement || document.getElementById('agentDownlineTable');
  if (!tbody) return;
  if (depth === 0) {
    tbody.innerHTML = '';
    budget = { count: 0, truncated: false };
  }

  const agentTreeFlat = get('agentTreeFlat') || [];
  const totalVolume = agentTreeFlat.reduce((s, a) => s + (a.total_volume || 0), 0);
  const agentPatternCounts = get('agentPatternCounts') || {};

  nodes.forEach(node => {
    if (budget.count >= (typeof TABLE_RENDER_LIMIT !== 'undefined' ? TABLE_RENDER_LIMIT : 150)) {
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
    const bookPct = typeof getExposurePct === 'function' ? getExposurePct(displayRisk, totalVolume) : '0';

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
        <div class="flex items-center justify-center gap-1">
          <button type="button" class="px-2 py-1 rounded text-xs" style="background:var(--accent);color:#fff;" data-action="load-agent-performance" data-agent="${agentAttr}">Perf</button>
          <button type="button" class="px-2 py-1 rounded text-xs" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" data-action="filter-agent" data-agent="${agentAttr}">Wagers</button>
        </div>
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
    row.innerHTML = `<td colspan="11" class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">Showing ${(typeof TABLE_RENDER_LIMIT !== 'undefined' ? TABLE_RENDER_LIMIT : 150).toLocaleString()} agents. Search to narrow the downline.</td>`;
    tbody.appendChild(row);
  }
}

export function getAgentPatternCount(agent) {
  const agentPatternCounts = get('agentPatternCounts') || {};
  return Number(agentPatternCounts[agent]?.pattern_count || 0);
}

export function patternIconForAgent(info) {
  return Number(info.critical_count || 0) > 0 ? '!' : '*';
}

export function toggleAgentPatternSort() {
  const current = get('agentPatternSortEnabled') || false;
  set('agentPatternSortEnabled', !current);
  const icon = document.getElementById('agentPatternSortIcon');
  if (icon) icon.textContent = !current ? '↓' : '';
  renderAgentTree(get('agentTreeData') || []);
}

export function pulseAgentPatternRow(agent) {
  const row = document.querySelector(`tr.agent-row[data-agent="${cssEscape(agent)}"]`);
  if (!row) return;
  row.classList.add('agent-pattern-pulse');
  setTimeout(() => row.classList.remove('agent-pattern-pulse'), 3000);
}

export function pulseAgentPatternBadge(agent) {
  const row = document.querySelector(`tr.agent-row[data-agent="${cssEscape(agent)}"]`);
  if (!row) return;
  const badge = row.querySelector('[data-agent-field="patterns"] .agent-pattern-badge');
  if (badge) {
    badge.classList.add('pattern-badge-pulse');
    setTimeout(() => badge.classList.remove('pattern-badge-pulse'), 2000);
  }
  row.classList.add('agent-pattern-pulse');
  setTimeout(() => row.classList.remove('agent-pattern-pulse'), 3000);
}

export function toggleAgentExpand(agentLogin, event) {
  if (event) event.stopPropagation();
  const agentTreeFlat = get('agentTreeFlat') || [];
  const node = agentTreeFlat.find(a => a.agent === agentLogin);
  if (node && node.children && node.children.length) {
    node.expanded = !node.expanded;
    renderAgentTree(get('agentTreeData') || []);
  }
}

export function handleAgentDownlineClick(event) {
  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget || !event.currentTarget.contains(actionTarget)) return;
  event.preventDefault();
  event.stopPropagation();

  if (actionTarget.dataset.action === 'toggle-agent') {
    toggleAgentExpand(actionTarget.dataset.agent);
  } else if (actionTarget.dataset.action === 'load-agent-performance') {
    selectZone2AgentPerformance(actionTarget.dataset.agent);
  } else if (actionTarget.dataset.action === 'filter-agent') {
    if (typeof filterTickerByAgent === 'function') filterTickerByAgent(actionTarget.dataset.agent);
  } else if (actionTarget.dataset.action === 'filter-agent-patterns') {
    openPatternsForAgent(actionTarget.dataset.agent);
  }
}

export function openPatternsForAgent(agent) {
  if (typeof switchSection === 'function') switchSection('patterns', typeof getSidebarButton === 'function' ? getSidebarButton('patterns') : null);
  const agentSelect = document.getElementById('patternAgentFilter');
  if (agentSelect) {
    if (![...agentSelect.options].some(opt => opt.value === agent)) {
      agentSelect.add(new Option(agent, agent));
    }
    agentSelect.value = agent;
  }
  if (typeof setPatternCategory === 'function') setPatternCategory('all');
  if (typeof sectionCache !== 'undefined' && sectionCache?.patterns) sectionCache.patterns.at = 0;
  if (typeof loadPatterns === 'function') loadPatterns(true);
}

// ==================== ZONE2 PANEL TABS ====================
export function setZone2PanelTab(tab) {
  const zone2PanelTab = tab === 'billing' ? 'billing' : 'performance';
  set('zone2PanelTab', zone2PanelTab);
  const isBilling = zone2PanelTab === 'billing';
  const performanceContent = document.getElementById('zone2PerformanceContent');
  const billingContent = document.getElementById('zone2BillingContent');
  const performanceControls = document.getElementById('zone2PerformanceControls');
  const billingControls = document.getElementById('zone2BillingControls');
  const performanceTab = document.getElementById('zone2PerformanceTab');
  const billingTab = document.getElementById('zone2BillingTab');

  performanceContent?.classList.toggle('hidden', isBilling);
  billingContent?.classList.toggle('hidden', !isBilling);
  performanceControls?.classList.toggle('hidden', isBilling);
  billingControls?.classList.toggle('hidden', !isBilling);
  billingControls?.classList.toggle('flex', isBilling);

  if (performanceTab) {
    performanceTab.style.background = isBilling ? 'var(--bg)' : 'var(--accent)';
    performanceTab.style.border = isBilling ? '1px solid var(--border)' : 'none';
    performanceTab.style.color = isBilling ? 'var(--text-dim)' : '#fff';
  }
  if (billingTab) {
    billingTab.style.background = isBilling ? 'var(--accent)' : 'var(--bg)';
    billingTab.style.border = isBilling ? 'none' : '1px solid var(--border)';
    billingTab.style.color = isBilling ? '#fff' : 'var(--text-dim)';
  }

  if (isBilling) {
    const weekEl = document.getElementById('zone2BillingWeek');
    const zone2BillingState = get('zone2BillingState');
    if (weekEl) weekEl.value = zone2BillingState.week || '0';
    renderZone2Billing();
    if (!zone2BillingState.loading && zone2BillingState.figures.length === 0) loadZone2Billing(false);
  } else {
    renderZone2Performance();
  }
}

export function initializeZone2PerformanceDates() {
  const zone2PerformanceState = get('zone2PerformanceState');
  const end = new Date();
  const start = new Date(Date.now() - 27 * 86400000);
  if (!zone2PerformanceState.end) zone2PerformanceState.end = end.toISOString().split('T')[0];
  if (!zone2PerformanceState.start) zone2PerformanceState.start = start.toISOString().split('T')[0];
  set('zone2PerformanceState', zone2PerformanceState);
  const startEl = document.getElementById('zone2StartDate');
  const endEl = document.getElementById('zone2EndDate');
  const viewEl = document.getElementById('zone2PerformanceView');
  if (startEl && !startEl.value) startEl.value = zone2PerformanceState.start;
  if (endEl && !endEl.value) endEl.value = zone2PerformanceState.end;
  if (viewEl) viewEl.value = zone2PerformanceState.view || 'weekly';
}

export function selectZone2AgentPerformance(agent) {
  if (!agent) return;
  const zone2PerformanceState = get('zone2PerformanceState');
  zone2PerformanceState.selectedAgent = agent;
  set('zone2PerformanceState', zone2PerformanceState);
  initializeZone2PerformanceDates();
  setText('zone2PerformanceStatus', `Loading ${agent} performance...`);
  loadZone2AgentPerformance(true);
}

export function getZone2InputState() {
  initializeZone2PerformanceDates();
  const zone2PerformanceState = get('zone2PerformanceState');
  const view = document.getElementById('zone2PerformanceView')?.value || zone2PerformanceState.view || 'weekly';
  const start = document.getElementById('zone2StartDate')?.value || zone2PerformanceState.start;
  const end = document.getElementById('zone2EndDate')?.value || zone2PerformanceState.end;
  zone2PerformanceState.view = view;
  zone2PerformanceState.start = start;
  zone2PerformanceState.end = end;
  set('zone2PerformanceState', zone2PerformanceState);
  return { view, start, end };
}

export function getZone2ProxyCredentials() {
  return {
    token: localStorage.getItem('buckeye_token') || localStorage.getItem('buckeyeToken') || '',
    cf: localStorage.getItem('cf_clearance') || '',
    cfBm: localStorage.getItem('__cf_bm') || '',
    baseUrl: localStorage.getItem('proxyBaseUrl') || 'http://localhost:3001',
  };
}

// ==================== ZONE2 PERFORMANCE ====================
export async function loadZone2AgentPerformance(force = false) {
  const zone2PerformanceState = get('zone2PerformanceState');
  const agent = zone2PerformanceState.selectedAgent;
  const { view, start, end } = getZone2InputState();
  if (!agent) {
    showToast('Select an agent from the downline first.', 'info');
    renderZone2Performance();
    return;
  }
  if (zone2PerformanceState.loading && !force) return;

  zone2PerformanceState.loading = true;
  set('zone2PerformanceState', zone2PerformanceState);
  renderZone2Performance();
  try {
    const report = await fetchZone2AgentPerformance(agent, start, end, view);
    zone2PerformanceState.rows = report.data || [];
    zone2PerformanceState.totals = report.totals || zone2TotalsFromRows(report.data || []);
    zone2PerformanceState.source = report.source || 'performance';
    set('zone2PerformanceState', zone2PerformanceState);
    setText('zone2PerformanceStatus', `${agent} ${view} report loaded from ${zone2PerformanceState.source}.`);
  } catch (err) {
    zone2PerformanceState.rows = [];
    zone2PerformanceState.totals = zone2TotalsFromRows([]);
    zone2PerformanceState.source = '';
    set('zone2PerformanceState', zone2PerformanceState);
    setText('zone2PerformanceStatus', err instanceof Error ? err.message : 'Unable to load performance.');
  } finally {
    zone2PerformanceState.loading = false;
    set('zone2PerformanceState', zone2PerformanceState);
    renderZone2Performance();
  }
}

export async function fetchZone2AgentPerformance(agent, start, end, view) {
  const proxy = getZone2ProxyCredentials();
  if (proxy.token && proxy.cf) {
    try {
      const res = await fetch(`${proxy.baseUrl}/api/proxy/agent/performance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: proxy.token,
          cf_clearance: proxy.cf,
          __cf_bm: proxy.cfBm,
          agentID: agent,
          startDate: start,
          endDate: end,
          view,
        }),
      });
      if (!res.ok) throw new Error(`proxy ${res.status}`);
      const payload = await res.json();
      return { ...normalizeZone2Report(payload, view, start, end), source: 'proxy-enhanced' };
    } catch (err) {
      console.warn('[Zone2] Proxy performance unavailable, falling back to backend:', err?.message || err);
    }
  }

  try {
    const masterAgent = localStorage.getItem('agentId') || agent;
    const url = new URL(`${getApiBaseUrl()}/api/buckeye/agent-performance`);
    url.searchParams.set('agentId', masterAgent);
    url.searchParams.set('reportAgentId', agent);
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('type', 'CP');
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`backend live ${res.status}`);
    const payload = await res.json();
    const normalized = normalizeZone2Report(payload, view, start, end);
    if ((normalized.data || []).length > 0) return { ...normalized, source: 'backend Buckeye session' };
  } catch (err) {
    console.warn('[Zone2] Backend live performance unavailable, using archive:', err?.message || err);
  }

  const archiveRes = await fetch(`${getApiBaseUrl()}/api/performance/details?agent=${encodeURIComponent(agent)}&weeks=12`);
  if (!archiveRes.ok) throw new Error(`Archived performance request failed: ${archiveRes.status}`);
  const archivePayload = await archiveRes.json();
  return { ...normalizeZone2ArchiveReport(archivePayload, view, start, end), source: 'local archive' };
}

export function normalizeZone2Report(payload, view, start, end) {
  if (Array.isArray(payload?.data)) {
    return {
      period: payload.period || view,
      data: payload.data.map(zone2NormalizeRow),
      totals: zone2NormalizeTotals(payload.totals),
    };
  }
  const totals = payload?.parsed?.totals || payload?.totals || {};
  const row = {
    date: `${start} - ${end}`,
    bets: Number(totals.wagerCount || totals.bets || 0),
    wager: Number(totals.volume || totals.wager || totals.risk || 0),
    win: Number(totals.amountWon || totals.win || 0),
    loss: Number(totals.amountLost || totals.loss || 0),
    net: Number(totals.net || 0),
    commission: Number(totals.commission || 0),
  };
  return { period: view, data: row.bets || row.wager || row.net ? [row] : [], totals: zone2TotalsFromRows([row]) };
}

export function normalizeZone2ArchiveReport(payload, view, start, end) {
  const trend = Array.isArray(payload?.weeklyTrend) ? payload.weeklyTrend : [];
  const rows = trend.map(row => ({
    date: row.week_start_date || row.week || `${start} - ${end}`,
    bets: Number(row.row_count || row.wager_count || 0),
    wager: Number(row.handle || row.volume || 0),
    win: Number(row.amount_won || 0),
    loss: Number(row.amount_lost || 0),
    net: Number(row.win_loss || row.net || 0),
    commission: Number(row.commission || 0),
  }));
  return { period: view, data: rows, totals: zone2TotalsFromRows(rows) };
}

export function zone2NormalizeRow(row) {
  return {
    date: row.date || row.startDate || '-',
    bets: Number(row.bets || row.wagerCount || 0),
    wager: Number(row.wager || row.volume || row.risk || 0),
    win: Number(row.win || row.amountWon || 0),
    loss: Number(row.loss || row.amountLost || 0),
    net: Number(row.net || row.netProfit || 0),
    commission: Number(row.commission || 0),
  };
}

export function zone2NormalizeTotals(totals) {
  if (!totals) return zone2TotalsFromRows([]);
  return {
    bets: Number(totals.bets || totals.wagerCount || 0),
    wager: Number(totals.wager || totals.volume || totals.risk || 0),
    win: Number(totals.win || totals.amountWon || 0),
    loss: Number(totals.loss || totals.amountLost || 0),
    net: Number(totals.net || totals.netProfit || 0),
    commission: Number(totals.commission || 0),
  };
}

export function zone2TotalsFromRows(rows) {
  return (rows || []).reduce((acc, row) => {
    acc.bets += Number(row.bets || 0);
    acc.wager += Number(row.wager || 0);
    acc.win += Number(row.win || 0);
    acc.loss += Number(row.loss || 0);
    acc.net += Number(row.net || 0);
    acc.commission += Number(row.commission || 0);
    return acc;
  }, { bets: 0, wager: 0, win: 0, loss: 0, net: 0, commission: 0 });
}

// ==================== ZONE2 BILLING ====================
export function getZone2BillingAgent() {
  return localStorage.getItem('agentId')
    || localStorage.getItem('customerID')
    || localStorage.getItem('buckeye_customer_id')
    || get('zone2PerformanceState')?.selectedAgent
    || get('agentTreeFlat')?.[0]?.agent
    || '';
}

export async function loadZone2Billing(force = false) {
  const zone2BillingState = get('zone2BillingState');
  const weekEl = document.getElementById('zone2BillingWeek');
  const week = weekEl?.value || zone2BillingState.week || '0';
  zone2BillingState.week = week;
  set('zone2BillingState', zone2BillingState);
  if (zone2BillingState.loading && !force) return;

  const agentID = getZone2BillingAgent();
  if (!agentID) {
    setText('zone2PerformanceStatus', 'Connect or select a master agent before loading billing.');
    renderZone2Billing();
    return;
  }

  const proxy = getZone2ProxyCredentials();
  if (!proxy.token || !proxy.cf) {
    setText('zone2PerformanceStatus', 'Buckeye token and cf_clearance are required for live billing.');
    renderZone2Billing();
    return;
  }

  zone2BillingState.loading = true;
  set('zone2BillingState', zone2BillingState);
  renderZone2Billing();
  try {
    const res = await fetch(`${proxy.baseUrl}/api/proxy/agentBilling`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: proxy.token,
        cf_clearance: proxy.cf,
        __cf_bm: proxy.cfBm,
        agentID,
        week,
      }),
    });
    if (!res.ok) throw new Error(`Billing proxy failed: ${res.status}`);
    const payload = await res.json();
    const report = normalizeZone2Billing(payload);
    zone2BillingState.figures = report.figures;
    zone2BillingState.totals = report.totals;
    zone2BillingState.period = report.period;
    zone2BillingState.source = payload.endpoint || 'getAgentBilling';
    set('zone2BillingState', zone2BillingState);
    setText('zone2PerformanceStatus', `${agentID} billing loaded from ${zone2BillingState.source}.`);
  } catch (err) {
    zone2BillingState.figures = [];
    zone2BillingState.totals = zone2BillingTotals([]);
    zone2BillingState.period = '';
    zone2BillingState.source = '';
    set('zone2BillingState', zone2BillingState);
    setText('zone2PerformanceStatus', err instanceof Error ? err.message : 'Unable to load billing.');
  } finally {
    zone2BillingState.loading = false;
    set('zone2BillingState', zone2BillingState);
    renderZone2Billing();
  }
}

export function normalizeZone2Billing(payload) {
  const data = payload?.data || payload || {};
  const rawFigures = Array.isArray(data.figures) ? data.figures
    : Array.isArray(data.agents) ? data.agents
      : Array.isArray(data.LIST) ? data.LIST
        : Array.isArray(data.data) ? data.data
          : [];
  const figures = rawFigures.map(zone2NormalizeBillingFigure).filter(fig => fig.agent || fig.name);
  return {
    period: data.period || data.week || '',
    figures,
    totals: zone2BillingTotals(figures),
  };
}

export function zone2NormalizeBillingFigure(row) {
  return {
    agent: row.agent || row.Agent || row.AgentID || '',
    name: row.name || row.Name || row.agentName || row.AgentName || row.agent || row.Agent || '',
    gross: Number(row.gross ?? row.Gross ?? 0),
    net: Number(row.net ?? row.Net ?? 0),
    hold: Number(row.hold ?? row.HoldPercent ?? row.Hold ?? 0),
    commission: Number(row.commission ?? row.Commission ?? 0),
    wagers: Number(row.wagers ?? row.Wagers ?? row.wagerCount ?? 0),
    wins: Number(row.wins ?? row.Wins ?? 0),
    losses: Number(row.losses ?? row.Losses ?? 0),
    pending: Number(row.pending ?? row.Pending ?? 0),
    cancelled: Number(row.cancelled ?? row.Cancelled ?? 0),
    refunded: Number(row.refunded ?? row.Refunded ?? 0),
    totalRisk: Number(row.totalRisk ?? row.TotalRisk ?? 0),
    totalWin: Number(row.totalWin ?? row.TotalWin ?? 0),
    avgBet: Number(row.avgBet ?? row.AverageBet ?? 0),
    openBets: Number(row.openBets ?? row.OpenBets ?? 0),
    playersActive: Number(row.playersActive ?? row.PlayersActive ?? 0),
    newPlayers: Number(row.newPlayers ?? row.NewPlayers ?? 0),
  };
}

export function zone2BillingTotals(figures) {
  return (figures || []).reduce((acc, fig) => {
    acc.gross += Number(fig.gross || 0);
    acc.net += Number(fig.net || 0);
    acc.wagers += Number(fig.wagers || 0);
    acc.wins += Number(fig.wins || 0);
    acc.losses += Number(fig.losses || 0);
    acc.pending += Number(fig.pending || 0);
    acc.playersActive += Number(fig.playersActive || 0);
    return acc;
  }, { gross: 0, net: 0, wagers: 0, wins: 0, losses: 0, pending: 0, playersActive: 0 });
}

export function renderZone2Billing() {
  const tbody = document.getElementById('zone2BillingRows');
  if (!tbody) return;
  const zone2BillingState = get('zone2BillingState');
  const totals = zone2BillingState.totals || zone2BillingTotals([]);
  setText('zone2BillingGross', formatCompactDollars(totals.gross || 0));
  setText('zone2BillingNet', formatCompactDollars(totals.net || 0));
  setText('zone2BillingWagers', Number(totals.wagers || 0).toLocaleString());
  setText('zone2BillingActive', Number(totals.playersActive || 0).toLocaleString());
  const grossEl = document.getElementById('zone2BillingGross');
  const netEl = document.getElementById('zone2BillingNet');
  if (grossEl) grossEl.style.color = Number(totals.gross || 0) >= 0 ? 'var(--green)' : 'var(--red)';
  if (netEl) netEl.style.color = Number(totals.net || 0) >= 0 ? 'var(--green)' : 'var(--red)';

  if (zone2BillingState.loading) {
    tbody.innerHTML = '<tr><td colspan="10" class="px-3 py-6 text-center" style="color:var(--text-dim);">Loading billing figures...</td></tr>';
    return;
  }
  const figures = zone2BillingState.figures || [];
  if (!figures.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="px-3 py-6 text-center" style="color:var(--text-dim);">No billing figures loaded.</td></tr>';
    return;
  }
  tbody.innerHTML = figures.map(fig => {
    const gross = Number(fig.gross || 0);
    const net = Number(fig.net || 0);
    return `<tr class="border-b" style="border-color:var(--border);">
      <td class="px-3 py-2"><div class="font-semibold">${escapeHtml(fig.name || fig.agent || '-')}</div><div class="text-[10px]" style="color:var(--text-dim);">${escapeHtml(fig.agent || '')}</div></td>
      <td class="px-3 py-2 text-right">${Number(fig.wagers || 0).toLocaleString()}</td>
      <td class="px-3 py-2 text-right" style="color:var(--green);">${Number(fig.wins || 0).toLocaleString()}</td>
      <td class="px-3 py-2 text-right" style="color:var(--red);">${Number(fig.losses || 0).toLocaleString()}</td>
      <td class="px-3 py-2 text-right" style="color:var(--yellow);">${Number(fig.pending || 0).toLocaleString()}</td>
      <td class="px-3 py-2 text-right" style="color:${gross >= 0 ? 'var(--green)' : 'var(--red)'};">${money(gross)}</td>
      <td class="px-3 py-2 text-right font-semibold" style="color:${net >= 0 ? 'var(--green)' : 'var(--red)'};">${money(net)}</td>
      <td class="px-3 py-2 text-right">${Number(fig.hold || 0).toFixed(2)}%</td>
      <td class="px-3 py-2 text-right">${money(fig.avgBet || 0)}</td>
      <td class="px-3 py-2 text-right">${Number(fig.playersActive || 0).toLocaleString()}</td>
    </tr>`;
  }).join('');
}

export function renderZone2Performance() {
  const tbody = document.getElementById('zone2PerformanceRows');
  if (!tbody) return;
  initializeZone2PerformanceDates();
  const zone2PerformanceState = get('zone2PerformanceState');
  const totals = zone2PerformanceState.totals || zone2TotalsFromRows([]);
  setText('zone2PerfBets', Number(totals.bets || 0).toLocaleString());
  setText('zone2PerfWager', formatCompactDollars(totals.wager || 0));
  setText('zone2PerfNet', formatCompactDollars(totals.net || 0));
  setText('zone2PerfCommission', formatCompactDollars(totals.commission || 0));
  const netEl = document.getElementById('zone2PerfNet');
  if (netEl) netEl.style.color = Number(totals.net || 0) >= 0 ? 'var(--green)' : 'var(--red)';

  if (zone2PerformanceState.loading) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-3 py-6 text-center" style="color:var(--text-dim);">Loading performance...</td></tr>';
    return;
  }
  const rows = zone2PerformanceState.rows || [];
  if (!zone2PerformanceState.selectedAgent) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-3 py-6 text-center" style="color:var(--text-dim);">Select an agent from the downline.</td></tr>';
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="px-3 py-6 text-center" style="color:var(--text-dim);">No performance rows for the selected range.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(row => {
    const net = Number(row.net || 0);
    return `<tr class="border-b" style="border-color:var(--border);">
      <td class="px-3 py-2 font-mono">${escapeHtml(row.date || '-')}</td>
      <td class="px-3 py-2 text-right">${Number(row.bets || 0).toLocaleString()}</td>
      <td class="px-3 py-2 text-right">${money(row.wager || 0)}</td>
      <td class="px-3 py-2 text-right">${money(row.win || 0)}</td>
      <td class="px-3 py-2 text-right">${money(row.loss || 0)}</td>
      <td class="px-3 py-2 text-right" style="color:${net >= 0 ? 'var(--green)' : 'var(--red)'};">${money(net)}</td>
      <td class="px-3 py-2 text-right">${money(row.commission || 0)}</td>
    </tr>`;
  }).join('');
}

// ==================== AGENT SEARCH ====================
export function searchAgentTree() {
  if (typeof scheduleTask === 'function') scheduleTask('agentSearch', runAgentTreeSearch, 100);
}

export function runAgentTreeSearch() {
  const query = (document.getElementById('agentSearchInput')?.value || '').toLowerCase().trim();
  if (!query) {
    renderAgentTree(get('agentTreeData') || []);
    return;
  }
  const agentTreeFlat = get('agentTreeFlat') || [];
  const filtered = agentTreeFlat.filter(a => a.agent.toLowerCase().includes(query));
  const tbody = document.getElementById('agentDownlineTable');
  if (!tbody) return;
  tbody.innerHTML = '';
  const visible = filtered.slice(0, typeof TABLE_RENDER_LIMIT !== 'undefined' ? TABLE_RENDER_LIMIT : 150);
  const agentPatternCounts = get('agentPatternCounts') || {};
  visible.forEach(node => {
    const agentAttr = escapeHtml(node.agent);
    const agentLabel = escapeHtml(node.agent);
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
      <td class="px-3 py-2 text-center">${patternBadge}</td>
      <td class="px-3 py-2 text-center">
        <div class="flex items-center justify-center gap-1">
          <button type="button" class="px-2 py-1 rounded text-xs" style="background:var(--accent);color:#fff;" data-action="load-agent-performance" data-agent="${agentAttr}">Perf</button>
          <button type="button" class="px-2 py-1 rounded text-xs" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" data-action="filter-agent" data-agent="${agentAttr}">Wagers</button>
        </div>
      </td>
    `;
    tbody.appendChild(row);
  });
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="px-3 py-8 text-center text-sm" style="color:var(--text-dim);">No agents match your search.</td></tr>';
  } else if (filtered.length > (typeof TABLE_RENDER_LIMIT !== 'undefined' ? TABLE_RENDER_LIMIT : 150)) {
    tbody.innerHTML += `<tr><td colspan="11" class="px-3 py-2 text-center text-xs" style="color:var(--text-dim);">Showing ${(typeof TABLE_RENDER_LIMIT !== 'undefined' ? TABLE_RENDER_LIMIT : 150).toLocaleString()} of ${filtered.length.toLocaleString()} matching agents.</td></tr>`;
  }
}

export function deriveAgentDownlineFromStatic() {
  const buckeyeWagers = get('buckeyeWagers') || [];
  const map = {};
  buckeyeWagers.forEach(w => {
    const a = w.AgentLogin;
    if (!map[a]) {
      map[a] = { agent_login: a, wager_count: 0, player_count: 0, total_volume: 0, total_risk: 0, alert_count: 0, live_count: 0, last_wager_at: w.InsertDateTime, players: {} };
    }
    map[a].wager_count++;
    map[a].total_volume += w.AmountWagered;
    map[a].total_risk += typeof getWagerExposure === 'function' ? getWagerExposure(w) : w.AmountWagered;
    if (w.TicketWriter === 'ALERT') map[a].alert_count++;
    if (w.TicketWriter === 'GSLIVE') map[a].live_count++;
    const p = w.Login;
    if (!map[a].players[p]) map[a].players[p] = 0;
    map[a].players[p] += typeof getWagerExposure === 'function' ? getWagerExposure(w) : w.AmountWagered;
  });
  Object.keys(map).forEach(a => {
    map[a].player_count = Object.keys(map[a].players).length;
  });
  const agentTreeData = Object.values(map).map(s => ({
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
  set('agentTreeData', agentTreeData);
  set('agentTreeFlat', agentTreeData);
  renderAgentTree(agentTreeData);
  updateAgentSummary(agentTreeData);
  return agentTreeData.length;
}

// Window exports
window.setAgentTreeLoading = setAgentTreeLoading;
window.refreshAgentDownline = refreshAgentDownline;
window.normalizeCachedAgentTree = normalizeCachedAgentTree;
window.loadAgentPatternCounts = loadAgentPatternCounts;
window.buildAgentTree = buildAgentTree;
window.flattenAgentTree = flattenAgentTree;
window.mergeAgentStats = mergeAgentStats;
window.computeDownlineStats = computeDownlineStats;
window.mergeAgentDelta = mergeAgentDelta;
window.applyAgentDelta = applyAgentDelta;
window.updateAgentRow = updateAgentRow;
window.updateAgentSummary = updateAgentSummary;
window.renderAgentTree = renderAgentTree;
window.getAgentPatternCount = getAgentPatternCount;
window.patternIconForAgent = patternIconForAgent;
window.toggleAgentPatternSort = toggleAgentPatternSort;
window.pulseAgentPatternRow = pulseAgentPatternRow;
window.pulseAgentPatternBadge = pulseAgentPatternBadge;
window.toggleAgentExpand = toggleAgentExpand;
window.handleAgentDownlineClick = handleAgentDownlineClick;
window.openPatternsForAgent = openPatternsForAgent;
window.setZone2PanelTab = setZone2PanelTab;
window.initializeZone2PerformanceDates = initializeZone2PerformanceDates;
window.selectZone2AgentPerformance = selectZone2AgentPerformance;
window.getZone2InputState = getZone2InputState;
window.getZone2ProxyCredentials = getZone2ProxyCredentials;
window.loadZone2AgentPerformance = loadZone2AgentPerformance;
window.fetchZone2AgentPerformance = fetchZone2AgentPerformance;
window.normalizeZone2Report = normalizeZone2Report;
window.normalizeZone2ArchiveReport = normalizeZone2ArchiveReport;
window.zone2NormalizeRow = zone2NormalizeRow;
window.zone2NormalizeTotals = zone2NormalizeTotals;
window.zone2TotalsFromRows = zone2TotalsFromRows;
window.getZone2BillingAgent = getZone2BillingAgent;
window.loadZone2Billing = loadZone2Billing;
window.normalizeZone2Billing = normalizeZone2Billing;
window.zone2NormalizeBillingFigure = zone2NormalizeBillingFigure;
window.zone2BillingTotals = zone2BillingTotals;
window.renderZone2Billing = renderZone2Billing;
window.renderZone2Performance = renderZone2Performance;
window.searchAgentTree = searchAgentTree;
window.runAgentTreeSearch = runAgentTreeSearch;
window.deriveAgentDownlineFromStatic = deriveAgentDownlineFromStatic;
