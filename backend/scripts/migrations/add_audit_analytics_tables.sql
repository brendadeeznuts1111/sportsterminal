-- ============================================================
-- Migration: add_audit_analytics_tables.sql
-- Purpose: Audit & Analytics Engine baseline for Sports Terminal
-- Date: 2026-05-09
-- Notes:
--   - Idempotent for local SQLite databases.
--   - Uses the app's current access_logs schema so this migration cannot
--     create a table shape that breaks runtime pattern/IP queries.
-- ============================================================

PRAGMA foreign_keys = OFF;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS raw_api_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  response_json TEXT NOT NULL,
  agent_id TEXT,
  duration_ms INTEGER,
  request_params TEXT,
  status_code INTEGER
);

CREATE INDEX IF NOT EXISTS idx_raw_logs_endpoint_time ON raw_api_logs(endpoint, fetched_at);
CREATE INDEX IF NOT EXISTS idx_raw_logs_agent ON raw_api_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_raw_logs_fetched_at ON raw_api_logs(fetched_at);

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
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw_json TEXT NOT NULL,
  sport TEXT,
  league TEXT,
  price REAL
);

CREATE INDEX IF NOT EXISTS idx_wager_archive_time ON wager_archive(insert_date_time);
CREATE INDEX IF NOT EXISTS idx_wager_archive_agent_time ON wager_archive(agent_login, insert_date_time);
CREATE INDEX IF NOT EXISTS idx_wager_archive_customer ON wager_archive(customer_id);
CREATE INDEX IF NOT EXISTS idx_wager_archive_ingested ON wager_archive(ingested_at);

-- Buckeye IP tracker / web access log rows.
-- Keep this schema aligned with backend/src/database.ts and PatternService.
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

CREATE INDEX IF NOT EXISTS idx_access_logs_ip_time ON access_logs(ip_address, access_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_access_logs_login_time ON access_logs(login_id, access_datetime DESC);

CREATE TABLE IF NOT EXISTS master_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  balance REAL,
  available_balance REAL,
  percent_book REAL,
  open_wager_count INTEGER DEFAULT 0,
  account_info_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_master_snapshots_time ON master_snapshots(timestamp);

CREATE TABLE IF NOT EXISTS weekly_figures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  week_start_date TEXT NOT NULL,
  sport TEXT,
  handle REAL,
  win_loss REAL,
  wager_type TEXT,
  raw_json TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_weekly_figures_agent_week ON weekly_figures(agent_id, week_start_date);

CREATE TABLE IF NOT EXISTS agent_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  performance_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_performance_agent_time ON agent_performance(agent_id, recorded_at);

CREATE TABLE IF NOT EXISTS scheduler_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watermarks (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('add_audit_analytics_tables');

COMMIT;

PRAGMA foreign_keys = ON;
