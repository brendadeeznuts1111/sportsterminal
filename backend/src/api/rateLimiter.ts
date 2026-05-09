/**
 * Rate Limiter — IP-based sliding window
 *
 * Configurable via env vars:
 *   RATE_LIMIT_MAX (default 100) — max requests per window
 *   RATE_LIMIT_WINDOW_MS (default 60000) — window duration in ms
 *
 * Dev bypass: disabled when NODE_ENV=development
 */
import { isDevMode } from '../auth/jwt';

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number; // seconds until next allowed request
}

export class RateLimiter {
  private window: Map<string, number[]>;
  private maxRequests: number;
  private windowMs: number;

  constructor(
    maxRequests: number = 100,
    windowMs: number = 60_000
  ) {
    this.window = new Map();
    this.maxRequests = Math.max(1, maxRequests);
    this.windowMs = Math.max(1000, windowMs);
  }

  /**
   * Check if a request from the given IP is allowed.
   * Returns allowed=false with retryAfter if rate limit exceeded.
   */
  check(ip: string): RateLimitResult {
    // Dev bypass
    if (isDevMode()) {
      return { allowed: true, retryAfter: 0 };
    }

    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Get or create timestamps array for this IP
    let timestamps = this.window.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.window.set(ip, timestamps);
    }

    // Prune expired entries
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    // Check if over limit
    if (timestamps.length >= this.maxRequests) {
      const oldestInWindow = timestamps[0];
      const retryAfter = Math.ceil((oldestInWindow + this.windowMs - now) / 1000);
      return { allowed: false, retryAfter: Math.max(1, retryAfter) };
    }

    // Allow and record
    timestamps.push(now);
    return { allowed: true, retryAfter: 0 };
  }

  /**
   * Extract client IP from request headers.
   * Checks x-forwarded-for, x-real-ip, then falls back to a simple hash.
   */
  static getClientIp(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }

    const realIp = request.headers.get('x-real-ip');
    if (realIp) {
      return realIp.trim();
    }

    // No standard header — fall back to a synthetic identifier.
    // Bun's Request doesn't expose the raw TCP remote address,
    // so we use host + user-agent as a best-effort identifier.
    const host = request.headers.get('host') || '';
    const ua = request.headers.get('user-agent') || '';
    return `local:${host}:${ua.substring(0, 40)}`;
  }
}

// Singleton instance
let defaultLimiter: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!defaultLimiter) {
    const max = parseInt(process.env.RATE_LIMIT_MAX || '100', 10) || 100;
    const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10) || 60000;
    defaultLimiter = new RateLimiter(max, windowMs);
  }
  return defaultLimiter;
}
