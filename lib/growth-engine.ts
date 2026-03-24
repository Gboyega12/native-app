// ── Growth Engine ──
// Runtime implementation for the Growth Agent.
// Compares current vs previous financial state, quantifies improvement,
// and generates a forward-looking personalised growth report.

import type { Analysis, GrowthReport } from './types';

// ── Interfaces ──

export interface GrowthEngineInputs {
  userId: string;
  timePeriod: string;
  currentAnalysis: Analysis;
  previousAnalysis: Analysis | null;
}

export interface GrowthReportOutput {
  headline: string;
  system_progress: {
    net_improvement: number;
    drivers: string[];
  };
  key_insights: Array<{
    insight: string;
    impact: number;
  }>;
  forward_outlook: {
    projected_gain: number;
    time_horizon: string;
  };
  next_actions: Array<{
    action: string;
    impact: number;
  }>;
}

// ── Core engine ──

export function generateGrowthReport(inputs: GrowthEngineInputs): GrowthReport {
  const { userId, timePeriod, currentAnalysis, previousAnalysis } = inputs;

  const drivers: string[] = [];
  const insights: Array<{ insight: string; impact: number }> = [];

  // Calculate net improvement
  const currentSurplus = currentAnalysis.surplus ?? 0;
  const previousSurplus = previousAnalysis?.surplus ?? 0;
  const surplusDelta = currentSurplus - previousSurplus;
  const annualSurplusDelta = surplusDelta * 12;

  // Score delta
  const currentScore = currentAnalysis.decision_score ?? 0;
  const previousScore = previousAnalysis?.decision_score ?? 0;
  const scoreDelta = currentScore - previousScore;

  // Spending delta
  const currentSpending = currentAnalysis.monthly_spending ?? 0;
  const previousSpending = previousAnalysis?.monthly_spending ?? 0;
  const spendingDelta = previousSpending - currentSpending; // positive = reduced spending

  // Income delta
  const currentIncome = currentAnalysis.monthly_income ?? 0;
  const previousIncome = previousAnalysis?.monthly_income ?? 0;
  const incomeDelta = currentIncome - previousIncome;

  // Build drivers
  if (spendingDelta > 0) {
    drivers.push(`Reduced monthly spending by £${Math.round(spendingDelta)}`);
  } else if (spendingDelta < 0) {
    drivers.push(`Monthly spending increased by £${Math.round(Math.abs(spendingDelta))}`);
  }

  if (incomeDelta > 0) {
    drivers.push(`Monthly income grew by £${Math.round(incomeDelta)}`);
  }

  if (scoreDelta > 0) {
    drivers.push(`Decision score improved by ${Math.round(scoreDelta)} points`);
  }

  // Savings delta
  const currentSavings = currentAnalysis.monthly_savings ?? 0;
  const previousSavings = previousAnalysis?.monthly_savings ?? 0;
  if (currentSavings > previousSavings) {
    drivers.push(`Savings increased by £${Math.round(currentSavings - previousSavings)}/mo`);
  }

  // Build key insights from inefficiencies and agent insights
  const agentInsights = currentAnalysis.agent_insights ?? [];
  for (const ai of agentInsights.slice(0, 3)) {
    insights.push({
      insight: ai.description,
      impact: ai.annual_impact,
    });
  }

  // If no agent insights, derive from moves
  if (insights.length === 0 && currentAnalysis.all_moves) {
    for (const move of currentAnalysis.all_moves.slice(0, 3)) {
      insights.push({
        insight: move.action,
        impact: move.annualImpact,
      });
    }
  }

  // Forward outlook: sum of top 3 moves' annual impact
  const topMoves = (currentAnalysis.all_moves ?? []).slice(0, 3);
  const projectedGain = topMoves.reduce((sum, m) => sum + (m.annualImpact ?? 0), 0);

  // Next actions from recommendations or moves
  const nextActions: Array<{ action: string; impact: number }> = [];
  const recs = currentAnalysis.agent_recommendations ?? [];
  if (recs.length > 0) {
    for (const rec of recs.slice(0, 3)) {
      nextActions.push({ action: rec.action, impact: rec.expected_impact });
    }
  } else {
    for (const move of topMoves) {
      nextActions.push({ action: move.action, impact: move.annualImpact });
    }
  }

  // Build headline
  const headline = buildHeadline(annualSurplusDelta, scoreDelta, drivers);

  return {
    user_id: userId,
    time_period: timePeriod,
    report: {
      headline,
      system_progress: {
        net_improvement: Math.round(annualSurplusDelta),
        drivers,
      },
      key_insights: insights,
      forward_outlook: {
        projected_gain: Math.round(projectedGain),
        time_horizon: '12 months',
      },
      next_actions: nextActions,
    },
  };
}

// ── Headline generator ──

function buildHeadline(annualDelta: number, scoreDelta: number, drivers: string[]): string {
  if (annualDelta > 0 && scoreDelta > 0) {
    return `Your financial system improved by £${Math.round(annualDelta).toLocaleString()}/yr — score up ${Math.round(scoreDelta)} points`;
  }
  if (annualDelta > 0) {
    return `Your system is £${Math.round(annualDelta).toLocaleString()}/yr stronger than last month`;
  }
  if (scoreDelta > 0) {
    return `Decision score improved by ${Math.round(scoreDelta)} points — momentum building`;
  }
  if (drivers.length > 0) {
    return `Your financial system held steady — here's what's next`;
  }
  return `Your monthly financial intelligence report is ready`;
}

// ── Helper: check if growth report should trigger ──

export function shouldTriggerGrowthReport(
  currentAnalysis: Analysis,
  previousAnalysis: Analysis | null,
): { trigger: boolean; priority: 'high' | 'medium' | 'low'; reason: string } {
  if (!previousAnalysis) {
    return { trigger: true, priority: 'medium', reason: 'First report — establishing baseline' };
  }

  const scoreDelta = (currentAnalysis.decision_score ?? 0) - (previousAnalysis.decision_score ?? 0);
  const surplusDelta = (currentAnalysis.surplus ?? 0) - (previousAnalysis.surplus ?? 0);

  // High priority: significant improvement or decline
  if (Math.abs(scoreDelta) >= 5 || Math.abs(surplusDelta) >= 100) {
    return {
      trigger: true,
      priority: 'high',
      reason: scoreDelta >= 5
        ? `Score improved by ${scoreDelta} points`
        : `Meaningful financial change detected (surplus Δ£${Math.round(surplusDelta)})`,
    };
  }

  // Medium priority: some change
  if (Math.abs(scoreDelta) >= 2 || Math.abs(surplusDelta) >= 25) {
    return { trigger: true, priority: 'medium', reason: 'Moderate financial change detected' };
  }

  // Low priority: end of period, minimal change
  return { trigger: true, priority: 'low', reason: 'End of period report' };
}
