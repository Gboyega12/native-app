import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';

export default function Welcome() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleContinue = async () => {
    if (!firstName.trim()) return;
    setLoading(true);
    const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
    await supabase.auth.updateUser({ data: { full_name: fullName } });
    setLoading(false);
    router.replace('/(main)/connect');
  };

  if (step === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.centerContent}>
          <Text style={styles.brandEmoji}>{'{ B }'}</Text>
          <Text style={styles.title}>Welcome to Bocy</Text>
          <Text style={styles.subtitle}>Your personal money advisor</Text>

          <View style={styles.benefits}>
            <BenefitItem text="See where your money really goes" />
            <BenefitItem text="Get a personalised financial profile" />
            <BenefitItem text="Actionable moves to improve your finances" />
          </View>

          <TouchableOpacity style={styles.button} onPress={() => setStep(1)}>
            <Text style={styles.buttonText}>Get started</Text>
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
        contentContainerStyle={styles.centerContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>What's your name?</Text>
        <Text style={styles.subtitle}>So we know what to call you</Text>

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="First name"
            placeholderTextColor={colors.muted}
            autoCapitalize="words"
            value={firstName}
            onChangeText={setFirstName}
          />
          <TextInput
            style={styles.input}
            placeholder="Last name (optional)"
            placeholderTextColor={colors.muted}
            autoCapitalize="words"
            value={lastName}
            onChangeText={setLastName}
          />
        </View>

        <TouchableOpacity
          style={[styles.button, (!firstName.trim() || loading) && styles.buttonDisabled]}
          onPress={handleContinue}
          disabled={!firstName.trim() || loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.buttonText}>Continue</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function BenefitItem({ text }: { text: string }) {
  return (
    <View style={styles.benefitRow}>
      <Text style={styles.benefitBullet}>&gt;</Text>
      <Text style={styles.benefitText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centerContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  brandEmoji: {
    fontFamily: fonts.mono,
    fontSize: 36,
    color: colors.accent,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    fontFamily: fonts.mono,
    fontSize: 24,
    color: colors.text,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: 14,
    color: colors.dim,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  benefits: {
    marginBottom: spacing.xxl,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  benefitBullet: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.accent,
    marginRight: spacing.sm,
    marginTop: 2,
  },
  benefitText: {
    fontSize: 15,
    color: colors.text2,
    flex: 1,
    lineHeight: 22,
  },
  form: {
    marginBottom: spacing.xl,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 16,
    color: colors.text,
    marginBottom: spacing.md,
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontFamily: fonts.mono,
    fontSize: 16,
    color: colors.bg,
    fontWeight: '700',
  },
});
