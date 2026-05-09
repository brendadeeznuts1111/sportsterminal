export interface ManagedIntervalTask {
  readonly name: string;
  stop(): void;
  restart(intervalMs?: number, initialDelayMs?: number): void;
  isRunning(): boolean;
}

interface ManagedIntervalOptions {
  initialDelayMs?: number;
  onError?: (error: unknown) => void;
}

export function createManagedInterval(
  name: string,
  intervalMs: number,
  task: () => Promise<void> | void,
  options: ManagedIntervalOptions = {}
): ManagedIntervalTask {
  let active = false;
  let generation = 0;
  let currentIntervalMs = Math.max(1, intervalMs);

  const runLoop = async (loopGeneration: number, initialDelayMs: number): Promise<void> => {
    if (initialDelayMs > 0) {
      await Bun.sleep(initialDelayMs);
    }

    while (active && loopGeneration === generation) {
      const startedAt = performance.now();
      try {
        await task();
      } catch (error) {
        if (options.onError) {
          options.onError(error);
        } else {
          console.warn(`[Scheduler] ${name} failed:`, error instanceof Error ? error.message : error);
        }
      }

      const elapsedMs = performance.now() - startedAt;
      await Bun.sleep(Math.max(1, currentIntervalMs - elapsedMs));
    }
  };

  const scheduledTask: ManagedIntervalTask = {
    name,
    stop() {
      active = false;
      generation++;
    },
    restart(nextIntervalMs = currentIntervalMs, initialDelayMs = nextIntervalMs) {
      currentIntervalMs = Math.max(1, nextIntervalMs);
      active = true;
      generation++;
      void runLoop(generation, Math.max(0, initialDelayMs));
    },
    isRunning() {
      return active;
    },
  };

  scheduledTask.restart(currentIntervalMs, options.initialDelayMs ?? currentIntervalMs);
  return scheduledTask;
}
