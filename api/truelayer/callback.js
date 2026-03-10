import { createClient } from '@supabase/supabase-js';

// Allow up to 60s for the callback to process (Hobby plan max).
// The default 10s is too tight for token exchange + multiple TrueLayer API calls.
export const config = { maxDuration: 60 };

// TrueLayer sandbox vs live – must match the frontend setting
const IS_SANDBOX = (process.env.EXPO_PUBLIC_TRUELAYER_SANDBOX ?? 'false') === 'true';
const TL_AUTH_HOST = IS_SANDBOX ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com';
const TL_API_HOST = IS_SANDBOX ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';

export default async function handler(req, res) {
  // Accept both GET (server redirect from TrueLayer) and POST (client-initiated)
  let code, connectionId, webOrigin;

  let postUserId;

  if (req.method === 'POST') {
    code = req.body?.code;
    postUserId = req.body?.user_id || null;
    const state = req.body?.state || '';
    const pipeIdx = state.indexOf('|');
    connectionId = pipeIdx === -1 ? state : state.slice(0, pipeIdx);
  } else if (req.method === 'GET') {
    code = req.query.code;
    const state = req.query.state || '';
    const pipeIdx = state.indexOf('|');
    connectionId = pipeIdx === -1 ? state : state.slice(0, pipeIdx);
    webOrigin = pipeIdx === -1 ? null : state.slice(pipeIdx + 1);
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Helper: for GET requests, redirect errors back to the app instead of returning JSON.
  // Without this, the popup/browser shows raw JSON and the user sees a blank screen.
  const fail = (status, error, details) => {
    if (req.method === 'GET' && webOrigin) {
      const errMsg = encodeURIComponent(details ? `${error}: ${details}` : error);
      return res.redirect(302, `${webOrigin}/connect?status=error&error=${errMsg}`);
    }
    return res.status(status).json({ error, details });
  };

  if (!code) return fail(400, 'Missing authorization code');
  if (!connectionId) return fail(400, 'Missing connection_id (state)');

  const redirectUri =
    process.env.TRUELAYER_REDIRECT_URI ||
    process.env.EXPO_PUBLIC_TRUELAYER_REDIRECT_URI ||
    'https://app.bocy.io/api/truelayer/callback';

  const clientId = process.env.TRUELAYER_CLIENT_ID;
  const clientSecret = process.env.TRUELAYER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return fail(500, 'Server misconfigured', 'TRUELAYER_CLIENT_ID or TRUELAYER_CLIENT_SECRET not set');
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch(`${TL_AUTH_HOST}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Token exchange failed:', JSON.stringify({
        status: tokenRes.status,
        redirect_uri_used: redirectUri,
        response: tokenData,
      }));
      return fail(400, 'Token exchange failed', tokenData.error_description || tokenData.error || 'Invalid authorization code');
    }

    const token = tokenData.access_token;
    const headers = { Authorization: `Bearer ${token}` };

    // Date range: last 12 months. Use tomorrow as upper bound so TrueLayer
    // includes all of today's transactions regardless of timezone.
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + 1);
    const to = toDate.toISOString().split('T')[0];
    const fromDate = new Date();
    fromDate.setFullYear(fromDate.getFullYear() - 1);
    const from = fromDate.toISOString().split('T')[0];

    // Fetch accounts, cards, and transactions — with retry.
    // After initial authorization, TrueLayer may need a few seconds to
    // propagate consent before data endpoints return results. Retry up to
    // 2 times with a 5s delay if we get 0 transactions.
    let accounts = [];
    let cards = [];
    let allTx = [];
    let cardBalanceResults = [];
    let accountBalanceResults = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        console.log(`[truelayer] Retry ${attempt}/2 — waiting 5s for data to propagate...`);
        await new Promise((r) => setTimeout(r, 5000));
      }

      const [accountsRes, cardsRes] = await Promise.all([
        fetch(`${TL_API_HOST}/data/v1/accounts`, { headers }),
        fetch(`${TL_API_HOST}/data/v1/cards`, { headers }),
      ]);
      const accountsData = await accountsRes.json();
      const cardsData = await cardsRes.json();

      accounts = accountsData.results || [];
      cards = cardsData.results || [];

      // Fetch transactions + card balances in parallel
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

      const [txResults, cbResults, abResults] = await Promise.all([
        Promise.all(txPromises),
        Promise.all(cardBalancePromises),
        Promise.all(accountBalancePromises),
      ]);
      allTx = txResults.flatMap((r) => r.results || []);
      cardBalanceResults = cbResults;
      accountBalanceResults = abResults;

      if (allTx.length > 0) break; // Got transactions — stop retrying

      console.warn(`[truelayer] Attempt ${attempt + 1}: 0 transactions. Accounts: ${accounts.length}, Cards: ${cards.length}`);
      // If no accounts/cards at all, don't retry — the consent may not include data access
      if (accounts.length === 0 && cards.length === 0) break;
    }

    // Convert to CSV
    const csvLines = ['Date,Description,Amount'];
    for (const tx of allTx) {
      const date = tx.timestamp ? tx.timestamp.split('T')[0] : '';
      const desc = (tx.merchant_name || tx.description || '').replace(/,/g, ' ').replace(/[\r\n]+/g, ' ');
      const amount = tx.transaction_type === 'CREDIT' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      csvLines.push(`${date},${desc},${amount}`);
    }
    const csv = csvLines.join('\n');

    // Save CSV to Supabase bank_data table (using service role to bypass RLS)
    const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      console.error('Missing Supabase config:', { supabaseUrl: !!supabaseUrl, serviceKey: !!serviceKey });
      return fail(500, 'Server misconfigured', 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // Determine account type and provider name from TrueLayer data
    const providerName = accounts[0]?.provider?.display_name || cards[0]?.provider?.display_name || null;
    const accountType = accounts.length > 0 && cards.length === 0 ? 'bank'
      : cards.length > 0 && accounts.length === 0 ? 'credit'
      : accounts.length > 0 ? 'bank' : null;

    // Insert bank data row with all available fields
    const insertRow = {
      connection_id: connectionId,
      csv_data: csv,
      source: 'truelayer',
      refresh_token: tokenData.refresh_token || null,
    };
    if (postUserId) insertRow.user_id = postUserId;
    if (providerName) insertRow.provider_name = providerName;
    if (accountType) insertRow.account_type = accountType;

    const { error: dbError } = await admin.from('bank_data').insert(insertRow);

    if (dbError) {
      console.error('Failed to save bank data:', dbError);
      return fail(500, 'Failed to save bank data', dbError.message || dbError.code);
    }

    // Clean up old connections for the same provider and user.
    // Without this, reconnecting a bank creates a duplicate row while the
    // old expired row persists — causing the reconnect banner to reappear
    // even though the user just reconnected successfully.
    if (postUserId) {
      try {
        // Build the cleanup query with all required filters in a single chain.
        // Supabase query builder is immutable — .eq() returns a NEW object,
        // so conditional chaining via variable reassignment doesn't work.
        if (providerName) {
          await admin
            .from('bank_data')
            .delete()
            .eq('user_id', postUserId)
            .eq('source', 'truelayer')
            .eq('provider_name', providerName)
            .neq('connection_id', connectionId);
        } else if (accountType) {
          await admin
            .from('bank_data')
            .delete()
            .eq('user_id', postUserId)
            .eq('source', 'truelayer')
            .eq('account_type', accountType)
            .neq('connection_id', connectionId);
        }
        // If neither providerName nor accountType is known, skip cleanup
        // to avoid deleting unrelated connections.
      } catch (cleanupErr) {
        console.warn('[callback] Non-critical: old connection cleanup failed:', cleanupErr.message);
      }
    }


    // Store card + account balances on bank_data row (best-effort, non-blocking)
    // Processing step will read these and upsert into debt_accounts with user_id
    try {
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
          // Only include accounts with debt exposure (overdraft facility or negative balance)
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

      const allBalances = [...cardBalances, ...accountBalances];

      if (allBalances.length > 0) {
        console.log('[callback] Balances:', JSON.stringify(allBalances));
        await admin.from('bank_data')
          .update({ card_balances: allBalances })
          .eq('connection_id', connectionId);
      }
    } catch (debtErr) {
      console.warn('[callback] Non-critical: balance save failed:', debtErr.message);
    }

    // POST → return JSON to the client
    if (req.method === 'POST') {
      return res.json({
        success: true,
        connection_id: connectionId,
        accounts_found: accounts.length,
        cards_found: cards.length,
        transactions_found: allTx.length,
      });
    }

    // GET → redirect back to app
    if (webOrigin) {
      return res.redirect(302, `${webOrigin}/connect?connection_id=${encodeURIComponent(connectionId)}&status=success`);
    }
    return res.redirect(302, `bocy://callback?connection_id=${connectionId}&status=success`);
  } catch (err) {
    console.error('Callback error:', err);
    return fail(500, 'Unexpected error', err.message);
  }
}
