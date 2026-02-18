import { useEffect, useState, useRef } from 'react';
import { View, Text, Animated, StyleSheet, Easing } from 'react-native';
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
  'Mapping income stability',
  'Enriching transactions',
  'Verifying with AI',
  'Detecting optimisation opportunities',
  'Ranking highest impact actions',
  'Refining your action plan',
];

const CLASSIFY_BATCH_SIZE = 25; // Send to Claude in batches of 25

// Global holder so dashboard can pick it up without re-fetching
let _lastResult: Analysis | null = null;
export function getLastResult(): Analysis | null { return _lastResult; }

function buildFirstInsight(identity: any, profile: any, topMove: any): string {
  if (!identity || !profile) return '';
  const surplus = Math.round(profile.monthly.surplus);
  const transport = Math.round(profile.monthly.transport);
  const topAction = topMove?.action || '';

  if (identity.work_setup === 'remote' && transport < 30) {
    return `As a remote worker, your commute costs are already minimal at \u00a3${transport}/month. Your biggest opportunity is ${topAction ? topAction.toLowerCase() : 'optimising your surplus'}.`;
  }
  if (identity.work_setup === 'hybrid') {
    return `As a hybrid worker, your transport pattern is unique. We've tailored your recommendations to your split schedule — your top move: ${topAction || 'unlocking more from your surplus'}.`;
  }
  if (identity.household === 'single_parent') {
    return `As a single parent, we've prioritised stability and protection in your plan. Your top move frees up \u00a3${topMove?.monthlyImpact || surplus}/month while keeping essential spending protected.`;
  }
  if (identity.work_setup === 'self_employed') {
    return `As self-employed, we've built in a larger safety buffer and tax set-aside. Your \u00a3${surplus}/month surplus gives you real flexibility — let's put it to work.`;
  }
  if (surplus > 500) {
    return `With \u00a3${surplus}/month in surplus, you're in a strong position. We've identified ${topAction ? `your top move: ${topAction.toLowerCase()}` : 'high-impact opportunities to grow your wealth'}.`;
  }
  if (surplus < 0) {
    return `You're currently spending \u00a3${Math.abs(surplus)}/month more than income. We've identified the fastest path back to positive — starting with ${topAction || 'cutting non-essential spending'}.`;
  }
  return `We've mapped your complete financial picture. ${topAction ? `Your top move: ${topAction.toLowerCase()}` : 'Your personalised action plan is ready'}.`;
}

// ── Animated scanning glyph ──
const ScanGlyph = () => {
  const pulse = useRef(new Animated.Value(0)).current;
  const rotate = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    ).start();
    Animated.loop(
      Animated.timing(rotate, { toValue: 1, duration: 4000, easing: Easing.linear, useNativeDriver: true })
    ).start();
  }, []);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.1] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
  const spin = rotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <View style={styles.glyphContainer}>
      <Animated.View style={[styles.glyphRing, { transform: [{ rotate: spin }, { scale }], opacity }]} />
      <Animated.Text style={[styles.glyphText, { opacity, transform: [{ scale }] }]}>
        {'{ B }'}
      </Animated.Text>
    </View>
  );
};

function ProcessingInner() {
  const router = useRouter();
  const { csvData } = useLocalSearchParams<{ csvData: string }>();
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState('');
  const [enrichProgress, setEnrichProgress] = useState('');
  const [insight, setInsight] = useState('');
  const fadeAnims = useRef(STEPS.map(() => new Animated.Value(0))).current;
  const slideAnims = useRef(STEPS.map(() => new Animated.Value(20))).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    runAnalysis();
  }, []);

  useEffect(() => {
    if (currentStep < STEPS.length) {
      Animated.parallel([
        Animated.timing(fadeAnims[currentStep], {
          toValue: 1,
          duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(slideAnims[currentStep], {
          toValue: 0,
          duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
      // Animate progress bar
      Animated.timing(progressAnim, {
        toValue: (currentStep + 1) / STEPS.length,
        duration: 600,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
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

      // Fetch identity + debt accounts for personalised analysis
      let identityData: any = null;
      let debtAccountsData: any[] = [];
      try {
        const { data: { user: idUser } } = await supabase.auth.getUser();
        if (idUser) {
          const [idRes, debtRes] = await Promise.all([
            supabase.from('user_identity').select('*').eq('user_id', idUser.id).single(),
            supabase.from('debt_accounts').select('account_name, account_type, outstanding_balance, credit_limit').eq('user_id', idUser.id),
          ]);
          if (idRes.data) identityData = idRes.data;
          if (debtRes.data) debtAccountsData = debtRes.data;
        }
      } catch {}

      setCurrentStep(1);
      let result = EnrichmentEngine.enrich(csvData, overrides, debtAccountsData, identityData);

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
          result = EnrichmentEngine.rebuild(updated, debtAccountsData, identityData);
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
      const ukpf = determineFlowchartPosition(result.profile, goals, debtAccountsData, identityData);
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
          // Merge Claude's refined text + cleaned merchants with our ranked data
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
              merchants: (refined.merchants && refined.merchants.length > 0) ? refined.merchants : original.merchants,
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

      // Show personalised first insight before navigating
      const firstInsight = buildFirstInsight(identityData, result.profile, topMove);
      if (firstInsight) {
        setInsight(firstInsight);
        await delay(3500);
      }

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

  if (insight) {
    return (
      <View style={styles.container}>
        <Text style={styles.insightEmoji}>{'{ B }'}</Text>
        <Text style={styles.insightTitle}>Your plan is ready</Text>
        <Text style={styles.insightText}>{insight}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScanGlyph />
      <Text style={styles.title}>Analysing your data</Text>

      {/* Progress bar */}
      <View style={styles.progressBar}>
        <Animated.View
          style={[
            styles.progressFill,
            {
              width: progressAnim.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      </View>
      <Text style={styles.progressLabel}>
        {currentStep + 1} of {STEPS.length}
      </Text>

      <View style={styles.steps}>
        {STEPS.map((step, i) => (
          <Animated.View
            key={i}
            style={[
              styles.stepRow,
              {
                opacity: fadeAnims[i],
                transform: [{ translateX: slideAnims[i] }],
              },
            ]}
          >
            <Text style={[styles.stepIcon, i < currentStep && styles.stepIconDone, i === currentStep && styles.stepIconActive]}>
              {i < currentStep ? '\u2713' : i === currentStep ? '\u25CF' : '\u25CB'}
            </Text>
            <View style={styles.stepContent}>
              <Text style={[styles.stepText, i <= currentStep && styles.stepTextActive, i < currentStep && styles.stepTextDone]}>
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

  // ── Scanning glyph ──
  glyphContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
    height: 80,
  },
  glyphRing: {
    position: 'absolute',
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1.5,
    borderColor: colors.green,
    borderTopColor: 'transparent',
  },
  glyphText: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: colors.green,
    letterSpacing: 2,
  },

  title: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.text,
    marginBottom: spacing.md,
  },

  // ── Progress bar ──
  progressBar: {
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
    marginBottom: spacing.sm,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.green,
  },
  progressLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: spacing.xl,
  },

  steps: {
    gap: spacing.md,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepContent: {
    flex: 1,
  },
  stepIcon: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.muted,
    width: 28,
    textAlign: 'center',
  },
  stepIconActive: {
    color: colors.green,
    fontSize: 10,
  },
  stepIconDone: {
    color: colors.green,
    fontSize: 14,
  },
  stepText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.muted,
  },
  stepTextActive: {
    color: colors.text,
  },
  stepTextDone: {
    color: colors.text2,
  },
  enrichProgress: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.green,
    marginTop: 2,
  },
  insightEmoji: {
    fontFamily: fonts.heading,
    fontSize: 36,
    color: colors.accent,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  insightTitle: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  insightText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text2,
    textAlign: 'center',
    lineHeight: 24,
    paddingHorizontal: spacing.md,
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
