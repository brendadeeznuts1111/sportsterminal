import { Database as BunDatabase } from 'bun:sqlite';
import crypto from 'crypto';

const dbPath = normalizeDatabasePath(process.env.DATABASE_URL || './data/terminal.db');

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

export interface DbRunResult {
  lastID: number;
  changes: number;
}

export class AppDatabase {
  private db: BunDatabase;

  constructor(filename: string) {
    this.db = new BunDatabase(filename);
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<DbRunResult> {
    const query = this.db.query(sql);
    const result = query.run(...params);
    return {
      lastID: Number(this.db.query('SELECT last_insert_rowid() AS id').get()?.id ?? 0),
      changes: result.changes,
    };
  }

  async get<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
    return this.db.query(sql).get(...params) as T | null;
  }

  async all<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.query(sql).all(...params) as T[];
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export type Database = AppDatabase;

export async function initDatabase(): Promise<AppDatabase> {
  const db = new AppDatabase(dbPath);

  // Enable foreign keys
  await db.exec('PRAGMA foreign_keys = ON');

  // Create tables
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
      wager_type TEXT CHECK(wager_type IN ('L','M','S','P','E','T','C')),
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
    CREATE INDEX IF NOT EXISTS idx_agent_perf_customer ON agent_performance_snapshots(customer_id, pulled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_perf_agent ON agent_performance_snapshots(agent_id, pulled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_perf_report ON agent_performance_snapshots(report_agent_id, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_odds_event ON odds(event_id);
    CREATE INDEX IF NOT EXISTS idx_wagers_agent ON wagers(agent_login);
    CREATE INDEX IF NOT EXISTS idx_wagers_datetime ON wagers(insert_datetime);
    CREATE INDEX IF NOT EXISTS idx_wagers_alert ON wagers(ticket_writer) WHERE ticket_writer = 'ALERT';
    CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON alerts(is_resolved) WHERE is_resolved = 0;
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

    CREATE INDEX IF NOT EXISTS idx_odds_snapshots_event ON odds_snapshots(event_id);
    CREATE INDEX IF NOT EXISTS idx_line_movements_event ON line_movements(event_id, book, market);
    CREATE INDEX IF NOT EXISTS idx_line_movements_time ON line_movements(recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_time ON detected_patterns(detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_event ON detected_patterns(event_id, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_type ON detected_patterns(type, detected_at DESC);
  `);

  console.log('📊 Database tables created');
  await migrateDatabase(db);
  await createPostMigrationIndexes(db);
  await seedBuckeyeSportTypes(db);
  return db;
}

async function createPostMigrationIndexes(db: AppDatabase): Promise<void> {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_category ON detected_patterns(category, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_agent ON detected_patterns(agent_login, detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_detected_patterns_wager ON detected_patterns(wager_number);
    CREATE INDEX IF NOT EXISTS idx_pattern_agents_agent ON pattern_agents(agent_login);
    CREATE INDEX IF NOT EXISTS idx_access_logs_ip_time ON access_logs(ip_address, access_datetime DESC);
    CREATE INDEX IF NOT EXISTS idx_access_logs_login_time ON access_logs(login_id, access_datetime DESC);
    CREATE INDEX IF NOT EXISTS idx_wagers_event_time ON wagers(matched_event_id, insert_datetime DESC);
    CREATE INDEX IF NOT EXISTS idx_wagers_game_side_time ON wagers(parsed_game, parsed_market, parsed_side, insert_datetime DESC);
  `);
}

/**
 * Migrate existing database tables to match current schema.
 * SQLite does not support ALTER TABLE DROP COLUMN, but ADD COLUMN is safe.
 */
export async function migrateDatabase(db: any) {
  try {
    // Check if odds_snapshots has spread_home_price
    const columns = await db.all(`PRAGMA table_info(odds_snapshots)`);
    const hasSpreadHomePrice = columns.some((c: any) => c.name === 'spread_home_price');
    const hasSpreadAwayPrice = columns.some((c: any) => c.name === 'spread_away_price');

    if (!hasSpreadHomePrice) {
      await db.exec(`ALTER TABLE odds_snapshots ADD COLUMN spread_home_price REAL`);
      console.log('📊 Migration: added spread_home_price to odds_snapshots');
    }
    if (!hasSpreadAwayPrice) {
      await db.exec(`ALTER TABLE odds_snapshots ADD COLUMN spread_away_price REAL`);
      console.log('📊 Migration: added spread_away_price to odds_snapshots');
    }

    const wagerColumns = await db.all(`PRAGMA table_info(wagers)`);
    const wagerColumnNames = new Set(wagerColumns.map((c: any) => c.name));
    const wagerAdds: Array<[string, string]> = [
      ['parsed_game', 'TEXT'],
      ['parsed_market', 'TEXT'],
      ['parsed_side', 'TEXT'],
      ['parsed_price', 'REAL'],
      ['parsed_period', 'TEXT'],
      ['matched_event_id', 'TEXT'],
      ['pin_reference_json', 'TEXT'],
    ];
    for (const [name, type] of wagerAdds) {
      if (!wagerColumnNames.has(name)) {
        await db.exec(`ALTER TABLE wagers ADD COLUMN ${name} ${type}`);
        console.log(`📊 Migration: added ${name} to wagers`);
      }
    }

    const patternColumns = await db.all(`PRAGMA table_info(detected_patterns)`);
    const patternColumnNames = new Set(patternColumns.map((c: any) => c.name));
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

    const agentColumns = await db.all(`PRAGMA table_info(agents)`);
    const agentColumnNames = new Set(agentColumns.map((c: any) => c.name));
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

    const playerColumns = await db.all(`PRAGMA table_info(players)`);
    const playerColumnNames = new Set(playerColumns.map((c: any) => c.name));
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_provider_login_unique ON agents(provider, login);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_players_provider_login_unique ON players(provider, login);
      CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
      CREATE INDEX IF NOT EXISTS idx_agents_seq ON agents(seq_number);
      CREATE INDEX IF NOT EXISTS idx_players_agent_id ON players(agent_id);
      CREATE INDEX IF NOT EXISTS idx_players_agent_login ON players(agent_login);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_provider_entity ON ingestion_checkpoints(provider, entity_type);
      CREATE INDEX IF NOT EXISTS idx_buckeye_sport_types_label ON buckeye_sport_types(label);
      CREATE INDEX IF NOT EXISTS idx_agent_perf_customer ON agent_performance_snapshots(customer_id, pulled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_perf_agent ON agent_performance_snapshots(agent_id, pulled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_perf_report ON agent_performance_snapshots(report_agent_id, start_date, end_date);
    `);
    const wagerSeq = await db.get(`SELECT MAX(wager_number) as max_seq, COUNT(*) as row_count FROM wagers`);
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
    await seedBuckeyeSportTypes(db);
  } catch (err) {
    console.error('📊 Migration error:', err);
  }
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
export function encryptCredentials(data: any, key: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);

  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decryptCredentials(encryptedData: string, key: string): any {
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
