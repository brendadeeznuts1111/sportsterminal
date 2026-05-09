/**
 * UrlPatternRouter.ts
 * URLPattern-based routing — no framework lock-in, works across any JS runtime.
 *
 * Usage:
 *   const router = new UrlPatternRouter();
 *   router.get('/api/wagers', handler);
 *   router.get('/api/agents/:agentId/performance', handler);
 *   const match = router.match('GET', '/api/agents/foo/performance');
 *   // => { handler, params: { agentId: 'foo' } }
 */

export type RouteHandler = (
  url: URL,
  request: Request,
  params: Record<string, string | undefined>
) => Response | null | Promise<Response | null>;

interface RouteEntry {
  pattern: URLPattern;
  method: string;
  handler: RouteHandler;
}

export class UrlPatternRouter {
  private routes: RouteEntry[] = [];

  /**
   * Register a GET route.
   * Path syntax follows URLPattern: `/api/agents/:agentId/performance`
   */
  get(pathname: string, handler: RouteHandler): this {
    return this.add('GET', pathname, handler);
  }

  /**
   * Register a POST route.
   */
  post(pathname: string, handler: RouteHandler): this {
    return this.add('POST', pathname, handler);
  }

  /**
   * Register a PUT route.
   */
  put(pathname: string, handler: RouteHandler): this {
    return this.add('PUT', pathname, handler);
  }

  /**
   * Register a DELETE route.
   */
  delete(pathname: string, handler: RouteHandler): this {
    return this.add('DELETE', pathname, handler);
  }

  /**
   * Register a route for any method.
   */
  all(pathname: string, handler: RouteHandler): this {
    return this.add('*', pathname, handler);
  }

  /**
   * Match a request against registered routes.
   * Returns the handler and extracted params, or null if no match.
   */
  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string | undefined> } | null {
    for (const entry of this.routes) {
      if (entry.method !== '*' && entry.method !== method) continue;
      const result = entry.pattern.exec(pathname);
      if (result) {
        return {
          handler: entry.handler,
          params: Object.fromEntries(result.pathname.groups),
        };
      }
    }
    return null;
  }

  /**
   * Dispatch a full Request object. Returns a Response or null.
   */
  async dispatch(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const match = this.match(request.method, url.pathname);
    if (!match) return null;
    return match.handler(url, request, match.params);
  }

  private add(method: string, pathname: string, handler: RouteHandler): this {
    this.routes.push({
      pattern: new URLPattern({ pathname }),
      method,
      handler,
    });
    return this;
  }
}
