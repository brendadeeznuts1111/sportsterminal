import type { Database } from '../database';
import { PositionService, type RiskPosition } from './PositionService';
import { RiskAlertService } from './RiskAlertService';
import { streamHub } from './StreamHub';

export type RiskLevel = 'GREEN' | 'YELLOW' | 'RED' | 'BLACK' | 'UNKNOWN';

export interface CustomerFeatureVector {
  customer_id: string;
  extracted_at: string;
  feature_version: number;
  lifetime_wagers: number;
  avg_wager_size: number;
  max_wager_size: number;
  win_rate: number;
  days_since_last_wager: number | null;
  sport_diversity_score: number;
  deposit_velocity_30d: number;
  withdrawal_ratio: number;
  bonus_dependency: number;
  sharp_score: number;
  chase_flag: number;
  archetype: string;
  risk_tier: RiskLevel;
  source_json: string;
}

export interface LiveRiskAnalysis {
  risk_level: RiskLevel;
  risk_score: number;
  confidence: number;
  summary: string;
  factors: string[];
  suggested_action: 'none' | 'reduce' | 'review' | 'block';
  max_exposure_usd: number;
  source: 'kimi' | 'heuristic' | 'kimi_failed';
  raw_response?: string;
}

interface WagerFeatureRow {
  wager_number: number;
  customer_id: string;
  login: string | null;
  agent_login: string | null;
  amount_wagered: number;
  to_win_amount: number;
  volume_amount: number;
  insert_datetime: string;
  sport: string | null;
  short_desc: string | null;
  parsed_price: number | null;
  raw_json: string | null;
}

interface PlayerRow {
  id: string;
  login: string | null;
  agent_id: string | null;
  agent_login: string | null;
  exposure: number | null;
  credit_limit: number | null;
  net_pnl: number | null;
  ytd_pnl: number | null;
  status: string | null;
}

const FEATURE_VERSION = 1;
const KIMI_TIMEOUT_MS = 15_000;

export class LiveFeatureService {
  private readonly positionService: PositionService;
  private readonly alertService: RiskAlertService;

  constructor(private readonly db: Database) {
    this.positionService = new PositionService(db);
    this.alertService = new RiskAlertService(db);
  }

  async extractRecentFeatures(hours = 1, limit = 250): Promise<{ processed: number; customers: string[] }> {
    const customers = await this.db.all<{ customer_id: string }>(
      `SELECT DISTINCT customer_id
         FROM wagers
        WHERE customer_id IS NOT NULL
          AND customer_id <> ''
          AND insert_datetime >= datetime('now', ?)
        UNION
       SELECT DISTINCT customer_id
         FROM wager_archive
        WHERE customer_id IS NOT NULL
          AND customer_id <> ''
          AND insert_date_time >= datetime('now', ?)
        LIMIT ?`,
      [`-${hours} hours`, `-${hours} hours`, limit]
    );

    let processed = 0;
    const ids: string[] = [];
    for (const row of customers) {
      await this.extractFeaturesForCustomer(row.customer_id);
      processed++;
      ids.push(row.customer_id);
    }

    return { processed, customers: ids };
  }

  async refreshStaleFeatures(hours = 6, limit = 250): Promise<{ processed: number; customers: string[] }> {
    const customers = await this.db.all<{ customer_id: string }>(
      `SELECT DISTINCT customer_id
         FROM wagers
        WHERE customer_id IS NOT NULL
          AND customer_id <> ''
          AND customer_id NOT IN (
            SELECT customer_id FROM customer_features
             WHERE extracted_at >= datetime('now', ?)
          )
        LIMIT ?`,
      [`-${hours} hours`, limit]
    );

    let processed = 0;
    const ids: string[] = [];
    for (const row of customers) {
      await this.extractFeaturesForCustomer(row.customer_id);
      processed++;
      ids.push(row.customer_id);
    }
    return { processed, customers: ids };
  }

  async getLatestFeatures(customerId: string): Promise<CustomerFeatureVector | null> {
    return this.db.get<CustomerFeatureVector>(
      `SELECT * FROM customer_features WHERE customer_id = ? LIMIT 1`,
      [customerId]
    );
  }

  async extractFeaturesForCustomer(customerId: string): Promise<CustomerFeatureVector> {
    const [wagers, player] = await Promise.all([
      this.getCustomerWagers(customerId, 5000),
      this.getPlayer(customerId),
    ]);

    const now = Date.now();
    const amounts = wagers.map((w) => centsToDollars(w.amount_wagered)).filter((n) => Number.isFinite(n));
    const lifetimeWagers = wagers.length;
    const avgWagerSize = lifetimeWagers > 0 ? sum(amounts) / lifetimeWagers : 0;
    const maxWagerSize = amounts.length ? Math.max(...amounts) : 0;
    const sports = new Set(wagers.map((w) => (w.sport || inferSport(w.short_desc || '')).trim()).filter(Boolean));
    const lastWagerAt = latestTime(wagers.map((w) => w.insert_datetime));
    const daysSinceLastWager = lastWagerAt ? (now - lastWagerAt.getTime()) / 86_400_000 : null;
    const winLoss = countWinsLosses(wagers);
    const winRate = winLoss.total > 0 ? winLoss.wins / winLoss.total : estimateWinRate(player, wagers);
    const sharpScore = computeSharpScore(wagers);
    const chaseFlag = detectChasePattern(wagers, player) ? 1 : 0;
    const sportDiversityScore = Math.min(sports.size / 5, 1);
    const bonusDependency = detectBonusDependency(wagers);
    const archetype = classifyArchetype({
      lifetimeWagers,
      avgWagerSize,
      winRate,
      sharpScore,
      chaseFlag,
      sportDiversityScore,
    });
    const riskTier = computeRiskTier({
      lifetimeWagers,
      avgWagerSize,
      maxWagerSize,
      winRate,
      sharpScore,
      chaseFlag,
      player,
    });
    const source = {
      player,
      wager_count: wagers.length,
      recent_wager_numbers: wagers.slice(0, 10).map((w) => w.wager_number),
      sports: [...sports],
      win_loss_observations: winLoss,
    };

    await this.db.run(
      `INSERT INTO customer_features (
        customer_id, extracted_at, feature_version, lifetime_wagers,
        avg_wager_size, max_wager_size, win_rate, days_since_last_wager,
        sport_diversity_score, deposit_velocity_30d, withdrawal_ratio,
        bonus_dependency, sharp_score, chase_flag, archetype, risk_tier, source_json
      ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET
        extracted_at = excluded.extracted_at,
        feature_version = excluded.feature_version,
        lifetime_wagers = excluded.lifetime_wagers,
        avg_wager_size = excluded.avg_wager_size,
        max_wager_size = excluded.max_wager_size,
        win_rate = excluded.win_rate,
        days_since_last_wager = excluded.days_since_last_wager,
        sport_diversity_score = excluded.sport_diversity_score,
        deposit_velocity_30d = excluded.deposit_velocity_30d,
        withdrawal_ratio = excluded.withdrawal_ratio,
        bonus_dependency = excluded.bonus_dependency,
        sharp_score = excluded.sharp_score,
        chase_flag = excluded.chase_flag,
        archetype = excluded.archetype,
        risk_tier = excluded.risk_tier,
        source_json = excluded.source_json`,
      [
        customerId,
        FEATURE_VERSION,
        lifetimeWagers,
        avgWagerSize,
        maxWagerSize,
        winRate,
        daysSinceLastWager,
        sportDiversityScore,
        0,
        0,
        bonusDependency,
        sharpScore,
        chaseFlag,
        archetype,
        riskTier,
        JSON.stringify(source),
      ]
    );

    const saved = await this.getLatestFeatures(customerId);
    if (!saved) throw new Error(`Failed to persist feature vector for ${customerId}`);
    return saved;
  }

  async analyzeLiveCustomer(input: { customer_id: string; forceRefresh?: boolean }): Promise<{
    customer_id: string;
    live: true;
    features: CustomerFeatureVector;
    analysis: LiveRiskAnalysis;
    position?: RiskPosition | { position_id: number; suggested: unknown; auto_applied: boolean };
    recent_wagers_count: number;
  }> {
    const customerId = input.customer_id.trim();
    if (!customerId) throw new Error('customer_id is required');

    const features = input.forceRefresh
      ? await this.extractFeaturesForCustomer(customerId)
      : ((await this.getLatestFeatures(customerId)) || await this.extractFeaturesForCustomer(customerId));
    const recentWagers = await this.getCustomerWagers(customerId, 10);
    const analysis = await this.analyzeWithKimiOrHeuristic(features, recentWagers);

    const flag = await this.db.run(
      `INSERT INTO ai_risk_flags (
        customer_id, player_id, risk_level, risk_score, confidence, summary,
        reasoning, factors, suggested_action, max_exposure, action, raw_response,
        flagged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        customerId,
        customerId,
        analysis.risk_level,
        analysis.risk_score,
        analysis.confidence,
        analysis.summary,
        analysis.summary,
        JSON.stringify(analysis.factors),
        analysis.suggested_action,
        analysis.max_exposure_usd,
        analysis.suggested_action === 'none' ? 'watch' : 'flagged',
        analysis.raw_response || JSON.stringify(analysis),
      ]
    );

    streamHub.publish('alerts', {
      event: 'risk_alert',
      data: {
        customer_id: customerId,
        risk_level: analysis.risk_level,
        confidence: analysis.confidence,
        summary: analysis.summary,
        source: analysis.source,
      },
      id: flag.lastID,
    });

    let position: RiskPosition | { position_id: number; suggested: unknown; auto_applied: boolean } | undefined;
    if (shouldGeneratePosition(analysis)) {
      position = await this.positionService.generatePosition({ customer_id: customerId, analysis_id: flag.lastID });
    }

    if (analysis.risk_level === 'RED' || analysis.risk_level === 'BLACK') {
      await this.alertService.sendAlerts({
        customer_id: customerId,
        risk_level: analysis.risk_level,
        confidence: analysis.confidence,
        summary: analysis.summary,
        suggested_action: analysis.suggested_action,
      });
    }

    return {
      customer_id: customerId,
      live: true,
      features,
      analysis,
      position,
      recent_wagers_count: recentWagers.length,
    };
  }

  private async getCustomerWagers(customerId: string, limit: number): Promise<WagerFeatureRow[]> {
    return this.db.all<WagerFeatureRow>(
      `SELECT
         wager_number,
         customer_id,
         login,
         agent_login,
         amount_wagered,
         to_win_amount,
         volume_amount,
         insert_datetime,
         sport,
         short_desc,
         parsed_price,
         NULL AS raw_json
       FROM wagers
       WHERE customer_id = ? OR login = ?
       UNION ALL
      SELECT
         wager_number,
         customer_id,
         login,
         agent_login,
         amount_wagered,
         to_win_amount,
         volume_amount,
         insert_date_time AS insert_datetime,
         sport,
         short_desc_raw AS short_desc,
         price AS parsed_price,
         raw_json
       FROM wager_archive
       WHERE customer_id = ? OR login = ?
       ORDER BY insert_datetime DESC
       LIMIT ?`,
      [customerId, customerId, customerId, customerId, limit]
    );
  }

  private async getPlayer(customerId: string): Promise<PlayerRow | null> {
    return this.db.get<PlayerRow>(
      `SELECT id, login, agent_id, agent_login, exposure, credit_limit, net_pnl, ytd_pnl, status
         FROM players
        WHERE id = ? OR login = ?
        LIMIT 1`,
      [customerId, customerId]
    );
  }

  private async analyzeWithKimiOrHeuristic(
    features: CustomerFeatureVector,
    recentWagers: WagerFeatureRow[]
  ): Promise<LiveRiskAnalysis> {
    const heuristic = buildHeuristicAnalysis(features);
    const apiKey = Bun.env.KIMI_API_KEY;
    if (!apiKey) return heuristic;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), KIMI_TIMEOUT_MS);
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
            { role: 'system', content: LIVE_RISK_SYSTEM_PROMPT },
            {
              role: 'user',
              content: JSON.stringify({
                features: featurePromptShape(features),
                recent_wagers: recentWagers.map((w) => ({
                  wager_number: w.wager_number,
                  amount: centsToDollars(w.amount_wagered),
                  to_win: centsToDollars(w.to_win_amount),
                  sport: w.sport || inferSport(w.short_desc || ''),
                  price: w.parsed_price,
                  placed_at: w.insert_datetime,
                  description: w.short_desc,
                })),
                deterministic_baseline: heuristic,
              }),
            },
          ],
          temperature: 0.1,
          max_tokens: 700,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { ...heuristic, source: 'kimi_failed', raw_response: `Kimi ${response.status}: ${body.slice(0, 500)}` };
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content || '';
      const parsed = parseAnalysisJson(content);
      return normalizeKimiAnalysis(parsed, content, heuristic);
    } catch (err) {
      return {
        ...heuristic,
        source: 'kimi_failed',
        raw_response: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildHeuristicAnalysis(features: CustomerFeatureVector): LiveRiskAnalysis {
  const factors: string[] = [];
  let score = 0;
  const lifetime = Number(features.lifetime_wagers || 0);
  const winRate = Number(features.win_rate || 0);
  const sharpScore = Number(features.sharp_score || 0);
  const avgWager = Number(features.avg_wager_size || 0);
  const maxWager = Number(features.max_wager_size || 0);

  if (winRate > 0.6 && lifetime >= 50) {
    score += 40;
    factors.push('sustained win rate above 60%');
  } else if (winRate > 0.55 && lifetime >= 25) {
    score += 24;
    factors.push('elevated win rate with meaningful sample');
  } else if (winRate > 0.52 && lifetime >= 15) {
    score += 12;
    factors.push('modestly positive win rate');
  }

  if (sharpScore >= 25) {
    score += 25;
    factors.push('strong sharp-price signal');
  } else if (sharpScore >= 10) {
    score += 12;
    factors.push('some sharp-price signal');
  }

  if (features.chase_flag) {
    score += 18;
    factors.push('recent wager sizing suggests chase behavior');
  }
  if (avgWager >= 2500) {
    score += 14;
    factors.push('high average wager size');
  }
  if (maxWager >= 10000) {
    score += 14;
    factors.push('large maximum wager exposure');
  }
  if (features.sport_diversity_score >= 0.8 && winRate > 0.53) {
    score += 8;
    factors.push('broad market activity with positive results');
  }

  score = Math.min(100, Math.max(score, tierScoreFloor(features.risk_tier)));
  const riskLevel = score >= 75 ? 'BLACK' : score >= 55 ? 'RED' : score >= 30 ? 'YELLOW' : 'GREEN';
  const confidence = Math.min(0.95, 0.55 + score / 220);
  const suggestedAction = riskLevel === 'BLACK' ? 'block' : riskLevel === 'RED' ? 'review' : riskLevel === 'YELLOW' ? 'reduce' : 'none';
  const maxExposure = suggestedExposure(riskLevel, features);

  return {
    risk_level: riskLevel,
    risk_score: score,
    confidence,
    summary: factors.length
      ? `${riskLevel} risk: ${factors.slice(0, 3).join(', ')}.`
      : 'GREEN risk: no elevated live risk signals in the current feature vector.',
    factors: factors.length ? factors : ['standard recreational profile'],
    suggested_action: suggestedAction,
    max_exposure_usd: maxExposure,
    source: 'heuristic',
  };
}

function normalizeKimiAnalysis(parsed: Record<string, unknown>, raw: string, fallback: LiveRiskAnalysis): LiveRiskAnalysis {
  const tier = normalizeRiskLevel(String(parsed.risk_level || parsed.tier || fallback.risk_level));
  const confidence = clampNumber(Number(parsed.confidence ?? fallback.confidence), 0, 1);
  const factors = Array.isArray(parsed.factors)
    ? parsed.factors.map((f) => String(f)).filter(Boolean).slice(0, 10)
    : fallback.factors;
  const score = clampNumber(Number(parsed.risk_score ?? riskLevelToScore(tier)), 0, 100);
  const action = normalizeAction(String(parsed.suggested_action || fallback.suggested_action), tier);
  return {
    risk_level: tier,
    risk_score: score,
    confidence,
    summary: String(parsed.summary || fallback.summary).slice(0, 1000),
    factors,
    suggested_action: action,
    max_exposure_usd: Math.max(0, Number(parsed.max_exposure_usd ?? parsed.max_exposure ?? fallback.max_exposure_usd)),
    source: 'kimi',
    raw_response: raw,
  };
}

function parseAnalysisJson(raw: string): Record<string, unknown> {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function shouldGeneratePosition(analysis: LiveRiskAnalysis): boolean {
  if (analysis.risk_level === 'BLACK') return true;
  if (analysis.risk_level === 'RED') return analysis.confidence >= 0.55;
  if (analysis.risk_level === 'YELLOW') return analysis.confidence >= 0.65;
  return false;
}

function featurePromptShape(features: CustomerFeatureVector): Record<string, unknown> {
  return {
    customer_id: features.customer_id,
    lifetime_wagers: features.lifetime_wagers,
    avg_wager_size: features.avg_wager_size,
    max_wager_size: features.max_wager_size,
    win_rate: features.win_rate,
    days_since_last_wager: features.days_since_last_wager,
    sport_diversity_score: features.sport_diversity_score,
    sharp_score: features.sharp_score,
    chase_flag: Boolean(features.chase_flag),
    archetype: features.archetype,
    baseline_risk_tier: features.risk_tier,
  };
}

function countWinsLosses(wagers: WagerFeatureRow[]): { wins: number; losses: number; total: number } {
  let wins = 0;
  let losses = 0;
  for (const wager of wagers) {
    const text = `${wager.raw_json || ''} ${wager.short_desc || ''}`.toLowerCase();
    if (/\b(win|won|winner)\b/.test(text)) wins++;
    else if (/\b(loss|lost|loser)\b/.test(text)) losses++;
  }
  return { wins, losses, total: wins + losses };
}

function estimateWinRate(player: PlayerRow | null, wagers: WagerFeatureRow[]): number {
  if (!wagers.length) return 0;
  const net = Number(player?.net_pnl ?? player?.ytd_pnl ?? 0);
  if (net > 0) return 0.54;
  if (net < 0) return 0.46;
  return 0.5;
}

function computeSharpScore(wagers: WagerFeatureRow[]): number {
  const prices = wagers
    .map((w) => Number(w.parsed_price))
    .filter((price) => Number.isFinite(price) && price !== 0);
  if (!prices.length) return 0;
  const plusMoney = prices.filter((price) => price > 100).length / prices.length;
  const marketBreadth = new Set(wagers.map((w) => w.sport || inferSport(w.short_desc || ''))).size;
  return Math.min(100, plusMoney * 35 + Math.min(marketBreadth, 5) * 5);
}

function detectChasePattern(wagers: WagerFeatureRow[], player: PlayerRow | null): boolean {
  if (wagers.length < 5) return false;
  const recent = wagers.slice(0, 5).map((w) => centsToDollars(w.amount_wagered));
  const older = wagers.slice(5, 25).map((w) => centsToDollars(w.amount_wagered));
  const recentAvg = recent.length ? sum(recent) / recent.length : 0;
  const olderAvg = older.length ? sum(older) / older.length : recentAvg;
  const pnlNegative = Number(player?.net_pnl ?? player?.ytd_pnl ?? 0) < 0;
  return recentAvg > olderAvg * 1.5 && (pnlNegative || recentAvg > 1000);
}

function detectBonusDependency(wagers: WagerFeatureRow[]): number {
  const bonusRows = wagers.filter((w) => /bonus|free\s*play|fp\b/i.test(`${w.raw_json || ''} ${w.short_desc || ''}`));
  return wagers.length ? bonusRows.length / wagers.length : 0;
}

function classifyArchetype(input: {
  lifetimeWagers: number;
  avgWagerSize: number;
  winRate: number;
  sharpScore: number;
  chaseFlag: number;
  sportDiversityScore: number;
}): string {
  if (input.sharpScore >= 25 && input.winRate > 0.53) return 'sharp';
  if (input.lifetimeWagers > 200 && input.avgWagerSize > 1500) return 'whale';
  if (input.chaseFlag) return 'chase_gambler';
  if (input.lifetimeWagers < 10) return 'new';
  if (input.sportDiversityScore > 0.75) return 'multi_sport';
  return 'recreational';
}

function computeRiskTier(input: {
  lifetimeWagers: number;
  avgWagerSize: number;
  maxWagerSize: number;
  winRate: number;
  sharpScore: number;
  chaseFlag: number;
  player: PlayerRow | null;
}): RiskLevel {
  if (input.winRate > 0.6 && input.lifetimeWagers >= 50) return 'BLACK';
  if (input.sharpScore >= 35 && input.lifetimeWagers >= 25) return 'RED';
  if (input.chaseFlag || Number(input.player?.net_pnl ?? 0) < -5000 || input.maxWagerSize > 10000) return 'RED';
  if (input.winRate > 0.52 || input.avgWagerSize > 1000) return 'YELLOW';
  return 'GREEN';
}

function normalizeRiskLevel(value: string): RiskLevel {
  const upper = value.toUpperCase();
  if (upper.includes('BLACK') || upper.includes('CRITICAL')) return 'BLACK';
  if (upper.includes('RED') || upper.includes('HIGH')) return 'RED';
  if (upper.includes('YELLOW') || upper.includes('MEDIUM')) return 'YELLOW';
  if (upper.includes('GREEN') || upper.includes('LOW')) return 'GREEN';
  return 'UNKNOWN';
}

function normalizeAction(value: string, tier: RiskLevel): LiveRiskAnalysis['suggested_action'] {
  const lower = value.toLowerCase();
  if (lower.includes('block')) return 'block';
  if (lower.includes('review')) return 'review';
  if (lower.includes('reduce') || lower.includes('limit')) return 'reduce';
  return tier === 'BLACK' ? 'block' : tier === 'RED' ? 'review' : tier === 'YELLOW' ? 'reduce' : 'none';
}

function riskLevelToScore(tier: RiskLevel): number {
  if (tier === 'BLACK') return 85;
  if (tier === 'RED') return 65;
  if (tier === 'YELLOW') return 40;
  if (tier === 'GREEN') return 15;
  return 0;
}

function tierScoreFloor(tier: RiskLevel): number {
  if (tier === 'BLACK') return 75;
  if (tier === 'RED') return 55;
  if (tier === 'YELLOW') return 30;
  return 0;
}

function suggestedExposure(tier: RiskLevel, features: CustomerFeatureVector): number {
  const source = safeParse(features.source_json);
  const player = source.player as PlayerRow | null | undefined;
  const balance = Math.max(0, Number(player?.exposure ?? player?.credit_limit ?? 1000));
  if (tier === 'BLACK') return 0;
  if (tier === 'RED') return Math.min(500, balance * 0.1);
  if (tier === 'YELLOW') return Math.min(2000, balance * 0.5);
  return Math.max(1000, balance * 2);
}

function latestTime(values: string[]): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!latest || date > latest) latest = date;
  }
  return latest;
}

function inferSport(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('nba') || lower.includes('basketball')) return 'Basketball';
  if (lower.includes('nfl') || lower.includes('football')) return 'Football';
  if (lower.includes('mlb') || lower.includes('baseball')) return 'Baseball';
  if (lower.includes('nhl') || lower.includes('hockey')) return 'Hockey';
  if (lower.includes('soccer') || lower.includes('premier')) return 'Soccer';
  return '';
}

function centsToDollars(value: number): number {
  const n = Number(value || 0);
  return n / 100;
}

function sum(values: number[]): number {
  return values.reduce((acc, n) => acc + n, 0);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const LIVE_RISK_SYSTEM_PROMPT = [
  'You are a senior sportsbook risk analyst for a live command center.',
  'Return ONLY JSON with keys: risk_level, risk_score, confidence, summary, factors, suggested_action, max_exposure_usd.',
  'risk_level must be one of GREEN, YELLOW, RED, BLACK.',
  'Suggested action must be none, reduce, review, or block.',
  'Use the deterministic baseline as a guardrail, but correct it when live wager context is stronger.',
].join('\n');
