import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView,
  ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { colors, fonts, spacing, radius } from '@/theme';

export default function SignUp() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [verificationSent, setVerificationSent] = useState(false);
  const [resending, setResending] = useState(false);

  // Track page view on mount
  useEffect(() => { trackScreen('Sign Up'); }, []);

  const handleSignUp = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Please enter your email and password.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setError('');
    setLoading(true);
    const { error: authError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: 'https://app.bocy.io/',
      },
    });
    setLoading(false);
    if (authError) {
      setError(authError.message);
      trackEvent('Sign Up Failed', { method: 'email' });
    } else {
      setVerificationSent(true);
      trackEvent('Sign Up', { method: 'email' });
    }
  };

  const handleGoogleSignUp = async () => {
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
      trackEvent('Sign Up Failed', { method: 'google' });
    } else {
      trackEvent('Sign Up', { method: 'google' });
    }
  };

  const handleResend = async () => {
    setResending(true);
    try {
      const { error: resendError } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
      if (resendError) throw resendError;
    } catch {
      setError('Could not resend the email. Please try again.');
    }
    setResending(false);
  };

  if (verificationSent) {
    return (
      <View style={styles.container}>
        <View style={styles.centerContent}>
          <Text style={styles.checkmark}>{'{ }'}</Text>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.message}>
            We've sent a verification link to{'\n'}
            <Text style={{ color: colors.accent }}>{email}</Text>
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={handleResend}
            disabled={resending}
          >
            <Text style={styles.secondaryButtonText}>
              {resending ? 'Sending...' : 'Resend email'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.replace('/(auth)/sign-in')}>
            <Text style={styles.link}>Back to sign in</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.title}>Create account</Text>
          <Text style={styles.subtitle}>AI-powered financial strategy</Text>
        </View>

        <View style={styles.form}>
          <TouchableOpacity
            style={[styles.googleButton, googleLoading && styles.buttonDisabled]}
            onPress={handleGoogleSignUp}
            disabled={loading || googleLoading}
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

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.muted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            value={email}
            onChangeText={setEmail}
          />
          <TextInput
            style={styles.input}
            placeholder="Password (min 6 characters)"
            placeholderTextColor={colors.muted}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleSignUp}
            disabled={loading || googleLoading}
          >
            {loading ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.buttonText}>Sign up</Text>
            )}
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={() => router.replace('/(auth)/sign-in')}>
          <Text style={styles.link}>
            Already have an account? <Text style={styles.linkAccent}>Sign in</Text>
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
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl + 4,
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.xxl + spacing.md,
  },
  checkmark: {
    fontFamily: fonts.heading,
    fontSize: 48,
    color: colors.accent,
    marginBottom: spacing.lg,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 26,
    color: colors.text,
    marginBottom: spacing.sm,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.dim,
    marginTop: spacing.sm,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  message: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: spacing.xl,
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
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl,
    borderRadius: 100,
    marginBottom: spacing.lg,
  },
  secondaryButtonText: {
    fontFamily: fonts.medium,
    fontSize: 14,
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
});
