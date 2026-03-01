// ── Automated Bank Sync Cron Job ──
// Runs every 6 hours (via Vercel Cron).
// Proactively refreshes TrueLayer access tokens and fetches fresh
// transactions for all connected users, so data is always up-to-date
// without requiring users to manually open the app.
//
// This solves the problem where TrueLayer connections appear "stale"
// because the token refresh only happened on app open. By running
// server-side, tokens stay warm and data stays fresh.

import { createClient } from '@supabase/supabase-js';

const IS_SANDBOX = (process.env.EXPO_PUBLIC_TRUELAYER_SANDBOX ?? 'false') === 'true';
const TL_AUTH_HOST = IS_SANDBOX ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com';
const TL_API_HOST = IS_SANDBOX ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Refresh a single TrueLayer connection: refresh token → fetch transactions + balances.
 * Returns updated data or null on failure.
 */
async function refreshConnection(bankRow, clientId, clientSecret) {
  try {
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
      return { success: false, expired: true };
    }

    const headers = { Authorization: `Bearer ${tokenData.access_token}` };

    const [accountsRes, cardsRes] = await Promise.all([
      fetch(`${TL_API_HOST}/data/v1/accounts`, { headers }),
      fetch(`${TL_API_HOST}/data/v1/cards`, { headers }),
    ]);
    const accounts = (await accountsRes.json()).results || [];
    const cards = (await cardsRes.json()).results || [];

    const to = new Date().toISOString().split('T')[0];
    const fromDate = new Date();
    fromDate.setFullYear(fromDate.getFullYear() - 1);
    const from = fromDate.toISOString().split('T')[0];

    const txPromises = [
      ...accounts.map((a) =>
        fetch(`${TL_API_HOST}/data/v1/accounts/${a.account_id}/transactions?from=${from}&to=${to}`, { headers }).then((r) => r.json())
      ),
      ...cards.map((c) =>
        fetch(`${TL_API_HOST}/data/v1/cards/${c.account_id}/transactions?from=${from}&to=${to}`, { headers }).then((r) => r.json())
      ),
    ];

    const cardBalancePromises = cards.map((c) =>
      fetch(`${TL_API_HOST}/data/v1/cards/${c.account_id}/balance`, { headers })
        .then((r) => r.json())
        .then((data) => ({ card: c, balance: (data.results || [])[0] || null }))
        .catch(() => ({ card: c, balance: null }))
    );

    const [txResults, cardBalanceResults] = await Promise.all([
      Promise.all(txPromises),
      Promise.all(cardBalancePromises),
    ]);
    const allTx = txResults.flatMap((r) => r.results || []);

    const csvLines = [];
    for (const tx of allTx) {
      const date = tx.timestamp ? tx.timestamp.split('T')[0] : '';
      const desc = (tx.merchant_name || tx.description || '').replace(/,/g, ' ');
      const amount = tx.transaction_type === 'CREDIT' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      csvLines.push(`${date},${desc},${amount}`);
    }

    const cardBalances = cardBalanceResults
      .filter((r) => r.balance)
      .map((r) => ({
        name: r.card.display_name || r.card.provider?.display_name || 'Card',
        type: 'credit_card',
        balance: r.balance.current != null ? Math.abs(r.balance.current) : null,
        limit: r.balance.credit_limit || null,
        available: r.balance.available || null,
      }));

    return {
      success: true,
      csvLines,
      cardBalances,
      newRefreshToken: tokenData.refresh_token || null,
      txCount: allTx.length,
    };
  } catch (err) {
    console.warn(`[bank-sync] Connection ${bankRow.connection_id} failed:`, err.message);
    return { success: false, expired: false };
  }
}

export default async function handler(req, res) {
  // Verify cron secret
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!serviceKey) {
    return res.json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const clientId = process.env.TRUELAYER_CLIENT_ID;
  const clientSecret = process.env.TRUELAYER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.json({ success: false, error: 'TrueLayer credentials not configured' });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const results = { refreshed: 0, failed: 0, expired: 0, total: 0 };

  try {
    // Get all TrueLayer connections with valid refresh tokens
    const { data: bankRows, error: fetchErr } = await admin
      .from('bank_data')
      .select('id, connection_id, refresh_token, user_id, provider_name, created_at, updated_at')
      .eq('source', 'truelayer')
      .not('refresh_token', 'is', null)
      .order('updated_at', { ascending: true }); // Oldest first — prioritize stale data

    if (fetchErr || !bankRows || bankRows.length === 0) {
      return res.json({ success: true, message: 'No connections to refresh', ...results });
    }

    results.total = bankRows.length;

    // Process connections in batches of 5 to avoid overwhelming TrueLayer
    const BATCH_SIZE = 5;
    for (let i = 0; i < bankRows.length; i += BATCH_SIZE) {
      const batch = bankRows.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (row) => {
          // Skip connections past the 90-day consent window — they need manual re-auth
          const created = new Date(row.created_at || row.updated_at);
          const expiry = new Date(created);
          expiry.setDate(expiry.getDate() + 90);
          if (Date.now() >= expiry.getTime()) {
            return { row, result: { success: false, expired: true } };
          }

          const result = await refreshConnection(row, clientId, clientSecret);
          return { row, result };
        })
      );

      for (const { row, result } of batchResults) {
        if (!result.success) {
          if (result.expired) {
            results.expired++;
          } else {
            results.failed++;
          }
          continue;
        }

        results.refreshed++;

        // Update the bank_data row with fresh data
        const updateFields = {
          csv_data: ['Date,Description,Amount', ...result.csvLines].join('\n'),
          updated_at: new Date().toISOString(),
        };
        if (result.cardBalances && result.cardBalances.length > 0) {
          updateFields.card_balances = result.cardBalances;
        }
        if (result.newRefreshToken) {
          updateFields.refresh_token = result.newRefreshToken;
        }

        await admin.from('bank_data').update(updateFields).eq('id', row.id);
      }
    }

    console.log(`[bank-sync] Refreshed ${results.refreshed}/${results.total} connections (${results.expired} expired, ${results.failed} failed)`);
    return res.json({ success: true, ...results });
  } catch (err) {
    console.error('[bank-sync] Cron failed:', err?.message);
    return res.status(500).json({ success: false, error: err?.message });
  }
}
