import type { Database } from '../database';
import { parseAgentHierarchyAndPlayers, type ParseAgentHierarchyOptions } from '../api/helpers';

export interface HierarchyBackfillResult {
  success: boolean;
  provider: string;
  agents: number;
  players: number;
  linkedPlayers: number;
  placeholderAgents: number;
  skippedPlayers: number;
  maxSeqNumber: number;
  invalidAgents?: number;
  topAgentsByPlayers?: Array<{ agent_login: string; player_count: number }>;
}

export interface HierarchyBackfillOptions extends ParseAgentHierarchyOptions {
  source?: string;
}

const PROVIDER = 'buckeye';

interface AgentHierarchySourceRow {
  AgentID?: unknown;
  Login?: unknown;
  ParentAgentID?: unknown;
  SeqNumber?: unknown;
  Level?: unknown;
  AgentType?: unknown;
  ChildCount?: unknown;
  PlayerCount?: unknown;
  HeadCountRateM?: unknown;
  InetHeadCountRateM?: unknown;
  CasinoHeadCountRateM?: unknown;
  LiveBettingRateM?: unknown;
  LiveBetting2RateM?: unknown;
  LiveCasinoRateM?: unknown;
  PropBuilderRateM?: unknown;
  FlashBetsRate?: unknown;
  ExtPropsRate?: unknown;
  CrashRate?: unknown;
  FantasyRate?: unknown;
  AmigoTechRate?: unknown;
}

interface LiveHierarchyPayload {
  GENERAL?: AgentHierarchySourceRow[];
  PLAYERS?: LivePlayerSourceRow[];
}

interface LivePlayerSourceRow {
  Login?: unknown;
  customerID?: unknown;
  Agent?: unknown;
  NameFirst?: unknown;
  SeqNumber?: unknown;
}

export async function backfillAgentsAndPlayers(
  db: Database,
  options: HierarchyBackfillOptions = {}
): Promise<HierarchyBackfillResult> {
  const parsed = await parseAgentHierarchyAndPlayers(options);
  let agents = parsed.agents;
  const players = parsed.players;

  // ─── Validation ─────────────────────────────────────────────────────────
  const validAgents: typeof agents = [];
  let invalidAgents = 0;
  for (const agent of agents) {
    const login = String(agent.Login || '').trim();
    const agentId = String(agent.AgentID || '').trim();
    if (!login || !agentId) {
      invalidAgents++;
      console.warn(`[HierarchyBackfill] Skipping invalid agent row: missing Login=${login} or AgentID=${agentId}`);
      continue;
    }
    validAgents.push(agent);
  }
  agents = validAgents;

  const agentLoginToId = new Map<string, string>();
  const agentIds = new Set<string>();
  for (const agent of [...agents].sort((a, b) => (Number(a?.SeqNumber) || 0) - (Number(b?.SeqNumber) || 0))) {
    const login = String(agent.Login || agent.AgentID || '').trim();
    const agentId = String(agent.AgentID || login).trim();
    if (agentId) {
      agentIds.add(agentId);
    }
    if (login && agentId && !agentLoginToId.has(login)) {
      agentLoginToId.set(login, agentId);
    }
  }

  await db.run('BEGIN');
  try {
    await replaceCurrentAgentIdTempTable(db, agentIds);
    await removePlaceholderAgents(db);

    // ─── Insert Agents ──────────────────────────────────────────────────────
    let agentIdx = 0;
    for (const agent of agents) {
      const login = String(agent.Login || agent.AgentID || '').trim();
      const agentId = String(agent.AgentID || login).trim();
      if (!agentId) continue;
      await upsertAgent(db, agent, agentId, login || agentId);
      agentIdx++;
      if (agentIdx % 500 === 0) {
        console.log(`[HierarchyBackfill] Inserted ${agentIdx}/${agents.length} agents...`);
      }
    }

    for (const agent of agents) {
      const login = String(agent.Login || agent.AgentID || '').trim();
      const agentId = String(agent.AgentID || login).trim();
      const parentAgentId = String(agent.ParentAgentID || '').trim();
      if (!agentId) continue;
      await db.run(
        `UPDATE agents
         SET parent_agent_id = ?, last_updated = CURRENT_TIMESTAMP
         WHERE provider = ? AND id = ?`,
        [parentAgentId || null, PROVIDER, agentId]
      );
    }

    // ─── Insert Players ─────────────────────────────────────────────────────
    let linkedPlayers = 0;
    let skippedPlayers = 0;
    let playerIdx = 0;
    for (const player of players) {
      if (!player.login) {
        skippedPlayers++;
        continue;
      }
      const agentId = agentLoginToId.get(player.agentLogin || '') || '';
      if (!agentId) {
        skippedPlayers++;
        continue;
      }
      linkedPlayers++;
      await db.run(
        `INSERT INTO players
          (id, provider, login, display_name, name, agent_login, agent_id, seq_number, last_seen, raw_json, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          login = excluded.login,
          display_name = excluded.display_name,
          name = excluded.name,
          agent_login = excluded.agent_login,
          agent_id = excluded.agent_id,
          seq_number = excluded.seq_number,
          last_seen = excluded.last_seen,
          raw_json = excluded.raw_json,
          last_updated = CURRENT_TIMESTAMP`,
        [
          player.login,
          PROVIDER,
          player.login,
          player.displayName,
          player.displayName || player.login,
          player.agentLogin,
          agentId,
          numberOrNull(player.seqNumber),
          JSON.stringify({
            customerId: player.customerId,
            login: player.login,
            agentLogin: player.agentLogin,
            seqNumber: player.seqNumber,
          }),
        ]
      );
      playerIdx++;
      if (playerIdx % 5000 === 0) {
        console.log(`[HierarchyBackfill] Inserted ${playerIdx}/${players.length} players...`);
      }
    }

    await removeAgentsOutsideCurrentSet(db);

    // ─── Checkpoints & Freshness ────────────────────────────────────────────
    const maxSeqNumber = agents.reduce((max, agent) => Math.max(max, Number(agent.SeqNumber) || 0), 0);
    await upsertCheckpoint(db, 'hierarchy', maxSeqNumber, {
      source: parsed.meta.source,
      agentCount: agents.length,
      playerCount: players.length,
      linkedPlayerAgents: parsed.meta.linkedPlayerAgents,
      placeholderAgents: 0,
      skippedPlayers,
    });
    const maxPlayerSeq = players.reduce((max, player) => Math.max(max, Number(player.seqNumber) || 0), 0);
    await upsertCheckpoint(db, 'players', maxPlayerSeq || 0, {
      source: parsed.meta.source,
      playerCount: players.length,
      linkedPlayerAgents: parsed.meta.linkedPlayerAgents,
      skippedPlayers,
      hasSeqNumbers: maxPlayerSeq > 0,
    });

    // Source freshness watermark
    const checksum = `${agents.length}:${players.length}:${linkedPlayers}`;
    await db.run(
      `INSERT INTO source_freshness (source, last_pull, row_count, checksum, metadata)
       VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
        last_pull = excluded.last_pull,
        row_count = excluded.row_count,
        checksum = excluded.checksum,
        metadata = excluded.metadata`,
      ['hierarchy_backfill', agents.length + players.length, checksum, JSON.stringify({ agentCount: agents.length, playerCount: players.length, linkedPlayers })]
    );

    await syncAgentProjectionTables(db, options.source || 'hierarchy_backfill');
    await rebuildAgentClosure(db);

    // ─── Per-Agent Player Count Summary ─────────────────────────────────────
    const topAgents = await db.all<{ agent_login: string; player_count: number }>(
      `SELECT agent_login, COUNT(*) AS player_count
       FROM players
       WHERE provider = ?
       GROUP BY agent_login
       ORDER BY player_count DESC
       LIMIT 10`,
      [PROVIDER]
    );

    await db.run('COMMIT');
    console.log(`[HierarchyBackfill] Top agents by player count:`);
    for (const a of topAgents) {
      console.log(`  ${a.agent_login}: ${a.player_count} players`);
    }

    return {
      success: true,
      provider: PROVIDER,
      agents: agents.length,
      players: players.length,
      linkedPlayers,
      placeholderAgents: 0,
      skippedPlayers,
      maxSeqNumber,
      invalidAgents,
      topAgentsByPlayers: topAgents,
    };
  } catch (error) {
    await db.run('ROLLBACK').catch(() => ({ lastID: 0, changes: 0 }));
    throw error;
  }
}

export async function upsertLiveAgentHierarchy(
  db: Database,
  payload: LiveHierarchyPayload,
  source = 'buckeye_api'
): Promise<HierarchyBackfillResult> {
  const rawAgents = Array.isArray(payload?.GENERAL) ? payload.GENERAL : [];
  const rawPlayers = Array.isArray(payload?.PLAYERS) ? payload.PLAYERS : [];

  // ─── Validation ─────────────────────────────────────────────────────────
  const validRawAgents: typeof rawAgents = [];
  let invalidAgents = 0;
  for (const agent of rawAgents) {
    const login = String(agent.Login || '').trim();
    const agentId = String(agent.AgentID || '').trim();
    if (!login || !agentId) {
      invalidAgents++;
      console.warn(`[HierarchyBackfill] Skipping invalid live agent row: missing Login=${login} or AgentID=${agentId}`);
      continue;
    }
    validRawAgents.push(agent);
  }

  const agents = deriveAgentParentLinks(validRawAgents);
  const players = rawPlayers;
  const agentLoginToId = new Map<string, string>();
  const agentIds = new Set<string>();
  for (const agent of agents) {
    const login = String(agent.Login || agent.AgentID || '').trim();
    const agentId = String(agent.AgentID || login).trim();
    if (!agentId) continue;
    agentIds.add(agentId);
    if (login) agentLoginToId.set(login, agentId);
  }

  await db.run('BEGIN');
  try {
    if (agentIds.size > 0) {
      await replaceCurrentAgentIdTempTable(db, agentIds);
      await removePlaceholderAgents(db);
    }

    let agentIdx = 0;
    for (const agent of agents) {
      const login = String(agent.Login || agent.AgentID || '').trim();
      const agentId = String(agent.AgentID || login).trim();
      if (!agentId) continue;
      await upsertAgent(db, agent, agentId, login || agentId);
      agentIdx++;
      if (agentIdx % 500 === 0) {
        console.log(`[HierarchyBackfill] Upserted ${agentIdx}/${agents.length} live agents...`);
      }
    }

    let linkedPlayers = 0;
    let skippedPlayers = 0;
    let playerIdx = 0;
    for (const player of players) {
      const login = String(player?.Login || player?.customerID || '').trim();
      const agentLogin = String(player?.Agent || '').trim();
      const agentId = agentLoginToId.get(agentLogin) || '';
      if (!login || !agentId) {
        if (login) skippedPlayers++;
        continue;
      }
      linkedPlayers++;
      await db.run(
        `INSERT INTO players
          (id, provider, login, display_name, name, agent_login, agent_id, seq_number, last_seen, raw_json, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          login = excluded.login,
          display_name = excluded.display_name,
          name = excluded.name,
          agent_login = excluded.agent_login,
          agent_id = excluded.agent_id,
          seq_number = excluded.seq_number,
          last_seen = excluded.last_seen,
          raw_json = excluded.raw_json,
          last_updated = CURRENT_TIMESTAMP`,
        [
          login,
          PROVIDER,
          login,
          String(player?.NameFirst || '').trim() || login,
          String(player?.NameFirst || '').trim() || login,
          agentLogin,
          agentId,
          numberOrNull(player?.SeqNumber),
          JSON.stringify({
            customerId: String(player?.customerID || login).trim(),
            login,
            agentLogin,
            seqNumber: player?.SeqNumber,
          }),
        ]
      );
      playerIdx++;
      if (playerIdx % 5000 === 0) {
        console.log(`[HierarchyBackfill] Upserted ${playerIdx}/${players.length} live players...`);
      }
    }

    await syncAgentProjectionTables(db, source);
    await rebuildAgentClosure(db);

    // Source freshness watermark
    const checksum = `${agents.length}:${players.length}:${linkedPlayers}`;
    await db.run(
      `INSERT INTO source_freshness (source, last_pull, row_count, checksum, metadata)
       VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
        last_pull = excluded.last_pull,
        row_count = excluded.row_count,
        checksum = excluded.checksum,
        metadata = excluded.metadata`,
      [source, agents.length + players.length, checksum, JSON.stringify({ agentCount: agents.length, playerCount: players.length, linkedPlayers })]
    );

    const maxSeqNumber = agents.reduce((max, agent) => Math.max(max, Number(agent.SeqNumber) || 0), 0);
    await upsertCheckpoint(db, 'hierarchy', maxSeqNumber, {
      source,
      agentCount: agents.length,
      playerCount: players.length,
      skippedPlayers,
    });

    // Per-agent summary
    const topAgents = await db.all<{ agent_login: string; player_count: number }>(
      `SELECT agent_login, COUNT(*) AS player_count
       FROM players
       WHERE provider = ?
       GROUP BY agent_login
       ORDER BY player_count DESC
       LIMIT 10`,
      [PROVIDER]
    );

    await db.run('COMMIT');
    console.log(`[HierarchyBackfill] Live ingest complete. Top agents by player count:`);
    for (const a of topAgents) {
      console.log(`  ${a.agent_login}: ${a.player_count} players`);
    }

    return {
      success: true,
      provider: PROVIDER,
      agents: agents.length,
      players: players.length,
      linkedPlayers,
      placeholderAgents: 0,
      skippedPlayers,
      maxSeqNumber,
      invalidAgents,
      topAgentsByPlayers: topAgents,
    };
  } catch (error) {
    await db.run('ROLLBACK').catch(() => ({ lastID: 0, changes: 0 }));
    throw error;
  }
}

function deriveAgentParentLinks(rawAgents: AgentHierarchySourceRow[]): AgentHierarchySourceRow[] {
  const sorted = [...rawAgents].sort((a, b) => (Number(a?.SeqNumber) || 0) - (Number(b?.SeqNumber) || 0));
  const stack: Array<{ level: number; agentId: string }> = [];
  const childCounts = new Map<string, number>();
  const enriched = sorted.map((agent) => {
    const login = String(agent?.Login || agent?.AgentID || '').trim();
    const agentId = String(agent?.AgentID || login).trim();
    const level = Number(agent?.Level) || 1;
    let parentAgentId = String(agent?.ParentAgentID || '').trim();
    if (!parentAgentId) {
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      parentAgentId = stack[stack.length - 1]?.agentId || '';
    }
    if (parentAgentId) childCounts.set(parentAgentId, (childCounts.get(parentAgentId) || 0) + 1);
    if (agentId) stack.push({ level, agentId });
    return {
      ...agent,
      AgentID: agentId,
      Login: login || agentId,
      ParentAgentID: parentAgentId,
    };
  });
  return enriched.map((agent) => ({
    ...agent,
    ChildCount: Number(agent.ChildCount) || childCounts.get(agent.AgentID) || 0,
  }));
}

export async function syncAgentProjectionTables(db: Database, source = 'hierarchy_backfill'): Promise<void> {
  await db.run(
    `INSERT INTO agent_hierarchy
      (agent_id, provider, login, display_name, parent_agent_id, level, agent_type, seq_number,
       child_count, player_count, head_count_rate_m, inet_head_count_rate_m, casino_head_count_rate_m,
       live_betting_rate_m, live_betting2_rate_m, live_casino_rate_m, prop_builder_rate_m,
       flash_bets_rate, ext_props_rate, crash_rate, fantasy_rate, amigo_tech_rate, raw_json, last_refreshed)
     SELECT
      id, provider, COALESCE(login, id), display_name, parent_agent_id, level, agent_type, seq_number,
      child_count, player_count, head_count_rate_m, inet_head_count_rate_m, casino_head_count_rate_m,
      live_betting_rate_m, live_betting2_rate_m, live_casino_rate_m, prop_builder_rate_m,
      flash_bets_rate, ext_props_rate, crash_rate, fantasy_rate, amigo_tech_rate, raw_json, CURRENT_TIMESTAMP
     FROM agents
     WHERE provider = ?
      AND COALESCE(raw_json, '') NOT LIKE '%placeholder%'
     ON CONFLICT(agent_id) DO UPDATE SET
      provider = excluded.provider,
      login = excluded.login,
      display_name = excluded.display_name,
      parent_agent_id = excluded.parent_agent_id,
      level = excluded.level,
      agent_type = excluded.agent_type,
      seq_number = excluded.seq_number,
      child_count = excluded.child_count,
      player_count = excluded.player_count,
      head_count_rate_m = excluded.head_count_rate_m,
      inet_head_count_rate_m = excluded.inet_head_count_rate_m,
      casino_head_count_rate_m = excluded.casino_head_count_rate_m,
      live_betting_rate_m = excluded.live_betting_rate_m,
      live_betting2_rate_m = excluded.live_betting2_rate_m,
      live_casino_rate_m = excluded.live_casino_rate_m,
      prop_builder_rate_m = excluded.prop_builder_rate_m,
      flash_bets_rate = excluded.flash_bets_rate,
      ext_props_rate = excluded.ext_props_rate,
      crash_rate = excluded.crash_rate,
      fantasy_rate = excluded.fantasy_rate,
      amigo_tech_rate = excluded.amigo_tech_rate,
      raw_json = excluded.raw_json,
      last_refreshed = CURRENT_TIMESTAMP`,
    [PROVIDER]
  );

  await db.run(
    `INSERT INTO player_agent_map
      (player_id, provider, player_login, agent_id, agent_login, source, linked_accounts_json, last_refreshed)
     SELECT
      p.id, p.provider, COALESCE(p.login, p.id), p.agent_id, COALESCE(a.login, p.agent_login, p.agent_id), ?, p.raw_json, CURRENT_TIMESTAMP
     FROM players p
     LEFT JOIN agents a ON a.provider = p.provider AND a.id = p.agent_id
     WHERE p.provider = ?
      AND p.agent_id <> ''
     ON CONFLICT(provider, player_id) DO UPDATE SET
      player_login = excluded.player_login,
      agent_id = excluded.agent_id,
      agent_login = excluded.agent_login,
      source = excluded.source,
      linked_accounts_json = excluded.linked_accounts_json,
      last_refreshed = CURRENT_TIMESTAMP`,
    [source, PROVIDER]
  );
}

export async function rebuildAgentClosure(db: Database): Promise<void> {
  await db.run('DELETE FROM agent_closure WHERE provider = ?', [PROVIDER]);
  await db.run(
    `INSERT OR IGNORE INTO agent_closure (provider, ancestor, descendant, depth)
     WITH RECURSIVE closure(provider, ancestor, descendant, depth) AS (
       SELECT provider, agent_id, agent_id, 0
       FROM agent_hierarchy
       WHERE provider = ?

       UNION ALL

       SELECT c.provider, c.ancestor, child.agent_id, c.depth + 1
       FROM closure c
       JOIN agent_hierarchy child
        ON child.provider = c.provider
       AND child.parent_agent_id = c.descendant
       WHERE c.depth < 64
     )
     SELECT provider, ancestor, descendant, depth
     FROM closure`,
    [PROVIDER]
  );
}

async function replaceCurrentAgentIdTempTable(db: Database, agentIds: Set<string>): Promise<void> {
  await db.exec('DROP TABLE IF EXISTS temp_current_buckeye_agent_ids');
  await db.exec('CREATE TEMP TABLE temp_current_buckeye_agent_ids (id TEXT PRIMARY KEY)');
  for (const agentId of agentIds) {
    await db.run('INSERT INTO temp_current_buckeye_agent_ids (id) VALUES (?)', [agentId]);
  }
}

async function upsertAgent(db: Database, agent: AgentHierarchySourceRow, agentId: string, login: string): Promise<void> {
  await db.run(
    `INSERT INTO agents
      (id, provider, login, display_name, name, parent_agent_id, level, tier, child_count, player_count,
       seq_number, agent_type, head_count_rate_m, inet_head_count_rate_m, casino_head_count_rate_m,
       live_betting_rate_m, live_betting2_rate_m, live_casino_rate_m, prop_builder_rate_m,
       flash_bets_rate, ext_props_rate, crash_rate, fantasy_rate, amigo_tech_rate, raw_json, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      login = excluded.login,
      display_name = excluded.display_name,
      name = excluded.name,
      parent_agent_id = excluded.parent_agent_id,
      level = excluded.level,
      tier = excluded.tier,
      child_count = excluded.child_count,
      player_count = excluded.player_count,
      seq_number = excluded.seq_number,
      agent_type = excluded.agent_type,
      head_count_rate_m = excluded.head_count_rate_m,
      inet_head_count_rate_m = excluded.inet_head_count_rate_m,
      casino_head_count_rate_m = excluded.casino_head_count_rate_m,
      live_betting_rate_m = excluded.live_betting_rate_m,
      live_betting2_rate_m = excluded.live_betting2_rate_m,
      live_casino_rate_m = excluded.live_casino_rate_m,
      prop_builder_rate_m = excluded.prop_builder_rate_m,
      flash_bets_rate = excluded.flash_bets_rate,
      ext_props_rate = excluded.ext_props_rate,
      crash_rate = excluded.crash_rate,
      fantasy_rate = excluded.fantasy_rate,
      amigo_tech_rate = excluded.amigo_tech_rate,
      raw_json = excluded.raw_json,
      last_updated = CURRENT_TIMESTAMP`,
    [
      agentId,
      PROVIDER,
      login,
      login,
      login,
      String(agent.ParentAgentID || '').trim() || null,
      numberOrNull(agent.Level),
      numberOrNull(agent.Level),
      Number(agent.ChildCount) || 0,
      Number(agent.PlayerCount) || 0,
      numberOrNull(agent.SeqNumber),
      String(agent.AgentType || '').trim(),
      numberOrNull(agent.HeadCountRateM),
      numberOrNull(agent.InetHeadCountRateM),
      numberOrNull(agent.CasinoHeadCountRateM),
      numberOrNull(agent.LiveBettingRateM),
      numberOrNull(agent.LiveBetting2RateM),
      numberOrNull(agent.LiveCasinoRateM),
      numberOrNull(agent.PropBuilderRateM),
      numberOrNull(agent.FlashBetsRate),
      numberOrNull(agent.ExtPropsRate),
      numberOrNull(agent.CrashRate),
      numberOrNull(agent.FantasyRate),
      numberOrNull(agent.AmigoTechRate),
      JSON.stringify(normalizeRawAgent(agent, agentId, login)),
    ]
  );
}

async function removePlaceholderAgents(db: Database): Promise<void> {
  await db.run(
    `DELETE FROM players
     WHERE provider = ?
       AND agent_login IN (
        SELECT login FROM agents
        WHERE provider = ?
          AND raw_json LIKE '%placeholder%'
       )`,
    [PROVIDER, PROVIDER]
  );

  await db.run(
    `DELETE FROM agents
     WHERE provider = ?
       AND raw_json LIKE '%placeholder%'`,
    [PROVIDER]
  );
}

async function removeAgentsOutsideCurrentSet(db: Database): Promise<void> {
  await db.run(
    `DELETE FROM players
     WHERE provider = ?
       AND agent_id NOT IN (SELECT id FROM temp_current_buckeye_agent_ids)`,
    [PROVIDER]
  );

  await db.run(
    `DELETE FROM agents
     WHERE provider = ?
       AND id NOT IN (SELECT id FROM temp_current_buckeye_agent_ids)`,
    [PROVIDER]
  );
}

function normalizeRawAgent(agent: AgentHierarchySourceRow, agentId: string, login: string): Record<string, unknown> {
  return {
    AgentID: agentId,
    SeqNumber: agent.SeqNumber,
    Level: agent.Level,
    AgentType: agent.AgentType,
    Login: login,
    ParentAgentID: String(agent.ParentAgentID || '').trim(),
    ChildCount: Number(agent.ChildCount) || 0,
    PlayerCount: Number(agent.PlayerCount) || 0,
    HeadCountRateM: numberOrNull(agent.HeadCountRateM) || 0,
    InetHeadCountRateM: numberOrNull(agent.InetHeadCountRateM) || 0,
    CasinoHeadCountRateM: numberOrNull(agent.CasinoHeadCountRateM) || 0,
    LiveBettingRateM: numberOrNull(agent.LiveBettingRateM) || 0,
    LiveBetting2RateM: numberOrNull(agent.LiveBetting2RateM) || 0,
    LiveCasinoRateM: numberOrNull(agent.LiveCasinoRateM) || 0,
    PropBuilderRateM: numberOrNull(agent.PropBuilderRateM) || 0,
    FlashBetsRate: numberOrNull(agent.FlashBetsRate) || 0,
    ExtPropsRate: numberOrNull(agent.ExtPropsRate) || 0,
    CrashRate: numberOrNull(agent.CrashRate) || 0,
    FantasyRate: numberOrNull(agent.FantasyRate) || 0,
    AmigoTechRate: numberOrNull(agent.AmigoTechRate) || 0,
  };
}

async function upsertCheckpoint(
  db: Database,
  entityType: string,
  lastSeq: number,
  metadata: Record<string, unknown>
): Promise<void> {
  await db.run(
    `INSERT INTO ingestion_checkpoints (provider, entity_type, last_seq, last_pull, metadata)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(provider, entity_type) DO UPDATE SET
      last_seq = excluded.last_seq,
      last_pull = excluded.last_pull,
      metadata = excluded.metadata`,
    [PROVIDER, entityType, lastSeq, JSON.stringify(metadata)]
  );
}

function numberOrNull(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
