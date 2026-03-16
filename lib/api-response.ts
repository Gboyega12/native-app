// ── Standardized API response helpers ──
// Ensures all API endpoints return a consistent envelope shape.

import type { VercelResponse } from '@vercel/node';

interface SuccessResponse {
  success: true;
  [key: string]: unknown;
}

interface ErrorResponse {
  success: false;
  error: string;
  details?: unknown;
}

/** Send a standardized success response */
export function apiSuccess(res: VercelResponse, data: Record<string, unknown> = {}, status = 200): void {
  const body: SuccessResponse = { success: true, ...data };
  res.status(status).json(body);
}

/** Send a standardized error response */
export function apiError(res: VercelResponse, status: number, error: string, details?: unknown): void {
  const body: ErrorResponse = { success: false, error };
  if (details !== undefined) body.details = details;
  res.status(status).json(body);
}

/** Standard method check — returns true if method is NOT allowed (caller should return early) */
export function methodNotAllowed(res: VercelResponse, method: string | undefined, allowed: string): boolean {
  if (method !== allowed) {
    apiError(res, 405, 'Method not allowed');
    return true;
  }
  return false;
}
