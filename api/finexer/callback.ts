import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { DEFAULT_APR, defaultMinimumPayment } from '../../lib/constants.js';
import {
  getConsent,
  listBankAccounts,
  syncBankAccount,
  getSyncStatus,
  fetchAllTransactions,
  getBalance,
  type FinexerTransaction,
  type FinexerBankAccount,
  type FinexerBalance,
} from '../../lib/finexer.js';

const querySchema = z.object({
  consent_id: z.string().optional(),
  connection_id: z.string().optional(),
  origin: z.string().optional(),
});

// Allow up to 60s for the callback to process (Hobby plan max).
export const config = { maxDuration: 60 };

// Allowed redirect origins
const ALLOWED_ORIGINS = new Set([
  'https://app.bocy.io',
  ...(process.env.APP_URL ? [process.env.APP_URL] : []),
  'http://localhost:8081',
  'http://localhost:19006',
]);

/**
 * GET /api/finexer/callback
 *
 * Finexer redirects here after the user authorizes bank access.
 * Fetches accounts, transactions, and balances, then saves to bank_data.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  const { consent_id: consentIdParam, connection_id: connectionId, origin: rawOrigin } = parsed.data;
  const webOrigin = rawOrigin && ALLOWED_ORIGINS.has(rawOrigin) ? rawOrigin : null;

  const fail = (error: string, details?: string) => {
    const errMsg = encodeURIComponent(details ? `${error}: ${details}` : error);
    if (webOrigin) {
      return res.redirect(302, `${webOrigin}/connect?status=error&error=${errMsg}`);
    }
    return res.redirect(302, `bocy://callback?status=error&error=${errMsg}`);
  };

  if (!connectionId) return fail('Missing connection_id');

  const apiKey = process.env.FINEXER_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey) return fail('Server misconfigured', 'FINEXER_API_KEY not set');
  if (!supabaseUrl || !serviceKey) return fail('Server misconfigured', 'Supabase not configured');

  try {
    const admin = createClient(supabaseUrl, serviceKey);

    // Look up the pre-created bank_data row to get consent_id and user_id
    const { data: bankRow } = await admin
      .from('bank_data')
      .select('id, consent_id, finexer_customer_id, user_id')
      .eq('connection_id', connectionId)
      .single();

    const consentId = consentIdParam || bankRow?.consent_id;
    if (!consentId) return fail('Missing consent_id');

    const userId = bankRow?.user_id || null;

    // Verify consent is authorized
    const consent = await getConsent(apiKey, consentId);
    if (consent.status !== 'authorized') {
      console.error(`[finexer/callback] Consent ${consentId} status: ${consent.status}`);
      return fail('Bank authorization not completed', `Consent status: ${consent.status}`);
    }

    // List bank accounts under this consent
    const { data: bankAccounts } = await listBankAccounts(apiKey, { consent: consentId });

    if (!bankAccounts || bankAccounts.length === 0) {
      return fail('No bank accounts found', 'Authorization succeeded but no accounts were returned');
    }

    console.log(`[finexer/callback] Found ${bankAccounts.length} bank accounts for consent ${consentId}`);

    // Sync each bank account to ensure fresh data
    const bankAccountIds: string[] = [];
    for (const account of bankAccounts) {
      bankAccountIds.push(account.id);
      try {
        await syncBankAccount(apiKey, account.id);
        // Wait for sync to complete (poll up to 30s)
        for (let i = 0; i < 15; i++) {
          const status = await getSyncStatus(apiKey, account.id);
          if (status.status !== 'running') break;
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (syncErr: unknown) {
        const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
        console.warn(`[finexer/callback] Sync failed for account ${account.id}:`, msg);
        // Continue — transactions might still be available from initial consent
      }
    }

    // Fetch transactions + balances for all accounts in parallel
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const sinceDate = twelveMonthsAgo.toISOString().split('T')[0];

    const [txResults, balanceResults] = await Promise.all([
      Promise.all(
        bankAccounts.map((account) =>
          fetchAllTransactions(apiKey, account.id, { since: sinceDate })
            .catch((err: Error) => {
              console.warn(`[finexer/callback] Tx fetch failed for ${account.id}:`, err.message);
              return [] as FinexerTransaction[];
            })
        )
      ),
      Promise.all(
        bankAccounts.map((account) =>
          getBalance(apiKey, account.id)
            .then((r) => ({ account, balances: r.data || [] }))
            .catch(() => ({ account, balances: [] as FinexerBalance[] }))
        )
      ),
    ]);

    const allTx: FinexerTransaction[] = txResults.flat();
    console.log(`[finexer/callback] Fetched ${allTx.length} transactions (since ${sinceDate})`);

    // Convert to CSV (same format as TrueLayer: Date,Description,Amount)
    const csvLines = ['Date,Description,Amount'];
    for (const tx of allTx) {
      const date = tx.timestamp ? tx.timestamp.split('T')[0] : '';
      const desc = (tx.merchant || tx.description || tx.reference || 'Unknown')
        .replace(/,/g, ' ')
        .replace(/[\r\n]+/g, ' ');
      // Finexer amounts are already signed (negative = debit, positive = credit)
      csvLines.push(`${date},${desc},${tx.amount}`);
    }
    const csv = csvLines.join('\n');

    // Determine provider name and account type
    const providerName = bankAccounts[0]?.provider || consent.provider || null;
    const hasCredit = bankAccounts.some((a) => a.class === 'credit');
    const hasBank = bankAccounts.some((a) => a.class !== 'credit');
    const accountType = hasBank && !hasCredit ? 'bank' : hasCredit && !hasBank ? 'credit' : 'bank';

    // Build balance arrays
    const cardBalances: Array<{ name: string; type: string; balance: number; limit: number | null; available: number | null }> = [];
    const accountBalances: Array<{ name: string; type: string; balance: number | null; available: number | null; overdraft: number | null }> = [];

    for (const { account, balances } of balanceResults) {
      for (const bal of balances) {
        if (account.class === 'credit') {
          cardBalances.push({
            name: account.nickname || account.holder_name || providerName || 'Card',
            type: 'credit_card',
            balance: bal.current != null ? Math.abs(bal.current) : 0,
            limit: null,
            available: bal.available || null,
          });
        } else {
          accountBalances.push({
            name: account.nickname || account.holder_name || providerName || 'Account',
            type: account.class || 'current',
            balance: bal.current,
            available: bal.available || null,
            overdraft: bal.overdraft?.limit || null,
          });

          // Check for overdraft
          const isOverdrawn = bal.current != null && bal.current < 0;
          const hasOverdraft = bal.overdraft?.limit != null && bal.overdraft.limit > 0;
          if (isOverdrawn || hasOverdraft) {
            cardBalances.push({
              name: account.nickname || account.holder_name || providerName || 'Account',
              type: isOverdrawn ? 'overdraft' : 'overdraft_facility',
              balance: isOverdrawn ? Math.abs(bal.current!) : 0,
              limit: bal.overdraft?.limit || null,
              available: bal.available || null,
            });
          }
        }
      }
    }

    // Update the pre-created bank_data row
    const updatePayload: Record<string, unknown> = {
      csv_data: csv,
      source: 'finexer',
      consent_id: consentId,
      finexer_bank_account_ids: bankAccountIds,
      last_successful_sync_date: sinceDate,
    };
    if (providerName) updatePayload.provider_name = providerName;
    if (accountType) updatePayload.account_type = accountType;
    if (cardBalances.length > 0) updatePayload.card_balances = cardBalances;
    if (accountBalances.length > 0) updatePayload.account_balances = accountBalances;

    const { error: dbError } = await admin
      .from('bank_data')
      .update(updatePayload)
      .eq('connection_id', connectionId);

    if (dbError) {
      console.error('[finexer/callback] Failed to update bank data:', dbError);
      return fail('Failed to save bank data', dbError.message || dbError.code);
    }

    // Clean up old connections for the same provider and user
    if (userId && providerName) {
      try {
        await admin
          .from('bank_data')
          .delete()
          .eq('user_id', userId)
          .eq('source', 'finexer')
          .eq('provider_name', providerName)
          .neq('connection_id', connectionId);
      } catch (cleanupErr: unknown) {
        const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        console.warn('[finexer/callback] Non-critical: old connection cleanup failed:', msg);
      }
    }

    // Upsert card/overdraft balances to debt_accounts
    if (userId && cardBalances.length > 0) {
      for (const card of cardBalances) {
        if (!card.balance || card.balance <= 0) continue;
        const acctType = card.type || 'credit_card';
        const defaultApr = DEFAULT_APR[acctType] ?? DEFAULT_APR.credit_card;
        const defaultMin = defaultMinimumPayment(acctType, card.balance);
        try {
          await admin.from('debt_accounts').upsert({
            user_id: userId,
            account_name: card.name || 'Card',
            account_type: acctType,
            outstanding_balance: card.balance,
            credit_limit: card.limit || null,
            interest_rate: defaultApr,
            minimum_payment: defaultMin,
            is_default_apr: true,
            source: 'finexer',
            provider_name: providerName || null,
            last_updated: new Date().toISOString(),
          }, { onConflict: 'user_id,account_name' });
        } catch (debtErr: unknown) {
          const msg = debtErr instanceof Error ? debtErr.message : String(debtErr);
          console.warn('[finexer/callback] debt_accounts upsert failed:', msg);
        }
      }
    }

    // Redirect back to the app
    if (webOrigin) {
      return res.redirect(302, `${webOrigin}/connect?connection_id=${encodeURIComponent(connectionId)}&status=success`);
    }
    return res.redirect(302, `bocy://callback?connection_id=${connectionId}&status=success`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[finexer/callback] Error:', err);
    return fail('Unexpected error', message);
  }
}
