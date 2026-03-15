import { useState, useEffect } from 'react';
import { Redirect } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { supabase } from '@/lib/supabase';

const Loading = () => (
  <View style={{ flex: 1, backgroundColor: '#050505', justifyContent: 'center', alignItems: 'center' }}>
    <ActivityIndicator color="#66DFCA" size="large" />
  </View>
);

export default function Index() {
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);

  // Check if TrueLayer redirect params are present (module-level check to
  // avoid losing URL params before AuthGate can pick them up).
  const [isBankRedirect] = useState(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return !!(params.get('code') && params.get('state'));
    }
    return false;
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setHasSession(!!data.session);
      setChecking(false);
    });
  }, []);

  // When TrueLayer redirects back with ?code=...&state=..., don't redirect
  // to sign-in — that would lose the params. Show a loading screen while
  // AuthGate picks up _pendingOAuth and navigates to the connect screen.
  if (isBankRedirect) return <Loading />;

  if (checking) return <Loading />;

  // Logged-in users go straight to home — avoids triggering AuthGate's
  // onboarding re-evaluation which can incorrectly redirect to connect.
  if (hasSession) return <Redirect href="/(main)/(tabs)" />;

  return <Redirect href="/(auth)/sign-in" />;
}
