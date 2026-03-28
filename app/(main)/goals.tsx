import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { colors, fonts, spacing, radius } from '@/theme';
import { AnimGlyph, BreathingBar } from '@/components/Card';
import { hapticLight } from '@/lib/haptics';

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

const TIMELINES = [
  { key: '6_months', label: '6 months' },
  { key: '1_year', label: '1 year' },
  { key: '2_years', label: '2 years' },
  { key: '3_5_years', label: '3-5 years' },
];

export default function Goals() {
  const router = useRouter();
  const { csvData, from } = useLocalSearchParams<{ csvData?: string; from?: string }>();
  const [step, setStep] = useState(0);
  const [situation, setSituation] = useState('');
  const [oneYearGoal, setOneYearGoal] = useState('');
  const [twoYearGoal, setTwoYearGoal] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [goalTimeline, setGoalTimeline] = useState('');
  const [loading, setLoading] = useState(false);
  const TOTAL_STEPS = 4;

  // Track page view on mount
  useEffect(() => { trackScreen('Goals'); }, []);

  // Preload existing goals when editing from profile
  useEffect(() => {
    if (from !== 'profile') return;
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const { data } = await supabase
          .from('goals')
          .select('current_situation, one_year_goal, two_year_goal, target_amount, goal_timeline')
          .eq('user_id', user.id)
          .maybeSingle();
        if (data) {
          if (data.current_situation) setSituation(data.current_situation);
          if (data.one_year_goal) setOneYearGoal(data.one_year_goal);
          if (data.two_year_goal) setTwoYearGoal(data.two_year_goal);
          if (data.target_amount) setTargetAmount(String(data.target_amount));
          if (data.goal_timeline) setGoalTimeline(data.goal_timeline);
        }
      } catch {}
    })();
  }, [from]);

  const handleNext = async () => {
    if (step < TOTAL_STEPS - 1) {
      trackEvent('Goals Step Completed', { step: step + 1 });
      setStep(step + 1);
      return;
    }

    // Final step — save goals
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { error } = await supabase.from('goals').upsert({
          user_id: user.id,
          current_situation: situation,
          one_year_goal: oneYearGoal,
          two_year_goal: twoYearGoal,
          target_amount: targetAmount ? parseFloat(targetAmount) : null,
          goal_timeline: goalTimeline || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
        if (error) console.warn('[goals] upsert failed:', error.message);
      }
      trackEvent('Goals Completed', { situation, one_year_goal: oneYearGoal, two_year_goal: twoYearGoal, goal_timeline: goalTimeline });
      if (from === 'profile') {
        router.replace('/(main)/profile');
      } else {
        router.push({ pathname: '/(main)/processing', params: { csvData } });
      }
    } catch {
      setLoading(false);
      window.alert('Could not save your goals. Please try again.');
    }
  };

  const currentSelection = step === 0 ? situation : step === 1 ? oneYearGoal : step === 2 ? twoYearGoal : goalTimeline;
  const canProceed = currentSelection !== '';

  const renderStep = () => {
    if (step === 0) {
      return (
        <>
          <Text style={styles.question}>How would you describe your current financial situation?</Text>
          {SITUATIONS.map((item, i) => (
            <OptionButton
              key={item.key}
              label={item.label}
              selected={situation === item.key}
              onPress={() => setSituation(item.key)}
              index={i}
            />
          ))}
        </>
      );
    }
    if (step === 1) {
      return (
        <>
          <Text style={styles.question}>What's your main goal for the next 12 months?</Text>
          {ONE_YEAR_GOALS.map((item, i) => (
            <OptionButton
              key={item.key}
              label={item.label}
              selected={oneYearGoal === item.key}
              onPress={() => setOneYearGoal(item.key)}
              index={i}
            />
          ))}
        </>
      );
    }
    if (step === 2) {
      return (
        <>
          <Text style={styles.question}>Where do you want to be in 2 years?</Text>
          {TWO_YEAR_GOALS.map((item, i) => (
            <OptionButton
              key={item.key}
              label={item.label}
              selected={twoYearGoal === item.key}
              onPress={() => setTwoYearGoal(item.key)}
              index={i}
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
    }
    return (
      <>
        <Text style={styles.question}>When do you want to achieve this?</Text>
        {TIMELINES.map((item, i) => (
          <OptionButton
            key={item.key}
            label={item.label}
            selected={goalTimeline === item.key}
            onPress={() => setGoalTimeline(item.key)}
            index={i}
          />
        ))}
      </>
    );
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.progress}>Step {step + 1} of {TOTAL_STEPS}</Text>
        {/* Step progress bar */}
        <View style={{ height: 3, borderRadius: 1.5, backgroundColor: colors.border, overflow: 'hidden', marginBottom: spacing.xl }}>
          <BreathingBar
            color={colors.accent}
            width={`${Math.round(((step + 1) / TOTAL_STEPS) * 100)}%`}
            style={{ height: '100%', borderRadius: 1.5 }}
          />
        </View>
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
              {step < TOTAL_STEPS - 1 ? 'Next' : from === 'profile' ? 'Save goals' : 'Start analysis'}
            </Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function OptionButton({ label, selected, onPress, index = 0 }: { label: string; selected: boolean; onPress: () => void; index?: number }) {
  return (
    <AnimGlyph delay={index * 50}>
      <TouchableOpacity
        style={[styles.option, selected && styles.optionSelected]}
        onPress={() => { hapticLight(); onPress(); }}
      >
        <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{label}</Text>
      </TouchableOpacity>
    </AnimGlyph>
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
    maxWidth: 560,
    alignSelf: 'center' as const,
    width: '100%',
  },
  progress: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.accent,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: spacing.xl,
  },
  question: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.text,
    lineHeight: 28,
    marginBottom: spacing.xl + spacing.sm,
    letterSpacing: -0.3,
  },
  option: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingVertical: 16,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm + 2,
  },
  optionSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDim,
  },
  optionText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text2,
  },
  optionTextSelected: {
    fontFamily: fonts.semibold,
    color: colors.accent,
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
    marginTop: spacing.lg,
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    borderRadius: 100,
    alignItems: 'center',
    marginTop: spacing.xl + spacing.sm,
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
