import { initDatabase, type Database } from '../database';
import { LIVE_RISK_SYSTEM_PROMPT } from '../services/LiveFeatureService';
import { logger } from '../utils/logger';

interface ShadowRequest {
  id: number;
  customer_ids: string[];
  prompt_a: string;
  prompt_b: string;
}

interface ShadowPromptResult {
  risk_level: string;
  risk_score: number;
  confidence: number;
  raw: string;
  source: 'kimi' | 'heuristic' | 'kimi_failed';
}

interface ShadowComparisonRow {
  customer_id: string;
  tier_a: string;
  tier_b: string;
  confidence_a: number;
  confidence_b: number;
  score_a: number;
  score_b: number;
  agreement: number;
  severity_diff: number;
  source_a: string;
  source_b: string;
  raw_a: string;
  raw_b: string;
}

self.onmessage = async (event: MessageEvent<ShadowRequest>) => {
  const request = event.data;
  let db: Database | null = null;
  try {
    db = await initDatabase();
    const results = await runShadowComparison(db, request);
    const agreementScore = results.length
      ? results.reduce((sum, row) => sum + row.agreement, 0) / results.length
      : 0;
    const avgSeverityDiff = results.length
      ? results.reduce((sum, row) => sum + row.severity_diff, 0) / results.length
      : 0;

    await db.run(
      `UPDATE live_shadow_ab_tests
          SET status='completed',
              results_json=?,
              agreement_score=?,
              avg_severity_diff=?,
              significant=?,
              completed_at=datetime('now')
        WHERE id=?`,
      [JSON.stringify(results), agreementScore, avgSeverityDiff, agreementScore < 0.7 ? 1 : 0, request.id]
    );

    logger.info('Shadow A/B completed', { id: request.id, customers: request.customer_ids.length });
    self.postMessage({ id: request.id, ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (db) {
      await db.run(
        `UPDATE live_shadow_ab_tests
            SET status='failed', error=?, completed_at=datetime('now')
          WHERE id=?`,
        [message, request.id]
      ).catch(() => undefined);
    }
    self.postMessage({ id: request.id, ok: false, error: message });
  } finally {
    if (db) await db.close().catch(() => undefined);
  }
};

async function runShadowComparison(db: Database, request: ShadowRequest): Promise<ShadowComparisonRow[]> {
  const rows: ShadowComparisonRow[] = [];
  for (const customerId of request.customer_ids) {
    const snapshot = await buildSnapshot(db, customerId);
    const userContent = JSON.stringify(snapshot);
    const [resultA, resultB] = await Promise.all([
      runPrompt(request.prompt_a, userContent, snapshot),
      runPrompt(request.prompt_b, userContent, snapshot),
    ]);
    const tierA = normalizeTier(resultA.risk_level);
    const tierB = normalizeTier(resultB.risk_level);
    rows.push({
      customer_id: customerId,
      tier_a: tierA,
      tier_b: tierB,
      confidence_a: resultA.confidence,
      confidence_b: resultB.confidence,
      score_a: resultA.risk_score,
      score_b: resultB.risk_score,
      agreement: tierA === tierB ? 1 : 0,
      severity_diff: Math.abs(tierToNumber(tierA) - tierToNumber(tierB)),
      source_a: resultA.source,
      source_b: resultB.source,
      raw_a: resultA.raw,
      raw_b: resultB.raw,
    });
  }
  return rows;
}

async function buildSnapshot(db: Database, customerId: string): Promise<Record<string, unknown>> {
  const [features, recentWagers] = await Promise.all([
    db.get<Record<string, unknown>>(
      `SELECT * FROM customer_features WHERE customer_id=? LIMIT 1`,
      [customerId]
    ),
    db.all<Record<string, unknown>>(
      `SELECT wager_number, customer_id, amount_wagered, to_win_amount, sport, parsed_price, insert_datetime, short_desc
         FROM wagers
        WHERE customer_id=? OR login=?
        ORDER BY insert_datetime DESC
        LIMIT 10`,
      [customerId, customerId]
    ),
  ]);

  return {
    customer_id: customerId,
    features: features || { note: 'no feature vector available' },
    recent_wagers: recentWagers,
  };
}

async function runPrompt(
  prompt: string,
  userContent: string,
  snapshot: Record<string, unknown>
): Promise<ShadowPromptResult> {
  const apiKey = Bun.env.KIMI_API_KEY;
  if (!apiKey) return heuristicResult(prompt, snapshot);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'kimi-latest',
        messages: [
          { role: 'system', content: `${LIVE_RISK_SYSTEM_PROMPT}\n\n${prompt}` },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 600,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ...heuristicResult(prompt, snapshot), source: 'kimi_failed', raw: `Kimi ${res.status}: ${body.slice(0, 250)}` };
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content || '';
    const parsed = parseJson(raw);
    return {
      risk_level: normalizeTier(String(parsed.risk_level || raw || 'UNKNOWN')),
      risk_score: clamp(Number(parsed.risk_score ?? tierToScore(normalizeTier(String(parsed.risk_level || raw)))), 0, 100),
      confidence: clamp(Number(parsed.confidence ?? 0.65), 0, 1),
      raw,
      source: 'kimi',
    };
  } catch (error) {
    return { ...heuristicResult(prompt, snapshot), source: 'kimi_failed', raw: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function heuristicResult(prompt: string, snapshot: Record<string, unknown>): ShadowPromptResult {
  const features = snapshot.features as Record<string, unknown> | undefined;
  const promptBias = prompt.toLowerCase();
  let score = 0;
  const winRate = Number(features?.win_rate || 0);
  const lifetime = Number(features?.lifetime_wagers || 0);
  const sharp = Number(features?.sharp_score || 0);
  const chase = Number(features?.chase_flag || 0);

  if (winRate > 0.6 && lifetime > 50) score += 42;
  else if (winRate > 0.55) score += 25;
  if (sharp > 20) score += 24;
  if (chase) score += 18;
  if (promptBias.includes('strict') || promptBias.includes('aggressive')) score += 8;
  if (promptBias.includes('lenient')) score -= 8;

  const tier = score >= 75 ? 'BLACK' : score >= 55 ? 'RED' : score >= 30 ? 'YELLOW' : 'GREEN';
  return {
    risk_level: tier,
    risk_score: clamp(score, 0, 100),
    confidence: 0.6,
    raw: `[heuristic] ${tier} score=${score}`,
    source: 'heuristic',
  };
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeTier(value: string): string {
  const upper = value.toUpperCase();
  if (upper.includes('BLACK') || upper.includes('CRITICAL')) return 'BLACK';
  if (upper.includes('RED') || upper.includes('HIGH')) return 'RED';
  if (upper.includes('YELLOW') || upper.includes('MEDIUM')) return 'YELLOW';
  if (upper.includes('GREEN') || upper.includes('LOW')) return 'GREEN';
  return 'UNKNOWN';
}

function tierToNumber(tier: string): number {
  return { BLACK: 4, RED: 3, YELLOW: 2, GREEN: 1, UNKNOWN: 0 }[tier as 'BLACK' | 'RED' | 'YELLOW' | 'GREEN' | 'UNKNOWN'] || 0;
}

function tierToScore(tier: string): number {
  return { BLACK: 85, RED: 65, YELLOW: 40, GREEN: 15, UNKNOWN: 0 }[tier as 'BLACK' | 'RED' | 'YELLOW' | 'GREEN' | 'UNKNOWN'] || 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
