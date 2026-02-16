import { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis, GoalTrajectory } from '@/lib/types';

// ── Helpers ──

function getScoreVerdict(score: number): { label: string; color: string } {
  if (score >= 80) return { label: 'Strong', color: colors.accent };
  if (score >= 60) return { label: 'Balanced', color: colors.sky };
  if (score >= 40) return { label: 'Needs Attention', color: '#E8C872' };
  return { label: 'At Risk', color: colors.coral };
}

function getArchetypeDisplay(key: string): { name: string; emoji: string } {
  const map: Record<string, { name: string; emoji: string }> = {
    subscription_collector: { name: 'Subscription Collector', emoji: '\u{1F4E6}' },
    convenience_seeker: { name: 'Convenience Seeker', emoji: '\u{1F695}' },
    lifestyle_investor: { name: 'Lifestyle Investor', emoji: '\u2728' },
    quiet_builder: { name: 'Quiet Builder', emoji: '\u{1F9F1}' },
    edge_walker: { name: 'Edge Walker', emoji: '\u26A1' },
    debt_juggler: { name: 'Debt Juggler', emoji: '\u{1F3AA}' },
    impulse_surfer: { name: 'Impulse Surfer', emoji: '\u{1F3C4}' },
    comfort_spender: { name: 'Comfort Spender', emoji: '\u2615' },
    side_hustler: { name: 'Side Hustler', emoji: '\u{1F4BC}' },
    balanced_realist: { name: 'Balanced Realist', emoji: '\u2696\uFE0F' },
  };
  return map[key] || { name: 'Balanced Realist', emoji: '\u2696\uFE0F' };
}

export default function Home() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const loadData = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    setUserName(user.user_metadata?.full_name?.split(' ')[0] || '');

    const { data } = await supabase
      .from('analyses')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    setAnalysis(data);
    setLoading(false);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  // ── Derived data ──
  const topMove = analysis?.top_move;
  const income = analysis?.monthly_income ?? 0;
  const spending = analysis?.monthly_spending ?? 0;
  const surplus = analysis?.surplus ?? 0;
  const score = analysis?.decision_score ?? 0;
  const verdict = getScoreVerdict(score);
  const archetype = analysis?.archetype ? getArchetypeDisplay(analysis.archetype) : null;
  const patterns = analysis?.behavioral_patterns ?? [];
  const goalCtx = analysis?.goal_context as GoalTrajectory | null;

  // Budget reality
  const nonDiscTotal = typeof analysis?.non_discretionary === 'object' && analysis.non_discretionary
    ? (analysis.non_discretionary as any).total ?? 0 : 0;
  const discTotal = typeof analysis?.discretionary === 'object' && analysis.discretionary
    ? (analysis.discretionary as any).total ?? 0 : 0;
  const totalExpense = nonDiscTotal + discTotal || spending;
  const nonDiscPct = totalExpense > 0 ? Math.round((nonDiscTotal / totalExpense) * 100) : 0;
  const discPct = totalExpense > 0 ? Math.round((discTotal / totalExpense) * 100) : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      {/* ── Header ── */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>
            {userName ? userName : 'Welcome'}
          </Text>
          <Text style={styles.greetingSub}>Here's your financial snapshot</Text>
        </View>
        <TouchableOpacity
          style={styles.profileButton}
          onPress={() => router.push('/(main)/profile')}
        >
          <Text style={styles.profileInitials}>
            {userName ? userName.charAt(0).toUpperCase() : '?'}
          </Text>
        </TouchableOpacity>
      </View>

      {!analysis ? (
        /* ── Empty State ── */
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>B</Text>
          <Text style={styles.emptyTitle}>Your #1 financial move awaits</Text>
          <Text style={styles.emptyDesc}>
            Connect your bank account so I can analyse your transactions and identify the single most impactful action you can take right now.
          </Text>
          <TouchableOpacity
            style={styles.ctaButton}
            onPress={() => router.push('/(main)/connect')}
          >
            <Text style={styles.ctaText}>Connect your bank</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* ── 1. Decision Score ── */}
          <Text style={styles.sectionLabel}>DECISION SCORE</Text>
          <View style={styles.scoreCard}>
            <View style={styles.scoreHeader}>
              <View>
                <Text style={styles.scoreTitle}>Decision Score</Text>
                {archetype && (
                  <Text style={styles.archetypeLabel}>
                    {archetype.emoji} {archetype.name}
                  </Text>
                )}
              </View>
              <Text style={styles.scoreNumber}>{score}</Text>
            </View>
            <View style={styles.verdictRow}>
              <View style={[styles.verdictBadge, { backgroundColor: verdict.color + '1A' }]}>
                <View style={[styles.verdictDot, { backgroundColor: verdict.color }]} />
                <Text style={[styles.verdictText, { color: verdict.color }]}>
                  {verdict.label}
                </Text>
              </View>
              <Text style={styles.scoreOutOf}>/100</Text>
            </View>
            {/* Score gauge bar */}
            <View style={styles.gaugeTrack}>
              <View style={[styles.gaugeFill, { width: `${Math.min(score, 100)}%` }]} />
              <View style={[styles.gaugeThumb, { left: `${Math.min(score, 100)}%` }]} />
            </View>
            <View style={styles.gaugeLabels}>
              <Text style={styles.gaugeLabelText}>0</Text>
              <Text style={styles.gaugeLabelText}>50</Text>
              <Text style={styles.gaugeLabelText}>100</Text>
            </View>
          </View>

          {/* ── 2. Your #1 Move ── */}
          <Text style={styles.sectionLabel}>YOUR #1 MOVE</Text>
          <View style={styles.moveCard}>
            {topMove?.action ? (
              <>
                <Text style={styles.moveAction}>{topMove.action}</Text>
                {topMove.timeline && (
                  <View style={styles.timelineRow}>
                    <View style={styles.timelineDot} />
                    <Text style={styles.timelineText}>{topMove.timeline}</Text>
                  </View>
                )}
                <View style={styles.impactRow}>
                  <View style={styles.impactChip}>
                    <Text style={styles.impactValue}>
                      {'\u00a3'}{topMove.monthlyImpact || 0}
                    </Text>
                    <Text style={styles.impactUnit}>/month</Text>
                  </View>
                  <View style={styles.impactChip}>
                    <Text style={styles.impactValue}>
                      {'\u00a3'}{topMove.annualImpact || ((topMove.monthlyImpact || 0) * 12)}
                    </Text>
                    <Text style={styles.impactUnit}>/year</Text>
                  </View>
                  {topMove.effort && (
                    <View style={[styles.effortChip, topMove.effort === 'low' && styles.effortLow, topMove.effort === 'high' && styles.effortHigh]}>
                      <Text style={[styles.effortText, topMove.effort === 'low' && styles.effortTextLow, topMove.effort === 'high' && styles.effortTextHigh]}>
                        {topMove.effort.charAt(0).toUpperCase() + topMove.effort.slice(1)} effort
                      </Text>
                    </View>
                  )}
                </View>
                <View style={styles.moveButtons}>
                  <TouchableOpacity
                    style={styles.approveButton}
                    onPress={() => router.push('/(main)/(tabs)/plan')}
                  >
                    <Text style={styles.approveText}>Approve</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modifyButton}
                    onPress={() => router.push('/(main)/(tabs)/plan')}
                  >
                    <Text style={styles.modifyText}>Modify</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <Text style={styles.noDataText}>
                No actionable move identified yet. Connect more accounts for deeper analysis.
              </Text>
            )}
          </View>

          {/* ── 3. Money Flow ── */}
          <Text style={styles.sectionLabel}>MONEY FLOW</Text>
          <View style={styles.card}>
            <View style={styles.flowRow}>
              <Text style={styles.flowLabel}>Monthly income</Text>
              <Text style={[styles.flowValue, { color: colors.accent }]}>
                {'\u00a3'}{Math.round(income).toLocaleString()}
              </Text>
            </View>
            <View style={styles.flowRow}>
              <Text style={styles.flowLabel}>Monthly spending</Text>
              <Text style={[styles.flowValue, { color: colors.coral }]}>
                {'\u00a3'}{Math.round(spending).toLocaleString()}
              </Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.flowRow}>
              <Text style={styles.flowLabel}>Surplus</Text>
              <Text style={[styles.surplusValue, { color: surplus >= 0 ? colors.accent : colors.coral }]}>
                {surplus >= 0 ? '+' : ''}{'\u00a3'}{Math.round(surplus).toLocaleString()}
              </Text>
            </View>
            {analysis.income_sources && analysis.income_sources.length > 0 && (
              <View style={styles.chipRow}>
                {analysis.income_sources.map((src: any, i: number) => (
                  <View key={i} style={styles.sourceChip}>
                    <Text style={styles.sourceChipText}>
                      {typeof src === 'string' ? src : src.source || src.name || 'Income'}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* ── 4. Spending Breakdown ── */}
          <Text style={styles.sectionLabel}>SPENDING BREAKDOWN</Text>
          <View style={styles.card}>
            <View style={styles.breakdownColumns}>
              <View style={styles.breakdownCol}>
                <Text style={styles.breakdownLabel}>Non-negotiable</Text>
                <Text style={[styles.breakdownValue, { color: colors.coral }]}>
                  {'\u00a3'}{Math.round(nonDiscTotal).toLocaleString()}
                </Text>
                <Text style={styles.breakdownPct}>{nonDiscPct}% of spending</Text>
              </View>
              <View style={styles.breakdownDivider} />
              <View style={styles.breakdownCol}>
                <Text style={styles.breakdownLabel}>Negotiable</Text>
                <Text style={[styles.breakdownValue, { color: colors.sky }]}>
                  {'\u00a3'}{Math.round(discTotal).toLocaleString()}
                </Text>
                <Text style={styles.breakdownPct}>{discPct}% of spending</Text>
              </View>
            </View>
            <View style={styles.barTrack}>
              <View style={[styles.barSegment, { flex: nonDiscPct || 1, backgroundColor: colors.coral }]} />
              <View style={[styles.barSegment, { flex: discPct || 1, backgroundColor: colors.sky }]} />
            </View>
            <Text style={styles.insightText}>
              {nonDiscPct > 60
                ? `${nonDiscPct}% of your spending is fixed. Focus on negotiable expenses for quick wins.`
                : discPct > 50
                  ? `${discPct}% of your spending is negotiable \u2014 significant room to optimise.`
                  : 'Your fixed and flexible spending is relatively balanced.'}
            </Text>
          </View>

          {/* ── 5. Behavioral Insights ── */}
          {patterns.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>BEHAVIORAL INSIGHTS</Text>
              <View style={styles.card}>
                <View style={styles.patternGrid}>
                  {patterns.map((pattern: string, i: number) => (
                    <View key={i} style={styles.patternChip}>
                      <Text style={styles.patternText}>{pattern}</Text>
                    </View>
                  ))}
                </View>
              </View>
            </>
          )}

          {/* ── 6. Goal Tracker ── */}
          {goalCtx && goalCtx.goalLabel && (
            <>
              <Text style={styles.sectionLabel}>GOAL TRACKER</Text>
              <View style={styles.goalCard}>
                <Text style={styles.goalLabel}>{goalCtx.goalLabel}</Text>
                {goalCtx.targetAmount > 0 && (
                  <Text style={styles.goalTarget}>
                    Target: {'\u00a3'}{goalCtx.targetAmount.toLocaleString()}
                  </Text>
                )}
                <View style={styles.goalTimeline}>
                  <View style={styles.goalTimeBlock}>
                    <Text style={styles.goalTimeNumber}>{goalCtx.currentMonths}</Text>
                    <Text style={styles.goalTimeUnit}>months{'\n'}currently</Text>
                  </View>
                  <View style={styles.goalArrow}>
                    <Text style={styles.goalArrowText}>{'\u2192'}</Text>
                  </View>
                  <View style={styles.goalTimeBlock}>
                    <Text style={[styles.goalTimeNumber, { color: colors.accent }]}>
                      {goalCtx.newMonths}
                    </Text>
                    <Text style={styles.goalTimeUnit}>months{'\n'}with move</Text>
                  </View>
                  <View style={styles.goalSavedBlock}>
                    <Text style={styles.goalSavedNumber}>
                      {goalCtx.monthsSaved}
                    </Text>
                    <Text style={styles.goalSavedUnit}>months{'\n'}saved</Text>
                  </View>
                </View>
                {goalCtx.insight && (
                  <Text style={styles.goalInsight}>{goalCtx.insight}</Text>
                )}
              </View>
            </>
          )}

          {/* ── 7. Upload New Statement CTA ── */}
          <TouchableOpacity
            style={styles.uploadButton}
            onPress={() => router.push('/(main)/connect')}
          >
            <Text style={styles.uploadText}>Upload new statement</Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: spacing.lg,
    paddingTop: spacing.xxl + spacing.lg,
    paddingBottom: spacing.xxl + spacing.lg,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Header ──
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  greeting: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: colors.text,
  },
  greetingSub: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginTop: 2,
  },
  profileButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileInitials: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
  },

  // ── Empty State ──
  emptyState: {
    marginTop: spacing.xxl,
    alignItems: 'center',
  },
  emptyIcon: {
    fontFamily: fonts.heading,
    fontSize: 40,
    color: colors.accent,
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontFamily: fonts.semibold,
    fontSize: 20,
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  emptyDesc: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  ctaButton: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    alignItems: 'center',
    width: '100%',
  },
  ctaText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
  },

  // ── Section Label ──
  sectionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
  },

  // ── 1. Decision Score Card ──
  scoreCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  scoreHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
  },
  scoreTitle: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.dim,
  },
  archetypeLabel: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.text2,
    marginTop: 4,
  },
  scoreNumber: {
    fontFamily: fonts.heading,
    fontSize: 42,
    color: colors.text,
    lineHeight: 48,
  },
  verdictRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  verdictBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 20,
    gap: 6,
  },
  verdictDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  verdictText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  scoreOutOf: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.muted,
  },
  gaugeTrack: {
    height: 6,
    backgroundColor: colors.muted,
    borderRadius: 3,
    marginBottom: spacing.xs,
    position: 'relative',
  },
  gaugeFill: {
    height: 6,
    backgroundColor: colors.accent,
    borderRadius: 3,
  },
  gaugeThumb: {
    position: 'absolute',
    top: -4,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent,
    marginLeft: -7,
    borderWidth: 2,
    borderColor: colors.bg,
  },
  gaugeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  gaugeLabelText: {
    fontFamily: fonts.regular,
    fontSize: 10,
    color: colors.muted,
  },

  // ── 2. #1 Move Card ──
  moveCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  moveAction: {
    fontFamily: fonts.semibold,
    fontSize: 17,
    color: colors.text,
    lineHeight: 25,
    marginBottom: spacing.sm,
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: 8,
  },
  timelineDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  timelineText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.accent,
  },
  impactRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  impactChip: {
    flexDirection: 'row',
    alignItems: 'baseline',
    backgroundColor: colors.accentDim,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
  },
  impactValue: {
    fontFamily: fonts.heading,
    fontSize: 17,
    color: colors.accent,
  },
  impactUnit: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.accent,
    marginLeft: 2,
  },
  effortChip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  effortLow: {
    backgroundColor: colors.accentDim,
  },
  effortHigh: {
    backgroundColor: colors.coralDim,
  },
  effortText: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.dim,
  },
  effortTextLow: {
    color: colors.accent,
  },
  effortTextHigh: {
    color: colors.coral,
  },
  moveButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  approveButton: {
    flex: 1,
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  approveText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.bg,
  },
  modifyButton: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  modifyText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.accent,
  },
  noDataText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    lineHeight: 22,
  },

  // ── 3. Money Flow ──
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  flowRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  flowLabel: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
  },
  flowValue: {
    fontFamily: fonts.semibold,
    fontSize: 16,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  surplusValue: {
    fontFamily: fonts.heading,
    fontSize: 20,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  sourceChip: {
    backgroundColor: colors.accentDim,
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 14,
  },
  sourceChipText: {
    fontFamily: fonts.medium,
    fontSize: 11,
    color: colors.accent,
  },

  // ── 4. Spending Breakdown ──
  breakdownColumns: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  breakdownCol: {
    flex: 1,
    alignItems: 'center',
  },
  breakdownDivider: {
    width: 1,
    height: 60,
    backgroundColor: colors.border,
    marginHorizontal: spacing.sm,
  },
  breakdownLabel: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.dim,
    marginBottom: spacing.xs,
  },
  breakdownValue: {
    fontFamily: fonts.heading,
    fontSize: 20,
    marginBottom: 2,
  },
  breakdownPct: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.muted,
  },
  barTrack: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    gap: 2,
  },
  barSegment: {
    borderRadius: 3,
  },
  insightText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text2,
    lineHeight: 20,
  },

  // ── 5. Behavioral Insights ──
  patternGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  patternChip: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  patternText: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.text2,
  },

  // ── 6. Goal Tracker ──
  goalCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  goalLabel: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
    marginBottom: 4,
  },
  goalTarget: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginBottom: spacing.md,
  },
  goalTimeline: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  goalTimeBlock: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: radius.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
  },
  goalTimeNumber: {
    fontFamily: fonts.heading,
    fontSize: 26,
    color: colors.text,
    lineHeight: 30,
  },
  goalTimeUnit: {
    fontFamily: fonts.regular,
    fontSize: 10,
    color: colors.dim,
    textAlign: 'center',
    marginTop: 2,
    lineHeight: 14,
  },
  goalArrow: {
    paddingHorizontal: 4,
  },
  goalArrowText: {
    fontFamily: fonts.medium,
    fontSize: 18,
    color: colors.muted,
  },
  goalSavedBlock: {
    flex: 1,
    backgroundColor: colors.accentDim,
    borderRadius: radius.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
  },
  goalSavedNumber: {
    fontFamily: fonts.heading,
    fontSize: 26,
    color: colors.accent,
    lineHeight: 30,
  },
  goalSavedUnit: {
    fontFamily: fonts.regular,
    fontSize: 10,
    color: colors.accent,
    textAlign: 'center',
    marginTop: 2,
    lineHeight: 14,
  },
  goalInsight: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text2,
    lineHeight: 20,
  },

  // ── 7. Upload CTA ──
  uploadButton: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: colors.accent,
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  uploadText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.accent,
  },
});
