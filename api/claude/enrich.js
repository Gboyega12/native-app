// Layer 3: Claude Refinement
// Takes ranked moves with raw data (amounts, merchants, categories)
// and rewrites them into BOCY-style output:
//   Before: "Review your low-cost subscriptions"
//   After: "Cancel Netflix, Spotify, Adobe Creative Cloud to free £47/mo → reach 1-month buffer in 4 months"

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { moves, context } = req.body;
  if (!moves || !Array.isArray(moves) || moves.length === 0) {
    return res.status(400).json({ error: 'moves array required' });
  }

  const prompt = buildRefinementPrompt(moves, context);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Parse the JSON response
    try {
      const refined = JSON.parse(text);
      return res.json({ success: true, moves: refined });
    } catch {
      // If Claude returns non-JSON, return original moves unchanged
      return res.json({ success: false, moves: moves, error: 'parse_failed' });
    }
  } catch (err) {
    // Graceful fallback — return original moves
    return res.json({ success: false, moves: moves, error: err.message });
  }
}

function buildRefinementPrompt(moves, context) {
  const { monthly_income, monthly_spending, surplus, goals, ukpf_priority, ukpf_label } = context || {};

  let prompt = `You are Bocy, an AI financial advisor. Rewrite these financial recommendations into bold, specific, outcome-focused action plans.

RULES:
- Name ACTUAL merchants from the merchants list (e.g. "Cancel Netflix, Spotify, Adobe" not "cancel some subscriptions")
- Include SPECIFIC £ amounts (already provided in the data)
- Tie every action to the user's goal with a timeline (e.g. "→ reach 1-month buffer in 4 months")
- Keep the action field under 80 characters — it's a headline
- Rewrite the strategy as 1-2 definite sentences — no hedging, no "you might want to"
- Rewrite the effect as a measurable outcome with timeline
- Keep the steps array as 3-4 concrete, executable actions
- Use British English and £ symbol
- NEVER give regulated financial advice — suggest consulting a qualified advisor for investment decisions

USER CONTEXT:
- UKPF priority: ${ukpf_label || 'unknown'} (${ukpf_priority || 'unknown'})`;

  if (monthly_income) prompt += `\n- Monthly income: £${Math.round(monthly_income)}`;
  if (monthly_spending) prompt += `\n- Monthly spending: £${Math.round(monthly_spending)}`;
  if (surplus != null) prompt += `\n- Monthly surplus: £${Math.round(surplus)}`;
  if (goals?.one_year_goal) prompt += `\n- 1-year goal: ${goals.one_year_goal}`;
  if (goals?.target_amount) prompt += `\n- Target amount: £${goals.target_amount}`;

  prompt += `\n\nMOVES TO REFINE (${moves.length} moves):`;

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    prompt += `\n\n--- Move ${i + 1} ---`;
    prompt += `\nAction: ${m.action}`;
    prompt += `\nCategory: ${m.category || 'spending'}`;
    prompt += `\nMonthly impact: £${m.monthlyImpact}`;
    prompt += `\nAnnual impact: £${m.annualImpact}`;
    prompt += `\nEffort: ${m.effort}`;
    prompt += `\nMerchants: ${(m.merchants || []).join(', ') || 'none detected'}`;
    prompt += `\nStrategy: ${m.strategy}`;
    prompt += `\nSteps: ${(m.steps || []).join('; ')}`;
    prompt += `\nEffect: ${m.effect}`;
    if (m.trajectory) {
      prompt += `\nGoal trajectory: ${m.trajectory.insight}`;
      if (m.trajectory.newMonths > 0) {
        prompt += ` (reach ${m.trajectory.goalLabel} in ${m.trajectory.newMonths} months)`;
      }
    }
  }

  prompt += `\n\nRespond with ONLY a JSON array. Each object must have these exact fields:
{
  "action": "bold headline under 80 chars with specific merchants and amounts",
  "strategy": "1-2 definite sentences explaining why and how",
  "steps": ["step 1", "step 2", "step 3"],
  "effect": "measurable outcome with timeline",
  "timeline": "goal-tied timeline e.g. 'reach 1-month buffer in 4 months'"
}

Return exactly ${moves.length} objects in the same order as the input moves. Do NOT change monthlyImpact, annualImpact, effort, category, or merchants — only rewrite action, strategy, steps, effect, and timeline.`;

  return prompt;
}
