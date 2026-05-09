import { serve } from 'bun';
import { Database } from 'sqlite';
import { initDatabase } from './database';
import { BuckeyeScraperManager } from './scrapers/ScraperManager';
import { BuckeyeAPI } from './scrapers/BuckeyeAPI';
import { OddsPoller } from './odds/OddsPoller';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-min-32-chars';

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseRequiredId(value: string | undefined): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, 'Invalid webhook id');
  }
  return parsed;
}

async function readJsonBody(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, 'Malformed JSON body');
  }
}

async function loadLocalAgentHierarchy(): Promise<any> {
  const candidates = ['docs/agentobject.md', '../docs/agentobject.md'];
  for (const path of candidates) {
    try {
      const file = Bun.file(path);
      if ((await file.size) === 0) continue;
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return { GENERAL: parsed, source: 'docs/agentobject.md' };
      }
      if (Array.isArray(parsed?.GENERAL)) {
        return { ...parsed, source: 'docs/agentobject.md' };
      }
    } catch {
      // Try the next relative path.
    }
  }
  return { GENERAL: [], source: 'none' };
}

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

      // WebSocket upgrade
      if (server.upgrade(request)) {
        return undefined;
      }

      // CORS headers for frontend
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json',
      };

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Health check
      if (url.pathname === '/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            scrapers: scraperManager.getMetrics(),
          }),
          { headers: corsHeaders }
        );
      }

      // Metrics
      if (url.pathname === '/metrics') {
        return new Response(
          JSON.stringify(scraperManager.getMetrics()),
          { headers: corsHeaders }
        );
      }

      // Stats summary
      if (url.pathname === '/api/stats') {
        return handleAsync(async () => scraperManager.getStats(), corsHeaders);
      }

      // Wagers
      if (url.pathname === '/api/wagers') {
        const limit = clampInt(url.searchParams.get('limit'), 200, 1, 500);
        const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
        return handleAsync(async () => scraperManager.getWagers(limit, offset), corsHeaders);
      }

      if (url.pathname === '/api/wagers/alerts') {
        return handleAsync(async () => scraperManager.getAlertWagers(), corsHeaders);
      }

      if (url.pathname === '/api/wagers/live') {
        return handleAsync(async () => scraperManager.getLiveWagers(), corsHeaders);
      }

      // Agents
      if (url.pathname === '/api/agents') {
        return handleAsync(async () => scraperManager.getAgents(), corsHeaders);
      }

      const agentExposureMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/exposure$/);
      if (agentExposureMatch) {
        const agentId = decodeURIComponent(agentExposureMatch[1]);
        return handleAsync(async () => scraperManager.getAgentData(agentId), corsHeaders);
      }

      const agentPerformanceMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/performance$/);
      if (agentPerformanceMatch) {
        const agentId = decodeURIComponent(agentPerformanceMatch[1]);
        return handleAsync(async () => scraperManager.getAgentPerformance(agentId), corsHeaders);
      }

      if (url.pathname === '/api/agents/downline') {
        return handleAsync(async () => scraperManager.getAgentDownline(), corsHeaders);
      }

      if (url.pathname === '/api/agents/hierarchy') {
        const agentId = url.searchParams.get('agentId') || undefined;
        return handleAsync(async () => {
          const liveHierarchy = await scraperManager.getAgentHierarchy(agentId);
          if (Array.isArray(liveHierarchy?.GENERAL) && liveHierarchy.GENERAL.length > 0) {
            return liveHierarchy;
          }
          const localHierarchy = await loadLocalAgentHierarchy();
          return localHierarchy.GENERAL.length > 0 ? localHierarchy : liveHierarchy;
        }, corsHeaders);
      }

      // Players
      const playerDetailsMatch = url.pathname.match(/^\/api\/players\/([^/]+)\/details$/);
      if (playerDetailsMatch) {
        const playerId = decodeURIComponent(playerDetailsMatch[1]);
        return handleAsync(async () => scraperManager.getPlayerDetails(playerId), corsHeaders);
      }

      const playerWagersMatch = url.pathname.match(/^\/api\/players\/([^/]+)\/wagers$/);
      if (playerWagersMatch) {
        const playerId = decodeURIComponent(playerWagersMatch[1]);
        return handleAsync(async () => scraperManager.getPlayerWagers(playerId), corsHeaders);
      }

      const playerPnlMatch = url.pathname.match(/^\/api\/players\/([^/]+)\/pnl$/);
      if (playerPnlMatch) {
        const playerId = decodeURIComponent(playerPnlMatch[1]);
        const days = clampInt(url.searchParams.get('days'), 7, 1, 90);
        return handleAsync(async () => scraperManager.getPlayerPnlHistory(playerId, days), corsHeaders);
      }

      // Risk / Alerts
      if (url.pathname === '/api/risk/alerts') {
        return handleAsync(async () => scraperManager.getAlerts(), corsHeaders);
      }

      // Exposure breakdowns
      if (url.pathname === '/api/exposure/sports') {
        return handleAsync(async () => scraperManager.getSportExposure(), corsHeaders);
      }

      if (url.pathname === '/api/exposure/agents') {
        return handleAsync(async () => scraperManager.getAgentExposure(), corsHeaders);
      }

      // Webhooks
      if (url.pathname === '/api/webhooks') {
        if (request.method === 'GET') {
          return handleAsync(async () => scraperManager.getWebhookService().getWebhooks(), corsHeaders);
        }
        if (request.method === 'POST') {
          return handleAsync(async () => {
            const body = await readJsonBody(request);
            return scraperManager.getWebhookService().createWebhook(body);
          }, corsHeaders);
        }
      }

      const webhookMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)$/);
      if (webhookMatch) {
        if (request.method === 'GET') {
          return handleAsync(async () => {
            const webhookId = parseRequiredId(webhookMatch[1]);
            return scraperManager.getWebhookService().getWebhookById(webhookId);
          }, corsHeaders);
        }
        if (request.method === 'PUT') {
          return handleAsync(async () => {
            const webhookId = parseRequiredId(webhookMatch[1]);
            const body = await readJsonBody(request);
            return scraperManager.getWebhookService().updateWebhook(webhookId, body);
          }, corsHeaders);
        }
        if (request.method === 'DELETE') {
          return handleAsync(async () => {
            const webhookId = parseRequiredId(webhookMatch[1]);
            const ok = await scraperManager.getWebhookService().deleteWebhook(webhookId);
            return { success: ok };
          }, corsHeaders);
        }
      }

      const webhookDeliveriesMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)\/deliveries$/);
      if (webhookDeliveriesMatch) {
        return handleAsync(async () => {
          const webhookId = parseRequiredId(webhookDeliveriesMatch[1]);
          return scraperManager.getWebhookService().getDeliveries(webhookId);
        }, corsHeaders);
      }

      // Odds Grid
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

      // Test Buckeye login (no polling — just validate credentials)
      if (url.pathname === '/api/connect' && request.method === 'POST') {
        return handleAsync(async () => {
          const body = await readJsonBody(request);
          const api = new BuckeyeAPI(
            {
              agentId: body.agentId,
              password: body.password,
              baseUrl: body.baseUrl,
              cfCookie: body.cfCookie,
            },
            false
          );
          const ok = await api.login();
          if (!ok) {
            throw new Error('Login failed — invalid credentials or site unreachable');
          }
          // Try one getBetTicker to confirm data access
          const wagers = await api.getBetTicker();
          return {
            success: true,
            message: 'Login successful',
            wagerCount: wagers.length,
            sample: wagers[0] || null,
          };
        }, corsHeaders);
      }

      // Static file serving for frontend (relative to project root)
      const staticPath = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = `../frontend/public${staticPath}`;
      try {
        const file = Bun.file(filePath);
        const size = await file.size;
        if (size > 0) {
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.svg': 'image/svg+xml',
          };
          const ext = staticPath.slice(staticPath.lastIndexOf('.'));
          const isHtml = ext === '.html';
          return new Response(file, {
            headers: {
              'Content-Type': mimeTypes[ext] || 'application/octet-stream',
              'Cache-Control': isHtml
                ? 'no-cache, no-store, must-revalidate'
                : 'public, max-age=3600',
            },
          });
        }
      } catch {
        // File not found — fall through to 404
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

function handleAsync(handler: () => Promise<any>, headers: Record<string, string>): Promise<Response> {
  return handler()
    .then((data) => new Response(JSON.stringify(data), { headers }))
    .catch((error) => {
      console.error('API error:', error);
      const status = error instanceof ApiError ? error.status : 500;
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
        { status, headers }
      );
    });
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
              ws.send(
                JSON.stringify({
                  type: 'auth_response',
                  success: true,
                  message: 'Session resumed',
                  token: msg.token,
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

        // Get token from the agent to send back to frontend
        const agentInstance = scraperManager.getAgentInstance(msg.agentId);
        const token = agentInstance?.api.getToken() || '';

        ws.send(
          JSON.stringify({
            type: 'auth_response',
            success: true,
            message: 'Authenticated',
            token,
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
