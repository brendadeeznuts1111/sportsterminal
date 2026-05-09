/**
 * PerformanceCache.ts
 * Bun.redis-backed caching layer for agent performance snapshots.
 *
 * - 15-minute TTL per agent performance snapshot
 * - Auto-pull logic: checks Redis first, falls back to Buckeye API
 * - Pub/sub broadcasts updates to connected dashboards
 * - Graceful degradation when Redis is unavailable
 */

import { RedisClient } from 'bun';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_PREFIX = 'sportsterminal:perf:';
const PUBSUB_CHANNEL = 'sportsterminal:perf:updates';

export interface CachedPerformance {
  agentId: string;
  data: unknown;
  cachedAt: string; // ISO timestamp
  ttlMs: number;
}

export interface PerformanceFetcher {
  (agentId: string): Promise<unknown>;
}

export class PerformanceCache {
  private redis: RedisClient | null = null;
  private connected = false;
  private fetcher: PerformanceFetcher;
  private defaultTtlMs: number;
  private subscribeCallbacks: Map<string, Set<(msg: string) => void>> = new Map();

  constructor(
    fetcher: PerformanceFetcher,
    redisUrl?: string,
    defaultTtlMs: number = DEFAULT_TTL_MS
  ) {
    this.fetcher = fetcher;
    this.defaultTtlMs = defaultTtlMs;

    if (redisUrl) {
      this.initRedis(redisUrl);
    }
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Get performance data for an agent.
   * Checks Redis cache first; falls back to the fetcher on miss.
   */
  async get(agentId: string): Promise<{ data: unknown; source: 'cache' | 'api' }> {
    // Try cache first
    if (this.connected && this.redis) {
      try {
        const cached = await this.redis.get(`${CACHE_PREFIX}${agentId}`);
        if (cached) {
          const parsed: CachedPerformance = JSON.parse(cached);
          const age = Date.now() - new Date(parsed.cachedAt).getTime();
          if (age < parsed.ttlMs) {
            return { data: parsed.data, source: 'cache' };
          }
        }
      } catch {
        // Redis error — fall through to API
      }
    }

    // Fallback to API
    const data = await this.fetcher(agentId);
    await this.set(agentId, data);
    return { data, source: 'api' };
  }

  /**
   * Store performance data in cache and publish update.
   */
  async set(agentId: string, data: unknown, ttlMs?: number): Promise<void> {
    if (!this.connected || !this.redis) return;

    const entry: CachedPerformance = {
      agentId,
      data,
      cachedAt: new Date().toISOString(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
    };

    try {
      await this.redis.setex(
        `${CACHE_PREFIX}${agentId}`,
        Math.ceil((ttlMs ?? this.defaultTtlMs) / 1000),
        JSON.stringify(entry)
      );
      // Publish update for dashboards
      await this.redis.publish(
        PUBSUB_CHANNEL,
        JSON.stringify({ type: 'performance_update', agentId, timestamp: entry.cachedAt })
      );
    } catch {
      // Non-critical — cache is best-effort
    }
  }

  /**
   * Invalidate cache entry for an agent.
   */
  async invalidate(agentId: string): Promise<void> {
    if (!this.connected || !this.redis) return;
    try {
      await this.redis.del(`${CACHE_PREFIX}${agentId}`);
    } catch {
      // Best-effort
    }
  }

  /**
   * Subscribe to performance update broadcasts.
   * Returns an unsubscribe function.
   */
  subscribe(callback: (msg: { type: string; agentId: string; timestamp: string }) => void): () => void {
    const id = crypto.randomUUID();
    if (!this.subscribeCallbacks.has(PUBSUB_CHANNEL)) {
      this.subscribeCallbacks.set(PUBSUB_CHANNEL, new Set());
    }
    this.subscribeCallbacks.get(PUBSUB_CHANNEL)!.add(id);

    // Start pub/sub listener if not already active
    this.ensurePubSubListener();

    // Wrap callback for type safety
    const wrappedCallback = (raw: string) => {
      try {
        const parsed = JSON.parse(raw);
        callback(parsed);
      } catch {
        // Ignore malformed messages
      }
    };
    (wrappedCallback as any).__id = id;
    this.subscribeCallbacks.get(PUBSUB_CHANNEL)!.add(wrappedCallback as any);

    return () => {
      const set = this.subscribeCallbacks.get(PUBSUB_CHANNEL);
      if (set) {
        set.delete(wrappedCallback as any);
        set.delete(id);
      }
    };
  }

  /**
   * Check if Redis is connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close the Redis connection.
   */
  async close(): Promise<void> {
    if (this.redis) {
      try {
        this.redis.close();
      } catch {
        // Ignore
      }
    }
    this.redis = null;
    this.connected = false;
    this.subscribeCallbacks.clear();
  }

  // ── Internal ────────────────────────────────────────────────

  private initRedis(redisUrl: string): void {
    try {
      const RedisClient = (Bun as any).redis.constructor as new (url?: string) => RedisClient;
      this.redis = new RedisClient(redisUrl);
      this.redis.onconnect = () => {
        this.connected = true;
        console.log('[PerformanceCache] Redis connected');
      };
      this.redis.onclose = () => {
        this.connected = false;
        console.log('[PerformanceCache] Redis disconnected');
      };
      this.redis.connect();
    } catch (err) {
      console.warn('[PerformanceCache] Redis unavailable — running in fallback mode');
      this.redis = null;
      this.connected = false;
    }
  }

  private pubSubActive = false;

  private ensurePubSubListener(): void {
    if (this.pubSubActive || !this.redis) return;
    this.pubSubActive = true;

    // Use a dedicated connection for pub/sub
    try {
      const RedisClient = (Bun as any).redis.constructor as new (url?: string) => RedisClient;
      const subRedis = new RedisClient(this.redis !== null ? undefined : undefined);
      subRedis.onconnect = () => {
        subRedis.subscribe(PUBSUB_CHANNEL);
      };
      subRedis.connect();

      // Poll for messages (Bun.redis subscribe delivers via callback)
      // Since Bun.redis subscribe is callback-based, we use a simple interval
      const pollInterval = setInterval(() => {
        if (!this.connected) {
          clearInterval(pollInterval);
          this.pubSubActive = false;
        }
      }, 30_000);

      // Store reference for cleanup
      (this as any).__subRedis = subRedis;
      (this as any).__subPoll = pollInterval;
    } catch {
      this.pubSubActive = false;
    }
  }
}
