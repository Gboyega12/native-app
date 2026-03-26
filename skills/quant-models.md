# Quant Models — Tax-Aware Lifetime & Intergenerational Optimisation (UK)

All models operate on **post-tax outcomes** over the full lifetime and across generations.

**IMPORTANT: Model outputs are analytical projections, not guarantees or financial advice. Users should consult qualified professionals before making financial decisions based on these projections.**

---

## 1. Monte Carlo Simulation Engine (Tax-Aware Extension)

### Purpose
Model uncertainty across markets, income, inflation, and lifespan with tax drag applied.

### Core
```
S_{t+1} = S_t × exp((mu_after_tax - 0.5×sigma²)×dt + sigma×sqrt(dt)×Z)
```

Where:
- mu_after_tax = mu × (1 - effective_tax_rate)
- sigma = volatility
- Z ~ N(0,1)

### Outputs
- Probability of goal success (post-tax)
- Distribution of terminal wealth (after IHT)
- Downside risk (VaR, CVaR)
- Tax drag quantification per scenario

---

## 2. Tax-Aware Portfolio Optimisation

### Objective
Evaluate after-tax expected return for given risk.

### Standard
```
max w^T × mu - lambda × w^T × Sigma × w
```

### BOCY (tax-adjusted)
```
max w^T × (mu_after_tax) - lambda × w^T × Sigma × w
```

Where:
- mu_after_tax_i = mu_i × (1 - tax_rate_i)
- tax_rate_i depends on wrapper (0 for ISA, marginal for GIA)

### Constraints
- Sum of weights = 1
- Wrapper limits (ISA: £20,000/year, pension: annual/lifetime)
- Risk tolerance bounds
- Liquidity requirements

---

## 3. Asset Location Optimisation

### Objective
Evaluate asset-to-wrapper assignment for tax drag minimisation.

### Problem
```
min Tax(returns | allocation across accounts)
```

### Decision Rules
- Bonds/fixed income → Pension (shelters income from tax)
- High-growth equities → ISA (shelters capital gains)
- High-turnover strategies → Tax-sheltered accounts
- Low-turnover, low-yield → GIA (minimal tax impact)

---

## 4. Dynamic Withdrawal Optimisation

### Framework
Dynamic programming over retirement drawdown.

### State
```
State = (age, wealth, tax_band, account_balances)
```

### Objective
```
max E[utility(consumption)]
```

Subject to:
- UK tax rules (income tax bands, pension withdrawal rules)
- Longevity risk (ONS life tables)
- Minimum consumption constraint

### Output
- Modelled yearly withdrawal by account type
- Tax band utilisation per year
- Probability of fund depletion

---

## 5. Tax-Loss Harvesting Model

### Objective
Identify opportunities to minimise realised gains within GIA.

### Logic
```
Harvest if: unrealised_loss > threshold
AND future_gain_offset_probability > 0.7
```

### Constraints
- Maintain market exposure (replace with correlated asset)
- Avoid wash sale equivalents (30-day rule)
- Track loss carry-forward pool

---

## 6. Capital Gains Timing Model

### Objective
Evaluate optimal timing of disposals to minimise CGT.

### Decision Rule
```
Sell if: Current_Tax_Rate < Expected_Future_Tax_Rate
OR: Annual_CGT_Allowance_Unused AND gains_available
```

### Extensions
- Model £3,000 CGT allowance utilisation annually (use-it-or-lose-it)
- Stagger disposals across tax years
- Bed-and-ISA: sell in GIA, rebuy in ISA (reset cost base)
- Inter-spouse transfers (at no gain/no loss)

---

## 7. Inheritance Tax (IHT) Simulation

### Model
```
Estate_t = Assets_t - Liabilities_t
IHT = max(0, Estate_t - NRB - RNRB) × 0.40
```

### Additions
- Nil rate band: £325,000
- Residence nil rate band: £175,000
- Transferable bands (married/civil partner)
- PET tracking with 7-year taper relief
- Business Property Relief modelling

### Output
- Expected IHT liability under N scenarios
- Projected optimal gifting schedule
- Estate value passed to beneficiaries (probability-weighted)

---

## 8. Lifetime Gifting Optimisation

### Objective
```
max E[Wealth_transferred]
subject to: Consumption >= Required_minimum
```

### Inputs
- Survival probabilities (age-specific)
- Current and projected estate value
- Annual income surplus
- Liquidity constraints

### Output
- Projected optimal annual gift amount
- PET tracking schedule
- Estimated IHT reduction
- Residual estate projection with confidence intervals

---

## 9. Behavioural Risk Model

### Objective
Identify patterns that may lead to suboptimal tax decisions.

### Inputs
- Trading frequency (excess turnover = excess CGT)
- Reaction to drawdowns (panic selling = realised losses at suboptimal time)
- Deviation from tax-efficient plan

### Output
- Tax-behavioural risk score
- Intervention trigger (alert when behaviour is tax-destructive)

---

## 10. Cash Flow Forecasting (After-Tax)

### Model
```
Cash_t = Income_t - Expenses_t - Taxes_t
```

### Outputs
- After-tax investable surplus
- Tax liability forecast by month
- Shortfall risk (probability of negative cash flow)
- Contribution timing analysis (pension vs ISA vs GIA)

---

## 11. Scenario Decision Engine

### Process
1. Generate scenarios (Monte Carlo, tax-aware)
2. Apply UK tax model per scenario
3. Evaluate decisions across scenarios
4. Surface highest expected after-tax utility option

### Output
- Insight with comparison
- Tax impact (£/year)
- Probability-weighted after-tax outcome
- Comparison: current vs alternative

---

## 12. Meta Optimisation Layer

### Core Principle
Continuous analysis across time, tax, and user behaviour.

### Inputs
- Market data (returns, volatility)
- User data (income, assets, spending)
- UK tax rules (rates, bands, allowances)

### Outputs
- Daily/weekly tax-aware insights
- Tax threshold alerts
- Rebalancing triggers (tax-efficient)
- Year-end optimisation opportunities

---

## IMPLEMENTATION PRIORITY

### MVP
- After-tax cash flow model
- Tax-aware Monte Carlo
- Simple UK tax rules (income + CGT + dividend)
- ISA/Pension/GIA allocation

### V2
- Asset location optimisation
- Tax-loss harvesting
- CGT timing model
- Bed-and-ISA automation

### V3
- Dynamic withdrawal optimisation
- IHT simulation + gifting model
- Behavioural risk model
- Cross-wrapper rebalancing

---

## FINAL PRINCIPLE

BOCY models and surfaces:
→ **After-tax wealth** projections
→ **Lifetime** efficiency opportunities
→ **Intergenerational** transfer insights

All outputs are analytical — not prescriptive.
