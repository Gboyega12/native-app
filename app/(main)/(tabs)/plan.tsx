import { useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Linking, Alert,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis, Move } from '@/lib/types';

/** Strip markdown bold/italic markers from text rendered with plain <Text> */
const stripMd = (s?: string | null) => (s || '').replace(/\*\*/g, '');

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
  return effort === 'low' ? colors.accent : effort === 'medium' ? colors.sky : colors.coral;
}

// Generate actionable steps for user plans
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

export default function Plan() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [userPlans, setUserPlans] = useState<UserPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  // Progress persisted to DB
  const [progress, setProgress] = useState<Record<string, ProgressRow>>({});
  const userIdRef = useRef<string | null>(null);

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

    // Fetch analysis + user plans + progress in parallel
    const [analysisRes, plansRes, progressRes] = await Promise.all([
      supabase.from('analyses').select('*').eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(1).single(),
      supabase.from('user_plans').select('*').eq('user_id', user.id)
        .eq('status', 'active').order('created_at', { ascending: false }),
      supabase.from('plan_progress').select('*').eq('user_id', user.id),
    ]);

    setAnalysis(analysisRes.data);
    setUserPlans(plansRes.data || []);

    // Build progress map
    const progressMap: Record<string, ProgressRow> = {};
    for (const row of (progressRes.data || [])) {
      progressMap[row.move_key] = {
        move_key: row.move_key,
        move_action: row.move_action,
        approved: row.approved,
        completed_steps: row.completed_steps || [],
      };
    }
    setProgress(progressMap);
    setLoading(false);
  };

  // ── Persist progress to DB ──

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

  // ── Auto-create plan when user taps "Start this" on a move ──

  const handleStartMove = async (index: number, move: Move) => {
    const uid = userIdRef.current;
    if (!uid) return;

    const key = `move-${index}`;

    // Mark as approved in local progress
    const row: ProgressRow = {
      move_key: key,
      move_action: move.action,
      approved: true,
      completed_steps: [],
    };
    setProgress((prev) => ({ ...prev, [key]: row }));
    saveProgress(key, row);

    // Also create a user_plan so it shows in "YOUR PLANS"
    try {
      const { data } = await supabase.from('user_plans').insert({
        user_id: uid,
        action: move.action,
        target_amount: null,
        monthly_saving: move.monthlyImpact || null,
        timeline: null,
        status: 'active',
      }).select('*').single();

      if (data) {
        setUserPlans((prev) => [data, ...prev]);
      }
    } catch {
      // Non-critical — progress is saved regardless
    }
  };

  const handleStopMove = async (index: number) => {
    const uid = userIdRef.current;
    if (!uid) return;

    const key = `move-${index}`;
    setProgress((prev) => {
      const updated = { ...prev };
      delete updated[key];
      return updated;
    });

    // Remove from DB
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

    setUserPlans((prev) => prev.filter((p) => p.id !== planId));
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
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

  const effortOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const moves: Move[] = [...(analysis?.all_moves || [])].sort(
    (a, b) => (effortOrder[a.effort] ?? 2) - (effortOrder[b.effort] ?? 2),
  );

  const approvedMoves = moves.filter((_, i) => progress[`move-${i}`]?.approved);
  const totalMonthly = moves.reduce((s, m) => s + (m.monthlyImpact || 0), 0);
  const approvedMonthly = approvedMoves.reduce((s, m) => s + (m.monthlyImpact || 0), 0);
  const planMonthly = userPlans.reduce((s, p) => s + (p.monthly_saving || 0), 0);
  const overallProgress = moves.length > 0 ? approvedMoves.length / moves.length : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <Text style={styles.heading}>Action Plan</Text>
      <Text style={styles.headingSub}>
        {moves.length} recommendation{moves.length !== 1 ? 's' : ''}
        {userPlans.length > 0 ? ` + ${userPlans.length} active plan${userPlans.length !== 1 ? 's' : ''}` : ''}
      </Text>

      {/* User Plans — created from chat or auto-created */}
      {userPlans.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>YOUR PLANS</Text>
          {userPlans.map((plan) => {
            const isPlanExpanded = expandedPlan === plan.id;
            const planKey = `plan-${plan.id}`;
            const planSteps = getPlanSteps(plan);
            const doneSteps = progress[planKey]?.completed_steps || [];
            const stepProgress = planSteps.length > 0 ? doneSteps.length / planSteps.length : 0;
            const nextStepIdx = planSteps.findIndex((_, idx) => !doneSteps.includes(idx));

            return (
              <View key={plan.id} style={[styles.card, styles.userPlanCard]}>
                <TouchableOpacity
                  onPress={() => setExpandedPlan(isPlanExpanded ? null : plan.id)}
                  activeOpacity={0.8}
                >
                  <View style={styles.cardHeader}>
                    <View style={[styles.moveNumberBadge, styles.planBadge]}>
                      <Text style={styles.planBadgeText}>{'\u2713'}</Text>
                    </View>
                    <View style={styles.cardContent}>
                      <Text style={styles.moveAction}>{stripMd(plan.action)}</Text>
                      {plan.timeline && (
                        <Text style={styles.moveTimeline}>{plan.timeline}</Text>
                      )}
                      <View style={styles.moveStats}>
                        {plan.monthly_saving != null && (
                          <Text style={styles.moveImpact}>
                            {'\u00a3'}{plan.monthly_saving}/mo
                          </Text>
                        )}
                        {plan.target_amount != null && (
                          <Text style={styles.planTarget}>
                            Target: {'\u00a3'}{plan.target_amount}
                          </Text>
                        )}
                        <Text style={styles.expandIcon}>{isPlanExpanded ? '\u25B2' : '\u25BC'}</Text>
                      </View>

                      {/* Step progress bar (collapsed) */}
                      {!isPlanExpanded && (
                        <View style={styles.stepProgressWrap}>
                          <View style={styles.stepProgressBar}>
                            <View style={[styles.stepProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                          </View>
                          <Text style={styles.stepProgressText}>
                            {doneSteps.length}/{planSteps.length} steps
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>

                {/* Quick discard button — always visible */}
                {!isPlanExpanded && (
                  <TouchableOpacity
                    style={styles.quickDiscardBtn}
                    onPress={() => {
                      Alert.alert(
                        'Discard plan?',
                        `Remove "${stripMd(plan.action)}" from your plans?`,
                        [
                          { text: 'Keep', style: 'cancel' },
                          { text: 'Discard', style: 'destructive', onPress: () => handleRemovePlan(plan.id) },
                        ],
                      );
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.quickDiscardText}>Discard</Text>
                  </TouchableOpacity>
                )}

                {isPlanExpanded && (
                  <View style={styles.expandedSection}>
                    <View style={styles.separator} />

                    {plan.target_amount != null && plan.monthly_saving != null && plan.monthly_saving > 0 && (
                      <View style={styles.detailBlock}>
                        <Text style={styles.detailLabel}>Projection</Text>
                        <View style={styles.impactGrid}>
                          <View style={styles.impactItem}>
                            <Text style={styles.impactValue}>{'\u00a3'}{plan.target_amount}</Text>
                            <Text style={styles.impactLabel}>target</Text>
                          </View>
                          <View style={styles.impactItem}>
                            <Text style={styles.impactValue}>{'\u00a3'}{plan.monthly_saving}</Text>
                            <Text style={styles.impactLabel}>per month</Text>
                          </View>
                        </View>
                      </View>
                    )}

                    {/* Actionable checklist */}
                    <View style={styles.detailBlock}>
                      <Text style={styles.detailLabel}>Action checklist</Text>
                      <View style={styles.stepProgressWrap}>
                        <View style={styles.stepProgressBar}>
                          <View style={[styles.stepProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                        </View>
                        <Text style={styles.stepProgressText}>
                          {doneSteps.length}/{planSteps.length} done
                        </Text>
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

                    <View style={styles.actionButtons}>
                      <TouchableOpacity
                        style={styles.removeButton}
                        onPress={() => handleRemovePlan(plan.id)}
                      >
                        <Text style={styles.removeText}>Discard plan</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            );
          })}
        </>
      )}

      {/* Progress summary */}
      {moves.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>RECOMMENDATIONS</Text>
          <View style={styles.progressCard}>
            <View style={styles.progressRow}>
              <View>
                <Text style={styles.progressLabel}>Started</Text>
                <Text style={styles.progressCount}>{approvedMoves.length} of {moves.length}</Text>
              </View>
              <View style={styles.progressRight}>
                <Text style={styles.progressLabel}>Monthly impact</Text>
                <Text style={styles.progressAmount}>
                  {'\u00a3'}{Math.round(approvedMonthly + planMonthly)} of {'\u00a3'}{Math.round(totalMonthly + planMonthly)}
                </Text>
              </View>
            </View>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${Math.round(overallProgress * 100)}%` }]} />
            </View>
          </View>
        </>
      )}

      {/* Moves */}
      {moves.map((move, i) => {
        const isExpanded = expanded === i;
        const moveKey = `move-${i}`;
        const isApproved = progress[moveKey]?.approved || false;
        const steps = move.steps || [];
        const doneSteps = progress[moveKey]?.completed_steps || [];
        const stepProgress = steps.length > 0 ? doneSteps.length / steps.length : 0;
        const nextStepIdx = steps.findIndex((_, idx) => !doneSteps.includes(idx));

        return (
          <View key={i} style={[styles.card, isApproved && styles.cardApproved]}>
            <TouchableOpacity
              onPress={() => setExpanded(isExpanded ? null : i)}
              activeOpacity={0.8}
            >
              <View style={styles.cardHeader}>
                <View style={[styles.moveNumberBadge, isApproved && styles.moveNumberApproved]}>
                  <Text style={[styles.moveNumber, isApproved && styles.moveNumberTextApproved]}>
                    {isApproved ? '\u2713' : i + 1}
                  </Text>
                </View>
                <View style={styles.cardContent}>
                  <Text style={[styles.moveAction, isApproved && styles.approvedAction]}>{stripMd(move.action)}</Text>
                  <View style={styles.moveStats}>
                    <Text style={styles.moveImpact}>
                      {'\u00a3'}{move.monthlyImpact}/mo
                    </Text>
                    <View style={[styles.effortBadge, { backgroundColor: `${effortColor(move.effort)}15` }]}>
                      <Text style={[styles.effortText, { color: effortColor(move.effort) }]}>{move.effort}</Text>
                    </View>
                    <Text style={styles.expandIcon}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                  </View>

                  {/* Step progress bar (collapsed) */}
                  {isApproved && steps.length > 0 && !isExpanded && (
                    <View style={styles.stepProgressWrap}>
                      <View style={styles.stepProgressBar}>
                        <View style={[styles.stepProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                      </View>
                      <Text style={styles.stepProgressText}>
                        {doneSteps.length}/{steps.length} steps
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </TouchableOpacity>

            {isExpanded && (
              <View style={styles.expandedSection}>
                <View style={styles.separator} />

                {move.strategy && (
                  <View style={styles.detailBlock}>
                    <Text style={styles.detailLabel}>Strategy</Text>
                    <Text style={styles.detailText}>{stripMd(move.strategy)}</Text>
                  </View>
                )}

                {/* Actionable checklist */}
                {steps.length > 0 && (
                  <View style={styles.detailBlock}>
                    <Text style={styles.detailLabel}>Action checklist</Text>
                    {isApproved && (
                      <View style={styles.stepProgressWrap}>
                        <View style={styles.stepProgressBar}>
                          <View style={[styles.stepProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                        </View>
                        <Text style={styles.stepProgressText}>
                          {doneSteps.length}/{steps.length} done
                        </Text>
                      </View>
                    )}
                    {steps.map((step, j) => {
                      const isDone = doneSteps.includes(j);
                      const isNext = j === nextStepIdx && isApproved;
                      return (
                        <TouchableOpacity
                          key={j}
                          style={[styles.checklistRow, isNext && styles.checklistRowNext]}
                          onPress={() => isApproved ? toggleStep(moveKey, j, move.action) : null}
                          activeOpacity={isApproved ? 0.7 : 1}
                        >
                          {isApproved ? (
                            <View style={[styles.checkbox, isDone && styles.checkboxDone]}>
                              {isDone && <Text style={styles.checkmark}>{'\u2713'}</Text>}
                            </View>
                          ) : (
                            <Text style={styles.stepNumber}>{j + 1}</Text>
                          )}
                          <View style={styles.checklistContent}>
                            <Text style={[
                              styles.checklistText,
                              isDone && isApproved && styles.checklistTextDone,
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

                {move.effect && (
                  <View style={styles.detailBlock}>
                    <Text style={styles.detailLabel}>Expected outcome</Text>
                    <Text style={styles.effectText}>{stripMd(move.effect)}</Text>
                  </View>
                )}

                <View style={styles.detailBlock}>
                  <Text style={styles.detailLabel}>Impact breakdown</Text>
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

                <TouchableOpacity
                  style={styles.chatBtn}
                  onPress={() => router.push('/(main)/(tabs)/chat')}
                >
                  <Text style={styles.chatBtnText}>Ask Bocy about this</Text>
                </TouchableOpacity>

                <View style={styles.actionButtons}>
                  {isApproved ? (
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
                      <Text style={styles.startBtnText}>Start this</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}
          </View>
        );
      })}

      {/* Resources */}
      <Text style={styles.sectionLabel}>NEED HELP WITH DEBT?</Text>
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
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, paddingTop: spacing.xxl + spacing.lg, paddingBottom: spacing.xxl },
  loadingContainer: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  emptyTitle: { fontFamily: fonts.semibold, fontSize: 18, color: colors.text, marginBottom: spacing.sm },
  emptyText: { fontFamily: fonts.regular, fontSize: 14, color: colors.dim, textAlign: 'center', lineHeight: 22 },
  heading: { fontFamily: fonts.heading, fontSize: 24, color: colors.text, marginBottom: 2 },
  headingSub: { fontFamily: fonts.regular, fontSize: 13, color: colors.dim, marginBottom: spacing.lg },
  // ── Progress card ──
  progressCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.lg },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.md },
  progressLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.dim, marginBottom: 2 },
  progressCount: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text },
  progressRight: { alignItems: 'flex-end' },
  progressAmount: { fontFamily: fonts.semibold, fontSize: 16, color: colors.accent },
  progressBar: { height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 3, minWidth: 2 },
  // ── Cards ──
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.sm },
  cardApproved: { borderColor: colors.accentDim },
  userPlanCard: { borderColor: colors.accent },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start' },
  moveNumberBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.accentDim, justifyContent: 'center', alignItems: 'center', marginRight: spacing.sm, marginTop: 2 },
  moveNumberApproved: { backgroundColor: colors.accent },
  planBadge: { backgroundColor: colors.accent },
  planBadgeText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.bg },
  moveNumber: { fontFamily: fonts.semibold, fontSize: 13, color: colors.accent },
  moveNumberTextApproved: { color: colors.bg },
  cardContent: { flex: 1 },
  moveAction: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, marginBottom: spacing.xs, lineHeight: 22 },
  approvedAction: { color: colors.text2 },
  moveTimeline: { fontFamily: fonts.medium, fontSize: 12, color: colors.accent, marginBottom: spacing.xs },
  moveStats: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  moveImpact: { fontFamily: fonts.semibold, fontSize: 13, color: colors.accent },
  planTarget: { fontFamily: fonts.regular, fontSize: 12, color: colors.dim },
  effortBadge: { borderRadius: 10, paddingVertical: 2, paddingHorizontal: 8 },
  effortText: { fontSize: 11, fontFamily: fonts.medium },
  expandIcon: { fontSize: 10, color: colors.muted, marginLeft: 'auto' },
  // ── Expanded section ──
  expandedSection: { marginTop: spacing.sm },
  separator: { height: 1, backgroundColor: colors.border, marginBottom: spacing.md },
  detailBlock: { marginBottom: spacing.md },
  detailLabel: { fontFamily: fonts.semibold, fontSize: 11, letterSpacing: 0.5, color: colors.dim, textTransform: 'uppercase', marginBottom: spacing.xs },
  detailText: { fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22 },
  // ── Interactive checklist ──
  checklistRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
  checklistRowNext: { backgroundColor: 'rgba(122,239,199,0.06)', marginHorizontal: -spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.sm, borderBottomWidth: 0 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.muted, marginRight: spacing.sm, marginTop: 1, justifyContent: 'center', alignItems: 'center' },
  checkboxDone: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkmark: { fontFamily: fonts.semibold, fontSize: 13, color: colors.bg },
  checklistContent: { flex: 1 },
  checklistText: { fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22 },
  checklistTextDone: { textDecorationLine: 'line-through', color: colors.muted },
  nextStepLabel: { fontFamily: fonts.semibold, fontSize: 10, letterSpacing: 0.5, color: colors.accent, marginTop: 2, textTransform: 'uppercase' },
  stepProgressWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.xs },
  stepProgressBar: { flex: 1, height: 4, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden' },
  stepProgressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 2, minWidth: 1 },
  stepProgressText: { fontFamily: fonts.mono, fontSize: 11, color: colors.muted },
  stepNumber: { fontFamily: fonts.semibold, fontSize: 13, color: colors.accent, width: 22, marginRight: spacing.sm, textAlign: 'center', marginTop: 1 },
  effectText: { fontFamily: fonts.medium, fontSize: 14, color: colors.accent, lineHeight: 22 },
  impactGrid: { flexDirection: 'row', gap: spacing.md },
  impactItem: { flex: 1, backgroundColor: colors.accentDim, borderRadius: radius.sm, padding: spacing.sm, alignItems: 'center' },
  impactValue: { fontFamily: fonts.heading, fontSize: 18, color: colors.accent },
  impactLabel: { fontFamily: fonts.regular, fontSize: 11, color: colors.accent, marginTop: 2 },
  // ── Buttons ──
  chatBtn: { borderWidth: 1.5, borderColor: colors.accentDim, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center', marginBottom: spacing.sm },
  chatBtnText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.accent },
  actionButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  startBtn: { flex: 1, backgroundColor: colors.accent, paddingVertical: 14, borderRadius: radius.md, alignItems: 'center' },
  startBtnText: { fontFamily: fonts.semibold, fontSize: 15, color: colors.bg },
  removeButton: { flex: 1, borderWidth: 1, borderColor: colors.border, paddingVertical: 14, borderRadius: radius.md, alignItems: 'center' },
  removeText: { fontFamily: fonts.medium, fontSize: 14, color: colors.dim },
  quickDiscardBtn: { position: 'absolute', top: spacing.lg, right: spacing.lg, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, backgroundColor: 'rgba(232,96,99,0.08)' },
  quickDiscardText: { fontFamily: fonts.medium, fontSize: 11, color: colors.coral },
  sectionLabel: { fontFamily: fonts.semibold, fontSize: 11, letterSpacing: 1.5, color: colors.accent, marginBottom: spacing.sm, marginTop: spacing.xl },
  resourceLink: { fontFamily: fonts.regular, fontSize: 14, color: colors.sky, paddingVertical: spacing.xs, textDecorationLine: 'underline' },
});
