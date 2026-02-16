import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { getLastResult } from './processing';
import { ARCHETYPES } from '@/lib/archetypes';
import { colors, fonts, spacing, radius } from '@/theme';
import ErrorBoundary from '@/components/ErrorBoundary';

function effortColor(effort: string) {
  return effort === 'low' ? colors.accent : effort === 'medium' ? colors.sky : colors.coral;
}

function ResultsInner() {
  const router = useRouter();
  const result = getLastResult() as any;

  if (!result) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No analysis data found.</Text>
        <TouchableOpacity style={styles.ctaButton} onPress={() => router.replace('/(main)/connect')}>
          <Text style={styles.ctaText}>Run an analysis</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const archetype = result._archetype || ARCHETYPES[result.archetype] || {};
  const score = result._decisionScore || { score: result.decision_score, verdict: 'Balanced' };
  const topMove = result.top_move;
  const allMoves = result.all_moves || [];
  const goalCtx = result.goal_context;

  const scoreColor = score.score >= 75 ? colors.accent
    : score.score >= 55 ? colors.sky
    : colors.coral;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      {/* Header with score reveal */}
      <Text style={styles.header}>Analysis complete</Text>
      <View style={styles.scoreCard}>
        <View style={styles.scoreRow}>
          <Text style={[styles.scoreBig, { color: scoreColor }]}>{score.score}</Text>
          <View>
            <Text style={[styles.scoreVerdict, { color: scoreColor }]}>{score.verdict}</Text>
            <Text style={styles.scoreSubtext}>Decision Score</Text>
          </View>
        </View>
      </View>

      {/* Hero: Top Move */}
      {topMove?.action && (
        <>
          <Text style={styles.sectionLabel}>YOUR #1 MOVE</Text>
          <View style={styles.heroCard}>
            <Text style={styles.heroAction}>{topMove.action}</Text>
            <View style={styles.impactRow}>
              <Text style={styles.heroImpact}>
                {'\u00a3'}{topMove.monthlyImpact || topMove.monthlySaving}/mo
              </Text>
              <Text style={styles.heroAnnual}>
                {'\u00a3'}{topMove.annualImpact || ((topMove.monthlyImpact || 0) * 12)}/yr
              </Text>
              <EffortBadge effort={topMove.effort} />
            </View>
            {topMove.strategy && (
              <Text style={styles.strategy}>{topMove.strategy}</Text>
            )}
            {topMove.steps?.map((step: string, i: number) => (
              <Text key={i} style={styles.step}>{i + 1}. {step}</Text>
            ))}
          </View>
        </>
      )}

      {/* Goal Trajectory */}
      {goalCtx && goalCtx.goalLabel && (
        <>
          <Text style={styles.sectionLabel}>GOAL TRAJECTORY</Text>
          <View style={styles.card}>
            <Text style={styles.goalLabel}>{goalCtx.goalLabel}</Text>
            {goalCtx.targetAmount > 0 && (
              <Text style={styles.goalTarget}>Target: {'\u00a3'}{goalCtx.targetAmount}</Text>
            )}
            <Text style={styles.goalInsight}>{goalCtx.insight}</Text>
          </View>
        </>
      )}

      {/* Financial Snapshot */}
      <Text style={styles.sectionLabel}>FINANCIAL SNAPSHOT</Text>
      <View style={styles.card}>
        <MetricRow label="Income" value={`\u00a3${result.monthly_income}`} color={colors.accent} />
        <MetricRow label="Spending" value={`\u00a3${result.monthly_spending}`} color={colors.coral} />
        <MetricRow
          label="Surplus"
          value={`\u00a3${result.surplus}`}
          color={result.surplus >= 0 ? colors.accent : colors.coral}
        />
      </View>

      {/* All Moves */}
      {allMoves.length > 1 && (
        <>
          <Text style={styles.sectionLabel}>ALL MOVES ({allMoves.length})</Text>
          {allMoves.slice(1).map((move: any, i: number) => (
            <View key={i} style={styles.card}>
              <View style={styles.moveHeader}>
                <Text style={styles.moveNumber}>{i + 2}</Text>
                <View style={styles.moveContent}>
                  <Text style={styles.moveAction}>{move.action}</Text>
                  <View style={styles.impactRow}>
                    <Text style={styles.moveImpact}>
                      {'\u00a3'}{move.monthlyImpact || move.monthlySaving}/mo
                    </Text>
                    <EffortBadge effort={move.effort} />
                  </View>
                </View>
              </View>
            </View>
          ))}
        </>
      )}

      {/* Profile: Archetype */}
      <Text style={styles.sectionLabel}>YOUR PROFILE</Text>
      <View style={styles.card}>
        <Text style={[styles.archetypeName, { color: archetype.color || colors.accent }]}>
          {archetype.name}
        </Text>
        <Text style={styles.archetypeDesc}>{archetype.description}</Text>
      </View>

      {/* Navigation */}
      <View style={styles.navRow}>
        <TouchableOpacity
          style={styles.ctaButton}
          onPress={() => router.replace('/(main)/(tabs)')}
        >
          <Text style={styles.ctaText}>Go to dashboard</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => router.replace('/(main)/connect')}
        >
          <Text style={styles.secondaryText}>Run new analysis</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function MetricRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color }]}>{value}</Text>
    </View>
  );
}

function EffortBadge({ effort }: { effort: string }) {
  const color = effortColor(effort);
  return (
    <View style={[styles.effortBadge, { borderColor: color }]}>
      <Text style={[styles.effortText, { color }]}>{effort}</Text>
    </View>
  );
}

export default function Results() {
  return (
    <ErrorBoundary fallbackMessage="Could not display results. Please run a new analysis.">
      <ResultsInner />
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: spacing.xl,
    paddingTop: spacing.xxl + spacing.lg,
    paddingBottom: spacing.xxl,
  },
  emptyContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  emptyText: {
    fontSize: 14,
    color: colors.dim,
    marginBottom: spacing.lg,
  },
  header: {
    fontFamily: fonts.mono,
    fontSize: 22,
    color: colors.text,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  scoreCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  scoreBig: {
    fontFamily: fonts.mono,
    fontSize: 48,
    fontWeight: '700',
  },
  scoreVerdict: {
    fontFamily: fonts.mono,
    fontSize: 16,
    fontWeight: '700',
  },
  scoreSubtext: {
    fontSize: 12,
    color: colors.dim,
    marginTop: 2,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
  },
  heroCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  heroAction: {
    fontFamily: fonts.mono,
    fontSize: 17,
    color: colors.text,
    fontWeight: '700',
    lineHeight: 24,
    marginBottom: spacing.sm,
  },
  impactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  heroImpact: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: colors.accent,
    fontWeight: '700',
  },
  heroAnnual: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
  },
  strategy: {
    fontSize: 13,
    color: colors.text2,
    lineHeight: 20,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  step: {
    fontSize: 13,
    color: colors.dim,
    lineHeight: 20,
    paddingLeft: spacing.sm,
  },
  goalLabel: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: colors.text,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  goalTarget: {
    fontSize: 13,
    color: colors.dim,
    marginBottom: spacing.sm,
  },
  goalInsight: {
    fontSize: 13,
    color: colors.accent,
    lineHeight: 20,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  metricLabel: {
    fontSize: 14,
    color: colors.dim,
  },
  metricValue: {
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: '700',
  },
  moveHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  moveNumber: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.accent,
    fontWeight: '700',
    width: 24,
    marginTop: 2,
  },
  moveContent: {
    flex: 1,
  },
  moveAction: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.text,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  moveImpact: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.accent,
  },
  effortBadge: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  effortText: {
    fontSize: 10,
    fontFamily: fonts.mono,
  },
  archetypeName: {
    fontFamily: fonts.mono,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  archetypeDesc: {
    fontSize: 13,
    color: colors.text2,
    lineHeight: 20,
  },
  navRow: {
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  ctaButton: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  ctaText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: colors.bg,
    fontWeight: '700',
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  secondaryText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: colors.text,
  },
});
