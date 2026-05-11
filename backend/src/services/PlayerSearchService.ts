/**
 * PlayerSearchService — fuzzy player search with autocomplete.
 *
 * Pure SQLite implementation using LIKE with `%` wildcards. Ranks by:
 *   1. Exact id/login match
 *   2. Prefix matches
 *   3. Substring matches
 * Augments each hit with their latest `ai_risk_flags` row.
 */

import type { Database } from '../database';

export interface PlayerSearchHit {
  customer_id: string;
  login: string;
  name: string;
  agent_login: string | null;
  net_pnl: number;
  exposure: number;
  status: string;
  risk_level: string | null;
  risk_confidence: number | null;
  match_type: 'exact' | 'prefix' | 'fuzzy';
  rank: number;
}

interface PlayerRow {
  customer_id: string;
  login: string;
  name: string;
  agent_login: string | null;
  net_pnl: number;
  exposure: number;
  status: string;
  risk_level: string | null;
  risk_confidence: number | null;
}

export class PlayerSearchService {
  constructor(private readonly db: Database) { }

  /**
   * Search across `players` table with auto-suggest semantics.
   *
   * @param query    user input
   * @param limit    max hits (default 10, max 50)
   */
  async search(query: string, limit = 10): Promise<PlayerSearchHit[]> {
    const q = (query || '').trim();
    if (q.length === 0) return [];
    const cap = Math.min(Math.max(limit, 1), 50);

    const exact = `${q}`;
    const prefix = `${q}%`;
    const fuzzy = `%${q}%`;

    // Single SQL with three UNION'd buckets so ranking is deterministic and
    // the row count is bounded by `cap` per bucket.
    const rows = await this.db.all<PlayerRow & { match_type: string; rank: number }>(
      `SELECT * FROM (
         SELECT
           p.id          AS customer_id,
           COALESCE(p.login, p.id) AS login,
           p.name        AS name,
           p.agent_login AS agent_login,
           COALESCE(p.net_pnl, 0)  AS net_pnl,
           COALESCE(p.exposure, 0) AS exposure,
           p.status      AS status,
           (SELECT risk_level FROM ai_risk_flags f WHERE f.customer_id = p.id ORDER BY created_at DESC LIMIT 1) AS risk_level,
           (SELECT confidence FROM ai_risk_flags f WHERE f.customer_id = p.id ORDER BY created_at DESC LIMIT 1) AS risk_confidence,
           'exact' AS match_type,
           1 AS rank
         FROM players p
         WHERE p.id = ? OR p.login = ?
         LIMIT ?
       )
       UNION ALL
       SELECT * FROM (
         SELECT
           p.id, COALESCE(p.login, p.id), p.name, p.agent_login,
           COALESCE(p.net_pnl, 0), COALESCE(p.exposure, 0), p.status,
           (SELECT risk_level FROM ai_risk_flags f WHERE f.customer_id = p.id ORDER BY created_at DESC LIMIT 1),
           (SELECT confidence FROM ai_risk_flags f WHERE f.customer_id = p.id ORDER BY created_at DESC LIMIT 1),
           'prefix', 2
         FROM players p
         WHERE (p.id LIKE ? OR p.login LIKE ? OR p.name LIKE ?)
           AND p.id <> ? AND COALESCE(p.login, '') <> ?
         LIMIT ?
       )
       UNION ALL
       SELECT * FROM (
         SELECT
           p.id, COALESCE(p.login, p.id), p.name, p.agent_login,
           COALESCE(p.net_pnl, 0), COALESCE(p.exposure, 0), p.status,
           (SELECT risk_level FROM ai_risk_flags f WHERE f.customer_id = p.id ORDER BY created_at DESC LIMIT 1),
           (SELECT confidence FROM ai_risk_flags f WHERE f.customer_id = p.id ORDER BY created_at DESC LIMIT 1),
           'fuzzy', 3
         FROM players p
         WHERE (p.id LIKE ? OR p.login LIKE ? OR p.name LIKE ?)
           AND p.id NOT LIKE ? AND COALESCE(p.login, '') NOT LIKE ? AND COALESCE(p.name, '') NOT LIKE ?
         LIMIT ?
       )
       ORDER BY rank ASC, name ASC
       LIMIT ?`,
      [
        // exact
        exact, exact, cap,
        // prefix
        prefix, prefix, prefix, exact, exact, cap,
        // fuzzy
        fuzzy, fuzzy, fuzzy, prefix, prefix, prefix, cap,
        // overall cap
        cap,
      ]
    );

    return rows.map((r) => ({
      customer_id: r.customer_id,
      login: r.login,
      name: r.name,
      agent_login: r.agent_login,
      net_pnl: Number(r.net_pnl),
      exposure: Number(r.exposure),
      status: r.status,
      risk_level: r.risk_level,
      risk_confidence: r.risk_confidence,
      match_type: r.match_type as PlayerSearchHit['match_type'],
      rank: Number(r.rank),
    }));
  }

  /**
   * Autocomplete suggestions — minimal payload for typeahead.
   */
  async suggest(query: string, limit = 8): Promise<{ id: string; label: string; risk_level: string | null }[]> {
    const hits = await this.search(query, limit);
    return hits.map((h) => ({
      id: h.customer_id,
      label: h.name && h.name !== h.login ? `${h.login} — ${h.name}` : h.login,
      risk_level: h.risk_level,
    }));
  }
}
