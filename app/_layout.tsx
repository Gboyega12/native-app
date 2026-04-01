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
  // Detect return from Finexer server callback (GET redirect flow)
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
  const router = useRouter();
  const segments = useSegments();

  // Persist routing cache in sessionStorage so it survives page refreshes
  // (useRef resets on remount, causing unnecessary DB queries + wrong redirects).
  // We store BOTH the session id and the destination so that on refresh we can
  // skip the DB queries entirely and route directly.
  const ROUTED_KEY = '_routedForSession';
  const ROUTED_DEST_KEY = '_routedDestination';
  const getRouted = () =>
    typeof window !== 'undefined' ? sessionStorage.getItem(ROUTED_KEY) : null;
  const getRoutedDest = () =>
    typeof window !== 'undefined' ? sessionStorage.getItem(ROUTED_DEST_KEY) : null;
  const setRouted = (id: string | null, destination?: string) => {
    if (typeof window === 'undefined') return;
    if (id) {
      sessionStorage.setItem(ROUTED_KEY, id);
      if (destination) sessionStorage.setItem(ROUTED_DEST_KEY, destination);
    } else {
      sessionStorage.removeItem(ROUTED_KEY);
      sessionStorage.removeItem(ROUTED_DEST_KEY);
    }
  };

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | null = null;
    try {
      const { data } = supabase.auth.onAuthStateChange((event, sess) => {
        // Only clear analytics/routing on explicit sign-out — not on transient
        // null sessions from TOKEN_REFRESHED or INITIAL_SESSION events.
        if (event === 'SIGNED_OUT') {
          clearSentryUser();
          setRouted(null);
          if (typeof window !== 'undefined') {
            localStorage.removeItem('bocy_onboarding_done');
          }
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

    // Proactively refresh token when browser tab resumes from idle/background.
    // After overnight idle, the JWT is expired. autoRefreshToken runs on an
    // interval but doesn't fire immediately on tab resume — this prevents
    // stale tokens from corrupting the routing DB queries.
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        supabase.auth.getSession().then(({ data: { session: s } }) => {
          if (s) {
            const expiresAt = s.expires_at ?? 0;
            const nowSec = Math.floor(Date.now() / 1000);
            if (expiresAt - nowSec < 120) {
              supabase.auth.refreshSession().catch(() => {});
            }
          }
        });
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      subscription?.unsubscribe();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, []);

  // Register service worker + init analytics once session is available
  useEffect(() => {
    if (session?.user?.id) {
      registerServiceWorker();
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
      setRouted(session.user.id, '/(main)/connect');
      router.replace({ pathname: '/(main)/connect', params: { code, state } });
      return;
    }

    // If returning from Finexer bank callback, let connect screen handle the URL params.
    // Don't reroute — just clear the flag once session arrives.
    if (pendingSignals.bankCallback) {
      if (session) {
        pendingSignals.bankCallback = false; // session restored, connect screen is handling it
        setRouted(session.user.id, '/(main)/connect');
      }
      // Whether session is null (restoring) or present, don't interfere —
      // connect is already mounted with connection_id + status in the URL.
      return;
    }

    if (!session && !inAuth) {
      // Cache is cleared in onAuthStateChange SIGNED_OUT handler above.
      // Don't clear here — transient null sessions (token refresh) reach this path too.
      router.replace('/(auth)/splash');
    } else if (session) {
      // Onboarding screens the user progresses through sequentially.
      // Don't re-route if they're already on one — let them continue.
      const onboardingScreens = ['welcome', 'education', 'identity', 'connect', 'processing', 'callback', 'account-setup'];
      const currentMain = segments[0] === '(main)' ? (segments as string[])[1] : null;
      const onOnboarding = currentMain != null && onboardingScreens.includes(currentMain as string);
      if (onOnboarding) return;

      // Once we've evaluated and routed for this session, don't re-run the
      // DB queries on every segment change (e.g. switching tabs). Reset on
      // session change (login/logout).
      // On page refresh, Expo Router starts at the root index (segments=[''])
      // before resolving — use the cached destination to route directly.
      const inMain = segments[0] === '(main)';
      if (getRouted() === session.user.id) {
        if (inMain) {
          // Update cached destination when user reaches the dashboard,
          // so a future page refresh goes straight there.
          const onTabs = (segments as string[])[1] === '(tabs)';
          if (onTabs && getRoutedDest() !== '/(main)/(tabs)') {
            setRouted(session.user.id, '/(main)/(tabs)');
            // Backfill durable flag so future cold starts skip DB queries
            if (typeof window !== 'undefined' && !localStorage.getItem('bocy_onboarding_done')) {
              localStorage.setItem('bocy_onboarding_done', 'true');
            }
          }
          return;
        }
        // Page refresh starts at root index — use cached destination
        // to skip DB queries and route directly.
        const cachedDest = getRoutedDest();
        if (cachedDest) {
          // Backfill durable flag when restoring a dashboard destination
          if (cachedDest === '/(main)/(tabs)' && typeof window !== 'undefined' && !localStorage.getItem('bocy_onboarding_done')) {
            localStorage.setItem('bocy_onboarding_done', 'true');
          }
          router.replace(cachedDest as any);
          return;
        }
      }

      // Durable onboarding flag — if the user has completed onboarding before,
      // skip the fragile multi-table DB reconstruction and go straight to dashboard.
      if (typeof window !== 'undefined' && localStorage.getItem('bocy_onboarding_done')) {
        setRouted(session.user.id, '/(main)/(tabs)');
        router.replace('/(main)/(tabs)');
        return;
      }

      // Route to the correct onboarding step (or dashboard) based on DB state.
      // Check analyses FIRST — this is the most definitive signal that the user
      // completed onboarding. Avoids false negatives from stale JWTs or metadata
      // not being populated on new devices (e.g. PWA install, different browser).
      void (async () => {
        try {
          const { data: rows, error: analysisError } = await supabase
            .from('analyses')
            .select('id')
            .eq('user_id', session.user.id)
            .order('created_at', { ascending: false })
            .limit(1);

          if (!analysisError && rows && rows.length > 0) {
            // Has analyses — user completed onboarding. Go straight to dashboard.
            if (typeof window !== 'undefined') {
              localStorage.setItem('bocy_onboarding_done', 'true');
            }
            setRouted(session.user.id, '/(main)/(tabs)');
            router.replace('/(main)/(tabs)');
            return;
          }

          // No analyses — determine which onboarding step they're on.
          const name = session.user.user_metadata?.full_name;
          if (!name) {
            setRouted(session.user.id, '/(main)/welcome');
            router.replace('/(main)/welcome');
            return;
          }

          const { data: identityData } = await supabase
            .from('user_identity')
            .select('user_id')
            .eq('user_id', session.user.id)
            .maybeSingle();

          if (!identityData) {
            setRouted(session.user.id, '/(main)/education');
            router.replace('/(main)/education');
            return;
          }

          // Identity exists but no analyses — route to connect
          if (!analysisError && rows && rows.length === 0) {
            setRouted(session.user.id, '/(main)/connect');
            router.replace('/(main)/connect');
          } else {
            // Query failed — default to dashboard
            setRouted(session.user.id, '/(main)/(tabs)');
            router.replace('/(main)/(tabs)');
          }
        } catch {
          // DB error — default to dashboard, never education/connect
          setRouted(session.user.id, '/(main)/(tabs)');
          router.replace('/(main)/(tabs)');
        }
      })();
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
