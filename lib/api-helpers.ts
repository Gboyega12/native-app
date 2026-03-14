import { z } from 'zod';
import type { VercelResponse } from '@vercel/node';

/**
 * Parse a request body against a Zod schema.
 * Returns parsed data or throws a structured error.
 */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const error = new Error('Invalid request') as Error & { status: number; details: Record<string, string[]> };
    error.status = 400;
    error.details = result.error.flatten().fieldErrors as Record<string, string[]>;
    throw error;
  }
  return result.data;
}

/**
 * Send a standardised error response.
 */
export function apiError(res: VercelResponse, status: number, message: string) {
  return res.status(status).json({ success: false, error: message });
}

/**
 * Send a standardised success response.
 */
export function apiSuccess(res: VercelResponse, data: Record<string, unknown> = {}) {
  return res.json({ success: true, ...data });
}
