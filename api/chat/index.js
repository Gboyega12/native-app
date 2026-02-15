export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, context } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const systemPrompt = buildSystemPrompt(context);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    return res.json({ success: true, text });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

function buildSystemPrompt(ctx) {
  let prompt = `You are Bocy, a friendly UK personal finance advisor. You give short, practical, non-judgmental advice. Use British English. Keep responses concise (2-4 paragraphs max). Reference specific numbers from the user's data when relevant. Never give regulated financial advice — always suggest consulting a qualified advisor for investment or debt decisions.`;

  if (ctx) {
    prompt += `\n\nUser's financial context:`;
    if (ctx.monthly_income) prompt += `\n- Monthly income: £${Math.round(ctx.monthly_income)}`;
    if (ctx.monthly_spending) prompt += `\n- Monthly spending: £${Math.round(ctx.monthly_spending)}`;
    if (ctx.surplus != null) prompt += `\n- Monthly surplus: £${Math.round(ctx.surplus)}`;
    if (ctx.archetype) prompt += `\n- Financial profile: ${ctx.archetype}`;
    if (ctx.goals) {
      prompt += `\n- Current situation: ${ctx.goals.current_situation || 'unknown'}`;
      prompt += `\n- One-year goal: ${ctx.goals.one_year_goal || 'unknown'}`;
    }
    if (ctx.top_move?.action) prompt += `\n- Top recommendation: ${ctx.top_move.action}`;
  }

  return prompt;
}
