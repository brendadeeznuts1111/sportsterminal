import type { Database } from '../database';

export interface SandboxConfig {
  customerCount: number;
  archetypesEnabled: boolean;
  snapshotsEnabled: boolean;
  aiSummariesEnabled: boolean;
  archetypeWeights?: Record<string, number>;
}

export interface SandboxSnapshotInput {
  day_index: number;
  balance: number;
  pnl: number;
  wager_count: number;
  clv: number;
  win_rate: number;
}

export interface SandboxCustomerInput {
  customer_id: string;
  archetype: string;
  risk_tier?: string;
  balance: number;
  clv: number;
  win_rate: number;
  lifetime_wagers: number;
  tags?: string[];
  profile?: Record<string, unknown>;
  snapshot?: SandboxSnapshotInput[];
}

export interface SaveSandboxScenarioInput {
  name: string;
  description?: string;
  config: SandboxConfig;
  customers: SandboxCustomerInput[];
}

export interface ABTestInput {
  scenario_id: number;
  name: string;
  prompt_a: string;
  prompt_b: string;
  customer_ids: string[];
}

interface ScenarioRow {
  id: number;
  name: string;
  description: string | null;
  config_json: string;
  version: number;
  is_archived?: number;
  created_at: string;
  updated_at: string;
}

interface CustomerRow {
  customer_id: string;
  archetype: string;
  risk_tier: string | null;
  balance: number | null;
  clv: number | null;
  win_rate: number | null;
  lifetime_wagers: number | null;
  tags_json: string | null;
  profile_json: string | null;
  summary_json: string | null;
  summary_status: string;
  summary_attempts: number;
}

interface FullCustomerRow extends CustomerRow {
  id: number;
  scenario_id: number;
  created_at: string;
}

interface QueueJobRow {
  id: number;
  scenario_id: number;
  customer_id: string;
  attempts: number;
}

interface SandboxPromptResult {
  risk_score: number;
  risk_tier: string;
  rationale: string;
}

const QUEUE_CONCURRENCY = 3;
const QUEUE_JOB_DELAY_MS = 500;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];
const SCENARIO_TTL_DAYS = 90;
const QUEUE_CLEANUP_DAYS = 7;
const queueProcessors = new WeakMap<Database, ReturnType<typeof setInterval>>();
const janitors = new WeakMap<Database, ReturnType<typeof setInterval>>();

export class SandboxService {
  constructor(private readonly db: Database) {}

  async saveScenario(input: SaveSandboxScenarioInput, existingId?: number): Promise<{ id: number; version: number }> {
    const scenarioId = await withTransaction(this.db, async () => {
      let id: number;
      if (existingId) {
        const current = await this.db.get<{ id: number; version: number }>(
          `SELECT id, version FROM sandbox_scenarios WHERE id = ? AND is_archived = 0`,
          [existingId]
        );
        if (!current) throw new Error('Scenario not found');

        await this.db.run(
          `UPDATE sandbox_scenarios
           SET name = ?, description = ?, config_json = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [input.name, input.description || null, JSON.stringify(input.config), existingId]
        );
        await this.db.run(`DELETE FROM sandbox_summary_queue WHERE scenario_id = ?`, [existingId]);
        await this.db.run(`DELETE FROM sandbox_ab_tests WHERE scenario_id = ?`, [existingId]);
        await this.db.run(`DELETE FROM sandbox_snapshots WHERE scenario_id = ?`, [existingId]);
        await this.db.run(`DELETE FROM sandbox_customers WHERE scenario_id = ?`, [existingId]);
        id = existingId;
      } else {
        const created = await this.db.run(
          `INSERT INTO sandbox_scenarios (name, description, config_json) VALUES (?, ?, ?)`,
          [input.name, input.description || null, JSON.stringify(input.config)]
        );
        id = created.lastID;
      }

      await this.insertScenarioCustomers(id, input);
      return id;
    });

    if (input.config.aiSummariesEnabled) {
      await this.queueSummaries(scenarioId, input.customers.map((customer) => customer.customer_id));
    }

    const saved = await this.db.get<{ version: number }>(
      `SELECT version FROM sandbox_scenarios WHERE id = ?`,
      [scenarioId]
    );
    return { id: scenarioId, version: saved?.version ?? 1 };
  }

  async listScenarios(includeArchived = false): Promise<unknown[]> {
    const where = includeArchived ? '' : 'WHERE s.is_archived = 0';
    return this.db.all(
      `SELECT s.id, s.name, s.description, s.version, s.is_archived, s.created_at, s.updated_at,
              COUNT(c.id) AS customer_count
       FROM sandbox_scenarios s
       LEFT JOIN sandbox_customers c ON c.scenario_id = s.id
       ${where}
       GROUP BY s.id
       ORDER BY s.updated_at DESC`,
      []
    );
  }

  async loadScenario(id: number, page: number, limit: number, includeSnapshots: boolean): Promise<unknown> {
    const scenario = await this.db.get<ScenarioRow>(
      `SELECT id, name, description, config_json, version, created_at, updated_at
       FROM sandbox_scenarios
       WHERE id = ? AND is_archived = 0`,
      [id]
    );
    if (!scenario) throw new Error('Scenario not found');

    const offset = (page - 1) * limit;
    const customers = await this.db.all<CustomerRow>(
      `SELECT customer_id, archetype, risk_tier, balance, clv, win_rate, lifetime_wagers,
              tags_json, profile_json, summary_json, summary_status, summary_attempts
       FROM sandbox_customers
       WHERE scenario_id = ?
       ORDER BY customer_id
       LIMIT ? OFFSET ?`,
      [id, limit, offset]
    );
    const count = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sandbox_customers WHERE scenario_id = ?`,
      [id]
    );
    const mappedCustomers = customers.map((customer) => ({
      customer_id: customer.customer_id,
      archetype: customer.archetype,
      risk_tier: customer.risk_tier,
      balance: customer.balance,
      clv: customer.clv,
      win_rate: customer.win_rate,
      lifetime_wagers: customer.lifetime_wagers,
      tags: parseJson<string[]>(customer.tags_json, []),
      profile: parseJson<Record<string, unknown>>(customer.profile_json, {}),
      summary: customer.summary_json ? parseJson<unknown>(customer.summary_json, null) : null,
      summary_status: customer.summary_status,
      summary_attempts: customer.summary_attempts,
    }));

    if (includeSnapshots && mappedCustomers.length > 0) {
      const ids = mappedCustomers.map((customer) => customer.customer_id);
      const placeholders = ids.map(() => '?').join(',');
      const snapshots = await this.db.all<Record<string, unknown>>(
        `SELECT customer_id, day_index, balance, pnl, wager_count, clv, win_rate
         FROM sandbox_snapshots
         WHERE scenario_id = ? AND customer_id IN (${placeholders})
         ORDER BY customer_id, day_index`,
        [id, ...ids]
      );
      const byCustomer = new Map<string, Record<string, unknown>[]>();
      for (const snapshot of snapshots) {
        const customerId = String(snapshot.customer_id || '');
        const list = byCustomer.get(customerId) || [];
        list.push(snapshot);
        byCustomer.set(customerId, list);
      }
      for (const customer of mappedCustomers) {
        Object.assign(customer, { snapshot: byCustomer.get(customer.customer_id) || [] });
      }
    }

    const total = count?.count ?? 0;
    return {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      config: parseJson<SandboxConfig>(scenario.config_json, defaultConfig()),
      version: scenario.version,
      created_at: scenario.created_at,
      updated_at: scenario.updated_at,
      customers: mappedCustomers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async archiveScenario(id: number): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE sandbox_scenarios SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );
    return result.changes > 0;
  }

  async restoreScenario(id: number): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE sandbox_scenarios SET is_archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );
    return result.changes > 0;
  }

  async hardDeleteScenario(id: number): Promise<boolean> {
    const result = await this.db.run(`DELETE FROM sandbox_scenarios WHERE id = ?`, [id]);
    return result.changes > 0;
  }

  async scenarioExists(id: number): Promise<boolean> {
    const row = await this.db.get<{ id: number }>(
      `SELECT id FROM sandbox_scenarios WHERE id = ? AND is_archived = 0`,
      [id]
    );
    return Boolean(row);
  }

  async queueSummaries(scenarioId: number, customerIds?: string[]): Promise<{ queued: number }> {
    if (!(await this.scenarioExists(scenarioId))) {
      throw new Error('Scenario not found or archived');
    }
    const ids = customerIds?.length
      ? customerIds
      : (await this.db.all<{ customer_id: string }>(
          `SELECT customer_id FROM sandbox_customers WHERE scenario_id = ?`,
          [scenarioId]
        )).map((row) => row.customer_id);
    if (customerIds?.length) {
      await this.assertScenarioCustomers(scenarioId, customerIds);
    }

    let queued = 0;
    await withTransaction(this.db, async () => {
      for (const customerId of ids) {
        const inserted = await this.db.run(
          `INSERT OR IGNORE INTO sandbox_summary_queue (scenario_id, customer_id) VALUES (?, ?)`,
          [scenarioId, customerId]
        );
        if (inserted.changes > 0) queued += 1;
      }
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        await this.db.run(
          `UPDATE sandbox_customers
           SET summary_status = 'queued'
           WHERE scenario_id = ? AND customer_id IN (${placeholders}) AND summary_status != 'completed'`,
          [scenarioId, ...ids]
        );
      }
    });
    startSandboxQueueProcessor(this.db);
    void processQueueBatch(this.db);
    return { queued };
  }

  async getQueueStatus(scenarioId: number): Promise<unknown> {
    const rows = await this.db.all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count
       FROM sandbox_summary_queue
       WHERE scenario_id = ?
       GROUP BY status`,
      [scenarioId]
    );
    const status = { total: 0, queued: 0, processing: 0, completed: 0, failed: 0, dead: 0, pending: 0 };
    for (const row of rows) {
      const key = row.status as keyof typeof status;
      if (key in status) status[key] = Number(row.count);
      status.total += Number(row.count);
    }
    status.pending = status.queued + status.processing;
    return status;
  }

  async refreshCustomerSummary(scenarioId: number, customerId: string): Promise<unknown> {
    const customer = await this.getCustomer(scenarioId, customerId);
    if (!customer) throw new Error('Customer not found');
    const summary = await generateCustomerSummary(customer);
    const summaryJson = JSON.stringify(summary);
    await withTransaction(this.db, async () => {
      await this.db.run(
        `UPDATE sandbox_customers
         SET summary_json = ?, summary_status = 'completed', summary_attempts = summary_attempts + 1
         WHERE scenario_id = ? AND customer_id = ?`,
        [summaryJson, scenarioId, customerId]
      );
      await this.db.run(
        `INSERT INTO sandbox_summary_queue
           (scenario_id, customer_id, status, summary_json, attempts, completed_at)
         VALUES (?, ?, 'completed', ?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(scenario_id, customer_id)
         DO UPDATE SET status = 'completed', summary_json = excluded.summary_json,
                       attempts = sandbox_summary_queue.attempts + 1,
                       last_error = NULL, next_attempt_at = NULL,
                       processing_started_at = NULL, completed_at = CURRENT_TIMESTAMP`,
        [scenarioId, customerId, summaryJson]
      );
    });
    return summary;
  }

  async createABTest(input: ABTestInput): Promise<{ id: number; status: string }> {
    const scenario = await this.db.get<{ id: number }>(
      `SELECT id FROM sandbox_scenarios WHERE id = ? AND is_archived = 0`,
      [input.scenario_id]
    );
    if (!scenario) throw new Error('Scenario not found');
    await this.assertScenarioCustomers(input.scenario_id, input.customer_ids);

    const result = await this.db.run(
      `INSERT INTO sandbox_ab_tests (scenario_id, name, prompt_a, prompt_b, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [input.scenario_id, input.name, input.prompt_a, input.prompt_b]
    );
    const id = result.lastID;
    void this.runABTest(id, input);
    return { id, status: 'running' };
  }

  async getABTest(id: number): Promise<unknown> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT * FROM sandbox_ab_tests WHERE id = ?`,
      [id]
    );
    if (!row) throw new Error('AB test not found');
    return {
      ...row,
      results: row.results_json ? parseJson<unknown>(String(row.results_json), null) : null,
    };
  }

  async listABTests(scenarioId?: number): Promise<unknown[]> {
    const params: unknown[] = [];
    let where = '';
    if (scenarioId) {
      where = 'WHERE scenario_id = ?';
      params.push(scenarioId);
    }
    return this.db.all(
      `SELECT id, scenario_id, name, agreement_score, avg_severity_diff, significant, status, created_at, completed_at
       FROM sandbox_ab_tests
       ${where}
       ORDER BY created_at DESC`,
      params
    );
  }

  async exportCsv(scenarioId: number): Promise<string> {
    const rows = await this.db.all<CustomerRow>(
      `SELECT customer_id, archetype, risk_tier, balance, clv, win_rate, lifetime_wagers,
              tags_json, profile_json, summary_json, summary_status, summary_attempts
       FROM sandbox_customers
       WHERE scenario_id = ?
       ORDER BY customer_id`,
      [scenarioId]
    );
    if (rows.length === 0) throw new Error('No customers found');
    const header = [
      'customer_id',
      'archetype',
      'risk_tier',
      'balance',
      'clv',
      'win_rate',
      'lifetime_wagers',
      'tags',
      'summary_status',
      'summary_risk_level',
      'summary_confidence',
    ];
    const lines = rows.map((row) => {
      const tags = parseJson<string[]>(row.tags_json, []).join('|');
      const summary = row.summary_json ? parseJson<Record<string, unknown>>(row.summary_json, {}) : {};
      return [
        row.customer_id,
        row.archetype,
        row.risk_tier || '',
        row.balance ?? '',
        row.clv ?? '',
        row.win_rate ?? '',
        row.lifetime_wagers ?? '',
        tags,
        row.summary_status,
        String(summary.risk_level || summary.risk_tier || ''),
        String(summary.confidence || ''),
      ].map(csvCell).join(',');
    });
    return [header.join(','), ...lines].join('\n');
  }

  async exportFeatures(scenarioId: number): Promise<unknown> {
    const rows = await this.db.all<CustomerRow>(
      `SELECT customer_id, archetype, risk_tier, balance, clv, win_rate, lifetime_wagers,
              tags_json, profile_json, summary_json, summary_status, summary_attempts
       FROM sandbox_customers
       WHERE scenario_id = ?
       ORDER BY customer_id`,
      [scenarioId]
    );
    return {
      scenario_id: scenarioId,
      count: rows.length,
      features: rows.map((row) => customerToFeature(row)),
    };
  }

  async getStats(): Promise<unknown> {
    const [active, archived, customers, summaries, abTests, avgClv, queue] = await Promise.all([
      this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM sandbox_scenarios WHERE is_archived = 0`, []),
      this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM sandbox_scenarios WHERE is_archived = 1`, []),
      this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM sandbox_customers`, []),
      this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM sandbox_customers WHERE summary_status = 'completed'`, []),
      this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM sandbox_ab_tests`, []),
      this.db.get<{ avg_clv: number | null }>(`SELECT AVG(clv) AS avg_clv FROM sandbox_customers`, []),
      this.db.all<{ status: string; count: number }>(
        `SELECT status, COUNT(*) AS count FROM sandbox_summary_queue GROUP BY status`,
        []
      ),
    ]);
    return {
      scenarios: { active: active?.count ?? 0, archived: archived?.count ?? 0 },
      customers: {
        total: customers?.count ?? 0,
        summaries_completed: summaries?.count ?? 0,
        avg_clv: avgClv?.avg_clv ?? 0,
      },
      ab_tests: abTests?.count ?? 0,
      queue,
    };
  }

  async getHealth(): Promise<unknown> {
    await this.db.get(`SELECT 1`, []);
    const activeQueue = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sandbox_summary_queue WHERE status IN ('queued', 'processing')`,
      []
    );
    const deadQueue = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sandbox_summary_queue WHERE status = 'dead'`,
      []
    );
    return {
      status: 'healthy',
      db: 'connected',
      active_queue_jobs: activeQueue?.count ?? 0,
      dead_queue_jobs: deadQueue?.count ?? 0,
    };
  }

  private async insertScenarioCustomers(scenarioId: number, input: SaveSandboxScenarioInput): Promise<void> {
    for (const customer of input.customers) {
      await this.db.run(
        `INSERT INTO sandbox_customers
         (scenario_id, customer_id, archetype, risk_tier, balance, clv, win_rate, lifetime_wagers, tags_json, profile_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scenarioId,
          customer.customer_id,
          customer.archetype,
          customer.risk_tier || null,
          customer.balance,
          customer.clv,
          customer.win_rate,
          customer.lifetime_wagers,
          JSON.stringify(customer.tags || []),
          JSON.stringify(customer.profile || {}),
        ]
      );

      if (input.config.snapshotsEnabled && customer.snapshot?.length) {
        for (const snapshot of customer.snapshot) {
          await this.db.run(
            `INSERT INTO sandbox_snapshots
             (scenario_id, customer_id, day_index, balance, pnl, wager_count, clv, win_rate)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              scenarioId,
              customer.customer_id,
              snapshot.day_index,
              snapshot.balance,
              snapshot.pnl,
              snapshot.wager_count,
              snapshot.clv,
              snapshot.win_rate,
            ]
          );
        }
      }
    }
  }

  private async assertScenarioCustomers(scenarioId: number, customerIds: string[]): Promise<void> {
    if (customerIds.length === 0) throw new Error('At least one customer is required');
    const placeholders = customerIds.map(() => '?').join(',');
    const rows = await this.db.all<{ customer_id: string }>(
      `SELECT customer_id FROM sandbox_customers
       WHERE scenario_id = ? AND customer_id IN (${placeholders})`,
      [scenarioId, ...customerIds]
    );
    if (rows.length !== new Set(customerIds).size) {
      throw new Error('Some customers were not found in the scenario');
    }
  }

  private async getCustomer(scenarioId: number, customerId: string): Promise<FullCustomerRow | null> {
    return this.db.get<FullCustomerRow>(
      `SELECT id, scenario_id, customer_id, archetype, risk_tier, balance, clv, win_rate, lifetime_wagers,
              tags_json, profile_json, summary_json, summary_status, summary_attempts, created_at
       FROM sandbox_customers
       WHERE scenario_id = ? AND customer_id = ?`,
      [scenarioId, customerId]
    );
  }

  private async runABTest(id: number, input: ABTestInput): Promise<void> {
    const results: unknown[] = [];
    try {
      await this.db.run(`UPDATE sandbox_ab_tests SET status = 'running' WHERE id = ?`, [id]);
      for (const customerId of input.customer_ids) {
        const customer = await this.db.get<CustomerRow>(
          `SELECT customer_id, archetype, risk_tier, balance, clv, win_rate, lifetime_wagers,
                  tags_json, profile_json, summary_json, summary_status, summary_attempts
           FROM sandbox_customers
           WHERE scenario_id = ? AND customer_id = ?`,
          [input.scenario_id, customerId]
        );
        if (!customer) throw new Error(`Customer not found: ${customerId}`);
        const [resultA, resultB] = await Promise.all([
          evaluatePromptForCustomer(input.prompt_a, customer),
          evaluatePromptForCustomer(input.prompt_b, customer),
        ]);
        const tierA = resultA.risk_tier;
        const tierB = resultB.risk_tier;
        const severityDiff = Math.abs(tierToNumber(tierA) - tierToNumber(tierB));
        results.push({
          customer_id: customerId,
          result_a: resultA,
          result_b: resultB,
          tier_a: tierA,
          tier_b: tierB,
          agreement: tierA === tierB ? 1 : 0,
          severity_diff: severityDiff,
        });
      }
      const typedResults = results as Array<{ agreement: number; severity_diff: number }>;
      const agreementScore = typedResults.reduce((sum, row) => sum + row.agreement, 0) / typedResults.length;
      const avgSeverityDiff = typedResults.reduce((sum, row) => sum + row.severity_diff, 0) / typedResults.length;
      await this.db.run(
        `UPDATE sandbox_ab_tests
         SET status = 'completed', results_json = ?, agreement_score = ?, avg_severity_diff = ?,
             significant = ?, completed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(results), agreementScore, avgSeverityDiff, agreementScore < 0.7 ? 1 : 0, id]
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db.run(
        `UPDATE sandbox_ab_tests SET status = 'failed', results_json = ? WHERE id = ?`,
        [JSON.stringify({ error: message, partial_results: results }), id]
      );
    }
  }
}

export function startSandboxQueueProcessor(db: Database): void {
  if (queueProcessors.has(db)) return;
  const interval = setInterval(() => {
    void processQueueBatch(db);
  }, 2_000);
  queueProcessors.set(db, interval);
}

export function startSandboxJanitor(db: Database): void {
  if (janitors.has(db)) return;
  const interval = setInterval(() => {
    void runSandboxJanitor(db);
  }, 3_600_000);
  janitors.set(db, interval);
  void runSandboxJanitor(db);
}

export async function runSandboxJanitor(db: Database): Promise<void> {
  try {
    await db.run(
      `UPDATE sandbox_scenarios
       SET is_archived = 1, updated_at = CURRENT_TIMESTAMP
       WHERE is_archived = 0 AND updated_at < datetime('now', ?)`,
      [`-${SCENARIO_TTL_DAYS} days`]
    );
    await db.run(
      `DELETE FROM sandbox_summary_queue
       WHERE status = 'completed' AND completed_at < datetime('now', ?)`,
      [`-${QUEUE_CLEANUP_DAYS} days`]
    );
    await db.run(
      `DELETE FROM sandbox_summary_queue
       WHERE status = 'dead' AND completed_at IS NOT NULL AND completed_at < datetime('now', '-30 days')`,
      []
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Sandbox] Janitor failed: ${message}`);
  }
}

export async function processQueueBatch(db: Database): Promise<void> {
  await recoverStaleProcessingJobs(db);
  const jobs = await db.all<QueueJobRow>(
    `SELECT id, scenario_id, customer_id, attempts
     FROM sandbox_summary_queue
     WHERE status IN ('queued', 'failed')
       AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
       AND attempts < ?
     ORDER BY created_at
     LIMIT ?`,
    [MAX_RETRIES, QUEUE_CONCURRENCY]
  );
  for (let i = 0; i < jobs.length; i++) {
    if (i > 0) await Bun.sleep(QUEUE_JOB_DELAY_MS);
    await processSingleJob(db, jobs[i]);
  }
}

async function processSingleJob(db: Database, job: QueueJobRow): Promise<void> {
  const claimed = await db.run(
    `UPDATE sandbox_summary_queue
     SET status = 'processing', attempts = attempts + 1, processing_started_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('queued', 'failed') AND attempts < ?`,
    [job.id, MAX_RETRIES]
  );
  if (claimed.changes === 0) return;

  const attempts = job.attempts + 1;
  try {
    const customer = await db.get<CustomerRow>(
      `SELECT customer_id, archetype, risk_tier, balance, clv, win_rate, lifetime_wagers,
              tags_json, profile_json, summary_json, summary_status, summary_attempts
       FROM sandbox_customers
       WHERE scenario_id = ? AND customer_id = ?`,
      [job.scenario_id, job.customer_id]
    );
    if (!customer) throw new Error('Customer not found');
    const summary = await generateCustomerSummary(customer);
    const summaryJson = JSON.stringify(summary);

    await withTransaction(db, async () => {
      await db.run(
        `UPDATE sandbox_customers
         SET summary_json = ?, summary_status = 'completed', summary_attempts = ?
         WHERE scenario_id = ? AND customer_id = ?`,
        [summaryJson, attempts, job.scenario_id, job.customer_id]
      );
      await db.run(
        `UPDATE sandbox_summary_queue
         SET status = 'completed', summary_json = ?, attempts = ?, processing_started_at = NULL,
             completed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [summaryJson, attempts, job.id]
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
    const nextAttempt = toSqliteDateTime(Date.now() + delay);
    const dead = attempts >= MAX_RETRIES;
    await withTransaction(db, async () => {
      await db.run(
        `UPDATE sandbox_summary_queue
         SET status = ?, last_error = ?, attempts = ?, next_attempt_at = ?, processing_started_at = NULL
         WHERE id = ?`,
        [dead ? 'dead' : 'failed', message, attempts, dead ? null : nextAttempt, job.id]
      );
      await db.run(
        `UPDATE sandbox_customers
         SET summary_status = 'failed', summary_attempts = ?
         WHERE scenario_id = ? AND customer_id = ?`,
        [attempts, job.scenario_id, job.customer_id]
      );
    });
  }
}

async function recoverStaleProcessingJobs(db: Database): Promise<void> {
  await db.run(
    `UPDATE sandbox_summary_queue
     SET status = CASE WHEN attempts >= ? THEN 'dead' ELSE 'failed' END,
         last_error = COALESCE(last_error, 'Recovered stale processing job'),
         next_attempt_at = CASE WHEN attempts >= ? THEN NULL ELSE CURRENT_TIMESTAMP END,
         processing_started_at = NULL
     WHERE status = 'processing'
       AND (processing_started_at IS NULL OR processing_started_at <= datetime('now', '-2 minutes'))`,
    [MAX_RETRIES, MAX_RETRIES]
  );
}

async function withTransaction<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

async function generateCustomerSummary(customer: CustomerRow): Promise<Record<string, unknown>> {
  const tags = parseJson<string[]>(customer.tags_json, []);
  const score = scoreCustomer(customer);
  const fallback = {
    customer_id: customer.customer_id,
    headline: `${customer.archetype} profile with ${riskTierFromScore(score)} sandbox risk`,
    risk_score: score,
    risk_tier: riskTierFromScore(score),
    risk_level: riskTierFromScore(score),
    summary: `${customer.archetype} profile with CLV ${customer.clv ?? 0}, win rate ${customer.win_rate ?? 0}, and ${customer.lifetime_wagers ?? 0} lifetime wagers.`,
    factors: {
      archetype: customer.archetype,
      clv: customer.clv ?? 0,
      win_rate: customer.win_rate ?? 0,
      lifetime_wagers: customer.lifetime_wagers ?? 0,
      tags,
    },
    confidence: 0.72,
    generated_by: 'sandbox-heuristic',
    generated_at: new Date().toISOString(),
  };

  const apiKey = Bun.env.KIMI_API_KEY;
  if (!apiKey) return fallback;

  try {
    const raw = await callKimi(
      'You are a sportsbook risk analyst. Return compact JSON with risk_level, summary, factors, confidence.',
      JSON.stringify({
        customer_id: customer.customer_id,
        archetype: customer.archetype,
        risk_tier: customer.risk_tier,
        balance: customer.balance,
        clv: customer.clv,
        win_rate: customer.win_rate,
        lifetime_wagers: customer.lifetime_wagers,
        tags,
        profile: parseJson<Record<string, unknown>>(customer.profile_json, {}),
      }),
      apiKey
    );
    const parsed = parseJsonObjectFromText(raw);
    const tier = stringValue(parsed.risk_level) || extractRiskTier(raw);
    return {
      ...fallback,
      risk_tier: tier,
      risk_level: tier,
      summary: stringValue(parsed.summary) || raw.slice(0, 500),
      factors: Array.isArray(parsed.factors) ? parsed.factors : fallback.factors,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : fallback.confidence,
      raw_response: raw,
      generated_by: 'kimi',
    };
  } catch (err) {
    return {
      ...fallback,
      kimi_error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    };
  }
}

async function evaluatePromptForCustomer(prompt: string, customer: CustomerRow): Promise<SandboxPromptResult> {
  const apiKey = Bun.env.KIMI_API_KEY;
  if (apiKey) {
    try {
      const raw = await callKimi(
        prompt,
        `Analyze customer: ${JSON.stringify({
          customer_id: customer.customer_id,
          archetype: customer.archetype,
          risk_tier: customer.risk_tier,
          balance: customer.balance,
          clv: customer.clv,
          win_rate: customer.win_rate,
          lifetime_wagers: customer.lifetime_wagers,
          tags: parseJson<string[]>(customer.tags_json, []),
        })}`,
        apiKey
      );
      const tier = extractRiskTier(raw);
      return {
        risk_score: Math.max(0, Math.min(100, tierToNumber(tier) * 25)),
        risk_tier: tier,
        rationale: raw.slice(0, 1_000),
      };
    } catch {
      // Keep AB testing usable offline or when Kimi is unavailable.
    }
  }

  const baseScore = scoreCustomer(customer);
  const lower = prompt.toLowerCase();
  const adjustment = lower.includes('strict') || lower.includes('aggressive') ? 10
    : lower.includes('conservative') || lower.includes('lenient') ? -10
      : 0;
  const score = Math.max(0, Math.min(100, baseScore + adjustment));
  return {
    risk_score: score,
    risk_tier: riskTierFromScore(score),
    rationale: `Prompt-adjusted sandbox evaluation for ${customer.customer_id}`,
  };
}

function scoreCustomer(customer: CustomerRow): number {
  let score = 20;
  const clv = Number(customer.clv ?? 0);
  const winRate = Number(customer.win_rate ?? 0);
  const balance = Number(customer.balance ?? 0);
  const lifetimeWagers = Number(customer.lifetime_wagers ?? 0);
  if (clv > 0.08) score += 30;
  else if (clv > 0.03) score += 15;
  if (winRate > 0.58) score += 20;
  if (balance > 10_000) score += 10;
  if (lifetimeWagers > 1_000) score += 10;
  if (customer.archetype.toLowerCase().includes('sharp')) score += 15;
  return Math.max(0, Math.min(100, score));
}

async function callKimi(systemPrompt: string, userContent: string, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'kimi-latest',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 512,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Kimi API ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeout);
  }
}

function extractRiskTier(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('black') || lower.includes('critical') || lower.includes('severe')) return 'BLACK';
  if (lower.includes('red') || lower.includes('high risk')) return 'RED';
  if (lower.includes('yellow') || lower.includes('medium') || lower.includes('moderate')) return 'YELLOW';
  if (lower.includes('green') || lower.includes('low risk') || lower.includes('safe')) return 'GREEN';
  return 'UNKNOWN';
}

function parseJsonObjectFromText(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  return parseJson<Record<string, unknown>>(match[0], {});
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function customerToFeature(customer: CustomerRow): Record<string, unknown> {
  const tags = parseJson<string[]>(customer.tags_json, []);
  const profile = parseJson<Record<string, unknown>>(customer.profile_json, {});
  const summary = customer.summary_json ? parseJson<Record<string, unknown>>(customer.summary_json, {}) : {};
  const balance = Number(customer.balance ?? 0);
  const lifetimeWagers = Number(customer.lifetime_wagers ?? 0);
  return {
    customer_id: customer.customer_id,
    extracted_at: new Date().toISOString(),
    feature_version: 1,
    lifetime_wagers: lifetimeWagers,
    avg_wager_size: numberValue(profile.avg_wager_size) ?? balance / Math.max(lifetimeWagers, 1),
    max_wager_size: numberValue(profile.max_wager_size) ?? balance,
    win_rate: customer.win_rate ?? 0,
    days_since_last_wager: 0,
    sport_diversity_score: numberValue(profile.sport_diversity) ?? 0.5,
    deposit_velocity_30d: numberValue(profile.deposit_velocity) ?? 0,
    withdrawal_ratio: numberValue(profile.withdrawal_ratio) ?? 0,
    bonus_dependency: tags.includes('Bonus Abuser') ? 0.8 : 0.1,
    sharp_score: customer.clv ?? 0,
    chase_flag: tags.includes('Chasing') ? 1 : 0,
    archetype: customer.archetype,
    risk_tier: customer.risk_tier || summary.risk_level || summary.risk_tier || 'UNKNOWN',
    synthetic: 1,
  };
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function riskTierFromScore(score: number): string {
  if (score >= 85) return 'BLACK';
  if (score >= 65) return 'RED';
  if (score >= 40) return 'YELLOW';
  return 'GREEN';
}

function tierToNumber(tier: string): number {
  return { BLACK: 4, RED: 3, YELLOW: 2, GREEN: 1, UNKNOWN: 0 }[tier] ?? 0;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toSqliteDateTime(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 19).replace('T', ' ');
}

function defaultConfig(): SandboxConfig {
  return {
    customerCount: 0,
    archetypesEnabled: false,
    snapshotsEnabled: false,
    aiSummariesEnabled: false,
  };
}
