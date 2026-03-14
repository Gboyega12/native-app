// ── Automated Bank Sync Cron Job ──
// Runs every 6 hours (via Vercel Cron).
// Proactively refreshes TrueLayer access tokens and fetches fresh
// transactions for all connected users, so data is always up-to-date
// without requiring users to manually open the app.
//
// This solves the problem where TrueLayer connections appear "stale"
// because the token refresh only happened on app open. By running
// server-side, tokens stay warm and data stays fresh.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Allow up to 60s for the cron job (Hobby plan max).
// Processing multiple users' bank connections easily exceeds the default 10s.
export const config = { maxDuration: 60 };

const IS_SANDBOX = (process.env.EXPO_PUBLIC_TRUELAYER_SANDBOX ?? 'false') === 'true';
const TL_AUTH_HOST = IS_SANDBOX ? 'https://auth.truelayer-sandbox.com' : 'https://auth.truelayer.com';
const TL_API_HOST = IS_SANDBOX ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

interface BankRow {
  id: string;
  connection_id: string;
  refresh_token: string;
  user_id: string;
  provider_name: string | null;
  created_at: string;
  updated_at: string;
  csv_data: string | null;
}

interface RefreshResult {
  success: boolean;
  expired?: boolean;
  csvLines?: string[];
  cardBalances?: Array<{ name: string; type: string; balance: number | null; limit: number | null; available: number | null }>;
  newRefreshToken?: string | null;
  txCount?: number;
}

/**
 * Refresh a single TrueLayer connection: refresh token → fetch transactions + balances.
 * Returns updated data or null on failure.
 */
async function refreshConnection(bankRow: BankRow, clientId: string, clientSecret: string, admin: SupabaseClient): Promise<RefreshResult> {
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
      return { success: false, expired: true };
    }

    // Persist the new refresh token IMMEDIATELY — before any data fetches.
    // TrueLayer tokens are single-use. The old token is consumed on exchange.
    // If we wait and the function times out, the new token is lost forever.
    newRefreshToken = tokenData.refresh_token || null;
    if (newRefreshToken && admin) {
      await admin.from('bank_data').update({ refresh_token: newRefreshToken }).eq('id', bankRow.id);
    }

    const headers = { Authorization: `Bearer ${tokenData.access_token}` };

    const [accountsRes, cardsRes] = await Promise.all([
      fetch(`${TL_API_HOST}/data/v1/accounts`, { headers }),
      fetch(`${TL_API_HOST}/data/v1/cards`, { headers }),
    ]);

    const accountsJson = await accountsRes.json();
    const cardsJson = await cardsRes.json();

    // Guard: if TrueLayer returned an error (403, 429, etc.), bail out
    // rather than proceeding with empty arrays and overwriting valid CSV.
    // Refresh token is already persisted above.
    if (!accountsRes.ok || !cardsRes.ok) {
      console.warn(`[bank-sync] TrueLayer data endpoints returned errors — accounts: ${accountsRes.status}, cards: ${cardsRes.status}`);
      return { success: false, expired: false, newRefreshToken: newRefreshToken ?? undefined };
    }

    const accounts: Array<{ account_id: string; display_name?: string; provider?: { display_name?: string } }> = accountsJson.results || [];
    const cards: Array<{ account_id: string; display_name?: string; provider?: { display_name?: string } }> = cardsJson.results || [];

    // Use tomorrow as the upper bound so TrueLayer includes all of today's transactions.
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + 1);
    const to = toDate.toISOString().split('T')[0];
    const fromDate = new Date();
    // Re-syncs fetch 1 month of data (incremental). Initial 12-month pull is in callback.ts.
    fromDate.setMonth(fromDate.getMonth() - 1);
    const from = fromDate.toISOString().split('T')[0];

    const txPromises = [
      ...accounts.map((a) =>
        fetch(`${TL_API_HOST}/data/v1/accounts/${a.account_id}/transactions?from=${from}&to=${to}`, { headers })
          .then((r) => r.json())
          .catch((err: Error) => { console.warn(`[bank-sync] Transaction fetch failed for account ${a.account_id}:`, err.message); return { results: [] }; })
      ),
      ...cards.map((c) =>
        fetch(`${TL_API_HOST}/data/v1/cards/${c.account_id}/transactions?from=${from}&to=${to}`, { headers })
          .then((r) => r.json())
          .catch((err: Error) => { console.warn(`[bank-sync] Transaction fetch failed for card ${c.account_id}:`, err.message); return { results: [] }; })
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
      const desc = (tx.merchant_name || tx.description || '').replace(/,/g, ' ');
      const amount = tx.transaction_type === 'CREDIT' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      csvLines.push(`${date},${desc},${amount}`);
    }

    const cardBalances = cardBalanceResults
      .filter((r) => r.balance)
      .map((r) => ({
        name: r.card.display_name || r.card.provider?.display_name || 'Card',
        type: 'credit_card' as const,
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
          type: isOverdrawn ? 'overdraft' as const : 'overdraft_facility' as const,
          balance: isOverdrawn ? Math.abs(bal.current!) : 0,
          limit: bal.overdraft || null,
          available: bal.available || null,
        };
      })
      .filter(Boolean) as Array<{ name: string; type: string; balance: number; limit: number | null; available: number | null }>;

    return {
      success: true,
      csvLines,
      cardBalances: [...cardBalances, ...accountBalances],
      newRefreshToken,
      txCount: allTx.length,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[bank-sync] Connection ${bankRow.connection_id} failed:`, message);
    // Return the new refresh token even on failure so it can be persisted
    return { success: false, expired: false, newRefreshToken: newRefreshToken ?? undefined };
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

  const clientId = process.env.TRUELAYER_CLIENT_ID;
  const clientSecret = process.env.TRUELAYER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.json({ success: false, error: 'TrueLayer credentials not configured' });
  }

  const admin = createClient(supabaseUrl!, serviceKey);
  const results = { refreshed: 0, failed: 0, expired: 0, total: 0 };
  const refreshedUserIds = new Set<string>();

  try {
    // Get all TrueLayer connections with valid refresh tokens
    const { data: bankRows, error: fetchErr } = await admin
      .from('bank_data')
      .select('id, connection_id, refresh_token, user_id, provider_name, created_at, updated_at, csv_data')
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
      const batch = bankRows.slice(i, i + BATCH_SIZE) as BankRow[];

      const batchResults = await Promise.all(
        batch.map(async (row) => {
          // Skip connections past the 90-day consent window — they need manual re-auth
          const created = new Date(row.created_at || row.updated_at);
          const expiry = new Date(created);
          expiry.setDate(expiry.getDate() + 90);
          if (Date.now() >= expiry.getTime()) {
            return { row, result: { success: false, expired: true } as RefreshResult };
          }

          const result = await refreshConnection(row, clientId, clientSecret, admin);
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
        // Guard: never overwrite stored CSV with empty data.
        const updateFields: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };
        if (result.csvLines && result.csvLines.length > 0) {
          // Merge new transactions with existing stored CSV (incremental sync).
          const existingLines: string[] = [];
          if (row.csv_data) {
            const lines = row.csv_data.split('\n');
            existingLines.push(...lines.slice(1).filter((l: string) => l.trim()));
          }
          const allLines = [...existingLines, ...result.csvLines];
          const seen = new Set<string>();
          const unique: string[] = [];
          for (const line of allLines) {
            const key = line.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ').trim();
            if (!seen.has(key)) {
              seen.add(key);
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

          // Salary-like patterns in description
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

          // Find income-like transactions from this week
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

    console.log(`[bank-sync] Refreshed ${results.refreshed}/${results.total} connections (${results.expired} expired, ${results.failed} failed), enriched ${enriched}/${usersToEnrich.length} users`);
    return res.json({ success: true, ...results, enriched });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[bank-sync] Cron failed:', message);
    return res.status(500).json({ success: false, error: message });
  }
}
