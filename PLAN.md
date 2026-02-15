# Bocy Native App — Rebuild Plan

## Overview

Rebuild the Bocy personal finance advisor as a clean Expo Router + TypeScript + Supabase app.
Same features as the original, properly structured with no loose ends.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Expo SDK 54 + Expo Router v6 |
| Language | TypeScript (strict) |
| Auth & DB | Supabase (email/password + OAuth) |
| API Routes | Vercel Serverless Functions |
| AI | Claude API (Sonnet for chat, Haiku for enrichment) |
| Banking | TrueLayer Open Banking |
| Styling | React Native StyleSheet (no external UI library) |

---

## Project Structure

```
native-app/
├── app/
│   ├── _layout.tsx              # Root layout: fonts, auth gate, splash
│   ├── index.tsx                # Entry redirect
│   ├── (auth)/
│   │   ├── _layout.tsx          # Auth stack layout
│   │   ├── sign-in.tsx          # Email/password + OAuth login
│   │   └── sign-up.tsx          # Registration + email verification
│   └── (main)/
│       ├── _layout.tsx          # Main stack layout
│       ├── welcome.tsx          # Onboarding: intro + name capture
│       ├── connect.tsx          # Bank connection (TrueLayer / CSV upload)
│       ├── goals.tsx            # 3-step goal questionnaire
│       ├── processing.tsx       # Transaction analysis pipeline
│       ├── results.tsx          # Full analysis results display
│       ├── profile.tsx          # User settings, sign out, delete account
│       ├── history.tsx          # Past analyses timeline
│       └── (tabs)/
│           ├── _layout.tsx      # Bottom tab bar (Home, Plan, Chat)
│           ├── index.tsx        # Home: dashboard with latest analysis
│           ├── plan.tsx         # Money moves ranked by impact
│           └── chat.tsx         # AI advisor chat
├── api/
│   ├── truelayer/
│   │   └── callback.js          # TrueLayer OAuth callback + tx fetch + Supabase persist
│   ├── claude/
│   │   └── enrich.js            # AI enrichment of move descriptions
│   ├── chat/
│   │   └── index.js             # Conversational AI with financial context
│   └── delete-account/
│       └── index.js             # Account + data deletion
├── lib/
│   ├── supabase.ts              # Supabase client (SecureStore on native, localStorage on web)
│   ├── truelayer.ts             # TrueLayer auth URL builder + CSV extractor
│   ├── enrichment-engine.ts     # Core financial analysis engine (rewritten in TS)
│   ├── archetypes.ts            # 10 financial personality archetypes + traits
│   ├── move-engine.ts           # UKPF flowchart positioning + goal alignment
│   ├── merchant-db.ts           # Merchant matching database
│   ├── constants.ts             # UK benchmarks, essential categories
│   └── types.ts                 # Shared TypeScript interfaces
├── components/
│   └── ErrorBoundary.tsx        # React error boundary for crash recovery
├── theme/
│   └── index.ts                 # Colors, fonts, spacing, radius
├── assets/
│   └── fonts/
│       └── SpaceMono-Regular.ttf
├── app.json                     # Expo config
├── package.json
├── tsconfig.json
├── vercel.json                  # Vercel deployment config
├── .env.example                 # Environment variable template
└── .gitignore
```

---

## Supabase Schema (Fresh Project)

### Table: `goals`
```sql
CREATE TABLE goals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  current_situation TEXT NOT NULL,
  one_year_goal TEXT NOT NULL,
  two_year_goal TEXT NOT NULL,
  target_amount NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own goals"
  ON goals FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own goals"
  ON goals FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own goals"
  ON goals FOR UPDATE USING (auth.uid() = user_id);
```

### Table: `analyses`
```sql
CREATE TABLE analyses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  archetype TEXT NOT NULL,
  decision_score INTEGER NOT NULL,
  monthly_income NUMERIC NOT NULL,
  monthly_spending NUMERIC NOT NULL,
  surplus NUMERIC NOT NULL,
  non_discretionary JSONB DEFAULT '{}',
  discretionary JSONB DEFAULT '{}',
  income_sources JSONB DEFAULT '[]',
  top_move JSONB DEFAULT '{}',
  all_moves JSONB DEFAULT '[]',
  behavioral_patterns JSONB DEFAULT '[]',
  goal_context JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own analyses"
  ON analyses FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own analyses"
  ON analyses FOR INSERT WITH CHECK (auth.uid() = user_id);
```

### Table: `bank_data` (NEW — fixes CSV persistence + mobile TrueLayer flow)
```sql
CREATE TABLE bank_data (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id TEXT UNIQUE NOT NULL,
  csv_data TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'truelayer',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bank_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own bank data"
  ON bank_data FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can insert bank data"
  ON bank_data FOR INSERT WITH CHECK (true);

CREATE POLICY "Users can delete own bank data"
  ON bank_data FOR DELETE USING (auth.uid() = user_id);
```

---

## TrueLayer Flow (Fixed for Mobile)

The original used `window.opener.postMessage()` which only works in browser popups.
New flow works on both mobile and web:

```
1. App generates a unique connection_id (UUID)
2. App opens TrueLayer auth URL with state=connection_id
   → Uses WebBrowser.openAuthSessionAsync on mobile
   → Uses window.open on web
3. User authorizes → TrueLayer redirects to /api/truelayer/callback?code=...&state=connection_id
4. Callback server:
   a. Exchanges code for access token
   b. Fetches all accounts + cards + transactions
   c. Converts to CSV
   d. Saves CSV to bank_data table (using service role, keyed by connection_id)
   e. Redirects to bocy://callback?connection_id=xxx&status=success
5. App detects redirect:
   → Mobile: openAuthSessionAsync resolves with the redirect URL
   → Web: message listener or polling
6. App fetches CSV from bank_data table using connection_id
7. App passes CSV to goals screen
```

---

## Screen-by-Screen Specification

### Phase 1: Auth Flow

#### Sign In (`(auth)/sign-in.tsx`)
- Email + password fields
- "Sign in" primary button
- Google OAuth button, Apple OAuth button
- Link to sign-up
- Error display with user-friendly messages
- On success: auth gate redirects to welcome (no name) or tabs (has name)

#### Sign Up (`(auth)/sign-up.tsx`)
- Email + password fields (min 6 chars validation)
- "Sign up" button
- Email verification sent → confirmation screen
- "Resend email" option
- Link back to sign-in

### Phase 2: Onboarding

#### Welcome (`(main)/welcome.tsx`)
- Step 1: Intro screen — Bocy branding, value proposition, 3 key benefits
- Step 2: Name capture — first + last name inputs
- Saves full_name to `supabase.auth.updateUser({ data: { full_name } })`
- Navigate to connect screen

### Phase 3: Data Connection

#### Connect (`(main)/connect.tsx`)
- Two paths:
  1. **TrueLayer**: Generates connection_id → opens auth URL → waits for callback → fetches CSV from bank_data
  2. **CSV Upload**: File picker → validate CSV format → pass forward
- Trust indicators (FCA regulated, read-only access, data on device)
- Loading state while waiting for TrueLayer callback
- Error handling for both paths (invalid CSV, auth failure, network errors)

### Phase 4: Analysis Pipeline

#### Goals (`(main)/goals.tsx`)
- 3-step questionnaire with progress indicator
- Step 1: Current situation (5 options + "other" text input)
  - In debt, Breaking even, Saving slowly, Saving well, Other
- Step 2: One-year goal (6 options + custom)
  - Clear debt, Emergency fund, Savings target, Reduce spending, Invest, Other
- Step 3: Two-year goal (6 options + custom + target amount)
  - Buy home, Go freelance, Financial freedom, Clear all debt, Grow investments, Other
- **Upsert** (not insert) to Supabase goals table — uses onConflict: 'user_id'
- Navigate to processing with csvData

#### Processing (`(main)/processing.tsx`)
- 5-step animated progress with sequential fade-in:
  1. Reading your transactions
  2. Recognising merchants
  3. Spotting patterns in your spending
  4. Aligning with your goals
  5. Building your recommendations
- Wrapped in ErrorBoundary for crash recovery
- Runs enrichment engine on CSV data (client-side)
- Fetches goals from Supabase, runs move engine
- Optional Claude enrichment of move descriptions (graceful fallback if API fails)
- Saves complete analysis to analyses table
- Navigate to results

#### Results (`(main)/results.tsx`)
- Financial overview: income, spending, surplus (color-coded)
- Budget breakdown: discretionary vs non-discretionary
- Top move highlighted with strategy + steps
- Goal trajectory with timeline (months to reach goal)
- Additional moves list
- Archetype card with emoji + description
- Decision score (0-100) with verdict (Strong/Balanced/Needs Attention/At Risk)
- "Go to dashboard" + "Run new analysis" buttons

### Phase 5: Main App (Tabs)

#### Home (`(main)/(tabs)/index.tsx`)
- Fetch latest analysis + goals on mount
- Loading skeleton while fetching
- Dashboard cards: monthly income, spending, surplus
- Archetype display with emoji
- Top money move summary
- Quick links: run new analysis, update goals
- Empty state if no analysis exists yet

#### Plan (`(main)/(tabs)/plan.tsx`)
- All moves from latest analysis, ranked by annual impact
- Expandable cards: action title, monthly/annual savings, effort badge
- Expanded view: strategy, numbered implementation steps, expected effect
- Monthly surplus display (color-coded)
- Goal context if available
- Debt help resources section:
  - StepChange (https://www.stepchange.org)
  - Citizens Advice (https://www.citizensadvice.org.uk/debt-and-money)
- Empty state if no analysis exists

#### Chat (`(main)/(tabs)/chat.tsx`)
- Message bubbles (user right-aligned accent, assistant left-aligned surface)
- Loads latest analysis + goals context on mount
- Sends context + message history to /api/chat
- 4 suggested starter questions when chat is empty:
  - "How can I save more?"
  - "Am I spending too much on food?"
  - "What should I prioritise first?"
  - "How do I build an emergency fund?"
- Typing indicator ("Thinking...")
- Keyboard-avoiding layout (iOS)
- Error handling for API failures

### Phase 6: Supporting Screens

#### Profile (`(main)/profile.tsx`)
- Avatar circle with user initials
- Name + email display
- Menu items:
  - Add Account → navigate to connect
  - Goals → navigate to goals
  - Report a Bug → email to support@bocy.app
  - Notifications → "Coming soon"
  - Agreements → "Coming soon"
- Security section (collapsible):
  - Sign out → clear session → redirect to sign-in
  - Delete account → confirmation dialog → POST /api/delete-account → sign out

#### History (`(main)/history.tsx`)
- FlatList of all analyses, newest first
- Each card: formatted date, income, spending, surplus, decision score
- Color-coded amounts (mint for income, coral for spending)
- Empty state message

---

## API Contracts

### POST `/api/chat`
```
Request:  { messages: [{ role, content }], context: { monthly_income, monthly_spending, surplus, archetype, goals, top_move } }
Response: { success: boolean, text: string }
Model: claude-sonnet-4-5-20250929
System: Bocy UK personal finance advisor persona
```

### POST `/api/claude/enrich`
```
Request:  { prompt: string, max_tokens?: number }
Response: { success: boolean, text: string }
Model: claude-haiku-4-5-20251001
```

### GET `/api/truelayer/callback?code=...&state=connection_id`
```
Flow:
1. Exchange code for token
2. Fetch accounts + cards + transactions (12 months)
3. Convert to CSV
4. Save to bank_data table (keyed by connection_id from state param)
5. Redirect to bocy://callback?connection_id=xxx&status=success
```

### POST `/api/delete-account`
```
Headers:  Authorization: Bearer <supabase_jwt>
Flow:
1. Verify JWT with anon client
2. Delete from analyses, goals, bank_data (admin client)
3. Delete auth user (admin client)
Response: { success: boolean }
```

---

## Environment Variables

### App (.env — git-ignored)
```
EXPO_PUBLIC_SUPABASE_URL=https://imofcovytgqykwbgiujq.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imltb2Zjb3Z5dGdxeWt3YmdpdWpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExODE3MzAsImV4cCI6MjA4Njc1NzczMH0.RFsiyptebEYzzGHRYPfqUHRyu94Gik_-vFP57VlccaE
EXPO_PUBLIC_TRUELAYER_REDIRECT_URI=https://native-app.vercel.app/api/truelayer/callback
```

### Vercel Dashboard (serverless functions)
```
TRUELAYER_CLIENT_ID=bocymoneypersonality-a01ae4
TRUELAYER_CLIENT_SECRET=<from TrueLayer console>
CLAUDE_API_KEY=<from Anthropic console>
SUPABASE_URL=https://imofcovytgqykwbgiujq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<from Supabase dashboard>
EXPO_PUBLIC_SUPABASE_ANON_KEY=<same as app .env>
```

---

## Implementation Order

1. **Scaffold** — Expo project, dependencies, config files, theme, types
2. **Supabase** — Client setup, migration SQL file
3. **Lib** — merchant-db, constants, archetypes, enrichment-engine, move-engine (all TS)
4. **Components** — ErrorBoundary
5. **Auth screens** — root layout with auth gate, sign-in, sign-up
6. **Onboarding** — welcome, connect (TrueLayer + CSV)
7. **Analysis flow** — goals, processing, results
8. **Tabs** — home dashboard, plan, chat
9. **Supporting** — profile, history
10. **API routes** — chat, enrich, callback (with bank_data persist), delete-account
11. **Config** — vercel.json, .env.example, .gitignore

---

## Key Improvements Over Original

1. **TypeScript throughout** — all lib files converted from JS to TS with proper interfaces
2. **Shared types** — single types.ts for all data shapes (Transaction, Analysis, Goal, Move, etc.)
3. **TrueLayer flow fixed** — CSV persisted to Supabase, deep link redirect instead of postMessage
4. **CSV persistence** — bank_data table prevents data loss if app crashes mid-flow
5. **Goals upsert** — uses onConflict instead of insert to prevent unique constraint violations
6. **Error boundaries** — processing/results screens wrapped to prevent white-screen crashes
7. **Graceful Claude fallback** — if enrichment API fails, moves still display without AI rewriting
8. **RLS on all tables** — row-level security with ON DELETE CASCADE for clean user deletion
9. **Proper loading states** — skeleton/spinner on every async operation
10. **No dead code** — every file serves a purpose
11. **Consistent styling** — all screens use theme constants, no magic numbers

---

## Setup Checklist (User Actions Required)

### Supabase Dashboard
- [ ] Run the SQL migration (all 3 tables + RLS policies)
- [ ] Auth > URL Configuration: Add `bocy://` as redirect URL
- [ ] Auth > Providers: Enable Google and/or Apple (optional)

### TrueLayer Console
- [ ] Register redirect URI: `https://native-app.vercel.app/api/truelayer/callback`

### Vercel Dashboard
- [ ] Set all 5 environment variables listed above
- [ ] Connect the native-app GitHub repo for auto-deploy
