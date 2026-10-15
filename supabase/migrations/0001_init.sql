-- ============================================================================
-- Horizon — 0001_init.sql
-- Reduced MVP schema (deadline scope). APPLIED AND VERIFIED 2026-10-15.
-- ============================================================================
--
-- STATUS: applied to the connected project through the Dashboard SQL Editor and
-- then verified by re-reading the LIVE SCHEMA, not by trusting a migration
-- history table (the editor records none): all six tables present with RLS, the
-- vector extension at 0.8.2, and the enums, check constraints, generated fts
-- column and foreign key matching this file.
--
-- The coding agent could not apply it itself: the connected Supabase MCP toolset
-- exposes no write/execute-SQL capability, so this was a human step.
--
-- A FRESH project still has to run this file. See docs/apply-migration.md.
--
-- SCOPE (deliberately reduced for the submission deadline):
--   courses, resources, content blocks, conversations, turns, usage_ledger.
-- DEFERRED (do NOT expect these tables here):
--   profiles, jobs/worker queue, alignment_events, evaluations/evaluation_cases,
--   interview_* tables, storage buckets. These belong to later phases.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE:
--   * It does not create an approximate (ivfflat/hnsw) vector index. The MVP
--     uses exact vector scan over a small eligible corpus; an ANN index is only
--     justified after a filtered-recall test.
--   * It does not fix the embedding dimension. See the note on blocks.embedding.
--
-- IDEMPOTENCY: enums are created inside DO/EXCEPTION blocks and tables/indexes
-- use IF NOT EXISTS, so a human re-running this file in the SQL Editor is safe.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
create schema if not exists extensions;

-- pgvector is AVAILABLE in this project (default_version 0.8.2) but was NOT
-- installed when the Part 00 audit ran. This line enables it.
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Enums (canonical vocabulary from the blueprint)
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.policy as enum ('TIMELINE_BOUND', 'COURSE_WIDE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.review_state as enum
    ('PENDING', 'AUTO_APPROVED', 'HUMAN_APPROVED', 'REJECTED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.lint_status as enum
    ('NA', 'PASSED', 'FLAGGED', 'ACKNOWLEDGED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ingest_status as enum
    ('PENDING', 'PROCESSING', 'INDEXED', 'FAILED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.block_type as enum ('transcript', 'pdf', 'ppt', 'notes', 'code');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.resource_kind as enum ('video', 'transcript', 'pdf', 'ppt', 'notes', 'code');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.scope_mode as enum ('POSITION', 'PROGRESS');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. courses
-- ---------------------------------------------------------------------------
create table if not exists public.courses (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid references auth.users (id) on delete set null,
  title             text not null,
  description       text,
  duration_seconds  numeric not null check (duration_seconds > 0),
  content_version   text not null default 'v1',
  policy_version    text not null default 'v1',
  visibility        text not null default 'private'
                      check (visibility in ('private', 'public')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.courses is
  'One recorded lesson and its supporting materials. duration_seconds validates the learner playhead.';

-- ---------------------------------------------------------------------------
-- 4. resources
-- ---------------------------------------------------------------------------
create table if not exists public.resources (
  id                 uuid primary key default gen_random_uuid(),
  course_id          uuid not null references public.courses (id) on delete cascade,
  kind               public.resource_kind not null,
  title              text,
  storage_key        text,
  source_hash        text not null,
  parser_version     text,
  ingest_status      public.ingest_status not null default 'PENDING',
  extraction_coverage numeric
                       check (extraction_coverage is null
                              or (extraction_coverage >= 0 and extraction_coverage <= 1)),
  default_policy     public.policy not null default 'TIMELINE_BOUND',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (course_id, source_hash)
);

comment on column public.resources.extraction_coverage is
  'Fraction of source text successfully extracted. Visual-only or unparsed content must NOT be counted as indexed.';

-- ---------------------------------------------------------------------------
-- 5. blocks — the retrieval unit and citation anchor
-- ---------------------------------------------------------------------------
create table if not exists public.blocks (
  id                   uuid primary key default gen_random_uuid(),
  course_id            uuid not null references public.courses (id) on delete cascade,
  resource_id          uuid not null references public.resources (id) on delete cascade,
  block_type           public.block_type not null,
  ordinal              integer not null default 0,

  text_original        text not null default '',
  text_normalized      text not null default '',

  -- Source location (exactly one family is meaningful per block_type).
  start_seconds        numeric,
  end_seconds          numeric,
  page_number          integer,
  slide_number         integer,
  line_start           integer,
  line_end             integer,
  frame_seconds        numeric,

  -- Eligibility.
  policy               public.policy not null default 'TIMELINE_BOUND',
  review_state         public.review_state not null default 'PENDING',
  lint_status          public.lint_status not null default 'NA',
  ingest_status        public.ingest_status not null default 'PENDING',
  unlock_seconds       numeric check (unlock_seconds is null or unlock_seconds >= 0),

  -- Alignment provenance.
  alignment_method     text,
  alignment_confidence numeric check (alignment_confidence is null
                                      or (alignment_confidence >= 0
                                          and alignment_confidence <= 1)),
  alignment_margin     numeric,

  -- Version + provenance.
  policy_version       text not null default 'v1',
  content_version      text not null default 'v1',
  source_hash          text not null,

  -- Retrieval features.
  -- NOTE (deliberate uncertainty): the embedding dimension is NOT fixed here
  -- because no embedding model has been chosen or verified yet. A dimension-less
  -- `extensions.vector` column stores any dimension and supports exact scan.
  -- Once a model is frozen, add a follow-up migration that sets a fixed
  -- dimension (e.g. extensions.vector(1536)) and, only after a filtered-recall
  -- test, an approximate index. embedding_model/embedding_dim record the choice.
  embedding            extensions.vector,
  embedding_model      text,
  embedding_dim        integer,

  -- Full-text search. Two-argument to_tsvector is IMMUTABLE, so it is valid in
  -- a generated column. This is built-in PostgreSQL; no extension required.
  fts                  tsvector generated always as
                         (to_tsvector('english', coalesce(text_normalized, ''))) stored,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.blocks is
  'A timestamped, source-addressable content block. Policy and review state are separate concepts; PENDING is a review state, never a policy.';

-- Indexes. The eligibility index is partial on INDEXED rows so both retrieval
-- branches can apply the canonical predicate cheaply.
create index if not exists blocks_fts_idx
  on public.blocks using gin (fts);

create index if not exists blocks_eligibility_idx
  on public.blocks (course_id, policy, review_state, unlock_seconds)
  where ingest_status = 'INDEXED';

create index if not exists blocks_resource_idx
  on public.blocks (resource_id);

create index if not exists blocks_course_idx
  on public.blocks (course_id);

-- ---------------------------------------------------------------------------
-- 6. conversations and turns
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses (id) on delete cascade,
  user_id     uuid references auth.users (id) on delete set null,
  scope_mode  public.scope_mode not null default 'POSITION',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.turns (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.conversations (id) on delete cascade,
  sequence          integer not null check (sequence >= 0),
  question          text not null,

  scope_mode        public.scope_mode not null default 'POSITION',
  boundary_seconds  numeric not null check (boundary_seconds >= 0),
  policy_version    text not null default 'v1',
  content_version   text not null default 'v1',

  -- Evidence actually sent to the model, and the claims that survived checks.
  evidence_ids      jsonb not null default '[]'::jsonb,
  verified_claims   jsonb not null default '[]'::jsonb,

  -- answer_state is the INTERNAL state. The learner-facing API collapses
  -- NOT_AVAILABLE_YET and NOT_IN_MATERIALS into INSUFFICIENT_EVIDENCE.
  answer_state      text not null default 'NOT_IN_MATERIALS'
                      check (answer_state in
                        ('ANSWERED', 'ANSWERED_PARTIAL', 'NOT_AVAILABLE_YET',
                         'NOT_IN_MATERIALS', 'TEMPORARILY_UNAVAILABLE')),
  reason_code       text,

  model_id          text,
  prompt_version    text,
  verifier_version  text,

  latency_ms        integer check (latency_ms is null or latency_ms >= 0),
  prompt_tokens     integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),

  created_at        timestamptz not null default now(),
  unique (conversation_id, sequence)
);

comment on column public.turns.answer_state is
  'Internal outcome. Never serialize NOT_AVAILABLE_YET / NOT_IN_MATERIALS distinctly to learners.';

create index if not exists turns_conversation_idx
  on public.turns (conversation_id, sequence);

-- ---------------------------------------------------------------------------
-- 7. usage_ledger — spend guard evidence
-- ---------------------------------------------------------------------------
create table if not exists public.usage_ledger (
  id                uuid primary key default gen_random_uuid(),
  occurred_at       timestamptz not null default now(),
  provider          text not null,
  model_id          text,
  request_id        text,
  turn_id           uuid references public.turns (id) on delete set null,
  prompt_tokens     integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  estimated_cost_usd numeric check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  price_source_date  date
);

comment on table public.usage_ledger is
  'Dated token/cost records. estimated_cost_usd requires a dated price source; leave NULL when pricing is unknown rather than inventing zero.';

create index if not exists usage_ledger_day_idx
  on public.usage_ledger (occurred_at);

-- ---------------------------------------------------------------------------
-- 8. updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['courses', 'resources', 'blocks', 'conversations']
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Row Level Security — restrictive by default
-- ---------------------------------------------------------------------------
-- RLS is enabled on every table and NO permissive policy is granted in this
-- migration. The effective result for `anon` (and for `authenticated` until
-- policies are added) is DENY: the tables expose no rows to the public API.
--
-- The server uses the service-role key, which bypasses RLS, and is responsible
-- for its own authorization checks. Learner-facing RLS policies arrive in a
-- later migration together with Supabase Auth integration. Do not add a broad
-- "allow select to anon" policy to make a demo work.
alter table public.courses       enable row level security;
alter table public.resources     enable row level security;
alter table public.blocks        enable row level security;
alter table public.conversations enable row level security;
alter table public.turns         enable row level security;
alter table public.usage_ledger  enable row level security;

-- Defense in depth: remove the default public grants Supabase applies.
revoke all on public.courses       from anon;
revoke all on public.resources     from anon;
revoke all on public.blocks        from anon;
revoke all on public.conversations from anon;
revoke all on public.turns         from anon;
revoke all on public.usage_ledger  from anon;

-- ============================================================================
-- End of 0001_init.sql
-- ============================================================================
