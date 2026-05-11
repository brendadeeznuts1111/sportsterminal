/**
 * AB Test Worker — runs paired Kimi prompts in parallel without blocking the main thread.
 *
 * Bun-native: TypeScript loads directly via `new Worker("./abTestWorker.ts")`.
 *
 * Protocol (main thread → worker):
 *   { id: number, customer_id: string, snapshot: object, prompt_a: string, prompt_b: string }
 *
 * Protocol (worker → main):
 *   { id, ok: true, result_a: AbResult, result_b: AbResult, agreement: number }
 *   { id, ok: false, error: string }
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

interface AbResponseOk {
  id: number;
  ok: true;
  customer_id: string;
  result_a: AbResult;
  result_b: AbResult;
  agreement: number;
}

interface AbResponseErr {
  id: number;
  ok: false;
  error: string;
}

self.onmessage = async (event: MessageEvent<AbRequest>) => {
  const req = event.data;
  try {
    const apiKey = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun?.env?.KIMI_API_KEY;
    const userContent = JSON.stringify({
      customer_id: req.customer_id,
      snapshot: req.snapshot,
    });

    const [a, b] = await Promise.all([
      runOne(apiKey, req.prompt_a, userContent, 'A'),
      runOne(apiKey, req.prompt_b, userContent, 'B'),
    ]);

    const agreement = a.risk_level === b.risk_level ? 1 : 0;
    const response: AbResponseOk = {
      id: req.id,
      ok: true,
      customer_id: req.customer_id,
      result_a: a,
      result_b: b,
      agreement,
    };
    self.postMessage(response);
  } catch (err) {
    const response: AbResponseErr = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};

async function runOne(
  apiKey: string | undefined,
  systemPrompt: string,
  userContent: string,
  label: 'A' | 'B'
): Promise<AbResult> {
  const start = Date.now();
  if (!apiKey) {
    // Synthetic deterministic fallback so AB tests work offline
    const tier = synthTier(systemPrompt);
    return {
      prompt_label: label,
      risk_level: tier,
      confidence: 0.55,
      raw: `[synthetic] ${tier}`,
      duration_ms: Date.now() - start,
    };
  }

  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'kimi-latest',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 512,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutHandle);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        prompt_label: label,
        risk_level: 'UNKNOWN',
        confidence: 0,
        raw: '',
        duration_ms: Date.now() - start,
        error: `Kimi ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || '';
    return {
      prompt_label: label,
      risk_level: extractTier(content),
      confidence: extractConfidence(content),
      raw: content,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      prompt_label: label,
      risk_level: 'UNKNOWN',
      confidence: 0,
      raw: '',
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractTier(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('black') || lower.includes('critical')) return 'BLACK';
  if (lower.includes('red') || lower.includes('high risk')) return 'RED';
  if (lower.includes('yellow') || lower.includes('medium')) return 'YELLOW';
  if (lower.includes('green') || lower.includes('low risk')) return 'GREEN';
  return 'UNKNOWN';
}

function extractConfidence(text: string): number {
  const match = text.match(/confidence[:\s]+(0?\.\d+|\d+(?:\.\d+)?)/i);
  if (!match) return 0.6;
  const n = Number(match[1]);
  return n > 1 ? n / 100 : n;
}

function synthTier(systemPrompt: string): string {
  const lower = systemPrompt.toLowerCase();
  if (lower.includes('strict') || lower.includes('aggressive')) return 'RED';
  if (lower.includes('lenient') || lower.includes('conservative')) return 'GREEN';
  return 'YELLOW';
}
