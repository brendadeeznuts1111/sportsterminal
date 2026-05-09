/**
 * Raw API Logger Service
 * Logs every API response from Buckeye into raw_api_logs table.
 * Fire-and-forget design — does not block the response to the client.
 */

import type { Database } from '../database';

export const DEFAULT_SENSITIVE_FIELDS = [
  'password',
  'pin',
  'smsphonenumber',
  'phone',
  'email',
  'creditcard',
  'cardnumber',
  'cvv',
  'ssn',
  'taxid',
  'bankaccount',
  'routingnumber',
  'secret',
  'token',
  'bearer',
  'authorization',
  'apikey',
  'authtoken',
  'cf_clearance',
  'cf_bm',
  'cookie',
];

export interface RawLogEntry {
  endpoint: string;
  responseJson: unknown;
  agentId?: string;
  durationMs?: number;
  requestParams?: string;
  statusCode?: number;
}

interface QueuedRawLogEntry {
  endpoint: string;
  responseJson: string;
  agentId: string | null;
  durationMs: number | null;
  requestParams: string | null;
  statusCode: number | null;
}

export class RawApiLogger {
  private db: Database;
  private enabled: boolean;
  private queue: QueuedRawLogEntry[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private batchSize: number;
  private flushDelayMs: number;

  constructor(
    db: Database,
    enabled: boolean = true,
    options: { batchSize?: number; flushDelayMs?: number } = {}
  ) {
    this.db = db;
    this.enabled = enabled;
    this.batchSize = Math.max(1, options.batchSize ?? 25);
    this.flushDelayMs = Math.max(10, options.flushDelayMs ?? 250);
  }

  /**
   * Log a raw API response.
   * @param entry - Log entry data
   */
  async log(entry: RawLogEntry): Promise<void> {
    if (!this.enabled) return;

    try {
      const responseJson =
        typeof entry.responseJson === 'string'
          ? redactSensitiveJsonString(entry.responseJson)
          : JSON.stringify(redactSensitiveFields(entry.responseJson));

      this.queue.push({
        endpoint: entry.endpoint,
        responseJson,
        agentId: entry.agentId || null,
        durationMs: entry.durationMs || null,
        requestParams: entry.requestParams || null,
        statusCode: entry.statusCode || null,
      });

      if (this.queue.length >= this.batchSize) {
        void this.flush();
      } else {
        this.scheduleFlush();
      }
    } catch (error) {
      // Log errors silently — don't let logging failures break the application
      console.error('[RawApiLogger] Failed to log raw API response:', error);
    }
  }

  /**
   * Log a response with timing information.
   * @param endpoint - API endpoint
   * @param response - Response object
   * @param agentId - Agent ID (optional)
   * @param startTime - Request start time (for duration calculation)
   * @param requestParams - Request parameters (optional)
   */
  async logWithTiming(
    endpoint: string,
    response: Response,
    agentId?: string,
    startTime: number = Date.now(),
    requestParams?: string
  ): Promise<void> {
    const durationMs = Date.now() - startTime;
    const responseText = await response.clone().text();

    await this.log({
      endpoint,
      responseJson: responseText,
      agentId,
      durationMs,
      requestParams,
      statusCode: response.status,
    });
  }

  /**
   * Redact sensitive fields from JSON response.
   * Removes passwords, PINs, SMS phone numbers, and other PII.
   */
  /**
   * Enable or disable logging.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if logging is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    const batch = this.queue.splice(0, this.batchSize);
    if (batch.length === 0) return;

    try {
      await this.db.run('BEGIN');
      for (const entry of batch) {
        await this.db.run(
          `INSERT INTO raw_api_logs (
            endpoint,
            fetched_at,
            response_json,
            agent_id,
            duration_ms,
            request_params,
            status_code
          ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`,
          [
            entry.endpoint,
            entry.responseJson,
            entry.agentId,
            entry.durationMs,
            entry.requestParams,
            entry.statusCode,
          ]
        );
      }
      await this.db.run('COMMIT');
    } catch (error) {
      try {
        await this.db.run('ROLLBACK');
      } catch {
        // Ignore rollback failures.
      }
      console.error('[RawApiLogger] Failed to flush raw API logs:', error);
    } finally {
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, this.flushDelayMs);
  }
}

export function redactSensitiveFields(
  value: unknown,
  sensitiveFields: string[] = DEFAULT_SENSITIVE_FIELDS
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item, sensitiveFields));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveFields.some((field) => lowerKey.includes(field))) {
      result[key] = 'REDACTED';
    } else {
      result[key] = redactSensitiveFields(child, sensitiveFields);
    }
  }

  return result;
}

function redactSensitiveJsonString(json: string): string {
  try {
    return JSON.stringify(redactSensitiveFields(JSON.parse(json)));
  } catch {
    return json;
  }
}
