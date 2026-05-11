/**
 * Odds Matrix Module
 * Extracted from app.js lines ~2940-3895.
 * Handles odds matrix rendering, zone1 taxonomy, tooltip system,
 * book settings modal, and consensus modal.
 */

import { getApiBaseUrl } from '../api.js?v=5.32.14';
import { escapeHtml, escapeJs, formatShortDateTime } from '../utils.js';
import { get, set } from './state.js';

// ==================== CONSTANTS ====================
const DEFAULT_BOOK_ORDER = ['PIN', 'BOL', 'BOV', 'BUC', 'ACE', 'MET', 'DK', 'FD', 'MGM', 'CZR', 'PB', 'BR', 'BS', 'SBO', 'STK', 'NIT'];
const ALL_SPORTS = ['all', 'NBA', 'NCAAB', 'MLB', 'NHL', 'NFL', 'Soccer'];

// ==================== STATE INITIALIZATION ====================
if (!get('currentMatrixData')) set('currentMatrixData', { games: [], books: [], movements: [] });
if (!get('currentBookHealth')) set('currentBookHealth', {});
if (!get('matrixState')) {
  set('matrixState', {
    sport: 'all',
    market: 'spread',
    search: '',
    sort: 'startTime',
    showConsensus: true,
    expandedGame: null,
  });
}
if (!get('zone1TaxonomyState')) {
  set('zone1TaxonomyState', {
    sports: [],
    leagues: [],
    games: [],
    lines: [],
    selectedSport: '',
    selectedLeague: '',
    selectedGame: '',
    loading: '',
    error: '',
    source: '',
    lastLoadedAt: 0,
  });
}
if (!get('bookPreferences')) {
  set('bookPreferences', loadBookPreferences());
}
if (!get('oddsFormat')) set('oddsFormat', 'american');

// ==================== BOOK PREFERENCES ====================
export function loadBookPreferences() {
  try {
    const raw = localStorage.getItem('bookPreferences');
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {
    order: [...DEFAULT_BOOK_ORDER],
    visible: ['PIN', 'BOL', 'BOV', 'BUC', 'ACE', 'MET'],
  };
}

export function saveBookPreferences(prefs) {
  localStorage.setItem('bookPreferences', JSON.stringify(prefs));
  set('bookPreferences', prefs);
}

// ==================== ODDS DATA ====================
export async function loadOddsData(force = false) {
  if (!force && typeof isCacheFresh === 'function' && isCacheFresh('odds')) {
    renderOddsMatrix();
    return;
  }

  let url = '';
  try {
    const bookPreferences = get('bookPreferences') || loadBookPreferences();
    const visibleBooks = bookPreferences.visible.join(',');
    const matrixState = get('matrixState');
    const sportParam = matrixState.sport !== 'all' ? `&sport=${encodeURIComponent(matrixState.sport)}` : '';
    url = `${getApiBaseUrl()}/api/odds/live?books=${visibleBooks}${sportParam}`;
    const oddsRes = await fetch(url);

    if (oddsRes.ok) {
      const data = await oddsRes.json();
      set('currentMatrixData', data);
      const health = {};
      (data.books || []).forEach(h => { health[h.key] = h.status; });
      set('currentBookHealth', health);
      if (typeof indexMovements === 'function') indexMovements(data.movements);
      if (typeof markCacheFresh === 'function') markCacheFresh('odds');
    }

    renderOddsMatrix();
  } catch (err) {
    console.error('Failed to load odds:', err?.message || err, '| URL:', url);
    renderDemoOddsMatrix();
  }
}

// ==================== ZONE1 TAXONOMY ====================
export async function loadZone1Taxonomy(force = false) {
  const panel = document.getElementById('zone1TaxonomyPanel');
  if (!panel) return;
  const zone1TaxonomyState = get('zone1TaxonomyState');
  if (!force && zone1TaxonomyState.sports.length && Date.now() - zone1TaxonomyState.lastLoadedAt < 300000) {
    renderZone1Taxonomy();
    return;
  }
  zone1TaxonomyState.loading = 'sports';
  zone1TaxonomyState.error = '';
  set('zone1TaxonomyState', zone1TaxonomyState);
  renderZone1Taxonomy();
  try {
    const payload = await fetchZone1Taxonomy('sports');
    zone1TaxonomyState.sports = Array.isArray(payload.data) ? payload.data : [];
    zone1TaxonomyState.source = payload.source || '';
    zone1TaxonomyState.lastLoadedAt = Date.now();
  } catch (err) {
    zone1TaxonomyState.sports = ALL_SPORTS
      .filter(sport => sport !== 'all')
      .map(sport => ({ id: sport, code: sport, name: sport }));
    zone1TaxonomyState.source = 'local';
    zone1TaxonomyState.lastLoadedAt = Date.now();
    zone1TaxonomyState.error = err?.message || 'Live taxonomy unavailable; showing local sports.';
  } finally {
    zone1TaxonomyState.loading = '';
    set('zone1TaxonomyState', zone1TaxonomyState);
    renderZone1Taxonomy();
  }
}

export async function fetchZone1Taxonomy(level, params = {}) {
  const proxy = typeof getZone2ProxyCredentials === 'function' ? getZone2ProxyCredentials() : {
    token: localStorage.getItem('buckeye_token') || localStorage.getItem('buckeyeToken') || '',
    cf: localStorage.getItem('cf_clearance') || '',
    cfBm: localStorage.getItem('__cf_bm') || '',
    baseUrl: localStorage.getItem('proxyBaseUrl') || 'http://localhost:3001',
  };
  if (!proxy.token || !proxy.cf) {
    throw new Error('Add buckeye_token and cf_clearance in Settings/localStorage to load Buckeye taxonomy.');
  }
  const headers = { 'Content-Type': 'application/json' };
  const proxyApiKey = localStorage.getItem('proxyApiKey');
  if (proxyApiKey) headers['X-API-Key'] = proxyApiKey;
  const agentID = localStorage.getItem('agentId') || params.customerID || '';
  const res = await fetch(`${proxy.baseUrl}/api/proxy/taxonomy/${level}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      token: proxy.token,
      cf_clearance: proxy.cf,
      __cf_bm: proxy.cfBm,
      customerID: agentID,
      agentID,
      ...params,
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) throw new Error(payload.error || `Taxonomy ${level} failed (${res.status})`);
  return payload;
}

export function renderZone1Taxonomy() {
  const panel = document.getElementById('zone1TaxonomyPanel');
  if (!panel) return;
  const state = get('zone1TaxonomyState');
  const selectedSport = state.sports.find(s => zone1TaxonomyKey(s) === state.selectedSport);
  const selectedLeague = state.leagues.find(l => zone1TaxonomyKey(l) === state.selectedLeague);
  const selectedGame = state.games.find(g => zone1TaxonomyKey(g) === state.selectedGame);
  const status = state.error
    ? `<span style="color:var(--red);">${escapeHtml(state.error)}</span>`
    : state.loading
      ? `Loading ${escapeHtml(state.loading)}...`
      : state.lastLoadedAt
        ? `${state.source || 'taxonomy'} · ${new Date(state.lastLoadedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
        : 'Ready';

  panel.innerHTML = `
    <div class="rounded-lg border overflow-hidden" style="background:var(--panel);border-color:var(--border);">
      <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b" style="border-color:var(--border);">
        <div>
          <div class="text-xs font-bold uppercase tracking-wider" style="color:var(--accent);">Zone 1 Taxonomy</div>
          <div class="text-[11px]" style="color:var(--text-dim);">${status}</div>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-[11px]" style="color:var(--text-dim);">
          <span>${state.sports.length} sports</span>
          <span>${state.leagues.length} leagues</span>
          <span>${state.games.length} games</span>
          <span>${state.lines.length} lines</span>
          <button type="button" class="px-2 py-1 rounded" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" onclick="loadZone1Taxonomy(true)">Refresh</button>
        </div>
      </div>
      <div class="grid gap-2 p-3" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));">
        ${zone1TaxonomyColumn('Sports', state.sports, state.selectedSport, 'selectZone1Sport', 'No sports loaded')}
        ${zone1TaxonomyColumn(selectedSport ? `Leagues · ${selectedSport.code || selectedSport.name || state.selectedSport}` : 'Leagues', state.leagues, state.selectedLeague, 'selectZone1League', selectedSport ? 'No leagues returned' : 'Pick a sport')}
        ${zone1TaxonomyColumn(selectedLeague ? `Games · ${selectedLeague.code || selectedLeague.name || state.selectedLeague}` : 'Games', state.games, state.selectedGame, 'selectZone1Game', selectedLeague ? 'No games returned' : 'Pick a league')}
        ${zone1LinesColumn(selectedGame)}
      </div>
    </div>
  `;
}

export function zone1TaxonomyColumn(title, rows, selectedKey, action, emptyText) {
  const body = rows.length
    ? rows.slice(0, 30).map(row => {
      const key = zone1TaxonomyKey(row);
      const label = zone1TaxonomyLabel(row);
      const sub = zone1TaxonomySubLabel(row);
      const active = key === selectedKey;
      return `<button type="button" class="w-full text-left px-2 py-1.5 rounded mb-1" style="background:${active ? 'rgba(245,158,11,0.14)' : 'var(--bg)'};border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};color:var(--text);" onclick="${action}('${escapeJs(key)}')">
        <span class="block text-xs font-semibold">${escapeHtml(label)}</span>
        ${sub ? `<span class="block text-[10px]" style="color:var(--text-dim);">${escapeHtml(sub)}</span>` : ''}
      </button>`;
    }).join('')
    : `<div class="px-2 py-4 text-center text-xs" style="color:var(--text-dim);">${escapeHtml(emptyText)}</div>`;
  return `<div>
    <div class="text-[10px] uppercase tracking-wider mb-2" style="color:var(--text-dim);">${escapeHtml(title)}</div>
    <div style="max-height:220px;overflow:auto;">${body}</div>
  </div>`;
}

export function zone1LinesColumn(game) {
  const state = get('zone1TaxonomyState');
  const lines = state.lines || [];
  const title = game ? `Lines · ${zone1GameLabel(game)}` : 'Lines';
  if (!game) {
    return `<div><div class="text-[10px] uppercase tracking-wider mb-2" style="color:var(--text-dim);">${title}</div><div class="px-2 py-4 text-center text-xs" style="color:var(--text-dim);">Pick a game</div></div>`;
  }
  const body = lines.length
    ? lines.slice(0, 40).map(line => {
      const type = line.type || line.wagerTypeName || 'LINE';
      const side = line.side ? `${line.side} ` : '';
      const price = Number(line.odds || line.moneyline || 0);
      const priceText = price ? `${price > 0 ? '+' : ''}${price}` : '—';
      const value = line.line ?? line.points ?? line.spread ?? line.moneyline ?? '—';
      return `<div class="grid gap-2 px-2 py-1.5 border-b text-xs" style="grid-template-columns:72px 1fr 56px;border-color:var(--border);">
        <span style="color:var(--accent);">${escapeHtml(type)}</span>
        <span>${escapeHtml(side)}${escapeHtml(value)}</span>
        <span class="font-mono text-right">${escapeHtml(priceText)}</span>
      </div>`;
    }).join('')
    : `<div class="px-2 py-4 text-center text-xs" style="color:var(--text-dim);">No lines returned</div>`;
  return `<div>
    <div class="text-[10px] uppercase tracking-wider mb-2" style="color:var(--text-dim);">${escapeHtml(title)}</div>
    <div style="max-height:220px;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:6px;">${body}</div>
  </div>`;
}

export function zone1TaxonomyKey(row) {
  return String(row?.code || row?.id || row?.name || '').trim();
}

export function zone1TaxonomyLabel(row) {
  if (!row) return '';
  if (row.away || row.home) return zone1GameLabel(row);
  return String(row.name || row.code || row.id || '').trim();
}

export function zone1TaxonomySubLabel(row) {
  if (!row) return '';
  if (row.away || row.home) {
    const status = row.status ? `${row.status} · ` : '';
    return `${status}${row.datetime ? formatShortDateTime(row.datetime) : ''}`;
  }
  return [row.code, row.region, row.season, row.sport].filter(Boolean).join(' · ');
}

export function zone1GameLabel(game) {
  const away = game?.away?.team || game?.away || 'Away';
  const home = game?.home?.team || game?.home || 'Home';
  return `${away} @ ${home}`;
}

export async function selectZone1Sport(sportKey) {
  const zone1TaxonomyState = get('zone1TaxonomyState');
  zone1TaxonomyState.selectedSport = sportKey;
  zone1TaxonomyState.selectedLeague = '';
  zone1TaxonomyState.selectedGame = '';
  zone1TaxonomyState.leagues = [];
  zone1TaxonomyState.games = [];
  zone1TaxonomyState.lines = [];
  zone1TaxonomyState.error = '';
  set('zone1TaxonomyState', zone1TaxonomyState);
  syncZone1SportFilter(sportKey);
  zone1TaxonomyState.loading = 'leagues';
  set('zone1TaxonomyState', zone1TaxonomyState);
  renderZone1Taxonomy();
  try {
    const payload = await fetchZone1Taxonomy('leagues', { sport: sportKey });
    zone1TaxonomyState.leagues = Array.isArray(payload.data) ? payload.data : [];
  } catch (err) {
    zone1TaxonomyState.error = err?.message || 'Unable to load leagues.';
  } finally {
    zone1TaxonomyState.loading = '';
    set('zone1TaxonomyState', zone1TaxonomyState);
    renderZone1Taxonomy();
  }
}

export async function selectZone1League(leagueKey) {
  const zone1TaxonomyState = get('zone1TaxonomyState');
  zone1TaxonomyState.selectedLeague = leagueKey;
  zone1TaxonomyState.selectedGame = '';
  zone1TaxonomyState.games = [];
  zone1TaxonomyState.lines = [];
  zone1TaxonomyState.error = '';
  zone1TaxonomyState.loading = 'schedule';
  set('zone1TaxonomyState', zone1TaxonomyState);
  renderZone1Taxonomy();
  try {
    const payload = await fetchZone1Taxonomy('schedule', { sport: zone1TaxonomyState.selectedSport, league: leagueKey });
    zone1TaxonomyState.games = Array.isArray(payload.data) ? payload.data : [];
  } catch (err) {
    zone1TaxonomyState.error = err?.message || 'Unable to load schedule.';
  } finally {
    zone1TaxonomyState.loading = '';
    set('zone1TaxonomyState', zone1TaxonomyState);
    renderZone1Taxonomy();
  }
}

export async function selectZone1Game(gameKey) {
  const zone1TaxonomyState = get('zone1TaxonomyState');
  zone1TaxonomyState.selectedGame = gameKey;
  zone1TaxonomyState.lines = [];
  zone1TaxonomyState.error = '';
  zone1TaxonomyState.loading = 'lines';
  set('zone1TaxonomyState', zone1TaxonomyState);
  renderZone1Taxonomy();
  try {
    const payload = await fetchZone1Taxonomy('lines', {
      sport: zone1TaxonomyState.selectedSport,
      league: zone1TaxonomyState.selectedLeague,
      gameId: gameKey,
    });
    zone1TaxonomyState.lines = Array.isArray(payload.data) ? payload.data : [];
    const game = zone1TaxonomyState.games.find(g => zone1TaxonomyKey(g) === gameKey);
    if (game) {
      window.dispatchEvent(new CustomEvent('buckeye:focus', { detail: { game, source: 'taxonomy' } }));
    }
  } catch (err) {
    zone1TaxonomyState.error = err?.message || 'Unable to load lines.';
  } finally {
    zone1TaxonomyState.loading = '';
    set('zone1TaxonomyState', zone1TaxonomyState);
    renderZone1Taxonomy();
  }
}

export function syncZone1SportFilter(sportKey) {
  const normalized = ALL_SPORTS.includes(sportKey) ? sportKey : ALL_SPORTS.find(s => s.toLowerCase() === String(sportKey).toLowerCase());
  if (!normalized) return;
  const matrixState = get('matrixState');
  matrixState.sport = normalized;
  set('matrixState', matrixState);
  document.querySelectorAll('.sport-tab').forEach(btn => {
    const isActive = btn.dataset.sport === normalized;
    btn.classList.toggle('active', isActive);
    btn.style.background = isActive ? 'var(--accent)' : 'var(--panel)';
    btn.style.color = isActive ? '#fff' : 'var(--text-dim)';
    btn.style.border = isActive ? 'none' : '1px solid var(--border)';
  });
  loadOddsData(true);
}

export function renderDemoOddsMatrix() {
  if (typeof indexMovements === 'function') indexMovements([]);
  const grid = document.getElementById('oddsGrid');
  const mobile = document.getElementById('oddsGridMobile');
  if (grid) grid.innerHTML = '<div class="p-4 text-sm" style="color:var(--text-dim);">Odds backend unavailable. Start the backend to see live odds.</div>';
  if (mobile) mobile.innerHTML = '<div class="p-4 text-sm" style="color:var(--text-dim);">Odds backend unavailable.</div>';
}

// ==================== MATRIX HELPERS ====================
export function getVisibleBooks() {
  const currentMatrixData = get('currentMatrixData') || { games: [], books: [], movements: [] };
  const bookPreferences = get('bookPreferences') || loadBookPreferences();
  const currentBookHealth = get('currentBookHealth') || {};
  if (!currentMatrixData.books || currentMatrixData.books.length === 0) {
    return bookPreferences.visible.map(b => ({ key: b, name: b, status: currentBookHealth[b] || 'unknown' }));
  }
  const ordered = [];
  for (const key of bookPreferences.order) {
    const meta = currentMatrixData.books.find(b => b.key === key);
    if (meta && bookPreferences.visible.includes(key)) ordered.push(meta);
  }
  for (const meta of currentMatrixData.books) {
    if (bookPreferences.visible.includes(meta.key) && !ordered.find(b => b.key === meta.key)) {
      ordered.push(meta);
    }
  }
  return ordered;
}

export function getFilteredGames() {
  const currentMatrixData = get('currentMatrixData') || { games: [], books: [], movements: [] };
  const matrixState = get('matrixState');
  let games = currentMatrixData.games || [];
  if (matrixState.search) {
    const q = matrixState.search.toLowerCase();
    games = games.filter(g => g.home.toLowerCase().includes(q) || g.away.toLowerCase().includes(q));
  }
  games = [...games];
  if (matrixState.sort === 'startTime') {
    games.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  } else if (matrixState.sort === 'sport') {
    games.sort((a, b) => a.sport.localeCompare(b.sport) || new Date(a.startTime) - new Date(b.startTime));
  } else if (matrixState.sort === 'name') {
    games.sort((a, b) => a.away.localeCompare(b.away));
  }
  return games;
}

export function getMovement(gameId, book, market, side) {
  if (typeof currentMovementIndex !== 'undefined') {
    return currentMovementIndex[`${gameId}:${book}:${market}:${side}`] || null;
  }
  return null;
}

export function formatOddsValue(val, type) {
  const oddsFormat = get('oddsFormat') || 'american';
  if (val === null || val === undefined) return '—';
  if (oddsFormat === 'decimal') {
    if (val === 0) return '—';
    const dec = val > 0 ? (val / 100) + 1 : (100 / Math.abs(val)) + 1;
    return dec.toFixed(2);
  }
  if (type === 'spread' || type === 'total') {
    return (val > 0 ? '+' : '') + val.toFixed(1);
  }
  return (val > 0 ? '+' : '') + Math.round(val);
}

export function formatOddsCell(awayVal, homeVal, type, awayPrice, homePrice) {
  const awayStr = formatOddsValue(awayVal, type);
  const homeStr = formatOddsValue(homeVal, type);
  const awayPriceStr = (type === 'spread' || type === 'total') && awayPrice != null ? ` <span style="color:var(--text-dim);font-size:10px;">(${formatOddsValue(awayPrice, 'moneyline')})</span>` : '';
  const homePriceStr = (type === 'spread' || type === 'total') && homePrice != null ? ` <span style="color:var(--text-dim);font-size:10px;">(${formatOddsValue(homePrice, 'moneyline')})</span>` : '';
  return `<div class="odds-price">${awayStr}${awayPriceStr}</div><div class="odds-juice">${homeStr}${homePriceStr}</div>`;
}

export function findBestBook(games, market, side) {
  const bestByGame = {};
  for (const g of games) {
    let best = null;
    for (const book of Object.keys(g.books)) {
      const bookData = g.books[book];
      if (!bookData || !bookData[market]) continue;
      const val = bookData[market][side];
      if (val === null || val === undefined) continue;
      const isBetter = (market === 'moneyline')
        ? (best === null || val > best.val)
        : (best === null || val > best.val);
      if (isBetter) best = { book, val };
    }
    bestByGame[g.id] = best?.book || null;
  }
  return bestByGame;
}

// ==================== TOOLTIP SYSTEM ====================
const tooltipEl = document.getElementById('globalTooltip');
const tooltipContentEl = document.getElementById('globalTooltipContent');
let tooltipHideTimer = null;
let tooltipCache = {};
let tooltipIdCounter = 0;

export function cacheTooltip(html) {
  const id = 'tt_' + (tooltipIdCounter++);
  tooltipCache[id] = html;
  return id;
}

export function getCachedTooltip(id) {
  return tooltipCache[id] || '';
}

export function clearTooltipCache() {
  tooltipCache = {};
  tooltipIdCounter = 0;
}

export function showTooltip(targetEl, htmlContent) {
  if (!tooltipEl || !tooltipContentEl) return;
  tooltipContentEl.innerHTML = htmlContent;
  tooltipEl.classList.add('visible');

  const rect = targetEl.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - Math.min(tipRect.width, 320) / 2;

  if (left < 8) left = 8;
  if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
  if (top + tipRect.height > window.innerHeight - 8) top = rect.top - tipRect.height - 8;

  tooltipEl.style.top = top + 'px';
  tooltipEl.style.left = left + 'px';
}

export function hideTooltip() {
  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(() => {
    if (tooltipEl) tooltipEl.classList.remove('visible');
  }, 150);
}

export function keepTooltip() {
  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
}

if (tooltipEl) {
  tooltipEl.addEventListener('mouseenter', keepTooltip);
  tooltipEl.addEventListener('mouseleave', hideTooltip);
}

export function buildOddsCellTooltip(gameId, bookKey, market, side) {
  const currentMatrixData = get('currentMatrixData') || { games: [], books: [], movements: [] };
  const game = currentMatrixData.games.find(g => g.id === gameId);
  if (!game) return '';
  const bookData = game.books[bookKey];
  if (!bookData) return '';
  const mktData = bookData[market];
  if (!mktData) return '';

  const val = side === 'over' ? mktData.over : side === 'under' ? mktData.under : side === 'home' ? mktData.home : mktData.away;
  const otherSide = side === 'over' ? 'under' : side === 'under' ? 'over' : side === 'home' ? 'away' : 'home';
  const otherVal = side === 'over' ? mktData.under : side === 'under' ? mktData.over : side === 'home' ? mktData.away : mktData.home;
  const lastUpdated = mktData.lastUpdated ? new Date(mktData.lastUpdated).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '—';

  const price = (market === 'spread' || market === 'total') ? (side === 'over' ? mktData.overPrice : side === 'under' ? mktData.underPrice : side === 'home' ? mktData.homePrice : mktData.awayPrice) : null;
  const otherPrice = (market === 'spread' || market === 'total') ? (side === 'over' ? mktData.underPrice : side === 'under' ? mktData.overPrice : side === 'home' ? mktData.awayPrice : mktData.homePrice) : null;
  let html = `<div class="tooltip-header">${bookKey} — ${market.charAt(0).toUpperCase() + market.slice(1)}</div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Current</span><span class="tooltip-value">${formatOddsValue(val, market)}${price != null ? ' (' + formatOddsValue(price, 'moneyline') + ')' : ''}</span></div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Other Side</span><span class="tooltip-value">${formatOddsValue(otherVal, market)}${otherPrice != null ? ' (' + formatOddsValue(otherPrice, 'moneyline') + ')' : ''}</span></div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Last Update</span><span class="tooltip-value">${lastUpdated}</span></div>`;

  const msk = `${market}:${side}`;
  const recent = bookData.recentMoves?.[msk];
  if (recent && recent.length > 0) {
    html += `<div class="tooltip-section"><div class="tooltip-section-title">Recent Moves</div>`;
    for (const mov of recent.slice(0, 5)) {
      const t = new Date(mov.recorded_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      const arrow = mov.delta > 0 ? '▲' : '▼';
      html += `<div class="tooltip-move-row"><span class="tooltip-move-time">${t}</span><span class="tooltip-move-val">${formatOddsValue(mov.new_value, market)} ${arrow}${Math.abs(mov.delta).toFixed(1)}</span></div>`;
    }
    html += `</div>`;
  }

  const cons = game.consensus?.[market];
  if (cons) {
    const consVal = side === 'over' ? cons.over : side === 'under' ? cons.under : side === 'home' ? cons.home : cons.away;
    if (consVal !== null && val !== null) {
      const diff = val - consVal;
      const diffStr = diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
      const diffColor = diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--text-dim)';
      html += `<div class="tooltip-section"><div class="tooltip-section-title">vs Consensus</div>`;
      html += `<div class="tooltip-row"><span class="tooltip-label">PIN Line</span><span class="tooltip-value">${formatOddsValue(consVal, market)}</span></div>`;
      html += `<div class="tooltip-row"><span class="tooltip-label">Diff</span><span class="tooltip-value" style="color:${diffColor};">${diffStr}</span></div></div>`;
    }
  }

  const openLine = bookData.openLine?.[market];
  if (openLine) {
    const openVal = side === 'over' ? openLine.over : side === 'under' ? openLine.under : side === 'home' ? openLine.home : openLine.away;
    if (openVal !== null && val !== null) {
      const diff = val - openVal;
      const diffStr = diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
      html += `<div class="tooltip-section"><div class="tooltip-section-title">vs Open</div>`;
      html += `<div class="tooltip-row"><span class="tooltip-label">Open</span><span class="tooltip-value">${formatOddsValue(openVal, market)}</span></div>`;
      html += `<div class="tooltip-row"><span class="tooltip-label">Change</span><span class="tooltip-value">${diffStr}</span></div></div>`;
    }
  }

  return html;
}

export function buildMovementTooltip(movement) {
  if (!movement) return '';
  const t = new Date(movement.recorded_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const market = movement.market;
  const arrow = movement.delta > 0 ? '▲' : '▼';
  return `<div class="tooltip-header">Line Movement</div>
    <div class="tooltip-row"><span class="tooltip-label">Book</span><span class="tooltip-value">${movement.book}</span></div>
    <div class="tooltip-row"><span class="tooltip-label">From</span><span class="tooltip-value">${formatOddsValue(movement.old_value, market)}</span></div>
    <div class="tooltip-row"><span class="tooltip-label">To</span><span class="tooltip-value">${formatOddsValue(movement.new_value, market)}</span></div>
    <div class="tooltip-row"><span class="tooltip-label">Time</span><span class="tooltip-value">${t}</span></div>
    <div class="tooltip-alert">${arrow} ${Math.abs(movement.delta).toFixed(1)} at ${t}</div>`;
}

export function buildPatternTooltip(patternId) {
  const currentMatrixData = get('currentMatrixData') || { games: [], books: [], movements: [] };
  let pattern = currentMatrixData.patterns?.find(p => p.id === patternId);
  if (!pattern && typeof livePatterns !== 'undefined') pattern = livePatterns.get(patternId);
  if (!pattern) return '';
  const t = new Date(pattern.detectedAt || pattern.detected_at || Date.now()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  let html = `<div class="tooltip-header">${escapeHtml(pattern.type || 'Pattern')}</div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Detected</span><span class="tooltip-value">${t}</span></div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Trigger</span><span class="tooltip-value">${escapeHtml(pattern.triggerBook || pattern.trigger_book || '—')}</span></div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Severity</span><span class="tooltip-value" style="color:${pattern.severity === 'critical' ? 'var(--red)' : pattern.severity === 'warning' ? 'var(--yellow)' : 'var(--green)'}">${escapeHtml(pattern.severity || 'info')}</span></div>`;

  const followedBy = pattern.followedBy || pattern.followed_by || [];
  if (followedBy.length > 0) {
    html += `<div class="tooltip-section"><div class="tooltip-section-title">Followed By</div>`;
    for (const fb of followedBy) {
      const lagMs = fb.lagMs || fb.lag_ms || 0;
      const lag = lagMs > 60000 ? `${(lagMs / 60000).toFixed(1)}m` : `${(lagMs / 1000).toFixed(0)}s`;
      html += `<div class="tooltip-move-row"><span class="tooltip-move-time">${escapeHtml(fb.book || '—')}</span><span class="tooltip-move-val">${formatOddsValue(fb.newValue || fb.new_value, pattern.market || 'moneyline')} (+${lag} lag)</span></div>`;
    }
    html += `</div>`;
  }

  html += `<div class="tooltip-section" style="font-size:10px;color:var(--text-dim);">${escapeHtml(pattern.description || '')}</div>`;
  return html;
}

export function buildConsensusTooltip(gameId, market) {
  const currentMatrixData = get('currentMatrixData') || { games: [], books: [], movements: [] };
  const game = currentMatrixData.games.find(g => g.id === gameId);
  if (!game) return '';
  const cons = game.consensus?.[market];
  if (!cons) return '';
  const sides = market === 'total' ? ['over', 'under'] : ['away', 'home'];
  let html = `<div class="tooltip-header">Consensus — ${market.charAt(0).toUpperCase() + market.slice(1)}</div>`;
  html += `<div class="tooltip-row"><span class="tooltip-label">Source</span><span class="tooltip-value">Pinnacle</span></div>`;

  for (const side of sides) {
    const consVal = cons[side];
    const best = game.bestPrices?.[market]?.[side];
    html += `<div class="tooltip-section"><div class="tooltip-section-title">${side.charAt(0).toUpperCase() + side.slice(1)} Side</div>`;
    const consPrice = (market === 'spread' || market === 'total') ? cons[side === 'over' ? 'overPrice' : side === 'under' ? 'underPrice' : side === 'home' ? 'homePrice' : 'awayPrice'] : null;
    html += `<div class="tooltip-row"><span class="tooltip-label">Consensus</span><span class="tooltip-value">${formatOddsValue(consVal, market)}${consPrice != null ? ' (' + formatOddsValue(consPrice, 'moneyline') + ')' : ''}</span></div>`;
    if (best) {
      const diff = best.val - consVal;
      const diffStr = diff >= 0 ? `+${diff.toFixed(1)}c` : `${diff.toFixed(1)}c`;
      html += `<div class="tooltip-row"><span class="tooltip-label">Best Price</span><span class="tooltip-value">${best.book} ${formatOddsValue(best.val, market)}</span></div>`;
      html += `<div class="tooltip-best">Value: ${diffStr} vs consensus</div>`;
    }
    html += `</div>`;
  }

  return html;
}

export function buildTimelineTooltip(gameId) {
  const currentMatrixData = get('currentMatrixData') || { games: [], books: [], movements: [] };
  const game = currentMatrixData.games.find(g => g.id === gameId);
  if (!game) return '';
  let html = `<div class="tooltip-header">${game.away} @ ${game.home} — Movement Timeline</div>`;
  const movements = currentMatrixData.movements?.filter(m => m.event_id === gameId) || [];
  if (movements.length === 0) {
    html += `<div style="color:var(--text-dim);font-size:10px;">No recent movements</div>`;
    return html;
  }

  movements.sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
  html += `<div class="tooltip-section">`;
  for (const m of movements.slice(0, 8)) {
    const t = new Date(m.recorded_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const arrow = m.delta > 0 ? '▲' : '▼';
    html += `<div class="tooltip-move-row"><span class="tooltip-move-time">${t}</span><span class="tooltip-move-val">${m.book} ${m.market} ${formatOddsValue(m.new_value, m.market)} ${arrow}${Math.abs(m.delta).toFixed(1)}</span></div>`;
  }
  html += `</div>`;
  return html;
}

export function getGamePatterns(gameId) {
  const currentMatrixData = get('currentMatrixData') || { games: [], books: [], movements: [] };
  const apiPatterns = currentMatrixData.patterns?.filter(p => p.eventId === gameId) || [];
  const wsPatterns = [];
  if (typeof livePatterns !== 'undefined') {
    livePatterns.forEach(p => {
      if (p.eventId === gameId || p.event_id === gameId) wsPatterns.push(p);
    });
  }
  return [...apiPatterns, ...wsPatterns];
}

// ==================== RENDER ODDS MATRIX ====================
export function renderOddsMatrix() {
  const grid = document.getElementById('oddsGrid');
  const mobile = document.getElementById('oddsGridMobile');
  if (!grid || !mobile) return;

  clearTooltipCache();
  const games = getFilteredGames();
  const visibleBooks = getVisibleBooks();
  const matrixState = get('matrixState');
  const market = matrixState.market;

  if (games.length === 0) {
    grid.innerHTML = '<div class="p-4 text-sm" style="color:var(--text-dim);">No games match the current filters.</div>';
    mobile.innerHTML = '<div class="p-4 text-sm" style="color:var(--text-dim);">No games match.</div>';
    return;
  }

  const bestAway = findBestBook(games, market, market === 'total' ? 'over' : 'away');
  const bestHome = findBestBook(games, market, market === 'total' ? 'under' : 'home');

  let html = '<div class="matrix-container"><table class="matrix-table">';
  html += '<thead><tr>';
  html += '<th class="sticky-col text-left" style="min-width:140px;">Game</th>';
  if (matrixState.showConsensus) {
    html += '<th class="sticky-col-2 text-center" style="min-width:80px;">Consensus</th>';
  }
  for (const book of visibleBooks) {
    const currentBookHealth = get('currentBookHealth') || {};
    const status = book.status || currentBookHealth[book.key] || 'unknown';
    const dotColor = status === 'online' ? 'var(--green)' : status === 'offline' ? 'var(--red)' : 'var(--text-dim)';
    html += `<th class="book-header text-center" style="min-width:68px;"><div class="flex items-center justify-center gap-1">${book.key}<span class="health-dot" style="background:${dotColor};"></span></div></th>`;
  }
  html += '</tr></thead><tbody>';

  for (const g of games) {
    const timeStr = g.startTime ? new Date(g.startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
    const isExpanded = matrixState.expandedGame === g.id;
    const patterns = getGamePatterns(g.id);
    const hasRecentMoves = g.recentMovementCount > 0;

    html += `<tr class="cursor-pointer ${hasRecentMoves ? 'pulse-recent' : ''}" onclick="toggleDetailDrawer('${g.id}')">`;

    let patternIcons = '';
    for (const p of patterns) {
      const icon = p.type === 'Steam Move' ? '🔥' : p.type === 'Reverse Line' ? '🚨' : '⚠️';
      const ptId = cacheTooltip(buildPatternTooltip(p.id));
      patternIcons += `<span class="pattern-icon" onclick="event.stopPropagation();" data-pt="${ptId}" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.pt))" onmouseleave="hideTooltip()">${icon}</span>`;
    }
    const tlId = cacheTooltip(buildTimelineTooltip(g.id));
    patternIcons += `<span class="sparkline-icon" onclick="event.stopPropagation();" data-tt="${tlId}" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.tt))" onmouseleave="hideTooltip()">📊</span>`;

    html += `<td class="sticky-col"><div class="font-bold text-xs">${g.away} @ ${g.home} ${patternIcons}</div><div class="text-[10px]" style="color:var(--text-dim);">${g.sport} • ${timeStr}</div></td>`;

    if (matrixState.showConsensus) {
      const cons = g.consensus?.[market];
      const awayVal = cons ? (market === 'total' ? cons.over : cons.away) : null;
      const homeVal = cons ? (market === 'total' ? cons.under : cons.home) : null;
      const awayPrice = cons ? (market === 'total' ? cons.overPrice : cons.awayPrice) : null;
      const homePrice = cons ? (market === 'total' ? cons.underPrice : cons.homePrice) : null;
      const ctId = cacheTooltip(buildConsensusTooltip(g.id, market));
      html += `<td class="sticky-col-2 consensus-cell text-center" data-tt="${ctId}" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.tt))" onmouseleave="hideTooltip()">${formatOddsCell(awayVal, homeVal, market, awayPrice, homePrice)}</td>`;
    }

    for (const book of visibleBooks) {
      const bookData = g.books[book.key];
      const val = bookData?.[market];
      const awayVal = val ? (market === 'total' ? val.over : val.away) : null;
      const homeVal = val ? (market === 'total' ? val.under : val.home) : null;
      const awayPrice = (market === 'spread' || market === 'total') && val ? (market === 'total' ? val.overPrice : val.awayPrice) : null;
      const homePrice = (market === 'spread' || market === 'total') && val ? (market === 'total' ? val.underPrice : val.homePrice) : null;
      const isBestAway = bestAway[g.id] === book.key;
      const isBestHome = bestHome[g.id] === book.key;
      const isBest = (isBestAway || isBestHome) && (awayVal !== null || homeVal !== null);
      const currentBookHealth = get('currentBookHealth') || {};
      const status = book.status || currentBookHealth[book.key] || 'unknown';
      const offlineClass = status === 'offline' ? 'offline-book' : '';

      const awaySide = market === 'total' ? 'over' : 'away';
      const homeSide = market === 'total' ? 'under' : 'home';
      const movAway = getMovement(g.id, book.key, market, awaySide);
      const movHome = getMovement(g.id, book.key, market, homeSide);
      const movAwayHtml = movAway ? `<span class="movement-arrow movement-up" data-tt="${cacheTooltip(buildMovementTooltip(movAway))}" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.tt))" onmouseleave="hideTooltip()">▲${Math.abs(movAway.delta).toFixed(1)}</span>` : '<span class="movement-none">—</span>';
      const movHomeHtml = movHome ? `<span class="movement-arrow movement-down" data-tt="${cacheTooltip(buildMovementTooltip(movHome))}" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.tt))" onmouseleave="hideTooltip()">▼${Math.abs(movHome.delta).toFixed(1)}</span>` : '<span class="movement-none">—</span>';

      const cellTooltipAway = buildOddsCellTooltip(g.id, book.key, market, awaySide);
      const ttId = cacheTooltip(cellTooltipAway);

      const awayPriceStr = awayPrice != null ? ` <span style="color:var(--text-dim);font-size:10px;">(${formatOddsValue(awayPrice, 'moneyline')})</span>` : '';
      const homePriceStr = homePrice != null ? ` <span style="color:var(--text-dim);font-size:10px;">(${formatOddsValue(homePrice, 'moneyline')})</span>` : '';

      html += `<td class="text-center ${isBest ? 'best-line' : ''} ${offlineClass}" data-tt="${ttId}" onclick="event.stopPropagation();openTradeModal('${g.away} @ ${g.home}','${book.key}',${awayVal ?? 0})" onmouseenter="showTooltip(this, getCachedTooltip(this.dataset.tt))" onmouseleave="hideTooltip()">`;
      html += `<div class="odds-price">${formatOddsValue(awayVal, market)}${awayPriceStr} ${movAwayHtml}</div>`;
      html += `<div class="odds-juice">${formatOddsValue(homeVal, market)}${homePriceStr} ${movHomeHtml}</div>`;
      html += `</td>`;
    }
    html += '</tr>';

    html += `<tr><td colspan="${visibleBooks.length + (matrixState.showConsensus ? 2 : 1)}" style="padding:0;border:0;">`;
    html += `<div id="drawer-${g.id}" class="detail-drawer ${isExpanded ? 'open' : ''}">`;
    html += renderDetailDrawer(g);
    html += '</div></td></tr>';
  }

  html += '</tbody></table></div>';
  grid.innerHTML = html;

  renderOddsMatrixMobile(games, visibleBooks, bestAway, bestHome, market);
}

export function renderOddsMatrixMobile(games, visibleBooks, bestAway, bestHome, market) {
  const mobile = document.getElementById('oddsGridMobile');
  if (!mobile) return;

  mobile.innerHTML = games.map(g => {
    const timeStr = g.startTime ? new Date(g.startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
    const isExpanded = get('matrixState')?.expandedGame === g.id;

    let booksHtml = visibleBooks.map(book => {
      const bookData = g.books[book.key];
      const val = bookData?.[market];
      const awayVal = val ? (market === 'total' ? val.over : val.away) : null;
      const awayPrice = (market === 'spread' || market === 'total') && val ? (market === 'total' ? val.overPrice : val.awayPrice) : null;
      const isBest = bestAway[g.id] === book.key || bestHome[g.id] === book.key;
      const activeClass = isBest ? 'active' : '';
      const priceStr = awayPrice != null ? ` (${formatOddsValue(awayPrice, 'moneyline')})` : '';
      return `<button class="book-pill ${activeClass}" onclick="event.stopPropagation();openTradeModal('${g.away} @ ${g.home}','${book.key}',${awayVal ?? 0})">${book.key}<br><span class="text-[10px]">${formatOddsValue(awayVal, market)}${priceStr}</span></button>`;
    }).join('');

    return `<div class="game-card" onclick="toggleDetailDrawer('${g.id}')">
      <div class="game-card-header">
        <div><div class="font-bold text-xs">${g.away} @ ${g.home}</div><div class="text-[10px]" style="color:var(--text-dim);">${g.sport} • ${timeStr}</div></div>
        <div class="text-xs" style="color:var(--accent);" onclick="event.stopPropagation();openConsensusModal('${g.id}')">Consensus</div>
      </div>
      <div class="flex flex-wrap gap-1">${booksHtml}</div>
      ${isExpanded ? `<div class="mt-2 pt-2 border-t" style="border-color:var(--border);">${renderDetailDrawer(g)}</div>` : ''}
    </div>`;
  }).join('');
}

export function renderDetailDrawer(g) {
  const cons = g.consensus;
  let html = `<div class="p-3">`;
  html += `<div class="flex items-center justify-between mb-2"><span class="text-xs font-bold">${g.away} @ ${g.home}</span><span class="text-[10px]" style="color:var(--text-dim);">${g.sport} • ${g.league || ''}</span></div>`;
  html += `<div class="grid grid-cols-3 gap-2 mb-2">`;
  html += `<div class="rounded p-2" style="background:var(--panel);border:1px solid var(--border);"><div class="text-[10px]" style="color:var(--text-dim);">Spread</div><div class="text-xs font-mono">${cons?.spread?.away ?? '—'}${cons?.spread?.awayPrice != null ? ' (' + formatOddsValue(cons.spread.awayPrice, 'moneyline') + ')' : ''} / ${cons?.spread?.home ?? '—'}${cons?.spread?.homePrice != null ? ' (' + formatOddsValue(cons.spread.homePrice, 'moneyline') + ')' : ''}</div></div>`;
  html += `<div class="rounded p-2" style="background:var(--panel);border:1px solid var(--border);"><div class="text-[10px]" style="color:var(--text-dim);">Moneyline</div><div class="text-xs font-mono">${cons?.moneyline?.away ?? '—'} / ${cons?.moneyline?.home ?? '—'}</div></div>`;
  html += `<div class="rounded p-2" style="background:var(--panel);border:1px solid var(--border);"><div class="text-[10px]" style="color:var(--text-dim);">Total</div><div class="text-xs font-mono">${cons?.total?.over ?? '—'}${cons?.total?.overPrice != null ? ' (' + formatOddsValue(cons.total.overPrice, 'moneyline') + ')' : ''} / ${cons?.total?.under ?? '—'}${cons?.total?.underPrice != null ? ' (' + formatOddsValue(cons.total.underPrice, 'moneyline') + ')' : ''}</div></div>`;
  html += `</div>`;
  html += `<div class="flex gap-2">`;
  html += `<button class="flex-1 py-1.5 rounded text-xs font-medium" style="background:var(--accent);color:#fff;" onclick="openTradeModal('${g.away}','PIN',${cons?.moneyline?.away ?? 0})">Bet ${g.away}</button>`;
  html += `<button class="flex-1 py-1.5 rounded text-xs font-medium" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" onclick="openConsensusModal('${g.id}')">Compare Lines</button>`;
  html += `</div>`;
  html += `</div>`;
  return html;
}

export function toggleDetailDrawer(gameId) {
  const matrixState = get('matrixState');
  if (matrixState.expandedGame === gameId) {
    matrixState.expandedGame = null;
  } else {
    matrixState.expandedGame = gameId;
  }
  set('matrixState', matrixState);
  renderOddsMatrix();
}

export function filterBySport(sport, btn) {
  const matrixState = get('matrixState');
  matrixState.sport = sport;
  set('matrixState', matrixState);
  document.querySelectorAll('.sport-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadOddsData(true);
}

export function searchGames(q) {
  const matrixState = get('matrixState');
  matrixState.search = q.trim();
  set('matrixState', matrixState);
  if (typeof scheduleTask === 'function') scheduleTask('gameSearch', renderOddsMatrix, 100);
}

export function sortGames(val) {
  const matrixState = get('matrixState');
  matrixState.sort = val;
  set('matrixState', matrixState);
  renderOddsMatrix();
}

export function setMarketTab(btn, market) {
  const matrixState = get('matrixState');
  matrixState.market = market;
  set('matrixState', matrixState);
  document.querySelectorAll('.market-tab').forEach(b => {
    b.style.background = 'var(--panel)';
    b.style.color = 'var(--text-dim)';
    b.classList.remove('active');
  });
  btn.style.background = 'var(--accent)';
  btn.style.color = '#fff';
  btn.classList.add('active');
  renderOddsMatrix();
}

// ==================== BOOK SETTINGS MODAL ====================
export function openBookSettings() {
  renderBookSettingsList();
  const modal = document.getElementById('bookSettingsModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

export function closeBookSettings() {
  const modal = document.getElementById('bookSettingsModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

export function renderBookSettingsList() {
  const container = document.getElementById('bookSettingsList');
  const bookPreferences = get('bookPreferences') || loadBookPreferences();
  const allBooks = bookPreferences.order.length > 0 ? bookPreferences.order : DEFAULT_BOOK_ORDER;
  container.innerHTML = allBooks.map((book, idx) => {
    const isVisible = bookPreferences.visible.includes(book);
    return `<div class="book-list-item" draggable="true" ondragstart="bookDragStart(event,'${book}')" ondragover="bookDragOver(event)" ondrop="bookDrop(event,'${book}')">
      <span class="book-drag-handle">≡</span>
      <input type="checkbox" ${isVisible ? 'checked' : ''} onchange="toggleBookVisibility('${book}',this.checked)" class="accent-orange-500">
      <span class="text-xs font-medium">${book}</span>
      <span class="text-[10px] ml-auto" style="color:var(--text-dim);">${idx + 1}</span>
    </div>`;
  }).join('');
}

let draggedBook = null;
export function bookDragStart(e, book) { draggedBook = book; e.dataTransfer.effectAllowed = 'move'; }
export function bookDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
export function bookDrop(e, targetBook) {
  e.preventDefault();
  if (!draggedBook || draggedBook === targetBook) return;
  const bookPreferences = get('bookPreferences') || loadBookPreferences();
  const order = [...bookPreferences.order];
  const from = order.indexOf(draggedBook);
  const to = order.indexOf(targetBook);
  if (from === -1 || to === -1) return;
  order.splice(from, 1);
  order.splice(to, 0, draggedBook);
  bookPreferences.order = order;
  set('bookPreferences', bookPreferences);
  renderBookSettingsList();
}

export function toggleBookVisibility(book, visible) {
  const bookPreferences = get('bookPreferences') || loadBookPreferences();
  if (visible) {
    if (!bookPreferences.visible.includes(book)) bookPreferences.visible.push(book);
  } else {
    bookPreferences.visible = bookPreferences.visible.filter(b => b !== book);
  }
  set('bookPreferences', bookPreferences);
}

export function saveBookSettings() {
  saveBookPreferences(get('bookPreferences') || loadBookPreferences());
  closeBookSettings();
  loadOddsData(true);
  if (typeof showToast === 'function') showToast('Book preferences saved', 'success');
}

export function resetBookSettings() {
  const prefs = { order: [...DEFAULT_BOOK_ORDER], visible: ['PIN', 'BOL', 'BOV', 'BUC', 'ACE', 'MET'] };
  set('bookPreferences', prefs);
  renderBookSettingsList();
}

// ==================== CONSENSUS MODAL ====================
export function openConsensusModal(gameId) {
  const currentMatrixData = get('currentMatrixData') || { games: [], books: [], movements: [] };
  const g = currentMatrixData.games.find(x => x.id === gameId);
  if (!g) return;
  document.getElementById('consensusModalTitle').textContent = `${g.away} @ ${g.home} — Consensus`;
  const cons = g.consensus;
  let html = '<table class="w-full text-xs"><thead><tr style="background:var(--bg);"><th class="text-left px-2 py-1">Book</th><th class="text-center px-2 py-1">Spread</th><th class="text-center px-2 py-1">ML</th><th class="text-center px-2 py-1">Total</th><th class="text-center px-2 py-1">Last Move</th></tr></thead><tbody>';

  html += `<tr style="border-bottom:1px solid var(--accent);"><td class="px-2 py-1 font-bold" style="color:var(--accent);">Consensus</td>`;
  html += `<td class="text-center px-2 py-1">${formatOddsValue(cons?.spread?.away, 'spread')} / ${formatOddsValue(cons?.spread?.home, 'spread')}</td>`;
  html += `<td class="text-center px-2 py-1">${formatOddsValue(cons?.moneyline?.away, 'moneyline')} / ${formatOddsValue(cons?.moneyline?.home, 'moneyline')}</td>`;
  html += `<td class="text-center px-2 py-1">${formatOddsValue(cons?.total?.over, 'total')} / ${formatOddsValue(cons?.total?.under, 'total')}</td>`;
  html += `<td class="text-center px-2 py-1" style="color:var(--text-dim);">${formatLastMovement(getLastMovementForGame(g.id))}</td>`;
  html += '</tr>';

  const visibleBooks = getVisibleBooks();
  for (const book of visibleBooks) {
    const b = g.books[book.key];
    const lastMove = getLastMovementForBook(g.id, book.key);
    html += `<tr class="border-b" style="border-color:var(--border);"><td class="px-2 py-1">${book.key}</td>`;
    html += `<td class="text-center px-2 py-1">${b?.spread ? formatOddsValue(b.spread.away, 'spread') + ' / ' + formatOddsValue(b.spread.home, 'spread') : '—'}</td>`;
    html += `<td class="text-center px-2 py-1">${b?.moneyline ? formatOddsValue(b.moneyline.away, 'moneyline') + ' / ' + formatOddsValue(b.moneyline.home, 'moneyline') : '—'}</td>`;
    html += `<td class="text-center px-2 py-1">${b?.total ? formatOddsValue(b.total.over, 'total') + ' / ' + formatOddsValue(b.total.under, 'total') : '—'}</td>`;
    html += `<td class="text-center px-2 py-1" style="color:var(--text-dim);">${formatLastMovement(lastMove)}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('consensusModalContent').innerHTML = html;
  const modal = document.getElementById('consensusModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

export function getLastMovementForBook(gameId, bookKey) {
  const currentMatrixData = get('currentMatrixData') || { games: [], books: [], movements: [] };
  return (currentMatrixData.movements || [])
    .filter(m => m.event_id === gameId && m.book === bookKey)
    .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0] || null;
}

export function getLastMovementForGame(gameId) {
  const currentMatrixData = get('currentMatrixData') || { games: [], books: [], movements: [] };
  return (currentMatrixData.movements || [])
    .filter(m => m.event_id === gameId)
    .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0] || null;
}

export function formatLastMovement(move) {
  if (!move?.recorded_at) return '—';
  const t = new Date(move.recorded_at);
  const time = t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const delta = move.delta != null ? ` ${move.delta > 0 ? '+' : ''}${Number(move.delta).toFixed(1)}` : '';
  return `${time}${delta}`;
}

export function closeConsensusModal() {
  const modal = document.getElementById('consensusModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

// Poll odds every 30s
setInterval(() => {
  if (typeof currentSection !== 'undefined' && currentSection === 'floor') {
    loadOddsData(true);
  }
}, 30000);

// Window exports
window.loadOddsData = loadOddsData;
window.loadZone1Taxonomy = loadZone1Taxonomy;
window.fetchZone1Taxonomy = fetchZone1Taxonomy;
window.renderZone1Taxonomy = renderZone1Taxonomy;
window.zone1TaxonomyColumn = zone1TaxonomyColumn;
window.zone1LinesColumn = zone1LinesColumn;
window.zone1TaxonomyKey = zone1TaxonomyKey;
window.zone1TaxonomyLabel = zone1TaxonomyLabel;
window.zone1TaxonomySubLabel = zone1TaxonomySubLabel;
window.zone1GameLabel = zone1GameLabel;
window.selectZone1Sport = selectZone1Sport;
window.selectZone1League = selectZone1League;
window.selectZone1Game = selectZone1Game;
window.syncZone1SportFilter = syncZone1SportFilter;
window.renderDemoOddsMatrix = renderDemoOddsMatrix;
window.getVisibleBooks = getVisibleBooks;
window.getFilteredGames = getFilteredGames;
window.getMovement = getMovement;
window.formatOddsValue = formatOddsValue;
window.formatOddsCell = formatOddsCell;
window.findBestBook = findBestBook;
window.cacheTooltip = cacheTooltip;
window.getCachedTooltip = getCachedTooltip;
window.clearTooltipCache = clearTooltipCache;
window.showTooltip = showTooltip;
window.hideTooltip = hideTooltip;
window.keepTooltip = keepTooltip;
window.buildOddsCellTooltip = buildOddsCellTooltip;
window.buildMovementTooltip = buildMovementTooltip;
window.buildPatternTooltip = buildPatternTooltip;
window.buildConsensusTooltip = buildConsensusTooltip;
window.buildTimelineTooltip = buildTimelineTooltip;
window.getGamePatterns = getGamePatterns;
window.renderOddsMatrix = renderOddsMatrix;
window.renderOddsMatrixMobile = renderOddsMatrixMobile;
window.renderDetailDrawer = renderDetailDrawer;
window.toggleDetailDrawer = toggleDetailDrawer;
window.filterBySport = filterBySport;
window.searchGames = searchGames;
window.sortGames = sortGames;
window.setMarketTab = setMarketTab;
window.openBookSettings = openBookSettings;
window.closeBookSettings = closeBookSettings;
window.renderBookSettingsList = renderBookSettingsList;
window.bookDragStart = bookDragStart;
window.bookDragOver = bookDragOver;
window.bookDrop = bookDrop;
window.toggleBookVisibility = toggleBookVisibility;
window.saveBookSettings = saveBookSettings;
window.resetBookSettings = resetBookSettings;
window.openConsensusModal = openConsensusModal;
window.getLastMovementForBook = getLastMovementForBook;
window.getLastMovementForGame = getLastMovementForGame;
window.formatLastMovement = formatLastMovement;
window.closeConsensusModal = closeConsensusModal;
