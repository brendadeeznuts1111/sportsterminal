/**
 * PerformanceCache.ts
 * Bun.redis-backed caching layer for agent performance snapshots.
 *
 * - 15-minute TTL per agent performance snapshot
 * - Auto-pull logic: checks Redis first, falls back to Buckeye API
 * - Pub/sub broadcasts updates to connected dashboards
 * - Graceful degradation when Redis is unavailable
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_PREFIX = 'sportsterminal:perf:';
const PUBSUB_CHANNEL = 'sportsterminal:perf:updates';

export interface CachedPerformance {
  agentId: string;
  data: unknown;
  cachedAt: string;
  ttlMs: number;
}

export interface PerformanceFetcher {
  (agentId: string): Promise<unknown>;
}

type RedisClient = InstanceType<typeof Bun.redis.constructor>;

export class PerformanceCache {
  private redis: RedisClient | null = null;
  private connected = false;
  private fetcher: PerformanceFetcher;
  private defaultTtlMs: number;

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
    if (this.connected && this.redis) {
      try {
        const cached = await this.redis.get(`${CACHE_PREFIX}${agentId}`);
        if (cached) {
          const parsed: CachedPerformance = JSON.parse(cached as string);
          const age = Date.now() - new Date(parsed.cachedAt).getTime();
          if (age < parsed.ttlMs) {
            return { data: parsed.data, source: 'cache' };
          }
        }
      } catch {
        // Redis error — fall through to API
      }
    }

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
  }

  // ── Internal ────────────────────────────────────────────────

  private initRedis(redisUrl: string): void {
    try {
      const RedisClient = Bun.redis.constructor as new (url?: string) => RedisClient;
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
}
