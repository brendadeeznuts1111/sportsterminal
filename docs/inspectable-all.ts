// src/types/inspectable-all.ts
// COMPREHENSIVE: Every domain object prints beautifully + FULL table columns
// Uses Bun.inspect.custom, Bun.inspect.table, Bun.stringWidth, Bun.wrapAnsi
// Zero npm deps — pure Bun native

import { randomUUIDv7 } from "bun";

// ═══════════════════════════════════════════════════════════════════════════════
// ANSI PALETTE — Bloomberg Terminal Dark Theme with Orange Accents
// ═══════════════════════════════════════════════════════════════════════════════
const $ = {
  reset:     "\x1b[0m",
  bold:      "\x1b[1m",
  dim:       "\x1b[2m",
  italic:    "\x1b[3m",
  underline: "\x1b[4m",
  black:   "\x1b[30m",  red:     "\x1b[31m",  green:   "\x1b[32m",
  yellow:  "\x1b[33m",  blue:    "\x1b[34m",  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",  white:   "\x1b[37m",
  bBlack:  "\x1b[90m",  bRed:    "\x1b[91m",  bGreen:  "\x1b[92m",
  bYellow: "\x1b[93m",  bBlue:   "\x1b[94m",  bMagenta:"\x1b[95m",
  bCyan:   "\x1b[96m",  bWhite:  "\x1b[97m",
  bgBlack: "\x1b[40m",  bgRed:   "\x1b[41m",  bgGreen: "\x1b[42m",
  bgYellow:"\x1b[43m",  bgBlue:  "\x1b[44m",  bgMagenta:"\x1b[45m",
  bgCyan:  "\x1b[46m",  bgWhite: "\x1b[47m",
  orange:     "\x1b[38;5;208m",
  darkOrange: "\x1b[38;5;166m",
  gold:       "\x1b[38;5;220m",
  bgRedWhite:   "\x1b[41m\x1b[37m",
  bgYellowBlack:"\x1b[43m\x1b[30m",
  bgGreenBlack: "\x1b[42m\x1b[30m",
  bgOrangeBlack:"\x1b[48;5;208m\x1b[30m",
};

function c(code: string, text: string, enabled = true): string {
  return enabled ? `${code}${text}${$.reset}` : text;
}

function tierColor(tier?: string): string {
  const map: Record<string, string> = {
    BLACK: $.red, RED: $.yellow, YELLOW: $.orange,
    GREEN: $.green, BLUE: $.blue, GREY: $.dim,
    WHITE: $.white, PURPLE: $.magenta,
  };
  return map[tier || ""] || $.dim;
}

function severityColor(sev?: string): string {
  const map: Record<string, string> = {
    CRITICAL: $.bgRedWhite, HIGH: $.red, MEDIUM: $.yellow,
    LOW: $.green, INFO: $.blue, DEBUG: $.dim,
  };
  return map[sev || ""] || $.dim;
}

function pnlColor(pnl: number): string {
  return pnl > 0 ? $.green : pnl < 0 ? $.red : $.dim;
}

function scoreBar(score: number, width = 20, colors = true): string {
  const filled = Math.round(width * Math.min(score, 1));
  const empty = width - filled;
  const color = score > 0.75 ? $.red : score > 0.5 ? $.yellow : $.green;
  return colors
    ? `${color}${"█".repeat(filled)}${$.dim}${"░".repeat(empty)}${$.reset}`
    : "█".repeat(filled) + "░".repeat(empty);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
interface InspectCtx {
  colors?: boolean;
  depth?: number;
  breakLength?: number;
  compact?: boolean | number;
  sorted?: boolean;
  showHidden?: boolean;
  maxArrayLength?: number;
}

type InspectFn = (value: unknown, options?: InspectCtx) => string;

function wrapIfLong(text: string, maxLen: number, colors: boolean): string {
  if (text.length <= maxLen) return text;
  return colors
    ? Bun.wrapAnsi(text, maxLen, { wordWrap: true, trim: true })
    : text.slice(0, maxLen - 3) + "...";
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. WAGER
// ═══════════════════════════════════════════════════════════════════════════════
export class Wager {
  WagerNumber!: string;
  AgentID!: string;
  CustomerID!: string;
  AmountWagered!: number;
  ToWinAmount?: number;
  Sport?: string;
  Line?: string;
  Odds?: number;
  RiskScore?: number;
  Archetype?: string;
  RiskTier?: string;
  WinRate?: number;
  Velocity?: number;
  TicketDetails?: string;
  PlacedDate?: string;
  Status?: "PENDING" | "WON" | "LOST" | "CANCELLED" | "VOID";
  BetType?: string;
  EventID?: string;
  Market?: string;
  Selection?: string;
  IPAddress?: string;
  Device?: string;
  OddsFormat?: "decimal" | "american" | "fractional";

  constructor(data: Partial<Wager>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const tier = this.RiskTier ? c(tierColor(this.RiskTier), `[${this.RiskTier}]`, colors) : "";
    const archetype = this.Archetype ? c($.dim, `(${this.Archetype})`, colors) : "";
    const win = this.WinRate !== undefined ? c(this.WinRate > 0.6 ? $.green : $.yellow, `${(this.WinRate * 100).toFixed(0)}%`, colors) : "";
    const statusColor = this.Status === "WON" ? $.green : this.Status === "LOST" ? $.red : this.Status === "PENDING" ? $.yellow : $.dim;
    const status = this.Status ? c(statusColor, this.Status, colors) : "";
    return `Wager#${c($.bold, this.WagerNumber, colors)} ${tier} ${archetype} @$${this.AmountWagered} ${this.Sport || ""} ${status} via ${this.AgentID} ${win}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      "Wager #": this.WagerNumber,
      Agent: this.AgentID,
      Customer: this.CustomerID,
      Amount: `$${this.AmountWagered}`,
      "To Win": this.ToWinAmount ? `$${this.ToWinAmount}` : "—",
      Sport: this.Sport || "—",
      Market: this.Market || "—",
      Selection: this.Selection || "—",
      Line: this.Line || "—",
      Odds: this.Odds ?? "—",
      Tier: this.RiskTier || "—",
      Archetype: this.Archetype || "—",
      "Win %": this.WinRate ? `${(this.WinRate * 100).toFixed(0)}%` : "—",
      Velocity: this.Velocity ?? "—",
      Status: this.Status || "—",
      "Bet Type": this.BetType || "—",
      "Placed": this.PlacedDate?.slice(0, 16) || "—",
      IP: this.IPAddress || "—",
      Device: this.Device || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. AGENT
// ═══════════════════════════════════════════════════════════════════════════════
export class Agent {
  agent_id!: string;
  login!: string;
  level!: number;
  hub_id?: string;
  parent_id?: string;
  risk_score?: number;
  commission_tier?: string;
  agent_type?: "M" | "A" | "P";
  children_count?: number;
  name_cluster?: string;
  is_active?: boolean;
  credit_limit?: number;
  wager_limit?: number;
  balance?: number;
  weekly_handle?: number;
  weekly_pnl?: number;
  last_login?: string;
  created_at?: string;
  phone?: string;
  email?: string;

  constructor(data: Partial<Agent>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const typeBadge = this.agent_type === "M" ? c($.bgOrangeBlack, " M ", colors) :
                      this.agent_type === "A" ? c($.bgYellowBlack, " A ", colors) :
                      c($.bgGreenBlack, " P ", colors);
    const risk = this.risk_score !== undefined
      ? c(this.risk_score > 0.75 ? $.red : this.risk_score > 0.5 ? $.yellow : $.green, `risk=${this.risk_score.toFixed(2)}`, colors)
      : "";
    const hub = this.hub_id ? c($.cyan, `@${this.hub_id}`, colors) : "";
    const children = this.children_count ? c($.dim, `+${this.children_count}↓`, colors) : "";
    const limits = this.credit_limit ? c($.dim, `credit=$${this.credit_limit}`, colors) : "";
    return `${typeBadge} ${c($.orange, "Agent", colors)} ${c($.bold, this.login, colors)} L${this.level} ${c($.dim, `[${this.agent_id}]`, colors)} ${risk} ${hub} ${children} ${limits}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      Login: this.login,
      Type: this.agent_type || "—",
      Level: this.level,
      Hub: this.hub_id || "—",
      Parent: this.parent_id || "—",
      "Risk Score": this.risk_score?.toFixed(2) || "—",
      Tier: this.commission_tier || "—",
      Downline: this.children_count ?? "—",
      Credit: this.credit_limit ? `$${this.credit_limit}` : "—",
      "Wager Limit": this.wager_limit ? `$${this.wager_limit}` : "—",
      Balance: this.balance ? `$${this.balance.toFixed(2)}` : "—",
      "7d Handle": this.weekly_handle ? `$${this.weekly_handle.toFixed(0)}` : "—",
      "7d P&L": this.weekly_pnl ? `$${this.weekly_pnl.toFixed(0)}` : "—",
      Active: this.is_active ? "●" : "○",
      Cluster: this.name_cluster || "—",
      "Last Login": this.last_login?.slice(0, 16) || "—",
      Phone: this.phone || "—",
      Email: this.email || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. PLAYER
// ═══════════════════════════════════════════════════════════════════════════════
export class Player {
  customer_id!: string;
  name?: string;
  email?: string;
  phone?: string;
  archetype?: string;
  risk_tier?: string;
  sharp_score?: number;
  lifetime_wagers?: number;
  avg_wager_size?: number;
  win_rate?: number;
  violation_count?: number;
  flag_count?: number;
  deposit_count?: number;
  total_deposited?: number;
  total_withdrawn?: number;
  net_deposits?: number;
  last_active?: string;
  first_seen?: string;
  ip_address?: string;
  country?: string;
  city?: string;
  device_fingerprint?: string;
  tags?: string[];
  notes_count?: number;
  credit_limit?: number;
  current_balance?: number;
  open_bets_count?: number;
  settled_bets_count?: number;

  constructor(data: Partial<Player>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const tier = this.risk_tier ? c(tierColor(this.risk_tier), `[${this.risk_tier}]`, colors) : "";
    const sharp = this.sharp_score !== undefined ? c(this.sharp_score > 70 ? $.red : this.sharp_score > 40 ? $.yellow : $.green, `sharp=${this.sharp_score}`, colors) : "";
    const win = this.win_rate !== undefined ? c(this.win_rate > 0.6 ? $.red : $.green, `win=${(this.win_rate * 100).toFixed(0)}%`, colors) : "";
    const dep = this.total_deposited ? c($.gold, `$${this.total_deposited.toFixed(0)}`, colors) : "";
    const tags = this.tags?.length ? c($.dim, `[${this.tags.join(",")}]`, colors) : "";
    return `${c($.cyan, "Player", colors)} ${c($.bold, this.customer_id, colors)} ${this.name || ""} ${tier} ${sharp} ${win} ${dep} ${tags}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.customer_id,
      Name: this.name || "—",
      Archetype: this.archetype || "—",
      Tier: this.risk_tier || "—",
      "Sharp Score": this.sharp_score ?? "—",
      "Win Rate": this.win_rate ? `${(this.win_rate * 100).toFixed(0)}%` : "—",
      "Lifetime Wagers": this.lifetime_wagers ?? "—",
      "Avg Wager": this.avg_wager_size ? `$${this.avg_wager_size.toFixed(2)}` : "—",
      "Open Bets": this.open_bets_count ?? "—",
      "Settled": this.settled_bets_count ?? "—",
      Deposited: this.total_deposited ? `$${this.total_deposited.toFixed(0)}` : "—",
      Withdrawn: this.total_withdrawn ? `$${this.total_withdrawn.toFixed(0)}` : "—",
      "Net Deposits": this.net_deposits ? `$${this.net_deposits.toFixed(0)}` : "—",
      Balance: this.current_balance ? `$${this.current_balance.toFixed(2)}` : "—",
      Credit: this.credit_limit ? `$${this.credit_limit}` : "—",
      Violations: this.violation_count ?? "—",
      Flags: this.flag_count ?? "—",
      Tags: this.tags?.join(", ") || "—",
      "Last Active": this.last_active?.slice(0, 16) || "—",
      "First Seen": this.first_seen?.slice(0, 10) || "—",
      Country: this.country || "—",
      City: this.city || "—",
      IP: this.ip_address || "—",
      Notes: this.notes_count ?? "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. RISK SCORE
// ═══════════════════════════════════════════════════════════════════════════════
export class RiskScore {
  wagerNumber!: string;
  playerId!: string;
  compositeScore!: number;
  sharpScore!: number;
  velocityScore!: number;
  ipRiskScore!: number;
  syndicateScore!: number;
  clvScore?: number;
  stakeAnomalyScore?: number;
  timingScore?: number;
  flags!: string[];
  traceId!: string;
  reasoning?: string[];
  aiConfidence?: number;
  aiSummary?: string;
  modelVersion?: string;
  calculatedAt?: string;

  constructor(data: Partial<RiskScore>) {
    Object.assign(this, data);
    this.traceId = data.traceId || randomUUIDv7("base64url");
    this.flags = data.flags || [];
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const sc = this.compositeScore > 0.75 ? $.red : this.compositeScore > 0.5 ? $.yellow : $.green;
    const flags = this.flags.length > 0 ? c($.dim, `flags=[${this.flags.join(", ")}]`, colors) : "";
    const ai = this.aiConfidence !== undefined ? c($.magenta, `AI=${(this.aiConfidence * 100).toFixed(0)}%`, colors) : "";
    return `RiskScore${c(sc, `(${this.compositeScore.toFixed(2)})`, colors)} wager=${this.wagerNumber} player=${this.playerId} ${flags} trace=${this.traceId.slice(0, 8)} ${ai}`;
  }

  inspectDetailed(opts: InspectCtx): string {
    const colors = opts.colors ?? false;
    const rows = [
      { Metric: "Composite", Score: this.compositeScore.toFixed(2), Bar: scoreBar(this.compositeScore, 20, colors) },
      { Metric: "Sharp",     Score: this.sharpScore.toFixed(2),     Bar: scoreBar(this.sharpScore, 20, colors) },
      { Metric: "Velocity",  Score: this.velocityScore.toFixed(2),  Bar: scoreBar(this.velocityScore, 20, colors) },
      { Metric: "IP Risk",   Score: this.ipRiskScore.toFixed(2),    Bar: scoreBar(this.ipRiskScore, 20, colors) },
      { Metric: "Syndicate", Score: this.syndicateScore.toFixed(2), Bar: scoreBar(this.syndicateScore, 20, colors) },
      { Metric: "CLV",       Score: this.clvScore?.toFixed(2) ?? "—", Bar: this.clvScore ? scoreBar(this.clvScore, 20, colors) : "—" },
      { Metric: "Stake Anom",Score: this.stakeAnomalyScore?.toFixed(2) ?? "—", Bar: this.stakeAnomalyScore ? scoreBar(this.stakeAnomalyScore, 20, colors) : "—" },
      { Metric: "Timing",    Score: this.timingScore?.toFixed(2) ?? "—", Bar: this.timingScore ? scoreBar(this.timingScore, 20, colors) : "—" },
    ];
    return Bun.inspect.table(rows, ["Metric", "Score", "Bar"], { colors });
  }

  toTableRow(): Record<string, unknown> {
    return {
      Wager: this.wagerNumber,
      Player: this.playerId,
      Composite: this.compositeScore.toFixed(2),
      Sharp: this.sharpScore.toFixed(2),
      Velocity: this.velocityScore.toFixed(2),
      "IP Risk": this.ipRiskScore.toFixed(2),
      Syndicate: this.syndicateScore.toFixed(2),
      CLV: this.clvScore?.toFixed(2) ?? "—",
      "Stake Anom": this.stakeAnomalyScore?.toFixed(2) ?? "—",
      Timing: this.timingScore?.toFixed(2) ?? "—",
      Flags: this.flags.join(", ") || "—",
      Trace: this.traceId.slice(0, 8),
      AI: this.aiConfidence ? `${(this.aiConfidence * 100).toFixed(0)}%` : "—",
      Model: this.modelVersion || "—",
      Time: this.calculatedAt?.slice(11, 19) || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. POSITION
// ═══════════════════════════════════════════════════════════════════════════════
export class Position {
  positionId!: string;
  playerId!: string;
  sport!: string;
  league?: string;
  market!: string;
  eventId?: string;
  side!: "back" | "lay";
  stake!: number;
  odds!: number;
  oddsFormat?: string;
  exposure!: number;
  pnl!: number;
  status!: "OPEN" | "HEDGED" | "CLOSED" | "SETTLED";
  openedAt?: string;
  closedAt?: string;
  settledAt?: string;
  hedgeId?: string;
  hedgeStake?: number;
  hedgeOdds?: number;
  bookExposure?: number;
  sportbookLiability?: number;
  margin?: number;
  holdPercentage?: number;

  constructor(data: Partial<Position>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const pnlC = pnlColor(this.pnl);
    const sideC = this.side === "back" ? $.magenta : $.cyan;
    const statusBadge = this.status === "OPEN" ? c($.bgGreenBlack, " OPEN ", colors) :
                        this.status === "HEDGED" ? c($.bgYellowBlack, " HEDGED ", colors) :
                        this.status === "SETTLED" ? c($.bgOrangeBlack, " SETTLED ", colors) :
                        c($.dim, " [CLOSED] ", colors);
    const exposure = this.bookExposure ? c($.yellow, `book=$${this.bookExposure.toFixed(0)}`, colors) : "";
    return `Pos#${c($.bold, this.positionId, colors)} ${c(sideC, this.side.toUpperCase(), colors)} ${this.sport}/${this.market} $${this.stake}@${this.odds} ${c(pnlC, `P&L=$${this.pnl.toFixed(2)}`, colors)} ${statusBadge} ${exposure}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.positionId,
      Sport: this.sport,
      League: this.league || "—",
      Market: this.market,
      Event: this.eventId || "—",
      Side: this.side,
      Stake: `$${this.stake}`,
      Odds: this.odds,
      "Odds Fmt": this.oddsFormat || "—",
      Exposure: `$${this.exposure}`,
      "P&L": `$${this.pnl.toFixed(2)}`,
      Status: this.status,
      "Book Exp": this.bookExposure ? `$${this.bookExposure.toFixed(0)}` : "—",
      Liability: this.sportbookLiability ? `$${this.sportbookLiability.toFixed(0)}` : "—",
      Margin: this.margin ? `${(this.margin * 100).toFixed(1)}%` : "—",
      Hold: this.holdPercentage ? `${(this.holdPercentage * 100).toFixed(1)}%` : "—",
      "Hedge ID": this.hedgeId || "—",
      "Hedge Stake": this.hedgeStake ? `$${this.hedgeStake}` : "—",
      "Hedge Odds": this.hedgeOdds ?? "—",
      Opened: this.openedAt?.slice(0, 16) || "—",
      Closed: this.closedAt?.slice(0, 16) || "—",
      Settled: this.settledAt?.slice(0, 16) || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. RISK ALERT
// ═══════════════════════════════════════════════════════════════════════════════
export class RiskAlert {
  id!: string;
  type!: "SHARP" | "VELOCITY" | "SYNDICATE" | "IP" | "RULE" | "AI" | "SYSTEM";
  severity!: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  playerId!: string;
  wagerNumber?: string;
  message!: string;
  timestamp!: string;
  traceId!: string;
  suggestedAction?: string;
  channel?: "telegram" | "discord" | "sms" | "webhook" | "email";
  delivered?: boolean;
  deliveryAttempts?: number;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  dismissed?: boolean;
  relatedAlerts?: string[];

  constructor(data: Partial<RiskAlert>) {
    Object.assign(this, data);
    this.id = data.id || randomUUIDv7("base64url");
    this.timestamp = data.timestamp || new Date().toISOString();
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const sevBadge = c(severityColor(this.severity), ` ${this.severity} `, colors);
    const typeBadge = c($.dim, `[${this.type}]`, colors);
    const action = this.suggestedAction ? c($.cyan, `→ ${this.suggestedAction}`, colors) : "";
    const delivered = this.delivered === false ? c($.red, " [UNDEIVERED]", colors) : "";
    const ack = this.acknowledgedBy ? c($.green, `✓${this.acknowledgedBy}`, colors) : "";
    const msg = colors && this.message.length > 60
      ? Bun.wrapAnsi(this.message, 60, { wordWrap: true, trim: true })
      : this.message;
    return `${sevBadge} ${typeBadge} ${msg} player=${c($.bold, this.playerId, colors)} trace=${this.traceId.slice(0, 8)} ${action}${delivered} ${ack}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      Sev: this.severity,
      Type: this.type,
      Player: this.playerId,
      Wager: this.wagerNumber || "—",
      Message: this.message.slice(0, 50),
      Action: this.suggestedAction || "—",
      Channel: this.channel || "—",
      Delivered: this.delivered ? "✓" : this.delivered === false ? "✗" : "—",
      Attempts: this.deliveryAttempts ?? "—",
      Ack: this.acknowledgedBy ? `${this.acknowledgedBy} @${this.acknowledgedAt?.slice(11, 16)}` : "—",
      Dismissed: this.dismissed ? "✓" : "—",
      Related: this.relatedAlerts?.length ?? "—",
      Time: this.timestamp.slice(11, 19),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. HUB SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════
export class HubSummary {
  hub_id!: string;
  name!: string;
  agent_count!: number;
  player_count?: number;
  active_players?: number;
  total_handle_7d!: number;
  total_handle_30d?: number;
  total_pnl_7d!: number;
  total_pnl_30d?: number;
  flagged_children!: number;
  avg_risk_score!: number;
  max_risk_score?: number;
  top_agent?: string;
  top_agent_handle?: number;
  weekly_deposits?: number;
  weekly_withdrawals?: number;
  commission_paid?: number;
  active_wagers_count?: number;
  settled_wagers_count?: number;

  constructor(data: Partial<HubSummary>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const riskC = this.avg_risk_score > 0.5 ? $.yellow : $.green;
    const pnlC = pnlColor(this.total_pnl_7d);
    const flags = this.flagged_children > 0 ? c($.red, `${this.flagged_children}⚠`, colors) : "";
    const players = this.active_players ? c($.dim, `${this.active_players}👤`, colors) : "";
    return `${c($.orange, "Hub", colors)} ${c($.bold, this.name, colors)} ${c($.dim, `[${this.hub_id}]`, colors)} ${this.agent_count} agents ${players} ${c(riskC, `risk=${this.avg_risk_score.toFixed(2)}`, colors)} ${c(pnlC, `P&L=$${this.total_pnl_7d.toFixed(0)}`, colors)} ${flags}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      Hub: this.name,
      ID: this.hub_id,
      Agents: this.agent_count,
      Players: this.player_count ?? "—",
      Active: this.active_players ?? "—",
      "7d Handle": `$${this.total_handle_7d.toFixed(0)}`,
      "30d Handle": this.total_handle_30d ? `$${this.total_handle_30d.toFixed(0)}` : "—",
      "7d P&L": `$${this.total_pnl_7d.toFixed(0)}`,
      "30d P&L": this.total_pnl_30d ? `$${this.total_pnl_30d.toFixed(0)}` : "—",
      "Risk Avg": this.avg_risk_score.toFixed(2),
      "Risk Max": this.max_risk_score?.toFixed(2) ?? "—",
      Flags: this.flagged_children,
      Deposits: this.weekly_deposits ? `$${this.weekly_deposits.toFixed(0)}` : "—",
      Withdrawals: this.weekly_withdrawals ? `$${this.weekly_withdrawals.toFixed(0)}` : "—",
      Commission: this.commission_paid ? `$${this.commission_paid.toFixed(0)}` : "—",
      "Top Agent": this.top_agent || "—",
      "Top Handle": this.top_agent_handle ? `$${this.top_agent_handle.toFixed(0)}` : "—",
      "Active Wagers": this.active_wagers_count ?? "—",
      "Settled": this.settled_wagers_count ?? "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. PLUGIN MANIFEST
// ═══════════════════════════════════════════════════════════════════════════════
export class PluginManifest {
  name!: string;
  version!: string;
  category!: string;
  author?: string;
  description?: string;
  isActive?: boolean;
  installPath?: string;
  installedAt?: string;
  lastExecuted?: string;
  executionCount?: number;
  avgDurationMs?: number;
  permissions?: {
    hierarchy_scope?: string;
    can_write_buckeye?: boolean;
    can_send_telegram?: boolean;
    can_access_players?: boolean;
    can_modify_limits?: boolean;
    sqlite_access?: string;
  };
  hooks?: string[];
  tools?: string[];
  miniapp?: { enabled: boolean; route?: string; widget?: string };
  cronSchedules?: string[];
  networkDomains?: string[];

  constructor(data: Partial<PluginManifest>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const status = this.isActive ? c($.green, "●", colors) : c($.red, "○", colors);
    const cat = c($.cyan, `[${this.category}]`, colors);
    const mini = this.miniapp?.enabled ? c($.gold, "🌐", colors) : "";
    const hooks = this.hooks?.length ? c($.dim, `${this.hooks.length} hooks`, colors) : "";
    const perms = this.permissions?.can_write_buckeye ? c($.red, "WRITE", colors) : "";
    const cron = this.cronSchedules?.length ? c($.dim, `⏰${this.cronSchedules.length}`, colors) : "";
    return `${status} ${c($.bold, this.name, colors)}@${this.version} ${cat} ${mini} ${hooks} ${perms} ${cron} ${this.author ? `by ${this.author}` : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      Plugin: this.name,
      Version: this.version,
      Category: this.category,
      Active: this.isActive ? "✓" : "✗",
      Hooks: this.hooks?.length ?? 0,
      Tools: this.tools?.length ?? 0,
      Cron: this.cronSchedules?.length ?? 0,
      MiniApp: this.miniapp?.enabled ? `✓ ${this.miniapp.route}` : "—",
      Widget: this.miniapp?.widget || "—",
      Write: this.permissions?.can_write_buckeye ? "⚠" : "—",
      Telegram: this.permissions?.can_send_telegram ? "✓" : "—",
      Players: this.permissions?.can_access_players ? "✓" : "—",
      Limits: this.permissions?.can_modify_limits ? "⚠" : "—",
      SQLite: this.permissions?.sqlite_access || "—",
      Domains: this.networkDomains?.join(", ") || "—",
      Author: this.author || "—",
      Path: this.installPath || "—",
      Installed: this.installedAt?.slice(0, 10) || "—",
      "Last Run": this.lastExecuted?.slice(0, 16) || "—",
      "Exec Count": this.executionCount ?? "—",
      "Avg Dur": this.avgDurationMs ? `${this.avgDurationMs.toFixed(0)}ms` : "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. PLUGIN EXECUTION LOG
// ═══════════════════════════════════════════════════════════════════════════════
export class PluginExecution {
  id!: number;
  plugin_name!: string;
  tool_name?: string;
  trigger_type!: string;
  agent_id?: string;
  hub_id?: string;
  level?: number;
  cluster?: string;
  target_customer_id?: string;
  risk_score_contribution?: number;
  confidence?: number;
  result_summary?: string;
  parameters?: string;
  result_json?: string;
  error?: string;
  exit_code?: number;
  duration_ms!: number;
  duration_ns?: number;
  trace_id!: string;
  created_at!: string;

  constructor(data: Partial<PluginExecution>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const status = this.error ? c($.red, "✗", colors) : c($.green, "✓", colors);
    const risk = this.risk_score_contribution ? c(this.risk_score_contribution > 0.5 ? $.red : $.green, `+${this.risk_score_contribution.toFixed(2)}`, colors) : "";
    const dur = c($.dim, `${this.duration_ms}ms`, colors);
    const ns = this.duration_ns ? c($.dim, `${(this.duration_ns / 1_000_000).toFixed(3)}ms`, colors) : "";
    return `${status} ${c($.bold, this.plugin_name, colors)}${this.tool_name ? "/" + this.tool_name : ""} [${this.trigger_type}] ${risk} ${dur} ${ns} trace=${this.trace_id.slice(0, 8)} ${this.error ? c($.red, this.error.slice(0, 40), colors) : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id,
      Plugin: this.plugin_name,
      Tool: this.tool_name || "—",
      Trigger: this.trigger_type,
      Agent: this.agent_id || "—",
      Hub: this.hub_id || "—",
      Level: this.level ?? "—",
      Cluster: this.cluster || "—",
      Target: this.target_customer_id || "—",
      "Risk +": this.risk_score_contribution?.toFixed(2) || "—",
      Confidence: this.confidence ? `${(this.confidence * 100).toFixed(0)}%` : "—",
      Summary: this.result_summary?.slice(0, 30) || "—",
      Duration: `${this.duration_ms}ms`,
      "Dur (ns)": this.duration_ns ? `${(this.duration_ns / 1_000_000).toFixed(3)}ms` : "—",
      Status: this.error ? "ERROR" : this.exit_code ? `EXIT:${this.exit_code}` : "OK",
      "Error Msg": this.error?.slice(0, 30) || "—",
      Trace: this.trace_id.slice(0, 8),
      Time: this.created_at.slice(11, 19),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. AI RISK FLAG
// ═══════════════════════════════════════════════════════════════════════════════
export class AIRiskFlag {
  id!: string;
  customer_id!: string;
  risk_level!: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  suggested_action!: "review" | "reduce" | "block" | "monitor" | "none";
  ai_summary?: string;
  ai_confidence?: number;
  heuristic_fallback?: boolean;
  model_used?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  latency_ms?: number;
  created_at!: string;
  trace_id!: string;
  wager_number?: string;
  rule_triggered?: string;

  constructor(data: Partial<AIRiskFlag>) {
    Object.assign(this, data);
    this.id = data.id || randomUUIDv7("base64url");
    this.created_at = data.created_at || new Date().toISOString();
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const levelColor = this.risk_level === "CRITICAL" ? $.bgRedWhite :
                       this.risk_level === "HIGH" ? $.red :
                       this.risk_level === "MEDIUM" ? $.yellow : $.green;
    const level = c(levelColor, ` ${this.risk_level} `, colors);
    const action = c($.cyan, `→ ${this.suggested_action}`, colors);
    const ai = this.heuristic_fallback ? c($.yellow, "[HEURISTIC]", colors) : c($.magenta, "[AI]", colors);
    const conf = this.aiConfidence ? c($.dim, `${(this.aiConfidence * 100).toFixed(0)}%`, colors) : "";
    const tokens = this.total_tokens ? c($.dim, `${this.total_tokens}tok`, colors) : "";
    const summary = this.ai_summary && colors
      ? Bun.wrapAnsi(this.ai_summary, 70, { wordWrap: true, trim: true })
      : this.ai_summary?.slice(0, 70);
    return `${ai} ${level} ${action} ${conf} ${tokens} player=${c($.bold, this.customer_id, colors)} ${summary ? "\n  " + summary : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id.slice(0, 8),
      Player: this.customer_id,
      Wager: this.wager_number || "—",
      Level: this.risk_level,
      Action: this.suggested_action,
      Source: this.heuristic_fallback ? "Heuristic" : "AI",
      Model: this.model_used || "—",
      Confidence: this.aiConfidence ? `${(this.aiConfidence * 100).toFixed(0)}%` : "—",
      "Prompt Tok": this.prompt_tokens ?? "—",
      "Comp Tok": this.completion_tokens ?? "—",
      "Total Tok": this.total_tokens ?? "—",
      "Latency": this.latency_ms ? `${this.latency_ms}ms` : "—",
      Rule: this.rule_triggered || "—",
      Time: this.created_at.slice(11, 19),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 11. AGENT ACTION (Rules Engine)
// ═══════════════════════════════════════════════════════════════════════════════
export class AgentAction {
  id!: string;
  rule_name!: string;
  rule_id?: string;
  customer_id!: string;
  agent_id?: string;
  hub_id?: string;
  action!: "review" | "reduce" | "block" | "monitor" | "limit" | "suspend";
  reason!: string;
  triggered_by?: string;
  triggered_value?: string;
  is_executed?: boolean;
  executed_at?: string;
  executed_by?: string;
  buckeye_log_id?: string;
  telegram_alert_id?: string;
  created_at!: string;

  constructor(data: Partial<AgentAction>) {
    Object.assign(this, data);
    this.id = data.id || randomUUIDv7("base64url");
    this.created_at = data.created_at || new Date().toISOString();
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const actionColor = this.action === "block" || this.action === "suspend" ? $.red :
                        this.action === "reduce" || this.action === "limit" ? $.yellow :
                        this.action === "review" ? $.orange : $.green;
    const exec = this.is_executed ? c($.green, "✓", colors) : c($.dim, "○", colors);
    return `${exec} ${c($.bold, this.rule_name, colors)} ${c(actionColor, this.action.toUpperCase(), colors)} player=${this.customer_id} ${c($.dim, this.reason.slice(0, 50), colors)}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id.slice(0, 8),
      Rule: this.rule_name,
      "Rule ID": this.rule_id || "—",
      Action: this.action,
      Player: this.customer_id,
      Agent: this.agent_id || "—",
      Hub: this.hub_id || "—",
      Reason: this.reason.slice(0, 40),
      Trigger: this.triggered_by || "—",
      "Trigger Val": this.triggered_value || "—",
      Executed: this.is_executed ? "✓" : "○",
      "Exec At": this.executed_at?.slice(0, 16) || "—",
      "Exec By": this.executed_by || "—",
      "Buckeye Log": this.buckeye_log_id?.slice(0, 8) || "—",
      "Telegram": this.telegram_alert_id?.slice(0, 8) || "—",
      Time: this.created_at.slice(11, 19),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 12. ENFORCEMENT QUEUE
// ═══════════════════════════════════════════════════════════════════════════════
export class EnforcementQueueItem {
  id!: string;
  action_type!: "SUSPEND" | "LIMIT" | "ALERT" | "BLOCK" | "REDUCE" | "REVIEW";
  target_id!: string;
  target_type!: "player" | "agent" | "wager";
  priority!: number;
  status!: "pending" | "processing" | "completed" | "failed" | "cancelled";
  ai_decision_id?: string;
  buckeye_log_id?: string;
  telegram_alert_id?: string;
  plugin_execution_id?: string;
  error_message?: string;
  retry_count?: number;
  max_retries?: number;
  created_at!: string;
  executed_at?: string;
  expires_at?: string;

  constructor(data: Partial<EnforcementQueueItem>) {
    Object.assign(this, data);
    this.id = data.id || randomUUIDv7("base64url");
    this.created_at = data.created_at || new Date().toISOString();
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const statusColor = this.status === "completed" ? $.green :
                        this.status === "failed" ? $.red :
                        this.status === "processing" ? $.yellow :
                        this.status === "cancelled" ? $.dim : $.orange;
    const typeColor = this.action_type === "BLOCK" || this.action_type === "SUSPEND" ? $.red : $.yellow;
    const retry = this.retry_count ? c($.dim, `retry:${this.retry_count}/${this.max_retries || 3}`, colors) : "";
    return `${c(statusColor, `[${this.status.toUpperCase()}]`, colors)} ${c(typeColor, this.action_type, colors)} ${this.target_type}=${c($.bold, this.target_id, colors)} P${this.priority} ${retry} ${this.executed_at ? c($.dim, this.executed_at.slice(11, 19), colors) : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id.slice(0, 8),
      Action: this.action_type,
      Target: this.target_id,
      Type: this.target_type,
      Priority: this.priority,
      Status: this.status,
      "AI Ref": this.ai_decision_id?.slice(0, 8) || "—",
      "Buckeye": this.buckeye_log_id?.slice(0, 8) || "—",
      "Telegram": this.telegram_alert_id?.slice(0, 8) || "—",
      "Plugin": this.plugin_execution_id?.slice(0, 8) || "—",
      Retries: this.retry_count != null ? `${this.retry_count}/${this.max_retries || 3}` : "—",
      Error: this.error_message?.slice(0, 20) || "—",
      Created: this.created_at.slice(11, 19),
      Executed: this.executed_at?.slice(11, 19) || "—",
      Expires: this.expires_at?.slice(11, 19) || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 13. TELEGRAM ROUTE
// ═══════════════════════════════════════════════════════════════════════════════
export class TelegramRoute {
  plugin_name!: string;
  agent_id!: string;
  topic_purpose!: "alerts" | "approvals" | "general" | "risk" | "audit";
  topic_id!: number;
  chat_id!: string;
  chat_name?: string;
  is_default?: boolean;
  last_used?: string;
  message_count?: number;
  delivery_rate?: number;

  constructor(data: Partial<TelegramRoute>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const def = this.is_default ? c($.gold, "★", colors) : "";
    const rate = this.delivery_rate !== undefined ? c(this.delivery_rate > 0.9 ? $.green : $.yellow, `${(this.delivery_rate * 100).toFixed(0)}%`, colors) : "";
    return `${def} ${c($.cyan, this.plugin_name, colors)} → topic#${this.topic_id} [${this.topic_purpose}] agent=${this.agent_id} ${rate}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      Plugin: this.plugin_name,
      Agent: this.agent_id,
      Purpose: this.topic_purpose,
      Topic: this.topic_id,
      Chat: this.chat_id,
      "Chat Name": this.chat_name || "—",
      Default: this.is_default ? "★" : "",
      "Last Used": this.last_used?.slice(0, 16) || "—",
      Messages: this.message_count ?? "—",
      "Delivery %": this.delivery_rate ? `${(this.delivery_rate * 100).toFixed(0)}%` : "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 14. BUCKEYE WRITE AUDIT
// ═══════════════════════════════════════════════════════════════════════════════
export class BuckeyeWriteAudit {
  id!: string;
  idempotency_key!: string;
  wager_id?: string;
  customer_id?: string;
  operation!: string;
  column?: string;
  old_value?: string;
  new_value?: string;
  payload_hash!: string;
  integrity_hash!: string;
  status!: "pending" | "completed" | "failed" | "rolled_back";
  error?: string;
  error_code?: string;
  performed_by!: string;
  performed_at!: string;
  ai_decision_id?: string;
  telegram_alert_id?: string;
  plugin_name?: string;
  request_duration_ms?: number;
  buckeye_response_code?: number;
  created_at!: string;

  constructor(data: Partial<BuckeyeWriteAudit>) {
    Object.assign(this, data);
    this.id = data.id || randomUUIDv7("base64url");
    this.created_at = data.created_at || new Date().toISOString();
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const statusColor = this.status === "completed" ? $.green : this.status === "failed" ? $.red : this.status === "rolled_back" ? $.yellow : $.orange;
    const hash = c($.dim, this.payload_hash.slice(0, 16) + "...", colors);
    const col = this.column ? c($.cyan, `${this.column}`, colors) : "";
    const val = this.new_value ? c($.bold, `→ ${this.new_value}`, colors) : "";
    return `${c(statusColor, `[${this.status.toUpperCase()}]`, colors)} ${c($.bold, this.operation, colors)} ${col} ${val} wager=${this.wager_id || "—"} by=${this.performed_by} hash=${hash} ${this.error ? c($.red, this.error.slice(0, 30), colors) : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id.slice(0, 8),
      Operation: this.operation,
      Column: this.column || "—",
      "Old Val": this.old_value?.slice(0, 20) || "—",
      "New Val": this.new_value?.slice(0, 20) || "—",
      Wager: this.wager_id || "—",
      Customer: this.customer_id || "—",
      Status: this.status,
      By: this.performed_by,
      "At": this.performed_at.slice(11, 19),
      "Payload Hash": this.payload_hash.slice(0, 16) + "...",
      Integrity: this.integrity_hash.slice(0, 16) + "...",
      "Error Code": this.error_code || "—",
      Error: this.error?.slice(0, 20) || "—",
      "AI Ref": this.ai_decision_id?.slice(0, 8) || "—",
      Telegram: this.telegram_alert_id?.slice(0, 8) || "—",
      Plugin: this.plugin_name || "—",
      "Dur ms": this.request_duration_ms ?? "—",
      "HTTP": this.buckeye_response_code ?? "—",
      Time: this.created_at.slice(11, 19),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 15. PLAYER TRANSACTION
// ═══════════════════════════════════════════════════════════════════════════════
export class PlayerTransaction {
  id!: string;
  customer_id!: string;
  type!: "DEPOSIT" | "WITHDRAWAL" | "BONUS" | "ADJUSTMENT" | "REFUND" | "FEE";
  amount!: number;
  currency?: string;
  method?: string;
  method_detail?: string;
  status!: "PENDING" | "COMPLETED" | "FAILED" | "REVERSED" | "CANCELLED";
  tran_date_time?: string;
  processed_date_time?: string;
  description?: string;
  reference_id?: string;
  processed_by?: string;
  ip_address?: string;
  device?: string;
  fee_amount?: number;
  net_amount?: number;

  constructor(data: Partial<PlayerTransaction>) {
    Object.assign(this, data);
    this.id = data.id || randomUUIDv7("base64url");
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const amtColor = this.type === "DEPOSIT" || this.type === "BONUS" ? $.green :
                     this.type === "WITHDRAWAL" || this.type === "FEE" ? $.red : $.yellow;
    const statusColor = this.status === "COMPLETED" ? $.green : this.status === "FAILED" ? $.red : $.yellow;
    const fee = this.fee_amount ? c($.red, `-$${this.fee_amount}`, colors) : "";
    return `${c($.cyan, this.type, colors)} ${c(amtColor, `$${Math.abs(this.amount).toFixed(2)}`, colors)} ${c(statusColor, `[${this.status}]`, colors)} ${this.customer_id} ${this.method ? `via ${this.method}` : ""} ${fee} ${this.description ? c($.dim, this.description.slice(0, 30), colors) : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id.slice(0, 8),
      Type: this.type,
      Amount: `$${this.amount.toFixed(2)}`,
      Currency: this.currency || "USD",
      Net: this.net_amount ? `$${this.net_amount.toFixed(2)}` : "—",
      Fee: this.fee_amount ? `$${this.fee_amount.toFixed(2)}` : "—",
      Method: this.method || "—",
      Detail: this.method_detail || "—",
      Status: this.status,
      Customer: this.customer_id,
      Ref: this.reference_id || "—",
      Description: this.description?.slice(0, 30) || "—",
      IP: this.ip_address || "—",
      Device: this.device || "—",
      "Processed By": this.processed_by || "—",
      Time: this.tran_date_time?.slice(0, 16) || "—",
      "Processed": this.processed_date_time?.slice(0, 16) || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 16. WAGER VIOLATION
// ═══════════════════════════════════════════════════════════════════════════════
export class WagerViolation {
  id!: string;
  wager_number!: string;
  customer_id!: string;
  agent_id?: string;
  rule_id!: string;
  rule_name!: string;
  rule_category?: string;
  severity!: "MINOR" | "MAJOR" | "CRITICAL";
  details?: string;
  detected_at!: string;
  detected_by?: string;
  resolved_at?: string;
  resolved_by?: string;
  resolution?: string;
  status?: "open" | "resolved" | "escalated";

  constructor(data: Partial<WagerViolation>) {
    Object.assign(this, data);
    this.id = data.id || randomUUIDv7("base64url");
    this.detected_at = data.detected_at || new Date().toISOString();
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const sevColor = this.severity === "CRITICAL" ? $.red : this.severity === "MAJOR" ? $.yellow : $.orange;
    const resolved = this.resolved_at ? c($.green, "✓", colors) : c($.red, "○", colors);
    const status = this.status === "escalated" ? c($.bgRedWhite, " ESCALATED ", colors) : "";
    return `${resolved} ${status} ${c(sevColor, this.severity, colors)} ${c($.bold, this.rule_name, colors)} wager=${this.wager_number} ${this.details ? c($.dim, this.details.slice(0, 40), colors) : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id.slice(0, 8),
      Rule: this.rule_name,
      "Rule ID": this.rule_id,
      Category: this.rule_category || "—",
      Severity: this.severity,
      Wager: this.wager_number,
      Player: this.customer_id,
      Agent: this.agent_id || "—",
      Details: this.details?.slice(0, 30) || "—",
      Status: this.status || "open",
      Detected: this.detected_at.slice(11, 16),
      "Detected By": this.detected_by || "—",
      Resolved: this.resolved_at?.slice(11, 16) || "—",
      "Resolved By": this.resolved_by || "—",
      Resolution: this.resolution?.slice(0, 20) || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 17. PLAYER FLAG
// ═══════════════════════════════════════════════════════════════════════════════
export class PlayerFlag {
  id!: string;
  customer_id!: string;
  flag_type!: "SHARP" | "SYNDICATE" | "BOT" | "FRAUD" | "VIP" | "WATCH" | "LIMIT" | "MANUAL" | "ARBITRAGE" | "MONEY_LAUNDERING";
  source!: "AI" | "RULE" | "MANUAL" | "PLUGIN" | "EXTERNAL";
  reason!: string;
  evidence?: string;
  confidence?: number;
  created_by?: string;
  created_at!: string;
  updated_at?: string;
  expires_at?: string;
  resolved_at?: string;
  resolved_by?: string;
  is_active!: boolean;
  wager_count_impact?: number;

  constructor(data: Partial<PlayerFlag>) {
    Object.assign(this, data);
    this.id = data.id || randomUUIDv7("base64url");
    this.created_at = data.created_at || new Date().toISOString();
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const typeColor = this.flag_type === "SHARP" ? $.red :
                      this.flag_type === "SYNDICATE" ? $.magenta :
                      this.flag_type === "BOT" ? $.yellow :
                      this.flag_type === "FRAUD" || this.flag_type === "MONEY_LAUNDERING" ? $.bgRedWhite :
                      this.flag_type === "ARBITRAGE" ? $.orange :
                      this.flag_type === "VIP" ? $.gold : $.orange;
    const sourceColor = this.source === "AI" ? $.magenta : this.source === "MANUAL" ? $.blue : $.dim;
    const active = this.is_active ? c($.green, "●", colors) : c($.dim, "○", colors);
    const conf = this.confidence ? c($.dim, `${(this.confidence * 100).toFixed(0)}%`, colors) : "";
    return `${active} ${c(typeColor, this.flag_type, colors)} ${c(sourceColor, `[${this.source}]`, colors)} ${conf} ${c($.bold, this.customer_id, colors)} ${c($.dim, this.reason.slice(0, 40), colors)} ${this.expires_at ? `expires=${this.expires_at.slice(0, 10)}` : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id.slice(0, 8),
      Flag: this.flag_type,
      Player: this.customer_id,
      Source: this.source,
      Confidence: this.confidence ? `${(this.confidence * 100).toFixed(0)}%` : "—",
      Reason: this.reason.slice(0, 30),
      Evidence: this.evidence?.slice(0, 20) || "—",
      By: this.created_by || "—",
      Active: this.is_active ? "●" : "○",
      Created: this.created_at.slice(0, 10),
      Updated: this.updated_at?.slice(0, 10) || "—",
      Expires: this.expires_at?.slice(0, 10) || "—",
      Resolved: this.resolved_at?.slice(0, 10) || "—",
      "Resolved By": this.resolved_by || "—",
      Impact: this.wager_count_impact ?? "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 18. SPORT EVENT
// ═══════════════════════════════════════════════════════════════════════════════
export class SportEvent {
  event_id!: string;
  sport!: string;
  league?: string;
  home_team?: string;
  away_team?: string;
  start_time?: string;
  status!: "UPCOMING" | "LIVE" | "FINAL" | "CANCELLED" | "POSTPONED";
  score_home?: number;
  score_away?: number;
  period?: string;
  time_remaining?: string;
  venue?: string;
  broadcast?: string;
  markets?: Market[];
  market_count?: number;
  volume?: number;
  handle?: number;

  constructor(data: Partial<SportEvent>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const statusColor = this.status === "LIVE" ? $.bgRedWhite :
                        this.status === "UPCOMING" ? $.green :
                        this.status === "FINAL" ? $.dim : $.red;
    const score = this.score_home !== undefined && this.score_away !== undefined
      ? c($.bold, `${this.score_home}-${this.score_away}`, colors)
      : "";
    const teams = this.home_team && this.away_team
      ? `${c($.bold, this.home_team, colors)} vs ${c($.bold, this.away_team, colors)}`
      : "";
    const mkts = this.market_count ? c($.dim, `${this.market_count} markets`, colors) : "";
    const vol = this.volume ? c($.dim, `$${this.volume}`, colors) : "";
    return `${c(statusColor, ` ${this.status} `, colors)} ${c($.orange, this.sport, colors)} ${this.league ? `| ${this.league}` : ""} ${teams} ${score} ${this.period ? c($.yellow, this.period, colors) : ""} ${mkts} ${vol}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      Event: this.event_id,
      Sport: this.sport,
      League: this.league || "—",
      Home: this.home_team || "—",
      Away: this.away_team || "—",
      Score: this.score_home !== undefined ? `${this.score_home}-${this.score_away}` : "—",
      Period: this.period || "—",
      Time: this.time_remaining || "—",
      Status: this.status,
      Start: this.start_time?.slice(0, 16) || "—",
      Venue: this.venue || "—",
      Broadcast: this.broadcast || "—",
      Markets: this.market_count ?? (this.markets?.length ?? "—"),
      Volume: this.volume ? `$${this.volume}` : "—",
      Handle: this.handle ? `$${this.handle}` : "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 19. MARKET
// ═══════════════════════════════════════════════════════════════════════════════
export class Market {
  market_id!: string;
  event_id!: string;
  type!: "MONEYLINE" | "SPREAD" | "TOTAL" | "PROP" | "FUTURE" | "PARLAY" | "TEASER";
  subtype?: string;
  selection?: string;
  selection_id?: string;
  line?: number;
  spread?: number;
  total?: number;
  over_under?: "OVER" | "UNDER";
  odds?: number;
  odds_decimal?: number;
  odds_american?: string;
  probability?: number;
  volume?: number;
  handle?: number;
  liability?: number;
  max_bet?: number;
  min_bet?: number;
  last_updated?: string;
  is_live?: boolean;
  is_suspended?: boolean;
  is_closed?: boolean;

  constructor(data: Partial<Market>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const susp = this.is_suspended ? c($.bgRedWhite, " SUSPENDED ", colors) : "";
    const live = this.is_live ? c($.bgRedWhite, " LIVE ", colors) : "";
    const odds = this.odds ? c($.green, `${this.odds > 0 ? "+" : ""}${this.odds}`, colors) :
                 this.odds_decimal ? c($.green, `${this.odds_decimal.toFixed(2)}`, colors) : "";
    return `${live} ${susp} ${c($.cyan, this.type, colors)} ${this.selection || ""} ${this.line !== undefined ? `@ ${this.line}` : ""} ${this.spread !== undefined ? `(${this.spread > 0 ? "+" : ""}${this.spread})` : ""} ${odds} ${this.volume ? c($.dim, `vol=$${this.volume}`, colors) : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      Market: this.market_id,
      Type: this.type,
      Subtype: this.subtype || "—",
      Selection: this.selection || "—",
      "Sel ID": this.selection_id || "—",
      Line: this.line ?? "—",
      Spread: this.spread ?? "—",
      Total: this.total ?? "—",
      "O/U": this.over_under || "—",
      Odds: this.odds ? `${this.odds > 0 ? "+" : ""}${this.odds}` : this.odds_decimal?.toFixed(2) ?? "—",
      American: this.odds_american || "—",
      Prob: this.probability ? `${(this.probability * 100).toFixed(1)}%` : "—",
      Volume: this.volume ? `$${this.volume}` : "—",
      Handle: this.handle ? `$${this.handle}` : "—",
      Liability: this.liability ? `$${this.liability}` : "—",
      "Max Bet": this.max_bet ? `$${this.max_bet}` : "—",
      "Min Bet": this.min_bet ? `$${this.min_bet}` : "—",
      Live: this.is_live ? "●" : "—",
      Suspended: this.is_suspended ? "✓" : "—",
      Closed: this.is_closed ? "✓" : "—",
      Updated: this.last_updated?.slice(11, 16) || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 20. HEALTH STATUS
// ═══════════════════════════════════════════════════════════════════════════════
export class HealthStatus {
  service!: string;
  status!: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";
  latency_ms!: number;
  last_check!: string;
  error?: string;
  version?: string;
  uptime_seconds?: number;
  request_count_1m?: number;
  error_rate_1m?: number;
  cpu_percent?: number;
  memory_mb?: number;
  connections?: number;
  queue_depth?: number;

  constructor(data: Partial<HealthStatus>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const badge = this.status === "HEALTHY" ? c($.bgGreenBlack, " HEALTHY ", colors) :
                  this.status === "DEGRADED" ? c($.bgYellowBlack, " DEGRADED ", colors) :
                  this.status === "DOWN" ? c($.bgRedWhite, " DOWN ", colors) :
                  c($.dim, " UNKNOWN ", colors);
    const lat = c(this.latency_ms > 1000 ? $.red : this.latency_ms > 200 ? $.yellow : $.green, `${this.latency_ms}ms`, colors);
    const q = this.queue_depth ? c(this.queue_depth > 100 ? $.red : $.yellow, `Q:${this.queue_depth}`, colors) : "";
    return `${badge} ${c($.bold, this.service, colors)} ${lat} ${q} ${this.uptime_seconds ? c($.dim, `up=${(this.uptime_seconds / 60).toFixed(0)}m`, colors) : ""} ${this.error ? c($.red, this.error.slice(0, 30), colors) : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      Service: this.service,
      Status: this.status,
      Latency: `${this.latency_ms}ms`,
      Version: this.version || "—",
      Uptime: this.uptime_seconds ? `${(this.uptime_seconds / 60).toFixed(0)}m` : "—",
      "Req/min": this.request_count_1m ?? "—",
      "Err Rate": this.error_rate_1m ? `${(this.error_rate_1m * 100).toFixed(1)}%` : "—",
      "CPU %": this.cpu_percent ? `${this.cpu_percent.toFixed(1)}%` : "—",
      "Memory": this.memory_mb ? `${this.memory_mb}MB` : "—",
      Conns: this.connections ?? "—",
      "Queue": this.queue_depth ?? "—",
      Error: this.error || "—",
      Checked: this.last_check.slice(11, 19),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 21. WEBHOOK ALERT
// ═══════════════════════════════════════════════════════════════════════════════
export class WebhookAlert {
  id!: string;
  channel!: "telegram" | "discord" | "sms" | "email" | "slack" | "pagerduty";
  event_type?: string;
  payload!: Record<string, unknown>;
  payload_size?: number;
  status!: "queued" | "sent" | "failed" | "retrying" | "cancelled";
  attempts!: number;
  max_attempts!: number;
  next_retry?: string;
  last_error?: string;
  error_code?: string;
  response_status?: number;
  response_body?: string;
  created_at!: string;
  sent_at?: string;
  delivered_at?: string;
  acknowledged_at?: string;

  constructor(data: Partial<WebhookAlert>) {
    Object.assign(this, data);
    this.id = data.id || randomUUIDv7("base64url");
    this.created_at = data.created_at || new Date().toISOString();
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const statusColor = this.status === "sent" ? $.green :
                        this.status === "failed" ? $.red :
                        this.status === "retrying" ? $.yellow : $.orange;
    const attemptStr = `${this.attempts}/${this.max_attempts}`;
    const retry = this.next_retry ? c($.dim, `retry@${this.next_retry.slice(11, 16)}`, colors) : "";
    const size = this.payload_size ? c($.dim, `${(this.payload_size / 1024).toFixed(1)}KB`, colors) : "";
    return `${c(statusColor, `[${this.status.toUpperCase()}]`, colors)} ${c($.cyan, this.channel, colors)} ${c($.bold, attemptStr, colors)} ${size} ${retry} ${this.last_error ? c($.red, this.last_error.slice(0, 30), colors) : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id.slice(0, 8),
      Channel: this.channel,
      Event: this.event_type || "—",
      Status: this.status,
      Attempts: `${this.attempts}/${this.max_attempts}`,
      "Next Retry": this.next_retry?.slice(11, 16) || "—",
      "Error Code": this.error_code || "—",
      "Last Error": this.last_error?.slice(0, 20) || "—",
      "HTTP": this.response_status ?? "—",
      "Payload": this.payload_size ? `${(this.payload_size / 1024).toFixed(1)}KB` : "—",
      Created: this.created_at.slice(11, 16),
      Sent: this.sent_at?.slice(11, 16) || "—",
      Delivered: this.delivered_at?.slice(11, 16) || "—",
      Acked: this.acknowledged_at?.slice(11, 16) || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 22. ARCHETYPE RESULT
// ═══════════════════════════════════════════════════════════════════════════════
export class ArchetypeResult {
  customer_id!: string;
  archetype!: string;
  archetype_group?: string;
  dimensions!: {
    volume: string;
    stake: string;
    win_rate: string;
    recency: string;
    diversity: string;
    consistency: string;
  };
  confidence!: number;
  wager_count!: number;
  days_active!: number;
  avg_daily_wagers?: number;
  peak_day_wagers?: number;
  favorite_sport?: string;
  favorite_market?: string;
  deposit_pattern?: string;
  withdrawal_pattern?: string;
  session_length_avg?: number;
  calculatedAt?: string;

  constructor(data: Partial<ArchetypeResult>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const dims = Object.entries(this.dimensions)
      .map(([k, v]) => c($.dim, `${k.slice(0, 3)}:${v}`, colors))
      .join(" ");
    const group = this.archetype_group ? c($.dim, `[${this.archetype_group}]`, colors) : "";
    return `${c($.gold, "Archetype", colors)} ${group} ${c($.bold, this.archetype, colors)} ${c($.cyan, `${(this.confidence * 100).toFixed(0)}%`, colors)} ${this.wager_count}wagers ${this.days_active}days ${dims}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      Player: this.customer_id,
      Archetype: this.archetype,
      Group: this.archetype_group || "—",
      Confidence: `${(this.confidence * 100).toFixed(0)}%`,
      Wagers: this.wager_count,
      "Days Active": this.days_active,
      "Avg Daily": this.avg_daily_wagers?.toFixed(1) ?? "—",
      "Peak Day": this.peak_day_wagers ?? "—",
      Volume: this.dimensions.volume,
      Stake: this.dimensions.stake,
      "Win Rate": this.dimensions.win_rate,
      Recency: this.dimensions.recency,
      Diversity: this.dimensions.diversity,
      Consistency: this.dimensions.consistency,
      "Fav Sport": this.favorite_sport || "—",
      "Fav Market": this.favorite_market || "—",
      "Deposit Pat": this.deposit_pattern || "—",
      "Withdraw Pat": this.withdrawal_pattern || "—",
      "Session Min": this.session_length_avg ? `${this.session_length_avg.toFixed(0)}m` : "—",
      Calculated: this.calculatedAt?.slice(0, 16) || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 23. PLAYER NOTE
// ═══════════════════════════════════════════════════════════════════════════════
export class PlayerNote {
  id!: string;
  customer_id!: string;
  agent_id!: string;
  agent_name?: string;
  note!: string;
  category?: "BEHAVIOR" | "RISK" | "VIP" | "COMPLAINT" | "GENERAL" | "FRAUD" | "ARBITRAGE";
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  is_private?: boolean;
  tags?: string[];
  created_at!: string;
  updated_at?: string;

  constructor(data: Partial<PlayerNote>) {
    Object.assign(this, data);
    this.id = data.id || randomUUIDv7("base64url");
    this.created_at = data.created_at || new Date().toISOString();
  }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const catColor = this.category === "RISK" || this.category === "FRAUD" ? $.red :
                     this.category === "VIP" ? $.gold :
                     this.category === "COMPLAINT" ? $.yellow :
                     this.category === "ARBITRAGE" ? $.orange : $.dim;
    const priv = this.is_private ? c($.red, "🔒", colors) : "";
    const note = colors && this.note.length > 50
      ? Bun.wrapAnsi(this.note, 50, { wordWrap: true, trim: true })
      : this.note.slice(0, 50);
    const tags = this.tags?.length ? c($.dim, `[${this.tags.join(",")}]`, colors) : "";
    return `${priv} ${c(catColor, `[${this.category}]`, colors)} ${c($.bold, this.customer_id, colors)} ${c($.dim, `by ${this.agent_name || this.agent_id}`, colors)} ${note} ${tags}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id.slice(0, 8),
      Player: this.customer_id,
      Category: this.category || "—",
      Priority: this.priority || "—",
      Note: this.note.slice(0, 40),
      By: this.agent_name || this.agent_id,
      Private: this.is_private ? "🔒" : "",
      Tags: this.tags?.join(", ") || "—",
      Time: this.created_at.slice(11, 16),
      Updated: this.updated_at?.slice(11, 16) || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 24. PLUGIN CRON REGISTRY
// ═══════════════════════════════════════════════════════════════════════════════
export class PluginCronJob {
  id!: number;
  plugin_name!: string;
  schedule!: string;
  script_path!: string;
  last_run?: string;
  next_run?: string;
  is_active!: boolean;
  stagger_ms?: number;
  run_count?: number;
  avg_duration_ms?: number;
  last_error?: string;

  constructor(data: Partial<PluginCronJob>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const status = this.is_active ? c($.green, "●", colors) : c($.dim, "○", colors);
    const next = this.next_run ? c($.dim, `next@${this.next_run.slice(11, 16)}`, colors) : "";
    const runs = this.run_count ? c($.dim, `${this.run_count}runs`, colors) : "";
    const err = this.last_error ? c($.red, "ERR", colors) : "";
    return `${status} ${c($.bold, this.plugin_name, colors)} ${c($.cyan, this.schedule, colors)} ${this.script_path.split("/").pop()} ${runs} ${next} ${err}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id,
      Plugin: this.plugin_name,
      Schedule: this.schedule,
      Script: this.script_path.split("/").pop() || this.script_path,
      Active: this.is_active ? "●" : "○",
      "Last Run": this.last_run?.slice(0, 16) || "—",
      "Next Run": this.next_run?.slice(0, 16) || "—",
      Stagger: this.stagger_ms ? `${this.stagger_ms}ms` : "—",
      Runs: this.run_count ?? "—",
      "Avg Dur": this.avg_duration_ms ? `${this.avg_duration_ms.toFixed(0)}ms` : "—",
      Error: this.last_error?.slice(0, 20) || "—",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 25. REQUEST LOG — Proxy telemetry
// ═══════════════════════════════════════════════════════════════════════════════
export class RequestLog {
  id!: number;
  endpoint!: string;
  method?: string;
  status!: number;
  duration_ms!: number;
  duration_ns?: number;
  error?: string;
  source?: string;
  agent_id?: string;
  customer_id?: string;
  trace_id?: string;
  request_size?: number;
  response_size?: number;
  created_at!: string;

  constructor(data: Partial<RequestLog>) { Object.assign(this, data); }

  [Bun.inspect.custom](depth: number, opts: InspectCtx, inspect: InspectFn): string {
    const colors = opts.colors ?? false;
    const statusColor = this.status >= 500 ? $.red : this.status >= 400 ? $.yellow : this.status >= 200 ? $.green : $.dim;
    const durColor = this.duration_ms > 1000 ? $.red : this.duration_ms > 200 ? $.yellow : $.green;
    const src = this.source ? c($.dim, `[${this.source}]`, colors) : "";
    return `${c(statusColor, `${this.status}`, colors)} ${this.method || "GET"} ${c($.bold, this.endpoint, colors)} ${c(durColor, `${this.duration_ms}ms`, colors)} ${src} ${this.error ? c($.red, this.error.slice(0, 30), colors) : ""}`;
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.id,
      Method: this.method || "GET",
      Endpoint: this.endpoint,
      Status: this.status,
      Duration: `${this.duration_ms}ms`,
      "Dur (ns)": this.duration_ns ? `${(this.duration_ns / 1_000_000).toFixed(3)}ms` : "—",
      Source: this.source || "—",
      Agent: this.agent_id || "—",
      Customer: this.customer_id || "—",
      Trace: this.trace_id?.slice(0, 8) || "—",
      "Req Size": this.request_size ? `${(this.request_size / 1024).toFixed(1)}KB` : "—",
      "Res Size": this.response_size ? `${(this.response_size / 1024).toFixed(1)}KB` : "—",
      Error: this.error?.slice(0, 20) || "—",
      Time: this.created_at.slice(11, 19),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

interface TableRenderable {
  toTableRow(): Record<string, unknown>;
}

export function renderTable<T extends TableRenderable>(
  items: T[],
  columns?: string[],
  options?: { colors?: boolean; title?: string; maxWidth?: number }
): string {
  const rows = items.map(i => i.toTableRow());
  let output = "";
  if (options?.title) {
    const titleStr = options.colors ? `${$.bold}${$.orange}${options.title}${$.reset}` : options.title;
    const pad = "═".repeat(Math.min(Bun.stringWidth(options.title) + 6, options?.maxWidth || 80));
    output += `${pad}\n  ${titleStr}\n${pad}\n`;
  }
  output += Bun.inspect.table(rows, columns, { colors: options?.colors ?? false });
  return output;
}

export function renderCompact<T extends { [Bun.inspect.custom]: any }>(
  items: T[],
  options?: { colors?: boolean; maxItems?: number }
): string {
  const colors = options?.colors ?? false;
  const max = options?.maxItems ?? 5;
  const shown = items.slice(0, max);
  const remaining = items.length - max;
  let output = shown.map(item => "  " + item[Bun.inspect.custom](0, { colors }, () => "")).join("\n");
  if (remaining > 0) output += `\n${c($.dim, `  ... and ${remaining} more`, colors)}`;
  return output;
}

export function renderCards<T extends { [Bun.inspect.custom]: any }>(
  items: T[],
  options?: { colors?: boolean; perRow?: number }
): string {
  const colors = options?.colors ?? false;
  const perRow = options?.perRow ?? 2;
  let output = "";
  for (let i = 0; i < items.length; i += perRow) {
    const row = items.slice(i, i + perRow);
    output += row.map(item => item[Bun.inspect.custom](0, { colors }, () => "")).join("  |  ") + "\n";
  }
  return output;
}

export function renderSummaryStats(stats: Record<string, number | string>, colors = true): string {
  const entries = Object.entries(stats);
  const maxKey = Math.max(...entries.map(([k]) => Bun.stringWidth(k)));
  return entries.map(([k, v]) => {
    const key = c($.cyan, k.padEnd(maxKey + 2), colors);
    const val = c($.bold, String(v), colors);
    return `  ${key} ${val}`;
  }).join("\n");
}

export function renderSection(title: string, colors = true): string {
  const t = colors ? `${$.bold}${$.orange}${title}${$.reset}` : title;
  const line = "═".repeat(Math.min(Bun.stringWidth(title) + 8, 80));
  return `${line}\n  ${t}\n${line}`;
}
