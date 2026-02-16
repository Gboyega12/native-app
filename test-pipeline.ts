/**
 * Quick validation of the classification pipeline.
 * Tests: merchant-db, keyword classifier, normalisation, and Claude API.
 *
 * Run: npx tsx test-pipeline.ts
 */

import { readFileSync } from 'fs';
import { matchMerchant, isPersonTransfer } from './lib/merchant-db';
import { classifyTransaction } from './lib/classifier';
import { normaliseDescription } from './lib/normalise';

// ── Load .env manually (no dotenv dependency) ──
try {
  const envFile = readFileSync('.env', 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env file */ }

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
    failed++;
  }
}

// ─── 1. Normalisation ───
console.log('\n-- Normalisation --');

assert(
  'Strips card number suffixes',
  normaliseDescription('TESCO STORES 6091').includes('tesco'),
);
assert(
  'Cleans VIS/GBR noise',
  !normaliseDescription('AMAZON MKTPLACE GBR').toLowerCase().includes('gbr'),
);

// ─── 2. Merchant DB — known brands ───
console.log('\n-- Merchant DB (known brands) --');

const knownTests: [string, string, string][] = [
  ['TESCO STORES 6091', 'Tesco', 'Groceries'],
  ['NETFLIX.COM', 'Netflix', 'Streaming'],
  ['SPOTIFY P1234', 'Spotify', 'Streaming'],
  ['TFL TRAVEL', 'TfL', 'Transport'],
  ['AMZNMKTPLACE', 'Amazon', 'Shopping'],
  ['UBER EATS', 'Uber Eats', 'Delivery'],
  ['STARBUCKS', 'Starbucks', 'Coffee & Cafes'],
];

for (const [desc, expectedMerchant, expectedCategory] of knownTests) {
  const normalised = normaliseDescription(desc);
  const match = matchMerchant(normalised, desc);
  assert(
    `"${desc}" -> ${expectedMerchant} (${expectedCategory})`,
    match !== null && match.merchant === expectedMerchant && match.category === expectedCategory,
    match ? `got: ${match.merchant} (${match.category})` : 'no match',
  );
}

// ─── 3. Previously unknown brands now in merchant DB ───
console.log('\n-- Previously unknown brands (now in merchant DB) --');

const nowKnownTests: [string, string, string][] = [
  ['KOKORO', 'Kokoro', 'Eating Out'],
  ['FILLISHACK', 'Fillishack', 'Eating Out'],
  ['FRAMER', 'Framer', 'Subscriptions'],
];

for (const [desc, expectedMerchant, expectedCategory] of nowKnownTests) {
  const normalised = normaliseDescription(desc);
  const match = matchMerchant(normalised, desc);
  assert(
    `"${desc}" -> ${expectedMerchant} (${expectedCategory})`,
    match !== null && match.merchant === expectedMerchant && match.category === expectedCategory,
    match ? `got: ${match.merchant} (${match.category})` : 'no match',
  );
}

// ─── 4. Keyword Classifier — generic descriptors ───
console.log('\n-- Keyword Classifier --');

const keywordTests: [string, string][] = [
  ['COUNCIL TAX PAYMENT', 'Council Tax'],
  ['DIRECT DEBIT INSURANCE', 'Insurance'],
  ['GYM MEMBERSHIP FEE', 'Fitness'],
];

for (const [desc, expectedCategory] of keywordTests) {
  const normalised = normaliseDescription(desc);
  const result = classifyTransaction(desc, null, normalised);
  assert(
    `"${desc}" -> ${expectedCategory}`,
    result.category === expectedCategory,
    `got: ${result.category} (source: ${result.source})`,
  );
}

// ─── 5. Genuinely unknown brands → confidence: low (will go to Claude) ───
console.log('\n-- Genuinely unknown brands (should go to Claude) --');

const unknownBrands = ['WAHACA', 'MONZO POT', 'XYZFOOBAR123', 'RANDOM MERCHANT'];

for (const desc of unknownBrands) {
  const normalised = normaliseDescription(desc);
  const match = matchMerchant(normalised, desc);
  const result = classifyTransaction(desc, match, normalised);
  assert(
    `"${desc}" -> confidence: low (will go to Claude)`,
    result.confidence === 'low',
    `got: confidence=${result.confidence}, category=${result.category}, source=${result.source}`,
  );
}

// ─── 6. Person transfer detection ───
console.log('\n-- Person transfer detection --');

assert('Mr J Smith -> person', isPersonTransfer('MR J SMITH'));
assert('Mrs Jane Doe -> person', isPersonTransfer('MRS JANE DOE'));
assert('TESCO STORES -> not person', !isPersonTransfer('TESCO STORES'));
assert('AMZNMKTPLACE -> not person', !isPersonTransfer('AMZNMKTPLACE'));

// ─── 7. Claude API connectivity ───
console.log('\n-- Claude API connectivity --');

async function testClaudeAPI() {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.log('  FAIL CLAUDE_API_KEY not set in environment');
    failed++;
    return;
  }
  assert('CLAUDE_API_KEY is set', true);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Classify these UK bank transactions. Return ONLY a JSON array.

0. "WAHACA SOUTHBANK" (amount: -£34.20)
1. "XYZZY NOODLE BAR" (amount: -£9.80)
2. "LINKTREE" (amount: -£6.00)

Each object: {"index":0,"merchant":"Name","category":"<valid>","isEssential":false,"isSubscription":false,"isDebt":false,"isBNPL":false,"isIncome":false,"confidence":"high"}
Valid categories: Groceries, Eating Out, Shopping, Subscriptions, Streaming, Transport, Coffee & Cafes, Other`,
        }],
      }),
    });

    const data = await res.json();

    if (data.error) {
      console.log(`  FAIL Claude API error: ${data.error.message}`);
      failed++;
      return;
    }

    let text = data.content?.[0]?.text || '';
    // Strip markdown code fences (same fix as production API route)
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    assert('Claude API responds', text.length > 0);

    try {
      const classifications = JSON.parse(text);
      assert('Response is valid JSON array', Array.isArray(classifications));

      if (Array.isArray(classifications)) {
        for (const c of classifications) {
          const desc = ['WAHACA SOUTHBANK', 'XYZZY NOODLE BAR', 'LINKTREE'][c.index] || `index ${c.index}`;
          const isNotOther = c.category !== 'Other';
          assert(
            `"${desc}" -> ${c.merchant} (${c.category})`,
            isNotOther,
            isNotOther ? '' : 'Claude returned "Other" -- world knowledge missed this',
          );
        }
      }
    } catch {
      console.log(`  FAIL Failed to parse Claude response as JSON`);
      console.log(`    Raw: ${text.slice(0, 200)}`);
      failed++;
    }
  } catch (err: any) {
    console.log(`  FAIL Network error: ${err.message}`);
    failed++;
  }
}

testClaudeAPI().then(() => {
  console.log(`\n== Results: ${passed} passed, ${failed} failed ==\n`);
  process.exit(failed > 0 ? 1 : 0);
});
