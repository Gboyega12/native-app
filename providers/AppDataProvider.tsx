// ── App Data Provider ──
// Wraps the app with shared data context so all screens share the same
// analysis, debtAccounts, budgetAdjustments, userPlans, planProgress, etc.
// Eliminates the triple-fetch problem where Home, Plan, and Chat all
// independently hit Supabase for the same data on every tab switch.

import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { onSyncComplete } from '@/lib/sync-coordinator';
import { getLastResult } from '@/app/(main)/processing';
import { AppDataContext, type AppData, type AppDataSnapshot, type PlanProgressEntry } from '@/hooks/useAppData';
import type { Analysis } from '@/lib/types';
import type { WeeklyContext } from '@/lib/sync';

export default function AppDataProvider({ children }: { children: React.ReactNode }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [debtAccounts, setDebtAccounts] = useState<any[]>([]);
  const [budgetAdjustments, setBudgetAdjustments] = useState<any[]>([]);
  const [userPlans, setUserPlans] = useState<any[]>([]);
  const [planProgress, setPlanProgress] = useState<Record<string, PlanProgressEntry>>({});
  const [prevSnapshot, setPrevSnapshot] = useState<{ monthly_spending: number; monthly_income: number } | null>(null);
  const [weeklyCtx, setWeeklyCtx] = useState<WeeklyContext | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track whether we've done at least one successful fetch — avoids refetching on mount
  const hasFetched = useRef(false);

  /**
   * Fetch all shared data from Supabase.
   * Called on mount and whenever refresh() is invoked.
   */
  const fetchData = useCallback(async (): Promise<AppDataSnapshot> => {
    const empty: AppDataSnapshot = { analysis: null, budgetAdjustments: [], debtAccounts: [], userPlans: [], planProgress: {}, prevSnapshot: null };
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setLoading(false);
        return empty;
      }

      setUserId(user.id);
      const rawName = user.user_metadata?.full_name?.split(' ')[0] || '';
      setUserName(rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : '');

      // Parallel fetches for all shared data
      const [analysisRes, adjRes, debtRes, plansRes, progressRes, prevRes] = await Promise.all([
        // Latest analysis
        supabase
          .from('analyses')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        // Budget adjustments
        supabase
          .from('budget_adjustments')
          .select('description, category, monthly_amount, is_essential')
          .eq('user_id', user.id),
        // Debt accounts
        supabase
          .from('debt_accounts')
          .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, last_updated, source, is_default_apr')
          .eq('user_id', user.id),
        // Active user plans
        supabase
          .from('user_plans')
          .select('*')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .order('created_at', { ascending: false }),
        // Plan progress
        supabase
          .from('plan_progress')
          .select('*')
          .eq('user_id', user.id),
        // Previous month snapshot for income comparison
        (() => {
          const now = new Date();
          const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
          return supabase
            .from('score_history')
            .select('monthly_spending, monthly_income')
            .eq('user_id', user.id)
            .gte('created_at', prevMonth.toISOString())
            .lte('created_at', prevMonthEnd.toISOString())
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        })(),
      ]);

      // Set analysis (fall back to in-memory result from processing screen)
      const a = analysisRes.data ?? getLastResult() ?? null;
      setAnalysis(a);
      if (analysisRes.error) {
        console.warn('[AppDataProvider] Failed to fetch analysis:', analysisRes.error.message);
      }

      // Budget adjustments
      const adj = adjRes.data || [];
      setBudgetAdjustments(adj);

      // Debt accounts
      const debt = debtRes.data || [];
      setDebtAccounts(debt);

      // User plans
      const plans = plansRes.data || [];
      setUserPlans(plans);

      // Plan progress — build map, excluding dismissed entries
      const progressMap: Record<string, PlanProgressEntry> = {};
      for (const row of (progressRes.data || [])) {
        if (!row.move_key.startsWith('dismissed-')) {
          progressMap[row.move_key] = {
            move_key: row.move_key,
            move_action: row.move_action,
            approved: row.approved,
            completed_steps: row.completed_steps || [],
            sub_goals: row.sub_goals && Array.isArray(row.sub_goals) ? row.sub_goals : undefined,
            updated_at: row.updated_at,
          };
        }
      }
      setPlanProgress(progressMap);

      // Previous month snapshot
      const prev = prevRes.data ?? null;
      setPrevSnapshot(prev);

      setError(null);
      setLoading(false);
      hasFetched.current = true;

      // Return snapshot so callers can use fresh data immediately
      // (React state updates are batched and may not be visible yet)
      return { analysis: a, budgetAdjustments: adj, debtAccounts: debt, userPlans: plans, planProgress: progressMap, prevSnapshot: prev };
    } catch (err: any) {
      console.warn('[AppDataProvider] fetchData error:', err?.message);
      setError(err?.message || 'Failed to load data');
    }
    setLoading(false);
    return empty;
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Subscribe to sync completions — update shared state when any screen triggers a sync
  useEffect(() => {
    const unsub = onSyncComplete((result) => {
      if (!result) return;
      // Update analysis if sync returned one
      if (result.analysis) {
        setAnalysis(result.analysis);
      }
      // Update weekly context
      if (result.weeklyContext) {
        setWeeklyCtx(result.weeklyContext);
      }
      // Update debt accounts from sync
      if (result.debtAccounts?.length > 0) {
        setDebtAccounts(result.debtAccounts);
      }
      // Merge verified steps from reactive engine
      if (result.reactive?.verifiedSteps && Object.keys(result.reactive.verifiedSteps).length > 0) {
        setPlanProgress((prev) => {
          const updated = { ...prev };
          for (const [key, steps] of Object.entries(result.reactive!.verifiedSteps)) {
            if (updated[key]) {
              updated[key] = { ...updated[key], completed_steps: steps as number[] };
            }
          }
          return updated;
        });
      }
    });
    return () => unsub();
  }, []);

  const refresh = useCallback(async (): Promise<AppDataSnapshot> => {
    setLoading(true);
    return fetchData();
  }, [fetchData]);

  const value: AppData = {
    analysis,
    debtAccounts,
    budgetAdjustments,
    userPlans,
    planProgress,
    prevSnapshot,
    weeklyCtx,
    userId,
    userName,
    loading,
    error,
    refresh,
    setAnalysis,
    setPlanProgress,
    setDebtAccounts,
    setWeeklyCtx,
  };

  return (
    <AppDataContext.Provider value={value}>
      {children}
    </AppDataContext.Provider>
  );
}
