// ── Claude Transaction Classifier ──
// Fallback classification layer for transactions that the rule-based
// merchant-DB and keyword classifier couldn't identify.
//
// Batches unclassified descriptions → Claude Haiku → structured JSON
// with merchant name, category, essential/subscription/debt flags.
//
// Includes an in-memory classification cache so the same description
// is never sent to Claude twice across requests within the same server
// process. Cache entries expire after 24 hours.
//
// Claude's world knowledge handles cases rules can't:
//   "to Amex"          → Debt Payments (credit card)
//   "Claude.ai"        → Subscriptions (AI tool)
//   "THE BARBERSHOP"   → Personal Care (discretionary)
//   "DVLA VEHICLE TAX" → Transport (essential)

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 2000;

// ── In-memory classification cache ──
// Key: normalised description (lowercase, trimmed)
// Value: { classification, timestamp }
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
  // Evict oldest entries if cache is full
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

// Allowed categories — Claude must pick from this list
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

  const { transactions } = req.body;
  if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
    return res.json({ success: true, classifications: [] });
  }

  // Cap batch size to keep prompt reasonable and fast
  const batch = transactions.slice(0, 50);

  // ── Check cache for already-classified descriptions ──
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

  // If everything was cached, return immediately
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

      // Strip markdown code fences that Claude sometimes wraps around JSON
      text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

      try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
          return res.json({ success: false, classifications: [], error: 'not_array' });
        }

        // Validate, sanitize, and cache each classification
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

          // Cache successful non-Other classifications
          if (classification.category !== 'Other') {
            setCache(entry.tx.description, classification);
          }
        });

        // Fill any remaining gaps (if Claude returned fewer results)
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
