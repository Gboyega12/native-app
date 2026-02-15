import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { getLastResult } from './processing';
import { ARCHETYPES } from '@/lib/archetypes';
import { colors, fonts, spacing, radius } from '@/theme';
import ErrorBoundary from '@/components/ErrorBoundary';

function ResultsInner() {
  const router = useRouter();
  const result = getLastResult() as any;

  if (!result) {
    return (
      <View style={styles.container}>
        <Text style={styles.emptyText}>No analysis data found.</Text>
        <TouchableOpacity style={styles.button} onPress={() => router.replace('/(main)/connect')}>
          <Text style={styles.buttonText}>Run an analysis</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const archetype = result._archetype || ARCHETYPES[result.archetype] || {};
  const score = result._decisionScore || { score: result.decision_score, verdict: 'Balanced', breakdown: [] };
  const topMove = result.top_move;
  const allMoves = result.all_moves || [];
  const goalCtx = result.goal_context;

  const verdictColor = score.score >= 75 ? colors.mint
    : score.score >= 55 ? colors.accent
    : score.score >= 35 ? colors.coral
    : colors.coral;

  return (
    <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scroll}>
      {/* Financial Overview */}
      <Text style={styles.sectionTitle}>FINANCIAL OVERVIEW</Text>
      <View style={styles.card}>
        <MetricRow label="Monthly income" value={`\u00a3${result.monthly_income}`} color={colors.mint} />
        <MetricRow label="Monthly spending" value={`\u00a3${result.monthly_spending}`} color={colors.coral} />
        <MetricRow
          label="Monthly surplus"
          value={`\u00a3${result.surplus}`}
          color={result.surplus >= 0 ? colors.mint : colors.coral}
        />
      </View>

      {/* Budget Breakdown */}
      <Text style={styles.sectionTitle}>BUDGET BREAKDOWN</Text>
      <View style={styles.card}>
        <MetricRow
          label="Non-discretionary"
          value={`\u00a3${Math.round(result.non_discretionary?.total || 0)}`}
          color={colors.text2}
        />
        <MetricRow
          label="Discretionary"
          value={`\u00a3${Math.round(result.discretionary?.total || 0)}`}
          color={colors.text2}
        />
      </View>

      {/* Top Move */}
      {topMove?.action && (
        <>
          <Text style={styles.sectionTitle}>TOP MONEY MOVE</Text>
          <View style={[styles.card, styles.accentCard]}>
            <Text style={styles.moveAction}>{topMove.action}</Text>
            <View style={styles.moveStats}>
              <Text style={styles.moveSaving}>
                \u00a3{topMove.monthlyImpact || topMove.monthlySaving}/month
              </Text>
              <EffortBadge effort={topMove.effort} />
            </View>
            {topMove.strategy && (
              <Text style={styles.moveStrategy}>{topMove.strategy}</Text>
            )}
            {topMove.steps?.map((step: string, i: number) => (
              <Text key={i} style={styles.moveStep}>{i + 1}. {step}</Text>
            ))}
          </View>
        </>
      )}

      {/* Goal Trajectory */}
      {goalCtx && goalCtx.goalLabel && (
        <>
          <Text style={styles.sectionTitle}>GOAL TRAJECTORY</Text>
          <View style={styles.card}>
            <Text style={styles.goalLabel}>{goalCtx.goalLabel}</Text>
            {goalCtx.targetAmount > 0 && (
              <Text style={styles.goalTarget}>Target: \u00a3{goalCtx.targetAmount}</Text>
            )}
            <Text style={styles.goalInsight}>{goalCtx.insight}</Text>
          </View>
        </>
      )}

      {/* Additional Moves */}
      {allMoves.length > 1 && (
        <>
          <Text style={styles.sectionTitle}>MORE MOVES</Text>
          {allMoves.slice(1).map((move: any, i: number) => (
            <View key={i} style={styles.card}>
              <Text style={styles.moveActionSmall}>{move.action}</Text>
              <View style={styles.moveStats}>
                <Text style={styles.moveSavingSmall}>
                  \u00a3{move.monthlyImpact || move.monthlySaving}/month
                </Text>
                <EffortBadge effort={move.effort} />
              </View>
            </View>
          ))}
        </>
      )}

      {/* Archetype */}
      <Text style={styles.sectionTitle}>YOUR FINANCIAL ARCHETYPE</Text>
      <View style={styles.card}>
        <Text style={styles.archetypeEmoji}>{archetype.emoji}</Text>
        <Text style={[styles.archetypeName, { color: archetype.color || colors.accent }]}>
          {archetype.name}
        </Text>
        <Text style={styles.archetypeDesc}>{archetype.description}</Text>
      </View>

      {/* Decision Score */}
      <Text style={styles.sectionTitle}>DECISION SCORE</Text>
      <View style={styles.card}>
        <Text style={[styles.scoreNumber, { color: verdictColor }]}>{score.score}</Text>
        <Text style={[styles.scoreVerdict, { color: verdictColor }]}>{score.verdict}</Text>
      </View>

      {/* Navigation */}
      <View style={styles.navRow}>
        <TouchableOpacity
          style={styles.button}
          onPress={() => router.replace('/(main)/(tabs)')}
        >
          <Text style={styles.buttonText}>Go to dashboard</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => router.replace('/(main)/connect')}
        >
          <Text style={styles.secondaryButtonText}>Run new analysis</Text>
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
  const effortColor = effort === 'low' ? colors.mint : effort === 'medium' ? colors.accent : colors.coral;
  return (
    <View style={[styles.effortBadge, { borderColor: effortColor }]}>
      <Text style={[styles.effortText, { color: effortColor }]}>{effort}</Text>
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
  scrollContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: spacing.xl,
    paddingTop: spacing.xxl + spacing.lg,
    paddingBottom: spacing.xxl,
  },
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  sectionTitle: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    marginBottom: spacing.sm,
    marginTop: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  accentCard: {
    borderColor: colors.accentDim,
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
  moveAction: {
    fontFamily: fonts.mono,
    fontSize: 16,
    color: colors.text,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  moveStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  moveSaving: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.mint,
    fontWeight: '700',
  },
  moveStrategy: {
    fontSize: 13,
    color: colors.text2,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  moveStep: {
    fontSize: 13,
    color: colors.dim,
    lineHeight: 20,
    paddingLeft: spacing.sm,
  },
  moveActionSmall: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.text,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  moveSavingSmall: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.mint,
  },
  effortBadge: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  effortText: {
    fontSize: 11,
    fontFamily: fonts.mono,
  },
  archetypeEmoji: {
    fontSize: 36,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  archetypeName: {
    fontFamily: fonts.mono,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  archetypeDesc: {
    fontSize: 13,
    color: colors.text2,
    textAlign: 'center',
    lineHeight: 20,
  },
  scoreNumber: {
    fontFamily: fonts.mono,
    fontSize: 48,
    fontWeight: '700',
    textAlign: 'center',
  },
  scoreVerdict: {
    fontFamily: fonts.mono,
    fontSize: 14,
    textAlign: 'center',
    marginTop: spacing.xs,
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
    color: colors.text2,
    lineHeight: 20,
  },
  navRow: {
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  buttonText: {
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
  secondaryButtonText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: colors.text,
  },
  emptyText: {
    fontSize: 14,
    color: colors.dim,
    marginBottom: spacing.lg,
  },
});
