// ── Subscription Management Screen ──
// Shows all detected subscriptions with monthly cost, frequency,
// and an option to ask Bocy for help cancelling.

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '@/lib/supabase';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useResponsive } from '@/lib/responsive';
import { BocyFace } from '@/components/Bocy';
import type { Analysis, RecurringItem } from '@/lib/types';
import { trackEvent, trackScreen } from '@/lib/mixpanel';

type SubItem = {
  merchant: string;
  monthly: number;
  frequency: string;
  category: string;
  fromMoves: boolean; // Whether it appeared in a move's merchants[] list (i.e. Bocy thinks it can be cut)
};

export default function Subscriptions() {
  const router = useRouter();
  const { colors } = useTheme();
  const { maxContentWidth, isTablet, horizontalPadding } = useResponsive();
  const s = useMemo(() => createStyles(colors), [colors]);

  const [subs, setSubs] = useState<SubItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [totalMonthly, setTotalMonthly] = useState(0);

  const loadSubs = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }

      const { data } = await supabase
        .from('analyses')
        .select('discretionary, all_moves')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!data) { setLoading(false); return; }

      // 1. Extract subscription merchants mentioned in moves
      const moveMerchants = new Set<string>();
      for (const move of (data.all_moves || [])) {
        if (move.merchants?.length && (move.action || '').toLowerCase().includes('subscript')) {
          for (const m of move.merchants) moveMerchants.add(m.toLowerCase());
        }
      }

      // 2. Extract subscription items from discretionary budget
      const items: SubItem[] = [];
      const seen = new Set<string>();

      const disc = data.discretionary as Analysis['discretionary'];
      if (disc?.items) {
        for (const cat of disc.items) {
          const isSubCat = ['Subscriptions', 'Streaming', 'Entertainment'].includes(cat.category);
          if (!isSubCat) continue;

          // Each category might have transactions — group by merchant
          if (cat.transactions?.length) {
            const merchantTotals: Record<string, { total: number; count: number }> = {};
            for (const tx of cat.transactions) {
              const key = (tx.merchant || tx.description || 'Unknown').toLowerCase();
              if (!merchantTotals[key]) merchantTotals[key] = { total: 0, count: 0 };
              merchantTotals[key].total += Math.abs(tx.amount);
              merchantTotals[key].count += 1;
            }
            for (const [merchant, data] of Object.entries(merchantTotals)) {
              if (seen.has(merchant)) continue;
              seen.add(merchant);
              items.push({
                merchant: merchant.replace(/\b\w/g, (c) => c.toUpperCase()),
                monthly: Math.round(data.total / data.count),
                frequency: 'monthly',
                category: cat.category,
                fromMoves: moveMerchants.has(merchant),
              });
            }
          } else if (cat.monthly > 0) {
            // No transactions, but we have the category total
            const key = cat.category.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              items.push({
                merchant: cat.category,
                monthly: Math.round(cat.monthly),
                frequency: 'monthly',
                category: cat.category,
                fromMoves: false,
              });
            }
          }
        }
      }

      // Sort by cost descending
      items.sort((a, b) => b.monthly - a.monthly);

      setSubs(items);
      setTotalMonthly(items.reduce((s, i) => s + i.monthly, 0));
    } catch {
      // Silently fail — user will see empty state
    }
    setLoading(false);
    setRefreshing(false);
  };

  useFocusEffect(useCallback(() => { trackScreen('Subscriptions'); loadSubs(); }, []));

  const onRefresh = () => { setRefreshing(true); loadSubs(); };

  const askBocy = (merchant: string) => {
    trackEvent('Ask Bocy From Subscription', { merchant });
    router.push({
      pathname: '/(main)/(tabs)/chat',
      params: { prefill: `How do I cancel or downgrade my ${merchant} subscription? What alternatives are there?` },
    });
  };

  if (loading) {
    return (
      <View style={[s.container, s.centered]}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={[
        s.scroll,
        isTablet && { maxWidth: maxContentWidth, alignSelf: 'center' as const, width: '100%', paddingHorizontal: horizontalPadding },
      ]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
      }
    >
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => router.canGoBack() ? router.back() : router.replace('/(main)/(tabs)')}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={s.backBtn}>{'\u2190'}</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Subscriptions</Text>
        <View style={{ width: 24 }} />
      </View>

      {subs.length === 0 ? (
        /* Empty state */
        <View style={s.emptyState}>
          <View style={s.emptyBocyWrap}>
            <BocyFace mood="neutral" size="lg" breathing />
          </View>
          <Text style={s.emptyTitle}>No subscriptions detected</Text>
          <Text style={s.emptyDesc}>
            Connect your bank account and Bocy will automatically find recurring subscriptions in your transactions.
          </Text>
          <TouchableOpacity style={s.ctaButton} onPress={() => router.push('/(main)/connect')}>
            <Text style={s.ctaText}>Connect your bank</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Summary card */}
          <View style={s.summaryCard}>
            <View style={s.summaryRow}>
              <View>
                <Text style={s.summaryAmount}>
                  {'\u00a3'}{totalMonthly.toLocaleString()}
                </Text>
                <Text style={s.summaryLabel}>per month</Text>
              </View>
              <View style={s.summaryRight}>
                <Text style={s.summaryAnnual}>
                  {'\u00a3'}{(totalMonthly * 12).toLocaleString()}/yr
                </Text>
                <Text style={s.summaryCount}>
                  {subs.length} subscription{subs.length !== 1 ? 's' : ''}
                </Text>
              </View>
            </View>
          </View>

          {/* Subscription list — grouped by category */}
          {(() => {
            // Group subs by category
            const groups: Record<string, SubItem[]> = {};
            for (const sub of subs) {
              const key = sub.category || 'Other';
              if (!groups[key]) groups[key] = [];
              groups[key].push(sub);
            }
            const categoryKeys = Object.keys(groups);
            const showHeaders = categoryKeys.length > 1;

            return categoryKeys.map((cat, catIdx) => {
              const catSubs = groups[cat];
              const catTotal = catSubs.reduce((sum, sub) => sum + sub.monthly, 0);
              const isLastGroup = catIdx === categoryKeys.length - 1;
              return (
                <View key={cat}>
                  {showHeaders && (
                    <View style={s.categoryHeader}>
                      <Text style={s.categoryLabel}>{cat.toUpperCase()}</Text>
                      <Text style={s.categoryDot}>{'\u00B7'}</Text>
                      <Text style={s.categoryTotal}>{'\u00a3'}{catTotal}/mo</Text>
                    </View>
                  )}
                  {catSubs.map((sub, i) => (
                    <View key={`${cat}-${i}`} style={[s.subCard, isLastGroup && i === catSubs.length - 1 && { marginBottom: spacing.xxl }]}>
                      <View style={s.subRow}>
                        <View style={s.subInfo}>
                          <Text style={s.subMerchant}>{sub.merchant}</Text>
                          <View style={s.subMeta}>
                            {!showHeaders && <Text style={s.subCategory}>{sub.category}</Text>}
                            {sub.fromMoves && (
                              <View style={s.cuttableBadge}>
                                <Text style={s.cuttableBadgeText}>Cuttable</Text>
                              </View>
                            )}
                          </View>
                        </View>
                        <View style={s.subCost}>
                          <Text style={s.subAmount}>
                            {'\u00a3'}{sub.monthly}
                          </Text>
                          <Text style={s.subFreq}>/mo</Text>
                        </View>
                      </View>
                      <View style={s.subActions}>
                        <TouchableOpacity
                          style={s.askBocyBtn}
                          onPress={() => askBocy(sub.merchant)}
                          activeOpacity={0.7}
                        >
                          <Text style={s.askBocyText}>Ask Bocy to help cancel</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}
                </View>
              );
            });
          })()}
        </>
      )}
    </ScrollView>
  );
}

// ── Styles ──

const createStyles = (c: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  scroll: {
    padding: spacing.lg,
    paddingTop: spacing.xxl + spacing.sm,
    paddingBottom: spacing.xxl,
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  backBtn: {
    fontFamily: fonts.regular,
    fontSize: 22,
    color: c.accent,
  },
  headerTitle: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: c.text,
    letterSpacing: -0.2,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingTop: spacing.xxl,
  },
  emptyBocyWrap: {
    marginBottom: spacing.xl,
  },
  emptyTitle: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: c.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  emptyDesc: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.dim,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: spacing.xl,
    maxWidth: 280,
  },
  ctaButton: {
    backgroundColor: c.accent,
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: radius.md,
  },
  ctaText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: c.bg,
  },

  // Summary card
  summaryCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryAmount: {
    fontFamily: fonts.heading,
    fontSize: 32,
    color: c.text,
    letterSpacing: -1,
  },
  summaryLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    marginTop: 2,
  },
  summaryRight: {
    alignItems: 'flex-end',
  },
  summaryAnnual: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: c.coral,
  },
  summaryCount: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
    marginTop: 2,
  },

  // Category group headers
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  categoryLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2,
    color: c.text2,
  },
  categoryDot: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.muted,
  },
  categoryTotal: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.text2,
  },

  // Subscription card
  subCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  subRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  subInfo: {
    flex: 1,
    marginRight: spacing.md,
  },
  subMerchant: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: c.text,
    marginBottom: 4,
  },
  subMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  subCategory: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
  },
  cuttableBadge: {
    backgroundColor: c.greenDim,
    borderWidth: 1,
    borderColor: c.green + '30',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  cuttableBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: c.green,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  subCost: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  subAmount: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: c.text,
  },
  subFreq: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
    marginLeft: 2,
  },

  // Actions
  subActions: {
    marginTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: spacing.sm,
  },
  askBocyBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.green + '40',
    alignSelf: 'flex-start',
  },
  askBocyText: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: c.green,
  },
});
