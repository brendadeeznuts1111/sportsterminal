// frontend/public/js/prop-builder.js — Zone 3 Prop Builder Module
// Fetches getProps + getExtendedProps via /api/live/* backend routes
import { fetchPost } from './api.js?v=5.32.14';

let propCache = [];
let propSlipSelections = [];
let currentPropFilter = { sport: '', type: '', search: '' };

export function initPropBuilder() {
  console.log('[PropBuilder] initialized');
}

export async function loadProps() {
  const agentId = document.getElementById('propAgentId')?.value?.trim() || 'BILLY666';
  const grid = document.getElementById('propsGrid');
  if (!grid) return;

  grid.innerHTML = '<div class="text-xs p-4 text-center" style="color:var(--text-dim);">Loading props...</div>';

  try {
    const payload = await fetchPost('/api/live/props', { agentID: agentId });
    const data = payload.data || payload;

    propCache = normalizeProps(data);
    renderPropsGrid(propCache);
    updatePropCount(propCache.length);
  } catch (err) {
    console.error('[PropBuilder] loadProps failed:', err instanceof Error ? err.message : err);
    grid.innerHTML = `<div class="text-xs p-4 text-center" style="color:var(--red);">Failed to load props: ${err instanceof Error ? err.message : 'Unknown error'}</div>`;
  }
}

export async function loadExtendedProps() {
  const agentId = document.getElementById('propAgentId')?.value?.trim() || 'BILLY666';
  const grid = document.getElementById('propsGrid');
  if (!grid) return;

  grid.innerHTML = '<div class="text-xs p-4 text-center" style="color:var(--text-dim);">Loading extended props...</div>';

  try {
    const payload = await fetchPost('/api/live/extendedProps', { agentID: agentId });
    const data = payload.data || payload;

    propCache = normalizeProps(data);
    renderPropsGrid(propCache);
    updatePropCount(propCache.length);
  } catch (err) {
    console.error('[PropBuilder] loadExtendedProps failed:', err instanceof Error ? err.message : err);
    grid.innerHTML = `<div class="text-xs p-4 text-center" style="color:var(--red);">Failed to load extended props: ${err instanceof Error ? err.message : 'Unknown error'}</div>`;
  }
}

export async function fetchPropBuilderURL() {
  const el = document.getElementById('propBuilderUrl');
  if (!el) return;
  el.textContent = 'Loading...';

  try {
    const payload = await fetchPost('/api/live/propBuilderURL');
    const url = payload.data || payload;
    el.textContent = typeof url === 'string' ? url : JSON.stringify(url);
  } catch (err) {
    console.error('[PropBuilder] fetchPropBuilderURL failed:', err instanceof Error ? err.message : err);
    el.textContent = `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
}

function normalizeProps(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normalizePropItem);
  if (raw.LIST && Array.isArray(raw.LIST)) return raw.LIST.map(normalizePropItem);
  if (raw.props && Array.isArray(raw.props)) return raw.props.map(normalizePropItem);
  if (raw.data && Array.isArray(raw.data)) return raw.data.map(normalizePropItem);
  if (typeof raw === 'object') return [normalizePropItem(raw)];
  return [];
}

function normalizePropItem(item) {
  if (!item || typeof item !== 'object') return { id: 'unknown', description: String(item), type: 'unknown', sport: '', line: null, odds: null };
  return {
    id: item.id || item.propID || item.PropID || item.ID || Math.random().toString(36).slice(2, 8),
    description: item.description || item.Description || item.name || item.Name || item.prop || 'Unknown prop',
    type: item.type || item.Type || item.propType || 'player',
    sport: item.sport || item.Sport || item.league || item.League || '',
    player: item.player || item.Player || item.playerName || '',
    team: item.team || item.Team || item.teamName || '',
    game: item.game || item.Game || item.gameId || '',
    line: item.line !== undefined ? item.line : (item.Line || item.point || item.Point || null),
    odds: item.odds !== undefined ? item.odds : (item.Odds || item.price || item.Price || null),
    side: item.side || item.Side || item.overUnder || '',
    status: item.status || item.Status || 'open',
    category: item.category || item.Category || '',
  };
}

function renderPropsGrid(props) {
  const grid = document.getElementById('propsGrid');
  if (!grid) return;

  if (props.length === 0) {
    grid.innerHTML = '<div class="text-xs p-4 text-center" style="color:var(--text-dim);">No props found for this agent.</div>';
    return;
  }

  grid.innerHTML = props.map(p => `
    <div class="prop-card rounded-lg border p-3 cursor-pointer transition-all hover:border-orange-500" style="background:var(--panel);border-color:var(--border);" data-prop-id="${p.id}" onclick="togglePropSelection('${p.id}')">
      <div class="flex items-center justify-between mb-1">
        <div class="flex items-center gap-2">
          <span class="text-xs px-1.5 py-0.5 rounded font-medium" style="background:var(--accent);color:#fff;">${p.sport || 'ALL'}</span>
          <span class="text-xs px-1.5 py-0.5 rounded" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">${p.type}</span>
          ${p.status !== 'open' ? `<span class="text-xs px-1.5 py-0.5 rounded" style="background:var(--red);color:#fff;">${p.status}</span>` : ''}
        </div>
        <div class="text-xs font-mono font-bold" style="color:var(--green);">${formatOdds(p.odds)}</div>
      </div>
      <div class="text-sm font-medium mb-1">${escapeHtml(p.description)}</div>
      <div class="flex items-center gap-3 text-xs" style="color:var(--text-dim);">
        ${p.player ? `<span>Player: ${escapeHtml(p.player)}</span>` : ''}
        ${p.team ? `<span>Team: ${escapeHtml(p.team)}</span>` : ''}
        ${p.line !== null ? `<span class="font-mono">Line: ${p.line}</span>` : ''}
        ${p.side ? `<span>Side: ${p.side}</span>` : ''}
      </div>
    </div>
  `).join('');
}

function updatePropCount(count) {
  const el = document.getElementById('propCount');
  if (el) el.textContent = String(count);
}

function formatOdds(odds) {
  if (odds === null || odds === undefined) return '—';
  const n = Number(odds);
  if (!Number.isFinite(n)) return String(odds);
  if (n > 0) return `+${n}`;
  return `${n}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function filterPropsBySport(sport) {
  currentPropFilter.sport = sport;
  applyPropFilters();
}

export function filterPropsByType(type) {
  currentPropFilter.type = type;
  applyPropFilters();
}

export function searchProps(query) {
  currentPropFilter.search = query.toLowerCase().trim();
  applyPropFilters();
}

function applyPropFilters() {
  let filtered = propCache;
  if (currentPropFilter.sport) {
    filtered = filtered.filter(p => p.sport === currentPropFilter.sport);
  }
  if (currentPropFilter.type) {
    filtered = filtered.filter(p => p.type === currentPropFilter.type);
  }
  if (currentPropFilter.search) {
    filtered = filtered.filter(p =>
      p.description.toLowerCase().includes(currentPropFilter.search) ||
      p.player.toLowerCase().includes(currentPropFilter.search) ||
      p.team.toLowerCase().includes(currentPropFilter.search)
    );
  }
  renderPropsGrid(filtered);
  updatePropCount(filtered.length);
}

export function togglePropSelection(id) {
  const idx = propSlipSelections.findIndex(s => s.id === id);
  if (idx >= 0) {
    propSlipSelections.splice(idx, 1);
  } else {
    const prop = propCache.find(p => p.id === id);
    if (prop) propSlipSelections.push(prop);
  }
  renderPropSlip();
  highlightSelectedProps();
}

function highlightSelectedProps() {
  document.querySelectorAll('.prop-card').forEach(card => {
    const id = card.getAttribute('data-prop-id');
    const selected = propSlipSelections.some(s => s.id === id);
    if (selected) {
      card.style.borderColor = 'var(--accent)';
      card.style.background = 'rgba(255,140,0,0.05)';
    } else {
      card.style.borderColor = 'var(--border)';
      card.style.background = 'var(--panel)';
    }
  });
}

function renderPropSlip() {
  const slip = document.getElementById('propSlip');
  if (!slip) return;

  if (propSlipSelections.length === 0) {
    slip.innerHTML = '<div class="text-xs text-center py-4" style="color:var(--text-dim);">No props selected</div>';
    updateToWin();
    return;
  }

  slip.innerHTML = propSlipSelections.map(s => `
    <div class="flex items-center justify-between p-2 rounded text-xs" style="background:var(--bg);border:1px solid var(--border);">
      <div class="flex-1 min-w-0">
        <div class="font-medium truncate">${escapeHtml(s.description)}</div>
        <div class="text-xs" style="color:var(--text-dim);">${s.sport} • ${s.type} • ${formatOdds(s.odds)}</div>
      </div>
      <button onclick="togglePropSelection('${s.id}')" class="ml-2 px-1.5 py-0.5 rounded text-xs" style="background:var(--red);color:#fff;">×</button>
    </div>
  `).join('');
  updateToWin();
}

function updateToWin() {
  const riskEl = document.getElementById('propRisk');
  const toWinEl = document.getElementById('propToWin');
  if (!riskEl || !toWinEl) return;

  const risk = Number(riskEl.value) || 0;
  let totalOdds = 1;
  for (const s of propSlipSelections) {
    const o = Number(s.odds) || 0;
    if (o > 0) totalOdds *= (1 + o / 100);
    else if (o < 0) totalOdds *= (1 + 100 / Math.abs(o));
  }
  const toWin = risk * (totalOdds - 1);
  toWinEl.textContent = `$${toWin.toFixed(2)}`;
}

export function clearPropSlip() {
  propSlipSelections = [];
  renderPropSlip();
  highlightSelectedProps();
}

// Expose to window for onclick handlers
if (typeof window !== 'undefined') {
  window.loadProps = loadProps;
  window.loadExtendedProps = loadExtendedProps;
  window.fetchPropBuilderURL = fetchPropBuilderURL;
  window.filterPropsBySport = filterPropsBySport;
  window.filterPropsByType = filterPropsByType;
  window.searchProps = searchProps;
  window.togglePropSelection = togglePropSelection;
  window.clearPropSlip = clearPropSlip;
}
