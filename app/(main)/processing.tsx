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
      if (!csvData) {
        setError('No transaction data found.');
        return;
      }

      // ── Layer 1: Enrichment Engine ──
      // CSV → categorise, profile, raw moves
      setCurrentStep(0);
      await delay(400);

      setCurrentStep(1);
      let result = EnrichmentEngine.enrich(csvData);
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
      } catch {
        // Graceful fallback — continue with rule-based enrichment only
      }
      await delay(400);

      setCurrentStep(3);
      await delay(400);

      // Fetch user goals
      const { data: { user } } = await supabase.auth.getUser();
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
        user_id: user?.id,
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

      if (user) {
        await supabase.from('analyses').insert({
          ...analysis,
          non_discretionary: analysis.non_discretionary,
          discretionary: analysis.discretionary,
          income_sources: analysis.income_sources,
          top_move: analysis.top_move,
          all_moves: analysis.all_moves,
          behavioral_patterns: analysis.behavioral_patterns,
          goal_context: analysis.goal_context,
        });
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
