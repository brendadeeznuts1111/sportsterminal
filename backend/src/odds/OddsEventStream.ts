/**
 * Server-sent events stream of odds price deltas.
 *
 * OddsPoller.poll() publishes a snapshot on the first book, then one
 * `odds` event per game/book whose price or line actually changed.
 * Each event has a monotonic `id:` so EventSource can resume with
 * Last-Event-ID. A fresh EventSource cannot set that header, so the
 * route also accepts `?lastEventId=` for manual reconnects.
 */

import type { BookOdds, EventOdds } from './types';

export type OddsMarket = 'moneyline' | 'spread' | 'total';
export type OddsSide = 'home' | 'away' | 'over' | 'under';

export interface OddsPriceChange {
  market: OddsMarket;
  side: OddsSide;
  line: number | null;
  price: number | null;
  previousLine: number | null;
  previousPrice: number | null;
}

export interface OddsDeltaPayload {
  eventId: string;
  book: string;
  changes: OddsPriceChange[];
}

export interface OddsSnapshotPayload {
  generatedAt: string;
  games: Array<{ eventId: string; books: BookOdds[] }>;
}

export interface OddsStreamEvent {
  id: number;
  event: 'odds' | 'snapshot' | 'heartbeat';
  data: OddsDeltaPayload | OddsSnapshotPayload | { serverTime: number };
}

interface Subscriber {
  send: (chunk: string) => void;
  close: () => void;
}

export interface OddsEventStreamOptions {
  heartbeatMs?: number;
  bufferLimit?: number;
}

const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_BUFFER_LIMIT = 2000;

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface SideQuote {
  market: OddsMarket;
  side: OddsSide;
  line: number | null;
  price: number | null;
}

export function quoteSides(book: BookOdds): SideQuote[] {
  return [
    { market: 'moneyline', side: 'home', line: null, price: finite(book.moneylineHome) },
    { market: 'moneyline', side: 'away', line: null, price: finite(book.moneylineAway) },
    { market: 'spread', side: 'home', line: finite(book.spreadHome), price: finite(book.spreadHomePrice) },
    { market: 'spread', side: 'away', line: finite(book.spreadAway), price: finite(book.spreadAwayPrice) },
    { market: 'total', side: 'over', line: finite(book.totalOver), price: finite(book.totalOverPrice) },
    { market: 'total', side: 'under', line: finite(book.totalUnder), price: finite(book.totalUnderPrice) },
  ];
}

export function diffBook(previous: BookOdds | undefined, next: BookOdds): OddsPriceChange[] {
  const before = new Map((previous ? quoteSides(previous) : []).map((side) => [`${side.market}:${side.side}`, side]));
  const changes: OddsPriceChange[] = [];
  for (const side of quoteSides(next)) {
    const prev = before.get(`${side.market}:${side.side}`);
    const previousLine = prev?.line ?? null;
    const previousPrice = prev?.price ?? null;
    if (previousLine === side.line && previousPrice === side.price) continue;
    changes.push({
      market: side.market,
      side: side.side,
      line: side.line,
      price: side.price,
      previousLine,
      previousPrice,
    });
  }
  return changes;
}

export function encodeSse(event: OddsStreamEvent): string {
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function readLastEventId(request: Request): number | null {
  const header = request.headers.get('last-event-id');
  const url = new URL(request.url);
  const raw = header ?? url.searchParams.get('lastEventId');
  if (raw == null || raw.trim() === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) return null;
  return id;
}

export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Last-Event-ID',
};

export class OddsEventStream {
  private nextId = 1;
  private buffer: OddsStreamEvent[] = [];
  private latestSnapshot: OddsStreamEvent | null = null;
  private subscribers = new Set<Subscriber>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatMs: number;
  private readonly bufferLimit: number;

  constructor(options: OddsEventStreamOptions = {}) {
    const heartbeatMs = options.heartbeatMs ?? readPositiveInt(process.env.ODDS_STREAM_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS);
    this.heartbeatMs = heartbeatMs;
    this.bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  }

  start(): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => {
      this.emit('heartbeat', { serverTime: Date.now() });
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  stop(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const subscriber of this.subscribers) subscriber.close();
    this.subscribers.clear();
  }

  publishSnapshot(odds: EventOdds[]): OddsStreamEvent {
    const data: OddsSnapshotPayload = {
      generatedAt: new Date().toISOString(),
      games: odds.map((entry) => ({
        eventId: entry.event.id,
        books: entry.books,
      })),
    };
    return this.emit('snapshot', data);
  }

  publishPriceDeltas(previous: EventOdds[], next: EventOdds[]): OddsStreamEvent[] {
    const previousByKey = new Map<string, BookOdds>();
    for (const entry of previous) {
      for (const book of entry.books) {
        previousByKey.set(`${entry.event.id}:${book.book}`, book);
      }
    }

    const events: OddsStreamEvent[] = [];
    for (const entry of next) {
      for (const book of entry.books) {
        const changes = diffBook(previousByKey.get(`${entry.event.id}:${book.book}`), book);
        if (changes.length === 0) continue;
        events.push(this.emit('odds', {
          eventId: entry.event.id,
          book: book.book,
          changes,
        }));
      }
    }
    return events;
  }

  /**
   * Events a reconnecting client still needs.
   * No Last-Event-ID means "start live"; the caller sends the latest snapshot
   * separately so a new subscriber does not replay the whole buffer.
   */
  replay(lastEventId: number | null): OddsStreamEvent[] {
    if (lastEventId == null) return [];
    if (this.buffer.length === 0) {
      return this.latestSnapshot ? [this.latestSnapshot] : [];
    }
    const oldest = this.buffer[0].id;
    if (lastEventId < oldest - 1) {
      const events: OddsStreamEvent[] = [];
      if (this.latestSnapshot) events.push(this.latestSnapshot);
      for (const event of this.buffer) {
        if (this.latestSnapshot && event.id === this.latestSnapshot.id) continue;
        if (event.id > (this.latestSnapshot?.id ?? lastEventId)) events.push(event);
      }
      return events;
    }
    return this.buffer.filter((event) => event.id > lastEventId);
  }

  createResponse(request: Request): Response {
    const lastEventId = readLastEventId(request);
    const encoder = new TextEncoder();
    let unsubscribe = () => {};

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let remove = () => {};
        const subscriber: Subscriber = {
          send: (chunk: string) => {
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              remove();
            }
          },
          close: () => {
            remove();
            try { controller.close(); } catch { /* already closed */ }
          },
        };
        remove = () => {
          this.subscribers.delete(subscriber);
        };
        this.subscribers.add(subscriber);
        unsubscribe = remove;

        subscriber.send('retry: 3000\n\n');
        for (const event of this.replay(lastEventId)) {
          subscriber.send(encodeSse(event));
        }
        if (lastEventId == null && this.latestSnapshot) {
          subscriber.send(encodeSse(this.latestSnapshot));
        }
      },
      cancel: () => {
        unsubscribe();
      },
    });

    return new Response(body, { headers: SSE_RESPONSE_HEADERS });
  }

  private emit(
    eventName: OddsStreamEvent['event'],
    data: OddsStreamEvent['data'],
  ): OddsStreamEvent {
    const event: OddsStreamEvent = { id: this.nextId++, event: eventName, data };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferLimit) {
      this.buffer.splice(0, this.buffer.length - this.bufferLimit);
    }
    if (eventName === 'snapshot') this.latestSnapshot = event;
    const chunk = encodeSse(event);
    for (const subscriber of this.subscribers) subscriber.send(chunk);
    return event;
  }
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
