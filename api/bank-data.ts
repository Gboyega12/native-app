import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/bank-data?connection_id=xxx
 *
 * Fetches bank_data CSV by connection_id using the service role key.
 * This bypasses RLS, which blocks the client-side anon key from reading
 * rows inserted by the callback handler (which has no user_id context).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const connectionId = req.query.connection_id as string | undefined;
  const userId = req.query.user_id as string | undefined;
  if (!connectionId) {
    return res.status(400).json({ error: 'Missing connection_id' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  try {
    const admin = createClient(supabaseUrl, serviceKey);
    const { data, error } = await admin
      .from('bank_data')
      .select('csv_data')
      .eq('connection_id', connectionId)
      .single();

    if (error || !data?.csv_data) {
      return res.status(404).json({
        error: 'No bank data found',
        details: error?.message,
      });
    }

    // Claim the row for this user so sync can find it later
    if (userId) {
      await admin.from('bank_data')
        .update({ user_id: userId })
        .eq('connection_id', connectionId)
        .is('user_id', null);

      // Best-effort: derive account_type from card_balances if column exists
      try {
        const { data: row } = await admin.from('bank_data')
          .select('card_balances, account_type, provider_name')
          .eq('connection_id', connectionId)
          .single();

        if (row && !row.account_type) {
          const cardBalances = row.card_balances as unknown[] | null;
          const derived = (cardBalances && cardBalances.length > 0) ? 'credit' : 'bank';
          await admin.from('bank_data')
            .update({ account_type: derived })
            .eq('connection_id', connectionId);
        }

        // Clean up old connections for the same provider.
        if (row?.provider_name) {
          await admin
            .from('bank_data')
            .delete()
            .eq('user_id', userId)
            .eq('source', 'truelayer')
            .eq('provider_name', row.provider_name)
            .neq('connection_id', connectionId);
        }
      } catch (derivErr: unknown) {
        const message = derivErr instanceof Error ? derivErr.message : String(derivErr);
        console.warn('[bank-data] Non-critical: account_type derivation or cleanup failed:', message);
      }
    }

    return res.json({ success: true, csv_data: data.csv_data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}
