import { useEffect, useState, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { findMostMaterialMove, calcGoalTrajectory } from '@/lib/move-engine';
import ErrorBoundary from '@/components/ErrorBoundary';
import { colors, fonts, spacing } from '@/theme';
import type { Analysis, Goals } from '@/lib/types';

const STEPS = [
  'Scanning transactions',
  'Identifying merchants',
  'Detecting spending patterns',
  'Modelling financial impact',
  'Ranking your moves',
];

// Global holder so dashboard can pick it up without re-fetching
let _lastResult: Analysis | null = null;
export function getLastResult(): Analysis | null { return _lastResult; }

function ProcessingInner() {
  const router = useRouter();
  const { csvData } = useLocalSearchParams<{ csvData: string }>();
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState('');
  const fadeAnims = useRef(STEPS.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    runAnalysis();
  }, []);

  useEffect(() => {
    if (currentStep < STEPS.length) {
      Animated.timing(fadeAnims[currentStep], {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }
  }, [currentStep]);

  const runAnalysis = async () => {
    try {
      if (!csvData) {
        setError('No transaction data found.');
        return;
      }

      // Step 1: Parse
      setCurrentStep(0);
      await delay(500);

      // Step 2: Enrich
      setCurrentStep(1);
      const result = EnrichmentEngine.enrich(csvData);
      await delay(500);

      // Step 3: Patterns
      setCurrentStep(2);
      await delay(500);

      // Step 4: Goals
      setCurrentStep(3);
      const { data: { user } } = await supabase.auth.getUser();
      let goals: Goals | null = null;
      if (user) {
        const { data } = await supabase
          .from('goals')
          .select('*')
          .eq('user_id', user.id)
          .single();
        goals = data;
      }
      await delay(500);

      // Step 5: Moves
      setCurrentStep(4);
      const topMove = findMostMaterialMove(result.decisionStack, result.profile, goals);
      const goalTrajectory = topMove ? calcGoalTrajectory(result.profile, goals, topMove) : null;

      // Try Claude enrichment (graceful fallback)
      let enrichedTopMove = topMove;
      if (topMove) {
        try {
          const res = await fetch('/api/claude/enrich', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: `Rewrite this financial advice title to be more engaging and personal (keep under 10 words): "${topMove.action}"`,
              max_tokens: 50,
            }),
          });
          const data = await res.json();
          if (data.success && data.text) {
            enrichedTopMove = { ...topMove, action: data.text.trim().replace(/"/g, '') };
          }
        } catch {
          // Graceful fallback — use original
        }
      }

      await delay(300);

      // Save to Supabase
      const analysis: Analysis = {
        user_id: user?.id,
        archetype: result.archetype.key,
        decision_score: result.decisionScore.score,
        monthly_income: Math.round(result.profile.monthly.income),
        monthly_spending: Math.round(result.profile.monthly.spending),
        surplus: Math.round(result.profile.monthly.surplus),
        non_discretionary: result.profile.budgetReality.nonDiscretionary,
        discretionary: result.profile.budgetReality.discretionary,
        income_sources: result.profile.incomeSources,
        top_move: enrichedTopMove || topMove || ({} as any),
        all_moves: result.decisionStack,
        behavioral_patterns: result.behavioralPatterns,
        goal_context: goalTrajectory,
      };

      if (user) {
        await supabase.from('analyses').insert({
          ...analysis,
          non_discretionary: analysis.non_discretionary,
          discretionary: analysis.discretionary,
          income_sources: analysis.income_sources,
          top_move: analysis.top_move,
          all_moves: analysis.all_moves,
          behavioral_patterns: analysis.behavioral_patterns,
          goal_context: analysis.goal_context,
        });
      }

      // Store for results screen
      _lastResult = {
        ...analysis,
        _enrichmentResult: result,
        _archetype: result.archetype,
        _decisionScore: result.decisionScore,
      } as any;

      router.replace('/(main)/(tabs)');
    } catch (err: any) {
      setError(err.message || 'Analysis failed. Please try again.');
    }
  };

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorIcon}>!</Text>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Analysing your data</Text>
      <View style={styles.steps}>
        {STEPS.map((step, i) => (
          <Animated.View key={i} style={[styles.stepRow, { opacity: fadeAnims[i] }]}>
            <Text style={[styles.stepIcon, i <= currentStep && styles.stepIconActive]}>
              {i < currentStep ? '>' : i === currentStep ? '...' : ' '}
            </Text>
            <Text style={[styles.stepText, i <= currentStep && styles.stepTextActive]}>
              {step}
            </Text>
          </Animated.View>
        ))}
      </View>
    </View>
  );
}

export default function Processing() {
  return (
    <ErrorBoundary fallbackMessage="The analysis engine encountered an error. Please try with a different CSV file.">
      <ProcessingInner />
    </ErrorBoundary>
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.text,
    marginBottom: spacing.xxl,
  },
  steps: {
    gap: spacing.lg,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepIcon: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.muted,
    width: 32,
  },
  stepIconActive: {
    color: colors.accent,
  },
  stepText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.muted,
  },
  stepTextActive: {
    color: colors.text,
  },
  errorIcon: {
    fontFamily: fonts.medium,
    fontSize: 48,
    color: colors.coral,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  errorText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.coral,
    textAlign: 'center',
    lineHeight: 22,
  },
});
