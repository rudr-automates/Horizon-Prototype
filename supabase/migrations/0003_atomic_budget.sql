-- 0003_atomic_budget.sql
--
-- STATUS: applied to the connected project on 2026-10-15, and verified by
--   BEHAVIOUR rather than by object existence: `pnpm verify:budget` fired 12
--   simultaneous reservations at horizon_admit_generation_tokens against a budget
--   that only 4 could fit and got exactly 4 grants, then bound 12 simultaneous
--   embedding admissions at exactly the cap of 3, and removed its probe rows.
--   A FRESH project still has to run this file after 0001 and 0002
--   (docs/apply-migration.md).
--
-- WHY THIS MIGRATION EXISTS
--   Before this file, budget admission was three separate round trips from the
--   application: read the day's total, decide in the application, then record
--   usage afterwards. Two concurrent turns could both read the same remaining
--   budget and both be admitted, so the daily ceiling was soft by exactly the
--   number of in-flight calls. The process-local embedding counter had the same
--   shape: N instances got N caps.
--
--   This migration moves both decisions into single SQL statements that take an
--   advisory transaction lock, so admission is serialized in the database rather
--   than assumed to be serial in the application.
--
-- WHAT IT DOES NOT DO
--   - It does not meter embedding COST. The embeddings API still reports no
--     token usage, so only the request COUNT is bounded here. Calling the
--     embedding path "cost-capped" would be false.
--   - It does not invent a cost figure. estimated_cost_usd stays NULL for want
--     of a dated price source.
--
-- SAFE TO RE-RUN. Every statement is idempotent: columns are added with
-- `if not exists`, constraints and columns are guarded by catalog checks, and
-- the functions are `create or replace`.

-- ---------------------------------------------------------------------------
-- 1. Turn `usage_ledger` into the single source of truth for admission.
--
--    One table rather than two: a separate reservation table would mean two
--    answers to "what has been spent today", and the wrong one would eventually
--    be read. Existing rows keep working — they are backfilled as settled rows
--    whose charge is the figure the previous revision already enforced.
-- ---------------------------------------------------------------------------

alter table public.usage_ledger
  add column if not exists kind            text not null default 'generation_tokens',
  add column if not exists state           text not null default 'settled',
  add column if not exists day             date,
  add column if not exists reserved_tokens integer not null default 0,
  add column if not exists charged_tokens  integer,
  add column if not exists reasoning_tokens integer,
  -- `operation` is new as a column: 0001's table had no place for it, so the
  -- application had to drop the value when persisting an entry.
  add column if not exists operation       text,
  add column if not exists outcome         text,
  add column if not exists detail          text,
  add column if not exists settled_at      timestamptz;

-- Backfill. `occurred_at` is already not null, so every row gets a day.
update public.usage_ledger
   set day = (occurred_at at time zone 'utc')::date
 where day is null;

-- The pre-0003 convention folded reasoning tokens into `completion_tokens`, so
-- prompt+completion IS the figure the old cap was checked against. Preserve that
-- exact number as the charge rather than recomputing something "cleaner" that
-- would silently change what yesterday's rows say.
update public.usage_ledger
   set charged_tokens = prompt_tokens + completion_tokens
 where charged_tokens is null;

update public.usage_ledger
   set outcome = coalesce(outcome, 'reported')
 where state = 'settled' and outcome is null;

alter table public.usage_ledger
  alter column day set default ((now() at time zone 'utc')::date);

alter table public.usage_ledger
  alter column day set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'usage_ledger_kind_check') then
    alter table public.usage_ledger
      add constraint usage_ledger_kind_check
      check (kind in ('generation_tokens', 'embedding_request'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'usage_ledger_state_check') then
    alter table public.usage_ledger
      add constraint usage_ledger_state_check
      check (state in ('reserved', 'settled'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'usage_ledger_reserved_nonneg') then
    alter table public.usage_ledger
      add constraint usage_ledger_reserved_nonneg
      check (reserved_tokens >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'usage_ledger_charged_nonneg') then
    alter table public.usage_ledger
      add constraint usage_ledger_charged_nonneg
      check (charged_tokens is null or charged_tokens >= 0);
  end if;
end $$;

-- The admission query filters on exactly these columns, once per provider call.
create index if not exists usage_ledger_day_kind_state_idx
  on public.usage_ledger (day, kind, state);

comment on column public.usage_ledger.state is
  'reserved = capacity held for an in-flight call; settled = reconciled with what the provider reported.';
comment on column public.usage_ledger.charged_tokens is
  'AUTHORITATIVE charge for a settled row. Prompt/completion/reasoning are descriptive detail and must never be summed instead.';
comment on column public.usage_ledger.reserved_tokens is
  'Worst-case capacity held while the call is in flight. Also the charge when a sent call reports no usage, so spend is never erased.';

-- ---------------------------------------------------------------------------
-- 2. Atomic admission for generation/verification calls (token budget).
--
--    `pg_advisory_xact_lock` is held until the surrounding transaction commits.
--    PostgREST runs each RPC in its own transaction and commits before it
--    responds, so a second caller blocks until the first row is visible and
--    cannot read the same remaining budget.
-- ---------------------------------------------------------------------------

create or replace function public.horizon_admit_generation_tokens(
  p_budget_tokens  integer,
  p_reserve_tokens integer,
  p_provider       text,
  p_model_id       text default null,
  p_operation      text default 'generate'
)
returns table (
  admitted        boolean,
  reservation_id  uuid,
  spent_tokens    bigint,
  reserved_tokens bigint,
  detail          text
)
language plpgsql
-- Pinned rather than inherited: a mutable search_path is a hardening warning,
-- and this function decides whether money may be spent.
set search_path = public, pg_temp
as $$
declare
  v_day      date := (now() at time zone 'utc')::date;
  v_spent    bigint := 0;
  v_reserved bigint := 0;
  v_id       uuid;
begin
  if p_budget_tokens is null or p_budget_tokens <= 0 then
    return query select
      false, null::uuid, 0::bigint, 0::bigint,
      'No positive daily token budget is configured, so no provider call is permitted.'::text;
    return;
  end if;

  if p_reserve_tokens is null or p_reserve_tokens < 0 then
    return query select
      false, null::uuid, 0::bigint, 0::bigint,
      'A non-negative token reservation is required before a call can be admitted.'::text;
    return;
  end if;

  -- One lock per (kind, UTC day). Concurrent callers for the same day queue here.
  perform pg_advisory_xact_lock(
    hashtext('horizon.budget'),
    hashtext('generation:' || v_day::text)
  );

  -- THE TABLE MUST BE ALIASED AND EVERY COLUMN QUALIFIED HERE.
  -- `reserved_tokens` is both an OUT column of this function and a column of
  -- usage_ledger, so an unqualified reference is ambiguous: PL/pgSQL's default
  -- `variable_conflict = error` rejects it at RUN TIME. `create function` would
  -- have accepted the body, so this would have failed on the first real call
  -- with none of the objects appearing broken — the worst possible failure mode
  -- for a script a human is asked to run once against a production database.
  -- Qualifying removes the ambiguity under any setting of that pragma.
  select coalesce(sum(l.charged_tokens), 0) into v_spent
    from public.usage_ledger l
   where l.day = v_day
     and l.kind = 'generation_tokens'
     and l.state = 'settled';

  select coalesce(sum(l.reserved_tokens), 0) into v_reserved
    from public.usage_ledger l
   where l.day = v_day
     and l.kind = 'generation_tokens'
     and l.state = 'reserved';

  if v_spent + v_reserved + p_reserve_tokens > p_budget_tokens then
    return query select
      false, null::uuid, v_spent, v_reserved,
      format(
        'This call needs about %s tokens but only %s remain of the %s-token daily budget (%s settled, %s reserved).',
        p_reserve_tokens,
        greatest(p_budget_tokens - v_spent - v_reserved, 0),
        p_budget_tokens,
        v_spent,
        v_reserved
      );
    return;
  end if;

  insert into public.usage_ledger (day, kind, state, reserved_tokens, provider, model_id, operation)
  values (v_day, 'generation_tokens', 'reserved', p_reserve_tokens, coalesce(p_provider, 'unknown'), p_model_id, p_operation)
  returning id into v_id;

  return query select
    true, v_id, v_spent, v_reserved,
    format(
      '%s of %s tokens used today; reserving %s for this call.',
      v_spent + v_reserved, p_budget_tokens, p_reserve_tokens
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Atomic admission for embedding REQUESTS (a count, not tokens).
--
--    The row is inserted already settled: one row equals one request attempt,
--    counted before it is sent, so a failing call is not free and a retry storm
--    cannot multiply requests. This is why the row is not left "reserved": there
--    is no token figure to reconcile later.
-- ---------------------------------------------------------------------------

create or replace function public.horizon_admit_embedding_request(
  p_max_calls integer,
  p_provider  text,
  p_model_id  text default null
)
returns table (
  admitted   boolean,
  used_today integer,
  detail     text
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_day  date := (now() at time zone 'utc')::date;
  v_used integer := 0;
begin
  if p_max_calls is null or p_max_calls <= 0 then
    return query select
      false, 0,
      'No embedding-request cap is configured, so no embedding request is admitted against a durable cap.'::text;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('horizon.budget'),
    hashtext('embedding:' || v_day::text)
  );

  -- Aliased for the same reason as above: the function has OUT columns whose
  -- names could collide with a ledger column, and a collision is a run-time
  -- error rather than a creation-time one.
  select count(*)::integer into v_used
    from public.usage_ledger l
   where l.day = v_day
     and l.kind = 'embedding_request';

  if v_used >= p_max_calls then
    return query select
      false, v_used,
      format('The embedding-request cap of %s for %s has been reached (%s used).', p_max_calls, v_day, v_used);
    return;
  end if;

  insert into public.usage_ledger
    (day, kind, state, reserved_tokens, charged_tokens, provider, model_id, operation, outcome, settled_at)
  values
    (v_day, 'embedding_request', 'settled', 0, 0, coalesce(p_provider, 'unknown'), p_model_id, 'embed', 'request_counted', now());

  return query select
    true, v_used + 1,
    format('%s of %s embedding requests recorded for %s. Cost is NOT bounded by this cap.', v_used + 1, p_max_calls, v_day);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Settle a reservation against what the provider actually reported.
--
--    THE POLICY THAT MATTERS: if the provider reports nothing, the reservation
--    stands as the charge. A timeout or a crash must not erase usage that may
--    well have been billed.
--
--    THE ONE EXCEPTION is `p_not_billable`: the provider explicitly REJECTED the
--    request before processing it (a 429 quota refusal is the live example), so
--    nothing could have been consumed and the hold is released. Charging the
--    full reservation in that case would be wrong in the other direction: a burst
--    of rate-limited attempts would drain the day's budget and convert a
--    provider outage into a self-inflicted BUDGET_EXHAUSTED.
-- ---------------------------------------------------------------------------

-- Superseded signature dropped first: adding a parameter creates an OVERLOAD
-- rather than replacing the function, and an ambiguous pair of overloads would
-- let PostgREST pick either one.
drop function if exists public.horizon_settle_reservation(uuid, integer, integer, integer, boolean, text);

create or replace function public.horizon_settle_reservation(
  p_reservation_id   uuid,
  p_prompt_tokens    integer default null,
  p_completion_tokens integer default null,
  p_reasoning_tokens integer default null,
  p_failed           boolean default false,
  p_detail           text default null,
  p_not_billable     boolean default false
)
returns table (
  charged_tokens  bigint,
  reported_tokens bigint,
  outcome         text,
  detail          text
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_row        public.usage_ledger;
  v_prompt     integer := greatest(coalesce(p_prompt_tokens, 0), 0);
  v_completion integer := greatest(coalesce(p_completion_tokens, 0), 0);
  v_reasoning  integer := greatest(coalesce(p_reasoning_tokens, 0), 0);
  v_reported   bigint;
  v_charged    bigint;
  v_outcome    text;
begin
  select l.* into v_row
    from public.usage_ledger l
   where l.id = p_reservation_id
   for update;

  if not found then
    raise exception 'No usage reservation with id %', p_reservation_id
      using errcode = 'P0002';
  end if;

  -- Idempotent: a duplicate settle must not charge twice.
  if v_row.state <> 'reserved' then
    return query select
      coalesce(v_row.charged_tokens, 0)::bigint,
      (coalesce(v_row.prompt_tokens, 0) + coalesce(v_row.completion_tokens, 0) + coalesce(v_row.reasoning_tokens, 0))::bigint,
      coalesce(v_row.outcome, 'already_settled')::text,
      'This reservation was already settled; the recorded figures are returned unchanged.'::text;
    return;
  end if;

  v_reported := v_prompt::bigint + v_completion::bigint + v_reasoning::bigint;

  if v_reported > 0 then
    v_charged := v_reported;
    v_outcome := 'reported';
  elsif coalesce(p_not_billable, false) then
    v_charged := 0;
    v_outcome := 'failed_not_billable';
  else
    v_charged := greatest(v_row.reserved_tokens, 0);
    v_outcome := case
      when p_failed then 'failed_no_report_charged_reservation'
      else 'no_report_charged_reservation'
    end;
  end if;

  update public.usage_ledger
     set state           = 'settled',
         charged_tokens  = v_charged,
         prompt_tokens   = v_prompt,
         completion_tokens = v_completion,
         reasoning_tokens  = v_reasoning,
         outcome         = v_outcome,
         detail          = p_detail,
         settled_at      = now()
   where id = p_reservation_id;

  return query select
    v_charged,
    v_reported,
    v_outcome,
    case
      when v_reported > 0
        then format('Settled at the %s tokens the provider reported.', v_reported)
      when coalesce(p_not_billable, false)
        then 'The provider rejected the request before processing it, so the reservation was released without charge.'
      else format(
        'The provider reported no usage for a call that was sent, so the %s-token reservation stands rather than collapsing to zero.',
        v_charged
      )
    end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Schema/ledger availability probe for the health endpoint.
--
--    Returns COUNTS and BOOLEANS only. Its purpose is to let /api/v1/health
--    distinguish "the host answered" from "authenticated reads and the budget
--    objects actually work" without handing a public client a schema map.
-- ---------------------------------------------------------------------------

create or replace function public.horizon_schema_status()
returns table (
  tables_present          integer,
  tables_expected         integer,
  core_functions_present  integer,
  core_functions_expected integer,
  atomic_budget_objects   boolean,
  ledger_readable         boolean
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_tables     integer := 0;
  v_functions  integer := 0;
  v_atomic     boolean := false;
  v_readable   boolean := false;
begin
  select count(*)::integer into v_tables
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relname in ('courses', 'resources', 'blocks', 'conversations', 'turns', 'usage_ledger');

  select count(*)::integer into v_functions
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'set_updated_at',
       'horizon_is_eligible',
       'horizon_search_fts',
       'horizon_search_vector',
       'horizon_list_eligible',
       'horizon_has_matching_ineligible'
     );

  -- 0003-specific objects: the reservation columns and the three functions that
  -- make admission atomic. If any is missing, admission cannot be trusted.
  select (
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'usage_ledger' and column_name = 'charged_tokens')
    and exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'usage_ledger' and column_name = 'state')
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'horizon_admit_generation_tokens')
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'horizon_admit_embedding_request')
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'horizon_settle_reservation')
  ) into v_atomic;

  begin
    perform 1 from public.usage_ledger limit 1;
    v_readable := true;
  exception when others then
    v_readable := false;
  end;

  return query select
    v_tables, 6, v_functions, 6, v_atomic, v_readable;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges for the new functions.
--
-- `create function` grants EXECUTE to PUBLIC by default. These functions decide
-- whether money may be spent, so that default is tightened: only the service
-- role (which is what the server authenticates as) may call them. Role-existence
-- is checked because a plain PostgreSQL instance has no `anon`/`authenticated`
-- roles and this migration must not fail on one.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.horizon_admit_generation_tokens(integer, integer, text, text, text)',
    'public.horizon_admit_embedding_request(integer, text, text)',
    'public.horizon_settle_reservation(uuid, integer, integer, integer, boolean, text, boolean)',
    'public.horizon_schema_status()'
  ]
  loop
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = split_part(split_part(fn, '.', 2), '(', 1)) then
      execute format('revoke all on function %s from public', fn);

      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute format('revoke all on function %s from anon', fn);
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('revoke all on function %s from authenticated', fn);
      end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute format('grant execute on function %s to service_role', fn);
      end if;
    end if;
  end loop;
end $$;
