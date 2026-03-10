import { useEffect, useState, useRef } from 'react';
import { View, Text, Animated, StyleSheet, Easing, TouchableOpacity } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { rankMoves, determineFlowchartPosition, calcGoalTrajectory } from '@/lib/move-engine';
import type { RankedMove } from '@/lib/move-engine';
import ErrorBoundary from '@/components/ErrorBoundary';
import { SpendingRing } from '@/components/Charts';
import { colors, fonts, spacing, radius } from '@/theme';
import { BocyHero } from '@/components/Bocy';
import type { Analysis, Goals, BudgetCategory } from '@/lib/types';

const STEPS = [
  'Scanning transactions',
  'Mapping income stability',
  'Enriching transactions',
  'Verifying transactions',
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

// ── Nothing-style dot matrix animation ──
// 7x7 grid of dots that pulse in concentric rings from the centre outward
const DOT_GRID = 7;
const DOT_RINGS = 4;

const DotMatrix = () => {
  const ringAnims = useRef(Array.from({ length: DOT_RINGS }, () => new Animated.Value(0))).current;

  useEffect(() => {
    const wave = () => {
      ringAnims.forEach((a) => a.setValue(0));
      Animated.stagger(
        180,
        ringAnims.map((anim) =>
          Animated.sequence([
            Animated.timing(anim, { toValue: 1, duration: 500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
            Animated.timing(anim, { toValue: 0, duration: 500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          ]),
        ),
      ).start(() => setTimeout(wave, 300));
    };
    wave();
  }, []);

  const centre = (DOT_GRID - 1) / 2;
  return (
    <View style={styles.dotGridContainer}>
      {Array.from({ length: DOT_GRID }).map((_, r) => (
        <View key={r} style={styles.dotRow}>
          {Array.from({ length: DOT_GRID }).map((_, c) => {
            const dist = Math.max(Math.abs(r - centre), Math.abs(c - centre));
            const ring = Math.min(Math.floor(dist), DOT_RINGS - 1);
            const opacity = ringAnims[ring].interpolate({ inputRange: [0, 1], outputRange: [0.12, 1] });
            const scale = ringAnims[ring].interpolate({ inputRange: [0, 1], outputRange: [0.5, 1.3] });
            return (
              <Animated.View key={c} style={[styles.dot, { opacity, transform: [{ scale }] }]} />
            );
          })}
        </View>
      ))}
    </View>
  );
};

function ProcessingInner() {
  const router = useRouter();
  const { csvData, source } = useLocalSearchParams<{ csvData: string; source?: string }>();
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState('');
  const [enrichProgress, setEnrichProgress] = useState('');
  const [insight, setInsight] = useState('');
  const fadeAnims = useRef(STEPS.map(() => new Animated.Value(0))).current;
  const slideAnims = useRef(STEPS.map(() => new Animated.Value(20))).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    trackScreen('Processing');
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
      // ── Resolve CSV data ──
      // For bank connections: read directly from bank_data table (all connections).
      // This avoids URL param size limits and ensures we use ALL available data,
      // not just the latest callback's CSV.
      let csv = csvData;
      if (source === 'bank') {
        try {
          const { data: { user: bankUser } } = await supabase.auth.getUser();
          if (bankUser) {
            const { data: bankRows } = await supabase
              .from('bank_data')
              .select('csv_data')
              .eq('user_id', bankUser.id)
              .order('created_at', { ascending: false });
            if (bankRows && bankRows.length > 0) {
              const allLines: string[] = [];
              for (const row of bankRows) {
                if (!row.csv_data) continue;
                const lines = row.csv_data.split('\n').slice(1).filter((l: string) => l.trim());
                allLines.push(...lines);
              }
              if (allLines.length > 0) {
                csv = ['Date,Description,Amount', ...allLines].join('\n');
              }
            }
          }
        } catch (e) {
          console.warn('[processing] Failed to fetch bank_data from DB, using URL param:', e);
        }
      }

      if (!csv || csv.trim().length < 10) {
        setError(source === 'bank'
          ? 'Your bank returned no transactions yet. This can happen with new accounts \u2014 try again in a few hours.'
          : 'No transaction data found. Please go back and upload a bank statement.');
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
      } catch (e) {
        console.warn('[processing] Failed to load overrides:', e);
      }

      // Fetch identity + debt accounts for personalised analysis
      let identityData: any = null;
      let debtAccountsData: any[] = [];
      try {
        const { data: { user: idUser } } = await supabase.auth.getUser();
        if (idUser) {
          const [idRes, debtRes] = await Promise.all([
            supabase.from('user_identity').select('*').eq('user_id', idUser.id).maybeSingle(),
            supabase.from('debt_accounts').select('account_name, account_type, outstanding_balance, credit_limit').eq('user_id', idUser.id),
          ]);
          if (idRes.data) identityData = idRes.data;
          if (debtRes.data) debtAccountsData = debtRes.data;
        }
      } catch (e) {
        console.warn('[processing] Failed to load identity/debt data:', e);
      }

      setCurrentStep(1);
      let result = EnrichmentEngine.enrich(csv, overrides, debtAccountsData, identityData);

      if (result.enrichedTransactions.length === 0) {
        if (source === 'bank') {
          setError('Your bank is connected but hasn\u2019t returned any usable transactions yet. This can happen with new connections \u2014 try again in a few hours.');
          return;
        }
        setError('No transactions found in your data. Check the file format \u2014 it should have Date, Description, and Amount columns.');
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
              const classifyRes = await fetch('/api/claude', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'classify',
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
                  tx.classifiedBy = 'claude_ai';
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
        try {
          const { data } = await supabase
            .from('goals')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle();
          goals = data;
        } catch {}
      }

      // ── Layer 2: Move Engine ──
      // UKPF flowchart priority + goal-aware ranking + trajectories
      setCurrentStep(5);
      const ukpf = determineFlowchartPosition(result.profile, goals, debtAccountsData, identityData);
      const rankedMoves = rankMoves(result.decisionStack, result.profile, goals, identityData, debtAccountsData);
      const topRanked = rankedMoves[0] || null;
      const goalTrajectory = topRanked ? topRanked.trajectory : null;
      await delay(400);

      // ── Layer 3: Claude Refinement ──
      // Takes top 3 ranked moves + raw data → rewrites into BOCY-style language
      setCurrentStep(6);
      const top3 = rankedMoves.slice(0, 3);
      let refinedMoves = top3 as RankedMove[];

      try {
        const res = await fetch('/api/claude', {
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

          // ── Save score snapshot for historical tracking ──
          try {
            const savingsRate = analysis.monthly_income > 0
              ? Math.round((analysis.surplus / analysis.monthly_income) * 100)
              : 0;
            await supabase.from('score_history').insert({
              user_id: user.id,
              decision_score: analysis.decision_score,
              monthly_income: analysis.monthly_income,
              monthly_spending: analysis.monthly_spending,
              surplus: analysis.surplus,
              savings_rate: savingsRate,
              subscription_count: result.profile.metrics.subscriptionCount || 0,
              debt_account_count: result.profile.metrics.debtAccountCount || 0,
              archetype: analysis.archetype,
            });
          } catch (scoreErr: any) {
            console.warn('[processing] Non-critical: score history save failed:', scoreErr?.message);
          }

          // ── Check achievements ──
          try {
            // Get previous snapshot
            const { data: prevSnapshots } = await supabase
              .from('score_history')
              .select('decision_score, monthly_spending, surplus, savings_rate, subscription_count, debt_account_count, monthly_income')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false })
              .range(1, 1); // Second most recent

            const prevSnap = prevSnapshots?.[0] || null;
            const currentSnap = {
              decision_score: analysis.decision_score,
              monthly_income: analysis.monthly_income,
              monthly_spending: analysis.monthly_spending,
              surplus: analysis.surplus,
              savings_rate: analysis.monthly_income > 0
                ? Math.round((analysis.surplus / analysis.monthly_income) * 100) : 0,
              subscription_count: result.profile.metrics.subscriptionCount || 0,
              debt_account_count: result.profile.metrics.debtAccountCount || 0,
            };

            // Get existing achievements
            const { data: existingAch } = await supabase
              .from('user_achievements')
              .select('achievement_key')
              .eq('user_id', user.id);

            const existingKeys = (existingAch || []).map((a: any) => a.achievement_key);

            // Check context
            const { data: goalsData } = await supabase
              .from('goals').select('id').eq('user_id', user.id).limit(1);
            const { data: overridesData } = await supabase
              .from('transaction_overrides').select('id').eq('user_id', user.id).limit(1);
            const { data: plansData } = await supabase
              .from('user_plans').select('id').eq('user_id', user.id).limit(1);
            const { data: progressData } = await supabase
              .from('plan_progress').select('completed_steps').eq('user_id', user.id);
            const { data: streakData } = await supabase
              .from('user_streaks').select('current_streak').eq('user_id', user.id).maybeSingle();

            const completedCount = (progressData || []).filter(
              (p: any) => p.completed_steps && p.completed_steps.length > 0
            ).length;

            const { checkAchievements } = await import('@/lib/achievements');
            const newAchievements = checkAchievements(currentSnap, prevSnap, existingKeys, {
              hasGoals: !!(goalsData && goalsData.length > 0),
              hasOverrides: !!(overridesData && overridesData.length > 0),
              hasPlans: !!(plansData && plansData.length > 0),
              planCompletedCount: completedCount,
              totalMoveCount: (analysis.all_moves || []).length,
              streakDays: streakData?.current_streak || 0,
            });

            if (newAchievements.length > 0) {
              for (const key of newAchievements) {
                await supabase.from('user_achievements').upsert({
                  user_id: user.id,
                  achievement_key: key,
                  unlocked_at: new Date().toISOString(),
                  notified: false,
                }, { onConflict: 'user_id,achievement_key' });
              }
              // achievements unlocked silently
            }
          } catch (achErr: any) {
            console.warn('[processing] Non-critical: achievement check failed:', achErr?.message);
          }

          // ── Auto-create notification preferences if first analysis ──
          // Google OAuth users may have email in user_metadata instead of
          // the top-level field, so check both locations.
          try {
            const { data: { user: authUser } } = await supabase.auth.getUser();
            const userEmail = authUser?.email
              || authUser?.user_metadata?.email
              || authUser?.identities?.[0]?.identity_data?.email;
            if (userEmail) {
              await supabase.from('notification_preferences').upsert({
                user_id: user.id,
                email: userEmail,
                weekly_digest: true,
                checkin_prompts: true,
              }, { onConflict: 'user_id' });
            }
          } catch (prefErr: any) {
            console.warn('[processing] Non-critical: notification preferences save failed:', prefErr?.message);
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
              .maybeSingle();

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
              // debt accounts synced
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
        _enrichmentMetrics: result.enrichmentMetrics,
        _unresolvedCount: result.enrichedTransactions.filter(
          (t) => t.category === 'Other' && !t.isIncome && !t.isTransfer && !t.isRefund
        ).length,
      } as any;

      trackEvent('Analysis Completed', {
        transaction_count: result.enrichedTransactions.length,
        monthly_income: Math.round(result.profile.monthly.income),
        monthly_spending: Math.round(result.profile.monthly.spending),
        surplus: Math.round(result.profile.monthly.surplus),
        move_count: allMoves.length,
        archetype: result.archetype.key,
      });

      // Show personalised first insight — user navigates manually
      const firstInsight = buildFirstInsight(identityData, result.profile, topMove);
      setInsight(firstInsight || 'Your personalised action plan is ready.');
      // User will tap the button to navigate
    } catch (err: any) {
      trackEvent('Analysis Failed', { error: err.message });
      setError(err.message || 'Analysis failed. Please try again.');
    }
  };

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorIcon}>!</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          style={styles.insightButton}
          onPress={() => router.replace('/(main)/(tabs)')}
          activeOpacity={0.8}
        >
          <Text style={styles.insightButtonText}>Go to dashboard</Text>
        </TouchableOpacity>
        {source === 'bank' && (
          <TouchableOpacity
            style={[styles.insightButton, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border, marginTop: spacing.sm }]}
            onPress={() => {
              setError('');
              setCurrentStep(0);
              runAnalysis();
            }}
            activeOpacity={0.8}
          >
            <Text style={[styles.insightButtonText, { color: colors.text }]}>Try again</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  if (insight) {
    return (
      <View style={styles.container}>
        <View style={styles.insightHero}>
          <BocyHero mood="celebrating" animate />
        </View>

        {/* Completion ring */}
        <View style={{ alignItems: 'center', marginBottom: spacing.lg }}>
          <SpendingRing
            progress={1}
            remaining={STEPS.length}
            budget={STEPS.length}
            color={colors.green}
            size={120}
          />
        </View>

        <Text style={styles.insightTitle}>Your plan is ready</Text>
        <Text style={styles.insightText}>{insight}</Text>

        <TouchableOpacity
          style={styles.insightButton}
          onPress={() => router.replace('/(main)/(tabs)')}
          activeOpacity={0.8}
        >
          <Text style={styles.insightButtonText}>Go to dashboard</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <DotMatrix />
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
    maxWidth: 560,
    alignSelf: 'center' as const,
    width: '100%',
  },

  // ── Nothing-style dot matrix ──
  dotGridContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
    paddingVertical: spacing.md,
  },
  dotRow: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.green,
    margin: 5,
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
  insightHero: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  insightTitle: {
    fontFamily: fonts.heading,
    fontSize: 24,
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
  insightStats: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
    marginBottom: spacing.xl,
    gap: spacing.lg,
  },
  insightStat: {
    alignItems: 'center',
  },
  insightStatValue: {
    fontFamily: fonts.mono,
    fontSize: 24,
    color: colors.accent,
    marginBottom: 4,
  },
  insightStatLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.dim,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  insightStatDivider: {
    width: 1,
    height: 32,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  insightButton: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
    marginHorizontal: spacing.md,
  },
  insightButtonText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
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
