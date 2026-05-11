// utils/connection.ts — Connection fingerprinting, DNS caching, preconnect benchmarks
import { randomUUIDv7 } from "bun";
import os from "node:os";

export interface ConnectionFingerprint {
  id: string;
  os: string;
  arch: string;
  platform: string;
  version: string;
  runtime: string;
  runtimeVersion: string;
  chromeVersion: string;
  chromeMajor: number;
}

let _fingerprint: ConnectionFingerprint | null = null;

export function getConnectionFingerprint(): ConnectionFingerprint {
  if (_fingerprint) return _fingerprint;

  const platform = os.platform();
  const arch = os.arch();
  const version = os.release();
  const runtimeVersion = process.versions.bun || Bun.version || "unknown";

  const osMap: Record<string, string> = {
    win32: "Windows",
    linux: "Linux",
    darwin: "macOS",
    freebsd: "FreeBSD",
  };

  const chromeMajor = 148;

  _fingerprint = {
    id: randomUUIDv7(),
    os: osMap[platform] || platform,
    arch,
    platform,
    version,
    runtime: "bun",
    runtimeVersion,
    chromeVersion: `${chromeMajor}.0.7778.96`,
    chromeMajor,
  };

  return _fingerprint;
}

export function getApiFingerprintHeader(fingerprint?: ConnectionFingerprint): string {
  const fp = fingerprint || getConnectionFingerprint();
  return [
    `id=${fp.id}`,
    `os=${fp.os}`,
    `arch=${fp.arch}`,
    `platform=${fp.platform}`,
    `runtime=${fp.runtime}`,
    `runtimeVersion=${fp.runtimeVersion}`,
    `chrome=${fp.chromeVersion}`,
  ].join(";");
}

function buildUserAgent(fp: ConnectionFingerprint): string {
  switch (fp.platform) {
    case "win32":
      return `Mozilla/5.0 (Windows NT 10.0; Win64; ${fp.arch === "arm64" ? "arm64" : "x64"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fp.chromeVersion} Safari/537.36`;
    case "darwin":
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fp.chromeVersion} Safari/537.36`;
    case "linux":
      return `Mozilla/5.0 (X11; Linux ${fp.arch === "arm64" ? "aarch64" : "x86_64"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fp.chromeVersion} Safari/537.36`;
    default:
      return `Mozilla/5.0 (${fp.os}; ${fp.arch}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fp.chromeVersion} Safari/537.36`;
  }
}

export interface BrowserHeaderOptions {
  token?: string;
  cookie?: string;
  origin?: string;
  referer?: string;
  contentType?: string;
  accept?: string;
  fingerprint?: ConnectionFingerprint;
}

export function buildBrowserHeaders(options: BrowserHeaderOptions = {}): Record<string, string> {
  const fp = options.fingerprint || getConnectionFingerprint();
  const token = options.token ?? "undefined";
  const origin = options.origin ?? "https://fantasy402.com";
  const referer = options.referer ?? "https://fantasy402.com/";
  const contentType = options.contentType ?? "application/x-www-form-urlencoded; charset=UTF-8";
  const accept = options.accept ?? "*/*";

  const platformMap: Record<string, string> = {
    win32: "Windows",
    darwin: "macOS",
    linux: "Linux",
  };

  const h: Record<string, string> = {
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
    Origin: origin,
    Priority: "u=1, i",
    Referer: referer,
    "Sec-Ch-Ua": `"Google Chrome";v="${fp.chromeMajor}", "Not.A/Brand";v="8", "Chromium";v="${fp.chromeMajor}"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": `"${platformMap[fp.platform] || fp.os}"`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": buildUserAgent(fp),
    "X-Requested-With": "XMLHttpRequest",
    "X-API-Fingerprint": getApiFingerprintHeader(fp),
  };

  if (options.cookie) {
    h.Cookie = options.cookie;
  }

  return h;
}

export interface ServiceHeaderOptions {
  apiKey?: string;
  adminKey?: string;
  fingerprint?: ConnectionFingerprint;
  extra?: Record<string, string>;
}

export function buildServiceHeaders(options: ServiceHeaderOptions = {}): Record<string, string> {
  const fp = options.fingerprint || getConnectionFingerprint();
  const h: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-Fingerprint": getApiFingerprintHeader(fp),
    ...(options.apiKey ? { "X-API-Key": options.apiKey } : {}),
    ...(options.adminKey ? { "X-Admin-Key": options.adminKey } : {}),
    ...(options.extra || {}),
  };
  return h;
}

// ==========================================
// PRECONNECT + DNS CACHE + BENCHMARK
// ==========================================

export interface WarmupBenchmark {
  target: string;
  host: string;
  port: number;
  dnsMs: number;
  tcpMs: number;
  totalMs: number;
  dnsPrefetched: boolean;
  preconnected: boolean;
  error?: string;
}

function parseNetworkTarget(origin: string): { origin: string; host: string; port: number } | null {
  try {
    const url = new URL(origin);
    return {
      origin: url.origin,
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
  } catch {
    return null;
  }
}

export async function benchmarkNetworkTarget(origin: string): Promise<WarmupBenchmark | null> {
  const target = parseNetworkTarget(origin);
  if (!target) return null;

  const result: WarmupBenchmark = {
    target: target.origin,
    host: target.host,
    port: target.port,
    dnsMs: 0,
    tcpMs: 0,
    totalMs: 0,
    dnsPrefetched: false,
    preconnected: false,
  };

  const t0 = performance.now();

  try {
    const dnsStart = performance.now();
    await Promise.resolve(Bun.dns.prefetch(target.host, target.port));
    result.dnsMs = Math.round(performance.now() - dnsStart);
    result.dnsPrefetched = true;
  } catch (error) {
    result.error = `dns: ${error instanceof Error ? error.message : String(error)}`;
  }

  try {
    const tcpStart = performance.now();
    const fetchWithPreconnect = fetch as typeof fetch & {
      preconnect?: (url: string, options?: { dns?: boolean; tcp?: boolean }) => unknown;
    };
    await Promise.resolve(fetchWithPreconnect.preconnect?.(target.origin, { dns: true, tcp: true }));
    result.tcpMs = Math.round(performance.now() - tcpStart);
    result.preconnected = true;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    result.error = result.error ? `${result.error}; preconnect: ${details}` : `preconnect: ${details}`;
  }

  result.totalMs = Math.round(performance.now() - t0);
  return result;
}

export async function prewarmNetworkTargets(targets: string[]): Promise<WarmupBenchmark[]> {
  const uniqueTargets = Array.from(new Set(targets.filter(Boolean)));
  const results = (await Promise.all(uniqueTargets.map((t) => benchmarkNetworkTarget(t)))).filter(
    (r): r is WarmupBenchmark => Boolean(r)
  );
  return results;
}

export interface DnsCacheStats {
  cacheHitsCompleted?: number;
  cacheHitsInflight?: number;
  cacheMisses?: number;
  size?: number;
  errors?: number;
  totalCount?: number;
  [key: string]: unknown;
}

export function getDnsCacheStats(): DnsCacheStats | null {
  try {
    return Bun.dns.getCacheStats() as DnsCacheStats;
  } catch {
    return null;
  }
}

export function enrichDnsStats(stats: DnsCacheStats | null): Record<string, unknown> | null {
  if (!stats) return null;
  const hits = Number(stats.cacheHitsCompleted || 0);
  const total = Number(stats.totalCount || 0);
  const hitRatePercent = total > 0 ? Number(((hits / total) * 100).toFixed(1)) : null;
  return {
    ...stats,
    hitRatePercent,
    hitRate: hitRatePercent === null ? "N/A" : `${hitRatePercent.toFixed(1)}%`,
  };
}
