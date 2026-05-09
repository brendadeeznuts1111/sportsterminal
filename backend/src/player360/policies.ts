export type Player360RefreshPolicy = 'live' | 'hotset' | 'on_open' | 'daily' | 'manual' | 'derived';
export type Player360ScaleClass = 'realtime' | 'cheap' | 'heavy' | 'manual';
export type Player360FreshnessState = 'fresh' | 'stale' | 'missing' | 'error' | 'probe';

export interface Player360SourcePolicy {
  key: string;
  refreshPolicy: Player360RefreshPolicy;
  ttlSeconds: number;
  scaleClass: Player360ScaleClass;
}

export const PLAYER360_SOURCE_POLICIES: Record<string, Player360SourcePolicy> = {
  wager_archive: { key: 'wager_archive', refreshPolicy: 'live', ttlSeconds: 0, scaleClass: 'realtime' },
  access_logs: { key: 'access_logs', refreshPolicy: 'hotset', ttlSeconds: 30 * 60, scaleClass: 'cheap' },
  agent_performance_snapshots: { key: 'agent_performance_snapshots', refreshPolicy: 'hotset', ttlSeconds: 60 * 60, scaleClass: 'heavy' },
  player_transactions: { key: 'player_transactions', refreshPolicy: 'on_open', ttlSeconds: 6 * 60 * 60, scaleClass: 'heavy' },
  deleted_transactions: { key: 'deleted_transactions', refreshPolicy: 'on_open', ttlSeconds: 6 * 60 * 60, scaleClass: 'heavy' },
  deposits: { key: 'deposits', refreshPolicy: 'on_open', ttlSeconds: 6 * 60 * 60, scaleClass: 'heavy' },
  customer_snapshots: { key: 'customer_snapshots', refreshPolicy: 'on_open', ttlSeconds: 24 * 60 * 60, scaleClass: 'heavy' },
  teaser_profile: { key: 'teaser_profile', refreshPolicy: 'on_open', ttlSeconds: 24 * 60 * 60, scaleClass: 'heavy' },
  player_links: { key: 'player_links', refreshPolicy: 'derived', ttlSeconds: 0, scaleClass: 'cheap' },
  player_flags: { key: 'player_flags', refreshPolicy: 'manual', ttlSeconds: 0, scaleClass: 'manual' },
  player_notes: { key: 'player_notes', refreshPolicy: 'manual', ttlSeconds: 0, scaleClass: 'manual' },
};

export function getPlayer360SourcePolicy(key: string): Player360SourcePolicy {
  return PLAYER360_SOURCE_POLICIES[key] || {
    key,
    refreshPolicy: 'on_open',
    ttlSeconds: 0,
    scaleClass: 'heavy',
  };
}

export function nextRefreshAt(lastSuccessAt: string | null, ttlSeconds: number): string | null {
  if (!lastSuccessAt || ttlSeconds <= 0) return null;
  const last = new Date(lastSuccessAt).getTime();
  if (!Number.isFinite(last)) return null;
  return new Date(last + ttlSeconds * 1000).toISOString();
}

export function classifyPlayer360Freshness(input: {
  status: string;
  rowCount: number;
  ttlSeconds: number;
  lastSeen?: string | null;
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  refreshPolicy?: Player360RefreshPolicy;
  nowMs?: number;
}): Player360FreshnessState {
  if (input.lastError) return 'error';
  if (input.refreshPolicy === 'manual') return input.rowCount > 0 ? 'fresh' : 'missing';
  if (input.refreshPolicy === 'derived') return input.rowCount > 0 ? 'fresh' : 'probe';
  if (input.status === 'probe') return 'probe';
  if (input.rowCount <= 0) return input.lastAttemptAt ? 'probe' : 'missing';

  const freshnessTime = input.lastSuccessAt || input.lastSeen;
  if (!freshnessTime || input.ttlSeconds <= 0) return 'fresh';
  const updatedAt = new Date(freshnessTime).getTime();
  if (!Number.isFinite(updatedAt)) return 'fresh';
  return (input.nowMs ?? Date.now()) - updatedAt > input.ttlSeconds * 1000 ? 'stale' : 'fresh';
}

export function shouldRefreshPlayer360Source(input: {
  ttlSeconds: number;
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  force?: boolean;
  nowMs?: number;
}): boolean {
  if (input.force) return true;
  if (input.lastError) return true;
  if (input.ttlSeconds <= 0) return false;
  const referenceTime = input.lastSuccessAt || input.lastAttemptAt;
  if (!referenceTime) return true;
  const last = new Date(referenceTime).getTime();
  if (!Number.isFinite(last)) return true;
  return (input.nowMs ?? Date.now()) - last > input.ttlSeconds * 1000;
}
