// ── Bayesian Ensemble Transaction Classifier ──
// Combines 5 weak statistical classifiers into a strong ensemble that
// runs client-side in milliseconds. Trained on high/medium-confidence
// transactions from the rule-based cascade, then predicts categories
// for the remaining unclassified transactions.
//
// Models:
//   1. TF-IDF + Cosine Similarity (word-level merchant matching)
//   2. Naïve Bayes (words × amount × day-of-week × week-of-month)
//   3. Amount Distribution (log-normal fit per category)
//   4. EMA Recurrence (per-merchant temporal patterns)
//   5. Markov Chain (spending sequence transitions)
//
// Ensemble: weighted log-probability combination with softmax.

import { normaliseDescription } from './normalise.js';
import type { RawTransaction, EnrichedTransaction } from './types.js';

// ── Stop words for tokenisation (reused from learned-patterns concept) ──
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'from', 'and', 'at', 'in', 'on', 'for', 'of',
  'ltd', 'limited', 'plc', 'uk', 'gb', 'gbr', 'com', 'org', 'net',
  'payment', 'direct', 'debit', 'credit', 'card', 'ref', 'fee',
]);

const MIN_TOKEN_LEN = 3;

// ── Amount buckets (log-spaced for heavy-tailed spending) ──
const AMOUNT_THRESHOLDS = [2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000];

function amountToBucket(amount: number): string {
  const abs = Math.abs(amount);
  for (let i = 0; i < AMOUNT_THRESHOLDS.length; i++) {
    if (abs < AMOUNT_THRESHOLDS[i]) return `b${i}`;
  }
  return `b${AMOUNT_THRESHOLDS.length}`;
}

function tokenise(description: string): string[] {
  return normaliseDescription(description)
    .split(/\s+/)
    .filter((w) => w.length >= MIN_TOKEN_LEN && !STOP_WORDS.has(w));
}

function weekOfMonth(day: number): number {
  return Math.min(5, Math.ceil(day / 7));
}

// ── Log-sum-exp trick for numerical stability ──
function logSumExp(values: number[]): number {
  if (values.length === 0) return -Infinity;
  const max = Math.max(...values);
  if (max === -Infinity) return -Infinity;
  return max + Math.log(values.reduce((s, v) => s + Math.exp(v - max), 0));
}

// ── Log-normal PDF (in log-space) ──
function logNormalLogPdf(x: number, mu: number, sigma: number): number {
  const lnX = Math.log(x + 1);
  const diff = lnX - mu;
  return -Math.log(sigma) - 0.5 * Math.log(2 * Math.PI) - Math.log(x + 1) - (diff * diff) / (2 * sigma * sigma);
}

// ════════════════════════════════════════════════════════════════
// Data Structures
// ════════════════════════════════════════════════════════════════

interface TFIDFModel {
  idf: Map<string, number>;
  centroids: Map<string, Map<string, number>>;
  centroidMags: Map<string, number>;
  docCount: number;
}

interface NaiveBayesModel {
  logPrior: Map<string, number>;
  wordLL: Map<string, Map<string, number>>;
  amountLL: Map<string, Map<string, number>>;
  dowLL: Map<string, Map<number, number>>;
  womLL: Map<string, Map<number, number>>;
  vocabSize: number;
  alpha: number;
}

interface AmountDistModel {
  params: Map<string, { mu: number; sigma: number; count: number }>;
}

interface EMAModel {
  patterns: Map<string, { emaAmount: number; count: number; avgGapDays: number; lastSeen: number; category: string }>;
}

interface MarkovModel {
  transitions: Map<string, Map<string, number>>;
  rowTotals: Map<string, number>;
}

interface EnsembleWeights {
  tfidf: number;
  naiveBayes: number;
  amountDist: number;
  ema: number;
  markov: number;
}

interface TrainedEnsemble {
  tfidf: TFIDFModel;
  naiveBayes: NaiveBayesModel;
  amountDist: AmountDistModel;
  ema: EMAModel;
  markov: MarkovModel;
  weights: EnsembleWeights;
  categories: string[];
  essentialityMap: Map<string, boolean>;
}

export interface EnsemblePrediction {
  category: string;
  confidence: number;
  isEssential: boolean;
  scores: Map<string, number>;
}

// ════════════════════════════════════════════════════════════════
// Model 1: TF-IDF + Cosine Similarity
// ════════════════════════════════════════════════════════════════

function trainTFIDF(data: { tokens: string[]; category: string }[]): TFIDFModel {
  const docCount = data.length;
  const df = new Map<string, number>();
  const catDocs = new Map<string, string[][]>();

  // Document frequency
  for (const { tokens, category } of data) {
    const unique = new Set(tokens);
    for (const t of unique) df.set(t, (df.get(t) || 0) + 1);
    if (!catDocs.has(category)) catDocs.set(category, []);
    catDocs.get(category)!.push(tokens);
  }

  // IDF
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(docCount / (1 + count)));
  }

  // Category centroids
  const centroids = new Map<string, Map<string, number>>();
  const centroidMags = new Map<string, number>();

  for (const [cat, docs] of catDocs) {
    const centroid = new Map<string, number>();
    for (const tokens of docs) {
      const termCounts = new Map<string, number>();
      for (const t of tokens) termCounts.set(t, (termCounts.get(t) || 0) + 1);
      for (const [term, count] of termCounts) {
        const tf = count / tokens.length;
        const tfidf = tf * (idf.get(term) || 0);
        centroid.set(term, (centroid.get(term) || 0) + tfidf);
      }
    }
    // Average
    for (const [term, val] of centroid) centroid.set(term, val / docs.length);
    centroids.set(cat, centroid);

    // Precompute magnitude
    let mag = 0;
    for (const val of centroid.values()) mag += val * val;
    centroidMags.set(cat, Math.sqrt(mag));
  }

  return { idf, centroids, centroidMags, docCount };
}

function predictTFIDF(model: TFIDFModel, tokens: string[], categories: string[]): Map<string, number> {
  // Build transaction vector
  const txVec = new Map<string, number>();
  const termCounts = new Map<string, number>();
  for (const t of tokens) termCounts.set(t, (termCounts.get(t) || 0) + 1);
  for (const [term, count] of termCounts) {
    const tf = count / tokens.length;
    txVec.set(term, tf * (model.idf.get(term) || 0));
  }

  let txMag = 0;
  for (const val of txVec.values()) txMag += val * val;
  txMag = Math.sqrt(txMag);

  if (txMag === 0) {
    // No meaningful tokens — return uniform
    const uniform = -Math.log(categories.length);
    return new Map(categories.map((c) => [c, uniform]));
  }

  // Cosine similarity with each centroid
  const T = 0.5; // softmax temperature
  const logScores: number[] = [];
  const catScores: [string, number][] = [];

  for (const cat of categories) {
    const centroid = model.centroids.get(cat);
    const centroidMag = model.centroidMags.get(cat) || 0;
    if (!centroid || centroidMag === 0) {
      catScores.push([cat, -10]);
      logScores.push(-10);
      continue;
    }
    let dot = 0;
    for (const [term, val] of txVec) {
      dot += val * (centroid.get(term) || 0);
    }
    const sim = dot / (txMag * centroidMag);
    const score = sim / T;
    catScores.push([cat, score]);
    logScores.push(score);
  }

  // Softmax normalisation
  const lse = logSumExp(logScores);
  return new Map(catScores.map(([cat, score]) => [cat, score - lse]));
}

// ════════════════════════════════════════════════════════════════
// Model 2: Naïve Bayes
// ════════════════════════════════════════════════════════════════

function trainNaiveBayes(data: { tokens: string[]; amount: number; date: Date; category: string }[]): NaiveBayesModel {
  const alpha = 1.0;
  const alphaSmall = 0.5;
  const totalDocs = data.length;

  const catCount = new Map<string, number>();
  const wordCounts = new Map<string, Map<string, number>>();
  const catWordTotals = new Map<string, number>();
  const amountCounts = new Map<string, Map<string, number>>();
  const dowCounts = new Map<string, Map<number, number>>();
  const womCounts = new Map<string, Map<number, number>>();
  const vocab = new Set<string>();

  for (const { tokens, amount, date, category } of data) {
    catCount.set(category, (catCount.get(category) || 0) + 1);

    // Words
    if (!wordCounts.has(category)) wordCounts.set(category, new Map());
    const wc = wordCounts.get(category)!;
    for (const t of tokens) {
      vocab.add(t);
      wc.set(t, (wc.get(t) || 0) + 1);
      catWordTotals.set(category, (catWordTotals.get(category) || 0) + 1);
    }

    // Amount bucket
    const bucket = amountToBucket(amount);
    if (!amountCounts.has(category)) amountCounts.set(category, new Map());
    const ac = amountCounts.get(category)!;
    ac.set(bucket, (ac.get(bucket) || 0) + 1);

    // Day of week
    const dow = date.getDay();
    if (!dowCounts.has(category)) dowCounts.set(category, new Map());
    const dc = dowCounts.get(category)!;
    dc.set(dow, (dc.get(dow) || 0) + 1);

    // Week of month
    const wom = weekOfMonth(date.getDate());
    if (!womCounts.has(category)) womCounts.set(category, new Map());
    const wc2 = womCounts.get(category)!;
    wc2.set(wom, (wc2.get(wom) || 0) + 1);
  }

  const vocabSize = vocab.size;
  const numBuckets = AMOUNT_THRESHOLDS.length + 1;

  // Compute log-probabilities
  const logPrior = new Map<string, number>();
  for (const [cat, count] of catCount) {
    logPrior.set(cat, Math.log(count / totalDocs));
  }

  const wordLL = new Map<string, Map<string, number>>();
  for (const [cat, wc] of wordCounts) {
    const total = catWordTotals.get(cat) || 0;
    const ll = new Map<string, number>();
    for (const word of vocab) {
      ll.set(word, Math.log(((wc.get(word) || 0) + alpha) / (total + alpha * vocabSize)));
    }
    wordLL.set(cat, ll);
  }

  const amountLL = new Map<string, Map<string, number>>();
  for (const [cat, ac] of amountCounts) {
    const total = catCount.get(cat) || 0;
    const ll = new Map<string, number>();
    for (let i = 0; i <= AMOUNT_THRESHOLDS.length; i++) {
      const b = `b${i}`;
      ll.set(b, Math.log(((ac.get(b) || 0) + alphaSmall) / (total + alphaSmall * numBuckets)));
    }
    amountLL.set(cat, ll);
  }

  const dowLL = new Map<string, Map<number, number>>();
  for (const [cat, dc] of dowCounts) {
    const total = catCount.get(cat) || 0;
    const ll = new Map<number, number>();
    for (let d = 0; d < 7; d++) {
      ll.set(d, Math.log(((dc.get(d) || 0) + alphaSmall) / (total + alphaSmall * 7)));
    }
    dowLL.set(cat, ll);
  }

  const womLL = new Map<string, Map<number, number>>();
  for (const [cat, wc2] of womCounts) {
    const total = catCount.get(cat) || 0;
    const ll = new Map<number, number>();
    for (let w = 1; w <= 5; w++) {
      ll.set(w, Math.log(((wc2.get(w) || 0) + alphaSmall) / (total + alphaSmall * 5)));
    }
    womLL.set(cat, ll);
  }

  return { logPrior, wordLL, amountLL, dowLL, womLL, vocabSize, alpha };
}

function predictNaiveBayes(
  model: NaiveBayesModel,
  tokens: string[],
  amount: number,
  date: Date,
  categories: string[],
): Map<string, number> {
  const bucket = amountToBucket(amount);
  const dow = date.getDay();
  const wom = weekOfMonth(date.getDate());
  const unseenLogProb = Math.log(model.alpha / (model.alpha * model.vocabSize));

  const logScores: [string, number][] = [];

  for (const cat of categories) {
    let score = model.logPrior.get(cat) || -10;

    // Word likelihoods
    const catWords = model.wordLL.get(cat);
    if (catWords) {
      for (const t of tokens) {
        score += catWords.get(t) ?? unseenLogProb;
      }
    }

    // Amount bucket
    const catAmount = model.amountLL.get(cat);
    if (catAmount) score += catAmount.get(bucket) ?? -3;

    // Day of week
    const catDow = model.dowLL.get(cat);
    if (catDow) score += catDow.get(dow) ?? -2;

    // Week of month
    const catWom = model.womLL.get(cat);
    if (catWom) score += catWom.get(wom) ?? -2;

    logScores.push([cat, score]);
  }

  const lse = logSumExp(logScores.map(([, s]) => s));
  return new Map(logScores.map(([cat, score]) => [cat, score - lse]));
}

// ════════════════════════════════════════════════════════════════
// Model 3: Amount Distribution (Log-Normal)
// ════════════════════════════════════════════════════════════════

function trainAmountDist(data: { amount: number; category: string }[]): AmountDistModel {
  const catAmounts = new Map<string, number[]>();
  for (const { amount, category } of data) {
    if (!catAmounts.has(category)) catAmounts.set(category, []);
    catAmounts.get(category)!.push(Math.abs(amount));
  }

  const params = new Map<string, { mu: number; sigma: number; count: number }>();
  for (const [cat, amounts] of catAmounts) {
    const logAmounts = amounts.map((a) => Math.log(a + 1));
    const n = logAmounts.length;
    const mu = logAmounts.reduce((s, v) => s + v, 0) / n;
    const variance = logAmounts.reduce((s, v) => s + (v - mu) * (v - mu), 0) / n;
    const sigma = Math.max(0.5, Math.sqrt(variance));
    params.set(cat, { mu, sigma, count: n });
  }

  return { params };
}

function predictAmountDist(model: AmountDistModel, amount: number, categories: string[]): Map<string, number> {
  const logScores: [string, number][] = [];
  for (const cat of categories) {
    const p = model.params.get(cat);
    if (p && p.count >= 3) {
      logScores.push([cat, logNormalLogPdf(Math.abs(amount), p.mu, p.sigma)]);
    } else {
      logScores.push([cat, -5]); // weak prior for insufficient data
    }
  }
  const lse = logSumExp(logScores.map(([, s]) => s));
  return new Map(logScores.map(([cat, score]) => [cat, score - lse]));
}

// ════════════════════════════════════════════════════════════════
// Model 4: EMA Recurrence
// ════════════════════════════════════════════════════════════════

function trainEMA(data: { normalised: string; amount: number; date: Date; category: string }[]): EMAModel {
  const alpha = 0.3;
  // Sort by date
  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const patterns = new Map<string, { emaAmount: number; count: number; avgGapDays: number; lastSeen: number; category: string }>();

  for (const { normalised, amount, date, category } of sorted) {
    const absAmt = Math.abs(amount);
    const existing = patterns.get(normalised);
    if (existing) {
      existing.emaAmount = alpha * absAmt + (1 - alpha) * existing.emaAmount;
      const gap = (date.getTime() - existing.lastSeen) / (1000 * 60 * 60 * 24);
      existing.avgGapDays = alpha * gap + (1 - alpha) * existing.avgGapDays;
      existing.lastSeen = date.getTime();
      existing.count++;
      existing.category = category; // latest category wins
    } else {
      patterns.set(normalised, {
        emaAmount: absAmt,
        count: 1,
        avgGapDays: 30,
        lastSeen: date.getTime(),
        category,
      });
    }
  }

  return { patterns };
}

function predictEMA(model: EMAModel, normalised: string, amount: number, date: Date, categories: string[]): Map<string, number> {
  const pattern = model.patterns.get(normalised);

  if (!pattern || pattern.count < 2) {
    // No pattern — abstain (return uniform)
    const uniform = -Math.log(categories.length);
    return new Map(categories.map((c) => [c, uniform]));
  }

  const absAmt = Math.abs(amount);
  const amountDiff = Math.abs(absAmt - pattern.emaAmount) / (0.3 * pattern.emaAmount + 1);
  const amountFit = Math.exp(-0.5 * amountDiff * amountDiff);

  const daysSinceLast = (date.getTime() - pattern.lastSeen) / (1000 * 60 * 60 * 24);
  const recurrenceFit = daysSinceLast < 2 * pattern.avgGapDays
    ? 1.0
    : Math.exp(-0.1 * (daysSinceLast - 2 * pattern.avgGapDays));

  const matchScore = Math.log(Math.max(0.01, amountFit * recurrenceFit));
  const noMatchScore = Math.log(0.05);

  const logScores: [string, number][] = categories.map((c) => [
    c,
    c === pattern.category ? matchScore : noMatchScore,
  ]);

  const lse = logSumExp(logScores.map(([, s]) => s));
  return new Map(logScores.map(([cat, score]) => [cat, score - lse]));
}

// ════════════════════════════════════════════════════════════════
// Model 5: Markov Chain
// ════════════════════════════════════════════════════════════════

function trainMarkov(data: { date: Date; category: string }[]): MarkovModel {
  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const transitions = new Map<string, Map<string, number>>();
  const rowTotals = new Map<string, number>();

  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / (1000 * 60 * 60 * 24);
    if (gap > 7) continue; // only count transitions within same spending session

    const prev = sorted[i - 1].category;
    const curr = sorted[i].category;
    if (!transitions.has(prev)) transitions.set(prev, new Map());
    const row = transitions.get(prev)!;
    row.set(curr, (row.get(curr) || 0) + 1);
    rowTotals.set(prev, (rowTotals.get(prev) || 0) + 1);
  }

  return { transitions, rowTotals };
}

function predictMarkov(model: MarkovModel, prevCategory: string | null, categories: string[]): Map<string, number> {
  const smoothing = 0.1;
  const numCats = categories.length;

  if (!prevCategory || !model.transitions.has(prevCategory)) {
    const uniform = -Math.log(numCats);
    return new Map(categories.map((c) => [c, uniform]));
  }

  const row = model.transitions.get(prevCategory)!;
  const total = model.rowTotals.get(prevCategory) || 0;

  const logScores: [string, number][] = categories.map((c) => [
    c,
    Math.log(((row.get(c) || 0) + smoothing) / (total + smoothing * numCats)),
  ]);

  const lse = logSumExp(logScores.map(([, s]) => s));
  return new Map(logScores.map(([cat, score]) => [cat, score - lse]));
}

// ════════════════════════════════════════════════════════════════
// Ensemble: Training + Prediction
// ════════════════════════════════════════════════════════════════

const DEFAULT_WEIGHTS: EnsembleWeights = {
  tfidf: 1.0,
  naiveBayes: 0.8,
  amountDist: 0.3,
  ema: 0.5,
  markov: 0.2,
};

const COLD_START_WEIGHTS: EnsembleWeights = {
  tfidf: 1.0,
  naiveBayes: 0.6,
  amountDist: 0,
  ema: 0,
  markov: 0,
};

const MIN_TRAINING_SIZE = 10;
const COLD_START_THRESHOLD = 30;
const CONFIDENCE_THRESHOLD = 0.45;
const MIN_MARGIN = 0.15;

/**
 * Train the Bayesian ensemble from high/medium-confidence transactions.
 * Returns null if insufficient training data (<10 transactions).
 */
export function trainEnsemble(trainingData: EnrichedTransaction[]): TrainedEnsemble | null {
  if (trainingData.length < MIN_TRAINING_SIZE) return null;

  // Prepare features
  const prepared = trainingData.map((tx) => ({
    tokens: tokenise(tx.description),
    normalised: normaliseDescription(tx.description),
    amount: tx.amount,
    date: new Date(tx.date),
    category: tx.category,
  }));

  const categories = [...new Set(prepared.map((d) => d.category))].filter((c) => c !== 'Other');

  // Train all 5 models
  const tfidf = trainTFIDF(prepared);
  const naiveBayes = trainNaiveBayes(prepared);
  const amountDist = trainAmountDist(prepared);
  const ema = trainEMA(prepared);
  const markov = trainMarkov(prepared);

  // Determine weights based on data size
  const weights = trainingData.length < COLD_START_THRESHOLD ? COLD_START_WEIGHTS : DEFAULT_WEIGHTS;

  // Essentiality map: majority rule per category
  const essentialityMap = new Map<string, boolean>();
  const catCounts = new Map<string, { essential: number; total: number }>();
  for (const tx of trainingData) {
    const c = catCounts.get(tx.category) || { essential: 0, total: 0 };
    if (tx.isEssential) c.essential++;
    c.total++;
    catCounts.set(tx.category, c);
  }
  for (const [cat, { essential, total }] of catCounts) {
    essentialityMap.set(cat, essential / total > 0.5);
  }

  return { tfidf, naiveBayes, amountDist, ema, markov, weights, categories, essentialityMap };
}

/**
 * Predict a category for an unclassified transaction using the ensemble.
 * Returns null if no confident prediction can be made.
 */
export function predictWithEnsemble(
  ensemble: TrainedEnsemble,
  tx: RawTransaction,
  allEnriched: EnrichedTransaction[],
): EnsemblePrediction | null {
  const { tfidf, naiveBayes, amountDist, ema, markov, weights, categories } = ensemble;
  if (categories.length === 0) return null;

  const tokens = tokenise(tx.description);
  const normalised = normaliseDescription(tx.description);
  const date = new Date(tx.date);

  // Run each model
  const tfidfScores = predictTFIDF(tfidf, tokens, categories);
  const nbScores = predictNaiveBayes(naiveBayes, tokens, tx.amount, date, categories);
  const amountScores = predictAmountDist(amountDist, tx.amount, categories);
  const emaScores = predictEMA(ema, normalised, tx.amount, date, categories);

  // Find previous transaction's category for Markov context
  const txTime = date.getTime();
  let prevCategory: string | null = null;
  let closestGap = Infinity;
  for (const e of allEnriched) {
    const eTime = new Date(e.date).getTime();
    const gap = txTime - eTime;
    if (gap > 0 && gap < closestGap && e.category !== 'Other') {
      closestGap = gap;
      prevCategory = e.category;
    }
  }
  const markovScores = predictMarkov(markov, prevCategory, categories);

  // Combine with weighted log-probabilities
  const combined = new Map<string, number>();
  for (const cat of categories) {
    const score =
      weights.tfidf * (tfidfScores.get(cat) || -10) +
      weights.naiveBayes * (nbScores.get(cat) || -10) +
      weights.amountDist * (amountScores.get(cat) || -10) +
      weights.ema * (emaScores.get(cat) || -10) +
      weights.markov * (markovScores.get(cat) || -10);
    combined.set(cat, score);
  }

  // Softmax to get probabilities
  const lse = logSumExp([...combined.values()]);
  const probs = new Map<string, number>();
  for (const [cat, score] of combined) {
    probs.set(cat, Math.exp(score - lse));
  }

  // Find top prediction
  let bestCat = categories[0];
  let bestProb = 0;
  for (const [cat, prob] of probs) {
    if (prob > bestProb) {
      bestProb = prob;
      bestCat = cat;
    }
  }

  return {
    category: bestCat,
    confidence: bestProb,
    isEssential: ensemble.essentialityMap.get(bestCat) || false,
    scores: probs,
  };
}

/**
 * Check if a prediction is confident enough to accept.
 * Requires both absolute confidence and margin over second-best.
 */
export function shouldAcceptPrediction(prediction: EnsemblePrediction): boolean {
  if (prediction.confidence < CONFIDENCE_THRESHOLD) return false;

  const sorted = [...prediction.scores.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length < 2) return prediction.confidence >= CONFIDENCE_THRESHOLD;

  const margin = sorted[0][1] - sorted[1][1];
  return margin >= MIN_MARGIN;
}
