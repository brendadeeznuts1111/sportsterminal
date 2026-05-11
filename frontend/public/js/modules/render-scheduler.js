/**
 * Render Scheduler — batches DOM updates via requestAnimationFrame.
 * Replaces the ad-hoc `scheduleRender` / `renderFrameId` pattern in app.js.
 */

import { logger } from '../logger.js';

// Priority order: lower index = higher priority
const PRIORITY = [
  'backend',
  'buckeye',
  'oddsMatrix',
  'patterns',
  'positions',
  'playerProfile',
  'playerSearch',
  'agentNetwork',
  'performance',
  'webhooks',
  'apiStatus',
  'settings',
  'modals',
  'toast',
];

const queue = new Map(); // scope -> { fn, priority }
let rafId = null;
let isRunning = false;

function run() {
  rafId = null;
  if (queue.size === 0) return;

  // Sort by priority index, then execute
  const tasks = [...queue.entries()]
    .map(([scope, task]) => ({ scope, ...task }))
    .sort((a, b) => {
      const pa = PRIORITY.indexOf(a.priority);
      const pb = PRIORITY.indexOf(b.priority);
      return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
    });

  queue.clear();

  for (const task of tasks) {
    try {
      task.fn();
      logger.debug('Render', `Executed ${task.scope}`);
    } catch (err) {
      logger.error('Render', `Failed ${task.scope}:`, err);
    }
  }
}

function scheduleFlush() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(run);
}

/**
 * Schedule a render task. Duplicate scopes are deduped (last write wins).
 * @param {string} scope — logical scope name (e.g. 'oddsMatrix')
 * @param {Function} fn — render function
 * @param {string} [priority] — optional override; defaults to scope name lookup
 */
export function schedule(scope, fn, priority = scope) {
  queue.set(scope, { fn, priority });
  scheduleFlush();
}

/**
 * Execute immediately (synchronously). Use for user-initiated actions
 * that must not wait for the next frame.
 * @param {string} scope
 * @param {Function} fn
 */
export function scheduleImmediate(scope, fn) {
  try {
    fn();
    logger.debug('Render', `Immediate ${scope}`);
  } catch (err) {
    logger.error('Render', `Immediate ${scope} failed:`, err);
  }
}

/**
 * Cancel a pending render for the given scope.
 * @param {string} scope
 */
export function cancel(scope) {
  queue.delete(scope);
}

/**
 * Cancel all pending renders.
 */
export function cancelAll() {
  queue.clear();
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

/**
 * Returns true if there are pending renders.
 */
export function hasPending() {
  return queue.size > 0;
}

/**
 * Returns the number of pending render scopes.
 */
export function pendingCount() {
  return queue.size;
}
