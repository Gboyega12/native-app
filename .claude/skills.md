## Workflow Orchestration

### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately – don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how


## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections


## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.


## Skills Files (MUST be strictly adhered to)

All skills files in `skills/` define BOCY's institutional-grade financial system behaviour.
Every skill file is mandatory and must be followed without exception:

- `skills/bocy-philosophy.md` — Core philosophy and capital allocation principles
- `skills/financial-models.md` — LAMU model, Monte Carlo, decision layers
- `skills/insight-engine.md` — Insight detection and generation pipeline
- `skills/recommendation-engine.md` — Recommendation generation and prioritisation
- `skills/debt-intelligence.md` — Debt evaluation framework
- `skills/transaction-enrichment.md` — Transaction enrichment pipeline (9 layers, confidence model, validation)
- `skills/chat-engine.md` — Chat engine architecture (4 layers, memory system, proactive engine)
- `skills/app-behaviour.md` — User-facing app behaviour and UX rules
- `skills/tone.md` — Communication style and language rules
- `skills/user-cohorts.md` — Target user segmentation
- `skills/tax-optimisation.md` — Tax planning engine (UK): wrappers, CGT, income structuring, continuous monitoring
- `skills/estate-planning.md` — Estate planning engine (UK): IHT framework, gifting, trusts, pension as estate tool
- `skills/quant-models.md` — Tax-aware quant models: Monte Carlo, asset location, withdrawal optimisation, IHT simulation
