/**
 * Sandbox scenario routes.
 * Stores synthetic customers in normalized tables instead of large JSON blobs.
 */
import { z } from 'zod';
import { ApiError, clampInt, corsHeaders, handleAsync, parseRequiredId, readJsonBody, requireAdminTokenIfConfigured } from '../helpers';
import { SandboxService, type ABTestInput, type SaveSandboxScenarioInput } from '../../services/SandboxService';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';

const MAX_SAVE_PAYLOAD_BYTES = 10 * 1024 * 1024;

const SandboxConfigSchema = z.object({
  customerCount: z.number().int().min(1).max(100),
  archetypesEnabled: z.boolean(),
  snapshotsEnabled: z.boolean(),
  aiSummariesEnabled: z.boolean(),
  archetypeWeights: z.record(z.string(), z.number().min(0).max(1)).optional(),
});

const SandboxSnapshotSchema = z.object({
  day_index: z.number().int().min(0).max(89),
  balance: z.number(),
  pnl: z.number(),
  wager_count: z.number().int().min(0),
  clv: z.number(),
  win_rate: z.number().min(0).max(1),
});

const SandboxCustomerSchema = z.object({
  customer_id: z.string().min(1).max(80),
  archetype: z.string().min(1).max(80),
  risk_tier: z.enum(['GREEN', 'YELLOW', 'RED', 'BLACK', 'UNKNOWN']).optional(),
  balance: z.number(),
  clv: z.number(),
  win_rate: z.number().min(0).max(1),
  lifetime_wagers: z.number().int().min(0),
  tags: z.array(z.string().max(30)).max(20).optional(),
  profile: z.record(z.string(), z.unknown()).optional(),
  snapshot: z.array(SandboxSnapshotSchema).max(90).optional(),
});

const SaveScenarioSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  config: SandboxConfigSchema,
  customers: z.array(SandboxCustomerSchema).min(1).max(100),
});

const QueueSummariesSchema = z.object({
  scenarioId: z.number().int().positive(),
  customerIds: z.array(z.string().min(1)).max(100).optional(),
});

const DeleteScenarioSchema = z.object({
  id: z.number().int().positive(),
});

const ABTestSchema = z.object({
  scenario_id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  prompt_a: z.string().min(1).max(8_000),
  prompt_b: z.string().min(1).max(8_000),
  customer_ids: z.array(z.string().min(1).max(80)).min(1).max(20),
});

const RefreshSummarySchema = z.object({
  scenario_id: z.number().int().positive(),
  customer_id: z.string().min(1).max(80),
});

export function registerSandboxRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Response | Promise<Response> | null {
  const service = new SandboxService(scraperManager.getDatabase());

  if (url.pathname === '/api/sandbox/list' && request.method === 'GET') {
    return handleAsync(async () => ({
      scenarios: await service.listScenarios(url.searchParams.get('archived') === 'true'),
    }), corsHeaders);
  }

  if (url.pathname === '/api/sandbox/load' && request.method === 'GET') {
    return handleAsync(async () => {
      const id = parseRequiredId(url.searchParams.get('id') || undefined, 'scenario id');
      const page = clampInt(url.searchParams.get('page'), 1, 1, 10_000);
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 50);
      const includeSnapshots = url.searchParams.get('snapshots') === 'true';
      return service.loadScenario(id, page, limit, includeSnapshots);
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/save' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      assertPayloadSize(request, MAX_SAVE_PAYLOAD_BYTES);
      const input = parseZod(SaveScenarioSchema, await readJsonBody(request)) as SaveSandboxScenarioInput;
      const existingId = optionalPositiveInt(url.searchParams.get('id'));
      const saved = await service.saveScenario(input, existingId);
      return { ok: true, ...saved };
    }, corsHeaders);
  }

  if ((url.pathname === '/api/sandbox/delete' || url.pathname === '/api/sandbox/archive') && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const body = parseZod(DeleteScenarioSchema, await readJsonBody(request));
      return { ok: await service.archiveScenario(body.id), id: body.id };
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/restore' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const body = parseZod(DeleteScenarioSchema, await readJsonBody(request));
      return { ok: await service.restoreScenario(body.id), id: body.id };
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/hard-delete' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const body = parseZod(DeleteScenarioSchema, await readJsonBody(request));
      return { ok: await service.hardDeleteScenario(body.id), id: body.id };
    }, corsHeaders);
  }

  if (/^\/api\/sandbox\/scenarios\/\d+$/.test(url.pathname) && request.method === 'DELETE') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const id = parseRequiredId(url.pathname.split('/').pop(), 'scenario id');
      return { ok: await service.archiveScenario(id), id };
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/generate-summaries' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const body = parseZod(QueueSummariesSchema, await readJsonBody(request));
      return { ok: true, ...(await service.queueSummaries(body.scenarioId, body.customerIds)) };
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/customer-summary' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const body = parseZod(RefreshSummarySchema, await readJsonBody(request));
      return {
        ok: true,
        summary: await service.refreshCustomerSummary(body.scenario_id, body.customer_id),
      };
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/queue-status' && request.method === 'GET') {
    return handleAsync(async () => {
      const scenarioId = parseRequiredId(url.searchParams.get('scenarioId') || undefined, 'scenario id');
      return service.getQueueStatus(scenarioId);
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/ab-tests' && request.method === 'GET') {
    return handleAsync(async () => {
      const scenarioId = optionalPositiveInt(url.searchParams.get('scenario_id') || url.searchParams.get('scenarioId'));
      return { tests: await service.listABTests(scenarioId) };
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/ab-test' && request.method === 'GET') {
    return handleAsync(async () => {
      const scenarioId = optionalPositiveInt(url.searchParams.get('scenario_id') || url.searchParams.get('scenarioId'));
      return { tests: await service.listABTests(scenarioId) };
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/ab-test' && request.method === 'POST') {
    const adminResponse = requireAdminTokenIfConfigured(request);
    if (adminResponse) return adminResponse;
    return handleAsync(async () => {
      const body = parseZod(ABTestSchema, await readJsonBody(request)) as ABTestInput;
      return { ok: true, ...(await service.createABTest(body)) };
    }, corsHeaders);
  }

  if (/^\/api\/sandbox\/ab-test\/\d+$/.test(url.pathname) && request.method === 'GET') {
    return handleAsync(async () => {
      const id = parseRequiredId(url.pathname.split('/').pop(), 'AB test id');
      return service.getABTest(id);
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/export/csv' && request.method === 'GET') {
    return handleExportCsv(url, service);
  }

  if (url.pathname === '/api/sandbox/export/features' && request.method === 'GET') {
    return handleAsync(async () => {
      const scenarioId = parseRequiredId(url.searchParams.get('scenarioId') || undefined, 'scenario id');
      return service.exportFeatures(scenarioId);
    }, corsHeaders);
  }

  if (url.pathname === '/api/sandbox/stats' && request.method === 'GET') {
    return handleAsync(async () => service.getStats(), corsHeaders);
  }

  if (url.pathname === '/api/sandbox/health' && request.method === 'GET') {
    return handleAsync(async () => service.getHealth(), corsHeaders);
  }

  return null;
}

async function handleExportCsv(url: URL, service: SandboxService): Promise<Response> {
  const scenarioId = parseRequiredId(url.searchParams.get('scenarioId') || undefined, 'scenario id');
  const csv = await service.exportCsv(scenarioId);
  return new Response(csv, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sandbox-${scenarioId}.csv"`,
    },
  });
}

function assertPayloadSize(request: Request, maxBytes: number): void {
  const rawLength = request.headers.get('content-length');
  if (!rawLength) return;
  const length = Number.parseInt(rawLength, 10);
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ApiError(413, `Request body exceeds ${maxBytes} bytes`);
  }
}

function optionalPositiveInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(400, 'Invalid id');
  }
  return parsed;
}

function parseZod<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `Validation failed: ${details}`, 'VALIDATION_FAILED');
}
