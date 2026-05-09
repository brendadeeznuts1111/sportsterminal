-- ============================================================
-- Migration: add_player360_tables.sql
-- Purpose: Player 360 foundation tables for financial/account
--          intelligence, linked-account detection, and operator notes.
-- Date: 2026-05-09
-- Notes:
--   - Idempotent for local SQLite databases.
--   - Pollers are intentionally not enabled by this migration.
-- ============================================================

PRAGMA foreign_keys = OFF;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  pulled_at TEXT NOT NULL DEFAULT (datetime('now')),
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_deposits_customer_time ON deposits(customer_id, transaction_time DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_ip_time ON deposits(ip_address, transaction_time DESC);

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
  snapshot_time TEXT NOT NULL DEFAULT (datetime('now')),
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_customer_snapshots_customer_time ON customer_snapshots(customer_id, snapshot_time DESC);

CREATE TABLE IF NOT EXISTS player_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'buckeye',
  player_a TEXT NOT NULL,
  player_b TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(provider, player_a, player_b, reason)
);

CREATE INDEX IF NOT EXISTS idx_player_links_a ON player_links(player_a, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_links_b ON player_links(player_b, detected_at DESC);

CREATE TABLE IF NOT EXISTS player_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'buckeye',
  customer_id TEXT NOT NULL,
  flag_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  label TEXT NOT NULL,
  details TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_player_flags_customer ON player_flags(customer_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS player_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'buckeye',
  customer_id TEXT NOT NULL,
  note_type TEXT NOT NULL DEFAULT 'general',
  body TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_player_notes_customer ON player_notes(customer_id, created_at DESC);

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('add_player360_tables');

COMMIT;

PRAGMA foreign_keys = ON;
