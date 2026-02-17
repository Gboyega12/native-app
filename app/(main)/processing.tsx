import { useEffect, useState, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { rankMoves, determineFlowchartPosition, calcGoalTrajectory } from '@/lib/move-engine';
import type { RankedMove } from '@/lib/move-engine';
import ErrorBoundary from '@/components/ErrorBoundary';
import { colors, fonts, spacing } from '@/theme';
import type { Analysis, Goals } from '@/lib/types';

const STEPS = [
  'Scanning transactions',
  'Identifying merchants',
  'Verifying with AI',
  'Detecting spending patterns',
  'Ranking by financial priority',
  'Refining your action plan',
];

// Global holder so dashboard can pick it up without re-fetching
let _lastResult: Analysis | null = null;
export function getLastResult(): Analysis | null { return _lastResult; }

function ProcessingInner() {
  const router = useRouter();
  const { csvData } = useLocalSearchParams<{ csvData: string }>();
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState('');
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

      // Fetch user's transaction overrides (corrections made via chat)
      let overrides: any[] = [];
      try {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (authUser) {
          const { data: overrideData } = await supabase
            .from('transaction_overrides')
            .select('match_description, category, is_essential')
            .eq('user_id', authUser.id);
          if (overrideData) overrides = overrideData;
        }
      } catch {}

      setCurrentStep(1);
      let result = EnrichmentEngine.enrich(csvData, overrides);

      if (result.enrichedTransactions.length === 0) {
        setError('No transactions found in your data. Check the file format — it should have Date, Description, and Amount columns.');
        return;
      }
      await delay(400);

      // ── Layer 1.5: Claude AI Verification ──
      // Batch all low-confidence transactions to Claude for classification.
      // Claude's world knowledge catches merchants the rule-based system misses:
      //   "to Amex" → Debt Payments, "Claude.ai" → Subscriptions, etc.
      setCurrentStep(2);
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
          const classifyRes = await fetch('/api/claude/classify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              transactions: unclassified.map(({ tx }) => ({
                description: tx.description,
                amount: tx.amount,
              })),
            }),
          });
          const classifyData = await classifyRes.json();

          if (classifyData.success && Array.isArray(classifyData.classifications)) {
            // Merge Claude's classifications back into enriched transactions
            const updated = [...result.enrichedTransactions];
            classifyData.classifications.forEach((c: any, i: number) => {
              const entry = unclassified[i];
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

            // Rebuild profile, archetype, score, and moves with improved data
            result = EnrichmentEngine.rebuild(updated);
          }
        }
      } catch (classifyErr: any) {
        console.warn('[processing] Claude classify failed, falling back to rule-based enrichment:', classifyErr?.message || classifyErr);
        // Surface the failure count so it's visible in logs. If this fires,
        // check that CLAUDE_API_KEY is set in .env — without it, ALL unknown
        // merchants (restaurants, SaaS tools, niche brands) stay as "Other".
        const lowConfCount = result.enrichedTransactions.filter((t) => t.confidence === 'low' && !t.isIncome && !t.isTransfer).length;
        if (lowConfCount > 0) {
          console.warn(`[processing] ${lowConfCount} transactions stuck as "Other" — Claude AI fallback unavailable`);
        }
      }
      await delay(400);

      setCurrentStep(3);
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
      setCurrentStep(4);
      const ukpf = determineFlowchartPosition(result.profile, goals);
      const rankedMoves = rankMoves(result.decisionStack, result.profile, goals);
      const topRanked = rankedMoves[0] || null;
      const goalTrajectory = topRanked ? topRanked.trajectory : null;
      await delay(400);

      // ── Layer 3: Claude Refinement ──
      // Takes top 3 ranked moves + raw data → rewrites into BOCY-style language
      setCurrentStep(5);
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

      // ── Save to Supabase ──
      const topMove = allMoves[0] || null;
      const analysis: Analysis = {
        user_id: user?.id ?? undefined,
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

          // Save card balances to debt_accounts (from TrueLayer data)
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
            <Text style={[styles.stepText, i <= currentStep && styles.stepTextActive]}>
              {step}
            </Text>
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
