import type { Database } from '../database';
import { COMMAND_CENTER_MAP } from '../config/commandCenterMap';

export interface StartShadowAbInput {
  customer_ids: string[];
  prompt_a: string;
  prompt_b: string;
  name?: string;
}

export interface StartShadowAbResult {
  id: number;
  status: 'running';
}

export class ShadowAgentService {
  constructor(
    private readonly db: Database,
    private readonly workerUrl: string = new URL('../workers/shadowAgentWorker.ts', import.meta.url).href
  ) { }

  async start(input: StartShadowAbInput): Promise<StartShadowAbResult> {
    const customerIds = [...new Set(input.customer_ids.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
    if (customerIds.length === 0) throw new Error(COMMAND_CENTER_MAP.errors.customerIdsRequired.message);
    if (!input.prompt_a.trim() || !input.prompt_b.trim()) throw new Error(COMMAND_CENTER_MAP.errors.promptsRequired.message);

    const result = await this.db.run(
      `INSERT INTO live_shadow_ab_tests (
        name, prompt_a, prompt_b, customer_ids_json, status
      ) VALUES (?, ?, ?, ?, 'running')`,
      [
        input.name?.trim() || `Shadow A/B ${new Date().toISOString()}`,
        input.prompt_a,
        input.prompt_b,
        JSON.stringify(customerIds),
      ]
    );

    const id = result.lastID;
    console.log(`[${COMMAND_CENTER_MAP.logEvents.shadowAbStarted}] id=${id} customers=${customerIds.length}`);
    this.spawnWorker({
      id,
      customer_ids: customerIds,
      prompt_a: input.prompt_a,
      prompt_b: input.prompt_b,
    });

    return { id, status: 'running' };
  }

  async get(id: number): Promise<Record<string, unknown> | null> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT * FROM live_shadow_ab_tests WHERE id = ?`,
      [id]
    );
    if (!row) return null;
    return {
      ...row,
      customer_ids: parseJsonField(row.customer_ids_json),
      results: parseJsonField(row.results_json),
    };
  }

  private spawnWorker(payload: {
    id: number;
    customer_ids: string[];
    prompt_a: string;
    prompt_b: string;
  }): void {
    const worker = new Worker(this.workerUrl, { type: 'module' });
    worker.onmessage = () => {
      worker.terminate();
    };
    worker.onerror = (error) => {
      console.error(`[${COMMAND_CENTER_MAP.logEvents.shadowAbFailed}]`, error.message);
      void this.db.run(
        `UPDATE live_shadow_ab_tests
            SET status='failed', error=?, completed_at=datetime('now')
          WHERE id=?`,
        [error.message, payload.id]
      ).finally(() => worker.terminate());
    };
    worker.postMessage(payload);
  }
}

function parseJsonField(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
