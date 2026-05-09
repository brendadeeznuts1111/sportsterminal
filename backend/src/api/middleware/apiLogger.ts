/**
 * API Logger Middleware
 * Wraps API routes to log all Buckeye API responses into raw_api_logs table.
 */

import type { Database } from '../../database';
import { RawApiLogger } from '../../services/RawApiLogger';

export interface ApiLoggerDeps {
  db: Database;
  enabled: boolean;
}

type RouteHandler = (url: URL, request: Request) => Response | null | Promise<Response | null>;

let sharedLogger: RawApiLogger | undefined;

function getSharedLogger(deps: ApiLoggerDeps): RawApiLogger {
  if (!sharedLogger) {
    sharedLogger = new RawApiLogger(deps.db, deps.enabled);
  } else {
    sharedLogger.setEnabled(deps.enabled);
  }
  return sharedLogger;
}

/**
 * Wrap a route handler with logging middleware.
 * Logs all Buckeye API responses to raw_api_logs table.
 */
export function wrapWithApiLogging(
  handler: RouteHandler,
  deps: ApiLoggerDeps
): RouteHandler {
  const logger = getSharedLogger(deps);

  return async (url: URL, request: Request): Promise<Response | null> => {
    // Only log Buckeye API endpoints
    if (!url.pathname.startsWith('/api/buckeye/')) {
      return handler(url, request);
    }

    const startTime = Date.now();
    const agentId = extractAgentIdFromRequest(request);

    try {
      const response = await handler(url, request);

      if (response) {
        const requestParams = JSON.stringify(Object.fromEntries(url.searchParams.entries()));
        logger
          .logWithTiming(url.pathname, response, agentId, startTime, requestParams)
          .catch((err) =>
            console.error('[apiLogger] Failed to write raw API log:', err instanceof Error ? err.message : err)
          );
      }

      return response;
    } catch (error) {
      // Log errors as well
      const durationMs = Date.now() - startTime;
      const errorJson = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      logger.log({
        endpoint: url.pathname,
        responseJson: errorJson,
        agentId,
        durationMs,
        requestParams: JSON.stringify(Object.fromEntries(url.searchParams.entries())),
        statusCode: 500,
      }).catch((err) =>
        console.error('[apiLogger] Failed to write raw API error log:', err instanceof Error ? err.message : err)
      );

      throw error;
    }
  };
}

/**
 * Extract agent ID from request context.
 * Looks for JWT token in Authorization header or WebSocket protocol header.
 */
function extractAgentIdFromRequest(request: Request): string | undefined {
  // Try Authorization header
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      // Simple token parsing - in production, use proper JWT verification
      const parts = token.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(atob(parts[1]));
        return payload.agentId || payload.customerID || payload.agentID;
      }
    } catch {
      // Token parsing failed, continue
    }
  }

  // Try WebSocket protocol header
  const wsProtocol = request.headers.get('sec-websocket-protocol');
  if (wsProtocol) {
    const match = wsProtocol.match(/jwt,\s*(.+)/);
    if (match) {
      try {
        const token = match[1];
        const parts = token.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(atob(parts[1]));
          return payload.agentId || payload.customerID || payload.agentID;
        }
      } catch {
        // Token parsing failed, continue
      }
    }
  }

  return undefined;
}

/**
 * Wrap the entire router with logging middleware.
 * This is a convenience function for wrapping the main router.
 */
export function wrapRouterWithLogging(
  router: RouteHandler,
  deps: ApiLoggerDeps
): RouteHandler {
  return wrapWithApiLogging(router, deps);
}
