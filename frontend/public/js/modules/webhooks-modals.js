/**
 * Webhooks & Modals Module
 * Extracted from app.js lines ~4127-4632.
 * Handles trade modal, auth modal, toast system, webhooks CRUD,
 * proxy secrets, vault status, and connection management.
 */

import { getApiBaseUrl, fetchJson, fetchDelete, fetchBlob } from '../api.js';
import { escapeHtml, money, timeAgo } from '../utils.js';
import { state, get, set } from './state.js';
import { schedule } from './render-scheduler.js';

// ==================== TRADE MODAL ====================
export function openTradeModal(selection, book, odds) {
  const modal = document.getElementById('tradeModal');
  const content = document.getElementById('tradeModalContent');
  content.innerHTML = `
    <div class="space-y-3">
      <div class="flex justify-between text-sm"><span>Selection:</span><span class="font-bold">${selection}</span></div>
      <div class="flex justify-between text-sm"><span>Book:</span><span class="font-bold">${book}</span></div>
      <div class="flex justify-between text-sm"><span>Odds:</span><span class="font-bold">${odds > 0 ? '+' : ''}${odds}</span></div>
      <div><label class="text-xs" style="color:var(--text-dim);">Stake ($)</label><input type="number" id="stakeInput" value="100" class="w-full mt-1 text-sm px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);"></div>
      <div class="flex gap-2"><button class="flex-1 py-2 rounded-lg text-sm font-medium" style="background:var(--accent);color:#fff;" onclick="executeTrade('${selection}','${book}',${odds})">Execute</button><button class="flex-1 py-2 rounded-lg text-sm" style="background:var(--panel);border:1px solid var(--border);color:var(--text);" onclick="closeTradeModal()">Cancel</button></div>
    </div>`;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

export function closeTradeModal() {
  const modal = document.getElementById('tradeModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

export function executeTrade(selection, book, odds) {
  const stake = parseFloat(document.getElementById('stakeInput').value) || 100;
  showToast(`Trade executed: ${selection} @ ${book} for $${stake}`, 'success');
  closeTradeModal();
}

// ==================== AUTH MODAL ====================
export function toggleAuthModal() {
  const modal = document.getElementById('authModal');
  const content = document.getElementById('authModalContent');
  const savedAgent = localStorage.getItem('agentId') || '';
  content.innerHTML = `
    <div class="space-y-3">
      <div><label class="text-xs" style="color:var(--text-dim);">Agent ID</label><input id="modalAgentId" type="text" value="${escapeHtml(savedAgent)}" class="w-full mt-1 text-sm px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" placeholder="Enter agent ID"></div>
      <div><label class="text-xs" style="color:var(--text-dim);">Password</label><input id="modalPassword" type="password" value="" class="w-full mt-1 text-sm px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" placeholder="Enter password"></div>
      <div><label class="text-xs" style="color:var(--text-dim);">Cloudflare Cookie (optional)</label><input id="modalCfCookie" type="text" value="" class="w-full mt-1 text-sm px-2 py-1.5 rounded outline-none" style="background:var(--bg);border:1px solid var(--border);color:var(--text);" placeholder="Paste cf_clearance"></div>
      <button class="w-full py-2 rounded-lg text-sm font-medium" style="background:var(--accent);color:#fff;" onclick="modalSignIn()">Connect to Buckeye</button>
      <button class="w-full py-2 rounded-lg text-sm font-medium" style="background:var(--panel);border:1px solid var(--border);color:var(--text);" onclick="openBuckeyeForCookie()">Open Buckeye to Get Cookie</button>
    </div>`;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

export function modalSignIn() {
  const agentId = document.getElementById('modalAgentId').value.trim();
  const password = document.getElementById('modalPassword').value;
  const cfCookie = document.getElementById('modalCfCookie')?.value?.trim() || '';
  if (!agentId || !password) {
    showToast('Please enter both Agent ID and Password', 'error');
    return;
  }
  closeAuthModal();
  if (typeof saveAndConnect === 'function') saveAndConnect(agentId, password, null, cfCookie);
}

export function openBuckeyeForCookie() {
  window.open('https://fantasy402.com/index.php', '_blank');
  showToast('Log into Buckeye in the new tab, then copy cf_clearance from DevTools > Application > Cookies', 'info');
}

export function closeAuthModal() {
  const modal = document.getElementById('authModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

// ==================== TOAST SYSTEM ====================
export function showToast(message, type = 'info') {
  if (localStorage.getItem('toastsEnabled') === 'false') return;
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  const colors = { success: 'var(--green)', error: 'var(--red)', warning: 'var(--yellow)', info: 'var(--blue)' };
  toast.className = 'toast pointer-events-auto px-4 py-3 rounded-lg border text-sm flex items-center gap-2';
  toast.style.cssText = `background:var(--panel);border-color:${colors[type] || colors.info};color:var(--text);`;
  toast.innerHTML = `<div class="w-2 h-2 rounded-full" style="background:${colors[type] || colors.info};"></div><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ==================== REFRESH & EXPORT ====================
export function refreshData() {
  showToast('Data refreshed', 'success');
  if (typeof sectionCache !== 'undefined') {
    if (sectionCache?.odds) sectionCache.odds.at = 0;
    if (sectionCache?.exposure) sectionCache.exposure.at = 0;
  }
  if (typeof loadOddsData === 'function') loadOddsData(true);
  if (typeof scheduleRender === 'function') scheduleRender('all');
  if (typeof fetchExposureData === 'function') fetchExposureData(true);
  if (typeof currentSection !== 'undefined' && currentSection === 'performance' && typeof loadPerformancePage === 'function') loadPerformancePage(true);
}

export function exportWagers() {
  const buckeyeWagers = get('buckeyeWagers') || [];
  const csv = buckeyeWagers.map(w => `${w.WagerNumber},${w.Login},${w.AgentLogin},${w.WagerType},${w.AmountWagered},${w.VolumeAmount},${w.TicketWriter},${w.InsertDateTime}`).join('\n');
  const blob = new Blob(['WagerNumber,Login,Agent,Type,Wagered,Volume,Source,Time\n' + csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'buckeye_wagers.csv';
  a.click();
  showToast('Wagers exported to CSV', 'success');
}

export function exportPositions() {
  showToast('Positions exported', 'success');
}

export function closePosition(game) {
  showToast(`Position closed: ${game}`, 'info');
}

// ==================== BUCKEYE CONNECTION ====================
export function connectBuckeye() {
  if (typeof showBuckeyeSettings === 'function') showBuckeyeSettings();
  showToast('Enter credentials once; the backend stores them in the OS vault after login.', 'info');
}

export function disconnectBuckeye() {
  if (typeof wsClient !== 'undefined' && wsClient?.ws) {
    wsClient.ws.close();
  }
  if (typeof updateConnectionStatus === 'function') updateConnectionStatus('disconnected');
  showToast('Disconnected from Buckeye', 'info');
}

export function resyncBuckeye() {
  if (typeof wsClient !== 'undefined' && wsClient?.isAuthenticated) {
    wsClient.send({ type: 'refresh', agentId: wsClient.agentId });
    showToast('Resyncing with Buckeye...', 'info');
  } else {
    showToast('Not connected — connect first', 'warning');
  }
}

export function showBuckeyeSettings() {
  if (typeof switchSection === 'function') switchSection('settings', typeof getSidebarButton === 'function' ? getSidebarButton('settings') : null);
}

// ==================== SETTINGS ====================
export function saveSettings() {
  const agentId = document.getElementById('settingsAgentId').value.trim();
  const password = document.getElementById('settingsPassword').value;
  const baseUrl = document.getElementById('settingsBaseUrl').value.trim();
  const cfCookie = document.getElementById('settingsCfCookie').value.trim();
  const retainedRisk = typeof getRetainedRiskPercent === 'function' ? getRetainedRiskPercent() : 0;

  if (!agentId || !password) {
    showToast('Agent ID and Password are required', 'error');
    return;
  }

  localStorage.setItem('agentId', agentId);
  localStorage.setItem('baseUrl', baseUrl);
  localStorage.removeItem('password');
  localStorage.removeItem('cfCookie');
  localStorage.setItem('retainedRiskPercent', String(retainedRisk));
  if (typeof computeSportExposureLocal === 'function') computeSportExposureLocal();
  if (typeof computeAgentExposureLocal === 'function') computeAgentExposureLocal();
  if (typeof renderPositions === 'function') renderPositions();

  if (typeof saveAndConnect === 'function') saveAndConnect(agentId, password, baseUrl, cfCookie);
}

export function getDefaultWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host || 'localhost:3000';
  return `${protocol}//${host}/ws`;
}

export function getRetainedRiskPercent() {
  const input = document.getElementById('retainedRiskPercent');
  const val = input ? parseFloat(input.value) : NaN;
  return Number.isFinite(val) && val >= 0 && val <= 100 ? val : 0;
}

// ==================== PROXY SECRETS ====================
const PROXY_SECRET_NAMES = [
  'proxy-admin-key',
  'buckeye-api-key',
  'buckeye-customer-id',
  'buckeye-password',
  'agent-id',
  'agent-owner',
  'kimi-api-key',
  'cf-clearance',
];

export function getProxySecretsBaseUrl() {
  const input = document.getElementById('proxySecretsBaseUrl');
  const value = input?.value?.trim() || localStorage.getItem('proxyBaseUrl') || 'http://localhost:3001';
  localStorage.setItem('proxyBaseUrl', value);
  return value.replace(/\/+$/, '');
}

export function getProxySecretsApiKey() {
  const input = document.getElementById('proxySecretsApiKey');
  const value = input?.value || localStorage.getItem('proxyApiKey') || 'dev-key-123';
  if (value) localStorage.setItem('proxyApiKey', value);
  return value;
}

export function proxySecretHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': getProxySecretsApiKey(),
  };
}

export function getProxySecretInput(name) {
  return document.getElementById(`secret_${name}`);
}

export function syncBuckeyeSettingsFromProxySecrets(secrets) {
  const agent = secrets['agent-id'] || secrets['buckeye-customer-id'] || '';
  const password = secrets['buckeye-password'] || '';
  const cf = secrets['cf-clearance'] || '';
  const agentInput = document.getElementById('settingsAgentId');
  const passwordInput = document.getElementById('settingsPassword');
  const cfInput = document.getElementById('settingsCfCookie');
  if (agent && agentInput) agentInput.value = agent;
  if (password && passwordInput) passwordInput.value = password;
  if (cf && cfInput) cfInput.value = cf;
}

export async function fetchProxySecrets(redact = false) {
  const url = `${getProxySecretsBaseUrl()}/api/secrets${redact ? '?redact=1' : ''}`;
  const res = await fetch(url, { headers: proxySecretHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Proxy secrets unavailable');
  return body;
}

export async function refreshProxySecretStatus() {
  const statusEl = document.getElementById('proxySecretsStatus');
  try {
    const secrets = await fetchProxySecrets(true);
    const setCount = PROXY_SECRET_NAMES.filter(name => secrets[name]).length;
    for (const name of PROXY_SECRET_NAMES) {
      const input = getProxySecretInput(name);
      if (input) input.placeholder = secrets[name] ? 'Stored in vault' : '';
    }
    if (statusEl) {
      statusEl.textContent = `${setCount}/${PROXY_SECRET_NAMES.length} set`;
      statusEl.style.color = setCount ? 'var(--green)' : 'var(--text-dim)';
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err instanceof Error ? err.message : 'Proxy secrets unavailable';
      statusEl.style.color = 'var(--yellow)';
    }
  }
}

export async function importProxySecrets() {
  const statusEl = document.getElementById('proxySecretsStatus');
  try {
    const secrets = await fetchProxySecrets(false);
    for (const name of PROXY_SECRET_NAMES) {
      const input = getProxySecretInput(name);
      if (input && typeof secrets[name] === 'string') input.value = secrets[name] || '';
    }
    syncBuckeyeSettingsFromProxySecrets(secrets);
    if (secrets['proxy-admin-key']) {
      localStorage.setItem('proxyApiKey', secrets['proxy-admin-key']);
      const keyInput = document.getElementById('proxySecretsApiKey');
      if (keyInput) keyInput.value = secrets['proxy-admin-key'];
    }
    if (statusEl) {
      statusEl.textContent = 'Imported';
      statusEl.style.color = 'var(--green)';
    }
    showToast('Proxy secrets imported', 'success');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Could not import proxy secrets', 'error');
  }
}

export async function saveProxySecrets() {
  const names = PROXY_SECRET_NAMES
    .filter(name => name !== 'proxy-admin-key')
    .concat('proxy-admin-key');
  let saved = 0;
  try {
    for (const name of names) {
      const input = getProxySecretInput(name);
      const value = input?.value || '';
      if (!value) continue;
      const res = await fetch(`${getProxySecretsBaseUrl()}/api/secrets`, {
        method: 'POST',
        headers: proxySecretHeaders(),
        body: JSON.stringify({ name, value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Could not save ${name}`);
      saved++;
      if (name === 'proxy-admin-key') {
        localStorage.setItem('proxyApiKey', value);
        const keyInput = document.getElementById('proxySecretsApiKey');
        if (keyInput) keyInput.value = value;
      }
    }
    await refreshProxySecretStatus();
    showToast(saved ? `${saved} proxy secret${saved === 1 ? '' : 's'} saved` : 'No filled secrets to save', saved ? 'success' : 'info');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Could not save proxy secrets', 'error');
  }
}

export async function deleteProxySecrets() {
  const names = PROXY_SECRET_NAMES
    .filter(name => name !== 'proxy-admin-key')
    .concat('proxy-admin-key');
  let deleted = 0;
  try {
    for (const name of names) {
      const input = getProxySecretInput(name);
      if (!input?.value) continue;
      const url = new URL(`${getProxySecretsBaseUrl()}/api/secrets`);
      url.searchParams.set('name', name);
      const res = await fetch(url, { method: 'DELETE', headers: { 'X-API-Key': getProxySecretsApiKey() } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Could not delete ${name}`);
      input.value = '';
      deleted++;
    }
    await refreshProxySecretStatus();
    showToast(deleted ? `${deleted} proxy secret${deleted === 1 ? '' : 's'} deleted` : 'Fill secret fields to delete them', deleted ? 'success' : 'info');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Could not delete proxy secrets', 'error');
  }
}

// ==================== VAULT STATUS ====================
export async function refreshVaultStatus() {
  const el = document.getElementById('vaultStatusText');
  const listEl = document.getElementById('vaultAgentList');
  if (!el) return;
  try {
    const url = new URL(`${getApiBaseUrl()}/api/buckeye/vault-status`);
    const res = await fetch(url);
    const status = await res.json();
    if (listEl) listEl.innerHTML = '';
    if (!status.available) {
      el.textContent = 'OS vault unavailable';
      el.style.color = 'var(--yellow)';
      if (typeof updateBuckeyeStatusBadge === 'function') updateBuckeyeStatusBadge('warning', 'Vault Unavailable');
      return;
    }
    const agents = Array.isArray(status.agents) ? status.agents : (status.agentId ? [status] : []);
    if (!agents.length) {
      el.textContent = 'No Buckeye secrets stored';
      el.style.color = 'var(--text-dim)';
      const buckeyeWagers = get('buckeyeWagers') || [];
      if (typeof updateBuckeyeStatusBadge === 'function') updateBuckeyeStatusBadge(buckeyeWagers.length ? 'archive' : 'disconnected', buckeyeWagers.length ? `${buckeyeWagers.length.toLocaleString()} Latest` : 'No Vault');
      return;
    }
    const activeCount = agents.filter(agent => agent.active).length;
    const readyCount = agents.filter(agent => agent.hasToken || (agent.hasPassword && agent.hasCfCookie)).length;
    window.backendLiveAgents = activeCount;
    window.backendVaultReadyAgents = readyCount;
    el.textContent = `${agents.length} vaulted agent${agents.length === 1 ? '' : 's'} | ${activeCount} ingesting`;
    el.style.color = activeCount ? 'var(--green)' : 'var(--yellow)';
    if (activeCount) {
      if (typeof updateBuckeyeStatusBadge === 'function') updateBuckeyeStatusBadge('connected', `${activeCount} Agent${activeCount === 1 ? '' : 's'} Live`);
    } else if (readyCount) {
      if (typeof updateBuckeyeStatusBadge === 'function') updateBuckeyeStatusBadge('ready', `${readyCount} Vault Ready`);
    } else {
      if (typeof updateBuckeyeStatusBadge === 'function') updateBuckeyeStatusBadge('warning', 'Vault Needs Cookie');
    }
    if (listEl) {
      listEl.innerHTML = agents.map(agent => {
        const flags = [
          agent.hasPassword ? 'password' : null,
          agent.hasCfCookie ? 'cookie' : null,
          agent.hasToken ? 'token' : null,
          agent.active ? 'active' : null,
        ].filter(Boolean);
        const flagText = flags.length ? flags.join(' + ') : 'no usable secrets';
        const color = agent.active ? 'var(--green)' : (flags.length ? 'var(--yellow)' : 'var(--text-dim)');
        const error = agent.lastError ? `<span style="color:var(--red);"> | ${escapeHtml(agent.lastError)}</span>` : '';
        return `<div class="flex items-center justify-between gap-2 rounded px-2 py-1" style="background:var(--panel);border:1px solid var(--border);">
          <span class="font-mono" style="color:var(--text);">${escapeHtml(agent.agentId || 'Unknown')}</span>
          <span style="color:${color};">${escapeHtml(flagText)}${error}</span>
        </div>`;
      }).join('');
    }
  } catch {
    el.textContent = 'Vault status unavailable';
    el.style.color = 'var(--yellow)';
    if (listEl) listEl.innerHTML = '';
  }
}

export async function logoutBuckeyeVault() {
  const agentId = document.getElementById('settingsAgentId')?.value?.trim() || localStorage.getItem('agentId') || '';
  if (!agentId) {
    showToast('Select an agent before logging out of the vault', 'warning');
    return;
  }
  try {
    const url = new URL(`${getApiBaseUrl()}/api/buckeye/vault-status`);
    url.searchParams.set('agentId', agentId);
    await fetch(url, { method: 'DELETE' });
    if (typeof wsClient !== 'undefined' && wsClient?.ws) wsClient.ws.close();
    localStorage.removeItem('buckeyeToken');
    localStorage.removeItem('lastAuthTime');
    if (typeof updateConnectionStatus === 'function') updateConnectionStatus('disconnected');
    await refreshVaultStatus();
    showToast(`Buckeye vault credentials cleared for ${agentId}`, 'success');
  } catch {
    showToast('Could not clear Buckeye vault credentials', 'error');
  }
}

// ==================== TEST CONNECTION ====================
export async function testConnection() {
  const agentId = document.getElementById('settingsAgentId').value.trim();
  const password = document.getElementById('settingsPassword').value;
  const baseUrl = document.getElementById('settingsBaseUrl').value.trim();

  if (!agentId || !password) {
    showToast('Agent ID and Password are required', 'error');
    return;
  }

  showToast('Testing login to fantasy402.com...', 'info');
  if (typeof updateConnectionStatus === 'function') updateConnectionStatus('testing');

  try {
    const res = await fetch(`${getApiBaseUrl()}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, password, baseUrl }),
    });
    const data = await res.json();
    if (data.success) {
      if (data.token) localStorage.setItem('apiToken', data.token);
      showToast(`Login OK — ${data.wagerCount} wagers on site`, 'success');
      if (typeof updateConnectionStatus === 'function') updateConnectionStatus('ready');
    } else {
      showToast(data.error || 'Login failed', 'error');
      if (typeof updateConnectionStatus === 'function') updateConnectionStatus('disconnected');
    }
  } catch (err) {
    showToast('Backend unreachable — is the server running?', 'error');
    if (typeof updateConnectionStatus === 'function') updateConnectionStatus('disconnected');
  }
}

// ==================== SAVE & CONNECT ====================
export function saveAndConnect(agentId, password, baseUrl, cfCookie) {
  localStorage.setItem('agentId', agentId);
  if (baseUrl) localStorage.setItem('baseUrl', baseUrl);
  localStorage.removeItem('password');
  localStorage.removeItem('cfCookie');

  if (typeof updateConnectionStatus === 'function') updateConnectionStatus('connecting');
  showToast('Connecting to Buckeye...', 'info');
  if (typeof refreshMasterAccountInfo === 'function') refreshMasterAccountInfo(true);

  if (typeof wsClient !== 'undefined') {
    if (!wsClient.ws || wsClient.ws.readyState !== WebSocket.OPEN) {
      wsClient.connect();
      setTimeout(() => {
        wsClient.authenticate(agentId, agentId, password, cfCookie);
      }, 1000);
    } else {
      wsClient.authenticate(agentId, agentId, password, cfCookie);
    }
  }
}

export function resumeSession(agentId, password, baseUrl, cfCookie, token) {
  localStorage.setItem('agentId', agentId);
  if (baseUrl) localStorage.setItem('baseUrl', baseUrl);
  localStorage.removeItem('password');
  localStorage.removeItem('cfCookie');

  if (typeof updateConnectionStatus === 'function') updateConnectionStatus('connecting');
  showToast('Resuming session...', 'info');
  if (typeof refreshMasterAccountInfo === 'function') refreshMasterAccountInfo(true);

  if (typeof wsClient !== 'undefined') {
    if (!wsClient.ws || wsClient.ws.readyState !== WebSocket.OPEN) {
      wsClient.connect();
      setTimeout(() => {
        wsClient.authenticateWithToken(agentId, token, cfCookie);
      }, 1000);
    } else {
      wsClient.authenticateWithToken(agentId, token, cfCookie);
    }
  }
}

export function attemptAutoReconnect() {
  const agentId = localStorage.getItem('agentId');
  if (agentId) {
    showToast('Reconnect from Settings if the backend vault has not restored the session.', 'info');
  }
}

export function updateConnectionStatus(state) {
  const el = document.getElementById('connectionStatus');
  if (!el) return;
  const token = localStorage.getItem('apiToken');
  const authIndicator = token ? '🔒 ' : '🔓 ';
  const styles = {
    connected: { text: authIndicator + '● Live Polling', color: 'var(--green)' },
    connecting: { text: authIndicator + '● Connecting...', color: 'var(--yellow)' },
    testing: { text: authIndicator + '● Testing...', color: 'var(--yellow)' },
    ready: { text: authIndicator + '● Login OK', color: 'var(--blue)' },
    disconnected: { text: authIndicator + '● Disconnected', color: 'var(--text-dim)' },
  };
  const s = styles[state] || styles.disconnected;
  el.textContent = s.text;
  el.style.color = s.color;
  el.title = token ? 'Authenticated to backend API' : 'No API token — some features may be unavailable';
  const liveAgents = Number(window.backendLiveAgents || 0);
  if (state === 'disconnected' && liveAgents > 0) {
    if (typeof updateBuckeyeStatusBadge === 'function') updateBuckeyeStatusBadge('connected', `${liveAgents} Agent${liveAgents === 1 ? '' : 's'} Live`);
  } else {
    if (typeof updateBuckeyeStatusBadge === 'function') updateBuckeyeStatusBadge(state, s.text.replace('● ', ''));
  }
  if (typeof updateTopBarStatus === 'function') updateTopBarStatus();
}

// Window exports
window.openTradeModal = openTradeModal;
window.closeTradeModal = closeTradeModal;
window.executeTrade = executeTrade;
window.toggleAuthModal = toggleAuthModal;
window.modalSignIn = modalSignIn;
window.openBuckeyeForCookie = openBuckeyeForCookie;
window.closeAuthModal = closeAuthModal;
window.showToast = showToast;
window.refreshData = refreshData;
window.exportWagers = exportWagers;
window.exportPositions = exportPositions;
window.closePosition = closePosition;
window.connectBuckeye = connectBuckeye;
window.disconnectBuckeye = disconnectBuckeye;
window.resyncBuckeye = resyncBuckeye;
window.showBuckeyeSettings = showBuckeyeSettings;
window.saveSettings = saveSettings;
window.getDefaultWsUrl = getDefaultWsUrl;
window.getRetainedRiskPercent = getRetainedRiskPercent;
window.getProxySecretsBaseUrl = getProxySecretsBaseUrl;
window.getProxySecretsApiKey = getProxySecretsApiKey;
window.proxySecretHeaders = proxySecretHeaders;
window.getProxySecretInput = getProxySecretInput;
window.syncBuckeyeSettingsFromProxySecrets = syncBuckeyeSettingsFromProxySecrets;
window.fetchProxySecrets = fetchProxySecrets;
window.refreshProxySecretStatus = refreshProxySecretStatus;
window.importProxySecrets = importProxySecrets;
window.saveProxySecrets = saveProxySecrets;
window.deleteProxySecrets = deleteProxySecrets;
window.refreshVaultStatus = refreshVaultStatus;
window.logoutBuckeyeVault = logoutBuckeyeVault;
window.testConnection = testConnection;
window.saveAndConnect = saveAndConnect;
window.resumeSession = resumeSession;
window.attemptAutoReconnect = attemptAutoReconnect;
window.updateConnectionStatus = updateConnectionStatus;
