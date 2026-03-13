// ── Server-side Enrichment Endpoint ──
// Takes a user_id (authenticated via cron secret or Supabase JWT),
// reads stored CSV from bank_data, runs the enrichment + move engines,
// and upserts the updated analysis. This keeps the analyses row fresh
// even when the user doesn't open the app.

import { createClient } from '@supabase/supabase-js';
import EnrichmentEngine from '../lib/enrichment-engine.js';
import { rankMoves, determineFlowchartPosition } from '../lib/move-engine.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = { maxDuration: 30 };

/**
 * Deduplicate CSV lines across multiple bank_data rows.
 */
function deduplicateCSVLines(csvLines: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of csvLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authenticate: accept either cron secret or Supabase JWT
  const authHeader = (req.headers.authorization as string) || '';
  const cronSecret = process.env.CRON_SECRET;
  const isCronAuth = cronSecret && authHeader === `Bearer ${cronSecret}`;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  if (!isCronAuth) {
    // Verify Supabase JWT
    const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!anonKey) return res.status(500).json({ error: 'Server misconfigured' });
    const token = authHeader.replace('Bearer ', '');
    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.body?.user_id && req.body.user_id !== user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.body = { ...req.body, user_id: user.id };
  }

  const userId: string | undefined = req.body?.user_id;
  if (!userId) {
    return res.status(400).json({ error: 'Missing user_id' });
  }

  try {
    // ── 1. Read stored CSV from bank_data ──
    const { data: bankRows } = await admin
      .from('bank_data')
      .select('csv_data')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (!bankRows || bankRows.length === 0) {
      return res.json({ success: false, reason: 'no_data' });
    }

    const rawLines: string[] = [];
    for (const row of bankRows) {
      if (!row.csv_data) continue;
      const lines = (row.csv_data as string).split('\n');
      rawLines.push(...lines.slice(1).filter((l: string) => l.trim()));
    }
    const uniqueLines = deduplicateCSVLines(rawLines);
    if (uniqueLines.length === 0) {
      return res.json({ success: false, reason: 'no_transactions' });
    }
    const csvData = ['Date,Description,Amount', ...uniqueLines].join('\n');

    // ── 2. Fetch user config ──
    const [overrideRes, adjustmentRes, debtRes, idRes, goalsRes] = await Promise.all([
      admin.from('transaction_overrides')
        .select('match_description, category, is_essential, direction')
        .eq('user_id', userId),
      admin.from('budget_adjustments')
        .select('description, category, monthly_amount, is_essential')
        .eq('user_id', userId),
      admin.from('debt_accounts')
        .select('account_name, account_type, outstanding_balance, credit_limit')
        .eq('user_id', userId),
      admin.from('user_identity')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
      admin.from('goals')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    const overrides = overrideRes.data || [];
    const debtAccountsData = debtRes.data || [];
    const identityData = idRes.data || null;
    const goals = goalsRes.data || null;

    // ── 3. Enrich ──
    const result = EnrichmentEngine.enrich(csvData, overrides, debtAccountsData, identityData);
    if (result.enrichedTransactions.length === 0) {
      return res.json({ success: false, reason: 'no_enriched_transactions' });
    }

    // ── 4. Rank moves ──
    determineFlowchartPosition(result.profile, goals, debtAccountsData, identityData);
    const rankedMoves = rankMoves(result.decisionStack, result.profile, goals, identityData, debtAccountsData);

    // Filter dismissed moves
    const allMoves = [...rankedMoves];
    try {
      const { data: progressRows } = await admin
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
    } catch {}

    const topMove = allMoves[0] || null;

    // ── 5. Build analysis ──
    const rawAnalysis = {
      user_id: userId,
      archetype: result.archetype.key,
      decision_score: result.decisionScore.score,
      monthly_income: Math.round(result.profile.monthly.income),
      monthly_spending: Math.round(result.profile.monthly.spending),
      surplus: Math.round(result.profile.monthly.surplus),
      non_discretionary: result.profile.budgetReality.nonDiscretionary,
      discretionary: result.profile.budgetReality.discretionary,
      income_sources: result.profile.incomeSources,
      top_move: topMove || {},
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

    const { data: existingRow } = await admin
      .from('analyses')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingRow?.id) {
      await admin.from('analyses').update(fields).eq('id', existingRow.id);
    } else {
      await admin.from('analyses').insert({ user_id: userId, ...fields });
    }

    // ── 7. Score snapshot ──
    const savingsRate = rawAnalysis.monthly_income > 0
      ? Math.round((rawAnalysis.surplus / rawAnalysis.monthly_income) * 100) : 0;
    await admin.from('score_history').insert({
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

    // ── 8. Latest transaction date ──
    let latestTransactionDate: string | null = null;
    for (const tx of result.enrichedTransactions) {
      if (tx.date && (!latestTransactionDate || tx.date > latestTransactionDate)) {
        latestTransactionDate = tx.date;
      }
    }

    console.log(`[enrich] Updated analysis for user ${userId} — ${result.enrichedTransactions.length} transactions, latest: ${latestTransactionDate}`);

    return res.json({
      success: true,
      transactions_enriched: result.enrichedTransactions.length,
      latest_transaction_date: latestTransactionDate,
      decision_score: rawAnalysis.decision_score,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[enrich] Failed:', message);
    return res.status(500).json({ error: 'Enrichment failed', details: message });
  }
}
