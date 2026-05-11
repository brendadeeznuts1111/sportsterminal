/**
 * Patterns Module
 * Extracted from app.js lines ~2190-2942.
 * Handles pattern detection display, syndicate intel, integrity cases,
 * pattern catalog, and pattern detail drawer.
 */

import { getApiBaseUrl } from '../api.js?v=5.32.14';
import { escapeHtml, escapeJs, money, timeAgo } from '../utils.js';
import { state, get, set, update } from './state.js';
import { schedule } from './render-scheduler.js';

// ==================== PATTERN CATEGORY ====================
export function setPatternCategory(category) {
  set('patternCategory', category || 'all');
  if (typeof sectionCache !== 'undefined' && sectionCache?.patterns) sectionCache.patterns.at = 0;
  document.querySelectorAll('.pattern-category-tab').forEach(btn => {
    const active = btn.dataset.category === get('patternCategory');
    btn.style.background = active ? 'var(--accent)' : 'var(--panel)';
    btn.style.border = `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`;
    btn.style.color = active ? '#fff' : 'var(--text)';
  });
  if (typeof loadPatterns === 'function') loadPatterns(true);
}

export function getPatternFilters() {
  return {
    sinceHours: document.getElementById('patternWindowFilter')?.value || '24',
    type: document.getElementById('patternTypeFilter')?.value || 'all',
    market: document.getElementById('patternMarketFilter')?.value || 'all',
    sport: document.getElementById('patternSportFilter')?.value || 'all',
    agent: document.getElementById('patternAgentFilter')?.value || 'all',
    category: get('patternCategory') || 'all',
  };
}

export function setPatternRefreshState(isLoading) {
  const btn = document.getElementById('patternRefreshBtn');
  if (!btn) return;
  btn.disabled = isLoading;
  btn.textContent = isLoading ? 'Refreshing...' : 'Refresh';
  btn.style.opacity = isLoading ? '0.65' : '1';
}

export function updatePatternFilterChoices(rows) {
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

  set('patternFilterChoices', {
    agents: Array.from(agents).sort((a, b) => a.localeCompare(b)),
    sports: Array.from(sports).sort((a, b) => a.localeCompare(b)),
  });
  renderPatternFilterOptions();
}

export function renderPatternFilterOptions() {
  const choices = get('patternFilterChoices') || { agents: [], sports: [] };
  const sportSelect = document.getElementById('patternSportFilter');
  const agentSelect = document.getElementById('patternAgentFilter');
  if (sportSelect) {
    const selected = sportSelect.value || 'all';
    sportSelect.innerHTML = `<option value="all">All sports</option>${choices.sports.map(sport => `<option value="${escapeHtml(sport)}">${escapeHtml(sport)}</option>`).join('')}`;
    sportSelect.value = choices.sports.includes(selected) ? selected : 'all';
  }
  if (agentSelect) {
    const selected = agentSelect.value || 'all';
    agentSelect.innerHTML = `<option value="all">All agents</option>${choices.agents.map(agent => `<option value="${escapeHtml(agent)}">${escapeHtml(agent)}</option>`).join('')}`;
    agentSelect.value = choices.agents.includes(selected) ? selected : 'all';
  }
}

export function renderPatternTypeOptions() {
  const select = document.getElementById('patternTypeFilter');
  const catalog = get('patternCatalog') || [];
  if (!select || !catalog.length) return;
  const selected = select.value || 'all';
  const options = catalog
    .slice()
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.label || a.type).localeCompare(b.label || b.type))
    .map(def => `<option value="${escapeHtml(def.type)}">${escapeHtml(def.label || def.type)}</option>`)
    .join('');
  select.innerHTML = `<option value="all">All active detectors</option>${options}`;
  select.value = catalog.some(def => def.type === selected) ? selected : 'all';
}

export function renderPatterns() {
  const tbody = document.getElementById('patternsTable');
  if (!tbody) return;

  syncPatternCategoryTabs();
  updatePatternSummaryCards();
  renderPatternCatalogPanel();
  renderSyndicateIntel();

  const patternsData = get('patternsData') || [];
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

export function getSyndicateAgentId() {
  return document.getElementById('syndicateAgentInput')?.value?.trim() || localStorage.getItem('agentId') || '';
}

export function renderSyndicateIntel() {
  const content = document.getElementById('syndicateIntelContent');
  const status = document.getElementById('syndicateIntelStatus');
  const button = document.getElementById('syndicateScanBtn');
  if (!content) return;

  const syndicateState = get('syndicateIntelState') || {};
  const result = syndicateState.result || {};
  const details = result.syndicateDetails || result.syndicates || [];
  const count = Array.isArray(details) ? details.length : Number(result.syndicates || 0);
  const totalStake = Array.isArray(details) ? details.reduce((sum, item) => sum + Number(item.totalStake || 0), 0) : 0;
  const maxScore = Array.isArray(details) ? details.reduce((max, item) => Math.max(max, Number(item.riskScore || item.confidence || 0)), 0) : 0;
  const scanned = syndicateState.lastScanAt ? new Date(syndicateState.lastScanAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'not scanned';

  if (status) {
    status.textContent = syndicateState.error || (syndicateState.loading ? 'Scanning enhanced proxy analytics...' : `Last scan ${scanned}`);
    status.style.color = syndicateState.error ? 'var(--red)' : 'var(--text-dim)';
  }
  if (button) {
    button.disabled = syndicateState.loading;
    button.textContent = syndicateState.loading ? 'Scanning...' : 'Scan';
    button.style.opacity = syndicateState.loading ? '0.65' : '1';
  }

  const cards = [
    syndicateIntelCard('Clusters', count, count > 0 ? 'var(--yellow)' : 'var(--text)'),
    syndicateIntelCard('Stake', money(totalStake), totalStake > 0 ? 'var(--red)' : 'var(--text)'),
    syndicateIntelCard('Max Score', `${maxScore || 0}%`, maxScore >= 80 ? 'var(--red)' : maxScore >= 60 ? 'var(--yellow)' : 'var(--green)'),
  ].join('');

  const list = Array.isArray(details) && details.length
    ? details.slice(0, 6).map((item, index) => {
      const score = Number(item.riskScore || item.confidence || 0);
      const scoreColor = score >= 80 ? 'var(--red)' : score >= 60 ? 'var(--yellow)' : 'var(--green)';
      const signals = Array.isArray(item.signals) ? item.signals : [];
      return `<div class="rounded border p-2" style="background:var(--bg);border-color:var(--border);">
        <div class="flex items-center justify-between gap-2">
          <div class="text-xs font-semibold">Cluster ${index + 1}</div>
          <div class="text-xs font-mono" style="color:${scoreColor};">${score || '—'}%</div>
        </div>
        <div class="text-[11px] mt-1" style="color:var(--text-dim);">${escapeHtml(item.pattern || '')} · ${escapeHtml(item.commonGame || '')}</div>
        <div class="flex flex-wrap gap-1 mt-2">${(item.members || []).slice(0, 8).map(member => `<span class="px-1.5 py-0.5 rounded text-[10px]" style="background:rgba(245,158,11,0.14);color:var(--accent);">${escapeHtml(member)}</span>`).join('')}</div>
        <div class="text-[10px] mt-2" style="color:var(--text-dim);">${signals.map(escapeHtml).join(' | ')}</div>
        <button class="mt-2 px-2 py-1 rounded text-[10px] font-semibold" style="background:rgba(239,68,68,0.16);color:var(--red);border:1px solid rgba(239,68,68,0.24);" onclick="createIntegrityCaseFromSyndicate(${index})">Open Case</button>
      </div>`;
    }).join('')
    : `<div class="rounded border p-3 text-xs lg:col-span-2" style="background:var(--bg);border-color:var(--border);color:var(--text-dim);">No syndicate clusters detected for the current threshold.</div>`;

  content.innerHTML = `
    <div class="grid grid-cols-3 gap-2">${cards}</div>
    <div class="lg:col-span-2 grid grid-cols-1 xl:grid-cols-2 gap-2">${list}</div>
  `;
  renderIntegrityCases();
}

export function renderIntegrityCases() {
  const content = document.getElementById('integrityCaseContent');
  const status = document.getElementById('integrityCaseStatus');
  const button = document.getElementById('integrityCaseRefreshBtn');
  if (!content) return;

  const integrityState = get('integrityCaseState') || {};
  const stats = integrityState.stats || {};
  const caseStats = stats.cases || {};
  const openCount = Number(caseStats.open || 0);
  const escalatedCount = Number(caseStats.escalated || 0);
  const scanCount = Number(stats.syndicates?.count || 0);
  const loaded = integrityState.lastLoadedAt ? new Date(integrityState.lastLoadedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'not loaded';

  if (status) {
    status.textContent = integrityState.error || (integrityState.loading ? 'Loading integrity cases...' : `Last loaded ${loaded}`);
    status.style.color = integrityState.error ? 'var(--red)' : 'var(--text-dim)';
  }
  if (button) {
    button.disabled = integrityState.loading || integrityState.saving;
    button.textContent = integrityState.loading ? 'Loading...' : integrityState.saving ? 'Saving...' : 'Refresh';
    button.style.opacity = integrityState.loading || integrityState.saving ? '0.65' : '1';
  }

  const cards = [
    syndicateIntelCard('Open Cases', openCount, openCount > 0 ? 'var(--yellow)' : 'var(--text)'),
    syndicateIntelCard('Escalated', escalatedCount, escalatedCount > 0 ? 'var(--red)' : 'var(--text)'),
    syndicateIntelCard('Scan Clusters', scanCount, scanCount > 0 ? 'var(--accent)' : 'var(--text)'),
  ].join('');

  const cases = integrityState.cases?.length
    ? integrityState.cases.slice(0, 8).map(row => integrityCaseRow(row)).join('')
    : `<div class="rounded border p-3 text-xs lg:col-span-2" style="background:var(--bg);border-color:var(--border);color:var(--text-dim);">No integrity cases for the selected status.</div>`;

  content.innerHTML = `
    <div class="grid grid-cols-3 gap-2">${cards}</div>
    <div class="lg:col-span-2 grid grid-cols-1 xl:grid-cols-2 gap-2">${cases}</div>
  `;
}

function integrityCaseRow(row) {
  const priorityColor = row.priority === 'critical' ? 'var(--red)' : row.priority === 'high' ? 'var(--yellow)' : 'var(--text-dim)';
  const statusColor = row.status === 'escalated' ? 'var(--red)' : row.status === 'closed' ? 'var(--green)' : row.status === 'false_positive' ? 'var(--text-dim)' : 'var(--yellow)';
  const buttons = [
    ['reviewing', 'Review'],
    ['escalated', 'Escalate'],
    ['closed', 'Close'],
    ['false_positive', 'False +'],
  ].filter(([status]) => status !== row.status).map(([status, label]) =>
    `<button class="px-2 py-1 rounded text-[10px]" style="background:var(--panel);border:1px solid var(--border);color:var(--text-dim);" onclick="updateIntegrityCaseStatus('${escapeHtml(row.id)}','${status}')">${label}</button>`
  ).join('');
  return `<div class="rounded border p-2" style="background:var(--bg);border-color:var(--border);">
    <div class="flex items-start justify-between gap-2">
      <div>
        <div class="text-xs font-semibold">${escapeHtml(row.title || row.id)}</div>
        <div class="text-[10px] mt-1" style="color:var(--text-dim);">${escapeHtml(row.summary || '')}</div>
      </div>
      <div class="text-[10px] font-bold uppercase" style="color:${priorityColor};">${escapeHtml(row.priority || '')}</div>
    </div>
    <div class="flex flex-wrap items-center gap-2 mt-2">
      <span class="px-1.5 py-0.5 rounded text-[10px] uppercase" style="background:${statusColor}22;color:${statusColor};">${escapeHtml(row.status || '')}</span>
      <span class="text-[10px]" style="color:var(--text-dim);">${escapeHtml(row.syndicateId || 'manual')}</span>
    </div>
    <div class="flex flex-wrap gap-1 mt-2">${buttons}</div>
  </div>`;
}

function syndicateIntelCard(label, value, color) {
  return `<div class="rounded p-2" style="background:var(--bg);border:1px solid var(--border);">
    <div class="text-[10px] uppercase tracking-wider" style="color:var(--text-dim);">${escapeHtml(label)}</div>
    <div class="text-lg font-bold font-mono" style="color:${color};">${escapeHtml(value)}</div>
  </div>`;
}

export function renderPatternCatalogPanel() {
  const panel = document.getElementById('patternCatalogPanel');
  if (!panel) return;
  const catalog = get('patternCatalog') || [];
  if (!catalog.length) {
    panel.innerHTML = '<div class="text-xs" style="color:var(--text-dim);">Detector catalog unavailable. Pattern rows still show persisted evidence and reason codes.</div>';
    return;
  }

  const filters = getPatternFilters();
  const visibleDefs = catalog
    .filter(def => filters.category === 'all' || def.category === filters.category)
    .filter(def => filters.type === 'all' || def.type === filters.type);
  const categoryCounts = catalog.reduce((acc, def) => {
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
        <div class="text-[10px]" style="color:var(--text-dim);">${catalog.length} active detectors. Rules are derived from local live wager, odds movement, event, and access-log tables.</div>
      </div>
      <div class="flex flex-wrap gap-1 justify-end">${chips}</div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-2">${defs || '<div class="text-xs" style="color:var(--text-dim);">No detector definitions match this filter.</div>'}</div>
  `;
}

export function syncPatternCategoryTabs() {
  const category = get('patternCategory') || 'all';
  document.querySelectorAll('.pattern-category-tab').forEach(btn => {
    const active = btn.dataset.category === category;
    btn.style.background = active ? 'var(--accent)' : 'var(--panel)';
    btn.style.border = `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`;
    btn.style.color = active ? '#fff' : 'var(--text)';
  });
}

export function parsePatternDetails(pattern) {
  if (!pattern) return {};
  if (pattern.details_json && typeof pattern.details_json === 'string') {
    try { return JSON.parse(pattern.details_json); } catch { return {}; }
  }
  return pattern.details_json || pattern.details || {};
}

export function showPatternDetail(patternId) {
  const patternsData = get('patternsData') || [];
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

export function showPatternDefinition(type) {
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

export function resetPatternDetail() {
  const drawer = document.getElementById('patternDetailDrawer');
  if (!drawer) return;
  const summary = get('patternSummary') || { total: 0, bySeverity: {} };
  drawer.innerHTML = `<h3 class="text-sm font-semibold mb-3">Evidence</h3>
    <div class="text-xs" style="color:var(--text-dim);">Select a pattern row to inspect wager timing, matched event, PIN reference, agents, players, IPs, and reason codes.</div>
    <div class="pt-3 mt-3 border-t text-xs" style="border-color:var(--border);color:var(--text-dim);">
      <span id="patternHealthText">${summary.total || 0} patterns in window | ${(summary.bySeverity || {}).critical || 0} critical</span>
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
  const catalog = get('patternCatalog') || [];
  return catalog.find(def => def.type === type);
}

export function displayPatternType(type) {
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

export function updatePatternSummaryCards() {
  const summary = get('patternSummary') || { byType: {}, bySeverity: {}, total: 0 };
  const byType = summary.byType || {};
  const elSteam = document.getElementById('patternSteamCount');
  const elReverse = document.getElementById('patternReverseCount');
  const elSyndicate = document.getElementById('patternSyndicateCount');
  const elArb = document.getElementById('patternArbCount');
  const health = document.getElementById('patternHealthText');

  if (elSteam) elSteam.textContent = byType['Steam Move'] || 0;
  if (elReverse) elReverse.textContent = (byType['Agent Swarm'] || 0) + (byType.cross_agent_steam || 0) + (byType['Cross-Agent Swarm'] || 0);
  if (elSyndicate) elSyndicate.textContent = (byType['Live Past-Post Risk'] || 0) + (byType['Late Live Spike'] || 0);
  if (elArb) elArb.textContent = (byType['Pinnacle Drift Bet'] || 0) + (byType['Post-PIN Move Bet'] || 0) + (byType['Repeat Timing Signature'] || 0) + (byType['Steam Chase'] || 0);
  if (health) {
    const critical = summary.bySeverity?.critical || 0;
    health.textContent = `${summary.total || 0} patterns in window | ${critical} critical`;
  }
}

export function updatePatternBadge() {
  const badge = document.getElementById('patternBadge');
  if (!badge) return;
  const summary = get('patternSummary') || {};
  const count = summary.bySeverity?.critical || 0;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

export function severityToScore(severity) {
  if (severity === 'critical') return 90;
  if (severity === 'warning') return 70;
  return 45;
}

// ==================== PATTERN LOADING ====================
let lastPatternRequestKey = '';
let patternsLoading = false;

export async function loadPatterns(force = false) {
  const filters = getPatternFilters();
  const requestKey = JSON.stringify(filters);

  if (!force && typeof sectionCache !== 'undefined' && sectionCache?.patterns && (Date.now() - sectionCache.patterns.at < sectionCache.patterns.ttl) && requestKey === lastPatternRequestKey) {
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

    const patternsData = await historyRes.json();
    const patternSummary = await summaryRes.json();
    if (choicesRes.ok) {
      updatePatternFilterChoices(await choicesRes.json());
    }
    set('patternsData', patternsData);
    set('patternSummary', patternSummary);
    lastPatternRequestKey = requestKey;
    if (typeof sectionCache !== 'undefined' && sectionCache?.patterns) sectionCache.patterns.at = Date.now();
  } catch (err) {
    console.log('[Patterns] Failed to load live patterns:', err.message);
    set('patternsData', []);
    set('patternSummary', { byType: {}, bySeverity: {}, total: 0 });
  } finally {
    patternsLoading = false;
    setPatternRefreshState(false);
  }

  renderPatterns();
  updatePatternBadge();
}

// Window exports
window.setPatternCategory = setPatternCategory;
window.getPatternFilters = getPatternFilters;
window.renderPatternFilterOptions = renderPatternFilterOptions;
window.renderPatternTypeOptions = renderPatternTypeOptions;
window.renderPatterns = renderPatterns;
window.getSyndicateAgentId = getSyndicateAgentId;
window.renderSyndicateIntel = renderSyndicateIntel;
window.renderIntegrityCases = renderIntegrityCases;
window.renderPatternCatalogPanel = renderPatternCatalogPanel;
window.showPatternDetail = showPatternDetail;
window.showPatternDefinition = showPatternDefinition;
window.resetPatternDetail = resetPatternDetail;
window.updatePatternSummaryCards = updatePatternSummaryCards;
window.updatePatternBadge = updatePatternBadge;
window.loadPatterns = loadPatterns;
