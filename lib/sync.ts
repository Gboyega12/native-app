// ── Shared bank-data sync ──
// Fetches fresh transactions from TrueLayer (or falls back to stored CSV),
// re-runs the enrichment + move engines, and persists the updated analysis.
// Used by both the Home and Plan screens so data stays consistent.

import { supabase } from '@/lib/supabase';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { rankMoves } from '@/lib/move-engine';
import { runReactiveEngine, type ReactiveResult } from '@/lib/reactive-engine';
import { buildSystemMap, detectInsights } from '@/lib/insight-engine';
import { classifyAccounts } from '@/lib/account-classifier';
import type { Analysis, Goals, EnrichedTransaction, FinancialProfile, UserIdentity, DebtAccount, BudgetAdjustment, BudgetSection, Move } from '@/lib/types';
import type { TransactionOverride } from '@/lib/enrichment-engine';
import { DEFAULT_APR, defaultMinimumPayment } from '@/lib/constants';

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
  /** The raw analysis (before budget-adjustment merge). Null when bank is connected but enrichment found no usable transactions yet. */
  analysis: Analysis | null;
  /** Debt accounts synced from TrueLayer card balances. */
  debtAccounts: DebtAccount[];
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
  /** Reactive engine results: events, next move suggestion, achievements. */
  reactive: ReactiveResult | null;
  /** Epoch ms when this sync started — used to reject stale results after override saves. */
  syncStartedAt: number;
}

/**
 * Deduplicate CSV lines that appear across multiple bank_data rows.
 * Uses date + amount + normalised description as a composite key.
 *
 * Count-based: if the same key appears N times in one row and M times
 * in another, we keep max(N, M) — not N+M — so cross-account duplicates
 * are merged while legitimate same-day/same-amount transactions within
 * one account are preserved.
 */
function deduplicateCSVLines(csvLines: string[], perRowLines?: string[][]): string[] {
  const normalise = (l: string) => l.trim().toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ');

  // If per-row breakdown is provided, use count-based dedup
  if (perRowLines && perRowLines.length > 0) {
    const rowMaps = perRowLines.map((lines) => {
      const counts = new Map<string, number>();
      const ref = new Map<string, string>();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const key = normalise(trimmed);
        counts.set(key, (counts.get(key) || 0) + 1);
        if (!ref.has(key)) ref.set(key, trimmed);
      }
      return { counts, ref };
    });
    const allKeys = new Set<string>();
    for (const { counts } of rowMaps) for (const k of counts.keys()) allKeys.add(k);
    const unique: string[] = [];
    for (const k of allKeys) {
      let best = 0;
      let line = '';
      for (const { counts, ref } of rowMaps) {
        const c = counts.get(k) || 0;
        if (c > best) { best = c; line = ref.get(k) || line; }
      }
      for (let i = 0; i < best; i++) unique.push(line);
    }
    return unique;
  }

  // Fallback: simple Set-based dedup (single source)
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of csvLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = normalise(trimmed);
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
  const syncStartedAt = Date.now();
  // ── 1. Fetch fresh CSV ──
  let csvData: string | null = null;
  let dataSource: 'truelayer' | 'fallback' = 'truelayer';
  const connectionIssues: string[] = [];
  const expiredBankNames: string[] = [];
  let syncFailedNoConnection = false;
  const expiringConnections: { name: string; daysLeft: number }[] = [];

  try {
    const syncController = new AbortController();
    const syncTimeout = setTimeout(() => syncController.abort(), 45_000);
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/truelayer/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
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
      // Transient failure — DON'T push to connectionIssues here.
      // The fallback path below will load cached CSV, and the caller
      // will see dataSource='fallback' which triggers appropriate
      // freshness checks (stale_data vs fallback) instead of a scary
      // "reconnect your bank" banner for a transient TrueLayer outage.
      console.warn('[sync] All connections failed (transient, within 90-day window) — will use fallback data');
    } else if (data.reason === 'no_connection') {
      // Don't push immediately — wait to see if we have cached CSV.
      // The token may be dead but the data is still in bank_data.
      // We'll check after the fallback query below.
      syncFailedNoConnection = true;
      console.warn('[sync] No active TrueLayer connections found — will check for cached data');
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
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] TrueLayer sync request failed:', message);
  }

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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn('[sync] Failed to fetch bank names:', message);
    }
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
        const perRowLines: string[][] = [];
        const rawLines: string[] = [];
        for (const row of bankRows) {
          if (!row.csv_data) continue;
          const lines = row.csv_data.split('\n').slice(1).filter((l: string) => l.trim());
          perRowLines.push(lines);
          rawLines.push(...lines);
        }
        // Deduplicate across accounts while preserving legitimate duplicates within each
        const uniqueLines = deduplicateCSVLines(rawLines, perRowLines);
        csvData = ['Date,Description,Amount', ...uniqueLines].join('\n');
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn('[sync] Failed to read fallback CSV:', message);
    }
  }

  // Deferred no_connection check: only flag as a real issue if there's
  // genuinely no cached data. If we loaded fallback CSV, the user has data —
  // the refresh token is just dead. Treat as stale data, not "no connection".
  if (syncFailedNoConnection && !csvData) {
    connectionIssues.push('no_connection');
  }

  if (!csvData) return null;

  // ── 2. Fetch user config ──
  let overrides: TransactionOverride[] = [];
  let budgetAdjustments: BudgetAdjustment[] = [];
  try {
    const [overrideRes, adjustmentRes] = await Promise.all([
      supabase
        .from('transaction_overrides')
        .select('match_description, category, is_essential, direction')
        .eq('user_id', userId),
      supabase
        .from('budget_adjustments')
        .select('description, category, monthly_amount, is_essential')
        .eq('user_id', userId),
    ]);
    if (overrideRes.data) overrides = overrideRes.data;
    if (adjustmentRes.data) budgetAdjustments = adjustmentRes.data;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] Failed to fetch user config:', message);
  }

  // ── 2b. Sync debt accounts from card balances BEFORE enrichment ──
  // This must happen before we query debt_accounts so the enrichment engine
  // and move ranking have access to connected credit card data on the first sync.
  const syncedDebt: DebtAccount[] = [];
  try {
    const { data: bankRows } = await supabase
      .from('bank_data')
      .select('card_balances, provider_name')
      .eq('user_id', userId)
      .not('card_balances', 'is', null);

    if (bankRows && bankRows.length > 0) {
      for (const row of bankRows) {
        if (!Array.isArray(row.card_balances)) continue;
        for (const card of row.card_balances) {
          const cardName = card.name || row.provider_name || 'Card';
          const acctType = card.type || 'credit_card';
          const defaultApr = DEFAULT_APR[acctType] ?? DEFAULT_APR.credit_card;
          const defaultMin = defaultMinimumPayment(acctType, card.balance || 0);
          const { error: upsertErr } = await supabase.from('debt_accounts').upsert({
            user_id: userId,
            account_name: cardName,
            account_type: acctType,
            outstanding_balance: card.balance,
            credit_limit: card.limit,
            interest_rate: defaultApr,
            minimum_payment: defaultMin,
            is_default_apr: true,
            source: 'truelayer',
            last_updated: new Date().toISOString(),
          }, { onConflict: 'user_id,account_name' });
          if (!upsertErr) {
            syncedDebt.push({
              account_name: cardName,
              account_type: card.type || 'credit_card',
              outstanding_balance: card.balance,
              credit_limit: card.limit,
              interest_rate: defaultApr,
              is_default_apr: true,
              provider_name: row.provider_name || undefined,
            });
          }
        }
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] Failed to sync debt accounts from card balances:', message);
  }

  let debtAccountsData: DebtAccount[] = [];
  let identityData: UserIdentity | null = null;
  try {
    const [debtRes, idRes] = await Promise.all([
      supabase
        .from('debt_accounts')
        .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, is_default_apr, provider_name')
        .eq('user_id', userId),
      supabase
        .from('user_identity')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);
    if (debtRes.data) debtAccountsData = debtRes.data;
    if (idRes.data) identityData = idRes.data;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] Failed to fetch debt/identity data:', message);
  }

  // ── 3. Enrich ──
  const result = EnrichmentEngine.enrich(csvData, overrides, debtAccountsData, identityData);
  if (result.enrichedTransactions.length === 0) {
    // Bank is connected but all transactions were filtered out (pending, £0, etc.).
    // Return a partial result so the caller knows the bank IS connected — don't
    // return null which makes the dashboard think there's no connection at all.
    console.warn('[sync] Enrichment returned 0 transactions — bank connected but no usable data yet');
    connectionIssues.push('no_transactions_yet');
    return {
      analysis: null,
      debtAccounts: [],
      weeklyContext: { adaptiveBudget: 0, staticBudget: 0, committedThisWeek: 0, discretionaryThisWeek: 0, incomeArrivedThisWeek: false, recentIncomeEvents: [] },
      dataSource,
      latestTransactionDate: null,
      connectionIssues,
      expiredBankNames,
      expiringConnections,
      reactive: null,
      syncStartedAt,
    };
  }

  // ── 3b. Reconcile debt payments ──
  // Match BNPL/debt payments in transactions against manual debt accounts
  // and reduce outstanding balances accordingly.
  try {
    await reconcileDebtPayments(userId, result.enrichedTransactions);
    // Re-fetch debt accounts so the rest of the pipeline uses updated balances
    const { data: freshDebt } = await supabase
      .from('debt_accounts')
      .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, is_default_apr, provider_name')
      .eq('user_id', userId);
    if (freshDebt) debtAccountsData = freshDebt;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] Debt reconciliation failed:', message);
  }

  // ── 3c. Compute essential gap deduction for conservative surplus ──
  // When essential costs are missing from transactions (rent via partner,
  // variable bills, etc.), use the midpoint of typical ranges as a
  // conservative deduction so the CRRA engine doesn't overvalue savings/invest.
  if (result.essentialGaps && result.essentialGaps.length > 0) {
    const gapDeduction = result.essentialGaps.reduce((sum, gap) => {
      // Use midpoint of typical range as conservative estimate
      return sum + (gap.typicalRange.low + gap.typicalRange.high) / 2;
    }, 0);
    (result.profile as FinancialProfile & { essentialGapDeduction?: number }).essentialGapDeduction = Math.round(gapDeduction);
  }

  // ── 4. Rank moves ──
  let goals: Goals | null = null;
  try {
    const { data: goalsData } = await supabase
      .from('goals')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    goals = goalsData;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] Failed to fetch goals:', message);
  }

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
      const dismissedActions = new Set(progressRows.map((r: { move_action: string }) => r.move_action));
      for (let i = allMoves.length - 1; i >= 0; i--) {
        if (dismissedActions.has(allMoves[i].action)) allMoves.splice(i, 1);
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] Failed to filter dismissed moves:', message);
  }

  const topMove = allMoves[0] || null;

  // ── 4b. Detect insights from system map ──
  let detectedInsights: import('@/lib/types').Insight[] = [];
  try {
    // Fetch account balances for system map
    const { data: bankBalanceRows } = await supabase
      .from('bank_data')
      .select('account_balances')
      .eq('user_id', userId)
      .not('account_balances', 'is', null);

    const accountBalances = (bankBalanceRows || []).flatMap((r: any) =>
      Array.isArray(r.account_balances) ? r.account_balances : [],
    );

    const accounts = accountBalances.length > 0 ? classifyAccounts(accountBalances) : null;
    const systemMap = buildSystemMap(result.profile as FinancialProfile, accounts, debtAccountsData);
    detectedInsights = detectInsights(systemMap, result.profile as FinancialProfile, allMoves, debtAccountsData);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] Insight detection failed (non-blocking):', message);
  }

  // ── 5. Build raw analysis ──
  const rawAnalysis: Analysis = {
    user_id: userId,
    segment: result.segment,
    decision_score: result.decisionScore.score,
    monthly_income: Math.round(result.profile.monthly.income),
    monthly_spending: Math.round(result.profile.monthly.spending),
    surplus: Math.round(result.profile.monthly.surplus),
    non_discretionary: result.profile.budgetReality.nonDiscretionary,
    discretionary: result.profile.budgetReality.discretionary,
    income_sources: result.profile.incomeSources,
    top_move: topMove || ({} as Move),
    all_moves: allMoves,
    behavioral_patterns: result.behavioralPatterns,
    goal_context: topMove?.trajectory || null,
    income_floor: result.profile.monthly.incomeFloor,
    is_variable_income: result.profile.monthly.isVariableIncome,
    income_cv: result.profile.monthly.incomeCV,
    essential_gaps: result.essentialGaps,
    verified_bills: result.verifiedBills,
    person_transfers: result.profile.transfers,
    savings_categories: (result.profile as any).savingsCategories,
    monthly_savings: Math.round((result.profile as any).monthlySavings || 0),
    incoming_transfers: (result.profile as any).incomingTransfers,
    enrichment_metrics: {
      subscriptionCount: result.profile.metrics.subscriptionCount,
      streamingCount: result.profile.metrics.streamingCount,
      creditCardCount: result.profile.metrics.creditCardCount,
      bnplCount: result.profile.metrics.bnplCount,
    },
    analysis_months: (result.profile as any).months || 1,
    insights: detectedInsights.length > 0 ? detectedInsights : undefined,
  };

  // ── 6. Upsert to Supabase ──
  const fields = {
    segment: rawAnalysis.segment,
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
    person_transfers: rawAnalysis.person_transfers,
    essential_gaps: rawAnalysis.essential_gaps,
    verified_bills: rawAnalysis.verified_bills,
    savings_categories: rawAnalysis.savings_categories,
    monthly_savings: rawAnalysis.monthly_savings,
    incoming_transfers: rawAnalysis.incoming_transfers,
    enrichment_metrics: rawAnalysis.enrichment_metrics,
    analysis_months: rawAnalysis.analysis_months,
    insights: rawAnalysis.insights,
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
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] Failed to upsert analysis:', message);
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
      segment: rawAnalysis.segment,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] Failed to insert score snapshot:', message);
  }

  // ── 8. Compute latest transaction date for freshness tracking ──
  let latestTransactionDate: string | null = null;
  for (const tx of result.enrichedTransactions) {
    if (tx.date && (!latestTransactionDate || tx.date > latestTransactionDate)) {
      latestTransactionDate = tx.date;
    }
  }

  // ── 9. Income arrival detection + adaptive weekly context ──
  const weeklyContext = buildWeeklyContext(result, rawAnalysis);

  // ── 10. (Moved earlier — card balance sync now happens before enrichment) ──

  // ── 11. Reactive engine — close the feedback loop ──
  let reactive: ReactiveResult | null = null;
  try {
    reactive = await runReactiveEngine(
      userId,
      rawAnalysis,
      result.enrichedTransactions,
      result.profile as FinancialProfile,
      goals,
      identityData,
      debtAccountsData,
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[sync] Reactive engine failed:', message);
  }

  return {
    analysis: rawAnalysis,
    debtAccounts: debtAccountsData,
    weeklyContext,
    dataSource,
    latestTransactionDate,
    connectionIssues,
    expiredBankNames,
    expiringConnections,
    reactive,
    syncStartedAt,
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

  // Detect income arrivals this week — only from recognised income sources, not transfers
  const incomeSources = profile.incomeSources || [];
  const primarySource = incomeSources.find((s) => s.isSalary) || incomeSources[0] || null;

  // Filter: must be flagged isIncome, positive amount, NOT a transfer,
  // and must match a known income source (by name or amount pattern)
  const incomeThisWeek = thisWeekTxs.filter((t) => {
    if (!t.isIncome || t.amount <= 0 || t.isTransfer) return false;
    // Must match a recognised income source
    const txLabel = (t.merchant || t.description || '').toLowerCase();
    return incomeSources.some((s) =>
      txLabel.includes(s.source.toLowerCase()) ||
      (s.isSalary && t.amount >= s.avgAmount * 0.7)
    );
  });

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
  const nonDiscTotal = (analysis.non_discretionary as BudgetSection)?.total || 0;
  const discTotal = (analysis.discretionary as BudgetSection)?.total || 0;
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
