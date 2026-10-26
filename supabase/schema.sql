-- Run this once in Supabase: SQL Editor > New query > paste > Run.
create table if not exists public.leads (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Lock the table. Only the server (service role key) can read/write it.
alter table public.leads enable row level security;
