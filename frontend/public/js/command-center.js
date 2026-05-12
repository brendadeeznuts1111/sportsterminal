import { fetchJson, fetchPost, fetchDelete } from './api.js';
import { COMMAND_CENTER_MAP } from './command-center-map.js';
import { escapeHtml, money, timeAgo } from './utils.js';

const ccState = {
  loaded: false,
  lastTicker: [],
  queueFilter: 'all',
};

function endpoint(name) {
  return COMMAND_CENTER_MAP.endpoints[name];
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function tierColor(tier) {
  if (tier === 'BLACK') return 'var(--red)';
  if (tier === 'RED') return 'var(--red)';
  if (tier === 'YELLOW') return 'var(--yellow)';
  if (tier === 'GREEN') return 'var(--green)';
  return 'var(--text-dim)';
}

function statusChip(value) {
  const status = String(value || 'unknown');
  const color = status === 'applied' ? 'var(--green)' : status === 'pending' ? 'var(--yellow)' : status === 'expired' ? 'var(--text-dim)' : 'var(--blue)';
  return `<span class="px-2 py-0.5 rounded font-mono" style="background:${color}22;color:${color};border:1px solid ${color}55;">${escapeHtml(status)}</span>`;
}

function tierChip(value) {
  const tier = String(value || 'UNKNOWN').toUpperCase();
  const color = tierColor(tier);
  return `<span class="px-2 py-0.5 rounded font-mono" style="background:${color}22;color:${color};border:1px solid ${color}55;">${escapeHtml(tier)}</span>`;
}

function renderEmpty(id, label) {
  setHtml(id, `<div class="text-xs text-center py-4" style="color:var(--text-dim);">${escapeHtml(label)}</div>`);
}

async function renderDashboardSummary() {
  try {
    const summary = await fetchJson('/api/dashboard/summary');
    setText('ccDashOpen', summary.open_positions ?? 0);
    setText('ccDashPending', summary.pending_review ?? 0);
    setText('ccDashAutoBlocks', summary.auto_blocks_24h ?? 0);
    setText('ccDashBreaches', summary.breaches_24h ?? 0);
  } catch (error) {
    console.warn('[CommandCenter] summary failed:', error.message);
  }
}

async function renderRiskSummary() {
  try {
    const summary = await fetchJson('/api/risk/summary');
    const stats = summary.positions || {};
    setText('ccTotal', stats.total ?? 0);
    setText('ccPending', stats.pending ?? 0);
    setText('ccApplied', stats.applied ?? 0);
    setText('ccOverridden', stats.overridden ?? 0);
    setText('ccExpired', stats.expired ?? 0);
    setText('ccAutoBlocked', stats.auto_blocked ?? 0);
  } catch (error) {
    console.warn('[CommandCenter] risk summary failed:', error.message);
  }
}

async function renderRuntimeMap() {
  try {
    const [status, map] = await Promise.all([
      fetchJson(endpoint('backendStatus')),
      fetchJson(endpoint('backendMap')),
    ]);
    const runtime = status.runtime || status;
    const health = status.status || status.overall || 'online';
    setText('ccRuntimeStatus', health);
    setText('ccRuntimeLatest', `Latest check ${new Date().toLocaleTimeString()}`);
    setText('ccRuntimeWagers', runtime.wagers?.live ?? runtime.wagers ?? '—');
    setText('ccRuntimeFeatures', runtime.features?.total ?? runtime.features ?? '—');
    setText('ccRuntimeCoverage', runtime.coverage?.percent ? `${runtime.coverage.percent}%` : '—');
    setText('ccRuntimeIngestion', runtime.ingestion?.overall ?? runtime.ingestion ?? '—');
    setText('ccRuntimeSse', window.liveSseClient?.source ? 'live' : 'idle');

    const endpoints = Object.entries(map.endpoints || {}).slice(0, 12);
    setHtml('ccRuntimeMap', endpoints.map(([key, meta]) => `
      <span class="px-2 py-1 rounded font-mono" style="background:var(--bg);border:1px solid var(--border);color:var(--text-dim);">
        ${escapeHtml(key)} <span style="color:var(--green);">${escapeHtml(meta.method || 'GET')}</span>
      </span>
    `).join(''));
  } catch (error) {
    setText('ccRuntimeStatus', 'degraded');
    setText('ccRuntimeLatest', error.message);
  }
}

async function renderBookExposure() {
  try {
    const rows = await fetchJson(endpoint('dashboardExposure'));
    if (!rows.length) return renderEmpty('ccBookExposure', 'No exposure rows yet');
    const max = Math.max(...rows.map((r) => Number(r.total_risk || 0)), 1);
    setHtml('ccBookExposure', rows.slice(0, 10).map((row) => {
      const pct = Math.min(100, Number(row.total_risk || 0) / max * 100);
      return `
        <div class="flex items-center gap-2">
          <div class="w-24 truncate font-mono">${escapeHtml(row.agent_login || 'unknown')}</div>
          <div class="flex-1 h-2 rounded overflow-hidden" style="background:var(--bg);">
            <div style="width:${pct.toFixed(0)}%;height:100%;background:var(--accent);"></div>
          </div>
          <div class="w-20 text-right font-mono">${money(row.total_risk || 0)}</div>
          <div class="w-14 text-right" style="color:var(--text-dim);">${row.wager_count || 0}</div>
        </div>`;
    }).join(''));
  } catch (error) {
    renderEmpty('ccBookExposure', `Exposure unavailable: ${error.message}`);
  }
}

async function renderSharpAlerts() {
  try {
    const rows = await fetchJson(endpoint('dashboardSharpAlerts'));
    if (!rows.length) return renderEmpty('ccSharpAlerts', 'No sharp alerts for this window');
    setHtml('ccSharpAlerts', rows.slice(0, 12).map((row) => `
      <div class="rounded p-2 flex items-center gap-3" style="background:var(--bg);border:1px solid var(--border);">
        ${tierChip(row.risk_level)}
        <button class="font-mono hover:underline" onclick="viewPlayer('${escapeJsString(row.customer_id)}')">${escapeHtml(row.customer_id)}</button>
        <span style="color:var(--text-dim);">sharp ${Number(row.sharp_score || 0).toFixed(1)}</span>
        <span style="color:var(--text-dim);">win ${(Number(row.win_rate || 0) * 100).toFixed(0)}%</span>
        <span class="ml-auto">${money(row.total_volume || 0)}</span>
      </div>
    `).join(''));
  } catch (error) {
    renderEmpty('ccSharpAlerts', `Sharp alerts unavailable: ${error.message}`);
  }
}

async function renderExposureBuckets() {
  try {
    const rows = await fetchJson('/api/dashboard/buckets');
    if (!rows.length) return renderEmpty('ccExposureBuckets', 'No buckets yet');
    const max = Math.max(...rows.map((r) => Number(r.exposure || 0)), 1);
    setHtml('ccExposureBuckets', rows.map((row) => {
      const pct = Math.min(100, Number(row.exposure || 0) / max * 100);
      return `
        <div>
          <div class="flex justify-between mb-1"><span>${escapeHtml(row.bucket)}</span><span>${money(row.exposure || 0)}</span></div>
          <div class="h-1.5 rounded overflow-hidden" style="background:var(--bg);"><div style="width:${pct.toFixed(0)}%;height:100%;background:var(--purple);"></div></div>
        </div>`;
    }).join(''));
  } catch (error) {
    renderEmpty('ccExposureBuckets', `Buckets unavailable: ${error.message}`);
  }
}

async function renderPnlChart() {
  try {
    const days = document.getElementById('ccPnlDays')?.value || '30';
    const rows = await fetchJson(`/api/dashboard/pnl?days=${encodeURIComponent(days)}`);
    if (!rows.length) return renderEmpty('ccPnlChart', 'No P&L history yet');
    const max = Math.max(...rows.map((r) => Math.abs(Number(r.net || 0))), 1);
    setHtml('ccPnlChart', rows.slice(-30).map((row) => {
      const net = Number(row.net || 0);
      const width = Math.min(100, Math.abs(net) / max * 100);
      const color = net >= 0 ? 'var(--green)' : 'var(--red)';
      return `
        <div class="grid grid-cols-[80px_1fr_90px] items-center gap-2">
          <span style="color:var(--text-dim);">${escapeHtml(row.day)}</span>
          <div class="h-2 rounded overflow-hidden" style="background:var(--bg);"><div style="width:${width.toFixed(0)}%;height:100%;background:${color};"></div></div>
          <span class="text-right font-mono">${money(net)}</span>
        </div>`;
    }).join(''));
  } catch (error) {
    renderEmpty('ccPnlChart', `P&L unavailable: ${error.message}`);
  }
}

async function renderPositions() {
  try {
    const status = document.getElementById('ccStatusFilter')?.value || '';
    const level = document.getElementById('ccLevelFilter')?.value || '';
    const params = new URLSearchParams({ limit: '50' });
    if (status) params.set('status', status);
    if (level) params.set('risk_level', level);
    const data = await fetchJson(`/api/risk/positions?${params}`);
    const rows = data.positions || [];
    if (!rows.length) {
      setHtml('ccPositionsTable', `<tr><td colspan="9" class="text-center py-4" style="color:var(--text-dim);">No positions match the current filters</td></tr>`);
      return;
    }
    setHtml('ccPositionsTable', rows.map((row) => `
      <tr style="border-top:1px solid var(--border);">
        <td class="px-3 py-2 font-mono"><button class="hover:underline" onclick="viewPlayer('${escapeJsString(row.customer_id)}')">${escapeHtml(row.customer_id)}</button></td>
        <td class="px-3 py-2 text-center">${tierChip(row.risk_level)}</td>
        <td class="px-3 py-2 text-right">${money(row.suggested_max_exposure || 0)}</td>
        <td class="px-3 py-2 text-right">${money(row.suggested_wager_limit || 0)}</td>
        <td class="px-3 py-2 text-center">${escapeHtml(row.suggested_action || 'review')}</td>
        <td class="px-3 py-2 text-center">${statusChip(row.status)}</td>
        <td class="px-3 py-2 text-center">${Math.round(Number(row.ai_confidence || 0) * 100)}%</td>
        <td class="px-3 py-2 text-center" style="color:var(--text-dim);">${timeAgo(row.created_at)}</td>
        <td class="px-3 py-2 text-center">
          <button class="px-2 py-1 rounded" style="background:var(--bg);border:1px solid var(--border);" onclick="ccAnalyzeLive('${escapeJsString(row.customer_id)}')">Analyze</button>
          ${row.status === 'pending' ? `
            <button class="px-2 py-1 rounded ml-1" style="background:var(--green);color:#fff;" onclick="ccApplyPosition(${row.id}, '${escapeJsString(row.customer_id)}', ${Number(row.suggested_wager_limit || 0)}, ${Number(row.suggested_max_exposure || 0)})">Apply</button>
            <button class="px-2 py-1 rounded ml-1" style="background:var(--yellow);color:#000;" onclick="ccOverridePosition(${row.id}, '${escapeJsString(row.customer_id)}')">Override</button>
            ${String(row.risk_level).toUpperCase() === 'BLACK' ? `<button class="px-2 py-1 rounded ml-1" style="background:var(--red);color:#fff;" onclick="ccBlockPlayer(${row.id}, '${escapeJsString(row.customer_id)}')">Block</button>` : ''}
          ` : ''}
        </td>
      </tr>
    `).join(''));
  } catch (error) {
    setHtml('ccPositionsTable', `<tr><td colspan="9" class="text-center py-4" style="color:var(--red);">${escapeHtml(error.message)}</td></tr>`);
  }
}

async function renderViolations() {
  try {
    const data = await fetchJson('/api/risk/violations');
    const types = Object.entries(data);
    if (!types.length) return renderEmpty('ccViolations', 'No violations in the last 24h');
    const max = Math.max(...types.map(([, count]) => Number(count || 0)), 1);
    setHtml('ccViolations', types.map(([type, count]) => {
      const pct = Math.min(100, Number(count || 0) / max * 100);
      return `
        <div class="flex items-center gap-2">
          <div class="w-32 truncate font-mono">${escapeHtml(type)}</div>
          <div class="flex-1 h-2 rounded overflow-hidden" style="background:var(--bg);">
            <div style="width:${pct.toFixed(0)}%;height:100%;background:var(--red);"></div>
          </div>
          <div class="w-14 text-right font-mono">${count}</div>
        </div>`;
    }).join(''));
  } catch (error) {
    renderEmpty('ccViolations', `Violations unavailable: ${error.message}`);
  }
}

async function renderTimeseries() {
  try {
    const days = document.getElementById('ccTimeseriesDays')?.value || '30';
    const rows = await fetchJson(`/api/risk/timeseries?days=${encodeURIComponent(days)}`);
    if (!rows.length) return renderEmpty('ccTimeseries', 'No timeseries data yet');
    const max = Math.max(...rows.map((r) => Math.abs(Number(r.net || 0))), 1);
    setHtml('ccTimeseries', rows.slice(-30).map((row) => {
      const net = Number(row.net || 0);
      const width = Math.min(100, Math.abs(net) / max * 100);
      const color = net >= 0 ? 'var(--green)' : 'var(--red)';
      return `
        <div class="grid grid-cols-[80px_1fr_90px] items-center gap-2">
          <span style="color:var(--text-dim);">${escapeHtml(row.date)}</span>
          <div class="h-2 rounded overflow-hidden" style="background:var(--bg);"><div style="width:${width.toFixed(0)}%;height:100%;background:${color};"></div></div>
          <span class="text-right font-mono">${money(net)}</span>
        </div>`;
    }).join(''));
  } catch (error) {
    renderEmpty('ccTimeseries', `Timeseries unavailable: ${error.message}`);
  }
}

async function renderWriteLog() {
  try {
    const customerId = document.getElementById('ccWriteLogCustomer')?.value?.trim();
    const params = new URLSearchParams({ limit: '25' });
    if (customerId) params.set('customer_id', customerId);
    const data = await fetchJson(`/api/enforcement/write-log?${params}`);
    const rows = data.writes || [];
    if (!rows.length) {
      setHtml('ccWriteLogTable', `<tr><td colspan="7" class="text-center py-4" style="color:var(--text-dim);">No write operations yet</td></tr>`);
      return;
    }
    setHtml('ccWriteLogTable', rows.map((row) => {
      const statusColor = row.success ? 'var(--green)' : 'var(--red)';
      const statusLabel = row.success ? 'OK' : 'FAIL';
      return `
        <tr style="border-top:1px solid var(--border);">
          <td class="px-2 py-1 font-mono" style="color:var(--text-dim);">${new Date(row.timestamp).toLocaleString()}</td>
          <td class="px-2 py-1">${escapeHtml(row.operation)}</td>
          <td class="px-2 py-1 font-mono">${escapeHtml(row.customer_id)}</td>
          <td class="px-2 py-1">${escapeHtml(row.column_name || '-')}</td>
          <td class="px-2 py-1 font-mono">${escapeHtml(row.new_value || row.amount_cents || '-')}</td>
          <td class="px-2 py-1 text-center"><span class="px-1.5 py-0.5 rounded text-xs font-mono" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}55;">${statusLabel}</span></td>
          <td class="px-2 py-1">${escapeHtml(row.trader_name || '-')}</td>
        </tr>
      `;
    }).join(''));
  } catch (error) {
    setHtml('ccWriteLogTable', `<tr><td colspan="7" class="text-center py-4" style="color:var(--red);">${escapeHtml(error.message)}</td></tr>`);
  }
}

async function renderTelegram() {
  try {
    const purpose = document.getElementById('ccTelegramFilter')?.value || 'all';
    const [topicsData, channelsData] = await Promise.all([
      fetchJson(`/api/telegram/topics?purpose=${encodeURIComponent(purpose)}`),
      fetchJson('/api/telegram/channels'),
    ]);
    const topics = topicsData.topics || [];
    const channels = channelsData.channels || [];

    if (!topics.length) {
      renderEmpty('ccTelegramTopics', 'No Telegram topics found');
    } else {
      setHtml('ccTelegramTopics', topics.map((t) => {
        const deeplink = t.supergroup_chat_id && t.topic_thread_id
          ? `https://t.me/c/${String(t.supergroup_chat_id).replace('-100', '')}/${t.topic_thread_id}`
          : null;
        const purposeColor = t.supergroup_purpose === 'system_internal' ? 'var(--blue)' : 'var(--cyan)';
        return `
        <div class="rounded mb-1" style="background:var(--bg);border:1px solid var(--border);">
          <div class="flex items-center gap-2 p-2">
            <span class="px-1.5 py-0.5 rounded font-mono text-xs" style="background:${purposeColor}22;color:${purposeColor};border:1px solid ${purposeColor}55;">${escapeHtml(t.supergroup_purpose === 'system_internal' ? 'SYS' : 'AGT')}</span>
            <span class="font-mono text-xs" style="color:var(--text);">${escapeHtml(t.agent_login || t.topic_name)}</span>
            <span class="text-xs truncate" style="color:var(--text-dim);max-width:200px;">${escapeHtml(t.topic_name)}</span>
            ${t.topic_icon ? `<span class="text-xs" style="color:var(--text-dim);">${escapeHtml(t.topic_icon)}</span>` : ''}
            ${t.topic_hex_color ? `<span class="px-1 py-0.5 rounded text-xs font-mono" style="background:#${escapeHtml(t.topic_hex_color)}22;color:#${escapeHtml(t.topic_hex_color)};">#${escapeHtml(t.topic_hex_color)}</span>` : ''}
            <span class="ml-auto text-xs font-mono" style="color:var(--text-dim);">thread ${t.topic_thread_id}</span>
            ${deeplink ? `<a href="${escapeHtml(deeplink)}" target="_blank" rel="noopener" class="px-2 py-0.5 rounded text-xs font-medium" style="background:var(--accent);color:#fff;">Open</a>` : ''}
            <button class="px-2 py-0.5 rounded text-xs font-medium" style="background:var(--panel);border:1px solid var(--border);color:var(--text);" onclick="ccToggleTopicMessages(${t.id})">Messages</button>
          </div>
          <div id="ccTopicMsgs_${t.id}" class="hidden px-2 pb-2">
            <div id="ccTopicMsgsList_${t.id}" class="space-y-1 mb-2 max-h-40 overflow-y-auto"></div>
            <div class="flex items-center gap-2">
              <input id="ccTopicMsgInput_${t.id}" type="text" placeholder="Type a message…" class="flex-1 px-2 py-1 rounded text-xs" style="background:var(--panel);border:1px solid var(--border);color:var(--text);" onkeydown="if(event.key==='Enter')ccSendTopicMessage(${t.id})">
              <button class="px-2 py-1 rounded text-xs font-medium" style="background:var(--green);color:#fff;" onclick="ccSendTopicMessage(${t.id})">Send</button>
            </div>
          </div>
        </div>`;
      }).join(''));
    }

    if (!channels.length) {
      renderEmpty('ccTelegramChannels', 'No broadcast channels registered');
    } else {
      setHtml('ccTelegramChannels', channels.map((c) => `
        <div class="flex items-center gap-2 rounded p-2 mb-1" style="background:var(--bg);border:1px solid var(--border);">
          <span class="px-1.5 py-0.5 rounded font-mono text-xs" style="background:var(--purple)22;color:var(--purple);border:1px solid var(--purple)55;">${escapeHtml(c.channel_type || 'broadcast')}</span>
          <span class="font-mono text-xs" style="color:var(--text);">${escapeHtml(c.channel_name)}</span>
          <span class="text-xs" style="color:var(--text-dim);">${escapeHtml(c.purpose || '')}</span>
          <span class="ml-auto text-xs" style="color:${c.is_active ? 'var(--green)' : 'var(--text-dim)'}">${c.is_active ? 'Active' : 'Inactive'}</span>
          ${c.telegram_chat_id ? `<span class="text-xs font-mono" style="color:var(--text-dim);">${escapeHtml(c.telegram_chat_id)}</span>` : ''}
        </div>
      `).join(''));
    }
  } catch (error) {
    renderEmpty('ccTelegramTopics', `Telegram unavailable: ${error.message}`);
    renderEmpty('ccTelegramChannels', `Channels unavailable: ${error.message}`);
  }
}

export async function ccToggleTopicMessages(topicId) {
  const el = document.getElementById(`ccTopicMsgs_${topicId}`);
  if (!el) return;
  const isHidden = el.classList.contains('hidden');
  if (isHidden) {
    el.classList.remove('hidden');
    await ccLoadTopicMessages(topicId);
  } else {
    el.classList.add('hidden');
  }
}

async function ccLoadTopicMessages(topicId) {
  const target = document.getElementById(`ccTopicMsgsList_${topicId}`);
  if (!target) return;
  target.innerHTML = '<span class="text-xs" style="color:var(--text-dim);">Loading…</span>';
  try {
    const data = await fetchJson(`/api/telegram/topics/${topicId}/messages?limit=20`);
    const messages = data.messages || [];
    if (!messages.length) {
      target.innerHTML = '<span class="text-xs" style="color:var(--text-dim);">No messages yet</span>';
      return;
    }
    target.innerHTML = messages.map((m) => `
      <div class="flex items-start gap-2 rounded p-1.5 ${m.is_pinned ? 'border-l-2' : ''}" style="background:var(--panel);${m.is_pinned ? 'border-color:var(--yellow);' : ''}">
        <span class="text-xs font-mono shrink-0" style="color:var(--text-dim);">${escapeHtml(m.sender)}</span>
        <span class="text-xs" style="color:var(--text);">${escapeHtml(m.text)}</span>
        ${m.is_pinned ? '<span class="text-xs" style="color:var(--yellow);">📌</span>' : ''}
        <span class="ml-auto text-xs shrink-0" style="color:var(--text-dim);">${new Date(m.sent_at).toLocaleString()}</span>
      </div>
    `).join('');
  } catch (error) {
    target.innerHTML = `<span class="text-xs" style="color:var(--red);">${escapeHtml(error.message)}</span>`;
  }
}

export async function ccSendTopicMessage(topicId) {
  const input = document.getElementById(`ccTopicMsgInput_${topicId}`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  try {
    await fetchPost(`/api/telegram/topics/${topicId}/messages`, { text, pin: false });
    input.value = '';
    await ccLoadTopicMessages(topicId);
  } catch (error) {
    window.alert(`Failed to send: ${error.message}`);
  }
}

async function renderWebhookHealth() {
  try {
    const rows = await fetchJson('/api/risk/webhooks/health');
    if (!rows.length) return renderEmpty('ccWebhookHealth', 'No webhook configs tracked');
    setHtml('ccWebhookHealth', rows.map((row) => {
      const state = String(row.state || 'unknown');
      const color = state === 'closed' ? 'var(--green)' : state === 'degraded' ? 'var(--yellow)' : 'var(--red)';
      return `
        <div class="flex items-center gap-2 rounded p-2" style="background:var(--bg);border:1px solid var(--border);">
          <span class="px-2 py-0.5 rounded font-mono" style="background:${color}22;color:${color};border:1px solid ${color}55;">${escapeHtml(state)}</span>
          <span class="font-mono truncate" style="color:var(--text-dim);">${escapeHtml(row.url || '')}</span>
          <span class="ml-auto" style="color:var(--text-dim);">failures ${row.consecutiveFailures || 0}</span>
        </div>`;
    }).join(''));
  } catch (error) {
    renderEmpty('ccWebhookHealth', `Webhook health unavailable: ${error.message}`);
  }
}

async function renderEnforcementQueue() {
  try {
    const risk = ccState.queueFilter === 'all' ? null : ccState.queueFilter;
    const data = await fetchPost(endpoint('enforcementQueue'), { status: 'pending', risk_level: risk, limit: 50 });
    const rows = data.queue || [];
    setText('ccEnforcementCount', rows.length ? String(rows.length) : '0');
    if (!rows.length) return renderEmpty('ccEnforcementQueue', 'No manual enforcement items pending');
    setHtml('ccEnforcementQueue', rows.map((item) => `
      <div class="rounded p-3" style="background:var(--bg);border:1px solid var(--border);border-left:3px solid ${tierColor(item.risk_level)};">
        <div class="flex items-center gap-2 mb-2">
          ${tierChip(item.risk_level)}
          <button class="font-mono font-bold hover:underline" onclick="viewPlayer('${escapeJsString(item.customer_id)}')">${escapeHtml(item.customer_id)}</button>
          <span style="color:var(--text-dim);">${Math.round(Number(item.ai_confidence || 0) * 100)}% confidence</span>
          <span class="ml-auto font-mono" style="color:var(--yellow);">${timeRemaining(item.expires_at)}</span>
        </div>
        <div class="text-xs mb-2" style="color:var(--text-dim);">${escapeHtml(item.ai_summary || 'No AI summary captured.')}</div>
        <div class="grid grid-cols-2 gap-2 text-xs mb-3">
          <div>Max exposure <strong>${money(item.suggested_max_exposure || 0)}</strong></div>
          <div>Wager limit <strong>${money(item.suggested_wager_limit || 0)}</strong></div>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="px-2 py-1 rounded text-xs font-medium" style="background:var(--accent);color:#fff;" onclick="ccOpenBuckeyeAdmin(${item.id}, '${escapeJsString(item.buckeye_admin_url || '')}', '${escapeJsString(item.customer_id)}')">Open Buckeye Admin</button>
          <button class="px-2 py-1 rounded text-xs font-medium" style="background:var(--green);color:#fff;" onclick="ccMarkEnforcementApplied(${item.id})">Mark Applied</button>
          <button class="px-2 py-1 rounded text-xs font-medium" style="background:var(--panel);border:1px solid var(--border);color:var(--text);" onclick="ccEscalateEnforcement(${item.id})">Escalate</button>
          ${item.reminder_count > 0 ? `<span class="px-2 py-1 rounded text-xs" style="background:var(--yellow)22;color:var(--yellow);">Reminded ${item.reminder_count}x</span>` : ''}
        </div>
      </div>
    `).join(''));
  } catch (error) {
    renderEmpty('ccEnforcementQueue', `Queue unavailable: ${error.message}`);
  }
}

async function renderAlertLog() {
  try {
    const rows = await fetchJson('/api/risk-alerts/log?limit=25');
    if (!rows.length) {
      setHtml('ccAlertLogTable', `<tr><td colspan="5" class="text-center py-4" style="color:var(--text-dim);">No alert deliveries yet</td></tr>`);
      return;
    }
    setHtml('ccAlertLogTable', rows.map((row) => `
      <tr style="border-top:1px solid var(--border);">
        <td class="px-3 py-2 font-mono">${escapeHtml(row.customer_id || '')}</td>
        <td class="px-3 py-2 text-center">${tierChip(row.risk_level)}</td>
        <td class="px-3 py-2 text-center">${escapeHtml(row.platform || '')}</td>
        <td class="px-3 py-2 text-center">${row.response_status}</td>
        <td class="px-3 py-2 text-center" style="color:var(--text-dim);">${timeAgo(row.sent_at)}</td>
      </tr>
    `).join(''));
  } catch (error) {
    setHtml('ccAlertLogTable', `<tr><td colspan="5" class="text-center py-4" style="color:var(--red);">${escapeHtml(error.message)}</td></tr>`);
  }
}

function renderTickerEvent(type, payload) {
  const label = type === 'wager' ? `Wager ${payload?.customer_id || payload?.login || ''}` : type === 'risk_alert' ? `Alert ${payload?.risk_level || ''}` : type;
  ccState.lastTicker.unshift({ label, payload, at: Date.now() });
  ccState.lastTicker = ccState.lastTicker.slice(0, 8);
  setHtml('ccTicker', ccState.lastTicker.map((item) => `
    <span><span style="color:var(--green);">${escapeHtml(item.label)}</span> <span style="color:var(--text-dim);">${new Date(item.at).toLocaleTimeString()}</span></span>
  `).join(''));
}

function setSseStatus(status) {
  setText('ccSseLabel', `SSE: ${status}`);
  const dot = document.getElementById('ccSseDot');
  if (dot) dot.style.background = status === 'live' ? 'var(--green)' : status === 'error' ? 'var(--red)' : 'var(--yellow)';
}

export async function loadCommandCenter() {
  await Promise.allSettled([
    renderDashboardSummary(),
    renderRiskSummary(),
    renderRuntimeMap(),
    renderBookExposure(),
    renderSharpAlerts(),
    renderExposureBuckets(),
    renderPnlChart(),
    renderTimeseries(),
    renderPositions(),
    renderViolations(),
    renderWebhookHealth(),
    renderWebhookChannels(),
    renderWriteLog(),
    renderTelegram(),
    renderEnforcementQueue(),
    renderAlertLog(),
  ]);
}

export function renderCommandCenter() {
  if (!ccState.loaded) {
    ccState.loaded = true;
    window.addEventListener(COMMAND_CENTER_MAP.sse.browserEventPrefix, (event) => {
      setSseStatus('live');
      renderTickerEvent(event.detail?.type, event.detail?.payload || {});
    });
  }
  setSseStatus(window.liveSseClient?.source ? 'live' : 'idle');
  loadCommandCenter();
}

export async function ccPlayerSuggest(query) {
  const target = document.getElementById('ccPlayerSuggestList');
  if (!target) return;
  if (!query || query.length < 2) {
    target.innerHTML = '';
    return;
  }
  try {
    const data = await fetchJson(`/api/players/suggest?q=${encodeURIComponent(query)}&limit=8`);
    const rows = data.suggestions || data || [];
    target.innerHTML = rows.map((row) => `
      <button class="w-full text-left rounded px-2 py-1 hover:bg-slate-800" onclick="viewPlayer('${escapeJsString(row.customer_id || row.id || row.login)}')">
        <span class="font-mono">${escapeHtml(row.customer_id || row.id || row.login || '')}</span>
        <span style="color:var(--text-dim);">${escapeHtml(row.name || row.display_name || '')}</span>
      </button>
    `).join('');
  } catch (error) {
    target.innerHTML = `<div style="color:var(--red);">${escapeHtml(error.message)}</div>`;
  }
}

export function ccRefreshPnlChart() {
  renderPnlChart();
}

export function ccRefreshTimeseries() {
  renderTimeseries();
}

export function ccRefreshViolations() {
  renderViolations();
}

export function ccRefreshWebhookHealth() {
  renderWebhookHealth();
}

export function ccRefreshTelegram() {
  // Stub: Telegram refresh not yet implemented
  console.log('[CommandCenter] ccRefreshTelegram called');
}

export function ccRefreshWriteLog() {
  // Stub: Write log refresh not yet implemented
  console.log('[CommandCenter] ccRefreshWriteLog called');
}

export function ccSetEnforcementFilter(filter) {
  ccState.queueFilter = filter || 'all';
  for (const id of ['ccQueueFilterAll', 'ccQueueFilterBlack', 'ccQueueFilterRed']) {
    const el = document.getElementById(id);
    if (el) el.style.background = 'var(--panel)';
  }
  const active = document.getElementById(filter === 'BLACK' ? 'ccQueueFilterBlack' : filter === 'RED' ? 'ccQueueFilterRed' : 'ccQueueFilterAll');
  if (active) active.style.background = 'var(--accent)';
  renderEnforcementQueue();
}

export async function ccOpenBuckeyeAdmin(queueId, url, customerId) {
  await fetchPost(endpoint('enforcementMarkViewed'), { queue_id: queueId, trader_name: currentTraderName() }).catch(() => null);
  window.open(url || `https://fantasy402.com/manager.html?player=${encodeURIComponent(customerId)}&tab=limits`, '_blank', 'noopener');
  renderEnforcementQueue();
}

export async function ccMarkEnforcementApplied(queueId) {
  const trader = currentTraderName();
  const actualWagerLimit = Number(window.prompt('Applied wager limit? Leave blank to use AI suggestion.', '') || NaN);
  await fetchPost(endpoint('enforcementMarkApplied'), {
    queue_id: queueId,
    trader_name: trader,
    ...(Number.isFinite(actualWagerLimit) ? { actual_wager_limit: actualWagerLimit } : {}),
  });
  await loadCommandCenter();
}

export async function ccEscalateEnforcement(queueId) {
  const note = window.prompt('Escalation note', 'Needs senior trader review') || 'Needs senior trader review';
  await fetchPost(endpoint('enforcementEscalate'), { queue_id: queueId, trader_name: currentTraderName(), note });
  await loadCommandCenter();
}

export async function ccAnalyzeLive(customerId) {
  const result = await fetchPost(endpoint('analyzeLive'), { customer_id: customerId, forceRefresh: true });
  window.alert(`${result.analysis?.risk_level || 'UNKNOWN'}: ${result.analysis?.summary || 'Analysis complete'}`);
  await loadCommandCenter();
}

export async function ccApplyPosition(positionId, customerId, suggestedWagerLimit, suggestedMaxExposure) {
  const trader = currentTraderName();
  const actualWagerLimit = Number(window.prompt(`Apply position for ${customerId}? Wager limit (blank = AI suggestion):`, suggestedWagerLimit || '') || NaN);
  const note = window.prompt('Execution note (optional):', '') || '';
  const wagerCents = Number.isFinite(actualWagerLimit) ? Math.round(actualWagerLimit * 100) : Math.round((suggestedWagerLimit || 0) * 100);
  const creditCents = Math.round((suggestedMaxExposure || 0) * 100);
  if (wagerCents > 0 || creditCents > 0) {
    await fetchPost('/api/enforcement/apply-limit', {
      customer_id: customerId,
      max_wager_cents: wagerCents,
      max_credit_cents: creditCents,
      trader_name: trader,
      note: note || 'Applied from Command Center',
    });
  }
  await fetchPost('/api/positions/execute', {
    position_id: positionId,
    action: 'apply',
    trader_name: trader,
    ...(Number.isFinite(actualWagerLimit) ? { wager_limit: actualWagerLimit } : {}),
    ...(note ? { note } : {}),
  });
  await loadCommandCenter();
}

export async function ccOverridePosition(positionId, customerId) {
  const trader = currentTraderName();
  const reason = window.prompt(`Override position for ${customerId}. Reason required:`, 'Trader discretion') || 'Trader discretion';
  await fetchPost('/api/positions/override', {
    position_id: positionId,
    reason,
    trader_name: trader,
  });
  await loadCommandCenter();
}

export async function ccBlockPlayer(positionId, customerId) {
  if (!window.confirm(`BLOCK player ${customerId}? This will zero all limits and suspend the account in Buckeye.`)) return;
  const trader = currentTraderName();
  await fetchPost('/api/enforcement/block-player', {
    customer_id: customerId,
    trader_name: trader,
    note: 'Full block from Command Center',
  });
  await fetchPost('/api/positions/execute', {
    position_id: positionId,
    action: 'block',
    trader_name: trader,
    note: 'Full block executed via Buckeye updateByColumn',
  });
  await loadCommandCenter();
}

export function toggleCcWebhookForm() {
  document.getElementById('ccWebhookForm')?.classList.toggle('hidden');
}

export async function addCcWebhook() {
  const name = document.getElementById('ccHookName')?.value?.trim();
  const platform = document.getElementById('ccHookPlatform')?.value;
  const url = document.getElementById('ccHookUrl')?.value?.trim();
  const triggersRaw = document.getElementById('ccHookTriggers')?.value || '[]';
  if (!name || !url) {
    window.alert('Name and URL are required');
    return;
  }
  let triggers = [];
  try {
    triggers = JSON.parse(triggersRaw);
    if (!Array.isArray(triggers)) throw new Error('triggers must be an array');
  } catch {
    window.alert('Triggers must be a valid JSON array');
    return;
  }
  await fetchPost('/api/webhooks', { name, platform, url, triggers, enabled: true });
  toggleCcWebhookForm();
  await renderWebhookChannels();
}

export async function ccDeleteWebhook(id) {
  if (!window.confirm('Delete this webhook channel?')) return;
  await fetchDelete(`/api/webhooks/${id}`);
  await renderWebhookChannels();
}

async function renderWebhookChannels() {
  try {
    const rows = await fetchJson('/api/webhooks');
    if (!rows.length) return renderEmpty('ccWebhookList', 'No alert channels configured');
    setHtml('ccWebhookList', rows.map((row) => `
      <div class="flex items-center gap-2 rounded p-2" style="background:var(--bg);border:1px solid var(--border);">
        <span class="px-2 py-0.5 rounded font-mono text-xs" style="background:var(--accent);color:#fff;">${escapeHtml(row.platform)}</span>
        <span class="font-mono text-xs truncate" style="color:var(--text);">${escapeHtml(row.name)}</span>
        <span class="text-xs" style="color:var(--text-dim);">${(row.triggers || []).join(', ')}</span>
        <span class="ml-auto text-xs" style="color:${row.enabled ? 'var(--green)' : 'var(--text-dim)'};">${row.enabled ? 'ON' : 'OFF'}</span>
        <button class="px-2 py-0.5 rounded text-xs" style="background:var(--red);color:#fff;" onclick="ccDeleteWebhook(${row.id})">Delete</button>
      </div>
    `).join(''));
  } catch (error) {
    renderEmpty('ccWebhookList', `Channels unavailable: ${error.message}`);
  }
}

export function toggleCcAbTestForm() {
  document.getElementById('ccAbTestForm')?.classList.toggle('hidden');
}

export async function ccRunAbTest() {
  const customer = document.getElementById('ccAbCustomer')?.value?.trim();
  const promptA = document.getElementById('ccAbPromptA')?.value || '';
  const promptB = document.getElementById('ccAbPromptB')?.value || '';
  const status = document.getElementById('ccAbStatus');
  if (!customer) {
    if (status) status.textContent = 'Customer ID required';
    return;
  }
  const res = await fetchPost(endpoint('shadowAb'), { customer_ids: [customer], prompt_a: promptA, prompt_b: promptB, name: `Manual ${customer}` });
  if (status) status.textContent = `Started shadow A/B #${res.id}`;
}

export function ccStartStreamAnalysis() {
  const customer = document.getElementById('ccStreamCustomer')?.value?.trim();
  if (!customer) return;
  ccAnalyzeLive(customer);
}

export function ccStopStreamAnalysis() {
  setHtml('ccStreamOutput', '<span style="color:var(--text-dim);">No active stream.</span>');
}

function currentTraderName() {
  return localStorage.getItem('operatorName') || localStorage.getItem('agentId') || 'operator';
}

function timeRemaining(value) {
  if (!value) return 'no expiry';
  const diff = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return 'expired';
  const mins = Math.floor(diff / 60_000);
  return `${mins}m left`;
}

function escapeJsString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    renderCommandCenter,
    loadCommandCenter,
    ccPlayerSuggest,
    ccRefreshPnlChart,
    ccRefreshTimeseries,
    ccRefreshViolations,
    ccRefreshWebhookHealth,
    ccRefreshTelegram,
    ccRefreshWriteLog,
    ccToggleTopicMessages,
    ccSendTopicMessage,
    ccSetEnforcementFilter,
    ccOpenBuckeyeAdmin,
    ccMarkEnforcementApplied,
    ccEscalateEnforcement,
    ccAnalyzeLive,
    ccApplyPosition,
    ccOverridePosition,
    ccBlockPlayer,
    toggleCcWebhookForm,
    addCcWebhook,
    ccDeleteWebhook,
    toggleCcAbTestForm,
    ccRunAbTest,
    ccStartStreamAnalysis,
    ccStopStreamAnalysis,
  });
}
