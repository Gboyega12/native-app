import { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis } from '@/lib/types';

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

  const topMove = analysis?.top_move;
  const income = analysis?.monthly_income ?? 0;
  const spending = analysis?.monthly_spending ?? 0;
  const surplus = analysis?.surplus ?? 0;
  const nonDisc = analysis?.non_discretionary ?? 0;
  const disc = analysis?.discretionary ?? 0;
  const totalExpense = nonDisc + disc || spending;
  const nonDiscPct = totalExpense > 0 ? Math.round((nonDisc / totalExpense) * 100) : 0;
  const discPct = totalExpense > 0 ? Math.round((disc / totalExpense) * 100) : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>
            {userName ? `${userName}` : 'Welcome'}
          </Text>
          <Text style={styles.greetingSub}>Here's your financial overview</Text>
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
          {/* Card 1: Insight — #1 Move */}
          <Text style={styles.sectionLabel}>YOUR #1 MOVE</Text>
          <View style={styles.insightCard}>
            {topMove?.action ? (
              <>
                <Text style={styles.insightAction}>{topMove.action}</Text>
                <View style={styles.insightImpactRow}>
                  <View style={styles.impactChip}>
                    <Text style={styles.impactValue}>
                      {'\u00a3'}{topMove.monthlyImpact || (topMove as any).monthlySaving || 0}
                    </Text>
                    <Text style={styles.impactLabel}>/month</Text>
                  </View>
                  <View style={styles.impactChip}>
                    <Text style={styles.impactValue}>
                      {'\u00a3'}{topMove.annualImpact || ((topMove.monthlyImpact || 0) * 12)}
                    </Text>
                    <Text style={styles.impactLabel}>/year</Text>
                  </View>
                </View>
                <View style={styles.insightButtons}>
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
              <Text style={styles.noMoveText}>No actionable move identified yet. Connect more accounts for deeper analysis.</Text>
            )}
          </View>

          {/* Card 2: Income */}
          <Text style={styles.sectionLabel}>INCOME</Text>
          <View style={styles.card}>
            <View style={styles.metricRow}>
              <Text style={styles.metricLabel}>Monthly income</Text>
              <Text style={[styles.metricValue, { color: colors.accent }]}>
                {'\u00a3'}{Math.round(income).toLocaleString()}
              </Text>
            </View>
            <View style={styles.metricRow}>
              <Text style={styles.metricLabel}>Monthly spending</Text>
              <Text style={[styles.metricValue, { color: colors.coral }]}>
                {'\u00a3'}{Math.round(spending).toLocaleString()}
              </Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.metricRow}>
              <Text style={styles.metricLabel}>Surplus</Text>
              <Text style={[styles.metricValueBig, { color: surplus >= 0 ? colors.accent : colors.coral }]}>
                {surplus >= 0 ? '+' : ''}{'\u00a3'}{Math.round(surplus).toLocaleString()}
              </Text>
            </View>
            {analysis.income_sources && analysis.income_sources.length > 0 && (
              <View style={styles.sourcesRow}>
                {analysis.income_sources.map((src: any, i: number) => (
                  <View key={i} style={styles.sourceChip}>
                    <Text style={styles.sourceText}>
                      {typeof src === 'string' ? src : src.name || src.source || 'Income'}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Card 3: Budget Reality — Non-negotiable vs Negotiable */}
          <Text style={styles.sectionLabel}>BUDGET REALITY</Text>
          <View style={styles.card}>
            <View style={styles.budgetRow}>
              <View style={styles.budgetItem}>
                <Text style={styles.budgetLabel}>Non-negotiable</Text>
                <Text style={[styles.budgetValue, { color: colors.coral }]}>
                  {'\u00a3'}{Math.round(nonDisc).toLocaleString()}
                </Text>
                <Text style={styles.budgetPct}>{nonDiscPct}% of spending</Text>
              </View>
              <View style={styles.budgetDivider} />
              <View style={styles.budgetItem}>
                <Text style={styles.budgetLabel}>Negotiable</Text>
                <Text style={[styles.budgetValue, { color: colors.sky }]}>
                  {'\u00a3'}{Math.round(disc).toLocaleString()}
                </Text>
                <Text style={styles.budgetPct}>{discPct}% of spending</Text>
              </View>
            </View>
            <View style={styles.barContainer}>
              <View style={[styles.barSegment, { flex: nonDiscPct || 1, backgroundColor: colors.coral }]} />
              <View style={[styles.barSegment, { flex: discPct || 1, backgroundColor: colors.sky }]} />
            </View>
            <Text style={styles.budgetInsight}>
              {nonDiscPct > 60
                ? `${nonDiscPct}% of your spending is fixed. Focus on negotiable expenses for quick wins.`
                : discPct > 50
                  ? `${discPct}% of your spending is negotiable \u2014 significant room to optimise.`
                  : 'Your fixed and flexible spending is relatively balanced.'}
            </Text>
          </View>
        </>
      )}
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
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileInitials: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
  },
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
  sectionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  insightCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  insightAction: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: colors.text,
    lineHeight: 26,
    marginBottom: spacing.md,
  },
  insightImpactRow: {
    flexDirection: 'row',
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
    fontSize: 18,
    color: colors.accent,
  },
  impactLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.accent,
    marginLeft: 2,
  },
  insightButtons: {
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
  noMoveText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    lineHeight: 22,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  metricLabel: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
  },
  metricValue: {
    fontFamily: fonts.semibold,
    fontSize: 16,
  },
  metricValueBig: {
    fontFamily: fonts.heading,
    fontSize: 20,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  sourcesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  sourceChip: {
    backgroundColor: colors.accentDim,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  sourceText: {
    fontFamily: fonts.medium,
    fontSize: 11,
    color: colors.accent,
  },
  budgetRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  budgetItem: {
    flex: 1,
    alignItems: 'center',
  },
  budgetDivider: {
    width: 1,
    height: 60,
    backgroundColor: colors.border,
    marginHorizontal: spacing.sm,
  },
  budgetLabel: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.dim,
    marginBottom: spacing.xs,
  },
  budgetValue: {
    fontFamily: fonts.heading,
    fontSize: 20,
    marginBottom: 2,
  },
  budgetPct: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.muted,
  },
  barContainer: {
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
  budgetInsight: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text2,
    lineHeight: 20,
  },
});
