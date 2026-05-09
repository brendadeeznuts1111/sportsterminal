/**
 * Free-play analysis routes
 */
import { createRouteHandler } from './base';
import { logRequest } from '../../utils/logger';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export const FREEPLAY_CATEGORIES = [
  'freeplay_issued',
  'freeplay_redeemed',
  'freeplay_expired',
  'freeplay_adjustment',
];

type FreePlayGroupBy = 'player' | 'agent' | 'day';

export const registerFreePlayAnalysisRoutes = createRouteHandler(
  '/api/freeplay/analysis',
  async (url, _req, scraperManager: BuckeyeScraperManager) => {
    logRequest('GET', '/api/freeplay/analysis');
    const db = scraperManager.getDatabase();
    if (!(await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='player_transactions'`))) {
      return emptyFreePlayResponse(url);
    }
    const playerId = (url.searchParams.get('playerId') || '').trim();
    const agentId = (url.searchParams.get('agentId') || '').trim();
    const from = (url.searchParams.get('from') || '').trim();
    const to = (url.searchParams.get('to') || '').trim();
    const groupBy = normalizeGroupBy(url.searchParams.get('groupBy'));
    const { where, params } = buildFreePlayWhere({ playerId, agentId, from, to });

    const rows = await db.all(
      `SELECT
        id,
        customer_id AS customerId,
        login,
        agent_id AS agentId,
        agent_login AS agentLogin,
        document_number AS documentNumber,
        tran_code AS tranCode,
        tran_type AS tranType,
        amount,
        balance,
        description,
        category,
        transaction_time AS transactionTime,
        raw_json AS rawJson
       FROM player_transactions
       WHERE ${where.join(' AND ')}
       ORDER BY transaction_time DESC
       LIMIT 5000`,
      params
    );

    const transactions = rows.map((row: any) => ({
      ...row,
      amount: Number(row.amount || 0),
      balance: Number(row.balance || 0),
      sourceConfidence: freePlaySourceConfidence(row),
    }));

    return {
      filters: { playerId, agentId, from, to, groupBy },
      totals: summarizeFreePlay(transactions),
      groups: groupFreePlayRows(transactions, groupBy),
      transactions: transactions.slice(0, 500),
      count: transactions.length,
    };
  }
);

function emptyFreePlayResponse(url: URL): any {
  const groupBy = normalizeGroupBy(url.searchParams.get('groupBy'));
  return {
    filters: {
      playerId: (url.searchParams.get('playerId') || '').trim(),
      agentId: (url.searchParams.get('agentId') || '').trim(),
      from: (url.searchParams.get('from') || '').trim(),
      to: (url.searchParams.get('to') || '').trim(),
      groupBy,
    },
    totals: summarizeFreePlay([]),
    groups: [],
    transactions: [],
    count: 0,
  };
}

export function buildFreePlayWhere(filters: {
  playerId?: string;
  agentId?: string;
  from?: string;
  to?: string;
}): { where: string[]; params: unknown[] } {
  const where = [`category IN (${FREEPLAY_CATEGORIES.map(() => '?').join(',')})`];
  const params: unknown[] = [...FREEPLAY_CATEGORIES];
  if (filters.playerId) {
    where.push('(customer_id = ? OR login = ?)');
    params.push(filters.playerId, filters.playerId);
  }
  if (filters.agentId) {
    where.push('(agent_id = ? OR agent_login = ?)');
    params.push(filters.agentId, filters.agentId);
  }
  if (filters.from) {
    where.push('transaction_time >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('transaction_time <= ?');
    params.push(`${filters.to} 23:59:59`);
  }
  return { where, params };
}

export function summarizeFreePlay(rows: any[]): any {
  const totals = {
    issued: 0,
    redeemed: 0,
    expired: 0,
    adjustments: 0,
    outstandingEstimate: 0,
    transactionCount: rows.length,
    sourceConfidence: 'confirmed',
  };
  for (const row of rows) {
    const amount = Math.abs(Number(row.amount || 0));
    if (row.category === 'freeplay_issued') totals.issued += amount;
    if (row.category === 'freeplay_redeemed') totals.redeemed += amount;
    if (row.category === 'freeplay_expired') totals.expired += amount;
    if (row.category === 'freeplay_adjustment') totals.adjustments += Number(row.amount || 0);
    if (row.sourceConfidence === 'candidate') totals.sourceConfidence = 'candidate';
  }
  totals.outstandingEstimate = totals.issued + totals.adjustments - totals.redeemed - totals.expired;
  return totals;
}

export function freePlaySourceConfidence(row: any): 'confirmed' | 'candidate' {
  const text = `${row.tranType || row.tran_type || ''} ${row.description || ''} ${row.rawJson || row.raw_json || ''}`.toLowerCase();
  if (/\bfree[\s_-]*play\b|freeplay|bonus\s+play/.test(text)) return 'confirmed';
  return 'candidate';
}

function groupFreePlayRows(rows: any[], groupBy: FreePlayGroupBy): any[] {
  const groups = new Map<string, any[]>();
  for (const row of rows) {
    const key = groupKey(row, groupBy);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => ({
      key,
      groupBy,
      label: key,
      totals: summarizeFreePlay(groupRows),
    }))
    .sort((a, b) => Math.abs(b.totals.outstandingEstimate) - Math.abs(a.totals.outstandingEstimate));
}

function groupKey(row: any, groupBy: FreePlayGroupBy): string {
  if (groupBy === 'agent') return row.agentLogin || row.agentId || 'Unknown agent';
  if (groupBy === 'day') return String(row.transactionTime || '').slice(0, 10) || 'Unknown day';
  return row.login || row.customerId || 'Unknown player';
}

function normalizeGroupBy(value: string | null): FreePlayGroupBy {
  return value === 'agent' || value === 'day' ? value : 'player';
}
