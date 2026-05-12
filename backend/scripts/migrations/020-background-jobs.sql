CREATE TABLE IF NOT EXISTS background_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  status TEXT CHECK(status IN ('running','completed','failed')) NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_background_jobs_name_started
  ON background_jobs(job_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_background_jobs_status_started
  ON background_jobs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS hierarchy_sync_config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO hierarchy_sync_config (id, enabled, interval_minutes)
VALUES (1, 1, 30);
