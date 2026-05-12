/**
 * BunUtils — wrappers and helpers around Bun's built-in utilities.
 *
 * References:
 * - https://bun.sh/docs/runtime/utils
 * - Bun.which, Bun.sleepSync, Bun.inspect, Bun.nanoseconds, etc.
 */

import { which, sleepSync, nanoseconds, inspect } from 'bun';

// ─── Process / Path Utilities ──────────────────────────────────────────────

/**
 * Find the absolute path to an executable in PATH.
 * Wrapper around Bun.which() with better typing.
 */
export function findExecutable(name: string): string | null {
  return which(name);
}

/**
 * Check if an executable exists in PATH.
 */
export function hasExecutable(name: string): boolean {
  return which(name) !== null;
}

// ─── Timing Utilities ──────────────────────────────────────────────────────

/**
 * High-resolution timer: nanoseconds since process start.
 * Wrapper around Bun.nanoseconds().
 */
export function hrTime(): number {
  return nanoseconds();
}

/**
 * Measure async function execution time in milliseconds.
 */
export async function measureAsync<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/**
 * Measure sync function execution time in milliseconds.
 */
export function measureSync<T>(label: string, fn: () => T): { result: T; durationMs: number } {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/**
 * Sleep synchronously for N milliseconds.
 * Uses Bun.sleepSync() — blocks the event loop, use sparingly.
 */
export function sleepMs(ms: number): void {
  sleepSync(ms);
}

/**
 * Sleep asynchronously for N milliseconds.
 * Non-blocking, preferred for most cases.
 */
export async function sleepAsync(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Inspection / Serialization ────────────────────────────────────────────

/**
 * Pretty-print an object with optional colors.
 * Wrapper around Bun.inspect() with sensible defaults.
 */
export function prettyPrint(obj: unknown, options?: { colors?: boolean; depth?: number }): string {
  return inspect(obj, {
    colors: options?.colors ?? true,
    depth: options?.depth ?? 3,
    compact: false,
  });
}

/**
 * Format tabular data as a string using Bun.inspect.table().
 */
export function printTable(
  data: Array<Record<string, unknown>>,
  columns?: string[],
  options?: { colors?: boolean }
): string {
  if (columns && columns.length > 0) {
    return inspect.table(data, columns, { colors: options?.colors ?? true });
  }
  return inspect.table(data, { colors: options?.colors ?? true });
}

// ─── Memory Utilities ──────────────────────────────────────────────────────

/**
 * Get current process memory usage in MB.
 */
export function memoryUsage(): { rss: number; heapUsed: number; heapTotal: number; external: number } {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024 * 100) / 100,
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100,
    external: Math.round((usage.external || 0) / 1024 / 1024 * 100) / 100,
  };
}

/**
 * Format memory usage as a readable string.
 */
export function formatMemoryUsage(): string {
  const mem = memoryUsage();
  return `RSS: ${mem.rss}MB | Heap: ${mem.heapUsed}MB / ${mem.heapTotal}MB | External: ${mem.external}MB`;
}

// ─── Environment / Process ─────────────────────────────────────────────────

/**
 * Check if running in production mode.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Check if running in development mode.
 */
export function isDevelopment(): boolean {
  return !isProduction();
}

/**
 * Get Bun version string.
 */
export function bunVersion(): string {
  return process.versions?.bun ?? 'unknown';
}

/**
 * Safe JSON parse with fallback.
 */
export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Safe JSON stringify with circular reference handling.
 */
export function safeJsonStringify(obj: unknown, space?: number): string {
  try {
    return JSON.stringify(obj, null, space);
  } catch {
    return '[unserializable]';
  }
}
