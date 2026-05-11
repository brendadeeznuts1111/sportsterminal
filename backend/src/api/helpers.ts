/**
 * Shared API utilities extracted from index.ts
 */

/** Structured API error with HTTP status and machine-readable code. */
export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code || defaultErrorCode(status, message);
  }
}

/**
 * Clamp a string value to an integer within [min, max].
 * @param value - The string to parse
 * @param fallback - Value returned when input is null/empty/unparseable
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value
 */
export function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Parse a required ID from a string path parameter.
 * @param value - The string to parse
 * @param label - Human-readable name for error messages (default: 'id')
 * @throws ApiError(400) if the value is not a positive integer
 */
export function parseRequiredId(value: string | undefined, label = 'id'): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, `Invalid ${label}`);
  }
  return parsed;
}

/**
 * Safely read and parse JSON from a Request body.
 * @throws ApiError(400) if the body is not valid JSON
 */
export async function readJsonBody<T = Record<string, never>>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new ApiError(400, 'Malformed JSON body');
  }
}

/**
 * Enforce admin token if ADMIN_API_TOKEN is configured.
 * @returns null when access is allowed, or a 403 Response when denied
 */
export function requireAdminTokenIfConfigured(request: Request): Response | null {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) return null;
  const provided = request.headers.get('x-admin-token')
    || bearerToken(request.headers.get('authorization'));
  if (provided === expected) return null;
  return new Response(
    JSON.stringify({ error: 'Admin token required', code: 'ADMIN_TOKEN_REQUIRED' }),
    { status: 403, headers: corsHeaders }
  );
}

export interface ParsedLocalAgentExport {
  agents: LocalAgentExportRow[];
  players: Array<{
    customerId: string;
    login: string;
    displayName: string;
    agentLogin: string;
    seqNumber?: number;
  }>;
  meta: {
    source: string;
    agentCount: number;
    playerCount: number;
    linkedPlayerAgents: number;
    hasExplicitParentIds: boolean;
    hasPlayerPasswords: boolean;
  };
}

type LocalAgentExportRow = Record<string, unknown>;
type BuckeyeLocalExport = {
  GENERAL?: LocalAgentExportRow[];
  PLAYERS?: LocalAgentExportRow[];
};

/**
 * Load and parse local Buckeye agent export files (docs/agentobject.md or docs/agentslistharz.md).
 * Enriches agents with player counts and computed parent/child relationships.
 */
export async function parseAgentHierarchyAndPlayers(): Promise<ParsedLocalAgentExport> {
  const agentCandidates = ['docs/agentobject.md', '../docs/agentobject.md'];
  const combinedCandidates = ['docs/agentslistharz.md', '../docs/agentslistharz.md'];

  const combined = await loadLocalAgentExport(combinedCandidates);
  for (const path of agentCandidates) {
    try {
      const file = Bun.file(path);
      if ((await file.size) === 0) continue;
      const text = await file.text();
      const parsed = parseLocalJsonPrefix(text) as BuckeyeLocalExport | LocalAgentExportRow[];
      const agents = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.GENERAL) ? parsed.GENERAL : [];
      if (agents.length > 0) {
        return buildParsedLocalAgentExport(agents, combined.players, 'docs/agentobject.md');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.debug(`[Helpers] Failed to load agent export from ${path}: ${msg}`);
    }
  }

  if (combined.agents.length > 0) {
    return buildParsedLocalAgentExport(combined.agents, combined.players, 'docs/agentslistharz.md');
  }

  return {
    agents: [],
    players: [],
    meta: {
      source: 'none',
      agentCount: 0,
      playerCount: 0,
      linkedPlayerAgents: 0,
      hasExplicitParentIds: false,
      hasPlayerPasswords: false,
    },
  };
}

/**
 * Convenience wrapper that returns only the agent GENERAL array + meta.
 */
export async function loadLocalAgentHierarchy(): Promise<{
  GENERAL: LocalAgentExportRow[];
  meta: ParsedLocalAgentExport['meta'];
  source: string;
}> {
  const parsed = await parseAgentHierarchyAndPlayers();
  return {
    GENERAL: parsed.agents,
    meta: parsed.meta,
    source: parsed.meta.source,
  };
}

async function loadLocalAgentExport(
  candidates: string[]
): Promise<{ agents: LocalAgentExportRow[]; players: LocalAgentExportRow[] }> {
  for (const path of candidates) {
    try {
      const file = Bun.file(path);
      if ((await file.size) === 0) continue;
      const parsed = parseLocalJsonPrefix(await file.text()) as BuckeyeLocalExport | LocalAgentExportRow[];
      const exportObject = Array.isArray(parsed) ? null : parsed;
      return {
        agents: Array.isArray(exportObject?.GENERAL) ? exportObject.GENERAL : Array.isArray(parsed) ? parsed : [],
        players: Array.isArray(exportObject?.PLAYERS) ? exportObject.PLAYERS : [],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.debug(`[Helpers] Failed to load local export from ${path}: ${msg}`);
    }
  }
  return { agents: [], players: [] };
}

function parseLocalJsonPrefix(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const harBoundary = text.indexOf('}{\r\n  "log"');
    if (harBoundary > 0) {
      return JSON.parse(text.slice(0, harBoundary + 1));
    }
    throw new Error('Unable to parse local agent export');
  }
}

function buildParsedLocalAgentExport(
  agents: LocalAgentExportRow[],
  players: LocalAgentExportRow[],
  source: string
): ParsedLocalAgentExport {
  const playerCounts = new Map<string, number>();
  const sanitizedPlayers = [];
  for (const player of players) {
    const agent = String(player?.Agent || '').trim();
    const login = String(player?.Login || player?.customerID || '').trim();
    if (login) {
      sanitizedPlayers.push({
        customerId: String(player?.customerID || login).trim(),
        login,
        displayName: String(player?.NameFirst || '').trim(),
        agentLogin: agent,
        seqNumber: Number(player?.SeqNumber) || undefined,
      });
    }
    if (!agent) continue;
    playerCounts.set(agent, (playerCounts.get(agent) || 0) + 1);
  }

  const sortedAgents = [...agents].sort((a, b) => {
    return (Number(a?.SeqNumber) || 0) - (Number(b?.SeqNumber) || 0);
  });
  const stack: Array<{ level: number; agentId: string }> = [];
  const childCounts = new Map<string, number>();

  const enriched = sortedAgents.map((agent) => {
    const login = String(agent?.Login || agent?.AgentID || '').trim();
    const agentId = String(agent?.AgentID || login).trim();
    const level = Number(agent?.Level) || 1;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    const parentAgentId = stack[stack.length - 1]?.agentId || '';
    if (parentAgentId) {
      childCounts.set(parentAgentId, (childCounts.get(parentAgentId) || 0) + 1);
    }
    stack.push({ level, agentId });

    return {
      ...agent,
      AgentID: agentId,
      Login: login,
      ParentAgentID: parentAgentId,
      PlayerCount: playerCounts.get(login) || 0,
    };
  });

  const enrichedWithCounts = enriched.map((agent) => ({
      ...agent,
      ChildCount: childCounts.get(agent.AgentID) || 0,
  }));

  return {
    agents: enrichedWithCounts,
    players: sanitizedPlayers,
    meta: {
      source,
      agentCount: enrichedWithCounts.length,
      playerCount: sanitizedPlayers.length,
      linkedPlayerAgents: playerCounts.size,
      hasExplicitParentIds: true,
      hasPlayerPasswords: false,
    },
  };
}

/**
 * Wrap an async handler so it always returns a Response.
 * Success → JSON 200. ApiError → matching status + code. Other errors → 500.
 */
export function handleAsync(
  handler: () => Promise<unknown>,
  headers: Record<string, string>
): Promise<Response> {
  return handler()
    .then((data) => new Response(JSON.stringify(data), { headers }))
    .catch((error) => {
      console.error('API error:', error);
      const status = error instanceof ApiError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'Unknown error';
      const code = error instanceof ApiError ? error.code : defaultErrorCode(status, message);
      return new Response(
        JSON.stringify({ error: message, code }),
        { status, headers }
      );
    });
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-API-Key',
  'Content-Type': 'application/json',
};

export const corsHeaders = CORS_HEADERS;

function bearerToken(value: string | null): string | null {
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim();
}

function defaultErrorCode(status: number, message: string): string {
  const text = message.toLowerCase();
  if (text.includes('malformed json')) return 'MALFORMED_JSON';
  if (text.includes('admin token')) return 'ADMIN_TOKEN_REQUIRED';
  if (text.includes('login failed')) return 'BUCKEYE_AUTH_FAILED';
  if (text.includes('not authenticated')) return 'BUCKEYE_NOT_AUTHENTICATED';
  if (text.includes('customerid required')) return 'CUSTOMER_ID_REQUIRED';
  if (text.includes('agentid') && text.includes('required')) return 'AGENT_ID_REQUIRED';
  if (text.includes('playerid') && text.includes('required')) return 'PLAYER_ID_REQUIRED';
  if (text.includes('required')) return 'MISSING_REQUIRED_FIELD';
  if (text.includes('invalid')) return 'INVALID_REQUEST';
  if (text.includes('unknown operation')) return 'UNKNOWN_PROXY_OPERATION';
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMIT_EXCEEDED';
  return 'INTERNAL_ERROR';
}
