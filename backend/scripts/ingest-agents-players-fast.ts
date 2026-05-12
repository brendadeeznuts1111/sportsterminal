/**
 * ingest-agents-players-fast.ts
 * Direct SQLite batch ETL — bypasses initDatabase to avoid migration overhead.
 */
import { Database } from 'bun:sqlite';
import { resolve } from 'path';

const DB_PATH = resolve('./data/terminal.db');
const AGENTS_PATH = resolve('C:/Users/bobby/user_pasted_clipboard_long_content_as_file_[ { A.txt');
const PLAYERS_PATH = resolve('C:/Users/bobby/customerpreview.txt');

const BATCH_SIZE = 1000;

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
  console.log('🚀 Opening SQLite directly:', DB_PATH);
  const db = new Database(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  console.log('📋 Loading agents...');
  const agents = await loadJson<AgentRow>(AGENTS_PATH);
  console.log(`   ${agents.length} agents`);

  console.log('📋 Loading players...');
  const players = await loadJson<PlayerRow>(PLAYERS_PATH);
  console.log(`   ${players.length} players`);

  // ─── Agents ─────────────────────────────────────────────────────────────
  console.log('\n📝 Inserting agents...');
  db.exec('BEGIN');

  const agentStmt = db.prepare(`
    INSERT OR REPLACE INTO agents
    (id, name, provider, login, seq_number, level, agent_type,
     head_count_rate_m, inet_head_count_rate_m, casino_head_count_rate_m,
     live_betting_rate_m, live_betting2_rate_m, live_casino_rate_m,
     prop_builder_rate_m, flash_bets_rate, ext_props_rate,
     crash_rate, fantasy_rate, amigo_tech_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const a of agents) {
    const login = n(a.Login);
    const agentId = n(a.AgentID);
    if (!login) continue;

    agentStmt.run(
      agentId, login, 'buckeye', login,
      a.SeqNumber ?? null, a.Level ?? null, n(a.AgentType),
      a.HeadCountRateM ?? 0, a.InetHeadCountRateM ?? 0, a.CasinoHeadCountRateM ?? 0,
      a.LiveBettingRateM ?? 0, a.LiveBetting2RateM ?? 0, a.LiveCasinoRateM ?? 0,
      a.PropBuilderRateM ?? 0, a.FlashBetsRate ?? 0, a.ExtPropsRate ?? 0,
      a.CrashRate ?? 0, a.FantasyRate ?? 0, a.AmigoTechRate ?? 0
    );
    count++;
    if (count % 500 === 0) process.stdout.write(`\r   ${count}/${agents.length}`);
  }
  process.stdout.write(`\r   ✅ ${count} agents inserted\n`);
  db.exec('COMMIT');
  agentStmt.finalize();

  // ─── Build agent_login → agent_id map ───────────────────────────────────
  console.log('🔑 Building agent lookup...');
  const agentMap = new Map<string, string>();
  const agentRows = db.query(`SELECT id, login FROM agents WHERE provider = 'buckeye'`).all() as Array<{ id: string; login: string }>;
  for (const r of agentRows) agentMap.set(r.login, r.id);
  console.log(`   ${agentMap.size} agents mapped`);

  // ─── Players ────────────────────────────────────────────────────────────
  console.log('\n📝 Inserting players...');
  db.exec('BEGIN');

  const playerStmt = db.prepare(`
    INSERT OR REPLACE INTO players
    (id, agent_id, name, provider, login, agent_login, status, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  count = 0;
  for (const p of players) {
    const customerId = n(p.customerID);
    const login = n(p.Login);
    const agentLogin = n(p.Agent);
    const agentId = agentMap.get(agentLogin) || agentLogin;

    playerStmt.run(
      customerId, agentId, login || customerId, 'buckeye',
      login, agentLogin, 'active'
    );
    count++;
    if (count % 1000 === 0) process.stdout.write(`\r   ${count}/${players.length}`);
  }
  process.stdout.write(`\r   ✅ ${count} players inserted\n`);
  db.exec('COMMIT');
  playerStmt.finalize();

  // ─── Stats ──────────────────────────────────────────────────────────────
  const stats = db.query(`
    SELECT
      (SELECT COUNT(*) FROM agents WHERE provider = 'buckeye') AS agent_count,
      (SELECT COUNT(*) FROM players WHERE provider = 'buckeye') AS player_count
  `).get() as { agent_count: number; player_count: number };

  console.log('\n═══════════════════════════════════════════════════');
  console.log('📊 Ingest Complete');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Agents:  ${stats.agent_count}`);
  console.log(`Players: ${stats.player_count}`);

  db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Ingest failed:', err);
  process.exit(1);
});
