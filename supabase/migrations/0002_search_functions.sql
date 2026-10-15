-- ============================================================================
-- Horizon — 0002_search_functions.sql
-- Canonical-predicate retrieval functions. APPLIED AND VERIFIED 2026-10-15.
-- ============================================================================
--
-- STATUS: applied to the connected project, and verified by re-reading the live
-- schema: `horizon_is_eligible`, `horizon_search_fts`, `horizon_search_vector`,
-- `horizon_list_eligible` and `horizon_has_matching_ineligible` are all present,
-- and the retrieval branches that call them were then exercised against real rows
-- (`pnpm verify:data-path`). A FRESH project still has to run this file after
-- 0001. See docs/apply-migration.md.
--
-- WHY THIS FILE EXISTS
--   The canonical eligibility predicate must be applied identically by every
--   retrieval branch. Expressing it once in SQL (horizon_is_eligible) and
--   calling it from each branch guarantees that. Re-implementing the predicate
--   in PostgREST filter strings would create a second, divergent copy.
--
-- Apply this AFTER 0001_init.sql, through the Supabase Dashboard SQL Editor.
-- See docs/apply-migration.md.
--
-- RETRIEVAL ORDERING
--   Every candidate list orders by its own score/distance with a deterministic
--   tie-breaker (b.id) BEFORE the limit. The vector branch uses an exact scan
--   over eligible rows; no approximate index is created, deliberately.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The single SQL predicate
-- ---------------------------------------------------------------------------
-- Mirrors isBlockEligible() in src/lib/eligibility/predicate.ts exactly.
create or replace function public.horizon_is_eligible(
  p_course_id       uuid,
  p_block_course_id uuid,
  p_ingest_status   public.ingest_status,
  p_policy          public.policy,
  p_review_state    public.review_state,
  p_lint_status     public.lint_status,
  p_unlock_seconds  numeric,
  p_boundary        numeric
)
returns boolean
language sql
immutable
as $$
  select
    p_block_course_id = p_course_id
    and p_ingest_status = 'INDEXED'
    and (
      (p_policy = 'TIMELINE_BOUND'
        and p_review_state in ('AUTO_APPROVED', 'HUMAN_APPROVED')
        and p_unlock_seconds is not null
        and p_unlock_seconds <= p_boundary)
      or
      (p_policy = 'COURSE_WIDE'
        and p_review_state = 'HUMAN_APPROVED'
        and p_lint_status in ('PASSED', 'ACKNOWLEDGED'))
    );
$$;

comment on function public.horizon_is_eligible is
  'The one canonical eligibility predicate. Every retrieval branch must call this, not a copy of its logic.';

-- ---------------------------------------------------------------------------
-- 2. Full-text branch
-- ---------------------------------------------------------------------------
create or replace function public.horizon_search_fts(
  p_course_id uuid,
  p_boundary  numeric,
  p_query     text,
  p_limit     integer default 20
)
returns table (block_id uuid, score real)
language sql
stable
as $$
  with q as (select websearch_to_tsquery('english', p_query) as tsq)
  select b.id as block_id,
         ts_rank(b.fts, q.tsq)::real as score
  from public.blocks b, q
  where public.horizon_is_eligible(
          p_course_id, b.course_id, b.ingest_status, b.policy,
          b.review_state, b.lint_status, b.unlock_seconds, p_boundary)
    and b.fts @@ q.tsq
  order by ts_rank(b.fts, q.tsq) desc, b.id asc
  limit greatest(coalesce(p_limit, 20), 1);
$$;

-- ---------------------------------------------------------------------------
-- 3. Vector branch (exact scan over eligible rows)
-- ---------------------------------------------------------------------------
-- p_embedding is passed as text (a JSON array literal such as "[0.1,0.2]")
-- because PostgREST cannot serialize the pgvector type directly.
create or replace function public.horizon_search_vector(
  p_course_id uuid,
  p_boundary  numeric,
  p_embedding text,
  p_limit     integer default 20
)
returns table (block_id uuid, distance real)
language sql
stable
as $$
  select b.id as block_id,
         (b.embedding <=> p_embedding::extensions.vector)::real as distance
  from public.blocks b
  where public.horizon_is_eligible(
          p_course_id, b.course_id, b.ingest_status, b.policy,
          b.review_state, b.lint_status, b.unlock_seconds, p_boundary)
    and b.embedding is not null
  order by (b.embedding <=> p_embedding::extensions.vector) asc, b.id asc
  limit greatest(coalesce(p_limit, 20), 1);
$$;

-- ---------------------------------------------------------------------------
-- 4. Eligible listing (scope chip, summary, quiz)
-- ---------------------------------------------------------------------------
create or replace function public.horizon_list_eligible(
  p_course_id uuid,
  p_boundary  numeric,
  p_limit     integer default 1000
)
returns setof public.blocks
language sql
stable
as $$
  select b.*
  from public.blocks b
  where public.horizon_is_eligible(
          p_course_id, b.course_id, b.ingest_status, b.policy,
          b.review_state, b.lint_status, b.unlock_seconds, p_boundary)
  order by coalesce(b.unlock_seconds, -1) asc, b.id asc
  limit greatest(coalesce(p_limit, 1000), 1);
$$;

-- ---------------------------------------------------------------------------
-- 5. Coarse backend-only diagnostic
-- ---------------------------------------------------------------------------
-- Returns a SINGLE BOOLEAN. It never discloses titles, timestamps, ids or
-- counts of withheld material, so it cannot become a syllabus oracle. Its only
-- use is letting server-side state logic pick between two internal outcomes
-- that map to the SAME learner-facing refusal.
create or replace function public.horizon_has_matching_ineligible(
  p_course_id uuid,
  p_boundary  numeric,
  p_query     text
)
returns boolean
language sql
stable
as $$
  with q as (select websearch_to_tsquery('english', p_query) as tsq)
  select exists (
    select 1
    from public.blocks b, q
    where b.course_id = p_course_id
      and b.ingest_status = 'INDEXED'
      and b.fts @@ q.tsq
      and not public.horizon_is_eligible(
            p_course_id, b.course_id, b.ingest_status, b.policy,
            b.review_state, b.lint_status, b.unlock_seconds, p_boundary)
  );
$$;

-- ---------------------------------------------------------------------------
-- 6. Permissions
-- ---------------------------------------------------------------------------
-- These functions live in the exposed `public` schema, so the default PUBLIC
-- execute grant must be removed. Only the server (service_role) may call them.
revoke all on function public.horizon_is_eligible(
  uuid, uuid, public.ingest_status, public.policy,
  public.review_state, public.lint_status, numeric, numeric) from public;
revoke all on function public.horizon_search_fts(uuid, numeric, text, integer) from public;
revoke all on function public.horizon_search_vector(uuid, numeric, text, integer) from public;
revoke all on function public.horizon_list_eligible(uuid, numeric, integer) from public;
revoke all on function public.horizon_has_matching_ineligible(uuid, numeric, text) from public;

grant execute on function public.horizon_is_eligible(
  uuid, uuid, public.ingest_status, public.policy,
  public.review_state, public.lint_status, numeric, numeric) to service_role;
grant execute on function public.horizon_search_fts(uuid, numeric, text, integer) to service_role;
grant execute on function public.horizon_search_vector(uuid, numeric, text, integer) to service_role;
grant execute on function public.horizon_list_eligible(uuid, numeric, integer) to service_role;
grant execute on function public.horizon_has_matching_ineligible(uuid, numeric, text) to service_role;

-- ============================================================================
-- End of 0002_search_functions.sql
-- ============================================================================
