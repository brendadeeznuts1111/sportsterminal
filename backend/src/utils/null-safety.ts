/**
 * Null-safe utility functions to replace verbose null checks
 */

export function hasChanged<T>(prev: T | null | undefined, curr: T | null | undefined): boolean {
  if (prev === null || prev === undefined || curr === null || curr === undefined) return false;
  return prev !== curr;
}

export function firstOf<T>(...values: (T | null | undefined)[]): T | null {
  for (const val of values) {
    if (val !== null && val !== undefined) return val as T;
  }
  return null;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return isNaN(n) ? fallback : n;
}

export function centsTodollars(cents: number | null | undefined, fallback = 0): number {
  const n = asNumber(cents);
  return n / 100 || fallback;
}

export function differs<T>(a: T | null | undefined, b: T | null | undefined): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return false;
  if ((a === null || a === undefined) || (b === null || b === undefined)) return true;
  return a !== b;
}

export function safeString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  return fallback;
}

export function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

export function isFlagSet(flag: unknown): boolean {
  return flag === 'Y' || flag === true || flag === 1;
}

export function getDeep<T = unknown>(obj: unknown, path: string[], fallback: T | null = null): T | null {
  let current = obj;
  for (const key of path) {
    if (current === null || current === undefined) return fallback;
    current = (current as Record<string, unknown>)[key];
  }
  return (current ?? fallback) as T;
}
