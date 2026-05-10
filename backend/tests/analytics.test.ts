import { describe, test, expect } from 'bun:test';

const WAGER_TYPE_MAP: Record<string, string> = {
  L: "STRAIGHT",
  S: "STRAIGHT",
  P: "PARLAY",
  I: "IF_BET",
  T: "TEASER",
  G: "RACEBOOK",
  A: "MANUAL_PLAY",
  C: "CONTEST",
  N: "LIVE_PROP",
  R: "REVERSE",
  M: "MONEYLINE",
};

function parseBuckeyeWagers(raw: unknown): Array<{
  bettorId: string; gameId: string; wagerType: string; side: string;
  line: number; odds: number; stake: number; timestamp: number;
  profit: number; sport: string; wagerStatus: string; chosenTeam: string;
  description: string; originalLine: number; adjustedLine: number;
  isParlay: boolean; parlayName: string; overUnder: string; amountWon: number;
}> {
  if (!raw) return [];
  const obj = raw as Record<string, unknown>;
  const list = (obj.LIST || obj.data || obj.list || obj) as Array<Record<string, unknown>>;
  if (!Array.isArray(list)) return [];
  return list.map((w: Record<string, unknown>) => {
    const rawType = String(w.WagerType || w.wagerType || w.Type || w.type || "L").trim().toUpperCase();
    const wt = WAGER_TYPE_MAP[rawType] || rawType;
    const rawSport = String(w.SportType || w.Sport || w.sport || "").trim();
    const rawCustomerId = String(w.customerID || w.Login || w.bettorID || w.playerLogin || w.agentID || "").trim();
    const rawTeam = String(w.ChosenTeamID || w.chosenTeam || w.Team1ID || w.side || "").trim();
    const rawStatus = String(w.WagerStatus || w.wagerStatus || w.Status || "").trim();
    const rawOU = String(w.TotalPointsOU || w.OverUnder || "").trim();
    const amountWagered = Number(w.AmountWagered || w.amount_wagered || w.Risk || w.LegAmountWagered || 0);
    const amountWon = Number(w.ToWinAmount || w.amount_won || w.LegToWinAmount || 0);
    const netWinnings = Number(w.NetWinnings || w.net_winnings || 0);
    const origLine = Number(w.OrigSpread || w.OrigTotalPoints || w.Line || w.line || w.Spread || w.spread || 0);
    const adjLine = Number(w.AdjSpread || w.AdjTotalPoints || w.AdjustedSpread || 0);
    const finalOdds = Number(w.FinalMoney || w.Odds || w.odds || w.MoneyLine || w.moneyLine || 0);
    const rawGameId = String(w.GRA || w.gra || w.gameID || w.GameID || w.gameId || "").trim();
    const rawTime = String(w.AcceptedDateTime || w.Insert_Date_Time || w.insert_date_time || w.Date || w.Time || "");
    const ts = Date.parse(rawTime);
    const isParlay = wt === "PARLAY" || wt === "TEASER" || Number(w.PlayNumber || w.playNumber || 1) > 1;
    const side = rawOU ? rawOU : (rawTeam.includes("/") ? rawTeam.split("/")[0] : rawTeam);
    return {
      bettorId: rawCustomerId || "unknown",
      gameId: rawGameId || `unknown-${rawSport}`,
      wagerType: wt,
      side,
      line: adjLine || origLine,
      odds: finalOdds,
      stake: amountWagered / 100,
      timestamp: isNaN(ts) ? 0 : ts,
      profit: netWinnings / 100,
      sport: rawSport,
      wagerStatus: rawStatus,
      chosenTeam: rawTeam,
      description: String(w.Description || w.ShortDesc || "").trim(),
      originalLine: origLine,
      adjustedLine: adjLine,
      isParlay,
      parlayName: String(w.ParlayName || "").trim(),
      overUnder: rawOU,
      amountWon: amountWon / 100,
    };
  }).filter(w => w.timestamp > 0);
}

function detectSyndicates(
  wagers: Array<{ bettorId: string; gameId: string; wagerType: string; side: string; line: number; odds: number; stake: number; timestamp: number }>,
  opts: { minBettors: number; minStake: number },
): Array<{ id: string; members: string[]; commonGame: string; pattern: string; totalStake: number; timestamp: number }> {
  const { minBettors, minStake } = opts;
  const groups = new Map<string, Array<{ bettorId: string; gameId: string; wagerType: string; side: string; line: number; odds: number; stake: number; timestamp: number }>>();
  for (const w of wagers) {
    const key = `${w.gameId}|${w.wagerType}|${w.side}|${w.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(w);
  }
  const syndicates: Array<{ id: string; members: string[]; commonGame: string; pattern: string; totalStake: number; timestamp: number }> = [];
  for (const [, groupWagers] of groups.entries()) {
    const sorted = [...groupWagers].sort((a, b) => a.timestamp - b.timestamp);
    let cluster: typeof sorted = [];
    for (let i = 0; i < sorted.length; i++) {
      if (cluster.length === 0) {
        cluster.push(sorted[i]);
      } else if (sorted[i].timestamp - cluster[cluster.length - 1].timestamp <= 300000) {
        cluster.push(sorted[i]);
      } else {
        if (cluster.length >= minBettors) {
          const uniqueBettors = new Set(cluster.map(w => w.bettorId));
          const totalStake = cluster.reduce((s, w) => s + w.stake, 0);
          if (uniqueBettors.size >= minBettors && totalStake >= minStake) {
            syndicates.push({ id: "test-id", members: Array.from(uniqueBettors), commonGame: cluster[0].gameId, pattern: `${cluster[0].wagerType} ${cluster[0].side} ${cluster[0].line}`, totalStake, timestamp: cluster[0].timestamp });
          }
        }
        cluster = [sorted[i]];
      }
    }
    if (cluster.length >= minBettors) {
      const uniqueBettors = new Set(cluster.map(w => w.bettorId));
      const totalStake = cluster.reduce((s, w) => s + w.stake, 0);
      if (uniqueBettors.size >= minBettors && totalStake >= minStake) {
        syndicates.push({ id: "test-id", members: Array.from(uniqueBettors), commonGame: cluster[0].gameId, pattern: `${cluster[0].wagerType} ${cluster[0].side} ${cluster[0].line}`, totalStake, timestamp: cluster[0].timestamp });
      }
    }
  }
  return syndicates;
}

function computeExpectedValue(
  historicalWagers: Array<{ stake: number; odds: number; profit: number; sport: string; wagerType: string }>,
  modelType: string,
): { model: string; overall: { winRate: number; avgOdds: number; impliedProbability: number; expectedROI: number; confidence: number }; byCategory: Array<{ category: string; roi: number; winRate: number; avgOdds: number; impliedProb: number; edge: number; sampleSize: number }> } {
  if (historicalWagers.length < 50) {
    return { model: modelType, overall: { winRate: 0, avgOdds: 0, impliedProbability: 0, expectedROI: 0, confidence: 0 }, byCategory: [] };
  }
  const totalBets = historicalWagers.length;
  const overallWins = historicalWagers.filter(w => w.profit > 0).length;
  const overallWinRate = overallWins / totalBets;
  const overallAvgOdds = historicalWagers.reduce((s, w) => s + w.odds, 0) / totalBets;
  const overallImplied = overallAvgOdds > 0 ? 100 / (overallAvgOdds + 100) : -overallAvgOdds / (-overallAvgOdds + 100);
  const expectedROI = overallWinRate * (overallAvgOdds / 100) - (1 - overallWinRate);
  return { model: modelType, overall: { winRate: overallWinRate, avgOdds: overallAvgOdds, impliedProbability: overallImplied, expectedROI, confidence: Math.min(100, totalBets / 10) }, byCategory: [] };
}

function computePredictiveSharpness(wagers: Array<{ stake: number; profit: number; sport: string; wagerType: string; timestamp: number }>): { score: number; confidence: number; factors: { totalBets: number; avgStake: number; maxStake: number; winRate: number; recentWinRate: number; recentROI: number; sports: number; types: number; stdDev: number; insufficient?: boolean } } {
  if (wagers.length < 30) {
    return { score: 0, confidence: 10, factors: { totalBets: wagers.length, avgStake: 0, maxStake: 0, winRate: 0, recentWinRate: 0, recentROI: 0, sports: 0, types: 0, stdDev: 0 } };
  }
  const totalBets = wagers.length;
  const totalStake = wagers.reduce((s, w) => s + w.stake, 0);
  const avgStake = totalStake / totalBets;
  const maxStake = Math.max(...wagers.map(w => w.stake));
  const winRate = wagers.filter(w => w.profit > 0).length / totalBets;
  const variance = wagers.reduce((s, w) => s + Math.pow(w.stake - avgStake, 2), 0) / totalBets;
  const stdDev = Math.sqrt(variance);
  const recent = wagers.slice(-20);
  const recentWinRate = recent.filter(w => w.profit > 0).length / recent.length;
  const recentStake = recent.reduce((s, w) => s + w.stake, 0);
  const recentROI = recentStake > 0 ? recent.reduce((s, w) => s + w.profit, 0) / recentStake : 0;
  const sports = new Set(wagers.map(w => w.sport || "UNK")).size;
  const types = new Set(wagers.map(w => w.wagerType || "UNK")).size;
  let score = 0;
  if (avgStake > 500) score += 15;
  if (maxStake > 2000) score += 15;
  if (winRate > 0.55) score += 25;
  if (winRate > 0.6) score += 15;
  if (recentWinRate > 0.6) score += 20;
  if (recentROI > 0.1) score += 10;
  if (sports > 3) score += 5;
  if (types > 2) score += 5;
  if (stdDev > avgStake * 0.5) score += 10;
  score = Math.min(100, Math.max(0, score));
  const confidence = Math.min(100, Math.round(30 + (totalBets / 10)));
  return { score, confidence, factors: { totalBets, avgStake, maxStake, winRate, recentWinRate, recentROI, sports, types, stdDev } };
}

describe('Syndicate Detection', () => {
  test('detects correlated betting from multiple bettors on same game/line within 5 min', () => {
    const now = Date.now();
    const wagers = [
      { bettorId: 'A', gameId: 'NFL-1', wagerType: 'SPREAD', side: 'HOME', line: -3, odds: -110, stake: 50, timestamp: now },
      { bettorId: 'B', gameId: 'NFL-1', wagerType: 'SPREAD', side: 'HOME', line: -3, odds: -110, stake: 75, timestamp: now + 60000 },
      { bettorId: 'C', gameId: 'NFL-1', wagerType: 'SPREAD', side: 'HOME', line: -3, odds: -110, stake: 100, timestamp: now + 120000 },
    ];
    const result = detectSyndicates(wagers, { minBettors: 2, minStake: 100 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].members).toContain('A');
    expect(result[0].members).toContain('B');
    expect(result[0].commonGame).toBe('NFL-1');
    expect(result[0].totalStake).toBe(225);
  });

  test('does not flag single bettor as syndicate', () => {
    const now = Date.now();
    const wagers = [
      { bettorId: 'A', gameId: 'NFL-1', wagerType: 'SPREAD', side: 'HOME', line: -3, odds: -110, stake: 500, timestamp: now },
      { bettorId: 'A', gameId: 'NFL-1', wagerType: 'SPREAD', side: 'HOME', line: -3, odds: -110, stake: 500, timestamp: now + 60000 },
    ];
    const result = detectSyndicates(wagers, { minBettors: 2, minStake: 100 });
    expect(result.length).toBe(0);
  });

  test('does not detect syndicate when bettors are far apart in time', () => {
    const now = Date.now();
    const wagers = [
      { bettorId: 'A', gameId: 'NFL-1', wagerType: 'SPREAD', side: 'HOME', line: -3, odds: -110, stake: 50, timestamp: now },
      { bettorId: 'B', gameId: 'NFL-1', wagerType: 'SPREAD', side: 'HOME', line: -3, odds: -110, stake: 75, timestamp: now + 600000 },
    ];
    const result = detectSyndicates(wagers, { minBettors: 2, minStake: 100 });
    expect(result.length).toBe(0);
  });
});

describe('EV Simulation', () => {
  test('returns insufficient data for less than 50 wagers', () => {
    const wagers = Array.from({ length: 30 }, (_, i) => ({
      stake: 100, odds: -110, profit: i % 2 === 0 ? 90 : -100, sport: 'NFL', wagerType: 'SPREAD',
    }));
    const result = computeExpectedValue(wagers, 'bayesian');
    expect(result.overall.confidence).toBe(0);
    expect(result.overall.winRate).toBe(0);
    expect(result.byCategory.length).toBe(0);
  });

  test('computes EV for 50+ wagers', () => {
    const wagers = Array.from({ length: 100 }, (_, i) => ({
      stake: 100, odds: -110, profit: i < 55 ? 90 : -100, sport: 'NFL', wagerType: 'SPREAD',
    }));
    const result = computeExpectedValue(wagers, 'bayesian');
    expect(result.overall.winRate).toBeCloseTo(0.55, 1);
    expect(result.overall.confidence).toBe(10);
    expect(result.model).toBe('bayesian');
  });
});

describe('Predictive Sharpness', () => {
  test('returns score 0 and low confidence for < 30 wagers', () => {
    const wagers = Array.from({ length: 10 }, (_, i) => ({
      stake: 100, profit: i < 6 ? 90 : -100, sport: 'NFL', wagerType: 'SPREAD', timestamp: Date.now() + i * 3600000,
    }));
    const result = computePredictiveSharpness(wagers);
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(10);
    expect(result.factors.insufficient).toBeUndefined();
  });

  test('computes sharpness score for 30+ wagers', () => {
    const wagers = Array.from({ length: 60 }, (_, i) => ({
      stake: 800 + Math.random() * 400,
      profit: i < 38 ? 720 : -800,
      sport: i < 30 ? 'NFL' : 'NBA',
      wagerType: i < 40 ? 'SPREAD' : 'MONEYLINE',
      timestamp: Date.now() + i * 3600000,
    }));
    const result = computePredictiveSharpness(wagers);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.confidence).toBeGreaterThanOrEqual(30);
    expect(result.factors.totalBets).toBe(60);
    expect(result.factors.avgStake).toBeGreaterThan(0);
    expect(result.factors.winRate).toBeCloseTo(38 / 60, 1);
  });

  test('high-variance bettors get bonus points', () => {
    const wagers = Array.from({ length: 100 }, (_, i) => ({
      stake: i % 10 === 0 ? 5000 : 100,
      profit: i % 10 === 0 ? 4500 : (i < 55 ? 90 : -100),
      sport: 'NFL',
      wagerType: 'SPREAD',
      timestamp: Date.now() + i * 3600000,
    }));
    const result = computePredictiveSharpness(wagers);
    expect(result.score).toBeGreaterThan(30);
    expect(result.factors.stdDev).toBeGreaterThan(result.factors.avgStake * 0.5);
  });
});

describe('Parse Buckeye Wagers', () => {
  test('parses LIST array with cents-to-dollars conversion', () => {
    const raw = {
      LIST: [
        { customerID: 'P1', gameID: 'G1', WagerType: 'SPREAD', Side: 'HOME', Insert_Date_Time: '2026-05-10T12:00:00Z', AmountWagered: 2500, NetWinnings: 2250, Sport: 'NFL' },
        { customerID: 'P2', gameID: 'G1', WagerType: 'MONEYLINE', Side: 'AWAY', Insert_Date_Time: '2026-05-10T12:01:00Z', AmountWagered: 5000, NetWinnings: -5000, Sport: 'NBA' },
      ],
    };
    const result = parseBuckeyeWagers(raw);
    expect(result.length).toBe(2);
    expect(result[0].bettorId).toBe('P1');
    expect(result[0].stake).toBe(25);
    expect(result[0].profit).toBe(22.5);
    expect(result[1].stake).toBe(50);
    expect(result[1].profit).toBe(-50);
  });

  test('parses real Buckeye getBetTicker shape with WagerType codes', () => {
    const raw = {
      LIST: [
        {
          agentID: "ISLAND999", customerID: "ISL66 ", Login: "ISL66", NameFirst: "Dominic",
          WagerType: "L", WagerNumber: 1, AmountWagered: 165000, ToWinAmount: 150000,
          NetWinnings: null, VolumeAmount: 150000, SportType: "Baseball            ",
          ChosenTeamID: "Washington Nationals/Miami Marlins", Description: "Baseball #952 Nationals/Marlins U 8½ -110",
          FinalMoney: -110, OrigSpread: 8.5, AdjSpread: 0, OrigTotalPoints: 8.5,
          TotalPointsOU: "U", WagerStatus: "P", GameDateTime: "2026-05-10 12:15:00.000",
          Team1ID: "Washington Nationals", Team2ID: "Miami Marlins", Team1RotNum: 951, Team2RotNum: 952,
          PlacedOn: "Internet", AcceptedDateTime: "2026-05-10 03:43:21.763",
        },
      ],
    };
    const result = parseBuckeyeWagers(raw);
    expect(result.length).toBe(1);
    expect(result[0].wagerType).toBe('STRAIGHT');
    expect(result[0].stake).toBe(1650);
    expect(result[0].sport).toBe('Baseball');
    expect(result[0].bettorId).toBe('ISL66');
    expect(result[0].overUnder).toBe('U');
    expect(result[0].originalLine).toBe(8.5);
    expect(result[0].odds).toBe(-110);
    expect(result[0].wagerStatus).toBe('P');
  });

  test('parses parlay wagers (WagerType P)', () => {
    const raw = {
      LIST: [
        { customerID: "BETTOR1", WagerType: "P", AmountWagered: 50000, ToWinAmount: 120000, LegWagerType: "L", PlayNumber: 1, SportType: "Football", AcceptedDateTime: "2026-05-10 14:00:00.000", LegAmountWagered: 50000, LegToWinAmount: 45455 },
        { customerID: "BETTOR1", WagerType: "P", AmountWagered: 50000, ToWinAmount: 120000, LegWagerType: "L", PlayNumber: 2, SportType: "Basketball", AcceptedDateTime: "2026-05-10 14:00:00.000", LegAmountWagered: 50000, LegToWinAmount: 45455 },
      ],
    };
    const result = parseBuckeyeWagers(raw);
    expect(result.length).toBe(2);
    expect(result[0].wagerType).toBe('PARLAY');
    expect(result[0].isParlay).toBe(true);
    expect(result[0].stake).toBe(500);
  });

  test('trims trailing spaces from Buckeye fields', () => {
    const raw = {
      LIST: [
        { customerID: "  ISL66   ", SportType: "  Baseball  ", ChosenTeamID: "  Team A / Team B  ", WagerType: "L", AmountWagered: 10000, AcceptedDateTime: "2026-05-10 15:00:00.000" },
      ],
    };
    const result = parseBuckeyeWagers(raw);
    expect(result[0].bettorId).toBe('ISL66');
    expect(result[0].sport).toBe('Baseball');
    expect(result[0].chosenTeam).toBe('Team A / Team B');
  });

  test('returns empty array for falsy input', () => {
    expect(parseBuckeyeWagers(null)).toEqual([]);
    expect(parseBuckeyeWagers(undefined)).toEqual([]);
    expect(parseBuckeyeWagers({})).toEqual([]);
  });

  test('WAGER_TYPE_MAP covers all known Buckeye codes', () => {
    expect(WAGER_TYPE_MAP['L']).toBe('STRAIGHT');
    expect(WAGER_TYPE_MAP['P']).toBe('PARLAY');
    expect(WAGER_TYPE_MAP['T']).toBe('TEASER');
    expect(WAGER_TYPE_MAP['I']).toBe('IF_BET');
    expect(WAGER_TYPE_MAP['G']).toBe('RACEBOOK');
    expect(WAGER_TYPE_MAP['A']).toBe('MANUAL_PLAY');
    expect(WAGER_TYPE_MAP['C']).toBe('CONTEST');
    expect(WAGER_TYPE_MAP['N']).toBe('LIVE_PROP');
    expect(WAGER_TYPE_MAP['R']).toBe('REVERSE');
    expect(WAGER_TYPE_MAP['M']).toBe('MONEYLINE');
    expect(WAGER_TYPE_MAP['S']).toBe('STRAIGHT');
  });
});
