import { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, Platform,
  LayoutAnimation,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as DocumentPicker from 'expo-document-picker';
import { getTrueLayerAuthUrl } from '@/lib/truelayer';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';

// ── Session storage helpers (web only) ──
function saveConnectState(csv: string, count: number) {
  if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem('bocy_connect_csv', csv);
      sessionStorage.setItem('bocy_connect_count', String(count));
    } catch {}
  }
}

function restoreConnectState(): { csv: string; count: number } | null {
  if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined') {
    try {
      const csv = sessionStorage.getItem('bocy_connect_csv');
      const count = sessionStorage.getItem('bocy_connect_count');
      if (csv || count) {
        return { csv: csv || '', count: parseInt(count || '0', 10) };
      }
    } catch {}
  }
  return null;
}

function clearConnectState() {
  if (Platform.OS === 'web' && typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem('bocy_connect_csv');
      sessionStorage.removeItem('bocy_connect_count');
    } catch {}
  }
}

export default function Connect() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    connection_id?: string; status?: string; error?: string;
    code?: string; state?: string;
    from?: string;
    csvData?: string;
  }>();

  // Detect if we're returning from a TrueLayer redirect
  const isRedirecting = !!(params.connection_id && params.status === 'success') || !!(params.code && params.state);

  const [loading, setLoading] = useState(false);
  const [loadingCSV, setLoadingCSV] = useState(false);
  const [loadingPDF, setLoadingPDF] = useState(false);
  const [redirectLoading, setRedirectLoading] = useState(isRedirecting);
  const [statusMsg, setStatusMsg] = useState(isRedirecting ? 'Connecting your account...' : '');
  const [errorMsg, setErrorMsg] = useState('');
  const [accumulatedCSV, setAccumulatedCSV] = useState(params.csvData || '');
  const [connectedCount, setConnectedCount] = useState(params.csvData ? 1 : 0);
  const [lastConnectedName, setLastConnectedName] = useState('');

  const isFromProfile = params.from === 'profile';

  // On mount: restore state, count bank_data rows, and guard against re-connection
  useEffect(() => {
    const init = async () => {
      // Restore session state (from before TrueLayer redirect)
      const saved = restoreConnectState();
      if (saved && saved.count > 0) {
        setAccumulatedCSV((prev) => prev || saved.csv);
        setConnectedCount((prev) => Math.max(prev, saved.count));
      }

      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          // Count existing bank_data rows
          const { count } = await supabase
            .from('bank_data')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id);
          if (count && count > 0) {
            setConnectedCount((prev) => Math.max(prev, count));
          }

          // Guard: if not from profile and not returning from TrueLayer,
          // redirect to dashboard if analysis already exists
          if (!isFromProfile && !isRedirecting) {
            const { data: existing } = await supabase
              .from('analyses')
              .select('id')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false })
              .limit(1);
            if (existing && existing.length > 0) {
              clearConnectState();
              router.replace('/(main)/(tabs)');
              return;
            }
          }
        }
      } catch {}
    };
    init();
  }, []);

  // Handle redirect params — arriving back from TrueLayer
  useEffect(() => {
    if (params.status === 'success' && params.connection_id) {
      fetchBankData(params.connection_id);
    } else if (params.status === 'error' && params.error) {
      setErrorMsg(decodeURIComponent(params.error));
      setRedirectLoading(false);
    } else if (params.code && params.state) {
      exchangeTrueLayerCode(params.code, params.state);
    }
  }, [params.connection_id, params.status, params.code, params.state]);

  const exchangeTrueLayerCode = async (code: string, state: string) => {
    setLoading(true);
    setRedirectLoading(true);
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
        setStatusMsg('Fetching your transactions...');
        await fetchBankData(data.connection_id);
        return;
      }

      const errDetail = data.details
        ? `${data.error}: ${typeof data.details === 'string' ? data.details : JSON.stringify(data.details)}`
        : data.error || 'Token exchange failed';
      setErrorMsg(errDetail);
      setStatusMsg('');
      setLoading(false);
      setRedirectLoading(false);
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error during token exchange');
      setStatusMsg('');
      setLoading(false);
      setRedirectLoading(false);
    }
  };

  const fetchBankData = async (connId: string) => {
    setLoading(true);
    setErrorMsg('');
    setStatusMsg('Loading transactions...');
    try {
      let userId = '';
      try {
        const { data: { user } } = await supabase.auth.getUser();
        userId = user?.id || '';
      } catch {}
      const qs = `connection_id=${encodeURIComponent(connId)}${userId ? `&user_id=${encodeURIComponent(userId)}` : ''}`;
      const res = await fetch(`/api/bank-data?${qs}`);
      const result = await res.json();

      if (!result.success || !result.csv_data) {
        setErrorMsg(result.error || 'No bank data found for this connection');
        setStatusMsg('');
        setLoading(false);
        setRedirectLoading(false);
        return;
      }

      setStatusMsg('');
      setLoading(false);
      setRedirectLoading(false);

      if (isFromProfile) {
        clearConnectState();
        router.replace({ pathname: '/(main)/profile', params: { connected: 'true' } as any });
        return;
      }

      // Onboarding flow — accumulate data
      handleConnectionSuccess(result.csv_data, 'Bank account');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to fetch bank data');
      setStatusMsg('');
      setLoading(false);
      setRedirectLoading(false);
    }
  };

  const handleConnectionSuccess = (csvData: string, label: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const combined = accumulatedCSV
      ? accumulatedCSV + '\n' + csvData.split('\n').slice(1).join('\n')
      : csvData;
    setAccumulatedCSV(combined);
    setConnectedCount((c) => {
      const next = c + 1;
      // Persist state for web redirect survival
      saveConnectState(combined, next);
      return next;
    });
    setLastConnectedName(label);
  };

  const handleTrueLayer = async () => {
    setLoading(true);
    setErrorMsg('');
    setStatusMsg('Connecting to your bank...');

    // Save current state before redirect (web loses state)
    saveConnectState(accumulatedCSV, connectedCount);

    try {
      const connectionId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const authUrl = getTrueLayerAuthUrl(connectionId);

      if (Platform.OS === 'web') {
        window.location.href = authUrl;
        return;
      }

      const returnUrl = 'bocy://callback';
      const result = await WebBrowser.openAuthSessionAsync(authUrl, returnUrl);

      if (result.type === 'success' && result.url) {
        const url = new URL(result.url);
        const connId = url.searchParams.get('connection_id');
        const status = url.searchParams.get('status');
        if (status === 'success' && connId) {
          await fetchBankData(connId);
          return;
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (code && state) {
          await exchangeTrueLayerCode(code, state);
          return;
        }
      }

      setLoading(false);
      setStatusMsg('');
      if (result.type !== 'cancel') {
        setErrorMsg('Could not connect to your bank. Please try again.');
      }
    } catch (err: any) {
      setLoading(false);
      setStatusMsg('');
      setErrorMsg(err.message || 'Something went wrong connecting to your bank.');
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

      if (isFromProfile) {
        router.replace({ pathname: '/(main)/profile', params: { connected: 'true' } as any });
        return;
      }

      handleConnectionSuccess(csvText, 'CSV statement');
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
      const base64 = await fileToBase64(file);
      if (!base64) {
        Alert.alert('Error', 'Could not read the PDF file.');
        setLoadingPDF(false);
        return;
      }

      const res = await fetch('/api/parse-statement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf_base64: base64 }),
      });
      const data = await res.json();

      if (!data.success || !data.csv_data) {
        Alert.alert('Could not parse statement', data.error || 'Please try a CSV export instead.');
        setLoadingPDF(false);
        return;
      }

      setLoadingPDF(false);

      if (isFromProfile) {
        router.replace({ pathname: '/(main)/profile', params: { connected: 'true' } as any });
        return;
      }

      handleConnectionSuccess(data.csv_data, 'PDF statement');
    } catch (err) {
      setLoadingPDF(false);
      Alert.alert('Error', 'Could not process the PDF. Please try a CSV export instead.');
    }
  };

  const handleContinue = async () => {
    // Merge ALL bank_data CSVs from Supabase + any locally accumulated data
    let mergedCSV = accumulatedCSV;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: bankRows } = await supabase
          .from('bank_data')
          .select('csv_data')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (bankRows && bankRows.length > 0) {
          const allLines: string[] = ['Date,Description,Amount'];
          for (const row of bankRows) {
            if (!row.csv_data) continue;
            const lines = row.csv_data.split('\n');
            allLines.push(...lines.slice(1).filter((l: string) => l.trim()));
          }
          const dbCSV = allLines.join('\n');

          // Merge with any locally accumulated CSV (from manual uploads)
          if (mergedCSV) {
            const localLines = mergedCSV.split('\n').slice(1).filter((l: string) => l.trim());
            // Deduplicate by checking if lines already exist in DB CSV
            const dbLineSet = new Set(allLines);
            const uniqueLocal = localLines.filter((l: string) => !dbLineSet.has(l));
            if (uniqueLocal.length > 0) {
              mergedCSV = dbCSV + '\n' + uniqueLocal.join('\n');
            } else {
              mergedCSV = dbCSV;
            }
          } else {
            mergedCSV = dbCSV;
          }
        }
      }
    } catch {}

    if (!mergedCSV || mergedCSV.trim().split('\n').length < 2) {
      Alert.alert('No data', 'No transaction data found. Please connect at least one account.');
      return;
    }

    clearConnectState();
    router.push({ pathname: '/(main)/processing', params: { csvData: mergedCSV } });
  };

  const anyLoading = loading || loadingCSV || loadingPDF;

  // Show full-screen loading when returning from TrueLayer redirect
  if (redirectLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.loadingText}>{statusMsg || 'Connecting your account...'}</Text>
        <Text style={styles.loadingHint}>This may take a few seconds</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {/* Success banner for connected accounts */}
        {connectedCount > 0 && !isFromProfile && (
          <View style={styles.successBanner}>
            <View style={styles.successCountBadge}>
              <Text style={styles.successCountText}>{connectedCount}</Text>
            </View>
            <Text style={styles.successText}>
              {connectedCount} account{connectedCount > 1 ? 's' : ''} connected
              {lastConnectedName ? ` (${lastConnectedName})` : ''}
            </Text>
          </View>
        )}

        <Text style={styles.title}>
          {isFromProfile ? 'Add a connection' : connectedCount > 0 ? 'Add another account?' : 'Connect your bank'}
        </Text>
        <Text style={styles.subtitle}>
          {isFromProfile
            ? 'Connect a bank account for transactions or a credit card for balance tracking.'
            : connectedCount > 0
              ? 'Connect more accounts for a complete picture, or continue to analyse your finances.'
              : 'We need your transaction data to identify your most impactful financial move.'}
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

        {/* Continue button — only in onboarding when at least one account connected */}
        {connectedCount > 0 && !isFromProfile && (
          <TouchableOpacity style={styles.continueButton} onPress={handleContinue}>
            <Text style={styles.continueText}>
              Continue with {connectedCount} account{connectedCount > 1 ? 's' : ''} {'>'}
            </Text>
          </TouchableOpacity>
        )}

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
    if (Platform.OS === 'web') {
      const webFile = (file as any).file as File | undefined;
      if (webFile) {
        const buffer = await webFile.arrayBuffer();
        return arrayBufferToBase64(buffer);
      }
    }
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

  // ── Loading screen (redirect) ──
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  loadingText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
  loadingHint: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginTop: spacing.sm,
    textAlign: 'center',
  },

  // ── Success banner ──
  successBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(122,239,199,0.08)',
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: spacing.lg,
    gap: 10,
  },
  successCountBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  successCountText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.bg,
  },
  successText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.accent,
    flex: 1,
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
  continueButton: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  continueText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.bg,
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
