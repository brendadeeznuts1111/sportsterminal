/**
 * ingest-agents-players.ts
 * Fast batch ETL for agent + player preview data into SportsTerminal SQLite.
 *
 * Usage:
 *   bun run scripts/ingest-agents-players.ts
 */
import { initDatabase } from '../src/database';
import { resolve } from 'path';

const AGENTS_PATH = resolve('C:/Users/bobby/user_pasted_clipboard_long_content_as_file_[ { A.txt');
const PLAYERS_PATH = resolve('C:/Users/bobby/customerpreview.txt');

const BATCH_SIZE = 500;

interface AgentRow {
  AgentID: string;
  SeqNumber: number;
  Level: number;
  AgentType: string;
  Login: string;
  HeadCountRateM?: number;
  InetHeadCountRateM?: number;
  CasinoHeadCountRateM?: number;
  LiveBettingRateM?: number;
  LiveBetting2RateM?: number;
  LiveCasinoRateM?: number;
  PropBuilderRateM?: number;
  FlashBetsRate?: number;
  ExtPropsRate?: number;
  CrashRate?: number;
  FantasyRate?: number;
  AmigoTechRate?: number;
}

interface PlayerRow {
  customerID: string;
  Login: string;
  NameFirst: string;
  Password: string;
  Agent: string;
}

async function loadJson<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  const jsonStart = text.indexOf('[');
  if (jsonStart === -1) throw new Error(`No JSON array found in ${path}`);
  return JSON.parse(text.slice(jsonStart)) as T[];
}

function n(value: string | number | undefined | null): string {
  return (value || '').toString().trim().toUpperCase();
}

async function main() {
  const db = await initDatabase();
  console.log('🚀 Ingesting agents + players into SportsTerminal DB\n');

  // ─── 1. Agents (batch INSERT OR REPLACE) ────────────────────────────────
  const agents = await loadJson<AgentRow>(AGENTS_PATH);
  console.log(`📋 ${agents.length} agent(s) loaded from file`);

  await db.exec('BEGIN');
  try {
    for (let i = 0; i < agents.length; i += BATCH_SIZE) {
      const chunk = agents.slice(i, i + BATCH_SIZE);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
      const values: (string | number | null)[] = [];

      for (const a of chunk) {
        const login = n(a.Login);
        const agentId = n(a.AgentID);
        values.push(
          agentId, login, 'buckeye', login,
          a.SeqNumber ?? null, a.Level ?? null, n(a.AgentType),
          a.HeadCountRateM ?? 0, a.InetHeadCountRateM ?? 0, a.CasinoHeadCountRateM ?? 0,
          a.LiveBettingRateM ?? 0, a.LiveBetting2RateM ?? 0, a.LiveCasinoRateM ?? 0,
          a.PropBuilderRateM ?? 0, a.FlashBetsRate ?? 0, a.ExtPropsRate ?? 0,
          a.CrashRate ?? 0, a.FantasyRate ?? 0, a.AmigoTechRate ?? 0
        );
      }

      await db.run(
        `INSERT OR REPLACE INTO agents
         (id, name, provider, login, seq_number, level, agent_type,
          head_count_rate_m, inet_head_count_rate_m, casino_head_count_rate_m,
          live_betting_rate_m, live_betting2_rate_m, live_casino_rate_m,
          prop_builder_rate_m, flash_bets_rate, ext_props_rate,
          crash_rate, fantasy_rate, amigo_tech_rate_m)
         VALUES ${placeholders}`,
        values
      );

      process.stdout.write(`\r   📦 Batch ${Math.min(i + BATCH_SIZE, agents.length)}/${agents.length}`);
    }
    process.stdout.write('\n');
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }

  // ─── 2. Build agent_login → agent_id map for FK resolution ──────────────
  const agentMap = new Map<string, string>();
  const agentRows = await db.all<{ id: string; login: string }>(
    `SELECT id, login FROM agents WHERE provider = 'buckeye'`
  );
  for (const r of agentRows) {
    agentMap.set(r.login, r.id);
  }
  console.log(`   🔑 Resolved ${agentMap.size} agent mappings`);

  // ─── 3. Players (batch INSERT OR REPLACE) ───────────────────────────────
  const players = await loadJson<PlayerRow>(PLAYERS_PATH);
  console.log(`\n📋 ${players.length} player(s) loaded from file`);

  await db.exec('BEGIN');
  try {
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
      const chunk = players.slice(i, i + BATCH_SIZE);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').join(',');
      const values: (string | number | null)[] = [];

      for (const p of chunk) {
        const customerId = n(p.customerID);
        const login = n(p.Login);
        const agentLogin = n(p.Agent);
        const agentId = agentMap.get(agentLogin) || agentLogin;

        values.push(
          customerId, agentId, login || customerId, 'buckeye',
          login, agentLogin, 'active'
        );
      }

      await db.run(
        `INSERT OR REPLACE INTO players
         (id, agent_id, name, provider, login, agent_login, status, last_updated)
         VALUES ${placeholders}`,
        values
      );

      process.stdout.write(`\r   📦 Batch ${Math.min(i + BATCH_SIZE, players.length)}/${players.length}`);
    }
    process.stdout.write('\n');
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }

  // ─── 4. Stats ───────────────────────────────────────────────────────────
  const stats = await db.get<{ agent_count: number; player_count: number }>(
    `SELECT
       (SELECT COUNT(*) FROM agents WHERE provider = 'buckeye') AS agent_count,
       (SELECT COUNT(*) FROM players WHERE provider = 'buckeye') AS player_count`
  );

  console.log('\n═══════════════════════════════════════════════════');
  console.log('📊 Ingest Complete');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Agents in DB:  ${stats?.agent_count ?? 0}`);
  console.log(`Players in DB: ${stats?.player_count ?? 0}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Ingest failed:', err);
  process.exit(1);
});
