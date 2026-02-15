import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';

const SITUATIONS = [
  { key: 'in_debt', label: 'In debt' },
  { key: 'breaking_even', label: 'Breaking even' },
  { key: 'saving_slowly', label: 'Saving slowly' },
  { key: 'saving_well', label: 'Saving well' },
  { key: 'other', label: 'Other' },
];

const ONE_YEAR_GOALS = [
  { key: 'clear_debt', label: 'Clear debt' },
  { key: 'emergency_fund', label: 'Emergency fund' },
  { key: 'save_target', label: 'Savings target' },
  { key: 'reduce_spending', label: 'Reduce spending' },
  { key: 'invest', label: 'Start investing' },
  { key: 'other', label: 'Other' },
];

const TWO_YEAR_GOALS = [
  { key: 'buy_home', label: 'Buy a home' },
  { key: 'go_freelance', label: 'Go freelance' },
  { key: 'financial_freedom', label: 'Financial freedom' },
  { key: 'clear_debt', label: 'Clear all debt' },
  { key: 'invest', label: 'Grow investments' },
  { key: 'other', label: 'Other' },
];

export default function Goals() {
  const router = useRouter();
  const { csvData } = useLocalSearchParams<{ csvData: string }>();
  const [step, setStep] = useState(0);
  const [situation, setSituation] = useState('');
  const [oneYearGoal, setOneYearGoal] = useState('');
  const [twoYearGoal, setTwoYearGoal] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [loading, setLoading] = useState(false);

  const handleNext = async () => {
    if (step < 2) {
      setStep(step + 1);
      return;
    }

    // Final step — save goals
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from('goals').upsert({
        user_id: user.id,
        current_situation: situation,
        one_year_goal: oneYearGoal,
        two_year_goal: twoYearGoal,
        target_amount: targetAmount ? parseFloat(targetAmount) : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    }
    setLoading(false);
    router.push({ pathname: '/(main)/processing', params: { csvData } });
  };

  const currentSelection = step === 0 ? situation : step === 1 ? oneYearGoal : twoYearGoal;
  const canProceed = currentSelection !== '';

  const renderStep = () => {
    if (step === 0) {
      return (
        <>
          <Text style={styles.question}>How would you describe your current financial situation?</Text>
          {SITUATIONS.map((item) => (
            <OptionButton
              key={item.key}
              label={item.label}
              selected={situation === item.key}
              onPress={() => setSituation(item.key)}
            />
          ))}
        </>
      );
    }
    if (step === 1) {
      return (
        <>
          <Text style={styles.question}>What's your main goal for the next 12 months?</Text>
          {ONE_YEAR_GOALS.map((item) => (
            <OptionButton
              key={item.key}
              label={item.label}
              selected={oneYearGoal === item.key}
              onPress={() => setOneYearGoal(item.key)}
            />
          ))}
        </>
      );
    }
    return (
      <>
        <Text style={styles.question}>Where do you want to be in 2 years?</Text>
        {TWO_YEAR_GOALS.map((item) => (
          <OptionButton
            key={item.key}
            label={item.label}
            selected={twoYearGoal === item.key}
            onPress={() => setTwoYearGoal(item.key)}
          />
        ))}
        <TextInput
          style={styles.input}
          placeholder="Target amount (optional, e.g. 5000)"
          placeholderTextColor={colors.muted}
          keyboardType="numeric"
          value={targetAmount}
          onChangeText={setTargetAmount}
        />
      </>
    );
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.progress}>Step {step + 1} of 3</Text>
        {renderStep()}

        <TouchableOpacity
          style={[styles.button, (!canProceed || loading) && styles.buttonDisabled]}
          onPress={handleNext}
          disabled={!canProceed || loading}
        >
          {loading ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.buttonText}>
              {step < 2 ? 'Next' : 'Start analysis'}
            </Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function OptionButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.option, selected && styles.optionSelected]}
      onPress={onPress}
    >
      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{label}</Text>
    </TouchableOpacity>
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
  progress: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.accent,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: spacing.lg,
  },
  question: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: colors.text,
    fontWeight: '700',
    lineHeight: 26,
    marginBottom: spacing.xl,
  },
  option: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  optionSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDim,
  },
  optionText: {
    fontSize: 15,
    color: colors.text2,
  },
  optionTextSelected: {
    color: colors.accent,
    fontWeight: '600',
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 16,
    color: colors.text,
    marginTop: spacing.md,
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.xl,
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
