# Transaction Enrichment Engine — Institutional Grade
## Definition
Transaction enrichment is NOT categorisation.
It is:
→ The reconstruction of **true economic meaning** from raw financial data
BOCY does NOT label transactions.
BOCY determines:
→ What actually happened financially
→ Why it happened
→ How it affects the user's financial system
---
# CORE OBJECTIVE
Achieve:
→ Near-100% correctness in:
- Merchant identification
- Transaction intent
- Financial classification
- Recurrence detection
- System impact
---
# ENRICHMENT PIPELINE (MULTI-LAYER)
## Layer 1: Raw Normalisation
Input:
- Bank description
- Amount
- Timestamp
- Account
Tasks:
- Clean strings (remove noise, codes, IDs)
- Standardize formats
- Extract structured fields
---
## Layer 2: Merchant Resolution (Deterministic First)
Goal:
→ Identify the EXACT merchant/entity
Methods:
1. Deterministic Matching
- Known merchant database
- Regex rules
- Bank-specific mappings
2. Fuzzy Matching
- String similarity
- Alias resolution
3. External Enrichment (if needed)
- Merchant registries
- Payment processors
---
## RULE
Merchant identification must be:
→ Exact OR confidence-scored
---
## Output:
- Canonical merchant name
- Merchant type (utility, retailer, employer, etc.)
---
## Layer 3: Transaction Decomposition
Critical step most systems fail.
Each transaction must be broken into:
1. Primary intent
2. Secondary components (if any)
Example:
- Amazon purchase:
  → Retail (primary)
- Salary:
  → Income (primary)
- Credit card payment:
  → Liability transfer (NOT spending)
---
## RULE
DO NOT treat all outflows as expenses
---
## Layer 4: Economic Classification (NOT Categories)
Replace "categories" with:
### Financial Types:
1. Income
2. Fixed Essential Expense
3. Variable Essential Expense
4. Discretionary Expense
5. Debt Repayment
6. Asset Transfer
7. Internal Transfer
8. Investment Contribution
9. Tax-related
10. One-off / Anomalous
---
## RULE
Classification must reflect:
→ Economic meaning, not merchant type
---
## Layer 5: Recurrence Detection
Goal:
→ Identify patterns with high confidence
Detect:
- Fixed recurring (salary, rent)
- Variable recurring (utilities)
- Irregular patterns
Methods:
- Time-series clustering
- Amount consistency
- Interval detection
---
## Output:
- Recurrence type
- Next expected occurrence
- Confidence score
---
## Layer 6: Contextual Enrichment
Each transaction must be enriched with:
- Essential vs discretionary
- Fixed vs variable
- Linked transactions (e.g. salary → rent → savings)
- Role in user's financial system
---
## Example
Electricity bill:
Not:
→ "Utilities"
But:
→ "Recurring essential expense required to maintain baseline living"
---
## Layer 7: System-Level Linking
Link transactions across accounts:
Examples:
- Salary → savings transfer → investment
- Credit card spend → credit card repayment
---
## RULE
BOCY must understand:
→ Flows, not isolated transactions
---
## Layer 8: Validation Layer (CRITICAL FOR 100% CORRECTNESS)
Every transaction must pass:
### 1. Consistency Check
- Does classification match historical pattern?
### 2. Balance Check
- Do inflows/outflows reconcile logically?
### 3. Cross-Account Check
- Is this actually a transfer?
---
## Conflict Resolution
If ambiguity exists:
→ Assign confidence score
→ Defer to higher-certainty classification
→ Flag for refinement
---
## Layer 9: Continuous Learning
System improves via:
- User corrections (high weight)
- Pattern reinforcement
- Aggregated anonymized signals
---
## HARD RULE
User corrections override model assumptions
---
# CONFIDENCE MODEL
Each transaction must include:
- Merchant confidence (0–1)
- Classification confidence (0–1)
- Recurrence confidence (0–1)
---
## RULE
If confidence < threshold:
→ Do NOT use for critical insights
---
# ERROR TYPES (MUST BE ELIMINATED)
1. Treating transfers as expenses
2. Misidentifying income
3. Misclassifying debt payments
4. Missing recurring obligations
5. Double-counting across accounts
---
# INSIGHT DEPENDENCY
No insight may be generated unless:
→ Underlying transactions are correctly enriched
---
# EXAMPLES
## Example 1
Raw:
"AMZN MKTP UK 12345"
Enriched:
- Merchant: Amazon
- Type: Discretionary expense
- Recurrence: Non-recurring
- System role: Consumption
---
## Example 2
Raw:
"HSBC CREDIT CARD PAYMENT"
Enriched:
- Type: Liability settlement
- NOT an expense
- Linked to prior credit transactions
---
## Example 3
Raw:
"PAYROLL ABC LTD"
Enriched:
- Type: Income
- Recurring
- Confidence: High
---
# DIFFERENTIATION VS GENERIC SYSTEMS
Generic systems:
→ Categorize transactions
BOCY:
→ Reconstructs financial reality
---
# FINAL OBJECTIVE
BOCY must know:
→ Not just WHAT a transaction is
→ But WHAT IT MEANS for the user's financial system
---
User must never think:
→ "This categorisation is wrong"
System must operate as:
→ A **source of financial truth**