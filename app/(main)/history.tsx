import { useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, ActivityIndicator,
} from 'react-native';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';

interface HistoryItem {
  id: string;
  created_at: string;
  archetype: string;
  decision_score: number;
  monthly_income: number;
  monthly_spending: number;
  surplus: number;
}

export default function History() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { data } = await supabase
      .from('analyses')
      .select('id, created_at, archetype, decision_score, monthly_income, monthly_spending, surplus')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    setItems(data || []);
    setLoading(false);
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Analysis history</Text>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No analyses yet.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.date}>{formatDate(item.created_at)}</Text>
            <MetricRow label="Income" value={`\u00a3${item.monthly_income}`} color={colors.mint} />
            <MetricRow label="Spending" value={`\u00a3${item.monthly_spending}`} color={colors.coral} />
            <MetricRow
              label="Surplus"
              value={`\u00a3${item.surplus}`}
              color={item.surplus >= 0 ? colors.mint : colors.coral}
            />
            <MetricRow
              label="Score"
              value={`${item.decision_score}/100`}
              color={item.decision_score >= 55 ? colors.mint : colors.coral}
            />
          </View>
        )}
      />
    </View>
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
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heading: {
    fontFamily: fonts.mono,
    fontSize: 22,
    color: colors.text,
    fontWeight: '700',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl + spacing.lg,
    marginBottom: spacing.lg,
  },
  list: {
    padding: spacing.xl,
    paddingTop: 0,
    paddingBottom: spacing.xxl,
  },
  emptyText: {
    fontSize: 14,
    color: colors.dim,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  date: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.accent,
    marginBottom: spacing.sm,
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  metricLabel: {
    fontSize: 13,
    color: colors.dim,
  },
  metricValue: {
    fontFamily: fonts.mono,
    fontSize: 13,
    fontWeight: '700',
  },
});
