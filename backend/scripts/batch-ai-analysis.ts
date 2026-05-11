import { AppDatabase, normalizeDatabasePath } from '../src/database';

const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_TIMEOUT_MS = 20_000;
const BATCH_SIZE = 10; // Process in small batches to avoid rate limits

interface CustomerData {
  customer_id: string;
  login: string;
  agent_login: string | null;
  archetype: string;
  lifetime_wagers: number;
  avg_wager_size: number;
  max_wager_size: number;
  win_rate: number;
  sharp_score: number;
  risk_tier: string;
  sport_diversity_score: number;
  days_since_last_wager: number | null;
  violation_count: number;
  position_count: number;
  flag_count: number;
  total_wagered_cents: number;
}

function buildPrompt(c: CustomerData): string {
  return `You are a sports betting risk analyst. Analyze this customer profile and provide a risk assessment.

CUSTOMER: ${c.login} (${c.customer_id})
AGENT: ${c.agent_login || 'unknown'}
ARCHETYPE: ${c.archetype}
RISK TIER: ${c.risk_tier}

WAGERING PROFILE:
- Lifetime wagers: ${c.lifetime_wagers}
- Average stake: $${c.avg_wager_size.toFixed(2)}
- Max stake: $${c.max_wager_size.toFixed(2)}
- Total wagered: $${(c.total_wagered_cents / 100).toFixed(2)}
- Win rate: ${(c.win_rate * 100).toFixed(1)}%
- Sharp score: ${c.sharp_score.toFixed(1)}/100
- Sport diversity: ${(c.sport_diversity_score * 100).toFixed(0)}%
- Days since last wager: ${c.days_since_last_wager !== null ? c.days_since_last_wager.toFixed(0) : 'N/A'}

RISK INDICATORS:
- Wager violations: ${c.violation_count}
- Risk positions: ${c.position_count}
- Player flags: ${c.flag_count}

Provide a JSON response with exactly these fields:
{
  "risk_level": "GREEN|YELLOW|RED|BLACK",
  "risk_score": 0-100,
  "confidence": 0-100,
  "summary": "One-line executive summary",
  "reasoning": "Detailed reasoning paragraph",
  "factors": ["factor1", "factor2", "factor3"],
  "suggested_action": "none|reduce|review|block",
  "max_exposure": recommended_max_exposure_dollars
}`;
}

interface KimiResponse {
  risk_level: string;
  risk_score: number;
  confidence: number;
  summary: string;
  reasoning: string;
  factors: string[];
  suggested_action: string;
  max_exposure: number;
}

async function callKimi(prompt: string): Promise<{ response: KimiResponse | null; raw: string; error: string | null }> {
  if (!KIMI_API_KEY) {
    return { response: null, raw: '', error: 'KIMI_API_KEY not configured' };
  }

  try {
    const res = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KIMI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'kimi-latest',
        messages: [
          { role: 'system', content: 'You are a precise risk analyst. Respond only with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(KIMI_TIMEOUT_MS),
    });

    const body = await res.text();
    if (!res.ok) {
      return { response: null, raw: body, error: `Kimi ${res.status}: ${body.slice(0, 250)}` };
    }

    const parsed = JSON.parse(body);
    const content = parsed.choices?.[0]?.message?.content || '';

    // Extract JSON from markdown code blocks if present
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/```\s*([\s\S]*?)```/) || [null, content];
    const jsonStr = jsonMatch[1].trim();

    try {
      const response = JSON.parse(jsonStr) as KimiResponse;
      return { response, raw: content, error: null };
    } catch {
      return { response: null, raw: content, error: 'Failed to parse JSON from response' };
    }
  } catch (err) {
    return { response: null, raw: '', error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const db = new AppDatabase(normalizeDatabasePath('backend/data/terminal.db'));

  console.log('═══════════════════════════════════════════════════');
  console.log('🤖 BATCH AI RISK ANALYSIS (Kimi)');
  console.log('═══════════════════════════════════════════════════\n');

  if (!KIMI_API_KEY) {
    console.log('⚠️  KIMI_API_KEY not set. Running in heuristic mode...\n');
  }

  // Get RED/BLACK customers + top YELLOW customers by sharp_score
  const customers = await db.all<CustomerData>(
    `SELECT
       cf.customer_id,
       COALESCE(cs.login, cf.customer_id) as login,
       COALESCE(cs.agent_login, (SELECT MAX(agent_login) FROM wagers WHERE customer_id = cf.customer_id)) as agent_login,
       cf.archetype,
       cf.lifetime_wagers,
       cf.avg_wager_size,
       cf.max_wager_size,
       cf.win_rate,
       cf.sharp_score,
       cf.risk_tier,
       cf.sport_diversity_score,
       cf.days_since_last_wager,
       COALESCE(v.violation_count, 0) as violation_count,
       COALESCE(p.position_count, 0) as position_count,
       COALESCE(f.flag_count, 0) as flag_count,
       COALESCE(w.total_wagered, 0) as total_wagered_cents
     FROM customer_features cf
     LEFT JOIN customer_snapshots cs ON cs.customer_id = cf.customer_id
     LEFT JOIN (SELECT customer_id, COUNT(*) as violation_count FROM wager_violations GROUP BY customer_id) v ON v.customer_id = cf.customer_id
     LEFT JOIN (SELECT customer_id, COUNT(*) as position_count FROM risk_positions GROUP BY customer_id) p ON p.customer_id = cf.customer_id
     LEFT JOIN (SELECT customer_id, COUNT(*) as flag_count FROM player_flags GROUP BY customer_id) f ON f.customer_id = cf.customer_id
     LEFT JOIN (SELECT customer_id, SUM(amount_wagered) as total_wagered FROM wagers GROUP BY customer_id) w ON w.customer_id = cf.customer_id
     WHERE cf.risk_tier IN ('RED', 'BLACK')
        OR (cf.risk_tier = 'YELLOW' AND cf.sharp_score > 50)
     ORDER BY cf.sharp_score DESC, cf.risk_tier DESC`
  );

  console.log(`Found ${customers.length} high-risk customers to analyze\n`);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < customers.length; i += BATCH_SIZE) {
    const batch = customers.slice(i, i + BATCH_SIZE);

    for (const customer of batch) {
      const prompt = buildPrompt(customer);
      const { response, raw, error } = await callKimi(prompt);

      if (response) {
        await db.run(
          `INSERT INTO ai_risk_flags (
            customer_id, player_id, risk_level, risk_score, confidence, summary, reasoning,
            factors, suggested_action, max_exposure, action, raw_response, agent_level, agent_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            customer.customer_id,
            customer.customer_id,
            response.risk_level,
            response.risk_score,
            response.confidence,
            response.summary,
            response.reasoning,
            JSON.stringify(response.factors),
            response.suggested_action,
            response.max_exposure,
            'ai_analyzed',
            raw,
            null,
            null,
          ]
        );
        succeeded++;
        console.log(`   ✅ ${customer.login}: ${response.risk_level} (${response.risk_score}/100) — ${response.summary}`);
      } else {
        // Fallback: insert heuristic result
        const heuristicRisk = customer.risk_tier;
        const heuristicScore = Math.min(100, customer.sharp_score + (customer.win_rate > 0.55 ? 10 : 0));
        const heuristicAction = customer.risk_tier === 'BLACK' ? 'block' : customer.risk_tier === 'RED' ? 'review' : 'reduce';
        const heuristicMaxExposure = customer.avg_wager_size * 5;

        await db.run(
          `INSERT INTO ai_risk_flags (
            customer_id, player_id, risk_level, risk_score, confidence, summary, reasoning,
            factors, suggested_action, max_exposure, action, raw_response, agent_level, agent_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            customer.customer_id,
            customer.customer_id,
            heuristicRisk,
            heuristicScore,
            60,
            `${customer.login}: ${customer.archetype} with ${customer.violation_count} violations.`,
            `Heuristic fallback. Sharp score: ${customer.sharp_score}. Win rate: ${(customer.win_rate * 100).toFixed(1)}%.`,
            JSON.stringify(['heuristic_fallback', 'kimi_unavailable']),
            heuristicAction,
            heuristicMaxExposure,
            'heuristic',
            error || 'KIMI_API_KEY not configured',
            null,
            null,
          ]
        );
        failed++;
        console.log(`   ⚠️  ${customer.login}: heuristic fallback (${error || 'no API key'})`);
      }
      processed++;
    }

    console.log(`   Batch ${Math.ceil((i + 1) / BATCH_SIZE)}/${Math.ceil(customers.length / BATCH_SIZE)} complete (${processed}/${customers.length})\n`);
  }

  const totalAi = await db.get<{ c: number }>("SELECT COUNT(*) as c FROM ai_risk_flags WHERE action = 'ai_analyzed'");
  const totalHeuristic = await db.get<{ c: number }>("SELECT COUNT(*) as c FROM ai_risk_flags WHERE action = 'heuristic'");

  console.log('═══════════════════════════════════════════════════');
  console.log('✅ AI ANALYSIS COMPLETE');
  console.log(`   Processed: ${processed}`);
  console.log(`   AI analyzed: ${totalAi?.c || 0}`);
  console.log(`   Heuristic fallback: ${totalHeuristic?.c || 0}`);
  console.log('═══════════════════════════════════════════════════');

  await db.close();
}

main().catch((err) => {
  console.error('❌ AI analysis failed:', err);
  process.exit(1);
});
