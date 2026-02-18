import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/bank-data?connection_id=xxx
 *
 * Fetches bank_data CSV by connection_id using the service role key.
 * This bypasses RLS, which blocks the client-side anon key from reading
 * rows inserted by the callback handler (which has no user_id context).
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const connectionId = req.query.connection_id;
  const userId = req.query.user_id;
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
    // Also derive account_type from card_balances if not already set
    if (userId) {
      const { data: row } = await admin.from('bank_data')
        .select('card_balances, account_type')
        .eq('connection_id', connectionId)
        .single();

      const updates = { user_id: userId };
      if (!row?.account_type) {
        updates.account_type = (row?.card_balances && row.card_balances.length > 0) ? 'credit' : 'bank';
      }

      await admin.from('bank_data')
        .update(updates)
        .eq('connection_id', connectionId)
        .is('user_id', null);
    }

    return res.json({ success: true, csv_data: data.csv_data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
