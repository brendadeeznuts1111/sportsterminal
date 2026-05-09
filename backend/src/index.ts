import { serve } from 'bun';
import { initDatabase, type Database } from './database';
import { BuckeyeScraperManager } from './scrapers/ScraperManager';
import { OddsPoller } from './odds/OddsPoller';
import { routeRequest } from './api/router';
import { corsHeaders } from './api/helpers';
import { createToken, verifyToken, isDevMode } from './auth/jwt';
import { getRateLimiter } from './api/rateLimiter';
import { BunSecretVault } from './services/BunSecretVault';
import { restoreBuckeyeAgentsFromVault } from './services/BuckeyeVaultRestore';
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

  // Initialize scraper manager with broadcast callback
  const debugMode = env.DEBUG;
  secretVault = new BunSecretVault();
  scraperManager = new BuckeyeScraperManager(db, broadcast, debugMode, secretVault);
  console.log('✅ Scraper manager initialized');

  // Initialize odds poller
  oddsPoller = new OddsPoller(db, broadcast);
  oddsPoller.start();
  console.log('✅ Odds poller initialized');

  await restoreBuckeyeFromVault();

  // Create HTTP server with WebSocket support
  const server = serve({
    port: PORT,
    hostname: HOST,
    websocket: {
      perMessageDeflate: true, // Built-in compression for WS messages
      open(ws) {
        console.log('[WS] Client connected');
        ws.data = { agentId: null, isAuthenticated: false, lastPing: Date.now() };
        wsClients.add(ws);

        // Heartbeat: ping every 30s, close if no response within 45s
        ws.data.pingInterval = setInterval(() => {
          if (Date.now() - ws.data.lastPing > 45_000) {
            console.log('[WS] Stale connection detected, closing');
            clearInterval(ws.data.pingInterval);
            ws.close();
          } else {
            try { ws.ping(); } catch {}
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
        secretVault,
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
              baseUrl: env.BUCKEYE_BASE_URL,
              cfCookie: msg.cfCookie,
            }, msg.token);

            if (resumed) {
              await secretVault.saveBuckeyeSecrets({
                agentId: msg.agentId,
                password: msg.password || undefined,
                cfCookie: msg.cfCookie,
                token: msg.token,
              });
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
        const agentInstance = scraperManager.getAgentInstance(msg.agentId);
        const buckeyeToken = agentInstance?.api.getToken() || '';
        await secretVault.saveBuckeyeSecrets({
          agentId: msg.agentId,
          password: msg.password,
          cfCookie: msg.cfCookie,
          token: buckeyeToken,
        });

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
        } catch (err) {
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
