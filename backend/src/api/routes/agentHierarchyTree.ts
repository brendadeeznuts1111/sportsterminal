import { syncAgentProjectionTables } from '../../services/HierarchyBackfillService';
import type { Database } from '../../database';
import { formatAgentNode, type AgentHierarchyRow, type AgentNode } from './agentFormatters';

const HIERARCHY_TREE_CACHE_TTL_MS = 60_000;

let hierarchyTreeCache:
  | {
      json: string;
      gzip: Uint8Array;
      etag: string;
      generatedAt: number;
      responseMeta: {
        agentCount: number;
        rootCount: number;
        maxLastRefreshed: string;
      };
    }
  | null = null;

export function clearAgentHierarchyTreeCache(): void {
  hierarchyTreeCache = null;
}

type AgentTreeNode = AgentNode & { children: AgentTreeNode[] };

export interface AgentHierarchyTree {
  tree: AgentTreeNode[];
  agents: AgentNode[];
  meta: {
    source: 'agent_hierarchy';
    agentCount: number;
    rootCount: number;
    maxLevel: number;
    refreshedAt: string;
  };
}

export async function getAgentHierarchyTree(db: Database, agentId?: string): Promise<AgentHierarchyTree> {
  await syncAgentProjectionTables(db, 'read_through');
  const scopedAgentId = String(agentId || '').trim();
  const rows = await db.all<AgentHierarchyRow>(
    scopedAgentId
      ? `SELECT ah.*
         FROM agent_hierarchy ah
         JOIN agent_closure ac
          ON ac.provider = ah.provider
         AND ac.descendant = ah.agent_id
         JOIN agent_hierarchy root
          ON root.provider = ac.provider
         AND root.agent_id = ac.ancestor
         WHERE ah.provider = 'buckeye'
          AND (root.agent_id = ? OR root.login = ?)
         ORDER BY ac.depth, COALESCE(ah.seq_number, 999999999), COALESCE(ah.level, 99), ah.login`
      : `SELECT *
         FROM agent_hierarchy
         WHERE provider = 'buckeye'
         ORDER BY COALESCE(seq_number, 999999999), COALESCE(level, 99), login`,
    scopedAgentId ? [scopedAgentId, scopedAgentId] : []
  );
  const nodes = rows.map(formatAgentNode);
  const byId = new Map<string, AgentTreeNode>(
    nodes.map((node) => [node.agentId, { ...node, children: [] }])
  );
  const roots: AgentTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentAgentId ? byId.get(node.parentAgentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return {
    tree: roots,
    agents: nodes,
    meta: {
      source: 'agent_hierarchy',
      agentCount: nodes.length,
      rootCount: roots.length,
      maxLevel: nodes.reduce((max, node) => Math.max(max, Number(node.level || 0)), 0),
      refreshedAt: new Date().toISOString(),
    },
  };
}

export async function getCachedAgentHierarchyTree(db: Database): Promise<{
  json: string;
  gzip: Uint8Array;
  etag: string;
  agentCount: number;
  cacheHit: boolean;
}> {
  const now = Date.now();
  if (hierarchyTreeCache && now - hierarchyTreeCache.generatedAt < HIERARCHY_TREE_CACHE_TTL_MS) {
    return {
      json: hierarchyTreeCache.json,
      gzip: hierarchyTreeCache.gzip,
      etag: hierarchyTreeCache.etag,
      agentCount: hierarchyTreeCache.responseMeta.agentCount,
      cacheHit: true,
    };
  }

  const version = await db.get(
    `SELECT
       COUNT(*) AS agentCount,
       MAX(last_refreshed) AS maxLastRefreshed
     FROM agent_hierarchy
     WHERE provider = 'buckeye'`
  );
  const agentCount = Number(version?.agentCount || 0);
  const maxLastRefreshed = String(version?.maxLastRefreshed || '');

  if (
    hierarchyTreeCache
    && hierarchyTreeCache.responseMeta.agentCount === agentCount
    && hierarchyTreeCache.responseMeta.maxLastRefreshed === maxLastRefreshed
  ) {
    hierarchyTreeCache.generatedAt = now;
    return {
      json: hierarchyTreeCache.json,
      gzip: hierarchyTreeCache.gzip,
      etag: hierarchyTreeCache.etag,
      agentCount: hierarchyTreeCache.responseMeta.agentCount,
      cacheHit: true,
    };
  }

  const tree = await getAgentHierarchyTree(db);
  const json = JSON.stringify(tree);
  const gzip = Bun.gzipSync(json);
  hierarchyTreeCache = {
    json,
    gzip,
    etag: `W/"agents-${tree.meta.agentCount}-${tree.meta.rootCount}-${tree.meta.maxLevel}-${gzip.byteLength}"`,
    generatedAt: now,
    responseMeta: {
      agentCount: tree.meta.agentCount,
      rootCount: tree.meta.rootCount,
      maxLastRefreshed,
    },
  };

  return {
    json: hierarchyTreeCache.json,
    gzip: hierarchyTreeCache.gzip,
    etag: hierarchyTreeCache.etag,
    agentCount: hierarchyTreeCache.responseMeta.agentCount,
    cacheHit: false,
  };
}
