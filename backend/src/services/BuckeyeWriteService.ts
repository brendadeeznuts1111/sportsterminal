/**
 * BuckeyeWriteService
 *
 * Defense-grade wrapper around BuckeyeAPI write operations.
 * Adds: input validation, rate limiting, audit logging, Telegram notification.
 */

import type { BuckeyeAPI } from '../scrapers/BuckeyeAPI';
import type { Database } from '../database';
import { TelegramBotClient } from './TelegramBotClient';
import { TelegramTopicService } from './TelegramTopicService';

// ─── Constants ─────────────────────────────────────────────────────────────

const ALLOWED_COLUMNS = new Set([
  'CreditLimit',
  'WagerLimit',
  'SettleFigure',
  'TempCreditAdj',
  'CreditAcctFlag',
  'ZeroBalanceFlag',
  'WeeklyLimitFlag',
  'TempCreditAdjExpDate',
  'Status',
]);

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

// In-memory rate limiter keyed by "customerId:operation"
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WriteAuditEntry {
  id?: number;
  timestamp?: string;
  operation: string;
  customer_id: string;
  column_name?: string;
  old_value?: string;
  new_value?: string;
  agent_id: string;
  ip_address?: string;
  success: boolean;
  error_message?: string;
  telegram_alert_id?: number;
  ai_decision_id?: string;
  source?: string;
  trader_name?: string;
}

export interface WriteResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  auditId?: number;
  telegramMessageId?: number;
}

// ─── Service ───────────────────────────────────────────────────────────────

export class BuckeyeWriteService {
  constructor(
    private readonly api: BuckeyeAPI,
    private readonly db: Database,
    private readonly agentId: string
  ) {}

  // ─── Validation ────────────────────────────────────────────────────────

  validateColumn(column: string): void {
    if (!ALLOWED_COLUMNS.has(column)) {
      throw new Error(`Column "${column}" is not in the allowed whitelist. Allowed: ${Array.from(ALLOWED_COLUMNS).join(', ')}`);
    }
  }

  validateRateLimit(customerId: string, operation: string): void {
    const key = `${customerId}:${operation}`;
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return;
    }

    if (bucket.count >= RATE_LIMIT_MAX) {
      throw new Error(`Rate limit exceeded: ${operation} on ${customerId} — max ${RATE_LIMIT_MAX} per ${RATE_LIMIT_WINDOW_MS / 1000}s`);
    }

    bucket.count++;
  }

  // ─── Audit Logging ─────────────────────────────────────────────────────

  async logAudit(entry: WriteAuditEntry): Promise<number> {
    const result = await this.db.run(
      `INSERT INTO buckeye_write_log
       (operation, customer_id, column_name, old_value, new_value, agent_id, ip_address, success, error_message, telegram_alert_id, ai_decision_id, source, trader_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.operation,
        entry.customer_id,
        entry.column_name ?? null,
        entry.old_value ?? null,
        entry.new_value ?? null,
        entry.agent_id,
        entry.ip_address ?? null,
        entry.success ? 1 : 0,
        entry.error_message ?? null,
        entry.telegram_alert_id ?? null,
        entry.ai_decision_id ?? null,
        entry.source ?? 'manual',
        entry.trader_name ?? null,
      ]
    );
    return result.lastID as number;
  }

  async getRecentWrites(customerId: string, limit: number = 20): Promise<WriteAuditEntry[]> {
    return this.db.all<WriteAuditEntry>(
      `SELECT * FROM buckeye_write_log WHERE customer_id = ? ORDER BY timestamp DESC LIMIT ?`,
      [customerId, limit]
    );
  }

  async getRecentWritesByAgent(agentId: string, limit: number = 50): Promise<WriteAuditEntry[]> {
    return this.db.all<WriteAuditEntry>(
      `SELECT * FROM buckeye_write_log WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?`,
      [agentId, limit]
    );
  }

  // ─── Telegram Notification ─────────────────────────────────────────────

  async notifyTelegram(params: {
    operation: string;
    customerId: string;
    column?: string;
    oldValue?: string;
    newValue: string;
    success: boolean;
    error?: string;
    traderName?: string;
  }): Promise<number | undefined> {
    const client = new TelegramBotClient();
    await client.init();
    if (!client.isConfigured) return undefined;

    const topicService = new TelegramTopicService(this.db);

    // Determine route
    let topicPurpose = 'general';
    let priorityEmoji = '📝';

    if (!params.success) {
      topicPurpose = 'approvals';
      priorityEmoji = '🔴';
    } else if (params.column === 'Status' && ['SUSPENDED', 'BLOCKED'].includes(String(params.newValue).toUpperCase())) {
      topicPurpose = 'approvals';
      priorityEmoji = '🚨';
    } else if (params.column === 'CreditLimit' || params.column === 'WagerLimit') {
      const cents = Number(params.newValue);
      if (cents < 100_000) { // < $1,000
        topicPurpose = 'alerts';
        priorityEmoji = '⚠️';
      }
    } else if (params.operation === 'insertTransaction') {
      const amount = Number(params.newValue);
      if (amount > 500_000) { // > $5,000
        topicPurpose = 'alerts';
        priorityEmoji = '💰';
      }
    }

    // Find agent supergroup + topic
    const agentRow = await this.db.get<{ agent_login: string }>(
      `SELECT agent_login FROM wagers WHERE customer_id = ? ORDER BY insert_datetime DESC LIMIT 1`,
      [params.customerId]
    );
    const agentLogin = agentRow?.agent_login || this.agentId;

    const supergroup = await this.db.get<{ id: number; supergroup_chat_id: string }>(
      `SELECT id, supergroup_chat_id FROM agent_supergroups WHERE owner_agent_login = ? AND purpose = 'agent' LIMIT 1`,
      [agentLogin]
    );
    if (!supergroup) return undefined;

    const topic = await topicService.findTopicByPurpose(supergroup.supergroup_chat_id, topicPurpose);
    if (!topic) return undefined;

    const text = [
      `${priorityEmoji} *BUCKEYE WRITE ${params.success ? 'SUCCESS' : 'FAILED'}*`,
      '',
      `Customer: \`${params.customerId}\``,
      `Agent: ${agentLogin}`,
      `Operation: ${params.operation}`,
      params.column ? `Column: ${params.column}` : '',
      `Value: ${params.newValue}`,
      params.oldValue ? `(was: ${params.oldValue})` : '',
      params.traderName ? `Trader: ${params.traderName}` : '',
      '',
      params.error ? `⚠️ Error: ${params.error}` : '',
      `_${new Date().toISOString()}_`,
    ].filter(Boolean).join('\n');

    try {
      const res = await client.sendMessage({
        chat_id: supergroup.supergroup_chat_id,
        message_thread_id: topic.topic_thread_id,
        text,
        parse_mode: 'Markdown',
        disable_notification: topicPurpose === 'general',
      });

      if (res.ok && res.result && typeof res.result === 'object' && 'message_id' in res.result) {
        const telegramMessageId = Number((res.result as Record<string, unknown>).message_id);
        return telegramMessageId;
      }
    } catch {
      /* best-effort — don't fail the write if Telegram is down */
    }

    return undefined;
  }

  // ─── Wrapped Write Methods ─────────────────────────────────────────────

  async updateByColumn(params: {
    customerID: number;
    column: string;
    value: string | number;
    type?: number;
    title?: string;
    info?: string;
    traderName?: string;
    source?: string;
    aiDecisionId?: string;
  }): Promise<WriteResult> {
    this.validateColumn(params.column);
    this.validateRateLimit(String(params.customerID), `updateByColumn:${params.column}`);

    const oldValue = await this.fetchOldValue(params.customerID, params.column);

    let result: unknown;
    let success = false;
    let error: string | undefined;

    try {
      result = await this.api.updateByColumn({
        customerID: params.customerID,
        column: params.column,
        value: params.value,
        type: params.type,
        title: params.title,
        info: params.info,
      });
      success = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const telegramId = await this.notifyTelegram({
      operation: 'updateByColumn',
      customerId: String(params.customerID),
      column: params.column,
      oldValue,
      newValue: String(params.value),
      success,
      error,
      traderName: params.traderName,
    });

    const auditId = await this.logAudit({
      operation: 'updateByColumn',
      customer_id: String(params.customerID),
      column_name: params.column,
      old_value: oldValue,
      new_value: String(params.value),
      agent_id: this.agentId,
      success,
      error_message: error,
      telegram_alert_id: telegramId,
      ai_decision_id: params.aiDecisionId,
      source: params.source ?? 'manual',
      trader_name: params.traderName,
    });

    if (!success) {
      throw new Error(error);
    }

    return { success: true, data: result, auditId, telegramMessageId: telegramId };
  }

  async setCreditLimit(customerId: number, cents: number, opts?: { traderName?: string; source?: string; aiDecisionId?: string }): Promise<WriteResult> {
    return this.updateByColumn({
      customerID: customerId,
      column: 'CreditLimit',
      value: cents,
      type: 0,
      info: `THE BASICS : credit limit | New : ${cents} /`,
      traderName: opts?.traderName,
      source: opts?.source,
      aiDecisionId: opts?.aiDecisionId,
    });
  }

  async setWagerLimit(customerId: number, cents: number, opts?: { traderName?: string; source?: string; aiDecisionId?: string }): Promise<WriteResult> {
    return this.updateByColumn({
      customerID: customerId,
      column: 'WagerLimit',
      value: cents,
      type: 0,
      info: `THE BASICS : wager limit | New : ${cents} /`,
      traderName: opts?.traderName,
      source: opts?.source,
      aiDecisionId: opts?.aiDecisionId,
    });
  }

  async setPlayerStatus(customerId: number, status: 'ACTIVE' | 'SUSPENDED' | 'BLOCKED', opts?: { traderName?: string; source?: string; aiDecisionId?: string }): Promise<WriteResult> {
    return this.updateByColumn({
      customerID: customerId,
      column: 'Status',
      value: status,
      type: 1,
      info: `THE BASICS : status | New : ${status} /`,
      traderName: opts?.traderName,
      source: opts?.source,
      aiDecisionId: opts?.aiDecisionId,
    });
  }

  async insertTransaction(params: {
    customerID: string;
    type: 'E' | 'I' | 'C' | 'D' | 'B' | 'N';
    amount: number;
    description: string;
    dailyFigure?: string;
    traderName?: string;
    source?: string;
    aiDecisionId?: string;
  }): Promise<WriteResult> {
    this.validateRateLimit(params.customerID, 'insertTransaction');

    let result: unknown;
    let success = false;
    let error: string | undefined;

    try {
      result = await this.api.insertTransaction({
        customerID: params.customerID,
        type: params.type,
        amount: params.amount,
        description: params.description,
        dailyFigure: params.dailyFigure,
      });
      success = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const telegramId = await this.notifyTelegram({
      operation: 'insertTransaction',
      customerId: params.customerID,
      newValue: String(params.amount),
      success,
      error,
      traderName: params.traderName,
    });

    const auditId = await this.logAudit({
      operation: 'insertTransaction',
      customer_id: params.customerID,
      new_value: String(params.amount),
      agent_id: this.agentId,
      success,
      error_message: error,
      telegram_alert_id: telegramId,
      ai_decision_id: params.aiDecisionId,
      source: params.source ?? 'manual',
      trader_name: params.traderName,
    });

    if (!success) {
      throw new Error(error);
    }

    return { success: true, data: result, auditId, telegramMessageId: telegramId };
  }

  // ─── Composite Actions ─────────────────────────────────────────────────

  async blockPlayer(customerId: number, opts?: { traderName?: string; source?: string; aiDecisionId?: string }): Promise<WriteResult<{ action: string; customerId: number; results: Record<string, WriteResult> }>> {
    const results: Record<string, WriteResult> = {};
    results.creditLimit = await this.setCreditLimit(customerId, 0, opts);
    results.wagerLimit = await this.setWagerLimit(customerId, 0, opts);
    results.settleFigure = await this.updateByColumn({ customerID: customerId, column: 'SettleFigure', value: 0, type: 0, info: 'THE BASICS : settle figure | New : 0 /', traderName: opts?.traderName, source: opts?.source, aiDecisionId: opts?.aiDecisionId });
    results.tempCredit = await this.updateByColumn({ customerID: customerId, column: 'TempCreditAdj', value: 0, type: 0, info: 'THE BASICS : temp credit | New : 0 /', traderName: opts?.traderName, source: opts?.source, aiDecisionId: opts?.aiDecisionId });
    results.creditAcct = await this.updateByColumn({ customerID: customerId, column: 'CreditAcctFlag', value: 'N', type: 1, info: 'THE BASICS : account type | New : N /', traderName: opts?.traderName, source: opts?.source, aiDecisionId: opts?.aiDecisionId });
    results.zeroBalance = await this.updateByColumn({ customerID: customerId, column: 'ZeroBalanceFlag', value: 'true', type: 1, info: 'THE BASICS : zero balance | New : true /', traderName: opts?.traderName, source: opts?.source, aiDecisionId: opts?.aiDecisionId });

    return { success: true, data: { action: 'BLOCK', customerId, results } };
  }

  async reducePlayerLimits(customerId: number, maxWagerCents: number, maxCreditCents: number, opts?: { traderName?: string; source?: string; aiDecisionId?: string }): Promise<WriteResult<{ action: string; customerId: number; results: Record<string, WriteResult> }>> {
    const results: Record<string, WriteResult> = {};
    results.creditLimit = await this.setCreditLimit(customerId, maxCreditCents, opts);
    results.wagerLimit = await this.setWagerLimit(customerId, maxWagerCents, opts);
    results.settleFigure = await this.updateByColumn({ customerID: customerId, column: 'SettleFigure', value: maxCreditCents, type: 0, info: `THE BASICS : settle figure | New : ${maxCreditCents} /`, traderName: opts?.traderName, source: opts?.source, aiDecisionId: opts?.aiDecisionId });

    return { success: true, data: { action: 'REDUCE', customerId, results } };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async fetchOldValue(customerId: number, column: string): Promise<string | undefined> {
    try {
      const data = await this.api.postManagerOperation('getInfoPlayer', { customerID: String(customerId) });
      const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const val = row[column];
      return val !== undefined ? String(val) : undefined;
    } catch {
      return undefined;
    }
  }
}
