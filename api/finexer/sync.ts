import { z } from 'zod';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  getConsent,
  listBankAccounts,
  syncBankAccount,
  fetchAllTransactions,
  getBalance,
  type FinexerTransaction,
  type FinexerBalance,
} from '../../lib/finexer.js';

const bodySchema = z.object({
  user_id: z.string().optional(),
});

// Allow up to 60s for sync (Hobby plan max).
export const config = { maxDuration: 60 };

interface BankRow {
  id: string;
  connection_id: string;
  consent_id: string;
  finexer_bank_account_ids: string[] | null;
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
  txCount: number;
  providerName: string | null;
}

/**
 * Sync a single Finexer connection: check consent → sync accounts → fetch transactions + balances.
 */
async function syncConnection(
  bankRow: BankRow,
  apiKey: string,
  admin: SupabaseClient,
  lastSyncDate: string | null,
): Promise<SyncResult | null> {
  try {
    // Check consent is still valid
    const consent = await getConsent(apiKey, bankRow.consent_id);
    if (consent.status !== 'authorized') {
      console.warn(`[finexer/sync] Consent ${bankRow.consent_id} status: ${consent.status}`);
      return null;
    }

    // Get bank accounts — either from stored IDs or by listing
    let bankAccountIds = bankRow.finexer_bank_account_ids || [];
    if (bankAccountIds.length === 0) {
      const { data: accounts } = await listBankAccounts(apiKey, { consent: bankRow.consent_id });
      bankAccountIds = (accounts || []).map((a) => a.id);
      // Store for next time
      if (bankAccountIds.length > 0) {
        await admin.from('bank_data')
          .update({ finexer_bank_account_ids: bankAccountIds })
          .eq('id', bankRow.id);
      }
    }

    if (bankAccountIds.length === 0) {
      console.warn(`[finexer/sync] No bank accounts for consent ${bankRow.consent_id}`);
      return null;
    }

    // Trigger sync on each bank account (best-effort, rate limited to 1/hr)
    for (const accountId of bankAccountIds) {
      try {
        await syncBankAccount(apiKey, accountId);
      } catch {
        // Rate limited or already synced — fine, proceed with existing data
      }
    }

    // Date range: from last sync or 1 month fallback
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + 1);
    const to = toDate.toISOString().split('T')[0];
    const fromDate = new Date();
    if (lastSyncDate) {
      fromDate.setTime(new Date(lastSyncDate).getTime());
    } else {
      fromDate.setMonth(fromDate.getMonth() - 1);
    }
    const from = fromDate.toISOString().split('T')[0];

    // Fetch transactions + balances in parallel
    const [txResults, balanceResults] = await Promise.all([
      Promise.all(
        bankAccountIds.map((id) =>
          fetchAllTransactions(apiKey, id, { since: from, until: to })
            .catch((err: Error) => {
              console.warn(`[finexer/sync] Tx fetch failed for ${id}:`, err.message);
              return [] as FinexerTransaction[];
            })
        )
      ),
      Promise.all(
        bankAccountIds.map((id) =>
          getBalance(apiKey, id)
            .then((r) => ({ accountId: id, balances: r.data || [] }))
            .catch(() => ({ accountId: id, balances: [] as FinexerBalance[] }))
        )
      ),
    ]);

    const allTx = txResults.flat();
    const providerName = consent.provider || bankRow.provider_name;

    // Convert to CSV lines (no header)
    const csvLines: string[] = [];
    for (const tx of allTx) {
      const date = tx.timestamp ? tx.timestamp.split('T')[0] : '';
      const desc = (tx.merchant || tx.description || tx.reference || 'Unknown')
        .replace(/,/g, ' ')
        .replace(/[\r\n]+/g, ' ');
      csvLines.push(`${date},${desc},${tx.amount}`);
    }

    // Build balance arrays (get account info for naming)
    const { data: accountInfos } = await listBankAccounts(apiKey, { consent: bankRow.consent_id });
    const accountMap = new Map((accountInfos || []).map((a) => [a.id, a]));

    const cardBalances: Array<{ name: string; type: string; balance: number; limit: number | null; available: number | null }> = [];
    const accountBalances: Array<{ name: string; type: string; balance: number | null; available: number | null; overdraft: number | null }> = [];

    for (const { accountId, balances } of balanceResults) {
      const account = accountMap.get(accountId);
      const name = account?.nickname || account?.holder_name || providerName || 'Account';

      for (const bal of balances) {
        if (account?.class === 'credit') {
          cardBalances.push({
            name,
            type: 'credit_card',
            balance: bal.current != null ? Math.abs(bal.current) : 0,
            limit: null,
            available: bal.available || null,
          });
        } else {
          accountBalances.push({
            name,
            type: account?.class || 'current',
            balance: bal.current,
            available: bal.available || null,
            overdraft: bal.overdraft?.limit || null,
          });

          const isOverdrawn = bal.current != null && bal.current < 0;
          const hasOverdraft = bal.overdraft?.limit != null && bal.overdraft.limit > 0;
          if (isOverdrawn || hasOverdraft) {
            cardBalances.push({
              name,
              type: isOverdrawn ? 'overdraft' : 'overdraft_facility',
              balance: isOverdrawn ? Math.abs(bal.current!) : 0,
              limit: bal.overdraft?.limit || null,
              available: bal.available || null,
            });
          }
        }
      }
    }

    return {
      csvLines,
      balances: cardBalances,
      accountBalances,
      txCount: allTx.length,
      providerName,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[finexer/sync] Connection ${bankRow.connection_id} failed:`, message);
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authenticate via JWT
  const authHeader = (req.headers.authorization as string) || '';
  const token = authHeader.replace('Bearer ', '');

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
  const apiKey = process.env.FINEXER_API_KEY;

  if (!supabaseUrl || !serviceKey || !apiKey) {
    return res.json({ success: false, reason: 'misconfigured' });
  }

  // Verify the JWT to get user_id
  let userId: string | null = null;
  if (token && token !== 'null') {
    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: { user } } = await anonClient.auth.getUser(token);
    userId = user?.id || null;
  }

  // Fallback: try body
  if (!userId) {
    const parsed = bodySchema.safeParse(req.body);
    if (parsed.success) userId = parsed.data.user_id || null;
  }

  if (!userId) {
    return res.json({ success: false, reason: 'no_user' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  try {
    // Fetch all Finexer connections for this user
    const { data: bankRows, error: fetchErr } = await admin
      .from('bank_data')
      .select('id, connection_id, consent_id, finexer_bank_account_ids, updated_at, provider_name, created_at, csv_data, last_successful_sync_date')
      .eq('user_id', userId)
      .eq('source', 'finexer')
      .not('consent_id', 'is', null);

    if (fetchErr || !bankRows || bankRows.length === 0) {
      return res.json({ success: false, reason: 'no_connection' });
    }

    // Sync all connections in parallel
    const results = await Promise.all(
      (bankRows as BankRow[]).map(async (row) => {
        const result = await syncConnection(row, apiKey, admin, row.last_successful_sync_date ?? null);
        return { row, result };
      })
    );

    // Process results
    let mergedCsvData: string | null = null;
    let totalTx = 0;
    let totalBalances = 0;
    let connectionsSynced = 0;
    const expiredConnections: Array<{ connection_id: string; provider_name: string | null }> = [];
    const expiringConnections: Array<{ provider_name: string; days_left: number }> = [];

    for (const { row, result } of results) {
      if (!result) {
        expiredConnections.push({ connection_id: row.connection_id, provider_name: row.provider_name });
        continue;
      }

      connectionsSynced++;
      totalTx += result.txCount;

      // Merge CSV with existing data using count-based dedup
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

      const existingLines: string[] = [];
      if (row.csv_data) {
        const lines = row.csv_data.split('\n');
        existingLines.push(...lines.slice(1).filter((l: string) => l.trim()));
      }

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

      const mergedCsv = ['Date,Description,Amount', ...unique].join('\n');

      // Update bank_data row
      const updateFields: Record<string, unknown> = {
        csv_data: mergedCsv,
        updated_at: new Date().toISOString(),
        last_successful_sync_date: new Date().toISOString().split('T')[0],
      };
      if (result.balances.length > 0) updateFields.card_balances = result.balances;
      if (result.accountBalances && result.accountBalances.length > 0) {
        updateFields.account_balances = result.accountBalances;
      }
      totalBalances += result.balances.length + (result.accountBalances?.length || 0);

      await admin.from('bank_data').update(updateFields).eq('id', row.id);

      // Track the latest CSV for the merged response
      if (!mergedCsvData) {
        mergedCsvData = mergedCsv;
      } else {
        // Merge across connections
        const prevLines = mergedCsvData.split('\n').slice(1).filter((l) => l.trim());
        const prevCounts = countByKey(prevLines);
        const newCounts = countByKey(unique);
        const allCrossKeys = new Set([...prevCounts.counts.keys(), ...newCounts.counts.keys()]);
        const crossUnique: string[] = [];
        for (const key of allCrossKeys) {
          const maxCount = Math.max(prevCounts.counts.get(key) || 0, newCounts.counts.get(key) || 0);
          const line = newCounts.lineByKey.get(key) || prevCounts.lineByKey.get(key)!;
          for (let i = 0; i < maxCount; i++) {
            crossUnique.push(line);
          }
        }
        mergedCsvData = ['Date,Description,Amount', ...crossUnique].join('\n');
      }
    }

    if (connectionsSynced === 0 && expiredConnections.length > 0) {
      return res.json({
        success: false,
        reason: 'token_expired',
        expired_connections: expiredConnections,
      });
    }

    if (connectionsSynced === 0) {
      return res.json({ success: false, reason: 'sync_failed' });
    }

    return res.json({
      success: true,
      csv_data: mergedCsvData,
      transactions_found: totalTx,
      balances_found: totalBalances,
      connections_synced: connectionsSynced,
      connections_total: bankRows.length,
      expired_connections: expiredConnections,
      expiring_connections: expiringConnections,
      updated_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[finexer/sync] Error:', message);
    return res.json({ success: false, reason: 'sync_failed', error: message });
  }
}
