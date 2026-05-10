/**
 * Zod-based request validation helpers.
 */
import { z, ZodError, ZodSchema } from 'zod';

export function validateQuery<T>(schema: ZodSchema<T>, url: URL): T {
  const obj: Record<string, unknown> = {};
  url.searchParams.forEach((value, key) => {
    obj[key] = value;
  });
  return schema.parse(obj);
}

export async function validateBody<T>(schema: ZodSchema<T>, request: Request): Promise<T> {
  const body = await request.json().catch(() => ({}));
  return schema.parse(body);
}

export function formatZodError(error: ZodError): { error: string; details: Array<{ field: string; message: string }> } {
  return {
    error: 'Validation failed',
    details: error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

// Common schemas
export const webLogQuerySchema = z.object({
  agentId: z.string().optional(),
  customerId: z.string().optional(),
  start: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'start must be MM/DD/YYYY'),
  end: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'end must be MM/DD/YYYY'),
  type: z.enum(['A', 'B', 'C', 'I']).default('A'),
  actions: z.enum(['A', 'B', 'C', 'I', 'ALL']).default('A'),
  ip: z.string().optional(),
});

export const connectBodySchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
  password: z.string().min(1, 'password is required'),
  baseUrl: z.string().url().optional(),
  cfCookie: z.string().optional(),
});
