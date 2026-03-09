import { Redirect } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';

export default function Index() {
  // When TrueLayer redirects back with ?code=...&state=..., don't redirect
  // to sign-in — that would lose the params. Show a loading screen while
  // AuthGate picks up _pendingOAuth and navigates to the connect screen.
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('code') && params.get('state')) {
      return (
        <View style={{ flex: 1, backgroundColor: '#050505', justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color="#66DFCA" size="large" />
        </View>
      );
    }
  }

  return <Redirect href="/(auth)/sign-in" />;
}
