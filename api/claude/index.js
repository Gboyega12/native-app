// ── Unified Claude API endpoint ──
// POST /api/claude with { action: "classify" | "enrich", ... }
//
// classify: batches unclassified transaction descriptions → Claude → structured JSON
// enrich: takes ranked moves and rewrites them into BOCY-style output

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 2000;

// ── In-memory classification cache ──
const classificationCache = new Map();

function getCacheKey(description) {
  return (description || '').toLowerCase().trim();
}

function getCached(description) {
  const key = getCacheKey(description);
  const entry = classificationCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    classificationCache.delete(key);
    return null;
  }
  return entry.classification;
}

function setCache(description, classification) {
  if (classificationCache.size >= MAX_CACHE_SIZE) {
    const firstKey = classificationCache.keys().next().value;
    classificationCache.delete(firstKey);
  }
  classificationCache.set(getCacheKey(description), {
    classification,
    timestamp: Date.now(),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLen);
}

const VALID_CATEGORIES = [
  'Groceries', 'Delivery', 'Coffee & Cafes', 'Eating Out',
  'Transport', 'Streaming', 'Fitness', 'Shopping', 'BNPL',
  'Broadband & Phone', 'Council Tax', 'Energy', 'Water',
  'TV Licence', 'Insurance', 'Rent', 'Mortgage',
  'Entertainment', 'Health', 'Debt Payments', 'Income',
  'Savings', 'Childcare', 'Education', 'Personal Care',
  'Gambling', 'Subscriptions', 'Charity', 'Pets', 'Other',
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body;

  if (action === 'classify') {
    return handleClassify(req, res);
  } else if (action === 'enrich') {
    return handleEnrich(req, res);
  }

  return res.status(400).json({ error: 'action must be "classify" or "enrich"' });
}

// ─── CLASSIFY ───────────────────────────────────────────────

async function handleClassify(req, res) {
  const { transactions } = req.body;
  if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
    return res.json({ success: true, classifications: [] });
  }

  const batch = transactions.slice(0, 50);
  const results = new Array(batch.length).fill(null);
  const uncached = [];

  for (let i = 0; i < batch.length; i++) {
    const cached = getCached(batch[i].description);
    if (cached) {
      results[i] = { ...cached, index: i };
    } else {
      uncached.push({ tx: batch[i], originalIndex: i });
    }
  }

  const cacheHits = batch.length - uncached.length;
  if (cacheHits > 0) {
    console.log(`[classify] Cache: ${cacheHits}/${batch.length} hits, ${uncached.length} to classify`);
  }

  if (uncached.length === 0) {
    return res.json({ success: true, classifications: results, cacheHits });
  }

  const model = process.env.CLAUDE_CLASSIFY_MODEL || process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const prompt = buildClassifyPrompt(uncached.map((u) => u.tx));

  let lastError = null;
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
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const data = await response.json();
      let text = data.content?.[0]?.text || '';
      text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
          return res.json({ success: false, classifications: [], error: 'not_array' });
        }

        parsed.forEach((item, i) => {
          const entry = uncached[i];
          if (!entry) return;

          const classification = {
            merchant: sanitize(item.merchant || entry.tx.description || 'Unknown', 100),
            category: VALID_CATEGORIES.includes(item.category) ? item.category : 'Other',
            isEssential: Boolean(item.isEssential),
            isSubscription: Boolean(item.isSubscription),
            isDebt: Boolean(item.isDebt),
            isBNPL: Boolean(item.isBNPL),
            isIncome: Boolean(item.isIncome),
            confidence: item.confidence === 'high' ? 'high' : 'medium',
          };

          results[entry.originalIndex] = { ...classification, index: entry.originalIndex };
          if (classification.category !== 'Other') {
            setCache(entry.tx.description, classification);
          }
        });

        const classifications = results.map((r, i) => r || {
          index: i,
          merchant: sanitize(batch[i]?.description || 'Unknown', 100),
          category: 'Other',
          isEssential: false,
          isSubscription: false,
          isDebt: false,
          isBNPL: false,
          isIncome: false,
          confidence: 'low',
        });

        return res.json({ success: true, classifications, cacheHits });
      } catch {
        return res.json({ success: false, classifications: [], error: 'parse_failed' });
      }
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  return res.json({ success: false, classifications: [], error: lastError?.message || 'request_failed' });
}

function buildClassifyPrompt(transactions) {
  let prompt = `You are a UK bank transaction classifier. For each transaction description, determine:
1. The clean merchant name (human-readable, e.g. "American Express" not "AMEX EPAYMENT")
2. The spending category
3. Whether it's essential (a genuine need, not a want)
4. Whether it's a subscription, debt payment, BNPL, or income

VALID CATEGORIES (pick exactly one):
${VALID_CATEGORIES.join(', ')}

RULES:
- Credit card payments (Amex, Barclaycard, MBNA, Capital One, etc.) → "Debt Payments", isDebt: true
- Loan repayments, HP agreements → "Debt Payments", isDebt: true
- Klarna, Clearpay, Laybuy → "BNPL", isBNPL: true
- Recurring software/services (Claude.ai, ChatGPT, GitHub, Adobe, etc.) → "Subscriptions", isSubscription: true
- Streaming (Netflix, Spotify, Disney+, etc.) → "Streaming", isSubscription: true
- Salary, wages, benefits → "Income", isIncome: true
- Rent, mortgage, council tax, utilities, insurance → essential
- Groceries, transport, health, childcare, education → essential
- Restaurants, takeaways, coffee shops, shopping, entertainment → NOT essential
- Gambling, betting → "Gambling", NOT essential
- If genuinely uncertain, use "Other"
- Use your world knowledge of UK merchants, brands, and services

TRANSACTIONS TO CLASSIFY:
`;

  transactions.forEach((tx, i) => {
    prompt += `\n${i}. "${sanitize(tx.description, 150)}" (amount: ${tx.amount > 0 ? '+' : ''}£${Math.abs(tx.amount).toFixed(2)})`;
  });

  prompt += `

Respond with ONLY a JSON array. Each object must have these exact fields:
{
  "index": 0,
  "merchant": "Clean Merchant Name",
  "category": "Category from list above",
  "isEssential": false,
  "isSubscription": false,
  "isDebt": false,
  "isBNPL": false,
  "isIncome": false,
  "confidence": "high" or "medium"
}

Return exactly ${transactions.length} objects in index order.`;

  return prompt;
}

// ─── ENRICH ─────────────────────────────────────────────────

async function handleEnrich(req, res) {
  const { moves, context } = req.body;
  if (!moves || !Array.isArray(moves) || moves.length === 0) {
    return res.status(400).json({ error: 'moves array required' });
  }

  const model = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const prompt = buildEnrichPrompt(moves, context);

  let lastError = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const data = await response.json();
      let text = data.content?.[0]?.text || '';
      text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

      try {
        const refined = JSON.parse(text);
        return res.json({ success: true, moves: refined });
      } catch {
        return res.json({ success: false, moves: moves, error: 'parse_failed' });
      }
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  return res.json({ success: false, moves: moves, error: lastError?.message || 'request_failed' });
}

function buildEnrichPrompt(moves, context) {
  const { monthly_income, monthly_spending, surplus, goals, ukpf_priority, ukpf_label } = context || {};

  let prompt = `You are Bocy, an AI financial advisor. Rewrite these financial recommendations into specific, outcome-focused action plans.

RULES:
- Name ACTUAL merchants from the merchants list (e.g. "Cancel Netflix, Spotify, Adobe" not "cancel some subscriptions")
- Include SPECIFIC £ amounts (already provided in the data)
- Tie every action to the user's goal with a timeline (e.g. "→ reach 1-month buffer in 4 months")
- Keep the action field under 80 characters — it's a headline
- Rewrite the strategy as 1-2 definite sentences — no hedging, no "you might want to"
- Rewrite the effect as a measurable outcome with timeline
- Keep the steps array as 3-4 concrete, executable actions
- Use British English and £ symbol
- NEVER use markdown formatting — no **bold**, no *italic*, no backticks. Output plain text only.
- NEVER give regulated financial advice — suggest consulting a qualified advisor for investment decisions
- NEVER mention specific financial institutions or products (e.g. no "Monzo", "Chase", "Marcus", "Chip", "Vanguard", no savings account interest rates, no ISA providers). Keep recommendations institution-neutral

MERCHANT CLEANUP RULES:
- The "merchants" array may contain raw bank descriptions. Clean them into proper brand names.
- Examples: "DELIVEROO.COM ORDER" → "Deliveroo", "AMZNMKTPLACE" → "Amazon", "TESCO STORES" → "Tesco", "UBER *EATS" → "Uber Eats"
- Remove payment prefixes (SQ*, IZ*, PP*, etc.), terminal IDs, reference numbers, country codes (GB, GBR)
- Use proper capitalisation: "Deliveroo" not "deliveroo" or "DELIVEROO"
- Deduplicate: if the same merchant appears with slight variations, keep only the clean version
- Remove generic entries like "Card Payment", "Direct Debit", or transaction descriptions that are not actual merchant names

USER CONTEXT:
- UKPF priority: ${sanitize(ukpf_label || 'unknown')} (${sanitize(ukpf_priority || 'unknown')})`;

  if (monthly_income) prompt += `\n- Monthly income: £${Math.round(monthly_income)}`;
  if (monthly_spending) prompt += `\n- Monthly spending: £${Math.round(monthly_spending)}`;
  if (surplus != null) prompt += `\n- Monthly surplus: £${Math.round(surplus)}`;
  if (goals?.one_year_goal) prompt += `\n- 1-year goal: ${sanitize(goals.one_year_goal)}`;
  if (goals?.target_amount) prompt += `\n- Target amount: £${goals.target_amount}`;

  prompt += `\n\nMOVES TO REFINE (${moves.length} moves):`;

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    prompt += `\n\n--- Move ${i + 1} ---`;
    prompt += `\nAction: ${sanitize(m.action, 120)}`;
    prompt += `\nCategory: ${sanitize(m.category || 'spending', 30)}`;
    prompt += `\nMonthly impact: £${m.monthlyImpact}`;
    prompt += `\nAnnual impact: £${m.annualImpact}`;
    prompt += `\nEffort: ${sanitize(m.effort, 10)}`;
    prompt += `\nMerchants (raw — clean these up): ${(m.merchants || []).map((s) => sanitize(s, 50)).join(', ') || 'none detected'}`;
    prompt += `\nStrategy: ${sanitize(m.strategy, 300)}`;
    prompt += `\nSteps: ${(m.steps || []).map((s) => sanitize(s, 100)).join('; ')}`;
    prompt += `\nEffect: ${sanitize(m.effect, 200)}`;
    if (m.trajectory) {
      prompt += `\nGoal trajectory: ${sanitize(m.trajectory.insight, 200)}`;
      if (m.trajectory.newMonths > 0) {
        prompt += ` (reach ${sanitize(m.trajectory.goalLabel, 50)} in ${m.trajectory.newMonths} months)`;
      }
    }
  }

  prompt += `\n\nRespond with ONLY a JSON array. Each object must have these exact fields:
{
  "action": "bold headline under 80 chars with specific merchants and amounts",
  "strategy": "1-2 definite sentences explaining why and how",
  "steps": ["step 1", "step 2", "step 3"],
  "effect": "measurable outcome with timeline",
  "timeline": "goal-tied timeline e.g. 'reach 1-month buffer in 4 months'",
  "merchants": ["Clean Merchant Name 1", "Clean Merchant Name 2"]
}

Return exactly ${moves.length} objects in the same order as the input moves. Do NOT change monthlyImpact, annualImpact, effort, or category — only rewrite action, strategy, steps, effect, timeline, and merchants.`;

  return prompt;
}
