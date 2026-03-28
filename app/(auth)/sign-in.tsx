import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView,
  ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { gaPageView, gaEvent } from '@/lib/ga';
import { colors, fonts, spacing, radius } from '@/theme';

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [emailConfirmed, setEmailConfirmed] = useState(false);

  useEffect(() => {
    trackScreen('Sign In');
    gaPageView('/sign-in', 'Sign In');
    if (typeof window !== 'undefined') {
      if (sessionStorage.getItem('_emailConfirmed')) {
        sessionStorage.removeItem('_emailConfirmed');
        setEmailConfirmed(true);
      }
    }
  }, []);

  const handleSignIn = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Please enter your email and password.');
      return;
    }
    setError('');
    setLoading(true);
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setLoading(false);
    if (authError) {
      setError(authError.message === 'Invalid login credentials'
        ? 'Wrong email or password. Please try again.'
        : authError.message);
      trackEvent('Sign In Failed', { method: 'email' });
      gaEvent('login_failed', { method: 'email' });
    } else {
      trackEvent('Sign In', { method: 'email' });
      gaEvent('login', { method: 'email' });
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setGoogleLoading(true);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });
    if (oauthError) {
      setError(oauthError.message);
      setGoogleLoading(false);
      trackEvent('Sign In Failed', { method: 'google' });
    } else {
      trackEvent('Sign In', { method: 'google' });
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={undefined}
      testID="sign-in-screen"
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.logo}>Bocy</Text>
          <Text style={styles.subtitle}>AI financial strategist</Text>
        </View>

        {emailConfirmed && (
          <View style={styles.confirmedBanner}>
            <Text style={styles.confirmedText}>Email confirmed! Sign in to continue.</Text>
          </View>
        )}

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.muted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            value={email}
            onChangeText={setEmail}
            testID="sign-in-email-input"
            accessibilityLabel="Email address"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            testID="sign-in-password-input"
            accessibilityLabel="Password"
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleSignIn}
            disabled={loading || googleLoading}
            testID="sign-in-submit-button"
            accessibilityRole="button"
            accessibilityLabel="Sign in"
          >
            {loading ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </TouchableOpacity>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <TouchableOpacity
            style={[styles.googleButton, googleLoading && styles.buttonDisabled]}
            onPress={handleGoogleSignIn}
            disabled={loading || googleLoading}
            testID="sign-in-google-button"
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
          >
            {googleLoading ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <>
                <Text style={styles.googleIcon}>G</Text>
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={() => router.push('/(auth)/sign-up')} testID="sign-in-sign-up-link" accessibilityRole="button" accessibilityLabel="Go to sign up">
          <Text style={styles.link}>
            Don't have an account? <Text style={styles.linkAccent}>Sign up</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl + 4,
    maxWidth: 480,
    alignSelf: 'center' as const,
    width: '100%',
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.xxl + spacing.md,
  },
  logo: {
    fontFamily: fonts.heading,
    fontSize: 38,
    color: colors.accent,
    letterSpacing: 2,
  },
  subtitle: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.dim,
    marginTop: spacing.sm,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  form: {
    marginBottom: spacing.xl,
  },
  input: {
    fontFamily: fonts.regular,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.md + 2,
    paddingHorizontal: spacing.lg,
    fontSize: 16,
    color: colors.text,
    marginBottom: spacing.md,
  },
  error: {
    fontFamily: fonts.regular,
    color: colors.coral,
    fontSize: 13,
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    borderRadius: 100,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
    letterSpacing: 0.2,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: spacing.lg + spacing.xs,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  dividerText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginHorizontal: spacing.lg,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 100,
    paddingVertical: 16,
  },
  googleIcon: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.text,
    marginRight: spacing.sm,
  },
  googleButtonText: {
    fontFamily: fonts.medium,
    fontSize: 16,
    color: colors.text,
  },
  link: {
    fontFamily: fonts.regular,
    textAlign: 'center',
    color: colors.dim,
    fontSize: 14,
  },
  linkAccent: {
    color: colors.accent,
  },
  confirmedBanner: {
    backgroundColor: 'rgba(122, 239, 199, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(122, 239, 199, 0.3)',
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    marginBottom: spacing.lg,
    alignItems: 'center',
  },
  confirmedText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.accent,
  },
});
