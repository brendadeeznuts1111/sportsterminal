const LIVE_SPORT_ICONS = {
  Football: '\u{1F3C8}',
  Basketball: '\u{1F3C0}',
  Baseball: '\u26BE',
  Soccer: '\u26BD',
  Hockey: '\u{1F3D2}',
  Tennis: '\u{1F3BE}',
  Golf: '\u26F3',
  MMA: '\u{1F94A}',
  Boxing: '\u{1F94A}',
  default: '\u{1F3AF}',
};

let liveData = { events: [], scores: [], sports: [] };
let livePollInterval = null;
let liveFlashPrev = new Map();

import { fetchPost } from './api.js';

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function formatScore(n) {
  if (n === null || n === undefined || n === 0) return '0';
  return String(n);
}

async function fetchLiveScores() {
  try {
    const json = await fetchPost('/api/proxy/Report/getScoresLiveDynamic', { operation: 'getScoresLiveDynamic', agentSite: '1', RRO: '1' });
    return json.data?.scores || json.data?.items || json.scores || [];
  } catch (err) {
    console.warn('[Live] fetchLiveScores failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function fetchDynamicLive() {
  try {
    const json = await fetchPost('/api/proxy/Manager/getDynamicLive', { operation: 'getDynamicLive', agentSite: '1', RRO: '1', live: '1' });
    return json.data?.events || json.data?.items || json.events || [];
  } catch (err) {
    console.warn('[Live] fetchDynamicLive failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function fetchLiveSports() {
  try {
    const json = await fetchPost('/api/proxy/Manager/getSportsTypesLive', { operation: 'getSportsTypesLive', agentSite: '1', RRO: '1' });
    return json.data?.sports || json.data?.items || json.sports || [];
  } catch (err) {
    console.warn('[Live] fetchLiveSports failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

function detectFlash(ev) {
  const prev = liveFlashPrev.get(ev.id);
  if (!prev) return false;
  return prev.awayScore !== (ev.awayScore ?? 0) || prev.homeScore !== (ev.homeScore ?? 0);
}

function renderScoreCard(ev) {
  const isFlash = detectFlash(ev);
  const icon = LIVE_SPORT_ICONS[ev.sport] || LIVE_SPORT_ICONS.default;
  const flashClass = isFlash ? 'ring-2 ring-green-400' : '';
  const statusColor = ev.status === 'LIVE' ? 'var(--green)' : ev.status === 'FINAL' ? 'var(--text-dim)' : 'var(--yellow)';

  return `
    <div class="rounded-lg border p-3 ${flashClass} transition-all" style="background:var(--panel);border-color:var(--border);">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <span class="text-sm">${icon}</span>
          <span class="text-xs font-medium" style="color:var(--text-dim);">${escapeHtml(ev.sport || '')}</span>
        </div>
        <span class="text-xs px-2 py-0.5 rounded-full font-medium" style="background:${statusColor};color:#000;">${escapeHtml(ev.period || ev.status || 'LIVE')}</span>
      </div>
      <div class="space-y-1">
        <div class="flex justify-between items-center text-sm">
          <span class="font-medium" style="color:var(--text);">${escapeHtml(ev.away || 'Away')}</span>
          <span class="font-bold text-lg ${isFlash ? 'text-green-400' : ''}" style="color:${isFlash ? 'var(--green)' : 'var(--text)'};">${formatScore(ev.awayScore)}</span>
        </div>
        <div class="flex justify-between items-center text-sm">
          <span class="font-medium" style="color:var(--text);">${escapeHtml(ev.home || 'Home')}</span>
          <span class="font-bold text-lg ${isFlash ? 'text-green-400' : ''}" style="color:${isFlash ? 'var(--green)' : 'var(--text)'};">${formatScore(ev.homeScore)}</span>
        </div>
      </div>
      ${ev.timeRemaining ? `<div class="mt-1 text-xs text-center" style="color:var(--text-dim);">${escapeHtml(ev.timeRemaining)}</div>` : ''}
    </div>`;
}

function renderLineCard(ev) {
  const lines = Array.isArray(ev.lines) ? ev.lines : [];
  if (lines.length === 0) return '';

  return `
    <div class="rounded-lg border p-3" style="background:var(--panel);border-color:var(--border);">
      <div class="text-xs font-medium mb-2" style="color:var(--text-dim);">${escapeHtml(ev.away || 'Away')} @ ${escapeHtml(ev.home || 'Home')}</div>
      <div class="space-y-1">
        ${lines.slice(0, 6).map(line => {
          const typeLabel = line.WagerType || line.wagerType || line.lineType || 'ML';
          const odds = line.Odds || line.odds || line.FinalMoney || '';
          const value = line.Line || line.line || line.RunLine || '';
          return `<div class="flex justify-between text-xs" style="color:var(--text);">
            <span>${escapeHtml(typeLabel)}${value ? ' ' + escapeHtml(String(value)) : ''}</span>
            <span class="font-medium">${escapeHtml(String(odds))}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

function renderLiveSection() {
  const filter = document.getElementById('liveSportFilter')?.value || '';
  const scoresGrid = document.getElementById('liveScoresGrid');
  const linesPanel = document.getElementById('liveLinesPanel');

  if (!scoresGrid || !linesPanel) return;

  const filtered = filter
    ? liveData.scores.filter(ev => (ev.sport || '').toLowerCase() === filter.toLowerCase())
    : liveData.scores;

  const badge = document.getElementById('liveCount');
  if (badge) {
    badge.textContent = String(filtered.length);
    badge.classList.toggle('hidden', filtered.length === 0);
  }

  scoresGrid.innerHTML = filtered.length > 0
    ? filtered.map(ev => renderScoreCard(ev)).join('')
    : '<div class="text-sm py-8 text-center" style="color:var(--text-dim);">No live games found. Connect to a Buckeye agent to load live scores.</div>';

  const filteredEvents = filter
    ? liveData.events.filter(ev => (ev.sport || '').toLowerCase() === filter.toLowerCase())
    : liveData.events;

  linesPanel.innerHTML = filteredEvents.length > 0
    ? filteredEvents.slice(0, 10).map(ev => renderLineCard(ev)).join('')
    : '<div class="text-xs py-4 text-center" style="color:var(--text-dim);">No live lines available</div>';
}

function updateSportFilter() {
  const select = document.getElementById('liveSportFilter');
  if (!select) return;
  const current = select.value;
  const sports = liveData.sports || [];
  const uniqueSports = [...new Set([
    ...sports.map(s => s.name || s.Sport || s.SportType).filter(Boolean),
    ...liveData.scores.map(s => s.sport).filter(Boolean)
  ])];
  select.innerHTML = '<option value="">All Sports</option>' + uniqueSports.map(s =>
    `<option value="${escapeHtml(s)}" ${s === current ? 'selected' : ''}>${escapeHtml(s)}</option>`
  ).join('');
}

async function loadLiveSection() {
  const [scores, events, sports] = await Promise.all([
    fetchLiveScores(),
    fetchDynamicLive(),
    fetchLiveSports(),
  ]);

  if (scores) {
    scores.forEach(ev => {
      const prev = liveFlashPrev.get(ev.id);
      if (prev && (prev.awayScore !== (ev.awayScore ?? 0) || prev.homeScore !== (ev.homeScore ?? 0))) {
        ev._flash = true;
      }
      liveFlashPrev.set(ev.id, { awayScore: ev.awayScore ?? 0, homeScore: ev.homeScore ?? 0 });
    });
    liveData.scores = scores;
  }

  liveData.events = events || liveData.events;
  liveData.sports = sports || liveData.sports;

  updateSportFilter();
  renderLiveSection();
}

function refreshLive() {
  return loadLiveSection();
}

function startLivePolling() {
  stopLivePolling();
  loadLiveSection();
  livePollInterval = setInterval(loadLiveSection, 10000);
}

function stopLivePolling() {
  if (livePollInterval) {
    clearInterval(livePollInterval);
    livePollInterval = null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const filter = document.getElementById('liveSportFilter');
  if (filter) filter.addEventListener('change', renderLiveSection);
});

if (typeof window !== 'undefined') {
  window.loadLiveSection = loadLiveSection;
  window.refreshLive = refreshLive;
  window.startLivePolling = startLivePolling;
  window.stopLivePolling = stopLivePolling;
  window.handleLiveFlash = handleLiveFlash;

  function handleLiveFlash(ev) {
  const idx = liveData.scores.findIndex(s => s.id === ev.id);
  if (idx >= 0) {
    liveData.scores[idx]._flash = true;
    liveData.scores[idx].awayScore = ev.awayScore;
    liveData.scores[idx].homeScore = ev.homeScore;
  }
  liveFlashPrev.set(ev.id, { awayScore: ev.awayScore ?? 0, homeScore: ev.homeScore ?? 0 });
  renderLiveSection();
  setTimeout(() => {
    liveData.scores.forEach(s => s._flash = false);
    renderLiveSection();
  }, 3000);
}
}

export { loadLiveSection, refreshLive, startLivePolling, stopLivePolling };
