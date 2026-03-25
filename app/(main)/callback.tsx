import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';

/**
 * Deep link handler for native bank auth callback.
 *
 * After authorising in the bank app, Finexer redirects to the server callback
 * which then redirects to `bocy://callback?connection_id=...&status=success`.
 * This route catches that deep link and forwards the params to the connect screen,
 * which already knows how to fetch bank data from a connection_id.
 */
export default function Callback() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    connection_id?: string;
    status?: string;
    error?: string;
  }>();

  useEffect(() => {
    // Forward all params to the connect screen which handles bank data fetching
    router.replace({
      pathname: '/(main)/connect',
      params: {
        ...(params.connection_id ? { connection_id: params.connection_id } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.error ? { error: params.error } : {}),
      },
    });
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#050505', justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator color="#66DFCA" size="large" />
    </View>
  );
}
