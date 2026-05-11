/**
 * RiskAlertService
 * Dispatches webhook alerts when AI flags a player as RED or BLACK.
 * Uses the existing alert_webhooks table and WebhookService infrastructure.
 */

import type { Database } from '../database';
import { COMMAND_CENTER_MAP } from '../config/commandCenterMap';
import { streamHub } from './StreamHub';

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
          sent++;
        } else {
          failed++;
        }
      } catch (err) {
        console.error(`[RiskAlert] Webhook failed for ${hook.name}:`, err);
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

    return { sent, failed };
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

      return { success: response.ok, status: response.status };
    } catch (err) {
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

    switch (platform) {
      case 'discord':
        return {
          username: 'Sports Terminal Risk Bot',
          embeds: [
            {
              title: `🚨 ${input.risk_level} RISK ALERT`,
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
                text: `*Customer:* ${input.customer_id}\n*Confidence:* ${(input.confidence * 100).toFixed(0)}%\n*Action:* ${actionLabel}`,
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
          timestamp: new Date().toISOString(),
          source: 'sports-terminal-risk-command-center',
        };
    }
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
