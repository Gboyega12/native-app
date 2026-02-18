import { useState, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Animated,
  Dimensions, Alert, ActivityIndicator, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import type {
  WorkSetup, HouseholdType, HousingStatus, FinancialExperience,
  RiskAppetite, Priority, UpcomingEvent, Dependent,
} from '@/lib/types';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const { width } = Dimensions.get('window');
const CARD_GAP = 10;
const CARD_WIDTH = (width - spacing.xl * 2 - CARD_GAP) / 2;

// ── Screen definitions ──

type CardOption = {
  key: string;
  label: string;
  desc: string;
  icon: string;
};

type ScreenDef = {
  question: string;
  hint: string;
  multiSelect?: boolean;
  maxSelect?: number;
  skippable?: boolean;
  options: CardOption[];
};

const SCREENS: ScreenDef[] = [
  // 0: Work setup
  {
    question: "What's your work setup?",
    hint: 'This shapes your commute, energy, and income pattern',
    options: [
      { key: 'office', label: 'Office (5 days)', desc: 'Full-time in the office', icon: '|O|' },
      { key: 'hybrid', label: 'Hybrid', desc: '2-3 days office, rest at home', icon: '<>' },
      { key: 'remote', label: 'Remote / WFH', desc: 'Work from home full-time', icon: '/\\' },
      { key: 'self_employed', label: 'Self-employed', desc: 'Freelance or own business', icon: '*' },
      { key: 'student', label: 'Student', desc: 'Full or part-time education', icon: '^' },
      { key: 'multiple_jobs', label: 'Multiple jobs', desc: 'More than one income source', icon: '++' },
    ],
  },
  // 1: Household
  {
    question: "Who's in your household?",
    hint: 'This completely changes what "essential" means',
    options: [
      { key: 'single', label: 'Just me', desc: 'Living solo', icon: 'I' },
      { key: 'couple_shared', label: 'Couple (shared)', desc: 'Partner, shared finances', icon: '&&' },
      { key: 'couple_separate', label: 'Couple (separate)', desc: 'Partner, separate finances', icon: '||' },
      { key: 'family', label: 'Family', desc: 'Partner and children', icon: '::]' },
      { key: 'single_parent', label: 'Single parent', desc: 'Just me and the kids', icon: ':..' },
      { key: 'shared_house', label: 'Shared house', desc: 'Flatmates or house-share', icon: '[]' },
    ],
  },
  // 2: Housing
  {
    question: "What's your housing situation?",
    hint: 'Affects your biggest expense category',
    options: [
      { key: 'renting', label: 'Renting', desc: 'Private rental', icon: '[R]' },
      { key: 'mortgage', label: 'Mortgage', desc: 'Own with mortgage', icon: '[M]' },
      { key: 'with_family', label: 'With family', desc: 'Living at home', icon: '[F]' },
      { key: 'shared_house', label: 'Shared house', desc: 'Splitting rent with others', icon: '[S]' },
      { key: 'council', label: 'Council / Social', desc: 'Council or social housing', icon: '[C]' },
    ],
  },
  // 3: Financial experience
  {
    question: "What's your money experience?",
    hint: 'This adjusts the depth of our recommendations',
    options: [
      { key: 'beginner', label: 'Just getting started', desc: 'New to managing money', icon: '.' },
      { key: 'basics', label: 'Know the basics', desc: 'Budget, save, basic investing', icon: '..' },
      { key: 'confident', label: 'Pretty confident', desc: 'ISAs, pensions, tax planning', icon: '...' },
      { key: 'advanced', label: 'Advanced', desc: 'Multi-asset, tax optimisation', icon: ':::' },
    ],
  },
  // 4: Priorities (multi-select, top 2)
  {
    question: 'What matters most right now?',
    hint: 'Pick your top 2 — this ranks every recommendation',
    multiSelect: true,
    maxSelect: 2,
    options: [
      { key: 'security', label: 'Security', desc: 'Buffer, insurance, stability', icon: '( )' },
      { key: 'freedom', label: 'Freedom', desc: 'Flexibility, no obligations', icon: '~' },
      { key: 'growth', label: 'Grow wealth', desc: 'Investing, ISAs, pension', icon: '//' },
      { key: 'experiences', label: 'Enjoy life', desc: 'Travel, hobbies, lifestyle', icon: '-->' },
      { key: 'family', label: 'Family first', desc: "Children's future, partner goals", icon: '<3' },
    ],
  },
  // 5: Upcoming events (multi-select, skippable)
  {
    question: 'Anything big coming up?',
    hint: 'These create time-sensitive moves — skip if nothing planned',
    multiSelect: true,
    skippable: true,
    options: [
      { key: 'moving', label: 'Moving home', desc: 'New rental or relocation', icon: '->' },
      { key: 'baby', label: 'Baby on the way', desc: 'Starting or growing family', icon: ':)' },
      { key: 'wedding', label: 'Wedding', desc: 'Planning a wedding', icon: '**' },
      { key: 'career_change', label: 'Career change', desc: 'New job or going freelance', icon: '><' },
      { key: 'first_home', label: 'Buying first home', desc: 'Saving for a deposit', icon: '^_' },
      { key: 'business', label: 'Starting a business', desc: 'Building something new', icon: '!!' },
      { key: 'retirement', label: 'Retirement', desc: 'Planning for retirement', icon: '==' },
      { key: 'none', label: 'Nothing specific', desc: 'Just optimising', icon: '--' },
    ],
  },
  // 6: Risk appetite
  {
    question: 'How do you feel about financial risk?',
    hint: 'Affects investment and savings recommendations',
    options: [
      { key: 'conservative', label: 'Protect it', desc: 'Keep what I have safe', icon: '[ ]' },
      { key: 'balanced', label: 'Balanced', desc: 'Mix of safety and growth', icon: '[=]' },
      { key: 'growth', label: 'Grow it', desc: 'Happy to take risks for returns', icon: '[+]' },
    ],
  },
  // 7: Dependents (multi-select, skippable)
  {
    question: 'Any dependents?',
    hint: 'Affects buffer sizing and protection priorities',
    multiSelect: true,
    skippable: true,
    options: [
      { key: 'none', label: 'None', desc: 'Just looking after myself', icon: '-' },
      { key: 'young_children', label: 'Young children', desc: 'Under 12', icon: ':.' },
      { key: 'teenagers', label: 'Teenagers', desc: '12-18', icon: ':..' },
      { key: 'elderly_parents', label: 'Elderly parents', desc: 'Supporting parents', icon: '..:' },
      { key: 'pets', label: 'Pets', desc: 'Vet bills and insurance', icon: '~.' },
    ],
  },
];

const TOTAL_STEPS = SCREENS.length + 1; // +1 for summary

export default function Identity() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  // State for each screen's selection
  const [workSetup, setWorkSetup] = useState<string>('');
  const [household, setHousehold] = useState<string>('');
  const [housing, setHousing] = useState<string>('');
  const [experience, setExperience] = useState<string>('');
  const [priorities, setPriorities] = useState<string[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [risk, setRisk] = useState<string>('');
  const [dependents, setDependents] = useState<string[]>([]);

  const selections = [workSetup, household, housing, experience, priorities, events, risk, dependents];
  const setters = [setWorkSetup, setHousehold, setHousing, setExperience, setPriorities, setEvents, setRisk, setDependents];

  const isSummary = step === SCREENS.length;
  const currentScreen = !isSummary ? SCREENS[step] : null;

  // Current selection for this step
  const currentValue = selections[step];
  const isMulti = currentScreen?.multiSelect;

  const canProceed = (() => {
    if (isSummary) return true;
    if (currentScreen?.skippable) return true;
    if (isMulti) return (currentValue as string[]).length > 0;
    return (currentValue as string) !== '';
  })();

  const handleSelect = (key: string) => {
    if (isMulti) {
      const arr = currentValue as string[];
      const setter = setters[step] as React.Dispatch<React.SetStateAction<string[]>>;
      if (key === 'none') {
        // "None" clears other selections
        setter(['none']);
        return;
      }
      const without = arr.filter((k) => k !== 'none'); // remove 'none' if selecting something else
      if (without.includes(key)) {
        setter(without.filter((k) => k !== key));
      } else {
        const max = currentScreen?.maxSelect;
        if (max && without.length >= max) {
          // Replace oldest selection
          setter([...without.slice(1), key]);
        } else {
          setter([...without, key]);
        }
      }
    } else {
      (setters[step] as React.Dispatch<React.SetStateAction<string>>)(key);
    }
  };

  const isSelected = (key: string): boolean => {
    if (isMulti) return (currentValue as string[]).includes(key);
    return currentValue === key;
  };

  const animateStep = (next: number) => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => {
      setStep(next);
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    });
  };

  const handleNext = () => {
    if (isSummary) {
      saveAndContinue();
      return;
    }
    animateStep(step + 1);
  };

  const handleBack = () => {
    if (step > 0) animateStep(step - 1);
  };

  const handleSkip = () => {
    if (currentScreen?.skippable) {
      if (isMulti) {
        (setters[step] as React.Dispatch<React.SetStateAction<string[]>>)(['none']);
      }
      animateStep(step + 1);
    }
  };

  const saveAndContinue = async () => {
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        // Save identity to Supabase
        await supabase.from('user_identity').upsert({
          user_id: user.id,
          work_setup: workSetup,
          household,
          housing,
          financial_experience: experience,
          risk_appetite: risk,
          priorities,
          upcoming_events: events.filter((e) => e !== 'none'),
          dependents: dependents.filter((d) => d !== 'none'),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });

        // Also save backward-compatible goals from identity data
        const situationMap: Record<string, string> = {
          beginner: 'breaking_even',
          basics: 'saving_slowly',
          confident: 'saving_well',
          advanced: 'saving_well',
        };
        const priorityGoalMap: Record<string, string> = {
          security: 'emergency_fund',
          freedom: 'reduce_spending',
          growth: 'invest',
          experiences: 'save_target',
          family: 'save_target',
        };
        const eventGoalMap: Record<string, string> = {
          first_home: 'buy_home',
          business: 'go_freelance',
          retirement: 'financial_freedom',
          career_change: 'go_freelance',
          moving: 'save_target',
          baby: 'save_target',
          wedding: 'save_target',
        };

        const oneYearGoal = priorityGoalMap[priorities[0]] || 'save_target';
        const activeEvent = events.find((e) => e !== 'none');
        const twoYearGoal = activeEvent ? (eventGoalMap[activeEvent] || 'financial_freedom') : 'financial_freedom';

        await supabase.from('goals').upsert({
          user_id: user.id,
          current_situation: situationMap[experience] || 'other',
          one_year_goal: oneYearGoal,
          two_year_goal: twoYearGoal,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
      }
      router.push('/(main)/connect');
    } catch (err: any) {
      console.warn('[identity] Save failed:', err?.message);
      Alert.alert('Error', 'Could not save. Please try again.');
      setSaving(false);
    }
  };

  // ── Summary screen ──
  if (isSummary) {
    const summaryItems = [
      { label: 'Work', value: findLabel(0, workSetup) },
      { label: 'Household', value: findLabel(1, household) },
      { label: 'Housing', value: findLabel(2, housing) },
      { label: 'Experience', value: findLabel(3, experience) },
      { label: 'Priorities', value: priorities.map((p) => findLabel(4, p)).join(', ') },
      { label: 'Coming up', value: events.filter((e) => e !== 'none').map((e) => findLabel(5, e)).join(', ') || 'Nothing specific' },
      { label: 'Risk', value: findLabel(6, risk) },
      { label: 'Dependents', value: dependents.filter((d) => d !== 'none').map((d) => findLabel(7, d)).join(', ') || 'None' },
    ];

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.summaryScroll}>
          {/* Progress */}
          <View style={styles.progressRow}>
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
              <View key={i} style={[styles.progressDot, i <= step && styles.progressDotActive]} />
            ))}
          </View>

          <Text style={styles.summaryTitle}>Here's what we know</Text>
          <Text style={styles.summarySubtitle}>
            Every recommendation will be shaped by this. Tap any item to change it.
          </Text>

          {summaryItems.map((item, i) => (
            <TouchableOpacity
              key={i}
              style={styles.summaryCard}
              onPress={() => animateStep(i)}
              activeOpacity={0.7}
            >
              <Text style={styles.summaryLabel}>{item.label}</Text>
              <Text style={styles.summaryValue}>{item.value}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.bottomArea}>
          <TouchableOpacity
            style={[styles.button, saving && styles.buttonDisabled]}
            onPress={handleNext}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.buttonText}>Connect your accounts</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Card selection screen ──
  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Progress */}
        <View style={styles.progressRow}>
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <View key={i} style={[styles.progressDot, i <= step && styles.progressDotActive]} />
          ))}
        </View>

        {/* Back button */}
        {step > 0 && (
          <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
            <Text style={styles.backText}>{'\u2190'} Back</Text>
          </TouchableOpacity>
        )}

        <Animated.View style={{ opacity: fadeAnim }}>
          {/* Question */}
          <Text style={styles.question}>{currentScreen!.question}</Text>
          <Text style={styles.hint}>{currentScreen!.hint}</Text>

          {/* Cards grid */}
          <View style={styles.grid}>
            {currentScreen!.options.map((opt) => {
              const sel = isSelected(opt.key);
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={[styles.card, sel && styles.cardSelected]}
                  onPress={() => handleSelect(opt.key)}
                  activeOpacity={0.7}
                >
                  {/* Checkbox for multi-select screens */}
                  {isMulti && (
                    <View style={[styles.checkbox, sel && styles.checkboxSelected]}>
                      {sel && <Text style={styles.checkboxMark}>{'\u2713'}</Text>}
                    </View>
                  )}
                  <View style={[styles.cardIcon, sel && styles.cardIconSelected]}>
                    <Text style={[styles.cardIconText, sel && styles.cardIconTextSelected]}>
                      {opt.icon}
                    </Text>
                  </View>
                  <Text style={[styles.cardLabel, sel && styles.cardLabelSelected]}>
                    {opt.label}
                  </Text>
                  <Text style={styles.cardDesc}>{opt.desc}</Text>
                  {!isMulti && sel && <View style={styles.checkBadge}><Text style={styles.checkMark}>{'\u2713'}</Text></View>}
                </TouchableOpacity>
              );
            })}
          </View>
        </Animated.View>
      </ScrollView>

      {/* Bottom: skip + next */}
      <View style={styles.bottomArea}>
        {currentScreen?.skippable && (
          <TouchableOpacity style={styles.skipBtn} onPress={handleSkip}>
            <Text style={styles.skipText}>Skip for now</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.button, !canProceed && styles.buttonDisabled]}
          onPress={handleNext}
          disabled={!canProceed}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>
            {isMulti && (currentValue as string[]).length > 0
              ? `Continue (${(currentValue as string[]).filter((v) => v !== 'none').length} selected)`
              : 'Continue'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function findLabel(screenIdx: number, key: string): string {
  return SCREENS[screenIdx]?.options.find((o) => o.key === key)?.label || key;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.xl, paddingTop: spacing.xxl + spacing.md, paddingBottom: spacing.lg },
  summaryScroll: { padding: spacing.xl, paddingTop: spacing.xxl + spacing.md, paddingBottom: spacing.lg },

  // ── Progress ──
  progressRow: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: spacing.lg,
    justifyContent: 'center',
  },
  progressDot: {
    width: 24,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.muted,
  },
  progressDotActive: {
    backgroundColor: colors.accent,
  },

  // ── Back ──
  backBtn: { marginBottom: spacing.md },
  backText: { fontFamily: fonts.medium, fontSize: 14, color: colors.accent },

  // ── Question ──
  question: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginBottom: spacing.xl,
    lineHeight: 19,
  },

  // ── Card grid ──
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: CARD_GAP,
  },
  card: {
    width: CARD_WIDTH,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    position: 'relative',
  },
  cardSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDim,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  cardIconSelected: {
    backgroundColor: colors.accent,
  },
  cardIconText: {
    fontFamily: fonts.heading,
    fontSize: 13,
    color: colors.dim,
  },
  cardIconTextSelected: {
    color: colors.bg,
  },
  cardLabel: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
    marginBottom: 3,
  },
  cardLabelSelected: {
    color: colors.accent,
  },
  cardDesc: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
    lineHeight: 15,
  },
  checkbox: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.muted,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  checkboxSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  checkboxMark: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.bg,
    marginTop: -1,
  },
  checkBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkMark: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.bg,
  },

  // ── Summary ──
  summaryTitle: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  summarySubtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    marginBottom: spacing.xl,
    lineHeight: 20,
  },
  summaryCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryLabel: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.dim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    width: 90,
  },
  summaryValue: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.accent,
    flex: 1,
    textAlign: 'right',
  },

  // ── Bottom area ──
  bottomArea: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
    paddingTop: spacing.sm,
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: 10,
    marginBottom: spacing.xs,
  },
  skipText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.dim,
  },
});
