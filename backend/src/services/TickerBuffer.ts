/**
 * TickerBuffer — receives enriched wagers and dispatches to plugin hooks.
 *
 * Designed to be called from ScraperManager polling loops or API routes.
 */

import { AppDatabase } from '../database';
import { PluginContext, pluginLoader } from './PluginLoader';

export interface TickerBufferOptions {
  /** Max wagers to keep in memory buffer */
  maxBufferSize: number;
  /** How often to flush buffered wagers to plugins (ms) */
  flushIntervalMs: number;
}

const DEFAULT_OPTIONS: TickerBufferOptions = {
  maxBufferSize: 500,
  flushIntervalMs: 5000,
};

// Module-level singleton (initialized in index.ts)
let globalTickerBuffer: TickerBuffer | null = null;

export function setGlobalTickerBuffer(tb: TickerBuffer): void {
  globalTickerBuffer = tb;
}

export function getGlobalTickerBuffer(): TickerBuffer | null {
  return globalTickerBuffer;
}

export class TickerBuffer {
  private buffer: PluginContext[] = [];
  private options: TickerBufferOptions;
  private flushTimer: Timer | null = null;
  private db: AppDatabase;

  constructor(db: AppDatabase, options: Partial<TickerBufferOptions> = {}) {
    this.db = db;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.startFlushTimer();
  }

  /**
   * Feed a single enriched wager into the buffer.
   * If buffer is full, flushes immediately.
   */
  feed(ctx: PluginContext): void {
    this.buffer.push(ctx);
    if (this.buffer.length >= this.options.maxBufferSize) {
      this.flush();
    }
  }

  /**
   * Feed multiple enriched wagers at once.
   */
  feedBatch(contexts: PluginContext[]): void {
    for (const ctx of contexts) {
      this.buffer.push(ctx);
    }
    if (this.buffer.length >= this.options.maxBufferSize) {
      this.flush();
    }
  }

  /**
   * Flush all buffered wagers through plugin hooks.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.buffer.length);
    const start = performance.now();

    for (const ctx of batch) {
      await pluginLoader.dispatch('on_wager', ctx, this.db);
    }

    const duration = Math.round(performance.now() - start);
    if (batch.length > 0) {
      console.log(`[TickerBuffer] Flushed ${batch.length} wagers through plugins in ${duration}ms`);
    }
  }

  /**
   * Get current buffer stats.
   */
  stats(): { buffered: number; maxSize: number; flushIntervalMs: number } {
    return {
      buffered: this.buffer.length,
      maxSize: this.options.maxBufferSize,
      flushIntervalMs: this.options.flushIntervalMs,
    };
  }

  /**
   * Stop the automatic flush timer.
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[TickerBuffer] Flush error:', err);
      });
    }, this.options.flushIntervalMs);
  }
}
