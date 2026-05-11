/**
 * Enforcement Queue Module
 * Phase 3: Manual enforcement workflow for BLACK/RED risk positions.
 * Traders see pending positions, open Buckeye admin, mark as applied.
 */

import { getApiBaseUrl } from '../api.js';
import { escapeHtml, money } from '../utils.js';
import { get } from './state.js';

// ==================== STATE ====================
let queuePollInterval = null;
let currentFilter = 'all';

// ==================== API ====================
async function fetchQueue(status = null, risk_level = null, limit = 50) {
  const res = await fetch(`${getApiBaseUrl()}/api/enforcement/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': get('proxyApiKey') || 'dev-key-123' },
    body: JSON.stringify({ status, risk_level, limit }),
  });
  if (!res.ok) throw new Error(`Queue fetch failed: ${res.status}`);
  return res.json();
}

async function markViewed(queueId, traderName = 'current_user') {
  const res = await fetch(`${getApiBaseUrl()}/api/enforcement/mark-viewed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': get('proxyApiKey') || 'dev-key-123' },
    body: JSON.stringify({ queue_id: queueId, trader_name: traderName }),
  });
  if (!res.ok) throw new Error(`Mark viewed failed: ${res.status}`);
  return res.json();
}

async function markApplied(queueId, traderName = 'current_user') {
  const res = await fetch(`${getApiBaseUrl()}/api/enforcement/mark-applied`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': get('proxyApiKey') || 'dev-key-123' },
    body: JSON.stringify({ queue_id: queueId, trader_name: traderName }),
  });
  if (!res.ok) throw new Error(`Mark applied failed: ${res.status}`);
  return res.json();
}

// ==================== RENDERING ====================
export function renderEnforcementQueue(containerId = 'enforcementQueueContainer') {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="enforcement-queue">
      <div class="queue-header">
        <h2>Enforcement Queue <span id="queueBadge" class="badge">0</span></h2>
        <div class="filter-tabs">
          <button class="filter-tab active" data-filter="all">All</button>
          <button class="filter-tab black" data-filter="BLACK">BLACK</button>
          <button class="filter-tab red" data-filter="RED">RED</button>
        </div>
      </div>
      <div id="queueList" class="queue-list"></div>
    </div>
  `;

  container.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.filter;
      container.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadQueue();
    });
  });

  loadQueue();
  startPolling();
}

async function loadQueue() {
  const list = document.getElementById('queueList');
  const badge = document.getElementById('queueBadge');
  if (!list) return;

  list.innerHTML = '<div class="queue-loading">Loading...</div>';

  try {
    const riskLevel = currentFilter === 'all' ? null : currentFilter;
    const data = await fetchQueue('pending', riskLevel, 50);
    const queue = data.queue || [];

    if (badge) badge.textContent = String(queue.length);

    if (queue.length === 0) {
      list.innerHTML = '<div class="queue-empty">No pending enforcement items.</div>';
      return;
    }

    list.innerHTML = queue.map(item => renderQueueCard(item)).join('');

    // Attach event listeners
    list.querySelectorAll('.btn-open').forEach(btn => {
      btn.addEventListener('click', () => {
        const customerId = btn.dataset.customerId;
        openBuckeyeAdmin(customerId);
      });
    });

    list.querySelectorAll('.btn-apply').forEach(btn => {
      btn.addEventListener('click', async () => {
        const queueId = Number(btn.dataset.queueId);
        btn.disabled = true;
        btn.textContent = 'Applying...';
        try {
          await markApplied(queueId);
          loadQueue();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Mark Applied';
          alert('Failed to mark applied: ' + err.message);
        }
      });
    });

    list.querySelectorAll('.btn-viewed').forEach(btn => {
      btn.addEventListener('click', async () => {
        const queueId = Number(btn.dataset.queueId);
        btn.disabled = true;
        try {
          await markViewed(queueId);
          loadQueue();
        } catch (err) {
          btn.disabled = false;
          alert('Failed to mark viewed: ' + err.message);
        }
      });
    });

  } catch (err) {
    list.innerHTML = `<div class="queue-error">Error loading queue: ${escapeHtml(err.message)}</div>`;
  }
}

function renderQueueCard(item) {
  const tierClass = item.risk_level?.toLowerCase() || 'unknown';
  const timeRemaining = getTimeRemaining(item.expires_at);
  const confidence = item.ai_confidence ? Math.round(item.ai_confidence * 100) : 0;

  return `
    <div class="queue-card tier-${tierClass}">
      <div class="card-header">
        <span class="tier-badge">${escapeHtml(item.risk_level)}</span>
        <span class="confidence">${confidence}% confidence</span>
        <span class="timer ${timeRemaining === 'EXPIRED' ? 'expired' : ''}">${timeRemaining}</span>
      </div>
      <div class="player-info">
        <div class="player-id">${escapeHtml(item.customer_id)}</div>
        <div class="ai-summary">${escapeHtml(item.ai_summary || 'No summary')}</div>
      </div>
      <div class="suggested-limits">
        <div>Max Exposure: <strong>${money(item.suggested_max_exposure || 0)}</strong></div>
        <div>Wager Limit: <strong>${money(item.suggested_wager_limit || 0)}</strong></div>
        <div>Action: <strong>${escapeHtml(item.suggested_action || 'review')}</strong></div>
      </div>
      <div class="card-actions">
        <button class="btn-open" data-customer-id="${escapeHtml(item.customer_id)}">
          Open Buckeye Admin
        </button>
        <button class="btn-viewed" data-queue-id="${item.id}">
          Mark Viewed
        </button>
        <button class="btn-apply" data-queue-id="${item.id}">
          Mark Applied
        </button>
      </div>
      ${item.reminder_count > 0 ? `<div class="reminder-badge">⏰ Reminded ${item.reminder_count}x</div>` : ''}
    </div>
  `;
}

function getTimeRemaining(expiresAt) {
  if (!expiresAt) return 'N/A';
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return 'EXPIRED';
  const mins = Math.floor(diff / 60000);
  return `${mins}m remaining`;
}

function openBuckeyeAdmin(customerId) {
  // Deep link to Buckeye player management page
  // Adjust this URL pattern based on actual Buckeye admin URL structure
  const url = `https://fantasy402.com/manager.html?player=${encodeURIComponent(customerId)}&tab=limits`;
  window.open(url, '_blank');
}

// ==================== POLLING ====================
export function startPolling() {
  if (queuePollInterval) clearInterval(queuePollInterval);
  queuePollInterval = setInterval(loadQueue, 10000); // Poll every 10s
}

export function stopPolling() {
  if (queuePollInterval) {
    clearInterval(queuePollInterval);
    queuePollInterval = null;
  }
}

// ==================== CSS (injected once) ====================
const ENFORCEMENT_CSS = `
.enforcement-queue {
  padding: 1rem;
  max-width: 1200px;
  margin: 0 auto;
}
.queue-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.queue-header h2 {
  margin: 0;
  font-size: 1.25rem;
}
.badge {
  background: var(--accent, #3b82f6);
  color: white;
  border-radius: 999px;
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  margin-left: 0.5rem;
}
.filter-tabs {
  display: flex;
  gap: 0.5rem;
}
.filter-tab {
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--border, #333);
  background: var(--panel, #1a1a1a);
  color: var(--text, #e0e0e0);
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.875rem;
}
.filter-tab.active {
  background: var(--accent, #3b82f6);
  border-color: var(--accent, #3b82f6);
  color: white;
}
.filter-tab.black.active {
  background: #dc2626;
  border-color: #dc2626;
}
.filter-tab.red.active {
  background: #ea580c;
  border-color: #ea580c;
}
.queue-list {
  display: grid;
  gap: 0.75rem;
}
.queue-card {
  background: var(--panel, #1a1a1a);
  border: 1px solid var(--border, #333);
  border-radius: 0.5rem;
  padding: 1rem;
}
.queue-card.tier-black {
  border-left: 4px solid #dc2626;
}
.queue-card.tier-red {
  border-left: 4px solid #ea580c;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
.tier-badge {
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.confidence {
  font-size: 0.75rem;
  color: var(--muted, #888);
}
.timer {
  font-size: 0.75rem;
  color: var(--muted, #888);
}
.timer.expired {
  color: #dc2626;
  font-weight: 600;
}
.player-info {
  margin-bottom: 0.75rem;
}
.player-id {
  font-weight: 600;
  font-size: 1rem;
  margin-bottom: 0.25rem;
}
.ai-summary {
  font-size: 0.875rem;
  color: var(--muted, #888);
  line-height: 1.4;
}
.suggested-limits {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
}
.card-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.card-actions button {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
}
.btn-open {
  background: var(--accent, #3b82f6);
  color: white;
}
.btn-viewed {
  background: var(--panel, #333);
  color: var(--text, #e0e0e0);
  border: 1px solid var(--border, #444);
}
.btn-apply {
  background: #16a34a;
  color: white;
}
.reminder-badge {
  margin-top: 0.5rem;
  font-size: 0.75rem;
  color: #dc2626;
}
.queue-empty, .queue-loading, .queue-error {
  padding: 2rem;
  text-align: center;
  color: var(--muted, #888);
}
.queue-error {
  color: #dc2626;
}
`;

function injectStyles() {
  if (document.getElementById('enforcement-queue-styles')) return;
  const style = document.createElement('style');
  style.id = 'enforcement-queue-styles';
  style.textContent = ENFORCEMENT_CSS;
  document.head.appendChild(style);
}

// Auto-inject styles on first render
if (typeof document !== 'undefined') {
  injectStyles();
}

// ==================== EXPORTS ====================
export { loadQueue, startPolling, stopPolling };
