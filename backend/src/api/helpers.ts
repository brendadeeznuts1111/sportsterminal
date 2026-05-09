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

export interface ParsedLocalAgentExport {
  agents: any[];
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

export async function parseAgentHierarchyAndPlayers(): Promise<ParsedLocalAgentExport> {
  const agentCandidates = ['docs/agentobject.md', '../docs/agentobject.md'];
  const combinedCandidates = ['docs/agentslistharz.md', '../docs/agentslistharz.md'];

  const combined = await loadLocalAgentExport(combinedCandidates);
  for (const path of agentCandidates) {
    try {
      const file = Bun.file(path);
      if ((await file.size) === 0) continue;
      const text = await file.text();
      const parsed = parseLocalJsonPrefix(text);
      const agents = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.GENERAL) ? parsed.GENERAL : [];
      if (agents.length > 0) {
        return buildParsedLocalAgentExport(agents, combined.players, 'docs/agentobject.md');
      }
    } catch {
      // Try the next relative path.
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

export async function loadLocalAgentHierarchy(): Promise<any> {
  const parsed = await parseAgentHierarchyAndPlayers();
  return {
    GENERAL: parsed.agents,
    meta: parsed.meta,
    source: parsed.meta.source,
  };
}

async function loadLocalAgentExport(candidates: string[]): Promise<{ agents: any[]; players: any[] }> {
  for (const path of candidates) {
    try {
      const file = Bun.file(path);
      if ((await file.size) === 0) continue;
      const parsed = parseLocalJsonPrefix(await file.text());
      return {
        agents: Array.isArray(parsed?.GENERAL) ? parsed.GENERAL : Array.isArray(parsed) ? parsed : [],
        players: Array.isArray(parsed?.PLAYERS) ? parsed.PLAYERS : [],
      };
    } catch {
      // Try the next relative path.
    }
  }
  return { agents: [], players: [] };
}

function parseLocalJsonPrefix(text: string): any {
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

function buildParsedLocalAgentExport(agents: any[], players: any[], source: string): ParsedLocalAgentExport {
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

  const sortedAgents = [...agents].sort((a: any, b: any) => {
    return (Number(a?.SeqNumber) || 0) - (Number(b?.SeqNumber) || 0);
  });
  const stack: Array<{ level: number; agentId: string }> = [];
  const childCounts = new Map<string, number>();

  const enriched = sortedAgents.map((agent: any) => {
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
