/**
 * Odds grid routes
 */
import { clampInt, handleAsync, corsHeaders } from '../helpers';
import type { OddsPoller } from '../../odds/OddsPoller';

export function registerOddsRoutes(
  url: URL,
  _request: Request,
  oddsPoller: OddsPoller
): Response | null {
  if (url.pathname === '/api/odds/events') {
    return handleAsync(async () => oddsPoller.getEvents(), corsHeaders);
  }

  if (url.pathname === '/api/odds/snapshots') {
    return handleAsync(async () => oddsPoller.getAllOdds(), corsHeaders);
  }

  const oddsEventMatch = url.pathname.match(/^\/api\/odds\/events\/([^/]+)$/);
  if (oddsEventMatch) {
    const eventId = decodeURIComponent(oddsEventMatch[1]);
    return handleAsync(async () => oddsPoller.getOddsForEvent(eventId), corsHeaders);
  }

  if (url.pathname === '/api/odds/movements') {
    const eventId = url.searchParams.get('eventId') || undefined;
    const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
    return handleAsync(async () => oddsPoller.getMovements(eventId, limit), corsHeaders);
  }

  if (url.pathname === '/api/patterns/history') {
    const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
    const sinceHours = clampInt(url.searchParams.get('sinceHours'), 24, 1, 168);
    return handleAsync(
      async () => oddsPoller.getPatternHistory({
        type: url.searchParams.get('type') || undefined,
        market: url.searchParams.get('market') || undefined,
        severity: url.searchParams.get('severity') || undefined,
        category: url.searchParams.get('category') || undefined,
        sport: url.searchParams.get('sport') || undefined,
        agent: url.searchParams.get('agent') || undefined,
        eventId: url.searchParams.get('eventId') || undefined,
        sinceHours,
        limit,
      }),
      corsHeaders
    );
  }

  if (url.pathname === '/api/patterns/summary') {
    const sinceHours = clampInt(url.searchParams.get('sinceHours'), 24, 1, 168);
    return handleAsync(async () => oddsPoller.getPatternSummary(sinceHours), corsHeaders);
  }

  if (url.pathname === '/api/books/status') {
    return handleAsync(async () => oddsPoller.getBookHealth(), corsHeaders);
  }

  if (url.pathname === '/api/books') {
    return handleAsync(async () => oddsPoller.getBooksList(), corsHeaders);
  }

  if (url.pathname === '/api/odds/live') {
    const sport = url.searchParams.get('sport') || undefined;
    const booksParam = url.searchParams.get('books') || undefined;
    const books = booksParam ? booksParam.split(',') : undefined;
    const includeBookMoves = url.searchParams.get('includeBookMoves') === '1';
    return handleAsync(async () => oddsPoller.getLiveOddsMatrix(sport, books, includeBookMoves), corsHeaders);
  }

  return null;
}
