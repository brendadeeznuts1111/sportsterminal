/**
 * fetchWithTimeout.ts
 * Wrapper around fetch() with AbortSignal timeout support.
 * Prevents requests from hanging indefinitely on slow/unresponsive upstreams.
 *
 * Bun-specific features supported:
 * - verbose: true  → prints request/response headers to terminal (Bun-only)
 * - proxy: string  → HTTP proxy URL (Bun-only)
 * - tls: object    → custom TLS settings (Bun-only)
 *
 * Bun docs: https://bun.sh/docs/runtime/fetch
 */

export interface BunFetchOptions extends RequestInit {
  /** Bun-specific: print request/response headers to terminal for debugging */
  verbose?: boolean;
  /** Bun-specific: HTTP proxy URL */
  proxy?: string;
  /** Bun-specific: custom TLS options */
  tls?: {
    rejectUnauthorized?: boolean;
    cert?: string;
    key?: string;
    ca?: string;
  };
}

export async function fetchWithTimeout(
  url: string,
  options: BunFetchOptions = {},
  timeoutMs = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Build fetch init preserving Bun-specific options (verbose, proxy, tls)
  const fetchInit: BunFetchOptions = {
    ...options,
    signal: controller.signal,
  };

  try {
    // Pass through to Bun's native fetch; verbose/proxy/tls are consumed by Bun
    return await fetch(url, fetchInit);
  } finally {
    clearTimeout(timeout);
  }
}
