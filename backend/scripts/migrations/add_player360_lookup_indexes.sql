-- ============================================================
-- Migration: add_player360_lookup_indexes.sql
-- Purpose: Speed Player 360 profile lookups that filter by
--          either customer_id or login across large archive tables.
-- Date: 2026-05-09
-- ============================================================

PRAGMA foreign_keys = OFF;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wager_archive_login_time
  ON wager_archive(login, insert_date_time DESC);

CREATE INDEX IF NOT EXISTS idx_deposits_login_time
  ON deposits(login, transaction_time DESC);

CREATE INDEX IF NOT EXISTS idx_player_transactions_login_time
  ON player_transactions(login, transaction_time DESC);

CREATE INDEX IF NOT EXISTS idx_player_transactions_category_customer
  ON player_transactions(category, customer_id, transaction_time DESC);

CREATE INDEX IF NOT EXISTS idx_player_transactions_category_login
  ON player_transactions(category, login, transaction_time DESC);

CREATE INDEX IF NOT EXISTS idx_customer_snapshots_login_time
  ON customer_snapshots(login, snapshot_time DESC);

CREATE INDEX IF NOT EXISTS idx_agent_perf_login
  ON agent_performance_snapshots(login, pulled_at DESC);

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('add_player360_lookup_indexes');

COMMIT;

PRAGMA foreign_keys = ON;
