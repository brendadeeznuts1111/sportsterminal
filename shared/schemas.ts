/**
 * Runtime checks for untrusted JSON at the socket and HTTP body boundaries.
 * Object schemas strip unknown keys (the browser auth frame includes `username`,
 * which the server ignores). They accept the same optional fields the handlers
 * already read, so a well-formed client payload still passes.
 */
import { z } from 'zod';
import type { ClientSocketMessage } from './messages.ts';

export const clientSocketMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth'),
    agentId: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    cfCookie: z.string().optional(),
    token: z.string().optional(),
  }),
  z.object({
    type: z.literal('request_data'),
    agentId: z.string().optional(),
  }),
  z.object({
    type: z.literal('refresh'),
    agentId: z.string().optional(),
  }),
  z.object({
    type: z.literal('betAction'),
    agentId: z.string().optional(),
    action: z.string().optional(),
    wagerNumber: z.union([z.number(), z.string()]).optional(),
    amount: z.number().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('token_refresh'),
  }),
]) satisfies z.ZodType<ClientSocketMessage>;

export const webhookCreateSchema = z.object({
  name: z.string(),
  platform: z.enum(['discord', 'slack', 'telegram', 'generic']),
  url: z.string(),
  triggers: z.array(z.string()),
  enabled: z.boolean(),
});

export const webhookUpdateSchema = z.object({
  name: z.string().optional(),
  platform: z.enum(['discord', 'slack', 'telegram', 'generic']).optional(),
  url: z.string().optional(),
  triggers: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export const buckeyeSessionSchema = z.object({
  agentId: z.string().optional(),
  password: z.string().optional(),
  baseUrl: z.string().optional(),
  cfCookie: z.string().optional(),
  token: z.string().optional(),
  includeRaw: z.boolean().optional(),
  includeAgentParams: z.boolean().optional(),
  week: z.union([z.number(), z.string()]).optional(),
  type: z.string().optional(),
  layout: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  reportAgentId: z.string().optional(),
  freePlay: z.string().optional(),
  store: z.string().optional(),
  sport: z.string().optional(),
  subsport: z.string().optional(),
  period: z.union([z.string(), z.number()]).optional(),
  wagerType: z.string().optional(),
  betType: z.string().optional(),
  tipo: z.union([z.string(), z.number()]).optional(),
  activity: z.union([z.string(), z.number()]).optional(),
  group: z.union([z.string(), z.number()]).optional(),
  debug: z.union([z.string(), z.number()]).optional(),
  agentOwner: z.string().optional(),
  all: z.union([z.boolean(), z.literal('1')]).optional(),
});

export type WebhookCreateBody = z.infer<typeof webhookCreateSchema>;
export type WebhookUpdateBody = z.infer<typeof webhookUpdateSchema>;
export type BuckeyeSessionBody = z.infer<typeof buckeyeSessionSchema>;
