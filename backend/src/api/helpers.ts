/**
 * Shared API utilities extracted from index.ts
 */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function parseRequiredId(value: string | undefined): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, 'Invalid webhook id');
  }
  return parsed;
}

export async function readJsonBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, 'Malformed JSON body');
  }
}

export async function loadLocalAgentHierarchy(): Promise<any> {
  const candidates = ['docs/agentobject.md', '../docs/agentobject.md'];
  for (const path of candidates) {
    try {
      const file = Bun.file(path);
      if ((await file.size) === 0) continue;
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return { GENERAL: parsed, source: 'docs/agentobject.md' };
      }
      if (Array.isArray(parsed?.GENERAL)) {
        return { ...parsed, source: 'docs/agentobject.md' };
      }
    } catch {
      // Try the next relative path.
    }
  }
  return { GENERAL: [], source: 'none' };
}

export function handleAsync(
  handler: () => Promise<any>,
  headers: Record<string, string>
): Promise<Response> {
  return handler()
    .then((data) => new Response(JSON.stringify(data), { headers }))
    .catch((error) => {
      console.error('API error:', error);
      const status = error instanceof ApiError ? error.status : 500;
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
        { status, headers }
      );
    });
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export const corsHeaders = CORS_HEADERS;
