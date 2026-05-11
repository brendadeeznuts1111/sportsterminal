import { SQL } from 'bun';
import crypto from 'crypto';

const dbUrl = process.env.DATABASE_URL || './data/terminal.db';

const BUCKEYE_SPORT_TYPES = [
  'Auto Racing         ',
  'Baseball            ',
  'Basketball          ',
  'Boxing              ',
  'Cricket             ',
  'Entertainment       ',
  'Esports             ',
  'Football            ',
  'Golf                ',
  'Hockey              ',
  'Horse Racing        ',
  'LIVE                ',
  'Martial Arts        ',
  'Olympics            ',
  'Other               ',
  'Rugby               ',
  'Soccer              ',
  'Tennis              ',
  'Virtual Sports      ',
];

export function normalizeDatabasePath(value: string): string {
  return value.startsWith('sqlite:') ? value.slice('sqlite:'.length) : value;
}

export function isPostgresUrl(value: string): boolean {
  return value.startsWith('postgres://') || value.startsWith('postgresql://');
}

export interface DbRunResult {
  lastID: number;
  changes: number;
}

type UntypedRow = Record<string, unknown>;

interface PragmaColumnRow {
  name: string;
}

interface WagerSequenceRow {
  max_seq: number | null;
  row_count: number;
}

export class AppDatabase {
  private db: SQL;
  private dialect: 'sqlite' | 'postgres';

  constructor(url: string) {
    this.dialect = isPostgresUrl(url) ? 'postgres' : 'sqlite';
    if (this.dialect === 'sqlite') {
      const sqliteUrl = toSqliteUrl(url);
      this.db = isInMemorySqliteUrl(sqliteUrl)
        ? new SQL(sqliteUrl, { max: 1 })
        : new SQL(sqliteUrl);
    } else {
      this.db = new SQL(url);
    }
  }

  getDialect(): 'sqlite' | 'postgres' {
    return this.dialect;
  }

  async exec(sql: string): Promise<void> {
    if (this.dialect === 'sqlite') {
      for (const statement of splitSqliteStatements(sql)) {
        await this.db.unsafe(statement);
      }
      return;
    }

    await this.db.unsafe(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const result = await this.db.unsafe(sql, params);
    if (this.dialect === 'sqlite') {
      const changes = await this.db.unsafe('SELECT changes() AS changes');
      return {
        lastID: Number(result.lastInsertRowid ?? 0),
        changes: Number(changes[0]?.changes ?? 0),
      };
    }
    // Postgres: lastInsertRowid is not available; use RETURNING or omit
    return {
      lastID: Number(result.lastInsertRowid ?? 0),
      changes: result.length ?? 0,
    };
  }

  // Database callers can provide a row type; untyped SQL falls back to a broad object row.
  async get<T = UntypedRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.db.unsafe(sql, params);
    return (rows[0] ?? null) as T | null;
  }

  // Database callers can provide a row type; untyped SQL falls back to a broad object row.
  async all<T = UntypedRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.unsafe(sql, params)) as T[];
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export type Database = AppDatabase;

function splitSqliteStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function initDatabase(url: string = dbUrl): Promise<AppDatabase> {
  const db = new AppDatabase(url);

  if (db.getDialect() === 'sqlite') {
    // Enable foreign keys for SQLite
    await db.exec('PRAGMA foreign_keys = ON');
    // Enable WAL mode for better concurrent read/write performance
    await db.exec('PRAGMA journal_mode = WAL');
    // Increase busy timeout to 30 seconds to reduce SQLITE_BUSY errors
    await db.exec('PRAGMA busy_timeout = 30000');
  }

  // Create tables (SQLite-compatible; Postgres will use its own migration path)
  if (db.getDialect() === 'sqlite') {
    await db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      login TEXT,
      display_name TEXT,
      parent_agent_id TEXT,
      tier INTEGER,
      level INTEGER,
      child_count INTEGER DEFAULT 0,
      player_count INTEGER DEFAULT 0,
      seq_number INTEGER,
      agent_type TEXT,
      head_count_rate_m REAL,
      inet_head_count_rate_m REAL,
      casino_head_count_rate_m REAL,
      live_betting_rate_m REAL,
      live_betting2_rate_m REAL,
      live_casino_rate_m REAL,
      prop_builder_rate_m REAL,
      flash_bets_rate REAL,
      ext_props_rate REAL,
      crash_rate REAL,
      fantasy_rate REAL,
      amigo_tech_rate REAL,
      credit REAL,
      balance REAL,
      status TEXT DEFAULT 'active',
      raw_json TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      login TEXT,
      display_name TEXT,
      agent_login TEXT,
      seq_number INTEGER,
      net_pnl REAL DEFAULT 0,
      ytd_pnl REAL DEFAULT 0,
      exposure REAL DEFAULT 0,
      credit_limit REAL,
      status TEXT DEFAULT 'active',
      last_seen TEXT,
      raw_json TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS agent_hierarchy (
      agent_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      login TEXT NOT NULL,
      display_name TEXT,
      parent_agent_id TEXT,
      level INTEGER,
      agent_type TEXT,
      seq_number INTEGER,
      child_count INTEGER DEFAULT 0,
      player_count INTEGER DEFAULT 0,
      head_count_rate_m REAL DEFAULT 0,
      inet_head_count_rate_m REAL DEFAULT 0,
      casino_head_count_rate_m REAL DEFAULT 0,
      live_betting_rate_m REAL DEFAULT 0,
      live_betting2_rate_m REAL DEFAULT 0,
      live_casino_rate_m REAL DEFAULT 0,
      prop_builder_rate_m REAL DEFAULT 0,
      flash_bets_rate REAL DEFAULT 0,
      ext_props_rate REAL DEFAULT 0,
      crash_rate REAL DEFAULT 0,
      fantasy_rate REAL DEFAULT 0,
      amigo_tech_rate REAL DEFAULT 0,
      raw_json TEXT,
      last_refreshed DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS player_agent_map (
      player_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      player_login TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_login TEXT,
      source TEXT NOT NULL DEFAULT 'hierarchy_backfill',
      linked_accounts_json TEXT,
      last_refreshed DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, player_id)
    );
  `);

    // Migration: add seq_number to players if missing (pre-2026-05-09 schema)
    try {
      await db.exec('ALTER TABLE players ADD COLUMN seq_number INTEGER');
    } catch (err) {
      // Only ignore "duplicate column" errors; rethrow everything else
      if (!errorMessage(err).toLowerCase().includes('duplicate column name')) {
        throw err;
      }
    }

    await db.exec(`
    CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      last_seq INTEGER,
      last_pull TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (provider, entity_type)
    );

    CREATE TABLE IF NOT EXISTS buckeye_sport_types (
      raw_value TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'seed',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS raw_api_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      response_json TEXT NOT NULL,
      agent_id TEXT,
      duration_ms INTEGER,
      request_params TEXT,
      status_code INTEGER
    );

    CREATE TABLE IF NOT EXISTS wager_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wager_number INTEGER UNIQUE NOT NULL,
      agent_id TEXT,
      customer_id TEXT,
      login TEXT,
      wager_type TEXT,
      amount_wagered REAL,
      to_win_amount REAL,
      insert_date_time TEXT NOT NULL,
      ticket_writer TEXT,
      volume_amount REAL,
      short_desc_raw TEXT,
      vip TEXT,
      agent_login TEXT,
      ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL,
      sport TEXT,
      league TEXT,
      price REAL
    );

    CREATE TABLE IF NOT EXISTS master_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      balance REAL,
      available_balance REAL,
      percent_book REAL,
      open_wager_count INTEGER DEFAULT 0,
      account_info_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS weekly_figures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      agent_id TEXT NOT NULL,
      week INTEGER DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'A',
      layout TEXT NOT NULL DEFAULT 'byDay',
      week_start_date TEXT,
      sport TEXT,
      handle REAL,
      win_loss REAL,
      this_week REAL DEFAULT 0,
      active REAL DEFAULT 0,
      today REAL DEFAULT 0,
      info TEXT,
      wager_type TEXT,
      raw_json TEXT NOT NULL DEFAULT '{}',
      pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      performance_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      login TEXT,
      agent_id TEXT,
      agent_login TEXT,
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT,
      method TEXT,
      ip_address TEXT,
      status TEXT,
      transaction_time TEXT NOT NULL,
      pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS player_transactions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      login TEXT,
      agent_id TEXT,
      agent_login TEXT,
      document_number TEXT,
      tran_code TEXT,
      tran_type TEXT,
      amount REAL NOT NULL DEFAULT 0,
      balance REAL,
      hold_amount REAL,
      grade_num TEXT,
      description TEXT,
      entered_by TEXT,
      category TEXT NOT NULL DEFAULT 'other',
      transaction_time TEXT NOT NULL,
      pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS customer_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      login TEXT,
      agent_id TEXT,
      agent_login TEXT,
      kyc_level TEXT,
      vip_status TEXT,
      email_masked TEXT,
      phone_masked TEXT,
      currency TEXT,
      source TEXT NOT NULL DEFAULT 'probe',
      snapshot_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS player_source_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      login TEXT,
      agent_id TEXT,
      source_key TEXT NOT NULL,
      refresh_policy TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 0,
      scale_class TEXT NOT NULL,
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      next_refresh_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, customer_id, source_key)
    );

    CREATE TABLE IF NOT EXISTS player_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      player_a TEXT NOT NULL,
      player_b TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(provider, player_a, player_b, reason)
    );

    CREATE TABLE IF NOT EXISTS player_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      flag_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      label TEXT NOT NULL,
      details TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS player_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      customer_id TEXT NOT NULL,
      note_type TEXT NOT NULL DEFAULT 'general',
      body TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduler_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watermarks (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      actor_id TEXT,
      actor_type TEXT,
      old_values TEXT,
      new_values TEXT,
      timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT
    );

    CREATE TABLE IF NOT EXISTS telegram_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_login TEXT NOT NULL,
      topic_name TEXT NOT NULL,
      purpose TEXT,
      topic_icon TEXT,
      topic_hex_color TEXT,
      topic_icon_color INTEGER,
      topic_thread_id INTEGER,
      supergroup_chat_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS telegram_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_name TEXT NOT NULL,
      channel_type TEXT DEFAULT 'broadcast',
      purpose TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      telegram_chat_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Agent supergroups (one per agent, plus one system-internal group)
    CREATE TABLE IF NOT EXISTS agent_supergroups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supergroup_chat_id TEXT NOT NULL UNIQUE,
      owner_agent_login TEXT,
      purpose TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- All discovered topics (idempotent by supergroup+thread_id)
    CREATE TABLE IF NOT EXISTS agent_supergroup_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supergroup_id INTEGER NOT NULL,
      topic_thread_id INTEGER NOT NULL,
      topic_name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      topic_icon TEXT,
      topic_hex_color TEXT,
      is_managed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supergroup_id) REFERENCES agent_supergroups(id),
      UNIQUE(supergroup_id, topic_thread_id)
    );

    -- Messages sent to topics (stored locally for history / audit)
    CREATE TABLE IF NOT EXISTS telegram_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      telegram_message_id INTEGER,
      text TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT 'bot',
      parse_mode TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (topic_id) REFERENCES agent_supergroup_topics(id)
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_messages_topic ON telegram_messages(topic_id, sent_at);

    CREATE TABLE IF NOT EXISTS agent_performance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'buckeye',
      report_agent_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      login TEXT NOT NULL,
      report_type TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      sport TEXT,
      subsport TEXT,
      period TEXT,
      wager_type TEXT,
      bet_type TEXT,
      activity_tipo TEXT,
      free_play TEXT,
      wager_count INTEGER DEFAULT 0,
      risk REAL DEFAULT 0,
      to_win REAL DEFAULT 0,
      amount_won REAL DEFAULT 0,
      amount_lost REAL DEFAULT 0,
      volume REAL DEFAULT 0,
      net REAL DEFAULT 0,
      pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS odds (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      sport TEXT,
      league TEXT,
      home_team TEXT,
      away_team TEXT,
      spread REAL,
      total REAL,
      moneyline_home REAL,
      moneyline_away REAL,
      provider TEXT DEFAULT 'buckeye',
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Wagers table: aligns with Buckeye getBetTicker schema
    CREATE TABLE IF NOT EXISTS wagers (
      wager_number INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      login TEXT NOT NULL,
      wager_type TEXT,
      amount_wagered INTEGER NOT NULL,
      to_win_amount INTEGER NOT NULL,
      volume_amount INTEGER NOT NULL,
      insert_datetime TEXT NOT NULL,
      ticket_writer TEXT NOT NULL,
      short_desc TEXT NOT NULL,
      vip TEXT NOT NULL,
      agent_login TEXT NOT NULL,
      sport TEXT,
      parsed_game TEXT,
      parsed_market TEXT,
      parsed_side TEXT,
      parsed_price REAL,
      parsed_period TEXT,
      matched_event_id TEXT,
      pin_reference_json TEXT,
      scraped_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
      wager_number INTEGER,
      rule_name TEXT NOT NULL,
      severity TEXT CHECK(severity IN ('info','warning','critical')),
      message TEXT NOT NULL,
      is_resolved BOOLEAN DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS risk_alerts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      player_id TEXT,
      type TEXT NOT NULL,
      value REAL,
      threshold REAL,
      message TEXT,
      acknowledged BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (player_id) REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS account_change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      player TEXT NOT NULL,
      ip_address TEXT,
      change_type TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS failed_logins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      player TEXT NOT NULL,
      ip TEXT,
      timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS closing_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      closing_odds REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'odds_snapshots',
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(game_id, market, side)
    );

    CREATE TABLE IF NOT EXISTS agent_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      condition_json TEXT NOT NULL,
      action TEXT NOT NULL,
      severity TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER,
      wager_number INTEGER,
      player_id TEXT,
      action TEXT NOT NULL,
      severity TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (rule_id) REFERENCES agent_rules(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sandbox_scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      config_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sandbox_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id INTEGER NOT NULL,
      customer_id TEXT NOT NULL,
      archetype TEXT NOT NULL,
      risk_tier TEXT,
      balance REAL,
      clv REAL,
      win_rate REAL,
      lifetime_wagers INTEGER,
      tags_json TEXT NOT NULL DEFAULT '[]',
      profile_json TEXT NOT NULL DEFAULT '{}',
      summary_json TEXT,
      summary_status TEXT NOT NULL DEFAULT 'pending',
      summary_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (scenario_id) REFERENCES sandbox_scenarios(id) ON DELETE CASCADE,
      UNIQUE(scenario_id, customer_id)
    );

    CREATE TABLE IF NOT EXISTS sandbox_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id INTEGER NOT NULL,
      customer_id TEXT NOT NULL,
      day_index INTEGER NOT NULL,
      balance REAL,
      pnl REAL,
      wager_count INTEGER,
      clv REAL,
      win_rate REAL,
      FOREIGN KEY (scenario_id) REFERENCES sandbox_scenarios(id) ON DELETE CASCADE,
      UNIQUE(scenario_id, customer_id, day_index)
    );

    CREATE TABLE IF NOT EXISTS sandbox_ab_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      prompt_a TEXT NOT NULL,
      prompt_b TEXT NOT NULL,
      results_json TEXT,
      agreement_score REAL,
      avg_severity_diff REAL,
      significant INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (scenario_id) REFERENCES sandbox_scenarios(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sandbox_summary_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id INTEGER NOT NULL,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      summary_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT,
      processing_started_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (scenario_id) REFERENCES sandbox_scenarios(id) ON DELETE CASCADE,
      UNIQUE(scenario_id, customer_id)
    );

    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      encrypted_data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_players_agent ON players(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
    CREATE INDEX IF NOT EXISTS idx_players_agent_login ON players(agent_login);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_provider_entity ON ingestion_checkpoints(provider, entity_type);
    CREATE INDEX IF NOT EXISTS idx_buckeye_sport_types_label ON buckeye_sport_types(label);
    CREATE INDEX IF NOT EXISTS idx_raw_logs_endpoint_time ON raw_api_logs(endpoint, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_raw_logs_agent ON raw_api_logs(agent_id, fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_raw_logs_fetched_at ON raw_api_logs(fetched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_weekly_figures_agent ON weekly_figures(agent_id, pulled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_master_snapshots_agent ON master_snapshots(agent_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_wager_archive_time ON wager_archive(insert_date_time);
    CREATE INDEX IF NOT EXISTS idx_wager_archive_agent_time ON wager_archive(agent_login, insert_date_time);
    CREATE INDEX IF NOT EXISTS idx_wager_archive_customer ON wager_archive(customer_id);
    CREATE INDEX IF NOT EXISTS idx_wager_archive_login_time ON wager_archive(login, insert_date_time DESC);
    CREATE INDEX IF NOT EXISTS idx_wager_archive_ingested ON wager_archive(ingested_at);
    CREATE INDEX IF NOT EXISTS idx_deposits_customer_time ON deposits(customer_id, transaction_time DESC);
    CREATE INDEX IF NOT EXISTS idx_deposits_login_time ON deposits(login, transaction_time DESC);
    CREATE INDEX IF NOT EXISTS idx_deposits_ip_time ON deposits(ip_address, transaction_time DESC);
    CREATE INDEX IF NOT EXISTS idx_player_transactions_customer_time ON player_transactions(customer_id, transaction_time DESC);
    CREATE INDEX IF NOT EXISTS idx_player_transactions_login_time ON player_transactions(login, transaction_time DESC);
    CREATE INDEX IF NOT EXISTS idx_player_transactions_category_time ON player_transactions(category, transaction_time DESC);
    CREATE INDEX IF NOT EXISTS idx_player_transactions_category_customer ON player_transactions(category, customer_id, transaction_time DESC);
    CREATE INDEX IF NOT EXISTS idx_player_transactions_category_login ON player_transactions(category, login, transaction_time DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_snapshots_customer_time ON customer_snapshots(customer_id, snapshot_time DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_snapshots_login_time ON customer_snapshots(login, snapshot_time DESC);
    CREATE INDEX IF NOT EXISTS idx_player_source_status_customer ON player_source_status(customer_id, source_key);
    CREATE INDEX IF NOT EXISTS idx_player_source_status_next ON player_source_status(agent_id, next_refresh_at);
    CREATE INDEX IF NOT EXISTS idx_player_links_a ON player_links(player_a, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_player_links_b ON player_links(player_b, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_player_flags_customer ON player_flags(customer_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_player_notes_customer ON player_notes(customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_master_snapshots_time ON master_snapshots(timestamp);
    CREATE INDEX IF NOT EXISTS idx_weekly_figures_agent_week ON weekly_figures(agent_id, week_start_date);
    CREATE INDEX IF NOT EXISTS idx_agent_performance_agent_time ON agent_performance(agent_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);
    CREATE INDEX IF NOT EXISTS idx_agent_perf_customer ON agent_performance_snapshots(customer_id, pulled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_perf_login ON agent_performance_snapshots(login, pulled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_perf_agent ON agent_performance_snapshots(agent_id, pulled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_perf_report ON agent_performance_snapshots(report_agent_id, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_odds_event ON odds(event_id);
    CREATE INDEX IF NOT EXISTS idx_wagers_agent ON wagers(agent_login);
    CREATE INDEX IF NOT EXISTS idx_wagers_datetime ON wagers(insert_datetime);
    CREATE INDEX IF NOT EXISTS idx_wagers_alert ON wagers(ticket_writer) WHERE ticket_writer = 'ALERT';
    CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON alerts(is_resolved) WHERE is_resolved = 0;
    CREATE INDEX IF NOT EXISTS idx_failed_logins_player_time ON failed_logins(player, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_failed_logins_ip_time ON failed_logins(ip, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_account_change_player_time ON account_change_logs(player, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_closing_lines_game_market ON closing_lines(game_id, market, side);
    CREATE INDEX IF NOT EXISTS idx_agent_rules_enabled ON agent_rules(enabled);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON agent_actions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_action_player ON agent_actions(action, player_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sandbox_customers_scenario ON sandbox_customers(scenario_id);
    CREATE INDEX IF NOT EXISTS idx_sandbox_customers_status ON sandbox_customers(scenario_id, summary_status);
    CREATE INDEX IF NOT EXISTS idx_sandbox_snapshots_lookup ON sandbox_snapshots(scenario_id, customer_id);
    CREATE INDEX IF NOT EXISTS idx_sandbox_queue_status ON sandbox_summary_queue(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_sandbox_queue_scenario ON sandbox_summary_queue(scenario_id);
    CREATE INDEX IF NOT EXISTS idx_sandbox_ab_tests_scenario ON sandbox_ab_tests(scenario_id, status);
    CREATE INDEX IF NOT EXISTS idx_wagers_sport ON wagers(sport);
    CREATE INDEX IF NOT EXISTS idx_wagers_login_datetime ON wagers(login, insert_datetime DESC);
    CREATE INDEX IF NOT EXISTS idx_wagers_agent_datetime ON wagers(agent_login, insert_datetime DESC);
    CREATE INDEX IF NOT EXISTS idx_wagers_ticket_datetime ON wagers(ticket_writer, insert_datetime DESC);
    CREATE INDEX IF NOT EXISTS idx_wagers_sport_datetime ON wagers(sport, insert_datetime DESC);

    -- Webhook configuration for alert notifications
    CREATE TABLE IF NOT EXISTS alert_webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      platform TEXT CHECK(platform IN ('discord','slack','telegram','generic')) NOT NULL,
      url TEXT NOT NULL,
      triggers TEXT NOT NULL DEFAULT '["all"]',
      enabled BOOLEAN DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Webhook delivery log
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id INTEGER NOT NULL,
      alert_id INTEGER,
      payload TEXT NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      success BOOLEAN DEFAULT 0,
      attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (webhook_id) REFERENCES alert_webhooks(id) ON DELETE CASCADE
    );

    -- Odds grid: events (games)
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      league TEXT,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      start_time TEXT,
      status TEXT DEFAULT 'upcoming',
      last_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Odds grid: per-event per-book snapshots
    CREATE TABLE IF NOT EXISTS odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      book TEXT NOT NULL,
      spread_home REAL,
      spread_away REAL,
      spread_home_price REAL,
      spread_away_price REAL,
      total_over REAL,
      total_under REAL,
      total_over_price REAL,
      total_under_price REAL,
      moneyline_home REAL,
      moneyline_away REAL,
      scraped_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_id, book),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );

    -- Odds grid: line movement history
    CREATE TABLE IF NOT EXISTS line_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      book TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      old_value REAL NOT NULL,
      new_value REAL NOT NULL,
      delta REAL NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id)
    );

    -- Book health tracking
    CREATE TABLE IF NOT EXISTS book_health (
      book TEXT PRIMARY KEY,
      status TEXT DEFAULT 'unknown',
      last_seen TEXT,
      error_count INTEGER DEFAULT 0,
      last_error TEXT
    );

    -- Persisted line-movement pattern detections
    CREATE TABLE IF NOT EXISTS detected_patterns (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT NOT NULL,
      severity TEXT CHECK(severity IN ('info','warning','critical')) NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'odds',
      wager_number INTEGER,
      agent_login TEXT,
      trigger_book TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      description TEXT,
      detected_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id)
    );

    CREATE TABLE IF NOT EXISTS pattern_agents (
      pattern_id TEXT NOT NULL,
      agent_login TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (pattern_id, agent_login),
      FOREIGN KEY (pattern_id) REFERENCES detected_patterns(id) ON DELETE CASCADE
    );

    -- Buckeye IP tracker / web access log rows
    CREATE TABLE IF NOT EXISTS access_logs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      login_id TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      access_datetime TEXT NOT NULL,
      operation TEXT,
      data TEXT,
      log_type TEXT NOT NULL,
      pulled_at TEXT NOT NULL,
      raw_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS ip_denylist (
      ip TEXT PRIMARY KEY,
      blocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reason TEXT,
      created_by TEXT NOT NULL DEFAULT 'operator'
    );

    CREATE INDEX IF NOT EXISTS idx_odds_snapshots_event ON odds_snapshots(event_id);
    CREATE INDEX IF NOT EXISTS idx_line_movements_event ON line_movements(event_id, book, market);
    CREATE INDEX IF NOT EXISTS idx_line_movements_time ON line_movements(recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_time ON detected_patterns(detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_event ON detected_patterns(event_id, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_type ON detected_patterns(type, detected_at DESC);

    -- AI Risk Flags (populated by Kimi agent / proxy-enhanced)
    -- Mirrors the schema used by kimiremote so positions can read latest analyses.
    CREATE TABLE IF NOT EXISTS ai_risk_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wager_number INTEGER,
      agent_id TEXT,
      customer_id TEXT,
      player_id TEXT,
      risk_level TEXT,
      risk_score REAL,
      confidence REAL,
      summary TEXT,
      reasoning TEXT,
      factors TEXT,
      suggested_action TEXT,
      max_exposure REAL,
      action TEXT,
      raw_response TEXT,
      reviewed INTEGER DEFAULT 0,
      reviewer TEXT,
      reviewer_id TEXT,
      reviewed_at TEXT,
      review_note TEXT,
      flagged_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_risk_flags_customer ON ai_risk_flags(customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_risk_flags_player ON ai_risk_flags(player_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_risk_flags_level ON ai_risk_flags(risk_level, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_risk_flags_unreviewed ON ai_risk_flags(reviewed, created_at DESC);

    -- Live AI command center: latest extracted player feature vector.
    CREATE TABLE IF NOT EXISTS customer_features (
      customer_id TEXT PRIMARY KEY,
      extracted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      feature_version INTEGER NOT NULL DEFAULT 1,
      lifetime_wagers INTEGER NOT NULL DEFAULT 0,
      avg_wager_size REAL NOT NULL DEFAULT 0,
      max_wager_size REAL NOT NULL DEFAULT 0,
      win_rate REAL NOT NULL DEFAULT 0,
      days_since_last_wager REAL,
      sport_diversity_score REAL NOT NULL DEFAULT 0,
      deposit_velocity_30d REAL NOT NULL DEFAULT 0,
      withdrawal_ratio REAL NOT NULL DEFAULT 0,
      bonus_dependency REAL NOT NULL DEFAULT 0,
      sharp_score REAL NOT NULL DEFAULT 0,
      chase_flag INTEGER NOT NULL DEFAULT 0,
      archetype TEXT NOT NULL DEFAULT 'unknown',
      risk_tier TEXT NOT NULL DEFAULT 'UNKNOWN',
      clv REAL NOT NULL DEFAULT 0,
      feature_json TEXT NOT NULL DEFAULT '{}',
      source_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_customer_features_tier ON customer_features(risk_tier, extracted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_customer_features_sharp ON customer_features(sharp_score DESC, extracted_at DESC);

    -- Live shadow A/B runs are separate from sandbox A/B tests.
    CREATE TABLE IF NOT EXISTS live_shadow_ab_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      prompt_a TEXT NOT NULL,
      prompt_b TEXT NOT NULL,
      customer_ids_json TEXT NOT NULL,
      results_json TEXT,
      agreement_score REAL,
      avg_severity_diff REAL,
      significant INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_live_shadow_ab_status ON live_shadow_ab_tests(status, created_at DESC);

    -- Risk Command Center: position management
    CREATE TABLE IF NOT EXISTS risk_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      scenario_id INTEGER,
      risk_level TEXT NOT NULL,
      suggested_max_exposure REAL,
      suggested_wager_limit REAL,
      suggested_action TEXT CHECK(suggested_action IN ('none','reduce','review','block')),
      ai_confidence REAL,
      ai_summary TEXT,
      executed_max_exposure REAL,
      executed_wager_limit REAL,
      executed_action TEXT,
      executed_by TEXT,
      executed_at TEXT,
      execution_note TEXT,
      status TEXT DEFAULT 'pending',
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (scenario_id) REFERENCES sandbox_scenarios(id)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_customer ON risk_positions(customer_id, status);
    CREATE INDEX IF NOT EXISTS idx_positions_pending ON risk_positions(status, created_at);

    -- Manual enforcement queue: local operator workflow while Buckeye writes are unmapped.
    CREATE TABLE IF NOT EXISTS enforcement_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL UNIQUE,
      customer_id TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      suggested_max_exposure REAL,
      suggested_wager_limit REAL,
      suggested_action TEXT,
      ai_confidence REAL,
      ai_summary TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      viewed_at TEXT,
      viewed_by TEXT,
      applied_at TEXT,
      applied_by TEXT,
      buckeye_admin_url TEXT,
      reminder_count INTEGER NOT NULL DEFAULT 0,
      last_reminder_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL DEFAULT (datetime('now', '+30 minutes')),
      FOREIGN KEY (position_id) REFERENCES risk_positions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_enforcement_pending ON enforcement_queue(status, risk_level, created_at);
    CREATE INDEX IF NOT EXISTS idx_enforcement_customer ON enforcement_queue(customer_id, status);

    -- Risk Command Center: alert dispatch log
    CREATE TABLE IF NOT EXISTS risk_alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT,
      risk_level TEXT,
      webhook_id INTEGER,
      platform TEXT,
      payload TEXT,
      response_status INTEGER,
      sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (webhook_id) REFERENCES alert_webhooks(id) ON DELETE SET NULL
    );

    -- Risk Command Center: wager violations with deduplication
    CREATE TABLE IF NOT EXISTS wager_violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wager_id INTEGER NOT NULL,
      customer_id TEXT NOT NULL,
      violation_type TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(wager_id, violation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_violations_customer ON wager_violations(customer_id, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_violations_type ON wager_violations(violation_type, detected_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wv_unique_violation ON wager_violations(wager_id, violation_type);
  `);

    console.log('📊 Database tables created');
    await migrateDatabase(db);
    await createPostMigrationIndexes(db);
    await seedBuckeyeSportTypes(db);
  } else {
    console.log('📊 Postgres mode — schema managed via migrations');
  }

  return db;
}

function toSqliteUrl(filename: string): string {
  if (filename === ':memory:' || filename === 'sqlite://:memory:') {
    return `sqlite://file:sportsterminal-${crypto.randomUUID()}?mode=memory&cache=shared`;
  }
  if (filename.startsWith('sqlite://')) return filename;
  return `sqlite://${filename.replace(/\\/g, '/')}`;
}

function isInMemorySqliteUrl(url: string): boolean {
  return url === 'sqlite://:memory:' || url.startsWith('sqlite://:memory:?') || url.includes('mode=memory');
}

async function createPostMigrationIndexes(db: AppDatabase): Promise<void> {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_category ON detected_patterns(category, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_agent ON detected_patterns(agent_login, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_wager ON detected_patterns(wager_number);
    CREATE INDEX IF NOT EXISTS idx_pattern_agents_agent ON pattern_agents(agent_login);
    CREATE INDEX IF NOT EXISTS idx_access_logs_ip_time ON access_logs(ip_address, access_datetime DESC);
    CREATE INDEX IF NOT EXISTS idx_access_logs_login_time ON access_logs(login_id, access_datetime DESC);
    CREATE INDEX IF NOT EXISTS idx_ip_denylist_blocked_at ON ip_denylist(blocked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_failed_logins_player_time ON failed_logins(player, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_failed_logins_ip_time ON failed_logins(ip, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_account_change_player_time ON account_change_logs(player, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_closing_lines_game_market ON closing_lines(game_id, market, side);
    CREATE INDEX IF NOT EXISTS idx_agent_rules_enabled ON agent_rules(enabled);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON agent_actions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sandbox_customers_scenario ON sandbox_customers(scenario_id);
    CREATE INDEX IF NOT EXISTS idx_sandbox_customers_status ON sandbox_customers(scenario_id, summary_status);
    CREATE INDEX IF NOT EXISTS idx_sandbox_snapshots_lookup ON sandbox_snapshots(scenario_id, customer_id);
    CREATE INDEX IF NOT EXISTS idx_sandbox_queue_status ON sandbox_summary_queue(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_sandbox_queue_scenario ON sandbox_summary_queue(scenario_id);
    CREATE INDEX IF NOT EXISTS idx_sandbox_ab_tests_scenario ON sandbox_ab_tests(scenario_id, status);
    CREATE INDEX IF NOT EXISTS idx_wagers_event_time ON wagers(matched_event_id, insert_datetime DESC);
    CREATE INDEX IF NOT EXISTS idx_wagers_game_side_time ON wagers(parsed_game, parsed_market, parsed_side, insert_datetime DESC);
  `);
}

/**
 * Migrate existing database tables to match current schema.
 * SQLite does not support ALTER TABLE DROP COLUMN, but ADD COLUMN is safe.
 */
export async function migrateDatabase(db: Database) {
  try {
    // Check if odds_snapshots has spread_home_price
    const columns = await db.all<PragmaColumnRow>(`PRAGMA table_info(odds_snapshots)`);
    if (columns.length > 0) {
      const hasSpreadHomePrice = columns.some((c) => c.name === 'spread_home_price');
      const hasSpreadAwayPrice = columns.some((c) => c.name === 'spread_away_price');

      if (!hasSpreadHomePrice) {
        await db.exec(`ALTER TABLE odds_snapshots ADD COLUMN spread_home_price REAL`);
        console.log('📊 Migration: added spread_home_price to odds_snapshots');
      }
      if (!hasSpreadAwayPrice) {
        await db.exec(`ALTER TABLE odds_snapshots ADD COLUMN spread_away_price REAL`);
        console.log('📊 Migration: added spread_away_price to odds_snapshots');
      }
    }

    const wagerColumns = await db.all<PragmaColumnRow>(`PRAGMA table_info(wagers)`);
    const wagerColumnNames = new Set(wagerColumns.map((c) => c.name));
    const wagerAdds: Array<[string, string]> = [
      ['parsed_game', 'TEXT'],
      ['parsed_market', 'TEXT'],
      ['parsed_side', 'TEXT'],
      ['parsed_price', 'REAL'],
      ['parsed_period', 'TEXT'],
      ['matched_event_id', 'TEXT'],
      ['pin_reference_json', 'TEXT'],
      ['raw_json', 'TEXT'],
    ];
    for (const [name, type] of wagerAdds) {
      if (!wagerColumnNames.has(name)) {
        await db.exec(`ALTER TABLE wagers ADD COLUMN ${name} ${type}`);
        console.log(`📊 Migration: added ${name} to wagers`);
      }
    }
    await removeLegacyWagerTypeConstraint(db);

    const patternColumns = await db.all<PragmaColumnRow>(`PRAGMA table_info(detected_patterns)`);
    const patternColumnNames = new Set(patternColumns.map((c) => c.name));
    if (!patternColumnNames.has('category')) {
      await db.exec(`ALTER TABLE detected_patterns ADD COLUMN category TEXT NOT NULL DEFAULT 'odds'`);
      console.log('📊 Migration: added category to detected_patterns');
    }
    if (!patternColumnNames.has('wager_number')) {
      await db.exec(`ALTER TABLE detected_patterns ADD COLUMN wager_number INTEGER`);
      console.log('📊 Migration: added wager_number to detected_patterns');
    }
    if (!patternColumnNames.has('agent_login')) {
      await db.exec(`ALTER TABLE detected_patterns ADD COLUMN agent_login TEXT`);
      console.log('📊 Migration: added agent_login to detected_patterns');
    }

    await db.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
        provider TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        last_seq INTEGER,
        last_pull TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (provider, entity_type)
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS buckeye_sport_types (
        raw_value TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'seed',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS raw_api_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        response_json TEXT NOT NULL,
        agent_id TEXT,
        duration_ms INTEGER,
        request_params TEXT,
        status_code INTEGER
      )
    `);
    const rawLogColumns = await db.all<PragmaColumnRow>(`PRAGMA table_info(raw_api_logs)`);
    const rawLogColumnNames = new Set(rawLogColumns.map((c) => c.name));
    if (!rawLogColumnNames.has('status_code')) {
      await db.exec(`ALTER TABLE raw_api_logs ADD COLUMN status_code INTEGER`);
      console.log('📊 Migration: added status_code to raw_api_logs');
    }

    const sandboxQueueColumns = await db.all<PragmaColumnRow>(`PRAGMA table_info(sandbox_summary_queue)`);
    const sandboxQueueColumnNames = new Set(sandboxQueueColumns.map((c) => c.name));
    if (sandboxQueueColumns.length > 0 && !sandboxQueueColumnNames.has('processing_started_at')) {
      await db.exec(`ALTER TABLE sandbox_summary_queue ADD COLUMN processing_started_at TEXT`);
      console.log('📊 Migration: added processing_started_at to sandbox_summary_queue');
    }

    await db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS watermarks (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS master_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'buckeye',
        agent_id TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        balance REAL,
        available_balance REAL,
        percent_book REAL,
        open_wager_count INTEGER DEFAULT 0,
        config_web_reports_json TEXT,
        config_web_reports_pending_json TEXT,
        sports_type_json TEXT,
        authorizations_json TEXT,
        message_json TEXT,
        new_emails_count_json TEXT,
        account_info_json TEXT,
        raw_json TEXT NOT NULL DEFAULT '{}'
      )
    `);
    const masterColumns = await db.all<PragmaColumnRow>(`PRAGMA table_info(master_snapshots)`);
    const masterColumnNames = new Set(masterColumns.map((c) => c.name));
    if (!masterColumnNames.has('open_wager_count')) {
      await db.exec(`ALTER TABLE master_snapshots ADD COLUMN open_wager_count INTEGER DEFAULT 0`);
      console.log('📊 Migration: added open_wager_count to master_snapshots');
    }
    if (!masterColumnNames.has('provider')) {
      await db.exec(`ALTER TABLE master_snapshots ADD COLUMN provider TEXT NOT NULL DEFAULT 'buckeye'`);
      console.log('📊 Migration: added provider to master_snapshots');
    }
    if (!masterColumnNames.has('agent_id')) {
      await db.exec(`ALTER TABLE master_snapshots ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''`);
      console.log('📊 Migration: added agent_id to master_snapshots');
    }
    if (!masterColumnNames.has('config_web_reports_json')) {
      await db.exec(`ALTER TABLE master_snapshots ADD COLUMN config_web_reports_json TEXT`);
      console.log('📊 Migration: added config_web_reports_json to master_snapshots');
    }
    if (!masterColumnNames.has('config_web_reports_pending_json')) {
      await db.exec(`ALTER TABLE master_snapshots ADD COLUMN config_web_reports_pending_json TEXT`);
      console.log('📊 Migration: added config_web_reports_pending_json to master_snapshots');
    }
    if (!masterColumnNames.has('sports_type_json')) {
      await db.exec(`ALTER TABLE master_snapshots ADD COLUMN sports_type_json TEXT`);
      console.log('📊 Migration: added sports_type_json to master_snapshots');
    }
    if (!masterColumnNames.has('authorizations_json')) {
      await db.exec(`ALTER TABLE master_snapshots ADD COLUMN authorizations_json TEXT`);
      console.log('📊 Migration: added authorizations_json to master_snapshots');
    }
    if (!masterColumnNames.has('message_json')) {
      await db.exec(`ALTER TABLE master_snapshots ADD COLUMN message_json TEXT`);
      console.log('📊 Migration: added message_json to master_snapshots');
    }
    if (!masterColumnNames.has('new_emails_count_json')) {
      await db.exec(`ALTER TABLE master_snapshots ADD COLUMN new_emails_count_json TEXT`);
      console.log('📊 Migration: added new_emails_count_json to master_snapshots');
    }
    if (!masterColumnNames.has('raw_json')) {
      await db.exec(`ALTER TABLE master_snapshots ADD COLUMN raw_json TEXT NOT NULL DEFAULT '{}'`);
      console.log('📊 Migration: added raw_json to master_snapshots');
    }

    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_performance_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'buckeye',
        report_agent_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        login TEXT NOT NULL,
        report_type TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        sport TEXT,
        subsport TEXT,
        period TEXT,
        wager_type TEXT,
        bet_type TEXT,
        activity_tipo TEXT,
        free_play TEXT,
        wager_count INTEGER DEFAULT 0,
        risk REAL DEFAULT 0,
        to_win REAL DEFAULT 0,
        amount_won REAL DEFAULT 0,
        amount_lost REAL DEFAULT 0,
        volume REAL DEFAULT 0,
        net REAL DEFAULT 0,
        pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        raw_json TEXT NOT NULL DEFAULT '{}'
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS deposits (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'buckeye',
        customer_id TEXT NOT NULL,
        login TEXT,
        agent_id TEXT,
        agent_login TEXT,
        amount REAL NOT NULL DEFAULT 0,
        currency TEXT,
        method TEXT,
        ip_address TEXT,
        status TEXT,
        transaction_time TEXT NOT NULL,
        pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        raw_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS player_transactions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'buckeye',
        customer_id TEXT NOT NULL,
        login TEXT,
        agent_id TEXT,
        agent_login TEXT,
        document_number TEXT,
        tran_code TEXT,
        tran_type TEXT,
        amount REAL NOT NULL DEFAULT 0,
        balance REAL,
        hold_amount REAL,
        grade_num TEXT,
        description TEXT,
        entered_by TEXT,
        category TEXT NOT NULL DEFAULT 'other',
        transaction_time TEXT NOT NULL,
        pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        raw_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS customer_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'buckeye',
        customer_id TEXT NOT NULL,
        login TEXT,
        agent_id TEXT,
        agent_login TEXT,
        kyc_level TEXT,
        vip_status TEXT,
        email_masked TEXT,
        phone_masked TEXT,
        currency TEXT,
        source TEXT NOT NULL DEFAULT 'probe',
        snapshot_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        raw_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS player_source_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'buckeye',
        customer_id TEXT NOT NULL,
        login TEXT,
        agent_id TEXT,
        source_key TEXT NOT NULL,
        refresh_policy TEXT NOT NULL,
        ttl_seconds INTEGER NOT NULL DEFAULT 0,
        scale_class TEXT NOT NULL,
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        next_refresh_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider, customer_id, source_key)
      );

      CREATE TABLE IF NOT EXISTS player_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'buckeye',
        player_a TEXT NOT NULL,
        player_b TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'active',
        UNIQUE(provider, player_a, player_b, reason)
      );

      CREATE TABLE IF NOT EXISTS player_flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'buckeye',
        customer_id TEXT NOT NULL,
        flag_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        label TEXT NOT NULL,
        details TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS player_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL DEFAULT 'buckeye',
        customer_id TEXT NOT NULL,
        note_type TEXT NOT NULL DEFAULT 'general',
        body TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT,
        archived_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_deposits_customer_time ON deposits(customer_id, transaction_time DESC);
      CREATE INDEX IF NOT EXISTS idx_deposits_login_time ON deposits(login, transaction_time DESC);
      CREATE INDEX IF NOT EXISTS idx_deposits_ip_time ON deposits(ip_address, transaction_time DESC);
      CREATE INDEX IF NOT EXISTS idx_player_transactions_customer_time ON player_transactions(customer_id, transaction_time DESC);
      CREATE INDEX IF NOT EXISTS idx_player_transactions_login_time ON player_transactions(login, transaction_time DESC);
      CREATE INDEX IF NOT EXISTS idx_player_transactions_category_time ON player_transactions(category, transaction_time DESC);
      CREATE INDEX IF NOT EXISTS idx_player_transactions_category_customer ON player_transactions(category, customer_id, transaction_time DESC);
      CREATE INDEX IF NOT EXISTS idx_player_transactions_category_login ON player_transactions(category, login, transaction_time DESC);
      CREATE INDEX IF NOT EXISTS idx_customer_snapshots_customer_time ON customer_snapshots(customer_id, snapshot_time DESC);
      CREATE INDEX IF NOT EXISTS idx_customer_snapshots_login_time ON customer_snapshots(login, snapshot_time DESC);
      CREATE INDEX IF NOT EXISTS idx_player_source_status_customer ON player_source_status(customer_id, source_key);
      CREATE INDEX IF NOT EXISTS idx_player_source_status_next ON player_source_status(agent_id, next_refresh_at);
      CREATE INDEX IF NOT EXISTS idx_player_links_a ON player_links(player_a, detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_player_links_b ON player_links(player_b, detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_player_flags_customer ON player_flags(customer_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_player_notes_customer ON player_notes(customer_id, created_at DESC);
    `);

    const agentColumns = await db.all<PragmaColumnRow>(`PRAGMA table_info(agents)`);
    const agentColumnNames = new Set(agentColumns.map((c) => c.name));
    const agentAdds: Array<[string, string]> = [
      ['login', 'TEXT'],
      ['display_name', 'TEXT'],
      ['level', 'INTEGER'],
      ['child_count', 'INTEGER DEFAULT 0'],
      ['player_count', 'INTEGER DEFAULT 0'],
      ['seq_number', 'INTEGER'],
      ['agent_type', 'TEXT'],
      ['head_count_rate_m', 'REAL'],
      ['inet_head_count_rate_m', 'REAL'],
      ['casino_head_count_rate_m', 'REAL'],
      ['live_betting_rate_m', 'REAL'],
      ['live_betting2_rate_m', 'REAL'],
      ['live_casino_rate_m', 'REAL'],
      ['prop_builder_rate_m', 'REAL'],
      ['flash_bets_rate', 'REAL'],
      ['ext_props_rate', 'REAL'],
      ['crash_rate', 'REAL'],
      ['fantasy_rate', 'REAL'],
      ['amigo_tech_rate', 'REAL'],
      ['raw_json', 'TEXT'],
    ];
    for (const [name, type] of agentAdds) {
      if (!agentColumnNames.has(name)) {
        await db.exec(`ALTER TABLE agents ADD COLUMN ${name} ${type}`);
        console.log(`📊 Migration: added ${name} to agents`);
      }
    }

    const playerColumns = await db.all<PragmaColumnRow>(`PRAGMA table_info(players)`);
    const playerColumnNames = new Set(playerColumns.map((c) => c.name));
    const playerAdds: Array<[string, string]> = [
      ['provider', "TEXT NOT NULL DEFAULT 'buckeye'"],
      ['login', 'TEXT'],
      ['display_name', 'TEXT'],
      ['agent_login', 'TEXT'],
      ['last_seen', 'TEXT'],
      ['raw_json', 'TEXT'],
    ];
    for (const [name, type] of playerAdds) {
      if (!playerColumnNames.has(name)) {
        await db.exec(`ALTER TABLE players ADD COLUMN ${name} ${type}`);
        console.log(`📊 Migration: added ${name} to players`);
      }
    }

    await db.exec(`
      DROP INDEX IF EXISTS idx_agents_provider_login_unique;
      CREATE INDEX IF NOT EXISTS idx_agents_provider_login ON agents(provider, login);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_players_provider_login_unique ON players(provider, login);
      CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
      CREATE INDEX IF NOT EXISTS idx_agents_seq ON agents(seq_number);
      CREATE INDEX IF NOT EXISTS idx_players_agent_id ON players(agent_id);
      CREATE INDEX IF NOT EXISTS idx_players_agent_login ON players(agent_login);
      CREATE INDEX IF NOT EXISTS idx_agent_hierarchy_parent ON agent_hierarchy(provider, parent_agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_hierarchy_level ON agent_hierarchy(provider, level);
      CREATE INDEX IF NOT EXISTS idx_player_agent_map_agent ON player_agent_map(provider, agent_id);
      CREATE INDEX IF NOT EXISTS idx_player_agent_map_login ON player_agent_map(provider, player_login);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_provider_entity ON ingestion_checkpoints(provider, entity_type);
      CREATE INDEX IF NOT EXISTS idx_buckeye_sport_types_label ON buckeye_sport_types(label);
      CREATE INDEX IF NOT EXISTS idx_raw_logs_endpoint_time ON raw_api_logs(endpoint, fetched_at);
      CREATE INDEX IF NOT EXISTS idx_raw_logs_agent ON raw_api_logs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_raw_logs_fetched_at ON raw_api_logs(fetched_at);
      CREATE INDEX IF NOT EXISTS idx_agent_perf_customer ON agent_performance_snapshots(customer_id, pulled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_perf_login ON agent_performance_snapshots(login, pulled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_perf_agent ON agent_performance_snapshots(agent_id, pulled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_perf_report ON agent_performance_snapshots(report_agent_id, start_date, end_date);
    `);
    const wagerSeq = await db.get<WagerSequenceRow>(`SELECT MAX(wager_number) as max_seq, COUNT(*) as row_count FROM wagers`);
    if (wagerSeq?.max_seq) {
      await db.run(
        `INSERT INTO ingestion_checkpoints (provider, entity_type, last_seq, last_pull, metadata)
         VALUES ('buckeye', 'wagers', ?, CURRENT_TIMESTAMP, ?)
         ON CONFLICT(provider, entity_type) DO UPDATE SET
          last_seq = MAX(COALESCE(ingestion_checkpoints.last_seq, 0), excluded.last_seq),
          last_pull = excluded.last_pull,
          metadata = excluded.metadata`,
        [
          Number(wagerSeq.max_seq),
          JSON.stringify({
            source: 'existing_wagers_table',
            rowCount: Number(wagerSeq.row_count) || 0,
          }),
        ]
      );
    }
    // Risk Command Center: migrate new columns
    const riskFlagColumns = await db.all<PragmaColumnRow>(`PRAGMA table_info(ai_risk_flags)`);
    const riskFlagColumnNames = new Set(riskFlagColumns.map((c) => c.name));
    if (!riskFlagColumnNames.has('reviewer_id')) {
      await db.exec(`ALTER TABLE ai_risk_flags ADD COLUMN reviewer_id TEXT`);
      console.log('📊 Migration: added reviewer_id to ai_risk_flags');
    }
    if (!riskFlagColumnNames.has('reviewed_at')) {
      await db.exec(`ALTER TABLE ai_risk_flags ADD COLUMN reviewed_at TEXT`);
      console.log('📊 Migration: added reviewed_at to ai_risk_flags');
    }

    const featureColumns = await db.all<PragmaColumnRow>(`PRAGMA table_info(customer_features)`);
    const featureColumnNames = new Set(featureColumns.map((c) => c.name));
    if (!featureColumnNames.has('clv')) {
      await db.exec(`ALTER TABLE customer_features ADD COLUMN clv REAL NOT NULL DEFAULT 0`);
      console.log('📊 Migration: added clv to customer_features');
    }
    if (!featureColumnNames.has('feature_json')) {
      await db.exec(`ALTER TABLE customer_features ADD COLUMN feature_json TEXT NOT NULL DEFAULT '{}'`);
      console.log('📊 Migration: added feature_json to customer_features');
    }

    await db.exec(`
      CREATE TABLE IF NOT EXISTS enforcement_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL UNIQUE,
        customer_id TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        suggested_max_exposure REAL,
        suggested_wager_limit REAL,
        suggested_action TEXT,
        ai_confidence REAL,
        ai_summary TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        viewed_at TEXT,
        viewed_by TEXT,
        applied_at TEXT,
        applied_by TEXT,
        buckeye_admin_url TEXT,
        reminder_count INTEGER NOT NULL DEFAULT 0,
        last_reminder_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL DEFAULT (datetime('now', '+30 minutes')),
        FOREIGN KEY (position_id) REFERENCES risk_positions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_enforcement_pending ON enforcement_queue(status, risk_level, created_at);
      CREATE INDEX IF NOT EXISTS idx_enforcement_customer ON enforcement_queue(customer_id, status);

      CREATE TABLE IF NOT EXISTS wager_violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wager_id INTEGER NOT NULL,
        customer_id TEXT NOT NULL,
        violation_type TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}',
        detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(wager_id, violation_type)
      )
    `);
    await dedupeWagerViolations(db);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_violations_customer ON wager_violations(customer_id, detected_at DESC)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_violations_type ON wager_violations(violation_type, detected_at DESC)`);
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wv_unique_violation ON wager_violations(wager_id, violation_type)`);
    console.log('📊 Migration: ensured wager_violations table');

    // ─── Telegram Topic Management: agent supergroups & topics ────────────
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_supergroups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supergroup_chat_id TEXT NOT NULL UNIQUE,
        owner_agent_login TEXT,
        purpose TEXT NOT NULL DEFAULT 'agent',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_supergroup_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supergroup_id INTEGER NOT NULL,
        topic_thread_id INTEGER NOT NULL,
        topic_name TEXT NOT NULL,
        purpose TEXT NOT NULL,
        topic_icon TEXT,
        topic_hex_color TEXT,
        is_managed INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (supergroup_id) REFERENCES agent_supergroups(id),
        UNIQUE(supergroup_id, topic_thread_id)
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_supergroup_topics_purpose ON agent_supergroup_topics(supergroup_id, purpose)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_supergroup_chat_id ON agent_supergroups(supergroup_chat_id)`);
    console.log('📊 Migration: ensured agent_supergroups and agent_supergroup_topics tables');

    // Migrate legacy telegram_topics into new schema (idempotent)
    const legacyTopics = await db.all<{
      id: number;
      agent_login: string;
      topic_name: string;
      purpose: string | null;
      topic_icon: string | null;
      topic_hex_color: string | null;
      topic_icon_color: number | null;
      topic_thread_id: number | null;
      supergroup_chat_id: string | null;
    }>(`SELECT * FROM telegram_topics WHERE supergroup_chat_id IS NOT NULL AND topic_thread_id IS NOT NULL`);

    for (const t of legacyTopics) {
      if (!t.supergroup_chat_id || !t.topic_thread_id) continue;

      const supergroup = await db.get<{ id: number }>(
        `SELECT id FROM agent_supergroups WHERE supergroup_chat_id = ?`,
        [t.supergroup_chat_id]
      );

      let supergroupId: number;
      if (supergroup) {
        supergroupId = supergroup.id;
      } else {
        await db.run(
          `INSERT OR IGNORE INTO agent_supergroups (supergroup_chat_id, owner_agent_login, purpose)
           VALUES (?, ?, ?)`,
          [t.supergroup_chat_id, t.agent_login, 'agent']
        );
        const inserted = await db.get<{ id: number }>(
          `SELECT id FROM agent_supergroups WHERE supergroup_chat_id = ?`,
          [t.supergroup_chat_id]
        );
        supergroupId = inserted!.id;
      }

      await db.run(
        `INSERT OR IGNORE INTO agent_supergroup_topics
         (supergroup_id, topic_thread_id, topic_name, purpose, topic_icon, topic_hex_color, is_managed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          supergroupId,
          t.topic_thread_id,
          t.topic_name,
          t.purpose || t.topic_name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
          t.topic_icon,
          t.topic_hex_color,
          1,
        ]
      );
    }
    if (legacyTopics.length > 0) {
      console.log(`📊 Migration: migrated ${legacyTopics.length} legacy telegram_topics into agent_supergroup_topics`);
    }

    // ─── Telegram Messages (local audit/history) ──────────────────────────
    await db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER NOT NULL,
        telegram_message_id INTEGER,
        text TEXT NOT NULL,
        sender TEXT NOT NULL DEFAULT 'bot',
        parse_mode TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (topic_id) REFERENCES agent_supergroup_topics(id)
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_telegram_messages_topic ON telegram_messages(topic_id, sent_at)`);
    console.log('📊 Migration: ensured telegram_messages table');

    await seedBuckeyeSportTypes(db);
  } catch (err) {
    console.error('📊 Migration error:', err);
    throw new Error(`Database migration failed: ${errorMessage(err)}`, { cause: err });
  }
}

async function removeLegacyWagerTypeConstraint(db: Database): Promise<void> {
  const row = await db.get<{ sql: string | null }>(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wagers'`
  );
  if (!row?.sql || !row.sql.includes('wager_type IN')) return;

  // Wrap the full table rebuild in a transaction for safety
  await db.exec('BEGIN IMMEDIATE');
  try {
    await db.exec('DROP TABLE IF EXISTS wagers_rebuilt');
    await db.exec(`
      CREATE TABLE wagers_rebuilt (
        wager_number INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        login TEXT NOT NULL,
        wager_type TEXT,
        amount_wagered INTEGER NOT NULL,
        to_win_amount INTEGER NOT NULL,
        volume_amount INTEGER NOT NULL,
        insert_datetime TEXT NOT NULL,
        ticket_writer TEXT NOT NULL,
        short_desc TEXT NOT NULL,
        vip TEXT NOT NULL,
        agent_login TEXT NOT NULL,
        sport TEXT,
        parsed_game TEXT,
        parsed_market TEXT,
        parsed_side TEXT,
        parsed_price REAL,
        parsed_period TEXT,
        matched_event_id TEXT,
        pin_reference_json TEXT,
        raw_json TEXT,
        scraped_at TEXT NOT NULL
      )
    `);
    await db.exec(`
      INSERT OR REPLACE INTO wagers_rebuilt (
        wager_number, agent_id, customer_id, login, wager_type, amount_wagered,
        to_win_amount, volume_amount, insert_datetime, ticket_writer, short_desc,
        vip, agent_login, sport, parsed_game, parsed_market, parsed_side,
        parsed_price, parsed_period, matched_event_id, pin_reference_json, raw_json,
        scraped_at
      )
      SELECT
        wager_number, agent_id, customer_id, login, wager_type, amount_wagered,
        to_win_amount, volume_amount, insert_datetime, ticket_writer, short_desc,
        vip, agent_login, sport, parsed_game, parsed_market, parsed_side,
        parsed_price, parsed_period, matched_event_id, pin_reference_json, raw_json,
        scraped_at
      FROM wagers
    `);
    await db.exec('DROP TABLE wagers');
    await db.exec('ALTER TABLE wagers_rebuilt RENAME TO wagers');
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_wagers_agent ON wagers(agent_login);
      CREATE INDEX IF NOT EXISTS idx_wagers_datetime ON wagers(insert_datetime);
      CREATE INDEX IF NOT EXISTS idx_wagers_alert ON wagers(ticket_writer) WHERE ticket_writer = 'ALERT';
      CREATE INDEX IF NOT EXISTS idx_wagers_sport ON wagers(sport);
      CREATE INDEX IF NOT EXISTS idx_wagers_login_datetime ON wagers(login, insert_datetime DESC);
      CREATE INDEX IF NOT EXISTS idx_wagers_agent_datetime ON wagers(agent_login, insert_datetime DESC);
      CREATE INDEX IF NOT EXISTS idx_wagers_ticket_datetime ON wagers(ticket_writer, insert_datetime DESC);
      CREATE INDEX IF NOT EXISTS idx_wagers_sport_datetime ON wagers(sport, insert_datetime DESC);
      CREATE INDEX IF NOT EXISTS idx_wagers_event_time ON wagers(matched_event_id, insert_datetime DESC);
      CREATE INDEX IF NOT EXISTS idx_wagers_game_side_time ON wagers(parsed_game, parsed_market, parsed_side, insert_datetime DESC);
    `);
    await db.exec('COMMIT');
    console.log('📊 Migration: rebuilt wagers without legacy wager_type CHECK constraint');
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => { });
    throw err;
  }
}

async function dedupeWagerViolations(db: Database): Promise<void> {
  await db.exec(`
    DELETE FROM wager_violations
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM wager_violations
      GROUP BY wager_id, violation_type
    )
  `);
}

export async function seedBuckeyeSportTypes(db: Database): Promise<void> {
  for (const [index, rawValue] of BUCKEYE_SPORT_TYPES.entries()) {
    await db.run(
      `INSERT INTO buckeye_sport_types (raw_value, label, sort_order, source, updated_at)
       VALUES (?, ?, ?, 'seed', CURRENT_TIMESTAMP)
       ON CONFLICT(raw_value) DO UPDATE SET
        label = excluded.label,
        sort_order = excluded.sort_order,
        source = excluded.source,
        updated_at = CURRENT_TIMESTAMP`,
      [rawValue, rawValue.trim(), index]
    );
  }
}

// Encryption utilities for storing credentials
export function encryptCredentials(data: unknown, key: string): string {
  // Use Bun's native crypto for random IV (faster than Node crypto.randomBytes)
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(iv));

  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${Buffer.from(iv).toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decryptCredentials(encryptedData: string, key: string): unknown {
  const [iv, authTag, encrypted] = encryptedData.split(':');

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'hex'),
    Buffer.from(iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
