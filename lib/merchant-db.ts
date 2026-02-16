interface MerchantEntry {
  patterns: string[];
  merchant: string;
  category: string;
  isEssential?: boolean;
  isSubscription?: boolean;
  isBNPL?: boolean;
  isDebt?: boolean;
  isIncome?: boolean;
}

export interface MerchantMatch {
  merchant: string;
  category: string;
  isEssential: boolean;
  isSubscription: boolean;
  isBNPL: boolean;
  isDebt: boolean;
  isIncome: boolean;
}

const MERCHANTS: MerchantEntry[] = [
  // ── Groceries (essential) ──
  { patterns: ['tesco', 'tesco stores'], merchant: 'Tesco', category: 'Groceries', isEssential: true },
  { patterns: ['sainsbury', 'sainsburys', "sainsbury's"], merchant: "Sainsbury's", category: 'Groceries', isEssential: true },
  { patterns: ['asda', 'asda stores'], merchant: 'Asda', category: 'Groceries', isEssential: true },
  { patterns: ['morrisons', 'wm morrisons'], merchant: 'Morrisons', category: 'Groceries', isEssential: true },
  { patterns: ['aldi'], merchant: 'Aldi', category: 'Groceries', isEssential: true },
  { patterns: ['lidl'], merchant: 'Lidl', category: 'Groceries', isEssential: true },
  { patterns: ['waitrose'], merchant: 'Waitrose', category: 'Groceries', isEssential: true },
  { patterns: ['co-op', 'coop', 'co op'], merchant: 'Co-op', category: 'Groceries', isEssential: true },
  { patterns: ['marks and spencer', 'm&s', 'marks & spencer'], merchant: 'M&S', category: 'Groceries', isEssential: true },
  { patterns: ['iceland'], merchant: 'Iceland', category: 'Groceries', isEssential: true },
  { patterns: ['ocado'], merchant: 'Ocado', category: 'Groceries', isEssential: true },

  // ── Delivery (discretionary) ──
  { patterns: ['deliveroo'], merchant: 'Deliveroo', category: 'Delivery' },
  { patterns: ['uber eats', 'ubereats'], merchant: 'Uber Eats', category: 'Delivery' },
  { patterns: ['just eat', 'justeat'], merchant: 'Just Eat', category: 'Delivery' },

  // ── Coffee & Cafes (discretionary) ──
  { patterns: ['starbucks'], merchant: 'Starbucks', category: 'Coffee & Cafes' },
  { patterns: ['costa coffee', 'costa'], merchant: 'Costa Coffee', category: 'Coffee & Cafes' },
  { patterns: ['pret', 'pret a manger'], merchant: 'Pret A Manger', category: 'Coffee & Cafes' },
  { patterns: ['greggs'], merchant: 'Greggs', category: 'Coffee & Cafes' },
  { patterns: ['caffe nero', 'nero'], merchant: 'Caffe Nero', category: 'Coffee & Cafes' },

  // ── Eating Out (discretionary) ──
  { patterns: ['mcdonald', 'mcdonalds'], merchant: "McDonald's", category: 'Eating Out' },
  { patterns: ['burger king'], merchant: 'Burger King', category: 'Eating Out' },
  { patterns: ['kfc'], merchant: 'KFC', category: 'Eating Out' },
  { patterns: ['nandos', "nando's"], merchant: "Nando's", category: 'Eating Out' },
  { patterns: ['wagamama'], merchant: 'Wagamama', category: 'Eating Out' },
  { patterns: ['five guys'], merchant: 'Five Guys', category: 'Eating Out' },
  { patterns: ['dominos', "domino's"], merchant: "Domino's", category: 'Eating Out' },
  { patterns: ['pizza hut'], merchant: 'Pizza Hut', category: 'Eating Out' },
  { patterns: ['subway'], merchant: 'Subway', category: 'Eating Out' },

  // ── Transport (essential) ──
  { patterns: ['uber', 'uber *trip', 'uber bv'], merchant: 'Uber', category: 'Transport', isEssential: true },
  { patterns: ['tfl', 'transport for london', 'tfl.gov'], merchant: 'TfL', category: 'Transport', isEssential: true },
  { patterns: ['trainline'], merchant: 'Trainline', category: 'Transport', isEssential: true },
  { patterns: ['bolt', 'bolt.eu'], merchant: 'Bolt', category: 'Transport', isEssential: true },
  { patterns: ['shell', 'shell petrol'], merchant: 'Shell', category: 'Transport', isEssential: true },
  { patterns: ['bp', 'bp petrol'], merchant: 'BP', category: 'Transport', isEssential: true },
  { patterns: ['esso'], merchant: 'Esso', category: 'Transport', isEssential: true },

  // ── Streaming (discretionary) ──
  { patterns: ['netflix'], merchant: 'Netflix', category: 'Streaming', isSubscription: true },
  { patterns: ['spotify'], merchant: 'Spotify', category: 'Streaming', isSubscription: true },
  { patterns: ['apple.com/bill', 'apple services'], merchant: 'Apple Services', category: 'Streaming', isSubscription: true },
  { patterns: ['amazon prime', 'amzn prime'], merchant: 'Amazon Prime', category: 'Streaming', isSubscription: true },
  { patterns: ['disney plus', 'disneyplus', 'disney+'], merchant: 'Disney+', category: 'Streaming', isSubscription: true },
  { patterns: ['youtube premium', 'google youtube'], merchant: 'YouTube Premium', category: 'Streaming', isSubscription: true },
  { patterns: ['now tv', 'nowtv'], merchant: 'NOW TV', category: 'Streaming', isSubscription: true },
  { patterns: ['sky digital', 'sky uk'], merchant: 'Sky', category: 'Streaming', isSubscription: true },
  { patterns: ['crunchyroll'], merchant: 'Crunchyroll', category: 'Streaming', isSubscription: true },
  { patterns: ['audible'], merchant: 'Audible', category: 'Streaming', isSubscription: true },

  // ── Fitness (discretionary) ──
  { patterns: ['gym', 'puregym', 'pure gym', 'the gym', 'david lloyd', 'virgin active', 'nuffield'], merchant: 'Gym', category: 'Fitness', isSubscription: true },

  // ── Shopping (discretionary) ──
  { patterns: ['amazon', 'amzn', 'amzn mktp'], merchant: 'Amazon', category: 'Shopping' },
  { patterns: ['asos'], merchant: 'ASOS', category: 'Shopping' },
  { patterns: ['ebay'], merchant: 'eBay', category: 'Shopping' },
  { patterns: ['primark'], merchant: 'Primark', category: 'Shopping' },
  { patterns: ['zara'], merchant: 'Zara', category: 'Shopping' },
  { patterns: ['h&m', 'h and m'], merchant: 'H&M', category: 'Shopping' },
  { patterns: ['next'], merchant: 'Next', category: 'Shopping' },
  { patterns: ['john lewis'], merchant: 'John Lewis', category: 'Shopping' },
  { patterns: ['argos'], merchant: 'Argos', category: 'Shopping' },
  { patterns: ['ikea'], merchant: 'IKEA', category: 'Shopping' },
  { patterns: ['shein'], merchant: 'Shein', category: 'Shopping' },
  { patterns: ['nike'], merchant: 'Nike', category: 'Shopping' },
  { patterns: ['boohoo'], merchant: 'Boohoo', category: 'Shopping' },
  { patterns: ['plt', 'prettylittlething'], merchant: 'PrettyLittleThing', category: 'Shopping' },

  // ── BNPL (discretionary) ──
  { patterns: ['klarna'], merchant: 'Klarna', category: 'BNPL', isBNPL: true },
  { patterns: ['clearpay'], merchant: 'Clearpay', category: 'BNPL', isBNPL: true },
  { patterns: ['laybuy'], merchant: 'Laybuy', category: 'BNPL', isBNPL: true },

  // ── Broadband & Phone (essential) ──
  { patterns: ['bt group', 'bt payment', 'british telecom'], merchant: 'BT', category: 'Broadband & Phone', isEssential: true },
  { patterns: ['virgin media', 'virginmedia'], merchant: 'Virgin Media', category: 'Broadband & Phone', isEssential: true },
  { patterns: ['ee', 'ee limited'], merchant: 'EE', category: 'Broadband & Phone', isEssential: true },
  { patterns: ['vodafone'], merchant: 'Vodafone', category: 'Broadband & Phone', isEssential: true },
  { patterns: ['three', 'three.co.uk', 'hutchison 3g'], merchant: 'Three', category: 'Broadband & Phone', isEssential: true },
  { patterns: ['o2', 'telefonica'], merchant: 'O2', category: 'Broadband & Phone', isEssential: true },
  { patterns: ['giffgaff'], merchant: 'giffgaff', category: 'Broadband & Phone', isEssential: true },
  { patterns: ['tesco mobile'], merchant: 'Tesco Mobile', category: 'Broadband & Phone', isEssential: true },
  { patterns: ['sky broadband'], merchant: 'Sky Broadband', category: 'Broadband & Phone', isEssential: true },
  { patterns: ['plusnet'], merchant: 'Plusnet', category: 'Broadband & Phone', isEssential: true },
  { patterns: ['talktalk'], merchant: 'TalkTalk', category: 'Broadband & Phone', isEssential: true },

  // ── Council Tax (essential) ──
  { patterns: ['council tax'], merchant: 'Council Tax', category: 'Council Tax', isEssential: true },

  // ── Energy (essential) ──
  { patterns: ['british gas', 'britishgas'], merchant: 'British Gas', category: 'Energy', isEssential: true },
  { patterns: ['octopus energy'], merchant: 'Octopus Energy', category: 'Energy', isEssential: true },
  { patterns: ['eon', 'e.on'], merchant: 'E.ON', category: 'Energy', isEssential: true },
  { patterns: ['edf energy', 'edf'], merchant: 'EDF', category: 'Energy', isEssential: true },
  { patterns: ['ovo energy', 'ovo'], merchant: 'OVO Energy', category: 'Energy', isEssential: true },
  { patterns: ['bulb energy', 'bulb'], merchant: 'Bulb', category: 'Energy', isEssential: true },
  { patterns: ['scottish power', 'scottishpower'], merchant: 'Scottish Power', category: 'Energy', isEssential: true },

  // ── Water (essential) ──
  { patterns: ['thames water', 'united utilities', 'severn trent', 'anglian water', 'southern water', 'yorkshire water', 'welsh water', 'northumbrian water'], merchant: 'Water', category: 'Water', isEssential: true },

  // ── TV Licence (essential) ──
  { patterns: ['tv licence', 'tv licensing'], merchant: 'TV Licence', category: 'TV Licence', isEssential: true },

  // ── Insurance (essential) ──
  { patterns: ['aviva'], merchant: 'Aviva', category: 'Insurance', isEssential: true },
  { patterns: ['admiral'], merchant: 'Admiral', category: 'Insurance', isEssential: true },
  { patterns: ['direct line', 'directline'], merchant: 'Direct Line', category: 'Insurance', isEssential: true },
  { patterns: ['hastings direct', 'hastingsdirect'], merchant: 'Hastings Direct', category: 'Insurance', isEssential: true },
  { patterns: ['aa insurance', 'aa breakdown'], merchant: 'AA', category: 'Insurance', isEssential: true },
  { patterns: ['rac'], merchant: 'RAC', category: 'Insurance', isEssential: true },
  { patterns: ['churchill'], merchant: 'Churchill', category: 'Insurance', isEssential: true },
  { patterns: ['legal & general', 'legal and general'], merchant: 'Legal & General', category: 'Insurance', isEssential: true },
  { patterns: ['vitality'], merchant: 'Vitality', category: 'Insurance', isEssential: true },
  { patterns: ['bupa'], merchant: 'Bupa', category: 'Insurance', isEssential: true },

  // ── Rent (essential) ──
  { patterns: ['openrent'], merchant: 'OpenRent', category: 'Rent', isEssential: true },
  { patterns: ['goodlord'], merchant: 'Goodlord', category: 'Rent', isEssential: true },
  { patterns: ['foxtons'], merchant: 'Foxtons', category: 'Rent', isEssential: true },
  { patterns: ['rightmove'], merchant: 'Rightmove', category: 'Rent', isEssential: true },

  // ── Entertainment (discretionary) ──
  { patterns: ['cineworld', 'odeon', 'vue cinema'], merchant: 'Cinema', category: 'Entertainment' },
  { patterns: ['ticketmaster'], merchant: 'Ticketmaster', category: 'Entertainment' },

  // ── Health (essential) ──
  { patterns: ['boots'], merchant: 'Boots', category: 'Health', isEssential: true },
  { patterns: ['superdrug'], merchant: 'Superdrug', category: 'Health', isEssential: true },

  // ── Debt / Credit (essential) ──
  { patterns: ['loan', 'lending'], merchant: 'Loan Payment', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['student loan', 'slc'], merchant: 'Student Loan', category: 'Debt Payments', isDebt: true, isEssential: true },

  // Credit card issuers — UK-specific
  { patterns: ['amex', 'american express'], merchant: 'American Express', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['barclaycard'], merchant: 'Barclaycard', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['mbna'], merchant: 'MBNA', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['capital one'], merchant: 'Capital One', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['vanquis'], merchant: 'Vanquis', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['aqua card', 'aqua credit'], merchant: 'Aqua', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['newday', 'new day'], merchant: 'NewDay', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['virgin money credit', 'virgin credit'], merchant: 'Virgin Money', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['tesco credit', 'tesco bank credit'], merchant: 'Tesco Bank', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['sainsburys bank', "sainsbury's bank"], merchant: "Sainsbury's Bank", category: 'Debt Payments', isDebt: true, isEssential: true },

  // Car finance / HP
  { patterns: ['black horse', 'bhfc'], merchant: 'Black Horse Finance', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['moneybarn'], merchant: 'Moneybarn', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['bmw financial', 'bmw finance'], merchant: 'BMW Finance', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['vw financial', 'vw finance', 'volkswagen finance'], merchant: 'VW Finance', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['mercedes finance', 'mercedes-benz finance'], merchant: 'Mercedes Finance', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['pcp finance', 'motor finance', 'car finance'], merchant: 'Car Finance', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['close brothers', 'close motor'], merchant: 'Close Brothers', category: 'Debt Payments', isDebt: true, isEssential: true },
  { patterns: ['motonovo', 'moto novo'], merchant: 'MotoNovo', category: 'Debt Payments', isDebt: true, isEssential: true },

  // Mortgage providers
  { patterns: ['nationwide mortgage'], merchant: 'Nationwide', category: 'Mortgage', isDebt: true, isEssential: true },
  { patterns: ['halifax mortgage', 'halifax mtg'], merchant: 'Halifax', category: 'Mortgage', isDebt: true, isEssential: true },
  { patterns: ['santander mortgage', 'santander mtg'], merchant: 'Santander', category: 'Mortgage', isDebt: true, isEssential: true },
  { patterns: ['natwest mortgage', 'natwest mtg'], merchant: 'NatWest', category: 'Mortgage', isDebt: true, isEssential: true },
  { patterns: ['barclays mortgage', 'barclays mtg'], merchant: 'Barclays', category: 'Mortgage', isDebt: true, isEssential: true },
  { patterns: ['hsbc mortgage', 'hsbc mtg'], merchant: 'HSBC', category: 'Mortgage', isDebt: true, isEssential: true },
  { patterns: ['lloyds mortgage', 'lloyds mtg'], merchant: 'Lloyds', category: 'Mortgage', isDebt: true, isEssential: true },
  { patterns: ['tsb mortgage', 'tsb mtg'], merchant: 'TSB', category: 'Mortgage', isDebt: true, isEssential: true },
  { patterns: ['coventry building', 'coventry bs'], merchant: 'Coventry BS', category: 'Mortgage', isDebt: true, isEssential: true },
  { patterns: ['yorkshire building', 'yorkshire bs'], merchant: 'Yorkshire BS', category: 'Mortgage', isDebt: true, isEssential: true },

  // ── Income (special — not spending) ──
  { patterns: ['salary', 'wages', 'payroll'], merchant: 'Salary', category: 'Income', isIncome: true },
  { patterns: ['hmrc', 'tax refund', 'tax credit'], merchant: 'HMRC', category: 'Income', isIncome: true },
  { patterns: ['dwp', 'universal credit', 'jobseekers'], merchant: 'DWP Benefits', category: 'Income', isIncome: true },

  // ── Savings (special — not spending) ──
  { patterns: ['vanguard'], merchant: 'Vanguard', category: 'Savings' },
  { patterns: ['trading 212', 'trading212'], merchant: 'Trading 212', category: 'Savings' },
  { patterns: ['nutmeg'], merchant: 'Nutmeg', category: 'Savings' },
  { patterns: ['moneybox'], merchant: 'Moneybox', category: 'Savings' },
];

// Short patterns (<=3 chars) use word-boundary matching to avoid false positives.
// e.g. "ee" must not match "coffee", "bp" must not match "ebook purchase".
function patternMatches(text: string, pattern: string): boolean {
  if (pattern.length <= 3) {
    return new RegExp(`\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
  }
  return text.includes(pattern);
}

export function matchMerchant(description: string, normalisedDescription?: string): MerchantMatch | null {
  // Try raw description first, then fall back to normalised version.
  // This ensures exact matches still work, while normalised descriptions
  // catch cases where gateway prefixes / noise hide the merchant name.
  const candidates = [description.toLowerCase().trim()];
  if (normalisedDescription && normalisedDescription !== candidates[0]) {
    candidates.push(normalisedDescription);
  }

  // Find the match with the LONGEST pattern. This ensures specific patterns
  // like "tesco credit" beat generic ones like "tesco", and "student loan"
  // beats "loan". Without this, array order would silently misclassify debt
  // transactions as groceries or other categories.
  let bestMatch: MerchantMatch | null = null;
  let bestPatternLen = 0;

  for (const text of candidates) {
    for (const entry of MERCHANTS) {
      for (const pattern of entry.patterns) {
        if (pattern.length > bestPatternLen && patternMatches(text, pattern)) {
          bestPatternLen = pattern.length;
          bestMatch = {
            merchant: entry.merchant,
            category: entry.category,
            isEssential: entry.isEssential || false,
            isSubscription: entry.isSubscription || false,
            isBNPL: entry.isBNPL || false,
            isDebt: entry.isDebt || false,
            isIncome: entry.isIncome || false,
          };
        }
      }
    }
  }
  return bestMatch;
}

// ── Salary / employer keyword detection ──
// Uses word-boundary regex to avoid false positives
// e.g. 'pay' must not match 'payment', 'paypoint', 'apple pay'

const SALARY_PATTERNS: RegExp[] = [
  /\bsalary\b/, /\bwages\b/, /\bpayroll\b/, /\bpayday\b/,
  /\bstipend\b/, /\bcommission\b/, /\bpension\b/,
  /\bpay from\b/, /\bmonthly pay\b/, /\bnet pay\b/, /\bdirect deposit\b/,
];

const EMPLOYER_PATTERNS: RegExp[] = [
  /\bltd\b/, /\bplc\b/, /\blimited\b/, /\binc\b/, /\bcorp\b/, /\bllp\b/,
  /\bgroup\b/, /\bholdings\b/,
  /\bcouncil\b/, /\bnhs\b/, /\buniversity\b/,
  /\bacademy\b/, /\bassociates\b/, /\bpartners\b/,
];

const BENEFIT_PATTERNS: RegExp[] = [
  /\bhmrc\b/, /\bdwp\b/, /\buniversal credit\b/, /\btax credit\b/,
  /\btax refund\b/, /\bchild benefit\b/, /\bjobseekers?\b/,
  /\bhousing benefit\b/, /\bpip\b/, /\besa\b/, /\bworking tax\b/,
  /\bstate pension\b/, /\bdisability\b/, /\bcarers? allowance\b/,
];

// ── Person name detection ──
// Matches 1-3 alpha-only words with no brand/company indicators.
// e.g. "John Smith", "Sarah Jane Williams", "Mr David Brown"
// Excludes descriptions containing company suffixes, numbers, or brand patterns.

const BRAND_INDICATORS = [
  'ltd', 'plc', 'limited', 'inc', 'corp', 'co.', 'co ',
  '.com', '.co.uk', '.org', 'www.',
  'store', 'shop', 'online', 'direct', 'club', 'plus',
  'pay', 'bill', 'fee', 'charge',
];

export function isPersonTransfer(description: string): boolean {
  const lower = description.toLowerCase().trim();

  // Explicit transfer method patterns — must NOT include generic "payment to"
  // because UK banks format most debits as "CARD PAYMENT TO [merchant]".
  const transferPatterns = [
    /^(mr|mrs|miss|ms|dr)\s/,
    /\bfaster payment\b/,
    /\bbank transfer\b/,
    /\btransfer to\b/,
    /\btransfer from\b/,
  ];
  if (transferPatterns.some((p) => p.test(lower))) return true;

  // "standing order" is only a transfer if the destination looks like a person,
  // not a company (e.g. "STANDING ORDER TO BRITISH GAS" is a bill, not a transfer)
  if (/\bstanding order\b/.test(lower) && !BRAND_INDICATORS.some((b) => lower.includes(b)) && !/\d/.test(lower)) {
    return true;
  }

  // If it contains any brand/company indicators, it's NOT a person
  if (BRAND_INDICATORS.some((b) => lower.includes(b))) return false;

  // If it contains digits, it's likely a reference number — not a person name
  if (/\d/.test(lower)) return false;

  // Clean the description: strip common prefixes
  const cleaned = lower
    .replace(/^(mr|mrs|miss|ms|dr|prof)\s+/i, '')
    .replace(/\bfp\b|\bbgt\b|\bbacs\b|\bchq\b/g, '')
    .trim();

  // Match 2-3 purely alphabetic words (typical person name pattern).
  // Single words are too ambiguous — "aldi", "pharmacy", "barbershop"
  // would all false-positive. Require at least 2 words for a name match.
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 3) {
    const allAlpha = words.every((w) => /^[a-z'-]+$/.test(w) && w.length >= 2);
    if (allAlpha) return true;
  }

  return false;
}

// ── Company / employer credit detection ──
// Checks if a credit transaction description looks like it comes from
// a company (salary, employer, government benefit, etc.)

export function matchesSalaryKeywords(description: string): boolean {
  const lower = description.toLowerCase();
  return SALARY_PATTERNS.some((rx) => rx.test(lower));
}

export function matchesEmployerPattern(description: string): boolean {
  const lower = description.toLowerCase();
  return EMPLOYER_PATTERNS.some((rx) => rx.test(lower));
}

export function matchesBenefitKeywords(description: string): boolean {
  const lower = description.toLowerCase();
  return BENEFIT_PATTERNS.some((rx) => rx.test(lower));
}

export function isLikelyIncomeCredit(description: string): boolean {
  return matchesSalaryKeywords(description)
    || matchesEmployerPattern(description)
    || matchesBenefitKeywords(description);
}
