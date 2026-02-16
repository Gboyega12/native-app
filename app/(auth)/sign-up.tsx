import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';

export default function SignUp() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [verificationSent, setVerificationSent] = useState(false);
  const [resending, setResending] = useState(false);

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
        emailRedirectTo: 'https://native-app-ashy.vercel.app/',
      },
    });
    setLoading(false);
    if (authError) {
      setError(authError.message);
    } else {
      setVerificationSent(true);
    }
  };

  const handleResend = async () => {
    setResending(true);
    await supabase.auth.resend({ type: 'signup', email: email.trim() });
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
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
            disabled={loading}
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
    padding: spacing.xl,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.xxl,
  },
  checkmark: {
    fontFamily: fonts.heading,
    fontSize: 48,
    color: colors.accent,
    marginBottom: spacing.lg,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    marginTop: spacing.xs,
  },
  message: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 22,
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
    borderRadius: radius.md,
    padding: spacing.md,
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
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
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
