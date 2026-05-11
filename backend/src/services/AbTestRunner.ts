/**
 * AbTestRunner — main-thread interface to the abTestWorker.
 *
 * Bun-native: `new Worker("./worker.ts")` loads TypeScript without a build step.
 * The worker is reused across requests; messages are correlated via incrementing
 * id and resolved via a Map<id, resolver>.
 */

interface AbRequest {
  id: number;
  customer_id: string;
  snapshot: Record<string, unknown>;
  prompt_a: string;
  prompt_b: string;
}

interface AbResult {
  prompt_label: 'A' | 'B';
  risk_level: string;
  confidence: number;
  raw: string;
  duration_ms: number;
  error?: string;
}

interface AbResponse {
  id: number;
  ok: boolean;
  customer_id?: string;
  result_a?: AbResult;
  result_b?: AbResult;
  agreement?: number;
  error?: string;
}

export class AbTestRunner {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, (resp: AbResponse) => void>();
  private workerUrl: string;

  constructor(workerUrl: string = new URL('../workers/abTestWorker.ts', import.meta.url).href) {
    this.workerUrl = workerUrl;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<AbResponse>) => {
      const resp = event.data;
      const resolver = this.pending.get(resp.id);
      if (resolver) {
        this.pending.delete(resp.id);
        resolver(resp);
      }
    };
    this.worker.onerror = (err) => {
      console.error('[AbTestRunner] Worker error:', err);
      // Reject all pending — worker is dead
      for (const [id, resolve] of this.pending) {
        resolve({ id, ok: false, error: 'worker_error' });
      }
      this.pending.clear();
      this.worker = null;
    };
    return this.worker;
  }

  /**
   * Run a paired AB test; resolves with both Kimi results plus an agreement score.
   * 30 second timeout — worker is killed if a single test hangs.
   */
  async run(input: Omit<AbRequest, 'id'>): Promise<AbResponse> {
    const id = this.nextId++;
    const req: AbRequest = { id, ...input };
    const worker = this.ensureWorker();

    return new Promise<AbResponse>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ id, ok: false, error: 'ab_test_timeout' });
        }
      }, 30_000);

      this.pending.set(id, (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      });

      worker.postMessage(req);
    });
  }

  /**
   * Run several tests sequentially through the worker; results stream back
   * as Promise.all. The worker handles concurrency internally with Promise.all
   * over Kimi calls, but back-to-back calls share the worker.
   */
  async runBatch(inputs: Omit<AbRequest, 'id'>[]): Promise<AbResponse[]> {
    return Promise.all(inputs.map((i) => this.run(i)));
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [id, resolve] of this.pending) {
      resolve({ id, ok: false, error: 'terminated' });
    }
    this.pending.clear();
  }
}

// Lazy singleton — create on first use only
let runnerInstance: AbTestRunner | null = null;
export function getAbTestRunner(): AbTestRunner {
  if (!runnerInstance) runnerInstance = new AbTestRunner();
  return runnerInstance;
}
