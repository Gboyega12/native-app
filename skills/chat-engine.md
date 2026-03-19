# Chat Engine — Institutional Grade
## Definition
Chat is NOT a conversational feature.
It is:
→ A **natural language interface to a financial decision system**
BOCY chat does NOT:
- "talk about money"
- "give advice"
BOCY chat:
→ Executes financial reasoning, retrieves system state, and returns decisions
---
# CORE OBJECTIVE
Enable the user to:
→ Query, understand, and act on their financial system
→ Without navigating UI complexity
---
# ARCHITECTURE OVERVIEW
BOCY chat is composed of 4 layers:
1. Interpretation Layer (LLM)
2. Orchestration Layer (Agent)
3. Tooling Layer (Deterministic systems)
4. Response Layer (Decision output)
---
# LAYER 1: INTERPRETATION (INTENT + CONTEXT)
## Function
Convert user input into:
- Financial intent
- Required data
- Required computation
---
## Requirements
Must identify:
- Explicit intent ("How much can I invest?")
- Implicit intent ("Am I doing this right?" → optimization request)
---
## Context Injection
Always include:
- Enriched transaction data
- Current balance sheet
- Active insights
- User constraints (liquidity, risk)
---
## RULE
Chat must NEVER respond without full system context
---
# LAYER 2: ORCHESTRATION (AGENT ENGINE)
## Function
Determine:
→ What needs to be done to answer the query
---
## Capabilities
- Select tools
- Sequence steps
- Loop until resolution
---
## Example
User:
"How much can I safely invest?"
Agent:
1. Retrieve liquidity threshold
2. Calculate excess cash
3. Apply LAMU model
4. Generate recommendation
---
## RULE
Chat must NOT hallucinate answers
→ All answers must be tool-derived
---
# LAYER 3: TOOLING (DETERMINISTIC CORE)
## Tool Types
### 1. Retrieval Tools
- Fetch balances
- Fetch transactions
- Fetch insights
---
### 2. Calculation Tools
- LAMU engine
- Monte Carlo simulation
- Tax calculations
---
### 3. Action Tools
- Trigger reallocation flows
- Set reminders
- Initiate execution steps
---
## RULE
LLM NEVER performs:
- Financial calculations
- Aggregations
- Simulations
→ These must be deterministic
---
# LAYER 4: RESPONSE (DECISION OUTPUT)
## Structure
Every response must:
1. Answer the question directly
2. Provide financial implication (£ impact)
3. Provide action (if relevant)
4. Provide trade-offs (if uncertainty exists)
---
## Example
User:
"Should I overpay my mortgage?"
Response:
"This is suboptimal.
You are over-allocating capital to a 3.2% liability.
Monte Carlo analysis shows:
- 68% probability investing outperforms
- Median gain: £28,000 (10 years)
- Downside: -£9,000
Recommended allocation:
- Reduce overpayment to £400/month
- Redirect £600/month to ISA"
---
# MEMORY SYSTEM (CRITICAL)
## Definition
Memory is NOT chat history.
It is:
→ Structured financial knowledge about the user
---
## Storage Model
Use:
- Knowledge graph (entities + relationships)
- Key state summaries
---
## Store:
- Income patterns
- Spending structure
- Risk tolerance
- Financial goals
- Behaviour patterns
---
## Retrieval
Memory must be:
- Selective (only relevant context)
- Compressed (no full transcripts)
---
# PROACTIVE ENGINE (DIFFERENTIATOR)
Chat must NOT be reactive only.
It must:
→ Inject insights into conversation when relevant
---
## Example
User:
"Can I afford a holiday?"
System should ALSO surface:
"You have £18,000 idle cash reducing net outcome by ~£1,200/year"
---
# CONVERSATION TYPES
## 1. Query Mode
User asks → system answers
---
## 2. Diagnostic Mode
User unsure → system identifies inefficiencies
---
## 3. Decision Mode
User comparing options → system runs trade-offs
---
## 4. Execution Mode
User agrees → system initiates action
---
# RESPONSE STANDARD
## MUST:
- Be decisive
- Be quantified
- Be system-aware
---
## MUST NOT:
- Be generic
- Be conversational fluff
- Ask unnecessary follow-ups
---
# MULTI-STEP REASONING
Chat must handle:
- Sequential reasoning
- Conditional logic
- Iterative refinement
---
## Example
User:
"How do I optimize everything?"
System:
1. Identify top 3 inefficiencies
2. Rank by impact
3. Present ordered actions
---
# ERROR HANDLING
If data is uncertain:
- State uncertainty explicitly
- Provide bounded estimate
- Request minimal clarification
---
# LATENCY PRINCIPLE
Responses must feel:
→ Immediate but correct
Trade-off:
- Prefer slightly slower, correct answers
over fast, approximate ones
---
# PERSONALITY CONSTRAINT
BOCY is NOT:
- A friend
- A coach
- A personality-driven agent
BOCY is:
→ A financial system with clarity and authority
---
# HARD RULES
- No hallucinated financial outputs
- No answering without tool validation
- No detachment from system state
- No breaking institutional tone
---
# SYSTEM OBJECTIVE
User must feel:
→ "I can ask anything and get a precise financial answer"
→ "This understands my entire financial system"
→ "This is better than thinking through it myself"
---
# FINAL DIFFERENTIATION
Cleo:
→ Conversational financial assistant
BOCY:
→ Financial decision system with a conversational interface
Chat is not the product.
Chat is:
→ The command line for your financial system