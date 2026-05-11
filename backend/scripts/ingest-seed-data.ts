/**
 * Ingest Seed Data
 *
 * Reads agent and player JSON files directly using Bun.file()
 * and upserts them into the existing hierarchy tables.
 *
 * Run with:
 *   bun run backend/scripts/ingest-seed-data.ts --agents data/agents.json --players data/players.json
 *   bun run backend/scripts/ingest-seed-data.ts --dry-run --agents data/agents.json
 *
 * Cron usage:
 *   import { ingestSeedData } from './ingest-seed-data';
 *   Bun.cron("0 3 * * 1", () => ingestSeedData(db, { agentsPath: 'data/agents.json', playersPath: 'data/players.json' }));
 */

import { AppDatabase, migrateDatabase, normalizeDatabasePath } from '../src/database';
import { backfillAgentsAndPlayers } from '../src/services/HierarchyBackfillService';

export interface IngestSeedOptions {
  agentsPath?: string;
  playersPath?: string;
  source?: string;
  dryRun?: boolean;
}

interface SeedAgentRow {
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

interface SeedPlayerRow {
  Login?: unknown;
  customerID?: unknown;
  Agent?: unknown;
  NameFirst?: unknown;
  SeqNumber?: unknown;
}

export async function ingestSeedData(
  db: AppDatabase,
  options: IngestSeedOptions = {}
): Promise<{ success: boolean; agents: number; players: number; error?: string }> {
  const agentsPath = options.agentsPath;
  const playersPath = options.playersPath;

  if (!agentsPath && !playersPath) {
    return { success: false, agents: 0, players: 0, error: 'No --agents or --players path provided' };
  }

  let agents: SeedAgentRow[] = [];
  let players: SeedPlayerRow[] = [];

  // ─── Read JSON files with Bun.file() ────────────────────────────────────
  if (agentsPath) {
    try {
      const file = Bun.file(agentsPath);
      if (!(await file.exists())) {
        return { success: false, agents: 0, players: 0, error: `Agents file not found: ${agentsPath}` };
      }
      const json = await file.json();
      agents = Array.isArray(json) ? json : json?.GENERAL || [];
      console.log(`📥 Loaded ${agents.length} agents from ${agentsPath}`);
    } catch (err) {
      return { success: false, agents: 0, players: 0, error: `Failed to parse agents JSON: ${err instanceof Error ? err.message : err}` };
    }
  }

  if (playersPath) {
    try {
      const file = Bun.file(playersPath);
      if (!(await file.exists())) {
        return { success: false, agents: 0, players: 0, error: `Players file not found: ${playersPath}` };
      }
      const json = await file.json();
      players = Array.isArray(json) ? json : json?.PLAYERS || [];
      console.log(`📥 Loaded ${players.length} players from ${playersPath}`);
    } catch (err) {
      return { success: false, agents: 0, players: 0, error: `Failed to parse players JSON: ${err instanceof Error ? err.message : err}` };
    }
  }

  // ─── Dry-run validation ─────────────────────────────────────────────────
  if (options.dryRun) {
    const invalidAgents = agents.filter((a) => !a.Login || !a.AgentID).length;
    const invalidPlayers = players.filter((p) => !p.Login && !p.customerID).length;
    console.log(`🔍 Dry-run summary:`);
    console.log(`   Agents: ${agents.length} total, ${invalidAgents} invalid (missing Login/AgentID)`);
    console.log(`   Players: ${players.length} total, ${invalidPlayers} invalid (missing Login/customerID)`);
    return { success: true, agents: agents.length, players: players.length };
  }

  // ─── Ingest via existing backfill service ───────────────────────────────
  const result = await backfillAgentsAndPlayers(db, {
    agents: agents as any,
    players: players as any,
    source: options.source || 'seed_json_ingest',
  });

  console.log(`\n✅ Ingest complete:`);
  console.log(`   Agents: ${result.agents}`);
  console.log(`   Players: ${result.players} (linked: ${result.linkedPlayers}, skipped: ${result.skippedPlayers})`);
  if (result.invalidAgents) {
    console.log(`   Invalid agents skipped: ${result.invalidAgents}`);
  }
  if (result.topAgentsByPlayers?.length) {
    console.log(`   Top agents by players:`);
    for (const a of result.topAgentsByPlayers.slice(0, 5)) {
      console.log(`     ${a.agent_login}: ${a.player_count}`);
    }
  }

  return {
    success: result.success,
    agents: result.agents,
    players: result.players,
  };
}

// ─── CLI entrypoint ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const dbPath = normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db');
  const db = new AppDatabase(dbPath);

  await db.exec('PRAGMA foreign_keys = ON');
  await migrateDatabase(db);

  const result = await ingestSeedData(db, {
    agentsPath: args.agents,
    playersPath: args.players,
    source: args.source || 'seed_json_cli',
    dryRun: args.dryRun,
  });

  await db.close();

  if (!result.success) {
    console.error('❌ Ingest failed:', result.error);
    process.exit(1);
  }
}

function parseArgs(argv: string[]): {
  agents?: string;
  players?: string;
  source?: string;
  dryRun?: boolean;
} {
  const parsed: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--agents') parsed.agents = argv[++i];
    else if (arg.startsWith('--agents=')) parsed.agents = arg.slice('--agents='.length);
    else if (arg === '--players') parsed.players = argv[++i];
    else if (arg.startsWith('--players=')) parsed.players = arg.slice('--players='.length);
    else if (arg === '--source') parsed.source = argv[++i];
    else if (arg.startsWith('--source=')) parsed.source = arg.slice('--source='.length);
    else if (arg === '--dry-run') parsed.dryRun = true;
  }
  return parsed;
}

main().catch((err) => {
  console.error('❌ Ingest script failed:', err);
  process.exit(1);
});
