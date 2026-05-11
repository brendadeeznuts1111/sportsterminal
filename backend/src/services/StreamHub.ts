/**
 * StreamHub — Server-Sent Events (SSE) fan-out
 *
 * Bun-native pattern: one in-memory pub/sub hub that converts internal
 * broadcast() calls into SSE async generators. Each connected client gets
 * its own AsyncIterableQueue; messages are filtered per-topic.
 *
 * Topics:
 *   - "wagers"          : every new wager
 *   - "wagers:<player>" : wagers for a specific player
 *   - "positions"       : risk position lifecycle events
 *   - "alerts"          : risk alerts dispatched
 *   - "analysis:<id>"   : Kimi token chunks for a streaming analysis
 *   - "ticker"          : low-cardinality heartbeat with stats
 */
import { COMMAND_CENTER_MAP } from '../config/commandCenterMap';

type Subscriber = {
  id: number;
  topics: Set<string>;
  queue: ((value: SseEvent | null) => void)[];
  buffer: SseEvent[];
  closed: boolean;
};

type RingEvent = {
  topic: string;
  event: SseEvent;
};

export interface SseEvent {
  event: string;
  data: unknown;
  id?: string | number;
}

export class StreamHub {
  private subscribers = new Map<number, Subscriber>();
  private nextId = 1;
  private ring: RingEvent[] = [];
  private readonly ringLimit = COMMAND_CENTER_MAP.sse.ringLimit;

  /**
   * Register a new subscriber. Returns an id and an AsyncGenerator
   * that yields SSE-formatted strings until the connection closes.
   */
  subscribe(topics: string[]): { id: number; stream: AsyncGenerator<string> } {
    const id = this.nextId++;
    const sub: Subscriber = {
      id,
      topics: new Set(topics),
      queue: [],
      buffer: [],
      closed: false,
    };
    this.subscribers.set(id, sub);

    return { id, stream: this.createStream(sub, topics) };
  }

  /** Disconnect a subscriber */
  unsubscribe(id: number): void {
    const sub = this.subscribers.get(id);
    if (!sub) return;
    sub.closed = true;
    // Resolve any pending waiter with null so the generator exits
    for (const resolve of sub.queue) resolve(null);
    sub.queue = [];
    this.subscribers.delete(id);
  }

  /**
   * Publish an event to all subscribers whose topics include `topic`.
   * Wildcard match: a subscriber to "wagers" receives "wagers:*" too.
   */
  publish(topic: string, event: SseEvent): void {
    this.ring.push({ topic, event });
    if (this.ring.length > this.ringLimit) this.ring.shift();

    for (const sub of this.subscribers.values()) {
      if (sub.closed) continue;
      if (!matchesTopic(sub.topics, topic)) continue;

      if (sub.queue.length > 0) {
        // Hand off to the oldest waiter
        const resolve = sub.queue.shift()!;
        resolve(event);
      } else {
        // Buffer (cap at 200 events per subscriber to bound memory)
        sub.buffer.push(event);
        if (sub.buffer.length > 200) sub.buffer.shift();
      }
    }
  }

  /** Number of currently connected subscribers */
  get count(): number {
    return this.subscribers.size;
  }

  /** Subscriber count for a specific topic */
  countForTopic(topic: string): number {
    let n = 0;
    for (const sub of this.subscribers.values()) {
      if (matchesTopic(sub.topics, topic)) n++;
    }
    return n;
  }

  /** Broadcast a heartbeat event (called by Bun.cron tick) */
  heartbeat(payload: Record<string, unknown> = {}): void {
    this.publish('ticker', {
      event: COMMAND_CENTER_MAP.sse.events.heartbeat,
      data: { now: Date.now(), subscribers: this.count, ...payload },
    });
  }

  /** Close all subscribers (graceful shutdown) */
  closeAll(): void {
    for (const id of [...this.subscribers.keys()]) this.unsubscribe(id);
  }

  private replayFor(sub: Subscriber): SseEvent[] {
    return this.ring
      .filter((entry) => matchesTopic(sub.topics, entry.topic))
      .map((entry) => entry.event)
      .slice(-COMMAND_CENTER_MAP.sse.replayLimit);
  }

  private async *createStream(sub: Subscriber, topics: string[]): AsyncGenerator<string> {
    const replay = this.replayFor(sub);
    yield formatSse({ event: COMMAND_CENTER_MAP.sse.events.connected, data: { id: sub.id, topics, replayed: replay.length } });

    for (const evt of replay) {
      yield formatSse(evt);
    }

    try {
      while (!sub.closed) {
        while (sub.buffer.length > 0) {
          const evt = sub.buffer.shift()!;
          yield formatSse(evt);
        }

        const evt = await new Promise<SseEvent | null>((resolve) => {
          sub.queue.push(resolve);
        });

        if (evt === null) return;
        yield formatSse(evt);
      }
    } finally {
      this.unsubscribe(sub.id);
    }
  }
}

function matchesTopic(subTopics: Set<string>, eventTopic: string): boolean {
  // Direct match
  if (subTopics.has(eventTopic)) return true;
  // Wildcard "all"
  if (subTopics.has('*') || subTopics.has('all')) return true;
  // Prefix match: subscriber to "wagers" gets "wagers:abc"
  for (const t of subTopics) {
    if (eventTopic.startsWith(t + ':')) return true;
  }
  return false;
}

function formatSse(evt: SseEvent): string {
  const lines: string[] = [];
  if (evt.id !== undefined) lines.push(`id: ${evt.id}`);
  if (evt.event) lines.push(`event: ${evt.event}`);
  const data = typeof evt.data === 'string' ? evt.data : JSON.stringify(evt.data);
  // SSE spec: split data on \n, prefix each line with "data: "
  for (const line of data.split('\n')) lines.push(`data: ${line}`);
  return lines.join('\n') + '\n\n';
}

// Singleton instance — shared across services
export const streamHub = new StreamHub();
