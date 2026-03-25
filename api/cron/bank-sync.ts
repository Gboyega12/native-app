// ── Automated Bank Sync Cron Job ──
// Runs every 6 hours (via Vercel Cron).
// Checks Finexer consent status and fetches fresh transactions
// for all connected users, so data is always up-to-date.

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
  type FinexerBankAccount,
} from '../../lib/finexer.js';

// Allow up to 60s for the cron job (Hobby plan max).
export const config = { maxDuration: 60 };

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

interface BankRow {
  id: string;
  connection_id: string;
  consent_id: string;
  finexer_bank_account_ids: string[] | null;
  user_id: string;
  provider_name: string | null;
  created_at: string;
  updated_at: string;
  csv_data: string | null;
  last_successful_sync_date?: string | null;
}

interface RefreshResult {
  success: boolean;
  expired?: boolean;
  csvLines?: string[];
  cardBalances?: Array<{ name: string; type: string; balance: number | null; limit: number | null; available: number | null }>;
  txCount?: number;
}

/**
 * Sync a single Finexer connection: check consent → sync accounts → fetch transactions + balances.
 */
async function refreshConnection(bankRow: BankRow, apiKey: string, admin: SupabaseClient, lastSyncDate: string | null): Promise<RefreshResult> {
  try {
    // Check consent is still authorized
    const consent = await getConsent(apiKey, bankRow.consent_id);
    if (consent.status !== 'authorized') {
      console.warn(`[bank-sync] Consent ${bankRow.consent_id} status: ${consent.status}`);
      return { success: false, expired: consent.status === 'expired' || consent.status === 'canceled' };
    }

    // Get bank accounts
    let bankAccountIds = bankRow.finexer_bank_account_ids || [];
    if (bankAccountIds.length === 0) {
      const { data: accounts } = await listBankAccounts(apiKey, { consent: bankRow.consent_id });
      bankAccountIds = (accounts || []).map((a: FinexerBankAccount) => a.id);
      if (bankAccountIds.length > 0) {
        await admin.from('bank_data')
          .update({ finexer_bank_account_ids: bankAccountIds })
          .eq('id', bankRow.id);
      }
    }

    if (bankAccountIds.length === 0) {
      return { success: false, expired: false };
    }

    // Trigger sync on each bank account (best-effort, rate limited to 1/hr)
    for (const accountId of bankAccountIds) {
      try {
        await syncBankAccount(apiKey, accountId);
      } catch {
        // Rate limited or already synced — fine
      }
    }

    // Date range
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

    // Fetch transactions + balances
    const [txResults, balanceResults] = await Promise.all([
      Promise.all(
        bankAccountIds.map((id) =>
          fetchAllTransactions(apiKey, id, { since: from, until: to })
            .catch((err: Error) => { console.warn(`[bank-sync] Tx fetch failed for ${id}:`, err.message); return [] as FinexerTransaction[]; })
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

    // Convert to CSV lines (no header)
    const csvLines: string[] = [];
    for (const tx of allTx) {
      const date = tx.timestamp ? tx.timestamp.split('T')[0] : '';
      const desc = (tx.merchant || tx.description || tx.reference || 'Unknown').replace(/,/g, ' ');
      csvLines.push(`${date},${desc},${tx.amount}`);
    }

    // Build balance arrays
    const { data: accountInfos } = await listBankAccounts(apiKey, { consent: bankRow.consent_id });
    const accountMap = new Map((accountInfos || []).map((a: FinexerBankAccount) => [a.id, a]));

    const cardBalances: Array<{ name: string; type: string; balance: number | null; limit: number | null; available: number | null }> = [];

    for (const { accountId, balances } of balanceResults) {
      const account = accountMap.get(accountId);
      const name = account?.nickname || account?.holder_name || bankRow.provider_name || 'Account';

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
      success: true,
      csvLines,
      cardBalances,
      txCount: allTx.length,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[bank-sync] Connection ${bankRow.connection_id} failed:`, message);
    return { success: false, expired: false };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = (req.headers.authorization as string) || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!serviceKey) {
    return res.json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const apiKey = process.env.FINEXER_API_KEY;
  if (!apiKey) {
    return res.json({ success: false, error: 'FINEXER_API_KEY not configured' });
  }

  const admin = createClient(supabaseUrl!, serviceKey);
  const results = { refreshed: 0, failed: 0, expired: 0, total: 0 };
  const refreshedUserIds = new Set<string>();

  try {
    // Get all Finexer connections with valid consent IDs
    const { data: bankRows, error: fetchErr } = await admin
      .from('bank_data')
      .select('id, connection_id, consent_id, finexer_bank_account_ids, user_id, provider_name, created_at, updated_at, csv_data, last_successful_sync_date')
      .eq('source', 'finexer')
      .not('consent_id', 'is', null)
      .order('updated_at', { ascending: true }); // Oldest first — prioritize stale data

    if (fetchErr || !bankRows || bankRows.length === 0) {
      return res.json({ success: true, message: 'No connections to refresh', ...results });
    }

    results.total = bankRows.length;

    // Process connections in batches of 5
    const BATCH_SIZE = 5;
    for (let i = 0; i < bankRows.length; i += BATCH_SIZE) {
      const batch = bankRows.slice(i, i + BATCH_SIZE) as BankRow[];

      const batchResults = await Promise.all(
        batch.map(async (row) => {
          const result = await refreshConnection(row, apiKey, admin, row.last_successful_sync_date ?? null);
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
        refreshedUserIds.add(row.user_id);

        // Update the bank_data row with fresh data.
        const updateFields: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
          last_successful_sync_date: new Date().toISOString().split('T')[0],
        };
        if (result.csvLines && result.csvLines.length > 0) {
          // Count-based dedup for incremental sync
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
            for (let j = 0; j < maxCount; j++) {
              unique.push(line);
            }
          }
          updateFields.csv_data = ['Date,Description,Amount', ...unique].join('\n');
        }
        if (result.cardBalances && result.cardBalances.length > 0) {
          updateFields.card_balances = result.cardBalances;
        }

        await admin.from('bank_data').update(updateFields).eq('id', row.id);

        // ── Income arrival detection & notification ──
        try {
          const now = new Date();
          const dayOfWeek = now.getDay();
          const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          const weekStart = new Date(now);
          weekStart.setDate(now.getDate() - mondayOffset);
          weekStart.setHours(0, 0, 0, 0);
          const weekStartStr = weekStart.toISOString().split('T')[0];

          const SALARY_PATTERNS = /\b(salary|wages|payroll|payday|stipend|pension|net pay|direct deposit|pay from|monthly pay)\b/i;
          const EMPLOYER_PATTERNS = /\b(ltd|plc|limited|inc|corp|llp|group|holdings|council|nhs|university)\b/i;
          const TRANSFER_PATTERNS = /\b(faster payment|bank transfer|transfer from|transfer to)\b/i;
          const PERSON_TITLE = /^(mr|mrs|miss|ms|dr)\s/i;

          function looksLikePersonName(text: string): boolean {
            const cleaned = text.toLowerCase().trim()
              .replace(/^(mr|mrs|miss|ms|dr|prof)\s+/i, '')
              .replace(/\b(fp|bgt|bacs|chq)\b/g, '')
              .trim();
            const words = cleaned.split(/\s+/).filter(Boolean);
            if (words.length < 2 || words.length > 3) return false;
            const allAlpha = words.every((w) => /^[a-z'-]+$/.test(w));
            const hasFullName = words.some((w) => w.length >= 2);
            return allAlpha && hasFullName;
          }

          const incomeCredits = (result.csvLines || []).filter((line: string) => {
            const parts = line.split(',');
            if (parts.length < 3) return false;
            const date = parts[0];
            const desc = parts.slice(1, -1).join(',');
            const amount = parseFloat(parts[parts.length - 1]);
            if (!date || date < weekStartStr || amount < 100) return false;
            if (TRANSFER_PATTERNS.test(desc) || PERSON_TITLE.test(desc.trim())) return false;
            if (looksLikePersonName(desc)) return false;
            return SALARY_PATTERNS.test(desc) || EMPLOYER_PATTERNS.test(desc);
          });

          if (incomeCredits.length > 0) {
            const { data: recentLog } = await admin
              .from('notification_log')
              .select('id')
              .eq('user_id', row.user_id)
              .eq('notification_type', 'income_arrival')
              .gte('sent_at', weekStartStr)
              .limit(1);

            if (!recentLog || recentLog.length === 0) {
              const [{ data: prefs }, { data: profile }] = await Promise.all([
                admin.from('notification_preferences').select('email, checkin_prompts').eq('user_id', row.user_id).single(),
                admin.from('profiles').select('full_name').eq('id', row.user_id).single(),
              ]);

              if (prefs?.email && prefs?.checkin_prompts !== false) {
                const topIncome = incomeCredits[0].split(',');
                const incomeAmount = parseFloat(topIncome[topIncome.length - 1]);
                const incomeSource = topIncome.slice(1, -1).join(',').trim();
                const userName = (profile?.full_name || '').split(' ')[0] || 'there';

                const notifyAppUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.bocy.io';
                const notifyEndpoint = `${notifyAppUrl.replace(/\/$/, '')}/api/notifications/send`;

                await fetch(notifyEndpoint, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${cronSecret}`,
                  },
                  body: JSON.stringify({
                    to: prefs.email,
                    subject: `\u00a3${Math.round(incomeAmount).toLocaleString()} received from ${incomeSource}`,
                    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><style>body{margin:0;padding:0;background:#0A0A0A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#fff;}</style></head><body><div style="max-width:520px;margin:0 auto;padding:32px 24px;"><div style="text-align:center;margin-bottom:24px;"><span style="font-size:24px;font-weight:800;">B</span> <span style="color:#999;font-size:14px;">Bocy</span></div><div style="background:#141414;border:1px solid #1F1F1F;border-radius:14px;padding:24px;"><p style="font-size:10px;color:#00d4aa;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px;">PAYDAY</p><h2 style="font-size:18px;margin:0 0 12px;">\u00a3${Math.round(incomeAmount).toLocaleString()} received</h2><p style="font-size:14px;line-height:22px;margin:0 0 12px;">Hey ${userName}, income from <strong>${incomeSource}</strong> just landed.</p><hr style="border:none;border-top:1px solid #1F1F1F;margin:20px 0;"><p style="font-size:14px;color:#999;">Open Bocy to see where it should go.</p><div style="text-align:center;margin-top:20px;"><a href="${notifyAppUrl}" style="display:inline-block;background:#00d4aa;color:#0A0A0A;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;">See your plan</a></div></div><div style="text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid #1F1F1F;"><p style="color:#999;font-size:12px;">You're receiving this because you have a Bocy account.<br>To manage or turn off email notifications, visit your <a href="${notifyAppUrl}/profile?section=notifications" style="color:#999;">notification settings</a> in the app.</p></div></div></body></html>`,
                    user_id: row.user_id,
                    notification_type: 'income_arrival',
                    push_body: `\u00a3${Math.round(incomeAmount).toLocaleString()} from ${incomeSource} just landed. Open Bocy to see where it should go.`,
                  }),
                }).catch((e: Error) => console.warn('[bank-sync] Income notification failed:', e?.message));
              }
            }
          }
        } catch (notifErr: unknown) {
          const msg = notifErr instanceof Error ? notifErr.message : String(notifErr);
          console.warn('[bank-sync] Income notification check failed:', msg);
        }
      }
    }

    // ── Re-enrich analyses for users whose data was refreshed ──
    const usersToEnrich = [...refreshedUserIds];

    let enriched = 0;
    if (usersToEnrich.length > 0) {
      const enrichAppUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.bocy.io';
      const enrichEndpoint = `${enrichAppUrl.replace(/\/$/, '')}/api/enrich`;

      for (const uid of usersToEnrich) {
        try {
          const enrichRes = await fetch(enrichEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${cronSecret}`,
            },
            body: JSON.stringify({ user_id: uid }),
          });
          const enrichData = await enrichRes.json();
          if (enrichData.success) enriched++;
          else console.warn(`[bank-sync] Enrich failed for ${uid}:`, enrichData.reason || enrichData.error);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[bank-sync] Enrich request failed for ${uid}:`, msg);
        }
      }
    }

    // ── Pick up stuck draft analyses and trigger background verification ──
    let verified = 0;
    try {
      const { data: draftRows } = await admin
        .from('analyses')
        .select('user_id')
        .in('verification_status', ['draft', 'verifying'])
        .order('created_at', { ascending: true })
        .limit(10);

      if (draftRows && draftRows.length > 0) {
        const verifyAppUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.bocy.io';
        const verifyEndpoint = `${verifyAppUrl.replace(/\/$/, '')}/api/verify`;

        for (const draftRow of draftRows) {
          try {
            const verifyRes = await fetch(verifyEndpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cronSecret}`,
              },
              body: JSON.stringify({ user_id: draftRow.user_id }),
            });
            const verifyData = await verifyRes.json();
            if (verifyData.success) verified++;
            else console.warn(`[bank-sync] Verify failed for ${draftRow.user_id}:`, verifyData.reason || verifyData.error);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[bank-sync] Verify request failed for ${draftRow.user_id}:`, msg);
          }
        }
      }
    } catch (verifyErr: unknown) {
      const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      console.warn('[bank-sync] Draft verification sweep failed:', msg);
    }

    console.log(`[bank-sync] Refreshed ${results.refreshed}/${results.total} connections (${results.expired} expired, ${results.failed} failed), enriched ${enriched}/${usersToEnrich.length} users, verified ${verified} drafts`);
    return res.json({ success: true, ...results, enriched, verified });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[bank-sync] Cron failed:', message);
    return res.status(500).json({ success: false, error: message });
  }
}
