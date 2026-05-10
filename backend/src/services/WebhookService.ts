/**
 * WebhookService
 * Manages alert webhook CRUD, payload formatting per platform,
 * dispatch with retry, and delivery logging.
 */

import type { Database } from '../database';
import type { Alert } from '../risk/AlertEngine';

export type WebhookPlatform = 'discord' | 'slack' | 'telegram' | 'generic';

export interface WebhookConfig {
  id?: number;
  name: string;
  platform: WebhookPlatform;
  url: string;
  triggers: string[];
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface WebhookDelivery {
  id?: number;
  webhookId: number;
  alertId?: number;
  payload: string;
  responseStatus?: number;
  responseBody?: string;
  success: boolean;
  attemptedAt?: string;
}

interface WebhookConfigRow {
  id: number;
  name: string;
  platform: WebhookPlatform;
  url: string;
  triggers: string;
  enabled: number | boolean;
  created_at?: string;
  updated_at?: string;
}

interface WebhookDeliveryRow {
  id: number;
  webhook_id: number;
  alert_id?: number;
  payload: string;
  response_status?: number;
  response_body?: string;
  success: number | boolean;
  attempted_at?: string;
}

export class WebhookService {
  private db: Database;
  private retryDelayMs: number;

  constructor(db: Database, retryDelayMs: number = 1000) {
    this.db = db;
    this.retryDelayMs = retryDelayMs;
  }

  // ==================== CRUD ====================

  async createWebhook(config: Omit<WebhookConfig, 'id' | 'createdAt' | 'updatedAt'>): Promise<WebhookConfig> {
    const result = await this.db.run(
      `INSERT INTO alert_webhooks (name, platform, url, triggers, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        config.name,
        config.platform,
        config.url,
        JSON.stringify(config.triggers),
        config.enabled ? 1 : 0,
      ]
    );

    return this.getWebhookById(result.lastID as number) as Promise<WebhookConfig>;
  }

  async getWebhooks(): Promise<WebhookConfig[]> {
    const rows = await this.db.all<WebhookConfigRow>('SELECT * FROM alert_webhooks ORDER BY created_at DESC');
    return rows.map((r) => this.rowToConfig(r));
  }

  async getWebhookById(id: number): Promise<WebhookConfig | null> {
    const row = await this.db.get<WebhookConfigRow>('SELECT * FROM alert_webhooks WHERE id = ?', [id]);
    return row ? this.rowToConfig(row) : null;
  }

  async updateWebhook(id: number, updates: Partial<Omit<WebhookConfig, 'id' | 'createdAt' | 'updatedAt'>>): Promise<WebhookConfig | null> {
    const sets: string[] = [];
    const values: Array<string | number> = [];

    if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
    if (updates.platform !== undefined) { sets.push('platform = ?'); values.push(updates.platform); }
    if (updates.url !== undefined) { sets.push('url = ?'); values.push(updates.url); }
    if (updates.triggers !== undefined) { sets.push('triggers = ?'); values.push(JSON.stringify(updates.triggers)); }
    if (updates.enabled !== undefined) { sets.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }

    if (sets.length === 0) return this.getWebhookById(id);

    sets.push("updated_at = datetime('now')");
    values.push(id);

    await this.db.run(
      `UPDATE alert_webhooks SET ${sets.join(', ')} WHERE id = ?`,
      values
    );

    return this.getWebhookById(id);
  }

  async deleteWebhook(id: number): Promise<boolean> {
    const result = await this.db.run('DELETE FROM alert_webhooks WHERE id = ?', [id]);
    return (result.changes ?? 0) > 0;
  }

  // ==================== DISPATCH ====================

  async dispatchAlert(alert: Alert): Promise<void> {
    const webhooks = await this.getActiveWebhooksForTrigger(alert.severity);
    if (webhooks.length === 0) return;

    for (const hook of webhooks) {
      await this.dispatchToWebhook(hook, alert);
    }
  }

  private async dispatchToWebhook(hook: WebhookConfig, alert: Alert, attempt: number = 1): Promise<void> {
    const payload = this.formatPayload(hook.platform, alert);
    const payloadJson = JSON.stringify(payload);

    let success: boolean;
    let responseStatus: number | undefined;
    let responseBody: string | undefined;

    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadJson,
      });

      responseStatus = response.status;
      responseBody = await response.text().catch(() => '');
      success = response.ok;
    } catch (error) {
      success = false;
      responseBody = error instanceof Error ? error.message : 'Network error';
    }

    // Log delivery
    await this.logDelivery({
      webhookId: hook.id!,
      alertId: alert.wagerNumber,
      payload: payloadJson,
      responseStatus,
      responseBody,
      success,
    });

    // Retry on failure (max 3 attempts, exponential backoff)
    if (!success && attempt < 3) {
      const delay = Math.pow(2, attempt) * this.retryDelayMs;
      await Bun.sleep(delay);
      await this.dispatchToWebhook(hook, alert, attempt + 1);
    }
  }

  private async getActiveWebhooksForTrigger(severity: string): Promise<WebhookConfig[]> {
    const rows = await this.db.all<WebhookConfigRow>(
      `SELECT * FROM alert_webhooks WHERE enabled = 1`
    );
    return rows
      .map((r) => this.rowToConfig(r))
      .filter((hook) => {
        if (hook.triggers.includes('all')) return true;
        return hook.triggers.includes(severity);
      });
  }

  // ==================== PAYLOAD FORMATTING ====================

  private formatPayload(platform: WebhookPlatform, alert: Alert): object {
    const colorMap: Record<string, number> = {
      info: 3447003,      // blue
      warning: 16776960,  // yellow
      critical: 15158332, // red
    };

    switch (platform) {
      case 'discord':
        return {
          embeds: [
            {
              title: `🚨 ${alert.ruleName}`,
              description: alert.message,
              color: colorMap[alert.severity] || 0,
              timestamp: new Date().toISOString(),
              footer: { text: `Severity: ${alert.severity.toUpperCase()} | Wager #${alert.wagerNumber}` },
            },
          ],
        };

      case 'slack':
        return {
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: `🚨 ${alert.ruleName}`, emoji: true },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*${alert.severity.toUpperCase()}*\n${alert.message}` },
            },
            {
              type: 'context',
              elements: [
                { type: 'mrkdwn', text: `Wager #${alert.wagerNumber} | ${new Date().toISOString()}` },
              ],
            },
          ],
        };

      case 'telegram':
        return {
          text: `🚨 *${alert.ruleName}*\n\nSeverity: *${alert.severity.toUpperCase()}*\n${alert.message}\n\nWager #${alert.wagerNumber}`,
          parse_mode: 'Markdown',
        };

      case 'generic':
      default:
        return {
          rule: alert.ruleName,
          severity: alert.severity,
          message: alert.message,
          wagerNumber: alert.wagerNumber,
          timestamp: new Date().toISOString(),
        };
    }
  }

  // ==================== DELIVERY LOG ====================

  async getDeliveries(webhookId?: number, limit: number = 100): Promise<WebhookDelivery[]> {
    let rows: WebhookDeliveryRow[];
    if (webhookId) {
      rows = await this.db.all<WebhookDeliveryRow>(
        'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY attempted_at DESC LIMIT ?',
        [webhookId, limit]
      );
    } else {
      rows = await this.db.all<WebhookDeliveryRow>(
        'SELECT * FROM webhook_deliveries ORDER BY attempted_at DESC LIMIT ?',
        [limit]
      );
    }
    return rows.map((r) => this.rowToDelivery(r));
  }

  private async logDelivery(delivery: Omit<WebhookDelivery, 'id' | 'attemptedAt'>): Promise<void> {
    await this.db.run(
      `INSERT INTO webhook_deliveries (webhook_id, alert_id, payload, response_status, response_body, success, attempted_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        delivery.webhookId,
        delivery.alertId ?? null,
        delivery.payload,
        delivery.responseStatus ?? null,
        delivery.responseBody ?? null,
        delivery.success ? 1 : 0,
      ]
    );
  }

  // ==================== HELPERS ====================

  private rowToConfig(row: WebhookConfigRow): WebhookConfig {
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      url: row.url,
      triggers: JSON.parse(row.triggers || '["all"]'),
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToDelivery(row: WebhookDeliveryRow): WebhookDelivery {
    return {
      id: row.id,
      webhookId: row.webhook_id,
      alertId: row.alert_id,
      payload: row.payload,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      success: Boolean(row.success),
      attemptedAt: row.attempted_at,
    };
  }
}
