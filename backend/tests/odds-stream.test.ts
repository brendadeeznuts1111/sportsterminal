import { describe, expect, test } from 'bun:test';
import { registerOddsRoutes } from '../src/api/routes/odds';
import { OddsPoller } from '../src/odds/OddsPoller';
import {
  OddsEventStream,
  diffBook,
  encodeSse,
  readLastEventId,
} from '../src/odds/OddsEventStream';
import type { BookOdds, EventOdds } from '../src/odds/types';

function book(partial: Partial<BookOdds> & { book: string }): BookOdds {
  return {
    spreadHome: -2.5,
    spreadAway: 2.5,
    spreadHomePrice: -110,
    spreadAwayPrice: -110,
    totalOver: 214,
    totalUnder: 214,
    totalOverPrice: -110,
    totalUnderPrice: -110,
    moneylineHome: -135,
    moneylineAway: 115,
    ...partial,
  };
}

function event(id: string, books: BookOdds[]): EventOdds {
  return {
    event: {
      id,
      sport: 'NBA',
      league: 'NBA',
      homeTeam: 'Knicks',
      awayTeam: '76ers',
      startTime: '2026-05-08T19:00:00Z',
      status: 'upcoming',
    },
    books,
  };
}

async function readUntil(response: Response, predicate: (text: string) => boolean, timeoutMs = 1000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (predicate(text)) break;
  }
  await reader.cancel();
  return text;
}

describe('odds price deltas', () => {
  test('emits one event per changed game/book and skips unchanged prices', () => {
    const stream = new OddsEventStream({ heartbeatMs: 0 });
    const previous = [event('nba-001', [book({ book: 'DK' }), book({ book: 'PIN', spreadHomePrice: -105, spreadAwayPrice: -105 })])];
    const next = [event('nba-001', [
      book({ book: 'DK', spreadHomePrice: -115, moneylineHome: -140 }),
      book({ book: 'PIN', spreadHomePrice: -105, spreadAwayPrice: -105 }),
    ])];

    const events = stream.publishPriceDeltas(previous, next);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(1);
    expect(events[0].event).toBe('odds');
    const data = events[0].data as { eventId: string; book: string; changes: Array<{ market: string; side: string; price: number; previousPrice: number }> };
    expect(data.eventId).toBe('nba-001');
    expect(data.book).toBe('DK');
    const markets = data.changes.map((change) => `${change.market}:${change.side}`);
    expect(markets).toContain('spread:home');
    expect(markets).toContain('moneyline:home');
    expect(markets).not.toContain('spread:away');
    const spread = data.changes.find((change) => change.market === 'spread' && change.side === 'home');
    expect(spread?.price).toBe(-115);
    expect(spread?.previousPrice).toBe(-110);
  });

  test('diffBook reports every side when the book is new', () => {
    const changes = diffBook(undefined, book({ book: 'BOL' }));
    expect(changes).toHaveLength(6);
    expect(changes.every((change) => change.previousPrice == null)).toBe(true);
  });
});

describe('GET /api/odds/stream', () => {
  test('frames id, event name, and a single-line data payload', () => {
    const framed = encodeSse({ id: 7, event: 'heartbeat', data: { serverTime: 10 } });
    expect(framed).toBe('id: 7\nevent: heartbeat\ndata: {"serverTime":10}\n\n');
  });

  test('replays after Last-Event-ID and sends the snapshot to a fresh client', async () => {
    const stream = new OddsEventStream({ heartbeatMs: 0 });
    const snapshot = stream.publishSnapshot([event('nba-001', [book({ book: 'PIN', spreadHomePrice: -105, spreadAwayPrice: -105 })])]);
    const delta = stream.publishPriceDeltas(
      [event('nba-001', [book({ book: 'DK' })])],
      [event('nba-001', [book({ book: 'DK', spreadHomePrice: -120 })])],
    );
    expect(snapshot.id).toBe(1);
    expect(delta[0].id).toBe(2);

    const freshRequest = new Request('http://localhost/api/odds/stream');
    const fresh = registerOddsRoutes(new URL(freshRequest.url), freshRequest, { openOddsStream: (request: Request) => stream.createResponse(request) } as unknown as OddsPoller);
    expect(fresh).toBeInstanceOf(Response);
    if (!(fresh instanceof Response)) throw new Error('expected a stream response');
    expect(fresh.headers.get('content-type')).toContain('text/event-stream');
    expect(fresh.headers.get('cache-control')).toContain('no-cache');
    const freshText = await readUntil(fresh, (text) => text.includes('event: snapshot'));
    expect(freshText).toContain('retry: 3000');
    expect(freshText).toContain('id: 1');
    expect(freshText).toContain('event: snapshot');
    expect(freshText).not.toContain('event: odds');

    const resumeRequest = new Request('http://localhost/api/odds/stream', {
      headers: { 'Last-Event-ID': '1' },
    });
    expect(readLastEventId(resumeRequest)).toBe(1);
    const resume = stream.createResponse(resumeRequest);
    const resumeText = await readUntil(resume, (text) => text.includes('event: odds'));
    expect(resumeText).toContain('id: 2');
    expect(resumeText).toContain('event: odds');
    expect(resumeText).not.toContain('event: snapshot');
  });

  test('honors lastEventId query when a new EventSource cannot set the header', async () => {
    const stream = new OddsEventStream({ heartbeatMs: 0 });
    stream.publishSnapshot([event('nba-001', [book({ book: 'PIN' })])]);
    stream.publishPriceDeltas([], [event('nba-001', [book({ book: 'DK', moneylineAway: 130 })])]);
    const request = new Request('http://localhost/api/odds/stream?lastEventId=1');
    const response = stream.createResponse(request);
    const text = await readUntil(response, (chunk) => chunk.includes('event: odds'));
    expect(text).toContain('"book":"DK"');
    expect(text).not.toContain('event: snapshot');
  });

  test('writes heartbeats while the stream is open', async () => {
    const stream = new OddsEventStream({ heartbeatMs: 20 });
    stream.start();
    try {
      const response = stream.createResponse(new Request('http://localhost/api/odds/stream'));
      const text = await readUntil(response, (chunk) => chunk.includes('event: heartbeat'), 500);
      expect(text).toContain('event: heartbeat');
      expect(text).toContain('serverTime');
    } finally {
      stream.stop();
    }
  });

  test('OddsPoller exposes the stream without replacing the count-only socket broadcast', async () => {
    const poller = new OddsPoller({} as never, () => {});
    const response = poller.openOddsStream(new Request('http://localhost/api/odds/stream'));
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await response.body?.cancel();
    poller.stop();
  });
});
