import { describe, test, expect, beforeEach } from 'bun:test';
import { ActionQueue, type ActionExecutor, type ActionResult } from '../src/actions/ActionQueue';
import type { Database } from '../src/database';

interface BetActionMessage {
  type: 'betAction';
  payload: ActionResult;
}

describe('ActionQueue', () => {
  let received: object[];

  beforeEach(() => {
    received = [];
  });

  function makeBroadcast() {
    return (msg: object) => { received.push(msg); };
  }

  function makeDb(): Database {
    return {
      run: async () => ({ lastID: 1, changes: 1 }),
      get: async () => null,
      all: async () => [],
    } as unknown as Database;
  }

  function pendingExecutor(): ActionExecutor {
    return () => new Promise(() => {});
  }

  test('enqueues an action and returns an ID', async () => {
    const queue = new ActionQueue(makeDb(), makeBroadcast(), 5000, pendingExecutor());
    const id = await queue.enqueue('AGENT1', 123, 'accept');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('queue length increases with multiple items', async () => {
    const queue = new ActionQueue(makeDb(), makeBroadcast(), 5000, pendingExecutor());
    await queue.enqueue('AGENT1', 1, 'accept');
    expect(queue.getQueueLength('AGENT1')).toBe(1);
    await queue.enqueue('AGENT1', 2, 'decline');
    expect(queue.getQueueLength('AGENT1')).toBe(2);
  });

  test('actions time out after the configured timeout', async () => {
    const queue = new ActionQueue(makeDb(), makeBroadcast(), 100, pendingExecutor());
    await queue.enqueue('AGENT2', 456, 'accept');

    // Wait for timeout
    await new Promise(r => setTimeout(r, 200));

    const betActions = received.filter(isBetActionMessage);
    expect(betActions.length).toBeGreaterThanOrEqual(1);
    const result = betActions[0].payload;
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  test('executes queued actions and broadcasts completion', async () => {
    const queue = new ActionQueue(makeDb(), makeBroadcast(), 5000, async (request) => ({
      id: request.id,
      success: true,
      action: request.action,
      wagerNumber: request.wagerNumber,
      message: 'done',
    }));

    await queue.enqueue('AGENT2', 789, 'decline');
    await new Promise(r => setTimeout(r, 0));

    const betActions = received.filter(isBetActionMessage);
    expect(betActions.length).toBe(1);
    expect(betActions[0].payload.success).toBe(true);
    expect(queue.getQueueLength('AGENT2')).toBe(0);
  });

  test('queues are per-agent (independent)', async () => {
    const queue = new ActionQueue(makeDb(), makeBroadcast(), 5000, pendingExecutor());
    await queue.enqueue('AGENT_A', 1, 'accept');
    await queue.enqueue('AGENT_B', 2, 'decline');
    expect(queue.getQueueLength('AGENT_A')).toBe(1);
    expect(queue.getQueueLength('AGENT_B')).toBe(1);
  });

  test('clearAgent empties the queue', async () => {
    const queue = new ActionQueue(makeDb(), makeBroadcast(), 5000, pendingExecutor());
    await queue.enqueue('AGENT3', 1, 'accept');
    await queue.enqueue('AGENT3', 2, 'decline');
    expect(queue.getQueueLength('AGENT3')).toBe(2);
    queue.clearAgent('AGENT3');
    expect(queue.getQueueLength('AGENT3')).toBe(0);
  });

  test('getMetrics returns queue state', async () => {
    const queue = new ActionQueue(makeDb(), makeBroadcast(), 5000, pendingExecutor());
    await queue.enqueue('A1', 1, 'accept');
    await queue.enqueue('A1', 2, 'decline');
    await queue.enqueue('A2', 3, 'accept');

    const metrics = queue.getMetrics();
    expect(metrics.totalQueued).toBe(3);
    expect(metrics.queues['A1']).toBe(2);
    expect(metrics.queues['A2']).toBe(1);
  });
});

function isBetActionMessage(message: object): message is BetActionMessage {
  return 'type' in message && message.type === 'betAction';
}
