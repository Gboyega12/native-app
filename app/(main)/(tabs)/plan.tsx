import { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
  Linking, Alert, LayoutAnimation, Platform, UIManager, Animated, Easing, Modal, Pressable,
} from 'react-native';
import { useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { syncBankData } from '@/lib/sync';
import { colors, fonts, spacing, radius } from '@/theme';
import { useSubscription } from '@/lib/subscription';
import Paywall from '@/components/Paywall';
import type { Analysis, Move, GoalTrajectory } from '@/lib/types';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Strip markdown bold/italic markers */
const stripMd = (s?: string | null) => (s || '').replace(/\*\*/g, '');

// Smooth layout animation config
const SMOOTH_ANIM = {
  duration: 280,
  create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
};

// ── Glyph micro-animation: fade+scale on mount ──
const AnimGlyph = ({ children, delay = 0, style }: { children: React.ReactNode; delay?: number; style?: any }) => {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 500,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: anim,
          transform: [{
            scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }),
          }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
};

/** Category label mapping for display */
const CATEGORY_LABELS: Record<string, string> = {
  break_even: 'Break Even',
  buffer: 'Emergency Buffer',
  debt: 'Debt',
  spending: 'Spending',
  savings: 'Savings',
  invest: 'Investing',
};

/** Provider action — a concrete action the user can take with a provider */
interface ProviderAction {
  label: string;
  sub?: string;
  phone?: string;
  url?: string;
  email?: string;
}

/** Known providers by move category/type */
const PROVIDER_ACTIONS: Record<string, ProviderAction[]> = {
  debt: [
    { label: 'Call StepChange', sub: 'Free debt help', phone: '0800 138 1111' },
    { label: 'Visit StepChange', url: 'https://www.stepchange.org' },
    { label: 'Citizens Advice', sub: 'Debt guidance', phone: '0800 144 8848', url: 'https://www.citizensadvice.org.uk/debt-and-money' },
  ],
  buffer: [
    { label: 'Compare savings accounts', sub: 'Find the best rate', url: 'https://www.bocy.io/savings-comparison.html' },
    { label: 'Compare ISAs', sub: 'Tax-free savings', url: 'https://www.bocy.io/isa-comparison.html' },
  ],
  savings: [
    { label: 'Compare savings rates', sub: 'Find the best rate', url: 'https://www.bocy.io/savings-comparison.html' },
    { label: 'Compare ISAs', sub: 'Tax-free savings', url: 'https://www.bocy.io/isa-comparison.html' },
  ],
  invest: [
    { label: 'Compare ISAs', sub: 'Stocks & Shares ISAs', url: 'https://www.bocy.io/isa-comparison.html' },
    { label: 'Compare savings rates', sub: 'Cash alternatives', url: 'https://www.bocy.io/savings-comparison.html' },
  ],
  subscriptions: [],
  transport: [
    { label: 'Get a Railcard', sub: 'Save 1/3 on rail', url: 'https://www.railcard.co.uk' },
    { label: 'Cycle to Work scheme', url: 'https://www.cyclescheme.co.uk' },
  ],
  energy: [
    { label: 'Switch energy provider', sub: 'Ofgem', url: 'https://www.ofgem.gov.uk/information-for-household-consumers/switching-your-energy-supplier' },
  ],
};

interface UserPlan {
  id: string;
  action: string;
  target_amount: number | null;
  monthly_saving: number | null;
  timeline: string | null;
  status: string;
  created_at: string;
}

interface ProgressRow {
  move_key: string;
  move_action: string;
  approved: boolean;
  completed_steps: number[];
}

function effortColor(effort: string) {
  return effort === 'low' ? '#666666' : effort === 'medium' ? colors.dim : colors.green;
}

function effortLabel(effort: string) {
  return effort === 'low' ? 'Quick win' : effort === 'medium' ? 'Some effort' : 'Big move';
}

/** Generate actionable steps for user plans */
function getPlanSteps(plan: UserPlan): string[] {
  const action = (plan.action || '').toLowerCase();
  if (action.includes('emergency') || action.includes('buffer')) {
    return [
      'Set aside your target amount on payday',
      'Automate it so you don\'t have to think about it',
      'Bocy will track your buffer progress each month',
    ];
  }
  if (action.includes('debt') || action.includes('credit') || action.includes('pay off')) {
    return [
      'List all debts with their interest rates',
      'Set up minimum payments on all debts',
      'Direct any extra to the highest-rate debt first',
      'Bocy will track your debt-free countdown',
    ];
  }
  if (action.includes('save') || action.includes('saving')) {
    return [
      'Set up automatic monthly transfer on payday',
      'Automate it — hands-free saving',
      'Bocy will update your progress each month',
    ];
  }
  if (action.includes('invest')) {
    return [
      'Start with a small monthly amount you won\'t miss',
      'Set it and forget it — don\'t check daily',
      'Bocy will flag when to review your approach',
    ];
  }
  if (action.includes('subscript') || action.includes('cancel')) {
    return [
      'Review active subscriptions this week',
      'Cancel the ones you haven\'t used in 30 days',
      'Bocy will check again next month',
    ];
  }
  return [
    'Break this goal into a weekly action',
    'Start with the smallest step this week',
    'Bocy will check in on your progress',
  ];
}

/** Get provider actions for a move based on its category and action text */
function getProviderActions(move: Move): ProviderAction[] {
  const action = (move.action || '').toLowerCase();
  const cat = move.category || '';

  // Debt moves
  if (cat === 'debt' || action.includes('debt') || action.includes('overpay')) {
    return PROVIDER_ACTIONS.debt;
  }

  // Buffer / emergency fund
  if (cat === 'buffer' || action.includes('buffer') || action.includes('emergency')) {
    return PROVIDER_ACTIONS.buffer;
  }

  // Savings
  if (cat === 'savings' || action.includes('saving') || action.includes('surplus')) {
    return PROVIDER_ACTIONS.savings;
  }

  // Investing
  if (cat === 'invest' || action.includes('invest')) {
    return PROVIDER_ACTIONS.invest;
  }

  // Subscriptions
  if (action.includes('subscript') || action.includes('cancel')) {
    return PROVIDER_ACTIONS.subscriptions;
  }

  // Transport
  if (action.includes('transport') || action.includes('commut')) {
    return PROVIDER_ACTIONS.transport;
  }

  return [];
}

/** Check if a move is subscription-related (routes to chat instead of external links) */
function isSubscriptionMove(move: Move): boolean {
  const action = (move.action || '').toLowerCase();
  return action.includes('subscript') || action.includes('cancel');
}

/** Confirm and execute a destructive action — works on web + native */
function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    const ok = window.confirm(`${title}\n\n${message}`);
    if (ok) onConfirm();
  } else {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onConfirm },
    ]);
  }
}

/** Number of moves visible on the free tier */
const FREE_MOVE_LIMIT = 2;

export default function Plan() {
  const router = useRouter();
  const { highlight } = useLocalSearchParams<{ highlight?: string }>();
  const { isPro } = useSubscription();
  const [showPaywall, setShowPaywall] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [userPlans, setUserPlans] = useState<UserPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, ProgressRow>>({});
  const userIdRef = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [highlightIdx, setHighlightIdx] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const itemYPositions = useRef<Record<number, number>>({});

  // Handle deep-link highlight from home page "View" button
  useEffect(() => {
    if (highlight != null) {
      const idx = parseInt(highlight, 10);
      if (!isNaN(idx)) {
        setHighlightIdx(idx);
        setExpanded(idx);
        // Clear highlight glow after animation
        const timer = setTimeout(() => setHighlightIdx(null), 2500);
        return () => clearTimeout(timer);
      }
    }
  }, [highlight]);

  // Scroll to highlighted card once data is loaded and layout is ready
  useEffect(() => {
    if (highlightIdx == null || loading) return;
    const timer = setTimeout(() => {
      const y = itemYPositions.current[highlightIdx];
      if (y != null && scrollRef.current) {
        scrollRef.current.scrollTo({ y: Math.max(0, y - 80), animated: true });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [highlightIdx, loading]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const loadData = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      userIdRef.current = user.id;

      const [analysisRes, plansRes, progressRes] = await Promise.all([
        supabase.from('analyses').select('*').eq('user_id', user.id)
          .order('created_at', { ascending: false }).limit(1).single(),
        supabase.from('user_plans').select('*').eq('user_id', user.id)
          .eq('status', 'active').order('created_at', { ascending: false }),
        supabase.from('plan_progress').select('*').eq('user_id', user.id),
      ]);

      setUserPlans(plansRes.data || []);

      const progressMap: Record<string, ProgressRow> = {};
      const dismissedActions = new Set<string>();
      for (const row of (progressRes.data || [])) {
        if (row.move_key.startsWith('dismissed-')) {
          dismissedActions.add(row.move_action);
        } else {
          progressMap[row.move_key] = {
            move_key: row.move_key,
            move_action: row.move_action,
            approved: row.approved,
            completed_steps: row.completed_steps || [],
          };
        }
      }

      if (analysisRes.data && dismissedActions.size > 0) {
        const filtered = (analysisRes.data.all_moves || []).filter(
          (m: Move) => !dismissedActions.has(m.action),
        );
        setAnalysis({ ...analysisRes.data, all_moves: filtered });
      } else {
        setAnalysis(analysisRes.data);
      }

      setProgress(progressMap);

      // Trigger background sync so moves/scores reflect latest bank data
      syncInBackground(user.id, dismissedActions);
    } catch (err) {
      console.warn('[plan] loadData error:', err);
    }
    setLoading(false);
  };

  // Background sync: re-fetch TrueLayer data and update moves
  const syncInBackground = async (userId: string, dismissedActions: Set<string>) => {
    try {
      setSyncing(true);
      const result = await syncBankData(userId);
      if (!result) { setSyncing(false); return; }

      // Apply dismissed-move filter
      const moves = result.analysis.all_moves || [];
      const filtered = dismissedActions.size > 0
        ? moves.filter((m: Move) => !dismissedActions.has(m.action))
        : moves;

      setAnalysis({ ...result.analysis, all_moves: filtered });
    } catch (err: any) {
      console.warn('[plan] Background sync failed:', err?.message);
    }
    setSyncing(false);
  };

  // ── Persist progress ──

  const saveProgress = async (key: string, row: ProgressRow) => {
    const uid = userIdRef.current;
    if (!uid) return;
    await supabase.from('plan_progress').upsert({
      user_id: uid,
      move_key: key,
      move_action: row.move_action,
      approved: row.approved,
      completed_steps: row.completed_steps,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,move_key' });
  };

  const toggleStep = (key: string, stepIndex: number, moveAction: string) => {
    setProgress((prev) => {
      const row = prev[key] || { move_key: key, move_action: moveAction, approved: true, completed_steps: [] };
      const steps = [...row.completed_steps];
      const idx = steps.indexOf(stepIndex);
      if (idx >= 0) steps.splice(idx, 1);
      else steps.push(stepIndex);
      const updated = { ...row, completed_steps: steps };
      saveProgress(key, updated);
      return { ...prev, [key]: updated };
    });
  };

  const handleStartMove = async (index: number, move: Move) => {
    const uid = userIdRef.current;
    if (!uid) return;

    const key = `move-${index}`;
    const row: ProgressRow = {
      move_key: key,
      move_action: move.action,
      approved: true,
      completed_steps: [],
    };

    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setProgress((prev) => ({ ...prev, [key]: row }));
    saveProgress(key, row);

    try {
      const { data } = await supabase.from('user_plans').insert({
        user_id: uid,
        action: move.action,
        target_amount: null,
        monthly_saving: move.monthlyImpact || null,
        timeline: null,
        status: 'active',
      }).select('*').single();

      if (data) setUserPlans((prev) => [data, ...prev]);
    } catch {}
  };

  const handleStopMove = async (index: number) => {
    const uid = userIdRef.current;
    if (!uid) return;

    const key = `move-${index}`;
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setProgress((prev) => {
      const updated = { ...prev };
      delete updated[key];
      return updated;
    });

    await supabase.from('plan_progress').delete().eq('user_id', uid).eq('move_key', key);
  };

  const handleRemovePlan = async (planId: string) => {
    const uid = userIdRef.current;
    if (!uid) return;

    try {
      await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss', plan_id: planId, user_id: uid }),
      });
    } catch {}

    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setUserPlans((prev) => prev.filter((p) => p.id !== planId));
  };

  const handleDeleteRecommendation = async (sortedIndex: number) => {
    if (!analysis) return;
    const uid = userIdRef.current;
    if (!uid) return;

    const moveToDelete = moves[sortedIndex];
    if (!moveToDelete) return;

    const originalMoves = analysis.all_moves || [];
    const originalIndex = originalMoves.findIndex((m) => m.action === moveToDelete.action);
    if (originalIndex === -1) return;

    const updatedMoves = [...originalMoves];
    updatedMoves.splice(originalIndex, 1);

    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setAnalysis({ ...analysis, all_moves: updatedMoves });

    const progressKey = `move-${sortedIndex}`;
    setProgress((prev) => {
      const updated = { ...prev };
      delete updated[progressKey];
      return updated;
    });

    try {
      await supabase.from('plan_progress').upsert({
        user_id: uid,
        move_key: `dismissed-${moveToDelete.action.slice(0, 80)}`,
        move_action: moveToDelete.action,
        approved: false,
        completed_steps: [],
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,move_key' });

      const { data: latest } = await supabase.from('analyses')
        .select('id, all_moves')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (latest?.id) {
        const dbMoves = (latest.all_moves || []).filter(
          (m: any) => m.action !== moveToDelete.action,
        );
        await supabase.from('analyses')
          .update({ all_moves: dbMoves })
          .eq('id', latest.id);
      }

      await supabase.from('plan_progress').delete().eq('user_id', uid).eq('move_key', progressKey);
    } catch (err: any) {
      console.warn('[plan] Failed to persist recommendation deletion:', err?.message);
    }
  };

  // ── Loading & empty states ──

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#FFFFFF" size="large" />
      </View>
    );
  }

  if (!analysis && userPlans.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle}>No action plan yet</Text>
        <Text style={styles.emptyText}>Connect your bank or upload a statement to get personalised recommendations.</Text>
      </View>
    );
  }

  // ── Derived data ──

  const effortOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const moves: Move[] = [...(analysis?.all_moves || [])].sort(
    (a, b) => (effortOrder[a.effort] ?? 2) - (effortOrder[b.effort] ?? 2),
  );

  const activeMoves = moves
    .map((m, i) => ({ move: m, index: i }))
    .filter(({ index }) => progress[`move-${index}`]?.approved);

  const opportunities = moves
    .map((m, i) => ({ move: m, index: i }))
    .filter(({ index }) => !progress[`move-${index}`]?.approved)
    .sort((a, b) => {
      // Big moves (high effort) first, quick wins (low effort) last
      const eDiff = (effortOrder[a.move.effort] ?? 2) - (effortOrder[b.move.effort] ?? 2);
      if (eDiff !== 0) return eDiff;
      // Within same effort tier, sort by highest impact first
      return (b.move.annualImpact || 0) - (a.move.annualImpact || 0);
    });

  const totalMonthlyImpact = moves.reduce((s, m) => s + (m.monthlyImpact || 0), 0);
  const activeMonthly = activeMoves.reduce((s, { move }) => s + (move.monthlyImpact || 0), 0);
  const planMonthly = userPlans.reduce((s, p) => s + (p.monthly_saving || 0), 0);
  const goalCtx: GoalTrajectory | null = analysis?.goal_context || null;

  // ── Render ──

  return (
    <ScrollView ref={scrollRef} style={styles.container} contentContainerStyle={styles.scroll}>
      <AnimGlyph delay={0}>
        <View style={styles.headingRow}>
          <View>
            <Text style={styles.heading}>Your Plan</Text>
            <Text style={styles.headingSub}>
              {syncing ? 'Syncing latest data...' : (
                `${activeMoves.length + userPlans.length} in progress` +
                (opportunities.length > 0 ? ` \u00B7 ${opportunities.length} recommended` : '')
              )}
            </Text>
          </View>
          <TouchableOpacity style={styles.infoBtn} onPress={() => setShowInfo(true)} activeOpacity={0.7}>
            <Text style={styles.infoBtnText}>{'\u24D8'}</Text>
          </TouchableOpacity>
        </View>
      </AnimGlyph>

      {/* ── Info modal ── */}
      <Modal visible={showInfo} transparent animationType="fade" onRequestClose={() => setShowInfo(false)}>
        <Pressable style={styles.infoOverlay} onPress={() => setShowInfo(false)}>
          <Pressable style={styles.infoModal} onPress={() => {}}>
            {/* Close icon */}
            <TouchableOpacity style={styles.infoCloseIcon} onPress={() => setShowInfo(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={styles.infoCloseIconText}>{'\u2715'}</Text>
            </TouchableOpacity>
            <ScrollView showsVerticalScrollIndicator={false} bounces={false} style={styles.infoScroll} contentContainerStyle={styles.infoScrollContent}>
              <Text style={styles.infoTitle}>How your plan works</Text>

              <Text style={styles.infoHeading}>Goal trajectory</Text>
              <Text style={styles.infoBody}>
                Shows how many months to reach your goal if you follow the plan, compared to doing nothing.
              </Text>

              <Text style={styles.infoHeading}>In progress</Text>
              <Text style={styles.infoBody}>
                Moves you've started. Track steps with the checklist. Your monthly savings total is shown at the top.
              </Text>

              <Text style={styles.infoHeading}>Recommended</Text>
              <Text style={styles.infoBody}>
                Personalised opportunities ranked by annual impact. Tap to expand details, strategy, and action steps.
              </Text>

              <Text style={styles.infoHeading}>Effort levels</Text>
              <Text style={styles.infoBody}>
                Quick win = minimal effort.{'\n'}Some effort = takes a bit of time.{'\n'}Big move = significant change but highest reward.
              </Text>

              <Text style={styles.infoHeading}>Take action</Text>
              <Text style={styles.infoBody}>
                Each move has direct links or buttons to help you act — compare rates, call providers, or ask Bocy for personalised guidance.
              </Text>

              <Text style={styles.infoHeading}>Automatic tracking</Text>
              <Text style={styles.infoBody}>
                Recommendations are automatically tracked when Bocy re-analyses your bank data. As your spending patterns change, new transactions come in, and debts are paid down, Bocy re-evaluates your recommendations and updates progress automatically — no manual input needed. Dismissed or completed recommendations won't reappear.
              </Text>

              <TouchableOpacity style={styles.infoClose} onPress={() => setShowInfo(false)} activeOpacity={0.8}>
                <Text style={styles.infoCloseText}>Got it</Text>
              </TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Paywall ── */}
      <Paywall visible={showPaywall} onClose={() => setShowPaywall(false)} feature="moves" />

      {/* ══════════════════════════════════════════════
          SECTION 1 — YOUR GOAL
          ══════════════════════════════════════════════ */}
      {goalCtx && (
        <View style={styles.trajectoryCard}>
          <AnimGlyph>
            <Text style={styles.trajGoal}>{goalCtx.goalLabel}</Text>
          </AnimGlyph>

          {goalCtx.targetAmount > 0 && (
            <Text style={styles.trajTarget}>
              {'\u00a3'}{goalCtx.targetAmount.toLocaleString()} target
            </Text>
          )}

          {goalCtx.newMonths > 0 ? (
            <View style={styles.trajTimeline}>
              {/* Clear primary metric */}
              <AnimGlyph delay={100}>
                <Text style={styles.trajHeroNumber}>{goalCtx.newMonths}</Text>
                <Text style={styles.trajHeroLabel}>months to reach your goal</Text>
              </AnimGlyph>

              {/* Savings comparison */}
              {goalCtx.monthsSaved > 0 && goalCtx.currentMonths > 0 && (
                <View style={styles.trajCompareRow}>
                  <View style={styles.trajCompareItem}>
                    <Text style={[styles.trajCompareValue, { color: colors.green }]}>
                      {goalCtx.monthsSaved} months faster
                    </Text>
                    <Text style={styles.trajCompareLabel}>
                      vs {goalCtx.currentMonths} months without a plan
                    </Text>
                  </View>
                </View>
              )}
            </View>
          ) : goalCtx.insight ? (
            <Text style={styles.trajInsight}>{goalCtx.insight}</Text>
          ) : null}

          {goalCtx.newMonths > 0 && goalCtx.insight && (
            <Text style={styles.trajInsight}>{goalCtx.insight}</Text>
          )}
        </View>
      )}

      {/* ══════════════════════════════════════════════
          SECTION 2 — ACTIVE MOVES
          ══════════════════════════════════════════════ */}
      {(activeMoves.length > 0 || userPlans.length > 0) && (
        <>
          <AnimGlyph delay={100}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>IN PROGRESS</Text>
              <Text style={[styles.sectionMeta, { color: colors.green }]}>
                saving {'\u00a3'}{Math.round(activeMonthly + planMonthly)}/mo
              </Text>
            </View>
          </AnimGlyph>

          {/* User plans (from chat or auto-created) */}
          {userPlans.map((plan) => {
            const isPlanExpanded = expandedPlan === plan.id;
            const planKey = `plan-${plan.id}`;
            const planSteps = getPlanSteps(plan);
            const doneSteps = progress[planKey]?.completed_steps || [];
            const stepProgress = planSteps.length > 0 ? doneSteps.length / planSteps.length : 0;
            const nextStepIdx = planSteps.findIndex((_, idx) => !doneSteps.includes(idx));

            return (
              <View key={plan.id} style={[styles.card, styles.activeCard]}>
                <TouchableOpacity
                  onPress={() => setExpandedPlan(isPlanExpanded ? null : plan.id)}
                  activeOpacity={0.8}
                >
                  <View style={styles.cardHeader}>
                    <View style={[styles.badge, styles.badgeActive]}>
                      <Text style={styles.badgeActiveText}>{'\u2713'}</Text>
                    </View>
                    <View style={styles.cardContent}>
                      <Text style={styles.moveAction}>{stripMd(plan.action)}</Text>
                      <View style={styles.moveStats}>
                        {plan.monthly_saving != null && (
                          <Text style={styles.impactText}>
                            {'\u00a3'}{plan.monthly_saving}/mo
                          </Text>
                        )}
                        <Text style={styles.expandIcon}>{isPlanExpanded ? '\u25B2' : '\u25BC'}</Text>
                      </View>
                      {!isPlanExpanded && (
                        <View style={styles.miniProgress}>
                          <View style={styles.miniProgressBar}>
                            <View style={[styles.miniProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                          </View>
                          <Text style={styles.miniProgressText}>{doneSteps.length}/{planSteps.length}</Text>
                        </View>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>

                {isPlanExpanded && (
                  <View style={styles.expandedSection}>
                    <View style={styles.separator} />

                    {/* Step checklist */}
                    <View style={styles.detailBlock}>
                      <Text style={styles.detailLabel}>Action checklist</Text>
                      <View style={styles.miniProgress}>
                        <View style={styles.miniProgressBar}>
                          <View style={[styles.miniProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                        </View>
                        <Text style={styles.miniProgressText}>{doneSteps.length}/{planSteps.length} done</Text>
                      </View>
                      {planSteps.map((step, j) => {
                        const isDone = doneSteps.includes(j);
                        const isNext = j === nextStepIdx;
                        return (
                          <TouchableOpacity
                            key={j}
                            style={[styles.checklistRow, isNext && styles.checklistRowNext]}
                            onPress={() => toggleStep(planKey, j, plan.action)}
                            activeOpacity={0.7}
                          >
                            <View style={[styles.checkbox, isDone && styles.checkboxDone]}>
                              {isDone && <Text style={styles.checkmark}>{'\u2713'}</Text>}
                            </View>
                            <View style={styles.checklistContent}>
                              <Text style={[styles.checklistText, isDone && styles.checklistTextDone]}>
                                {stripMd(step)}
                              </Text>
                              {isNext && !isDone && (
                                <Text style={styles.nextStepLabel}>Do this next</Text>
                              )}
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <TouchableOpacity
                      style={styles.chatBtn}
                      onPress={() => router.push('/(main)/(tabs)/chat')}
                    >
                      <Text style={styles.chatBtnText}>Ask Bocy about this</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.removeButton}
                      onPress={() => confirmAction(
                        'Delete plan?',
                        `Remove "${stripMd(plan.action)}" from your plans?`,
                        () => handleRemovePlan(plan.id),
                      )}
                    >
                      <Text style={styles.removeText}>Delete plan</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}

          {/* Active recommendation moves */}
          {activeMoves.map(({ move, index: i }, seqIdx) => {
            const isExpanded = expanded === i;
            const moveKey = `move-${i}`;
            const steps = move.steps || [];
            const doneSteps = progress[moveKey]?.completed_steps || [];
            const stepProgress = steps.length > 0 ? doneSteps.length / steps.length : 0;
            const nextStepIdx = steps.findIndex((_, idx) => !doneSteps.includes(idx));

            return (
              <View key={`active-${i}`} style={[styles.card, styles.activeCard]}>
                <TouchableOpacity
                  onPress={() => setExpanded(isExpanded ? null : i)}
                  activeOpacity={0.8}
                >
                  <View style={styles.cardHeader}>
                    <AnimGlyph delay={seqIdx * 80}>
                      <View style={[styles.badge, styles.badgeActive]}>
                        <Text style={styles.badgeActiveText}>{'\u2713'}</Text>
                      </View>
                    </AnimGlyph>
                    <View style={styles.cardContent}>
                      <Text style={styles.moveAction}>{stripMd(move.action)}</Text>
                      <View style={styles.moveStats}>
                        <Text style={styles.impactText}>
                          {'\u00a3'}{move.monthlyImpact}/mo
                        </Text>
                        <View style={[styles.effortBadge, { backgroundColor: `${effortColor(move.effort)}15` }]}>
                          <Text style={[styles.effortText, { color: effortColor(move.effort) }]}>{effortLabel(move.effort)}</Text>
                        </View>
                        <Text style={styles.expandIcon}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                      </View>
                      {!isExpanded && steps.length > 0 && (
                        <View style={styles.miniProgress}>
                          <View style={styles.miniProgressBar}>
                            <View style={[styles.miniProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                          </View>
                          <Text style={styles.miniProgressText}>{doneSteps.length}/{steps.length}</Text>
                        </View>
                      )}

                      {/* Emergency fund info hint on collapsed active card */}
                      {!isExpanded && ((move.action || '').toLowerCase().includes('emergency') || (move.action || '').toLowerCase().includes('buffer') || (move.action || '').toLowerCase().includes('rainy') || (move.category || '') === 'buffer') && (
                        <View style={styles.emergencyHint}>
                          <View style={styles.emergencyHintIcon}>
                            <Text style={styles.emergencyHintIconText}>i</Text>
                          </View>
                          <Text style={styles.emergencyHintText}>
                            A safety net for unexpected costs — tap to learn more
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>

                {isExpanded && renderExpandedMove(move, i, moveKey, steps, doneSteps, stepProgress, nextStepIdx, true)}
              </View>
            );
          })}
        </>
      )}

      {/* ══════════════════════════════════════════════
          SECTION 3 — OPPORTUNITIES
          ══════════════════════════════════════════════ */}
      {opportunities.length > 0 && (
        <>
          <AnimGlyph delay={100}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>RECOMMENDED</Text>
              <Text style={[styles.sectionMeta, { color: colors.green }]}>
                {'\u00a3'}{Math.round(totalMonthlyImpact - activeMonthly)}/mo potential
              </Text>
            </View>
          </AnimGlyph>

          {/* Impact comparison bar */}
          <View style={styles.impactCompare}>
            {opportunities.map(({ move, index: i }) => {
              const maxImpact = opportunities[0]?.move.annualImpact || 1;
              const pct = Math.max(8, Math.round(((move.annualImpact || 0) / maxImpact) * 100));
              const eColor = effortColor(move.effort);
              return (
                <TouchableOpacity
                  key={`bar-${i}`}
                  style={styles.impactBarRow}
                  onPress={() => setExpanded(expanded === i ? null : i)}
                  activeOpacity={0.7}
                >
                  <View style={styles.impactBarLabel}>
                    <Text style={styles.impactBarAction} numberOfLines={1}>
                      {stripMd(move.action)}
                    </Text>
                  </View>
                  <View style={styles.impactBarTrack}>
                    <View
                      style={[styles.impactBarFill, { width: `${pct}%`, backgroundColor: eColor + '40' }]}
                    />
                  </View>
                  <Text style={[styles.impactBarValue, { color: eColor }]}>
                    {'\u00a3'}{(move.annualImpact || 0).toLocaleString()}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <Text style={styles.impactBarFootnote}>annual impact {'\u2192'} tap to expand</Text>
          </View>

          {/* Individual opportunity cards */}
          {(isPro ? opportunities : opportunities.slice(0, FREE_MOVE_LIMIT)).map(({ move, index: i }, seqIdx) => {
            const isExpanded = expanded === i;
            const isHighlighted = highlightIdx === i;
            const moveKey = `move-${i}`;
            const steps = move.steps || [];
            const doneSteps = progress[moveKey]?.completed_steps || [];
            const stepProgress = steps.length > 0 ? doneSteps.length / steps.length : 0;
            const nextStepIdx = steps.findIndex((_, idx) => !doneSteps.includes(idx));

            return (
              <View
                key={`opp-${i}`}
                onLayout={(e) => {
                  const y = e.nativeEvent.layout.y;
                  itemYPositions.current[i] = y;
                  if (highlightIdx === i) {
                    setTimeout(() => {
                      scrollRef.current?.scrollTo({ y: Math.max(0, y - 80), animated: true });
                    }, 150);
                  }
                }}
                style={[
                  styles.card,
                  isHighlighted && styles.cardHighlight,
                ]}
              >
                <TouchableOpacity
                  onPress={() => setExpanded(isExpanded ? null : i)}
                  activeOpacity={0.8}
                >
                  <View style={styles.cardHeader}>
                    <AnimGlyph delay={seqIdx * 80}>
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{seqIdx + 1}</Text>
                      </View>
                    </AnimGlyph>
                    <View style={styles.cardContent}>
                      <Text style={styles.moveAction}>{stripMd(move.action)}</Text>
                      <View style={styles.moveStats}>
                        <Text style={styles.impactText}>
                          {'\u00a3'}{move.monthlyImpact}/mo
                        </Text>
                        <View style={[styles.effortBadge, { backgroundColor: `${effortColor(move.effort)}15` }]}>
                          <Text style={[styles.effortText, { color: effortColor(move.effort) }]}>{effortLabel(move.effort)}</Text>
                        </View>
                        <Text style={styles.expandIcon}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                      </View>

                      {/* Emergency fund info hint on collapsed card */}
                      {!isExpanded && ((move.action || '').toLowerCase().includes('emergency') || (move.action || '').toLowerCase().includes('buffer') || (move.action || '').toLowerCase().includes('rainy') || (move.category || '') === 'buffer') && (
                        <View style={styles.emergencyHint}>
                          <View style={styles.emergencyHintIcon}>
                            <Text style={styles.emergencyHintIconText}>i</Text>
                          </View>
                          <Text style={styles.emergencyHintText}>
                            A safety net for unexpected costs — tap to learn more
                          </Text>
                        </View>
                      )}

                      {/* Merchant chips preview */}
                      {!isExpanded && move.merchants && move.merchants.length > 0 && (
                        <View style={styles.merchantChips}>
                          {move.merchants.slice(0, 3).map((m, j) => (
                            <View key={j} style={styles.merchantChip}>
                              <Text style={styles.merchantChipText}>{m}</Text>
                            </View>
                          ))}
                          {move.merchants.length > 3 && (
                            <Text style={styles.merchantMore}>+{move.merchants.length - 3}</Text>
                          )}
                        </View>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>

                {isExpanded && renderExpandedMove(move, i, moveKey, steps, doneSteps, stepProgress, nextStepIdx, false)}
              </View>
            );
          })}

          {/* ── Upgrade CTA for free users ── */}
          {!isPro && opportunities.length > FREE_MOVE_LIMIT && (
            <TouchableOpacity
              style={styles.upgradeCard}
              onPress={() => setShowPaywall(true)}
              activeOpacity={0.8}
            >
              <Text style={styles.upgradeBadge}>PRO</Text>
              <Text style={styles.upgradeTitle}>
                +{opportunities.length - FREE_MOVE_LIMIT} more moves locked
              </Text>
              <Text style={styles.upgradeSubtitle}>
                Unlock your full action plan with step-by-step guidance
              </Text>
              <View style={styles.upgradeBtn}>
                <Text style={styles.upgradeBtnText}>See plans</Text>
              </View>
            </TouchableOpacity>
          )}
        </>
      )}

    </ScrollView>
  );

  // ── Shared expanded move renderer ──

  function renderExpandedMove(
    move: Move,
    i: number,
    moveKey: string,
    steps: string[],
    doneSteps: number[],
    stepProgress: number,
    nextStepIdx: number,
    isActive: boolean,
  ) {
    const providerActions = getProviderActions(move);

    return (
      <View style={styles.expandedSection}>
        <View style={styles.separator} />

        {/* Emergency fund info */}
        {((move.action || '').toLowerCase().includes('emergency') || (move.action || '').toLowerCase().includes('buffer') || (move.category || '') === 'buffer') && (
          <View style={styles.emergencyInfoBox}>
            <View style={styles.emergencyInfoHeader}>
              <Text style={styles.emergencyInfoIcon}>i</Text>
              <Text style={styles.emergencyInfoTitle}>What is an emergency fund?</Text>
            </View>
            <Text style={styles.emergencyInfoText}>
              An emergency fund is 3–6 months of essential expenses kept in an easy-access savings account. It acts as your financial safety net for unexpected costs — car repairs, medical bills, or job loss — so you never have to fall back on credit cards or loans.
            </Text>
            <Text style={[styles.emergencyInfoText, { marginTop: 8, color: colors.green }]}>
              Target: 3–6 months of essentials ({move.monthlyImpact ? `aim for £${Math.round(move.monthlyImpact * 3).toLocaleString()}–£${Math.round(move.monthlyImpact * 6).toLocaleString()}` : 'based on your spending'}){'\n'}
              Timeframe: {move.timeline ? stripMd(move.timeline) : 'Start with £1,000 in the first 2–3 months, then build up gradually'}
            </Text>
          </View>
        )}

        {/* Strategy */}
        {move.strategy && (
          <View style={styles.detailBlock}>
            <Text style={styles.detailLabel}>Strategy</Text>
            <Text style={styles.detailText}>{stripMd(move.strategy)}</Text>
          </View>
        )}

        {/* Merchants breakdown */}
        {move.merchants && move.merchants.length > 0 && (
          <View style={styles.detailBlock}>
            <Text style={styles.detailLabel}>Where your money goes</Text>
            <View style={styles.merchantList}>
              {move.merchants.map((m, j) => (
                <View key={j} style={styles.merchantRow}>
                  <View style={styles.merchantDot} />
                  <Text style={styles.merchantName}>{m}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Action checklist */}
        {steps.length > 0 && (
          <View style={styles.detailBlock}>
            <Text style={styles.detailLabel}>Action checklist</Text>
            {isActive && (
              <View style={styles.miniProgress}>
                <View style={styles.miniProgressBar}>
                  <View style={[styles.miniProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                </View>
                <Text style={styles.miniProgressText}>{doneSteps.length}/{steps.length} done</Text>
              </View>
            )}
            {steps.map((step, j) => {
              const isDone = doneSteps.includes(j);
              const isNext = j === nextStepIdx && isActive;
              return (
                <TouchableOpacity
                  key={j}
                  style={[styles.checklistRow, isNext && styles.checklistRowNext]}
                  onPress={isActive ? () => toggleStep(moveKey, j, move.action) : undefined}
                  activeOpacity={isActive ? 0.7 : 1}
                  disabled={!isActive}
                >
                  {isActive ? (
                    <View style={[styles.checkbox, isDone && styles.checkboxDone]}>
                      {isDone && <Text style={styles.checkmark}>{'\u2713'}</Text>}
                    </View>
                  ) : (
                    <Text style={styles.stepNumber}>{j + 1}</Text>
                  )}
                  <View style={styles.checklistContent}>
                    <Text style={[
                      styles.checklistText,
                      isDone && isActive && styles.checklistTextDone,
                    ]}>
                      {stripMd(step)}
                    </Text>
                    {isNext && !isDone && (
                      <Text style={styles.nextStepLabel}>Do this next</Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Expected outcome */}
        {move.effect && (
          <View style={styles.detailBlock}>
            <Text style={styles.detailLabel}>Expected outcome</Text>
            <Text style={styles.effectText}>{stripMd(move.effect)}</Text>
          </View>
        )}

        {/* Impact breakdown */}
        <View style={styles.detailBlock}>
          <Text style={styles.detailLabel}>Impact</Text>
          <View style={styles.impactGrid}>
            <View style={styles.impactItem}>
              <Text style={styles.impactValue}>{'\u00a3'}{move.monthlyImpact || 0}</Text>
              <Text style={styles.impactLabel}>per month</Text>
            </View>
            <View style={styles.impactItem}>
              <Text style={styles.impactValue}>{'\u00a3'}{move.annualImpact || ((move.monthlyImpact || 0) * 12)}</Text>
              <Text style={styles.impactLabel}>per year</Text>
            </View>
          </View>
        </View>

        {/* Provider action buttons — subscriptions route to chat instead */}
        {isSubscriptionMove(move) ? (
          <View style={styles.providerBlock}>
            <Text style={styles.detailLabel}>Take action</Text>
            <TouchableOpacity
              style={styles.askBocyBtn}
              onPress={() => {
                const prompt = `I'd like help with this recommendation: "${stripMd(move.action)}".${move.merchants?.length ? ` My subscriptions include: ${move.merchants.join(', ')}.` : ''} What should I do?`;
                router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: prompt } });
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.askBocyBtnText}>Ask BOCY about this</Text>
            </TouchableOpacity>
          </View>
        ) : providerActions.length > 0 ? (
          <View style={styles.providerBlock}>
            <Text style={styles.detailLabel}>Take action</Text>
            <View style={styles.providerGrid}>
              {providerActions.map((pa, j) => (
                <TouchableOpacity
                  key={j}
                  style={[styles.providerBtn, pa.phone && !pa.url ? styles.providerBtnCall : styles.providerBtnLink]}
                  onPress={() => {
                    if (pa.phone && !pa.url) {
                      Linking.openURL(`tel:${pa.phone}`);
                    } else if (pa.url) {
                      Linking.openURL(pa.url);
                    } else if (pa.email) {
                      Linking.openURL(`mailto:${pa.email}`);
                    }
                  }}
                >
                  <Text style={[
                    styles.providerBtnText,
                    pa.phone && !pa.url ? styles.providerBtnTextCall : styles.providerBtnTextLink,
                  ]}>
                    {pa.label}
                  </Text>
                  {pa.sub && (
                    <Text style={[
                      styles.providerBtnSub,
                      pa.phone && !pa.url ? styles.providerBtnSubCall : styles.providerBtnSubLink,
                    ]}>
                      {pa.sub}
                    </Text>
                  )}
                  {pa.phone && !pa.url && (
                    <Text style={styles.providerBtnPhone}>{pa.phone}</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

        <TouchableOpacity
          style={styles.chatBtn}
          onPress={() => {
            const prompt = `Tell me more about: "${stripMd(move.action)}"`;
            router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: prompt } });
          }}
        >
          <Text style={styles.chatBtnText}>Ask Bocy about this</Text>
        </TouchableOpacity>

        {/* Action buttons */}
        <View style={styles.actionButtons}>
          {isActive ? (
            <TouchableOpacity
              style={styles.removeButton}
              onPress={() => handleStopMove(i)}
            >
              <Text style={styles.removeText}>Remove from plan</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.startBtn}
              onPress={() => handleStartMove(i, move)}
            >
              <Text style={styles.startBtnText}>Start this move</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={() => confirmAction(
              'Delete recommendation?',
              `Permanently remove "${stripMd(move.action)}"?`,
              () => handleDeleteRecommendation(i),
            )}
          >
            <Text style={styles.deleteBtnText}>Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
}

// ══════════════════════════════════════════════
// STYLES
// ══════════════════════════════════════════════

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingTop: spacing.xxl + spacing.xl, paddingBottom: spacing.xxl + spacing.lg },
  loadingContainer: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  emptyTitle: { fontFamily: fonts.medium, fontSize: 18, color: colors.text, marginBottom: spacing.sm },
  emptyText: { fontFamily: fonts.regular, fontSize: 15, color: colors.dim, textAlign: 'center', lineHeight: 24 },

  // ── Header ──
  headingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: spacing.xl },
  heading: { fontFamily: fonts.mono, fontSize: 22, color: colors.text, marginBottom: 4, letterSpacing: 0.5, textTransform: 'uppercase' },
  headingSub: { fontFamily: fonts.regular, fontSize: 14, color: colors.dim },
  infoBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', marginTop: 2 },
  infoBtnText: { fontSize: 18, color: colors.text2 },

  // ── Info modal ──
  infoOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  infoModal: { backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', borderRadius: 24, maxWidth: 400, width: '100%', maxHeight: '80%', overflow: 'hidden' },
  infoCloseIcon: { position: 'absolute', top: 16, right: 16, zIndex: 10, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', justifyContent: 'center', alignItems: 'center' },
  infoCloseIconText: { fontFamily: fonts.regular, fontSize: 12, color: colors.dim },
  infoScroll: { flex: 1 },
  infoScrollContent: { padding: spacing.xl },
  infoTitle: { fontFamily: fonts.mono, fontSize: 16, color: colors.text, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: spacing.lg },
  infoHeading: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, marginTop: spacing.md, marginBottom: 4 },
  infoBody: { fontFamily: fonts.regular, fontSize: 13, color: colors.text2, lineHeight: 20 },
  infoClose: { backgroundColor: '#FFFFFF', borderRadius: 100, paddingVertical: 14, alignItems: 'center', marginTop: spacing.xl },
  infoCloseText: { fontFamily: fonts.semibold, fontSize: 14, color: '#000000' },

  // ── Goal trajectory ──
  trajectoryCard: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 24,
    padding: spacing.xl,
    marginBottom: spacing.xl,
  },
  trajGoal: {
    fontFamily: fonts.medium,
    fontSize: 19,
    color: colors.text,
    marginBottom: spacing.sm,
    lineHeight: 26,
  },
  trajTarget: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.dim,
    marginBottom: spacing.lg,
  },
  trajTimeline: {
    marginTop: spacing.sm,
  },
  trajHeroNumber: {
    fontFamily: fonts.mono,
    fontSize: 48,
    fontWeight: '300',
    color: colors.text,
    letterSpacing: -2,
  },
  trajHeroLabel: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
    marginTop: 2,
    marginBottom: spacing.md,
  },
  trajCompareRow: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
    paddingTop: spacing.md,
  },
  trajCompareItem: {
  },
  trajCompareValue: {
    fontFamily: fonts.mono,
    fontSize: 15,
    marginBottom: 2,
  },
  trajCompareLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
  },
  trajInsight: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text2,
    lineHeight: 20,
    marginTop: spacing.sm,
  },

  // ── Section headers ──
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2,
    color: colors.text2,
    textTransform: 'uppercase',
  },
  sectionMeta: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.dim,
  },

  // ── Cards ──
  card: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 24,
    padding: spacing.xl,
    marginBottom: spacing.md,
  },
  activeCard: {
    borderColor: 'rgba(255,255,255,0.20)',
  },
  cardHighlight: {
    borderColor: '#FFFFFF',
    borderWidth: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  cardContent: {
    flex: 1,
  },

  // ── Badges ──
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.sm,
    marginTop: 2,
  },
  badgeText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.dim,
  },
  badgeActive: {
    backgroundColor: colors.green,
    borderColor: colors.green,
  },
  badgeActiveText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: '#000000',
  },

  // ── Move content ──
  moveAction: {
    fontFamily: fonts.medium,
    fontSize: 16,
    color: colors.text,
    marginBottom: spacing.sm,
    lineHeight: 24,
  },
  moveStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  impactText: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.green,
  },
  effortBadge: {
    borderRadius: 100,
    paddingVertical: 2,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  effortText: {
    fontSize: 10,
    fontFamily: fonts.mono,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  expandIcon: {
    fontSize: 10,
    color: colors.muted,
    marginLeft: 'auto',
  },

  // ── Merchant chips ──
  merchantChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.sm,
  },
  merchantChip: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 100,
    paddingVertical: 3,
    paddingHorizontal: 10,
  },
  merchantChipText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.text2,
  },
  merchantMore: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.dim,
    alignSelf: 'center',
  },

  // ── Mini progress bar ──
  miniProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  miniProgressBar: {
    flex: 1,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  miniProgressFill: {
    height: '100%',
    backgroundColor: colors.green,
    borderRadius: 2,
    minWidth: 1,
  },
  miniProgressText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted,
  },

  // ── Impact comparison bars ──
  impactCompare: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 24,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  impactBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  impactBarLabel: {
    width: 100,
  },
  impactBarAction: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.text2,
  },
  impactBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  impactBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  impactBarValue: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: '400',
    width: 54,
    textAlign: 'right',
  },
  impactBarFootnote: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.muted,
    textAlign: 'right',
    marginTop: 2,
    letterSpacing: 0.3,
  },

  // ── Emergency fund info ──
  emergencyInfoBox: {
    backgroundColor: 'rgba(0,212,170,0.06)',
    borderRadius: 12,
    padding: 14,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.12)',
  },
  emergencyInfoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  emergencyInfoIcon: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.green,
    width: 20,
    height: 20,
    lineHeight: 20,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.4)',
    borderRadius: 10,
    overflow: 'hidden',
  },
  emergencyInfoTitle: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.green,
    letterSpacing: 0.3,
  },
  emergencyInfoText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.text2,
    lineHeight: 18,
  },

  // ── Emergency hint on collapsed card ──
  emergencyHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: 'rgba(0,212,170,0.06)',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.12)',
  },
  emergencyHintIcon: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emergencyHintIconText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.green,
    lineHeight: 14,
  },
  emergencyHintText: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.green,
    flex: 1,
  },

  // ── Expanded section ──
  expandedSection: { marginTop: spacing.md },
  separator: { height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginBottom: spacing.lg },
  detailBlock: { marginBottom: spacing.lg },
  detailLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 2,
    color: colors.text2,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  detailText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text2,
    lineHeight: 24,
  },

  // ── Merchant list ──
  merchantList: {
    gap: spacing.xs,
  },
  merchantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 4,
  },
  merchantDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
  },
  merchantName: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
  },

  // ── Checklist ──
  checklistRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  checklistRowNext: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderBottomWidth: 0,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    marginRight: spacing.sm,
    marginTop: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxDone: {
    backgroundColor: colors.green,
    borderColor: colors.green,
  },
  checkmark: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: '#000000',
  },
  checklistContent: { flex: 1 },
  checklistText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text2,
    lineHeight: 24,
  },
  checklistTextDone: {
    textDecorationLine: 'line-through',
    color: colors.muted,
  },
  nextStepLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1,
    color: colors.text,
    marginTop: 2,
    textTransform: 'uppercase',
  },
  stepNumber: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.dim,
    width: 22,
    marginRight: spacing.sm,
    textAlign: 'center',
    marginTop: 1,
  },

  // ── Impact grid ──
  effectText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
    lineHeight: 24,
  },
  impactGrid: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  impactItem: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.sm,
    padding: spacing.sm,
    alignItems: 'center',
  },
  impactValue: {
    fontFamily: fonts.mono,
    fontSize: 18,
    fontWeight: '300',
    color: colors.green,
  },
  impactLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.dim,
    marginTop: 2,
    letterSpacing: 0.3,
  },

  // ── Provider action buttons ──
  providerBlock: {
    marginBottom: spacing.md,
  },
  providerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  providerBtn: {
    minWidth: '45%',
    flexGrow: 1,
    borderRadius: 100,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  providerBtnCall: {
    backgroundColor: '#FFFFFF',
  },
  providerBtnLink: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  providerBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  providerBtnTextCall: {
    color: '#000000',
  },
  providerBtnTextLink: {
    color: colors.text,
  },
  providerBtnSub: {
    fontFamily: fonts.regular,
    fontSize: 10,
    marginTop: 2,
  },
  providerBtnSubCall: {
    color: '#000000',
    opacity: 0.5,
  },
  providerBtnSubLink: {
    color: colors.dim,
  },
  providerBtnPhone: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: '#000000',
    marginTop: 2,
    opacity: 0.4,
  },

  // ── Buttons ──
  askBocyBtn: {
    backgroundColor: '#FFFFFF',
    borderRadius: 100,
    paddingVertical: 14,
    alignItems: 'center',
  },
  askBocyBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: '#000000',
  },
  chatBtn: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 100,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  chatBtnText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.text,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  startBtn: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
  },
  startBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: '#000000',
  },
  removeButton: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
  },
  removeText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
  },
  deleteBtn: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(224,82,82,0.3)',
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
  },
  deleteBtnText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.coral,
  },

  // ── Upgrade card (free tier gate) ──
  upgradeCard: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.25)',
    borderRadius: 24,
    padding: spacing.xl,
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  upgradeBadge: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 3,
    color: colors.green,
    backgroundColor: 'rgba(0,212,170,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.25)',
    borderRadius: 100,
    paddingVertical: 3,
    paddingHorizontal: 12,
    overflow: 'hidden',
    marginBottom: spacing.sm,
  },
  upgradeTitle: {
    fontFamily: fonts.medium,
    fontSize: 16,
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  upgradeSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  upgradeBtn: {
    backgroundColor: '#FFFFFF',
    borderRadius: 100,
    paddingVertical: 12,
    paddingHorizontal: spacing.xl,
  },
  upgradeBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: '#000000',
  },

});
