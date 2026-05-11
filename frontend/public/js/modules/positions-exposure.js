/**
 * Positions & Exposure Module
 * Extracted from app.js — handles position stats, sport/agent exposure rendering.
 */

import { getApiBaseUrl } from '../api.js';
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

// ==================== EXPOSURE HELPERS ====================
function decodeEntities(desc) {
  if (!desc) return desc;
  return desc.replace(/&#189;/g, '½').replace(/&#188;/g, '¼').replace(/&#190;/g, '¾').replace(/&#038;/g, '&').replace(/&amp;/g, '&');
}

function getWagerExposure(w) {
  return (w.VolumeAmount > 0 ? w.VolumeAmount : w.AmountWagered) || 0;
}

function getRetainedRiskPercent() {
  const inputValue = document.getElementById('retainedRiskPercent')?.value;
  const storedValue = localStorage.getItem('retainedRiskPercent');
  const parsed = Number(inputValue || storedValue || 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(parsed, 0), 100);
}

function getHeldRisk(w) {
  return getWagerExposure(w) * (getRetainedRiskPercent() / 100);
}

function getExposurePct(amount, totalVolume) {
  if (!totalVolume) return '0%';
  return Math.min(100, ((Number(amount || 0) / totalVolume) * 100)).toFixed(1) + '%';
}

function parseSport(desc) {
  if (!desc) return 'Other';
  desc = decodeEntities(desc);
  const gsliveMatch = desc.match(/^[A-Z][.:]G?\d+\s*-\s*(?:Top\s+)?([A-Za-z]+)/);
  if (gsliveMatch) return gsliveMatch[1];
  const directMatch = desc.match(/^[A-Z][.:]([A-Za-z\s]+?)(?:\s*#|\s*-|\s*$)/);
  if (directMatch) {
    const sport = directMatch[1].trim();
    if (sport.length > 1) return sport;
  }
  if (desc.includes('Martial Arts')) return 'MMA';
  if (desc.includes('Basketball')) return 'Basketball';
  if (desc.includes('Baseball')) return 'Baseball';
  if (desc.includes('Football')) return 'Football';
  if (desc.includes('Hockey')) return 'Hockey';
  if (desc.includes('Soccer')) return 'Soccer';
  if (desc.includes('Tennis')) return 'Tennis';
  if (desc.includes('Golf')) return 'Golf';
  if (desc.includes('UFC') || desc.includes('MMA')) return 'MMA';
  if (desc.includes('Boxing')) return 'Boxing';
  return 'Other';
}

function parseGameSingle(desc) {
  desc = decodeEntities(desc);
  const gsMatch = desc.match(/^[A-Z][.:]G?\d+\s+-\s+(?:Top\s+)?\w+\s+-\s+(.+?)(?:\s+\/|\s+-\s+For\s|$)/);
  if (gsMatch) return gsMatch[1].trim().substring(0, 35);
  const stdMatch = desc.match(/^[A-Z][.:\s][\w\s]+\s+#\d+\s+(.+?)(?:\s+-\s+For\s|\s+\/|\s+-\s+\d)/);
  if (stdMatch) return stdMatch[1].trim().substring(0, 35);
  const futuresMatch = desc.match(/-\s+([A-Za-z][A-Za-z\s'.-]+?)(?:\s+[+-]\d+(?:\.\d+)?)\s+(?:for\s+Game|-\s+For\s+Game|$)/i);
  if (futuresMatch) return futuresMatch[1].trim().substring(0, 35);
  const vsMatch = desc.match(/([A-Za-z][A-Za-z\s'.-]{1,20}(?:\s+vs\.?|\s+VS\.?|\s+@)\s+[A-Za-z][A-Za-z\s'.-]{1,20})/);
  if (vsMatch) return vsMatch[1].trim().substring(0, 35);
  const simpleMatch = desc.match(/^[A-Z][.:\s][\w\s]+\s+#?\d*\s*([^#-]{5,40}?)(?:\s+-\s+For|\s+for\s+Game|\s+\/|$)/i);
  if (simpleMatch) return simpleMatch[1].trim().substring(0, 35);
  return desc.substring(0, 35) || 'Unknown Game';
}

function parseGame(desc) {
  if (!desc) return 'Unknown Game';
  desc = decodeEntities(desc);
  if (desc.includes('\r\n') || (desc.includes(' - For Game ') && desc.match(/ - For Game /g).length > 1)) {
    const firstLeg = desc.split('\r\n')[0].split(' - For Game ')[0];
    const legCount = (desc.match(/ - For Game /g) || []).length;
    const game = parseGameSingle(firstLeg);
    return legCount > 1 ? `${game} (+${legCount - 1} legs)` : game;
  }
  return parseGameSingle(desc);
}

function parseSide(desc) {
  if (!desc) return '';
  desc = decodeEntities(desc);
  let clean = desc.replace(/^[A-Z][.:]\s*/, '');
  clean = clean.replace(/^G\d+\s*-\s*/, '');
  clean = clean.replace(/\s+-\s+For\s.*$/i, '');
  clean = clean.replace(/\s+\/\s+(Teaser|Straight|Parlay)\s+\/\s+[^/]+$/i, '');
  clean = clean.replace(/^#\d+\s+/, '');
  const propMatch = clean.match(/([A-Za-z][A-Za-z\s'.-]*\s+[OU]\s+\d+\.?\d*)/i);
  if (propMatch) return propMatch[1].trim().substring(0, 30);
  const spreadMatch = clean.match(/([A-Za-z][A-Za-z\s'.-]*\s+[+-]\d+\.?\d*)/i);
  if (spreadMatch) return spreadMatch[1].trim().substring(0, 30);
  const ouMatch = clean.match(/\b(Over|Under)\s+\d+\.?\d*/i);
  if (ouMatch) return ouMatch[0].trim().substring(0, 30);
  return clean.substring(0, 30);
}

function extractPrice(desc) {
  if (!desc) return null;
  desc = decodeEntities(desc);
  const match = desc.match(/\s([+-]\d+(?:\.\d+)?)(?:\s+-\s+For|\s+for\s+Game|\s*$)/i);
  if (match) return match[1];
  const slashPrice = desc.match(/\/\s*[^/]*?\s+([+-]?\d{2,4})(?:\s*$|\s+-\s+For|\s+for\s+Game)/i);
  if (slashPrice) {
    const raw = slashPrice[1];
    return raw.startsWith('+') || raw.startsWith('-') ? raw : `+${raw}`;
  }
  const altMatch = desc.match(/\s([+-]\d{2,4})\b/);
  if (altMatch) return altMatch[1];
  return null;
}

// ==================== LOCAL COMPUTATION ====================
function computeSportExposureLocal() {
  const buckeyeWagers = get('buckeyeWagers') || [];
  const sports = {};
  buckeyeWagers.forEach(w => {
    const sport = parseSport(w.ShortDesc);
    if (!sports[sport]) sports[sport] = { total: 0, live: 0, wagerCount: 0, wagers: [] };
    sports[sport].total += getHeldRisk(w);
    sports[sport].wagerCount++;
    if (w.TicketWriter === 'GSLIVE') sports[sport].live++;
    sports[sport].wagers.push(w);
  });

  const totalVolume = Object.values(sports).reduce((s, d) => s + d.total, 0);

  const result = Object.entries(sports).map(([sport, data]) => {
    const games = {};
    data.wagers.forEach(w => {
      const g = parseGame(w.ShortDesc);
      games[g] = (games[g] || 0) + getHeldRisk(w);
    });
    let topGame = '';
    let gameTotal = 0;
    for (const [g, v] of Object.entries(games)) {
      if (v > gameTotal) { topGame = g; gameTotal = v; }
    }
    const sides = {};
    data.wagers.filter(w => parseGame(w.ShortDesc) === topGame).forEach(w => {
      const side = parseSide(w.ShortDesc) || w.ShortDesc;
      const price = extractPrice(w.ShortDesc);
      if (!sides[side]) sides[side] = { volume: 0, price };
      sides[side].volume += getHeldRisk(w);
    });
    let topSide = '';
    let topSideVol = 0;
    let topSidePrice = '';
    for (const [s, d] of Object.entries(sides)) {
      if (d.volume > topSideVol) { topSide = s; topSideVol = d.volume; topSidePrice = d.price; }
    }

    return {
      sport, total: data.total,
      pct: getExposurePct(data.total, totalVolume),
      live: data.live, wagerCount: data.wagerCount,
      topGame, side: topSide || '—', price: topSidePrice || '—', gameTotal
    };
  }).sort((a, b) => b.total - a.total);

  set('sportExposureData', result);
  return result;
}

function computeAgentExposureLocal() {
  const buckeyeWagers = get('buckeyeWagers') || [];
  const agents = {};
  buckeyeWagers.forEach(w => {
    const a = w.AgentLogin || 'Unknown';
    if (!agents[a]) agents[a] = { total: 0, live: 0, wagerCount: 0, wagers: [] };
    agents[a].total += getHeldRisk(w);
    agents[a].wagerCount++;
    if (w.TicketWriter === 'GSLIVE') agents[a].live++;
    agents[a].wagers.push(w);
  });

  const totalVolume = Object.values(agents).reduce((s, d) => s + d.total, 0);

  const result = Object.entries(agents).map(([agent, data]) => {
    const customers = {};
    const games = {};
    data.wagers.forEach(w => {
      customers[w.Login || 'Unknown'] = (customers[w.Login || 'Unknown'] || 0) + getHeldRisk(w);
      const g = parseGame(w.ShortDesc);
      games[g] = (games[g] || 0) + getHeldRisk(w);
    });
    let topCustomer = '';
    let topCustomerVol = 0;
    for (const [c, v] of Object.entries(customers)) {
      if (v > topCustomerVol) { topCustomer = c; topCustomerVol = v; }
    }
    let topGame = '';
    let topGameVol = 0;
    for (const [g, v] of Object.entries(games)) {
      if (v > topGameVol) { topGame = g; topGameVol = v; }
    }
    return {
      agent, total: data.total,
      pct: getExposurePct(data.total, totalVolume),
      live: data.live, wagerCount: data.wagerCount,
      topCustomer: topCustomer || '—', topCustomerVol,
      topGame: topGame || '—', topGameVol
    };
  }).sort((a, b) => b.total - a.total);

  set('agentExposureData', result);
  return result;
}

// ==================== FETCH EXPOSURE ====================
async function fetchSportExposure() {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/exposure/sports`);
    if (!res.ok) throw new Error('Failed to fetch sport exposure');
    let data = await res.json();
    const totalVolume = data.reduce((sum, row) => sum + (row.total || 0), 0);
    data = data.map(row => ({
      ...row,
      pct: getExposurePct(row.total || 0, totalVolume),
    }));
    set('sportExposureData', data);
    renderSportExposure();
  } catch (err) {
    console.log('[Exposure] Sport fetch failed:', err.message);
    computeSportExposureLocal();
    renderSportExposure();
  }
}

async function fetchAgentExposure() {
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/exposure/agents`);
    if (!res.ok) throw new Error('Failed to fetch agent exposure');
    let data = await res.json();
    const totalVolume = data.reduce((sum, row) => sum + (row.total || 0), 0);
    data = data.map(row => ({
      ...row,
      pct: getExposurePct(row.total || 0, totalVolume),
    }));
    set('agentExposureData', data);
    renderAgentExposure();
  } catch (err) {
    console.log('[Exposure] Agent fetch failed:', err.message);
    computeAgentExposureLocal();
    renderAgentExposure();
  }
}

export async function fetchExposureData(force = false) {
  if (!force && typeof sectionCache !== 'undefined' && sectionCache?.exposure && (Date.now() - sectionCache.exposure.at < sectionCache.exposure.ttl)) {
    renderSportExposure();
    renderAgentExposure();
    return;
  }
  await Promise.all([fetchSportExposure(), fetchAgentExposure()]);
  if (typeof sectionCache !== 'undefined' && sectionCache?.exposure) sectionCache.exposure.at = Date.now();
}

// Window exports
window.updatePositionStats = updatePositionStats;
window.renderSportExposure = renderSportExposure;
window.renderAgentExposure = renderAgentExposure;
window.sortSportExposure = sortSportExposure;
window.sortAgentExposure = sortAgentExposure;
window.fetchExposureData = fetchExposureData;
