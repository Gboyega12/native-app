import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView,
  Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import { BocyHero } from '@/components/Bocy';

export default function Welcome() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleContinue = async () => {
    if (!firstName.trim()) return;
    setLoading(true);
    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
      const { error } = await supabase.auth.updateUser({ data: { full_name: fullName } });
      if (error) throw error;
      router.replace('/(main)/education');
    } catch {
      setLoading(false);
      Alert.alert('Error', 'Could not save your name. Please try again.');
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

          <TouchableOpacity style={styles.button} onPress={() => setStep(1)} activeOpacity={0.8}>
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
        <Text style={styles.tagline}>YOUR NAME</Text>
        <Text style={styles.title}>What should{'\n'}Bocy call you?</Text>

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
