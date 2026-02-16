import { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as DocumentPicker from 'expo-document-picker';
import { supabase } from '@/lib/supabase';
import { getTrueLayerAuthUrl } from '@/lib/truelayer';
import { colors, fonts, spacing, radius } from '@/theme';

export default function Connect() {
  const router = useRouter();
  const params = useLocalSearchParams<{ connection_id?: string; status?: string }>();
  const [loading, setLoading] = useState(false);
  const [loadingCSV, setLoadingCSV] = useState(false);

  // Handle web OAuth callback (when redirected back from TrueLayer via query params)
  useEffect(() => {
    if (params.status === 'success' && params.connection_id) {
      fetchBankData(params.connection_id);
    }
  }, [params.status, params.connection_id]);

  const fetchBankData = async (connId: string) => {
    setLoading(true);
    try {
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
    } catch {
      setLoading(false);
      Alert.alert('Error', 'Could not retrieve bank data.');
    }
  };

  const handleTrueLayer = async () => {
    setLoading(true);
    try {
      const connectionId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      // On web, pass the origin so the callback can redirect back here
      const webOrigin = Platform.OS === 'web' ? window.location.origin : undefined;
      const authUrl = getTrueLayerAuthUrl(connectionId, webOrigin);

      // On web, use the web URL as the return URL; on mobile, use deep link
      const returnUrl = Platform.OS === 'web'
        ? `${window.location.origin}/connect`
        : 'bocy://callback';

      const result = await WebBrowser.openAuthSessionAsync(authUrl, returnUrl);

      if (result.type === 'success' && result.url) {
        const url = new URL(result.url);
        const status = url.searchParams.get('status');
        const connId = url.searchParams.get('connection_id');

        if (status === 'success' && connId) {
          await fetchBankData(connId);
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
        type: Platform.OS === 'web'
          ? ['text/csv', 'text/plain', '.csv']
          : ['text/csv', 'text/comma-separated-values', 'application/csv'],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) {
        setLoadingCSV(false);
        return;
      }

      const file = result.assets[0];

      // On web, read the File object directly (more reliable than fetching blob URIs)
      let csvText: string;
      const webFile = Platform.OS === 'web' && (file as any).file;
      if (webFile) {
        csvText = await webFile.text();
      } else {
        const response = await fetch(file.uri);
        csvText = await response.text();
      }

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
          We need your transaction data to identify your most material financial move.
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
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontFamily: fonts.regular,
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
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.bg,
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
    backgroundColor: 'rgba(122,239,199,0.06)',
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: 20,
  },
  badgeText: {
    fontSize: 11,
    color: colors.accent,
    fontFamily: fonts.medium,
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
    fontFamily: fonts.regular,
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
    fontFamily: fonts.medium,
    fontSize: 15,
    color: colors.text,
  },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
  },
});
