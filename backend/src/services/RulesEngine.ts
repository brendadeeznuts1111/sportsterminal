import type { Database } from '../database';
import type { EnrichedWager, Severity } from '../risk/AlertEngine';
import type { ClvResult } from './CLV';

export type RuleConditionType = 'ipShared' | 'clvBeater' | 'failedLogin' | 'velocity' | 'accountChange';
export type RuleAction = 'flag' | 'block' | 'alert' | 'adjustLimit';
export type RuleSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface RuleCondition {
  type: RuleConditionType;
  threshold: number;
  windowMins?: number;
}

export interface Rule {
  id: number;
  name: string;
  condition: RuleCondition;
  action: RuleAction;
  severity: RuleSeverity;
  enabled: boolean;
}

export interface RuleInput {
  name: string;
  condition: RuleCondition;
  action: RuleAction;
  severity: RuleSeverity;
  enabled?: boolean;
  id?: number;
}

type RuleRow = Record<string, unknown> & {
  id: number;
  name: string;
  condition_json: string;
  action: RuleAction;
  severity: RuleSeverity;
  enabled: number;
};

interface CountRow {
  cnt: number | string;
}

export async function listRules(db: Database): Promise<Rule[]> {
  const rows = await db.all<RuleRow>(
    `SELECT * FROM agent_rules ORDER BY enabled DESC, id DESC`
  );
  return rows.map(parseRuleRow);
}

export async function getActiveRules(db: Database): Promise<Rule[]> {
  const rows = await db.all<RuleRow>(
    `SELECT * FROM agent_rules WHERE enabled = 1 ORDER BY id`
  );
  return rows.map(parseRuleRow);
}

export async function upsertRule(db: Database, input: RuleInput): Promise<{ id: number | null }> {
  const normalized = normalizeRuleInput(input);
  if (normalized.id) {
    await db.run(
      `UPDATE agent_rules
       SET name = ?, condition_json = ?, action = ?, severity = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        normalized.name,
        JSON.stringify(normalized.condition),
        normalized.action,
        normalized.severity,
        normalized.enabled ? 1 : 0,
        normalized.id,
      ]
    );
    return { id: normalized.id };
  }

  const result = await db.run(
    `INSERT INTO agent_rules (name, condition_json, action, severity, enabled)
     VALUES (?, ?, ?, ?, ?)`,
    [
      normalized.name,
      JSON.stringify(normalized.condition),
      normalized.action,
      normalized.severity,
      normalized.enabled ? 1 : 0,
    ]
  );
  return { id: result.lastID || null };
}

export async function deleteRule(db: Database, id: number): Promise<boolean> {
  const result = await db.run(`DELETE FROM agent_rules WHERE id = ?`, [id]);
  return result.changes > 0;
}

export async function evaluateRules(
  db: Database,
  wager: EnrichedWager,
  _playerSnapshot: unknown,
  ipStats: Record<string, unknown> | null,
  clvResult: ClvResult
): Promise<Rule[]> {
  const triggered: Rule[] = [];
  const rules = await getActiveRules(db);
  for (const rule of rules) {
    const condition = rule.condition;
    let meets: boolean;
    switch (condition.type) {
      case 'ipShared': {
        const sharedCount = Number(ipStats?.sharedIpCount || await getSharedIpCount(db, wager.Login));
        meets = sharedCount >= condition.threshold;
        break;
      }
      case 'clvBeater':
        meets = clvResult.isBeater && clvResult.clvPercent >= condition.threshold;
        break;
      case 'failedLogin': {
        const failCount = await countRecent(db, 'failed_logins', 'player', wager.Login || wager.CustomerID, condition.windowMins || 15);
        meets = failCount >= condition.threshold;
        break;
      }
      case 'velocity': {
        const recentWagers = await db.get<CountRow>(
          `SELECT COUNT(*) AS cnt
           FROM wagers
           WHERE (customer_id = ? OR login = ?)
             AND insert_datetime >= datetime('now', ?)`,
          [wager.CustomerID, wager.Login, `-${condition.windowMins || 5} minutes`]
        );
        meets = Number(recentWagers?.cnt || 0) >= condition.threshold;
        break;
      }
      case 'accountChange': {
        const changes = await countRecent(db, 'account_change_logs', 'player', wager.Login || wager.CustomerID, condition.windowMins || 60);
        meets = changes >= condition.threshold;
        break;
      }
      default:
        meets = false;
    }
    if (meets) triggered.push(rule);
  }
  return triggered;
}

export async function takeAction(
  db: Database,
  rule: Rule,
  wager: EnrichedWager,
  context: Record<string, unknown> = {},
  broadcast?: (msg: object) => void
): Promise<void> {
  await db.run(
    `INSERT INTO agent_actions (rule_id, wager_number, player_id, action, severity, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      rule.id,
      wager.WagerNumber,
      wager.Login || wager.CustomerID,
      rule.action,
      rule.severity,
      JSON.stringify({ rule: rule.name, condition: rule.condition, ...context }),
    ]
  );

  await db.run(
    `INSERT INTO alerts (wager_number, rule_name, severity, message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      wager.WagerNumber,
      `Rule: ${rule.name}`,
      toAlertSeverity(rule.severity),
      `${rule.action} ${wager.Login || wager.CustomerID} on wager #${wager.WagerNumber} (${rule.condition.type})`,
      new Date().toISOString(),
    ]
  );

  broadcast?.({
    type: 'agent_rule.triggered',
    timestamp: new Date().toISOString(),
    payload: {
      rule,
      wagerNumber: wager.WagerNumber,
      playerId: wager.Login || wager.CustomerID,
      action: rule.action,
      severity: rule.severity,
      context,
    },
  });
}

function parseRuleRow(row: RuleRow): Rule {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    condition: parseCondition(row.condition_json),
    action: normalizeAction(row.action),
    severity: normalizeSeverity(row.severity),
    enabled: Number(row.enabled || 0) === 1,
  };
}

function normalizeRuleInput(input: RuleInput): RuleInput {
  return {
    id: input.id ? Number(input.id) : undefined,
    name: String(input.name || '').trim() || 'Untitled Rule',
    condition: parseCondition(input.condition),
    action: normalizeAction(input.action),
    severity: normalizeSeverity(input.severity),
    enabled: input.enabled !== false,
  };
}

function parseCondition(value: unknown): RuleCondition {
  const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
  const condition = parsed && typeof parsed === 'object' ? parsed as Partial<RuleCondition> : {};
  const type = normalizeConditionType(condition.type);
  return {
    type,
    threshold: Number.isFinite(Number(condition.threshold)) ? Number(condition.threshold) : defaultThreshold(type),
    ...(condition.windowMins ? { windowMins: Math.max(1, Number(condition.windowMins)) } : {}),
  };
}

function normalizeConditionType(value: unknown): RuleConditionType {
  return value === 'clvBeater'
    || value === 'failedLogin'
    || value === 'velocity'
    || value === 'accountChange'
    || value === 'ipShared'
    ? value
    : 'ipShared';
}

function normalizeAction(value: unknown): RuleAction {
  return value === 'block' || value === 'alert' || value === 'adjustLimit' || value === 'flag'
    ? value
    : 'flag';
}

function normalizeSeverity(value: unknown): RuleSeverity {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : 'medium';
}

function defaultThreshold(type: RuleConditionType): number {
  if (type === 'clvBeater') return 10;
  if (type === 'failedLogin') return 5;
  if (type === 'velocity') return 5;
  if (type === 'accountChange') return 1;
  return 3;
}

function toAlertSeverity(severity: RuleSeverity): Severity {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'warning';
  return 'info';
}

async function countRecent(
  db: Database,
  table: 'failed_logins' | 'account_change_logs',
  column: 'player',
  value: string,
  windowMins: number
): Promise<number> {
  const row = await db.get<CountRow>(
    `SELECT COUNT(*) AS cnt
     FROM ${table}
     WHERE ${column} = ?
       AND timestamp >= datetime('now', ?)`,
    [value, `-${windowMins} minutes`]
  );
  return Number(row?.cnt || 0);
}

async function getSharedIpCount(db: Database, player: string): Promise<number> {
  const row = await db.get<CountRow>(
    `SELECT COUNT(DISTINCT other.login_id) AS cnt
     FROM access_logs mine
     JOIN access_logs other
       ON other.ip_address = mine.ip_address
      AND other.login_id <> mine.login_id
     WHERE mine.login_id = ?
       AND mine.access_datetime >= datetime('now', '-1 day')`,
    [player]
  );
  return Number(row?.cnt || 0);
}
