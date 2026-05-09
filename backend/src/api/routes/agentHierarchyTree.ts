import { syncAgentProjectionTables } from '../../services/HierarchyBackfillService';
import { formatAgentNode } from './agentFormatters';

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

export async function getAgentHierarchyTree(db: any): Promise<any> {
  await syncAgentProjectionTables(db, 'read_through');
  const rows = await db.all(
    `SELECT *
     FROM agent_hierarchy
     WHERE provider = 'buckeye'
     ORDER BY COALESCE(seq_number, 999999999), COALESCE(level, 99), login`
  );
  const nodes = rows.map(formatAgentNode);
  const byId = new Map(nodes.map((node: any) => [node.agentId, { ...node, children: [] }]));
  const roots: any[] = [];
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
      maxLevel: nodes.reduce((max: number, node: any) => Math.max(max, Number(node.level || 0)), 0),
      refreshedAt: new Date().toISOString(),
    },
  };
}

export async function getCachedAgentHierarchyTree(db: any): Promise<{
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
