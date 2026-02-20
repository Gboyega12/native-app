import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { ThemeProvider, useTheme } from '@/lib/theme-context';

SplashScreen.preventAutoHideAsync();

// Capture OAuth code+state at module load time — before any component renders.
// This is critical because app/index.tsx's <Redirect> fires during render and
// clears the URL params before useEffect can read them.
let _pendingOAuth: { code: string; state: string } | null = null;
let _pendingBankCallback = false;
let _emailConfirmed = false;
if (typeof window !== 'undefined') {
  const p = new URLSearchParams(window.location.search);
  const code = p.get('code');
  const state = p.get('state');
  if (code && state) {
    _pendingOAuth = { code, state };
  }
  // Detect return from TrueLayer server callback (GET redirect flow)
  if (p.get('connection_id') && p.get('status')) {
    _pendingBankCallback = true;
  }
  // Detect email confirmation redirect (Supabase appends #...&type=signup)
  const hash = window.location.hash;
  if (hash.includes('type=signup') || hash.includes('type=email')) {
    _emailConfirmed = true;
  }
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      setReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const inAuth = segments[0] === '(auth)';

    // Email confirmation opened in email browser — sign out to prevent
    // onboarding in the wrong browser. Show confirmation on sign-in instead.
    if (session && _emailConfirmed) {
      _emailConfirmed = false;
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('_emailConfirmed', '1');
      }
      supabase.auth.signOut();
      router.replace('/(auth)/sign-in');
      return;
    }

    // Forward captured OAuth code+state to the connect screen
    if (session && _pendingOAuth) {
      const { code, state } = _pendingOAuth;
      _pendingOAuth = null; // consume so it doesn't fire again
      router.replace({ pathname: '/(main)/connect', params: { code, state } });
      return;
    }

    // If returning from TrueLayer bank callback, let connect screen handle the URL params.
    // Don't reroute — just clear the flag once session arrives.
    if (_pendingBankCallback) {
      if (session) {
        _pendingBankCallback = false; // session restored, connect screen is handling it
      }
      // Whether session is null (restoring) or present, don't interfere —
      // connect is already mounted with connection_id + status in the URL.
      return;
    }

    if (!session && !inAuth) {
      router.replace('/(auth)/splash');
    } else if (session && inAuth) {
      const name = session.user.user_metadata?.full_name;
      if (!name) {
        router.replace('/(main)/welcome');
      } else {
        // Check if user has completed identity discovery
        supabase
          .from('user_identity')
          .select('user_id')
          .eq('user_id', session.user.id)
          .single()
          .then(({ data }) => {
            if (data) {
              // Identity complete — check if they have an analysis
              supabase
                .from('analyses')
                .select('id')
                .eq('user_id', session.user.id)
                .order('created_at', { ascending: false })
                .limit(1)
                .then(({ data: rows }) => {
                  router.replace(rows && rows.length > 0 ? '/(main)/(tabs)' : '/(main)/connect');
                })
                .catch(() => {
                  router.replace('/(main)/connect');
                });
            } else {
              // No identity yet — start education flow
              router.replace('/(main)/education');
            }
          })
          .catch(() => {
            // Query failed — fall back to education flow
            router.replace('/(main)/education');
          });
      }
    }
  }, [session, ready, segments]);

  return <>{children}</>;
}

function InnerLayout() {
  const { colors, isDark } = useTheme();

  return (
    <AuthGate>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </AuthGate>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    Poppins_400Regular: require('@expo-google-fonts/poppins/400Regular/Poppins_400Regular.ttf'),
    Poppins_500Medium: require('@expo-google-fonts/poppins/500Medium/Poppins_500Medium.ttf'),
    Poppins_600SemiBold: require('@expo-google-fonts/poppins/600SemiBold/Poppins_600SemiBold.ttf'),
    Poppins_700Bold: require('@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf'),
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: '#050505' }} />;
  }

  return (
    <ThemeProvider>
      <InnerLayout />
    </ThemeProvider>
  );
}
