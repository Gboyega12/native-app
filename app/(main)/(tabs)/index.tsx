import { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
  LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getLastResult } from '@/app/(main)/processing';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { rankMoves, determineFlowchartPosition, calcGoalTrajectory } from '@/lib/move-engine';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis, BudgetCategory, TransactionDetail, IncomeSource, Move, Goals } from '@/lib/types';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Extended palette matching the BOCY design
const gold = '#E8C55A';
const goldSoft = 'rgba(232, 197, 90, 0.15)';

export default function Home() {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedMoves, setExpandedMoves] = useState<Set<number>>(new Set());

  const toggleCategory = (key: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleMove = (idx: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedMoves((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

  const isCurrentMonth = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  };

  const [syncing, setSyncing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const loadData = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }

      setUserName(user.user_metadata?.full_name?.split(' ')[0] || '');

      // Use the latest in-memory result from processing if available.
      const lastResult = getLastResult();
      if (lastResult) {
        setAnalysis(lastResult);
        setLoading(false);
        // Still trigger background sync for fresh data
        syncInBackground(user.id);
        return;
      }

      const { data, error } = await supabase
        .from('analyses')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        console.warn('[home] Failed to fetch analysis:', error.message);
      }

      setAnalysis(data || null);

      // Trigger background sync if user has an existing analysis
      if (data) {
        syncInBackground(user.id);
      }
    } catch (err: any) {
      console.warn('[home] loadData error:', err?.message);
      setAnalysis(null);
    }
    setLoading(false);
  };

  // Background sync: refresh bank data via TrueLayer and re-run analysis
  const syncInBackground = async (userId: string) => {
    try {
      setSyncing(true);
      const res = await fetch('/api/truelayer/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
      const data = await res.json();

      if (!data.success || !data.csv_data) {
        // No TrueLayer connection, token expired, or no new data — silent fail
        setSyncing(false);
        return;
      }

      // Fetch user's transaction overrides
      let overrides: any[] = [];
      try {
        const { data: overrideData } = await supabase
          .from('transaction_overrides')
          .select('match_description, category, is_essential')
          .eq('user_id', userId);
        if (overrideData) overrides = overrideData;
      } catch {}

      // Re-run enrichment engine with fresh data (fast, ~1 second)
      const result = EnrichmentEngine.enrich(data.csv_data, overrides);
      if (result.enrichedTransactions.length === 0) {
        setSyncing(false);
        return;
      }

      // Fetch goals for move ranking
      let goals: Goals | null = null;
      const { data: goalsData } = await supabase
        .from('goals')
        .select('*')
        .eq('user_id', userId)
        .single();
      goals = goalsData;

      // Run move engine
      const ukpf = determineFlowchartPosition(result.profile, goals);
      const rankedMoves = rankMoves(result.decisionStack, result.profile, goals);
      const topRanked = rankedMoves[0] || null;
      const goalTrajectory = topRanked ? topRanked.trajectory : null;

      const allMoves = rankedMoves;
      const topMove = allMoves[0] || null;

      const updatedAnalysis: Analysis = {
        user_id: userId,
        archetype: result.archetype.key,
        decision_score: result.decisionScore.score,
        monthly_income: Math.round(result.profile.monthly.income),
        monthly_spending: Math.round(result.profile.monthly.spending),
        surplus: Math.round(result.profile.monthly.surplus),
        non_discretionary: result.profile.budgetReality.nonDiscretionary,
        discretionary: result.profile.budgetReality.discretionary,
        income_sources: result.profile.incomeSources,
        top_move: topMove || ({} as any),
        all_moves: allMoves,
        behavioral_patterns: result.behavioralPatterns,
        goal_context: goalTrajectory,
      };

      // Save to Supabase
      await supabase.from('analyses').insert({
        user_id: userId,
        archetype: updatedAnalysis.archetype,
        decision_score: updatedAnalysis.decision_score,
        monthly_income: updatedAnalysis.monthly_income,
        monthly_spending: updatedAnalysis.monthly_spending,
        surplus: updatedAnalysis.surplus,
        non_discretionary: updatedAnalysis.non_discretionary,
        discretionary: updatedAnalysis.discretionary,
        income_sources: updatedAnalysis.income_sources,
        top_move: updatedAnalysis.top_move,
        all_moves: updatedAnalysis.all_moves,
        behavioral_patterns: updatedAnalysis.behavioral_patterns,
        goal_context: updatedAnalysis.goal_context,
      });

      // Update dashboard
      setAnalysis(updatedAnalysis);
    } catch (err: any) {
      console.warn('[home] Background sync failed:', err?.message);
    }
    setSyncing(false);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  // ── Derived data ──
  const moves = analysis?.all_moves ?? [];
  const income = analysis?.monthly_income ?? 0;
  const incomeSources = analysis?.income_sources ?? [];

  // Only show high + medium effort moves on dashboard; low effort → plan page only
  // Sort: high effort first, then medium
  const highEffortMoves = moves.filter((m: Move) => m.effort === 'high');
  const mediumEffortMoves = moves.filter((m: Move) => m.effort === 'medium');
  const dashboardMoves = [...highEffortMoves, ...mediumEffortMoves];

  // Primary income source only
  const primaryIncome = incomeSources.find((s: IncomeSource) => s.isSalary)
    || (incomeSources.length > 0
      ? incomeSources.reduce((a, b) => a.avgAmount > b.avgAmount ? a : b)
      : null);

  const nonDisc = analysis?.non_discretionary as any;
  const disc = analysis?.discretionary as any;
  const nonDiscTotal = nonDisc?.total ?? 0;
  const discTotal = disc?.total ?? 0;
  const nonDiscItems: BudgetCategory[] = nonDisc?.items ?? [];
  const discItems: BudgetCategory[] = disc?.items ?? [];
  const leftToDecide = Math.max(0, income - nonDiscTotal - discTotal);

  // Bar segment proportions
  const barTotal = nonDiscTotal + discTotal + leftToDecide || 1;
  const nonDiscFlex = nonDiscTotal / barTotal;
  const discFlex = discTotal / barTotal;
  const leftFlex = leftToDecide / barTotal;

  // Percentages of income — use largest-remainder method so they always sum to 100%
  const [nonDiscPct, discPct, leftPct] = (() => {
    if (income <= 0) return [0, 0, 0];
    const rawPcts = [
      (nonDiscTotal / income) * 100,
      (discTotal / income) * 100,
      (leftToDecide / income) * 100,
    ];
    const floored = rawPcts.map(Math.floor);
    const remainders = rawPcts.map((r, i) => r - floored[i]);
    let gap = 100 - floored.reduce((a, b) => a + b, 0);
    const indices = [0, 1, 2].sort((a, b) => remainders[b] - remainders[a]);
    for (const idx of indices) {
      if (gap <= 0) break;
      floored[idx]++;
      gap--;
    }
    return floored as [number, number, number];
  })();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      {/* ── Header ── */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>
            Hello, {userName || 'there'}
          </Text>
          {syncing && (
            <Text style={styles.syncText}>Syncing latest transactions...</Text>
          )}
        </View>
        <TouchableOpacity
          style={styles.menuButton}
          onPress={() => router.push('/(main)/profile')}
        >
          <View style={styles.menuLine} />
          <View style={[styles.menuLine, styles.menuLineShort]} />
          <View style={styles.menuLine} />
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
          {/* ══════════════════════════════════════════════
              CARD 1 — YOUR TOP MONEY MOVES
              ══════════════════════════════════════════════ */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Your top moves</Text>
            <Text style={styles.cardSubtitle}>Ranked by impact</Text>

            {dashboardMoves.length > 0 ? dashboardMoves.map((move: Move, i: number) => {
              const isOpen = expandedMoves.has(i);
              const isHigh = move.effort === 'high';
              return (
                <TouchableOpacity
                  key={i}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${i + 1}: ${move.action}, saves ${move.annualImpact} pounds per year`}
                  accessibilityHint="Tap to see details"
                  onPress={() => toggleMove(i)}
                  style={[styles.recCard, i === dashboardMoves.length - 1 && { marginBottom: 0 }]}
                >
                  {/* Priority indicator for high effort */}
                  {isHigh && <View style={styles.priorityStripe} />}

                  {/* Collapsed: rank + title + impact */}
                  <View style={styles.recHeader}>
                    <View style={styles.recMeta}>
                      <View style={[styles.rankBadge, isHigh && styles.rankBadgeHigh]}>
                        <Text style={[styles.rankText, isHigh && styles.rankTextHigh]}>#{i + 1}</Text>
                      </View>
                      <View style={styles.recTitleWrap}>
                        <Text style={styles.recTitle}>{move.action}</Text>
                        {isHigh && (
                          <View style={styles.priorityTag}>
                            <Text style={styles.priorityTagText}>HIGH PRIORITY</Text>
                          </View>
                        )}
                      </View>
                    </View>
                    <Text style={styles.recImpact}>
                      +{'\u00a3'}{(move.annualImpact || 0).toLocaleString()}
                    </Text>
                  </View>

                  {/* Expanded: effort, strategy, CTA */}
                  {isOpen && (
                    <View style={styles.recExpanded}>
                      {move.effort && (
                        <Text style={styles.effortLabel}>{move.effort} effort</Text>
                      )}
                      <Text style={styles.recDesc}>{move.strategy}</Text>
                      <TouchableOpacity
                        style={styles.planLink}
                        accessibilityRole="link"
                        onPress={() => router.push('/(main)/(tabs)/plan')}
                      >
                        <Text style={styles.planLinkText}>View in plan</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </TouchableOpacity>
              );
            }) : (
              <Text style={styles.noDataText}>
                No actionable moves yet. Upload a statement to get started.
              </Text>
            )}
          </View>

          {/* ══════════════════════════════════════════════
              CARD 2 — YOUR INCOME
              ══════════════════════════════════════════════ */}
          <View style={styles.card} accessibilityRole="summary" accessibilityLabel={`Monthly income: ${Math.round(income)} pounds`}>
            <Text style={styles.cardTitle}>Your income</Text>

            <View style={styles.bigNumberWrap}>
              <Text style={styles.bigNumber} accessibilityRole="text">
                {'\u00a3'}{Math.round(income).toLocaleString()}
              </Text>
              <Text style={styles.bigNumberLabel}>monthly</Text>
            </View>

            {primaryIncome && (
              <>
                <View style={styles.divider} />
                <View style={styles.sourceCard}>
                  <View style={styles.sourceRow}>
                    <View style={styles.sourceInfo}>
                      <Text style={styles.sourceName}>{primaryIncome.source}</Text>
                      <Text style={styles.sourceFreq}>
                        {primaryIncome.frequency.charAt(0).toUpperCase() + primaryIncome.frequency.slice(1)}
                      </Text>
                    </View>
                    <View style={styles.sourceAmountWrap}>
                      <Text style={styles.sourceAmount}>
                        {'\u00a3'}{Math.round(primaryIncome.avgAmount).toLocaleString()}
                      </Text>
                      <Text style={styles.sourceAmountPer}>
                        per {primaryIncome.frequency === 'weekly' ? 'week' : 'month'}
                      </Text>
                    </View>
                  </View>
                </View>
              </>
            )}

            {!primaryIncome && (
              <Text style={styles.noDataText}>No income sources detected.</Text>
            )}
          </View>

          {/* ══════════════════════════════════════════════
              CARD 3 — YOUR BUDGET REALITY
              ══════════════════════════════════════════════ */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Your budget reality</Text>

            {/* 3-segment stacked bar */}
            <View style={styles.budgetBar}>
              {nonDiscFlex > 0 && (
                <View style={[styles.barSeg, { flex: nonDiscFlex, backgroundColor: colors.coral }]} />
              )}
              {discFlex > 0 && (
                <View style={[styles.barSeg, { flex: discFlex, backgroundColor: gold }]} />
              )}
              {leftFlex > 0 && (
                <View style={[styles.barSeg, { flex: leftFlex, backgroundColor: colors.accent }]} />
              )}
            </View>

            {/* Summary row */}
            <View style={styles.summaryRow}>
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryAmount, { color: colors.coral }]}>
                  {'\u00a3'}{Math.round(nonDiscTotal).toLocaleString()}
                </Text>
                <Text style={styles.summaryLabel}>Non-negotiable</Text>
                <Text style={styles.summaryPct}>{nonDiscPct}%</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryAmount, { color: gold }]}>
                  {'\u00a3'}{Math.round(discTotal).toLocaleString()}
                </Text>
                <Text style={styles.summaryLabel}>Lifestyle</Text>
                <Text style={styles.summaryPct}>{discPct}%</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryAmount, { color: colors.accent }]}>
                  {'\u00a3'}{Math.round(leftToDecide).toLocaleString()}
                </Text>
                <Text style={styles.summaryLabel}>Left to decide</Text>
                <Text style={styles.summaryPct}>{leftPct}%</Text>
              </View>
            </View>

            {/* Non-negotiable breakdown */}
            {nonDiscItems.length > 0 && (
              <>
                <Text style={styles.breakdownHeader}>ESSENTIALS</Text>
                {nonDiscItems.map((item: BudgetCategory, i: number) => {
                  const key = `nd-${item.category}`;
                  const isExpanded = expandedCategories.has(key);
                  const txs: TransactionDetail[] = (item.transactions ?? []).filter(tx => isCurrentMonth(tx.date));
                  const pctOfSection = nonDiscTotal > 0 ? Math.round((item.monthly / nonDiscTotal) * 100) : 0;
                  return (
                    <View key={i}>
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={() => toggleCategory(key)}
                        style={[styles.dataRow, i === nonDiscItems.length - 1 && !isExpanded && styles.dataRowLast]}
                      >
                        <View style={styles.dataRowLeft}>
                          <View style={[styles.bullet, { borderLeftColor: colors.coral }, isExpanded && styles.bulletExpanded]} />
                          <View>
                            <Text style={styles.dataLabel}>{item.category}</Text>
                            <Text style={styles.dataMeta}>
                              {item.txs} txn{item.txs !== 1 ? 's' : ''} · {pctOfSection}% of essentials
                            </Text>
                          </View>
                        </View>
                        <View style={styles.dataRowRight}>
                          <Text style={[styles.dataValue, { color: colors.coral }]}>
                            {'\u00a3'}{Math.round(item.monthly).toLocaleString()}
                          </Text>
                          <Text style={styles.chevron}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                        </View>
                      </TouchableOpacity>
                      {isExpanded && txs.length > 0 && (
                        <View style={styles.txDropdown}>
                          {txs.map((tx, j) => (
                            <View key={j} style={[styles.txRow, j === txs.length - 1 && styles.txRowLast]}>
                              <View style={styles.txLeft}>
                                <Text style={styles.txMerchant}>{tx.merchant}</Text>
                                <Text style={styles.txDate}>{formatDate(tx.date)}</Text>
                              </View>
                              <Text style={[styles.txAmount, { color: colors.coral }]}>
                                {'\u00a3'}{Math.abs(tx.amount).toFixed(2)}
                              </Text>
                            </View>
                          ))}
                        </View>
                      )}
                      {isExpanded && txs.length === 0 && (
                        <View style={styles.txDropdown}>
                          <Text style={styles.txEmpty}>No transaction details available</Text>
                        </View>
                      )}
                    </View>
                  );
                })}
              </>
            )}

            {/* Lifestyle spending */}
            {discItems.length > 0 && (
              <>
                <Text style={[styles.breakdownHeader, { marginTop: 28 }]}>
                  LIFESTYLE
                </Text>
                {discItems.map((item: BudgetCategory, i: number) => {
                  const key = `d-${item.category}`;
                  const isExpanded = expandedCategories.has(key);
                  const txs: TransactionDetail[] = (item.transactions ?? []).filter(tx => isCurrentMonth(tx.date));
                  const pctOfSection = discTotal > 0 ? Math.round((item.monthly / discTotal) * 100) : 0;
                  return (
                    <View key={i}>
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={() => toggleCategory(key)}
                        style={[styles.dataRow, i === discItems.length - 1 && !isExpanded && styles.dataRowLast]}
                      >
                        <View style={styles.dataRowLeft}>
                          <View style={[styles.bullet, { borderLeftColor: gold }, isExpanded && styles.bulletExpanded]} />
                          <View>
                            <Text style={styles.dataLabel}>{item.category}</Text>
                            <Text style={styles.dataMeta}>
                              {item.txs} txn{item.txs !== 1 ? 's' : ''} · {pctOfSection}% of lifestyle
                            </Text>
                          </View>
                        </View>
                        <View style={styles.dataRowRight}>
                          <Text style={[styles.dataValue, { color: gold }]}>
                            {'\u00a3'}{Math.round(item.monthly).toLocaleString()}
                          </Text>
                          <Text style={styles.chevron}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                        </View>
                      </TouchableOpacity>
                      {isExpanded && txs.length > 0 && (
                        <View style={styles.txDropdown}>
                          {txs.map((tx, j) => (
                            <View key={j} style={[styles.txRow, j === txs.length - 1 && styles.txRowLast]}>
                              <View style={styles.txLeft}>
                                <Text style={styles.txMerchant}>{tx.merchant}</Text>
                                <Text style={styles.txDate}>{formatDate(tx.date)}</Text>
                              </View>
                              <Text style={[styles.txAmount, { color: gold }]}>
                                {'\u00a3'}{Math.abs(tx.amount).toFixed(2)}
                              </Text>
                            </View>
                          ))}
                        </View>
                      )}
                      {isExpanded && txs.length === 0 && (
                        <View style={styles.txDropdown}>
                          <Text style={styles.txEmpty}>No transaction details available</Text>
                        </View>
                      )}
                    </View>
                  );
                })}
              </>
            )}

            <Text style={styles.cardFooter}>Tap a category to see this month's transactions</Text>
          </View>

          {/* ── Upload new statement ── */}
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
    padding: 20,
    paddingTop: 56,
    paddingBottom: 48,
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
    marginBottom: 32,
  },
  greeting: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.2,
  },
  menuButton: {
    padding: 10,
    gap: 5,
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuLine: {
    width: 22,
    height: 2,
    backgroundColor: colors.text,
    borderRadius: 1,
  },
  menuLineShort: {
    width: 16,
    backgroundColor: colors.dim,
  },
  syncText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.accent,
    marginTop: 4,
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

  // ── Shared Card ──
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: 16,
    padding: 24,
    paddingTop: 28,
    paddingBottom: 28,
    marginBottom: 24,
    overflow: 'hidden',
  },
  cardTitle: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.text,
    letterSpacing: -0.2,
    marginBottom: 6,
  },
  cardSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    lineHeight: 20,
    marginBottom: 24,
  },
  noDataText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    lineHeight: 22,
  },

  // ── Card 1: Recommendations ──
  recCard: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 16,
    marginBottom: 0,
    position: 'relative' as const,
  },
  recHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 44,
  },
  recMeta: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    flex: 1,
    marginRight: 12,
  },
  rankBadge: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankBadgeHigh: {
    backgroundColor: 'rgba(122,239,199,0.12)',
  },
  rankText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: '700',
    color: colors.dim,
  },
  rankTextHigh: {
    color: colors.accent,
  },
  recTitleWrap: {
    flex: 1,
    gap: 6,
  },
  recTitle: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },
  priorityStripe: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  priorityTag: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accentDim,
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
  priorityTagText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    fontWeight: '700',
    color: colors.accent,
    letterSpacing: 1,
  },
  recImpact: {
    fontFamily: fonts.mono,
    fontSize: 13,
    fontWeight: '700',
    color: colors.accent,
  },
  recExpanded: {
    paddingLeft: 44,
    paddingTop: 8,
    paddingBottom: 4,
    gap: 8,
  },
  effortLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: gold,
    fontWeight: '500',
    textTransform: 'capitalize',
  },
  recDesc: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    lineHeight: 20,
  },
  planLink: {
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  planLinkText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent,
    letterSpacing: 0.3,
  },

  // ── Card 2: Income ──
  bigNumberWrap: {
    alignItems: 'center',
    paddingVertical: 12,
    paddingBottom: 28,
  },
  bigNumber: {
    fontFamily: fonts.mono,
    fontSize: 48,
    fontWeight: '800',
    color: colors.accent,
    letterSpacing: -1,
  },
  bigNumberLabel: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
    marginTop: 4,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    marginBottom: 4,
  },
  sourceCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
  },
  sourceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  sourceInfo: {
    flex: 1,
    marginRight: 12,
  },
  sourceName: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.text,
    lineHeight: 21,
    marginBottom: 8,
  },
  sourceTagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sourceFreq: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: 'rgba(122,239,199,0.6)',
  },
  primaryTag: {
    backgroundColor: colors.accentDim,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  primaryTagText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: '600',
    color: colors.accent,
    letterSpacing: 0.8,
  },
  sourceAmountWrap: {
    alignItems: 'flex-end',
  },
  sourceAmount: {
    fontFamily: fonts.mono,
    fontSize: 20,
    fontWeight: '800',
    color: colors.accent,
  },
  sourceAmountPer: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },

  // ── Card 3: Budget Reality ──
  budgetBar: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 20,
  },
  barSeg: {
    borderRadius: 0,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 28,
  },
  summaryItem: {
    alignItems: 'center',
    flex: 1,
  },
  summaryAmount: {
    fontFamily: fonts.mono,
    fontSize: 18,
    fontWeight: '800',
  },
  summaryLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
    marginTop: 2,
  },
  summaryPct: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 1,
  },
  breakdownHeader: {
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.muted,
    marginBottom: 4,
  },
  dataRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    minHeight: 48,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  dataRowLast: {
    borderBottomWidth: 0,
  },
  dataRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  bullet: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderTopWidth: 5,
    borderTopColor: 'transparent',
    borderBottomWidth: 5,
    borderBottomColor: 'transparent',
    borderLeftWidth: 7,
  },
  dataLabel: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.dim,
  },
  dataMeta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  dataRowRight: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 8,
  },
  dataValue: {
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: '600',
  },
  chevron: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.muted,
  },
  bulletExpanded: {
    borderLeftColor: colors.text,
  },

  // ── Transaction dropdown ──
  txDropdown: {
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(255,255,255,0.06)',
    marginLeft: 10,
    marginBottom: 8,
    paddingLeft: 14,
    paddingVertical: 6,
  },
  txRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.03)',
  },
  txRowLast: {
    borderBottomWidth: 0,
  },
  txLeft: {
    flex: 1,
    marginRight: 12,
  },
  txMerchant: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text2,
  },
  txDate: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  txAmount: {
    fontFamily: fonts.mono,
    fontSize: 13,
    fontWeight: '600',
  },
  txEmpty: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
    paddingVertical: 8,
  },
  breakdownSubtext: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
    marginBottom: 12,
    lineHeight: 18,
  },
  cardFooter: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 16,
  },

  // ── Upload CTA ──
  uploadButton: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: colors.accent,
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: 8,
    minHeight: 52,
    justifyContent: 'center',
  },
  uploadText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.accent,
  },
});
