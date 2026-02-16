const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, context, stream } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const systemPrompt = buildSystemPrompt(context);
  const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));

  // ── Streaming mode ──
  if (stream) {
    return handleStream(res, apiMessages, systemPrompt);
  }

  // ── Standard mode with retry ──
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
          messages: apiMessages,
        }),
      });

      const data = await response.json();
      let text = data.content?.[0]?.text || '';
      // Strip markdown code fences Claude sometimes wraps around output
      text = text.replace(/^```(?:\w+)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

      return res.json({ success: true, text });
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  return res.status(500).json({ success: false, error: lastError?.message || 'Unknown error' });
}

// ── Streaming handler ──

async function handleStream(res, apiMessages, systemPrompt) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

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
        stream: true,
        system: systemPrompt,
        messages: apiMessages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;

        try {
          const event = JSON.parse(raw);
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            res.write(`data: ${JSON.stringify({ t: event.delta.text })}\n\n`);
          }
        } catch {
          // Skip malformed events
        }
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

// ── System prompt builder ──

function buildSystemPrompt(ctx) {
  let prompt = `You are Bocy, an AI financial advisor built into a UK personal finance app. You speak with the confidence and directness of a trusted personal financial advisor. You identify the most financially material moves and help users execute them immediately.

Tone: Authoritative, confident, definite. Use phrases like "You should", "I recommend", "Do this now". Never hedge with "you might want to consider" or "perhaps". Be specific with numbers and timelines — e.g. "Increase your buffer by £180/month to reach 3-month safety in 5 months" not "you could try saving more".

Formatting rules:
- Use **bold** for key numbers and actions
- Use bullet lists for multi-step plans
- Keep responses to 2-4 paragraphs max
- Use £ and British English throughout

Content rules:
- Always reference the user's actual numbers from their analysis
- Frame every recommendation as a concrete action with measurable impact and a clear timeline
- Never give regulated financial advice — always suggest consulting a qualified advisor for investment or debt decisions
- NEVER mention or recommend specific financial institutions or products (e.g. no "Monzo savings pot", "Chase 4.5%", "Marcus account", "Vanguard ISA", "Chip"). Keep all recommendations institution-neutral — say "a high-interest savings account" not "a Chase savings account at 4.5%"
- When discussing moves, be definite: "Cancel or downgrade 2 subscriptions to free **£94/month**" not "look at your subscriptions"
- Prioritise actionable steps over explanations`;

  if (!ctx) return prompt;

  // ── Core financials ──
  prompt += `\n\nUser's financial snapshot:`;
  if (ctx.monthly_income) prompt += `\n- Monthly income: £${Math.round(ctx.monthly_income)}`;
  if (ctx.monthly_spending) prompt += `\n- Monthly spending: £${Math.round(ctx.monthly_spending)}`;
  if (ctx.surplus != null) prompt += `\n- Monthly surplus: £${Math.round(ctx.surplus)}`;
  if (ctx.decision_score != null) prompt += `\n- Financial health score: ${ctx.decision_score}/100`;
  if (ctx.archetype) prompt += `\n- Financial profile: ${ctx.archetype}`;

  // ── Spending breakdown ──
  if (ctx.spending_by_category?.length) {
    prompt += `\n\nSpending by category (monthly):`;
    for (const c of ctx.spending_by_category) {
      prompt += `\n- ${c.category}: £${Math.round(c.monthly)}`;
    }
  }

  // ── Subscriptions ──
  if (ctx.subscriptions?.length) {
    prompt += `\n\nActive subscriptions:`;
    for (const s of ctx.subscriptions) {
      prompt += `\n- ${s.merchant}: £${Math.abs(s.amount).toFixed(2)}/month`;
    }
  }

  // ── All moves (action plan) ──
  if (ctx.all_moves?.length) {
    prompt += `\n\nRecommended moves (from analysis):`;
    for (const m of ctx.all_moves) {
      prompt += `\n- ${m.action} → saves £${Math.round(m.monthlyImpact)}/month (effort: ${m.effort})`;
    }
  }

  // ── Goals ──
  if (ctx.goals) {
    prompt += `\n\nGoals:`;
    if (ctx.goals.current_situation) prompt += `\n- Situation: ${ctx.goals.current_situation}`;
    if (ctx.goals.one_year_goal) prompt += `\n- 1-year goal: ${ctx.goals.one_year_goal}`;
    if (ctx.goals.two_year_goal) prompt += `\n- 2-year goal: ${ctx.goals.two_year_goal}`;
    if (ctx.goals.target_amount) prompt += `\n- Target amount: £${ctx.goals.target_amount}`;
  }

  // ── Goal trajectory ──
  if (ctx.goal_trajectory) {
    const gt = ctx.goal_trajectory;
    prompt += `\n\nGoal trajectory: "${gt.goalLabel}" — currently ${gt.currentMonths} months away, could be ${gt.newMonths} months with moves. ${gt.insight}`;
  }

  // ── Behavioral patterns ──
  if (ctx.behavioral_patterns?.length) {
    prompt += `\n\nBehavioral patterns detected:`;
    for (const p of ctx.behavioral_patterns) {
      prompt += `\n- ${p}`;
    }
  }

  return prompt;
}
