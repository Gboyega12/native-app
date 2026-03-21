// ── Shared App Data Hook ──
// Consolidates data fetching that was duplicated across Home, Plan, and Chat screens.
// Uses React Context so tab switches don't re-fetch and all screens share the same state.

import { createContext, useContext } from 'react';
import type { Analysis, Investment, SavingsAccount } from '@/lib/types';
import type { WeeklyContext } from '@/lib/sync';

/** Shape of plan progress entries stored in state */
export interface PlanProgressEntry {
  move_key: string;
  move_action: string;
  approved: boolean;
  completed_steps: number[];
  sub_goals?: any[];
  updated_at?: string;
}

/** Snapshot returned by refresh() so callers can use fresh data immediately */
export interface AppDataSnapshot {
  analysis: Analysis | null;
  budgetAdjustments: any[];
  debtAccounts: any[];
  investments: Investment[];
  savingsAccounts: SavingsAccount[];
  userPlans: any[];
  planProgress: Record<string, PlanProgressEntry>;
  prevSnapshot: { monthly_spending: number; monthly_income: number } | null;
}

/** The shared data exposed by the context */
export interface AppData {
  // ── Core data ──
  analysis: Analysis | null;
  debtAccounts: any[];
  investments: Investment[];
  savingsAccounts: SavingsAccount[];
  budgetAdjustments: any[];
  userPlans: any[];
  planProgress: Record<string, PlanProgressEntry>;
  prevSnapshot: { monthly_spending: number; monthly_income: number } | null;
  weeklyCtx: WeeklyContext | null;
  userId: string | null;
  userName: string;

  // ── Status ──
  loading: boolean;
  error: string | null;

  // ── Actions ──
  /** Re-fetch everything from Supabase. Returns a snapshot of the fresh data. */
  refresh: () => Promise<AppDataSnapshot>;
  /** Update analysis in-place (for optimistic UI from overrides) */
  setAnalysis: (analysis: Analysis | null) => void;
  /** Update plan progress in-place */
  setPlanProgress: (updater: (prev: Record<string, PlanProgressEntry>) => Record<string, PlanProgressEntry>) => void;
  /** Update debt accounts in-place */
  setDebtAccounts: (accounts: any[]) => void;
  /** Update investments in-place */
  setInvestments: (investments: Investment[]) => void;
  /** Update savings accounts in-place */
  setSavingsAccounts: (accounts: SavingsAccount[]) => void;
  /** Update weekly context in-place */
  setWeeklyCtx: (ctx: WeeklyContext | null) => void;
}

const defaultAppData: AppData = {
  analysis: null,
  debtAccounts: [],
  investments: [],
  savingsAccounts: [],
  budgetAdjustments: [],
  userPlans: [],
  planProgress: {},
  prevSnapshot: null,
  weeklyCtx: null,
  userId: null,
  userName: '',
  loading: true,
  error: null,
  refresh: async () => ({ analysis: null, budgetAdjustments: [], debtAccounts: [], investments: [], savingsAccounts: [], userPlans: [], planProgress: {}, prevSnapshot: null }),
  setAnalysis: () => {},
  setPlanProgress: () => {},
  setDebtAccounts: () => {},
  setInvestments: () => {},
  setSavingsAccounts: () => {},
  setWeeklyCtx: () => {},
};

export const AppDataContext = createContext<AppData>(defaultAppData);

/** Hook to access the shared app data from any screen */
export function useAppData(): AppData {
  return useContext(AppDataContext);
}
