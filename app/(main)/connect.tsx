import { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as DocumentPicker from 'expo-document-picker';
import { supabase } from '@/lib/supabase';
import { getTrueLayerAuthUrl } from '@/lib/truelayer';
import { colors, fonts, spacing, radius } from '@/theme';

export default function Connect() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [loadingCSV, setLoadingCSV] = useState(false);

  const handleTrueLayer = async () => {
    setLoading(true);
    try {
      // Generate unique connection ID
      const connectionId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const authUrl = getTrueLayerAuthUrl(connectionId);

      const result = await WebBrowser.openAuthSessionAsync(authUrl, 'bocy://callback');

      if (result.type === 'success' && result.url) {
        const url = new URL(result.url);
        const status = url.searchParams.get('status');
        const connId = url.searchParams.get('connection_id');

        if (status === 'success' && connId) {
          // Fetch CSV from bank_data table
          const { data, error } = await supabase
            .from('bank_data')
            .select('csv_data')
            .eq('connection_id', connId)
            .single();

          if (error || !data?.csv_data) {
            Alert.alert('Error', 'Could not retrieve bank data. Please try again.');
            setLoading(false);
            return;
          }

          setLoading(false);
          router.push({ pathname: '/(main)/goals', params: { csvData: data.csv_data } });
          return;
        }
      }

      setLoading(false);
      if (result.type !== 'cancel') {
        Alert.alert('Connection failed', 'Could not connect to your bank. Please try again.');
      }
    } catch (err) {
      setLoading(false);
      Alert.alert('Error', 'Something went wrong connecting to your bank.');
    }
  };

  const handleCSVUpload = async () => {
    setLoadingCSV(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'application/csv'],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) {
        setLoadingCSV(false);
        return;
      }

      const file = result.assets[0];
      const response = await fetch(file.uri);
      const csvText = await response.text();

      if (!csvText.trim() || csvText.trim().split('\n').length < 2) {
        Alert.alert('Invalid file', 'The CSV file appears to be empty or malformed.');
        setLoadingCSV(false);
        return;
      }

      setLoadingCSV(false);
      router.push({ pathname: '/(main)/goals', params: { csvData: csvText } });
    } catch (err) {
      setLoadingCSV(false);
      Alert.alert('Error', 'Could not read the file. Please check the format and try again.');
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Connect your bank</Text>
        <Text style={styles.subtitle}>
          We need your transaction data to analyse your spending and build your financial profile.
        </Text>

        <TouchableOpacity
          style={[styles.primaryButton, loading && styles.buttonDisabled]}
          onPress={handleTrueLayer}
          disabled={loading || loadingCSV}
        >
          {loading ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.primaryButtonText}>Connect via Open Banking</Text>
          )}
        </TouchableOpacity>

        <View style={styles.trustRow}>
          <TrustBadge text="FCA regulated" />
          <TrustBadge text="Read-only access" />
          <TrustBadge text="Data on device" />
        </View>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <TouchableOpacity
          style={[styles.secondaryButton, loadingCSV && styles.buttonDisabled]}
          onPress={handleCSVUpload}
          disabled={loading || loadingCSV}
        >
          {loadingCSV ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={styles.secondaryButtonText}>Upload a CSV file</Text>
          )}
        </TouchableOpacity>
        <Text style={styles.hint}>
          Export transactions from your banking app as CSV
        </Text>
      </View>
    </View>
  );
}

function TrustBadge({ text }: { text: string }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    fontFamily: fonts.mono,
    fontSize: 22,
    color: colors.text,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontSize: 14,
    color: colors.dim,
    lineHeight: 22,
    marginBottom: spacing.xl,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  primaryButtonText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: colors.bg,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  trustRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  badge: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(114,232,176,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(114,232,176,0.15)',
    borderRadius: 20,
  },
  badgeText: {
    fontSize: 11,
    color: colors.mint,
    fontFamily: fonts.mono,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerText: {
    color: colors.muted,
    fontSize: 12,
    marginHorizontal: spacing.md,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  secondaryButtonText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: colors.text,
  },
  hint: {
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
  },
});
