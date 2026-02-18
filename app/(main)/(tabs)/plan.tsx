import { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
  Linking, Alert, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis, Move, GoalTrajectory } from '@/lib/types';

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
    { label: 'Call StepChange', sub: 'Free debt advice', phone: '0800 138 1111' },
    { label: 'Visit StepChange', url: 'https://www.stepchange.org' },
    { label: 'Citizens Advice', sub: 'Debt guidance', phone: '0800 144 8848', url: 'https://www.citizensadvice.org.uk/debt-and-money' },
  ],
  buffer: [
    { label: 'Compare savings accounts', sub: 'MoneyHelper', url: 'https://www.moneyhelper.org.uk/en/savings/how-to-save/use-our-savings-calculator' },
    { label: 'Open a Cash ISA', sub: 'Tax-free savings', url: 'https://www.moneyhelper.org.uk/en/savings/types-of-savings/cash-isas' },
  ],
  savings: [
    { label: 'Compare savings rates', sub: 'MSE', url: 'https://www.moneysavingexpert.com/savings/savings-accounts-best-interest/' },
    { label: 'Call MoneyHelper', sub: 'Savings advice', phone: '0800 138 7777' },
  ],
  invest: [
    { label: 'Learn about investing', sub: 'MoneyHelper guide', url: 'https://www.moneyhelper.org.uk/en/investments' },
    { label: 'Compare S&S ISAs', sub: 'MSE', url: 'https://www.moneysavingexpert.com/savings/stocks-shares-isas/' },
  ],
  subscriptions: [
    { label: 'Review with free tool', sub: 'Trim subscriptions', url: 'https://www.moneysavingexpert.com/broadband-and-tv/cancel-direct-debit/' },
  ],
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
  return effort === 'low' ? '#666666' : effort === 'medium' ? colors.dim : colors.accent;
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
  const { highlight } = useLocalSearchParams<{ highlight?: string }>();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [userPlans, setUserPlans] = useState<UserPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, ProgressRow>>({});
  const userIdRef = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [highlightIdx, setHighlightIdx] = useState<number | null>(null);

  // Handle deep-link highlight from home page "View" button
  useEffect(() => {
    if (highlight != null) {
      const idx = parseInt(highlight, 10);
      if (!isNaN(idx)) {
        setHighlightIdx(idx);
        setExpanded(idx);
        // Clear highlight glow after 2s
        const timer = setTimeout(() => setHighlightIdx(null), 2000);
        return () => clearTimeout(timer);
      }
    }
  }, [highlight]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const loadData = async () => {
    setLoading(true);
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
    setLoading(false);
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

    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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
      await fetch('/api/plans/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, user_id: uid }),
      });
    } catch {}

    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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

    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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
    .sort((a, b) => (b.move.annualImpact || 0) - (a.move.annualImpact || 0));

  const totalMonthlyImpact = moves.reduce((s, m) => s + (m.monthlyImpact || 0), 0);
  const activeMonthly = activeMoves.reduce((s, { move }) => s + (move.monthlyImpact || 0), 0);
  const planMonthly = userPlans.reduce((s, p) => s + (p.monthly_saving || 0), 0);
  const goalCtx: GoalTrajectory | null = analysis?.goal_context || null;

  // ── Render ──

  return (
    <ScrollView ref={scrollRef} style={styles.container} contentContainerStyle={styles.scroll}>
      <Text style={styles.heading}>Your Plan</Text>
      <Text style={styles.headingSub}>
        {activeMoves.length + userPlans.length} active
        {opportunities.length > 0 ? ` \u00B7 ${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'}` : ''}
      </Text>

      {/* ══════════════════════════════════════════════
          SECTION 1 — GOAL TRAJECTORY
          ══════════════════════════════════════════════ */}
      {goalCtx && (
        <View style={styles.trajectoryCard}>
          <Text style={styles.trajLabel}>GOAL TRAJECTORY</Text>
          <Text style={styles.trajGoal}>{goalCtx.goalLabel}</Text>

          {goalCtx.targetAmount > 0 && (
            <Text style={styles.trajTarget}>
              Target: {'\u00a3'}{goalCtx.targetAmount.toLocaleString()}
            </Text>
          )}

          {/* Timeline bar */}
          <View style={styles.trajTimeline}>
            <View style={styles.trajBarRow}>
              <View style={styles.trajBarBg}>
                {goalCtx.currentMonths > 0 && goalCtx.newMonths > 0 && (
                  <View
                    style={[
                      styles.trajBarFill,
                      { width: `${Math.min(100, Math.round((goalCtx.newMonths / goalCtx.currentMonths) * 100))}%` },
                    ]}
                  />
                )}
              </View>
            </View>
            <View style={styles.trajMonthsRow}>
              {goalCtx.newMonths > 0 ? (
                <>
                  <View style={styles.trajMonthItem}>
                    <Text style={styles.trajMonthValue}>{goalCtx.newMonths}</Text>
                    <Text style={styles.trajMonthLabel}>months{'\n'}with plan</Text>
                  </View>
                  {goalCtx.currentMonths > 0 && (
                    <View style={styles.trajMonthItem}>
                      <Text style={[styles.trajMonthValue, { color: colors.dim }]}>{goalCtx.currentMonths}</Text>
                      <Text style={styles.trajMonthLabel}>months{'\n'}without</Text>
                    </View>
                  )}
                  {goalCtx.monthsSaved > 0 && (
                    <View style={[styles.trajMonthItem, styles.trajSavedItem]}>
                      <Text style={[styles.trajMonthValue, { color: colors.text }]}>-{goalCtx.monthsSaved}</Text>
                      <Text style={[styles.trajMonthLabel, { color: colors.text }]}>months{'\n'}saved</Text>
                    </View>
                  )}
                </>
              ) : (
                <Text style={styles.trajInsight}>{goalCtx.insight}</Text>
              )}
            </View>
          </View>

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
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>ACTIVE MOVES</Text>
            <Text style={styles.sectionMeta}>
              {'\u00a3'}{Math.round(activeMonthly + planMonthly)}/mo impact
            </Text>
          </View>

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
          {activeMoves.map(({ move, index: i }) => {
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
                    <View style={[styles.badge, styles.badgeActive]}>
                      <Text style={styles.badgeActiveText}>{'\u2713'}</Text>
                    </View>
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
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>OPPORTUNITIES</Text>
            <Text style={styles.sectionMeta}>
              {'\u00a3'}{Math.round(totalMonthlyImpact - activeMonthly)}/mo potential
            </Text>
          </View>

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
          {opportunities.map(({ move, index: i }) => {
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
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{i + 1}</Text>
                    </View>
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
        </>
      )}

      {/* ══════════════════════════════════════════════
          SECTION 4 — RESOURCES
          ══════════════════════════════════════════════ */}
      <Text style={[styles.sectionLabel, { marginTop: spacing.xl }]}>NEED HELP WITH DEBT?</Text>
      <View style={styles.card}>
        <TouchableOpacity onPress={() => Linking.openURL('https://www.stepchange.org')}>
          <Text style={styles.resourceLink}>StepChange — Free debt advice</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL('https://www.citizensadvice.org.uk/debt-and-money')}>
          <Text style={styles.resourceLink}>Citizens Advice — Debt guidance</Text>
        </TouchableOpacity>
      </View>
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
                  onPress={() => isActive ? toggleStep(moveKey, j, move.action) : null}
                  activeOpacity={isActive ? 0.7 : 1}
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

        {/* Provider action buttons */}
        {providerActions.length > 0 && (
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
        )}

        <TouchableOpacity
          style={styles.chatBtn}
          onPress={() => router.push('/(main)/(tabs)/chat')}
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
  scroll: { padding: spacing.lg, paddingTop: spacing.xxl + spacing.lg, paddingBottom: spacing.xxl },
  loadingContainer: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  emptyTitle: { fontFamily: fonts.medium, fontSize: 18, color: colors.text, marginBottom: spacing.sm },
  emptyText: { fontFamily: fonts.regular, fontSize: 14, color: colors.dim, textAlign: 'center', lineHeight: 22 },

  // ── Header ──
  heading: { fontFamily: fonts.mono, fontSize: 20, color: colors.text, marginBottom: 2, letterSpacing: 0.5, textTransform: 'uppercase' },
  headingSub: { fontFamily: fonts.regular, fontSize: 13, color: colors.dim, marginBottom: spacing.lg },

  // ── Goal trajectory ──
  trajectoryCard: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 24,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  trajLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 2,
    color: colors.dim,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  trajGoal: {
    fontFamily: fonts.medium,
    fontSize: 18,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  trajTarget: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
    marginBottom: spacing.md,
  },
  trajTimeline: {
    marginBottom: spacing.sm,
  },
  trajBarRow: {
    marginBottom: spacing.md,
  },
  trajBarBg: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  trajBarFill: {
    height: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 2,
  },
  trajMonthsRow: {
    flexDirection: 'row',
    gap: spacing.lg,
  },
  trajMonthItem: {
    alignItems: 'center',
  },
  trajSavedItem: {
    marginLeft: 'auto',
  },
  trajMonthValue: {
    fontFamily: fonts.mono,
    fontSize: 24,
    fontWeight: '300',
    color: colors.text,
  },
  trajMonthLabel: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 15,
  },
  trajInsight: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text2,
    lineHeight: 20,
    marginTop: spacing.xs,
  },

  // ── Section headers ──
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 2,
    color: colors.dim,
    textTransform: 'uppercase',
  },
  sectionMeta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
  },

  // ── Cards ──
  card: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 24,
    padding: spacing.lg,
    marginBottom: spacing.sm,
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
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  badgeActiveText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: '#000000',
  },

  // ── Move content ──
  moveAction: {
    fontFamily: fonts.medium,
    fontSize: 15,
    color: colors.text,
    marginBottom: spacing.xs,
    lineHeight: 22,
  },
  moveStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  impactText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.text,
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
    backgroundColor: '#FFFFFF',
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

  // ── Expanded section ──
  expandedSection: { marginTop: spacing.sm },
  separator: { height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginBottom: spacing.md },
  detailBlock: { marginBottom: spacing.md },
  detailLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 2,
    color: colors.dim,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
  detailText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
    lineHeight: 22,
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
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  checkmark: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: '#000000',
  },
  checklistContent: { flex: 1 },
  checklistText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
    lineHeight: 22,
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
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
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
    color: colors.text,
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
    borderColor: 'rgba(215,26,33,0.3)',
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
  },
  deleteBtnText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.accent,
  },

  // ── Resources ──
  resourceLink: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
    paddingVertical: spacing.xs,
    textDecorationLine: 'underline',
  },
});
