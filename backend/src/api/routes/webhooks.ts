/**
 * Webhook CRUD + delivery log routes
 */
import { ApiError, parseRequiredId, readJsonBody, handleAsync, corsHeaders } from '../helpers';
import type { BuckeyeScraperManager } from '../../scrapers/ScraperManager';
import type { WebhookConfig } from '../../services/WebhookService';

type WebhookCreateBody = Omit<WebhookConfig, 'id' | 'createdAt' | 'updatedAt'>;
type WebhookUpdateBody = Partial<WebhookCreateBody>;

export function registerWebhookRoutes(
  url: URL,
  request: Request,
  scraperManager: BuckeyeScraperManager
): Promise<Response> | Response | null {
  if (url.pathname === '/api/webhooks') {
    if (request.method === 'GET') {
      return handleAsync(async () => scraperManager.getWebhookService().getWebhooks(), corsHeaders);
    }
    if (request.method === 'POST') {
      return handleAsync(async () => {
        const body = await readJsonBody<WebhookCreateBody>(request);
        return scraperManager.getWebhookService().createWebhook(body);
      }, corsHeaders);
    }
  }

  const webhookMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)$/);
  if (webhookMatch) {
    if (request.method === 'GET') {
      return handleAsync(async () => {
        const webhookId = parseRequiredId(webhookMatch[1], 'webhook id');
        return scraperManager.getWebhookService().getWebhookById(webhookId);
      }, corsHeaders);
    }
    if (request.method === 'PUT') {
      return handleAsync(async () => {
        const webhookId = parseRequiredId(webhookMatch[1], 'webhook id');
        const body = await readJsonBody<WebhookUpdateBody>(request);
        return scraperManager.getWebhookService().updateWebhook(webhookId, body);
      }, corsHeaders);
    }
    if (request.method === 'DELETE') {
      return handleAsync(async () => {
        const webhookId = parseRequiredId(webhookMatch[1], 'webhook id');
        const ok = await scraperManager.getWebhookService().deleteWebhook(webhookId);
        if (!ok) throw new ApiError(404, 'Webhook not found');
        return { success: true };
      }, corsHeaders);
    }
  }

  const webhookDeliveriesMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)\/deliveries$/);
  if (webhookDeliveriesMatch) {
    return handleAsync(async () => {
      const webhookId = parseRequiredId(webhookDeliveriesMatch[1], 'webhook id');
      return scraperManager.getWebhookService().getDeliveries(webhookId);
    }, corsHeaders);
  }

  return null;
}
