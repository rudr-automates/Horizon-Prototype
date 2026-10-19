-- ============================================================================
-- Horizon — 0004_request_rate_limit.sql
-- Per-client admission control for the public question endpoint.
--
-- STATUS: APPLIED AND VERIFIED THROUGH THE DASHBOARD SQL EDITOR ON 2026-10-19.
-- The migration-history API is empty for this project; verification is based on
-- read-only inspection of the live counter table and admission functions.
--
-- WHY THIS EXISTS
--   `POST /api/v1/courses/:courseId/questions` is public and spends provider
--   quota. The daily token budget bounds the total, but one client could consume
--   the whole day's allowance. A per-client limit needs to be shared across
--   serverless instances, so it has to be enforced by the database, not by
--   process memory.
--
-- WHY A SINGLE STATEMENT
--   The limit is claimed by one INSERT ... ON CONFLICT DO UPDATE whose increment
--   is conditional on the stored count being below the limit. Concurrent callers
--   serialize on the row, so two requests cannot both take the last slot. There
--   is no read-then-write window to lose.
--
-- WHAT IS STORED
--   A 64-hex bucket key (HMAC of a client address and a salt, scoped to one UTC
--   day) and a count. No IP address, no user identifier, no request content.
--   The key rotates daily and rows are small. Expired windows are removed by
--   `pnpm prune:rate-limits --apply`, an operator-run command; nothing prunes
--   automatically, and the cutoff is computed so an active window can never be
--   selected.
--
-- ADDITIVE ONLY
--   Creates one table and one function. Touches no existing table, row, policy
--   or grant.
--
-- ROLLBACK
--   drop function if exists public.horizon_admit_request(text, integer, integer, timestamptz);
--   drop table if exists public.request_rate_limits;
--   Dropping them makes the durable limiter fail closed (503), which is the
--   intended direction: no limit is never the failure mode.
-- ============================================================================

create table if not exists public.request_rate_limits (
  bucket_key      text        not null,
  -- Part of the key on purpose: a 10-minute window that begins at midnight has
  -- the same start instant as the UTC-day window, and they carry different limits.
  window_seconds  integer     not null check (window_seconds > 0),
  window_start    timestamptz not null,
  request_count   integer     not null default 0 check (request_count >= 0),
  primary key (bucket_key, window_seconds, window_start)
);

comment on table public.request_rate_limits is
  'Fixed-window request counters keyed by a daily HMAC bucket. No IP address or user identifier is stored.';

create index if not exists request_rate_limits_window_idx
  on public.request_rate_limits (window_start);

-- Deny by default, like every other table in this schema. Only the server's
-- service role may read or write it, and only through the function below.
alter table public.request_rate_limits enable row level security;
revoke all on public.request_rate_limits from anon;
revoke all on public.request_rate_limits from authenticated;

-- ---------------------------------------------------------------------------
-- Atomic admission
--
-- Returns exactly one row. `admitted = false` is a decision, not an error, and
-- the caller must treat any failure to obtain a row as a refusal (fail closed).
-- ---------------------------------------------------------------------------
create or replace function public.horizon_admit_request(
  p_bucket_key      text,
  p_window_seconds  integer,
  p_limit           integer,
  p_now             timestamptz default now()
)
returns table (
  admitted            boolean,
  used                integer,
  remaining           integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  -- The key is a hash the server computed. Reject anything that is not shaped
  -- like one, so this function cannot be used as a general key/value counter.
  if p_bucket_key is null or length(p_bucket_key) < 16 or length(p_bucket_key) > 128 then
    raise exception 'invalid bucket key' using errcode = '22023';
  end if;

  if p_window_seconds is null or p_window_seconds <= 0 or p_limit is null or p_limit <= 0 then
    -- A non-positive limit means "admit nothing". It must never mean "no limit".
    return query select false, 0, 0, greatest(coalesce(p_window_seconds, 60), 1);
    return;
  end if;

  v_window := to_timestamp(
    floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds
  );

  insert into public.request_rate_limits as r
    (bucket_key, window_seconds, window_start, request_count)
  values
    (p_bucket_key, p_window_seconds, v_window, 1)
  on conflict (bucket_key, window_seconds, window_start) do update
    set request_count = r.request_count + 1
    where r.request_count < p_limit
  returning r.request_count into v_count;

  if v_count is null then
    -- The conditional update was skipped, so this window is full. The count is
    -- re-read only to report it; the decision (false) is already final.
    select r.request_count into v_count
    from public.request_rate_limits r
    where r.bucket_key = p_bucket_key
      and r.window_seconds = p_window_seconds
      and r.window_start = v_window;

    return query
      select false,
             coalesce(v_count, p_limit),
             0,
             greatest(
               1,
               ceil(
                 extract(epoch from (
                   v_window + make_interval(secs => p_window_seconds) - p_now
                 ))
               )::integer
             );
    return;
  end if;

  return query select true, v_count, greatest(0, p_limit - v_count), 0;
end;
$$;

comment on function public.horizon_admit_request(text, integer, integer, timestamptz) is
  'Atomically claims one slot in a fixed window. Returns admitted=false when the window is full or the limit is non-positive; never grants on error.';

revoke all on function public.horizon_admit_request(text, integer, integer, timestamptz)
  from public;
revoke all on function public.horizon_admit_request(text, integer, integer, timestamptz)
  from anon;
revoke all on function public.horizon_admit_request(text, integer, integer, timestamptz)
  from authenticated;
grant execute on function public.horizon_admit_request(text, integer, integer, timestamptz)
  to service_role;

-- ============================================================================
-- End of 0004_request_rate_limit.sql
-- ============================================================================
