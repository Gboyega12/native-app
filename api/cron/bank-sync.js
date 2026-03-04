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

        // ── Income arrival detection & notification ──
        // Check if any large credits arrived this week that look like salary/income
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

          // Find income-like transactions from this week
          const incomeCredits = result.csvLines.filter((line) => {
            const parts = line.split(',');
            if (parts.length < 3) return false;
            const date = parts[0];
            const desc = parts.slice(1, -1).join(',');
            const amount = parseFloat(parts[parts.length - 1]);
            if (!date || date < weekStartStr || amount < 100) return false; // Min £100 credit
            if (TRANSFER_PATTERNS.test(desc) || PERSON_TITLE.test(desc.trim())) return false;
            return SALARY_PATTERNS.test(desc) || EMPLOYER_PATTERNS.test(desc);
          });

          if (incomeCredits.length > 0) {
            // Check we haven't already notified for this week
            const { data: recentLog } = await admin
              .from('notification_log')
              .select('id')
              .eq('user_id', row.user_id)
              .eq('notification_type', 'income_arrival')
              .gte('sent_at', weekStartStr)
              .limit(1);

            if (!recentLog || recentLog.length === 0) {
              // Get user preferences & profile
              const [{ data: prefs }, { data: profile }] = await Promise.all([
                admin.from('notification_preferences').select('email, checkin_prompts').eq('user_id', row.user_id).single(),
                admin.from('profiles').select('full_name').eq('id', row.user_id).single(),
              ]);

              if (prefs?.email && prefs?.checkin_prompts !== false) {
                const topIncome = incomeCredits[0].split(',');
                const incomeAmount = parseFloat(topIncome[topIncome.length - 1]);
                const incomeSource = topIncome.slice(1, -1).join(',').trim();
                const userName = (profile?.full_name || '').split(' ')[0] || 'there';

                const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.bocy.io';
                const notifyEndpoint = `${appUrl.replace(/\/$/, '')}/api/notifications/send`;

                await fetch(notifyEndpoint, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${cronSecret}`,
                  },
                  body: JSON.stringify({
                    to: prefs.email,
                    subject: `£${Math.round(incomeAmount).toLocaleString()} received from ${incomeSource}`,
                    html: `<div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #0A0A0A; color: #fff;">
                      <div style="background: #141414; border: 1px solid #1F1F1F; border-radius: 14px; padding: 24px;">
                        <p style="font-size: 10px; color: #999; letter-spacing: 2px; text-transform: uppercase; margin: 0 0 16px;">PAYDAY</p>
                        <h2 style="font-size: 18px; margin: 0 0 12px;">£${Math.round(incomeAmount).toLocaleString()} received</h2>
                        <p style="font-size: 14px; color: #ccc; line-height: 22px; margin: 0 0 12px;">Hey ${userName}, income from <strong style="color: #fff;">${incomeSource}</strong> just landed.</p>
                        <hr style="border: none; border-top: 1px solid #1F1F1F; margin: 20px 0;">
                        <p style="font-size: 14px; color: #999;">Open Bocy to see where it should go.</p>
                        <div style="margin-top: 20px;"><a href="${appUrl}" style="display: inline-block; background: #00d4aa; color: #000; padding: 12px 28px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px;">See your plan</a></div>
                      </div>
                    </div>`,
                    user_id: row.user_id,
                    notification_type: 'income_arrival',
                    push_body: `£${Math.round(incomeAmount).toLocaleString()} from ${incomeSource} just landed. Open Bocy to see where it should go.`,
                  }),
                }).catch((e) => console.warn('[bank-sync] Income notification failed:', e?.message));
              }
            }
          }
        } catch (notifErr) {
          // Non-critical — don't fail the sync
          console.warn('[bank-sync] Income notification check failed:', notifErr?.message);
        }
      }
    }

    console.log(`[bank-sync] Refreshed ${results.refreshed}/${results.total} connections (${results.expired} expired, ${results.failed} failed)`);
    return res.json({ success: true, ...results });
  } catch (err) {
    console.error('[bank-sync] Cron failed:', err?.message);
    return res.status(500).json({ success: false, error: err?.message });
  }
}
