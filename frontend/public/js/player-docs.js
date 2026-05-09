export function createPlayerDocsRenderer(deps) {
  const {
    state,
    escapeHtml,
    formatShortDateTime,
    profileStatusChip,
    profileEmptyRow,
    fetchIntelligenceMap,
  } = deps;

  function renderDocs(profile) {
    const el = document.getElementById('playerProfileDocs');
    if (!el) return;
    const playerId = profile.playerId || state.playerId || 'PLAYER';
    const map = state.intelligenceMap;
    if (!map || map.playerId !== playerId) {
      el.innerHTML = '<div class="text-sm" style="color:var(--text-dim);">Loading live Player 360 data map...</div>';
      if (!state.docsLoading) {
        state.docsLoading = true;
        fetchIntelligenceMap(playerId)
          .then((payload) => {
            if (state.playerId !== playerId) return;
            state.intelligenceMap = payload;
            state.docsLoading = false;
            renderDocs(profile);
          })
          .catch((err) => {
            state.docsLoading = false;
            el.innerHTML = `<div class="text-sm" style="color:var(--red);">Failed to load intelligence map: ${escapeHtml(err?.message || err)}</div>`;
          });
      }
      return;
    }

    const architecture = [
      '+-------------------+      +-------------------------+',
      '| Buckeye Manager   | ---> | ScraperManager          |',
      '| getBetTicker LIVE |      | wager + access pollers  |',
      '| getWebLog LIVE    |      | player360 probe poller  |',
      '| customer probes   |      +-----------+-------------+',
      '+-------------------+                  |',
      '                                       v',
      '  +--------------------+ +-------------------------+',
      '  | confirmed live     | | probe / partial         |',
      '  | wager_archive      | | deposits                |',
      '  | access_logs        | | customer_snapshots      |',
      '  +---------+----------+ +-----------+-------------+',
      '            |                        |',
      '            v                        v',
      '  +--------------------+ +-------------------------+',
      '  | derived            | | manual                  |',
      '  | player_links       | | player_flags / notes    |',
      '  +---------+----------+ +-----------+-------------+',
      '            +------------+------------+',
      '                         v',
      '              +--------------------------+',
      '              | /api/players/:id/profile|',
      '              | /intelligence-map       |',
      '              +------------+-------------+',
      '                           v',
      '              +--------------------------+',
      '              | Player 360 modal + Status|',
      '              +--------------------------+',
    ].join('\n');
    const layout = [
      '+------------------------------------------------------------+',
      '| PLAYER PROFILE HEADER                                      |',
      '| player id | agent | wager count | sport | live bridge      |',
      '|                                      Docs Export Close      |',
      '+------------------------------------------------------------+',
      '| Overview | Wager History | Access Logs | Performance | ... |',
      '+------------------------------------------------------------+',
      '| Overview                                                   |',
      '| +---------+ +---------+ +---------+ +---------+ +--------+ |',
      '| | Volume  | | Open    | | WinRate | | Sport   | | Risk   | |',
      '| +---------+ +---------+ +---------+ +---------+ +--------+ |',
      '| +--------------------------+ +---------------------------+ |',
      '| | Risk meter + mini P&L    | | Latest wagers / live feed | |',
      '| +--------------------------+ +---------------------------+ |',
      '|                                                            |',
      '| Docs panel                                                 |',
      '| + coverage matrix + endpoint map + have/reuse/need lists   |',
      '+------------------------------------------------------------+',
    ].join('\n');

    el.innerHTML = `
      <div class="profile-doc-grid">
        <div class="profile-doc-panel profile-doc-wide">
          <h3>Coverage Matrix</h3>
          <div class="rounded-lg border overflow-auto" style="border-color:var(--border);">
            <table class="profile-table">
              <thead><tr><th>Source</th><th>Buckeye Endpoint</th><th>Local Table</th><th>Profile Use</th><th>Status</th><th>Refresh Policy</th><th>Rows</th><th>Last Seen</th><th>Last Attempt</th><th>Next Refresh</th><th>Gap</th></tr></thead>
              <tbody>${(map.sources || []).map(source => `<tr>
                <td class="font-mono">${escapeHtml(source.key || source.label || '')}</td>
                <td>${escapeHtml(source.buckeyeEndpoint || '-')}</td>
                <td class="font-mono">${escapeHtml(source.localTable || '-')}</td>
                <td>${escapeHtml(source.profileUse || '-')}</td>
                <td>${profileStatusChip(source.freshnessState || source.status)}</td>
                <td>${escapeHtml(source.refreshPolicy || '-')} / ${escapeHtml(source.scaleClass || '-')} / ${Number(source.ttlSeconds || 0).toLocaleString()}s</td>
                <td class="font-mono">${Number(source.rowCount || 0).toLocaleString()}</td>
                <td style="color:var(--text-dim);">${source.lastSeen ? formatShortDateTime(source.lastSeen) : '-'}</td>
                <td style="color:var(--text-dim);">${source.lastAttemptAt ? formatShortDateTime(source.lastAttemptAt) : '-'}</td>
                <td style="color:var(--text-dim);">${source.nextRefreshAt ? formatShortDateTime(source.nextRefreshAt) : '-'}</td>
                <td>${escapeHtml(source.gap || '-')}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
        <div class="profile-doc-panel">
          <h3>Endpoint Mapping</h3>
          <table class="profile-table">
            <tbody>
              <tr><th>Player</th><td class="font-mono">${escapeHtml(playerId)}</td></tr>
              <tr><th>Agent</th><td>${escapeHtml(map.agentLogin || '-')}</td></tr>
              <tr><th>Profile API</th><td class="font-mono">${escapeHtml(map.profileContract?.profile || '-')}</td></tr>
              <tr><th>Search API</th><td class="font-mono">${escapeHtml(map.profileContract?.search || '-')}</td></tr>
              <tr><th>Exports</th><td class="font-mono">${escapeHtml(map.profileContract?.exports?.wagers || '-')}<br>${escapeHtml(map.profileContract?.exports?.accessLogs || '-')}</td></tr>
              <tr><th>Audit Logs</th><td class="font-mono">${escapeHtml(map.profileContract?.audit?.accessLogs || '-')}</td></tr>
              <tr><th>Mutations</th><td class="font-mono">${escapeHtml(map.profileContract?.mutations?.flagCreate || '-')}<br>${escapeHtml(map.profileContract?.mutations?.noteCreate || '-')}<br>${escapeHtml(map.profileContract?.mutations?.multiAccountCheck || '-')}</td></tr>
              <tr><th>Live Feed</th><td>${escapeHtml(map.profileContract?.websocket || '-')}</td></tr>
            </tbody>
          </table>
          <div class="mt-3">
            <h3>Profile Tab Routes</h3>
            <table class="profile-table">
              <tbody>${Object.entries(map.profileContract?.tabs || {}).map(([tabName, routes]) => `<tr><th>${escapeHtml(tabName)}</th><td class="font-mono">${(routes || []).map(route => escapeHtml(route)).join('<br>')}</td></tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
        <div class="profile-doc-panel">
          <h3>Data We Have / Can Reuse / Need</h3>
          ${profileDocList('Have Now', map.coverage?.haveNow || [])}
          ${profileDocList('Can Reuse', map.coverage?.canReuse || [])}
          ${profileDocList('Need / Probe', map.coverage?.needOrProbe || [])}
          <div class="mt-3">
            <h3>Known Gaps</h3>
            <table class="profile-table">
              <tbody>${(map.gaps || []).map(gap => `<tr><th>${escapeHtml(gap.label || gap.key || '')}</th><td>${profileStatusChip(gap.status)} ${escapeHtml(gap.detail || '')}</td></tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
        <div class="profile-doc-panel">
          <h3>Freshness</h3>
          <table class="profile-table">
            <tbody>${Object.entries(map.freshness || {}).filter(([key]) => key !== 'watermarks').map(([key, value]) => `<tr>
              <th class="font-mono">${escapeHtml(key)}</th>
              <td>${Number(value?.rowCount || 0).toLocaleString()} rows</td>
              <td>${value?.lastSeen ? formatShortDateTime(value.lastSeen) : '-'}</td>
            </tr>`).join('')}
            <tr><th>Player 360 Poll</th><td colspan="2">${map.freshness?.watermarks?.player360 ? escapeHtml(JSON.stringify(map.freshness.watermarks.player360.value)) : 'No watermark'}</td></tr>
            <tr><th>Access Poll</th><td colspan="2">${map.freshness?.watermarks?.accessLogs ? escapeHtml(JSON.stringify(map.freshness.watermarks.accessLogs.value)) : 'No watermark'}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="profile-doc-panel profile-doc-wide">
          <h3>Field Contract</h3>
          <table class="profile-table">
            <thead><tr><th>Tab</th><th>Field</th><th>Route</th><th>Real Source</th><th>Status Rule</th></tr></thead>
            <tbody>${(map.fieldContract || []).map(row => `<tr>
              <td>${escapeHtml(row.tab || '-')}</td>
              <td class="font-mono">${escapeHtml(row.field || '-')}</td>
              <td class="font-mono">${escapeHtml(row.route || '-')}</td>
              <td>${escapeHtml(row.source || '-')}</td>
              <td>${escapeHtml(row.statusRule || '-')}</td>
            </tr>`).join('') || profileEmptyRow('No field contract returned by intelligence map.', 5)}</tbody>
          </table>
        </div>
        <div class="profile-doc-panel profile-doc-wide">
          <h3>Contract Mismatches To Track</h3>
          <table class="profile-table">
            <thead><tr><th>Severity</th><th>Field / Source</th><th>Status</th><th>Correction</th></tr></thead>
            <tbody>${(map.contractMismatches || []).map(row => `<tr>
              <td>${escapeHtml(row.severity || '-')}</td>
              <td>${escapeHtml(row.field || row.source || '-')}</td>
              <td>${profileStatusChip(row.status || 'missing')}</td>
              <td>${escapeHtml(row.action || '-')}</td>
            </tr>`).join('') || profileEmptyRow('No contract mismatches for this player right now.', 4)}</tbody>
          </table>
        </div>
        <div class="profile-doc-panel">
          <h3>Keyboard Help</h3>
          <table class="profile-table">
            <tbody>
              <tr><th>Esc</th><td>Close the Player Profile modal and clear state.</td></tr>
              <tr><th>Docs</th><td>Open this live endpoint and data coverage map.</td></tr>
              <tr><th>Tab Buttons</th><td>Use tab order to move between Overview, Wager History, Access Logs, Performance, Deposits, Account, Links, and Notes.</td></tr>
              <tr><th>CSV Buttons</th><td>Export wagers or access logs from the live Player 360 profile.</td></tr>
            </tbody>
          </table>
        </div>
        <div class="profile-doc-panel">
          <h3>Architecture Diagram</h3>
          <pre class="profile-doc-pre">${escapeHtml(architecture)}</pre>
        </div>
        <div class="profile-doc-panel">
          <h3>ASCII Layout</h3>
          <pre class="profile-doc-pre">${escapeHtml(layout)}</pre>
        </div>
      </div>`;
  }

  function profileDocList(title, rows) {
    return `<div class="mb-3">
      <div class="text-[10px] uppercase tracking-wider font-semibold mb-2" style="color:var(--text-dim);">${escapeHtml(title)}</div>
      <div class="profile-doc-list">${rows.map(row => `<span>${escapeHtml(row)}</span>`).join('')}</div>
    </div>`;
  }

  return { renderDocs };
}
