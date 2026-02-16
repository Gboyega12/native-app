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
  const [completed, setCompleted] = useState<Set<number>>(new Set());

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

  const toggleComplete = (index: number) => {
    setCompleted((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
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
        <Text style={styles.emptyText}>Run an analysis to see your action plan.</Text>
      </View>
    );
  }

  const moves: Move[] = analysis.all_moves || [];
  const completedCount = completed.size;
  const totalMonthly = moves.reduce((s, m) => s + (m.monthlyImpact || 0), 0);
  const unlockedMonthly = moves.reduce((s, m, i) => completed.has(i) ? s + (m.monthlyImpact || 0) : s, 0);
  const progress = moves.length > 0 ? completedCount / moves.length : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      <Text style={styles.heading}>Action Plan</Text>

      {/* Progress summary */}
      <View style={styles.progressCard}>
        <Text style={styles.progressText}>
          {completedCount} of {moves.length} moves completed
        </Text>
        <Text style={styles.progressAmount}>
          {'\u00a3'}{unlockedMonthly} of {'\u00a3'}{totalMonthly}/mo unlocked
        </Text>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      </View>

      {/* Moves */}
      {moves.map((move, i) => {
        const isExpanded = expanded === i;
        const isDone = completed.has(i);

        return (
          <TouchableOpacity
            key={i}
            style={[styles.card, isDone && styles.cardDone]}
            onPress={() => setExpanded(isExpanded ? null : i)}
            activeOpacity={0.8}
          >
            <View style={styles.cardHeader}>
              <Text style={[styles.moveNumber, isDone && styles.doneText]}>{i + 1}</Text>
              <View style={styles.cardContent}>
                <Text style={[styles.moveAction, isDone && styles.doneText]}>{move.action}</Text>
                <View style={styles.moveStats}>
                  <Text style={[styles.moveImpact, isDone && styles.doneText]}>
                    {'\u00a3'}{move.monthlyImpact}/mo
                  </Text>
                  <View style={[styles.effortBadge, { borderColor: effortColor(move.effort) }]}>
                    <Text style={[styles.effortText, { color: effortColor(move.effort) }]}>{move.effort}</Text>
                  </View>
                  <TouchableOpacity
                    style={[styles.checkButton, isDone && styles.checkButtonDone]}
                    onPress={() => toggleComplete(i)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={[styles.checkIcon, isDone && styles.checkIconDone]}>
                      {isDone ? '\u2713' : ' '}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {isExpanded && (
              <View style={styles.expandedSection}>
                <View style={styles.separator} />
                {move.strategy && (
                  <Text style={styles.strategy}>{move.strategy}</Text>
                )}
                {move.steps?.map((step, j) => (
                  <Text key={j} style={styles.step}>{j + 1}. {step}</Text>
                ))}
                {move.effect && (
                  <Text style={styles.effect}>{move.effect}</Text>
                )}
                <TouchableOpacity
                  style={isDone ? styles.undoButton : styles.markDoneButton}
                  onPress={() => toggleComplete(i)}
                >
                  <Text style={isDone ? styles.undoButtonText : styles.markDoneText}>
                    {isDone ? 'Mark as not done' : 'Mark as done'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </TouchableOpacity>
        );
      })}

      {/* Debt Resources */}
      <Text style={styles.sectionLabel}>NEED HELP WITH DEBT?</Text>
      <View style={styles.card}>
        <TouchableOpacity onPress={() => Linking.openURL('https://www.stepchange.org')}>
          <Text style={styles.resourceLink}>StepChange - Free debt advice</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openURL('https://www.citizensadvice.org.uk/debt-and-money')}>
          <Text style={styles.resourceLink}>Citizens Advice - Debt guidance</Text>
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
    padding: spacing.xl,
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
  emptyText: {
    fontSize: 14,
    color: colors.dim,
    textAlign: 'center',
  },
  heading: {
    fontFamily: fonts.mono,
    fontSize: 22,
    color: colors.text,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  progressCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  progressText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.text2,
    marginBottom: spacing.xs,
  },
  progressAmount: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.accent,
    marginBottom: spacing.sm,
  },
  progressBar: {
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.accent,
    borderRadius: 2,
    minWidth: 2,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardDone: {
    opacity: 0.5,
  },
  cardHeader: {
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
  cardContent: {
    flex: 1,
  },
  moveAction: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.text,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  moveStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  moveImpact: {
    fontFamily: fonts.mono,
    fontSize: 12,
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
  doneText: {
    color: colors.muted,
    textDecorationLine: 'line-through',
  },
  checkButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.muted,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  checkButtonDone: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDim,
  },
  checkIcon: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.muted,
  },
  checkIconDone: {
    color: colors.accent,
  },
  expandedSection: {
    marginTop: spacing.sm,
    paddingLeft: 24,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginBottom: spacing.sm,
  },
  strategy: {
    fontSize: 13,
    color: colors.text2,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  step: {
    fontSize: 13,
    color: colors.dim,
    lineHeight: 20,
  },
  effect: {
    fontSize: 12,
    color: colors.accent,
    marginTop: spacing.sm,
    fontStyle: 'italic',
  },
  markDoneButton: {
    borderWidth: 1,
    borderColor: colors.accent,
    paddingVertical: 10,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  markDoneText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.accent,
  },
  undoButton: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  undoButtonText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    marginBottom: spacing.sm,
    marginTop: spacing.xl,
  },
  resourceLink: {
    fontSize: 14,
    color: colors.sky,
    paddingVertical: spacing.xs,
    textDecorationLine: 'underline',
  },
});
