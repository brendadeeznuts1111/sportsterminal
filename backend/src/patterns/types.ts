import type { Severity } from '../risk/AlertEngine';

export interface ParsedWager {
  game: string;
  market: 'moneyline' | 'spread' | 'total' | 'prop' | 'parlay' | 'other';
  side: string;
  price: number | null;
  period: string;
  teams: string[];
}

export interface PatternInsert {
  id: string;
  eventId: string;
  type: string;
  category: 'odds' | 'wagers' | 'agents' | 'ip' | 'live' | 'feed';
  market: string;
  side: string;
  severity: Severity;
  score: number;
  triggerBook?: string | null;
  details: Record<string, unknown>;
  description: string;
  detectedAt: string;
}

export interface EventMatch {
  eventId: string | null;
  confidence: number;
  reason: string;
}
