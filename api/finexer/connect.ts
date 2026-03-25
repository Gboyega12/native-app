import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { apiSuccess, apiError, methodNotAllowed } from '../../lib/api-response.js';
import { createCustomer, createConsent } from '../../lib/finexer.js';

const bodySchema = z.object({
  connection_id: z.string(),
  user_id: z.string(),
  email: z.string().email(),
  name: z.string(),
});

/**
 * POST /api/finexer/connect
 *
 * Creates a Finexer customer (or reuses existing) and consent.
 * Returns the consent_url for the user to authorize at their bank.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (methodNotAllowed(res, req.method, 'POST')) return;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiError(res, 400, 'Invalid request', parsed.error.flatten().fieldErrors);
  }

  const { connection_id: connectionId, user_id: userId, email, name } = parsed.data;

  const apiKey = process.env.FINEXER_API_KEY;
  const redirectUri = process.env.FINEXER_REDIRECT_URI || process.env.EXPO_PUBLIC_FINEXER_REDIRECT_URI || 'https://app.bocy.io/api/finexer/callback';
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey) return apiError(res, 500, 'Server misconfigured: FINEXER_API_KEY not set');
  if (!supabaseUrl || !serviceKey) return apiError(res, 500, 'Server misconfigured: Supabase credentials not set');
  if (!redirectUri.startsWith('https://')) return apiError(res, 500, 'FINEXER_REDIRECT_URI must be a public HTTPS URL');

  try {
    const admin = createClient(supabaseUrl, serviceKey);

    // Check if user already has a Finexer customer ID from a previous connection
    let customerId: string | null = null;
    const { data: existingRows } = await admin
      .from('bank_data')
      .select('finexer_customer_id')
      .eq('user_id', userId)
      .eq('source', 'finexer')
      .not('finexer_customer_id', 'is', null)
      .limit(1);

    if (existingRows?.[0]?.finexer_customer_id) {
      customerId = existingRows[0].finexer_customer_id;
    }

    // Create customer if we don't have one
    if (!customerId) {
      const customer = await createCustomer(apiKey, name, email);
      customerId = customer.id;
    }

    // 12 months of transaction history
    const retroDate = new Date();
    retroDate.setFullYear(retroDate.getFullYear() - 1);
    const retroDateStr = retroDate.toISOString().split('T')[0];

    // Encode connection_id + web origin in return_url for callback routing.
    // Finexer requires the entire return_url (including query params) to be
    // publicly accessible HTTPS, so strip non-HTTPS origins to avoid rejection.
    const rawOrigin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || '';
    const webOrigin = rawOrigin.startsWith('https://') ? rawOrigin : '';
    const returnUrl = `${redirectUri}?connection_id=${encodeURIComponent(connectionId)}${webOrigin ? `&origin=${encodeURIComponent(webOrigin)}` : ''}`;

    const consent = await createConsent(apiKey, {
      customer: customerId,
      return_url: returnUrl,
      scopes: ['accounts', 'balance', 'transactions'],
      retro_date: retroDateStr,
      metadata: {
        connection_id: connectionId,
        user_id: userId,
      },
    });

    if (!consent.redirect?.consent_url) {
      return apiError(res, 500, 'Consent created but no redirect URL returned');
    }

    // Pre-create bank_data row so callback can update it
    await admin.from('bank_data').insert({
      connection_id: connectionId,
      user_id: userId,
      source: 'finexer',
      csv_data: '',
      consent_id: consent.id,
      finexer_customer_id: customerId,
    });

    return apiSuccess(res, {
      consent_url: consent.redirect.consent_url,
      consent_id: consent.id,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[finexer/connect] Error:', message);
    return apiError(res, 500, message || 'Failed to create bank connection');
  }
}
