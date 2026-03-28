import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Animated,
  ActivityIndicator, LayoutAnimation,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { colors, fonts, spacing, radius } from '@/theme';
import { AnimGlyph } from '@/components/Card';
import { hapticLight } from '@/lib/haptics';

const CARD_GAP = 10;

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

// Same screens as onboarding identity.tsx
const SCREENS: ScreenDef[] = [
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
  {
    question: "What's your annual income?",
    hint: 'This unlocks precise tax and pension recommendations',
    options: [
      { key: 'under_30k', label: 'Under £30k', desc: 'Below the higher-rate threshold', icon: '.' },
      { key: '30k_50k', label: '£30k – £50k', desc: 'Approaching higher-rate tax', icon: '..' },
      { key: '50k_100k', label: '£50k – £100k', desc: 'Higher-rate taxpayer', icon: '...' },
      { key: 'over_100k', label: 'Over £100k', desc: 'Personal allowance taper zone', icon: ':::' },
    ],
    skippable: true,
  },
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
  {
    question: 'How do you feel about financial risk?',
    hint: 'Affects investment and savings recommendations',
    options: [
      { key: 'conservative', label: 'Protect it', desc: 'Keep what I have safe', icon: '[ ]' },
      { key: 'balanced', label: 'Balanced', desc: 'Mix of safety and growth', icon: '[=]' },
      { key: 'growth', label: 'Grow it', desc: 'Happy to take risks for returns', icon: '[+]' },
    ],
  },
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

export default function Goals() {
  const router = useRouter();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const isEdit = from === 'profile';
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const scrollRef = useRef<ScrollView>(null);

  // State for each screen's selection
  const [workSetup, setWorkSetup] = useState<string>('');
  const [household, setHousehold] = useState<string>('');
  const [housing, setHousing] = useState<string>('');
  const [experience, setExperience] = useState<string>('');
  const [incomeBand, setIncomeBand] = useState<string>('');
  const [priorities, setPriorities] = useState<string[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [eventTimelines, setEventTimelines] = useState<Record<string, number | null>>({});
  const [risk, setRisk] = useState<string>('');
  const [dependents, setDependents] = useState<string[]>([]);

  useEffect(() => { trackScreen('Goals'); }, []);

  // Preload existing identity data when editing from profile
  useEffect(() => {
    if (!isEdit) return;
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setLoading(false); return; }
        const { data } = await supabase
          .from('user_identity')
          .select('work_setup, household, housing, financial_experience, risk_appetite, priorities, upcoming_events, dependents, income_band')
          .eq('user_id', user.id)
          .maybeSingle();
        if (data) {
          if (data.work_setup) setWorkSetup(data.work_setup);
          if (data.household) setHousehold(data.household);
          if (data.housing) setHousing(data.housing);
          if (data.financial_experience) setExperience(data.financial_experience);
          if (data.income_band) setIncomeBand(data.income_band);
          if (data.risk_appetite) setRisk(data.risk_appetite);
          if (Array.isArray(data.priorities)) setPriorities(data.priorities);
          if (Array.isArray(data.dependents) && data.dependents.length > 0) {
            setDependents(data.dependents);
          }
          if (Array.isArray(data.upcoming_events)) {
            const eventKeys: string[] = [];
            const timelines: Record<string, number | null> = {};
            for (const e of data.upcoming_events) {
              if (typeof e === 'string') {
                eventKeys.push(e);
              } else if (e && typeof e === 'object' && 'type' in e) {
                eventKeys.push(e.type);
                if (e.months_away != null) timelines[e.type] = e.months_away;
              }
            }
            if (eventKeys.length > 0) setEvents(eventKeys);
            if (Object.keys(timelines).length > 0) setEventTimelines(timelines);
          }
        }
      } catch {}
      setLoading(false);
    })();
  }, [isEdit]);

  const selections = [workSetup, household, housing, experience, incomeBand, priorities, events, risk, dependents];
  const setters = [setWorkSetup, setHousehold, setHousing, setExperience, setIncomeBand, setPriorities, setEvents, setRisk, setDependents];

  const isSummary = step === SCREENS.length;
  const currentScreen = !isSummary ? SCREENS[step] : null;
  const currentValue = selections[step];
  const isMulti = currentScreen?.multiSelect;

  const canProceed = (() => {
    if (isSummary) return true;
    if (currentScreen?.skippable) return true;
    if (isMulti) return (currentValue as string[]).length > 0;
    return (currentValue as string) !== '';
  })();

  const handleSelect = (key: string) => {
    if (step === 6 && ['baby', 'moving', 'wedding'].includes(key)) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }
    if (isMulti) {
      const arr = currentValue as string[];
      const setter = setters[step] as React.Dispatch<React.SetStateAction<string[]>>;
      if (key === 'none') {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setter(['none']);
        return;
      }
      const without = arr.filter((k) => k !== 'none');
      if (without.includes(key)) {
        setter(without.filter((k) => k !== key));
      } else {
        const max = currentScreen?.maxSelect;
        if (max && without.length >= max) {
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
    trackEvent('Goals Step Completed', { step: step + 1 });
    animateStep(step + 1);
  };

  const handleBack = () => {
    if (step > 0) {
      animateStep(step - 1);
    } else if (isEdit) {
      router.back();
    }
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
          upcoming_events: events.filter((e) => e !== 'none').map((e) => {
            const months = eventTimelines[e];
            return months != null ? { type: e, months_away: months } : e;
          }),
          dependents: dependents.filter((d) => d !== 'none'),
          income_band: incomeBand || null,
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
      trackEvent('Goals Saved', {
        from: isEdit ? 'profile' : 'onboarding',
        work_setup: workSetup,
        household,
        housing,
        financial_experience: experience,
        risk_appetite: risk,
      });
      if (isEdit) {
        router.replace('/(main)/profile');
      } else {
        router.push('/(main)/connect');
      }
    } catch (err: any) {
      console.warn('[goals] Save failed:', err?.message);
      window.alert('Could not save. Please try again.');
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  // ── Summary screen ──
  if (isSummary) {
    const summaryItems = [
      { label: 'Work', value: findLabel(0, workSetup) },
      { label: 'Household', value: findLabel(1, household) },
      { label: 'Housing', value: findLabel(2, housing) },
      { label: 'Experience', value: findLabel(3, experience) },
      { label: 'Income', value: incomeBand ? findLabel(4, incomeBand) : 'Skipped' },
      { label: 'Priorities', value: priorities.map((p) => findLabel(5, p)).join(', ') || 'None' },
      { label: 'Coming up', value: events.filter((e) => e !== 'none').map((e) => findLabel(6, e)).join(', ') || 'Nothing specific' },
      { label: 'Risk', value: findLabel(7, risk) },
      { label: 'Dependents', value: dependents.filter((d) => d !== 'none').map((d) => findLabel(8, d)).join(', ') || 'None' },
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

          {/* Back button */}
          <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
            <Text style={styles.backText}>{'\u2190'} Back</Text>
          </TouchableOpacity>

          <Text style={styles.summaryTitle}>{isEdit ? 'Review your changes' : "Here's what we know"}</Text>
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
              <Text style={styles.buttonText}>{isEdit ? 'Save changes' : 'Connect your accounts'}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Card selection screen ──
  return (
    <View style={styles.container}>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Progress */}
        <View style={styles.progressRow}>
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <View key={i} style={[styles.progressDot, i <= step && styles.progressDotActive]} />
          ))}
        </View>

        {/* Back button */}
        <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
          <Text style={styles.backText}>{'\u2190'} Back</Text>
        </TouchableOpacity>

        <Animated.View style={{ opacity: fadeAnim }}>
          {/* Question */}
          <Text style={styles.question}>{currentScreen!.question}</Text>
          <Text style={styles.hint}>{currentScreen!.hint}</Text>

          {/* Cards grid */}
          <View style={styles.grid}>
            {currentScreen!.options.map((opt, optIdx) => {
              const sel = isSelected(opt.key);
              return (
                <AnimGlyph key={opt.key} delay={optIdx * 50}>
                  <TouchableOpacity
                    style={[styles.card, sel && styles.cardSelected]}
                    onPress={() => { hapticLight(); handleSelect(opt.key); }}
                    activeOpacity={0.7}
                  >
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
                </AnimGlyph>
              );
            })}
          </View>

          {/* Timeline picker for events */}
          {step === 6 && (() => {
            const TIMELINE_EVENTS = ['baby', 'moving', 'wedding'];
            const TIMELINE_OPTIONS = [
              { label: '1\u20132 months', value: 1.5 },
              { label: '3\u20135 months', value: 4 },
              { label: '6\u20139 months', value: 7.5 },
              { label: 'Not sure', value: null },
            ];
            const selectedTimeline = events.filter((e) => e !== 'none' && TIMELINE_EVENTS.includes(e));
            if (selectedTimeline.length === 0) return null;
            return (
              <View
                style={styles.timelineSection}
                onLayout={() => {
                  setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
                }}
              >
                <View style={styles.timelineDivider} />
                {selectedTimeline.map((eventKey) => (
                  <View key={eventKey} style={{ marginBottom: 12 }}>
                    <Text style={styles.timelineLabel}>
                      {eventKey === 'baby' ? 'Baby' : eventKey === 'moving' ? 'Moving' : 'Wedding'} — roughly when?
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                      {TIMELINE_OPTIONS.map((opt) => {
                        const current = eventTimelines[eventKey];
                        const isSel = current === opt.value;
                        return (
                          <TouchableOpacity
                            key={opt.label}
                            onPress={() => {
                              hapticLight();
                              setEventTimelines((prev) => ({ ...prev, [eventKey]: opt.value }));
                            }}
                            style={{
                              paddingHorizontal: 14, paddingVertical: 8,
                              borderRadius: radius.sm,
                              backgroundColor: isSel ? colors.accent : colors.card,
                              borderWidth: 1,
                              borderColor: isSel ? colors.accent : colors.border,
                            }}
                          >
                            <Text style={{
                              fontFamily: fonts.medium, fontSize: 13,
                              color: isSel ? colors.bg : colors.muted,
                            }}>{opt.label}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                ))}
              </View>
            );
          })()}
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
  scroll: { padding: spacing.xl + 4, paddingTop: spacing.xxl + spacing.lg, paddingBottom: spacing.lg, maxWidth: 640, alignSelf: 'center' as const, width: '100%' },
  summaryScroll: { padding: spacing.xl + 4, paddingTop: spacing.xxl + spacing.lg, paddingBottom: spacing.lg, maxWidth: 640, alignSelf: 'center' as const, width: '100%' },

  progressRow: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: spacing.xl,
    justifyContent: 'center',
  },
  progressDot: {
    width: 24,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.muted,
  },
  progressDotActive: {
    backgroundColor: colors.accent,
  },

  backBtn: { marginBottom: spacing.lg },
  backText: { fontFamily: fonts.mono, fontSize: 12, color: colors.accent, letterSpacing: 0.5 },

  question: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: colors.text,
    marginBottom: spacing.xs,
    lineHeight: 32,
    letterSpacing: -0.3,
  },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginBottom: spacing.xl + spacing.sm,
    lineHeight: 20,
  },

  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: CARD_GAP + 2,
  },
  card: {
    flexBasis: '48%',
    flexGrow: 1,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md + 2,
    position: 'relative',
  },
  cardSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentDim,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.sm + 2,
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
    marginBottom: 4,
  },
  cardLabelSelected: {
    color: colors.accent,
  },
  cardDesc: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
    lineHeight: 16,
  },
  checkbox: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 20,
    height: 20,
    borderRadius: 6,
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

  timelineSection: {
    marginTop: spacing.xl,
    paddingTop: spacing.md,
  },
  timelineDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginBottom: spacing.lg,
  },
  timelineLabel: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    marginBottom: 10,
  },

  summaryTitle: {
    fontFamily: fonts.heading,
    fontSize: 26,
    color: colors.text,
    marginBottom: spacing.sm,
    letterSpacing: -0.3,
  },
  summarySubtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    marginBottom: spacing.xl + spacing.sm,
    lineHeight: 22,
  },
  summaryCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.md + 2,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm + 2,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.dim,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    width: 90,
  },
  summaryValue: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.accent,
    flex: 1,
    textAlign: 'right',
  },

  bottomArea: {
    paddingHorizontal: spacing.xl + 4,
    paddingBottom: spacing.xxl + spacing.sm,
    paddingTop: spacing.md,
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    borderRadius: 100,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
    letterSpacing: 0.2,
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: 12,
    marginBottom: spacing.xs,
  },
  skipText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.dim,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
});
