/**
 * WebhookCircuitBreaker — in-memory per-webhook circuit breaker.
 *
 * States:
 *   closed    → normal delivery
 *   degraded  → some recent failures, still attempting
 *   open      → skip delivery until cooldown expires
 *
 * In-memory only (resets on restart). This is safe because:
 *   - A restart clears transient errors
 *   - Prevents permanent blocks from stale state
 */

export interface WebhookCircuitBreakerState {
  url: string;
  state: 'closed' | 'degraded' | 'open';
  failures: number;
  successes: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  openedAt: number;
}

interface WebhookRecord {
  url: string;
  failures: number;
  successes: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  openedAt: number;
  state: 'closed' | 'degraded' | 'open';
}

const DEFAULT_OPTIONS = {
  failureThreshold: 5,
  successThreshold: 2,
  cooldownMs: 60_000,
  windowMs: 300_000,
};

export class WebhookCircuitBreaker {
  private records = new Map<string, WebhookRecord>();

  constructor(private readonly opts = DEFAULT_OPTIONS) {}

  /**
   * Check if delivery is allowed for this webhook URL.
   * Returns false when circuit is open and cooldown hasn't expired.
   */
  canDeliver(url: string): boolean {
    const rec = this.records.get(url);
    if (!rec) return true;

    if (rec.state === 'open') {
      const elapsed = Date.now() - rec.openedAt;
      if (elapsed >= this.opts.cooldownMs) {
        // Half-open: allow one probe
        rec.state = 'degraded';
        rec.failures = Math.floor(rec.failures / 2);
        return true;
      }
      return false;
    }

    return true;
  }

  /** Record a successful delivery. */
  recordSuccess(url: string): void {
    const rec = this.getOrCreate(url);
    rec.successes++;
    rec.lastSuccessAt = Date.now();

    if (rec.state === 'degraded' && rec.successes >= this.opts.successThreshold) {
      rec.state = 'closed';
      rec.failures = 0;
    }
  }

  /** Record a failed delivery. */
  recordFailure(url: string): void {
    const rec = this.getOrCreate(url);
    rec.failures++;
    rec.lastFailureAt = Date.now();

    if (rec.failures >= this.opts.failureThreshold) {
      rec.state = 'open';
      rec.openedAt = Date.now();
    } else if (rec.failures >= Math.ceil(this.opts.failureThreshold / 2)) {
      rec.state = 'degraded';
    }
  }

  /** Get current state for all tracked webhooks. */
  getStates(): WebhookCircuitBreakerState[] {
    return Array.from(this.records.values()).map((rec) => ({
      url: rec.url,
      state: rec.state,
      failures: rec.failures,
      successes: rec.successes,
      lastFailureAt: rec.lastFailureAt,
      lastSuccessAt: rec.lastSuccessAt,
      openedAt: rec.openedAt,
    }));
  }

  /** Get state for a single webhook. */
  getState(url: string): WebhookCircuitBreakerState | null {
    const rec = this.records.get(url);
    if (!rec) return null;
    return {
      url: rec.url,
      state: rec.state,
      failures: rec.failures,
      successes: rec.successes,
      lastFailureAt: rec.lastFailureAt,
      lastSuccessAt: rec.lastSuccessAt,
      openedAt: rec.openedAt,
    };
  }

  private getOrCreate(url: string): WebhookRecord {
    let rec = this.records.get(url);
    if (!rec) {
      rec = {
        url,
        failures: 0,
        successes: 0,
        lastFailureAt: 0,
        lastSuccessAt: 0,
        openedAt: 0,
        state: 'closed',
      };
      this.records.set(url, rec);
    }
    return rec;
  }
}

// Singleton instance shared across the process
export const webhookCircuitBreaker = new WebhookCircuitBreaker();
