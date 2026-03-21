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
  { patterns: ['kokoro'], merchant: 'Kokoro', category: 'Eating Out' },
  { patterns: ['fillishack', 'filli shack'], merchant: 'Fillishack', category: 'Eating Out' },
  { patterns: ['bungrill', 'bun grill'], merchant: 'BunGrill', category: 'Eating Out' },
  { patterns: ['leon'], merchant: 'Leon', category: 'Eating Out' },
  { patterns: ['itsu'], merchant: 'Itsu', category: 'Eating Out' },
  { patterns: ['eat.'], merchant: 'EAT.', category: 'Eating Out' },
  { patterns: ['tortilla'], merchant: 'Tortilla', category: 'Eating Out' },
  { patterns: ['wasabi'], merchant: 'Wasabi', category: 'Eating Out' },
  { patterns: ['chick-fil-a', 'chickfila'], merchant: 'Chick-fil-A', category: 'Eating Out' },
  { patterns: ['wingstop'], merchant: 'Wingstop', category: 'Eating Out' },
  { patterns: ['franco manca'], merchant: 'Franco Manca', category: 'Eating Out' },
  { patterns: ['chipotle'], merchant: 'Chipotle', category: 'Eating Out' },
  { patterns: ['german doner', 'gdk'], merchant: 'German Doner Kebab', category: 'Eating Out' },
  { patterns: ['morleys'], merchant: 'Morleys', category: 'Eating Out' },

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
  { patterns: ['apple.com/bill', 'apple services', 'apple.com'], merchant: 'Apple Services', category: 'Streaming', isSubscription: true },
  { patterns: ['amazon prime', 'amzn prime'], merchant: 'Amazon Prime', category: 'Streaming', isSubscription: true },
  { patterns: ['disney plus', 'disneyplus', 'disney+'], merchant: 'Disney+', category: 'Streaming', isSubscription: true },
  { patterns: ['youtube premium', 'google youtube'], merchant: 'YouTube Premium', category: 'Streaming', isSubscription: true },
  { patterns: ['now tv', 'nowtv'], merchant: 'NOW TV', category: 'Streaming', isSubscription: true },
  { patterns: ['sky digital', 'sky uk'], merchant: 'Sky', category: 'Streaming', isSubscription: true },
  { patterns: ['crunchyroll'], merchant: 'Crunchyroll', category: 'Streaming', isSubscription: true },
  { patterns: ['audible'], merchant: 'Audible', category: 'Streaming', isSubscription: true },

  // ── Software & SaaS Subscriptions (discretionary) ──
  { patterns: ['claude.ai', 'claude ai', 'anthropic'], merchant: 'Claude', category: 'Subscriptions', isSubscription: true },
  { patterns: ['chatgpt', 'openai'], merchant: 'ChatGPT', category: 'Subscriptions', isSubscription: true },
  { patterns: ['github'], merchant: 'GitHub', category: 'Subscriptions', isSubscription: true },
  { patterns: ['framer'], merchant: 'Framer', category: 'Subscriptions', isSubscription: true },
  { patterns: ['mobbin'], merchant: 'Mobbin', category: 'Subscriptions', isSubscription: true },
  { patterns: ['figma'], merchant: 'Figma', category: 'Subscriptions', isSubscription: true },
  { patterns: ['notion'], merchant: 'Notion', category: 'Subscriptions', isSubscription: true },
  { patterns: ['canva'], merchant: 'Canva', category: 'Subscriptions', isSubscription: true },
  { patterns: ['adobe'], merchant: 'Adobe', category: 'Subscriptions', isSubscription: true },
  { patterns: ['twitter', 'x premium', 'x developer', 'x.com'], merchant: 'Twitter / X', category: 'Subscriptions', isSubscription: true },
  { patterns: ['linkedin premium', 'linkedin'], merchant: 'LinkedIn', category: 'Subscriptions', isSubscription: true },
  { patterns: ['google storage', 'google one'], merchant: 'Google One', category: 'Subscriptions', isSubscription: true },
  { patterns: ['icloud', 'icloud+'], merchant: 'iCloud+', category: 'Subscriptions', isSubscription: true },
  { patterns: ['microsoft 365', 'microsoft office', 'office 365'], merchant: 'Microsoft 365', category: 'Subscriptions', isSubscription: true },

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
  { patterns: ['vinted'], merchant: 'Vinted', category: 'Shopping' },
  { patterns: ['tiktok shop', 'tiktokshop', 'tiktok.com'], merchant: 'TikTok Shop', category: 'Shopping' },
  { patterns: ['etsy', 'etsy.com'], merchant: 'Etsy', category: 'Shopping' },
  { patterns: ['depop'], merchant: 'Depop', category: 'Shopping' },
  { patterns: ['wish.com', 'wish shopping'], merchant: 'Wish', category: 'Shopping' },
  { patterns: ['aliexpress', 'ali express'], merchant: 'AliExpress', category: 'Shopping' },
  { patterns: ['tk maxx', 'tkmaxx', 'tj maxx'], merchant: 'TK Maxx', category: 'Shopping' },
  { patterns: ['sports direct', 'sportsdirect'], merchant: 'Sports Direct', category: 'Shopping' },
  { patterns: ['jd sports'], merchant: 'JD Sports', category: 'Shopping' },
  { patterns: ['currys', 'currys pc world'], merchant: 'Currys', category: 'Shopping' },
  { patterns: ['halfords'], merchant: 'Halfords', category: 'Shopping' },
  { patterns: ['wilko', 'wilkinsons'], merchant: 'Wilko', category: 'Shopping' },
  { patterns: ['home bargains'], merchant: 'Home Bargains', category: 'Shopping' },
  { patterns: ['b&m', 'b and m'], merchant: 'B&M', category: 'Shopping' },
  { patterns: ['poundland'], merchant: 'Poundland', category: 'Shopping' },

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
  { patterns: ['welcomeenergy', 'welcome energy'], merchant: 'Welcome Energy', category: 'Energy', isEssential: true },
  { patterns: ['utilita'], merchant: 'Utilita', category: 'Energy', isEssential: true },
  { patterns: ['shell energy'], merchant: 'Shell Energy', category: 'Energy', isEssential: true },
  { patterns: ['boost energy', 'boost power'], merchant: 'Boost Energy', category: 'Energy', isEssential: true },

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
  { patterns: ['grainger', 'grainger plc'], merchant: 'Grainger', category: 'Rent', isEssential: true },
  { patterns: ['countrywide', 'hamptons'], merchant: 'Hamptons', category: 'Rent', isEssential: true },

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
  { patterns: ['amex', 'american express', 'american exp'], merchant: 'American Express', category: 'Debt Payments', isDebt: true, isEssential: true },
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

  // ── Savings (excluded from spending — money set aside) ──
  { patterns: ['moneybox'], merchant: 'Moneybox', category: 'Savings' },
  { patterns: ['plum'], merchant: 'Plum', category: 'Savings' },
  { patterns: ['chip'], merchant: 'Chip', category: 'Savings' },
  { patterns: ['ns&i', 'nsandi', 'national savings'], merchant: 'NS&I', category: 'Savings' },
  { patterns: ['premium bond'], merchant: 'NS&I Premium Bonds', category: 'Savings' },
  { patterns: ['marcus'], merchant: 'Marcus', category: 'Savings' },
  { patterns: ['chase savings', 'chase saver'], merchant: 'Chase Savings', category: 'Savings' },
  { patterns: ['zopa'], merchant: 'Zopa', category: 'Savings' },

  // ── Investments (excluded from spending — capital deployed) ──
  { patterns: ['vanguard'], merchant: 'Vanguard', category: 'Investments' },
  { patterns: ['trading 212', 'trading212'], merchant: 'Trading 212', category: 'Investments' },
  { patterns: ['nutmeg'], merchant: 'Nutmeg', category: 'Investments' },
  { patterns: ['freetrade'], merchant: 'Freetrade', category: 'Investments' },
  { patterns: ['hargreaves', 'hl fund'], merchant: 'Hargreaves Lansdown', category: 'Investments' },
  { patterns: ['aj bell', 'ajbell'], merchant: 'AJ Bell', category: 'Investments' },
  { patterns: ['interactive investor', 'ii.co'], merchant: 'Interactive Investor', category: 'Investments' },
  { patterns: ['interactive brokers', 'ibkr'], merchant: 'Interactive Brokers', category: 'Investments' },
  { patterns: ['degiro'], merchant: 'DEGIRO', category: 'Investments' },
  { patterns: ['etoro'], merchant: 'eToro', category: 'Investments' },
  { patterns: ['coinbase'], merchant: 'Coinbase', category: 'Investments' },
  { patterns: ['kraken'], merchant: 'Kraken', category: 'Investments' },
  { patterns: ['crypto.com', 'cryptocom'], merchant: 'Crypto.com', category: 'Investments' },
  { patterns: ['binance'], merchant: 'Binance', category: 'Investments' },
  { patterns: ['wealthify'], merchant: 'Wealthify', category: 'Investments' },

  // ── International Transfers (not income, not spending — transfers) ──
  { patterns: ['lemfi'], merchant: 'LemFi', category: 'Transfers' },
  { patterns: ['wise', 'transferwise'], merchant: 'Wise', category: 'Transfers' },
  { patterns: ['remitly'], merchant: 'Remitly', category: 'Transfers' },
  { patterns: ['world remit', 'worldremit'], merchant: 'WorldRemit', category: 'Transfers' },
  { patterns: ['western union'], merchant: 'Western Union', category: 'Transfers' },
  { patterns: ['moneygram'], merchant: 'MoneyGram', category: 'Transfers' },
  { patterns: ['paypal'], merchant: 'PayPal', category: 'Transfers' },
  { patterns: ['revolut transfer'], merchant: 'Revolut Transfer', category: 'Transfers' },

  // ── Delivery services (discretionary) ──
  { patterns: ['getir'], merchant: 'Getir', category: 'Delivery' },
  { patterns: ['gorillas'], merchant: 'Gorillas', category: 'Delivery' },
  { patterns: ['gopuff'], merchant: 'GoPuff', category: 'Delivery' },
  { patterns: ['zapp'], merchant: 'Zapp', category: 'Delivery' },
  { patterns: ['amazon fresh', 'amzn fresh'], merchant: 'Amazon Fresh', category: 'Delivery' },

  // ── Florists (discretionary shopping) ──
  { patterns: ['interflora'], merchant: 'Interflora', category: 'Shopping' },
  { patterns: ['bloom & wild', 'bloomandwild', 'bloom and wild'], merchant: 'Bloom & Wild', category: 'Shopping' },
  { patterns: ['moonpig'], merchant: 'Moonpig', category: 'Shopping' },
  { patterns: ['bunches'], merchant: 'Bunches', category: 'Shopping' },

  // ── Additional Eating Out (discretionary) ──
  { patterns: ['wahaca'], merchant: 'Wahaca', category: 'Eating Out' },
  { patterns: ['dishoom'], merchant: 'Dishoom', category: 'Eating Out' },
  { patterns: ['honest burgers', 'honest burger'], merchant: 'Honest Burgers', category: 'Eating Out' },
  { patterns: ['byron'], merchant: 'Byron', category: 'Eating Out' },
  { patterns: ['prezzo'], merchant: 'Prezzo', category: 'Eating Out' },
  { patterns: ['yo sushi', 'yo! sushi'], merchant: 'YO! Sushi', category: 'Eating Out' },
  { patterns: ['pizza express', 'pizzaexpress'], merchant: 'Pizza Express', category: 'Eating Out' },
  { patterns: ['harvester'], merchant: 'Harvester', category: 'Eating Out' },
  { patterns: ['toby carvery'], merchant: 'Toby Carvery', category: 'Eating Out' },
  { patterns: ['beefeater'], merchant: 'Beefeater', category: 'Eating Out' },
  { patterns: ['wetherspoon', 'j d wetherspoon', 'jd wetherspoon'], merchant: "Wetherspoon's", category: 'Eating Out' },
  { patterns: ['tgi friday', "tgi friday's", 'tgi fridays'], merchant: "TGI Friday's", category: 'Eating Out' },
  { patterns: ['chiquito'], merchant: 'Chiquito', category: 'Eating Out' },
  { patterns: ['las iguanas'], merchant: 'Las Iguanas', category: 'Eating Out' },
  { patterns: ['cote', 'cote brasserie'], merchant: 'Côte', category: 'Eating Out' },
  { patterns: ['gourmet burger kitchen', 'gbk'], merchant: 'GBK', category: 'Eating Out' },
  { patterns: ['papa johns', "papa john's"], merchant: "Papa John's", category: 'Eating Out' },
  { patterns: ['slim chickens'], merchant: 'Slim Chickens', category: 'Eating Out' },
  { patterns: ['popeyes'], merchant: 'Popeyes', category: 'Eating Out' },
  { patterns: ['wendy'], merchant: "Wendy's", category: 'Eating Out' },
  { patterns: ['taco bell'], merchant: 'Taco Bell', category: 'Eating Out' },
  { patterns: ['krispy kreme'], merchant: 'Krispy Kreme', category: 'Eating Out' },

  // ── Additional Coffee & Cafes (discretionary) ──
  { patterns: ['black sheep coffee', 'black sheep'], merchant: 'Black Sheep Coffee', category: 'Coffee & Cafes' },
  { patterns: ['joe & the juice', 'joe and the juice'], merchant: 'Joe & The Juice', category: 'Coffee & Cafes' },
  { patterns: ['tim hortons'], merchant: 'Tim Hortons', category: 'Coffee & Cafes' },
  { patterns: ['paul bakery', 'paul uk'], merchant: 'PAUL', category: 'Coffee & Cafes' },
  { patterns: ['gail', "gail's", 'gails'], merchant: "Gail's", category: 'Coffee & Cafes' },
  { patterns: ['ole & steen', 'ole and steen'], merchant: 'Ole & Steen', category: 'Coffee & Cafes' },

  // ── Additional Groceries (essential) ──
  { patterns: ['farmfoods'], merchant: 'Farmfoods', category: 'Groceries', isEssential: true },
  { patterns: ['heron foods', 'heron'], merchant: 'Heron Foods', category: 'Groceries', isEssential: true },
  { patterns: ['jack'], merchant: "Jack's", category: 'Groceries', isEssential: true },
  { patterns: ['spar'], merchant: 'SPAR', category: 'Groceries', isEssential: true },
  { patterns: ['nisa'], merchant: 'Nisa', category: 'Groceries', isEssential: true },
  { patterns: ['londis'], merchant: 'Londis', category: 'Groceries', isEssential: true },
  { patterns: ['budgens'], merchant: 'Budgens', category: 'Groceries', isEssential: true },
  { patterns: ['costcutter'], merchant: 'Costcutter', category: 'Groceries', isEssential: true },

  // ── Additional Shopping (discretionary) ──
  { patterns: ['uniqlo'], merchant: 'Uniqlo', category: 'Shopping' },
  { patterns: ['river island'], merchant: 'River Island', category: 'Shopping' },
  { patterns: ['new look'], merchant: 'New Look', category: 'Shopping' },
  { patterns: ['superdry'], merchant: 'Superdry', category: 'Shopping' },
  { patterns: ['gap'], merchant: 'GAP', category: 'Shopping' },
  { patterns: ['mango'], merchant: 'Mango', category: 'Shopping' },
  { patterns: ['cos'], merchant: 'COS', category: 'Shopping' },
  { patterns: ['lush'], merchant: 'Lush', category: 'Shopping' },
  { patterns: ['the body shop', 'body shop'], merchant: 'The Body Shop', category: 'Shopping' },
  { patterns: ['screwfix'], merchant: 'Screwfix', category: 'Shopping' },
  { patterns: ['b&q', 'b and q'], merchant: 'B&Q', category: 'Shopping' },
  { patterns: ['hobbycraft'], merchant: 'Hobbycraft', category: 'Shopping' },
  { patterns: ['the range'], merchant: 'The Range', category: 'Shopping' },
  { patterns: ['dunelm'], merchant: 'Dunelm', category: 'Shopping' },
  { patterns: ['matalan'], merchant: 'Matalan', category: 'Shopping' },
  { patterns: ['peacocks'], merchant: 'Peacocks', category: 'Shopping' },
  { patterns: ['george asda'], merchant: 'George at Asda', category: 'Shopping' },
  { patterns: ['tu clothing', 'tu sainsbury'], merchant: 'Tu Clothing', category: 'Shopping' },

  // ── Additional Transport (essential) ──
  { patterns: ['national rail', 'nationalrail'], merchant: 'National Rail', category: 'Transport', isEssential: true },
  { patterns: ['lner'], merchant: 'LNER', category: 'Transport', isEssential: true },
  { patterns: ['avanti west coast', 'avanti'], merchant: 'Avanti', category: 'Transport', isEssential: true },
  { patterns: ['great western railway', 'gwr'], merchant: 'GWR', category: 'Transport', isEssential: true },
  { patterns: ['southern rail', 'southern railway'], merchant: 'Southern', category: 'Transport', isEssential: true },
  { patterns: ['southeastern'], merchant: 'Southeastern', category: 'Transport', isEssential: true },
  { patterns: ['northern rail', 'northern trains'], merchant: 'Northern', category: 'Transport', isEssential: true },
  { patterns: ['scotrail'], merchant: 'ScotRail', category: 'Transport', isEssential: true },
  { patterns: ['national express'], merchant: 'National Express', category: 'Transport', isEssential: true },
  { patterns: ['megabus'], merchant: 'Megabus', category: 'Transport', isEssential: true },
  { patterns: ['flixbus'], merchant: 'FlixBus', category: 'Transport', isEssential: true },
  { patterns: ['freenow', 'free now'], merchant: 'FREE NOW', category: 'Transport', isEssential: true },
  { patterns: ['lime bike', 'lime scooter', 'lime-e'], merchant: 'Lime', category: 'Transport' },
  { patterns: ['voi'], merchant: 'Voi', category: 'Transport' },
  { patterns: ['texaco'], merchant: 'Texaco', category: 'Transport', isEssential: true },
  { patterns: ['jet petrol', 'jet fuel'], merchant: 'Jet', category: 'Transport', isEssential: true },

  // ── Additional Entertainment (discretionary) ──
  { patterns: ['curzon'], merchant: 'Curzon', category: 'Entertainment' },
  { patterns: ['everyman cinema', 'everyman'], merchant: 'Everyman Cinema', category: 'Entertainment' },
  { patterns: ['picturehouse'], merchant: 'Picturehouse', category: 'Entertainment' },
  { patterns: ['the o2', 'theo2'], merchant: 'The O2', category: 'Entertainment' },
  { patterns: ['eventbrite'], merchant: 'Eventbrite', category: 'Entertainment' },
  { patterns: ['dice fm', 'dice.fm'], merchant: 'DICE', category: 'Entertainment' },

  // ── Additional Fitness (discretionary subscription) ──
  { patterns: ['barry', "barry's", 'barrys bootcamp'], merchant: "Barry's", category: 'Fitness', isSubscription: true },
  { patterns: ['f45'], merchant: 'F45 Training', category: 'Fitness', isSubscription: true },
  { patterns: ['classpass'], merchant: 'ClassPass', category: 'Fitness', isSubscription: true },
  { patterns: ['peloton'], merchant: 'Peloton', category: 'Fitness', isSubscription: true },
  { patterns: ['hussle'], merchant: 'Hussle', category: 'Fitness', isSubscription: true },
  { patterns: ['anytime fitness'], merchant: 'Anytime Fitness', category: 'Fitness', isSubscription: true },
  { patterns: ['jd gyms'], merchant: 'JD Gyms', category: 'Fitness', isSubscription: true },

  // ── Additional Streaming/Subscriptions (discretionary) ──
  { patterns: ['paramount+', 'paramount plus'], merchant: 'Paramount+', category: 'Streaming', isSubscription: true },
  { patterns: ['apple tv', 'apple tv+'], merchant: 'Apple TV+', category: 'Streaming', isSubscription: true },
  { patterns: ['discovery+', 'discovery plus'], merchant: 'Discovery+', category: 'Streaming', isSubscription: true },
  { patterns: ['britbox'], merchant: 'BritBox', category: 'Streaming', isSubscription: true },
  { patterns: ['hayu'], merchant: 'Hayu', category: 'Streaming', isSubscription: true },
  { patterns: ['dazn'], merchant: 'DAZN', category: 'Streaming', isSubscription: true },
  { patterns: ['tidal'], merchant: 'Tidal', category: 'Streaming', isSubscription: true },
  { patterns: ['amazon music'], merchant: 'Amazon Music', category: 'Streaming', isSubscription: true },
  { patterns: ['apple music'], merchant: 'Apple Music', category: 'Streaming', isSubscription: true },

  // ── Personal Care (discretionary) ──
  { patterns: ['specsavers'], merchant: 'Specsavers', category: 'Health', isEssential: true },
  { patterns: ['vision express'], merchant: 'Vision Express', category: 'Health', isEssential: true },

  // ── Childcare (essential) ──
  { patterns: ['bright horizons'], merchant: 'Bright Horizons', category: 'Childcare', isEssential: true },
  { patterns: ['kidsunlimited', 'kids unlimited'], merchant: 'Kids Unlimited', category: 'Childcare', isEssential: true },
  { patterns: ['busy bees'], merchant: 'Busy Bees', category: 'Childcare', isEssential: true },

  // ── Pets (discretionary) ──
  { patterns: ['pets at home'], merchant: 'Pets at Home', category: 'Pets' },
  { patterns: ['pet plan', 'petplan'], merchant: 'Petplan', category: 'Pets' },

  // ── Gambling (discretionary) ──
  { patterns: ['bet365'], merchant: 'Bet365', category: 'Gambling' },
  { patterns: ['paddy power', 'paddypower'], merchant: 'Paddy Power', category: 'Gambling' },
  { patterns: ['ladbrokes'], merchant: 'Ladbrokes', category: 'Gambling' },
  { patterns: ['william hill'], merchant: 'William Hill', category: 'Gambling' },
  { patterns: ['betfred'], merchant: 'Betfred', category: 'Gambling' },
  { patterns: ['skybet', 'sky bet'], merchant: 'Sky Bet', category: 'Gambling' },
  { patterns: ['betfair'], merchant: 'Betfair', category: 'Gambling' },
  { patterns: ['tombola'], merchant: 'Tombola', category: 'Gambling' },
  { patterns: ['national lottery', 'lottoland'], merchant: 'National Lottery', category: 'Gambling' },

  // ── Charity (discretionary) ──
  { patterns: ['cancer research'], merchant: 'Cancer Research', category: 'Charity' },
  { patterns: ['macmillan'], merchant: 'Macmillan', category: 'Charity' },
  { patterns: ['oxfam'], merchant: 'Oxfam', category: 'Charity' },
  { patterns: ['red cross', 'british red cross'], merchant: 'Red Cross', category: 'Charity' },
  { patterns: ['save the children'], merchant: 'Save the Children', category: 'Charity' },
  { patterns: ['shelter'], merchant: 'Shelter', category: 'Charity' },
  { patterns: ['nspcc'], merchant: 'NSPCC', category: 'Charity' },
  { patterns: ['mind charity', 'mind.org'], merchant: 'Mind', category: 'Charity' },
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

/**
 * Checks if a transaction description matches the user's own name,
 * indicating an internal transfer between the user's own accounts.
 * Handles variations: "J SMITH", "JOHN SMITH", "MR J SMITH", "SMITH J"
 */
export function isSelfTransfer(description: string, selfName?: string): boolean {
  if (!selfName || selfName.trim().length < 3) return false;

  const lower = description.toLowerCase().trim()
    .replace(/^(mr|mrs|miss|ms|dr|prof)\s+/i, '')
    .replace(/\bfp\b|\bbgt\b|\bbacs\b|\bchq\b|\bfaster payment\b|\bbank transfer\b|\btransfer to\b|\btransfer from\b|\bstanding order\b/g, '')
    .trim();

  const selfParts = selfName.toLowerCase().trim()
    .replace(/^(mr|mrs|miss|ms|dr|prof)\s+/i, '')
    .split(/\s+/)
    .filter((w) => w.length >= 1);

  if (selfParts.length < 2) return false;

  const selfFirst = selfParts[0];
  const selfLast = selfParts[selfParts.length - 1];
  const descWords = lower.split(/\s+/).filter((w) => /^[a-z'-]+$/.test(w) && w.length >= 1);

  // Last name must appear in the description
  if (!descWords.some((w) => w === selfLast)) return false;

  // First name or initial must also match
  const hasFirstName = descWords.some((w) => w === selfFirst);
  const hasInitial = descWords.some((w) => w.length === 1 && w === selfFirst[0]);

  return hasFirstName || hasInitial;
}

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

  // Strip trailing reference numbers (e.g. "ALICE BROWN REF 98765") before digit check
  const strippedRef = lower.replace(/\s+(ref|reference)\s+\d+\s*$/i, '').trim();

  // If it still contains digits after stripping refs, it's likely not a person name
  if (/\d/.test(strippedRef)) return false;

  // Clean the description: strip common prefixes
  const cleaned = strippedRef
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

// ── Fuzzy Merchant Matching ──
// Catches merchants with slight misspellings or word-order variations
// not covered by exact pattern matching. Only activates when exact
// matching fails. Returns null if no confident fuzzy match found.

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Space-optimised single-row DP
  const row: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(row[j] + 1, prev + 1, row[j - 1] + cost);
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

function extractSubstrings(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length >= 2);
  const out: string[] = [];
  for (let len = 1; len <= Math.min(3, words.length); len++) {
    for (let i = 0; i <= words.length - len; i++) {
      out.push(words.slice(i, i + len).join(' '));
    }
  }
  return out;
}

export function fuzzyMatchMerchant(
  description: string,
  normalisedDescription?: string,
): MerchantMatch | null {
  const candidates = [description.toLowerCase().trim()];
  if (normalisedDescription && normalisedDescription !== candidates[0]) {
    candidates.push(normalisedDescription);
  }

  let bestMatch: MerchantMatch | null = null;
  let bestSimilarity = 0;
  const MIN_SIMILARITY = 0.75;
  const MIN_PATTERN_LEN = 4;

  for (const text of candidates) {
    const substrings = extractSubstrings(text);

    for (const entry of MERCHANTS) {
      for (const pattern of entry.patterns) {
        if (pattern.length < MIN_PATTERN_LEN) continue;

        for (const substr of substrings) {
          // Skip if length difference too large
          if (Math.abs(substr.length - pattern.length) > Math.max(2, pattern.length * 0.4)) continue;

          const dist = levenshtein(substr, pattern);
          const maxLen = Math.max(substr.length, pattern.length);
          const similarity = 1 - dist / maxLen;

          if (similarity > bestSimilarity && similarity >= MIN_SIMILARITY) {
            bestSimilarity = similarity;
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
  }
  return bestMatch;
}

// ── Credit card / bank brand extraction ──
// Extracts a known financial brand from an account name string.

const CARD_BRANDS: [RegExp, string][] = [
  [/\b(amex|american express)\b/i, 'American Express'],
  [/\bbarclaycard\b/i, 'Barclaycard'],
  [/\bmbna\b/i, 'MBNA'],
  [/\bcapital one\b/i, 'Capital One'],
  [/\bvanquis\b/i, 'Vanquis'],
  [/\baqua\b/i, 'Aqua'],
  [/\bhsbc\b/i, 'HSBC'],
  [/\bmonzo\b/i, 'Monzo'],
  [/\bstarling\b/i, 'Starling'],
  [/\brevolut\b/i, 'Revolut'],
  [/\bchase\b/i, 'Chase'],
];

export function extractCreditCardBrand(accountName: string): string | null {
  if (!accountName) return null;
  for (const [pattern, brand] of CARD_BRANDS) {
    if (pattern.test(accountName)) return brand;
  }
  return null;
}
