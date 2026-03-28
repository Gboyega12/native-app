import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';

// ── Card Types ──

interface SpendingItem {
  category: string;
  amount: number;
}

interface TransactionItem {
  date: string;
  merchant: string;
  amount: number;
}

interface ComparisonData {
  label_a: string;
  label_b: string;
  value_a: number;
  value_b: number;
}

interface NumberData {
  value: string;
  trend?: 'up' | 'down' | 'flat';
  context: string;
}

export type ChatCardData =
  | { type: 'spending'; items: SpendingItem[] }
  | { type: 'transactions'; items: TransactionItem[] }
  | { type: 'comparison'; data: ComparisonData }
  | { type: 'number'; data: NumberData };

// ── Delimiter parser ──

const CARD_DELIMITER_RX = /^:::(\w+)\s+(\{[\s\S]*?\})\s*:::$/;

/** Try to parse a chat card from a :::type {...} ::: delimiter block */
export function parseCardDelimiter(text: string): ChatCardData | null {
  const match = text.trim().match(CARD_DELIMITER_RX);
  if (!match) return null;
  try {
    const cardType = match[1];
    const data = JSON.parse(match[2]);
    if (cardType === 'spending' && Array.isArray(data.items)) {
      return { type: 'spending', items: data.items };
    }
    if (cardType === 'transactions' && Array.isArray(data.items)) {
      return { type: 'transactions', items: data.items.slice(0, 5) };
    }
    if (cardType === 'comparison' && data.label_a) {
      return { type: 'comparison', data };
    }
    if (cardType === 'number' && data.value) {
      return { type: 'number', data };
    }
  } catch {}
  return null;
}

// ── Card Components ──

export default function ChatCard({ card }: { card: ChatCardData }) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);

  if (card.type === 'spending') return <SpendingCard items={card.items} s={s} colors={colors} />;
  if (card.type === 'transactions') return <TransactionListCard items={card.items} s={s} colors={colors} />;
  if (card.type === 'comparison') return <ComparisonCard data={card.data} s={s} colors={colors} />;
  if (card.type === 'number') return <NumberCard data={card.data} s={s} colors={colors} />;
  return null;
}

function SpendingCard({ items, s, colors }: { items: SpendingItem[]; s: any; colors: ThemeColors }) {
  const max = Math.max(...items.map((i) => i.amount), 1);
  return (
    <View style={s.card}>
      {items.map((item, idx) => (
        <View key={idx} style={s.spendingRow}>
          <Text style={s.spendingLabel} numberOfLines={1}>{item.category}</Text>
          <View style={s.barTrack}>
            <View style={[s.barFill, { width: `${Math.round((item.amount / max) * 100)}%`, backgroundColor: colors.accent }]} />
          </View>
          <Text style={s.spendingAmount}>{'\u00a3'}{Math.round(item.amount).toLocaleString()}</Text>
        </View>
      ))}
    </View>
  );
}

function TransactionListCard({ items, s, colors }: { items: TransactionItem[]; s: any; colors: ThemeColors }) {
  return (
    <View style={s.card}>
      {items.map((item, idx) => (
        <View key={idx} style={[s.txRow, idx < items.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={s.txMerchant} numberOfLines={1}>{item.merchant}</Text>
            <Text style={s.txDate}>{item.date}</Text>
          </View>
          <Text style={s.txAmount}>{'\u00a3'}{Math.abs(item.amount).toFixed(2)}</Text>
        </View>
      ))}
    </View>
  );
}

function ComparisonCard({ data, s, colors }: { data: ComparisonData; s: any; colors: ThemeColors }) {
  const delta = data.value_b - data.value_a;
  const deltaColor = delta > 0 ? colors.coral : colors.green;
  return (
    <View style={s.card}>
      <View style={s.compRow}>
        <View style={s.compCol}>
          <Text style={s.compLabel}>{data.label_a}</Text>
          <Text style={s.compValue}>{'\u00a3'}{Math.round(data.value_a).toLocaleString()}</Text>
        </View>
        <View style={s.compCol}>
          <Text style={s.compLabel}>{data.label_b}</Text>
          <Text style={s.compValue}>{'\u00a3'}{Math.round(data.value_b).toLocaleString()}</Text>
        </View>
      </View>
      <Text style={[s.compDelta, { color: deltaColor }]}>
        {delta > 0 ? '+' : ''}{'\u00a3'}{Math.round(Math.abs(delta)).toLocaleString()}
      </Text>
    </View>
  );
}

function NumberCard({ data, s, colors }: { data: NumberData; s: any; colors: ThemeColors }) {
  const trendArrow = data.trend === 'up' ? '\u2191' : data.trend === 'down' ? '\u2193' : '';
  const trendColor = data.trend === 'up' ? colors.green : data.trend === 'down' ? colors.coral : colors.text;
  return (
    <View style={[s.card, { alignItems: 'center' }]}>
      <Text style={[s.heroNumber, { color: trendColor }]}>
        {data.value} {trendArrow}
      </Text>
      <Text style={s.heroContext}>{data.context}</Text>
    </View>
  );
}

const createStyles = (c: ThemeColors) => StyleSheet.create({
  card: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  // Spending bar chart
  spendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  spendingLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.text2,
    width: 80,
  },
  barTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.accentDim,
    marginHorizontal: 8,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
  },
  spendingAmount: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.text,
    width: 60,
    textAlign: 'right',
  },
  // Transaction list
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  txMerchant: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.text,
  },
  txDate: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.muted,
    marginTop: 1,
  },
  txAmount: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.text,
  },
  // Comparison
  compRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  compCol: {
    flex: 1,
    alignItems: 'center',
  },
  compLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: c.muted,
    marginBottom: 4,
  },
  compValue: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: c.text,
  },
  compDelta: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
  },
  // Number hero
  heroNumber: {
    fontFamily: fonts.heading,
    fontSize: 32,
    color: c.text,
  },
  heroContext: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.text2,
    marginTop: 4,
  },
});
