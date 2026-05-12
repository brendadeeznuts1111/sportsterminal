/**
 * RiskAlertService
 * Dispatches webhook alerts when AI flags a player as RED or BLACK.
 * Uses the existing alert_webhooks table and WebhookService infrastructure.
 */

import { COMMAND_CENTER_MAP } from '../config/commandCenterMap';
import type { Database } from '../database';
import { logger } from '../utils/logger';
import { streamHub } from './StreamHub';
import { TelegramBotClient } from './TelegramBotClient';
import { TelegramTopicService } from './TelegramTopicService';
import { webhookCircuitBreaker } from './WebhookCircuitBreaker';

// ─── Types ───────────────────────────────────────────────────────────

export interface RiskAlertInput {
  customer_id: string;
  risk_level: string;
  confidence: number;
  summary: string;
  suggested_action?: string;
}

export interface AlertLogEntry {
  id: number;
  customer_id: string;
  risk_level: string;
  webhook_id: number;
  platform: string;
  payload: string;
  response_status: number;
  sent_at: string;
}

export interface WebhookDeliveryHealth {
  id: number;
  name: string;
  platform: string;
  enabled: boolean;
  state: 'closed' | 'degraded' | 'open';
  attempts: number;
  successes: number;
  failures: number;
  last_attempt_at: string | null;
}

export interface WebhookCircuitBreakerState {
  window_hours: number;
  open_count: number;
  degraded_count: number;
  webhooks: WebhookDeliveryHealth[];
}

interface WebhookRow {
  id: number;
  name: string;
  platform: string;
  url: string;
  triggers: string;
  enabled: number;
}

// ─── Constants ───────────────────────────────────────────────────────

const MIN_CONFIDENCE_TO_ALERT = 0.7;

// ─── Service ─────────────────────────────────────────────────────────

export class RiskAlertService {
  constructor(private readonly db: Database) { }

  /**
   * Send alerts to all matching webhooks for a risk flag event.
   * Called automatically after AI analysis stores a result.
   */
  async sendAlerts(input: RiskAlertInput): Promise<{ sent: number; failed: number }> {
    if (input.confidence < MIN_CONFIDENCE_TO_ALERT) {
      return { sent: 0, failed: 0 };
    }

    // Fan out to live SSE subscribers regardless of webhook config
    streamHub.publish('alerts', {
      event: COMMAND_CENTER_MAP.sse.events.riskAlert,
      data: input,
    });

    const webhooks = await this.getMatchingWebhooks(input.risk_level);

    let sent = 0;
    let failed = 0;

    for (const hook of webhooks) {
      if (!webhookCircuitBreaker.canDeliver(hook.url)) {
        logger.warn(`Circuit open for webhook ${hook.name}, skipping`);
        failed++;
        continue;
      }

      try {
        const payload = this.formatPayload(hook.platform, input);
        const payloadJson = JSON.stringify(payload);

        const response = await fetch(hook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payloadJson,
        });

        await this.logDelivery({
          customer_id: input.customer_id,
          risk_level: input.risk_level,
          webhook_id: hook.id,
          platform: hook.platform,
          payload: payloadJson,
          response_status: response.status,
        });

        if (response.ok) {
          webhookCircuitBreaker.recordSuccess(hook.url);
          sent++;
        } else {
          webhookCircuitBreaker.recordFailure(hook.url);
          failed++;
        }
      } catch (err) {
        logger.error(`Webhook failed for ${hook.name}`, err);
        webhookCircuitBreaker.recordFailure(hook.url);
        await this.logDelivery({
          customer_id: input.customer_id,
          risk_level: input.risk_level,
          webhook_id: hook.id,
          platform: hook.platform,
          payload: JSON.stringify({ error: 'dispatch_failed' }),
          response_status: 0,
        });
        failed++;
      }
    }

    // ─── Route to Telegram supergroup topics (best-effort) ────────────────
    try {
      await this.routeToTelegramTopic(input);
    } catch (err) {
      logger.warn('Telegram routing failed', err instanceof Error ? err.message : err);
    }

    return { sent, failed };
  }

  /**
   * Send a system-internal alert to the #risk-alerts topic.
   * Used for infra events (DNS failures, token expiry, etc.).
   */
  async sendSystemAlert(summary: string, detail?: string): Promise<void> {
    const topicService = new TelegramTopicService(this.db);
    const client = new TelegramBotClient();
    await client.init();
    if (!client.isConfigured) return;

    const chatId = await topicService.getSystemChatId();
    if (!chatId) return;

    const threadId = await topicService.getSystemTopicThreadId('risk_alerts');
    if (!threadId) return;

    const text = [
      `⚙️ *SYSTEM ALERT*`,
      '',
      summary,
      detail || '',
      '',
      `_${new Date().toISOString()}_`,
    ].join('\n');

    await client.sendMessage({
      chat_id: chatId,
      message_thread_id: threadId,
      text,
      parse_mode: 'Markdown',
    });
  }

  /**
   * Test a webhook by sending a sample alert.
   */
  async testWebhook(webhookId: number): Promise<{ success: boolean; status?: number; error?: string }> {
    const hook = await this.db.get<WebhookRow>(
      'SELECT * FROM alert_webhooks WHERE id = ?',
      [webhookId]
    );

    if (!hook) {
      return { success: false, error: 'Webhook not found' };
    }

    const sampleInput: RiskAlertInput = {
      customer_id: 'TEST_PLAYER',
      risk_level: 'RED',
      confidence: 0.92,
      summary: 'Test alert from Sports Terminal Risk Command Center.',
      suggested_action: 'review',
    };

    try {
      const payload = this.formatPayload(hook.platform, sampleInput);
      const payloadJson = JSON.stringify(payload);

      const response = await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadJson,
      });

      await this.logDelivery({
        customer_id: sampleInput.customer_id,
        risk_level: sampleInput.risk_level,
        webhook_id: hook.id,
        platform: hook.platform,
        payload: payloadJson,
        response_status: response.status,
      });

      if (response.ok) {
        webhookCircuitBreaker.recordSuccess(hook.url);
      } else {
        webhookCircuitBreaker.recordFailure(hook.url);
      }

      return { success: response.ok, status: response.status };
    } catch (err) {
      webhookCircuitBreaker.recordFailure(hook.url);
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }

  /**
   * Get alert delivery log.
   */
  async getAlertLog(options: {
    customer_id?: string;
    webhook_id?: number;
    limit?: number;
  } = {}): Promise<AlertLogEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.customer_id) {
      conditions.push('customer_id = ?');
      params.push(options.customer_id);
    }
    if (options.webhook_id) {
      conditions.push('webhook_id = ?');
      params.push(options.webhook_id);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(options.limit || 100, 500);

    const rows = await this.db.all<AlertLogEntry>(
      `SELECT * FROM risk_alert_log ${where} ORDER BY sent_at DESC LIMIT ?`,
      [...params, limit]
    );

    return rows;
  }

  async cleanupOldAlerts(retentionDays = COMMAND_CENTER_MAP.schedules.alertRetentionDays): Promise<number> {
    const days = Math.min(Math.max(retentionDays, 1), 3650);
    const result = await this.db.run(
      `DELETE FROM risk_alert_log WHERE sent_at < datetime('now', ?)`,
      [`-${days} days`]
    );
    return result.changes;
  }

  async getDeliveryHealth(windowHours = 24): Promise<WebhookCircuitBreakerState> {
    const hours = Math.min(Math.max(windowHours, 1), 720);
    const rows = await this.db.all<{
      id: number;
      name: string;
      platform: string;
      enabled: number;
      attempts: number;
      successes: number;
      failures: number;
      last_attempt_at: string | null;
    }>(
      `SELECT
         h.id,
         h.name,
         h.platform,
         h.enabled,
         COUNT(l.id) AS attempts,
         COALESCE(SUM(CASE WHEN l.response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END), 0) AS successes,
         COALESCE(SUM(CASE WHEN l.response_status = 0 OR l.response_status >= 400 THEN 1 ELSE 0 END), 0) AS failures,
         MAX(l.sent_at) AS last_attempt_at
       FROM alert_webhooks h
       LEFT JOIN risk_alert_log l
         ON l.webhook_id = h.id
        AND l.sent_at >= datetime('now', ?)
       GROUP BY h.id, h.name, h.platform, h.enabled
       ORDER BY failures DESC, attempts DESC, h.name ASC`,
      [`-${hours} hours`]
    );

    const webhooks = rows.map((row) => {
      const failures = Number(row.failures || 0);
      const successes = Number(row.successes || 0);
      const state: WebhookDeliveryHealth['state'] = failures >= 3 && successes === 0
        ? 'open'
        : failures > 0
          ? 'degraded'
          : 'closed';
      return {
        id: row.id,
        name: row.name,
        platform: row.platform,
        enabled: Boolean(row.enabled),
        state,
        attempts: Number(row.attempts || 0),
        successes,
        failures,
        last_attempt_at: row.last_attempt_at,
      };
    });

    return {
      window_hours: hours,
      open_count: webhooks.filter((hook) => hook.state === 'open').length,
      degraded_count: webhooks.filter((hook) => hook.state === 'degraded').length,
      webhooks,
    };
  }

  // ─── Private ───────────────────────────────────────────────────────

  private async getMatchingWebhooks(riskLevel: string): Promise<WebhookRow[]> {
    const rows = await this.db.all<WebhookRow>(
      `SELECT * FROM alert_webhooks WHERE enabled = 1`
    );

    return rows.filter((hook) => {
      const triggers = this.parseTriggers(hook.triggers);
      // Match if triggers include the risk level or 'all'
      return (
        triggers.includes(riskLevel) ||
        triggers.includes(riskLevel.toLowerCase()) ||
        triggers.includes('all') ||
        triggers.includes('ALL')
      );
    });
  }

  private parseTriggers(triggers: string): string[] {
    try {
      const parsed = JSON.parse(triggers);
      if (Array.isArray(parsed)) return parsed.map((t: string) => t.toUpperCase());
    } catch {
      // Fallback: comma-separated string
    }
    return triggers.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  }

  private formatPayload(platform: string, input: RiskAlertInput): object {
    const colorMap: Record<string, number> = {
      BLACK: 0x000000,
      RED: 0xFF0000,
      YELLOW: 0xFFFF00,
      GREEN: 0x00FF00,
    };

    const actionLabel = input.suggested_action
      ? input.suggested_action.toUpperCase()
      : input.risk_level === 'BLACK'
        ? 'AUTO-BLOCKED'
        : 'REVIEW REQUIRED';
    const playerUrl = this.getPlayerUrl(input.customer_id);

    switch (platform) {
      case 'discord':
        return {
          username: 'Sports Terminal Risk Bot',
          embeds: [
            {
              title: `🚨 ${input.risk_level} RISK ALERT`,
              ...(playerUrl ? { url: playerUrl } : {}),
              color: colorMap[input.risk_level] || 0xFF0000,
              fields: [
                { name: 'Customer', value: input.customer_id, inline: true },
                { name: 'Confidence', value: `${(input.confidence * 100).toFixed(0)}%`, inline: true },
                { name: 'Action', value: actionLabel, inline: true },
                { name: 'Summary', value: input.summary || 'No summary available' },
              ],
              timestamp: new Date().toISOString(),
              footer: { text: 'Sports Terminal Risk Command Center' },
            },
          ],
        };

      case 'telegram':
        return {
          text: [
            `🚨 *${input.risk_level} RISK ALERT*`,
            '',
            `Customer: \`${input.customer_id}\``,
            `Confidence: ${(input.confidence * 100).toFixed(0)}%`,
            `Action: ${actionLabel}`,
            ...(playerUrl ? [`Player: ${playerUrl}`] : []),
            '',
            input.summary || 'No summary available',
          ].join('\n'),
          parse_mode: 'Markdown',
        };

      case 'slack':
        return {
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: `🚨 ${input.risk_level} RISK ALERT`, emoji: true },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Customer:* ${input.customer_id}\n*Confidence:* ${(input.confidence * 100).toFixed(0)}%\n*Action:* ${actionLabel}${playerUrl ? `\n*Player:* ${playerUrl}` : ''}`,
              },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: input.summary || 'No summary available' },
            },
          ],
        };

      case 'generic':
      default:
        return {
          customer_id: input.customer_id,
          risk_level: input.risk_level,
          confidence: input.confidence,
          suggested_action: input.suggested_action,
          summary: input.summary,
          player_url: playerUrl,
          timestamp: new Date().toISOString(),
          source: 'sports-terminal-risk-command-center',
        };
    }
  }

  private async routeToTelegramTopic(input: RiskAlertInput): Promise<void> {
    const client = new TelegramBotClient();
    await client.init();
    if (!client.isConfigured) return;

    const topicService = new TelegramTopicService(this.db);

    // Find agent_login for this customer
    const agentRow = await this.db.get<{ agent_login: string }>(
      `SELECT agent_login FROM wagers WHERE customer_id = ? ORDER BY insert_datetime DESC LIMIT 1`,
      [input.customer_id]
    );
    const agentLogin = agentRow?.agent_login;
    if (!agentLogin) return;

    // Find agent supergroup
    const supergroup = await this.db.get<{ id: number; supergroup_chat_id: string }>(
      `SELECT id, supergroup_chat_id FROM agent_supergroups WHERE owner_agent_login = ? AND purpose = 'agent' LIMIT 1`,
      [agentLogin]
    );
    if (!supergroup) return;

    // Find #alerts topic
    const topic = await topicService.findTopicByPurpose(supergroup.supergroup_chat_id, 'alerts');
    if (!topic) return;

    const playerUrl = this.getPlayerUrl(input.customer_id);
    const actionLabel = input.suggested_action
      ? input.suggested_action.toUpperCase()
      : input.risk_level === 'BLACK'
        ? 'AUTO-BLOCKED'
        : 'REVIEW REQUIRED';

    const text = [
      `🚨 *${input.risk_level} RISK ALERT*`,
      '',
      `Customer: \`${input.customer_id}\``,
      `Agent: ${agentLogin}`,
      `Confidence: ${(input.confidence * 100).toFixed(0)}%`,
      `Action: ${actionLabel}`,
      ...(playerUrl ? [`Player: ${playerUrl}`] : []),
      '',
      input.summary || 'No summary available',
    ].join('\n');

    await client.sendMessage({
      chat_id: supergroup.supergroup_chat_id,
      message_thread_id: topic.topic_thread_id,
      text,
      parse_mode: 'Markdown',
    });
  }

  private getPlayerUrl(customerId: string): string | null {
    const base = (Bun.env.TERMINAL_BASE_URL || Bun.env.PUBLIC_BASE_URL || '').trim();
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}/player/${encodeURIComponent(customerId)}`;
  }

  private async logDelivery(entry: {
    customer_id: string;
    risk_level: string;
    webhook_id: number;
    platform: string;
    payload: string;
    response_status: number;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO risk_alert_log (customer_id, risk_level, webhook_id, platform, payload, response_status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.customer_id,
        entry.risk_level,
        entry.webhook_id,
        entry.platform,
        entry.payload,
        entry.response_status,
      ]
    );
  }
}
