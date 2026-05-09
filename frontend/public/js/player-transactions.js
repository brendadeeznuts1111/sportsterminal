export function createPlayerTransactionRenderer(deps) {
  const {
    state,
    escapeHtml,
    formatShortDateTime,
    profileStatusChip,
    profileEmptyRow,
    profileStatCard,
    destroyChart,
    getChart,
  } = deps;

  function renderTransactions(profile) {
    const el = document.getElementById('playerProfileTransactions');
    if (!el) return;
    const live = profile.buckeye || {};
    const txResult = live.transactions || {};
    const archived = profile.transactions || [];
    const isLive = Boolean(txResult.rows?.length || txResult.data?.LIST?.length);
    const activeTab = state.transactionTab || 'all';

    let sourceRows = [];
    let sourceLabel = 'Archived';
    let sourceDesc = 'From database archive (player_transactions table).';
    if (isLive) {
      const rows = txResult.rows || [];
      const rawData = txResult.data || {};
      const list = rawData.LIST || rawData.list || rawData.Rows || rawData.rows || [];
      sourceRows = Array.isArray(list) && list.length ? list : rows;
      sourceLabel = 'Live';
      sourceDesc = 'Direct from Buckeye getTransactionList / getTransactionHistory / getReportDeletedTransactions.';
    } else if (archived.length) {
      sourceRows = archived.map((row) => ({
        DocumentNumber: row.document_number || row.id,
        TranCode: row.tran_code,
        TranType: row.tran_type,
        Amount: (row.amount || 0) * 100,
        Balance: (row.balance || 0) * 100,
        ShortDesc: row.description,
        EnteredBy: row.entered_by,
        TranDateTime: row.transaction_time,
        AgentID: row.agent_id,
        Login: row.login,
        Category: row.category,
        SourceConfidence: row.sourceConfidence,
      }));
    }

    let creditTotal = 0;
    let debitTotal = 0;
    let creditCount = 0;
    let debitCount = 0;
    const displayRows = sourceRows.map(normalizeTransactionDisplayRow);
    displayRows.forEach((row) => {
      const code = row.code || '';
      const amount = Number(row.amount || 0);
      if (code === 'C' || code === 'c') {
        creditTotal += amount;
        creditCount += 1;
      } else if (code === 'D' || code === 'd') {
        debitTotal += amount;
        debitCount += 1;
      }
    });
    const freePlayRows = displayRows.filter((row) => isFreePlayCategory(row.category));

    if (activeTab === 'freeplay') {
      const summary = profile.freePlaySummary || computeFreePlaySummary(freePlayRows);
      el.innerHTML = `${renderTransactionSubtabs(activeTab)}
        <div class="profile-chart-card mb-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold mb-0">Free-Play Transactions</h3>
            <span class="text-xs" style="color:var(--text-dim);">${freePlayRows.length.toLocaleString()} captured row${freePlayRows.length === 1 ? '' : 's'}</span>
          </div>
          <div class="text-xs mt-1" style="color:var(--text-dim);">Only rows classified as free-play issued, redeemed, expired, or adjustment are shown here. Candidate mappings stay visibly marked.</div>
        </div>
        <div class="grid grid-cols-4 gap-3 mb-3">
          ${profileStatCard('Issued', formatMoney(summary.issued))}
          ${profileStatCard('Redeemed', formatMoney(summary.redeemed))}
          ${profileStatCard('Expired', formatMoney(summary.expired))}
          ${profileStatCard('Outstanding', formatMoney(summary.outstandingEstimate))}
        </div>
        ${freePlayRows.length ? '<div class="profile-chart-card mb-3"><canvas id="playerFreePlayChart" height="90"></canvas></div>' : ''}
        <div class="rounded-lg border overflow-auto" style="border-color:var(--border);">
          <table class="profile-table">
            <thead><tr>
              <th>Date</th><th>Document</th><th>Category</th><th>Confidence</th><th>Description</th><th class="text-right">Amount</th><th class="text-right">Balance</th><th>Entered By</th>
            </tr></thead>
            <tbody>${freePlayRows.map(freePlayTransactionRow).join('') || profileEmptyRow('No free-play transactions captured for this player.', 8)}</tbody>
          </table>
        </div>`;
      renderFreePlayChart(freePlayRows);
      return;
    }

    const tableRows = displayRows.map(transactionLedgerRow).join('');
    el.innerHTML = `${renderTransactionSubtabs(activeTab)}
      <div class="profile-chart-card mb-3">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold mb-0">${sourceLabel} Transaction Ledger</h3>
          ${txResult.fetchedAt ? `<span class="text-xs" style="color:var(--text-dim);">Fetched ${formatShortDateTime(txResult.fetchedAt)}</span>` : ''}
        </div>
        <div class="text-xs mt-1" style="color:var(--text-dim);">${sourceDesc} Credit (C) and Debit (D) rows with document numbers, descriptions, and running balance.</div>
        <div class="flex gap-3 mt-2">
          <div class="px-2 py-1 rounded text-xs" style="background:var(--panel);border:1px solid var(--border);">
            <span style="color:var(--text-dim);">Rows</span> <strong>${sourceRows.length.toLocaleString()}</strong>
          </div>
          <div class="px-2 py-1 rounded text-xs" style="background:var(--panel);border:1px solid var(--border);">
            <span style="color:var(--green);">Credits</span> <strong>${creditCount}</strong> <span style="color:var(--text-dim);">${formatMoney(creditTotal)}</span>
          </div>
          <div class="px-2 py-1 rounded text-xs" style="background:var(--panel);border:1px solid var(--border);">
            <span style="color:var(--red);">Debits</span> <strong>${debitCount}</strong> <span style="color:var(--text-dim);">${formatMoney(debitTotal)}</span>
          </div>
        </div>
      </div>
      <div class="rounded-lg border overflow-auto" style="border-color:var(--border);">
        <table class="profile-table">
          <thead><tr>
            <th>Date</th><th>Document</th><th>Code</th><th>Type</th><th>Description</th><th class="text-right">Amount</th><th class="text-right">Balance</th><th>Entered By</th>
          </tr></thead>
          <tbody>${tableRows || profileEmptyRow('No transaction ledger rows available for this player.', 8)}</tbody>
        </table>
      </div>`;
  }

  function setTransactionTab(tab) {
    state.transactionTab = tab === 'freeplay' ? 'freeplay' : 'all';
    if (state.tab === 'transactions' && state.profile) renderTransactions(state.profile);
  }

  function renderTransactionSubtabs(activeTab) {
    return `<div class="profile-action-row mb-3" role="tablist" aria-label="Transaction views">
      <button type="button" class="profile-action-button ${activeTab === 'all' ? 'active' : ''}" role="tab" aria-selected="${activeTab === 'all'}" onclick="setPlayerTransactionTab('all')">All</button>
      <button type="button" class="profile-action-button ${activeTab === 'freeplay' ? 'active' : ''}" role="tab" aria-selected="${activeTab === 'freeplay'}" onclick="setPlayerTransactionTab('freeplay')">Free-Play</button>
    </div>`;
  }

  function transactionLedgerRow(row) {
    const isCredit = row.code === 'C' || row.code === 'c';
    const amountClass = isCredit ? 'color:var(--green);' : (row.code === 'D' || row.code === 'd') ? 'color:var(--red);' : '';
    const amountPrefix = isCredit ? '+' : '';
    return `<tr>
      <td style="color:var(--text-dim);font-size:11px;">${escapeHtml(String(row.date).split(' ')[0] || '-')}</td>
      <td class="font-mono" style="font-size:11px;">${escapeHtml(String(row.doc))}</td>
      <td><span class="profile-status-chip" style="${amountClass}font-size:10px;padding:1px 6px;">${escapeHtml(row.code)}</span></td>
      <td style="font-size:11px;">${escapeHtml(row.type)}</td>
      <td style="font-size:11px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(row.desc)}">${escapeHtml(row.desc)}</td>
      <td class="text-right font-mono" style="font-size:11px;${amountClass}">${amountPrefix}${formatMoney(Math.abs(row.amount))}</td>
      <td class="text-right font-mono" style="font-size:11px;color:var(--text-dim);">${formatMoney(row.balance)}</td>
      <td style="font-size:11px;color:var(--text-dim);">${escapeHtml(String(row.entered)).trim() || '-'}</td>
    </tr>`;
  }

  function freePlayTransactionRow(row) {
    const amountClass = row.category === 'freeplay_issued' ? 'color:var(--green);' : 'color:var(--red);';
    return `<tr>
      <td style="color:var(--text-dim);font-size:11px;">${escapeHtml(String(row.date).split(' ')[0] || '-')}</td>
      <td class="font-mono" style="font-size:11px;">${escapeHtml(String(row.doc))}</td>
      <td>${profileStatusChip(row.category || 'freeplay')}</td>
      <td>${profileStatusChip(row.sourceConfidence || 'candidate')}</td>
      <td style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(row.desc)}">${escapeHtml(row.desc)}</td>
      <td class="text-right font-mono" style="font-size:11px;${amountClass}">${formatMoney(Math.abs(row.amount))}</td>
      <td class="text-right font-mono" style="font-size:11px;color:var(--text-dim);">${formatMoney(row.balance)}</td>
      <td style="font-size:11px;color:var(--text-dim);">${escapeHtml(String(row.entered)).trim() || '-'}</td>
    </tr>`;
  }

  function renderFreePlayChart(rows) {
    const canvas = document.getElementById('playerFreePlayChart');
    const ChartCtor = getChart();
    if (!canvas || !ChartCtor) return;
    destroyChart('freePlay');
    const byDay = new Map();
    rows.forEach((row) => {
      const day = String(row.date || '').slice(0, 10) || 'Unknown';
      const entry = byDay.get(day) || { issued: 0, redeemed: 0 };
      if (row.category === 'freeplay_issued') entry.issued += Math.abs(Number(row.amount || 0));
      if (row.category === 'freeplay_redeemed') entry.redeemed += Math.abs(Number(row.amount || 0));
      byDay.set(day, entry);
    });
    const labels = [...byDay.keys()].sort();
    requestAnimationFrame(() => {
      if (!document.getElementById('playerFreePlayChart')) return;
      destroyChart('freePlay');
      state.charts.freePlay = new ChartCtor(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Issued', data: labels.map((day) => byDay.get(day).issued), backgroundColor: 'rgba(16,185,129,.7)' },
            { label: 'Redeemed', data: labels.map((day) => byDay.get(day).redeemed), backgroundColor: 'rgba(239,68,68,.7)' },
          ],
        },
        options: { responsive: true, plugins: { legend: { labels: { color: '#9ca3af' } } }, scales: { x: { ticks: { color: '#9ca3af' } }, y: { ticks: { color: '#9ca3af' } } } },
      });
    });
  }

  return {
    renderTransactions,
    setTransactionTab,
  };
}

function normalizeTransactionDisplayRow(row) {
  const amountRaw = Number(row.Amount ?? row.amount ?? row.TransactionAmount ?? row.transactionAmount ?? 0);
  const balanceRaw = Number(row.Balance ?? row.balance ?? 0);
  const amount = (row.Amount !== undefined || row.TransactionAmount !== undefined) ? amountRaw / 100 : amountRaw;
  const balance = (row.Balance !== undefined) ? balanceRaw / 100 : balanceRaw;
  return {
    doc: row.DocumentNumber || row.documentNumber || row.document_number || row.DocNo || row.id || '-',
    code: row.TranCode || row.tran_code || row.Code || row.code || '-',
    type: row.TranType || row.tran_type || row.Type || row.type || '-',
    desc: row.ShortDesc || row.shortDesc || row.Description || row.description || row.Details || row.details || '-',
    amount,
    balance,
    entered: row.EnteredBy || row.enteredBy || row.entered_by || '-',
    date: row.TranDateTime || row.tranDateTime || row.TransactionTime || row.transactionTime || row.Date || row.date || row.transaction_time || '',
    category: row.Category || row.category || '',
    sourceConfidence: row.SourceConfidence || row.sourceConfidence || '',
  };
}

function isFreePlayCategory(category) {
  return ['freeplay_issued', 'freeplay_redeemed', 'freeplay_expired', 'freeplay_adjustment'].includes(category || '');
}

function formatMoney(value) {
  const amount = Number(value || 0);
  const sign = amount < 0 ? '-' : '';
  return `${sign}$${Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function computeFreePlaySummary(rows) {
  return rows.reduce((acc, row) => {
    const amount = Math.abs(Number(row.amount || 0));
    if (row.category === 'freeplay_issued') acc.issued += amount;
    if (row.category === 'freeplay_redeemed') acc.redeemed += amount;
    if (row.category === 'freeplay_expired') acc.expired += amount;
    if (row.category === 'freeplay_adjustment') acc.adjustments += Number(row.amount || 0);
    acc.transactionCount += 1;
    acc.outstandingEstimate = acc.issued + acc.adjustments - acc.redeemed - acc.expired;
    return acc;
  }, { issued: 0, redeemed: 0, expired: 0, adjustments: 0, outstandingEstimate: 0, transactionCount: 0 });
}
