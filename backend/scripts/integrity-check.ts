import { Database } from 'bun:sqlite';

const dbPath = process.argv[2] || 'backend/data/terminal.db';
const db = new Database(dbPath, { readonly: true });

type CheckSeverity = 'ok' | 'warning' | 'critical';

interface IntegrityCheck {
  name: string;
  severity: CheckSeverity;
  detail: string;
  value?: unknown;
}

function get<T = any>(sql: string): T {
  return db.query(sql).get() as T;
}

function all<T = any>(sql: string): T[] {
  return db.query(sql).all() as T[];
}

const wagerCounts = get<{ wagers: number; wagerArchiveDistinct: number }>(`
  SELECT
    (SELECT COUNT(*) FROM wagers) AS wagers,
    (SELECT COUNT(DISTINCT wager_number) FROM wager_archive) AS wagerArchiveDistinct
`);
const hierarchy = get<{ agents: number; roots: number; maxLevel: number }>(`
  SELECT
    COUNT(*) AS agents,
    SUM(CASE WHEN parent_agent_id IS NULL OR parent_agent_id = '' THEN 1 ELSE 0 END) AS roots,
    MAX(level) AS maxLevel
  FROM agent_hierarchy
  WHERE provider = 'buckeye'
`);
const checks: IntegrityCheck[] = [
  {
    name: 'wagers_reconcile_to_archive',
    severity: wagerCounts.wagers === wagerCounts.wagerArchiveDistinct ? 'ok' : 'critical',
    detail: `wagers=${wagerCounts.wagers}; wager_archive distinct wager_number=${wagerCounts.wagerArchiveDistinct}`,
    value: wagerCounts,
  },
  {
    name: 'wagers_no_legacy_type_constraint',
    severity: Number(get<{ hasLegacyConstraint: number }>(
      `SELECT instr(sql, 'wager_type IN') AS hasLegacyConstraint FROM sqlite_master WHERE type='table' AND name='wagers'`
    )?.hasLegacyConstraint || 0) === 0 ? 'ok' : 'critical',
    detail: 'wagers table should accept newly observed Buckeye wager types without stale CHECK constraints.',
  },
  {
    name: 'wagers_have_player_and_agent',
    severity: Number(get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM wagers WHERE COALESCE(login, '') = '' OR COALESCE(agent_login, '') = ''`
    ).count || 0) === 0 ? 'ok' : 'critical',
    detail: 'No live wager row should have blank login or agent_login.',
  },
  {
    name: 'player_agent_map_no_orphans',
    severity: Number(get<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM player_agent_map m
      LEFT JOIN agent_hierarchy h ON h.provider='buckeye' AND h.agent_id=m.agent_id
      WHERE h.agent_id IS NULL
    `).count || 0) === 0 ? 'ok' : 'critical',
    detail: 'Every player_agent_map.agent_id should resolve to agent_hierarchy.',
  },
  {
    name: 'agent_hierarchy_expected_shape',
    severity: hierarchy.agents === 2288 && hierarchy.roots === 3 && hierarchy.maxLevel === 17 ? 'ok' : 'warning',
    detail: `agents=${hierarchy.agents}; roots=${hierarchy.roots}; maxLevel=${hierarchy.maxLevel}`,
    value: hierarchy,
  },
];

const zeroAmountWagers = get<{ count: number }>(`SELECT COUNT(*) AS count FROM wagers WHERE amount_wagered = 0`);
if (Number(zeroAmountWagers.count || 0) > 0) {
  checks.push({
    name: 'wagers_zero_amount_anomalies',
    severity: 'warning',
    detail: `${zeroAmountWagers.count} zero-amount wager row(s) found; flagged for review, not deleted.`,
  });
}

const wagerTypes = all<{ wager_type: string; count: number }>(
  `SELECT COALESCE(wager_type, '') AS wager_type, COUNT(*) AS count FROM wagers GROUP BY wager_type ORDER BY count DESC`
);
const knownTypes = new Set(['L', 'M', 'S', 'P', 'E', 'T', 'C']);
const newTypes = wagerTypes.filter((row) => row.wager_type && !knownTypes.has(row.wager_type));
if (newTypes.length > 0) {
  checks.push({
    name: 'wagers_new_type_codes',
    severity: 'warning',
    detail: `New Buckeye wager type code(s): ${newTypes.map((row) => `${row.wager_type}=${row.count}`).join(', ')}.`,
    value: newTypes,
  });
}

const summary = {
  status: checks.some((check) => check.severity === 'critical') ? 'critical' : checks.some((check) => check.severity === 'warning') ? 'warning' : 'ok',
  generatedAt: new Date().toISOString(),
  dbPath,
  checks,
};

console.log(JSON.stringify(summary, null, 2));
if (summary.status === 'critical') process.exitCode = 1;
