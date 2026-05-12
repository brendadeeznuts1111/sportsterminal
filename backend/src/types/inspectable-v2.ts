import { inspect } from 'bun';

export interface InspectOptions {
  colors?: boolean;
  depth?: number;
  breakLength?: number;
  compact?: boolean | number;
  sorted?: boolean;
  showHidden?: boolean;
  maxArrayLength?: number;
}

export type InspectFn = (value: unknown, options?: InspectOptions) => string;

export interface TableRenderable {
  toTableRow(): Record<string, unknown>;
}

const customInspect = inspect.custom;
const emptyCell = '-';

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  orange: '\x1b[38;5;208m',
  bgRed: '\x1b[41m\x1b[37m',
  bgYellow: '\x1b[43m\x1b[30m',
  bgGreen: '\x1b[42m\x1b[30m',
} as const;

function color(code: string, text: string, enabled: boolean): string {
  return enabled ? `${code}${text}${ansi.reset}` : text;
}

function riskColor(tier: string | undefined, enabled: boolean): string {
  if (!tier) return '';
  const map: Record<string, string> = {
    BLACK: ansi.red,
    RED: ansi.yellow,
    YELLOW: ansi.orange,
    GREEN: ansi.green,
    BLUE: ansi.blue,
  };
  return color(map[tier] || ansi.dim, `[${tier}]`, enabled);
}

function money(value: number | undefined, digits: number = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(digits)}` : emptyCell;
}

function pct(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : emptyCell;
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

export class Wager implements TableRenderable {
  WagerNumber!: string;
  AgentID!: string;
  CustomerID!: string;
  AmountWagered!: number;
  Sport!: string;
  Line?: string;
  Odds?: number;
  RiskScore?: number;
  Archetype?: string;
  RiskTier?: string;
  WinRate?: number;
  Velocity?: number;

  constructor(data: Partial<Wager>) {
    Object.assign(this, data);
  }

  [customInspect](_depth: number, options: InspectOptions, _inspectValue: InspectFn): string {
    const useColors = options.colors ?? false;
    const tierBadge = riskColor(this.RiskTier, useColors);
    const archetype = this.Archetype ? color(ansi.dim, `(${this.Archetype})`, useColors) : '';
    const winRate = this.WinRate !== undefined
      ? color(this.WinRate > 0.6 ? ansi.green : ansi.yellow, pct(this.WinRate), useColors)
      : '';

    return [
      `Wager#${this.WagerNumber}`,
      tierBadge,
      archetype,
      `@${money(this.AmountWagered)}`,
      this.Sport,
      `via ${this.AgentID}`,
      winRate,
    ].filter(Boolean).join(' ');
  }

  toTableRow(): Record<string, unknown> {
    return {
      'Wager #': this.WagerNumber,
      Agent: this.AgentID,
      Customer: this.CustomerID,
      Amount: money(this.AmountWagered),
      Sport: this.Sport,
      Tier: this.RiskTier || emptyCell,
      Archetype: this.Archetype || emptyCell,
      'Win %': pct(this.WinRate),
    };
  }
}

export class Agent implements TableRenderable {
  agent_id!: string;
  login!: string;
  level!: number;
  hub_id?: string;
  risk_score?: number;
  commission_tier?: string;
  agent_type?: string;
  children_count?: number;

  constructor(data: Partial<Agent>) {
    Object.assign(this, data);
  }

  [customInspect](_depth: number, options: InspectOptions, _inspectValue: InspectFn): string {
    const useColors = options.colors ?? false;
    const risk = this.risk_score !== undefined
      ? color(
        this.risk_score > 0.75 ? ansi.red : this.risk_score > 0.5 ? ansi.yellow : ansi.green,
        `risk=${this.risk_score.toFixed(2)}`,
        useColors
      )
      : '';
    const hub = this.hub_id ? color(ansi.cyan, `@${this.hub_id}`, useColors) : '';
    const children = this.children_count ? color(ansi.dim, `+${this.children_count} downline`, useColors) : '';

    return [
      color(ansi.orange, 'Agent', useColors),
      color(ansi.bold, this.login, useColors),
      `L${this.level}`,
      color(ansi.dim, `[${this.agent_id}]`, useColors),
      risk,
      hub,
      children,
    ].filter(Boolean).join(' ');
  }

  toTableRow(): Record<string, unknown> {
    return {
      Login: this.login,
      Level: this.level,
      Hub: this.hub_id || emptyCell,
      'Risk Score': this.risk_score?.toFixed(2) || emptyCell,
      Tier: this.commission_tier || emptyCell,
      Type: this.agent_type || emptyCell,
      Downline: this.children_count || 0,
    };
  }
}

export class RiskScore implements TableRenderable {
  wagerNumber!: string;
  playerId!: string;
  compositeScore!: number;
  sharpScore!: number;
  velocityScore!: number;
  ipRiskScore!: number;
  syndicateScore!: number;
  flags: string[];
  traceId: string;
  reasoning?: string[];

  constructor(data: Partial<RiskScore>) {
    Object.assign(this, data);
    this.traceId = data.traceId || Bun.randomUUIDv7('base64url');
    this.flags = data.flags || [];
  }

  [customInspect](_depth: number, options: InspectOptions, _inspectValue: InspectFn): string {
    const useColors = options.colors ?? false;
    const score = clampScore(this.compositeScore);
    const scoreColor = score > 0.75 ? ansi.red : score > 0.5 ? ansi.yellow : ansi.green;
    const flags = this.flags.length > 0
      ? color(ansi.dim, `flags=[${this.flags.join(', ')}]`, useColors)
      : '';
    const trace = color(ansi.dim, `trace=${this.traceId.slice(0, 8)}`, useColors);

    return [
      `RiskScore${color(scoreColor, `(${score.toFixed(2)})`, useColors)}`,
      `wager=${this.wagerNumber}`,
      `player=${this.playerId}`,
      flags,
      trace,
    ].filter(Boolean).join(' ');
  }

  inspectDetailed(options: InspectOptions = {}): string {
    const useColors = options.colors ?? false;
    const rows = [
      { Metric: 'Composite', Score: this.compositeScore.toFixed(2), Bar: scoreBar(this.compositeScore, 20, useColors) },
      { Metric: 'Sharp', Score: this.sharpScore.toFixed(2), Bar: scoreBar(this.sharpScore, 20, useColors) },
      { Metric: 'Velocity', Score: this.velocityScore.toFixed(2), Bar: scoreBar(this.velocityScore, 20, useColors) },
      { Metric: 'IP Risk', Score: this.ipRiskScore.toFixed(2), Bar: scoreBar(this.ipRiskScore, 20, useColors) },
      { Metric: 'Syndicate', Score: this.syndicateScore.toFixed(2), Bar: scoreBar(this.syndicateScore, 20, useColors) },
    ];
    return inspect.table(rows, ['Metric', 'Score', 'Bar'], { colors: useColors });
  }

  toTableRow(): Record<string, unknown> {
    return {
      Wager: this.wagerNumber,
      Player: this.playerId,
      Composite: this.compositeScore.toFixed(2),
      Sharp: this.sharpScore.toFixed(2),
      Velocity: this.velocityScore.toFixed(2),
      Flags: this.flags.join(', ') || emptyCell,
      Trace: this.traceId.slice(0, 8),
    };
  }
}

export class Position implements TableRenderable {
  positionId!: string;
  playerId!: string;
  sport!: string;
  market!: string;
  side!: 'back' | 'lay';
  stake!: number;
  odds!: number;
  exposure!: number;
  pnl!: number;
  status!: 'OPEN' | 'HEDGED' | 'CLOSED';
  openedAt?: string;

  constructor(data: Partial<Position>) {
    Object.assign(this, data);
  }

  [customInspect](_depth: number, options: InspectOptions, _inspectValue: InspectFn): string {
    const useColors = options.colors ?? false;
    const pnlColor = this.pnl > 0 ? ansi.green : this.pnl < 0 ? ansi.red : ansi.dim;
    const sideColor = this.side === 'back' ? ansi.magenta : ansi.cyan;
    const statusBadge = this.status === 'OPEN'
      ? color(ansi.green, '[OPEN]', useColors)
      : this.status === 'HEDGED'
        ? color(ansi.yellow, '[HEDGED]', useColors)
        : color(ansi.dim, '[CLOSED]', useColors);

    return [
      `Pos#${this.positionId}`,
      color(sideColor, this.side.toUpperCase(), useColors),
      `${this.sport}/${this.market}`,
      `${money(this.stake)}@${this.odds}`,
      color(pnlColor, `P&L=${money(this.pnl)}`, useColors),
      statusBadge,
    ].join(' ');
  }

  toTableRow(): Record<string, unknown> {
    return {
      ID: this.positionId,
      Sport: this.sport,
      Market: this.market,
      Side: this.side,
      Stake: money(this.stake),
      Odds: this.odds,
      Exposure: money(this.exposure),
      'P&L': money(this.pnl),
      Status: this.status,
    };
  }
}

export class RiskAlert implements TableRenderable {
  id: string;
  type!: 'SHARP' | 'VELOCITY' | 'SYNDICATE' | 'IP' | 'RULE';
  severity!: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  playerId!: string;
  wagerNumber?: string;
  message!: string;
  timestamp: string;
  traceId!: string;
  suggestedAction?: string;

  constructor(data: Partial<RiskAlert>) {
    Object.assign(this, data);
    this.id = data.id || Bun.randomUUIDv7('base64url');
    this.timestamp = data.timestamp || new Date().toISOString();
    this.traceId = data.traceId || Bun.randomUUIDv7('base64url');
  }

  [customInspect](_depth: number, options: InspectOptions, _inspectValue: InspectFn): string {
    const useColors = options.colors ?? false;
    const severityColors: Record<string, string> = {
      CRITICAL: ansi.bgRed,
      HIGH: ansi.red,
      MEDIUM: ansi.yellow,
      LOW: ansi.green,
    };
    const severityBadge = color(severityColors[this.severity] || ansi.dim, ` ${this.severity} `, useColors);
    const typeBadge = color(ansi.dim, `[${this.type}]`, useColors);
    const action = this.suggestedAction ? color(ansi.cyan, `-> ${this.suggestedAction}`, useColors) : '';
    const message = this.message.length > 60
      ? Bun.wrapAnsi(this.message, 60, { wordWrap: true, trim: true })
      : this.message;

    return [
      severityBadge,
      typeBadge,
      message,
      `player=${color(ansi.bold, this.playerId, useColors)}`,
      `trace=${this.traceId.slice(0, 8)}`,
      action,
    ].filter(Boolean).join(' ');
  }

  toTableRow(): Record<string, unknown> {
    return {
      Severity: this.severity,
      Type: this.type,
      Player: this.playerId,
      Wager: this.wagerNumber || emptyCell,
      Message: this.message.slice(0, 50),
      Action: this.suggestedAction || emptyCell,
      Time: this.timestamp.slice(11, 19),
    };
  }
}

export class HubSummary implements TableRenderable {
  hub_id!: string;
  name!: string;
  agent_count!: number;
  total_handle_7d!: number;
  total_pnl_7d!: number;
  flagged_children!: number;
  avg_risk_score!: number;
  top_agent?: string;

  constructor(data: Partial<HubSummary>) {
    Object.assign(this, data);
  }

  [customInspect](_depth: number, options: InspectOptions, _inspectValue: InspectFn): string {
    const useColors = options.colors ?? false;
    const risk = this.avg_risk_score > 0.5 ? ansi.yellow : ansi.green;
    const pnl = this.total_pnl_7d > 0 ? ansi.green : this.total_pnl_7d < 0 ? ansi.red : ansi.dim;
    const flags = this.flagged_children > 0
      ? color(ansi.red, `${this.flagged_children} flagged`, useColors)
      : '';

    return [
      color(ansi.orange, 'Hub', useColors),
      color(ansi.bold, this.name, useColors),
      color(ansi.dim, `[${this.hub_id}]`, useColors),
      `${this.agent_count} agents`,
      color(risk, `risk=${this.avg_risk_score.toFixed(2)}`, useColors),
      color(pnl, `P&L=${money(this.total_pnl_7d, 0)}`, useColors),
      flags,
    ].filter(Boolean).join(' ');
  }

  toTableRow(): Record<string, unknown> {
    return {
      Hub: this.name,
      ID: this.hub_id,
      Agents: this.agent_count,
      '7d Handle': money(this.total_handle_7d, 0),
      '7d P&L': money(this.total_pnl_7d, 0),
      'Risk Avg': this.avg_risk_score.toFixed(2),
      Flags: this.flagged_children,
    };
  }
}

export function scoreBar(score: number, width: number, useColors: boolean): string {
  const normalized = clampScore(score);
  const filled = Math.round(width * normalized);
  const empty = width - filled;
  const barColor = normalized > 0.75 ? ansi.red : normalized > 0.5 ? ansi.yellow : ansi.green;
  const full = '#'.repeat(filled);
  const rest = '-'.repeat(empty);
  return useColors ? `${barColor}${full}${ansi.dim}${rest}${ansi.reset}` : full + rest;
}

export function renderTable<T extends TableRenderable>(
  items: T[],
  columns?: string[],
  options?: { colors?: boolean; title?: string }
): string {
  const rows = items.map((item) => item.toTableRow());
  let output = '';

  if (options?.title) {
    const title = options.colors ? `${ansi.bold}${ansi.orange}${options.title}${ansi.reset}` : options.title;
    const titleWidth = Bun.stringWidth(options.title);
    const edge = '='.repeat(Math.max(3, Math.floor((36 - titleWidth) / 2)));
    output += `${edge} ${title} ${edge}\n`;
  }

  output += columns && columns.length > 0
    ? inspect.table(rows, columns, { colors: options?.colors ?? false })
    : inspect.table(rows, { colors: options?.colors ?? false });
  return output;
}

export function renderCompact<T extends object>(
  items: T[],
  options?: { colors?: boolean; maxItems?: number }
): string {
  const useColors = options?.colors ?? false;
  const max = options?.maxItems ?? 5;
  const shown = items.slice(0, max);
  const remaining = items.length - max;

  let output = shown
    .map((item) => {
      const maybeInspector = (item as Record<symbol, unknown>)[customInspect];
      if (typeof maybeInspector === 'function') {
        return `  ${maybeInspector.call(item, 0, { colors: useColors }, inspect as InspectFn)}`;
      }
      return `  ${inspect(item, { colors: useColors })}`;
    })
    .join('\n');

  if (remaining > 0) {
    output += `\n${color(ansi.dim, `  ... and ${remaining} more`, useColors)}`;
  }
  return output;
}
