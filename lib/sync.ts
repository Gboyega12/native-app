// ── Shared bank-data sync ──
// Fetches fresh transactions from TrueLayer (or falls back to stored CSV),
// re-runs the enrichment + move engines, and persists the updated analysis.
// Used by both the Home and Plan screens so data stays consistent.

import { supabase } from '@/lib/supabase';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { rankMoves, determineFlowchartPosition } from '@/lib/move-engine';
import type { Analysis, Goals, EnrichedTransaction } from '@/lib/types';

export interface IncomeEvent {
  source: string;
  amount: number;
  date: string;
  frequency: string;
}

export interface WeeklyContext {
  /** Adaptive weekly budget after accounting for large committed payments this period */
  adaptiveBudget: number;
  /** Static weekly budget (leftToDecide / 4.33) */
  staticBudget: number;
  /** Amount of essential/committed spending that landed this week */
  committedThisWeek: number;
  /** Discretionary spent this week */
  discretionaryThisWeek: number;
  /** Whether primary income arrived this week */
  incomeArrivedThisWeek: boolean;
  /** Income events detected since last sync */
  recentIncomeEvents: IncomeEvent[];
}

export interface SyncResult {
  /** The raw analysis (before budget-adjustment merge). */
  analysis: Analysis;
  /** Debt accounts synced from TrueLayer card balances. */
  debtAccounts: any[];
  /** Real-time weekly budget context for adaptive spending guidance. */
  weeklyContext: WeeklyContext;
  /** Where the transaction data came from. */
  dataSource: 'truelayer' | 'fallback';
  /** ISO date of the most recent transaction in the data. */
  latestTransactionDate: string | null;
  /** Non-empty if some bank connections have expired tokens. */
  connectionIssues: string[];
  /** Names of banks with expired connections (e.g. ["Barclays", "HSBC"]). */
  expiredBankNames: string[];
  /** Connections approaching 90-day consent expiry (within 14 days). */
  expiringConnections: { name: string; daysLeft: number }[];
}

/**
 * Deduplicate CSV lines that appear across multiple bank_data rows.
 * Uses date + amount + normalised description as a composite key.
 * Two transactions with the same date, amount, and description are
 * treated as the same transaction regardless of which account they came from.
 */
function deduplicateCSVLines(csvLines: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of csvLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Normalise: lowercase, collapse whitespace, strip quotes
    const key = trimmed.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

/**
 * Reconcile enriched transactions against manual debt accounts.
 * If a BNPL/debt payment is detected in transactions, reduce the matching
 * manual debt account's outstanding balance by the payment amount.
 *
 * Only affects `source: 'manual'` debts — TrueLayer-synced debts get
 * their balance directly from the bank API.
 */
async function reconcileDebtPayments(
  userId: string,
  enrichedTxs: EnrichedTransaction[],
): Promise<void> {
  // Fetch manual debt accounts
  const { data: manualDebts } = await supabase
    .from('debt_accounts')
    .select('id, account_name, outstanding_balance, last_updated')
    .eq('user_id', userId)
    .eq('source', 'manual');

  if (!manualDebts || manualDebts.length === 0) return;

  // Build a map of debt account name (lowercase) → row
  const debtMap = new Map<string, typeof manualDebts[0]>();
  for (const d of manualDebts) {
    debtMap.set(d.account_name.toLowerCase(), d);
  }

  // Scan recent transactions for BNPL/debt payments that match a manual debt
  const now = new Date();
  const recentCutoff = new Date(now);
  recentCutoff.setDate(recentCutoff.getDate() - 30); // Look back 30 days

  for (const tx of enrichedTxs) {
    // Only consider outgoing payments that are flagged as BNPL or debt
    if (tx.amount >= 0) continue;
    if (!tx.isBNPL && !tx.isDebt) continue;
    if (new Date(tx.date) < recentCutoff) continue;

    const paymentAmount = Math.abs(tx.amount);
    const merchant = (tx.merchant || tx.description || '').toLowerCase();

    // Try to match against a manual debt account by name
    for (const [debtName, debtRow] of debtMap) {
      // Check if the transaction merchant contains the debt account name or vice versa
      const nameNorm = debtName.replace(/[^a-z0-9]/g, '');
      const merchantNorm = merchant.replace(/[^a-z0-9]/g, '');
      if (!nameNorm || !merchantNorm) continue;

      const isMatch = merchantNorm.includes(nameNorm) || nameNorm.includes(merchantNorm);
      if (!isMatch) continue;

      // Skip if this payment is older than the last manual update
      // (user may have already accounted for it)
      if (debtRow.last_updated && new Date(tx.date) <= new Date(debtRow.last_updated)) continue;

      // Reduce the outstanding balance
      const newBalance = Math.max(0, (debtRow.outstanding_balance || 0) - paymentAmount);
      await supabase.from('debt_accounts').update({
        outstanding_balance: newBalance,
        last_updated: new Date().toISOString(),
      }).eq('id', debtRow.id);

      // Update local map so subsequent payments are cumulative
      debtRow.outstanding_balance = newBalance;
      debtRow.last_updated = new Date().toISOString();
      break; // one match per transaction
    }
  }
}

/**
 * Sync bank data for a user and return the updated analysis.
 * 1. Calls TrueLayer /api/truelayer/sync for fresh CSV (falls back to stored CSV).
 * 2. Deduplicates transactions across multiple connected accounts.
 * 3. Re-enriches transactions with overrides, debt accounts, identity.
 * 4. Reconciles BNPL/debt payments against manual debt accounts.
 * 5. Ranks moves against the user's goals.
 * 6. Upserts the analysis row + score snapshot.
 * 7. Syncs debt accounts from card_balances.
 *
 * Returns `null` if there's no CSV data to process.
 */
export async function syncBankData(userId: string): Promise<SyncResult | null> {
  // ── 1. Fetch fresh CSV ──
  let csvData: string | null = null;
  let dataSource: 'truelayer' | 'fallback' = 'truelayer';
  const connectionIssues: string[] = [];
  const expiredBankNames: string[] = [];
  const expiringConnections: { name: string; daysLeft: number }[] = [];

  try {
    const syncController = new AbortController();
    const syncTimeout = setTimeout(() => syncController.abort(), 15_000);
    const res = await fetch('/api/truelayer/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
      signal: syncController.signal,
    });
    clearTimeout(syncTimeout);
    const data = await res.json();
    if (data.success && data.csv_data) {
      csvData = data.csv_data;
      // Track partially expired connections with bank names
      if (data.expired_connections?.length > 0) {
        connectionIssues.push('some_connections_expired');
        for (const ec of data.expired_connections) {
          if (ec.provider_name) expiredBankNames.push(ec.provider_name);
        }
      }
    } else if (data.reason === 'token_expired') {
      connectionIssues.push('token_expired');
      // Extract bank names from the all-expired response
      if (data.expired_connections?.length > 0) {
        for (const ec of data.expired_connections) {
          if (ec.provider_name) expiredBankNames.push(ec.provider_name);
        }
      }
    } else if (data.reason === 'sync_failed') {
      // Transient failure (all connections still within 90-day consent window).
      // Don't flag as a connection issue — fall through to cached data silently.
    } else if (data.reason === 'no_connection') {
      connectionIssues.push('no_connection');
    }
    // Extract connections approaching 90-day consent expiry
    if (data.expiring_connections?.length > 0) {
      for (const ec of data.expiring_connections) {
        expiringConnections.push({
          name: ec.provider_name || 'Bank',
          daysLeft: ec.days_left,
        });
      }
    }
  } catch {}

  // If connections have issues but we still don't have bank names, query DB as fallback
  if (connectionIssues.length > 0 && expiredBankNames.length === 0) {
    try {
      const { data: nameRows } = await supabase
        .from('bank_data')
        .select('provider_name')
        .eq('user_id', userId)
        .not('provider_name', 'is', null);
      if (nameRows) {
        for (const row of nameRows) {
          if (row.provider_name) expiredBankNames.push(row.provider_name);
        }
      }
    } catch {}
  }

  // Fallback to existing CSV from all bank_data rows
  if (!csvData) {
    dataSource = 'fallback';
    try {
      const { data: bankRows } = await supabase
        .from('bank_data')
        .select('csv_data')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (bankRows && bankRows.length > 0) {
        const rawLines: string[] = [];
        for (const row of bankRows) {
          if (!row.csv_data) continue;
          const lines = row.csv_data.split('\n');
          rawLines.push(...lines.slice(1).filter((l: string) => l.trim()));
        }
        // Deduplicate transactions that appear in multiple connected accounts
        const uniqueLines = deduplicateCSVLines(rawLines);
        csvData = ['Date,Description,Amount', ...uniqueLines].join('\n');
      }
    } catch {}
  }

  if (!csvData) return null;

  // ── 2. Fetch user config ──
  let overrides: any[] = [];
  let budgetAdjustments: any[] = [];
  try {
    const [overrideRes, adjustmentRes] = await Promise.all([
      supabase
        .from('transaction_overrides')
        .select('match_description, category, is_essential')
        .eq('user_id', userId),
      supabase
        .from('budget_adjustments')
        .select('description, category, monthly_amount, is_essential')
        .eq('user_id', userId),
    ]);
    if (overrideRes.data) overrides = overrideRes.data;
    if (adjustmentRes.data) budgetAdjustments = adjustmentRes.data;
  } catch {}

  let debtAccountsData: any[] = [];
  let identityData: any = null;
  try {
    const [debtRes, idRes] = await Promise.all([
      supabase
        .from('debt_accounts')
        .select('account_name, account_type, outstanding_balance, credit_limit')
        .eq('user_id', userId),
      supabase
        .from('user_identity')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);
    if (debtRes.data) debtAccountsData = debtRes.data;
    if (idRes.data) identityData = idRes.data;
  } catch {}

  // ── 3. Enrich ──
  const result = EnrichmentEngine.enrich(csvData, overrides, debtAccountsData, identityData);
  if (result.enrichedTransactions.length === 0) return null;

  // ── 3b. Reconcile debt payments ──
  // Match BNPL/debt payments in transactions against manual debt accounts
  // and reduce outstanding balances accordingly.
  try {
    await reconcileDebtPayments(userId, result.enrichedTransactions);
    // Re-fetch debt accounts so the rest of the pipeline uses updated balances
    const { data: freshDebt } = await supabase
      .from('debt_accounts')
      .select('account_name, account_type, outstanding_balance, credit_limit')
      .eq('user_id', userId);
    if (freshDebt) debtAccountsData = freshDebt;
  } catch {}

  // ── 4. Rank moves ──
  let goals: Goals | null = null;
  try {
    const { data: goalsData } = await supabase
      .from('goals')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    goals = goalsData;
  } catch {}

  const ukpf = determineFlowchartPosition(result.profile, goals, debtAccountsData, identityData);
  const rankedMoves = rankMoves(result.decisionStack, result.profile, goals, identityData, debtAccountsData);

  // Filter dismissed moves
  const allMoves = [...rankedMoves];
  try {
    const { data: progressRows } = await supabase
      .from('plan_progress')
      .select('move_key, move_action')
      .eq('user_id', userId)
      .like('move_key', 'dismissed-%');
    if (progressRows && progressRows.length > 0) {
      const dismissedActions = new Set(progressRows.map((r: any) => r.move_action));
      for (let i = allMoves.length - 1; i >= 0; i--) {
        if (dismissedActions.has(allMoves[i].action)) allMoves.splice(i, 1);
      }
    }
  } catch {}

  const topMove = allMoves[0] || null;

  // ── 5. Build raw analysis ──
  const rawAnalysis: Analysis = {
    user_id: userId,
    archetype: result.archetype.key,
    decision_score: result.decisionScore.score,
    monthly_income: Math.round(result.profile.monthly.income),
    monthly_spending: Math.round(result.profile.monthly.spending),
    surplus: Math.round(result.profile.monthly.surplus),
    non_discretionary: result.profile.budgetReality.nonDiscretionary,
    discretionary: result.profile.budgetReality.discretionary,
    income_sources: result.profile.incomeSources,
    top_move: topMove || ({} as any),
    all_moves: allMoves,
    behavioral_patterns: result.behavioralPatterns,
    goal_context: topMove?.trajectory || null,
    income_floor: result.profile.monthly.incomeFloor,
    is_variable_income: result.profile.monthly.isVariableIncome,
    income_cv: result.profile.monthly.incomeCV,
  };

  // ── 6. Upsert to Supabase ──
  const fields = {
    archetype: rawAnalysis.archetype,
    decision_score: rawAnalysis.decision_score,
    monthly_income: rawAnalysis.monthly_income,
    monthly_spending: rawAnalysis.monthly_spending,
    surplus: rawAnalysis.surplus,
    non_discretionary: rawAnalysis.non_discretionary,
    discretionary: rawAnalysis.discretionary,
    income_sources: rawAnalysis.income_sources,
    top_move: rawAnalysis.top_move,
    all_moves: rawAnalysis.all_moves,
    behavioral_patterns: rawAnalysis.behavioral_patterns,
    goal_context: rawAnalysis.goal_context,
    income_floor: rawAnalysis.income_floor,
    is_variable_income: rawAnalysis.is_variable_income,
    income_cv: rawAnalysis.income_cv,
  };

  try {
    const { data: existingRow } = await supabase
      .from('analyses')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingRow?.id) {
      await supabase.from('analyses').update(fields).eq('id', existingRow.id);
    } else {
      await supabase.from('analyses').insert({ user_id: userId, ...fields });
    }
  } catch (e: any) {
    console.warn('[sync] Failed to upsert analysis:', e?.message);
  }

  // ── 7. Score snapshot ──
  try {
    const savingsRate = rawAnalysis.monthly_income > 0
      ? Math.round((rawAnalysis.surplus / rawAnalysis.monthly_income) * 100) : 0;
    await supabase.from('score_history').insert({
      user_id: userId,
      decision_score: rawAnalysis.decision_score,
      monthly_income: rawAnalysis.monthly_income,
      monthly_spending: rawAnalysis.monthly_spending,
      surplus: rawAnalysis.surplus,
      savings_rate: savingsRate,
      subscription_count: result.profile.metrics.subscriptionCount || 0,
      debt_account_count: result.profile.metrics.debtAccountCount || 0,
      archetype: rawAnalysis.archetype,
    });
  } catch {}

  // ── 8. Compute latest transaction date for freshness tracking ──
  let latestTransactionDate: string | null = null;
  for (const tx of result.enrichedTransactions) {
    if (tx.date && (!latestTransactionDate || tx.date > latestTransactionDate)) {
      latestTransactionDate = tx.date;
    }
  }

  // ── 9. Income arrival detection + adaptive weekly context ──
  const weeklyContext = buildWeeklyContext(result, rawAnalysis);

  // ── 10. Sync debt accounts from card balances ──
  const syncedDebt: any[] = [];
  try {
    const { data: bankRows } = await supabase
      .from('bank_data')
      .select('card_balances')
      .eq('user_id', userId)
      .not('card_balances', 'is', null);

    if (bankRows && bankRows.length > 0) {
      for (const row of bankRows) {
        if (!Array.isArray(row.card_balances)) continue;
        for (const card of row.card_balances) {
          const { error: upsertErr } = await supabase.from('debt_accounts').upsert({
            user_id: userId,
            account_name: card.name || 'Card',
            account_type: card.type || 'credit_card',
            outstanding_balance: card.balance,
            credit_limit: card.limit,
            source: 'truelayer',
            last_updated: new Date().toISOString(),
          }, { onConflict: 'user_id,account_name' });
          if (!upsertErr) {
            syncedDebt.push({
              account_name: card.name || 'Card',
              account_type: card.type || 'credit_card',
              outstanding_balance: card.balance,
              credit_limit: card.limit,
            });
          }
        }
      }
    }
  } catch {}

  return {
    analysis: rawAnalysis,
    debtAccounts: syncedDebt,
    weeklyContext,
    dataSource,
    latestTransactionDate,
    connectionIssues,
    expiredBankNames,
    expiringConnections,
  };
}

/**
 * Detect income arrivals and build an adaptive weekly spending context.
 *
 * The static weekly budget (leftToDecide / 4.33) doesn't account for the
 * reality of a pay period: if salary arrived Monday and rent/transfers
 * went out the same day, the user's *actual* disposable cash is lower.
 *
 * This function:
 * 1. Detects whether primary income arrived this week
 * 2. Sums committed/essential payments made this week
 * 3. Computes an adaptive weekly budget = (remaining monthly surplus after
 *    committed payments this period) / remaining weeks in the month
 */
function buildWeeklyContext(
  enrichResult: ReturnType<typeof EnrichmentEngine.enrich>,
  analysis: Analysis,
): WeeklyContext {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - diff);
  weekStart.setHours(0, 0, 0, 0);

  const txs = enrichResult.enrichedTransactions;
  const profile = enrichResult.profile;

  // Find transactions that landed this week
  const thisWeekTxs = txs.filter((t) => new Date(t.date) >= weekStart);

  // Detect income arrivals this week
  const incomeThisWeek = thisWeekTxs.filter((t) => t.isIncome && t.amount > 0);
  const incomeSources = profile.incomeSources || [];
  const primarySource = incomeSources.find((s) => s.isSalary) || incomeSources[0] || null;

  const recentIncomeEvents: IncomeEvent[] = incomeThisWeek.map((t) => ({
    source: t.merchant || t.description,
    amount: t.amount,
    date: t.date,
    frequency: incomeSources.find((s) =>
      (t.merchant || t.description).toLowerCase().includes(s.source.toLowerCase())
    )?.frequency || 'unknown',
  }));

  const incomeArrivedThisWeek = recentIncomeEvents.length > 0;

  // Sum committed (essential) spending this week — rent, bills, transfers
  const committedThisWeek = thisWeekTxs
    .filter((t) => t.amount < 0 && (t.isEssential || t.isDebt) && !t.isRefund)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);

  // Sum discretionary spending this week
  const discretionaryThisWeek = thisWeekTxs
    .filter((t) => t.amount < 0 && !t.isEssential && !t.isDebt && !t.isTransfer && !t.isSavings && !t.isRefund)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);

  // Static weekly budget — for variable earners, use the conservative floor
  const rawIncome = analysis.monthly_income || 0;
  const income = analysis.is_variable_income && analysis.income_floor
    ? analysis.income_floor
    : rawIncome;
  const nonDiscTotal = (analysis.non_discretionary as any)?.total || 0;
  const discTotal = (analysis.discretionary as any)?.total || 0;
  const leftToDecide = Math.max(0, income - nonDiscTotal - discTotal);
  const staticBudget = leftToDecide / 4.33;

  // Adaptive budget: account for the fact that large committed payments
  // (rent, transfers) may have already consumed a chunk of this period's surplus.
  // If income arrived this week, recalculate based on actual remaining disposable.
  let adaptiveBudget = staticBudget;

  if (incomeArrivedThisWeek && primarySource) {
    // This period's actual income
    const periodIncome = recentIncomeEvents
      .filter((e) => e.source.toLowerCase().includes((primarySource.source || '').toLowerCase()) || e.amount >= primarySource.avgAmount * 0.8)
      .reduce((s, e) => s + e.amount, 0) || analysis.monthly_income;

    // Remaining after committed payments already made this week
    const remainingAfterCommitted = periodIncome - committedThisWeek - nonDiscTotal * (1 - committedThisWeek / Math.max(nonDiscTotal, 1));

    // Weeks remaining in the month (including this one)
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const weeksRemaining = Math.max(1, (daysInMonth - dayOfMonth + 1) / 7);

    // The adaptive budget = remaining disposable / remaining weeks
    const adaptiveFromPeriod = Math.max(0, remainingAfterCommitted) / weeksRemaining;

    // Use the lower of static and adaptive — be conservative
    adaptiveBudget = Math.min(staticBudget, adaptiveFromPeriod);
  }

  // Hard cap: adaptive budget can never exceed the static weekly budget
  adaptiveBudget = Math.min(adaptiveBudget, staticBudget);

  return {
    adaptiveBudget: Math.round(adaptiveBudget * 100) / 100,
    staticBudget: Math.round(staticBudget * 100) / 100,
    committedThisWeek: Math.round(committedThisWeek * 100) / 100,
    discretionaryThisWeek: Math.round(discretionaryThisWeek * 100) / 100,
    incomeArrivedThisWeek,
    recentIncomeEvents,
  };
}
