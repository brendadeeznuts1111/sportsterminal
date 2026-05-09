/**
 * Shared types for the odds pipeline
 */

export interface GameEvent {
  id: string;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string; // ISO
  status: 'upcoming' | 'live' | 'finished';
}

export interface BookOdds {
  book: string;
  spreadHome: number | null;
  spreadAway: number | null;
  spreadHomePrice: number | null;
  spreadAwayPrice: number | null;
  totalOver: number | null;
  totalUnder: number | null;
  totalOverPrice: number | null;
  totalUnderPrice: number | null;
  moneylineHome: number | null;
  moneylineAway: number | null;
}

export interface EventOdds {
  event: GameEvent;
  books: BookOdds[];
}

export interface LineMovement {
  eventId: string;
  book: string;
  market: 'spread' | 'total' | 'moneyline';
  side: 'home' | 'away' | 'over' | 'under';
  oldValue: number;
  newValue: number;
  delta: number;
  recordedAt: string;
}

export interface BookHealth {
  book: string;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  lastSeen: string | null;
  errorCount: number;
  lastError: string | null;
}

export interface OddsProvider {
  name: string;
  /** Fetch current odds for all tracked events */
  fetchOdds(): Promise<EventOdds[]>;
  /** Check provider / book health */
  checkHealth(): Promise<BookHealth[]>;
}
