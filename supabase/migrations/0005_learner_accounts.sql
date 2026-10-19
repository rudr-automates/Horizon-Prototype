-- ============================================================================
-- Horizon — 0005_learner_accounts.sql
-- Owner-scoped profile, progress, bookmark and note storage.
--
-- STATUS: APPLIED AND VERIFIED THROUGH THE AUTHENTICATED SUPABASE MIGRATION TOOL
-- ON 2026-10-19 AFTER EXPLICIT OWNER APPROVAL. Four tables, 15 owner-scoped
-- policies, indexes and timestamp triggers were re-read from the live catalog.
-- Migration history records version 20261019114602 / learner_accounts.
-- ============================================================================

create table public.learner_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.learner_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  furthest_seconds double precision not null default 0 check (furthest_seconds >= 0),
  watched_ranges jsonb not null default '[]'::jsonb
    check (jsonb_typeof(watched_ranges) = 'array' and pg_column_size(watched_ranges) <= 65536),
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id)
);

create table public.learner_bookmarks (
  id text primary key check (char_length(id) between 1 and 80),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  position_seconds double precision not null check (position_seconds >= 0),
  title text not null check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.learner_notes (
  id text primary key check (char_length(id) between 1 and 80),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  position_seconds double precision not null check (position_seconds >= 0),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index learner_bookmarks_owner_course_idx
  on public.learner_bookmarks (user_id, course_id, created_at desc);
create index learner_bookmarks_course_idx on public.learner_bookmarks (course_id);
create index learner_notes_owner_course_idx
  on public.learner_notes (user_id, course_id, updated_at desc);
create index learner_notes_course_idx on public.learner_notes (course_id);
create index learner_progress_course_idx on public.learner_progress (course_id);

alter table public.learner_profiles enable row level security;
alter table public.learner_progress enable row level security;
alter table public.learner_bookmarks enable row level security;
alter table public.learner_notes enable row level security;

create trigger learner_profiles_set_updated_at before update on public.learner_profiles
  for each row execute function public.set_updated_at();
create trigger learner_progress_set_updated_at before update on public.learner_progress
  for each row execute function public.set_updated_at();
create trigger learner_notes_set_updated_at before update on public.learner_notes
  for each row execute function public.set_updated_at();

create policy learner_profiles_select_own on public.learner_profiles
  for select to authenticated using (auth.uid() = user_id);
create policy learner_profiles_insert_own on public.learner_profiles
  for insert to authenticated with check (auth.uid() = user_id);
create policy learner_profiles_update_own on public.learner_profiles
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy learner_progress_select_own on public.learner_progress
  for select to authenticated using (auth.uid() = user_id);
create policy learner_progress_insert_own on public.learner_progress
  for insert to authenticated with check (auth.uid() = user_id);
create policy learner_progress_update_own on public.learner_progress
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy learner_progress_delete_own on public.learner_progress
  for delete to authenticated using (auth.uid() = user_id);

create policy learner_bookmarks_select_own on public.learner_bookmarks
  for select to authenticated using (auth.uid() = user_id);
create policy learner_bookmarks_insert_own on public.learner_bookmarks
  for insert to authenticated with check (auth.uid() = user_id);
create policy learner_bookmarks_update_own on public.learner_bookmarks
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy learner_bookmarks_delete_own on public.learner_bookmarks
  for delete to authenticated using (auth.uid() = user_id);

create policy learner_notes_select_own on public.learner_notes
  for select to authenticated using (auth.uid() = user_id);
create policy learner_notes_insert_own on public.learner_notes
  for insert to authenticated with check (auth.uid() = user_id);
create policy learner_notes_update_own on public.learner_notes
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy learner_notes_delete_own on public.learner_notes
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.learner_profiles, public.learner_progress,
  public.learner_bookmarks, public.learner_notes from public, anon, authenticated;
grant select, insert, update on public.learner_profiles to authenticated;
grant select, insert, update, delete on public.learner_progress,
  public.learner_bookmarks, public.learner_notes to authenticated;

-- ROLLBACK (only if no learner data has been written):
-- drop table public.learner_notes;
-- drop table public.learner_bookmarks;
-- drop table public.learner_progress;
-- drop table public.learner_profiles;
