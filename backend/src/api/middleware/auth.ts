/**
 * Authentication middleware for HTTP API routes.
 *
 * Policy (lenient mode):
 *   - Public (no auth): /health, /metrics, /api/health/*, /api/connect,
 *     /api/agents, /api/players/search, /api/stats, static frontend assets,
 *     and read-only archive/dashboard data routes
 *   - Protected: all other /api/* routes
 *
 * Dev bypass: NODE_ENV=development skips verification (existing behaviour).
 */
import { verifyToken, isDevMode } from '../../auth/jwt';
import { getEnv } from '../../config/env';
import { corsHeaders } from '../helpers';

const PUBLIC_PATHS = new Set([
  '/health',
  '/metrics',
  '/api/health/system-status',
  '/api/connect',
  '/api/agents',
  '/api/agents/downline',
  '/api/agents/hierarchy/tree',
  '/api/players/search',
  '/api/cross-reference',
  '/api/v1/agents/hierarchy',
  '/api/v1/cross-reference',
  '/api/patterns/catalog',
  '/api/patterns/history',
  '/api/patterns/summary',
  '/api/patterns/agents',
  '/api/stats',
]);

const PUBLIC_PREFIXES = [
  '/api/health/',
];

const PUBLIC_READ_PATHS = new Set([
  '/api/wagers',
  '/api/wagers/live',
  '/api/wagers/alerts',
  '/api/performance/status',
  '/api/performance/summary',
]);

const PUBLIC_READ_PREFIXES = [
  '/api/players/',
  '/api/performance/details',
];

function isPublicPath(pathname: string, method = 'GET'): boolean {
  if (pathname.startsWith('/api/v1/')) {
    const normalizedPath = pathname === '/api/v1/agents/hierarchy'
      ? '/api/agents/hierarchy/tree'
      : pathname.replace(/^\/api\/v1/, '/api');
    return isPublicPath(normalizedPath, method);
  }
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    if (PUBLIC_READ_PATHS.has(pathname)) return true;
    return PUBLIC_READ_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  }
  return false;
}

export interface AuthContext {
  agentId: string;
  token: string;
}

/**
 * Verify the Authorization header and return the auth context.
 * Returns null if the route is public or dev mode is active.
 * Returns a 401 Response if the token is missing or invalid.
 */
export async function requireAuth(
  request: Request,
  pathname: string
): Promise<AuthContext | Response | null> {
  if (isDevMode()) return null;
  if (!pathname.startsWith('/api/')) return null;
  if (isPublicPath(pathname, request.method)) return null;

  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized — Bearer token required' }),
      { status: 401, headers: corsHeaders }
    );
  }

  const token = match[1];
  const env = getEnv();

  try {
    const payload = await verifyToken(token, env.JWT_SECRET);
    return { agentId: payload.agentId, token };
  } catch {
    return new Response(
      JSON.stringify({ error: 'Unauthorized — invalid or expired token' }),
      { status: 401, headers: corsHeaders }
    );
  }
}
