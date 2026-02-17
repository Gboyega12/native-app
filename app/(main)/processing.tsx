import { useEffect, useState, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { rankMoves, determineFlowchartPosition, calcGoalTrajectory } from '@/lib/move-engine';
import type { RankedMove } from '@/lib/move-engine';
import ErrorBoundary from '@/components/ErrorBoundary';
import { colors, fonts, spacing } from '@/theme';
import type { Analysis, Goals, BudgetCategory } from '@/lib/types';

const STEPS = [
  'Scanning transactions',
  'Identifying merchants',
  'Enriching transactions',
  'Verifying with AI',
  'Detecting spending patterns',
  'Ranking by financial priority',
  'Refining your action plan',
];

const CLASSIFY_BATCH_SIZE = 25; // Send to Claude in batches of 25

// Global holder so dashboard can pick it up without re-fetching
let _lastResult: Analysis | null = null;
export function getLastResult(): Analysis | null { return _lastResult; }

function ProcessingInner() {
  const router = useRouter();
  const { csvData } = useLocalSearchParams<{ csvData: string }>();
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState('');
  const [enrichProgress, setEnrichProgress] = useState('');
  const fadeAnims = useRef(STEPS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    runAnalysis();
  }, []);

  useEffect(() => {
    if (currentStep < STEPS.length) {
      Animated.timing(fadeAnims[currentStep], {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }
  }, [currentStep]);

  const runAnalysis = async () => {
    try {
      if (!csvData || csvData.trim().length < 10) {
        setError('No transaction data found. Please go back and upload a bank statement.');
        return;
      }

      // ── Layer 1: Enrichment Engine ──
      // CSV → categorise, profile, raw moves
      setCurrentStep(0);
      await delay(400);

      // Fetch user's transaction overrides + manual budget items
      let overrides: any[] = [];
      let budgetAdjustments: any[] = [];
      try {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (authUser) {
          const [overrideRes, adjustmentRes] = await Promise.all([
            supabase
              .from('transaction_overrides')
              .select('match_description, category, is_essential')
              .eq('user_id', authUser.id),
            supabase
              .from('budget_adjustments')
              .select('description, category, monthly_amount, is_essential')
              .eq('user_id', authUser.id),
          ]);
          if (overrideRes.data) overrides = overrideRes.data;
          if (adjustmentRes.data) budgetAdjustments = adjustmentRes.data;
        }
      } catch {}

      setCurrentStep(1);
      let result = EnrichmentEngine.enrich(csvData, overrides);

      if (result.enrichedTransactions.length === 0) {
        setError('No transactions found in your data. Check the file format — it should have Date, Description, and Amount columns.');
        return;
      }
      await delay(400);

      // ── Layer 1.5: Enrichment — every transaction goes through enrichment ──
      setCurrentStep(2);
      setEnrichProgress(`${result.enrichedTransactions.length} transactions enriched`);
      await delay(400);

      // ── Layer 2: Claude AI Verification ──
      // Batch low-confidence transactions to Claude in chunks of CLASSIFY_BATCH_SIZE
      // so nothing falls off during enrichment.
      setCurrentStep(3);
      try {
        const unclassified = result.enrichedTransactions
          .map((tx, i) => ({ tx, originalIndex: i }))
          .filter(({ tx }) =>
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

            setEnrichProgress(`Verifying batch ${batchIdx + 1} of ${totalBatches} (${batch.length} transactions)`);

            try {
              const classifyRes = await fetch('/api/claude/classify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  transactions: batch.map(({ tx }) => ({
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
                  updated[entry.originalIndex] = tx;
                });
              }
            } catch (batchErr: any) {
              console.warn(`[processing] Batch ${batchIdx + 1} classify failed:`, batchErr?.message);
              // Continue with remaining batches
            }

            await delay(200);
          }

          // Rebuild profile with all improved data
          result = EnrichmentEngine.rebuild(updated);
          setEnrichProgress(`${unclassified.length} transactions verified`);
        }
      } catch (classifyErr: any) {
        console.warn('[processing] Claude classify failed, falling back to rule-based enrichment:', classifyErr?.message || classifyErr);
        const lowConfCount = result.enrichedTransactions.filter((t) => t.confidence === 'low' && !t.isIncome && !t.isTransfer).length;
        if (lowConfCount > 0) {
          console.warn(`[processing] ${lowConfCount} transactions stuck as "Other" — Claude AI fallback unavailable`);
        }
      }
      await delay(400);

      setCurrentStep(4);
      setEnrichProgress('');
      await delay(400);

      // Fetch user goals
      let user: any = null;
      try {
        const { data: { user: u } } = await supabase.auth.getUser();
        user = u;
      } catch (authErr: any) {
        console.warn('[processing] getUser failed:', authErr?.message);
      }
      let goals: Goals | null = null;
      if (user) {
        const { data } = await supabase
          .from('goals')
          .select('*')
          .eq('user_id', user.id)
          .single();
        goals = data;
      }

      // ── Layer 2: Move Engine ──
      // UKPF flowchart priority + goal-aware ranking + trajectories
      setCurrentStep(5);
      const ukpf = determineFlowchartPosition(result.profile, goals);
      const rankedMoves = rankMoves(result.decisionStack, result.profile, goals);
      const topRanked = rankedMoves[0] || null;
      const goalTrajectory = topRanked ? topRanked.trajectory : null;
      await delay(400);

      // ── Layer 3: Claude Refinement ──
      // Takes top 3 ranked moves + raw data → rewrites into BOCY-style language
      setCurrentStep(6);
      const top3 = rankedMoves.slice(0, 3);
      let refinedMoves = top3 as RankedMove[];

      try {
        const res = await fetch('/api/claude/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
              ukpf_priority: ukpf.priority,
              ukpf_label: ukpf.label,
            },
          }),
        });
        const data = await res.json();
        if (data.success && Array.isArray(data.moves)) {
          // Merge Claude's refined text with our ranked data
          refinedMoves = top3.map((original, i) => {
            const refined = data.moves[i];
            if (!refined) return original;
            return {
              ...original,
              action: refined.action || original.action,
              strategy: refined.strategy || original.strategy,
              steps: refined.steps || original.steps,
              effect: refined.effect || original.effect,
              timeline: refined.timeline || original.timeline,
            };
          });
        }
      } catch {
        // Graceful fallback — use pre-refined moves from Layer 2
      }

      // Combine: refined top 3 + remaining unrefined moves
      const allMoves = [
        ...refinedMoves,
        ...rankedMoves.slice(3),
      ];

      await delay(300);

      // ── Merge manual budget adjustments ──
      const nonDiscSection = { ...result.profile.budgetReality.nonDiscretionary };
      const discSection = { ...result.profile.budgetReality.discretionary };
      nonDiscSection.items = [...(nonDiscSection.items || [])];
      discSection.items = [...(discSection.items || [])];

      for (const adj of budgetAdjustments) {
        const section = adj.is_essential ? nonDiscSection : discSection;
        const existing = section.items.find((i: BudgetCategory) => i.category === adj.category);
        if (existing) {
          existing.monthly += adj.monthly_amount;
          existing.txs += 1;
          existing.transactions = [...(existing.transactions || []), {
            date: new Date().toISOString().split('T')[0],
            merchant: adj.description,
            description: adj.description + ' (manual)',
            amount: -Math.abs(adj.monthly_amount),
          }];
        } else {
          section.items.push({
            category: adj.category,
            monthly: adj.monthly_amount,
            txs: 1,
            transactions: [{
              date: new Date().toISOString().split('T')[0],
              merchant: adj.description,
              description: adj.description + ' (manual)',
              amount: -Math.abs(adj.monthly_amount),
            }],
          });
        }
        section.total = section.items.reduce((s: number, i: BudgetCategory) => s + i.monthly, 0);
      }

      const totalManualSpend = budgetAdjustments.reduce((s: number, a: any) => s + a.monthly_amount, 0);

      // ── Save to Supabase ──
      const topMove = allMoves[0] || null;
      const analysis: Analysis = {
        user_id: user?.id ?? undefined,
        archetype: result.archetype.key,
        decision_score: result.decisionScore.score,
        monthly_income: Math.round(result.profile.monthly.income),
        monthly_spending: Math.round(result.profile.monthly.spending + totalManualSpend),
        surplus: Math.round(result.profile.monthly.surplus - totalManualSpend),
        non_discretionary: nonDiscSection,
        discretionary: discSection,
        income_sources: result.profile.incomeSources,
        top_move: topMove || ({} as any),
        all_moves: allMoves,
        behavioral_patterns: result.behavioralPatterns,
        goal_context: goalTrajectory,
      };

      if (user?.id) {
        try {
          const { error: insertError } = await supabase.from('analyses').insert({
            user_id: user.id,
            archetype: analysis.archetype,
            decision_score: analysis.decision_score,
            monthly_income: analysis.monthly_income,
            monthly_spending: analysis.monthly_spending,
            surplus: analysis.surplus,
            non_discretionary: analysis.non_discretionary,
            discretionary: analysis.discretionary,
            income_sources: analysis.income_sources,
            top_move: analysis.top_move,
            all_moves: analysis.all_moves,
            behavioral_patterns: analysis.behavioral_patterns,
            goal_context: analysis.goal_context,
          });
          if (insertError) {
            console.warn('[processing] Supabase insert failed:', insertError.message);
          }

          // Save card + account balances to debt_accounts (from TrueLayer data)
          try {
            const { data: bankRows } = await supabase
              .from('bank_data')
              .select('card_balances')
              .eq('user_id', user.id)
              .not('card_balances', 'is', null)
              .order('created_at', { ascending: false })
              .limit(1)
              .single();

            if (bankRows?.card_balances && Array.isArray(bankRows.card_balances)) {
              for (const card of bankRows.card_balances) {
                await supabase.from('debt_accounts').upsert({
                  user_id: user.id,
                  account_name: card.name || 'Card',
                  account_type: card.type || 'credit_card',
                  outstanding_balance: card.balance,
                  credit_limit: card.limit,
                  source: 'truelayer',
                  last_updated: new Date().toISOString(),
                }, { onConflict: 'user_id,account_name' }).then(() => {});
              }
              console.log('[processing] Saved', bankRows.card_balances.length, 'debt account(s)');
            }
          } catch (debtErr: any) {
            console.warn('[processing] Non-critical: debt accounts save failed:', debtErr?.message);
          }
        } catch (dbErr: any) {
          console.warn('[processing] Supabase insert threw:', dbErr?.message);
        }
      } else {
        console.warn('[processing] No authenticated user — analysis saved in-memory only');
      }

      // Store for dashboard
      _lastResult = {
        ...analysis,
        _enrichmentResult: result,
        _archetype: result.archetype,
        _decisionScore: result.decisionScore,
      } as any;

      router.replace('/(main)/(tabs)');
    } catch (err: any) {
      setError(err.message || 'Analysis failed. Please try again.');
    }
  };

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorIcon}>!</Text>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Analysing your data</Text>
      <View style={styles.steps}>
        {STEPS.map((step, i) => (
          <Animated.View key={i} style={[styles.stepRow, { opacity: fadeAnims[i] }]}>
            <Text style={[styles.stepIcon, i <= currentStep && styles.stepIconActive]}>
              {i < currentStep ? '>' : i === currentStep ? '...' : ' '}
            </Text>
            <View>
              <Text style={[styles.stepText, i <= currentStep && styles.stepTextActive]}>
                {step}
              </Text>
              {i === currentStep && enrichProgress ? (
                <Text style={styles.enrichProgress}>{enrichProgress}</Text>
              ) : null}
            </View>
          </Animated.View>
        ))}
      </View>
    </View>
  );
}

export default function Processing() {
  return (
    <ErrorBoundary fallbackMessage="The analysis engine encountered an error. Please try with a different CSV file.">
      <ProcessingInner />
    </ErrorBoundary>
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.text,
    marginBottom: spacing.xxl,
  },
  steps: {
    gap: spacing.lg,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepIcon: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.muted,
    width: 32,
  },
  stepIconActive: {
    color: colors.accent,
  },
  stepText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.muted,
  },
  stepTextActive: {
    color: colors.text,
  },
  enrichProgress: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.accent,
    marginTop: 2,
  },
  errorIcon: {
    fontFamily: fonts.medium,
    fontSize: 48,
    color: colors.coral,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  errorText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.coral,
    textAlign: 'center',
    lineHeight: 22,
  },
});
