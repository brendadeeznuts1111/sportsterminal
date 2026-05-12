#!/usr/bin/env python3
"""
Export wager rows enriched with player and agent hierarchy context for AI/ML.

Default output is CSV so the script runs with the Python standard library. Use
`--format parquet` when pandas plus a Parquet engine such as pyarrow is present.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Iterable


DEFAULT_DB_CANDIDATES = (
    "backend/data/terminal.db",
    "data/terminal.db",
)


ENRICHED_WAGERS_SQL = """
SELECT
  w.id AS archive_id,
  w.wager_number,
  w.agent_id AS wager_agent_id,
  w.agent_login AS wager_agent_login,
  w.customer_id,
  w.login AS player_login,
  w.wager_type,
  w.amount_wagered,
  w.to_win_amount,
  w.volume_amount,
  w.insert_date_time,
  w.ticket_writer,
  w.short_desc_raw,
  w.vip,
  w.sport,
  w.league,
  w.price,
  w.ingested_at,
  p.id AS mapped_player_id,
  p.name AS player_name,
  p.display_name AS player_display_name,
  p.agent_id AS mapped_agent_id,
  p.agent_login AS mapped_agent_login,
  p.net_pnl,
  p.ytd_pnl,
  p.exposure,
  p.credit_limit,
  p.status AS player_status,
  ah.agent_id AS hierarchy_agent_id,
  ah.login AS hierarchy_agent_login,
  ah.display_name AS agent_display_name,
  ah.parent_agent_id,
  ah.level AS agent_level,
  ah.agent_type,
  ah.seq_number AS agent_seq_number,
  ah.child_count,
  ah.player_count,
  ah.head_count_rate_m,
  ah.inet_head_count_rate_m,
  ah.casino_head_count_rate_m,
  ah.live_betting_rate_m,
  ah.live_betting2_rate_m,
  ah.live_casino_rate_m,
  ah.prop_builder_rate_m,
  ah.flash_bets_rate,
  ah.ext_props_rate,
  ah.crash_rate,
  ah.fantasy_rate,
  ah.amigo_tech_rate,
  CASE WHEN COALESCE(ah.live_betting_rate_m, 0) <> 0 OR COALESCE(ah.live_betting2_rate_m, 0) <> 0 THEN 1 ELSE 0 END AS has_live_betting_rate,
  CASE WHEN COALESCE(ah.prop_builder_rate_m, 0) <> 0 THEN 1 ELSE 0 END AS has_prop_builder_rate
FROM wager_archive w
LEFT JOIN players p
  ON p.provider = 'buckeye'
 AND (
      p.id = w.customer_id
      OR p.login = w.login
      OR p.id = w.login
    )
LEFT JOIN agent_hierarchy ah
  ON ah.provider = 'buckeye'
 AND (
      ah.agent_id = p.agent_id
      OR ah.login = p.agent_login
      OR ah.login = w.agent_login
      OR ah.agent_id = w.agent_id
    )
WHERE (:agent_login IS NULL OR COALESCE(p.agent_login, w.agent_login, ah.login) = :agent_login)
  AND (:customer_id IS NULL OR COALESCE(w.customer_id, w.login, p.id) = :customer_id)
  AND (:since IS NULL OR w.insert_date_time >= :since)
  AND (:until IS NULL OR w.insert_date_time < :until)
ORDER BY w.insert_date_time
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export enriched wager rows for AI/ML training.")
    parser.add_argument("--db", default=os.environ.get("DATABASE_URL"), help="SQLite DB path or sqlite: URL.")
    parser.add_argument("--out", default="data/ai/enriched_wagers.csv", help="Output file path.")
    parser.add_argument("--format", choices=("csv", "jsonl", "parquet"), default=None, help="Output format. Defaults from --out extension, then csv.")
    parser.add_argument("--agent-login", default=None, help="Optional agent_login filter.")
    parser.add_argument("--customer-id", default=None, help="Optional customer_id/player filter.")
    parser.add_argument("--since", default=None, help="Optional inclusive insert_date_time lower bound.")
    parser.add_argument("--until", default=None, help="Optional exclusive insert_date_time upper bound.")
    parser.add_argument("--limit", type=int, default=None, help="Optional row limit for smoke tests.")
    parser.add_argument("--chunk-size", type=int, default=10000, help="Rows per streaming chunk for CSV/JSONL.")
    return parser.parse_args()


def resolve_db_path(raw: str | None) -> Path:
    if raw:
      normalized = raw
      if normalized.startswith("sqlite:"):
          normalized = normalized.removeprefix("sqlite:")
      return Path(normalized).expanduser()

    for candidate in DEFAULT_DB_CANDIDATES:
        path = Path(candidate)
        if path.exists():
            return path

    return Path(DEFAULT_DB_CANDIDATES[0])


def infer_format(output_path: Path, explicit: str | None) -> str:
    if explicit:
        return explicit
    suffix = output_path.suffix.lower()
    if suffix == ".parquet":
        return "parquet"
    if suffix in (".jsonl", ".ndjson"):
        return "jsonl"
    return "csv"


def query_with_limit(limit: int | None) -> str:
    if limit is None:
        return ENRICHED_WAGERS_SQL
    if limit < 1:
        raise ValueError("--limit must be positive")
    return f"SELECT * FROM ({ENRICHED_WAGERS_SQL}) LIMIT {limit}"


def query_params(args: argparse.Namespace) -> dict[str, str | None]:
    return {
        "agent_login": args.agent_login,
        "customer_id": args.customer_id,
        "since": args.since,
        "until": args.until,
    }


def iter_rows(conn: sqlite3.Connection, sql: str, params: dict[str, str | None], chunk_size: int) -> Iterable[list[sqlite3.Row]]:
    cursor = conn.execute(sql, params)
    while True:
        rows = cursor.fetchmany(chunk_size)
        if not rows:
            break
        yield rows


def export_csv(conn: sqlite3.Connection, sql: str, params: dict[str, str | None], output_path: Path, chunk_size: int) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer: csv.DictWriter[str] | None = None
        for rows in iter_rows(conn, sql, params, chunk_size):
            dict_rows = [dict(row) for row in rows]
            if writer is None:
                writer = csv.DictWriter(handle, fieldnames=list(dict_rows[0].keys()))
                writer.writeheader()
            writer.writerows(dict_rows)
            count += len(dict_rows)
    return count


def export_jsonl(conn: sqlite3.Connection, sql: str, params: dict[str, str | None], output_path: Path, chunk_size: int) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with output_path.open("w", encoding="utf-8") as handle:
        for rows in iter_rows(conn, sql, params, chunk_size):
            for row in rows:
                handle.write(json.dumps(dict(row), ensure_ascii=False, default=str))
                handle.write("\n")
                count += 1
    return count


def export_parquet(db_path: Path, sql: str, params: dict[str, str | None], output_path: Path) -> int:
    try:
        import pandas as pd
    except ImportError as exc:
        raise SystemExit("Parquet export requires pandas plus pyarrow or fastparquet. Install one Parquet engine, or use --format csv/jsonl.") from exc

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        frame = pd.read_sql_query(sql, conn, params=params)
    try:
        frame.to_parquet(output_path, index=False)
    except ImportError as exc:
        raise SystemExit("Parquet export requires pyarrow or fastparquet. Install one Parquet engine, or use --format csv/jsonl.") from exc
    return len(frame.index)


def main() -> int:
    args = parse_args()
    db_path = resolve_db_path(args.db)
    output_path = Path(args.out)
    output_format = infer_format(output_path, args.format)
    sql = query_with_limit(args.limit)
    params = query_params(args)

    if not db_path.exists():
        print(f"Database not found: {db_path}", file=sys.stderr)
        return 1

    if output_format == "parquet":
        count = export_parquet(db_path, sql, params, output_path)
    else:
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            if output_format == "jsonl":
                count = export_jsonl(conn, sql, params, output_path, args.chunk_size)
            else:
                count = export_csv(conn, sql, params, output_path, args.chunk_size)

    print(json.dumps({
        "success": True,
        "db": str(db_path),
        "out": str(output_path),
        "format": output_format,
        "rows": count,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
