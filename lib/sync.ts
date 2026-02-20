// ── Shared bank-data sync ──
// Fetches fresh transactions from TrueLayer (or falls back to stored CSV),
// re-runs the enrichment + move engines, and persists the updated analysis.
// Used by both the Home and Plan screens so data stays consistent.

import { supabase } from '@/lib/supabase';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { rankMoves, determineFlowchartPosition } from '@/lib/move-engine';
import type { Analysis, Goals } from '@/lib/types';

export interface SyncResult {
  /** The raw analysis (before budget-adjustment merge). */
  analysis: Analysis;
  /** Debt accounts synced from TrueLayer card balances. */
  debtAccounts: any[];
}

/**
 * Sync bank data for a user and return the updated analysis.
 * 1. Calls TrueLayer /api/truelayer/sync for fresh CSV (falls back to stored CSV).
 * 2. Re-enriches transactions with overrides, debt accounts, identity.
 * 3. Ranks moves against the user's goals.
 * 4. Upserts the analysis row + score snapshot.
 * 5. Syncs debt accounts from card_balances.
 *
 * Returns `null` if there's no CSV data to process.
 */
export async function syncBankData(userId: string): Promise<SyncResult | null> {
  // ── 1. Fetch fresh CSV ──
  let csvData: string | null = null;
  try {
    const res = await fetch('/api/truelayer/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    const data = await res.json();
    if (data.success && data.csv_data) {
      csvData = data.csv_data;
    }
  } catch {}

  // Fallback to existing CSV from all bank_data rows
  if (!csvData) {
    try {
      const { data: bankRows } = await supabase
        .from('bank_data')
        .select('csv_data')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (bankRows && bankRows.length > 0) {
        const allLines: string[] = ['Date,Description,Amount'];
        for (const row of bankRows) {
          if (!row.csv_data) continue;
          const lines = row.csv_data.split('\n');
          allLines.push(...lines.slice(1).filter((l: string) => l.trim()));
        }
        csvData = allLines.join('\n');
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
        .single(),
    ]);
    if (debtRes.data) debtAccountsData = debtRes.data;
    if (idRes.data) identityData = idRes.data;
  } catch {}

  // ── 3. Enrich ──
  const result = EnrichmentEngine.enrich(csvData, overrides, debtAccountsData, identityData);
  if (result.enrichedTransactions.length === 0) return null;

  // ── 4. Rank moves ──
  let goals: Goals | null = null;
  try {
    const { data: goalsData } = await supabase
      .from('goals')
      .select('*')
      .eq('user_id', userId)
      .single();
    goals = goalsData;
  } catch {}

  const ukpf = determineFlowchartPosition(result.profile, goals, debtAccountsData, identityData);
  const rankedMoves = rankMoves(result.decisionStack, result.profile, goals);

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
  };

  // ── 6. Upsert to Supabase ──
  const { data: existingRow } = await supabase
    .from('analyses')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

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
  };

  if (existingRow?.id) {
    await supabase.from('analyses').update(fields).eq('id', existingRow.id);
  } else {
    await supabase.from('analyses').insert({ user_id: userId, ...fields });
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

  // ── 8. Sync debt accounts from card balances ──
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

  return { analysis: rawAnalysis, debtAccounts: syncedDebt };
}
