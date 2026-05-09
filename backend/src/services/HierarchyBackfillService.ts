import type { Database } from '../database';
import { parseAgentHierarchyAndPlayers } from '../api/helpers';

export interface HierarchyBackfillResult {
  success: boolean;
  provider: string;
  agents: number;
  players: number;
  linkedPlayers: number;
  placeholderAgents: number;
  maxSeqNumber: number;
}

const PROVIDER = 'buckeye';

export async function backfillAgentsAndPlayers(db: Database): Promise<HierarchyBackfillResult> {
  const parsed = await parseAgentHierarchyAndPlayers();
  const agents = parsed.agents;
  const players = parsed.players;
  const agentLogins = new Set(agents.map((agent) => String(agent.Login || agent.AgentID || '').trim()).filter(Boolean));
  const placeholderLogins = new Set<string>();

  for (const player of players) {
    if (player.agentLogin && !agentLogins.has(player.agentLogin)) {
      placeholderLogins.add(player.agentLogin);
    }
  }

  await db.run('BEGIN');
  try {
    for (const agent of agents) {
      const login = String(agent.Login || agent.AgentID || '').trim();
      if (!login) continue;
      await upsertAgent(db, agent, login);
    }

    for (const login of placeholderLogins) {
      await upsertPlaceholderAgent(db, login);
    }

    for (const agent of agents) {
      const login = String(agent.Login || agent.AgentID || '').trim();
      const parentLogin = String(agent.ParentAgentID || '').trim();
      if (!login) continue;
      await db.run(
        `UPDATE agents
         SET parent_agent_id = ?, last_updated = CURRENT_TIMESTAMP
         WHERE provider = ? AND login = ?`,
        [parentLogin || null, PROVIDER, login]
      );
    }

    let linkedPlayers = 0;
    for (const player of players) {
      if (!player.login) continue;
      const agentId = player.agentLogin || 'UNKNOWN';
      if (agentId) linkedPlayers++;
      await db.run(
        `INSERT INTO players
          (id, provider, login, display_name, name, agent_login, agent_id, last_seen, raw_json, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          login = excluded.login,
          display_name = excluded.display_name,
          name = excluded.name,
          agent_login = excluded.agent_login,
          agent_id = excluded.agent_id,
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
          JSON.stringify({
            customerId: player.customerId,
            login: player.login,
            agentLogin: player.agentLogin,
          }),
        ]
      );
    }

    const maxSeqNumber = agents.reduce((max, agent) => Math.max(max, Number(agent.SeqNumber) || 0), 0);
    await upsertCheckpoint(db, 'hierarchy', maxSeqNumber, {
      source: parsed.meta.source,
      agentCount: agents.length,
      playerCount: players.length,
      linkedPlayerAgents: parsed.meta.linkedPlayerAgents,
      placeholderAgents: placeholderLogins.size,
    });
    await upsertCheckpoint(db, 'players', players.length, {
      source: parsed.meta.source,
      playerCount: players.length,
      linkedPlayerAgents: parsed.meta.linkedPlayerAgents,
    });

    await db.run('COMMIT');
    return {
      success: true,
      provider: PROVIDER,
      agents: agents.length,
      players: players.length,
      linkedPlayers,
      placeholderAgents: placeholderLogins.size,
      maxSeqNumber,
    };
  } catch (error) {
    await db.run('ROLLBACK').catch(() => ({ lastID: 0, changes: 0 }));
    throw error;
  }
}

async function upsertAgent(db: Database, agent: any, login: string): Promise<void> {
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
      login,
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
      JSON.stringify({
        AgentID: String(agent.AgentID || login).trim(),
        SeqNumber: agent.SeqNumber,
        Level: agent.Level,
        AgentType: agent.AgentType,
        Login: login,
      }),
    ]
  );
}

async function upsertPlaceholderAgent(db: Database, login: string): Promise<void> {
  await db.run(
    `INSERT INTO agents (id, provider, login, display_name, name, agent_type, raw_json, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      login = COALESCE(agents.login, excluded.login),
      display_name = COALESCE(agents.display_name, excluded.display_name),
      name = COALESCE(agents.name, excluded.name),
      raw_json = excluded.raw_json,
      last_updated = CURRENT_TIMESTAMP`,
    [
      login,
      PROVIDER,
      login,
      login,
      login,
      'A',
      JSON.stringify({ placeholder: true, reason: 'Referenced by player export' }),
    ]
  );
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
