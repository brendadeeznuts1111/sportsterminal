/**
 * SSE streaming routes.
 *
 * Each handler returns a Response with `Content-Type: text/event-stream`
 * and an AsyncGenerator body. The Bun server keeps the connection alive
 * because we call `server.timeout(req, 0)` from index.ts before dispatch.
 */
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import { streamHub } from '../../services/StreamHub';
import { ApiError, corsHeaders, handleAsync, readJsonBody } from '../helpers';

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no', // disable nginx buffering
  'Access-Control-Allow-Origin': '*',
};

/**
 * Convert an AsyncGenerator<string> into a streaming Response.
 * Bun.serve will pump each yielded string into the response body.
 */
function sseResponse(stream: AsyncGenerator<string>): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch {
        // Client disconnected — generator already cleaned up via finally
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      // Caller closed the connection — generator's finally runs
    },
  });
  return new Response(readable, { headers: SSE_HEADERS });
}

export function registerStreamRoutes(
  url: URL,
  request: Request,
  _scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  // GET /api/stream/live-wagers — dashboard-friendly one-way ticker.
  // Events: connected, wager, risk_alert, position, heartbeat.
  if (url.pathname === '/api/stream/live-wagers' && request.method === 'GET') {
    const { stream } = streamHub.subscribe([
      'wagers',
      'alerts',
      'positions',
      'ticker',
      'ws:wager.alert',
      'ws:agent_rule.triggered',
    ]);
    return sseResponse(stream);
  }

  // GET /api/stream/wagers — live wagers + ticker heartbeat
  if (url.pathname === '/api/stream/wagers' && request.method === 'GET') {
    const playerId = url.searchParams.get('playerId');
    const topics = playerId ? [`wagers:${playerId}`, 'ticker'] : ['wagers', 'ticker'];
    const { stream } = streamHub.subscribe(topics);
    return sseResponse(stream);
  }

  // GET /api/stream/positions — risk position lifecycle events
  if (url.pathname === '/api/stream/positions' && request.method === 'GET') {
    const { stream } = streamHub.subscribe(['positions', 'alerts', 'ticker']);
    return sseResponse(stream);
  }

  // GET /api/stream/all — firehose
  if (url.pathname === '/api/stream/all' && request.method === 'GET') {
    const { stream } = streamHub.subscribe(['*']);
    return sseResponse(stream);
  }

  // GET /api/stream/topic/:topic — custom topic subscription
  const topicMatch = url.pathname.match(/^\/api\/stream\/topic\/(.+)$/);
  if (topicMatch && request.method === 'GET') {
    const topic = decodeURIComponent(topicMatch[1]);
    const { stream } = streamHub.subscribe([topic, 'ticker']);
    return sseResponse(stream);
  }

  // GET /api/stream/stats — JSON stats about active SSE subscribers
  if (url.pathname === '/api/stream/stats' && request.method === 'GET') {
    return handleAsync(async () => ({
      total: streamHub.count,
      wagers: streamHub.countForTopic('wagers'),
      positions: streamHub.countForTopic('positions'),
      alerts: streamHub.countForTopic('alerts'),
      ticker: streamHub.countForTopic('ticker'),
    }), corsHeaders);
  }

  return null;
}

/**
 * Streaming Kimi analysis endpoint.
 * POST /api/analysis/stream
 *   { customer_id, prompt? }
 *
 * Streams Kimi's chat completion as SSE chunks. Falls back to a single-shot
 * response if KIMI_API_KEY is not configured.
 */
export function registerKimiStreamRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  if (url.pathname !== '/api/analysis/stream') return null;
  if (request.method !== 'POST' && request.method !== 'GET') return null;

  return handleStreamingAnalysis(request, url, scraperManager);
}

async function handleStreamingAnalysis(
  request: Request,
  url: URL,
  scraperManager: BuckeyeScraperManager
): Promise<Response> {
  let body: { customer_id?: string; prompt?: string; system_prompt?: string } = {};
  if (request.method === 'POST') {
    body = await readJsonBody<typeof body>(request);
  } else {
    body = {
      customer_id: url.searchParams.get('customer_id') || undefined,
      prompt: url.searchParams.get('prompt') || undefined,
      system_prompt: url.searchParams.get('system_prompt') || undefined,
    };
  }

  if (!body.customer_id) {
    throw new ApiError(400, 'customer_id is required');
  }

  const apiKey = Bun.env.KIMI_API_KEY;
  const db = scraperManager.getDatabase();

  // Fetch context for the prompt
  const playerRow = await db.get<{
    customer_id: string;
    balance: number;
    win_rate: number;
    lifetime_wagers: number;
    archetype: string;
  }>(
    `SELECT
       p.id AS customer_id,
       COALESCE(p.exposure, 0) AS balance,
       0 AS win_rate,
       0 AS lifetime_wagers,
       'live' AS archetype
     FROM players p WHERE p.id = ? OR p.login = ? LIMIT 1`,
    [body.customer_id, body.customer_id]
  );

  const userPrompt = body.prompt || JSON.stringify({
    customer_id: body.customer_id,
    snapshot: playerRow || { note: 'no profile data' },
  });
  const systemPrompt = body.system_prompt || DEFAULT_RISK_SYSTEM_PROMPT;

  if (!apiKey) {
    // Fallback: synthetic single-event stream
    return sseResponse(syntheticAnalysisStream(body.customer_id));
  }

  return sseResponse(streamKimi(apiKey, systemPrompt, userPrompt, body.customer_id));
}

/**
 * Connect to Kimi streaming endpoint and re-emit each token as an SSE event.
 */
async function* streamKimi(
  apiKey: string,
  systemPrompt: string,
  userContent: string,
  customerId: string
): AsyncGenerator<string> {
  yield formatSseChunk('start', { customer_id: customerId, model: 'kimi-latest' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
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
        max_tokens: 1024,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => '');
      yield formatSseChunk('error', { status: response.status, body: errText.slice(0, 500) });
      yield formatSseChunk('done', { customer_id: customerId });
      return;
    }

    let buffer = '';
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);

      // Kimi/OpenAI-style SSE: lines starting with "data: "
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          yield formatSseChunk('done', { customer_id: customerId });
          return;
        }
        try {
          const parsed = JSON.parse(payload);
          const token = parsed?.choices?.[0]?.delta?.content;
          if (token) {
            yield formatSseChunk('token', { token });
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    yield formatSseChunk('done', { customer_id: customerId });
  } catch (err) {
    yield formatSseChunk('error', {
      message: err instanceof Error ? err.message : 'Kimi stream failed',
    });
    yield formatSseChunk('done', { customer_id: customerId });
  } finally {
    clearTimeout(timeout);
  }
}

async function* syntheticAnalysisStream(customerId: string): AsyncGenerator<string> {
  yield formatSseChunk('start', { customer_id: customerId, model: 'synthetic' });
  const tokens = [
    'Risk', ' analysis', ' for', ' customer', ' ', customerId, '.',
    ' No', ' Kimi', ' API', ' key', ' configured', '—', ' returning',
    ' synthetic', ' stream.',
  ];
  for (const token of tokens) {
    await Bun.sleep(80);
    yield formatSseChunk('token', { token });
  }
  yield formatSseChunk('done', { customer_id: customerId });
}

function formatSseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const DEFAULT_RISK_SYSTEM_PROMPT = [
  'You are a sportsbook risk analyst.',
  'Given a customer snapshot, return a brief risk assessment with:',
  ' - risk_level: GREEN | YELLOW | RED | BLACK',
  ' - confidence: 0.0..1.0',
  ' - summary: 1-2 sentence explanation',
  'Stream your reasoning naturally; do not wrap in JSON.',
].join('\n');
