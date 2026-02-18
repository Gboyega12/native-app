// ── Description Normalisation ──
// Cleans raw bank descriptions before merchant matching.
// Bank statements are full of noise: POS terminal IDs, payment gateway
// prefixes, card numbers, and trailing reference codes. Stripping these
// dramatically increases merchant-DB hit rate.
//
// Examples:
//   "SQ *COFFEE HOUSE LONDON"     → "coffee house london"
//   "PAYPAL *NETFLIX.COM"         → "netflix.com"
//   "POS 23847 CARD 4321 BOOTS"   → "boots"
//   "CRV*TESCO STORES 4521 GB"   → "tesco stores"
//   "IZ *DELIVEROO LONDON"        → "deliveroo london"

// Known payment gateway / terminal prefixes to strip
const GATEWAY_PREFIXES: RegExp[] = [
  /^sq\s*\*\s*/i,                   // Square
  /^sumup\s*\*\s*/i,                // SumUp
  /^iz\s*\*\s*/i,                   // iZettle
  /^zettle\s*\*\s*/i,               // Zettle (rebrand)
  /^paypal\s*\*\s*/i,               // PayPal
  /^pp\s*\*\s*/i,                   // PayPal alt
  /^crv\s*\*\s*/i,                  // Card reader vendor
  /^sp\s*\*\s*/i,                   // Shopify payments
  /^gp\s*\*\s*/i,                   // GoCardless / generic prefix
  /^stripe\s*\*\s*/i,               // Stripe
  /^wln\s*\*\s*/i,                  // Worldline
  /^adyen\s*\*\s*/i,                // Adyen payment gateway

  // ── UK bank description prefixes ──
  /^vis\s+(?:purchase|purch)\s*/i,  // HSBC: "VIS PURCHASE TESCO"
  /^visa\s+(?:purchase|purch)\s*/i, // HSBC alt
  /^card\s+pur(?:chase)?\s*/i,      // NatWest: "CARD PUR TESCO"
  /^dd\s*[\-:]\s*/i,                // NatWest: "DD - BRITISH GAS"
  /^so\s*[\-:]\s*/i,                // Standing order: "SO - OPENRENT"
  /^ddr\s*[\-:]\s*/i,               // Direct debit received
  /^bgc\s*[\-:]\s*/i,               // Bank giro credit
  /^chq\s*[\-:]\s*/i,               // Cheque
  /^contactless\s*/i,               // "CONTACTLESS TESCO" → "TESCO"
  /^chip\s*(?:&|and)\s*pin\s*/i,    // "CHIP & PIN TESCO" → "TESCO"
  /^online\s+transaction\s*/i,      // "ONLINE TRANSACTION AMAZON" → "AMAZON"
  /^faster\s+payment\s+(?:to|from)\s*/i, // "FASTER PAYMENT TO MR SMITH"

  // ── Generic direction prefixes ──
  /^to\s+/i,                        // "To American Exp 3773" → "American Exp 3773"
  /^from\s+/i,                      // "From HSBC" → "HSBC"
  /^payment\s+to\s+/i,              // "Payment to Amex" → "Amex"
  /^card\s+payment\s+to\s+/i,       // "Card payment to ..." → "..."
  /^direct\s+debit\s+(?:to|payment\s+to)\s+/i, // "Direct debit to ..." / "Direct debit payment to ..."
  /^standing\s+order\s+to\s+/i,     // "Standing order to ..."
];

// Noise patterns to strip (order matters — most specific first)
const NOISE_PATTERNS: RegExp[] = [
  /\bpos\s*\d+/gi,                  // POS terminal IDs: "POS 23847"
  /\bcard\s*\d{4}/gi,              // Card last 4: "CARD 4321"
  /\bref\s*[:\s]*[\w-]+/gi,       // Reference codes: "REF: ABC123"
  /\btxn\s*[:\s]*\w+/gi,          // Transaction IDs: "TXN: 12345"
  /\b\d{6,}\b/g,                   // Long number sequences (6+ digits)
  /\bgbr?\b/gi,                    // Country code "GB" or "GBR"
  /\bgb\s*$/gi,                    // Trailing "GB"
  /\bon\s+\d{2}[\/\-]\d{2}/gi,    // "ON 15/01" date suffixes
  /\b\d{2}[\/\-]\d{2}[\/\-]\d{2,4}\b/g, // Inline dates
  /\bcd\s*\d{4}/gi,               // "CD 1234"
  /\s+\d{4}$/g,                    // Trailing 4-digit card suffix: "AMEX 3773" → "AMEX"
  /\bvisa\b/gi,                    // Card network names
  /\bmastercard\b/gi,
  /\bdebit\b/gi,
  /\bcredit\b/gi,
  /\bdpc\b/gi,                     // Direct payment charge
  /\bbgt\b/gi,                     // Budget account prefix
  /\bfpi\b/gi,                     // Faster Payment Inbound
  /\bfpo\b/gi,                     // Faster Payment Outbound
  /\bbacs\b/gi,                    // BACS payment
  /\b[a-z]{2}\d{2}\s?\d{4}\s?\d{4}\s?\d{4}/gi, // Partial IBANs
  /\bchip\s*(?:&|and)\s*pin\b/gi,  // Payment method marker
  /\bcontactless\b/gi,             // Payment method marker
  /\b(?:www\.)?[\w-]+\.(?:com|co\.uk|org|net)\b/gi, // URLs (keep merchant name, strip domain)
  /\s+[\w]{2,3}\d{6,}/gi,          // Branch/terminal codes like "LDN123456"
];

export function normaliseDescription(description: string): string {
  let text = description.toLowerCase().trim();

  // Strip gateway prefixes
  for (const prefix of GATEWAY_PREFIXES) {
    text = text.replace(prefix, '');
  }

  // Strip noise patterns
  for (const noise of NOISE_PATTERNS) {
    text = text.replace(noise, '');
  }

  // Collapse multiple spaces / trim
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}
