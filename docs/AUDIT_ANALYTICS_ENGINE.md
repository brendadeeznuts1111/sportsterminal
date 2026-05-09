# Audit Analytics Engine

This is the implementation contract for the Buckeye audit and analytics layer. It exists so raw provider data, derived analytics, frontend dashboards, retention jobs, and tests all share the same vocabulary.

## Goals

- Preserve original Buckeye responses before transformation, with sensitive fields redacted.
- Keep polling restart-safe through durable checkpoints and scheduler state.
- Store complete wager history independently of the live `wagers` working table.
- Emit WebSocket deltas only after novel durable inserts.
- Provide analytics endpoints for velocity, live-vs-pre, access logs, master history, performance summaries, and CSV exports.
- Keep SQLite reliable under local production load through WAL mode, transaction batching, and time/agent/customer indexes.

## Core Tables

| Table | Purpose | Notes |
|-------|---------|-------|
| `raw_api_logs` | Redacted response audit trail for Buckeye-facing API routes and pollers | Includes endpoint, status code, duration, agent, params, response JSON |
| `wager_archive` | Immutable archive of Buckeye wagers | Uses `INSERT OR IGNORE` by `wager_number` |
| `access_logs` | Buckeye web access/IP tracker rows | Existing app schema uses `id`, `login_id`, `access_datetime`, `log_type`, and raw JSON |
| `master_snapshots` | Master account balance/book snapshots | Pull from account info endpoints |
| `weekly_figures` | Weekly figure report archive | Stores raw report plus easy columns when available |
| `agent_performance` | Raw agent performance report archive | Complements normalized `agent_performance_snapshots` |
| `scheduler_state` / `watermarks` | Restart-safe poller cursors | Keys such as `last_access_log_poll`, `last_master_snapshot`, `last_weekly_figures_poll` |
| `audit_logs` | Operator/system action trail | For credential, webhook, alert, export, and retention activity |
| `schema_migrations` | Applied migration ledger | Prevents reapplying one-shot migration files |

## Redaction Rules

`redactSensitiveFields()` must run before data reaches `raw_api_logs`. The default deny-list includes:

- `password`, `pin`, `PIN`
- `token`, `bearer`, `authorization`, `authToken`, `apiKey`, `secret`
- `cf_clearance`, `cf_bm`, `cookie`
- `SMSPhoneNumber`, `phone`, `email`
- `creditCard*`, `cardNumber`, `cvv`
- `ssn`, `taxId`, `bankAccount`, `routingNumber`

Prefer redacting entire values as `REDACTED` instead of partial masking unless there is an explicit operational need for the suffix/prefix.

## Polling and Checkpoint Rules

- Read the poller cursor from `watermarks`, `scheduler_state`, or `ingestion_checkpoints` before remote calls.
- Fetch only a bounded window when the provider supports it.
- Insert new rows in a transaction when writing more than one row.
- Update the cursor only after all inserts in that batch succeed.
- On failure, leave the previous cursor intact and expose the last error in Status.

Recommended keys:

| Key | Value |
|-----|-------|
| `last_access_log_poll` | ISO timestamp of newest stored access log |
| `last_master_snapshot` | ISO timestamp of last successful account snapshot |
| `last_weekly_figures_poll` | JSON containing last window/agent |
| `last_agent_performance_poll` | JSON containing last window/agent |
| `last_retention_job` | ISO timestamp plus row counts in JSON |

## WebSocket Rules

For novel wager inserts:

1. Normalize and correlate the wager.
2. `INSERT OR IGNORE` into `wager_archive`.
3. If the insert changed one row, emit `wager.new` with a lightweight payload.
4. Persist patterns and alerts after the archive write.

Suggested payload:

```json
{
  "type": "wager.new",
  "wager_number": 750038740,
  "amount_wagered": 25,
  "insert_date_time": "2026-05-09T12:00:00Z",
  "agent_login": "BILLY666"
}
```

## Frontend Requirements

The future Performance tab should include:

- Master health card with last snapshot age and live/stale indicator.
- Betting velocity chart with auto-pause when the tab is hidden.
- Live-vs-pre split for the selected date/window.
- Access log table with clickable IP filters and first-seen labels.
- Agent performance table with virtualization when rows exceed 500.
- Export controls with progress, estimated row count, and generated file size.
- Loading, empty, stale, and error states matching the existing dark terminal theme.
- Keyboard support: `/` focuses search and `?` opens shortcut help.

## Retention

Default retention should favor safety:

- Keep `wager_archive`, `access_logs`, and performance summaries unless explicitly configured otherwise.
- Prune `raw_api_logs` after `RAW_API_LOG_RETENTION_DAYS` once aggregate tables are stable.
- Record retention runs in `audit_logs` with rows scanned, rows deleted, duration, and errors.
- Surface disk usage and last cleanup in Status.

## Testing Matrix

| Phase | Required Checks |
|-------|-----------------|
| Migration | Tables exist, indexes exist, `PRAGMA integrity_check` returns `ok` |
| Redaction | Sensitive nested fields are redacted while ordinary fields survive |
| Raw logging | Success and error responses log status code and do not consume response body |
| Wager archive | Duplicate wager does not broadcast twice |
| Pollers | Cursor updates only after successful insert |
| API | Filters, pagination, and empty states behave consistently |
| Frontend | Loading, error, keyboard, export progress, and live WebSocket update smoke tests |
