import { createClient } from '@supabase/supabase-js';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatRelativeDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.floor((today - d) / (1000 * 60 * 60 * 24));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
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
          description: 'Correct category. One of: Rent, Mortgage, Bills, Insurance, Groceries, Transport, Dining, Shopping, Entertainment, Subscriptions, Health, Debt Payments, Savings, Childcare, Education, Charity, Transfers, Household Contribution, Internal Transfer, Other. Use "Transfers" for person-to-person transfers that are NOT income (e.g. gifts, loans, splits). Use "Household Contribution" for regular payments from a partner/housemate (rent share, bills). Use "Internal Transfer" for moving money between your own accounts.',
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
      'Propose a plan based on the user\'s own EXPLICIT request. ONLY call this when the user has DIRECTLY asked you to create a plan, set a target, or track a goal — and you have concrete numbers they provided. Examples of when to call: user says "set up a plan to save £1000", "track my credit card payoff". Examples of when NOT to call: user asks "how should I budget my paycheck", "what should I do with my surplus", "can I afford X" — these are questions, not plan requests. NEVER call this proactively or as part of a paycheck breakdown. NEVER call this when answering a question. Never use this to suggest a product or provider.',
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
  {
    name: 'save_budget_item',
    description:
      'Add a manual budget item that doesn\'t appear in bank transactions. ONLY use this when the user EXPLICITLY tells you to add a specific expense with a concrete amount. The user must provide both what it is AND how much. Examples of when to call: "My rent is £1200 paid by standing order", "Add council tax £150 to essentials". Examples of when NOT to call: user mentions rent exists but hasn\'t given an amount, user is answering a question about their expenses, user is discussing a paycheck breakdown. When in doubt, ASK the user to confirm the amount before saving.',
    input_schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short description of the expense. E.g. "Rent", "Council Tax", "Childcare".',
        },
        category: {
          type: 'string',
          description: 'Budget category. One of: Rent, Mortgage, Bills, Insurance, Groceries, Transport, Dining, Shopping, Entertainment, Subscriptions, Health, Childcare, Education, Charity, Other.',
        },
        monthly_amount: {
          type: 'number',
          description: 'Monthly cost in pounds. E.g. 1200.',
        },
        is_essential: {
          type: 'boolean',
          description: 'Whether this is an essential (non-discretionary) expense.',
        },
      },
      required: ['description', 'category', 'monthly_amount', 'is_essential'],
    },
  },
  {
    name: 'search_gif',
    description:
      'Search for a reaction GIF to include in your reply. Use this roughly 1 in 4 messages to keep the vibe fun and human. Call this tool BEFORE writing your text reply — the returned URL will be available for you to embed. Good moments: user hits a milestone, overspent hilariously, you deliver a harsh truth, user asks something simple. NEVER use when delivering serious bad news or when the user is stressed.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Short search query for the GIF mood. E.g. "money rain", "facepalm", "celebration", "shocked", "thumbs up", "deal with it". Keep it to 1-3 words.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'suggest_goal_update',
    description:
      'Suggest the user update their financial goals when their situation has clearly changed. Use this when: (1) The user says their circumstances changed (got a raise, paid off debt, new expense, job loss). (2) Their financial data shows they\'ve achieved or outgrown their current goal (e.g. debt is nearly cleared but goal is still "clear debt"). (3) They explicitly ask to change their goals. Do NOT use this for minor progress updates — only for genuine goal shifts.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief explanation of why the goal should change. E.g. "Your debt is nearly cleared — time to shift focus."',
        },
        new_situation: {
          type: 'string',
          description: 'Updated financial situation. One of: in_debt, breaking_even, saving_slowly, saving_well, other.',
          enum: ['in_debt', 'breaking_even', 'saving_slowly', 'saving_well', 'other'],
        },
        new_one_year_goal: {
          type: 'string',
          description: 'Updated 1-year goal. One of: clear_debt, emergency_fund, save_target, reduce_spending, invest, other.',
          enum: ['clear_debt', 'emergency_fund', 'save_target', 'reduce_spending', 'invest', 'other'],
        },
        new_two_year_goal: {
          type: 'string',
          description: 'Updated 2-year goal. One of: buy_home, go_freelance, financial_freedom, clear_debt, invest, other.',
          enum: ['buy_home', 'go_freelance', 'financial_freedom', 'clear_debt', 'invest', 'other'],
        },
        new_target_amount: {
          type: 'number',
          description: 'Updated target amount in pounds (optional).',
        },
      },
      required: ['reason', 'new_situation', 'new_one_year_goal', 'new_two_year_goal'],
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
    max_tokens: 180,
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
  if (name === 'save_budget_item') {
    return executeBudgetItem(input, userId);
  }
  if (name === 'suggest_goal_update') {
    return executeGoalUpdate(input, userId);
  }
  if (name === 'search_gif') {
    return executeGifSearch(input);
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
    ...(input.direction ? { direction: input.direction } : {}),
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

async function executeBudgetItem(input, userId) {
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

  const { data, error } = await admin.from('budget_adjustments').insert({
    user_id: userId,
    description: input.description,
    category: input.category,
    monthly_amount: input.monthly_amount,
    is_essential: input.is_essential,
  }).select('id').single();

  if (error) {
    return {
      response: { success: false, error: error.message },
      action: null,
    };
  }

  return {
    response: {
      success: true,
      message: `Added ${input.description} (£${input.monthly_amount}/month) to your ${input.is_essential ? 'essentials' : 'lifestyle'} budget.`,
    },
    action: {
      type: 'budget_item_saved',
      data: {
        id: data.id,
        description: input.description,
        category: input.category,
        monthly_amount: input.monthly_amount,
        is_essential: input.is_essential,
      },
    },
  };
}

async function executePlan(input, userId) {
  if (!userId) {
    console.error('[executePlan] No userId provided');
    return {
      response: { success: false, error: 'No user session' },
      action: { type: 'plan_error', data: { error: 'Not signed in — please sign in to create plans.' } },
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('[executePlan] Missing env vars:', { url: !!supabaseUrl, key: !!serviceKey });
    return {
      response: { success: false, error: 'Server misconfigured' },
      action: { type: 'plan_error', data: { error: 'Server configuration issue — plan could not be saved.' } },
    };
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Insert as 'proposed' — user explicitly approves on the chat card
  const planRow = {
    user_id: userId,
    action: input.action,
    target_amount: input.target_amount || null,
    monthly_saving: input.monthly_saving || null,
    timeline: input.timeline || null,
    status: 'proposed',
  };

  console.log('[executePlan] Inserting plan:', JSON.stringify(planRow));

  const { data, error } = await admin.from('user_plans').insert(planRow).select('id').single();

  if (error) {
    console.error('[executePlan] Insert failed:', error.message, error.code);
    return {
      response: { success: false, error: error.message },
      action: { type: 'plan_error', data: { error: `Could not save plan: ${error.message}` } },
    };
  }

  console.log('[executePlan] Plan created successfully:', data.id);

  return {
    response: { success: true, message: 'Plan created and added to the user\'s action plan.' },
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

async function executeGoalUpdate(input, userId) {
  if (!userId) {
    return {
      response: { success: false, error: 'No user session' },
      action: null,
    };
  }

  // Don't insert yet — return proposal to client for confirmation
  return {
    response: { success: true, message: 'Goal update suggested to user for confirmation.' },
    action: {
      type: 'goal_update_proposed',
      data: {
        reason: input.reason,
        new_situation: input.new_situation,
        new_one_year_goal: input.new_one_year_goal,
        new_two_year_goal: input.new_two_year_goal,
        new_target_amount: input.new_target_amount || null,
      },
    },
  };
}

async function executeGifSearch(input) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    return { response: { success: false, error: 'GIF search not configured' }, action: null };
  }

  try {
    const q = encodeURIComponent(input.query || 'thumbs up');
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${q}&limit=5&rating=pg`;
    const res = await fetch(url);
    if (!res.ok) {
      return { response: { success: false, error: 'GIPHY request failed' }, action: null };
    }

    const data = await res.json();
    const gifs = data.data || [];
    if (gifs.length === 0) {
      return { response: { success: false, error: 'No GIFs found for that query' }, action: null };
    }

    // Pick a random one from top 5 for variety
    const pick = gifs[Math.floor(Math.random() * gifs.length)];
    const gifUrl = pick.images?.fixed_height?.url || pick.images?.original?.url;

    if (!gifUrl) {
      return { response: { success: false, error: 'No usable GIF URL' }, action: null };
    }

    return {
      response: {
        success: true,
        gif_url: gifUrl,
        instruction: `Include this GIF in your reply using: ![gif](${gifUrl}) on its own line, after your text.`,
      },
      action: null,
    };
  } catch (err) {
    return { response: { success: false, error: err.message }, action: null };
  }
}

// ── System prompt builder ──

function buildSystemPrompt(ctx) {
  let prompt = `You are Bocy. You ARE the user's financial brain. You've already analysed their bank data, you track their spending, you manage their plans, and you hold them accountable.

HARD WORD LIMIT:
- EVERY reply MUST be 12 words or fewer. Count before sending. Non-negotiable.
- "hello" → "hey! what's on your mind?" (6 words). That's the vibe.
- Even complex answers: "you're blowing **£340/mo** on subs. want me to dig in?" (11 words).
- If you catch yourself over 12 words, delete and rewrite shorter.
- MAX 2 PARAGRAPHS per reply. That means max 2 chat bubbles. NEVER more.
- The ONLY exception is when the user explicitly asks for a detailed breakdown or step-by-step list.

Voice:
- You text like a mate, not a chatbot. Short, punchy, real.
- Say "you" not "the user." Say "I'd do X" not "I recommend X."
- Think WhatsApp voice note transcribed, not a bank letter. Lowercase energy. No essays.
- Use their actual numbers. That's your edge.
- Own it: "spotted something" not "Based on the analysis." "I'll sort this" not "You could consider."
- Personality comes through brevity, not length. One well-placed line > three explaining ones.

Rules:
- **Bold** ONE key number or action per reply. Just one.
- Use £ and British English.
- Be razor-specific: "ditch Now TV and Paramount+, **£94/mo back**" not "you might want to look at your subscriptions."
- NEVER use dashes (—, –, -), arrows (→, ->, =>), or any dash-like separators. Flow naturally.
- Never recommend other apps. You do it all.
- NEVER recommend specific financial products, providers, or funds (no "open a Vanguard ISA", "get an AJ Bell SIPP", "use a Chase savings account"). You show the tax maths, allowance numbers, and effective rates. The user decides what to do with that.
- When discussing tax wrappers (ISA, pension, GIA), state the mathematical facts: allowance remaining, tax relief rate, effective cost per £1. Never say "you should put money in X."
- NEVER guess or assume expenses that aren't in the data. If you don't see rent, council tax, childcare, or other expected essentials, ASK the user — don't fill in amounts yourself. Say "I don't see rent in your transactions — do you pay it via another account or a partner?" The user's data might be correct (they might live rent-free, or pay via a partner). ALWAYS confirm before acting.
- NEVER call propose_plan or save_budget_item unless the user EXPLICITLY asks you to create a plan or add a budget item. Giving a breakdown, answering a question, or discussing spending is NOT a trigger to create plans or save budget items.
- No bullet lists unless they ask for steps. Keep it conversational.
- No filler. No preamble. No "Great question!" No "Absolutely!" No "Let me break this down." Just answer.
- Don't echo what they said. Don't restate the question. Jump straight to the answer.
- NEVER open with a greeting or "Hey!" when answering a question. Just answer it.
- Sound like a person texting, not an AI generating a response.
- NEVER answer more than ONE question at a time. If they asked 3 things, pick the most important one. They'll ask again.
- Keep your reply to 1-2 sentences max. If it looks like a paragraph, it's too long. Rewrite.

Conversation flow:
- THIS IS A DIALOGUE, NOT A MONOLOGUE. You say one short thing, then STOP and let them respond.
- NEVER send more than 2 short paragraphs. If you want to say more, wait for their reply first.
- If the topic needs 3 things said, say ONE now. Say the next after they reply. Then the third.
- When they bring up a new topic, ask ONE short question first. Don't answer AND ask AND elaborate.
- Imagine you're texting a friend. You wouldn't send 5 texts in a row without letting them reply.
- If they ask a broad question like "how am I doing?", give ONE sharp observation and ask if they want more.
- BAD: "you're overspending on food. also your subs are high. and rent is due. here's a plan."
- GOOD: "you're smashing **£400/mo** on takeaways. want to dig into that?"

GIFs:
- Occasionally (roughly 1 in 4 replies), use the search_gif tool to fetch a reaction GIF.
- Call search_gif FIRST with a short mood query (e.g. "money rain", "facepalm", "celebration"). You'll get back a real URL.
- Then include it in your text reply using: ![gif](THE_URL) on its own line, AFTER your text.
- NEVER fabricate or guess GIF URLs. ALWAYS use the URL returned by search_gif.
- Match the emotion: celebratory for wins, empathetic for tough moments, cheeky for spending call-outs.
- Good GIF moments: user hits a milestone, user overspent hilariously, you deliver a harsh truth, user asks something simple.
- NEVER use a GIF when delivering serious bad news or when the user is stressed. Read the room.
- Keep it to ONE gif per message max. Never two. If the tool fails, just skip the GIF — don't mention it.

Tools:
- When the user corrects a transaction (recategorise, flag as essential/non-essential, mentions a payment not showing), use save_transaction_override to save their correction. For the match_description, use the EXACT bank description shown in the transfers list if available — partial matches work (e.g. "JOHN" will match "TFR TO JOHN SMITH"). Common cases: rent paid to partner/housemate, bill splits, debt repayments showing as transfers.
- IMPORTANT: When the user says a person-to-person payment is NOT income, use category "Transfers" — NOT "Other". Transfers stay visible in their transaction history but won't inflate income figures. If the payment is a partner's household contribution (rent share, bills share), use "Household Contribution" instead — this is also excluded from income but tracked as a regular inflow. If the user says "that's my own account", use "Internal Transfer".
- When the user EXPLICITLY asks to set a target or track a goal, use propose_plan to create it. The user will see an "Add to plan" button and can approve or dismiss it from the chat. NEVER call propose_plan unless the user directly asks for a plan. Answering questions, giving breakdowns, or discussing budgets is NOT a reason to create a plan. If a user asks "how should I split my paycheck" that's a question — answer it, don't create a plan.
- When the user EXPLICITLY tells you to add a specific expense with a concrete amount, use save_budget_item. The user must provide both what it is AND how much. NEVER call this tool based on assumptions or as part of a breakdown. If you notice rent or an essential is missing from their data, ASK about it first — don't add it yourself.
- When the user's situation has clearly changed (life event, achieved a goal, outgrown their current goal), use suggest_goal_update to propose updated goals. This re-aligns all future analysis. Don't suggest this casually — only when a real shift has happened.
- IMPORTANT: In all tool call inputs (action titles, reasons, descriptions), use PLAIN TEXT only — no markdown, no **bold**, no *italic*. Markdown is only for your chat messages.`;

  if (!ctx) return prompt;

  // ── User Identity (from onboarding discovery) ──
  if (ctx.identity) {
    const id = ctx.identity;
    prompt += `\n\nUser's life context (critical for personalisation):`;
    if (id.work_setup) prompt += `\n- Work setup: ${id.work_setup.replace(/_/g, ' ')}`;
    if (id.household) prompt += `\n- Household: ${id.household.replace(/_/g, ' ')}`;
    if (id.housing) prompt += `\n- Housing: ${id.housing.replace(/_/g, ' ')}`;
    if (id.financial_experience) prompt += `\n- Financial experience: ${id.financial_experience}`;
    if (id.risk_appetite) prompt += `\n- Risk appetite: ${id.risk_appetite}`;
    if (id.priorities?.length) prompt += `\n- Top priorities: ${id.priorities.join(', ')}`;
    if (id.upcoming_events?.length && !id.upcoming_events.includes('none')) {
      prompt += `\n- Upcoming events: ${id.upcoming_events.join(', ').replace(/_/g, ' ')}`;
    }
    if (id.dependents?.length && !id.dependents.includes('none')) {
      prompt += `\n- Dependents: ${id.dependents.join(', ').replace(/_/g, ' ')}`;
    }
    prompt += `\nIMPORTANT: Tailor ALL insights to this life context. A self-employed single parent has different tax and allowance positions than a salaried office worker in a couple. Reference their specific situation.`;
  }

  // ── Core financials ──
  prompt += `\n\nUser's financial snapshot:`;
  if (ctx.monthly_income) prompt += `\n- Monthly income: £${Math.round(ctx.monthly_income)}`;
  if (ctx.monthly_spending) prompt += `\n- Monthly spending: £${Math.round(ctx.monthly_spending)}`;
  if (ctx.surplus != null) prompt += `\n- Monthly surplus: £${Math.round(ctx.surplus)}`;
  if (ctx.decision_score != null) prompt += `\n- Financial health score: ${ctx.decision_score}/100`;
  if (ctx.archetype) prompt += `\n- Financial profile: ${ctx.archetype}`;

  // ── Income sources with pay frequency ──
  if (ctx.income_sources?.length) {
    prompt += `\n\nIncome sources:`;
    for (const src of ctx.income_sources) {
      const freq = src.frequency || 'irregular';
      const freqLabel = freq === 'weekly' ? 'weekly' : freq === 'fortnightly' ? 'fortnightly' : freq === 'monthly' ? 'monthly' : 'irregular';
      prompt += `\n- ${src.source}: £${Math.round(src.avgAmount)} per payment (${freqLabel}), £${Math.round(src.monthly)}/month${src.isSalary ? ' [primary salary]' : ''}`;
    }
    const primarySrc = ctx.income_sources.find(s => s.isSalary) || ctx.income_sources[0];
    if (primarySrc) {
      const freq = primarySrc.frequency || 'monthly';
      prompt += `\nIMPORTANT: User is paid ${freq}. When discussing paycheck breakdowns, budgets per pay period, or "what to do with this paycheck", frame everything in ${freq} terms, not monthly (unless the user asks for monthly). A ${freq} earner receiving £${Math.round(primarySrc.avgAmount)} needs to think about £${Math.round(primarySrc.avgAmount)} at a time, not £${Math.round(ctx.monthly_income)}.`;
    }
  }

  // ── Budget line (real spending power & trade-offs) ──
  if (ctx.budget_line) {
    const bl = ctx.budget_line;
    prompt += `\n\nBudget line (pre-calculated — use these numbers directly):`;
    prompt += `\n- Real spending power: £${bl.real_spending_power}/month (income minus fixed costs — this is what they can actually allocate)`;
    prompt += `\n- Essentials: £${bl.essentials_total}/month (${bl.essentials_pct}% of income)`;
    prompt += `\n- Lifestyle: £${bl.lifestyle_total}/month`;
    prompt += `\n- Left to decide: £${bl.left_to_decide}/month`;
    if (bl.over_budget) {
      prompt += `\n- STATUS: £${bl.over_amount} OFF BALANCE. Total spending exceeds income by £${bl.over_amount}. Frame this as fixable, not alarming. Use "spending gap" or "off balance", never "over budget." Point them to their plan and moves.`;
    } else if (bl.left_to_decide === 0) {
      prompt += `\n- STATUS: FULLY ALLOCATED. Every pound has a job. Any new expense needs a trade-off from somewhere else.`;
    } else if (bl.left_to_decide / (ctx.monthly_income || 1) < 0.1) {
      prompt += `\n- STATUS: TIGHT. Only £${bl.left_to_decide} unallocated. Validate their discipline rather than warning them.`;
    }
    if (bl.essentials_change_pct != null && bl.essentials_change_pct !== 0) {
      prompt += bl.essentials_change_pct > 0
        ? `\n- Essentials rose ${bl.essentials_change_pct}% vs last month — real spending power has dropped.`
        : `\n- Essentials fell ${Math.abs(bl.essentials_change_pct)}% vs last month — they freed up money.`;
    }
    if (bl.top_lifestyle_category && bl.top_lifestyle_amount) {
      const tradeOff = Math.min(50, Math.round(bl.top_lifestyle_amount * 0.3));
      prompt += `\n- Trade-off example: cutting £${tradeOff} from ${bl.top_lifestyle_category.toLowerCase()} = £${tradeOff} more toward savings or debt.`;
    }
    if (bl.allocation_efficiency != null) {
      prompt += `\n- Allocation efficiency: ${bl.allocation_efficiency}/100 (how close their current spending pattern is to the mathematically optimal allocation given their priorities)`;
      if (bl.allocation_efficiency < 60) {
        prompt += ` — significant room to rebalance for better outcomes.`;
      } else if (bl.allocation_efficiency >= 85) {
        prompt += ` — well-optimised. Minor tweaks only.`;
      }
    }
    if (bl.top_reallocation) {
      const r = bl.top_reallocation;
      prompt += `\n- Top reallocation: move £${r.amount}/month from ${r.from} to ${r.to}. ${r.utility_gain}.`;
    }
    prompt += `\nIMPORTANT: When discussing budgets, trade-offs, or "can I afford X", use these budget line numbers. Say things like "You earn £X but £Y goes to fixed costs, so you actually have £Z to work with" — make it tangible, not abstract.`;
  }

  // ── Household cash flow scenarios ──
  if (ctx.household_cashflow) {
    const hc = ctx.household_cashflow;
    prompt += `\n\nHousehold cash flow (Monte Carlo simulated):`;
    if (hc.shared_expense_ratio > 0) {
      prompt += `\n- Joint surplus: £${hc.joint_surplus}/month (${hc.shared_expense_ratio}% of expenses are shared)`;
    }
    prompt += `\n- Buffer adequacy: ${hc.buffer_adequacy}% (probability current savings survive 24 months of simulated shocks)`;
    if (hc.buffer_adequacy < 50) {
      prompt += ` — this is concerning. Prioritise building the buffer.`;
    } else if (hc.buffer_adequacy >= 80) {
      prompt += ` — strong position. Buffer handles most scenarios.`;
    }
    if (hc.scenarios?.length) {
      prompt += `\n- Risk scenarios:`;
      for (const s of hc.scenarios.slice(0, 5)) {
        prompt += `\n  • ${s.label} (${s.probability}% annual chance): £${Math.abs(s.monthly_impact)}/month impact — ${s.description}`;
      }
    }
    prompt += `\nIMPORTANT: When the user asks about financial resilience, "what if" scenarios, or whether they can afford a life change, reference these scenario probabilities. Make risk feel concrete: "There's a ${hc.scenarios?.[0]?.probability || 6}% chance of income disruption this year — your buffer ${hc.buffer_adequacy >= 70 ? 'covers that well' : 'would struggle with that'}."`;
  }

  // ── Spending breakdown ──
  if (ctx.spending_by_category?.length) {
    prompt += `\n\nSpending by category (MONTHLY AVERAGES — these are per-month figures, not totals):`;
    for (const c of ctx.spending_by_category) {
      prompt += `\n- ${c.category}: £${Math.round(c.monthly)}/month`;
    }
  }

  // ── Subscriptions ──
  // IMPORTANT: Each entry is a UNIQUE subscription with its average monthly cost.
  // These are NOT individual transactions — they are deduplicated recurring payments.
  // E.g. "netflix: £10/month" means ONE Netflix subscription costing £10 each month,
  // NOT multiple £10 charges accumulated.
  if (ctx.subscriptions?.length) {
    prompt += `\n\nActive subscriptions (each is one recurring subscription, showing the average per-payment amount):`;
    for (const s of ctx.subscriptions) {
      prompt += `\n- ${s.merchant}: £${Math.abs(s.amount).toFixed(2)}/month`;
    }
    prompt += `\nIMPORTANT: Do NOT multiply these amounts by months when discussing current spending. Each figure is already the monthly cost. If a user pays £10/month for Netflix, their monthly Netflix spend is £10, not £40 (even if they've had it for 4 months).`;
  }

  // ── Verified bills (exact amounts from recognized merchants in transactions) ──
  if (ctx.verified_bills?.length) {
    prompt += `\n\n✓ VERIFIED BILLS — These exact amounts are confirmed from the user's transaction history:`;
    for (const bill of ctx.verified_bills) {
      prompt += `\n- ${bill.merchant} (${bill.category}): £${bill.monthlyAmount}/month (paid ${bill.frequency}, last payment £${bill.lastPayment} on ${bill.lastPaymentDate})`;
    }
    prompt += `\n\nThese are REAL amounts from actual bank transactions, not estimates. Use these exact figures when discussing budgets, paycheck breakdowns, and essential costs. They are more reliable than typical ranges.`;
  }

  // ── Essential gaps (missing from transactions but expected from identity) ──
  if (ctx.essential_gaps?.length) {
    prompt += `\n\n⚠ MISSING ESSENTIALS — These expenses are expected based on the user's profile but NOT visible in their transaction data:`;
    for (const gap of ctx.essential_gaps) {
      prompt += `\n- ${gap.category}: ${gap.reason}. Typical UK range: £${gap.typicalRange.low}-£${gap.typicalRange.high}/month. Confidence: ${gap.confidence}.`;
    }
    prompt += `\n\nHOW TO HANDLE MISSING ESSENTIALS:`;
    prompt += `\n- These gaps mean the surplus figure (£${Math.round(ctx.surplus || 0)}/month) may be OVERSTATED. The real surplus could be significantly lower.`;
    prompt += `\n- When the user asks about budgets, paycheck splits, or "how much can I save", FIRST check if you've already asked about these gaps in this conversation.`;
    prompt += `\n- If not yet asked, raise ONE gap per message. Example: "I don't see rent in your transactions. Do you pay it via a partner or another account? Knowing the amount helps me give you an accurate breakdown."`;
    prompt += `\n- NEVER assume amounts. NEVER auto-fill. Wait for the user to tell you the number.`;
    prompt += `\n- When the user provides an amount, use save_budget_item to record it. Only then.`;
    prompt += `\n- Low-confidence gaps (insurance, water) — only ask if the user is specifically discussing budgets or expenses. Don't lead with these.`;
    prompt += `\n- Once a gap is filled via save_budget_item, it won't appear in future conversations.`;
  }

  // ── Ambiguous recurring transfers ──
  if (ctx.ambiguous_transfers?.length) {
    prompt += `\n\n⚠ AMBIGUOUS RECURRING TRANSFERS — These recurring person-to-person transfers need clarification:`;
    for (const t of ctx.ambiguous_transfers) {
      const dir = t.direction === 'inbound' ? 'received from' : 'sent to';
      prompt += `\n- £${t.averageAmount}/${t.frequency} ${dir} "${t.counterparty}" (${t.count} occurrences)`;
      if (t.suggestedType) prompt += ` — likely: ${t.suggestedType.replace(/_/g, ' ')}`;
    }
    prompt += `\n\nThese may be rent payments to/from a partner, household contributions, debt repayments, or transfers to the user's own accounts.`;
    prompt += `\n- If the user asks about income accuracy or missing rent, mention these transfers and suggest they tap "Review" on the dashboard banner.`;
    prompt += `\n- Inbound recurring person transfers may be inflating the income figure if they are household contributions, not real income.`;
    prompt += `\n- Outbound recurring person transfers may be rent or debt repayments being counted as generic transfers.`;
  }

  // ── All moves (action plan) ──
  if (ctx.all_moves?.length) {
    prompt += `\n\nInsights from analysis (ranked by mathematical impact):`;
    for (const m of ctx.all_moves) {
      prompt += `\n- ${m.action} → saves £${Math.round(m.monthlyImpact)}/month (effort: ${m.effort})`;
    }
  }

  // ── Recent transfers / uncategorised (for override matching) ──
  if (ctx.recent_transfers?.length) {
    prompt += `\n\nRecent transfers & uncategorised payments (may need reclassifying):`;
    for (const t of ctx.recent_transfers) {
      prompt += `\n- "${t.description}" £${Math.abs(t.amount).toFixed(2)}`;
    }
    prompt += `\nIf the user mentions a payment that matches one of these, use save_transaction_override with the exact description above as match_description.`;
  }

  // ── Manual budget items (added by user) ──
  if (ctx.budget_adjustments?.length) {
    prompt += `\n\nManual budget items (already added by user — don't re-add these):`;
    for (const a of ctx.budget_adjustments) {
      prompt += `\n- ${a.description} (${a.category}, ${a.essential ? 'essential' : 'lifestyle'}): £${a.amount}/month`;
    }
  }

  // ── Debt accounts (from TrueLayer or manual entry) ──
  if (ctx.debt_accounts?.length) {
    prompt += `\n\nDebt accounts:`;
    let totalDebt = 0;
    for (const d of ctx.debt_accounts) {
      const bal = d.balance != null ? `£${Math.round(d.balance)}` : 'unknown balance';
      const lim = d.limit != null ? ` / £${Math.round(d.limit)} limit` : '';
      const util = (d.balance != null && d.limit != null && d.limit > 0)
        ? ` (${Math.round((d.balance / d.limit) * 100)}% utilised)`
        : '';
      prompt += `\n- ${d.name} (${d.type}): ${bal}${lim}${util}`;
      if (d.balance != null) totalDebt += d.balance;
    }
    if (totalDebt > 0) {
      prompt += `\nTotal outstanding debt: £${Math.round(totalDebt)}`;
    }
    // Determine good vs bad debt for advice
    const totalCreditLimit = ctx.debt_accounts.reduce((s, d) => s + (d.limit || 0), 0);
    const overallUtilisation = totalCreditLimit > 0 ? Math.round((totalDebt / totalCreditLimit) * 100) : -1;
    if (overallUtilisation >= 0 && overallUtilisation <= 30) {
      prompt += `\nOverall utilisation: ${overallUtilisation}% — low utilisation, paying on time. No high-interest cost.`;
    } else if (overallUtilisation > 75) {
      prompt += `\nOverall utilisation: ${overallUtilisation}% — high utilisation. Interest costs are significant at this level.`;
    } else if (overallUtilisation > 30) {
      prompt += `\nOverall utilisation: ${overallUtilisation}% — moderate utilisation. Suggest bringing it below 30% for credit score benefits.`;
    }
    prompt += `\nUse these actual balances when discussing debt strategy. Be specific — "Pay down your £${Math.round(totalDebt)} across ${ctx.debt_accounts.length} account(s)" not "attack your debts."`;
  }

  // ── Goals + staleness detection ──
  if (ctx.goals) {
    prompt += `\n\nGoals:`;
    if (ctx.goals.current_situation) prompt += `\n- Situation: ${ctx.goals.current_situation}`;
    if (ctx.goals.one_year_goal) prompt += `\n- 1-year goal: ${ctx.goals.one_year_goal}`;
    if (ctx.goals.two_year_goal) prompt += `\n- 2-year goal: ${ctx.goals.two_year_goal}`;
    if (ctx.goals.target_amount) prompt += `\n- Target amount: £${ctx.goals.target_amount}`;

    // Detect potential goal staleness — give Claude hints
    const hints = [];
    const situation = ctx.goals.current_situation;
    const oneYear = ctx.goals.one_year_goal;
    const surplus = ctx.surplus || 0;

    if (situation === 'in_debt' && surplus > 200) {
      hints.push('User says "in debt" but has £' + Math.round(surplus) + ' monthly surplus — situation may have improved.');
    }
    if (oneYear === 'clear_debt' && surplus > 300) {
      hints.push('Goal is "clear debt" but surplus is strong — they may have already cleared it or be close.');
    }
    if (situation === 'breaking_even' && surplus > 400) {
      hints.push('User says "breaking even" but surplus is £' + Math.round(surplus) + '/month — they\'re actually saving.');
    }
    if (oneYear === 'emergency_fund' && surplus > 500) {
      hints.push('Goal is "emergency fund" — with £' + Math.round(surplus) + '/month surplus, they may have already built one.');
    }
    if (situation === 'saving_slowly' && surplus > 600) {
      hints.push('User says "saving slowly" but surplus of £' + Math.round(surplus) + '/month suggests they\'re saving well.');
    }

    if (hints.length > 0) {
      prompt += `\n\n⚠ Goal alignment check (only mention if user brings up goals or asks about progress):`;
      for (const h of hints) {
        prompt += `\n- ${h}`;
      }
      prompt += `\nIf the user mentions their goals or progress, consider suggesting a goal update using suggest_goal_update.`;
    }
  }

  // ── Goal trajectory (with Monte Carlo confidence bands) ──
  if (ctx.goal_trajectory) {
    const gt = ctx.goal_trajectory;
    prompt += `\n\nGoal trajectory: "${gt.goalLabel}" — currently ${gt.currentMonths} months away, could be ${gt.newMonths} months with moves. ${gt.insight}`;

    if (gt.confidence) {
      const c = gt.confidence;
      prompt += `\n\nMonte Carlo analysis (1,000 simulations accounting for income volatility, spending variance, and emergencies):`;
      prompt += `\n- Optimistic: ${c.p10} months (10th percentile)`;
      prompt += `\n- Most likely: ${c.p50} months (median)`;
      prompt += `\n- Conservative: ${c.p90} months (90th percentile)`;
      if (c.hitRate12m > 0 && c.hitRate12m < 100) {
        prompt += `\n- ${c.hitRate12m}% probability of reaching goal within 12 months`;
      }
      if (c.hitRate24m > 0 && c.hitRate24m < 100) {
        prompt += `\n- ${c.hitRate24m}% probability of reaching goal within 24 months`;
      }
      prompt += `\nWhen discussing timelines, use these probability ranges instead of single-point estimates. Say "most likely X months" rather than "X months". Mention the range when relevant (e.g. "between X and Y months depending on circumstances"). Reference the hit rate percentages to set realistic expectations.`;
    }

    if (gt.bufferRecommendation) {
      const b = gt.bufferRecommendation;
      prompt += `\n\nBuffer analysis (Monte Carlo): £${b.amount.toLocaleString()} (${b.months} months of expenses) covers ${b.coverageRate}% of simulated income shock scenarios.`;
    }
  }

  // ── Recent transactions (last 7 days — enables daily/weekly spending questions) ──
  if (ctx.recent_transactions?.length) {
    // Group by date for readability
    const byDate = {};
    for (const tx of ctx.recent_transactions) {
      const d = tx.date?.split('T')[0] || 'unknown';
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(tx);
    }
    prompt += `\n\nRecent transactions (last 7 days):`;
    for (const [date, txs] of Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0]))) {
      const dayTotal = txs.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
      const dayLabel = formatRelativeDate(date);
      prompt += `\n${dayLabel} (spent £${dayTotal.toFixed(2)}):`;
      for (const tx of txs) {
        const sign = tx.amount >= 0 ? '+' : '-';
        prompt += `\n  ${sign}£${Math.abs(tx.amount).toFixed(2)} ${tx.description} [${tx.category}${tx.essential ? ', essential' : ''}]`;
      }
    }
    prompt += `\nUse these to answer questions about daily or weekly spending. Be specific — reference actual merchants and amounts.`;
  }

  // ── Behavioral patterns ──
  if (ctx.behavioral_patterns?.length) {
    prompt += `\n\nBehavioral patterns detected:`;
    for (const p of ctx.behavioral_patterns) {
      prompt += `\n- ${p}`;
    }
  }

  // ── Payday mode: income arrived this week ──
  if (ctx.payday_context?.incomeArrivedThisWeek && ctx.payday_context.incomeEvents?.length) {
    const pc = ctx.payday_context;
    const totalIncome = pc.incomeEvents.reduce((s, e) => s + e.amount, 0);
    const sources = pc.incomeEvents.map(e => `£${Math.round(e.amount)} from ${e.source}`).join(', ');

    // Determine pay frequency from income events
    const payFrequencies = pc.incomeEvents.map(e => e.frequency).filter(f => f && f !== 'unknown');
    const primaryFreq = payFrequencies[0] || 'monthly';
    const freqLabel = primaryFreq === 'weekly' ? 'weekly' : primaryFreq === 'fortnightly' ? 'fortnightly' : 'monthly';
    const periodsPerMonth = primaryFreq === 'weekly' ? 4.33 : primaryFreq === 'fortnightly' ? 2.17 : 1;

    prompt += `\n\n🔔 PAYDAY MODE ACTIVE — Income just landed this week:`;
    prompt += `\n- Income received: ${sources}`;
    prompt += `\n- Pay frequency: ${freqLabel} (user gets paid ${freqLabel})`;
    prompt += `\n- Already committed to bills/essentials this week: £${Math.round(pc.committedThisWeek)}`;
    prompt += `\n- Discretionary spending this week so far: £${Math.round(pc.discretionaryThisWeek)}`;
    prompt += `\n- Adaptive safe-to-spend budget: £${Math.round(pc.adaptiveBudget)}/week`;
    prompt += `\n- Static weekly budget: £${Math.round(pc.staticBudget)}/week`;
    prompt += `\n- IMPORTANT: This user is paid ${freqLabel}. ALL breakdowns must be per ${freqLabel === 'monthly' ? 'month' : freqLabel === 'fortnightly' ? 'fortnight' : 'week'}, NOT monthly (unless they ask for monthly). If they ask "how should I split this paycheck", break it down per pay period (${freqLabel}), not per month. For ${freqLabel} earners, divide monthly commitments by ${periodsPerMonth.toFixed(2)} to get per-paycheck amounts.`;

    prompt += `\n\nPAYDAY CONVERSATION RULES:`;
    prompt += `\n- Money just hit their account. Help them think through allocation — but ONLY if they ask. Don't dump a breakdown unprompted.`;
    prompt += `\n- CRITICAL: Do NOT call propose_plan or save_budget_item during payday conversations. These are questions, not plan requests.`;
    prompt += `\n- If they ask "how should I split this" or "where should this go", give a MATHEMATICAL breakdown based on their pay frequency and data — don't create plans or budget items.`;
    prompt += `\n- Use the adaptive budget (£${Math.round(pc.adaptiveBudget)}/week) not the static one.`;
    prompt += `\n- If they've already spent £${Math.round(pc.discretionaryThisWeek)} on discretionary this week, tell them exactly how much is left.`;
    prompt += `\n- NEVER guess missing essentials. If you don't see rent, council tax, or other expected essentials in their data, ASK: "I don't see rent in your transactions — do you pay it via a partner or another account?" Don't assume amounts.`;
    prompt += `\n- Do NOT just dump all these numbers. Weave them naturally into conversation. Only mention what's relevant to what they're asking about.`;
  }

  return prompt;
}
