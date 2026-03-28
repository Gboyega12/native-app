import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView,
  ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { colors, fonts, spacing, radius } from '@/theme';
import { BocyHero } from '@/components/Bocy';

export default function Welcome() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [loading, setLoading] = useState(false);
  const [firstNameFocused, setFirstNameFocused] = useState(false);
  const [lastNameFocused, setLastNameFocused] = useState(false);
  const [firstNameTouched, setFirstNameTouched] = useState(false);
  const firstNameError = firstNameTouched && !firstName.trim();

  // Track page view on mount
  useEffect(() => { trackScreen('Welcome'); }, []);

  const handleContinue = async () => {
    if (!firstName.trim()) return;
    setLoading(true);
    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
      const { error } = await supabase.auth.updateUser({ data: { full_name: fullName } });
      if (error) throw error;
      trackEvent('Onboarding Name Saved');
      router.replace('/(main)/education');
    } catch {
      setLoading(false);
      window.alert('Could not save your name. Please try again.');
    }
  };

  if (step === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.centerContent}>
          <View style={styles.heroWrap}>
            <BocyHero mood="happy" animate />
          </View>

          <Text style={styles.tagline}>MEET BOCY</Text>
          <Text style={styles.title}>Your personal{'\n'}finance companion</Text>
          <Text style={styles.subtitle}>
            Always watching, always working for you.
          </Text>

          {/* Dot separator */}
          <View style={styles.dotSeparator}>
            {Array.from({ length: 5 }).map((_, i) => (
              <View key={i} style={styles.dot} />
            ))}
          </View>

          <View style={styles.benefits}>
            <BenefitItem num="01" text="Finds the smartest move you can make right now" />
            <BenefitItem num="02" text="Builds a plan ranked by real impact" />
            <BenefitItem num="03" text="Guides you through each step" />
          </View>

          <TouchableOpacity style={styles.button} onPress={() => { trackEvent('Onboarding Get Started'); setStep(1); }} activeOpacity={0.8}>
            <Text style={styles.buttonText}>Get started</Text>
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
        contentContainerStyle={styles.centerContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.tagline}>YOUR NAME</Text>
        <Text style={styles.title}>What should{'\n'}Bocy call you?</Text>

        <View style={styles.form}>
          <View>
            <TextInput
              style={[
                styles.input,
                firstNameFocused && styles.inputFocused,
                firstNameError && styles.inputError,
              ]}
              placeholder="First name"
              placeholderTextColor={colors.muted}
              autoCapitalize="words"
              value={firstName}
              onChangeText={setFirstName}
              onFocus={() => setFirstNameFocused(true)}
              onBlur={() => { setFirstNameFocused(false); setFirstNameTouched(true); }}
            />
            {firstNameError && (
              <Text style={styles.errorText}>Please enter your first name</Text>
            )}
          </View>
          <TextInput
            style={[
              styles.input,
              lastNameFocused && styles.inputFocused,
            ]}
            placeholder="Last name (optional)"
            placeholderTextColor={colors.muted}
            autoCapitalize="words"
            value={lastName}
            onChangeText={setLastName}
            onFocus={() => setLastNameFocused(true)}
            onBlur={() => setLastNameFocused(false)}
          />
        </View>

        <TouchableOpacity
          style={[styles.button, (!firstName.trim() || loading) && styles.buttonDisabled]}
          onPress={handleContinue}
          disabled={!firstName.trim() || loading}
          activeOpacity={0.8}
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

function BenefitItem({ num, text }: { num: string; text: string }) {
  return (
    <View style={styles.benefitRow}>
      <Text style={styles.benefitNum}>{num}</Text>
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
    padding: spacing.xl + 4,
    paddingBottom: spacing.xxl + spacing.lg,
    maxWidth: 560,
    alignSelf: 'center' as const,
    width: '100%',
  },
  heroWrap: {
    alignItems: 'center',
    marginBottom: spacing.xl + spacing.sm,
  },
  tagline: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted,
    letterSpacing: 3,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 28,
    color: colors.text,
    textAlign: 'center',
    lineHeight: 36,
    marginBottom: spacing.md,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 22,
  },
  dotSeparator: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: spacing.lg,
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.border,
  },
  benefits: {
    marginBottom: spacing.xxl,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.lg,
    paddingLeft: spacing.xs,
  },
  benefitNum: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.green,
    letterSpacing: 1,
    width: 32,
    marginTop: 3,
  },
  benefitText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text2,
    flex: 1,
    lineHeight: 22,
  },
  form: {
    marginBottom: spacing.xl,
    gap: spacing.md,
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
  },
  inputFocused: {
    borderColor: colors.accent,
    borderWidth: 1.5,
  },
  inputError: {
    borderColor: colors.coral,
    borderWidth: 1.5,
  },
  errorText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.coral,
    marginTop: 4,
    marginLeft: 4,
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    borderRadius: 100,
    alignItems: 'center',
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
});
