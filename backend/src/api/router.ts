/**
 * API Router
 * Iterates route modules in priority order and returns the first match.
 * Falls through to 404 if no route matches.
 */
import { corsHeaders } from './helpers';
import { RateLimiter } from './rateLimiter';
import { registerHealthRoutes } from './routes/health';
import { registerWagerRoutes } from './routes/wagers';
import { registerAgentRoutes } from './routes/agents';
import { registerPlayerRoutes } from './routes/players';
import { registerRiskRoutes } from './routes/risk';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerOddsRoutes } from './routes/odds';
import { registerBuckeyeRoutes } from './routes/buckeye';
import { registerStaticRoutes } from './routes/static';
import type { BuckeyeScraperManager } from '../scrapers/ScraperManager';
import type { OddsPoller } from '../odds/OddsPoller';
import type { BunSecretVault } from '../services/BunSecretVault';

export interface RouterDeps {
  scraperManager: BuckeyeScraperManager;
  oddsPoller: OddsPoller;
  secretVault?: BunSecretVault;
}

/**
 * Route a request through all registered route modules.
 * Returns a Response or null if no route matched.
 */
export async function routeRequest(
  url: URL,
  request: Request,
  deps: RouterDeps,
  rateLimiter?: RateLimiter
): Promise<Response | null> {
  const { scraperManager, oddsPoller, secretVault } = deps;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Rate limiting
  if (rateLimiter) {
    const ip = RateLimiter.getClientIp(request);
    const limitResult = rateLimiter.check(ip);
    if (!limitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            'Retry-After': String(limitResult.retryAfter),
          },
        }
      );
    }
  }

  // Route groups in priority order (most specific first)
  const routeHandlers: Array<() => Promise<Response | null>> = [
    // Health / metrics (no auth needed)
    () => Promise.resolve(registerHealthRoutes(url, request, scraperManager)),

    // API routes
    () => Promise.resolve(registerWagerRoutes(url, request, scraperManager)),
    () => Promise.resolve(registerAgentRoutes(url, request, scraperManager)),
    () => Promise.resolve(registerPlayerRoutes(url, request, scraperManager)),
    () => Promise.resolve(registerRiskRoutes(url, request, scraperManager)),
    () => Promise.resolve(registerWebhookRoutes(url, request, scraperManager)),
    () => Promise.resolve(registerOddsRoutes(url, request, oddsPoller)),
    () => Promise.resolve(registerBuckeyeRoutes(url, request, scraperManager, secretVault)),

    // Static files (last resort)
    () => registerStaticRoutes(url),
  ];

  for (const handler of routeHandlers) {
    const result = await handler();
    if (result !== null) {
      return result;
    }
  }

  return null;
}
