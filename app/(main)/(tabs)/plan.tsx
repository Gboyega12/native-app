import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
  Linking, Alert, LayoutAnimation, Platform, UIManager, Modal, Pressable,
  RefreshControl,
} from 'react-native';
import { useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { requestSync, onSyncComplete, invalidateSyncCache } from '@/lib/sync-coordinator';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import Card, { AnimGlyph, SMOOTH_ANIM } from '@/components/Card';
import { useResponsive } from '@/lib/responsive';
import type { Analysis, Move, GoalTrajectory, IncomeSource } from '@/lib/types';
import type { ReactiveResult } from '@/lib/reactive-engine';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Strip markdown bold/italic markers */
const stripMd = (s?: string | null) => (s || '').replace(/\*\*/g, '');

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

function effortColor(effort: string, colors: ThemeColors) {
  return effort === 'low' ? colors.lavender : effort === 'medium' ? colors.dim : colors.green;
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


export default function Plan() {
  const router = useRouter();
  const { highlight, highlightAction } = useLocalSearchParams<{ highlight?: string; highlightAction?: string }>();
  const { colors } = useTheme();
  const { maxContentWidth, isTablet, horizontalPadding } = useResponsive();
  const s = useMemo(() => createStyles(colors), [colors]);
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
  const [pendingHighlightAction, setPendingHighlightAction] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [incomeExpanded, setIncomeExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAllMoves, setShowAllMoves] = useState(false);
  const itemYPositions = useRef<Record<number, number>>({});
  const [nextMoveHint, setNextMoveHint] = useState<string | null>(null);

  // Handle deep-link: store target action for resolution after data loads
  useEffect(() => {
    if (highlightAction) {
      setPendingHighlightAction(highlightAction);
    } else if (highlight != null) {
      // Legacy numeric index fallback
      const idx = parseInt(highlight, 10);
      if (!isNaN(idx)) {
        setHighlightIdx(idx);
        setExpanded(idx);
        const timer = setTimeout(() => setHighlightIdx(null), 2500);
        return () => clearTimeout(timer);
      }
    }
  }, [highlight, highlightAction]);

  // Resolve pendingHighlightAction → actual index once data is loaded
  useEffect(() => {
    if (!pendingHighlightAction || loading || !analysis) return;

    // Build the same sorted moves array used for rendering
    const effortOrd: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const sortedMoves = [...(Array.isArray(analysis.all_moves) ? analysis.all_moves : [])].sort(
      (a, b) => (effortOrd[a?.effort] ?? 2) - (effortOrd[b?.effort] ?? 2),
    );

    const idx = sortedMoves.findIndex(
      (m) => m.action === pendingHighlightAction,
    );

    if (idx !== -1) {
      setHighlightIdx(idx);
      setExpanded(idx);
      const timer = setTimeout(() => setHighlightIdx(null), 2500);
      setPendingHighlightAction(null);
      return () => clearTimeout(timer);
    }
    setPendingHighlightAction(null);
  }, [pendingHighlightAction, loading, analysis]);

  // Scroll to highlighted card once layout is ready
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
      // Subscribe to sync completions from other screens
      const unsub = onSyncComplete((result) => {
        if (!result) return;
        setAnalysis(result.analysis);
        applyReactiveResult(result.reactive);
      });
      return () => unsub();
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
          .order('created_at', { ascending: false }).limit(1).maybeSingle(),
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
  const syncInBackground = async (userId: string, dismissedActions: Set<string> = new Set()) => {
    try {
      setSyncing(true);
      const result = await requestSync(userId);
      if (!result) { setSyncing(false); return; }

      // Apply dismissed-move filter
      const moves = result.analysis.all_moves || [];
      const filtered = dismissedActions.size > 0
        ? moves.filter((m: Move) => !dismissedActions.has(m.action))
        : moves;

      setAnalysis({ ...result.analysis, all_moves: filtered });
      applyReactiveResult(result.reactive);
    } catch (err: any) {
      console.warn('[plan] Background sync failed:', err?.message);
    }
    setSyncing(false);
  };

  // Pull-to-refresh — force a fresh TrueLayer fetch
  const onRefresh = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid) return;
    setRefreshing(true);
    invalidateSyncCache();
    await syncInBackground(uid);
    setRefreshing(false);
  }, []);

  // ── Apply reactive engine results to local state ──
  const applyReactiveResult = (reactive: ReactiveResult | null | undefined) => {
    if (!reactive) return;
    if (reactive.nextMoveHint) setNextMoveHint(reactive.nextMoveHint);
    // Merge verified steps into local progress so checkboxes + progress bars update
    if (reactive.verifiedSteps && Object.keys(reactive.verifiedSteps).length > 0) {
      setProgress((prev) => {
        const updated = { ...prev };
        for (const [key, steps] of Object.entries(reactive.verifiedSteps)) {
          if (updated[key]) {
            updated[key] = { ...updated[key], completed_steps: steps };
          }
        }
        return updated;
      });
    }
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
    // Prevent double-tap: if already started, ignore
    if (progress[key]?.approved) return;

    const row: ProgressRow = {
      move_key: key,
      move_action: move.action,
      approved: true,
      completed_steps: [],
    };

    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setProgress((prev) => ({ ...prev, [key]: row }));
    saveProgress(key, row);
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
    let uid = userIdRef.current;
    if (!uid) {
      // Fallback: try fetching the user if ref wasn't set
      try {
        const { data: { user } } = await supabase.auth.getUser();
        uid = user?.id || null;
        if (uid) userIdRef.current = uid;
      } catch {
        uid = null;
      }
    }
    if (!uid) return;

    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setExpandedPlan(null);
    setUserPlans((prev) => prev.filter((p) => p.id !== planId));

    try {
      // Use the API endpoint (service-role key) so RLS doesn't block the delete
      const res = await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', plan_id: planId, user_id: uid }),
      });
      if (!res.ok) throw new Error('API delete failed');
    } catch {
      // Fallback: delete directly via Supabase client (works on native)
      try {
        const { error } = await supabase
          .from('user_plans')
          .update({ status: 'dismissed' })
          .eq('id', planId)
          .eq('user_id', uid);

        if (error) {
          await supabase.from('user_plans').delete().eq('id', planId).eq('user_id', uid);
        }
      } catch (err: any) {
        console.warn('[plan] Failed to delete plan:', err?.message);
      }
    }

    // Clean up any progress for this plan
    try {
      await supabase.from('plan_progress').delete().eq('user_id', uid).eq('move_key', `plan-${planId}`);
    } catch {}
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
        .maybeSingle();
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
      <View style={s.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (!analysis && userPlans.length === 0) {
    return (
      <View style={s.emptyContainer}>
        <Text style={s.emptyTitle}>No action plan yet</Text>
        <Text style={s.emptyText}>Connect your bank or upload a statement to get personalised recommendations.</Text>
      </View>
    );
  }

  // ── Derived data ──

  const effortOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const moves: Move[] = [...(Array.isArray(analysis?.all_moves) ? analysis.all_moves : [])].sort(
    (a, b) => (effortOrder[a?.effort] ?? 2) - (effortOrder[b?.effort] ?? 2),
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

  // Income context
  const monthlyIncome = analysis?.monthly_income ?? 0;
  const monthlySpending = analysis?.monthly_spending ?? 0;
  const surplus = analysis?.surplus ?? 0;
  const incomeSources = Array.isArray(analysis?.income_sources) ? analysis.income_sources : [];
  const isVariableIncome = analysis?.is_variable_income ?? false;
  const incomeFloor = analysis?.income_floor ?? monthlyIncome;

  // ── Render ──

  return (
    <ScrollView
      ref={scrollRef}
      style={s.container}
      contentContainerStyle={[
        s.scroll,
        isTablet && { maxWidth: maxContentWidth, alignSelf: 'center' as const, width: '100%', paddingHorizontal: horizontalPadding },
      ]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
          colors={[colors.accent]}
        />
      }
    >
      <AnimGlyph delay={0}>
        <View style={s.headingRow}>
          <View>
            <Text style={s.heading}>Your Plan</Text>
            <Text style={s.headingSub}>
              {syncing ? 'Syncing latest data...' : (
                `${activeMoves.length + userPlans.length} in progress` +
                (opportunities.length > 0 ? ` \u00B7 ${opportunities.length} move${opportunities.length !== 1 ? 's' : ''}` : '')
              )}
            </Text>
          </View>
          <TouchableOpacity style={s.infoBtn} onPress={() => setShowInfo(true)} activeOpacity={0.7}>
            <Text style={s.infoBtnText}>{'\u24D8'}</Text>
          </TouchableOpacity>
        </View>
      </AnimGlyph>

      {/* ── Info modal ── */}
      <Modal visible={showInfo} transparent animationType="fade" onRequestClose={() => setShowInfo(false)}>
        <Pressable style={s.infoOverlay} onPress={() => setShowInfo(false)}>
          <Pressable style={s.infoModal} onPress={() => {}}>
            {/* Close icon */}
            <TouchableOpacity style={s.infoCloseIcon} onPress={() => setShowInfo(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Text style={s.infoCloseIconText}>{'\u2715'}</Text>
            </TouchableOpacity>
            <ScrollView showsVerticalScrollIndicator={false} bounces={false} style={s.infoScroll} contentContainerStyle={s.infoScrollContent}>
              <Text style={s.infoTitle}>How your plan works</Text>

              <Text style={s.infoHeading}>Recommendations</Text>
              <Text style={s.infoBody}>
                Personalised actions ranked by what matters most for your situation right now. Priorities shift automatically as your finances change.
              </Text>

              <Text style={s.infoHeading}>Effort levels</Text>
              <Text style={s.infoBody}>
                Quick win = minimal effort.{'\n'}Some effort = takes a bit of time.{'\n'}Big move = significant change, highest reward.
              </Text>

              <Text style={s.infoHeading}>Tracking</Text>
              <Text style={s.infoBody}>
                Start a move to track it with a checklist. Bocy re-evaluates automatically as new transactions come in — no manual input needed.
              </Text>

              <TouchableOpacity style={s.infoClose} onPress={() => setShowInfo(false)} activeOpacity={0.8}>
                <Text style={s.infoCloseText}>Got it</Text>
              </TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>


      {/* ── Income context strip ── */}
      {monthlyIncome > 0 && (
        <AnimGlyph delay={50}>
          <Card variant="compact" style={{ borderRadius: 16, marginBottom: spacing.xl, padding: 0 }}>
            <TouchableOpacity
              style={s.incomeStripRow}
              onPress={() => {
                LayoutAnimation.configureNext(SMOOTH_ANIM);
                setIncomeExpanded(!incomeExpanded);
              }}
              activeOpacity={0.7}
            >
              <View style={s.incomeStripItem}>
                <Text style={s.incomeStripValue}>
                  {'\u00a3'}{Math.round(monthlyIncome).toLocaleString()}
                </Text>
                <Text style={s.incomeStripLabel}>{isVariableIncome ? 'income (avg)' : 'income'}</Text>
              </View>
              <View style={s.incomeStripDivider} />
              <View style={s.incomeStripItem}>
                <Text style={s.incomeStripValue}>
                  {'\u00a3'}{Math.round(monthlySpending).toLocaleString()}
                </Text>
                <Text style={s.incomeStripLabel}>spending</Text>
              </View>
              <View style={s.incomeStripDivider} />
              <View style={s.incomeStripItem}>
                <Text style={[s.incomeStripValue, { color: surplus >= 0 ? colors.green : colors.coral }]}>
                  {surplus >= 0 ? '+' : '-'}{'\u00a3'}{Math.abs(Math.round(surplus)).toLocaleString()}
                </Text>
                <Text style={s.incomeStripLabel}>surplus</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={s.incomeStripHint}
              onPress={() => {
                LayoutAnimation.configureNext(SMOOTH_ANIM);
                setIncomeExpanded(!incomeExpanded);
              }}
              activeOpacity={0.7}
            >
              <Text style={s.incomeStripHintText}>
                {incomeExpanded ? 'Hide details' : `${incomeSources.length} source${incomeSources.length !== 1 ? 's' : ''} \u00B7 Review`}
              </Text>
              <Text style={s.incomeStripChevron}>{incomeExpanded ? '\u25B4' : '\u25BE'}</Text>
            </TouchableOpacity>

            {incomeExpanded && (
              <View style={s.incomeDetail}>
                <Text style={s.incomeDetailNote}>
                  Detected from your bank transactions. Spending includes all outgoing transactions from the past month.
                </Text>
                {isVariableIncome && (
                  <Text style={[s.incomeDetailNote, { color: colors.amber || colors.coral, marginTop: 8 }]}>
                    Your income varies — budgets use {'\u00a3'}{Math.round(incomeFloor).toLocaleString()}/mo (conservative estimate) so you're covered on lower weeks.
                  </Text>
                )}

                {incomeSources.length > 0 && (
                  <>
                    <Text style={s.incomeDetailHeading}>Income sources</Text>
                    {incomeSources.map((src, idx) => (
                      <View key={idx} style={s.incomeSourceRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={s.incomeSourceName}>{src.source}</Text>
                          {(src.variability ?? 0) > 0.10 && src.recentAmounts && src.recentAmounts.length >= 2 && (
                            <Text style={[s.incomeSourceAmount, { fontSize: 10, color: colors.amber || colors.coral }]}>
                              Range: {'\u00a3'}{Math.round(Math.min(...src.recentAmounts)).toLocaleString()} – {'\u00a3'}{Math.round(Math.max(...src.recentAmounts)).toLocaleString()}
                            </Text>
                          )}
                        </View>
                        <Text style={s.incomeSourceAmount}>
                          {'\u00a3'}{Math.round(src.avgAmount).toLocaleString()}/{src.frequency === 'weekly' ? 'wk' : src.frequency === 'fortnightly' ? '2wk' : 'mo'}
                        </Text>
                      </View>
                    ))}
                  </>
                )}

                <TouchableOpacity
                  style={s.incomeEditBtn}
                  onPress={() => {
                    const prompt = `My income is showing as \u00a3${Math.round(monthlyIncome).toLocaleString()}/month but that doesn't look right. Can you help me correct it?`;
                    router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: prompt } });
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={s.incomeEditBtnText}>Something wrong? Tell Bocy</Text>
                </TouchableOpacity>
              </View>
            )}
          </Card>
        </AnimGlyph>
      )}

      {/* ══════════════════════════════════════════════
          SECTION 1 — YOUR GOAL
          ══════════════════════════════════════════════ */}
      {goalCtx && (
        <Card variant="active" style={{ marginBottom: spacing.xl }}>
          <AnimGlyph>
            <Text style={s.trajGoal}>{goalCtx.goalLabel}</Text>
          </AnimGlyph>

          {goalCtx.targetAmount > 0 && (
            <Text style={s.trajTarget}>
              {'\u00a3'}{goalCtx.targetAmount.toLocaleString()} target
            </Text>
          )}

          {goalCtx.confidence && goalCtx.confidence.p50 > 0 ? (
            <View style={s.trajTimeline}>
              {/* Monte Carlo primary metric — median months */}
              <AnimGlyph delay={100}>
                <Text style={s.trajHeroNumber}>{goalCtx.confidence.p50}</Text>
                <Text style={s.trajHeroLabel}>months — most likely</Text>
              </AnimGlyph>

              {/* Confidence bands */}
              <View style={s.confidenceBands}>
                <View style={s.confidenceRow}>
                  <Text style={[s.confidenceLabel, { color: colors.green }]}>Optimistic</Text>
                  <View style={s.confidenceBarTrack}>
                    <View style={[s.confidenceBarFill, s.confidenceBarOptimistic, { width: `${Math.min(100, (goalCtx.confidence.p10 / goalCtx.confidence.p90) * 100)}%` }]} />
                  </View>
                  <Text style={[s.confidenceValue, { color: colors.green }]}>{goalCtx.confidence.p10}mo</Text>
                </View>
                <View style={s.confidenceRow}>
                  <Text style={s.confidenceLabel}>Likely</Text>
                  <View style={s.confidenceBarTrack}>
                    <View style={[s.confidenceBarFill, s.confidenceBarLikely, { width: `${Math.min(100, (goalCtx.confidence.p50 / goalCtx.confidence.p90) * 100)}%` }]} />
                  </View>
                  <Text style={s.confidenceValue}>{goalCtx.confidence.p50}mo</Text>
                </View>
                <View style={s.confidenceRow}>
                  <Text style={[s.confidenceLabel, { color: colors.dim }]}>Conservative</Text>
                  <View style={s.confidenceBarTrack}>
                    <View style={[s.confidenceBarFill, s.confidenceBarConservative, { width: '100%' }]} />
                  </View>
                  <Text style={[s.confidenceValue, { color: colors.dim }]}>{goalCtx.confidence.p90}mo</Text>
                </View>
              </View>

              {/* Hit rate */}
              {goalCtx.confidence.hitRate12m > 0 && goalCtx.confidence.hitRate12m < 100 && (
                <View style={s.hitRateRow}>
                  <Text style={s.hitRateValue}>{goalCtx.confidence.hitRate12m}%</Text>
                  <Text style={s.hitRateLabel}> chance within 12 months</Text>
                </View>
              )}

              {/* Savings comparison */}
              {goalCtx.monthsSaved > 0 && goalCtx.currentMonths > 0 && (
                <View style={s.trajCompareRow}>
                  <View style={s.trajCompareItem}>
                    <Text style={[s.trajCompareValue, { color: colors.green }]}>
                      {goalCtx.monthsSaved} months faster
                    </Text>
                    <Text style={s.trajCompareLabel}>
                      vs {goalCtx.currentMonths} months without a plan
                    </Text>
                  </View>
                </View>
              )}

              {/* Buffer recommendation for emergency fund goals */}
              {goalCtx.bufferRecommendation && (
                <View style={s.bufferRow}>
                  <Text style={s.bufferLabel}>PERSONALISED BUFFER</Text>
                  <Text style={s.bufferValue}>
                    {'\u00a3'}{goalCtx.bufferRecommendation.amount.toLocaleString()} ({goalCtx.bufferRecommendation.months} months)
                  </Text>
                  <Text style={s.bufferNote}>
                    Covers {goalCtx.bufferRecommendation.coverageRate}% of simulated scenarios
                  </Text>
                </View>
              )}
            </View>
          ) : goalCtx.newMonths > 0 ? (
            <View style={s.trajTimeline}>
              <AnimGlyph delay={100}>
                <Text style={s.trajHeroNumber}>{goalCtx.newMonths}</Text>
                <Text style={s.trajHeroLabel}>months to reach your goal</Text>
              </AnimGlyph>
              {goalCtx.monthsSaved > 0 && goalCtx.currentMonths > 0 && (
                <View style={s.trajCompareRow}>
                  <View style={s.trajCompareItem}>
                    <Text style={[s.trajCompareValue, { color: colors.green }]}>
                      {goalCtx.monthsSaved} months faster
                    </Text>
                    <Text style={s.trajCompareLabel}>
                      vs {goalCtx.currentMonths} months without a plan
                    </Text>
                  </View>
                </View>
              )}
            </View>
          ) : goalCtx.insight ? (
            <Text style={s.trajInsight}>{goalCtx.insight}</Text>
          ) : null}

          {goalCtx.insight && (
            <Text style={s.trajInsight}>{goalCtx.insight}</Text>
          )}
        </Card>
      )}

      {/* Dot separator */}
      <View style={s.dotSeparator}>
        {Array.from({ length: 5 }).map((_, i) => (
          <View key={i} style={[s.dotItem, { backgroundColor: colors.border }]} />
        ))}
      </View>

      {/* ══════════════════════════════════════════════
          SECTION 2 — ACTIVE MOVES
          ══════════════════════════════════════════════ */}
      {(activeMoves.length > 0 || userPlans.length > 0) && (
        <>
          <AnimGlyph delay={100}>
            <View style={s.sectionHeader}>
              <Text style={s.sectionLabel}>IN PROGRESS</Text>
              <Text style={[s.sectionMeta, { color: colors.green }]}>
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
              <Card key={plan.id} variant="active" style={{ marginBottom: spacing.md }}>
                <TouchableOpacity
                  onPress={() => setExpandedPlan(isPlanExpanded ? null : plan.id)}
                  activeOpacity={0.8}
                >
                  <View style={s.cardHeader}>
                    <View style={[s.badge, s.badgeActive]}>
                      <Text style={s.badgeActiveText}>{'\u2713'}</Text>
                    </View>
                    <View style={s.cardContent}>
                      <Text style={s.moveAction}>{stripMd(plan.action)}</Text>
                      <View style={s.moveStats}>
                        {plan.monthly_saving != null && (
                          <Text style={s.impactText}>
                            {'\u00a3'}{plan.monthly_saving}/mo
                          </Text>
                        )}
                        <Text style={s.expandIcon}>{isPlanExpanded ? '\u25B2' : '\u25BC'}</Text>
                      </View>
                      {!isPlanExpanded && (
                        <View style={s.miniProgress}>
                          <View style={s.miniProgressBar}>
                            <View style={[s.miniProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                          </View>
                          <Text style={s.miniProgressText}>{doneSteps.length}/{planSteps.length}</Text>
                        </View>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>

                {isPlanExpanded && (
                  <View style={s.expandedSection}>
                    <View style={s.separator} />

                    {/* Step checklist */}
                    <View style={s.detailBlock}>
                      <Text style={s.detailLabel}>Action checklist</Text>
                      <View style={s.miniProgress}>
                        <View style={s.miniProgressBar}>
                          <View style={[s.miniProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                        </View>
                        <Text style={s.miniProgressText}>{doneSteps.length}/{planSteps.length} done</Text>
                      </View>
                      {planSteps.map((step, j) => {
                        const isDone = doneSteps.includes(j);
                        const isNext = j === nextStepIdx;
                        return (
                          <TouchableOpacity
                            key={j}
                            style={[s.checklistRow, isNext && s.checklistRowNext]}
                            onPress={() => toggleStep(planKey, j, plan.action)}
                            activeOpacity={0.7}
                          >
                            <View style={[s.checkbox, isDone && s.checkboxDone]}>
                              {isDone && <Text style={s.checkmark}>{'\u2713'}</Text>}
                            </View>
                            <View style={s.checklistContent}>
                              <Text style={[s.checklistText, isDone && s.checklistTextDone]}>
                                {stripMd(step)}
                              </Text>
                              {isNext && !isDone && (
                                <Text style={s.nextStepLabel}>Do this next</Text>
                              )}
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    <TouchableOpacity
                      style={s.chatBtn}
                      onPress={() => router.push('/(main)/(tabs)/chat')}
                    >
                      <Text style={s.chatBtnText}>Ask Bocy about this</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={s.removeButton}
                      onPress={() => confirmAction(
                        'Delete plan?',
                        `Remove "${stripMd(plan.action)}" from your plans?`,
                        () => handleRemovePlan(plan.id),
                      )}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete plan: ${stripMd(plan.action)}`}
                    >
                      <Text style={s.removeText}>Delete plan</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </Card>
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
              <View
                key={`active-${i}`}
                onLayout={(e) => {
                  itemYPositions.current[i] = e.nativeEvent.layout.y;
                  if (highlightIdx === i) {
                    setTimeout(() => {
                      scrollRef.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - 80), animated: true });
                    }, 150);
                  }
                }}
              >
              <Card
                variant={highlightIdx === i ? 'highlight' : 'active'}
                style={{ marginBottom: spacing.md }}
              >
                <View>
                  <TouchableOpacity
                    onPress={() => setExpanded(isExpanded ? null : i)}
                    activeOpacity={0.8}
                  >
                    <View style={s.cardHeader}>
                      <AnimGlyph delay={seqIdx * 80}>
                        <View style={[s.badge, s.badgeActive]}>
                          <Text style={s.badgeActiveText}>{'\u2713'}</Text>
                        </View>
                      </AnimGlyph>
                      <View style={s.cardContent}>
                        <Text style={s.moveAction}>{stripMd(move.action)}</Text>
                        <View style={s.moveStats}>
                          <Text style={s.impactText}>
                            {'\u00a3'}{move.monthlyImpact}/mo
                          </Text>
                          <View style={[s.effortBadge, { backgroundColor: `${effortColor(move.effort, colors)}15` }]}>
                            <Text style={[s.effortText, { color: effortColor(move.effort, colors) }]}>{effortLabel(move.effort)}</Text>
                          </View>
                          <Text style={s.expandIcon}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                        </View>
                        {!isExpanded && steps.length > 0 && (
                          <View style={s.miniProgress}>
                            <View style={s.miniProgressBar}>
                              <View style={[s.miniProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                            </View>
                            <Text style={s.miniProgressText}>{doneSteps.length}/{steps.length}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </TouchableOpacity>

                  {isExpanded && renderExpandedMove(move, i, moveKey, steps, doneSteps, stepProgress, nextStepIdx, true)}
                </View>
              </Card>
              </View>
            );
          })}
        </>
      )}

      {/* Dot separator */}
      <View style={s.dotSeparator}>
        {Array.from({ length: 5 }).map((_, i) => (
          <View key={i} style={[s.dotItem, { backgroundColor: colors.border }]} />
        ))}
      </View>

      {/* ── Next move hint (subtle one-liner above opportunities) ── */}
      {nextMoveHint && (
        <View style={{ marginBottom: spacing.sm, paddingVertical: 4 }}>
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.green, letterSpacing: 0.2 }}>
            {'\u2192'} {nextMoveHint}
          </Text>
        </View>
      )}

      {/* ══════════════════════════════════════════════
          SECTION 3 — OPPORTUNITIES
          ══════════════════════════════════════════════ */}
      {opportunities.length > 0 && (
        <>
          <AnimGlyph delay={100}>
            <View style={s.sectionHeader}>
              <Text style={s.sectionLabel}>YOUR INSIGHTS</Text>
              <Text style={[s.sectionMeta, { color: colors.green }]}>
                {'\u00a3'}{Math.round(totalMonthlyImpact - activeMonthly)}/mo potential
              </Text>
            </View>
          </AnimGlyph>

          {/* Individual opportunity cards */}
          {(showAllMoves ? opportunities : opportunities.slice(0, 2)).map(({ move, index: i }, seqIdx) => {
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
                  itemYPositions.current[i] = e.nativeEvent.layout.y;
                  if (highlightIdx === i) {
                    setTimeout(() => {
                      scrollRef.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - 80), animated: true });
                    }, 150);
                  }
                }}
              >
              <Card
                variant={isHighlighted ? 'highlight' : 'default'}
                style={{ marginBottom: spacing.md }}
              >
                <View>
                  <TouchableOpacity
                    onPress={() => setExpanded(isExpanded ? null : i)}
                    activeOpacity={0.8}
                  >
                    <View style={s.cardHeader}>
                      <AnimGlyph delay={seqIdx * 80}>
                        <View style={s.badge}>
                          <Text style={s.badgeText}>{seqIdx + 1}</Text>
                        </View>
                      </AnimGlyph>
                      <View style={s.cardContent}>
                        <Text style={s.moveAction}>{stripMd(move.action)}</Text>
                        <View style={s.moveStats}>
                          <Text style={s.impactText}>
                            {'\u00a3'}{move.monthlyImpact}/mo
                          </Text>
                          <View style={[s.effortBadge, { backgroundColor: `${effortColor(move.effort, colors)}15` }]}>
                            <Text style={[s.effortText, { color: effortColor(move.effort, colors) }]}>{effortLabel(move.effort)}</Text>
                          </View>
                          <Text style={s.expandIcon}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                        </View>

                        {/* Merchant chips preview */}
                        {!isExpanded && move.merchants && move.merchants.length > 0 && (
                          <View style={s.merchantChips}>
                            {move.merchants.slice(0, 3).map((m, j) => (
                              <View key={j} style={s.merchantChip}>
                                <Text style={s.merchantChipText}>{m}</Text>
                              </View>
                            ))}
                            {move.merchants.length > 3 && (
                              <Text style={s.merchantMore}>+{move.merchants.length - 3}</Text>
                            )}
                          </View>
                        )}
                      </View>
                    </View>
                  </TouchableOpacity>

                  {/* Quick-start CTA visible without expanding */}
                  {!isExpanded && (
                    <TouchableOpacity
                      style={s.quickStartBtn}
                      onPress={() => handleStartMove(i, move)}
                      activeOpacity={0.8}
                    >
                      <Text style={s.quickStartBtnText}>Start this move</Text>
                    </TouchableOpacity>
                  )}

                  {isExpanded && renderExpandedMove(move, i, moveKey, steps, doneSteps, stepProgress, nextStepIdx, false)}
                </View>
              </Card>
              </View>
            );
          })}

          {/* View more button for progressive disclosure */}
          {!showAllMoves && opportunities.length > 2 && (
            <TouchableOpacity
              style={s.viewMoreBtn}
              onPress={() => { LayoutAnimation.configureNext(SMOOTH_ANIM); setShowAllMoves(true); }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`View ${opportunities.length - 2} more moves`}
            >
              <Text style={s.viewMoreText}>View {opportunities.length - 2} more moves</Text>
              <Text style={s.viewMoreArrow}>{'\u25BC'}</Text>
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
      <View style={s.expandedSection}>
        <View style={s.separator} />

        {/* Strategy */}
        {move.strategy && (
          <View style={s.detailBlock}>
            <Text style={s.detailLabel}>Strategy</Text>
            <Text style={s.detailText}>{stripMd(move.strategy)}</Text>
          </View>
        )}

        {/* Primary CTA — right after strategy so users don't have to scroll */}
        {!isActive && (
          <TouchableOpacity
            style={s.startBtnProminent}
            onPress={() => handleStartMove(i, move)}
            activeOpacity={0.8}
          >
            <Text style={s.startBtnProminentText}>Start this move</Text>
          </TouchableOpacity>
        )}

        {/* Merchants breakdown */}
        {move.merchants && move.merchants.length > 0 && (
          <View style={s.detailBlock}>
            <Text style={s.detailLabel}>Where your money goes</Text>
            <View style={s.merchantList}>
              {move.merchants.map((m, j) => (
                <View key={j} style={s.merchantRow}>
                  <View style={s.merchantDot} />
                  <Text style={s.merchantName}>{m}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Action checklist */}
        {steps.length > 0 && (
          <View style={s.detailBlock}>
            <Text style={s.detailLabel}>Action checklist</Text>
            {isActive && (
              <View style={s.miniProgress}>
                <View style={s.miniProgressBar}>
                  <View style={[s.miniProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                </View>
                <Text style={s.miniProgressText}>{doneSteps.length}/{steps.length} done</Text>
              </View>
            )}
            {steps.map((step, j) => {
              const isDone = doneSteps.includes(j);
              const isNext = j === nextStepIdx && isActive;
              return (
                <TouchableOpacity
                  key={j}
                  style={[s.checklistRow, isNext && s.checklistRowNext]}
                  onPress={isActive ? () => toggleStep(moveKey, j, move.action) : undefined}
                  activeOpacity={isActive ? 0.7 : 1}
                  disabled={!isActive}
                >
                  {isActive ? (
                    <View style={[s.checkbox, isDone && s.checkboxDone]}>
                      {isDone && <Text style={s.checkmark}>{'\u2713'}</Text>}
                    </View>
                  ) : (
                    <Text style={s.stepNumber}>{j + 1}</Text>
                  )}
                  <View style={s.checklistContent}>
                    <Text style={[
                      s.checklistText,
                      isDone && isActive && s.checklistTextDone,
                    ]}>
                      {stripMd(step)}
                    </Text>
                    {isNext && !isDone && (
                      <Text style={s.nextStepLabel}>Do this next</Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Expected outcome */}
        {move.effect && (
          <View style={s.detailBlock}>
            <Text style={s.detailLabel}>Expected outcome</Text>
            <Text style={s.effectText}>{stripMd(move.effect)}</Text>
          </View>
        )}

        {/* Impact breakdown */}
        <View style={s.detailBlock}>
          <Text style={s.detailLabel}>Impact</Text>
          <View style={s.impactGrid}>
            <View style={s.impactItem}>
              <Text style={s.impactValue}>{'\u00a3'}{move.monthlyImpact || 0}</Text>
              <Text style={s.impactLabel}>per month</Text>
            </View>
            <View style={s.impactItem}>
              <Text style={s.impactValue}>{'\u00a3'}{move.annualImpact || ((move.monthlyImpact || 0) * 12)}</Text>
              <Text style={s.impactLabel}>per year</Text>
            </View>
          </View>
        </View>

        {/* Provider action buttons — subscriptions route to chat instead */}
        {isSubscriptionMove(move) ? (
          <View style={s.providerBlock}>
            <Text style={s.detailLabel}>Take action</Text>
            <TouchableOpacity
              style={s.askBocyBtn}
              onPress={() => {
                const prompt = `I'd like help with this recommendation: "${stripMd(move.action)}".${move.merchants?.length ? ` My subscriptions include: ${move.merchants.join(', ')}.` : ''} What should I do?`;
                router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: prompt } });
              }}
              activeOpacity={0.8}
            >
              <Text style={s.askBocyBtnText}>Ask BOCY about this</Text>
            </TouchableOpacity>
          </View>
        ) : providerActions.length > 0 ? (
          <View style={s.providerBlock}>
            <Text style={s.detailLabel}>Take action</Text>
            <View style={s.providerGrid}>
              {providerActions.map((pa, j) => (
                <TouchableOpacity
                  key={j}
                  style={[s.providerBtn, pa.phone && !pa.url ? s.providerBtnCall : s.providerBtnLink]}
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
                    s.providerBtnText,
                    pa.phone && !pa.url ? s.providerBtnTextCall : s.providerBtnTextLink,
                  ]}>
                    {pa.label}
                  </Text>
                  {pa.sub && (
                    <Text style={[
                      s.providerBtnSub,
                      pa.phone && !pa.url ? s.providerBtnSubCall : s.providerBtnSubLink,
                    ]}>
                      {pa.sub}
                    </Text>
                  )}
                  {pa.phone && !pa.url && (
                    <Text style={s.providerBtnPhone}>{pa.phone}</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

        <TouchableOpacity
          style={s.chatBtn}
          onPress={() => {
            const prompt = `Tell me more about: "${stripMd(move.action)}"`;
            router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: prompt } });
          }}
        >
          <Text style={s.chatBtnText}>Ask Bocy about this</Text>
        </TouchableOpacity>

        {/* Action buttons */}
        <View style={s.actionButtons}>
          {isActive && (
            <TouchableOpacity
              style={s.removeButton}
              onPress={() => handleStopMove(i)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${stripMd(move.action)} from plan`}
            >
              <Text style={s.removeText}>Remove from plan</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={s.deleteBtn}
            onPress={() => confirmAction(
              'Delete recommendation?',
              `Permanently remove "${stripMd(move.action)}"?`,
              () => handleDeleteRecommendation(i),
            )}
            accessibilityRole="button"
            accessibilityLabel={`Delete recommendation: ${stripMd(move.action)}`}
          >
            <Text style={s.deleteBtnText}>Delete</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
}

// ══════════════════════════════════════════════
// STYLES
// ══════════════════════════════════════════════

const createStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: spacing.lg, paddingTop: spacing.xxl + spacing.xl, paddingBottom: spacing.xxl + spacing.xxl },
  loadingContainer: { flex: 1, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  emptyTitle: { fontFamily: fonts.medium, fontSize: 18, color: c.text, marginBottom: spacing.sm },
  emptyText: { fontFamily: fonts.regular, fontSize: 15, color: c.dim, textAlign: 'center', lineHeight: 24 },

  // ── Header ──
  headingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: spacing.xl },
  heading: { fontFamily: fonts.mono, fontSize: 22, color: c.text, marginBottom: 4, letterSpacing: 0.5, textTransform: 'uppercase' },
  headingSub: { fontFamily: fonts.regular, fontSize: 14, color: c.dim },
  infoBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: c.accentDim, justifyContent: 'center', alignItems: 'center', marginTop: 2 },
  infoBtnText: { fontSize: 18, color: c.text2 },

  // ── Info modal ──
  infoOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  infoModal: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.accentDim, borderRadius: 24, maxWidth: 400, width: '100%', maxHeight: '80%', overflow: 'hidden' },
  infoCloseIcon: { position: 'absolute', top: 16, right: 16, zIndex: 10, width: 28, height: 28, borderRadius: 14, backgroundColor: c.mintDim, borderWidth: 1, borderColor: c.border, justifyContent: 'center', alignItems: 'center' },
  infoCloseIconText: { fontFamily: fonts.regular, fontSize: 12, color: c.dim },
  infoScroll: { flex: 1 },
  infoScrollContent: { padding: spacing.xl },
  infoTitle: { fontFamily: fonts.mono, fontSize: 16, color: c.text, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: spacing.lg },
  infoHeading: { fontFamily: fonts.semibold, fontSize: 14, color: c.text, marginTop: spacing.md, marginBottom: 4 },
  infoBody: { fontFamily: fonts.regular, fontSize: 13, color: c.text2, lineHeight: 20 },
  infoClose: { backgroundColor: c.accent, borderRadius: 100, paddingVertical: 14, alignItems: 'center', marginTop: spacing.xl },
  infoCloseText: { fontFamily: fonts.semibold, fontSize: 14, color: c.bg },

  // ── Income context strip ──
  incomeStripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 20,
  },
  incomeStripItem: {
    flex: 1,
    alignItems: 'center',
  },
  incomeStripValue: {
    fontFamily: fonts.mono,
    fontSize: 16,
    color: c.text,
    letterSpacing: -0.5,
  },
  incomeStripLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: c.dim,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 4,
  },
  incomeStripDivider: {
    width: 1,
    height: 28,
    backgroundColor: c.mintDim,
  },
  incomeDetail: {
    borderTopWidth: 1,
    borderTopColor: c.mintDim,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  incomeDetailNote: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
    lineHeight: 18,
  },
  incomeDetailHeading: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
    color: c.dim,
    textTransform: 'uppercase',
    marginTop: 14,
    marginBottom: 8,
  },
  incomeSourceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  incomeSourceName: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.text,
  },
  incomeSourceAmount: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.text2,
  },
  incomeEditBtn: {
    marginTop: 14,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.accentDim,
    borderRadius: 100,
  },
  incomeEditBtnText: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: c.dim,
  },

  // ── Goal trajectory ──
  trajGoal: {
    fontFamily: fonts.medium,
    fontSize: 19,
    color: c.text,
    marginBottom: spacing.sm,
    lineHeight: 26,
  },
  trajTarget: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: c.dim,
    marginBottom: spacing.lg,
  },
  trajTimeline: {
    marginTop: spacing.sm,
  },
  trajHeroNumber: {
    fontFamily: fonts.mono,
    fontSize: 48,
    color: c.text,
    letterSpacing: -2,
  },
  trajHeroLabel: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.text2,
    marginTop: 2,
    marginBottom: spacing.md,
  },
  trajCompareRow: {
    borderTopWidth: 1,
    borderTopColor: c.mintDim,
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
    color: c.dim,
  },
  trajInsight: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.text2,
    lineHeight: 20,
    marginTop: spacing.sm,
  },

  // ── Monte Carlo confidence bands ──
  confidenceBands: {
    gap: 10,
    marginTop: spacing.md,
    marginBottom: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: c.mintDim,
  },
  confidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  confidenceLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.text2,
    letterSpacing: 0.3,
    width: 80,
    textTransform: 'uppercase',
  },
  confidenceBarTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.mintDim,
    overflow: 'hidden',
  },
  confidenceBarFill: {
    height: '100%',
    borderRadius: 2,
  },
  confidenceBarOptimistic: {
    backgroundColor: c.green,
  },
  confidenceBarLikely: {
    backgroundColor: c.accent,
  },
  confidenceBarConservative: {
    backgroundColor: c.dim,
  },
  confidenceValue: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.text2,
    width: 36,
    textAlign: 'right',
  },
  hitRateRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingTop: spacing.sm,
  },
  hitRateValue: {
    fontFamily: fonts.mono,
    fontSize: 20,
    color: c.green,
  },
  hitRateLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.text2,
  },
  bufferRow: {
    borderTopWidth: 1,
    borderTopColor: c.mintDim,
    paddingTop: spacing.md,
    marginTop: spacing.md,
  },
  bufferLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
    color: c.dim,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  bufferValue: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: c.text,
  },
  bufferNote: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
    marginTop: 2,
  },

  // ── Dot separator ──
  dotSeparator: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  dotItem: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
  },

  // ── Section headers ──
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: spacing.xxl + spacing.sm,
    marginBottom: spacing.lg,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2.5,
    color: c.text2,
    textTransform: 'uppercase',
  },
  sectionMeta: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.dim,
  },

  // ── Cards ──
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
    backgroundColor: c.mintDim,
    borderWidth: 1,
    borderColor: c.accentDim,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.sm,
    marginTop: 2,
  },
  badgeText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.dim,
  },
  badgeActive: {
    backgroundColor: c.green,
    borderColor: c.green,
  },
  badgeActiveText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.bg,
  },

  // ── Move content ──
  moveAction: {
    fontFamily: fonts.medium,
    fontSize: 16,
    color: c.text,
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
    color: c.green,
  },
  effortBadge: {
    borderRadius: 100,
    paddingVertical: 2,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: c.accentDim,
  },
  effortText: {
    fontSize: 10,
    fontFamily: fonts.mono,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  expandIcon: {
    fontSize: 10,
    color: c.muted,
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
    borderColor: c.border,
    borderRadius: 100,
    paddingVertical: 3,
    paddingHorizontal: 10,
  },
  merchantChipText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.text2,
  },
  merchantMore: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.dim,
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
    backgroundColor: c.mintDim,
    borderRadius: 2,
    overflow: 'hidden',
  },
  miniProgressFill: {
    height: '100%',
    backgroundColor: c.green,
    borderRadius: 2,
    minWidth: 1,
  },
  miniProgressText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
  },

  // ── Expanded section ──
  expandedSection: { marginTop: spacing.md },
  separator: { height: 1, backgroundColor: c.mintDim, marginBottom: spacing.lg },
  detailBlock: { marginBottom: spacing.lg },
  detailLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 2,
    color: c.text2,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  detailText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: c.text2,
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
    backgroundColor: c.accent,
  },
  merchantName: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.text2,
  },

  // ── Checklist ──
  checklistRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.mintDim,
  },
  checklistRowNext: {
    backgroundColor: c.mintDim,
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
    borderColor: c.accentDim,
    marginRight: spacing.sm,
    marginTop: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxDone: {
    backgroundColor: c.green,
    borderColor: c.green,
  },
  checkmark: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.bg,
  },
  checklistContent: { flex: 1 },
  checklistText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: c.text2,
    lineHeight: 24,
  },
  checklistTextDone: {
    textDecorationLine: 'line-through',
    color: c.muted,
  },
  nextStepLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 1,
    color: c.text,
    marginTop: 2,
    textTransform: 'uppercase',
  },
  stepNumber: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.dim,
    width: 22,
    marginRight: spacing.sm,
    textAlign: 'center',
    marginTop: 1,
  },

  // ── Impact grid ──
  effectText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: c.text,
    lineHeight: 24,
  },
  impactGrid: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  impactItem: {
    flex: 1,
    backgroundColor: c.mintDim,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
    alignItems: 'center',
  },
  impactValue: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: c.green,
  },
  impactLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.dim,
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
    backgroundColor: c.accent,
  },
  providerBtnLink: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.accentDim,
  },
  providerBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  providerBtnTextCall: {
    color: c.bg,
  },
  providerBtnTextLink: {
    color: c.text,
  },
  providerBtnSub: {
    fontFamily: fonts.regular,
    fontSize: 10,
    marginTop: 2,
  },
  providerBtnSubCall: {
    color: c.bg,
    opacity: 0.5,
  },
  providerBtnSubLink: {
    color: c.dim,
  },
  providerBtnPhone: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.bg,
    marginTop: 2,
    opacity: 0.4,
  },

  // ── Buttons ──
  askBocyBtn: {
    backgroundColor: c.accent,
    borderRadius: 100,
    paddingVertical: 14,
    alignItems: 'center',
  },
  askBocyBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
  },
  chatBtn: {
    borderWidth: 1,
    borderColor: c.accentDim,
    borderRadius: 100,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  chatBtnText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.text,
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
    backgroundColor: c.accent,
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
  },
  startBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
  },
  removeButton: {
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  removeText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.dim,
  },
  deleteBtn: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.coralDim,
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  deleteBtnText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.coral,
  },

  // ── Upgrade card (free tier gate) ──
  upgradeBadge: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 3,
    color: c.green,
    backgroundColor: c.greenDim,
    borderWidth: 1,
    borderColor: c.greenDim,
    borderRadius: 100,
    paddingVertical: 3,
    paddingHorizontal: 12,
    overflow: 'hidden',
    marginBottom: spacing.sm,
  },
  upgradeTitle: {
    fontFamily: fonts.medium,
    fontSize: 16,
    color: c.text,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  upgradeSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  upgradeBtn: {
    backgroundColor: c.accent,
    borderRadius: 100,
    paddingVertical: 12,
    paddingHorizontal: spacing.xl,
  },
  upgradeBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
  },

  // ── Income strip expand hint ──
  incomeStripHint: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: c.mintDim,
    gap: 6,
  },
  incomeStripHintText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.dim,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  incomeStripChevron: {
    fontSize: 10,
    color: c.dim,
  },

  // ── Progressive disclosure ──
  viewMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    borderStyle: 'dashed',
  },
  viewMoreText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.text2,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  viewMoreArrow: {
    fontSize: 9,
    color: c.muted,
  },

  // ── Quick start on collapsed cards ──
  quickStartBtn: {
    backgroundColor: c.accent,
    borderRadius: 100,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  quickStartBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
  },

  // ── Prominent start button in expanded view ──
  startBtnProminent: {
    backgroundColor: c.accent,
    borderRadius: 100,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  startBtnProminentText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
  },

});
