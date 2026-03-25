import { useEffect, useState, useRef } from 'react';
import { View, Text, Animated, StyleSheet, Easing, TouchableOpacity } from 'react-native';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { CommonActions } from '@react-navigation/native';
import { supabase } from '@/lib/supabase';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import ErrorBoundary from '@/components/ErrorBoundary';
import { SpendingRing } from '@/components/Charts';
import { colors, fonts, spacing, radius } from '@/theme';
import { BocyHero } from '@/components/Bocy';
import type { Analysis, Goals, BudgetCategory } from '@/lib/types';

const STEPS = [
  'Scanning transactions',
  'Mapping income stability',
  'Enriching transactions',
  'Detecting optimisation opportunities',
  'Ranking highest impact actions',
  'Saving your analysis',
];

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
  const navigation = useNavigation();
  const { csvData, source } = useLocalSearchParams<{ csvData: string; source?: string }>();

  // After processing, route to account-setup (first time) or dashboard (returning)
  const goToDashboard = () => {
    const setupDone = typeof window !== 'undefined' && localStorage.getItem('bocy_account_setup_done');
    navigation.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [{ name: setupDone ? '(tabs)' : 'account-setup' }],
      }),
    );
  };
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState('');
  const [enrichProgress, setEnrichProgress] = useState('');
  const [insight, setInsight] = useState('');
  const [slowWarning, setSlowWarning] = useState(false);
  const fadeAnims = useRef(STEPS.map(() => new Animated.Value(0))).current;
  const slideAnims = useRef(STEPS.map(() => new Animated.Value(20))).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    trackScreen('Processing');
    runAnalysis();

    // Show a reassurance message if analysis takes > 45s
    const slowTimer = setTimeout(() => setSlowWarning(true), 45_000);
    return () => clearTimeout(slowTimer);
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
      // For bank connections: read from bank_data table (populated by the callback).
      // Falls back to URL param if DB fetch fails.
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

      // ── Layer 1: Enrichment Engine (lazy-loaded to reduce initial bundle) ──
      const [{ default: EnrichmentEngine }, { rankMoves, calcGoalTrajectory }] = await Promise.all([
        import('@/lib/enrichment-engine'),
        import('@/lib/move-engine'),
      ]);
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
              .select('match_description, category, is_essential, direction')
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
          const [idRes, debtRes, bankRes] = await Promise.all([
            supabase.from('user_identity').select('*').eq('user_id', idUser.id).maybeSingle(),
            supabase.from('debt_accounts').select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, is_default_apr, source').eq('user_id', idUser.id),
            // Also fetch card_balances from bank_data to hydrate debt accounts before enrichment
            supabase.from('bank_data').select('card_balances').eq('user_id', idUser.id).not('card_balances', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle(),
          ]);
          if (idRes.data) identityData = idRes.data;
          if (debtRes.data) debtAccountsData = debtRes.data;

          // Merge Finexer card balances into debt accounts (so enrichment has fresh data)
          if (bankRes.data?.card_balances && Array.isArray(bankRes.data.card_balances)) {
            const existingNames = new Set(debtAccountsData.map((d: any) => d.account_name));
            for (const card of bankRes.data.card_balances) {
              const cardName = card.name || card.display_name || card.provider || 'Card';
              if (!existingNames.has(cardName)) {
                debtAccountsData.push({
                  account_name: cardName,
                  account_type: card.type || 'credit_card',
                  outstanding_balance: card.balance,
                  credit_limit: card.limit,
                  source: 'finexer',
                });
                existingNames.add(cardName);
              } else {
                // Update existing entry with latest balance from Finexer
                const existing = debtAccountsData.find((d: any) => d.account_name === cardName);
                if (existing && card.balance != null) {
                  existing.outstanding_balance = card.balance;
                  if (card.limit != null) existing.credit_limit = card.limit;
                }
              }
            }
          }
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

      // ── Claude AI classification is now deferred to /api/verify (background) ──
      // The processing screen saves a "draft" analysis and fires /api/verify
      // which runs Claude classify + refinement server-side without blocking the user.

      setCurrentStep(3);
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
      // Goal-aware ranking + trajectories
      setCurrentStep(4);
      const rankedMoves = rankMoves(result.decisionStack, result.profile, goals, identityData, debtAccountsData);
      const topRanked = rankedMoves[0] || null;
      const goalTrajectory = topRanked ? topRanked.trajectory : null;
      await delay(400);

      // Claude refinement is now deferred to /api/verify (background).
      // Use unrefined moves for the draft — they'll be upgraded once verified.
      const allMoves = [...rankedMoves];

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

      // ── Save to Supabase (as draft — background verification will upgrade) ──
      setCurrentStep(5);
      const topMove = allMoves[0] || null;
      const analysis: Analysis = {
        user_id: user?.id ?? undefined,
        segment: result.segment,
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
          const insertPayload = {
            user_id: user.id,
            segment: analysis.segment,
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
            verification_status: 'draft',
          };
          let { error: insertError } = await supabase.from('analyses').insert(insertPayload);
          if (insertError) {
            console.warn('[processing] Supabase insert failed, retrying:', insertError.message);
            await delay(1000);
            const retry = await supabase.from('analyses').insert(insertPayload);
            insertError = retry.error;
          }
          if (insertError) {
            throw new Error(`Could not save your analysis. Please try again. (${insertError.message})`);
          }

          // Mark onboarding complete so cold starts skip DB reconstruction
          if (typeof window !== 'undefined') {
            localStorage.setItem('bocy_onboarding_done', 'true');
          }

          // ── Persist debt accounts BEFORE triggering verify ──
          // verify re-reads debt_accounts from DB, so card balances must be
          // written first — otherwise verify overwrites the draft with fallback
          // numbers (the "flash of real data then revert" bug).
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
                  account_name: card.name || card.display_name || card.provider || 'Card',
                  account_type: card.type || 'credit_card',
                  outstanding_balance: card.balance,
                  credit_limit: card.limit,
                  source: 'finexer',
                  last_updated: new Date().toISOString(),
                }, { onConflict: 'user_id,account_name' });
              }
            }
          } catch (debtErr: any) {
            console.warn('[processing] Non-critical: debt accounts save failed:', debtErr?.message);
          }

          // ── Fire-and-forget: trigger background verification ──
          // Claude AI classify + refinement runs server-side without blocking the user.
          // IMPORTANT: debt_accounts must be persisted above before this fires,
          // because verify re-reads them from DB to generate moves.
          try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.access_token) {
              fetch('/api/verify', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({ user_id: user.id }),
              }).catch((e: any) => console.warn('[processing] Background verify fire failed:', e?.message));
            }
          } catch (verifyErr: any) {
            console.warn('[processing] Background verify trigger failed:', verifyErr?.message);
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
              segment: analysis.segment,
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

          // debt_accounts already persisted above (before verify trigger)
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
        _segment: result.segment,
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
        segment: result.segment,
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
          onPress={goToDashboard}
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
          onPress={goToDashboard}
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
      <Text style={styles.title}>Building your financial picture</Text>

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

      {slowWarning && (
        <Text style={styles.slowWarning}>
          This is taking longer than usual. Large transaction histories need extra time — hang tight.
        </Text>
      )}
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
  slowWarning: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center' as const,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
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
