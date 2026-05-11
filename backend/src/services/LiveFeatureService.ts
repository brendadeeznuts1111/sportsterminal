import type { Database } from '../database';
import { COMMAND_CENTER_MAP } from '../config/commandCenterMap';
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
  clv: number;
  feature_json: string;
  source_json: string;
}

export type BehavioralFeatureVector = Record<string, number>;

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
  wager_type: string | null;
  amount_wagered: number;
  to_win_amount: number;
  volume_amount: number;
  insert_datetime: string;
  sport: string | null;
  short_desc: string | null;
  parsed_game: string | null;
  parsed_market: string | null;
  parsed_side: string | null;
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

const FEATURE_VERSION = 2;
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

  async getOrExtractFeatures(customerId: string, forceRefresh = false): Promise<CustomerFeatureVector> {
    if (forceRefresh) return this.extractFeaturesForCustomer(customerId);
    const existing = await this.getLatestFeatures(customerId);
    if (existing && !needsFeatureRefresh(existing)) return existing;
    return this.extractFeaturesForCustomer(customerId);
  }

  async extractFeaturesForCustomer(customerId: string): Promise<CustomerFeatureVector> {
    const [wagers, player] = await Promise.all([
      this.getCustomerWagers(customerId, 5000),
      this.getPlayer(customerId),
    ]);

    const now = Date.now();
    const behavioralFeatures = await this.computeBehavioralFeatures(customerId, wagers, player, now);
    const lifetimeWagers = behavioralFeatures.total_wagers_90d;
    const avgWagerSize = behavioralFeatures.avg_stake;
    const maxWagerSize = behavioralFeatures.max_stake;
    const sports = new Set(wagers.map((w) => (w.sport || inferSport(w.short_desc || '')).trim()).filter(Boolean));
    const daysSinceLastWager = Number.isFinite(behavioralFeatures.days_since_last_wager)
      ? behavioralFeatures.days_since_last_wager
      : null;
    const winLoss = countWinsLosses(wagers);
    const winRate = behavioralFeatures.win_rate;
    const sharpScore = computeSharpScoreFromFeatures(behavioralFeatures);
    const chaseFlag = behavioralFeatures.chase_flag;
    const sportDiversityScore = Math.min(sports.size / 5, 1);
    const bonusDependency = behavioralFeatures.bonus_ratio;
    const archetype = classifyArchetype(behavioralFeatures);
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
      behavioral_features: behavioralFeatures,
    };

    await this.db.run(
      `INSERT INTO customer_features (
        customer_id, extracted_at, feature_version, lifetime_wagers,
        avg_wager_size, max_wager_size, win_rate, days_since_last_wager,
        sport_diversity_score, deposit_velocity_30d, withdrawal_ratio,
        bonus_dependency, sharp_score, chase_flag, archetype, risk_tier, clv, feature_json, source_json
      ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        clv = excluded.clv,
        feature_json = excluded.feature_json,
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
        behavioralFeatures.avg_clv,
        JSON.stringify(behavioralFeatures),
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
    if (!customerId) throw new Error(COMMAND_CENTER_MAP.errors.customerIdRequired.message);

    const features = await this.getOrExtractFeatures(customerId, Boolean(input.forceRefresh));
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
      event: COMMAND_CENTER_MAP.sse.events.riskAlert,
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

  async buildPlayerSnapshot(customerId: string, forceRefresh = false): Promise<{
    customer_id: string;
    features: CustomerFeatureVector;
    behavioralFeatures: BehavioralFeatureVector;
    recent_wagers: Array<Record<string, unknown>>;
    player: PlayerRow | null;
  }> {
    const features = await this.getOrExtractFeatures(customerId, forceRefresh);
    const recentWagers = await this.getCustomerWagers(customerId, 10);
    return {
      customer_id: customerId,
      features,
      behavioralFeatures: parseFeatureJson(features),
      recent_wagers: recentWagers.map((w) => ({
        wager_number: w.wager_number,
        amount: centsToDollars(w.amount_wagered),
        to_win: centsToDollars(w.to_win_amount),
        sport: w.sport || inferSport(w.short_desc || ''),
        market: inferMarket(w),
        price: w.parsed_price,
        placed_at: w.insert_datetime,
        description: w.short_desc,
      })),
      player: await this.getPlayer(customerId),
    };
  }

  async getClvHistory(customerId: string, limit = 10): Promise<Array<{ bet_id: number; clvPercent: number; placed_at: string }>> {
    const wagers = await this.getCustomerWagers(customerId, Math.max(1, Math.min(limit * 4, 100)));
    const rows: Array<{ bet_id: number; clvPercent: number; placed_at: string }> = [];
    for (const wager of wagers) {
      const clv = await this.computeWagerClv(wager);
      if (clv === null) continue;
      rows.push({ bet_id: wager.wager_number, clvPercent: clv, placed_at: wager.insert_datetime });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  private async computeBehavioralFeatures(
    customerId: string,
    wagers: WagerFeatureRow[],
    player: PlayerRow | null,
    now: number
  ): Promise<BehavioralFeatureVector> {
    const recent90 = wagers.filter((w) => withinDays(w.insert_datetime, now, 90));
    const recent7 = wagers.filter((w) => withinDays(w.insert_datetime, now, 7));
    const amounts = recent90.map((w) => centsToDollars(w.amount_wagered)).filter((n) => Number.isFinite(n));
    const totalWagers = recent90.length;
    const activeDays = new Set(recent90.map((w) => dateKey(w.insert_datetime))).size;
    const winLoss = countWinsLosses(recent90);
    const marketCounts = countBy(recent90, inferMarket);
    const sportCounts = countBy(recent90, (w) => w.sport || inferSport(w.short_desc || '') || 'unknown');
    const timeBins = countBy(recent90, (w) => String(Math.floor(hourOfDay(w.insert_datetime) / 4)));
    const dayBins = countBy(recent90, (w) => String(dayOfWeek(w.insert_datetime)));
    const odds = recent90.map((w) => Number(w.parsed_price)).filter((n) => Number.isFinite(n) && n !== 0);
    const clvValues = await this.computeClvValues(recent90);
    const access = await this.getIpFeatureRows(customerId);
    const transaction = await this.getTransactionFeatureRows(customerId);
    const lastWagerAt = latestTime(wagers.map((w) => w.insert_datetime));
    const firstWagerAt = earliestTime(wagers.map((w) => w.insert_datetime));
    const avgStake = amounts.length ? sum(amounts) / amounts.length : 0;
    const stakeStddev = stddev(amounts);
    const straightPct = ratio(countMarket(marketCounts, ['straight', 'side', 'moneyline', 'total']), totalWagers);
    const parlayPct = ratio(countMarket(marketCounts, ['parlay']), totalWagers);
    const propsPct = ratio(countMarket(marketCounts, ['prop']), totalWagers);
    const livePct = ratio(recent90.filter((w) => /live|\bin[-\s]?play\b/i.test(`${w.wager_type || ''} ${w.short_desc || ''}`)).length, totalWagers);
    const freeplayRedeemed = transaction.freeplayRedeemed;
    const bonusRatio = transaction.totalVolume > 0 ? transaction.bonusVolume / transaction.totalVolume : detectBonusDependency(recent90);
    const sharedIpCount = access.sharedIpCount;
    const failedLogins24h = await this.countFailedLogins(customerId);

    return {
      total_wagers_90d: totalWagers,
      daily_avg_wagers: activeDays ? totalWagers / activeDays : 0,
      max_wagers_1h: maxEventsInWindow(recent90, 60),
      night_wager_ratio: ratio(recent90.filter((w) => hourOfDay(w.insert_datetime) <= 5).length, totalWagers),
      weekend_wager_ratio: ratio(recent90.filter((w) => [0, 6].includes(dayOfWeek(w.insert_datetime))).length, totalWagers),
      days_since_last_wager: lastWagerAt ? (now - lastWagerAt.getTime()) / 86_400_000 : 9999,
      session_count_7d: countSessions(recent7, 30),
      wager_velocity_5m: maxEventsInWindow(recent7, 5),
      avg_stake: avgStake,
      median_stake: median(amounts),
      max_stake: amounts.length ? Math.max(...amounts) : 0,
      stake_stddev: stakeStddev,
      round_stake_pct: ratio(amounts.filter((n) => n % 100 === 0 || n % 1000 === 0).length, amounts.length),
      stake_volatility: avgStake > 0 ? stakeStddev / avgStake : 0,
      hhi_sport: hhi(sportCounts, totalWagers),
      hhi_market: hhi(marketCounts, totalWagers),
      top_sport_share: topShare(sportCounts, totalWagers),
      straight_bet_pct: straightPct,
      live_bet_pct: livePct,
      parlay_pct: parlayPct,
      props_pct: propsPct,
      avg_odds: odds.length ? decimalToAmerican(sum(odds.map(americanToDecimal)) / odds.length) : 0,
      steep_odds_count: odds.filter((price) => Math.abs(price) >= 5000).length,
      min_odds: odds.length ? Math.min(...odds) : 0,
      clv_beat_count: clvValues.filter((n) => n > 10).length,
      avg_clv: clvValues.length ? sum(clvValues) / clvValues.length : 0,
      chronic_beater: clvValues.filter((n) => n > 10).length >= 5 && (clvValues.length ? sum(clvValues) / clvValues.length : 0) > 8 ? 1 : 0,
      odd_movement_within_1h: clvValues.some((n) => Math.abs(n) >= 5) ? 1 : 0,
      unique_ips_90d: access.uniqueIps90d,
      ip_switches_7d: access.ipSwitches7d,
      shared_ip_bool: sharedIpCount > 1 ? 1 : 0,
      shared_ip_count: sharedIpCount,
      failed_logins_24h: failedLogins24h,
      country_count: access.countryCount,
      ip_entropy: entropy(access.ipCounts, access.totalIpRows),
      is_vip: recent90.some((w) => String(w.raw_json || w.short_desc || '').toLowerCase().includes('vip') || String(player?.status || '').toLowerCase().includes('vip')) ? 1 : 0,
      freeplay_redeemed: freeplayRedeemed,
      bonus_ratio: bonusRatio,
      freeplay_abuser_flag: bonusRatio > 0.3 || (freeplayRedeemed > 5000 && totalWagers < 50) ? 1 : 0,
      time_entropy: entropy(timeBins, totalWagers),
      day_entropy: entropy(dayBins, totalWagers),
      avg_session_wagers: averageSessionSize(recent90, 30),
      live_timing_proxy: livePct,
      agent_tenure_days: firstWagerAt ? (now - firstWagerAt.getTime()) / 86_400_000 : 0,
      agent_concentration: 1 - hhi(countBy(recent90, (w) => w.agent_login || 'unknown'), totalWagers),
      agent_performance_trend: Number(player?.net_pnl ?? player?.ytd_pnl ?? 0),
      win_rate: winLoss.total > 0 ? winLoss.wins / winLoss.total : estimateWinRate(player, recent90),
      chase_flag: detectChasePattern(wagers, player) ? 1 : 0,
      sport_diversity_score: Math.min(Object.keys(sportCounts).length / 5, 1),
      sharp_score: Math.min(
        100,
        (clvValues.filter((n) => n > 10).length * 8)
          + ((clvValues.length ? sum(clvValues) / clvValues.length : 0) > 5 ? 20 : 0)
          + (straightPct > 0.7 ? 12 : 0)
          + (avgStake > 500 ? 10 : 0)
          + ((hhi(sportCounts, totalWagers) < 0.3 && totalWagers >= 20) ? 10 : 0)
      ),
    };
  }

  private async computeClvValues(wagers: WagerFeatureRow[]): Promise<number[]> {
    const values: number[] = [];
    const cache = new Map<string, number | null>();
    for (const wager of wagers.slice(0, 500)) {
      const key = clvKey(wager);
      if (!key) continue;
      if (!cache.has(key)) cache.set(key, await this.fetchClosingOdds(wager));
      const closing = cache.get(key);
      if (!closing || !wager.parsed_price) continue;
      values.push(computeClvPercent(wager.parsed_price, closing));
    }
    return values;
  }

  private async computeWagerClv(wager: WagerFeatureRow): Promise<number | null> {
    const closing = await this.fetchClosingOdds(wager);
    if (!closing || !wager.parsed_price) return null;
    return computeClvPercent(wager.parsed_price, closing);
  }

  private async fetchClosingOdds(wager: WagerFeatureRow): Promise<number | null> {
    const parsed = parseWagerFields(wager);
    if (!parsed.game || !parsed.market || !parsed.side) return null;
    const row = await this.db.get<{ closing_odds: number }>(
      `SELECT closing_odds FROM closing_lines WHERE game_id = ? AND market = ? AND side = ? LIMIT 1`,
      [parsed.game, parsed.market, parsed.side]
    );
    return row ? Number(row.closing_odds) : null;
  }

  private async getIpFeatureRows(customerId: string): Promise<{
    uniqueIps90d: number;
    ipSwitches7d: number;
    countryCount: number;
    sharedIpCount: number;
    ipCounts: Record<string, number>;
    totalIpRows: number;
  }> {
    const rows = await this.db.all<{ ip_address: string; raw_json: string | null; access_datetime: string }>(
      `SELECT ip_address, raw_json, access_datetime
       FROM access_logs
       WHERE login_id = ?
         AND access_datetime >= datetime('now', '-90 days')
       ORDER BY access_datetime ASC`,
      [customerId]
    );
    const ipCounts = countBy(rows, (row) => row.ip_address || 'unknown');
    const recent7 = rows.filter((row) => withinDays(row.access_datetime, Date.now(), 7));
    const countries = new Set(rows.map((row) => extractCountry(row.raw_json || '')).filter(Boolean));
    const shared = await this.db.get<{ cnt: number }>(
      `SELECT COUNT(DISTINCT other.login_id) AS cnt
       FROM access_logs mine
       JOIN access_logs other ON other.ip_address = mine.ip_address
       WHERE mine.login_id = ?
         AND other.login_id <> mine.login_id
         AND mine.access_datetime >= datetime('now', '-90 days')`,
      [customerId]
    );
    return {
      uniqueIps90d: Object.keys(ipCounts).length,
      ipSwitches7d: countIpSwitches(recent7),
      countryCount: countries.size,
      sharedIpCount: Number(shared?.cnt || 0),
      ipCounts,
      totalIpRows: rows.length,
    };
  }

  private async getTransactionFeatureRows(customerId: string): Promise<{ freeplayRedeemed: number; bonusVolume: number; totalVolume: number }> {
    const rows = await this.db.all<{ amount: number; category: string | null; tran_type: string | null; description: string | null }>(
      `SELECT amount, category, tran_type, description
       FROM player_transactions
       WHERE (customer_id = ? OR login = ?)
         AND transaction_time >= datetime('now', '-90 days')`,
      [customerId, customerId]
    );
    let freeplayRedeemed = 0;
    let bonusVolume = 0;
    let totalVolume = 0;
    for (const row of rows) {
      const amount = Math.abs(Number(row.amount || 0));
      const text = `${row.category || ''} ${row.tran_type || ''} ${row.description || ''}`.toLowerCase();
      totalVolume += amount;
      if (/free\s*play|freeplay|\bfp\b/.test(text)) freeplayRedeemed += amount;
      if (/bonus|promo|credit|free\s*play|freeplay/.test(text)) bonusVolume += amount;
    }
    return { freeplayRedeemed, bonusVolume, totalVolume };
  }

  private async countFailedLogins(customerId: string): Promise<number> {
    const row = await this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM failed_logins
       WHERE player = ?
         AND timestamp >= datetime('now', '-1 day')`,
      [customerId]
    );
    return Number(row?.cnt || 0);
  }

  private async getCustomerWagers(customerId: string, limit: number): Promise<WagerFeatureRow[]> {
    return this.db.all<WagerFeatureRow>(
      `SELECT
         wager_number,
         customer_id,
         login,
         agent_login,
         wager_type,
         amount_wagered,
         to_win_amount,
         volume_amount,
         insert_datetime,
         sport,
         short_desc,
         parsed_game,
         parsed_market,
         parsed_side,
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
         wager_type,
         amount_wagered,
         to_win_amount,
         volume_amount,
         insert_date_time AS insert_datetime,
         sport,
         short_desc_raw AS short_desc,
         NULL AS parsed_game,
         NULL AS parsed_market,
         NULL AS parsed_side,
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

    try {
      const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'kimi-for-coding',
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
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(KIMI_TIMEOUT_MS),
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
    behavioralFeatures: parseFeatureJson(features),
  };
}

export function parseFeatureJson(features: Pick<CustomerFeatureVector, 'feature_json'> | null): BehavioralFeatureVector {
  if (!features?.feature_json) return {};
  try {
    const parsed = JSON.parse(features.feature_json) as Record<string, unknown>;
    const normalized: BehavioralFeatureVector = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (Number.isFinite(n)) normalized[key] = n;
    }
    return normalized;
  } catch {
    return {};
  }
}

export function classifyArchetype(features: BehavioralFeatureVector | null | undefined): string {
  if (!features || Object.keys(features).length === 0) return 'unknown';
  if (
    Number(features.clv_beat_count || 0) >= 5
    || (
      Number(features.avg_stake || 0) > 500
      && Number(features.straight_bet_pct || 0) > 0.7
      && Number(features.hhi_sport || 1) < 0.3
    )
  ) {
    return 'Sharp Syndicate';
  }
  if (Number(features.bonus_ratio || 0) > 0.3 || Number(features.freeplay_redeemed || 0) > 5000) {
    return 'Bonus Abuser';
  }
  if (Number(features.max_stake || 0) > 5000 && Number(features.total_wagers_90d || 0) < 50) {
    return 'Whale';
  }
  if (Number(features.chase_flag || 0) === 1) return 'Chase Risk';
  return 'Recreational';
}

function needsFeatureRefresh(features: CustomerFeatureVector): boolean {
  return Number(features.feature_version || 0) < FEATURE_VERSION
    || !features.feature_json
    || features.feature_json === '{}';
}

function computeSharpScoreFromFeatures(features: BehavioralFeatureVector): number {
  return Math.min(
    100,
    Number(features.sharp_score || 0)
      + Number(features.clv_beat_count || 0) * 5
      + (Number(features.chronic_beater || 0) ? 25 : 0)
      + (Number(features.straight_bet_pct || 0) > 0.7 ? 8 : 0)
  );
}

function withinDays(value: string, now: number, days: number): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && now - date.getTime() <= days * 86_400_000;
}

function dateKey(value: string): string {
  return value.slice(0, 10);
}

function hourOfDay(value: string): number {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getHours();
}

function dayOfWeek(value: string): number {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getDay();
}

function countBy<T>(rows: T[], keyFn: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function hhi(counts: Record<string, number>, total: number): number {
  if (!total) return 0;
  return Object.values(counts).reduce((acc, cnt) => {
    const share = cnt / total;
    return acc + share * share;
  }, 0);
}

function topShare(counts: Record<string, number>, total: number): number {
  if (!total) return 0;
  return Math.max(0, ...Object.values(counts)) / total;
}

function entropy(counts: Record<string, number>, total: number): number {
  if (!total) return 0;
  return Object.values(counts).reduce((acc, cnt) => {
    if (!cnt) return acc;
    const p = cnt / total;
    return acc - p * Math.log2(p);
  }, 0);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] || 0) + (sorted[mid] || 0)) / 2 : sorted[mid] || 0;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = sum(values) / values.length;
  const variance = sum(values.map((n) => (n - avg) ** 2)) / values.length;
  return Math.sqrt(variance);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function countMarket(counts: Record<string, number>, keys: string[]): number {
  return Object.entries(counts).reduce((acc, [key, count]) => (
    keys.some((needle) => key.toLowerCase().includes(needle)) ? acc + count : acc
  ), 0);
}

function maxEventsInWindow(wagers: WagerFeatureRow[], minutes: number): number {
  const times = wagers
    .map((w) => new Date(w.insert_datetime).getTime())
    .filter((time) => !Number.isNaN(time))
    .sort((a, b) => a - b);
  let max = 0;
  let left = 0;
  const windowMs = minutes * 60_000;
  for (let right = 0; right < times.length; right++) {
    while ((times[right] || 0) - (times[left] || 0) > windowMs) left++;
    max = Math.max(max, right - left + 1);
  }
  return max;
}

function countSessions(wagers: WagerFeatureRow[], gapMinutes: number): number {
  if (!wagers.length) return 0;
  const times = wagers
    .map((w) => new Date(w.insert_datetime).getTime())
    .filter((time) => !Number.isNaN(time))
    .sort((a, b) => a - b);
  if (!times.length) return 0;
  let sessions = 1;
  const gapMs = gapMinutes * 60_000;
  for (let i = 1; i < times.length; i++) {
    if ((times[i] || 0) - (times[i - 1] || 0) > gapMs) sessions++;
  }
  return sessions;
}

function averageSessionSize(wagers: WagerFeatureRow[], gapMinutes: number): number {
  const sessions = countSessions(wagers, gapMinutes);
  return sessions ? wagers.length / sessions : 0;
}

function inferMarket(wager: WagerFeatureRow): string {
  const explicit = wager.parsed_market?.trim();
  if (explicit) return explicit.toLowerCase();
  const text = `${wager.wager_type || ''} ${wager.short_desc || ''}`.toLowerCase();
  if (/\bparlay\b|\bif bet\b/.test(text)) return 'parlay';
  if (/\bprop\b|player/.test(text)) return 'prop';
  if (/\btotal\b|over|under/.test(text)) return 'total';
  if (/\bmoneyline\b|\bml\b/.test(text)) return 'moneyline';
  if (/\bspread\b|point spread|side/.test(text)) return 'side';
  return wager.wager_type || 'unknown';
}

function parseWagerFields(wager: WagerFeatureRow): { game: string | null; market: string | null; side: string | null } {
  if (wager.parsed_game || wager.parsed_market || wager.parsed_side) {
    return { game: wager.parsed_game, market: wager.parsed_market, side: wager.parsed_side };
  }
  const raw = safeParse(wager.raw_json || '{}');
  return {
    game: stringField(raw, ['game_id', 'GameID', 'parsed_game']),
    market: stringField(raw, ['market', 'Market', 'parsed_market']),
    side: stringField(raw, ['side', 'Side', 'parsed_side']),
  };
}

function stringField(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return null;
}

function clvKey(wager: WagerFeatureRow): string | null {
  const parsed = parseWagerFields(wager);
  if (!parsed.game || !parsed.market || !parsed.side) return null;
  return `${parsed.game}|${parsed.market}|${parsed.side}`;
}

function americanToDecimal(american: number): number {
  if (american > 0) return american / 100 + 1;
  return 100 / Math.abs(american) + 1;
}

function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) return 0;
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

function computeClvPercent(wagerOdds: number, closingOdds: number): number {
  const wagerDec = americanToDecimal(wagerOdds);
  const closingDec = americanToDecimal(closingOdds);
  return closingDec ? ((wagerDec - closingDec) / closingDec) * 100 : 0;
}

function extractCountry(raw: string): string {
  const parsed = safeParse(raw);
  return stringField(parsed, ['country', 'Country', 'country_code', 'countryCode']) || '';
}

function countIpSwitches(rows: Array<{ ip_address: string; access_datetime: string }>): number {
  const sorted = [...rows].sort((a, b) => new Date(a.access_datetime).getTime() - new Date(b.access_datetime).getTime());
  let switches = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]?.ip_address && sorted[i - 1]?.ip_address && sorted[i]?.ip_address !== sorted[i - 1]?.ip_address) switches++;
  }
  return switches;
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

function earliestTime(values: string[]): Date | null {
  let earliest: Date | null = null;
  for (const value of values) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!earliest || date < earliest) earliest = date;
  }
  return earliest;
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
  'If behavioralFeatures is provided, interpret the key-value pairs as quantitative descriptors of long-term behavior.',
  'High round_stake_pct, clv_beat_count, chronic_beater, shared_ip_bool, or bonus_ratio should refine risk; never invent missing features.',
  'Use the deterministic baseline as a guardrail, but correct it when live wager context is stronger.',
].join('\n');
