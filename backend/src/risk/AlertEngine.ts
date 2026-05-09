/**
 * Alert Engine
 * Evaluates wager data against alert rules and generates risk notifications.
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  ruleName: string;
  severity: Severity;
  message: string;
  wagerNumber: number;
}

export interface EnrichedWager {
  WagerNumber: number;
  AgentID: string;
  CustomerID: string;
  Login: string;
  WagerType: string;
  AmountWagered: number;
  ToWinAmount: number;
  VolumeAmount: number;
  InsertDateTime: string;
  TicketWriter: string;
  ShortDesc: string;
  VIP: string;
  AgentLogin: string;
}

interface AlertRule {
  name: string;
  condition: (wager: EnrichedWager) => boolean;
  severity: Severity;
  message: (wager: EnrichedWager) => string;
}

const ALERT_RULES: AlertRule[] = [
  {
    name: 'High Volume Wager',
    condition: (w) => w.AmountWagered >= 50000,
    severity: 'critical',
    message: (w) =>
      `Agent ${w.AgentLogin}: $${w.AmountWagered.toLocaleString()} wager by ${w.Login}`,
  },
  {
    name: 'ALERT Ticket Writer',
    condition: (w) => w.TicketWriter === 'ALERT',
    severity: 'warning',
    message: (w) =>
      `ALERT wager: ${w.Login} — $${w.AmountWagered.toLocaleString()} (${w.WagerType})`,
  },
  {
    name: 'Live Large Wager',
    condition: (w) => w.TicketWriter === 'GSLIVE' && w.AmountWagered >= 10000,
    severity: 'warning',
    message: (w) =>
      `GSLIVE large: ${w.Login} — $${w.AmountWagered.toLocaleString()}`,
  },
  {
    name: 'Parlay High Payout',
    condition: (w) => w.WagerType === 'P' && w.ToWinAmount >= 100000,
    severity: 'warning',
    message: (w) =>
      `Parlay payout: ${w.Login} — win $${w.ToWinAmount.toLocaleString()}`,
  },
  {
    name: 'VIP Wager',
    condition: (w) => w.VIP !== '0' && w.VIP !== '',
    severity: 'info',
    message: (w) => `VIP wager: ${w.Login} — $${w.AmountWagered.toLocaleString()}`,
  },
  {
    name: 'Exotic Large',
    condition: (w) => w.WagerType === 'E' && w.AmountWagered >= 5000,
    severity: 'warning',
    message: (w) =>
      `Exotic large: ${w.Login} — $${w.AmountWagered.toLocaleString()}`,
  },
  {
    name: 'Teaser Large',
    condition: (w) => w.WagerType === 'T' && w.AmountWagered >= 5000,
    severity: 'warning',
    message: (w) =>
      `Teaser large: ${w.Login} — $${w.AmountWagered.toLocaleString()}`,
  },
];

/**
 * Evaluate a single wager against all alert rules.
 */
export function evaluateWager(wager: EnrichedWager): Alert[] {
  const alerts: Alert[] = [];

  for (const rule of ALERT_RULES) {
    if (rule.condition(wager)) {
      alerts.push({
        ruleName: rule.name,
        severity: rule.severity,
        message: rule.message(wager),
        wagerNumber: wager.WagerNumber,
      });
    }
  }

  return alerts;
}

/**
 * Evaluate an array of wagers and return all alerts.
 */
export function evaluateWagers(wagers: EnrichedWager[]): Alert[] {
  return wagers.flatMap((w) => evaluateWager(w));
}
