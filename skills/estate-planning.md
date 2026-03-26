# Estate Planning Engine — Institutional Grade (UK)

BOCY analyses estate structures to surface IHT exposure and wealth transfer efficiency insights.

**IMPORTANT: BOCY does not provide financial or legal advice. Estate planning insights are data-driven observations for the user to consider. Users should consult a qualified financial planner or solicitor before acting on estate planning matters.**

---

## CORE OBJECTIVE

Surface insights on IHT exposure while considering:
→ User lifestyle preservation
→ Control over asset distribution
→ Estate liquidity
→ Intergenerational wealth transfer efficiency

---

## UK INHERITANCE TAX FRAMEWORK

The system models:
- Nil Rate Band: £325,000
- Residence Nil Rate Band: £175,000 (conditions apply)
- IHT rate: 40% above thresholds
- Transferable nil rate band (married couples / civil partners)
- Taper relief for estates above £2M (RNRB clawback)

### IHT Calculation

```
Estate_value = Total_assets - Liabilities - Exempt_transfers
Taxable_estate = max(0, Estate_value - NRB - RNRB)
IHT_liability = Taxable_estate × 0.40
```

---

## KEY STRATEGIES THE SYSTEM EVALUATES

### 1. Lifetime Gifting
- Annual exemption: £3,000 per year (carry forward 1 year)
- Small gifts exemption: £250 per recipient
- Wedding/civil partnership gifts (£5,000/£2,500/£1,000)
- Normal expenditure out of income (unlimited, if conditions met)
- Potentially Exempt Transfers (PETs): fully exempt after 7 years

### 7-Year Rule Tracking
The system:
- Tracks all PETs with dates
- Models taper relief (3-7 years: 20%→80% relief)
- Alerts when PETs approach the 7-year mark
- Surfaces optimal gifting schedule insights

### 2. Trust Structures

The system understands:
- **Discretionary trusts**: Control over distribution, 10-year periodic charges
- **Bare trusts**: Simple, beneficiary has immediate entitlement
- **Interest in possession trusts**: Income rights to beneficiary
- **Relevant property regime**: 6% × (trust value - NRB fraction) every 10 years

Relevant use cases:
- Control over distribution timing
- Asset protection from creditors/divorce
- Tax mitigation across generations
- Business succession planning

### 3. Pension as Estate Tool
The system evaluates pensions for:
- IHT efficiency (pensions typically outside estate)
- Tax-free death benefits if death before 75
- Intergenerational transfer vehicle
- Drawdown vs annuity for estate planning purposes

### 4. Business Relief
- Business Property Relief (BPR): 50% or 100% relief
- Agricultural Property Relief (APR)
- AIM-listed shares (qualifying for BPR after 2 years)

---

## ESTATE LIQUIDITY PLANNING

The system evaluates:
- Whether sufficient liquid assets exist to cover IHT liability
- Risk of forced asset sales at undervalue
- Life insurance (written in trust) as IHT cover option
- Liquidity position under different estate scenarios

---

## ASSET STRUCTURING

The system analyses ownership efficiency:
- Individual vs joint (tenants in common vs joint tenants)
- Personal vs corporate holding
- Trust-held assets
- Pension vs non-pension wealth split

---

## LIFETIME GIFTING OPTIMISATION MODEL

```
Objective: max E[Wealth_transferred]
Subject to: Consumption >= Required_minimum
```

Inputs:
- Survival probabilities (ONS life tables)
- Current estate value
- Annual income surplus
- Liquidity constraints
- Risk tolerance

Output:
- Optimal annual gifting range
- PET schedule with 7-year tracking
- Projected IHT reduction
- Residual estate projection

---

## IHT SIMULATION

The system runs scenarios:
1. No action (baseline IHT)
2. Maximum gifting strategy
3. Trust + gifting combination
4. Pension maximisation
5. Combined optimal strategy

For each scenario, output:
- Expected IHT liability
- Estate value passed to beneficiaries
- Probability-weighted outcomes (longevity risk)
- Liquidity position through time

---

## DECISION ENGINE RULES

1. No insight is surfaced without IHT impact analysis
2. Baseline vs optimised estate outcomes are always modelled
3. Only compliant strategies are presented
4. Longevity risk is modelled in all gifting insights
5. Lifestyle is never assumed to be compromised for estate optimisation
6. All PETs and trust charges are tracked continuously
7. All outputs are informational — not directives

---

## OUTPUT FORMAT

Every estate insight includes:
- Observation (what the system detected)
- IHT impact (£)
- Net estate benefit
- Risks (longevity, legislative change)
- Time horizon
- Liquidity impact
- Disclaimer: "This is a data-driven insight, not estate planning advice"

---

## FUTURE EXTENSIONS

- Cross-border estate planning
- Business succession structuring
- Family office integration
- Charitable giving (IHT rate reduction to 36%)
- Deed of variation planning
