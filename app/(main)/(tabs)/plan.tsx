import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, Linking,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis, Move } from '@/lib/types';

export default function Plan() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

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
        <Text style={styles.emptyText}>Run an analysis to see your money moves.</Text>
      </View>
    );
  }

  const moves: Move[] = analysis.all_moves || [];

  return (
    <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scroll}>
      <Text style={styles.heading}>Your money moves</Text>
      <Text style={styles.subheading}>Ranked by annual impact</Text>

      {analysis.surplus != null && (
        <View style={styles.surplusRow}>
          <Text style={styles.surplusLabel}>Monthly surplus</Text>
          <Text style={[styles.surplusValue, { color: analysis.surplus >= 0 ? colors.mint : colors.coral }]}>
            {'\u00a3'}{analysis.surplus}
          </Text>
        </View>
      )}

      {moves.map((move, i) => {
        const isExpanded = expanded === i;
        const effortColor = move.effort === 'low' ? colors.mint : move.effort === 'medium' ? colors.accent : colors.coral;

        return (
          <TouchableOpacity
            key={i}
            style={styles.card}
            onPress={() => setExpanded(isExpanded ? null : i)}
            activeOpacity={0.8}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.moveNumber}>{i + 1}</Text>
              <View style={styles.cardContent}>
                <Text style={styles.moveAction}>{move.action}</Text>
                <View style={styles.moveStats}>
                  <Text style={styles.moveSaving}>
                    {'\u00a3'}{move.monthlyImpact}/month ({'\u00a3'}{move.annualImpact}/year)
                  </Text>
                  <View style={[styles.effortBadge, { borderColor: effortColor }]}>
                    <Text style={[styles.effortText, { color: effortColor }]}>{move.effort}</Text>
                  </View>
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
              </View>
            )}
          </TouchableOpacity>
        );
      })}

      {/* Debt Resources */}
      <Text style={styles.sectionTitle}>NEED HELP WITH DEBT?</Text>
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
  scrollContainer: {
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
    marginBottom: spacing.xs,
  },
  subheading: {
    fontSize: 13,
    color: colors.dim,
    marginBottom: spacing.lg,
  },
  surplusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  surplusLabel: {
    fontSize: 14,
    color: colors.dim,
  },
  surplusValue: {
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: '700',
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
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
  moveSaving: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.mint,
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
    color: colors.mint,
    marginTop: spacing.sm,
    fontStyle: 'italic',
  },
  sectionTitle: {
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
