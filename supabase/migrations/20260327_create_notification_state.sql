-- Notification state table: tracks per-user notification deduplication state
-- Used by api/notifications/trigger.ts to avoid sending duplicate alerts.

create table if not exists notification_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_income_fingerprint text,
  last_spending_pct integer default 0,
  isa_deadline_notified_year text,
  sa_deadline_notified_year text,
  updated_at timestamptz default now()
);

-- RLS: only the service role should access this table (server-side only)
alter table notification_state enable row level security;

-- Allow service role full access (used by the Vercel API route)
create policy "Service role full access"
  on notification_state
  for all
  using (true)
  with check (true);
