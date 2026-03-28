# BOCY — Project Instructions for Claude

## Architecture

BOCY is a React Native (Expo) fintech app with a multi-agent AI backend.

### Agent System
- **Financial agents** (`agents/*.md`): data_integrity → financial_analyst → allocation → risk_investment → tax_estate → wealth_manager → growth
- **Design agents** (`agents/frontend-designer-agent.md`, `agents/product-designer-agent.md`): product_designer → frontend_designer
- **Registry**: `lib/agent-registry.ts` — all agents, tools, skills, dependencies, and validation
- **Skills**: `skills/*.md` — domain knowledge loaded per agent (including `frontend-design.md` and `product-design.md`)
- **Tools**: `skills/decision-engine-tools.json` — tool schemas for the financial decision engine

### Design System
- **Theme**: `theme/index.ts` — colors (dark/light), spacing (4/8/16/24/32/48), radius (8/14/20/28), fonts (Poppins + SpaceMono)
- **Aesthetic**: Nothing Phone — dot-matrix, letterpress typography, monochrome base, strategic accent pops
- **Animations**: Breathing, typewriter, stagger, haptic feedback
- **Quality bar**: Would a top-tier fintech (Wise, Revolut, N26) ship this?

### Key Conventions
- Use theme tokens exclusively — never hardcode colors, spacing, or radius
- All components must handle: empty, loading, error, success states
- Progressive disclosure by default — collapse secondary information
- Mobile-first, responsive up to 560px max-width
- British English, £ currency

### Design Agents Workflow
When making UI/UX changes:
1. **Product Designer** first — define WHAT and WHY (flow, IA, behavior)
2. **Frontend Designer** second — execute HOW (components, styling, animation)
3. Run the Design Quality Checklist before shipping

### Design Quality Checklist
- [ ] Is it simple?
- [ ] Is it clear?
- [ ] Is it fast?
- [ ] Is it visually consistent with the theme system?
- [ ] Does it solve a real problem?
- [ ] Would a top-tier fintech ship this?
