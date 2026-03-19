// ── Background Verification Endpoint ──
// POST /api/verify with { user_id }
//
// Called fire-and-forget after processing.tsx saves a "draft" analysis.
// Runs Claude AI classification + refinement server-side, then updates
// the analysis row with verification_status = 'verified'.
//
// Also callable by the cron job to pick up any stuck drafts.

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import EnrichmentEngine from '../lib/enrichment-engine.js';
import { rankMoves } from '../lib/move-engine.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { apiSuccess, apiError, methodNotAllowed } from '../lib/api-response.js';

const bodySchema = z.object({
  user_id: z.string().optional(),
});

export const config = { maxDuration: 60 };

const CLASSIFY_BATCH_SIZE = 25;

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
  if (methodNotAllowed(res, req.method, 'POST')) return;

  // ── Auth: accept cron secret or Supabase JWT ──
  const authHeader = (req.headers.authorization as string) || '';
  const cronSecret = process.env.CRON_SECRET;
  const isCronAuth = cronSecret && authHeader === `Bearer ${cronSecret}`;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return apiError(res, 500, 'Server misconfigured');
  }

  const admin = createClient(supabaseUrl, serviceKey);

  if (!isCronAuth) {
    const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!anonKey) return apiError(res, 500, 'Server misconfigured');
    const token = authHeader.replace('Bearer ', '');
    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(token);
    if (authError || !user) return apiError(res, 401, 'Unauthorized');
    if (req.body?.user_id && req.body.user_id !== user.id) {
      return apiError(res, 403, 'Forbidden');
    }
    req.body = { ...req.body, user_id: user.id };
  }

  const bodyParsed = bodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return apiError(res, 400, 'Invalid request', bodyParsed.error.flatten().fieldErrors);
  }
  const userId: string | undefined = bodyParsed.data.user_id;
  if (!userId) {
    return apiError(res, 400, 'Missing user_id');
  }

  // Respond immediately — the caller doesn't need to wait for verification.
  // We continue processing in the background (Vercel keeps the function alive
  // until maxDuration as long as we don't return early with res.end()).
  // Actually, we need to keep the connection open so Vercel doesn't kill us.
  // We'll respond at the end.

  try {
    // ── 1. Find the draft analysis ──
    const { data: draftAnalysis } = await admin
      .from('analyses')
      .select('id')
      .eq('user_id', userId)
      .eq('verification_status', 'draft')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!draftAnalysis?.id) {
      return res.json({ success: false, reason: 'no_draft' });
    }

    // Mark as verifying so we don't double-process
    await admin
      .from('analyses')
      .update({ verification_status: 'verifying' })
      .eq('id', draftAnalysis.id);

    // ── 2. Read stored CSV from bank_data ──
    const { data: bankRows } = await admin
      .from('bank_data')
      .select('csv_data')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (!bankRows || bankRows.length === 0) {
      // Revert to draft so it can be retried
      await admin.from('analyses').update({ verification_status: 'draft' }).eq('id', draftAnalysis.id);
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
      await admin.from('analyses').update({ verification_status: 'draft' }).eq('id', draftAnalysis.id);
      return res.json({ success: false, reason: 'no_transactions' });
    }
    const csvData = ['Date,Description,Amount', ...uniqueLines].join('\n');

    // ── 3. Fetch user config ──
    const [overrideRes, debtRes, idRes, goalsRes] = await Promise.all([
      admin.from('transaction_overrides')
        .select('match_description, category, is_essential, direction')
        .eq('user_id', userId),
      admin.from('debt_accounts')
        .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment')
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

    // ── 4. Enrich (rule-based, fast) ──
    let result = EnrichmentEngine.enrich(csvData, overrides, debtAccountsData, identityData);
    if (result.enrichedTransactions.length === 0) {
      await admin.from('analyses').update({ verification_status: 'draft' }).eq('id', draftAnalysis.id);
      return res.json({ success: false, reason: 'no_enriched_transactions' });
    }

    // ── 5. Claude AI Classification ──
    // Batch low-confidence transactions to Claude in chunks of CLASSIFY_BATCH_SIZE
    const claudeApiUrl = getInternalApiUrl(req) + '/api/claude';
    let classifiedCount = 0;

    try {
      const unclassified = result.enrichedTransactions
        .map((tx: any, i: number) => ({ tx, originalIndex: i }))
        .filter(({ tx }: any) =>
          tx.confidence === 'low'
          && !tx.isIncome
          && !tx.isTransfer
          && !tx.isRefund
          && !tx.isSavings
        );

      if (unclassified.length > 0) {
        const updated = [...result.enrichedTransactions];
        const totalBatches = Math.ceil(unclassified.length / CLASSIFY_BATCH_SIZE);

        for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
          const batchStart = batchIdx * CLASSIFY_BATCH_SIZE;
          const batch = unclassified.slice(batchStart, batchStart + CLASSIFY_BATCH_SIZE);

          try {
            const classifyRes = await fetch(claudeApiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'classify',
                transactions: batch.map(({ tx }: any) => ({
                  description: tx.description,
                  amount: tx.amount,
                })),
              }),
            });
            const classifyData = await classifyRes.json();

            if (classifyData.success && Array.isArray(classifyData.classifications)) {
              classifyData.classifications.forEach((c: any, i: number) => {
                const entry = batch[i];
                if (!entry || c.category === 'Other') return;

                const tx = { ...updated[entry.originalIndex] };
                tx.merchant = c.merchant || tx.merchant;
                tx.category = c.category;
                tx.isEssential = c.isEssential;
                tx.isSubscription = c.isSubscription || tx.isSubscription;
                tx.isDebt = c.isDebt || tx.isDebt;
                tx.isBNPL = c.isBNPL || tx.isBNPL;
                tx.isIncome = c.isIncome || tx.isIncome;
                tx.confidence = c.confidence || 'medium';
                tx.classifiedBy = 'claude_ai';
                updated[entry.originalIndex] = tx;
                classifiedCount++;
              });
            }
          } catch (batchErr: any) {
            console.warn(`[verify] Batch ${batchIdx + 1}/${totalBatches} classify failed:`, batchErr?.message);
          }
        }

        // Rebuild profile with improved classifications
        result = EnrichmentEngine.rebuild(updated, debtAccountsData, identityData);
      }
    } catch (classifyErr: any) {
      console.warn('[verify] Claude classify failed, continuing with rule-based:', classifyErr?.message);
    }

    // ── 6. Rank moves ──
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

    // ── 7. Claude Refinement ──
    // Takes top 3 ranked moves → rewrites into BOCY-style language
    const top3 = allMoves.slice(0, 3);
    let refinedMoves = top3;

    try {
      const enrichRes = await fetch(claudeApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enrich',
          moves: top3.map((m) => ({
            action: m.action,
            category: m.category,
            monthlyImpact: m.monthlyImpact,
            annualImpact: m.annualImpact,
            effort: m.effort,
            merchants: m.merchants,
            strategy: m.strategy,
            steps: m.steps,
            effect: m.effect,
            trajectory: m.trajectory,
          })),
          context: {
            monthly_income: result.profile.monthly.income,
            monthly_spending: result.profile.monthly.spending,
            surplus: result.profile.monthly.surplus,
            goals: goals ? {
              one_year_goal: goals.one_year_goal,
              target_amount: goals.target_amount,
            } : null,
          },
        }),
      });
      const enrichData = await enrichRes.json();
      if (enrichData.success && Array.isArray(enrichData.moves)) {
        refinedMoves = top3.map((original, i) => {
          const refined = enrichData.moves[i];
          if (!refined) return original;
          return {
            ...original,
            action: refined.action || original.action,
            strategy: refined.strategy || original.strategy,
            steps: refined.steps || original.steps,
            effect: refined.effect || original.effect,
            timeline: refined.timeline || original.timeline,
            merchants: (refined.merchants && refined.merchants.length > 0) ? refined.merchants : original.merchants,
          };
        });
      }
    } catch (enrichErr: any) {
      console.warn('[verify] Claude refinement failed, using unrefined moves:', enrichErr?.message);
    }

    const finalMoves = [...refinedMoves, ...allMoves.slice(3)];
    const topMove = finalMoves[0] || null;

    // ── 8. Update the analysis with verified data ──
    const fields = {
      archetype: result.archetype.key,
      decision_score: result.decisionScore.score,
      monthly_income: Math.round(result.profile.monthly.income),
      monthly_spending: Math.round(result.profile.monthly.spending),
      surplus: Math.round(result.profile.monthly.surplus),
      non_discretionary: result.profile.budgetReality.nonDiscretionary,
      discretionary: result.profile.budgetReality.discretionary,
      income_sources: result.profile.incomeSources,
      top_move: topMove || {},
      all_moves: finalMoves,
      behavioral_patterns: result.behavioralPatterns,
      goal_context: topMove?.trajectory || null,
      verification_status: 'verified',
      verified_at: new Date().toISOString(),
    };

    await admin.from('analyses').update(fields).eq('id', draftAnalysis.id);

    console.log(`[verify] Verified analysis ${draftAnalysis.id} for user ${userId} — ${classifiedCount} transactions classified, ${finalMoves.length} moves`);

    return apiSuccess(res, {
      analysis_id: draftAnalysis.id,
      classified_count: classifiedCount,
      move_count: finalMoves.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[verify] Failed:', message);

    // Try to revert status to draft so it can be retried
    try {
      await admin
        .from('analyses')
        .update({ verification_status: 'draft' })
        .eq('user_id', userId)
        .eq('verification_status', 'verifying');
    } catch {}

    return apiError(res, 500, 'Verification failed', message);
  }
}

/**
 * Resolve the internal API base URL for server-to-server calls.
 */
function getInternalApiUrl(req: VercelRequest): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL;
  if (appUrl) {
    const base = appUrl.startsWith('http') ? appUrl : `https://${appUrl}`;
    return base.replace(/\/$/, '');
  }
  // Fallback: derive from request headers
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}
