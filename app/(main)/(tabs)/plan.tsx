import { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Linking,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis, Move } from '@/lib/types';

function effortColor(effort: string) {
  return effort === 'low' ? colors.accent : effort === 'medium' ? colors.sky : colors.coral;
}

export default function Plan() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [approved, setApproved] = useState<Set<number>>(new Set());

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const loadData = async () => {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

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

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (!analysis) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle}>No action plan yet</Text>
        <Text style={styles.emptyText}>Complete an analysis to see your personalised recommendations.</Text>
      </View>
    );
  }

  const moves: Move[] = analysis.all_moves || [];
  const approvedCount = approved.size;
  const totalMonthly = moves.reduce((s, m) => s + (m.monthlyImpact || 0), 0);
  const approvedMonthly = moves.reduce((s, m, i) => approved.has(i) ? s + (m.monthlyImpact || 0) : s, 0);
  const progress = moves.length > 0 ? approvedCount / moves.length : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <Text style={styles.heading}>Action Plan</Text>
      <Text style={styles.headingSub}>
        {moves.length} recommendation{moves.length !== 1 ? 's' : ''} based on your transaction data
      </Text>

      {/* Progress summary */}
      <View style={styles.progressCard}>
        <View style={styles.progressRow}>
          <View>
            <Text style={styles.progressLabel}>Approved</Text>
            <Text style={styles.progressCount}>{approvedCount} of {moves.length}</Text>
          </View>
          <View style={styles.progressRight}>
            <Text style={styles.progressLabel}>Monthly impact</Text>
            <Text style={styles.progressAmount}>
              {'\u00a3'}{Math.round(approvedMonthly)} of {'\u00a3'}{Math.round(totalMonthly)}
            </Text>
          </View>
        </View>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      </View>

      {/* Moves */}
      {moves.map((move, i) => {
        const isExpanded = expanded === i;
        const isApproved = approved.has(i);

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

                {move.steps && move.steps.length > 0 && (
                  <View style={styles.detailBlock}>
                    <Text style={styles.detailLabel}>Steps to execute</Text>
                    {move.steps.map((step, j) => (
                      <View key={j} style={styles.stepRow}>
                        <Text style={styles.stepNumber}>{j + 1}</Text>
                        <Text style={styles.stepText}>{step}</Text>
                      </View>
                    ))}
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
                        <Text style={styles.approveBtnText}>Approve</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.modifyBtn}>
                        <Text style={styles.modifyBtnText}>Modify</Text>
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
  stepRow: {
    flexDirection: 'row',
    marginBottom: spacing.xs,
  },
  stepNumber: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.accent,
    width: 20,
  },
  stepText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
    flex: 1,
    lineHeight: 22,
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
  actionButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
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
