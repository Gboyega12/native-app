import { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
  LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis, BudgetCategory, TransactionDetail, IncomeSource, Move } from '@/lib/types';

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

  const toggleCategory = (key: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

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
  const moves = analysis?.all_moves ?? [];
  const income = analysis?.monthly_income ?? 0;
  const incomeSources = analysis?.income_sources ?? [];

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

  // Percentages of income
  const nonDiscPct = income > 0 ? Math.round((nonDiscTotal / income) * 100) : 0;
  const discPct = income > 0 ? Math.round((discTotal / income) * 100) : 0;
  const leftPct = income > 0 ? Math.round((leftToDecide / income) * 100) : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      {/* ── Header ── */}
      <View style={styles.headerRow}>
        <Text style={styles.greeting}>
          Hello, {userName || 'there'}
        </Text>
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
            <Text style={styles.cardTitle}>Your top money moves</Text>
            <Text style={styles.cardSubtitle}>Ranked by impact. Start with #1.</Text>

            {moves.length > 0 ? moves.slice(0, 3).map((move: Move, i: number) => (
              <View key={i} style={styles.recCard}>
                {/* Rank / effort / impact header */}
                <View style={styles.recHeader}>
                  <View style={styles.recMeta}>
                    <View style={styles.rankBadge}>
                      <Text style={styles.rankText}>#{i + 1}</Text>
                    </View>
                    {move.effort && (
                      <Text style={styles.effortLabel}>
                        {move.effort} effort
                      </Text>
                    )}
                  </View>
                  <Text style={styles.recImpact}>
                    +{'\u00a3'}{(move.annualImpact || 0).toLocaleString()}/yr
                  </Text>
                </View>

                {/* Title + description */}
                <Text style={styles.recTitle}>{move.action}</Text>
                <Text style={styles.recDesc}>{move.strategy}</Text>

                {/* Approve / Modify */}
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.approveBtn}
                    onPress={() => router.push('/(main)/(tabs)/plan')}
                  >
                    <Text style={styles.approveBtnText}>Approve</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modifyBtn}
                    onPress={() => router.push('/(main)/(tabs)/plan')}
                  >
                    <Text style={styles.modifyBtnText}>Modify</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )) : (
              <Text style={styles.noDataText}>
                No actionable moves yet. Upload a statement to get started.
              </Text>
            )}
          </View>

          {/* ══════════════════════════════════════════════
              CARD 2 — YOUR INCOME
              ══════════════════════════════════════════════ */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Your income</Text>

            {/* Big centered number */}
            <View style={styles.bigNumberWrap}>
              <Text style={styles.bigNumber}>
                {'\u00a3'}{Math.round(income).toLocaleString()}
              </Text>
              <Text style={styles.bigNumberLabel}>total monthly income</Text>
            </View>

            <View style={styles.divider} />

            {/* Income sources */}
            {incomeSources.map((src: IncomeSource, i: number) => (
              <View key={i} style={styles.sourceCard}>
                <View style={styles.sourceRow}>
                  <View style={styles.sourceInfo}>
                    <Text style={styles.sourceName}>{src.source}</Text>
                    <View style={styles.sourceTagRow}>
                      <Text style={styles.sourceFreq}>
                        {src.frequency.charAt(0).toUpperCase() + src.frequency.slice(1)}
                      </Text>
                      {src.isSalary && (
                        <View style={styles.primaryTag}>
                          <Text style={styles.primaryTagText}>PRIMARY</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <View style={styles.sourceAmountWrap}>
                    <Text style={styles.sourceAmount}>
                      {'\u00a3'}{Math.round(src.avgAmount).toLocaleString()}
                    </Text>
                    <Text style={styles.sourceAmountPer}>
                      per {src.frequency === 'weekly' ? 'week' : 'month'}
                    </Text>
                  </View>
                </View>
              </View>
            ))}

            {incomeSources.length === 0 && (
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
                <Text style={styles.breakdownHeader}>ESSENTIALS BREAKDOWN</Text>
                <Text style={styles.breakdownSubtext}>
                  Fixed costs and necessities — bills, groceries, transport
                </Text>
                {nonDiscItems.map((item: BudgetCategory, i: number) => {
                  const key = `nd-${item.category}`;
                  const isExpanded = expandedCategories.has(key);
                  const txs: TransactionDetail[] = item.transactions ?? [];
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
                <Text style={[styles.breakdownHeader, { marginTop: 20 }]}>
                  LIFESTYLE SPENDING
                </Text>
                <Text style={styles.breakdownSubtext}>
                  Discretionary spending — dining, shopping, entertainment
                </Text>
                {discItems.map((item: BudgetCategory, i: number) => {
                  const key = `d-${item.category}`;
                  const isExpanded = expandedCategories.has(key);
                  const txs: TransactionDetail[] = item.transactions ?? [];
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

            <Text style={styles.cardFooter}>Tap a category to view transactions</Text>
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
    padding: 18,
    paddingTop: 52,
    paddingBottom: 40,
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
    marginBottom: 28,
  },
  greeting: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.2,
  },
  menuButton: {
    padding: 4,
    gap: 5,
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
    borderRadius: 14,
    padding: 22,
    paddingTop: 24,
    marginBottom: 28,
    overflow: 'hidden',
  },
  cardTitle: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.2,
    marginBottom: 4,
  },
  cardSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    lineHeight: 21,
    marginBottom: 20,
  },
  noDataText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    lineHeight: 22,
  },

  // ── Card 1: Recommendations ──
  recCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
    padding: 16,
    paddingTop: 18,
    marginBottom: 10,
  },
  recHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  recMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rankBadge: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  rankText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: '700',
    color: colors.dim,
  },
  effortLabel: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: gold,
    fontWeight: '500',
  },
  recImpact: {
    fontFamily: fonts.mono,
    fontSize: 15,
    fontWeight: '700',
    color: colors.accent,
  },
  recTitle: {
    fontFamily: fonts.heading,
    fontSize: 17,
    color: colors.text,
    lineHeight: 23,
    marginBottom: 6,
  },
  recDesc: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    lineHeight: 19.5,
    marginBottom: 4,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  approveBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(122,239,199,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(122,239,199,0.3)',
    alignItems: 'center',
  },
  approveBtnText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
    letterSpacing: 0.3,
  },
  modifyBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
  },
  modifyBtnText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    fontWeight: '600',
    color: colors.dim,
    letterSpacing: 0.3,
  },

  // ── Card 2: Income ──
  bigNumberWrap: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingBottom: 24,
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
    marginBottom: 14,
  },
  barSeg: {
    borderRadius: 0,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
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
    paddingVertical: 13,
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
    marginBottom: 8,
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
  },
  uploadText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.accent,
  },
});
