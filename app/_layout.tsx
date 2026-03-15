import { useEffect, useState, useRef } from 'react';
import { View, Animated, Easing, StyleSheet } from 'react-native';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { ThemeProvider, useTheme } from '@/lib/theme-context';
import { registerServiceWorker } from '@/lib/register-sw';
import { initMixpanel, resetMixpanel } from '@/lib/mixpanel';
import { initSentryClient, setSentryUser, clearSentryUser } from '@/lib/sentry';
import ErrorBoundary from '@/components/ErrorBoundary';
import UpdateBanner from '@/components/UpdateBanner';
import AppDataProvider from '@/providers/AppDataProvider';

// Initialise Sentry as early as possible
initSentryClient();

SplashScreen.preventAutoHideAsync().catch(() => {});

// Capture URL-based signals at module load time — before any component renders.
// This is critical because app/index.tsx's <Redirect> fires during render and
// clears the URL params before useEffect can read them. Each flag is consumed
// (set to null/false) on first read so it fires exactly once.
const pendingSignals = {
  oauth: null as { code: string; state: string } | null,
  bankCallback: false,
  emailConfirmed: false,
};
if (typeof window !== 'undefined') {
  const p = new URLSearchParams(window.location.search);
  const code = p.get('code');
  const state = p.get('state');
  if (code && state) {
    pendingSignals.oauth = { code, state };
  }
  // Detect return from TrueLayer server callback (GET redirect flow)
  if (p.get('connection_id') && p.get('status')) {
    pendingSignals.bankCallback = true;
  }
  // Detect email confirmation redirect (Supabase appends #...&type=signup)
  const hash = window.location.hash;
  if (hash.includes('type=signup') || hash.includes('type=email')) {
    pendingSignals.emailConfirmed = true;
  }
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const routedForSession = useRef<string | null>(null);
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | null = null;
    try {
      const { data } = supabase.auth.onAuthStateChange((_event, sess) => {
        if (!sess && session) {
          resetMixpanel();
          clearSentryUser();
        }
        if (sess?.user) setSentryUser(sess.user.id, sess.user.email);
        setSession(sess);
        setReady(true);
      });
      subscription = data.subscription;
    } catch (e) {
      console.warn('[AuthGate] onAuthStateChange error:', e);
      setReady(true); // unblock the UI so it shows sign-in
    }
    return () => subscription?.unsubscribe();
  }, []);

  // Register service worker + init analytics once session is available
  useEffect(() => {
    if (session?.user?.id) {
      registerServiceWorker();
      initMixpanel(session.user.id, session.user.email).catch((e) =>
        console.warn('[Layout] initMixpanel error:', e),
      );
    }
  }, [session?.user?.id]);

  useEffect(() => {
    if (!ready) return;
    const inAuth = segments[0] === '(auth)';

    // Email confirmation opened in email browser — sign out to prevent
    // onboarding in the wrong browser. Show confirmation on sign-in instead.
    if (session && pendingSignals.emailConfirmed) {
      pendingSignals.emailConfirmed = false;
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('_emailConfirmed', '1');
      }
      supabase.auth.signOut().catch(() => {});
      router.replace('/(auth)/sign-in');
      return;
    }

    // Forward captured OAuth code+state to the connect screen
    if (session && pendingSignals.oauth) {
      const { code, state } = pendingSignals.oauth;
      pendingSignals.oauth = null; // consume so it doesn't fire again
      router.replace({ pathname: '/(main)/connect', params: { code, state } });
      return;
    }

    // If returning from TrueLayer bank callback, let connect screen handle the URL params.
    // Don't reroute — just clear the flag once session arrives.
    if (pendingSignals.bankCallback) {
      if (session) {
        pendingSignals.bankCallback = false; // session restored, connect screen is handling it
      }
      // Whether session is null (restoring) or present, don't interfere —
      // connect is already mounted with connection_id + status in the URL.
      return;
    }

    if (!session && !inAuth) {
      routedForSession.current = null;
      router.replace('/(auth)/splash');
    } else if (session) {
      // Onboarding screens the user progresses through sequentially.
      // Don't re-route if they're already on one — let them continue.
      const onboardingScreens = ['welcome', 'education', 'identity', 'connect', 'processing'];
      const currentMain = segments[0] === '(main)' ? (segments as string[])[1] : null;
      const onOnboarding = currentMain != null && onboardingScreens.includes(currentMain as string);
      if (onOnboarding) return;

      // Once we've evaluated and routed for this session, don't re-run the
      // DB queries on every segment change (e.g. switching tabs). Reset on
      // session change (login/logout).
      if (routedForSession.current === session.user.id) return;

      // Route to the correct onboarding step (or dashboard) based on DB state.
      const name = session.user.user_metadata?.full_name;
      if (!name) {
        routedForSession.current = session.user.id;
        router.replace('/(main)/welcome');
      } else {
        void (async () => {
          try {
            const { data } = await supabase
              .from('user_identity')
              .select('user_id')
              .eq('user_id', session.user.id)
              .maybeSingle();
            if (data) {
              // Identity complete — check if they have an analysis
              try {
                const { data: rows } = await supabase
                  .from('analyses')
                  .select('id')
                  .eq('user_id', session.user.id)
                  .order('created_at', { ascending: false })
                  .limit(1);
                routedForSession.current = session.user.id;
                router.replace(rows && rows.length > 0 ? '/(main)/(tabs)' : '/(main)/connect');
              } catch {
                // Transient DB error — let dashboard handle missing data
                routedForSession.current = session.user.id;
                router.replace('/(main)/(tabs)');
              }
            } else {
              // No identity yet — start education flow
              routedForSession.current = session.user.id;
              router.replace('/(main)/education');
            }
          } catch {
            // Query failed — fall back to education flow
            routedForSession.current = session.user.id;
            router.replace('/(main)/education');
          }
        })();
      }
    }
  }, [session, ready, segments]);

  return <>{children}</>;
}

/** Full-screen overlay that flashes on theme toggle and fades out */
function ThemeOverlay() {
  const { colors, isDark } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [overlayBg, setOverlayBg] = useState<string | null>(null);
  const prevTheme = useRef(isDark);

  useEffect(() => {
    if (prevTheme.current !== isDark) {
      prevTheme.current = isDark;
      setOverlayBg(colors.bg);
      fadeAnim.setValue(1);
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 400,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => setOverlayBg(null));
    }
  }, [isDark]);

  if (!overlayBg) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: overlayBg, opacity: fadeAnim, zIndex: 9999 }]}
    />
  );
}

function InnerLayout() {
  const { colors, isDark } = useTheme();

  return (
    <AuthGate>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <ThemeOverlay />
    </AuthGate>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    Poppins_400Regular: require('@expo-google-fonts/poppins/400Regular/Poppins_400Regular.ttf'),
    Poppins_500Medium: require('@expo-google-fonts/poppins/500Medium/Poppins_500Medium.ttf'),
    Poppins_600SemiBold: require('@expo-google-fonts/poppins/600SemiBold/Poppins_600SemiBold.ttf'),
    Poppins_700Bold: require('@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf'),
  });

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: '#000000' }} />;
  }

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AppDataProvider>
          <InnerLayout />
          <UpdateBanner />
        </AppDataProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
