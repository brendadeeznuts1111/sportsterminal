import { AppDatabase, normalizeDatabasePath } from '../src/database';

interface Rule {
  id: number;
  name: string;
  condition_json: string;
  action: string;
  severity: string;
  enabled: number;
}

interface RuleCondition {
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'in' | 'contains';
  value: number | string | string[];
  table?: string;
}

interface RuleDef {
  name: string;
  conditions: RuleCondition[];
  action: string;
  severity: string;
}

const DEFAULT_RULES: RuleDef[] = [
  {
    name: 'Sharp Whale Detection',
    conditions: [
      { field: 'avg_wager_size', operator: 'gt', value: 100, table: 'customer_features' },
      { field: 'win_rate', operator: 'gt', value: 0.55, table: 'customer_features' },
    ],
    action: 'review',
    severity: 'high',
  },
  {
    name: 'High Volume Spike',
    conditions: [
      { field: 'amount_wagered', operator: 'gt', value: 200000, table: 'wagers' }, // >$2000
    ],
    action: 'reduce',
    severity: 'medium',
  },
  {
    name: 'Multiple Violations',
    conditions: [
      { field: 'violation_count', operator: 'gte', value: 3, table: 'wagerviolations' },
    ],
    action: 'block',
    severity: 'critical',
  },
  {
    name: 'BLACK Tier Auto-Block',
    conditions: [
      { field: 'risk_tier', operator: 'eq', value: 'BLACK', table: 'customer_features' },
    ],
    action: 'block',
    severity: 'critical',
  },
  {
    name: 'RED Tier Sharp Review',
    conditions: [
      { field: 'risk_tier', operator: 'eq', value: 'RED', table: 'customer_features' },
      { field: 'sharp_score', operator: 'gt', value: 70, table: 'customer_features' },
    ],
    action: 'review',
    severity: 'high',
  },
  {
    name: 'Dormant Reactivation Risk',
    conditions: [
      { field: 'days_since_last_wager', operator: 'gt', value: 90, table: 'customer_features' },
      { field: 'avg_wager_size', operator: 'gt', value: 50, table: 'customer_features' },
    ],
    action: 'review',
    severity: 'medium',
  },
  {
    name: 'Low Win Rate Grinder',
    conditions: [
      { field: 'lifetime_wagers', operator: 'gte', value: 50, table: 'customer_features' },
      { field: 'win_rate', operator: 'lt', value: 0.40, table: 'customer_features' },
    ],
    action: 'reduce',
    severity: 'low',
  },
  {
    name: 'Sport Specialist with High Stakes',
    conditions: [
      { field: 'sport_diversity_score', operator: 'lt', value: 0.3, table: 'customer_features' },
      { field: 'avg_wager_size', operator: 'gt', value: 75, table: 'customer_features' },
    ],
    action: 'review',
    severity: 'medium',
  },
];

async function seedRules(db: AppDatabase) {
  const existing = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM agent_rules');
  if ((existing?.count || 0) > 0) return;

  console.log('🌱 Seeding default rules...');
  for (const rule of DEFAULT_RULES) {
    await db.run(
      `INSERT INTO agent_rules (name, condition_json, action, severity, enabled)
       VALUES (?, ?, ?, ?, 1)`,
      [rule.name, JSON.stringify(rule.conditions), rule.action, rule.severity]
    );
  }
  console.log(`   Seeded ${DEFAULT_RULES.length} rules`);
}

function evaluateCondition(value: unknown, op: string, target: unknown): boolean {
  if (value === null || value === undefined) return false;

  switch (op) {
    case 'gt': return Number(value) > Number(target);
    case 'gte': return Number(value) >= Number(target);
    case 'lt': return Number(value) < Number(target);
    case 'lte': return Number(value) <= Number(target);
    case 'eq': return String(value) === String(target);
    case 'neq': return String(value) !== String(target);
    case 'in': return Array.isArray(target) && target.includes(String(value));
    case 'contains': return String(value).includes(String(target));
    default: return false;
  }
}

async function runRules(db: AppDatabase) {
  const rules = await db.all<Rule>('SELECT * FROM agent_rules WHERE enabled = 1');
  console.log(`\n⚙️  Running ${rules.length} rules against backfilled data...\n`);

  let totalTriggered = 0;

  for (const rule of rules) {
    let conditions: RuleCondition[];
    try {
      conditions = JSON.parse(rule.condition_json);
    } catch {
      console.warn(`   ⚠️  Rule "${rule.name}" has invalid JSON conditions`);
      continue;
    }

    // Build query based on conditions
    // For simplicity, we handle customer_features-based rules primarily
    const cfConditions = conditions.filter(c => !c.table || c.table === 'customer_features');
    const wagerConditions = conditions.filter(c => c.table === 'wagers');
    const violationConditions = conditions.filter(c => c.table === 'wagerviolations');

    let triggeredCustomers: string[] = [];

    if (cfConditions.length > 0 && wagerConditions.length === 0 && violationConditions.length === 0) {
      // Pure customer_features rule
      const whereClauses: string[] = [];
      const params: unknown[] = [];

      for (const cond of cfConditions) {
        const paramIndex = params.length + 1;
        switch (cond.operator) {
          case 'gt': whereClauses.push(`${cond.field} > ?${paramIndex}`); break;
          case 'gte': whereClauses.push(`${cond.field} >= ?${paramIndex}`); break;
          case 'lt': whereClauses.push(`${cond.field} < ?${paramIndex}`); break;
          case 'lte': whereClauses.push(`${cond.field} <= ?${paramIndex}`); break;
          case 'eq': whereClauses.push(`${cond.field} = ?${paramIndex}`); break;
          case 'neq': whereClauses.push(`${cond.field} != ?${paramIndex}`); break;
          default: whereClauses.push('1=0');
        }
        params.push(cond.value);
      }

      const rows = await db.all<{ customer_id: string }>(
        `SELECT customer_id FROM customer_features WHERE ${whereClauses.join(' AND ')}`,
        params
      );
      triggeredCustomers = rows.map(r => r.customer_id);
    } else if (wagerConditions.length > 0) {
      // Wager-based rule
      for (const cond of wagerConditions) {
        const rows = await db.all<{ customer_id: string }>(
          `SELECT DISTINCT customer_id FROM wagers WHERE ${cond.field} > ?`,
          [cond.value]
        );
        triggeredCustomers = rows.map(r => r.customer_id);
      }
    } else if (violationConditions.length > 0) {
      // Violation-based rule
      for (const cond of violationConditions) {
        const rows = await db.all<{ customer_id: string }>(
          `SELECT customer_id FROM (SELECT customer_id, COUNT(*) as violation_count FROM wager_violations GROUP BY customer_id) WHERE violation_count >= ?`,
          [cond.value]
        );
        triggeredCustomers = rows.map(r => r.customer_id);
      }
    }

    // Deduplicate
    triggeredCustomers = [...new Set(triggeredCustomers)];

    // Insert agent_actions
    let ruleTriggered = 0;
    for (const customerId of triggeredCustomers) {
      // Skip if already actioned for this rule today
      const existing = await db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM agent_actions WHERE rule_id = ? AND player_id = ? AND date(created_at) = date('now')`,
        [rule.id, customerId]
      );
      if ((existing?.count || 0) > 0) continue;

      // Find latest wager for this customer
      const wager = await db.get<{ wager_number: number }>(
        `SELECT wager_number FROM wagers WHERE customer_id = ? ORDER BY insert_datetime DESC LIMIT 1`,
        [customerId]
      );

      await db.run(
        `INSERT INTO agent_actions (rule_id, wager_number, player_id, action, severity, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          rule.id,
          wager?.wager_number || null,
          customerId,
          rule.action,
          rule.severity,
          JSON.stringify({ rule_name: rule.name, triggered_at: new Date().toISOString(), source: 'backfill_rules_engine' }),
        ]
      );
      ruleTriggered++;
    }

    if (ruleTriggered > 0) {
      console.log(`   🔥 "${rule.name}" triggered ${ruleTriggered} actions (${rule.action})`);
      totalTriggered += ruleTriggered;
    } else {
      console.log(`   ✓ "${rule.name}" — no triggers`);
    }
  }

  return totalTriggered;
}

async function main() {
  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));

  console.log('═══════════════════════════════════════════════════');
  console.log('⚙️  RULES ENGINE — BACKFILL RUN');
  console.log('═══════════════════════════════════════════════════\n');

  await seedRules(db);
  const triggered = await runRules(db);

  const totalActions = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM agent_actions');
  const todayActions = await db.get<{ c: number }>("SELECT COUNT(*) as c FROM agent_actions WHERE date(created_at) = date('now')");

  console.log('\n═══════════════════════════════════════════════════');
  console.log('✅ RULES ENGINE COMPLETE');
  console.log(`   New actions today: ${triggered}`);
  console.log(`   Total agent_actions: ${totalActions?.c || 0}`);
  console.log(`   Actions created today: ${todayActions?.c || 0}`);
  console.log('═══════════════════════════════════════════════════');

  await db.close();
}

main().catch((err) => {
  console.error('❌ Rules engine failed:', err);
  process.exit(1);
});
