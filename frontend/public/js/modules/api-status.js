/**
 * API Endpoint Status Module
 * Extracted from app.js — handles API endpoint health checks and status rendering.
 */

import { getApiBaseUrl } from '../api.js';

const API_ENDPOINTS = [
  { path: '/health', label: 'Health', group: 'System' },
  { path: '/api/health/system-status', label: 'System Issues', group: 'System' },
  { path: '/api/stats', label: 'Stats', group: 'System' },
  { path: '/api/wagers?limit=1', label: 'Wagers', group: 'Data' },
  { path: '/api/wagers/alerts', label: 'Alerts', group: 'Data' },
  { path: '/api/wagers/live', label: 'Live Wagers', group: 'Data' },
  { path: '/api/players/search?q=A17566', label: 'Player Search', group: 'Player 360' },
  { path: '/api/players/A17566/profile', label: 'Player Profile', group: 'Player 360' },
  { path: '/api/players/A17566/agent-context', label: 'Agent Context', group: 'Player 360' },
  { path: '/api/players/A17566/intelligence-map', label: 'Intel Map', group: 'Player 360' },
  { path: '/api/cross-reference?playerId=A17566', label: 'Cross-Refs', group: 'Player 360' },
  { path: '/api/players/A17566/deposits', label: 'Deposits', group: 'Player 360' },
  { path: '/api/players/A17566/account-snapshots', label: 'Snapshots', group: 'Player 360' },
  { path: '/api/players/A17566/links', label: 'Links', group: 'Player 360' },
  { path: '/api/players/A17566/flags', label: 'Flags', group: 'Player 360' },
  { path: '/api/players/A17566/notes', label: 'Notes', group: 'Player 360' },
  { path: '/api/players/A17566/export/wagers', label: 'Export Wagers', group: 'Player 360' },
  { path: '/api/players/A17566/export/access-logs', label: 'Export Access', group: 'Player 360' },
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

function getApiEndpoints(playerId = getStatusPlayerId()) {
  const safePlayer = encodeURIComponent(playerId || 'A17566');
  return API_ENDPOINTS.map((endpoint) => {
    let path = endpoint.path.replaceAll('A17566', safePlayer);
    if (endpoint.group === 'Player 360') path = path.replace('/api/players', '/api/v1/players');
    return { ...endpoint, path };
  });
}

function getPlayer360EndpointRegistry(playerId = getStatusPlayerId()) {
  const safePlayer = encodeURIComponent(playerId || 'A17566');
  return [
    { path: `/api/v1/players/search?q=${safePlayer}`, label: 'Search', group: 'Player 360', tab: 'Search', aspect: 'Player lookup', sources: ['wager_archive'] },
    { path: `/api/v1/players/${safePlayer}/profile`, label: 'Profile', group: 'Player 360', tab: 'Overview', aspect: 'Overview, wagers, performance, account shell', sources: ['wager_archive', 'agent_performance_snapshots', 'access_logs', 'player_transactions', 'deleted_transactions', 'deposits', 'customer_snapshots', 'player_links', 'player_flags', 'player_notes'] },
    { path: `/api/v1/players/${safePlayer}/intelligence-map`, label: 'Intel Map', group: 'Player 360', tab: 'Status / Docs', aspect: 'Coverage, status, freshness, gaps', sources: ['all'] },
    { path: `/api/v1/players/${safePlayer}/deposits`, label: 'Deposits', group: 'Player 360', tab: 'Deposits', aspect: 'Deposit-like transaction rows and IP match', sources: ['deposits', 'access_logs'] },
    { path: `/api/v1/players/${safePlayer}/transactions`, label: 'Transactions', group: 'Player 360', tab: 'Deposits', aspect: 'Full getTransactionList/getTransactionHistory/getReportDeletedTransactions account ledger', sources: ['player_transactions', 'deleted_transactions'] },
    { path: `/api/v1/players/${safePlayer}/account-snapshots`, label: 'Snapshots', group: 'Player 360', tab: 'Account', aspect: 'KYC, VIP, masked contact, currency', sources: ['customer_snapshots'] },
    { path: `/api/v1/players/${safePlayer}/links`, label: 'Links', group: 'Player 360', tab: 'Links', aspect: 'Multi-account evidence', sources: ['player_links', 'access_logs'] },
    { path: `/api/v1/players/${safePlayer}/flags`, label: 'Flags', group: 'Player 360', tab: 'Notes', aspect: 'Compliance flags', sources: ['player_flags'] },
    { path: `/api/v1/players/${safePlayer}/notes`, label: 'Notes', group: 'Player 360', tab: 'Notes', aspect: 'Operator notes', sources: ['player_notes'] },
    { path: `/api/v1/players/${safePlayer}/export/wagers`, label: 'Export Wagers', group: 'Player 360', tab: 'Wager History', aspect: 'Wager CSV export', sources: ['wager_archive'] },
    { path: `/api/v1/players/${safePlayer}/export/access-logs`, label: 'Export Access', group: 'Player 360', tab: 'Access Logs', aspect: 'Access CSV export', sources: ['access_logs'] },
    { path: `/api/v1/logs/access?limit=1`, label: 'Audit Access', group: 'Player 360', tab: 'Access Logs', aspect: 'Audit access-log fallback', sources: ['access_logs'] },
  ];
}

async function checkApiEndpoints() {
  const container = document.getElementById('apiEndpointList');
  const summary = document.getElementById('apiEndpointSummary');
  if (!container) return;

  container.innerHTML = '<div class="col-span-full" style="color:var(--text-dim);">Checking endpoints...</div>';

  const results = await Promise.allSettled(
    getApiEndpoints().map(async (ep) => {
      const start = performance.now();
      const res = await fetch(`${getApiBaseUrl()}${ep.path}`);
      const ms = Math.round(performance.now() - start);
      return { ...ep, status: res.status, ms };
    })
  );

  const entries = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { ...getApiEndpoints()[results.indexOf(r)], status: 0, ms: 0 }
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

function renderApiStatus() {
  const container = document.getElementById('apiStatusSection');
  if (!container) return;
  checkApiEndpoints();
}

function refreshApiStatus() {
  checkApiEndpoints();
}

function renderEndpointStatus() {
  // Placeholder for individual endpoint status rendering
}

// Window exports
window.renderApiStatus = renderApiStatus;
window.refreshApiStatus = refreshApiStatus;
