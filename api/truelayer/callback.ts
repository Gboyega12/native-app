import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const postBodySchema = z.object({
  code: z.string().optional(),
  user_id: z.string().optional(),
  state: z.string().optional(),
});

const getQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
});

// Allow up to 60s for the callback to process (Hobby plan max).
// The default 10s is too tight for token exchange + multiple TrueLayer API calls.
export const config = { maxDuration: 60 };

// TrueLayer sandbox vs live – must match the frontend setting
const IS_SANDBOX = (process.env.EXPO_PUBLIC_TRUELAYER_SANDBOX ?? 'false') === 'true';
const TL_AUTH_HOST = IS_SANDBOX ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com';
const TL_API_HOST = IS_SANDBOX ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';

// Allowed redirect origins — prevents open redirect via state parameter
const ALLOWED_ORIGINS = new Set([
  'https://app.bocy.io',
  ...(process.env.APP_URL ? [process.env.APP_URL] : []),
  ...(IS_SANDBOX ? ['http://localhost:8081', 'http://localhost:19006'] : []),
]);

interface TLAccount {
  account_id: string;
  display_name?: string;
  account_type?: string;
  provider?: { display_name?: string };
}

interface TLCard {
  account_id: string;
  display_name?: string;
  card_network?: string;
  provider?: { display_name?: string };
}

interface TLTransaction {
  timestamp?: string;
  merchant_name?: string;
  description?: string;
  transaction_type?: string;
  amount: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Accept both GET (server redirect from TrueLayer) and POST (client-initiated)
  let code: string | undefined;
  let connectionId: string;
  let webOrigin: string | null = null;
  let postUserId: string | null = null;

  if (req.method === 'POST') {
    const parsed = postBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }
    code = parsed.data.code;
    postUserId = parsed.data.user_id || null;
    const state: string = parsed.data.state || '';
    const pipeIdx = state.indexOf('|');
    connectionId = pipeIdx === -1 ? state : state.slice(0, pipeIdx);
  } else if (req.method === 'GET') {
    const parsed = getQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }
    code = parsed.data.code;
    const state: string = parsed.data.state || '';
    const pipeIdx = state.indexOf('|');
    connectionId = pipeIdx === -1 ? state : state.slice(0, pipeIdx);
    const rawOrigin = pipeIdx === -1 ? null : state.slice(pipeIdx + 1);
    webOrigin = rawOrigin && ALLOWED_ORIGINS.has(rawOrigin) ? rawOrigin : null;
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Helper: for GET requests, redirect errors back to the app instead of returning JSON.
  const fail = (status: number, error: string, details?: string) => {
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

    // Fetch accounts and cards
    const [accountsRes, cardsRes] = await Promise.all([
      fetch(`${TL_API_HOST}/data/v1/accounts`, { headers }),
      fetch(`${TL_API_HOST}/data/v1/cards`, { headers }),
    ]);

    if (!accountsRes.ok || !cardsRes.ok) {
      console.error('[callback] TrueLayer accounts/cards HTTP error:', {
        accounts: { status: accountsRes.status, statusText: accountsRes.statusText },
        cards: { status: cardsRes.status, statusText: cardsRes.statusText },
      });
    }

    const accountsData = await accountsRes.json();
    const cardsData = await cardsRes.json();

    const accounts: TLAccount[] = accountsData.results || [];
    const cards: TLCard[] = cardsData.results || [];

    if (!accountsData.results && accountsData.error) {
      console.error('[callback] TrueLayer accounts error:', JSON.stringify(accountsData));
    }
    if (!cardsData.results && cardsData.error) {
      console.error('[callback] TrueLayer cards error:', JSON.stringify(cardsData));
    }

    console.log(`[callback] Found ${accounts.length} accounts, ${cards.length} cards`);

    // Date range: last 12 months. Use today as upper bound.
    const to = new Date().toISOString().split('T')[0];
    const fromDate = new Date();
    fromDate.setFullYear(fromDate.getFullYear() - 1);
    const from = fromDate.toISOString().split('T')[0];

    // Fetch transactions + card balances in parallel
    const txPromises = [
      ...accounts.map((a) =>
        fetch(`${TL_API_HOST}/data/v1/accounts/${a.account_id}/transactions?from=${from}&to=${to}`, { headers })
          .then(async (r) => {
            const body = await r.json();
            if (!r.ok || body.error) {
              console.error(`[callback] Transactions error for account ${a.account_id}:`, { status: r.status, body: JSON.stringify(body) });
            }
            return body;
          })
      ),
      ...cards.map((c) =>
        fetch(`${TL_API_HOST}/data/v1/cards/${c.account_id}/transactions?from=${from}&to=${to}`, { headers })
          .then(async (r) => {
            const body = await r.json();
            if (!r.ok || body.error) {
              console.error(`[callback] Transactions error for card ${c.account_id}:`, { status: r.status, body: JSON.stringify(body) });
            }
            return body;
          })
      ),
    ];

    const cardBalancePromises = cards.map((c) =>
      fetch(`${TL_API_HOST}/data/v1/cards/${c.account_id}/balance`, { headers })
        .then((r) => r.json())
        .then((data: { results?: Array<{ current?: number; credit_limit?: number; available?: number }> }) => ({ card: c, balance: (data.results || [])[0] || null }))
        .catch(() => ({ card: c, balance: null }))
    );
    const accountBalancePromises = accounts.map((a) =>
      fetch(`${TL_API_HOST}/data/v1/accounts/${a.account_id}/balance`, { headers })
        .then((r) => r.json())
        .then((data: { results?: Array<{ current?: number; overdraft?: number; available?: number }> }) => ({ account: a, balance: (data.results || [])[0] || null }))
        .catch(() => ({ account: a, balance: null }))
    );

    const [txResults, cardBalanceResults, accountBalanceResults] = await Promise.all([
      Promise.all(txPromises),
      Promise.all(cardBalancePromises),
      Promise.all(accountBalancePromises),
    ]);
    const allTx: TLTransaction[] = txResults.flatMap((r: { results?: TLTransaction[] }) => r.results || []);

    console.log(`[callback] Fetched ${allTx.length} transactions (date range: ${from} to ${to})`);

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

    // Insert bank data row with all available fields.
    // Set last_successful_sync_date to the start of the fetched range so
    // subsequent incremental syncs know where to pick up from.
    const insertRow: Record<string, unknown> = {
      connection_id: connectionId,
      csv_data: csv,
      source: 'truelayer',
      refresh_token: tokenData.refresh_token || null,
      last_successful_sync_date: from,
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
    if (postUserId) {
      try {
        if (providerName) {
          await admin
            .from('bank_data')
            .delete()
            .eq('user_id', postUserId)
            .eq('source', 'truelayer')
            .eq('provider_name', providerName)
            .neq('connection_id', connectionId);
        }
      } catch (cleanupErr: unknown) {
        const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        console.warn('[callback] Non-critical: old connection cleanup failed:', msg);
      }
    }


    // Store card + account balances on bank_data row (best-effort, non-blocking)
    try {
      const cardBalances = cardBalanceResults
        .filter((r) => r.balance)
        .map((r) => ({
          name: r.card.provider?.display_name || r.card.card_network || r.card.display_name || 'Card',
          type: 'credit_card',
          balance: r.balance!.current != null ? Math.abs(r.balance!.current!) : null,
          limit: r.balance!.credit_limit || null,
          available: r.balance!.available || null,
        }));

      const accountBalances = accountBalanceResults
        .filter((r) => r.balance)
        .map((r) => {
          const bal = r.balance!;
          const hasOverdraft = bal.overdraft != null && bal.overdraft > 0;
          const isOverdrawn = bal.current != null && bal.current < 0;
          if (!hasOverdraft && !isOverdrawn) return null;
          return {
            name: r.account.display_name || r.account.provider?.display_name || 'Account',
            type: isOverdrawn ? 'overdraft' : 'overdraft_facility',
            balance: isOverdrawn ? Math.abs(bal.current!) : 0,
            limit: bal.overdraft || null,
            available: bal.available || null,
          };
        })
        .filter(Boolean);

      const allAccountBalances = accountBalanceResults
        .filter((r) => r.balance && r.balance.current != null)
        .map((r) => ({
          name: r.account.provider?.display_name || r.account.display_name || 'Account',
          type: r.account.account_type || 'current',
          balance: r.balance!.current,
          available: r.balance!.available || null,
          overdraft: r.balance!.overdraft || null,
        }));

      const allBalances = [...cardBalances, ...accountBalances];

      const updatePayload: Record<string, unknown> = {};
      if (allBalances.length > 0) updatePayload.card_balances = allBalances;
      if (allAccountBalances.length > 0) updatePayload.account_balances = allAccountBalances;

      if (Object.keys(updatePayload).length > 0) {
        console.log('[callback] Balances:', JSON.stringify(updatePayload));
        await admin.from('bank_data')
          .update(updatePayload)
          .eq('connection_id', connectionId);
      }
    } catch (debtErr: unknown) {
      const msg = debtErr instanceof Error ? debtErr.message : String(debtErr);
      console.warn('[callback] Non-critical: balance save failed:', msg);
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Callback error:', err);
    return fail(500, 'Unexpected error', message);
  }
}
