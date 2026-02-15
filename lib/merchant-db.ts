interface MerchantEntry {
  patterns: string[];
  merchant: string;
  category: string;
  isSubscription?: boolean;
  isBNPL?: boolean;
  isDebt?: boolean;
  isIncome?: boolean;
}

export interface MerchantMatch {
  merchant: string;
  category: string;
  isSubscription: boolean;
  isBNPL: boolean;
  isDebt: boolean;
  isIncome: boolean;
}

const MERCHANTS: MerchantEntry[] = [
  // Supermarkets & Groceries
  { patterns: ['tesco', 'tesco stores'], merchant: 'Tesco', category: 'Groceries' },
  { patterns: ['sainsbury', 'sainsburys', "sainsbury's"], merchant: "Sainsbury's", category: 'Groceries' },
  { patterns: ['asda', 'asda stores'], merchant: 'Asda', category: 'Groceries' },
  { patterns: ['morrisons', 'wm morrisons'], merchant: 'Morrisons', category: 'Groceries' },
  { patterns: ['aldi'], merchant: 'Aldi', category: 'Groceries' },
  { patterns: ['lidl'], merchant: 'Lidl', category: 'Groceries' },
  { patterns: ['waitrose'], merchant: 'Waitrose', category: 'Groceries' },
  { patterns: ['co-op', 'coop', 'co op'], merchant: 'Co-op', category: 'Groceries' },
  { patterns: ['marks and spencer', 'm&s', 'marks & spencer'], merchant: 'M&S', category: 'Groceries' },
  { patterns: ['iceland'], merchant: 'Iceland', category: 'Groceries' },
  { patterns: ['ocado'], merchant: 'Ocado', category: 'Groceries' },

  // Food Delivery
  { patterns: ['deliveroo'], merchant: 'Deliveroo', category: 'Food Delivery' },
  { patterns: ['uber eats', 'ubereats'], merchant: 'Uber Eats', category: 'Food Delivery' },
  { patterns: ['just eat', 'justeat'], merchant: 'Just Eat', category: 'Food Delivery' },

  // Coffee & Cafes
  { patterns: ['starbucks'], merchant: 'Starbucks', category: 'Coffee & Cafes' },
  { patterns: ['costa coffee', 'costa'], merchant: 'Costa Coffee', category: 'Coffee & Cafes' },
  { patterns: ['pret', 'pret a manger'], merchant: 'Pret A Manger', category: 'Coffee & Cafes' },
  { patterns: ['greggs'], merchant: 'Greggs', category: 'Coffee & Cafes' },
  { patterns: ['caffe nero', 'nero'], merchant: 'Caffe Nero', category: 'Coffee & Cafes' },

  // Eating Out
  { patterns: ['mcdonald', 'mcdonalds'], merchant: "McDonald's", category: 'Eating Out' },
  { patterns: ['burger king'], merchant: 'Burger King', category: 'Eating Out' },
  { patterns: ['kfc'], merchant: 'KFC', category: 'Eating Out' },
  { patterns: ['nandos', "nando's"], merchant: "Nando's", category: 'Eating Out' },
  { patterns: ['wagamama'], merchant: 'Wagamama', category: 'Eating Out' },
  { patterns: ['five guys'], merchant: 'Five Guys', category: 'Eating Out' },
  { patterns: ['dominos', "domino's"], merchant: "Domino's", category: 'Eating Out' },
  { patterns: ['pizza hut'], merchant: 'Pizza Hut', category: 'Eating Out' },
  { patterns: ['subway'], merchant: 'Subway', category: 'Eating Out' },

  // Transport
  { patterns: ['uber', 'uber *trip', 'uber bv'], merchant: 'Uber', category: 'Transport' },
  { patterns: ['tfl', 'transport for london', 'tfl.gov'], merchant: 'TfL', category: 'Transport' },
  { patterns: ['trainline'], merchant: 'Trainline', category: 'Transport' },
  { patterns: ['bolt', 'bolt.eu'], merchant: 'Bolt', category: 'Transport' },
  { patterns: ['shell', 'shell petrol'], merchant: 'Shell', category: 'Transport' },
  { patterns: ['bp', 'bp petrol'], merchant: 'BP', category: 'Transport' },
  { patterns: ['esso'], merchant: 'Esso', category: 'Transport' },

  // Subscriptions & Streaming
  { patterns: ['netflix'], merchant: 'Netflix', category: 'Subscriptions', isSubscription: true },
  { patterns: ['spotify'], merchant: 'Spotify', category: 'Subscriptions', isSubscription: true },
  { patterns: ['apple.com/bill', 'apple services'], merchant: 'Apple Services', category: 'Subscriptions', isSubscription: true },
  { patterns: ['amazon prime', 'amzn prime'], merchant: 'Amazon Prime', category: 'Subscriptions', isSubscription: true },
  { patterns: ['disney plus', 'disneyplus', 'disney+'], merchant: 'Disney+', category: 'Subscriptions', isSubscription: true },
  { patterns: ['youtube premium', 'google youtube'], merchant: 'YouTube Premium', category: 'Subscriptions', isSubscription: true },
  { patterns: ['now tv', 'nowtv'], merchant: 'NOW TV', category: 'Subscriptions', isSubscription: true },
  { patterns: ['sky digital', 'sky uk'], merchant: 'Sky', category: 'Subscriptions', isSubscription: true },
  { patterns: ['crunchyroll'], merchant: 'Crunchyroll', category: 'Subscriptions', isSubscription: true },
  { patterns: ['audible'], merchant: 'Audible', category: 'Subscriptions', isSubscription: true },
  { patterns: ['gym', 'puregym', 'pure gym', 'the gym', 'david lloyd', 'virgin active', 'nuffield'], merchant: 'Gym', category: 'Subscriptions', isSubscription: true },

  // Shopping
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

  // BNPL
  { patterns: ['klarna'], merchant: 'Klarna', category: 'BNPL', isBNPL: true },
  { patterns: ['clearpay'], merchant: 'Clearpay', category: 'BNPL', isBNPL: true },
  { patterns: ['laybuy'], merchant: 'Laybuy', category: 'BNPL', isBNPL: true },

  // Bills & Utilities
  { patterns: ['bt group', 'bt payment', 'british telecom'], merchant: 'BT', category: 'Bills' },
  { patterns: ['virgin media', 'virginmedia'], merchant: 'Virgin Media', category: 'Bills' },
  { patterns: ['ee', 'ee limited'], merchant: 'EE', category: 'Bills' },
  { patterns: ['vodafone'], merchant: 'Vodafone', category: 'Bills' },
  { patterns: ['three', 'three.co.uk', 'hutchison 3g'], merchant: 'Three', category: 'Bills' },
  { patterns: ['o2', 'telefonica'], merchant: 'O2', category: 'Bills' },
  { patterns: ['council tax'], merchant: 'Council Tax', category: 'Bills' },
  { patterns: ['british gas', 'britishgas'], merchant: 'British Gas', category: 'Bills' },
  { patterns: ['octopus energy'], merchant: 'Octopus Energy', category: 'Bills' },
  { patterns: ['eon', 'e.on'], merchant: 'E.ON', category: 'Bills' },
  { patterns: ['thames water', 'united utilities', 'severn trent', 'anglian water', 'southern water'], merchant: 'Water', category: 'Bills' },
  { patterns: ['tv licence', 'tv licensing'], merchant: 'TV Licence', category: 'Bills' },

  // Entertainment
  { patterns: ['cineworld', 'odeon', 'vue cinema'], merchant: 'Cinema', category: 'Entertainment' },
  { patterns: ['ticketmaster'], merchant: 'Ticketmaster', category: 'Entertainment' },

  // Health
  { patterns: ['boots'], merchant: 'Boots', category: 'Health' },
  { patterns: ['superdrug'], merchant: 'Superdrug', category: 'Health' },

  // Debt / Credit
  { patterns: ['loan', 'lending'], merchant: 'Loan Payment', category: 'Debt Payments', isDebt: true },
  { patterns: ['credit card', 'card payment'], merchant: 'Credit Card', category: 'Debt Payments', isDebt: true },
  { patterns: ['student loan', 'slc'], merchant: 'Student Loan', category: 'Debt Payments', isDebt: true },

  // Income patterns
  { patterns: ['salary', 'wages', 'payroll'], merchant: 'Salary', category: 'Income', isIncome: true },
  { patterns: ['hmrc', 'tax refund', 'tax credit'], merchant: 'HMRC', category: 'Income', isIncome: true },
  { patterns: ['dwp', 'universal credit', 'jobseekers'], merchant: 'DWP Benefits', category: 'Income', isIncome: true },

  // Savings
  { patterns: ['vanguard'], merchant: 'Vanguard', category: 'Savings' },
  { patterns: ['trading 212', 'trading212'], merchant: 'Trading 212', category: 'Savings' },
  { patterns: ['nutmeg'], merchant: 'Nutmeg', category: 'Savings' },
  { patterns: ['moneybox'], merchant: 'Moneybox', category: 'Savings' },
];

export function matchMerchant(description: string): MerchantMatch | null {
  const lower = description.toLowerCase().trim();
  for (const entry of MERCHANTS) {
    for (const pattern of entry.patterns) {
      if (lower.includes(pattern)) {
        return {
          merchant: entry.merchant,
          category: entry.category,
          isSubscription: entry.isSubscription || false,
          isBNPL: entry.isBNPL || false,
          isDebt: entry.isDebt || false,
          isIncome: entry.isIncome || false,
        };
      }
    }
  }
  return null;
}

export function isPersonTransfer(description: string): boolean {
  const lower = description.toLowerCase();
  const personPatterns = [
    /^(mr|mrs|miss|ms|dr)\s/,
    /\bfaster payment\b/,
    /\bbank transfer\b/,
    /\bstanding order\b/,
  ];
  return personPatterns.some((p) => p.test(lower));
}
