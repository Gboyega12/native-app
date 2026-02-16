import { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { ARCHETYPES } from '@/lib/archetypes';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis } from '@/lib/types';

function effortColor(effort: string) {
  return effort === 'low' ? colors.accent : effort === 'medium' ? colors.sky : colors.coral;
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

  const topMove = analysis?.top_move;
  const archetype = analysis ? ARCHETYPES[analysis.archetype] : null;
  const score = analysis?.decision_score ?? 0;
  const scoreColor = score >= 75 ? colors.accent : score >= 55 ? colors.sky : colors.coral;
  const scoreVerdict = score >= 75 ? 'Strong' : score >= 55 ? 'Balanced' : score >= 35 ? 'Needs Attention' : 'At Risk';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      {/* Header */}
      <View style={styles.headerRow}>
        <Text style={styles.greeting}>
          {userName ? `Hey, ${userName}` : 'Welcome back'}
        </Text>
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
          <Text style={styles.emptyBrand}>{'{ B }'}</Text>
          <Text style={styles.emptyTitle}>Discover your #1 move</Text>
          <Text style={styles.emptyDesc}>
            Connect your bank to identify the most material financial move available to you right now.
          </Text>
          <TouchableOpacity
            style={styles.ctaButton}
            onPress={() => router.push('/(main)/connect')}
          >
            <Text style={styles.ctaText}>Get started</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Hero: Top Move */}
          {topMove?.action && (
            <>
              <Text style={styles.sectionLabel}>YOUR #1 MOVE</Text>
              <View style={styles.heroCard}>
                <Text style={styles.heroAction}>{topMove.action}</Text>
                <View style={styles.heroImpactRow}>
                  <Text style={styles.heroImpact}>
                    {'\u00a3'}{topMove.monthlyImpact || (topMove as any).monthlySaving}/mo
                  </Text>
                  <Text style={styles.heroAnnual}>
                    {'\u00a3'}{topMove.annualImpact || ((topMove.monthlyImpact || 0) * 12)}/yr
                  </Text>
                  {topMove.effort && (
                    <View style={[styles.effortBadge, { borderColor: effortColor(topMove.effort) }]}>
                      <Text style={[styles.effortText, { color: effortColor(topMove.effort) }]}>
                        {topMove.effort}
                      </Text>
                    </View>
                  )}
                </View>
                <TouchableOpacity
                  style={styles.ctaButton}
                  onPress={() => router.push('/(main)/(tabs)/plan')}
                >
                  <Text style={styles.ctaText}>Start this move</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* Decision Score */}
          <View style={styles.card}>
            <View style={styles.scoreRow}>
              <Text style={styles.scoreLabel}>Decision Score</Text>
              <View style={styles.scoreRight}>
                <Text style={[styles.scoreValue, { color: scoreColor }]}>{score}</Text>
                <Text style={styles.scoreMax}>/100</Text>
                <Text style={[styles.scoreVerdict, { color: scoreColor }]}>{scoreVerdict}</Text>
              </View>
            </View>
          </View>

          {/* Surplus */}
          <View style={styles.card}>
            <View style={styles.metricRow}>
              <Text style={styles.metricLabel}>Monthly surplus</Text>
              <Text style={[styles.metricValue, { color: analysis.surplus >= 0 ? colors.accent : colors.coral }]}>
                {'\u00a3'}{analysis.surplus}
              </Text>
            </View>
          </View>

          {/* Archetype */}
          {archetype && (
            <View style={styles.card}>
              <View style={styles.metricRow}>
                <Text style={styles.metricLabel}>Financial type</Text>
                <Text style={[styles.archetypeValue, { color: archetype.color }]}>
                  {archetype.name}
                </Text>
              </View>
            </View>
          )}

          {/* Quick Actions */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => router.push('/(main)/connect')}
            >
              <Text style={styles.actionText}>New analysis</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => router.push('/(main)/history')}
            >
              <Text style={styles.actionText}>History</Text>
            </TouchableOpacity>
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
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  greeting: {
    fontFamily: fonts.mono,
    fontSize: 22,
    color: colors.text,
    fontWeight: '700',
  },
  profileButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileInitials: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.bg,
    fontWeight: '700',
  },
  emptyState: {
    marginTop: spacing.xxl,
    alignItems: 'center',
  },
  emptyBrand: {
    fontFamily: fonts.mono,
    fontSize: 32,
    color: colors.accent,
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontFamily: fonts.mono,
    fontSize: 20,
    color: colors.text,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  emptyDesc: {
    fontSize: 14,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  heroCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  heroAction: {
    fontFamily: fonts.mono,
    fontSize: 17,
    color: colors.text,
    fontWeight: '700',
    lineHeight: 24,
    marginBottom: spacing.sm,
  },
  heroImpactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  heroImpact: {
    fontFamily: fonts.mono,
    fontSize: 20,
    color: colors.accent,
    fontWeight: '700',
  },
  heroAnnual: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
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
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  scoreRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  scoreLabel: {
    fontSize: 14,
    color: colors.dim,
  },
  scoreRight: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
  },
  scoreValue: {
    fontFamily: fonts.mono,
    fontSize: 20,
    fontWeight: '700',
  },
  scoreMax: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.muted,
  },
  scoreVerdict: {
    fontFamily: fonts.mono,
    fontSize: 12,
    marginLeft: spacing.xs,
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metricLabel: {
    fontSize: 14,
    color: colors.dim,
  },
  metricValue: {
    fontFamily: fonts.mono,
    fontSize: 16,
    fontWeight: '700',
  },
  archetypeValue: {
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  actionButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  actionText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.text,
  },
});
