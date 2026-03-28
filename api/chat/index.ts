import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { formatRelativeDate } from '../../lib/date-utils.js';

const bodySchema = z.object({
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
    attachment: z.object({
      name: z.string(),
      type: z.string(),
      dataUrl: z.string(),
    }).optional(),
  })),
  context: z.record(z.string(), z.unknown()).optional(),
  stream: z.boolean().optional(),
  user_id: z.string().nullable().optional(),
});

// ── Phase 5A: Context Enforcement ──
// Validates that context contains the minimum required financial data.

interface ContextValidation {
  valid: boolean;
  missing: string[];
}

function validateContext(context: Record<string, unknown> | undefined): ContextValidation {
  if (!context) return { valid: false, missing: ['monthly_income', 'monthly_spending', 'surplus'] };

  const required = ['monthly_income', 'monthly_spending'];
  const missing = required.filter((key) => context[key] == null);

  return { valid: missing.length === 0, missing };
}

// ── Phase 5C: Conversation Mode Detection ──

type ConversationMode = 'query' | 'diagnostic' | 'decision' | 'execution' | 'general';

function detectConversationMode(userMessage: string): ConversationMode {
  const msg = userMessage.toLowerCase().trim();

  // Query: factual questions
  if (/^(how much|what is|what's|what are|show me|how many)/.test(msg)) return 'query';

  // Diagnostic: causality analysis
  if (/^(why (?:am|is|are|do)|what's wrong|what happened|explain)/.test(msg)) return 'diagnostic';

  // Decision: comparison/choice
  if (/^(should i|which is|compare|is it better|would it be)/.test(msg)) return 'decision';

  // Execution: action requests
  if (/^(do it|set up|create|start|cancel|save|add|remove)/.test(msg)) return 'execution';

  return 'general';
}

// ── Tax/Estate Intent Detection ──
// Detects when the user's question relates to tax optimisation, estate planning,
// inheritance, or wrapper allocation — so we can inject the tax_estate agent's
// analysis into the chat context for more accurate answers.

function isTaxEstateQuery(userMessage: string): boolean {
  const msg = userMessage.toLowerCase();
  const taxPatterns = [
    /\btax\b/, /\bisa\b/, /\bpension\b/, /\bsipp\b/, /\bwrapper/,
    /\binheritance\b/, /\biht\b/, /\bestate\b/, /\bgifting\b/,
    /\bcapital\s*gains?\b/, /\bcgt\b/, /\btax\s*relief\b/, /\btax\s*free\b/,
    /\bnil\s*rate\b/, /\bpersonal\s*allowance\b/, /\bsalary\s*sacrifice\b/,
    /\btax\s*drag\b/, /\btax\s*efficien/, /\btax\s*year\b/, /\b5\s*april\b/,
    /\bdividend\s*(?:tax|allowance)\b/, /\btaper\s*relief\b/,
    /\bwhere\s+should\s+(?:i|we)\s+put\b/, /\bwhich\s+account\b/,
    /\bshould\s+i\s+(?:invest|save|contribute)\b/,
  ];
  return taxPatterns.some((p) => p.test(msg));
}

// ── Phase 5B: Response Quality Validation ──

interface ResponseValidation {
  hasQuantification: boolean;
  hasAction: boolean;
  isFinancialQuestion: boolean;
}

function validateResponse(responseText: string, userMessage: string): ResponseValidation {
  const isFinancialQuestion = /(?:how much|budget|spend|save|invest|debt|money|income|cost|afford|pay)/i.test(userMessage);
  const hasQuantification = /£\d/.test(responseText);
  const hasAction = /\b(consider|move|transfer|cancel|reduce|increase|start|open|switch|compare|check)\b/i.test(responseText);

  return { hasQuantification, hasAction, isFinancialQuestion };
}

// ── Phase 5D: Proactive Insight Injection ──

function buildInsightContext(context: Record<string, unknown>): string {
  const parts: string[] = [];

  // Phase 5D: Active insights
  const insights = (context as any).active_insights as Array<{ statement: string; annualImpact: number; linkedMoveCategory?: string }> | undefined;
  if (insights && insights.length > 0) {
    const lines = insights.slice(0, 3).map((i) =>
      `- ${i.statement} (£${i.annualImpact}/yr impact)`,
    );
    parts.push(`## Active Insights (proactively surface when relevant)\n${lines.join('\n')}`);
  }

  // Agent pipeline recommendations (if available)
  const agentRecs = (context as any).agent_recommendations as Array<{ action: string; amount: number; expected_impact: number; source: string; destination: string }> | undefined;
  if (agentRecs && agentRecs.length > 0) {
    const lines = agentRecs.slice(0, 5).map((r) =>
      `- ${r.action} — Move £${r.amount} from ${r.source} → ${r.destination} (£${r.expected_impact}/yr benefit)`,
    );
    parts.push(`## Agent Recommendations (ranked by impact — reference these in responses)\n${lines.join('\n')}`);
  }

  // Agent-detected inefficiencies
  const agentInsights = (context as any).agent_insights as Array<{ type: string; description: string; annual_impact: number }> | undefined;
  if (agentInsights && agentInsights.length > 0) {
    const lines = agentInsights.slice(0, 3).map((i) =>
      `- [${i.type}] ${i.description} (£${i.annual_impact}/yr)`,
    );
    parts.push(`## Detected Inefficiencies\n${lines.join('\n')}`);
  }

  // Manual assets (investments/pensions on external platforms)
  const manualAssets = (context as any).manual_assets as Array<{ platform: string; asset_type: string; estimated_value: number; currency: string; notes: string | null }> | undefined;
  if (manualAssets && manualAssets.length > 0) {
    const lines = manualAssets.map((a) => {
      const typeLabel = a.asset_type.replace(/_/g, ' ');
      return `- ${a.platform}: ${typeLabel} — £${Math.round(a.estimated_value).toLocaleString()}${a.notes ? ` (${a.notes})` : ''}`;
    });
    const totalValue = manualAssets.reduce((s, a) => s + a.estimated_value, 0);
    parts.push(`## External Assets (manually tracked, not connected via open banking)\n${lines.join('\n')}\nTotal external assets: £${Math.round(totalValue).toLocaleString()}\nInclude these in net worth calculations and capital allocation analysis.`);
  }

  // Tax & Estate agent output (when available)
  const taxAnalysis = (context as any).tax_estate_analysis as {
    tax_analysis?: {
      effective_tax_rate: number;
      annual_tax_drag: number;
      wrapper_utilisation: { isa_used: number; isa_remaining: number; pension_contributed: number; pension_relief_captured: number };
      cgt_position: { realised_gains: number; allowance_remaining: number; losses_available: number };
      optimisation_opportunities: Array<{ type: string; description: string; annual_tax_saving: number }>;
    };
    estate_analysis?: {
      estimated_estate_value: number;
      iht_liability: number;
      nil_rate_band_available: number;
      residence_nil_rate_band_available: number;
      gifting_recommendations: Array<{ action: string; amount: number; iht_saving: number }>;
    };
  } | undefined;

  if (taxAnalysis?.tax_analysis) {
    const t = taxAnalysis.tax_analysis;
    const lines = [
      `- Effective tax rate: ${(t.effective_tax_rate * 100).toFixed(1)}%`,
      `- Annual tax drag: £${t.annual_tax_drag.toLocaleString()}/yr`,
      `- ISA remaining: £${t.wrapper_utilisation.isa_remaining.toLocaleString()} of £20,000`,
      `- Pension relief captured: £${t.wrapper_utilisation.pension_relief_captured.toLocaleString()}`,
      `- CGT allowance remaining: £${t.cgt_position.allowance_remaining.toLocaleString()} of £3,000`,
    ];
    if (t.optimisation_opportunities.length > 0) {
      lines.push('', 'Tax optimisation opportunities:');
      for (const o of t.optimisation_opportunities.slice(0, 4)) {
        lines.push(`  - ${o.description} (saves ~£${o.annual_tax_saving.toLocaleString()}/yr)`);
      }
    }
    parts.push(`## Tax Position Analysis\n${lines.join('\n')}`);
  }

  if (taxAnalysis?.estate_analysis && taxAnalysis.estate_analysis.iht_liability > 0) {
    const e = taxAnalysis.estate_analysis;
    const lines = [
      `- Estimated estate: £${e.estimated_estate_value.toLocaleString()}`,
      `- IHT liability: £${e.iht_liability.toLocaleString()}`,
      `- Nil rate band available: £${(e.nil_rate_band_available + e.residence_nil_rate_band_available).toLocaleString()}`,
    ];
    if (e.gifting_recommendations.length > 0) {
      lines.push('', 'Estate planning observations:');
      for (const g of e.gifting_recommendations.slice(0, 3)) {
        lines.push(`  - ${g.action} — potential IHT reduction: £${g.iht_saving.toLocaleString()}`);
      }
    }
    parts.push(`## Estate Position\nIMPORTANT: These are data-driven observations, not estate planning advice. Recommend the user consults a qualified adviser.\n${lines.join('\n')}`);
  }

  // Property portfolio (user-declared properties with mortgage data)
  const properties = (context as any).properties as Array<{
    address: string; postcode: string; estimated_value: number; purchase_price: number | null;
    property_type: string; equity: number;
    mortgage: { balance: number; rate: number; years_remaining: number; monthly_payment: number; type: string; fix_end_date: string | null } | null;
  }> | undefined;

  if (properties && properties.length > 0) {
    const totalPropertyValue = properties.reduce((s, p) => s + p.estimated_value, 0);
    const totalEquity = properties.reduce((s, p) => s + p.equity, 0);
    const totalMortgage = properties.reduce((s, p) => s + (p.mortgage?.balance || 0), 0);
    const lines = properties.map((p) => {
      let line = `- ${p.address} (${p.postcode}): ${p.property_type}, valued ~£${p.estimated_value.toLocaleString()}`;
      if (p.mortgage) {
        line += `\n  Mortgage: £${p.mortgage.balance.toLocaleString()} at ${p.mortgage.rate}% ${p.mortgage.type}`;
        if (p.mortgage.monthly_payment) line += `, £${p.mortgage.monthly_payment.toLocaleString()}/mo`;
        if (p.mortgage.years_remaining) line += `, ${p.mortgage.years_remaining} years left`;
        if (p.mortgage.fix_end_date) line += ` (fix ends ${p.mortgage.fix_end_date})`;
        line += `\n  Equity: £${p.equity.toLocaleString()}`;
      }
      return line;
    });
    parts.push(`## Property Portfolio\nTotal value: £${totalPropertyValue.toLocaleString()} | Total equity: £${totalEquity.toLocaleString()} | Total mortgage: £${totalMortgage.toLocaleString()}\n${lines.join('\n')}\nUse this data for net worth, mortgage optimisation, estate planning, and stamp duty calculations. When mortgage fix ends within 12 months, proactively suggest remortgage research.`);
  }

  // Estate planning documents status
  const estateDocs = (context as any).estate_documents as Array<{ type: string; status: string; updated_at: string }> | undefined;
  if (estateDocs && estateDocs.length > 0) {
    const lines = estateDocs.map((d) => `- ${d.type.replace(/_/g, ' ')}: ${d.status} (updated ${d.updated_at ? new Date(d.updated_at).toLocaleDateString() : 'N/A'})`);
    parts.push(`## Estate Planning Documents\n${lines.join('\n')}`);
  }

  // Tax signals from enrichment pipeline (structured transaction-level signals)
  const taxSignals = (context as any).tax_signals as Array<{
    type: string; annualAmount: number; monthlyAmount: number; confidence: number;
  }> | undefined;
  if (taxSignals && taxSignals.length > 0) {
    const lines = taxSignals
      .filter((s) => s.confidence >= 0.6)
      .map((s) => `- ${s.type.replace(/_/g, ' ')}: ~£${s.annualAmount.toLocaleString()}/yr (${s.confidence >= 0.8 ? 'high' : 'moderate'} confidence)`);
    if (lines.length > 0) {
      parts.push(`## Detected Tax-Relevant Transactions\n${lines.join('\n')}`);
    }
  }

  return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
}

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
    name: 'save_manual_asset',
    description:
      'Save a manual investment or asset that the user holds on an external platform (not connected via open banking). Use this when the user tells you about investments, pensions, ISAs, property, crypto, or other assets they hold elsewhere. Examples: "I have £30k in a Vanguard ISA", "My pension is worth about £85k with Aviva", "I have 2 BTC", "My house is worth £350k". The user must provide the platform/provider, asset type, and approximate value.',
    input_schema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'Platform or provider name. E.g. "Vanguard", "Hargreaves Lansdown", "Coinbase", "Workplace pension", "Property".',
        },
        asset_type: {
          type: 'string',
          description: 'Type of asset.',
          enum: ['stocks_and_shares_isa', 'cash_isa', 'general_investment', 'pension', 'sipp', 'crypto', 'property', 'premium_bonds', 'other'],
        },
        estimated_value: {
          type: 'number',
          description: 'Current estimated value in pounds.',
        },
        currency: {
          type: 'string',
          description: 'Currency if not GBP. Defaults to GBP.',
        },
        notes: {
          type: 'string',
          description: 'Additional details. E.g. "Global index fund", "workplace defined contribution", "Buy-to-let in Manchester".',
        },
      },
      required: ['platform', 'asset_type', 'estimated_value'],
    },
  },
  {
    name: 'manage_savings_account',
    description:
      'Add, update, or delete a savings account. Use this when the user tells you about a savings account they have, wants to update a balance or interest rate, or wants to remove one. Examples: "I have £5k in a Marcus account", "My ISA balance is now £12,000", "Remove my old Chip account". Also use when the user wants to tag an internal transfer as going to their savings — update the balance of the destination savings account.',
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'The operation to perform.',
          enum: ['add', 'update', 'delete'],
        },
        account_name: {
          type: 'string',
          description: 'Name of the savings account. E.g. "Marcus", "Chip", "Help to Buy ISA".',
        },
        provider: {
          type: 'string',
          description: 'Provider name (optional). E.g. "Goldman Sachs", "Chase".',
        },
        balance: {
          type: 'number',
          description: 'Current balance in pounds.',
        },
        interest_rate: {
          type: 'number',
          description: 'Annual interest rate as a percentage. E.g. 4.5.',
        },
        account_type: {
          type: 'string',
          description: 'Type of savings account.',
          enum: ['easy_access', 'fixed', 'isa', 'other'],
        },
        monthly_contribution: {
          type: 'number',
          description: 'How much the user puts into this account each month (optional). Helps track savings rate accurately.',
        },
      },
      required: ['operation', 'account_name'],
    },
  },
  {
    name: 'tag_transfer_as_savings',
    description:
      'Tag an internal transfer (between the user\'s own accounts) as a savings contribution. Use this when the user says a specific transfer goes to their savings. This creates a transaction override so future transfers matching this description are counted as savings, not just internal transfers. Examples: "The transfer to my Marcus is savings", "My standing order to Chip is my monthly savings".',
    input_schema: {
      type: 'object',
      properties: {
        match_description: {
          type: 'string',
          description: 'Transaction description to match (case-insensitive). E.g. "MARCUS", "TFR TO CHIP", "STANDING ORDER SAVINGS".',
        },
        savings_account_name: {
          type: 'string',
          description: 'Which savings account this transfer goes to (optional — helps link to a specific account).',
        },
        notes: {
          type: 'string',
          description: 'Brief note. E.g. "Monthly savings standing order".',
        },
      },
      required: ['match_description'],
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
  {
    name: 'navigate_to_screen',
    description:
      'Navigate the user to a specific screen in the app. Use this when the user asks to go somewhere, or when suggesting they check a specific section. Examples: "take me to my profile", "show my subscriptions", "let me edit my identity". Renders as a tappable card in chat.',
    input_schema: {
      type: 'object',
      properties: {
        screen: {
          type: 'string',
          description: 'The screen to navigate to.',
          enum: ['profile', 'subscriptions', 'connect', 'identity', 'education'],
        },
        label: {
          type: 'string',
          description: 'Display label for the navigation card. E.g. "Go to Profile", "View Subscriptions".',
        },
      },
      required: ['screen', 'label'],
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

  // Phase 5A: Context enforcement — warn if critical financial data is missing
  const ctxValidation = validateContext(context);

  // Phase 5C: Detect conversation mode from latest user message
  const lastUserMsg = messages.filter((m) => m.role === 'user').pop()?.content || '';
  const conversationMode = detectConversationMode(lastUserMsg);

  // Tax/estate intent detection — enables richer tax context in responses
  const isTaxQuery = isTaxEstateQuery(lastUserMsg);

  // Phase 5D: Build insight context for proactive injection
  const insightContext = context ? buildInsightContext(context) : '';

  let taxQueryGuidance = '';
  if (isTaxQuery) {
    taxQueryGuidance = `\n\n[Tax/Estate query detected — prioritise tax position data, wrapper utilisation, and allowance numbers in your response. `
      + `State mathematical facts (rates, allowances, relief amounts). `
      + `If tax_estate agent analysis is available above, reference those specific numbers. `
      + `IMPORTANT: All tax and estate outputs are data-driven observations, not financial or tax advice. `
      + `Recommend the user consults a qualified tax adviser or financial planner before acting.]`;
  }

  const systemPrompt = buildSystemPrompt(context) +
    (insightContext ? insightContext : '') +
    (conversationMode !== 'general' ? `\n\n[Detected conversation mode: ${conversationMode}]` : '') +
    taxQueryGuidance;

  const apiMessages = messages.map((m) => {
    // If message has an image attachment, build multimodal content for Claude
    if (m.attachment && m.attachment.dataUrl && m.attachment.type.startsWith('image/')) {
      // Extract base64 data from data URL (format: data:image/png;base64,...)
      const base64Match = m.attachment.dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (base64Match) {
        return {
          role: m.role,
          content: [
            { type: 'image', source: { type: 'base64', media_type: base64Match[1], data: base64Match[2] } },
            { type: 'text', text: m.content || `User attached an image: ${m.attachment.name}. Please analyse it for any financial data, statements, or information that could help with their financial optimisation.` },
          ],
        };
      }
    }
    // For non-image attachments (CSV, PDF, etc.), include the file info in text
    if (m.attachment && m.attachment.dataUrl && !m.attachment.type.startsWith('image/')) {
      const fileContext = `[User attached file: ${m.attachment.name} (${m.attachment.type}). The file content has been received for analysis.]`;
      return { role: m.role, content: m.content ? `${m.content}\n\n${fileContext}` : fileContext };
    }
    return { role: m.role, content: m.content };
  });

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
    max_tokens: 300,
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
  if (name === 'manage_savings_account') {
    return executeSavingsAccount(input, userId);
  }
  if (name === 'tag_transfer_as_savings') {
    return executeTagTransferAsSavings(input, userId);
  }
  if (name === 'save_manual_asset') {
    return executeManualAsset(input, userId);
  }
  if (name === 'search_gif') {
    return executeGifSearch(input);
  }
  if (name === 'show_income_summary') {
    return executeIncomeSummary(userId);
  }
  if (name === 'navigate_to_screen') {
    const screen = (input.screen as string) || 'profile';
    const label = (input.label as string) || `Go to ${screen}`;
    return {
      response: { success: true, screen, label },
      action: { type: 'navigate', screen, label },
    };
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

async function executeManualAsset(input: Record<string, unknown>, userId: string | null): Promise<ToolResult> {
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

  const assetData = {
    user_id: userId,
    platform: input.platform as string,
    asset_type: input.asset_type as string,
    estimated_value: input.estimated_value as number,
    currency: (input.currency as string) || 'GBP',
    notes: (input.notes as string) || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await admin.from('manual_assets').upsert(assetData, {
    onConflict: 'user_id,platform,asset_type',
  });

  if (error) {
    return {
      response: { success: false, error: error.message },
      action: null,
    };
  }

  return {
    response: {
      success: true,
      message: `Saved: ${input.platform} ${(input.asset_type as string).replace(/_/g, ' ')} — £${Math.round(input.estimated_value as number).toLocaleString()}. This will be included in your net worth and financial analysis.`,
    },
    action: {
      type: 'manual_asset_saved',
      data: assetData,
    },
  };
}

async function executeSavingsAccount(input: Record<string, unknown>, userId: string | null): Promise<ToolResult> {
  if (!userId) {
    return { response: { success: false, error: 'No user session' }, action: null };
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { response: { success: false, error: 'Server misconfigured' }, action: null };
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const operation = input.operation as string;
  const accountName = input.account_name as string;

  if (operation === 'delete') {
    const { error } = await admin.from('savings_accounts')
      .delete()
      .eq('user_id', userId)
      .ilike('account_name', accountName);

    if (error) {
      return { response: { success: false, error: error.message }, action: null };
    }

    return {
      response: { success: true, message: `Removed savings account "${accountName}".` },
      action: { type: 'savings_account_deleted', data: { account_name: accountName } },
    };
  }

  if (operation === 'update') {
    const updates: Record<string, unknown> = {};
    if (input.balance != null) updates.balance = input.balance;
    if (input.interest_rate != null) updates.interest_rate = input.interest_rate;
    if (input.provider != null) updates.provider = input.provider;
    if (input.account_type != null) updates.account_type = input.account_type;
    if (input.monthly_contribution != null) updates.monthly_contribution = input.monthly_contribution;

    if (Object.keys(updates).length === 0) {
      return { response: { success: false, error: 'Nothing to update — provide at least one field.' }, action: null };
    }

    const { error } = await admin.from('savings_accounts')
      .update(updates)
      .eq('user_id', userId)
      .ilike('account_name', accountName);

    if (error) {
      return { response: { success: false, error: error.message }, action: null };
    }

    const balanceStr = input.balance != null ? ` Balance: £${Math.round(input.balance as number).toLocaleString()}.` : '';
    const rateStr = input.interest_rate != null ? ` Rate: ${input.interest_rate}%.` : '';
    const contribStr = input.monthly_contribution != null ? ` Monthly contribution: £${Math.round(input.monthly_contribution as number)}.` : '';
    return {
      response: { success: true, message: `Updated "${accountName}".${balanceStr}${rateStr}${contribStr}` },
      action: { type: 'savings_account_updated', data: { account_name: accountName, ...updates } },
    };
  }

  // operation === 'add'
  const newAccount = {
    user_id: userId,
    account_name: accountName,
    provider: (input.provider as string) || null,
    balance: (input.balance as number) ?? 0,
    interest_rate: (input.interest_rate as number) || null,
    account_type: (input.account_type as string) || 'easy_access',
    monthly_contribution: (input.monthly_contribution as number) || null,
    source: 'chat',
  };

  const { data, error } = await admin.from('savings_accounts').insert(newAccount).select('id').maybeSingle();
  if (error) {
    return { response: { success: false, error: error.message }, action: null };
  }

  const balanceStr = newAccount.balance ? ` Balance: £${Math.round(newAccount.balance).toLocaleString()}.` : '';
  const rateStr = newAccount.interest_rate ? ` Rate: ${newAccount.interest_rate}%.` : '';
  const contribStr = newAccount.monthly_contribution ? ` Monthly contribution: £${Math.round(newAccount.monthly_contribution)}.` : '';
  return {
    response: {
      success: true,
      message: `Added savings account "${accountName}" (${newAccount.account_type}).${balanceStr}${rateStr}${contribStr} This will be reflected in your savings total.`,
    },
    action: {
      type: 'savings_account_added',
      data: { id: data?.id, ...newAccount },
    },
  };
}

async function executeTagTransferAsSavings(input: Record<string, unknown>, userId: string | null): Promise<ToolResult> {
  if (!userId) {
    return { response: { success: false, error: 'No user session' }, action: null };
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { response: { success: false, error: 'Server misconfigured' }, action: null };
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Create a transaction override that reclassifies this transfer as Savings
  const { error } = await admin.from('transaction_overrides').insert({
    user_id: userId,
    match_description: input.match_description,
    category: 'Savings',
    is_essential: false,
    notes: (input.notes as string) || `Tagged as savings${input.savings_account_name ? ` (→ ${input.savings_account_name})` : ''}`,
  });

  if (error) {
    return { response: { success: false, error: error.message }, action: null };
  }

  const accountNote = input.savings_account_name ? ` (linked to ${input.savings_account_name})` : '';
  return {
    response: {
      success: true,
      message: `Done. Transfers matching "${input.match_description}" will now count as savings${accountNote}. This applies on your next analysis refresh.`,
    },
    action: {
      type: 'transfer_tagged_as_savings',
      data: {
        match_description: input.match_description,
        savings_account_name: (input.savings_account_name as string) || null,
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
  segment?: string;
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
  account_summary?: { cash: number; savings: number; isa: number; pension: number; investments: number };
  idle_capital?: number;
  isa_remaining?: number;
  high_earner_cohort?: 'unstructured_high_earner' | 'structured_high_earner' | null;
  savings_accounts?: Array<{ account_name: string; provider?: string; balance: number; interest_rate?: number; account_type: string; monthly_contribution?: number }>;
  savings_categories?: Array<{ category: string; monthly: number; txs: number; transactions?: Array<{ date: string; merchant: string; amount: number }> }>;
  monthly_savings?: number;
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

REPLY LENGTH (tiered):
- QUICK replies (greetings, yes/no, confirmations, nudges): stay punchy, aim for ~12 words or fewer. "hey! what's on your mind?" energy.
- STANDARD replies (single-topic answers, one number to highlight): up to ~40 words. Still tight.
- DETAILED replies (breakdowns, comparisons, step-by-step the user asked for): up to ~100 words max. Use short paragraphs.
- NEVER exceed 100 words regardless of context.
- MAX 4 PARAGRAPHS per reply. That means max 4 chat bubbles. NEVER more.
- Default to the shortest tier that answers the question. When in doubt, go shorter.

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
- NEVER suggest cancelling subscriptions or reducing spending for users who earn well and manage their credit well. You are a financial OPTIMISATION platform, not a budgeting app. Focus on capital allocation, tax efficiency, investment returns, and wealth building. Only suggest spending changes for users genuinely in financial difficulty.
- NEVER suggest reducing essential costs like council tax, rent, mortgage, insurance, energy, or broadband. These are non-negotiable obligations.
- No bullet lists unless they ask for steps. Keep it conversational.
- No filler. No preamble. No "Great question!" No "Absolutely!" No "Let me break this down." Just answer.
- Don't echo what they said. Don't restate the question. Jump straight to the answer.
- NEVER open with a greeting or "Hey!" when answering a question. Just answer it.
- Sound like a person texting, not an AI generating a response.
- NEVER answer more than ONE question at a time. If they asked 3 things, pick the most important one. They'll ask again.
- Quick replies: 1-2 sentences. Standard: 2-3 sentences. Detailed (only when asked): up to 4 short paragraphs. If it looks like an essay, rewrite.

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
- When the user mentions investments, pensions, ISAs, crypto, property, or other assets held on external platforms (not connected via open banking), use save_manual_asset to record them. Ask for the platform name, type, and approximate value. Examples: "I have £30k in a Vanguard ISA" → save it. "My workplace pension is about £85k" → save it. This data enriches their net worth picture and unlocks better capital allocation recommendations.
- When the user's situation has clearly changed (life event, achieved a goal, outgrown their current goal), use suggest_goal_update to propose updated goals. This re-aligns all future analysis. Don't suggest this casually \u2014 only when a real shift has happened.
- When users attach images (screenshots of bank statements, investment platforms, payslips, etc.), analyse the content and extract relevant financial data. Use this information to update their profile, add manual assets, or answer questions. If the image shows investment balances from another platform, offer to save them using save_manual_asset.
- When users attach files (CSV bank statements, spreadsheets), acknowledge receipt and extract any useful financial information to help with their queries.
- SAVINGS: When the user mentions a savings account (e.g. "I have \u00a35k in Marcus", "my ISA has \u00a312k"), use manage_savings_account to add or update it. When they say a transfer goes to their savings (e.g. "that transfer to Chip is my savings"), use tag_transfer_as_savings so it counts toward their savings total. When they ask "how much am I saving" or "what are my savings", reference the savings accounts and savings transaction breakdown in context. Be transparent: internal transfers between own accounts are NOT savings unless the user explicitly tags them. If the user asks why a transfer isn't counting as savings, explain this and offer to tag it.
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
  if (ctx.segment) prompt += `\n- Financial segment: ${ctx.segment}`;

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

  // ── Capital allocation context (§14n) ──
  if (ctx.account_summary) {
    const acc = ctx.account_summary as Record<string, number>;
    const total = (acc.cash || 0) + (acc.savings || 0) + (acc.isa || 0) + (acc.pension || 0) + (acc.investments || 0);
    prompt += `\n\nAccount allocation (net worth £${Math.round(total).toLocaleString()}):`;
    if (acc.cash) prompt += `\n- Cash: £${Math.round(acc.cash).toLocaleString()}`;
    if (acc.savings) prompt += `\n- Savings: £${Math.round(acc.savings).toLocaleString()}`;
    if (acc.isa) prompt += `\n- ISA: £${Math.round(acc.isa).toLocaleString()}`;
    if (acc.pension) prompt += `\n- Pension: £${Math.round(acc.pension).toLocaleString()} (estimated)`;
    if (acc.investments) prompt += `\n- Investments: £${Math.round(acc.investments).toLocaleString()}`;
    if ((ctx.idle_capital as number) > 5000) {
      prompt += `\n- Idle capital (cash beyond 3-month buffer): £${Math.round(ctx.idle_capital as number).toLocaleString()}`;
    }
    if (ctx.high_earner_cohort) {
      const cohortLabel = ctx.high_earner_cohort === 'unstructured_high_earner'
        ? 'Unstructured High Earner (cash-heavy, under-optimised)'
        : 'Structured High Earner (active investor, locally efficient)';
      prompt += `\n- Cohort: ${cohortLabel}`;
    }
    prompt += `\nIMPORTANT: When the user asks "where should I put my money?", use this allocation data. For UHE: focus on deploying idle cash. For SHE: focus on tax efficiency and rebalancing.`;
  }

  // ── Savings accounts & activity ──
  if (ctx.savings_accounts?.length) {
    const totalSavingsBalance = ctx.savings_accounts.reduce((s, a) => s + (a.balance || 0), 0);
    const totalMonthlyContrib = ctx.savings_accounts.reduce((s, a) => s + (a.monthly_contribution || 0), 0);
    prompt += `\n\nSavings accounts (user-declared, ground truth):`;
    for (const acc of ctx.savings_accounts) {
      let line = `\n- ${acc.account_name}`;
      if (acc.provider) line += ` (${acc.provider})`;
      line += `: £${Math.round(acc.balance).toLocaleString()}`;
      if (acc.interest_rate) line += `, ${acc.interest_rate}% AER`;
      line += ` [${acc.account_type.replace(/_/g, ' ')}]`;
      if (acc.monthly_contribution) line += `, £${Math.round(acc.monthly_contribution)}/month contribution`;
      prompt += line;
    }
    prompt += `\nTotal savings balance: £${Math.round(totalSavingsBalance).toLocaleString()}`;
    if (totalMonthlyContrib > 0) {
      prompt += `\nTotal monthly savings contributions: £${Math.round(totalMonthlyContrib)}/month`;
    }
    prompt += `\nIMPORTANT: These are the user's DECLARED savings accounts. When they ask "how much do I have saved" or "what's my savings", use these numbers. The user can add, update, or remove savings accounts via chat using manage_savings_account.`;
  }

  if (ctx.savings_categories?.length) {
    prompt += `\n\nSavings activity from transactions (auto-detected or user-tagged):`;
    for (const cat of ctx.savings_categories) {
      prompt += `\n- ${cat.category}: £${Math.round(cat.monthly)}/month (${cat.txs} transactions)`;
      if (cat.transactions?.length) {
        const recentTxs = cat.transactions.slice(0, 3);
        for (const tx of recentTxs) {
          prompt += `\n  ${tx.date.split('T')[0]}: ${tx.merchant} £${Math.abs(tx.amount).toFixed(2)}`;
        }
      }
    }
    if (ctx.monthly_savings != null) {
      prompt += `\nTotal monthly savings outflow: £${Math.round(ctx.monthly_savings)}/month`;
    }
    prompt += `\nThese are the TRANSACTIONS that count toward savings. When the user asks "what counts as my savings" or "why is my savings number X", show these specific transactions.`;
    prompt += `\nIMPORTANT: Internal transfers between the user's own accounts are NOT savings unless the user explicitly tagged them using tag_transfer_as_savings. If the user says a transfer is savings, use that tool to tag it. If they say it's just moving money, leave it as an internal transfer.`;
  } else if (!ctx.savings_accounts?.length) {
    prompt += `\n\nNo savings data available. If the user mentions savings accounts, use manage_savings_account to add them. If they mention transfers that are actually savings, use tag_transfer_as_savings to track them.`;
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
      prompt += `\nIMPORTANT: Proactively ask the user for their APR on each debt account with missing rates. Say something like: "I'm currently using estimated rates for [account names]. Could you check your latest statement or app for the actual APR? It'll help me optimise which debt to target first."`;
    }
    prompt += `\nDebt strategy: ALWAYS use avalanche method (highest interest rate first). This saves the most money mathematically. When rates are equal, target the largest balance first. Never recommend snowball (smallest balance first).`;
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
