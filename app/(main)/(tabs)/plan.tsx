import { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Linking,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis, Move } from '@/lib/types';

interface UserPlan {
  id: string;
  action: string;
  target_amount: number | null;
  monthly_saving: number | null;
  timeline: string | null;
  status: string;
  created_at: string;
}

function effortColor(effort: string) {
  return effort === 'low' ? colors.accent : effort === 'medium' ? colors.sky : colors.coral;
}

// Generate actionable steps for user plans that don't have them
function getPlanSteps(plan: UserPlan): string[] {
  const action = (plan.action || '').toLowerCase();
  if (action.includes('emergency') || action.includes('buffer')) {
    return [
      'Open a separate savings pot today',
      'Set up a standing order on your next payday',
      'Automate so you don\'t have to think about it',
    ];
  }
  if (action.includes('debt') || action.includes('credit') || action.includes('pay off')) {
    return [
      'List all debts with their interest rates',
      'Set up minimum payments on all debts',
      'Direct any extra to the highest-rate debt first',
    ];
  }
  if (action.includes('save') || action.includes('saving')) {
    return [
      'Pick a high-interest savings account',
      'Set up automatic monthly transfer on payday',
      'Review progress at the end of each month',
    ];
  }
  if (action.includes('invest')) {
    return [
      'Research a stocks & shares ISA provider',
      'Start with a small monthly amount you won\'t miss',
      'Set it and forget it — don\'t check daily',
    ];
  }
  if (action.includes('subscript') || action.includes('cancel')) {
    return [
      'List all active subscriptions this week',
      'Cancel the ones you haven\'t used in 30 days',
      'Set a reminder to review again next month',
    ];
  }
  return [
    'Break this goal into a weekly action',
    'Set a calendar reminder for your first step',
    'Review progress with Bocy next week',
  ];
}

export default function Plan() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [userPlans, setUserPlans] = useState<UserPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  // Step completion tracking: key = "move-{index}" or "plan-{id}", value = set of completed step indices
  const [completedSteps, setCompletedSteps] = useState<Record<string, Set<number>>>({});

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const loadData = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    // Fetch analysis
    const { data: analysisData } = await supabase
      .from('analyses')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    setAnalysis(analysisData);

    // Fetch user plans (separate try to handle table not existing)
    try {
      const { data: plansData, error: plansError } = await supabase
        .from('user_plans')
        .select('*')
        .eq('user_id', user.id)
        .in('status', ['active', 'proposed'])
        .order('created_at', { ascending: false });

      if (plansError) {
        console.warn('[plan] Failed to fetch user plans:', plansError.message);
        setUserPlans([]);
      } else {
        setUserPlans(plansData || []);
      }
    } catch {
      setUserPlans([]);
    }

    setLoading(false);
  };

  const toggleStep = (key: string, stepIndex: number) => {
    setCompletedSteps((prev) => {
      const current = prev[key] || new Set<number>();
      const next = new Set(current);
      if (next.has(stepIndex)) next.delete(stepIndex);
      else next.add(stepIndex);
      return { ...prev, [key]: next };
    });
  };

  const handleApprove = (index: number) => {
    setApproved((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });
  };

  const handleUnapprove = (index: number) => {
    setApproved((prev) => {
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  };

  const handleApprovePlanFromPage = async (planId: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    try {
      const res = await fetch('/api/plans/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, user_id: user.id }),
      });
      const data = await res.json();
      if (data.success) {
        setUserPlans((prev) =>
          prev.map((p) => p.id === planId ? { ...p, status: 'active' } : p),
        );
      }
    } catch {}
  };

  const handleRemovePlan = async (planId: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    try {
      await fetch('/api/plans/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, user_id: user.id }),
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
        <Text style={styles.emptyText}>Complete an analysis to see your personalised recommendations.</Text>
      </View>
    );
  }

  const effortOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const moves: Move[] = [...(analysis?.all_moves || [])].sort(
    (a, b) => (effortOrder[a.effort] ?? 2) - (effortOrder[b.effort] ?? 2),
  );
  const approvedCount = approved.size;
  const totalMonthly = moves.reduce((s, m) => s + (m.monthlyImpact || 0), 0);
  const approvedMonthly = moves.reduce((s, m, i) => approved.has(i) ? s + (m.monthlyImpact || 0) : s, 0);
  const planMonthly = userPlans.reduce((s, p) => s + (p.monthly_saving || 0), 0);
  const progress = moves.length > 0 ? approvedCount / moves.length : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <Text style={styles.heading}>Action Plan</Text>
      <Text style={styles.headingSub}>
        {moves.length} recommendation{moves.length !== 1 ? 's' : ''}
        {userPlans.length > 0 ? ` + ${userPlans.length} active plan${userPlans.length !== 1 ? 's' : ''}` : ''}
      </Text>

      {/* User Plans — created from chat */}
      {userPlans.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>YOUR PLANS</Text>
          {userPlans.map((plan) => {
            const isPlanExpanded = expandedPlan === plan.id;
            const isProposed = plan.status === 'proposed';
            const planKey = `plan-${plan.id}`;
            const planSteps = getPlanSteps(plan);
            const doneSteps = completedSteps[planKey] || new Set<number>();
            const stepProgress = planSteps.length > 0 ? doneSteps.size / planSteps.length : 0;
            const nextStepIdx = planSteps.findIndex((_, idx) => !doneSteps.has(idx));

            return (
              <View key={plan.id} style={[styles.card, isProposed ? styles.userPlanPending : styles.userPlanCard]}>
                <TouchableOpacity
                  onPress={() => setExpandedPlan(isPlanExpanded ? null : plan.id)}
                  activeOpacity={0.8}
                >
                  <View style={styles.cardHeader}>
                    <View style={[styles.moveNumberBadge, isProposed ? styles.planBadgePending : styles.planBadge]}>
                      <Text style={isProposed ? styles.planBadgePendingText : styles.planBadgeText}>
                        {isProposed ? '?' : '\u2713'}
                      </Text>
                    </View>
                    <View style={styles.cardContent}>
                      <Text style={styles.moveAction}>{plan.action}</Text>
                      {isProposed && (
                        <Text style={styles.pendingLabel}>Pending approval from chat</Text>
                      )}
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

                      {/* Step progress bar (collapsed view) */}
                      {!isProposed && !isPlanExpanded && (
                        <View style={styles.stepProgressWrap}>
                          <View style={styles.stepProgressBar}>
                            <View style={[styles.stepProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                          </View>
                          <Text style={styles.stepProgressText}>
                            {doneSteps.size}/{planSteps.length} steps
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>

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
                    {!isProposed && (
                      <View style={styles.detailBlock}>
                        <Text style={styles.detailLabel}>Action checklist</Text>
                        <View style={styles.stepProgressWrap}>
                          <View style={styles.stepProgressBar}>
                            <View style={[styles.stepProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                          </View>
                          <Text style={styles.stepProgressText}>
                            {doneSteps.size}/{planSteps.length} done
                          </Text>
                        </View>
                        {planSteps.map((step, j) => {
                          const isDone = doneSteps.has(j);
                          const isNext = j === nextStepIdx;
                          return (
                            <TouchableOpacity
                              key={j}
                              style={[styles.checklistRow, isNext && styles.checklistRowNext]}
                              onPress={() => toggleStep(planKey, j)}
                              activeOpacity={0.7}
                            >
                              <View style={[styles.checkbox, isDone && styles.checkboxDone]}>
                                {isDone && <Text style={styles.checkmark}>{'\u2713'}</Text>}
                              </View>
                              <View style={styles.checklistContent}>
                                <Text style={[styles.checklistText, isDone && styles.checklistTextDone]}>
                                  {step}
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

                    {/* Ask Bocy for help */}
                    <TouchableOpacity
                      style={styles.chatBtn}
                      onPress={() => router.push('/(main)/(tabs)/chat')}
                    >
                      <Text style={styles.chatBtnText}>Ask Bocy about this</Text>
                    </TouchableOpacity>

                    <View style={styles.actionButtons}>
                      {isProposed && (
                        <TouchableOpacity
                          style={styles.approveBtn}
                          onPress={() => handleApprovePlanFromPage(plan.id)}
                        >
                          <Text style={styles.approveBtnText}>Approve</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        style={styles.unapproveButton}
                        onPress={() => handleRemovePlan(plan.id)}
                      >
                        <Text style={styles.unapproveText}>Remove plan</Text>
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
                <Text style={styles.progressLabel}>Approved</Text>
                <Text style={styles.progressCount}>{approvedCount} of {moves.length}</Text>
              </View>
              <View style={styles.progressRight}>
                <Text style={styles.progressLabel}>Monthly impact</Text>
                <Text style={styles.progressAmount}>
                  {'\u00a3'}{Math.round(approvedMonthly + planMonthly)} of {'\u00a3'}{Math.round(totalMonthly + planMonthly)}
                </Text>
              </View>
            </View>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
            </View>
          </View>
        </>
      )}

      {/* Moves */}
      {moves.map((move, i) => {
        const isExpanded = expanded === i;
        const isApproved = approved.has(i);
        const moveKey = `move-${i}`;
        const steps = move.steps || [];
        const doneSteps = completedSteps[moveKey] || new Set<number>();
        const stepProgress = steps.length > 0 ? doneSteps.size / steps.length : 0;
        const nextStepIdx = steps.findIndex((_, idx) => !doneSteps.has(idx));

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
                  <Text style={[styles.moveAction, isApproved && styles.approvedAction]}>{move.action}</Text>
                  {(move as any).timeline && (
                    <Text style={styles.moveTimeline}>{(move as any).timeline}</Text>
                  )}
                  <View style={styles.moveStats}>
                    <Text style={styles.moveImpact}>
                      {'\u00a3'}{move.monthlyImpact}/mo
                    </Text>
                    <View style={[styles.effortBadge, { backgroundColor: `${effortColor(move.effort)}15` }]}>
                      <Text style={[styles.effortText, { color: effortColor(move.effort) }]}>{move.effort}</Text>
                    </View>
                    <Text style={styles.expandIcon}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                  </View>

                  {/* Step progress bar (collapsed view) */}
                  {isApproved && steps.length > 0 && !isExpanded && (
                    <View style={styles.stepProgressWrap}>
                      <View style={styles.stepProgressBar}>
                        <View style={[styles.stepProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                      </View>
                      <Text style={styles.stepProgressText}>
                        {doneSteps.size}/{steps.length} steps
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
                    <Text style={styles.detailText}>{move.strategy}</Text>
                  </View>
                )}

                {/* Actionable checklist — replaces old numbered list */}
                {steps.length > 0 && (
                  <View style={styles.detailBlock}>
                    <Text style={styles.detailLabel}>Action checklist</Text>
                    {isApproved && (
                      <View style={styles.stepProgressWrap}>
                        <View style={styles.stepProgressBar}>
                          <View style={[styles.stepProgressFill, { width: `${Math.round(stepProgress * 100)}%` }]} />
                        </View>
                        <Text style={styles.stepProgressText}>
                          {doneSteps.size}/{steps.length} done
                        </Text>
                      </View>
                    )}
                    {steps.map((step, j) => {
                      const isDone = doneSteps.has(j);
                      const isNext = j === nextStepIdx && isApproved;
                      return (
                        <TouchableOpacity
                          key={j}
                          style={[styles.checklistRow, isNext && styles.checklistRowNext]}
                          onPress={() => isApproved ? toggleStep(moveKey, j) : null}
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
                              {step}
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
                    <Text style={styles.effectText}>{move.effect}</Text>
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

                {/* Ask Bocy for help */}
                <TouchableOpacity
                  style={styles.chatBtn}
                  onPress={() => router.push('/(main)/(tabs)/chat')}
                >
                  <Text style={styles.chatBtnText}>Ask Bocy about this</Text>
                </TouchableOpacity>

                <View style={styles.actionButtons}>
                  {isApproved ? (
                    <TouchableOpacity
                      style={styles.unapproveButton}
                      onPress={() => handleUnapprove(i)}
                    >
                      <Text style={styles.unapproveText}>Remove from plan</Text>
                    </TouchableOpacity>
                  ) : (
                    <>
                      <TouchableOpacity
                        style={styles.approveBtn}
                        onPress={() => handleApprove(i)}
                      >
                        <Text style={styles.approveBtnText}>Start this</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.modifyBtn}
                        onPress={() => router.push('/(main)/(tabs)/chat')}
                      >
                        <Text style={styles.modifyBtnText}>Ask Bocy</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              </View>
            )}
          </View>
        );
      })}

      {/* Debt Resources */}
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
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: spacing.lg,
    paddingTop: spacing.xxl + spacing.lg,
    paddingBottom: spacing.xxl,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  emptyTitle: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  emptyText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 22,
  },
  heading: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: colors.text,
    marginBottom: 2,
  },
  headingSub: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginBottom: spacing.lg,
  },
  progressCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  progressLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
    marginBottom: 2,
  },
  progressCount: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
  },
  progressRight: {
    alignItems: 'flex-end',
  },
  progressAmount: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.accent,
  },
  progressBar: {
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.accent,
    borderRadius: 3,
    minWidth: 2,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  cardApproved: {
    borderColor: colors.accentDim,
  },
  userPlanCard: {
    borderColor: colors.accent,
  },
  userPlanPending: {
    borderColor: colors.sky,
    borderStyle: 'dashed',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  moveNumberBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accentDim,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.sm,
    marginTop: 2,
  },
  moveNumberApproved: {
    backgroundColor: colors.accent,
  },
  planBadge: {
    backgroundColor: colors.accent,
  },
  planBadgeText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.bg,
  },
  planBadgePending: {
    backgroundColor: colors.skyDim,
  },
  planBadgePendingText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.sky,
  },
  pendingLabel: {
    fontFamily: fonts.medium,
    fontSize: 11,
    color: colors.sky,
    marginBottom: spacing.xs,
  },
  moveNumber: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.accent,
  },
  moveNumberTextApproved: {
    color: colors.bg,
  },
  cardContent: {
    flex: 1,
  },
  moveAction: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    marginBottom: spacing.xs,
    lineHeight: 22,
  },
  approvedAction: {
    color: colors.text2,
  },
  moveTimeline: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.accent,
    marginBottom: spacing.xs,
  },
  moveStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  moveImpact: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.accent,
  },
  planTarget: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
  },
  effortBadge: {
    borderRadius: 10,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  effortText: {
    fontSize: 11,
    fontFamily: fonts.medium,
  },
  expandIcon: {
    fontSize: 10,
    color: colors.muted,
    marginLeft: 'auto',
  },
  expandedSection: {
    marginTop: spacing.sm,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  detailBlock: {
    marginBottom: spacing.md,
  },
  detailLabel: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 0.5,
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
  // ── Interactive checklist ──
  checklistRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  checklistRowNext: {
    backgroundColor: 'rgba(122,239,199,0.06)',
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderBottomWidth: 0,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.muted,
    marginRight: spacing.sm,
    marginTop: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxDone: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  checkmark: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.bg,
  },
  checklistContent: {
    flex: 1,
  },
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
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 0.5,
    color: colors.accent,
    marginTop: 2,
    textTransform: 'uppercase',
  },
  stepProgressWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  stepProgressBar: {
    flex: 1,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  stepProgressFill: {
    height: '100%',
    backgroundColor: colors.accent,
    borderRadius: 2,
    minWidth: 1,
  },
  stepProgressText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
  },
  // ── Old step number (for non-approved moves) ──
  stepNumber: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.accent,
    width: 22,
    marginRight: spacing.sm,
    textAlign: 'center',
    marginTop: 1,
  },
  effectText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.accent,
    lineHeight: 22,
  },
  impactGrid: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  impactItem: {
    flex: 1,
    backgroundColor: colors.accentDim,
    borderRadius: radius.sm,
    padding: spacing.sm,
    alignItems: 'center',
  },
  impactValue: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.accent,
  },
  impactLabel: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.accent,
    marginTop: 2,
  },
  // ── Chat button ──
  chatBtn: {
    borderWidth: 1.5,
    borderColor: colors.accentDim,
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  chatBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.accent,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  approveBtn: {
    flex: 1,
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  approveBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.bg,
  },
  modifyBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  modifyBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.accent,
  },
  unapproveButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  unapproveText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.dim,
  },
  sectionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    marginBottom: spacing.sm,
    marginTop: spacing.xl,
  },
  resourceLink: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.sky,
    paddingVertical: spacing.xs,
    textDecorationLine: 'underline',
  },
});
