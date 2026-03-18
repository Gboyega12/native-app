import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { formatRelativeDate } from '../../lib/date-utils.js';

const bodySchema = z.object({
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
  context: z.record(z.string(), z.unknown()).optional(),
  stream: z.boolean().optional(),
  user_id: z.string().nullable().optional(),
});

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


// ── Tool definitions ──

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
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
      'Propose a plan based on the user\'s own EXPLICIT request. ONLY call this when the user has DIRECTLY asked you to create a plan, set a target, or track a goal \u2014 and you have concrete numbers they provided. Examples of when to call: user says "set up a plan to save \u00a31000", "track my credit card payoff". Examples of when NOT to call: user asks "how should I budget my paycheck", "what should I do with my surplus", "can I afford X" \u2014 these are questions, not plan requests. NEVER call this proactively or as part of a paycheck breakdown. NEVER call this when answering a question. Never use this to suggest a product or provider.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Plan title. E.g. "Build \u00a31,000 emergency buffer".',
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
      'Add a manual budget item that doesn\'t appear in bank transactions. ONLY use this when the user EXPLICITLY tells you to add a specific expense with a concrete amount. The user must provide both what it is AND how much. Examples of when to call: "My rent is \u00a31200 paid by standing order", "Add council tax \u00a3150 to essentials". Examples of when NOT to call: user mentions rent exists but hasn\'t given an amount, user is answering a question about their expenses, user is discussing a paycheck breakdown. When in doubt, ASK the user to confirm the amount before saving.',
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
      'Search for a reaction GIF to include in your reply. Use this roughly 1 in 4 messages to keep the vibe fun and human. Call this tool BEFORE writing your text reply \u2014 the returned URL will be available for you to embed. Good moments: user hits a milestone, overspent hilariously, you deliver a harsh truth, user asks something simple. NEVER use when delivering serious bad news or when the user is stressed.',
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
    name: 'show_income_summary',
    description:
      'Show the user an interactive income breakdown card with their income sources, essentials, and surplus. Use this when: (1) The user asks about their income, earnings, or pay. (2) The user asks "how much do I earn" or "show me my income". (3) The user wants to review or edit their income sources. The card lets them add, edit, or remove income sources directly.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'suggest_goal_update',
    description:
      'Suggest the user update their financial goals when their situation has clearly changed. Use this when: (1) The user says their circumstances changed (got a raise, paid off debt, new expense, job loss). (2) Their financial data shows they\'ve achieved or outgrown their current goal (e.g. debt is nearly cleared but goal is still "clear debt"). (3) They explicitly ask to change their goals. Do NOT use this for minor progress updates \u2014 only for genuine goal shifts.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief explanation of why the goal should change. E.g. "Your debt is nearly cleared \u2014 time to shift focus."',
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
  }
  const { messages, context, stream, user_id } = parsed.data;

  const systemPrompt = buildSystemPrompt(context);
  const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));

  // ── Streaming mode ──
  if (stream) {
    return handleStream(res, apiMessages, systemPrompt, user_id ?? null);
  }

  // ── Standard mode with tool loop ──
  return handleStandard(res, apiMessages, systemPrompt, user_id ?? null);
}

// ── Standard handler with tool loop ──

interface ToolAction {
  type: string;
  data: Record<string, unknown>;
}

interface ToolResult {
  response: Record<string, unknown>;
  action: ToolAction | null;
}

async function handleStandard(res: VercelResponse, apiMessages: Array<{ role: string; content: unknown }>, systemPrompt: string, userId: string | null) {
  let lastError: Error | undefined;
  let currentMessages = [...apiMessages];
  const actions: ToolAction[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      let response = await callClaude(currentMessages, systemPrompt, false) as { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> };

      // Tool use loop — max 3 iterations to prevent runaway
      for (let toolRound = 0; toolRound < 3; toolRound++) {
        const toolUseBlocks = (response.content || []).filter((b) => b.type === 'tool_use');
        if (toolUseBlocks.length === 0) break;

        // Execute tools
        const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
        for (const block of toolUseBlocks) {
          const result = await executeTool(block.name!, block.input!, userId);
          if (result.action) actions.push(result.action);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id!,
            content: JSON.stringify(result.response),
          });
        }

        // Continue conversation with tool results
        currentMessages = [
          ...currentMessages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults },
        ];

        response = await callClaude(currentMessages, systemPrompt, false) as { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> };
      }

      // Extract final text
      let text = '';
      for (const block of response.content || []) {
        if (block.type === 'text') text += block.text;
      }
      text = text.replace(/^```(?:\w+)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

      return res.json({ success: true, text, actions });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  return res.status(500).json({ success: false, error: lastError?.message || 'Unknown error' });
}

// ── Streaming handler with tool support ──

async function handleStream(res: VercelResponse, apiMessages: Array<{ role: string; content: unknown }>, systemPrompt: string, userId: string | null) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    const response = await callClaude(apiMessages, systemPrompt, true) as Response;

    if (!response.ok) {
      const err = await response.text();
      res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let currentToolId: string | null = null;
    let currentToolName: string | null = null;
    let currentToolInput = '';
    const assistantContent: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> = [];

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
            let parsedInput: Record<string, unknown> = {};
            try { parsedInput = JSON.parse(currentToolInput); } catch {}
            toolCalls.push({ id: currentToolId, name: currentToolName!, input: parsedInput });
            assistantContent.push({ type: 'tool_use', id: currentToolId, name: currentToolName!, input: parsedInput });
            currentToolId = null;
            currentToolName = null;
            currentToolInput = '';
          }
        } catch {
          // Skip malformed events
        }
      }
    }

    // Handle tool calls if any were collected
    if (toolCalls.length > 0) {
      const fullAssistantContent: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = [];
      if (fullText) fullAssistantContent.push({ type: 'text', text: fullText });
      fullAssistantContent.push(...assistantContent);

      const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
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

      const followupMessages = [
        ...apiMessages,
        { role: 'assistant', content: fullAssistantContent },
        { role: 'user', content: toolResults },
      ];

      const followup = await callClaude(followupMessages, systemPrompt, false) as { content: Array<{ type: string; text?: string }> };
      for (const block of followup.content || []) {
        if (block.type === 'text' && block.text) {
          res.write(`data: ${JSON.stringify({ t: block.text })}\n\n`);
        }
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

// ── Call Claude API ──

async function callClaude(messages: Array<{ role: string; content: unknown }>, systemPrompt: string, stream: boolean): Promise<Response | Record<string, unknown>> {
  const body: Record<string, unknown> = {
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
        'x-api-key': process.env.CLAUDE_API_KEY!,
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
      'x-api-key': process.env.CLAUDE_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  return response.json();
}

// ── Tool execution ──

async function executeTool(name: string, input: Record<string, unknown>, userId: string | null): Promise<ToolResult> {
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
  if (name === 'show_income_summary') {
    return executeIncomeSummary(userId);
  }
  return { response: { error: 'Unknown tool' }, action: null };
}

async function executeOverride(input: Record<string, unknown>, userId: string | null): Promise<ToolResult> {
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
    notes: (input.notes as string) || null,
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
        notes: (input.notes as string) || null,
      },
    },
  };
}

async function executeBudgetItem(input: Record<string, unknown>, userId: string | null): Promise<ToolResult> {
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
      message: `Added ${input.description} (\u00a3${input.monthly_amount}/month) to your ${input.is_essential ? 'essentials' : 'lifestyle'} budget.`,
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

async function executePlan(input: Record<string, unknown>, userId: string | null): Promise<ToolResult> {
  if (!userId) {
    console.error('[executePlan] No userId provided');
    return {
      response: { success: false, error: 'No user session' },
      action: { type: 'plan_error', data: { error: 'Not signed in \u2014 please sign in to create plans.' } },
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('[executePlan] Missing env vars:', { url: !!supabaseUrl, key: !!serviceKey });
    return {
      response: { success: false, error: 'Server misconfigured' },
      action: { type: 'plan_error', data: { error: 'Server configuration issue \u2014 plan could not be saved.' } },
    };
  }

  const admin = createClient(supabaseUrl, serviceKey);

  const planRow = {
    user_id: userId,
    action: input.action,
    target_amount: (input.target_amount as number) || null,
    monthly_saving: (input.monthly_saving as number) || null,
    timeline: (input.timeline as string) || null,
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
        target_amount: (input.target_amount as number) || null,
        monthly_saving: (input.monthly_saving as number) || null,
        timeline: (input.timeline as string) || null,
      },
    },
  };
}

async function executeGoalUpdate(input: Record<string, unknown>, userId: string | null): Promise<ToolResult> {
  if (!userId) {
    return {
      response: { success: false, error: 'No user session' },
      action: null,
    };
  }

  return {
    response: { success: true, message: 'Goal update suggested to user for confirmation.' },
    action: {
      type: 'goal_update_proposed',
      data: {
        reason: input.reason,
        new_situation: input.new_situation,
        new_one_year_goal: input.new_one_year_goal,
        new_two_year_goal: input.new_two_year_goal,
        new_target_amount: (input.new_target_amount as number) || null,
      },
    },
  };
}

async function executeGifSearch(input: Record<string, unknown>): Promise<ToolResult> {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    return { response: { success: false, error: 'GIF search not configured' }, action: null };
  }

  try {
    const q = encodeURIComponent((input.query as string) || 'thumbs up');
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${q}&limit=5&rating=pg`;
    const fetchRes = await fetch(url);
    if (!fetchRes.ok) {
      return { response: { success: false, error: 'GIPHY request failed' }, action: null };
    }

    const data = await fetchRes.json();
    const gifs: Array<{ images?: { fixed_height?: { url?: string }; original?: { url?: string } } }> = data.data || [];
    if (gifs.length === 0) {
      return { response: { success: false, error: 'No GIFs found for that query' }, action: null };
    }

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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { response: { success: false, error: message }, action: null };
  }
}

// ── System prompt builder ──

interface ChatContext {
  identity?: Record<string, unknown>;
  monthly_income?: number;
  monthly_spending?: number;
  surplus?: number;
  decision_score?: number;
  archetype?: string;
  income_sources?: Array<Record<string, unknown>>;
  budget_line?: Record<string, unknown>;
  household_cashflow?: Record<string, unknown>;
  spending_by_category?: Array<{ category: string; monthly: number }>;
  subscriptions?: Array<{ merchant: string; amount: number }>;
  verified_bills?: Array<Record<string, unknown>>;
  essential_gaps?: Array<Record<string, unknown>>;
  all_moves?: Array<Record<string, unknown>>;
  recent_transfers?: Array<{ description: string; amount: number }>;
  budget_adjustments?: Array<Record<string, unknown>>;
  debt_accounts?: Array<Record<string, unknown>>;
  goals?: Record<string, unknown>;
  goal_trajectory?: Record<string, unknown>;
  recent_transactions?: Array<Record<string, unknown>>;
  behavioral_patterns?: string[];
  payday_context?: Record<string, unknown>;
  uncategorized_transactions?: Array<{ description: string; amount: number; date: string; count: number }>;
}

async function executeIncomeSummary(userId: string | null): Promise<ToolResult> {
  if (!userId) {
    return { response: { success: false, error: 'No user session' }, action: null };
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { response: { success: false, error: 'Server misconfigured' }, action: null };
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: analysis } = await admin
    .from('analyses')
    .select('monthly_income, income_sources, non_discretionary, discretionary, surplus')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!analysis) {
    return { response: { success: false, error: 'No analysis data yet' }, action: null };
  }

  const incomeSources = (analysis.income_sources || []).map((s: any) => ({
    source: s.source,
    frequency: s.frequency || 'monthly',
    monthly: Math.round(s.monthly || 0),
    isSalary: !!s.isSalary,
  }));

  const essentialsTotal = Math.round(analysis.non_discretionary?.total || 0);
  const lifestyleTotal = Math.round(analysis.discretionary?.total || 0);
  const monthlyIncome = Math.round(analysis.monthly_income || 0);
  const surplus = Math.round(analysis.surplus || (monthlyIncome - essentialsTotal - lifestyleTotal));

  return {
    response: {
      success: true,
      message: 'Income summary card displayed.',
      income_sources: incomeSources,
      monthly_income: monthlyIncome,
      essentials_total: essentialsTotal,
      lifestyle_total: lifestyleTotal,
      surplus,
    },
    action: {
      type: 'income_summary',
      data: {
        income_sources: incomeSources,
        monthly_income: monthlyIncome,
        essentials_total: essentialsTotal,
        lifestyle_total: lifestyleTotal,
        surplus,
      },
    },
  };
}

function buildSystemPrompt(ctx: ChatContext | undefined): string {
  let prompt = `You are Bocy. You ARE the user's financial brain. You've already analysed their bank data, you track their spending, you manage their plans, and you hold them accountable.

HARD WORD LIMIT:
- EVERY reply MUST be 12 words or fewer. Count before sending. Non-negotiable.
- "hello" \u2192 "hey! what's on your mind?" (6 words). That's the vibe.
- Even complex answers: "you're blowing **\u00a3340/mo** on subs. want me to dig in?" (11 words).
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
- Use \u00a3 and British English.
- Be razor-specific: "ditch Now TV and Paramount+, **\u00a394/mo back**" not "you might want to look at your subscriptions."
- NEVER use dashes (\u2014, \u2013, -), arrows (\u2192, ->, =>), or any dash-like separators. Flow naturally.
- Never recommend other apps. You do it all.
- NEVER recommend specific financial products, providers, or funds (no "open a Vanguard ISA", "get an AJ Bell SIPP", "use a Chase savings account"). You show the tax maths, allowance numbers, and effective rates. The user decides what to do with that.
- When discussing tax wrappers (ISA, pension, GIA), state the mathematical facts: allowance remaining, tax relief rate, effective cost per \u00a31. Never say "you should put money in X."
- NEVER guess or assume expenses that aren't in the data. If you don't see rent, council tax, childcare, or other expected essentials, ASK the user \u2014 don't fill in amounts yourself. Say "I don't see rent in your transactions \u2014 do you pay it via another account or a partner?" The user's data might be correct (they might live rent-free, or pay via a partner). ALWAYS confirm before acting.
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
- GOOD: "you're smashing **\u00a3400/mo** on takeaways. want to dig into that?"

GIFs:
- Occasionally (roughly 1 in 4 replies), use the search_gif tool to fetch a reaction GIF.
- Call search_gif FIRST with a short mood query (e.g. "money rain", "facepalm", "celebration"). You'll get back a real URL.
- Then include it in your text reply using: ![gif](THE_URL) on its own line, AFTER your text.
- NEVER fabricate or guess GIF URLs. ALWAYS use the URL returned by search_gif.
- Match the emotion: celebratory for wins, empathetic for tough moments, cheeky for spending call-outs.
- Good GIF moments: user hits a milestone, user overspent hilariously, you deliver a harsh truth, user asks something simple.
- NEVER use a GIF when delivering serious bad news or when the user is stressed. Read the room.
- Keep it to ONE gif per message max. Never two. If the tool fails, just skip the GIF \u2014 don't mention it.

Tools:
- When the user corrects a transaction (recategorise, flag as essential/non-essential, mentions a payment not showing), use save_transaction_override to save their correction. For the match_description, use the EXACT bank description shown in the transfers list if available \u2014 partial matches work (e.g. "JOHN" will match "TFR TO JOHN SMITH"). Common cases: rent paid to partner/housemate, bill splits, debt repayments showing as transfers.
- IMPORTANT: When the user says a person-to-person payment is NOT income, use category "Transfers" \u2014 NOT "Other". Transfers stay visible in their transaction history but won't inflate income figures. If the payment is a partner's household contribution (rent share, bills share), use "Household Contribution" instead \u2014 this is also excluded from income but tracked as a regular inflow. If the user says "that's my own account", use "Internal Transfer".
- When the user EXPLICITLY asks to set a target or track a goal, use propose_plan to create it. The user will see an "Add to plan" button and can approve or dismiss it from the chat. NEVER call propose_plan unless the user directly asks for a plan. Answering questions, giving breakdowns, or discussing budgets is NOT a reason to create a plan. If a user asks "how should I split my paycheck" that's a question \u2014 answer it, don't create a plan.
- When the user EXPLICITLY tells you to add a specific expense with a concrete amount, use save_budget_item. The user must provide both what it is AND how much. NEVER call this tool based on assumptions or as part of a breakdown. If you notice rent or an essential is missing from their data, ASK about it first \u2014 don't add it yourself.
- When the user's situation has clearly changed (life event, achieved a goal, outgrown their current goal), use suggest_goal_update to propose updated goals. This re-aligns all future analysis. Don't suggest this casually \u2014 only when a real shift has happened.
- IMPORTANT: In all tool call inputs (action titles, reasons, descriptions), use PLAIN TEXT only \u2014 no markdown, no **bold**, no *italic*. Markdown is only for your chat messages.`;

  if (!ctx) return prompt;

  // ── User Identity (from onboarding discovery) ──
  if (ctx.identity) {
    const id = ctx.identity as Record<string, unknown>;
    prompt += `\n\nUser's life context (critical for personalisation):`;
    if (id.work_setup) prompt += `\n- Work setup: ${(id.work_setup as string).replace(/_/g, ' ')}`;
    if (id.household) prompt += `\n- Household: ${(id.household as string).replace(/_/g, ' ')}`;
    if (id.housing) prompt += `\n- Housing: ${(id.housing as string).replace(/_/g, ' ')}`;
    if (id.financial_experience) prompt += `\n- Financial experience: ${id.financial_experience}`;
    if (id.risk_appetite) prompt += `\n- Risk appetite: ${id.risk_appetite}`;
    if ((id.priorities as string[])?.length) prompt += `\n- Top priorities: ${(id.priorities as string[]).join(', ')}`;
    if ((id.upcoming_events as string[])?.length && !(id.upcoming_events as string[]).includes('none')) {
      prompt += `\n- Upcoming events: ${(id.upcoming_events as string[]).join(', ').replace(/_/g, ' ')}`;
    }
    if ((id.dependents as string[])?.length && !(id.dependents as string[]).includes('none')) {
      prompt += `\n- Dependents: ${(id.dependents as string[]).join(', ').replace(/_/g, ' ')}`;
    }
    prompt += `\nIMPORTANT: Tailor ALL insights to this life context. A self-employed single parent has different tax and allowance positions than a salaried office worker in a couple. Reference their specific situation.`;
  }

  // ── Core financials ──
  prompt += `\n\nUser's financial snapshot:`;
  if (ctx.monthly_income) prompt += `\n- Monthly income: \u00a3${Math.round(ctx.monthly_income)}`;
  if (ctx.monthly_spending) prompt += `\n- Monthly spending: \u00a3${Math.round(ctx.monthly_spending)}`;
  if (ctx.surplus != null) prompt += `\n- Monthly surplus: \u00a3${Math.round(ctx.surplus)}`;
  if (ctx.decision_score != null) prompt += `\n- Financial health score: ${ctx.decision_score}/100`;
  if (ctx.archetype) prompt += `\n- Financial profile: ${ctx.archetype}`;

  // ── Income sources with pay frequency ──
  if (ctx.income_sources?.length) {
    prompt += `\n\nIncome sources:`;
    for (const src of ctx.income_sources) {
      const freq = (src.frequency as string) || 'irregular';
      const freqLabel = freq === 'weekly' ? 'weekly' : freq === 'fortnightly' ? 'fortnightly' : freq === 'monthly' ? 'monthly' : 'irregular';
      prompt += `\n- ${src.source}: \u00a3${Math.round(src.avgAmount as number)} per payment (${freqLabel}), \u00a3${Math.round(src.monthly as number)}/month${src.isSalary ? ' [primary salary]' : ''}`;
    }
    const primarySrc = ctx.income_sources.find(s => s.isSalary) || ctx.income_sources[0];
    if (primarySrc) {
      const freq = (primarySrc.frequency as string) || 'monthly';
      prompt += `\nIMPORTANT: User is paid ${freq}. When discussing paycheck breakdowns, budgets per pay period, or "what to do with this paycheck", frame everything in ${freq} terms, not monthly (unless the user asks for monthly). A ${freq} earner receiving \u00a3${Math.round(primarySrc.avgAmount as number)} needs to think about \u00a3${Math.round(primarySrc.avgAmount as number)} at a time, not \u00a3${Math.round(ctx.monthly_income!)}.`;
    }
  }

  // ── Budget line ──
  if (ctx.budget_line) {
    const bl = ctx.budget_line as Record<string, unknown>;
    prompt += `\n\nBudget line (pre-calculated \u2014 use these numbers directly):`;
    prompt += `\n- Real spending power: \u00a3${bl.real_spending_power}/month (income minus fixed costs \u2014 this is what they can actually allocate)`;
    prompt += `\n- Essentials: \u00a3${bl.essentials_total}/month (${bl.essentials_pct}% of income)`;
    prompt += `\n- Lifestyle: \u00a3${bl.lifestyle_total}/month`;
    prompt += `\n- Left to decide: \u00a3${bl.left_to_decide}/month`;
    if (bl.over_budget) {
      prompt += `\n- STATUS: \u00a3${bl.over_amount} OFF BALANCE. Total spending exceeds income by \u00a3${bl.over_amount}. Frame this as fixable, not alarming. Use "spending gap" or "off balance", never "over budget." Point them to their plan and moves.`;
    } else if (bl.left_to_decide === 0) {
      prompt += `\n- STATUS: FULLY ALLOCATED. Every pound has a job. Any new expense needs a trade-off from somewhere else.`;
    } else if ((bl.left_to_decide as number) / ((ctx.monthly_income as number) || 1) < 0.1) {
      prompt += `\n- STATUS: TIGHT. Only \u00a3${bl.left_to_decide} unallocated. Validate their discipline rather than warning them.`;
    }
    if (bl.essentials_change_pct != null && (bl.essentials_change_pct as number) !== 0) {
      prompt += (bl.essentials_change_pct as number) > 0
        ? `\n- Essentials rose ${bl.essentials_change_pct}% vs last month \u2014 real spending power has dropped.`
        : `\n- Essentials fell ${Math.abs(bl.essentials_change_pct as number)}% vs last month \u2014 they freed up money.`;
    }
    if (bl.top_lifestyle_category && bl.top_lifestyle_amount) {
      const tradeOff = Math.min(50, Math.round((bl.top_lifestyle_amount as number) * 0.3));
      prompt += `\n- Trade-off example: cutting \u00a3${tradeOff} from ${(bl.top_lifestyle_category as string).toLowerCase()} = \u00a3${tradeOff} more toward savings or debt.`;
    }
    if (bl.allocation_efficiency != null) {
      prompt += `\n- Allocation efficiency: ${bl.allocation_efficiency}/100 (how close their current spending pattern is to the mathematically optimal allocation given their priorities)`;
      if ((bl.allocation_efficiency as number) < 60) {
        prompt += ` \u2014 significant room to rebalance for better outcomes.`;
      } else if ((bl.allocation_efficiency as number) >= 85) {
        prompt += ` \u2014 well-optimised. Minor tweaks only.`;
      }
    }
    if (bl.top_reallocation) {
      const r = bl.top_reallocation as Record<string, unknown>;
      prompt += `\n- Top reallocation: move \u00a3${r.amount}/month from ${r.from} to ${r.to}. ${r.utility_gain}.`;
    }
    prompt += `\nIMPORTANT: When discussing budgets, trade-offs, or "can I afford X", use these budget line numbers. Say things like "You earn \u00a3X but \u00a3Y goes to fixed costs, so you actually have \u00a3Z to work with" \u2014 make it tangible, not abstract.`;
  }

  // ── Household cash flow scenarios ──
  if (ctx.household_cashflow) {
    const hc = ctx.household_cashflow as Record<string, unknown>;
    prompt += `\n\nHousehold cash flow (Monte Carlo simulated):`;
    if ((hc.shared_expense_ratio as number) > 0) {
      prompt += `\n- Joint surplus: \u00a3${hc.joint_surplus}/month (${hc.shared_expense_ratio}% of expenses are shared)`;
    }
    prompt += `\n- Buffer adequacy: ${hc.buffer_adequacy}% (probability current savings survive 24 months of simulated shocks)`;
    if ((hc.buffer_adequacy as number) < 50) {
      prompt += ` \u2014 this is concerning. Prioritise building the buffer.`;
    } else if ((hc.buffer_adequacy as number) >= 80) {
      prompt += ` \u2014 strong position. Buffer handles most scenarios.`;
    }
    if ((hc.scenarios as unknown[])?.length) {
      prompt += `\n- Risk scenarios:`;
      for (const s of (hc.scenarios as Array<Record<string, unknown>>).slice(0, 5)) {
        prompt += `\n  \u2022 ${s.label} (${s.probability}% annual chance): \u00a3${Math.abs(s.monthly_impact as number)}/month impact \u2014 ${s.description}`;
      }
    }
    prompt += `\nIMPORTANT: When the user asks about financial resilience, "what if" scenarios, or whether they can afford a life change, reference these scenario probabilities. Make risk feel concrete: "There's a ${(hc.scenarios as Array<Record<string, unknown>>)?.[0]?.probability || 6}% chance of income disruption this year \u2014 your buffer ${(hc.buffer_adequacy as number) >= 70 ? 'covers that well' : 'would struggle with that'}."`;
  }

  // ── Spending breakdown ──
  if (ctx.spending_by_category?.length) {
    prompt += `\n\nSpending by category (MONTHLY AVERAGES \u2014 these are per-month figures, not totals):`;
    for (const c of ctx.spending_by_category) {
      const cat = c as Record<string, unknown>;
      let line = `\n- ${cat.category}: \u00a3${Math.round(cat.monthly as number)}/month`;
      if (cat.txCount) line += ` (${cat.txCount} transactions)`;
      if ((cat.topMerchants as unknown[])?.length) {
        const merchants = (cat.topMerchants as Array<{ name: string; amount: number }>)
          .map(m => `${m.name} \u00a3${m.amount}`)
          .join(', ');
        line += `\n  Top merchants: ${merchants}`;
      }
      prompt += line;
    }
  }

  // ── Subscriptions ──
  if (ctx.subscriptions?.length) {
    prompt += `\n\nActive subscriptions (each is one recurring subscription, showing the average per-payment amount):`;
    for (const s of ctx.subscriptions) {
      prompt += `\n- ${s.merchant}: \u00a3${Math.abs(s.amount).toFixed(2)}/month`;
    }
    prompt += `\nIMPORTANT: Do NOT multiply these amounts by months when discussing current spending. Each figure is already the monthly cost. If a user pays \u00a310/month for Netflix, their monthly Netflix spend is \u00a310, not \u00a340 (even if they've had it for 4 months).`;
  }

  // ── Verified bills ──
  if (ctx.verified_bills?.length) {
    prompt += `\n\n\u2713 VERIFIED BILLS \u2014 These exact amounts are confirmed from the user's transaction history:`;
    for (const bill of ctx.verified_bills) {
      const b = bill as Record<string, unknown>;
      prompt += `\n- ${b.merchant} (${b.category}): \u00a3${b.monthlyAmount}/month (paid ${b.frequency}, last payment \u00a3${b.lastPayment} on ${b.lastPaymentDate})`;
    }
    prompt += `\n\nThese are REAL amounts from actual bank transactions, not estimates. Use these exact figures when discussing budgets, paycheck breakdowns, and essential costs. They are more reliable than typical ranges.`;
  }

  // ── Essential gaps ──
  if (ctx.essential_gaps?.length) {
    prompt += `\n\n\u26a0 MISSING ESSENTIALS \u2014 These expenses are expected based on the user's profile but NOT visible in their transaction data:`;
    for (const gap of ctx.essential_gaps) {
      const g = gap as Record<string, unknown>;
      const range = g.typicalRange as { low: number; high: number };
      prompt += `\n- ${g.category}: ${g.reason}. Typical UK range: \u00a3${range.low}-\u00a3${range.high}/month. Confidence: ${g.confidence}.`;
    }
    prompt += `\n\nHOW TO HANDLE MISSING ESSENTIALS:`;
    prompt += `\n- These gaps mean the surplus figure (\u00a3${Math.round(ctx.surplus || 0)}/month) may be OVERSTATED. The real surplus could be significantly lower.`;
    prompt += `\n- When the user asks about budgets, paycheck splits, or "how much can I save", FIRST check if you've already asked about these gaps in this conversation.`;
    prompt += `\n- If not yet asked, raise ONE gap per message. Example: "I don't see rent in your transactions. Do you pay it via a partner or another account? Knowing the amount helps me give you an accurate breakdown."`;
    prompt += `\n- NEVER assume amounts. NEVER auto-fill. Wait for the user to tell you the number.`;
    prompt += `\n- When the user provides an amount, use save_budget_item to record it. Only then.`;
    prompt += `\n- Low-confidence gaps (insurance, water) \u2014 only ask if the user is specifically discussing budgets or expenses. Don't lead with these.`;
    prompt += `\n- Once a gap is filled via save_budget_item, it won't appear in future conversations.`;
  }

  // ── All moves ──
  if (ctx.all_moves?.length) {
    prompt += `\n\nFinancial moves (ranked by impact, shown on user's home screen):`;
    for (const m of ctx.all_moves) {
      let line = `\n- [${m.category || 'general'}] ${m.action} \u2192 \u00a3${Math.round(m.monthlyImpact as number)}/month (\u00a3${Math.round((m.annualImpact as number) || (m.monthlyImpact as number) * 12)}/year, effort: ${m.effort})`;
      if ((m.merchants as string[])?.length) line += `\n  Merchants: ${(m.merchants as string[]).join(', ')}`;
      if (m.strategy) line += `\n  Strategy: ${m.strategy}`;
      if ((m.steps as string[])?.length) line += `\n  Steps: ${(m.steps as string[]).join(' \u2192 ')}`;
      if (m.effect) line += `\n  Effect: ${m.effect}`;
      if ((m.subGoals as unknown[])?.length) {
        for (const sg of m.subGoals as Array<Record<string, unknown>>) {
          line += `\n  Sub-goal: ${sg.type} ${sg.target} from \u00a3${sg.startValue} to \u00a3${sg.targetValue}`;
        }
      }
      if (m.proof) line += `\n  Proof: ${(m.proof as string).replace(/\n/g, '; ')}`;
      if ((m as any).trajectory?.confidence) {
        const t = (m as any).trajectory;
        const conf = t.confidence;
        line += `\n  Trajectory: ${t.currentMonths}mo \u2192 ${conf.p50}mo (p10=${conf.p10}, p90=${conf.p90}, 12mo hit rate=${conf.hitRate12m}%)`;
      }
      prompt += line;
    }
    prompt += `\nThese moves are shown on the user's home screen. When they ask about a specific move, reference the exact merchants, steps, and amounts. When they want to act on a move, use the appropriate tool (save_transaction_override for reclassifications, save_budget_item for adding expenses, propose_plan for savings targets). Each move includes a mathematical proof showing how the impact was calculated — reference this when users question the numbers.`;
  }

  // ── Recent transfers ──
  if (ctx.recent_transfers?.length) {
    prompt += `\n\nRecent transfers & uncategorised payments (may need reclassifying):`;
    for (const t of ctx.recent_transfers) {
      prompt += `\n- "${t.description}" \u00a3${Math.abs(t.amount).toFixed(2)}`;
    }
    prompt += `\nIf the user mentions a payment that matches one of these, use save_transaction_override with the exact description above as match_description.`;
  }

  // ── Uncategorized transactions (need user review) ──
  if (ctx.uncategorized_transactions?.length) {
    prompt += `\n\n⚠ UNCATEGORIZED TRANSACTIONS — These could not be auto-categorised. The user should confirm what they are:`;
    for (const tx of ctx.uncategorized_transactions) {
      const t = tx as Record<string, unknown>;
      prompt += `\n- "${t.description}" — £${Math.abs(t.amount as number).toFixed(2)} total (${t.count} transaction${(t.count as number) > 1 ? 's' : ''})`;
    }
    prompt += `\nIMPORTANT: When the user first opens chat and there are uncategorized transactions, proactively mention them. Example: "I've got **${ctx.uncategorized_transactions.length} transaction${ctx.uncategorized_transactions.length > 1 ? 's' : ''}** I couldn't categorise. want to sort them?"`;
    prompt += `\nWhen the user identifies what a transaction is, use save_transaction_override to categorise it. NEVER guess or auto-assign categories for these — always ask the user first.`;
    prompt += `\nDo NOT hide these from the user. Transparency about what you don't know builds trust.`;
  }

  // ── Manual budget items ──
  if (ctx.budget_adjustments?.length) {
    prompt += `\n\nManual budget items (already added by user \u2014 don't re-add these):`;
    for (const a of ctx.budget_adjustments) {
      const adj = a as Record<string, unknown>;
      prompt += `\n- ${adj.description} (${adj.category}, ${adj.essential ? 'essential' : 'lifestyle'}): \u00a3${adj.amount}/month`;
    }
  }

  // ── Debt accounts ──
  if (ctx.debt_accounts?.length) {
    prompt += `\n\nDebt accounts:`;
    let totalDebt = 0;
    for (const d of ctx.debt_accounts) {
      const debt = d as Record<string, unknown>;
      const bal = debt.balance != null ? `\u00a3${Math.round(debt.balance as number)}` : 'unknown balance';
      const lim = debt.limit != null ? ` / \u00a3${Math.round(debt.limit as number)} limit` : '';
      const util = (debt.balance != null && debt.limit != null && (debt.limit as number) > 0)
        ? ` (${Math.round(((debt.balance as number) / (debt.limit as number)) * 100)}% utilised)`
        : '';
      const apr = debt.interest_rate != null ? `, APR: ${((debt.interest_rate as number) * 100).toFixed(1)}%` : ', APR: unknown';
      const minPay = debt.minimum_payment != null ? `, min payment: \u00a3${Math.round(debt.minimum_payment as number)}` : '';
      prompt += `\n- ${debt.name} (${debt.type}): ${bal}${lim}${util}${apr}${minPay}`;
      if (debt.balance != null) totalDebt += debt.balance as number;
    }
    if (totalDebt > 0) {
      prompt += `\nTotal outstanding debt: \u00a3${Math.round(totalDebt)}`;
    }
    const totalCreditLimit = ctx.debt_accounts.reduce((s, d) => s + ((d as Record<string, unknown>).limit as number || 0), 0);
    const overallUtilisation = totalCreditLimit > 0 ? Math.round((totalDebt / totalCreditLimit) * 100) : -1;
    if (overallUtilisation >= 0 && overallUtilisation <= 30) {
      prompt += `\nOverall utilisation: ${overallUtilisation}% \u2014 low utilisation, paying on time. No high-interest cost.`;
    } else if (overallUtilisation > 75) {
      prompt += `\nOverall utilisation: ${overallUtilisation}% \u2014 high utilisation. Interest costs are significant at this level.`;
    } else if (overallUtilisation > 30) {
      prompt += `\nOverall utilisation: ${overallUtilisation}% \u2014 moderate utilisation. Suggest bringing it below 30% for credit score benefits.`;
    }
    // Flag debt accounts with missing details
    const missingApr = ctx.debt_accounts.filter(d => (d as Record<string, unknown>).interest_rate == null);
    const missingMinPay = ctx.debt_accounts.filter(d => (d as Record<string, unknown>).minimum_payment == null);
    if (missingApr.length > 0 || missingMinPay.length > 0) {
      prompt += `\n⚠ MISSING DEBT DETAILS:`;
      if (missingApr.length > 0) {
        prompt += `\n- APR unknown for: ${missingApr.map(d => (d as Record<string, unknown>).name).join(', ')}. Ask the user for their interest rate when discussing debt strategy.`;
      }
      if (missingMinPay.length > 0) {
        prompt += `\n- Minimum payment unknown for: ${missingMinPay.map(d => (d as Record<string, unknown>).name).join(', ')}. Ask when discussing repayment plans.`;
      }
      prompt += `\nDon't guess these numbers — always ask the user. Getting the real APR matters for accurate payoff timelines.`;
    }
    prompt += `\nUse these actual balances when discussing debt strategy. Be specific \u2014 "Pay down your \u00a3${Math.round(totalDebt)} across ${ctx.debt_accounts.length} account(s)" not "attack your debts."`;
  }

  // ── Goals + staleness detection ──
  if (ctx.goals) {
    const goals = ctx.goals as Record<string, unknown>;
    prompt += `\n\nGoals:`;
    if (goals.current_situation) prompt += `\n- Situation: ${goals.current_situation}`;
    if (goals.one_year_goal) prompt += `\n- 1-year goal: ${goals.one_year_goal}`;
    if (goals.two_year_goal) prompt += `\n- 2-year goal: ${goals.two_year_goal}`;
    if (goals.target_amount) prompt += `\n- Target amount: \u00a3${goals.target_amount}`;

    const hints: string[] = [];
    const situation = goals.current_situation as string;
    const oneYear = goals.one_year_goal as string;
    const surplus = ctx.surplus || 0;

    if (situation === 'in_debt' && surplus > 200) {
      hints.push('User says "in debt" but has \u00a3' + Math.round(surplus) + ' monthly surplus \u2014 situation may have improved.');
    }
    if (oneYear === 'clear_debt' && surplus > 300) {
      hints.push('Goal is "clear debt" but surplus is strong \u2014 they may have already cleared it or be close.');
    }
    if (situation === 'breaking_even' && surplus > 400) {
      hints.push('User says "breaking even" but surplus is \u00a3' + Math.round(surplus) + '/month \u2014 they\'re actually saving.');
    }
    if (oneYear === 'emergency_fund' && surplus > 500) {
      hints.push('Goal is "emergency fund" \u2014 with \u00a3' + Math.round(surplus) + '/month surplus, they may have already built one.');
    }
    if (situation === 'saving_slowly' && surplus > 600) {
      hints.push('User says "saving slowly" but surplus of \u00a3' + Math.round(surplus) + '/month suggests they\'re saving well.');
    }

    if (hints.length > 0) {
      prompt += `\n\n\u26a0 Goal alignment check (only mention if user brings up goals or asks about progress):`;
      for (const h of hints) {
        prompt += `\n- ${h}`;
      }
      prompt += `\nIf the user mentions their goals or progress, consider suggesting a goal update using suggest_goal_update.`;
    }
  }

  // ── Goal trajectory ──
  if (ctx.goal_trajectory) {
    const gt = ctx.goal_trajectory as Record<string, unknown>;
    prompt += `\n\nGoal trajectory: "${gt.goalLabel}" \u2014 currently ${gt.currentMonths} months away, could be ${gt.newMonths} months with moves. ${gt.insight}`;

    if (gt.confidence) {
      const c = gt.confidence as Record<string, unknown>;
      prompt += `\n\nMonte Carlo analysis (1,000 simulations accounting for income volatility, spending variance, and emergencies):`;
      prompt += `\n- Optimistic: ${c.p10} months (10th percentile)`;
      prompt += `\n- Most likely: ${c.p50} months (median)`;
      prompt += `\n- Conservative: ${c.p90} months (90th percentile)`;
      if ((c.hitRate12m as number) > 0 && (c.hitRate12m as number) < 100) {
        prompt += `\n- ${c.hitRate12m}% probability of reaching goal within 12 months`;
      }
      if ((c.hitRate24m as number) > 0 && (c.hitRate24m as number) < 100) {
        prompt += `\n- ${c.hitRate24m}% probability of reaching goal within 24 months`;
      }
      prompt += `\nWhen discussing timelines, use these probability ranges instead of single-point estimates. Say "most likely X months" rather than "X months". Mention the range when relevant (e.g. "between X and Y months depending on circumstances"). Reference the hit rate percentages to set realistic expectations.`;
    }

    if (gt.bufferRecommendation) {
      const b = gt.bufferRecommendation as Record<string, unknown>;
      prompt += `\n\nBuffer analysis (Monte Carlo): \u00a3${(b.amount as number).toLocaleString()} (${b.months} months of expenses) covers ${b.coverageRate}% of simulated income shock scenarios.`;
    }
  }

  // ── Recent transactions ──
  if (ctx.recent_transactions?.length) {
    const byDate: Record<string, Array<Record<string, unknown>>> = {};
    for (const tx of ctx.recent_transactions) {
      const d = ((tx.date as string) || '').split('T')[0] || 'unknown';
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(tx);
    }
    prompt += `\n\nRecent transactions (last 7 days):`;
    for (const [date, txs] of Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0]))) {
      const dayTotal = txs.filter(t => (t.amount as number) < 0).reduce((s, t) => s + Math.abs(t.amount as number), 0);
      const dayLabel = formatRelativeDate(date);
      prompt += `\n${dayLabel} (spent \u00a3${dayTotal.toFixed(2)}):`;
      for (const tx of txs) {
        const sign = (tx.amount as number) >= 0 ? '+' : '-';
        prompt += `\n  ${sign}\u00a3${Math.abs(tx.amount as number).toFixed(2)} ${tx.description} [${tx.category}${tx.essential ? ', essential' : ''}]`;
      }
    }
    prompt += `\nUse these to answer questions about daily or weekly spending. Be specific \u2014 reference actual merchants and amounts.`;
  }

  // ── Behavioral patterns ──
  if (ctx.behavioral_patterns?.length) {
    prompt += `\n\nBehavioral patterns detected:`;
    for (const p of ctx.behavioral_patterns) {
      prompt += `\n- ${p}`;
    }
  }

  // ── Payday mode ──
  if (ctx.payday_context) {
    const pc = ctx.payday_context as Record<string, unknown>;
    if ((pc.incomeArrivedThisWeek as boolean) && (pc.incomeEvents as unknown[])?.length) {
      const incomeEvents = pc.incomeEvents as Array<Record<string, unknown>>;
      const totalIncome = incomeEvents.reduce((s, e) => s + (e.amount as number), 0);
      const sources = incomeEvents.map(e => `\u00a3${Math.round(e.amount as number)} from ${e.source}`).join(', ');

      const payFrequencies = incomeEvents.map(e => e.frequency as string).filter(f => f && f !== 'unknown');
      const primaryFreq = payFrequencies[0] || 'monthly';
      const freqLabel = primaryFreq === 'weekly' ? 'weekly' : primaryFreq === 'fortnightly' ? 'fortnightly' : 'monthly';
      const periodsPerMonth = primaryFreq === 'weekly' ? 4.33 : primaryFreq === 'fortnightly' ? 2.17 : 1;

      prompt += `\n\n\ud83d\udd14 PAYDAY MODE ACTIVE \u2014 Income just landed this week:`;
      prompt += `\n- Income received: ${sources}`;
      prompt += `\n- Pay frequency: ${freqLabel} (user gets paid ${freqLabel})`;
      prompt += `\n- Already committed to bills/essentials this week: \u00a3${Math.round(pc.committedThisWeek as number)}`;
      prompt += `\n- Discretionary spending this week so far: \u00a3${Math.round(pc.discretionaryThisWeek as number)}`;
      prompt += `\n- Adaptive safe-to-spend budget: \u00a3${Math.round(pc.adaptiveBudget as number)}/week`;
      prompt += `\n- Static weekly budget: \u00a3${Math.round(pc.staticBudget as number)}/week`;
      prompt += `\n- IMPORTANT: This user is paid ${freqLabel}. ALL breakdowns must be per ${freqLabel === 'monthly' ? 'month' : freqLabel === 'fortnightly' ? 'fortnight' : 'week'}, NOT monthly (unless they ask for monthly). If they ask "how should I split this paycheck", break it down per pay period (${freqLabel}), not per month. For ${freqLabel} earners, divide monthly commitments by ${periodsPerMonth.toFixed(2)} to get per-paycheck amounts.`;

      prompt += `\n\nPAYDAY CONVERSATION RULES:`;
      prompt += `\n- Money just hit their account. Help them think through allocation \u2014 but ONLY if they ask. Don't dump a breakdown unprompted.`;
      prompt += `\n- CRITICAL: Do NOT call propose_plan or save_budget_item during payday conversations. These are questions, not plan requests.`;
      prompt += `\n- If they ask "how should I split this" or "where should this go", give a MATHEMATICAL breakdown based on their pay frequency and data \u2014 don't create plans or budget items.`;
      prompt += `\n- Use the adaptive budget (\u00a3${Math.round(pc.adaptiveBudget as number)}/week) not the static one.`;
      prompt += `\n- If they've already spent \u00a3${Math.round(pc.discretionaryThisWeek as number)} on discretionary this week, tell them exactly how much is left.`;
      prompt += `\n- NEVER guess missing essentials. If you don't see rent, council tax, or other expected essentials in their data, ASK: "I don't see rent in your transactions \u2014 do you pay it via a partner or another account?" Don't assume amounts.`;
      prompt += `\n- Do NOT just dump all these numbers. Weave them naturally into conversation. Only mention what's relevant to what they're asking about.`;
    }
  }

  return prompt;
}
