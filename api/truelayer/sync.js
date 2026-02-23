import { createClient } from '@supabase/supabase-js';

const IS_SANDBOX = (process.env.EXPO_PUBLIC_TRUELAYER_SANDBOX ?? 'false') === 'true';
const TL_AUTH_HOST = IS_SANDBOX ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com';
const TL_API_HOST = IS_SANDBOX ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';

/**
 * Sync a single TrueLayer connection: refresh token → fetch transactions + balances.
 * Returns { csv, balances, newRefreshToken } or null on failure.
 */
async function syncConnection(bankRow, clientId, clientSecret) {
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
      console.warn(`[sync] Token expired for connection ${bankRow.connection_id}`);
      return null;
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
    const accountBalancePromises = accounts.map((a) =>
      fetch(`${TL_API_HOST}/data/v1/accounts/${a.account_id}/balance`, { headers })
        .then((r) => r.json())
        .then((data) => ({ account: a, balance: (data.results || [])[0] || null }))
        .catch(() => ({ account: a, balance: null }))
    );

    const [txResults, cardBalanceResults, accountBalanceResults] = await Promise.all([
      Promise.all(txPromises),
      Promise.all(cardBalancePromises),
      Promise.all(accountBalancePromises),
    ]);
    const allTx = txResults.flatMap((r) => r.results || []);

    // Convert to CSV lines (without header)
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

    const accountBalances = accountBalanceResults
      .filter((r) => r.balance)
      .map((r) => {
        const bal = r.balance;
        const hasOverdraft = bal.overdraft != null && bal.overdraft > 0;
        const isOverdrawn = bal.current != null && bal.current < 0;
        if (!hasOverdraft && !isOverdrawn) return null;
        return {
          name: r.account.display_name || r.account.provider?.display_name || 'Account',
          type: isOverdrawn ? 'overdraft' : 'overdraft_facility',
          balance: isOverdrawn ? Math.abs(bal.current) : 0,
          limit: bal.overdraft || null,
          available: bal.available || null,
        };
      })
      .filter(Boolean);

    return {
      csvLines,
      balances: [...cardBalances, ...accountBalances],
      newRefreshToken: tokenData.refresh_token || null,
      txCount: allTx.length,
    };
  } catch (err) {
    console.warn(`[sync] Connection ${bankRow.connection_id} failed:`, err.message);
    return null;
  }
}

/**
 * POST /api/truelayer/sync
 * Body: { user_id }
 *
 * Syncs ALL connected bank accounts for a user, merges transactions and
 * balances, and returns the combined CSV.
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
    // Find ALL TrueLayer connections for this user
    const { data: bankRows, error: findErr } = await admin
      .from('bank_data')
      .select('id, connection_id, refresh_token, updated_at, provider_name, created_at')
      .eq('user_id', userId)
      .eq('source', 'truelayer')
      .not('refresh_token', 'is', null)
      .order('created_at', { ascending: false });

    if (findErr || !bankRows || bankRows.length === 0) {
      return res.json({ success: false, reason: 'no_connection' });
    }

    // Sync all connections in parallel
    const results = await Promise.all(
      bankRows.map((row) => syncConnection(row, clientId, clientSecret).then((r) => ({ row, result: r })))
    );

    let mergedCsvLines = [];
    let mergedBalances = [];
    let totalTx = 0;
    let syncedCount = 0;
    let expiredConnections = [];

    for (const { row, result } of results) {
      if (!result) {
        expiredConnections.push({ connection_id: row.connection_id, provider_name: row.provider_name || null });
        continue;
      }

      syncedCount++;
      mergedCsvLines.push(...result.csvLines);
      mergedBalances.push(...result.balances);
      totalTx += result.txCount;

      // Update each bank_data row individually with its own data
      const updateFields = {
        csv_data: ['Date,Description,Amount', ...result.csvLines].join('\n'),
        updated_at: new Date().toISOString(),
      };
      if (result.balances.length > 0) {
        updateFields.card_balances = result.balances;
      }
      if (result.newRefreshToken) {
        updateFields.refresh_token = result.newRefreshToken;
      }
      await admin.from('bank_data').update(updateFields).eq('id', row.id);
    }

    if (syncedCount === 0) {
      return res.json({
        success: false,
        reason: 'token_expired',
        expired_connections: expiredConnections.length > 0 ? expiredConnections : undefined,
      });
    }

    // Deduplicate transactions across connections (same date+amount+desc = same tx)
    const seenKeys = new Set();
    const uniqueLines = [];
    for (const line of mergedCsvLines) {
      const key = line.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ').trim();
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        uniqueLines.push(line);
      }
    }

    // Return merged CSV across all connections
    const mergedCsv = ['Date,Description,Amount', ...uniqueLines].join('\n');

    // Check for connections approaching 90-day consent expiry (warn at 14 days)
    const CONSENT_DAYS = 90;
    const WARN_DAYS = 14;
    const expiringConnections = [];
    for (const row of bankRows) {
      const created = new Date(row.created_at || row.updated_at);
      const expiry = new Date(created);
      expiry.setDate(expiry.getDate() + CONSENT_DAYS);
      const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysLeft <= WARN_DAYS && daysLeft > 0) {
        expiringConnections.push({
          provider_name: row.provider_name || null,
          days_left: daysLeft,
        });
      }
    }

    console.log(`[sync] Synced ${syncedCount}/${bankRows.length} connections, ${totalTx} transactions, ${mergedBalances.length} balance(s)`);

    return res.json({
      success: true,
      csv_data: mergedCsv,
      transactions_found: totalTx,
      balances_found: mergedBalances.length,
      connections_synced: syncedCount,
      connections_total: bankRows.length,
      expired_connections: expiredConnections.length > 0 ? expiredConnections : undefined,
      expiring_connections: expiringConnections.length > 0 ? expiringConnections : undefined,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[sync] Error:', err);
    return res.status(500).json({ error: 'Sync failed', details: err.message });
  }
}
