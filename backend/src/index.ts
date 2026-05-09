import { serve } from 'bun';
import { initDatabase, type Database } from './database';
import { BuckeyeScraperManager } from './scrapers/ScraperManager';
import { OddsPoller } from './odds/OddsPoller';
import { routeRequest } from './api/router';
import { corsHeaders } from './api/helpers';
import { createToken, verifyToken, isDevMode } from './auth/jwt';
import { getRateLimiter } from './api/rateLimiter';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-min-32-chars';

// Initialize database and scraper
let db: Database;
let scraperManager: BuckeyeScraperManager;
let oddsPoller: OddsPoller;

// Connected WebSocket clients
const wsClients = new Set<any>();

function broadcast(msg: object) {
  const payload = JSON.stringify(msg);
  for (const client of wsClients) {
    try {
      if (client.readyState === 1) {
        client.send(payload);
      }
    } catch {
      // Ignore dead sockets
    }
  }
}

/**
 * Extract JWT from WebSocket upgrade request.
 * Checks sec-websocket-protocol header first, then query string.
 */
function extractWsToken(request: Request): string | null {
  // Try sec-websocket-protocol header
  const proto = request.headers.get('sec-websocket-protocol');
  if (proto) {
    // The header may contain 'jwt, <token>' as a single value
    const match = proto.match(/jwt,\s*(.+)/);
    if (match) return match[1];
    // Or just the token directly
    if (proto.startsWith('eyJ')) return proto;
  }

  // Try query string
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (token) return token;

  return null;
}

async function startServer() {
  // Initialize database
  db = await initDatabase();
  console.log('✅ Database initialized');

  // Initialize scraper manager with broadcast callback
  const debugMode = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
  scraperManager = new BuckeyeScraperManager(db, broadcast, debugMode);
  console.log('✅ Scraper manager initialized');

  // Initialize odds poller
  oddsPoller = new OddsPoller(db, broadcast);
  oddsPoller.start();
  console.log('✅ Odds poller initialized');

  // Create HTTP server with WebSocket support
  const server = serve({
    port: PORT,
    hostname: HOST,
    websocket: {
      open(ws) {
        console.log('[WS] Client connected');
        ws.data = { agentId: null, isAuthenticated: false };
        wsClients.add(ws);
      },
      message(ws, message) {
        handleWebSocketMessage(ws, message, scraperManager);
      },
      close(ws) {
        console.log('[WS] Client disconnected');
        wsClients.delete(ws);
        if (ws.data?.agentId) {
          scraperManager.stopAgent(ws.data.agentId);
        }
      },
    },
    async fetch(request, server) {
      const url = new URL(request.url);

      // WebSocket upgrade with JWT enforcement
      const isWsUpgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      if (isWsUpgrade) {
        // In production, verify JWT before upgrading
        if (!isDevMode()) {
          const token = extractWsToken(request);
          if (!token) {
            return new Response(JSON.stringify({ error: 'Missing authentication token' }), {
              status: 401,
              headers: corsHeaders,
            });
          }

          try {
            const payload = await verifyToken(token, JWT_SECRET);
            // Token valid — upgrade with pre-authenticated data
            if (server.upgrade(request, {
              data: { agentId: payload.agentId, isAuthenticated: true },
            })) {
              return undefined;
            }
          } catch {
            return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
              status: 401,
              headers: corsHeaders,
            });
          }
        } else {
          // Dev mode — upgrade without auth
          if (server.upgrade(request, {
            data: { agentId: null, isAuthenticated: false },
          })) {
            return undefined;
          }
        }
      }

      // Delegate to router
      const result = await routeRequest(url, request, {
        scraperManager,
        oddsPoller,
      }, getRateLimiter());

      if (result !== null) {
        return result;
      }

      // 404
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: corsHeaders,
      });
    },
  });

  console.log(`🚀 Backend running at http://${HOST}:${PORT}`);
}

async function handleWebSocketMessage(
  ws: any,
  message: string | Buffer,
  scraperManager: BuckeyeScraperManager
) {
  try {
    const msg = JSON.parse(message.toString());

    switch (msg.type) {
      case 'auth': {
        ws.data.agentId = msg.agentId;

        // If token is provided, try to resume session first
        if (msg.token) {
          try {
            const resumed = await scraperManager.resumeAgent(msg.agentId, {
              agentId: msg.agentId,
              password: msg.password || '',
              baseUrl: process.env.BUCKEYE_BASE_URL,
              cfCookie: msg.cfCookie,
            }, msg.token);

            if (resumed) {
              ws.data.isAuthenticated = true;
              // Issue a fresh JWT
              let jwtToken = '';
              try {
                jwtToken = await createToken(msg.agentId, JWT_SECRET);
              } catch (err) {
                console.error('[WS] JWT creation error:', err);
              }
              ws.send(
                JSON.stringify({
                  type: 'auth_response',
                  success: true,
                  message: 'Session resumed',
                  token: jwtToken || msg.token,
                })
              );
              break;
            }
          } catch (err) {
            console.log('[WS] Token resume failed, falling back to password login');
          }
        }

        // Fallback to password login
        const valid = msg.password && msg.password.length > 0;
        if (!valid) {
          ws.send(
            JSON.stringify({
              type: 'auth_response',
              success: false,
              message: 'Invalid credentials',
            })
          );
          return;
        }

        ws.data.isAuthenticated = true;

        try {
          await scraperManager.startAgent(msg.agentId, {
            agentId: msg.agentId,
            password: msg.password,
            baseUrl: process.env.BUCKEYE_BASE_URL,
            cfCookie: msg.cfCookie,
          });
        } catch (err) {
          console.error('[WS] Failed to start agent polling:', err);
          ws.send(
            JSON.stringify({
              type: 'auth_response',
              success: false,
              message: err instanceof Error ? err.message : 'Login failed',
            })
          );
          return;
        }

        // Get token from the agent
        const agentInstance = scraperManager.getAgentInstance(msg.agentId);
        const buckeyeToken = agentInstance?.api.getToken() || '';

        // Issue our own JWT for future reconnections
        let jwtToken = '';
        try {
          jwtToken = await createToken(msg.agentId, JWT_SECRET);
        } catch (err) {
          console.error('[WS] JWT creation error:', err);
        }

        ws.send(
          JSON.stringify({
            type: 'auth_response',
            success: true,
            message: 'Authenticated',
            token: jwtToken || buckeyeToken,
          })
        );
        break;
      }

      case 'request_data': {
        try {
          const data = await scraperManager.getAgentData(msg.agentId);
          ws.send(
            JSON.stringify({
              type: 'data_response',
              agentId: msg.agentId,
              data,
            })
          );
        } catch (err) {
          console.error('[WS] getAgentData error:', err);
          ws.send(
            JSON.stringify({
              type: 'data_error',
              agentId: msg.agentId,
              message: err instanceof Error ? err.message : 'Failed to load agent data',
            })
          );
        }
        break;
      }

      case 'refresh': {
        try {
          await scraperManager.forceRefresh(msg.agentId);
        } catch (err) {
          console.error('[WS] Force refresh error:', err);
        }
        ws.send(
          JSON.stringify({
            type: 'refresh_initiated',
            agentId: msg.agentId,
          })
        );
        break;
      }

      default:
        console.warn('Unknown message type:', msg.type);
    }
  } catch (error) {
    console.error('WS message error:', error);
    ws.send(
      JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    );
  }
}

startServer().catch(console.error);
