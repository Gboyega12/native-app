import { createClient } from '@supabase/supabase-js';

const IS_SANDBOX = (process.env.EXPO_PUBLIC_TRUELAYER_SANDBOX ?? 'false') === 'true';
const TL_AUTH_HOST = IS_SANDBOX ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com';
const TL_API_HOST = IS_SANDBOX ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';

/**
 * POST /api/truelayer/sync
 * Body: { user_id }
 *
 * Uses the stored refresh_token to fetch the latest transactions from TrueLayer,
 * updates the csv_data in bank_data, and returns the new CSV.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const userId = req.body?.user_id;
  if (!userId) {
    return res.status(400).json({ error: 'Missing user_id' });
  }

  const clientId = process.env.TRUELAYER_CLIENT_ID;
  const clientSecret = process.env.TRUELAYER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Server misconfigured', details: 'Missing TrueLayer credentials' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured', details: 'Missing Supabase credentials' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  try {
    // Find the user's most recent TrueLayer bank_data with a refresh_token
    const { data: bankRow, error: findErr } = await admin
      .from('bank_data')
      .select('id, connection_id, refresh_token, updated_at')
      .eq('user_id', userId)
      .eq('source', 'truelayer')
      .not('refresh_token', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (findErr || !bankRow?.refresh_token) {
      return res.json({ success: false, reason: 'no_connection' });
    }

    // Use refresh_token to get a new access_token
    const tokenRes = await fetch(`${TL_AUTH_HOST}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: bankRow.refresh_token,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      // Refresh token expired or revoked — user needs to re-connect
      return res.json({ success: false, reason: 'token_expired' });
    }

    const token = tokenData.access_token;
    const headers = { Authorization: `Bearer ${token}` };

    // Fetch accounts and cards
    const [accountsRes, cardsRes] = await Promise.all([
      fetch(`${TL_API_HOST}/data/v1/accounts`, { headers }),
      fetch(`${TL_API_HOST}/data/v1/cards`, { headers }),
    ]);
    const accountsData = await accountsRes.json();
    const cardsData = await cardsRes.json();

    const accounts = accountsData.results || [];
    const cards = cardsData.results || [];

    // Date range: last 12 months
    const to = new Date().toISOString().split('T')[0];
    const fromDate = new Date();
    fromDate.setFullYear(fromDate.getFullYear() - 1);
    const from = fromDate.toISOString().split('T')[0];

    // Fetch all transactions
    const txPromises = [
      ...accounts.map((a) =>
        fetch(`${TL_API_HOST}/data/v1/accounts/${a.account_id}/transactions?from=${from}&to=${to}`, { headers }).then((r) => r.json())
      ),
      ...cards.map((c) =>
        fetch(`${TL_API_HOST}/data/v1/cards/${c.account_id}/transactions?from=${from}&to=${to}`, { headers }).then((r) => r.json())
      ),
    ];

    const txResults = await Promise.all(txPromises);
    const allTx = txResults.flatMap((r) => r.results || []);

    // Convert to CSV
    const csvLines = ['Date,Description,Amount'];
    for (const tx of allTx) {
      const date = tx.timestamp ? tx.timestamp.split('T')[0] : '';
      const desc = (tx.merchant_name || tx.description || '').replace(/,/g, ' ');
      const amount = tx.transaction_type === 'CREDIT' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      csvLines.push(`${date},${desc},${amount}`);
    }
    const csv = csvLines.join('\n');

    // Update bank_data with fresh CSV and new refresh_token
    const updateFields = {
      csv_data: csv,
      updated_at: new Date().toISOString(),
    };
    // Store the new refresh_token if one was issued
    if (tokenData.refresh_token) {
      updateFields.refresh_token = tokenData.refresh_token;
    }

    await admin.from('bank_data')
      .update(updateFields)
      .eq('id', bankRow.id);

    return res.json({
      success: true,
      csv_data: csv,
      transactions_found: allTx.length,
      updated_at: updateFields.updated_at,
    });
  } catch (err) {
    console.error('[sync] Error:', err);
    return res.status(500).json({ error: 'Sync failed', details: err.message });
  }
}
