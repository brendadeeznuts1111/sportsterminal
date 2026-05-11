import { serve, type ServerWebSocket } from 'bun';
import { corsHeaders } from './api/helpers';
import { RateLimiter, getRateLimiter } from './api/rateLimiter';
import { routeRequest } from './api/router';
import { createToken, isDevMode, verifyToken } from './auth/jwt';
import { loadEnv } from './config/env';
import { initDatabase, type Database } from './database';
import { OddsPoller } from './odds/OddsPoller';
import { BuckeyeScraperManager } from './scrapers/ScraperManager';
import { restoreBuckeyeAgentsFromVault } from './services/BuckeyeVaultRestore';
import { BunSecretVault } from './services/BunSecretVault';
import { CommandCenterCron } from './services/CommandCenterCron';
import { PerformanceCache } from './services/PerformanceCache';
import { startSandboxJanitor, startSandboxQueueProcessor } from './services/SandboxService';
import { streamHub } from './services/StreamHub';
import { WS_TIMEOUTS } from './utils/constants';

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

// Bun native pub/sub topics
const WS_TOPIC_MESSAGES = 'messages';
const WS_TOPIC_WAGERS_ALL = 'wagers:all';
const WS_TOPIC_PLAYER = (playerId: string) => `player:${playerId}`;

/** Server reference for native publish/subscribe broadcasting and metrics */
let serverRef: { publish(topic: string, data: string, compress?: boolean): number; subscriberCount(topic: string): number } | undefined;

function broadcast(msg: object) {
  const broadcastMsg = msg as BroadcastMessage;
  const payload = JSON.stringify(msg);

  // 1. WebSocket pub/sub (existing behavior)
  if (serverRef) {
    if (broadcastMsg.type === 'wager.new') {
      const wager = broadcastMsg.payload || {};
      const playerId = String(wager.CustomerID || wager.customer_id || wager.Login || wager.login || '');
      if (playerId) {
        serverRef.publish(WS_TOPIC_PLAYER(playerId), payload);
      }
      serverRef.publish(WS_TOPIC_WAGERS_ALL, payload);
    } else {
      serverRef.publish(WS_TOPIC_MESSAGES, payload);
    }
  }

  // 2. SSE fan-out via StreamHub (new) — mirror the same events to /api/stream/*
  if (broadcastMsg.type === 'wager.new') {
    const wager = broadcastMsg.payload || {};
    const playerId = String(wager.CustomerID || wager.customer_id || wager.Login || wager.login || '');
    streamHub.publish('wagers', { event: 'wager', data: wager });
    if (playerId) {
      streamHub.publish(`wagers:${playerId}`, { event: 'wager', data: wager });
    }
  } else if (broadcastMsg.type === 'wager.alert' || broadcastMsg.type === 'agent_rule.triggered') {
    streamHub.publish('alerts', {
      event: 'risk_alert',
      data: broadcastMsg.payload ?? msg,
    });
  } else if (broadcastMsg.type) {
    // Generic broadcast — re-publish under the topic "ws:<type>"
    streamHub.publish(`ws:${broadcastMsg.type}`, {
      event: broadcastMsg.type,
      data: broadcastMsg.payload ?? msg,
    });
  }
}

/**
 * Get WebSocket topic subscriber counts for health/metrics.
 */
export function getWsSubscriberCounts(): Record<string, number> {
  if (!serverRef) return {};
  return {
    messages: serverRef.subscriberCount(WS_TOPIC_MESSAGES),
    wagersAll: serverRef.subscriberCount(WS_TOPIC_WAGERS_ALL),
  };
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

async function isClientIpBlocked(clientIp: string): Promise<boolean> {
  if (!clientIp || clientIp.startsWith('local:')) return false;
  try {
    const row = await db.get<{ ip: string }>(
      `SELECT ip FROM ip_denylist WHERE ip = ? LIMIT 1`,
      [clientIp]
    );
    return Boolean(row);
  } catch {
    return false;
  }
}

async function startServer() {
  // Initialize database
  db = await initDatabase();
  console.log('✅ Database initialized');
  startSandboxQueueProcessor(db);
  startSandboxJanitor(db);
  console.log('✅ Sandbox queue processor initialized');

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
  const server = serve<WebSocketData>({
    port: PORT,
    hostname: HOST,
    idleTimeout: WS_TIMEOUTS.IDLE_TIMEOUT_SECONDS,
    websocket: {
      sendPings: true,
      idleTimeout: 60,
      backpressureLimit: WS_TIMEOUTS.BACKPRESSURE_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
      perMessageDeflate: { compress: true, decompress: true }, // Built-in compression for WS messages
      open(ws) {
        console.log('[WS] Client connected');
        ws.data.agentId = ws.data.agentId ?? null;
        ws.data.isAuthenticated = ws.data.isAuthenticated ?? false;
        ws.data.lastPing = Date.now();

        // Subscribe to general message topics
        ws.subscribe(WS_TOPIC_MESSAGES);
        ws.subscribe(WS_TOPIC_WAGERS_ALL);

        // Heartbeat: ping every interval, close if no response within stale timeout
        ws.data.pingInterval = setInterval(() => {
          if (Date.now() - ws.data.lastPing > WS_TIMEOUTS.STALE_TIMEOUT_MS) {
            console.log('[WS] Stale connection detected, closing');
            clearInterval(ws.data.pingInterval);
            ws.close();
          } else {
            try { ws.ping(); } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn(`[WS] Heartbeat ping failed: ${msg}`);
            }
          }
        }, WS_TIMEOUTS.PING_INTERVAL_MS);
      },
      message(ws, message) {
        handleWebSocketMessage(ws, message, scraperManager);
      },
      close(ws) {
        console.log('[WS] Client disconnected');
        if (ws.data?.pingInterval) clearInterval(ws.data.pingInterval);
        ws.unsubscribe(WS_TOPIC_MESSAGES);
        ws.unsubscribe(WS_TOPIC_WAGERS_ALL);
      },
      drain(ws) {
        console.debug('[WS] Backpressure cleared for', ws.remoteAddress);
      },
    },
    async fetch(request, srv) {
      // Store server reference for native pub/sub broadcasting
      if (!serverRef) serverRef = srv;
      const url = new URL(request.url);

      // Disable per-request idle timeout for SSE streams — they must stay open
      // for the lifetime of the subscriber.
      if (url.pathname.startsWith('/api/stream/') || url.pathname === '/api/analysis/stream') {
        srv.timeout(request, 0);
      }

      // Accurate client IP via Bun's server.requestIP()
      const clientIp = srv.requestIP(request)?.address || RateLimiter.getClientIp(request);
      if (await isClientIpBlocked(clientIp)) {
        return new Response(JSON.stringify({ error: 'Forbidden', code: 'IP_BLOCKED' }), {
          status: 403,
          headers: corsHeaders,
        });
      }

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
            if (srv.upgrade(request, {
              data: { agentId: payload.agentId, isAuthenticated: true, lastPing: Date.now() },
            })) {
              return undefined;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[WS] Token verification failed: ${msg}`);
            return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
              status: 401,
              headers: corsHeaders,
            });
          }
        } else {
          // Dev mode — upgrade without auth
          if (srv.upgrade(request, {
            data: { agentId: null, isAuthenticated: false, lastPing: Date.now() },
          })) {
            return undefined;
          }
        }
      }

      // Delegate to router with accurate client IP
      const result = await routeRequest(url, request, {
        scraperManager,
        oddsPoller,
        secretVault,
        performanceCache,
      }, getRateLimiter(), clientIp);

      if (result !== null) {
        return result;
      }

      // 404
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: corsHeaders,
      });
    },
    error(error) {
      console.error('[HTTP] Unhandled server error:', error instanceof Error ? error.message : String(error));
      return new Response(
        JSON.stringify({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' }),
        { status: 500, headers: corsHeaders }
      );
    },
  });
  serverRef = server;
  server.ref();

  // Start Risk Command Center background jobs
  const commandCenterCron = new CommandCenterCron(db, {
    featureCandidateMs: 5 * 60_000,
    featureExtractMs: 10 * 60_000,
    portfolioRefreshMs: 15 * 60_000,
    heartbeatMs: 5_000,
  });
  commandCenterCron.start();

  console.log(`🚀 Backend running at http://${HOST}:${PORT}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[Server] Received ${signal}, starting graceful shutdown...`);
    try {
      commandCenterCron.stop();
      streamHub.closeAll();
      await server.stop();
      console.log('[Server] HTTP server stopped');
    } catch (e) {
      console.error('[Server] Error during shutdown:', e);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
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
        ws.subscribe(WS_TOPIC_PLAYER(playerId));
        ws.unsubscribe(WS_TOPIC_WAGERS_ALL); // scoped clients don't receive general wagers
        ws.send(JSON.stringify({ type: 'player.subscribed', playerId }));
        break;
      }

      case 'player.unsubscribe': {
        const playerId = String(msg.playerId || msg.customerId || msg.login || '').trim();
        if (playerId) ws.unsubscribe(WS_TOPIC_PLAYER(playerId));
        // Re-subscribe to general wagers if no player subscriptions remain
        const hasPlayerSubs = ws.subscriptions.some((s) => s.startsWith('player:'));
        if (!hasPlayerSubs) ws.subscribe(WS_TOPIC_WAGERS_ALL);
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
