import { z } from 'zod';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const bodySchema = z.object({
  user_id: z.string().optional(),
});

// Allow up to 60s for sync (Hobby plan max).
// Default 10s is too tight for token exchange + multiple TrueLayer API calls.
export const config = { maxDuration: 60 };

const IS_SANDBOX = (process.env.EXPO_PUBLIC_TRUELAYER_SANDBOX ?? 'false') === 'true';
const TL_AUTH_HOST = IS_SANDBOX ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com';
const TL_API_HOST = IS_SANDBOX ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';

interface BankRow {
  id: string;
  connection_id: string;
  refresh_token: string;
  updated_at: string;
  provider_name: string | null;
  created_at: string;
  csv_data: string | null;
  last_successful_sync_date?: string | null;
}

interface SyncResult {
  csvLines: string[];
  balances: Array<{ name: string; type: string; balance: number; limit: number | null; available: number | null }>;
  accountBalances?: Array<{ name: string; type: string; balance: number | null; available: number | null; overdraft: number | null }>;
  newRefreshToken: string | null;
  txCount: number;
  providerName: string | null;
  tokenOnlyRecovery?: boolean;
}

/**
 * Sync a single TrueLayer connection: refresh token → fetch transactions + balances.
 */
async function syncConnection(bankRow: BankRow, clientId: string, clientSecret: string, admin: SupabaseClient, lastSyncDate: string | null): Promise<SyncResult | null> {
  let newRefreshToken: string | null = null;
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

    newRefreshToken = tokenData.refresh_token || null;
    if (newRefreshToken && admin) {
      await admin.from('bank_data').update({ refresh_token: newRefreshToken }).eq('id', bankRow.id);
    }

    const headers = { Authorization: `Bearer ${tokenData.access_token}` };

    let accountsRes: Response, cardsRes: Response, accountsJson: Record<string, unknown>, cardsJson: Record<string, unknown>;
    for (let attempt = 0; attempt < 2; attempt++) {
      [accountsRes!, cardsRes!] = await Promise.all([
        fetch(`${TL_API_HOST}/data/v1/accounts`, { headers }),
        fetch(`${TL_API_HOST}/data/v1/cards`, { headers }),
      ]);

      accountsJson! = await accountsRes!.json();
      cardsJson! = await cardsRes!.json();

      if (accountsRes!.ok && cardsRes!.ok) break;

      if (attempt === 0) {
        console.warn(`[sync] TrueLayer data endpoints failed (attempt 1) — accounts: ${accountsRes!.status}, cards: ${cardsRes!.status}. Retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (!accountsRes!.ok || !cardsRes!.ok) {
      console.warn(`[sync] TrueLayer data endpoints returned errors after retry — accounts: ${accountsRes!.status}, cards: ${cardsRes!.status}`, {
        accountsError: (accountsJson! as Record<string, unknown>).error || null,
        cardsError: (cardsJson! as Record<string, unknown>).error || null,
      });
      return { csvLines: [], balances: [], newRefreshToken, txCount: 0, providerName: null, tokenOnlyRecovery: true };
    }

    const accounts: Array<{ account_id: string; display_name?: string; account_type?: string; provider?: { display_name?: string } }> = (accountsJson! as { results?: unknown[] }).results as Array<{ account_id: string; display_name?: string; account_type?: string; provider?: { display_name?: string } }> || [];
    const cards: Array<{ account_id: string; display_name?: string; card_network?: string; provider?: { display_name?: string } }> = (cardsJson! as { results?: unknown[] }).results as Array<{ account_id: string; display_name?: string; card_network?: string; provider?: { display_name?: string } }> || [];

    const providerName = accounts[0]?.provider?.display_name || cards[0]?.provider?.display_name || null;

    const to = new Date().toISOString().split('T')[0];
    // Fetch from last successful sync date to avoid gaps. Fall back to 1 month
    // if no sync date is recorded (e.g. legacy rows before this column existed).
    const fromDate = new Date();
    if (lastSyncDate) {
      fromDate.setTime(new Date(lastSyncDate).getTime());
    } else {
      fromDate.setMonth(fromDate.getMonth() - 1);
    }
    const from = fromDate.toISOString().split('T')[0];

    const txPromises = [
      ...accounts.map((a) =>
        fetch(`${TL_API_HOST}/data/v1/accounts/${a.account_id}/transactions?from=${from}&to=${to}`, { headers })
          .then(async (r) => {
            const body = await r.json();
            if (!r.ok || body.error) {
              console.error(`[sync] Transactions error for account ${a.account_id}:`, { status: r.status, body: JSON.stringify(body) });
            }
            return body;
          })
          .catch((err: Error) => { console.warn(`[sync] Transaction fetch failed for account ${a.account_id}:`, err.message); return { results: [] }; })
      ),
      ...cards.map((c) =>
        fetch(`${TL_API_HOST}/data/v1/cards/${c.account_id}/transactions?from=${from}&to=${to}`, { headers })
          .then(async (r) => {
            const body = await r.json();
            if (!r.ok || body.error) {
              console.error(`[sync] Transactions error for card ${c.account_id}:`, { status: r.status, body: JSON.stringify(body) });
            }
            return body;
          })
          .catch((err: Error) => { console.warn(`[sync] Transaction fetch failed for card ${c.account_id}:`, err.message); return { results: [] }; })
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
    const allTx: Array<{ timestamp?: string; merchant_name?: string; description?: string; transaction_type?: string; amount: number }> = txResults.flatMap((r: { results?: unknown[] }) => r.results || []) as Array<{ timestamp?: string; merchant_name?: string; description?: string; transaction_type?: string; amount: number }>;

    const csvLines: string[] = [];
    for (const tx of allTx) {
      const date = tx.timestamp ? tx.timestamp.split('T')[0] : '';
      const desc = (tx.merchant_name || tx.description || '').replace(/,/g, ' ').replace(/[\r\n]+/g, ' ');
      const amount = tx.transaction_type === 'CREDIT' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      csvLines.push(`${date},${desc},${amount}`);
    }

    const cardBalances = cardBalanceResults
      .filter((r) => r.balance)
      .map((r) => ({
        name: r.card.provider?.display_name || r.card.card_network || r.card.display_name || 'Card',
        type: 'credit_card' as const,
        balance: r.balance!.current != null ? Math.abs(r.balance!.current!) : 0,
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
          type: isOverdrawn ? 'overdraft' as const : 'overdraft_facility' as const,
          balance: isOverdrawn ? Math.abs(bal.current!) : 0,
          limit: bal.overdraft || null,
          available: bal.available || null,
        };
      })
      .filter(Boolean) as Array<{ name: string; type: string; balance: number; limit: number | null; available: number | null }>;

    const allAccountBalances = accountBalanceResults
      .filter((r) => r.balance && r.balance.current != null)
      .map((r) => ({
        name: r.account.provider?.display_name || r.account.display_name || 'Account',
        type: r.account.account_type || 'current',
        balance: r.balance!.current!,
        available: r.balance!.available || null,
        overdraft: r.balance!.overdraft || null,
      }));

    return {
      csvLines,
      balances: [...cardBalances, ...accountBalances],
      accountBalances: allAccountBalances,
      newRefreshToken,
      txCount: allTx.length,
      providerName,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[sync] Connection ${bankRow.connection_id} failed:`, message);
    if (newRefreshToken) {
      return { csvLines: [], balances: [], newRefreshToken, txCount: 0, providerName: null, tokenOnlyRecovery: true };
    }
    return null;
  }
}

// CONSENT_DAYS / WARN_DAYS removed — FCA rule changes mean UK banks issue
// long-lived tokens. Expiry is now determined by TrueLayer's actual token
// refresh response, not a pre-calculated date.

/**
 * POST /api/truelayer/sync
 * Body: { user_id }
 *
 * Syncs ALL connected bank accounts for a user, merges transactions and
 * balances, and returns the combined CSV.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authenticate the caller via Supabase JWT to prevent unauthenticated access
  const authHeader = (req.headers.authorization as string) || '';
  const authToken = authHeader.replace('Bearer ', '');
  if (!authToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseAnonKey) {
    const anonClient = createClient(supabaseUrl!, supabaseAnonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(authToken);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (req.body?.user_id && req.body.user_id !== user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.body = { ...req.body, user_id: user.id };
  }

  const bodyParsed = bodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid request', details: bodyParsed.error.flatten().fieldErrors });
  }
  const userId: string | undefined = bodyParsed.data.user_id;
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
    let { data: bankRows, error: findErr } = await admin
      .from('bank_data')
      .select('id, connection_id, refresh_token, updated_at, provider_name, created_at, csv_data, last_successful_sync_date')
      .eq('user_id', userId)
      .eq('source', 'truelayer')
      .not('refresh_token', 'is', null)
      .order('created_at', { ascending: false });

    // Fallback: if last_successful_sync_date column doesn't exist yet, query without it
    if (findErr && findErr.code === 'PGRST204' && findErr.message?.includes('last_successful_sync_date')) {
      console.warn('[sync] last_successful_sync_date column not found, querying without it');
      const fallback = await admin
        .from('bank_data')
        .select('id, connection_id, refresh_token, updated_at, provider_name, created_at, csv_data')
        .eq('user_id', userId)
        .eq('source', 'truelayer')
        .not('refresh_token', 'is', null)
        .order('created_at', { ascending: false });
      bankRows = fallback.data as typeof bankRows;
      findErr = fallback.error;
    }

    if (findErr || !bankRows || bankRows.length === 0) {
      return res.json({ success: false, reason: 'no_connection' });
    }

    // Sync all connections in parallel
    const results = await Promise.all(
      (bankRows as BankRow[]).map((row) => syncConnection(row, clientId, clientSecret, admin, row.last_successful_sync_date ?? null).then((r) => ({ row, result: r })))
    );

    let mergedBalances: Array<{ name: string; type: string; balance: number; limit: number | null; available: number | null }> = [];
    let totalTx = 0;
    let syncedCount = 0;
    const expiredConnections: Array<{ connection_id: string; provider_name: string | null }> = [];

    for (const { row, result } of results) {
      if (!result) {
        // Token refresh was rejected by TrueLayer (400 invalid_grant) — consent truly expired.
        expiredConnections.push({ connection_id: row.connection_id, provider_name: row.provider_name });
        continue;
      }
      if (result.tokenOnlyRecovery) {
        // Token refreshed OK but data fetch failed (e.g. 403, 429, timeout).
        // Connection is alive — don't mark as expired. Data will be fetched next sync.
        continue;
      }

      syncedCount++;
      mergedBalances.push(...result.balances);
      totalTx += result.txCount;

      const updateFields: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
        last_successful_sync_date: new Date().toISOString().split('T')[0],
      };
      if (result.csvLines.length > 0) {
        const existingLines: string[] = [];
        if (row.csv_data) {
          const lines = row.csv_data.split('\n');
          existingLines.push(...lines.slice(1).filter((l: string) => l.trim()));
        }
        const normalise = (line: string) => line.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ').trim();
        const countByKey = (lines: string[]) => {
          const counts = new Map<string, number>();
          const lineByKey = new Map<string, string>();
          for (const line of lines) {
            const key = normalise(line);
            counts.set(key, (counts.get(key) || 0) + 1);
            if (!lineByKey.has(key)) lineByKey.set(key, line);
          }
          return { counts, lineByKey };
        };
        const existing = countByKey(existingLines);
        const fresh = countByKey(result.csvLines);
        const allKeys = new Set([...existing.counts.keys(), ...fresh.counts.keys()]);
        const unique: string[] = [];
        for (const key of allKeys) {
          const maxCount = Math.max(existing.counts.get(key) || 0, fresh.counts.get(key) || 0);
          const line = fresh.lineByKey.get(key) || existing.lineByKey.get(key)!;
          for (let i = 0; i < maxCount; i++) {
            unique.push(line);
          }
        }
        updateFields.csv_data = ['Date,Description,Amount', ...unique].join('\n');
      }
      if (result.balances.length > 0) {
        updateFields.card_balances = result.balances;
      }
      if (result.accountBalances && result.accountBalances.length > 0) {
        updateFields.account_balances = result.accountBalances;
      }
      if (!row.provider_name && result.providerName) {
        updateFields.provider_name = result.providerName;
      }
      let { error: updateErr } = await admin.from('bank_data').update(updateFields).eq('id', row.id);
      // Fallback: if last_successful_sync_date column doesn't exist yet, retry without it
      if (updateErr && updateErr.code === 'PGRST204' && updateErr.message?.includes('last_successful_sync_date')) {
        console.warn('[sync] last_successful_sync_date column not found, retrying update without it');
        delete updateFields.last_successful_sync_date;
        await admin.from('bank_data').update(updateFields).eq('id', row.id);
      }
    }

    if (syncedCount === 0) {
      const reason = expiredConnections.length > 0 ? 'token_expired' : 'sync_failed';
      return res.json({
        success: false,
        reason,
        expired_connections: expiredConnections.length > 0 ? expiredConnections : undefined,
      });
    }

    // Deduplicate transactions across connections.
    const normKey = (l: string) => l.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ').trim();
    const connCountMaps = results
      .filter(({ result: r }) => r && !r.tokenOnlyRecovery && r.csvLines.length > 0)
      .map(({ result: r }) => {
        const m = new Map<string, number>();
        const ref = new Map<string, string>();
        for (const line of r!.csvLines) {
          const k = normKey(line);
          m.set(k, (m.get(k) || 0) + 1);
          if (!ref.has(k)) ref.set(k, line);
        }
        return { m, ref };
      });
    const allTxKeys = new Set<string>();
    for (const { m } of connCountMaps) for (const k of m.keys()) allTxKeys.add(k);
    const uniqueLines: string[] = [];
    for (const k of allTxKeys) {
      let best = 0;
      let line = '';
      for (const { m, ref } of connCountMaps) {
        const c = m.get(k) || 0;
        if (c > best) { best = c; line = ref.get(k) || line; }
      }
      for (let i = 0; i < best; i++) uniqueLines.push(line);
    }

    const mergedCsv = ['Date,Description,Amount', ...uniqueLines].join('\n');

    // Note: We no longer pre-calculate 90-day consent expiry from created_at.
    // The FCA changed rules in 2022 — UK banks issue long-lived tokens and only
    // require consent reconfirmation, not re-authentication. Expiry is determined
    // by TrueLayer's actual token refresh response (400 invalid_grant).
    const expiringConnections: Array<{ provider_name: string | null; days_left: number }> = [];

    console.log(`[sync] Synced ${syncedCount}/${bankRows.length} connections, ${totalTx} transactions, ${mergedBalances.length} balance(s)`);

    // Clean up duplicate connections for the same provider.
    try {
      const rowProviders: Record<string, string | null> = {};
      for (const { row, result } of results) {
        rowProviders[row.id] = row.provider_name || result?.providerName || null;
      }

      const providerGroups: Record<string, BankRow[]> = {};
      for (const row of bankRows as BankRow[]) {
        const key = rowProviders[row.id] || row.connection_id;
        if (!providerGroups[key]) providerGroups[key] = [];
        providerGroups[key].push(row);
      }
      for (const [, rows] of Object.entries(providerGroups)) {
        if (rows.length <= 1) continue;
        rows.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
        const staleIds = rows.slice(1).map((r) => r.id);
        if (staleIds.length > 0) {
          await admin.from('bank_data').delete().in('id', staleIds);
          console.log(`[sync] Cleaned up ${staleIds.length} stale connection(s)`);
        }
      }
    } catch (cleanupErr: unknown) {
      const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn('[sync] Non-critical: duplicate cleanup failed:', msg);
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sync] Error:', err);
    return res.status(500).json({ error: 'Sync failed', details: message });
  }
}
