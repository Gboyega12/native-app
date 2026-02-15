import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { ARCHETYPES } from '@/lib/archetypes';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis, Goals } from '@/lib/types';

export default function Home() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [goals, setGoals] = useState<Goals | null>(null);
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

    const [analysisRes, goalsRes] = await Promise.all([
      supabase
        .from('analyses')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single(),
      supabase
        .from('goals')
        .select('*')
        .eq('user_id', user.id)
        .single(),
    ]);

    setAnalysis(analysisRes.data);
    setGoals(goalsRes.data);
    setLoading(false);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  const archetype = analysis ? ARCHETYPES[analysis.archetype] : null;

  return (
    <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scroll}>
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
          <Text style={styles.emptyTitle}>No analysis yet</Text>
          <Text style={styles.emptyDesc}>
            Connect your bank or upload a CSV to get your personalised financial profile.
          </Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => router.push('/(main)/connect')}
          >
            <Text style={styles.buttonText}>Get started</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Financial Overview */}
          <Text style={styles.sectionTitle}>OVERVIEW</Text>
          <View style={styles.card}>
            <MetricRow label="Income" value={`\u00a3${analysis.monthly_income}`} color={colors.mint} />
            <MetricRow label="Spending" value={`\u00a3${analysis.monthly_spending}`} color={colors.coral} />
            <MetricRow
              label="Surplus"
              value={`\u00a3${analysis.surplus}`}
              color={analysis.surplus >= 0 ? colors.mint : colors.coral}
            />
          </View>

          {/* Archetype */}
          {archetype && (
            <>
              <Text style={styles.sectionTitle}>YOUR TYPE</Text>
              <View style={styles.card}>
                <View style={styles.archetypeRow}>
                  <Text style={styles.archetypeEmoji}>{archetype.emoji}</Text>
                  <Text style={[styles.archetypeName, { color: archetype.color }]}>
                    {archetype.name}
                  </Text>
                </View>
              </View>
            </>
          )}

          {/* Top Move */}
          {analysis.top_move?.action && (
            <>
              <Text style={styles.sectionTitle}>TOP MOVE</Text>
              <View style={[styles.card, styles.accentCard]}>
                <Text style={styles.moveAction}>{analysis.top_move.action}</Text>
                <Text style={styles.moveSaving}>
                  \u00a3{analysis.top_move.monthlyImpact || (analysis.top_move as any).monthlySaving}/month
                </Text>
              </View>
            </>
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

function MetricRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color }]}>{value}</Text>
    </View>
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
  archetypeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  archetypeEmoji: {
    fontSize: 24,
  },
  archetypeName: {
    fontFamily: fonts.mono,
    fontSize: 16,
    fontWeight: '700',
  },
  moveAction: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.text,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  moveSaving: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.mint,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xl,
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
  emptyState: {
    marginTop: spacing.xxl,
    alignItems: 'center',
  },
  emptyTitle: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  emptyDesc: {
    fontSize: 14,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xl,
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
  },
  buttonText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: colors.bg,
    fontWeight: '700',
  },
});
