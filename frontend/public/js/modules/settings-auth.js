/**
 * Settings & Auth Module
 * Extracted from app.js — handles settings saving, auth modal, and odds format toggle.
 */


function saveSettings() {
  const agentId = document.getElementById('settingsAgentId')?.value?.trim() || '';
  const password = document.getElementById('settingsPassword')?.value || '';
  const baseUrl = document.getElementById('settingsBaseUrl')?.value?.trim() || '';
  const cfCookie = document.getElementById('settingsCfCookie')?.value?.trim() || '';
  const retainedRisk = getRetainedRiskPercent();

  if (!agentId || !password) {
    showToast('Agent ID and Password are required', 'error');
    return;
  }

  localStorage.setItem('agentId', agentId);
  localStorage.setItem('baseUrl', baseUrl);
  localStorage.removeItem('password');
  localStorage.removeItem('cfCookie');
  localStorage.setItem('retainedRiskPercent', String(retainedRisk));

  // Trigger re-computation of exposure data
  if (typeof computeSportExposureLocal === 'function') computeSportExposureLocal();
  if (typeof computeAgentExposureLocal === 'function') computeAgentExposureLocal();
  if (typeof renderPositions === 'function') renderPositions();

  saveAndConnect(agentId, password, baseUrl, cfCookie);
}

function toggleAuthModal() {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  const isHidden = modal.classList.contains('hidden');
  if (isHidden) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  } else {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function toggleOddsFormat() {
  const current = localStorage.getItem('oddsFormat') || 'american';
  const next = current === 'american' ? 'decimal' : 'american';
  localStorage.setItem('oddsFormat', next);
  const btn = document.getElementById('oddsFormatBtn');
  if (btn) btn.textContent = next === 'american' ? 'American' : 'Decimal';
  // Trigger odds matrix re-render if available
  if (typeof renderOddsMatrix === 'function') renderOddsMatrix();
}

function refreshData() {
  showToast('Data refreshed', 'success');
  // Reset cache timestamps
  if (typeof sectionCache !== 'undefined' && sectionCache?.odds) sectionCache.odds.at = 0;
  if (typeof sectionCache !== 'undefined' && sectionCache?.exposure) sectionCache.exposure.at = 0;
  if (typeof loadOddsData === 'function') loadOddsData(true);
  if (typeof scheduleRender === 'function') scheduleRender('all');
  if (typeof fetchExposureData === 'function') fetchExposureData(true);
  if (typeof loadPerformancePage === 'function' && typeof currentSection !== 'undefined' && currentSection === 'performance') loadPerformancePage(true);
}

function getRetainedRiskPercent() {
  const input = document.getElementById('retainedRiskPercent');
  const val = input ? parseInt(input.value, 10) : NaN;
  return Number.isFinite(val) && val >= 0 && val <= 100 ? val : 100;
}

function getDefaultWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host || 'localhost:3000';
  return `${protocol}//${host}/ws`;
}

// Window exports
window.saveSettings = saveSettings;
window.toggleAuthModal = toggleAuthModal;
window.toggleOddsFormat = toggleOddsFormat;
window.refreshData = refreshData;
