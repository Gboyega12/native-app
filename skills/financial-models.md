# Financial Models — Institutional Grade Decision Engine
BOCY operates as a **multi-layer capital allocation system**.
It does NOT optimize in isolation.
It determines:
→ Where each marginal £ delivers the highest **risk-adjusted, liquidity-aware, after-tax utility**
---
# CORE MODEL
## Liquidity-Adjusted Marginal Utility (LAMU)
Every £ is evaluated based on its **next best use**, not its current state.
LAMU answers:
→ "Where should the NEXT £ go?"
---
## LAMU Formula
Utility (£) =
+ Liquidity Utility
+ Probability-Weighted Return
- Cost of Capital (Debt)
- Tax Drag
- Risk Penalty
---
# LAYER 1: LIQUIDITY CONSTRAINT (NON-NEGOTIABLE)
Before any optimization:
Define:
- Monthly essential outflows
- Income stability
- Buffer requirement (3–12 months)
---
## Rules
1. Liquidity below threshold:
   → ALL optimization stops
   → Priority = rebuild buffer
2. Liquidity above threshold:
   → Excess capital becomes optimizable
---
# LAYER 2: HIERARCHY OF CAPITAL ALLOCATION
Capital MUST be allocated in this order:
---
## Tier 1: Guaranteed Returns
- High-interest debt repayment (>6–8%)
- Employer pension match (if applicable)
→ These dominate ALL other uses
---
## Tier 2: Tax-Advantaged Allocation
- ISA
- Pension (within optimal range)
→ Immediate return via tax shield
---
## Tier 3: Market-Based Returns
- Equities
- Diversified investments
→ Subject to uncertainty (requires Monte Carlo)
---
## Tier 4: Excess Liquidity
- Cash beyond required buffer
→ Lowest utility unless required for optionality
---
# RULE
If capital is sitting in a lower tier while a higher tier is underutilized:
→ This is a **mandatory insight**
---
# LAYER 3: MONTE CARLO SIMULATION (UNCERTAINTY ENGINE)
## Purpose
Replace deterministic assumptions with:
→ **probability distributions of outcomes**
---
## Simulation Inputs
- Expected return (mean)
- Volatility (standard deviation)
- Time horizon
- Contribution patterns
- Inflation (optional)
- Correlation (if multi-asset)
---
## Simulation Output
BOCY must extract:
1. Median outcome (realistic expectation)
2. Downside (10th percentile)
3. Upside (90th percentile)
4. Probability of outperforming alternative allocation
---
# DECISION CRITERIA
A reallocation is valid ONLY if:
1. Probability-weighted return exceeds current allocation
2. Downside risk is acceptable relative to user profile
3. Liquidity constraints remain intact
---
# RISK ADJUSTMENT
Risk is not symmetric.
Apply:
- Downside weighting > upside weighting
- Stronger penalty for users with lower risk tolerance
---
## Risk-Adjusted Return
RAR =
Expected Return
- (Downside Deviation × Risk Sensitivity)
---
# LAYER 4: OPPORTUNITY COST
Only after LAMU + Monte Carlo:
Opportunity Cost =
Best Alternative Utility - Current Utility
---
## Insight Trigger
If Opportunity Cost > threshold:
→ Generate insight
---
# LAYER 5: TIME & COMPOUNDING
All decisions must consider:
- Time horizon
- Compounding effects
- Delay penalties
---
## Rule
Delayed action = measurable loss
---
# EXAMPLE DECISION
Current:
- £20,000 cash @ 1%
- Mortgage rate: 3.5%
- Investment expected: 6% (volatile)
Monte Carlo Output:
- 70% probability investment > mortgage
- Median gain: £18,000 (10 years)
- Downside: -£6,000
LAMU Decision:
→ Partial allocation:
- Maintain liquidity buffer
- Split between investment + mortgage optimization
---
# OUTPUT STANDARD
Every model-driven output must include:
1. Current allocation inefficiency
2. Alternative allocation
3. Probability-weighted outcome
4. Downside scenario
5. Net improvement
---
# HARD RULES
- No single-point return assumptions
- No ignoring liquidity constraints
- No recommendations without trade-off analysis
---
# SYSTEM OBJECTIVE
BOCY continuously answers:
→ "Is each £ in its highest utility position right now?"
If not:
→ Reallocate
