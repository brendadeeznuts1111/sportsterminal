/**
 * ActionQueue
 * Per-agent action queues with UUID generation, timeout, and expiry.
 * Used for Accept/Decline on the Buckeye bet ticker.
 */
import type { Database } from '../database';

export interface ActionRequest {
  id: string;
  agentId: string;
  wagerNumber: number;
  action: 'accept' | 'decline';
  amount?: number;
  reason?: string;
  createdAt: number;
}

export interface ActionResult {
  id: string;
  success: boolean;
  action: 'accept' | 'decline';
  wagerNumber: number;
  message: string;
  error?: string;
}

export type ActionExecutor = (request: ActionRequest) => Promise<ActionResult>;

const DEFAULT_TIMEOUT_MS = 30_000;

export class ActionQueue {
  private queues: Map<string, ActionRequest[]> = new Map();
  private timeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private db: Database;
  private broadcast: (msg: object) => void;
  private timeoutMs: number;
  private executor: ActionExecutor;

  constructor(
    db: Database,
    broadcast: (msg: object) => void,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    executor?: ActionExecutor
  ) {
    this.db = db;
    this.broadcast = broadcast;
    this.timeoutMs = timeoutMs;
    this.executor = executor || (async (request) => ({
      id: request.id,
      success: false,
      action: request.action,
      wagerNumber: request.wagerNumber,
      message: 'Action executor unavailable',
      error: 'No action executor configured',
    }));
  }

  /**
   * Generate a unique action ID.
   */
  private generateId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // v4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /**
   * Enqueue an action for an agent.
   * Actions within the same agent queue are processed sequentially.
   */
  async enqueue(
    agentId: string,
    wagerNumber: number,
    action: 'accept' | 'decline',
    amount?: number,
    reason?: string
  ): Promise<string> {
    const request: ActionRequest = {
      id: this.generateId(),
      agentId,
      wagerNumber,
      action,
      amount,
      reason,
      createdAt: Date.now(),
    };

    let queue = this.queues.get(agentId);
    if (!queue) {
      queue = [];
      this.queues.set(agentId, queue);
    }
    queue.push(request);

    // If this is the only item, process immediately
    if (queue.length === 1) {
      this.processNext(agentId);
    }

    return request.id;
  }

  /**
   * Get the current queue length for an agent.
   */
  getQueueLength(agentId: string): number {
    return this.queues.get(agentId)?.length || 0;
  }

  /**
   * Clear all queues (e.g., on agent stop).
   */
  clearAgent(agentId: string): void {
    const timeout = this.timeouts.get(agentId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(agentId);
    }
    this.queues.delete(agentId);
  }

  /**
   * Process the next action in an agent's queue.
   */
  private processNext(agentId: string): void {
    const queue = this.queues.get(agentId);
    if (!queue || queue.length === 0) return;

    const request = queue[0];

    // Set a timeout for this action
    const timeout = setTimeout(() => {
      const result: ActionResult = {
        id: request.id,
        success: false,
        action: request.action,
        wagerNumber: request.wagerNumber,
        message: 'Action timed out',
        error: `Action timed out after ${this.timeoutMs}ms`,
      };
      this.broadcast({
        type: 'betAction',
        timestamp: new Date().toISOString(),
        agentId: request.agentId,
        payload: result,
      });
      // Remove from queue
      queue.shift();
      this.timeouts.delete(agentId);
      this.processNext(agentId);
    }, this.timeoutMs);

    this.timeouts.set(agentId, timeout);
    this.executor(request)
      .then(result => this.completeAction(request.id, result))
      .catch(error => this.completeAction(request.id, {
        id: request.id,
        success: false,
        action: request.action,
        wagerNumber: request.wagerNumber,
        message: 'Action failed',
        error: error instanceof Error ? error.message : 'Unknown action error',
      }));
  }

  /**
   * Complete an action by ID.
   * Called when the agent or backend confirms the action result.
   */
  completeAction(actionId: string, result: ActionResult): void {
    // Find which agent queue contains this action
    for (const [agentId, queue] of this.queues) {
      const idx = queue.findIndex(r => r.id === actionId);
      if (idx === -1) continue;

      // Clear timeout
      const timeout = this.timeouts.get(agentId);
      if (timeout) {
        clearTimeout(timeout);
        this.timeouts.delete(agentId);
      }

      // Remove from queue
      queue.splice(idx, 1);

      // Broadcast result
      this.broadcast({
        type: 'betAction',
        timestamp: new Date().toISOString(),
        agentId,
        payload: { ...result, id: actionId },
      });

      // Process next
      this.processNext(agentId);
      return;
    }
  }

  /**
   * Get metrics for Prometheus or health checks.
   */
  getMetrics(): { totalQueued: number; queues: Record<string, number> } {
    const queues: Record<string, number> = {};
    let total = 0;
    for (const [agentId, queue] of this.queues) {
      queues[agentId] = queue.length;
      total += queue.length;
    }
    return { totalQueued: total, queues };
  }
}
