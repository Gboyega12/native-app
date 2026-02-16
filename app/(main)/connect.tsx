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
  const params = useLocalSearchParams<{
    connection_id?: string; status?: string;
    code?: string; state?: string;
  }>();
  const [loading, setLoading] = useState(false);
  const [loadingCSV, setLoadingCSV] = useState(false);
  const [loadingPDF, setLoadingPDF] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // Handle TrueLayer redirect — code+state arrive as URL params
  useEffect(() => {
    if (params.code && params.state) {
      exchangeTrueLayerCode(params.code, params.state);
    } else if (params.status === 'success' && params.connection_id) {
      fetchBankData(params.connection_id);
    }
  }, [params.code, params.state, params.status, params.connection_id]);

  // POST the auth code to our callback API for token exchange + data fetch
  const exchangeTrueLayerCode = async (code: string, state: string) => {
    setLoading(true);
    setErrorMsg('');
    setStatusMsg('Exchanging authorization code...');
    try {
      const res = await fetch('/api/truelayer/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, state }),
      });
      const data = await res.json();

      if (data.success && data.connection_id) {
        setStatusMsg('Fetching bank data...');
        await fetchBankData(data.connection_id);
        return;
      }

      const errDetail = data.details
        ? `${data.error}: ${typeof data.details === 'string' ? data.details : JSON.stringify(data.details)}`
        : data.error || 'Token exchange failed';
      setErrorMsg(errDetail);
      setStatusMsg('');
      setLoading(false);
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error during token exchange');
      setStatusMsg('');
      setLoading(false);
    }
  };

  const fetchBankData = async (connId: string) => {
    setLoading(true);
    setStatusMsg('Loading transactions...');
    try {
      const { data, error } = await supabase
        .from('bank_data')
        .select('csv_data')
        .eq('connection_id', connId)
        .single();

      if (error || !data?.csv_data) {
        setErrorMsg(error?.message || 'No bank data found for this connection');
        setStatusMsg('');
        setLoading(false);
        return;
      }

      setStatusMsg('');
      setLoading(false);
      router.push({ pathname: '/(main)/goals', params: { csvData: data.csv_data } });
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to fetch bank data');
      setStatusMsg('');
      setLoading(false);
    }
  };

  const handleTrueLayer = async () => {
    setLoading(true);
    try {
      const connectionId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const authUrl = getTrueLayerAuthUrl(connectionId);

      // TrueLayer redirects to the app root — match that as returnUrl
      const returnUrl = Platform.OS === 'web'
        ? window.location.origin
        : 'bocy://';

      const result = await WebBrowser.openAuthSessionAsync(authUrl, returnUrl);

      if (result.type === 'success' && result.url) {
        const url = new URL(result.url);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (code && state) {
          await exchangeTrueLayerCode(code, state);
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

  const handlePDFUpload = async () => {
    setLoadingPDF(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: Platform.OS === 'web'
          ? ['application/pdf', '.pdf']
          : ['application/pdf'],
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.[0]) {
        setLoadingPDF(false);
        return;
      }

      const file = result.assets[0];

      // Convert PDF to base64
      const base64 = await fileToBase64(file);
      if (!base64) {
        Alert.alert('Error', 'Could not read the PDF file.');
        setLoadingPDF(false);
        return;
      }

      // Send to API for Claude-powered extraction
      const res = await fetch('/api/parse-statement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf_base64: base64 }),
      });
      const data = await res.json();

      if (!data.success || !data.csv_data) {
        Alert.alert(
          'Could not parse statement',
          data.error || 'Please try a CSV export instead.',
        );
        setLoadingPDF(false);
        return;
      }

      setLoadingPDF(false);
      router.push({ pathname: '/(main)/goals', params: { csvData: data.csv_data } });
    } catch (err) {
      setLoadingPDF(false);
      Alert.alert('Error', 'Could not process the PDF. Please try a CSV export instead.');
    }
  };

  const anyLoading = loading || loadingCSV || loadingPDF;

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
          disabled={anyLoading}
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
          <Text style={styles.dividerText}>or upload a statement</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.uploadRow}>
          <TouchableOpacity
            style={[styles.uploadButton, loadingPDF && styles.buttonDisabled]}
            onPress={handlePDFUpload}
            disabled={anyLoading}
          >
            {loadingPDF ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <>
                <Text style={styles.uploadIcon}>PDF</Text>
                <Text style={styles.uploadButtonText}>PDF statement</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.uploadButton, loadingCSV && styles.buttonDisabled]}
            onPress={handleCSVUpload}
            disabled={anyLoading}
          >
            {loadingCSV ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <>
                <Text style={styles.uploadIcon}>CSV</Text>
                <Text style={styles.uploadButtonText}>CSV export</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <Text style={styles.hint}>
          Download your statement from your banking app as PDF or CSV
        </Text>

        {statusMsg ? (
          <Text style={styles.statusText}>{statusMsg}</Text>
        ) : null}
        {errorMsg ? (
          <Text style={styles.errorText}>{errorMsg}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ── Helpers ──

async function fileToBase64(
  file: DocumentPicker.DocumentPickerAsset,
): Promise<string | null> {
  try {
    // On web, use the File API directly
    if (Platform.OS === 'web') {
      const webFile = (file as any).file as File | undefined;
      if (webFile) {
        const buffer = await webFile.arrayBuffer();
        return arrayBufferToBase64(buffer);
      }
    }

    // On native (or web fallback), fetch the URI and convert
    const response = await fetch(file.uri);
    const blob = await response.blob();
    return await blobToBase64(blob);
  } catch {
    return null;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Process in chunks to avoid max call stack size
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
  }
  return btoa(binary);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      // Strip "data:application/pdf;base64," prefix
      const base64 = dataUrl.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
  uploadRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  uploadButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  uploadIcon: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.accent,
    backgroundColor: colors.accentDim,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 4,
  },
  uploadButtonText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
  },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
  },
  statusText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.accent,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  errorText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: '#ff6b6b',
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
