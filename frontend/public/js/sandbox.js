import { getApiBaseUrl, fetchJson, fetchPost } from './api.js';
import { escapeHtml } from './utils.js';

const PAGE_SIZE = 50;

let sandboxState = {
  scenarios: [],
  currentScenario: null,
  customers: [],
  pagination: { page: 1, limit: PAGE_SIZE, total: 0, pages: 0 },
  loading: false,
  error: '',
  view: 'list',
  expandedCustomers: new Set(),
  searchQuery: '',
  summaryQueueStatus: null,
  abTests: [],
};

export function getSandboxState() {
  return sandboxState;
}

export async function loadSandboxScenarioList() {
  sandboxState.loading = true;
  sandboxState.error = '';
  try {
    const data = await fetchJson('/api/sandbox/list');
    sandboxState.scenarios = data.scenarios || [];
  } catch (err) {
    sandboxState.error = err.message || 'Failed to load scenarios';
  }
  sandboxState.loading = false;
  renderSandboxUI();
}

export async function loadSandboxScenario(id, page = 1) {
  sandboxState.loading = true;
  sandboxState.error = '';
  try {
    const data = await fetchJson(`/api/sandbox/load?id=${id}&page=${page}&limit=${PAGE_SIZE}&snapshots=true`);
    sandboxState.currentScenario = data;
    sandboxState.customers = data.customers || [];
    sandboxState.pagination = data.pagination || { page: 1, limit: PAGE_SIZE, total: 0, pages: 0 };
    sandboxState.view = 'detail';
    sandboxState.expandedCustomers.clear();
  } catch (err) {
    sandboxState.error = err.message || 'Failed to load scenario';
  }
  sandboxState.loading = false;
  renderSandboxUI();
}

export async function saveSandboxScenario(input, existingId) {
  const url = existingId ? `/api/sandbox/save?id=${existingId}` : '/api/sandbox/save';
  const result = await fetchPost(url, input);
  return result;
}

export async function deleteSandboxScenario(id) {
  return fetchPost('/api/sandbox/delete', { id });
}

export async function generateSandboxSummaries(scenarioId, customerIds) {
  return fetchPost('/api/sandbox/generate-summaries', {
    scenarioId,
    ...(customerIds ? { customerIds } : {}),
  });
}

export async function loadSandboxQueueStatus(scenarioId) {
  try {
    const data = await fetchJson(`/api/sandbox/queue-status?scenarioId=${scenarioId}`);
    sandboxState.summaryQueueStatus = data;
  } catch {
    sandboxState.summaryQueueStatus = null;
  }
  renderSandboxUI();
}

export async function loadSandboxABTests(scenarioId) {
  try {
    const data = await fetchJson(`/api/sandbox/ab-tests?scenario_id=${scenarioId}`);
    sandboxState.abTests = data.tests || [];
  } catch {
    sandboxState.abTests = [];
  }
  renderSandboxUI();
}

export async function createSandboxABTest(input) {
  return fetchPost('/api/sandbox/ab-test', input);
}

export async function loadSandboxABTestDetail(id) {
  return fetchJson(`/api/sandbox/ab-test/${id}`);
}

export async function refreshSandboxCustomerSummary(scenarioId, customerId) {
  return fetchPost('/api/sandbox/customer-summary', { scenario_id: scenarioId, customer_id: customerId });
}

export function exportSandboxCsv(scenarioId) {
  window.open(`${getApiBaseUrl()}/api/sandbox/export/csv?scenarioId=${scenarioId}`, '_blank');
}

export function exportSandboxFeatures(scenarioId) {
  window.open(`${getApiBaseUrl()}/api/sandbox/export/features?scenarioId=${scenarioId}`, '_blank');
}

function tierColor(tier) {
  const colors = { BLACK: '#ef4444', RED: '#f97316', YELLOW: '#f59e0b', GREEN: '#10b981', UNKNOWN: '#6b7280' };
  return colors[tier] || colors.UNKNOWN;
}

function riskBadge(tier) {
  const c = tierColor(tier);
  return `<span class="px-1.5 py-0.5 rounded text-xs font-bold" style="background:${c}22;color:${c};">${tier}</span>`;
}

function sparklineSvg(data, width = 80, height = 24) {
  if (!data || data.length < 2) return `<span style="color:var(--text-dim);font-size:10px;">—</span>`;
  const values = data.map(d => typeof d === 'number' ? d : 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * (height - 4) - 2).toFixed(1)}`).join(' ');
  const areaPoints = `0,${height} ${points} ${width},${height}`;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:inline-block;vertical-align:middle;"><polygon points="${areaPoints}" fill="rgba(255,102,0,0.1)"/><polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderSandboxUI() {
  const container = document.getElementById('sandboxContent');
  if (!container) return;

  if (sandboxState.view === 'detail' && sandboxState.currentScenario) {
    container.innerHTML = renderDetailView();
  } else {
    container.innerHTML = renderListView();
  }
  bindSandboxEvents();
}

function renderListView() {
  const { scenarios, loading, error } = sandboxState;

  if (loading && scenarios.length === 0) {
    return `<div class="text-center py-12" style="color:var(--text-dim);">Loading scenarios...</div>`;
  }

  if (error) {
    return `<div class="text-center py-12" style="color:var(--red);">${escapeHtml(error)}</div>`;
  }

  if (scenarios.length === 0) {
    return `
      <div class="text-center py-12">
        <div class="text-sm font-medium mb-2" style="color:var(--text-dim);">No scenarios yet</div>
        <div class="text-xs mb-4" style="color:var(--text-dim);">Create a sandbox scenario to generate synthetic customer profiles and test risk assessments.</div>
        <button id="sandboxCreateBtn" class="px-4 py-2 rounded-lg text-xs font-medium" style="background:var(--accent);color:#fff;">Create Scenario</button>
      </div>
    `;
  }

  const rows = scenarios.map(s => {
    const date = s.updated_at ? new Date(s.updated_at) : null;
    const dateStr = date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
    const count = s.customer_count || 0;
    const version = s.version || 1;
    return `
      <div class="rounded-lg border p-4 cursor-pointer transition-colors hover:border-opacity-60 sandbox-scenario-card" data-scenario-id="${s.id}" style="background:var(--panel);border-color:var(--border);">
        <div class="flex items-center justify-between mb-2">
          <div class="font-semibold text-sm" style="color:var(--text);">${escapeHtml(s.name)}</div>
          <div class="flex items-center gap-2">
            <span class="text-xs px-1.5 py-0.5 rounded" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">v${version}</span>
            <button class="sandbox-delete-btn text-xs px-2 py-0.5 rounded" data-scenario-id="${s.id}" style="background:transparent;border:1px solid var(--border);color:var(--text-dim);" title="Archive scenario">Archive</button>
          </div>
        </div>
        ${s.description ? `<div class="text-xs mb-2" style="color:var(--text-dim);">${escapeHtml(s.description)}</div>` : ''}
        <div class="flex items-center gap-3 text-xs" style="color:var(--text-dim);">
          <span>${count} customer${count !== 1 ? 's' : ''}</span>
          <span>·</span>
          <span>${dateStr}</span>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <div class="text-xs" style="color:var(--text-dim);">${scenarios.length} scenario${scenarios.length !== 1 ? 's' : ''}</div>
        <button id="sandboxCreateBtn" class="px-3 py-1.5 rounded-lg text-xs font-medium" style="background:var(--accent);color:#fff;">+ New Scenario</button>
      </div>
      <div class="space-y-3">${rows}</div>
    </div>
  `;
}

function renderDetailView() {
  const sc = sandboxState.currentScenario;
  if (!sc) return '<div style="color:var(--text-dim);">No scenario loaded</div>';

  const config = sc.config || {};
  const pg = sandboxState.pagination;
  const customers = sandboxState.customers;
  const queueStatus = sandboxState.summaryQueueStatus;
  const abTests = sandboxState.abTests;

  const summaryStats = computeSummaryStats(customers);

  let queueHtml = '';
  if (queueStatus) {
    queueHtml = `
      <div class="flex items-center gap-4 text-xs" style="color:var(--text-dim);">
        <span>Queued: <strong style="color:var(--yellow);">${queueStatus.queued || 0}</strong></span>
        <span>Processing: <strong style="color:var(--blue);">${queueStatus.processing || 0}</strong></span>
        <span>Completed: <strong style="color:var(--green);">${queueStatus.completed || 0}</strong></span>
        <span>Failed: <strong style="color:var(--red);">${queueStatus.failed || 0}</strong></span>
        ${queueStatus.dead ? `<span>Dead: <strong style="color:var(--red);">${queueStatus.dead}</strong></span>` : ''}
      </div>
    `;
  }

  let abTestRows = '';
  if (abTests.length > 0) {
    abTestRows = abTests.map(t => `
      <div class="rounded border p-3" style="background:var(--bg);border-color:var(--border);">
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs font-medium">${escapeHtml(t.name)}</span>
          <span class="text-xs px-1.5 py-0.5 rounded font-bold" style="background:${t.status === 'completed' ? 'rgba(16,185,129,0.15);color:var(--green)' : t.status === 'running' ? 'rgba(59,130,246,0.15);color:var(--blue)' : 'rgba(107,114,128,0.15);color:var(--text-dim)'};">${t.status}</span>
        </div>
        ${t.agreement_score != null ? `<div class="text-xs" style="color:var(--text-dim);">Agreement: <strong>${(t.agreement_score * 100).toFixed(0)}%</strong> · Severity diff: <strong>${t.avg_severity_diff != null ? t.avg_severity_diff.toFixed(2) : '—'}</strong></div>` : ''}
        <div class="text-xs" style="color:var(--text-dim);">Created: ${t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'}</div>
      </div>
    `).join('');
  }

  const customerRows = customers.map(c => {
    const expanded = sandboxState.expandedCustomers.has(c.customer_id);
    const summary = c.summary || {};
    const snapshots = c.snapshot || [];
    const balSparkline = sparklineSvg(snapshots.map(s => s.balance));
    const pnlSparkline = sparklineSvg(snapshots.map(s => s.pnl));
    const wrSparkline = sparklineSvg(snapshots.map(s => s.win_rate));
    const clvSparkline = sparklineSvg(snapshots.map(s => s.clv));

    const summaryStatus = c.summary_status || 'pending';
    const statusColors = {
      pending: { bg: 'rgba(107,114,128,0.15)', color: 'var(--text-dim)' },
      queued: { bg: 'rgba(245,158,11,0.15)', color: 'var(--yellow)' },
      processing: { bg: 'rgba(59,130,246,0.15)', color: 'var(--blue)' },
      completed: { bg: 'rgba(16,185,129,0.15)', color: 'var(--green)' },
      failed: { bg: 'rgba(239,68,68,0.15)', color: 'var(--red)' },
    };
    const sc2 = statusColors[summaryStatus] || statusColors.pending;

    const tags = Array.isArray(c.tags) ? c.tags : [];
    const tagsHtml = tags.slice(0, 4).map(t => `<span class="text-xs px-1 py-0.5 rounded" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">${escapeHtml(String(t))}</span>`).join(' ');

    const expandContent = expanded ? `
      <div class="mt-3 p-3 rounded border" style="background:var(--bg);border-color:var(--border);">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 text-xs mb-3">
          <div><span style="color:var(--text-dim);">Balance:</span> <strong>${c.balance != null ? '$' + Number(c.balance).toLocaleString() : '—'}</strong></div>
          <div><span style="color:var(--text-dim);">CLV:</span> <strong>${c.clv != null ? Number(c.clv).toFixed(4) : '—'}</strong></div>
          <div><span style="color:var(--text-dim);">Win Rate:</span> <strong>${c.win_rate != null ? (Number(c.win_rate) * 100).toFixed(1) + '%' : '—'}</strong></div>
          <div><span style="color:var(--text-dim);">Lifetime Wagers:</span> <strong>${c.lifetime_wagers != null ? Number(c.lifetime_wagers).toLocaleString() : '—'}</strong></div>
        </div>
        ${snapshots.length > 0 ? `
        <div class="mb-3">
          <div class="text-xs font-medium mb-1" style="color:var(--text-dim);">90-Day Snapshots (${snapshots.length} days)</div>
          <div class="rounded border overflow-auto" style="border-color:var(--border);max-height:200px;">
            <table class="w-full text-xs">
              <thead style="position:sticky;top:0;background:var(--panel);"><tr>
                <th class="text-left px-2 py-1" style="color:var(--text-dim);">Day</th>
                <th class="text-right px-2 py-1" style="color:var(--text-dim);">Balance</th>
                <th class="text-right px-2 py-1" style="color:var(--text-dim);">P&L</th>
                <th class="text-right px-2 py-1" style="color:var(--text-dim);">Wagers</th>
                <th class="text-right px-2 py-1" style="color:var(--text-dim);">CLV</th>
                <th class="text-right px-2 py-1" style="color:var(--text-dim);">Win Rate</th>
              </tr></thead>
              <tbody>${snapshots.map(s => `
                <tr class="border-t" style="border-color:var(--border);">
                  <td class="px-2 py-1">${s.day_index}</td>
                  <td class="text-right px-2 py-1 font-mono">$${Number(s.balance).toLocaleString()}</td>
                  <td class="text-right px-2 py-1 font-mono" style="color:${Number(s.pnl) >= 0 ? 'var(--green)' : 'var(--red)'};">${Number(s.pnl) >= 0 ? '+' : ''}$${Number(s.pnl).toLocaleString()}</td>
                  <td class="text-right px-2 py-1">${s.wager_count}</td>
                  <td class="text-right px-2 py-1 font-mono">${Number(s.clv).toFixed(4)}</td>
                  <td class="text-right px-2 py-1">${(Number(s.win_rate) * 100).toFixed(1)}%</td>
                </tr>
              `).join('')}</tbody>
            </table>
          </div>
        </div>
        ` : '<div class="text-xs mb-3" style="color:var(--text-dim);">No snapshot data for this customer.</div>'}
        ${summary.headline ? `
        <div class="rounded border p-2 text-xs" style="background:var(--panel);border-color:var(--border);">
          <div class="font-medium mb-1">Summary</div>
          <div style="color:var(--text-dim);">${escapeHtml(summary.headline || '')}</div>
          ${summary.risk_score != null ? `<div class="mt-1">Risk Score: <strong>${summary.risk_score}</strong>/100 ${riskBadge(summary.risk_tier || summary.risk_level || 'UNKNOWN')}</div>` : ''}
          <div class="mt-1 text-xs" style="color:var(--text-dim);">Generated by: ${escapeHtml(summary.generated_by || '—')}</div>
        </div>
        ` : ''}
        <div class="flex gap-2 mt-2">
          <button class="sandbox-refresh-summary px-2 py-1 rounded text-xs" data-scenario-id="${sc.id}" data-customer-id="${c.customer_id}" style="background:var(--accent);color:#fff;">Refresh Summary</button>
        </div>
      </div>
    ` : '';

    return `
      <div class="rounded-lg border mb-2 sandbox-customer-card" data-customer-id="${c.customer_id}" style="background:var(--panel);border-color:var(--border);">
        <div class="p-3 cursor-pointer sandbox-customer-toggle" data-customer-id="${c.customer_id}">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0" style="background:${tierColor(c.risk_tier || 'UNKNOWN')}22;color:${tierColor(c.risk_tier || 'UNKNOWN')};">
                ${escapeHtml(String(c.customer_id).slice(0, 2).toUpperCase())}
              </div>
              <div class="min-w-0">
                <div class="font-medium text-sm truncate">${escapeHtml(c.customer_id)}</div>
                <div class="flex items-center gap-2 text-xs" style="color:var(--text-dim);">
                  <span>${escapeHtml(c.archetype)}</span>
                  ${c.risk_tier ? riskBadge(c.risk_tier) : ''}
                  ${tags.length > 0 ? `<span>${tagsHtml}</span>` : ''}
                </div>
              </div>
            </div>
            <div class="flex items-center gap-4 text-xs shrink-0">
              <div class="text-right">
                <div style="color:var(--text-dim);">Balance</div>
                <div class="font-mono font-medium">${c.balance != null ? '$' + Number(c.balance).toLocaleString() : '—'}</div>
              </div>
              <div class="text-right">
                <div style="color:var(--text-dim);">CLV</div>
                <div class="font-mono font-medium">${c.clv != null ? Number(c.clv).toFixed(4) : '—'}</div>
              </div>
              <div class="text-right">
                <div style="color:var(--text-dim);">Win%</div>
                <div class="font-mono font-medium">${c.win_rate != null ? (Number(c.win_rate) * 100).toFixed(1) + '%' : '—'}</div>
              </div>
              ${snapshots.length > 0 ? `
              <div class="flex items-center gap-2">
                <div title="Balance trend">${balSparkline}</div>
                <div title="P&L trend">${pnlSparkline}</div>
              </div>
              ` : ''}
              <span class="px-1.5 py-0.5 rounded text-xs" style="background:${sc2.bg};color:${sc2.color};">${summaryStatus}</span>
              <svg class="w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
            </div>
          </div>
        </div>
        ${expandContent}
      </div>
    `;
  }).join('');

  const startPage = Math.max(1, pg.page - 2);
  const endPage = Math.min(pg.pages, pg.page + 2);
  const pageButtons = [];
  if (pg.page > 1) pageButtons.push(`<button class="sandbox-page-btn px-2 py-1 rounded text-xs" data-page="${pg.page - 1}" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">Prev</button>`);
  for (let i = startPage; i <= endPage; i++) {
    const active = i === pg.page;
    pageButtons.push(`<button class="sandbox-page-btn px-2 py-1 rounded text-xs font-medium" data-page="${i}" style="background:${active ? 'var(--accent)' : 'var(--bg)'};border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};color:${active ? '#fff' : 'var(--text-dim)'};">${i}</button>`);
  }
  if (pg.page < pg.pages) pageButtons.push(`<button class="sandbox-page-btn px-2 py-1 rounded text-xs" data-page="${pg.page + 1}" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">Next</button>`);

  return `
    <div class="space-y-4">
      <!-- Header -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <button id="sandboxBackBtn" class="px-2 py-1 rounded text-xs" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">← Back</button>
          <div>
            <h3 class="text-lg font-bold">${escapeHtml(sc.name)}</h3>
            ${sc.description ? `<div class="text-xs" style="color:var(--text-dim);">${escapeHtml(sc.description)}</div>` : ''}
          </div>
          <span class="text-xs px-1.5 py-0.5 rounded" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">v${sc.version || 1}</span>
        </div>
        <div class="flex items-center gap-2">
          <button id="sandboxGenerateSummaries" class="px-3 py-1.5 rounded text-xs font-medium" style="background:var(--accent);color:#fff;">Generate Summaries</button>
          <button id="sandboxExportCsv" class="px-3 py-1.5 rounded text-xs font-medium" style="background:var(--panel);border:1px solid var(--border);color:var(--text);">Export CSV</button>
          <button id="sandboxExportFeatures" class="px-3 py-1.5 rounded text-xs font-medium" style="background:var(--panel);border:1px solid var(--border);color:var(--text);">Export Features</button>
        </div>
      </div>

      <!-- Summary Stats Cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <div class="rounded-lg p-3 border" style="background:var(--panel);border-color:var(--border);">
          <div class="text-xs" style="color:var(--text-dim);">Customers</div>
          <div class="text-lg font-bold">${pg.total}</div>
        </div>
        <div class="rounded-lg p-3 border" style="background:var(--panel);border-color:var(--border);">
          <div class="text-xs" style="color:var(--text-dim);">Avg Balance</div>
          <div class="text-lg font-bold">$${summaryStats.avgBalance.toLocaleString()}</div>
        </div>
        <div class="rounded-lg p-3 border" style="background:var(--panel);border-color:var(--border);">
          <div class="text-xs" style="color:var(--text-dim);">Avg CLV</div>
          <div class="text-lg font-bold">${summaryStats.avgClv.toFixed(4)}</div>
        </div>
        <div class="rounded-lg p-3 border" style="background:var(--panel);border-color:var(--border);">
          <div class="text-xs" style="color:var(--text-dim);">Avg Win Rate</div>
          <div class="text-lg font-bold">${summaryStats.avgWinRate.toFixed(1)}%</div>
        </div>
        <div class="rounded-lg p-3 border" style="background:var(--panel);border-color:var(--border);">
          <div class="text-xs" style="color:var(--text-dim);">Risk Tiers</div>
          <div class="flex items-center gap-1 mt-1">${renderTierBadges(summaryStats.tierCounts)}</div>
        </div>
        <div class="rounded-lg p-3 border" style="background:var(--panel);border-color:var(--border);">
          <div class="text-xs" style="color:var(--text-dim);">Summaries</div>
          <div class="text-lg font-bold">${summaryStats.completedSummaries}/${pg.total}</div>
        </div>
      </div>

      <!-- Queue Status -->
      ${queueHtml ? `<div class="rounded-lg border p-3" style="background:var(--panel);border-color:var(--border);">
        <div class="text-xs font-medium mb-1">Summary Queue</div>
        ${queueHtml}
      </div>` : ''}

      <!-- Customer List -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <div class="text-sm font-semibold">Customers</div>
          <div class="text-xs" style="color:var(--text-dim);">Page ${pg.page} of ${pg.pages} · ${pg.total} total</div>
        </div>
        ${customerRows.length > 0 ? customerRows : '<div class="text-xs py-4 text-center" style="color:var(--text-dim);">No customers on this page.</div>'}
      </div>

      <!-- Pagination -->
      ${pg.pages > 1 ? `
      <div class="flex items-center justify-center gap-1">
        ${pageButtons.join('')}
      </div>
      ` : ''}

      <!-- A/B Tests -->
      ${abTests.length > 0 ? `
      <div class="rounded-lg border p-4" style="background:var(--panel);border-color:var(--border);">
        <div class="text-sm font-semibold mb-3">A/B Tests</div>
        <div class="space-y-2">${abTestRows}</div>
      </div>
      ` : ''}

      <!-- Create A/B Test -->
      <div class="rounded-lg border p-4" style="background:var(--panel);border-color:var(--border);">
        <div class="text-sm font-semibold mb-3">New A/B Test</div>
        <form id="sandboxAbTestForm" class="space-y-3">
          <div>
            <label class="text-xs" style="color:var(--text-dim);">Name</label>
            <input id="sandboxAbTestName" type="text" placeholder="e.g. Strict vs Lenient" class="w-full text-xs px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);">
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs" style="color:var(--text-dim);">Prompt A</label>
              <textarea id="sandboxAbTestPromptA" rows="3" placeholder="You are a strict risk analyst..." class="w-full text-xs px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);"></textarea>
            </div>
            <div>
              <label class="text-xs" style="color:var(--text-dim);">Prompt B</label>
              <textarea id="sandboxAbTestPromptB" rows="3" placeholder="You are a lenient risk analyst..." class="w-full text-xs px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);"></textarea>
            </div>
          </div>
          <div>
            <label class="text-xs" style="color:var(--text-dim);">Customer IDs (comma-separated, max 20)</label>
            <input id="sandboxAbTestCustomers" type="text" placeholder="Leave empty for all" class="w-full text-xs px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);">
          </div>
          <button type="submit" class="px-3 py-1.5 rounded text-xs font-medium" style="background:var(--accent);color:#fff;">Run A/B Test</button>
        </form>
      </div>
    </div>
  `;
}

function renderTierBadges(tierCounts) {
  return ['BLACK', 'RED', 'YELLOW', 'GREEN', 'UNKNOWN'].map(tier => {
    const count = tierCounts[tier] || 0;
    if (count === 0) return '';
    return `<span class="text-xs px-1 py-0.5 rounded" style="background:${tierColor(tier)}22;color:${tierColor(tier)};">${count}</span>`;
  }).join('');
}

function computeSummaryStats(customers) {
  if (!customers.length) return { avgBalance: 0, avgClv: 0, avgWinRate: 0, tierCounts: {}, completedSummaries: 0 };
  let totalBalance = 0, totalClv = 0, totalWinRate = 0, completed = 0;
  const tierCounts = { BLACK: 0, RED: 0, YELLOW: 0, GREEN: 0, UNKNOWN: 0 };
  for (const c of customers) {
    totalBalance += Number(c.balance) || 0;
    totalClv += Number(c.clv) || 0;
    totalWinRate += Number(c.win_rate) || 0;
    const tier = (c.risk_tier || 'UNKNOWN').toUpperCase();
    if (tierCounts[tier] !== undefined) tierCounts[tier]++;
    else tierCounts.UNKNOWN++;
    if (c.summary_status === 'completed') completed++;
  }
  const n = customers.length;
  return {
    avgBalance: n ? totalBalance / n : 0,
    avgClv: n ? totalClv / n : 0,
    avgWinRate: n ? (totalWinRate / n) * 100 : 0,
    tierCounts,
    completedSummaries: completed,
  };
}

function bindSandboxEvents() {
  const container = document.getElementById('sandboxContent');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const target = e.target;

    const backBtn = target.closest('#sandboxBackBtn');
    if (backBtn) {
      sandboxState.view = 'list';
      sandboxState.currentScenario = null;
      loadSandboxScenarioList();
      return;
    }

    const createBtn = target.closest('#sandboxCreateBtn');
    if (createBtn) {
      showCreateScenarioModal();
      return;
    }

    const card = target.closest('.sandbox-scenario-card');
    if (card && !target.closest('.sandbox-delete-btn')) {
      const id = Number(card.dataset.scenarioId);
      if (id) loadSandboxScenario(id);
      return;
    }

    const deleteBtn = target.closest('.sandbox-delete-btn');
    if (deleteBtn) {
      e.stopPropagation();
      const id = Number(deleteBtn.dataset.scenarioId);
      if (id && confirm('Archive this scenario?')) {
        deleteSandboxScenario(id).then(() => loadSandboxScenarioList());
      }
      return;
    }

    const toggleCustomer = target.closest('.sandbox-customer-toggle');
    if (toggleCustomer) {
      const cid = toggleCustomer.dataset.customerId;
      if (sandboxState.expandedCustomers.has(cid)) {
        sandboxState.expandedCustomers.delete(cid);
      } else {
        sandboxState.expandedCustomers.add(cid);
      }
      renderSandboxUI();
      return;
    }

    const pageBtn = target.closest('.sandbox-page-btn');
    if (pageBtn && sandboxState.currentScenario) {
      const page = Number(pageBtn.dataset.page);
      loadSandboxScenario(sandboxState.currentScenario.id, page);
      return;
    }

    const refreshBtn = target.closest('.sandbox-refresh-summary');
    if (refreshBtn) {
      const scenarioId = Number(refreshBtn.dataset.scenarioId);
      const customerId = refreshBtn.dataset.customerId;
      refreshSandboxCustomerSummary(scenarioId, customerId).then(() => {
        loadSandboxScenario(sandboxState.currentScenario.id, sandboxState.pagination.page);
      });
      return;
    }
  });

  const generateBtn = container.querySelector('#sandboxGenerateSummaries');
  if (generateBtn) {
    generateBtn.onclick = () => {
      if (!sandboxState.currentScenario) return;
      generateSandboxSummaries(sandboxState.currentScenario.id).then(() => {
        setTimeout(() => {
          loadSandboxQueueStatus(sandboxState.currentScenario.id);
          loadSandboxScenario(sandboxState.currentScenario.id, sandboxState.pagination.page);
        }, 2000);
      });
    };
  }

  const csvBtn = container.querySelector('#sandboxExportCsv');
  if (csvBtn) {
    csvBtn.onclick = () => {
      if (sandboxState.currentScenario) exportSandboxCsv(sandboxState.currentScenario.id);
    };
  }

  const featBtn = container.querySelector('#sandboxExportFeatures');
  if (featBtn) {
    featBtn.onclick = () => {
      if (sandboxState.currentScenario) exportSandboxFeatures(sandboxState.currentScenario.id);
    };
  }

  const abForm = container.querySelector('#sandboxAbTestForm');
  if (abForm) {
    abForm.onsubmit = (e) => {
      e.preventDefault();
      const name = document.getElementById('sandboxAbTestName')?.value?.trim();
      const promptA = document.getElementById('sandboxAbTestPromptA')?.value?.trim();
      const promptB = document.getElementById('sandboxAbTestPromptB')?.value?.trim();
      const customersRaw = document.getElementById('sandboxAbTestCustomers')?.value?.trim();
      if (!name || !promptA || !promptB) return;
      const customerIds = customersRaw ? customersRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      createSandboxABTest({
        scenario_id: sandboxState.currentScenario.id,
        name,
        prompt_a: promptA,
        prompt_b: promptB,
        ...(customerIds ? { customer_ids: customerIds } : {}),
      }).then(() => {
        setTimeout(() => loadSandboxABTests(sandboxState.currentScenario.id), 3000);
      });
    };
  }
}

function showCreateScenarioModal() {
  const modal = document.getElementById('sandboxCreateModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

export function closeSandboxCreateModal() {
  const modal = document.getElementById('sandboxCreateModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

export async function submitCreateScenario(e) {
  e.preventDefault();
  const name = document.getElementById('sandboxCreateName')?.value?.trim();
  const description = document.getElementById('sandboxCreateDesc')?.value?.trim();
  const customerCount = Number(document.getElementById('sandboxCreateCount')?.value) || 5;

  if (!name) return;

  const archetypePool = [
    { archetype: 'sharp', weight: 0.2, risk_tier: 'RED', balance: [5000, 50000], clv: [0.05, 0.15], win_rate: [0.52, 0.6], lifetime_wagers: [500, 3000] },
    { archetype: 'recreational', weight: 0.35, risk_tier: 'GREEN', balance: [100, 2000], clv: [-0.1, 0.02], win_rate: [0.4, 0.5], lifetime_wagers: [10, 200] },
    { archetype: 'whale', weight: 0.1, risk_tier: 'YELLOW', balance: [10000, 100000], clv: [0.01, 0.08], win_rate: [0.48, 0.55], lifetime_wagers: [100, 1000] },
    { archetype: 'chaser', weight: 0.15, risk_tier: 'RED', balance: [500, 5000], clv: [-0.15, 0.0], win_rate: [0.35, 0.47], lifetime_wagers: [50, 500] },
    { archetype: 'casual', weight: 0.2, risk_tier: 'GREEN', balance: [50, 1000], clv: [-0.05, 0.03], win_rate: [0.44, 0.52], lifetime_wagers: [5, 50] },
  ];

  const weights = {};
  archetypePool.forEach(a => weights[a.archetype] = a.weight);

  const customers = [];
  for (let i = 0; i < customerCount; i++) {
    const archetype = weightedRandom(archetypePool);
    const clv = randomInRange(archetype.clv[0], archetype.clv[1]);
    const wr = randomInRange(archetype.win_rate[0], archetype.win_rate[1]);
    const bal = randomInRange(archetype.balance[0], archetype.balance[1]);
    const lw = Math.floor(randomInRange(archetype.lifetime_wagers[0], archetype.lifetime_wagers[1]));
    customers.push({
      customer_id: `${archetype.archetype}-${i + 1}`,
      archetype: archetype.archetype,
      risk_tier: archetype.risk_tier,
      balance: Math.round(bal),
      clv: Math.round(clv * 10000) / 10000,
      win_rate: Math.round(wr * 1000) / 1000,
      lifetime_wagers: lw,
      tags: archetype.archetype === 'chaser' ? ['Chasing'] : archetype.archetype === 'whale' ? ['High Roller'] : [],
    });
  }

  const input = {
    name,
    description: description || undefined,
    config: { customerCount, archetypesEnabled: true, snapshotsEnabled: false, aiSummariesEnabled: true, archetypeWeights: weights },
    customers,
  };

  try {
    const result = await saveSandboxScenario(input);
    closeSandboxCreateModal();
    await loadSandboxScenarioList();
    if (result.id) {
      await loadSandboxScenario(result.id);
    }
  } catch (err) {
    alert('Failed to create scenario: ' + (err.message || 'Unknown error'));
  }
}

function weightedRandom(pool) {
  const total = pool.reduce((s, a) => s + a.weight, 0);
  let rand = Math.random() * total;
  for (const a of pool) {
    rand -= a.weight;
    if (rand <= 0) return a;
  }
  return pool[pool.length - 1];
}

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

export function initSandboxSection() {
  loadSandboxScenarioList();
}