import { createClient } from '@supabase/supabase-js';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tool definitions ──

const TOOLS = [
  {
    name: 'save_transaction_override',
    description:
      'Save a correction to how a transaction is categorised. Use this when the user tells you a transaction is miscategorised, missing, or should be reclassified. Examples: "My rent is paid through my partner", "That Netflix charge should be entertainment", "Mark transfers to Amex as debt payments".',
    input_schema: {
      type: 'object',
      properties: {
        match_description: {
          type: 'string',
          description: 'Transaction description or merchant to match (case-insensitive). E.g. "NETFLIX", "rent via partner", "Amex".',
        },
        category: {
          type: 'string',
          description: 'Correct category. One of: Rent, Mortgage, Bills, Insurance, Groceries, Transport, Dining, Shopping, Entertainment, Subscriptions, Health, Debt Payments, Savings, Childcare, Education, Charity, Other.',
        },
        is_essential: {
          type: 'boolean',
          description: 'Whether this is an essential (non-discretionary) expense.',
        },
        notes: {
          type: 'string',
          description: 'Brief note about why. E.g. "Paid via partner".',
        },
      },
      required: ['match_description', 'category', 'is_essential'],
    },
  },
  {
    name: 'propose_plan',
    description:
      'Propose a financial plan for the user to approve. Use this when recommending a specific savings target, budget change, or financial action with concrete numbers. Examples: "Build a £1000 emergency fund saving £200/month", "Pay off credit card in 8 months". Only call this when you have a concrete, actionable plan with numbers.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Plan title. E.g. "Build £1,000 emergency buffer".',
        },
        target_amount: {
          type: 'number',
          description: 'Target amount in pounds.',
        },
        monthly_saving: {
          type: 'number',
          description: 'Monthly saving towards this goal in pounds.',
        },
        timeline: {
          type: 'string',
          description: 'Estimated timeline. E.g. "5 months".',
        },
      },
      required: ['action'],
    },
  },
];

// ── Main handler ──

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, context, stream, user_id } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const systemPrompt = buildSystemPrompt(context);
  const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));

  // ── Streaming mode ──
  if (stream) {
    return handleStream(res, apiMessages, systemPrompt, user_id);
  }

  // ── Standard mode with tool loop ──
  return handleStandard(res, apiMessages, systemPrompt, user_id);
}

// ── Standard handler with tool loop ──

async function handleStandard(res, apiMessages, systemPrompt, userId) {
  let lastError;
  let currentMessages = [...apiMessages];
  const actions = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      let response = await callClaude(currentMessages, systemPrompt, false);

      // Tool use loop — max 3 iterations to prevent runaway
      for (let toolRound = 0; toolRound < 3; toolRound++) {
        const toolUseBlocks = (response.content || []).filter((b) => b.type === 'tool_use');
        if (toolUseBlocks.length === 0) break;

        // Execute tools
        const toolResults = [];
        for (const block of toolUseBlocks) {
          const result = await executeTool(block.name, block.input, userId);
          if (result.action) actions.push(result.action);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result.response),
          });
        }

        // Continue conversation with tool results
        currentMessages = [
          ...currentMessages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults },
        ];

        response = await callClaude(currentMessages, systemPrompt, false);
      }

      // Extract final text
      let text = '';
      for (const block of response.content || []) {
        if (block.type === 'text') text += block.text;
      }
      text = text.replace(/^```(?:\w+)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

      return res.json({ success: true, text, actions });
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  return res.status(500).json({ success: false, error: lastError?.message || 'Unknown error' });
}

// ── Streaming handler with tool support ──

async function handleStream(res, apiMessages, systemPrompt, userId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    const response = await callClaude(apiMessages, systemPrompt, true);

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
    let fullText = '';
    const toolCalls = [];
    let currentToolId = null;
    let currentToolName = null;
    let currentToolInput = '';
    let assistantContent = [];

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

          // Text delta — stream to client
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            fullText += event.delta.text;
            res.write(`data: ${JSON.stringify({ t: event.delta.text })}\n\n`);
          }

          // Tool use block start
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolInput = '';
          }

          // Tool use input delta
          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
            currentToolInput += event.delta.partial_json;
          }

          // Tool use block end — collect the call
          if (event.type === 'content_block_stop' && currentToolId) {
            let parsedInput = {};
            try { parsedInput = JSON.parse(currentToolInput); } catch {}
            toolCalls.push({ id: currentToolId, name: currentToolName, input: parsedInput });
            assistantContent.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input: parsedInput });
            currentToolId = null;
            currentToolName = null;
            currentToolInput = '';
          }

          // Text block end — track for assistant content reconstruction
          if (event.type === 'content_block_stop' && !currentToolId && fullText) {
            // Will add text block to assistantContent after loop
          }
        } catch {
          // Skip malformed events
        }
      }
    }

    // Handle tool calls if any were collected
    if (toolCalls.length > 0) {
      // Build assistant content for the followup
      const fullAssistantContent = [];
      if (fullText) fullAssistantContent.push({ type: 'text', text: fullText });
      fullAssistantContent.push(...assistantContent);

      const toolResults = [];
      for (const call of toolCalls) {
        const result = await executeTool(call.name, call.input, userId);
        if (result.action) {
          res.write(`data: ${JSON.stringify({ action: result.action })}\n\n`);
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result.response),
        });
      }

      // Followup call to get Claude's response after tool execution
      const followupMessages = [
        ...apiMessages,
        { role: 'assistant', content: fullAssistantContent },
        { role: 'user', content: toolResults },
      ];

      const followup = await callClaude(followupMessages, systemPrompt, false);
      for (const block of followup.content || []) {
        if (block.type === 'text' && block.text) {
          res.write(`data: ${JSON.stringify({ t: block.text })}\n\n`);
        }
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

// ── Call Claude API ──

async function callClaude(messages, systemPrompt, stream) {
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 512,
    system: systemPrompt,
    messages,
    tools: TOOLS,
  };

  if (stream) {
    body.stream = true;
    // Return the raw fetch response for streaming
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  }

  // Non-streaming — return parsed response
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  return response.json();
}

// ── Tool execution ──

async function executeTool(name, input, userId) {
  if (name === 'save_transaction_override') {
    return executeOverride(input, userId);
  }
  if (name === 'propose_plan') {
    return executePlan(input, userId);
  }
  return { response: { error: 'Unknown tool' }, action: null };
}

async function executeOverride(input, userId) {
  if (!userId) {
    return {
      response: { success: false, error: 'No user session' },
      action: null,
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return {
      response: { success: false, error: 'Server misconfigured' },
      action: null,
    };
  }

  const admin = createClient(supabaseUrl, serviceKey);

  const { error } = await admin.from('transaction_overrides').insert({
    user_id: userId,
    match_description: input.match_description,
    category: input.category,
    is_essential: input.is_essential,
    notes: input.notes || null,
  });

  if (error) {
    return {
      response: { success: false, error: error.message },
      action: null,
    };
  }

  return {
    response: { success: true, message: 'Override saved. It will apply on your next analysis.' },
    action: {
      type: 'override_saved',
      data: {
        match_description: input.match_description,
        category: input.category,
        is_essential: input.is_essential,
        notes: input.notes || null,
      },
    },
  };
}

async function executePlan(input, userId) {
  if (!userId) {
    return {
      response: { success: false, error: 'No user session' },
      action: null,
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return {
      response: { success: false, error: 'Server misconfigured' },
      action: null,
    };
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Insert with status 'proposed' — client updates to 'active' on approve
  const { data, error } = await admin.from('user_plans').insert({
    user_id: userId,
    action: input.action,
    target_amount: input.target_amount || null,
    monthly_saving: input.monthly_saving || null,
    timeline: input.timeline || null,
    status: 'proposed',
  }).select('id').single();

  if (error) {
    return {
      response: { success: false, error: error.message },
      action: null,
    };
  }

  return {
    response: { success: true, message: 'Plan proposed to user for approval.' },
    action: {
      type: 'plan_proposed',
      data: {
        id: data.id,
        action: input.action,
        target_amount: input.target_amount || null,
        monthly_saving: input.monthly_saving || null,
        timeline: input.timeline || null,
      },
    },
  };
}

// ── System prompt builder ──

function buildSystemPrompt(ctx) {
  let prompt = `You are Bocy — a sharp, no-nonsense financial advisor the user can text anytime. Think: a smart friend who happens to be great with money.

Voice:
- Talk like a real person texting. Short sentences. Direct.
- Say "you" not "the user." Say "I'd do X" not "I recommend X."
- Be warm but decisive. Confident, not corporate.
- Use the user's actual numbers — that's what makes you useful.
- One clear point per message. If they need more, they'll ask.

Rules:
- Keep replies to 2-4 short sentences when possible. Max 1-2 short paragraphs for complex questions.
- **Bold** the key number or action in each reply — just one or two things, not everything.
- Use £ and British English.
- Be specific: "Cut those 2 subs and you free up **£94/month**" not "look at your subscriptions."
- Never name specific banks, apps, or products. Say "a high-interest savings account" not "Chase" or "Monzo."
- Never give regulated financial advice. For investments or debt restructuring, tell them to speak to a qualified advisor.
- No bullet lists unless they ask for steps. Keep it conversational.
- No filler, no preamble, no "Great question!" — just answer.

Tools:
- When the user corrects a transaction (recategorise, flag as essential/non-essential, mentions a payment not showing), use save_transaction_override to save their correction.
- When you recommend a concrete financial plan with a target amount or savings goal, use propose_plan so they can approve it directly in the chat.`;

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
