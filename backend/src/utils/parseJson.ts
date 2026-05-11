/**
 * Safe JSON parsing utilities to replace repetitive try/catch blocks.
 */

/**
 * Parse JSON text safely with a fallback value.
 * Replaces: try { return JSON.parse(text); } catch { return fallback; }
 */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Parse JSON text safely, returning null on failure.
 */
export function parseJsonOrNull<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Parse JSON text safely, returning the original string on failure.
 * Useful when the input may already be an object or a raw string.
 */
export function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
