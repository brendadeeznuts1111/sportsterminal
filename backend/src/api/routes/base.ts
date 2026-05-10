/**
 * Base Route Handlers
 * Generic route handler utilities to reduce code duplication across route files.
 */

import { handleAsync, corsHeaders } from '../helpers';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

/**
 * Generic route handler for simple path matching.
 * @param path - The route path (e.g., '/api/agents')
 * @param handler - The handler function
 * @param corsHeaders - CORS headers to include in response
 * @returns A route handler function
 */
export function createRouteHandler<T = BuckeyeScraperManager>(
  path: string,
  handler: (url: URL, request: Request, deps: T) => Promise<unknown>,
  headers: Record<string, string> = corsHeaders
): (url: URL, request: Request, deps: T) => Promise<Response | null> {
  return async (url: URL, request: Request, deps: T): Promise<Response | null> => {
    if (url.pathname !== path) return null;
    return handleAsync(async () => handler(url, request, deps), headers);
  };
}

/**
 * Route handler for parameter matching (e.g., '/api/agents/:agentId').
 * @param path - The route path (e.g., '/api/agents/:agentId')
 * @param paramName - The parameter name (e.g., 'agentId')
 * @param handler - The handler function
 * @param corsHeaders - CORS headers to include in response
 * @returns A route handler function
 */
export function createParamRouteHandler<T = BuckeyeScraperManager>(
  path: string,
  _paramName: string,
  handler: (url: URL, request: Request, deps: T, params: Record<string, string>) => Promise<unknown>,
  headers: Record<string, string> = corsHeaders
): (url: URL, request: Request, deps: T) => Promise<Response | null> {
  return async (url: URL, request: Request, deps: T): Promise<Response | null> => {
    const match = url.pathname.match(new RegExp(`^${path.replace(/:([^/]+)/g, '([^/]+)')}$`));
    if (!match) return null;

    const params: Record<string, string> = {};
    const paramNames = path.match(/:([^/]+)/g) || [];
    paramNames.forEach((name, i) => {
      params[name.slice(1)] = match[i + 1];
    });

    return handleAsync(async () => handler(url, request, deps, params), headers);
  };
}

/**
 * Route handler for HTTP method matching (e.g., POST '/api/agents/backfill/hierarchy').
 * @param path - The route path
 * @param method - The expected HTTP method ('GET' | 'POST' | 'PUT' | 'DELETE')
 * @param handler - The handler function
 * @param corsHeaders - CORS headers to include in response
 * @returns A route handler function
 */
export function createMethodRouteHandler<T = BuckeyeScraperManager>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  handler: (url: URL, request: Request, deps: T) => Promise<unknown>,
  headers: Record<string, string> = corsHeaders
): (url: URL, request: Request, deps: T) => Promise<Response | null> {
  return async (url: URL, request: Request, deps: T): Promise<Response | null> => {
    if (url.pathname !== path || request.method !== method) return null;
    return handleAsync(async () => handler(url, request, deps), headers);
  };
}

/**
 * Route handler for query parameter matching (e.g., '/api/odds/movements?eventId=123').
 * @param path - The route path
 * @param queryParams - Object of expected query parameters and their values
 * @param handler - The handler function
 * @param corsHeaders - CORS headers to include in response
 * @returns A route handler function
 */
export function createQueryRouteHandler<T = BuckeyeScraperManager>(
  path: string,
  queryParams: Record<string, string>,
  handler: (url: URL, request: Request, deps: T, query: URLSearchParams) => Promise<unknown>,
  headers: Record<string, string> = corsHeaders
): (url: URL, request: Request, deps: T) => Promise<Response | null> {
  return async (url: URL, request: Request, deps: T): Promise<Response | null> => {
    if (url.pathname !== path) return null;

    // Check all expected query parameters
    for (const [key, value] of Object.entries(queryParams)) {
      if (url.searchParams.get(key) !== value) return null;
    }

    return handleAsync(async () => handler(url, request, deps, url.searchParams), headers);
  };
}
