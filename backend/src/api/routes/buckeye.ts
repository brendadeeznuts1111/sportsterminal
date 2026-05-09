/**
 * Buckeye-specific routes: UI config, account info, weekly figures, connect test
 */
import { clampInt, readJsonBody, handleAsync, corsHeaders } from '../helpers';
import { BuckeyeAPI } from '../../scrapers/BuckeyeAPI';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

export function registerBuckeyeRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Response | null {
  // Buckeye language/theme config
  if (url.pathname === '/api/buckeye/ui-config') {
    if (request.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      const includeRaw = url.searchParams.get('includeRaw') === '1';
      const includeAgentParams = url.searchParams.get('includeAgentParams') === '1';
      return handleAsync(
        async () => scraperManager.getBuckeyeUiConfig(agentId, includeRaw, includeAgentParams),
        corsHeaders
      );
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        const api = new BuckeyeAPI(
          {
            agentId: body.agentId,
            password: body.password || '',
            baseUrl: body.baseUrl,
            cfCookie: body.cfCookie,
          },
          false
        );

        if (body.token) {
          (api as any).token = body.token;
          (api as any).loggedIn = true;
        } else {
          const ok = await api.login();
          if (!ok) {
            throw new Error('Login failed — invalid credentials or site unreachable');
          }
        }

        return api.getLanguageUiConfig({
          includeRaw: body.includeRaw === true,
          includeAgentParams: body.includeAgentParams === true,
        });
      }, corsHeaders);
    }
  }

  // Buckeye account info and capability flags
  if (url.pathname === '/api/buckeye/account-info') {
    if (request.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      const force = url.searchParams.get('force') === '1';
      return handleAsync(async () => scraperManager.getBuckeyeAccountInfo(agentId, force), corsHeaders);
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        const api = new BuckeyeAPI(
          {
            agentId: body.agentId,
            password: body.password || '',
            baseUrl: body.baseUrl,
            cfCookie: body.cfCookie,
          },
          false
        );

        if (body.token) {
          (api as any).token = body.token;
          (api as any).loggedIn = true;
        } else {
          const ok = await api.login();
          if (!ok) {
            throw new Error('Login failed — invalid credentials or site unreachable');
          }
        }

        return api.getAccountInfoOwner();
      }, corsHeaders);
    }
  }

  // Buckeye weekly figure report
  if (url.pathname === '/api/buckeye/weekly-figures') {
    if (request.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      const week = clampInt(url.searchParams.get('week'), 0, 0, 52);
      const type = url.searchParams.get('type') || 'A';
      const layout = url.searchParams.get('layout') || 'byDay';
      return handleAsync(
        async () => scraperManager.getWeeklyFigureByAgentLite(agentId, { week, type, layout }),
        corsHeaders
      );
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        const api = new BuckeyeAPI(
          {
            agentId: body.agentId,
            password: body.password || '',
            baseUrl: body.baseUrl,
            cfCookie: body.cfCookie,
          },
          false
        );

        if (body.token) {
          (api as any).token = body.token;
          (api as any).loggedIn = true;
        } else {
          const ok = await api.login();
          if (!ok) {
            throw new Error('Login failed — invalid credentials or site unreachable');
          }
        }

        return api.getWeeklyFigureByAgentLite({
          week: Number.isInteger(body.week) ? body.week : 0,
          type: body.type || 'A',
          layout: body.layout || 'byDay',
        });
      }, corsHeaders);
    }
  }

  // Buckeye manager bootstrap/report payloads (config reports, sports, auth flags, messages)
  if (url.pathname === '/api/buckeye/manager-snapshot') {
    if (request.method === 'GET') {
      const agentId = url.searchParams.get('agentId') || undefined;
      return handleAsync(async () => scraperManager.getBuckeyeManagerSnapshot(agentId), corsHeaders);
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        const api = new BuckeyeAPI(
          {
            agentId: body.agentId,
            password: body.password || '',
            baseUrl: body.baseUrl,
            cfCookie: body.cfCookie,
          },
          false
        );

        if (body.token) {
          (api as any).token = body.token;
          (api as any).loggedIn = true;
        } else {
          const ok = await api.login();
          if (!ok) {
            throw new Error('Login failed — invalid credentials or site unreachable');
          }
        }

        return api.getManagerSnapshot();
      }, corsHeaders);
    }
  }

  if (url.pathname === '/api/buckeye/access-logs') {
    if (request.method === 'GET') {
      const limit = clampInt(url.searchParams.get('limit'), 200, 1, 500);
      return handleAsync(async () => scraperManager.getAccessLogs(limit), corsHeaders);
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody(request);
        if (!body.agentId) throw new Error('agentId is required');
        return scraperManager.forceAccessLogRefresh(body.agentId);
      }, corsHeaders);
    }
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

  return null;
}
