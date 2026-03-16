# Bocy

Personal finance advisor app that analyses bank transactions to provide personalised financial recommendations, budgeting insights, and AI-powered chat assistance. Built for UK users.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Expo SDK 54 + Expo Router v6 |
| Language | TypeScript (strict) |
| Auth & DB | Supabase (email/password + OAuth) |
| API Routes | Vercel Serverless Functions |
| AI | Claude API (Sonnet for chat, Haiku for enrichment) |
| Banking | TrueLayer Open Banking + CSV upload |
| Payments | Stripe (web) |

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm start

# Run web version
npm run web

# Run tests
npm test

# Lint & format
npm run lint
npm run format
```

## Project Structure

```
app/                  # Expo Router screens (file-based routing)
  (auth)/             # Sign-in, sign-up, splash
  (main)/             # Authenticated app
    (tabs)/            # Bottom tab navigation (Home, Chat)
api/                  # Vercel serverless functions
  chat/               # Claude-powered AI chat
  claude/             # Transaction enrichment via Claude
  truelayer/          # Open Banking OAuth + sync
  cron/               # Background jobs (digests, sync, alerts)
  stripe/             # Web subscription payments
lib/                  # Core business logic
  enrichment-engine   # Transaction analysis pipeline (2500+ lines)
  merchant-db         # UK merchant pattern matching
  classifier          # Transaction categorisation
  move-engine         # Financial recommendation ranking (UKPF flowchart)
  budget-solver       # CRRA utility-based budget optimisation
  monte-carlo         # Monte Carlo simulation for goal confidence
  archetypes          # Financial personality detection
components/           # Reusable UI components
theme/                # Colours, typography, spacing
```

## Environment Variables

Copy `.env.example` and fill in credentials:

```bash
cp .env.example .env
```

Required: Supabase, TrueLayer, Claude API key. See `.env.example` for full list.

## Architecture

See [PLAN.md](./PLAN.md) for detailed architecture, screen specs, API contracts, and database schema.

## Key Features

- **Transaction enrichment** — Auto-categorises spending via merchant DB, keyword rules, and Claude AI fallback
- **Financial archetypes** — Identifies spending personality (10 archetypes) with strengths and blind spots
- **Money moves** — Ranked financial recommendations using UKPF flowchart + Monte Carlo simulation
- **Budget solver** — CRRA utility-based budget optimisation with identity-aware priority weighting
- **AI chat** — Claude-powered financial advisor with voice (ElevenLabs) and GIF (GIPHY) support
- **Open Banking** — TrueLayer integration for automatic bank data sync
