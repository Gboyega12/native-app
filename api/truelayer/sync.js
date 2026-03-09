import { createClient } from '@supabase/supabase-js';

// Allow up to 60s for sync (Hobby plan max).
// Default 10s is too tight for token exchange + multiple TrueLayer API calls.
export const config = { maxDuration: 60 };

const IS_SANDBOX = (process.env.EXPO_PUBLIC_TRUELAYER_SANDBOX ?? 'false') === 'true';
const TL_AUTH_HOST = IS_SANDBOX ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com';
const TL_API_HOST = IS_SANDBOX ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';

/**
 * Sync a single TrueLayer connection: refresh token → fetch transactions + balances.
 * Returns { csv, balances, newRefreshToken } or null on failure.
 * On token exchange success but data fetch failure, returns { newRefreshToken }
 * so the caller can persist the rotated token even if data fetching fails.
 */
async function syncConnection(bankRow, clientId, clientSecret, admin) {
  let newRefreshToken = null;
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
      console.warn(`[sync] Token refresh failed for connection ${bankRow.connection_id}:`, tokenData.error || 'no access_token');
      return null;
    }

    // Persist the new refresh token IMMEDIATELY — before any data fetches.
    // TrueLayer tokens are single-use (rotating). The old token is consumed
    // the moment we exchange it. If we wait until after data fetches and
    // the function times out or crashes, the new token is lost forever and
    // the user must re-authenticate.
    newRefreshToken = tokenData.refresh_token || null;
    if (newRefreshToken && admin) {
      await admin.from('bank_data').update({ refresh_token: newRefreshToken }).eq('id', bankRow.id);
    }

    const headers = { Authorization: `Bearer ${tokenData.access_token}` };

    // Fetch accounts and cards with a single retry — some banks need a
    // moment after token refresh before data endpoints respond.
    let accountsRes, cardsRes, accountsJson, cardsJson;
    for (let attempt = 0; attempt < 2; attempt++) {
      [accountsRes, cardsRes] = await Promise.all([
        fetch(`${TL_API_HOST}/data/v1/accounts`, { headers }),
        fetch(`${TL_API_HOST}/data/v1/cards`, { headers }),
      ]);

      accountsJson = await accountsRes.json();
      cardsJson = await cardsRes.json();

      if (accountsRes.ok && cardsRes.ok) break;

      if (attempt === 0) {
        console.warn(`[sync] TrueLayer data endpoints failed (attempt 1) — accounts: ${accountsRes.status}, cards: ${cardsRes.status}. Retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Guard: if TrueLayer still returned errors after retry, bail out.
    // IMPORTANT: preserve the new refresh token so the caller can persist it —
    // returning null here would lose the rotated token permanently.
    if (!accountsRes.ok || !cardsRes.ok) {
      console.warn(`[sync] TrueLayer data endpoints returned errors after retry — accounts: ${accountsRes.status}, cards: ${cardsRes.status}`, {
        accountsError: accountsJson.error || null,
        cardsError: cardsJson.error || null,
      });
      return { csvLines: [], balances: [], newRefreshToken, txCount: 0, tokenOnlyRecovery: true };
    }

    const accounts = accountsJson.results || [];
    const cards = cardsJson.results || [];

    // Extract provider name from TrueLayer account/card data
    const providerName = accounts[0]?.provider?.display_name || cards[0]?.provider?.display_name || null;

    // Use tomorrow as the upper bound so TrueLayer includes all of today's transactions.
    // Date-only strings (e.g. "2026-03-09") are interpreted as start-of-day UTC,
    // which can exclude same-day transactions depending on the bank's timezone.
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + 1);
    const to = toDate.toISOString().split('T')[0];
    const fromDate = new Date();
    // Re-syncs only need 30 days of data (incremental update).
    // The initial 12-month pull happens in callback.js at connection time.
    fromDate.setDate(fromDate.getDate() - 30);
    const from = fromDate.toISOString().split('T')[0];

    const txPromises = [
      ...accounts.map((a) =>
        fetch(`${TL_API_HOST}/data/v1/accounts/${a.account_id}/transactions?from=${from}&to=${to}`, { headers })
          .then((r) => r.json())
          .catch((err) => { console.warn(`[sync] Transaction fetch failed for account ${a.account_id}:`, err.message); return { results: [] }; })
      ),
      ...cards.map((c) =>
        fetch(`${TL_API_HOST}/data/v1/cards/${c.account_id}/transactions?from=${from}&to=${to}`, { headers })
          .then((r) => r.json())
          .catch((err) => { console.warn(`[sync] Transaction fetch failed for card ${c.account_id}:`, err.message); return { results: [] }; })
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
      newRefreshToken,
      txCount: allTx.length,
      providerName,
    };
  } catch (err) {
    console.warn(`[sync] Connection ${bankRow.connection_id} failed:`, err.message);
    // If token exchange succeeded but data fetch failed, return the new
    // refresh token so it can still be persisted (old token is consumed).
    if (newRefreshToken) {
      return { csvLines: [], balances: [], newRefreshToken, txCount: 0, tokenOnlyRecovery: true };
    }
    return null;
  }
}

const CONSENT_DAYS = 90;
const WARN_DAYS = 14;

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

  // Authenticate the caller via Supabase JWT to prevent unauthenticated access
  const authHeader = req.headers.authorization || '';
  const authToken = authHeader.replace('Bearer ', '');
  if (!authToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseAnonKey) {
    const anonClient = createClient(supabaseUrl, supabaseAnonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(authToken);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    // Ensure the user can only sync their own data
    if (req.body?.user_id && req.body.user_id !== user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Use the authenticated user's ID
    req.body = { ...req.body, user_id: user.id };
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

  const svcUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!svcUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured', details: 'Missing Supabase credentials' });
  }

  const admin = createClient(svcUrl, serviceKey);

  try {
    // Find ALL TrueLayer connections for this user
    const { data: bankRows, error: findErr } = await admin
      .from('bank_data')
      .select('id, connection_id, refresh_token, updated_at, provider_name, created_at, csv_data')
      .eq('user_id', userId)
      .eq('source', 'truelayer')
      .not('refresh_token', 'is', null)
      .order('created_at', { ascending: false });

    if (findErr || !bankRows || bankRows.length === 0) {
      return res.json({ success: false, reason: 'no_connection' });
    }

    // Sync all connections in parallel
    const results = await Promise.all(
      bankRows.map((row) => syncConnection(row, clientId, clientSecret, admin).then((r) => ({ row, result: r })))
    );

    let mergedCsvLines = [];
    let mergedBalances = [];
    let totalTx = 0;
    let syncedCount = 0;
    let expiredConnections = [];

    for (const { row, result } of results) {
      // Refresh token is now persisted inside syncConnection() immediately
      // after token exchange, before data fetches — no need to do it here.

      if (!result || result.tokenOnlyRecovery) {
        // Only flag as expired if the 90-day consent window has actually lapsed.
        // Transient failures (network errors, TrueLayer outages) within the
        // consent window should NOT trigger the reconnect banner.
        // IMPORTANT: Use created_at (when consent was granted), NOT updated_at
        // (which advances on every sync and would shift the 90-day window).
        const created = new Date(row.created_at);
        if (!created || isNaN(created.getTime())) continue;
        const expiry = new Date(created);
        expiry.setDate(expiry.getDate() + CONSENT_DAYS);
        if (Date.now() >= expiry.getTime()) {
          // Use provider_name from DB, or from the sync result (backfill), or fallback
          const name = row.provider_name || result?.providerName || null;
          expiredConnections.push({ connection_id: row.connection_id, provider_name: name });
        }
        continue;
      }

      syncedCount++;
      mergedCsvLines.push(...result.csvLines);
      mergedBalances.push(...result.balances);
      totalTx += result.txCount;

      // Update each bank_data row individually with its own data.
      // Guard: never overwrite stored CSV with empty data — only write if
      // we actually got transactions back from TrueLayer.
      const updateFields = {
        updated_at: new Date().toISOString(),
      };
      if (result.csvLines.length > 0) {
        // Merge new transactions with existing stored CSV (incremental sync).
        // The new 30-day window overlaps with stored data, so deduplicate.
        const existingLines = [];
        if (row.csv_data) {
          const lines = row.csv_data.split('\n');
          existingLines.push(...lines.slice(1).filter((l) => l.trim()));
        }
        const allLines = [...existingLines, ...result.csvLines];
        const seen = new Set();
        const unique = [];
        for (const line of allLines) {
          const key = line.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ').trim();
          if (!seen.has(key)) {
            seen.add(key);
            unique.push(line);
          }
        }
        updateFields.csv_data = ['Date,Description,Amount', ...unique].join('\n');
      }
      if (result.balances.length > 0) {
        updateFields.card_balances = result.balances;
      }
      // Backfill provider_name if missing (older rows created before the column existed)
      if (!row.provider_name && result.providerName) {
        updateFields.provider_name = result.providerName;
      }
      // refresh_token is already persisted above (before data fetch guards)
      await admin.from('bank_data').update(updateFields).eq('id', row.id);
    }

    if (syncedCount === 0) {
      // If no connections are genuinely expired (past 90 days), this is a
      // transient failure — don't tell the client to show "Reconnect".
      const reason = expiredConnections.length > 0 ? 'token_expired' : 'sync_failed';
      return res.json({
        success: false,
        reason,
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
    // Use created_at (when consent was granted), not updated_at (which shifts with syncs).
    const expiringConnections = [];
    for (const row of bankRows) {
      const created = new Date(row.created_at);
      if (!created || isNaN(created.getTime())) continue;
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

    // Clean up duplicate connections for the same provider.
    // When a user reconnects a bank, a new row is created — the old expired row
    // should be removed so the reconnect banner doesn't keep reappearing.
    try {
      // Build a map of row.id → providerName, using syncConnection response
      // to fill in missing provider_name (backfill for old rows)
      const rowProviders = {};
      for (const { row, result } of results) {
        rowProviders[row.id] = row.provider_name || result?.providerName || null;
      }

      const providerGroups = {};
      for (const row of bankRows) {
        const key = rowProviders[row.id] || row.connection_id;
        if (!providerGroups[key]) providerGroups[key] = [];
        providerGroups[key].push(row);
      }
      for (const [provKey, rows] of Object.entries(providerGroups)) {
        if (rows.length <= 1) continue;
        // Keep the newest, delete the rest
        rows.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
        const staleIds = rows.slice(1).map((r) => r.id);
        if (staleIds.length > 0) {
          await admin.from('bank_data').delete().in('id', staleIds);
          console.log(`[sync] Cleaned up ${staleIds.length} stale connection(s) for provider ${provKey}`);
        }
      }
    } catch (cleanupErr) {
      console.warn('[sync] Non-critical: duplicate cleanup failed:', cleanupErr.message);
    }

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
