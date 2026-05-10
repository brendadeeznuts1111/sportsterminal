/**
 * Geo-IP enrichment service.
 * Uses fast-geoip (MaxMind GeoLite2) for local lookups.
 * Results are cached in memory to avoid repeated lookups.
 */
import geoip from 'fast-geoip';

interface GeoResult {
  country: string;
  region: string;
  city: string;
  timezone: string;
  ll: [number, number];
}

const cache = new Map<string, GeoResult | null>();
const MAX_CACHE_SIZE = 5000;

export async function enrichIpGeo(ip: string): Promise<GeoResult | null> {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return null;
  }

  const cached = cache.get(ip);
  if (cached !== undefined) return cached;

  try {
    const result = await geoip.lookup(ip);
    if (!result) {
      cache.set(ip, null);
      return null;
    }

    const enriched: GeoResult = {
      country: result.country || '',
      region: result.region || '',
      city: result.city || '',
      timezone: result.timezone || '',
      ll: result.ll || [0, 0],
    };

    // Prune cache if too large
    if (cache.size >= MAX_CACHE_SIZE) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }

    cache.set(ip, enriched);
    return enriched;
  } catch {
    cache.set(ip, null);
    return null;
  }
}

export function formatGeoLabel(geo: GeoResult | null): string {
  if (!geo) return '';
  const parts = [geo.city, geo.region, geo.country].filter(Boolean);
  return parts.join(', ');
}
