import { serve, type ServerWebSocket } from 'bun';
import { initDatabase, type Database } from './database';
import { BuckeyeScraperManager } from './scrapers/ScraperManager';
import { OddsPoller } from './odds/OddsPoller';
import { routeRequest } from './api/router';
import { corsHeaders } from './api/helpers';
import { createToken, verifyToken, isDevMode } from './auth/jwt';
import { getRateLimiter } from './api/rateLimiter';
import { BunSecretVault } from './services/BunSecretVault';
import { restoreBuckeyeAgentsFromVault } from './services/BuckeyeVaultRestore';
import { PerformanceCache } from './services/PerformanceCache';
import { loadEnv } from './config/env';

const env = loadEnv();
const PORT = env.PORT;
const HOST = env.HOST;
const JWT_SECRET = env.JWT_SECRET;

// Initialize database and scraper
let db: Database;
let scraperManager: BuckeyeScraperManager;
let oddsPoller: OddsPoller;
let secretVault: BunSecretVault;
let performanceCache: PerformanceCache | undefined;

interface WebSocketData {
  agentId: string | null;
  isAuthenticated: boolean;
  lastPing: number;
  pingInterval?: Timer;
  playerSubscriptions?: Set<string>;
}

interface BroadcastMessage {
  type?: string;
  payload?: Record<string, unknown>;
}

type WebSocketMessage = Record<string, unknown> & {
  type?: string;
  agentId?: string;
  password?: string;
  cfCookie?: string;
  token?: string;
  playerId?: string;
  customerId?: string;
  login?: string;
  action?: string;
  wagerNumber?: number | string;
  amount?: number;
  reason?: string;
};

// Connected WebSocket clients
const wsClients = new Set<ServerWebSocket<WebSocketData>>();

function broadcast(msg: object) {
  const broadcastMsg = msg as BroadcastMessage;
  const payload = JSON.stringify(msg);
  for (const client of wsClients) {
    try {
      if (client.readyState === 1) {
        const subscribedPlayers = client.data?.playerSubscriptions;
        if (subscribedPlayers?.size && broadcastMsg.type === 'wager.new') {
          const wager = broadcastMsg.payload || {};
          const playerId = String(wager.CustomerID || wager.customer_id || wager.Login || wager.login || '');
          if (!playerId || !subscribedPlayers.has(playerId)) continue;
        }
        client.send(payload);
      }
    } catch (err) {
      console.warn('[WS] Broadcast to client failed:', err instanceof Error ? err.message : err);
    }
  }
}

async function restoreBuckeyeFromVault(): Promise<void> {
  const result = await restoreBuckeyeAgentsFromVault(secretVault, scraperManager, env.BUCKEYE_BASE_URL);
  for (const agentId of result.restored) {
    console.log(`[SecretVault] Restored Buckeye ingestion for ${agentId}`);
  }
  for (const failure of result.failed) {
    console.warn(
      `[SecretVault] Stored Buckeye credentials for ${failure.agentId} could not be used:`,
      failure.error
    );
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

  // Initialize performance cache (Redis-backed, graceful fallback)
  if (env.REDIS_URL) {
    performanceCache = new PerformanceCache(
      async (agentId: string) => {
        // Fetcher fallback — pulls from DB if Redis is unavailable
        return scraperManager?.getAgentPerformance(agentId) ?? null;
      },
      env.REDIS_URL
    );
    console.log('✅ Performance cache initialized (Redis)');
  } else {
    console.log('ℹ️  No REDIS_URL set — performance cache disabled');
  }

  // Initialize scraper manager with broadcast callback
  const debugMode = env.DEBUG;
  secretVault = new BunSecretVault();
  scraperManager = new BuckeyeScraperManager(db, broadcast, debugMode, secretVault, performanceCache);
  console.log('✅ Scraper manager initialized');

  // Initialize odds poller
  oddsPoller = new OddsPoller(db, broadcast);
  await oddsPoller.start();
  console.log('✅ Odds poller initialized');

  await restoreBuckeyeFromVault();

  // Create HTTP server with WebSocket support
  serve<WebSocketData>({
    port: PORT,
    hostname: HOST,
    idleTimeout: 30,
    websocket: {
      perMessageDeflate: true, // Built-in compression for WS messages
      open(ws) {
        console.log('[WS] Client connected');
        ws.data.agentId = ws.data.agentId ?? null;
        ws.data.isAuthenticated = ws.data.isAuthenticated ?? false;
        ws.data.lastPing = Date.now();
        wsClients.add(ws);

        // Heartbeat: ping every 30s, close if no response within 45s
        ws.data.pingInterval = setInterval(() => {
          if (Date.now() - ws.data.lastPing > 45_000) {
            console.log('[WS] Stale connection detected, closing');
            clearInterval(ws.data.pingInterval);
            ws.close();
          } else {
            try { ws.ping(); } catch {
              // Ignore heartbeat ping failures; stale sockets are closed on the next tick.
            }
          }
        }, 30_000);
      },
      message(ws, message) {
        handleWebSocketMessage(ws, message, scraperManager);
      },
      close(ws) {
        console.log('[WS] Client disconnected');
        if (ws.data?.pingInterval) clearInterval(ws.data.pingInterval);
        wsClients.delete(ws);
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
              data: { agentId: payload.agentId, isAuthenticated: true, lastPing: Date.now() },
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
            data: { agentId: null, isAuthenticated: false, lastPing: Date.now() },
          })) {
            return undefined;
          }
        }
      }

      // Delegate to router
      const result = await routeRequest(url, request, {
        scraperManager,
        oddsPoller,
        secretVault,
        performanceCache,
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
  ws: ServerWebSocket<WebSocketData>,
  message: string | Buffer,
  scraperManager: BuckeyeScraperManager
) {
  try {
    const msg = JSON.parse(message.toString()) as WebSocketMessage;

    switch (msg.type) {
      case 'auth': {
        const agentId = String(msg.agentId || '').trim();
        ws.data.agentId = agentId || null;

        // If token is provided, try to resume session first
        if (agentId && msg.token) {
          try {
            const resumed = await scraperManager.resumeAgent(agentId, {
              agentId,
              password: msg.password || '',
              baseUrl: env.BUCKEYE_BASE_URL,
              cfCookie: msg.cfCookie,
            }, msg.token);

            if (resumed) {
              await secretVault.saveBuckeyeSecrets({
                agentId,
                password: msg.password || undefined,
                cfCookie: msg.cfCookie,
                token: msg.token,
              });
              ws.data.isAuthenticated = true;
              // Issue a fresh JWT
              let jwtToken = '';
              try {
                jwtToken = await createToken(agentId, JWT_SECRET);
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
          } catch {
            console.log('[WS] Token resume failed, falling back to password login');
          }
        }

        // Fallback to password login
        const password = msg.password || '';
        if (!password) {
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
          await scraperManager.startAgent(agentId, {
            agentId,
            password,
            baseUrl: env.BUCKEYE_BASE_URL,
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
        const agentInstance = scraperManager.getAgentInstance(agentId);
        const buckeyeToken = agentInstance?.api.getToken() || '';
        await secretVault.saveBuckeyeSecrets({
          agentId,
          password,
          cfCookie: msg.cfCookie,
          token: buckeyeToken,
        });

        // Issue our own JWT for future reconnections
        let jwtToken = '';
        try {
          jwtToken = await createToken(agentId, JWT_SECRET);
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
          const agentId = String(msg.agentId || '').trim();
          const data = await scraperManager.getAgentData(agentId);
          ws.send(
            JSON.stringify({
              type: 'data_response',
              agentId,
              data,
            })
          );
        } catch (err) {
          console.error('[WS] getAgentData error:', err);
          ws.send(
            JSON.stringify({
              type: 'data_error',
              agentId: String(msg.agentId || '').trim(),
              message: err instanceof Error ? err.message : 'Failed to load agent data',
            })
          );
        }
        break;
      }

      case 'player.subscribe': {
        const playerId = String(msg.playerId || msg.customerId || msg.login || '').trim();
        if (!playerId) {
          ws.send(JSON.stringify({ type: 'error', message: 'player.subscribe requires playerId' }));
          return;
        }
        ws.data.playerSubscriptions = ws.data.playerSubscriptions || new Set<string>();
        ws.data.playerSubscriptions.add(playerId);
        ws.send(JSON.stringify({ type: 'player.subscribed', playerId }));
        break;
      }

      case 'player.unsubscribe': {
        const playerId = String(msg.playerId || msg.customerId || msg.login || '').trim();
        if (playerId && ws.data.playerSubscriptions) ws.data.playerSubscriptions.delete(playerId);
        ws.send(JSON.stringify({ type: 'player.unsubscribed', playerId }));
        break;
      }

      case 'refresh': {
        try {
          await scraperManager.forceRefresh(String(msg.agentId || '').trim());
        } catch (err) {
          console.error('[WS] Force refresh error:', err);
        }
        ws.send(
          JSON.stringify({
            type: 'refresh_initiated',
            agentId: String(msg.agentId || '').trim(),
          })
        );
        break;
      }

      case 'betAction': {
        try {
          if (!ws.data?.isAuthenticated || !ws.data?.agentId) {
            throw new Error('Not authenticated');
          }
          if (msg.agentId !== ws.data.agentId) {
            throw new Error('Agent mismatch');
          }
          if (msg.action !== 'accept' && msg.action !== 'decline') {
            throw new Error('Invalid bet action');
          }
          const wagerNumber = Number(msg.wagerNumber);
          if (!Number.isInteger(wagerNumber) || wagerNumber <= 0) {
            throw new Error('Invalid wager number');
          }
          const actionId = await scraperManager.getActionQueue().enqueue(
            ws.data.agentId,
            wagerNumber,
            msg.action,
            msg.amount,
            msg.reason
          );
          ws.send(
            JSON.stringify({
              type: 'betAction_queued',
              actionId,
              agentId: ws.data.agentId,
              wagerNumber,
              action: msg.action,
            })
          );
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: 'betAction_error',
              message: err instanceof Error ? err.message : 'Action failed',
            })
          );
        }
        break;
      }

      case 'token_refresh': {
        if (!ws.data?.isAuthenticated || !ws.data?.agentId) {
          ws.send(JSON.stringify({ type: 'token_refresh_error', message: 'Not authenticated' }));
          return;
        }
        try {
          const newToken = await createToken(ws.data.agentId, JWT_SECRET);
          ws.send(JSON.stringify({ type: 'token_refreshed', token: newToken }));
        } catch {
          ws.send(JSON.stringify({ type: 'token_refresh_error', message: 'Token refresh failed' }));
        }
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
