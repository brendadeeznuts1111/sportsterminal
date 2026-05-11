/**
 * fetchWithTimeout.ts
 * Wrapper around fetch() with AbortSignal timeout support.
 * Prevents requests from hanging indefinitely on slow/unresponsive upstreams.
 */

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
