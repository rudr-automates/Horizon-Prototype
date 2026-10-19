# Applying the Supabase migrations

**Current status update (2026-10-19):** migration `0004_request_rate_limit.sql`
was applied and verified in the Horizon project. Migration
`0005_learner_accounts.sql` was applied after explicit approval through the
authenticated Supabase migration tool and re-read from the live schema; the
history API records `20261019114602 / learner_accounts`. Do not reapply either
migration. The 0004 status text below is historical and was accurate when it
was written; use `AGENTS.md` and the newest part of `docs/EVALUATION.md` for
current state. No `db push` is authorized by this note.

**Status of `0001` and `0002`: APPLIED AND VERIFIED (2026-10-15).** Both files are
applied on the live project: six tables with RLS, the `vector` extension at
`0.8.2`, and all six functions present. `list_migrations` returns `[]`, so this
was verified by matching each file's declared artifacts against the live schema
rather than by reading a migration ledger. The demo corpus is seeded on top of it
(1 course, 6 resources, 18 blocks).

**Status of `0003`: APPLIED AND VERIFIED (2026-10-15).** It was applied through the
SQL Editor on the live project, and the project was then re-read: 6/6 required
tables, 6/6 required functions, the `0003` objects present, and the durable ledger
readable. Behaviour, not just object existence, was confirmed afterwards by
`pnpm verify:budget` (12 concurrent reservations against a budget that fits 4 →
exactly 4 granted; 12 concurrent embedding admissions against a cap of 3 → exactly
3 granted; cleanup complete) and `pnpm verify:data-path` (25/25 passed, 0 pending).
The instructions below remain the procedure for any fresh environment. The
"Consequences of NOT applying 0003" section at the end describes what a project
without it does — the answer path refuses every turn by design.

**Status of `0004`: APPLIED AND VERIFIED in the shared project (2026-10-19).** It
creates the public question endpoint's durable rate-limit table and atomic
admission function. The earlier disposable-Postgres rehearsal below remains
evidence for the SQL behavior; the current live verification is recorded in
`docs/EVALUATION.md` and `AGENTS.md`.

The behaviour was exercised against a throwaway container, including twelve
sessions contending for one bucket at the same instant, by
`pnpm verify:rate-limit-sql` (requires Docker; never contacts Supabase). Result:
`PASS`, 4 of 12 admitted with a stored count of exactly 4, clean re-apply, and a
rollback rehearsal that leaves the app failing closed. That is evidence about the
SQL. The shared-project migration was separately applied and verified.

Four files must be applied **in order**:

1. `supabase/migrations/0001_init.sql` — types, tables, indexes, RLS.
2. `supabase/migrations/0002_search_functions.sql` — the search/list functions
   `horizon_is_eligible`, `horizon_search_fts`, `horizon_search_vector`,
   `horizon_list_eligible` and `horizon_has_matching_ineligible`.
3. `supabase/migrations/0003_atomic_budget.sql` — the atomic budget admission and
   settlement functions (`horizon_admit_generation_tokens`,
   `horizon_admit_embedding_request`, `horizon_settle_reservation`,
   `horizon_schema_status`) plus the reservation columns on `usage_ledger`.
   Read [the 0003 section](#applying-0003-required) before running it: it alters
   an existing table and it changes how the app spends money. **Already applied on
   the connected project** (see the status above); it is listed here so the order
   is complete for a new environment.
4. `supabase/migrations/0004_request_rate_limit.sql` — `request_rate_limits`
   (RLS on, no policies, `anon`/`authenticated` revoked) and
   `horizon_admit_request`, granted to `service_role` only. **Applied and verified
   on the Horizon project.**
5. `supabase/migrations/0005_learner_accounts.sql` — owner-scoped learner profile,
   progress, bookmark and note tables. **Applied and verified on the Horizon
   project after explicit approval.** Do not reapply it there.

`0002` reuses the identical eligibility condition as
`src/lib/eligibility/predicate.ts`, so both retrieval branches filter the same
way. If you change one, change the other and rerun
[`tests/retrieval-eligibility.test.ts`](../tests/retrieval-eligibility.test.ts).

The earlier Part 00 audit found only read-only Supabase tools. The connected
tooling later changed; the approved `0005` migration was applied through the
authenticated Supabase migration tool and verified from the live schema.

## Prerequisites

- Access to the Supabase project whose URL is `https://hirbfuhnpwkiswvihcwb.supabase.co`
- Permission to use the SQL Editor in that project's dashboard
- A decision on the embedding model (see the note below) is **not** required to
  apply this file — the column is intentionally dimension-less.

## Steps

1. Open the Supabase dashboard for the project and go to **SQL Editor → New query**.
2. Open `supabase/migrations/0001_init.sql` from this repository.
3. Copy the entire file contents and paste them into the editor.
4. Run it once. The file is written to be re-runnable: enums use
   `DO ... EXCEPTION WHEN duplicate_object`, and tables/indexes use
   `IF NOT EXISTS`. A clean first run should report success with no errors.
5. Repeat steps 2–4 for `supabase/migrations/0002_search_functions.sql`.
6. Repeat steps 2–4 for `supabase/migrations/0003_atomic_budget.sql`. It is
   idempotent: columns use `IF NOT EXISTS`, constraints are guarded by catalog
   checks, and the functions are `create or replace`.
7. Run the verification queries below and confirm each expected result.
8. Record the outcome (date, project, who applied it) in your own notes. The
   migration files are the source of truth; the remote schema should match them.

### Applying 0003 (REQUIRED)

Precise steps, because this one is not a no-op on an existing database:

1. Dashboard → **SQL Editor** → **New query**.
2. Paste the **entire** contents of `supabase/migrations/0003_atomic_budget.sql`.
3. Run it **once, as a single script.** Do not run it statement-by-statement: the
   `alter table`/backfill/`set not null` sequence must happen inside one
   transaction-like run, or a later step can fail against a half-filled column.
4. Expect success with no errors. A first run prints nothing except the DO blocks'
   implicit notices.
5. Run **Verification A** and **Verification B** below and compare.
6. Then run the concurrency proof from the repository, which exercises the real
   functions and cleans up after itself:

   ```bash
   pnpm verify:budget
   ```

   Expect `RESULT: PASS`, exactly 4 grants out of 12 simultaneous reservations,
   the embedding cap binding at exactly 3, and `CLEANUP: complete`.

7. Re-request `/api/v1/health` and confirm `checks.database.durableLedger` becomes
   `"usable"`, `schemaObjects` becomes `"verified"`, and `ok` becomes `true`.

Nothing in this repository applies the migration for you, and no claim of it
being applied appears anywhere until those two checks pass.

Then set the three Supabase variables in `.env.local` and confirm the app
switches off demo mode:

```bash
# evidenceSource must become "supabase" and database.configured true
curl -s localhost:3000/api/v1/health | grep -o '"evidenceSource":"[a-z]*"'
```

## Verification queries

Run these in the same SQL Editor and compare against the expected results.

```sql
-- 1. pgvector is installed (expect one row, version 0.8.x)
select extname, extversion
from pg_extension
where extname = 'vector';

-- 2. The six MVP tables exist (expect courses, resources, blocks,
--    conversations, turns, usage_ledger)
select table_name
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
order by table_name;

-- 3. RLS is enabled on every table (expect relrowsecurity = true for all six)
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r'
order by relname;

-- 4. The blocks table carries the expected retrieval columns
select column_name, data_type, is_generated
from information_schema.columns
where table_schema = 'public' and table_name = 'blocks'
order by ordinal_position;

-- 5. Indexes on blocks (expect FTS gin index + partial eligibility index)
select indexname
from pg_indexes
where schemaname = 'public' and tablename = 'blocks'
order by indexname;

-- 6. Canonical policy vocabulary (expect exactly two labels per policy enum)
select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
from pg_type t
join pg_enum e on e.enumtypid = t.oid
where t.typname in ('policy', 'review_state', 'lint_status', 'ingest_status')
group by t.typname
order by t.typname;

-- 7. The five search/eligibility functions from 0002 exist (expect 5 rows)
select proname, pg_get_function_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'horizon\_%'
order by proname;
```

## Behavioural checks to run AFTER the schema exists

Schema existence is not behaviour. With rows loaded, confirm in the SQL Editor
that the functions actually cut off the future (replace the ids/timestamps with
real values from your seed rows):

```sql
-- A. An early boundary must not return a block that unlocks later.
select block_id from public.horizon_search_fts(
  '<course_id>', 360, 'backoff constant', 20
);
-- Expect: no block whose unlock_seconds > 360.

-- B. Both branches must agree about eligibility.
select block_id from public.horizon_search_vector(
  '<course_id>', 360, (select embedding::text from public.blocks limit 1)::extensions.vector, 20
);
-- Expect: the same eligibility cutoff as A.

-- C. The diagnostic returns a boolean, never future content.
select public.horizon_has_matching_ineligible('<course_id>', 360, 'backoff constant');
```

Note: `horizon_search_vector` takes the query vector supplied by the caller. The
application embeds the question with the configured embedding model and sends a
768-dimension vector; keep `HORIZON_EMBEDDING_DIMENSIONS` in step with the stored
column or similarity comparison will fail.

## Expected security posture after applying

RLS is enabled with **no permissive policies**, and `anon` grants are revoked.
That means a request using the public anon key should see no rows. To confirm
the deny-by-default behaviour, run this from a client using the anon key (not
the service-role key):

```sql
select * from public.courses limit 1;
-- Expected: permission denied, or an empty result — never actual rows.
```

Do **not** add an `allow select to anon` policy to make a demo work. Learner
policies come with Supabase Auth integration in a later phase.

## What is deliberately missing

- **No approximate vector index.** Exact scan is the MVP default (see D-013). Add
  ivfflat/hnsw only after a filtered-recall test shows it preserves eligible results.
- **No learner-facing RLS policies.** Every read in this revision goes through the
  server with the service-role key, so the deny-by-default posture is unchanged.
- **No storage buckets.** Creating them, and wiring signed URLs, is a later phase.
- **No seed data.** The `courses`/`resources`/`blocks` rows will be produced by the
  ingestion step once a real, rights-safe sample lesson exists.

## Resolved item: embedding dimension

Part 02 froze the embedding model and dimension: `gemini-embedding-001` at
**768** dimensions (`HORIZON_EMBEDDING_MODEL`, `HORIZON_EMBEDDING_DIMENSIONS`).
The column stays dimension-less `extensions.vector` so the exact scan works
regardless, but the application always writes and queries 768-dimension vectors
and `tests/gemini-adapter.test.ts` asserts that dimensionality.

When real rows are loaded, if you want the column pinned:

1. Add a follow-up migration:
   `alter table public.blocks alter column embedding type extensions.vector(768);`
2. Re-embed existing rows and record `embedding_model` and `embedding_dim`.
3. Only then consider an approximate index.

A dimension mismatch between the stored column and the query vector breaks
similarity search silently — that is why the dimension is configuration, not a
literal scattered through the code.

## Verification A — the 0003 objects exist (SQL Editor)

```sql
-- A1. Expect one row per function, all four present.
select proname, pronargs
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in (
     'horizon_admit_generation_tokens',
     'horizon_admit_embedding_request',
     'horizon_settle_reservation',
     'horizon_schema_status'
   )
 order by proname;

-- A2. Expect the new reservation columns on usage_ledger and NO null day values.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'usage_ledger'
 order by ordinal_position;

select count(*) as rows_with_null_day from public.usage_ledger where day is null;
-- Expect: 0

-- A3. Expect every pre-0003 row to have been backfilled as settled with a charge.
select state, count(*), coalesce(sum(charged_tokens), 0) as charged
  from public.usage_ledger
 group by state;

-- A4. Expect all four functions to be callable by the service role only.
select p.proname, coalesce(array_to_string(p.proacl, ' | '), '(default: PUBLIC)') as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'horizon\_admit%' or p.proname = 'horizon_settle_reservation';
```

## Verification B — the aggregate report the health endpoint uses

```sql
select * from public.horizon_schema_status();
-- Expect: tables_present 6, tables_expected 6,
--         core_functions_present 6, core_functions_expected 6,
--         atomic_budget_objects true, ledger_readable true.
```

This is the same call `/api/v1/health` makes. It returns counts and booleans
only, which is why it is safe to expose: no schema map, no names, no rows.

## Consequences of NOT applying 0003

The application requires it as soon as a database is configured. Until it is
applied, and by design:

- `/api/v1/health` reports `ok: false`, `schemaObjects: "unknown"` and
  `durableLedger: "unreadable"` — it does **not** report a healthy database.
- Every question returns `TEMPORARILY_UNAVAILABLE` with reason `BUDGET_EXHAUSTED`
  and the detail "the usage ledger could not be read", **before any provider call
  is made**. That is the fail-closed path, not a bug: an unreadable budget must
  never be treated as an unspent budget.
- `GET /api/v1/courses` and `/scope` keep working, because they do not touch the
  ledger.

If you see those three symptoms together, the fix is this migration — not raising
the budget, and not editing the ledger by hand.

## Migration history: how to reconcile it before touching the shared schema

The shared project was built by pasting `0001`–`0003` into the SQL Editor. Its
migration ledger is therefore empty (`list_migrations` returns `[]`) even though
the objects exist, and this checkout has **no** `supabase/config.toml` and **no**
linked project (`supabase/.temp/project-ref` is absent).

That combination makes the usual CLI commands the wrong tool, for concrete
reasons:

- **`supabase db push`** would replay every local migration against a database
  that already has those objects. `0001`/`0002` are mostly guarded with
  `if not exists`, but the run is not guaranteed to be a no-op, it needs a shadow
  database to diff, and a failure halfway leaves the schema neither old nor new.
  It also writes bookkeeping rows on the way.
- **`supabase migration repair`** only writes to
  `supabase_migrations.schema_migrations`. It does not create or verify anything.
  Run against a ledger that does not describe the real schema, it produces a
  history that is confidently wrong.

**The safe order is:**

1. **Read the live schema, do not write.** Run the verification queries in this
   document (and `pnpm verify:data-path` for behaviour) against the project and
   confirm the artifacts of `0001`–`0003` are present. That is what establishes
   the baseline, whether or not a ledger exists.
2. **Exercise the change somewhere disposable.** `pnpm verify:rate-limit-sql`
   applies `0004` to a throwaway Postgres, proves the atomic behaviour under
   concurrency, and drops the database. It needs Docker and no credentials.
3. **Apply `0004` as a reviewed script** through the SQL Editor (below), then
   verify the objects, the grants and the three-call behaviour query.
4. **Only if the team wants CLI bookkeeping**: `supabase link`, then
   `supabase migration repair --status applied 0001 0002 0003 0004`. That is a
   separate, approved change that records what step 1 already proved. Do not run
   it before step 1, and never use `--status reverted` to "clean up".

Until step 4 is done deliberately, the migration files plus this document are the
source of truth, and that is a legitimate state for this project.

## Applying 0004 (required before the rate-limited build is promoted)

`0004_request_rate_limit.sql` adds one table and one function. It does not alter
any existing object, so it is safe to apply on a live project, but it must be
applied **before** code that calls it is promoted: without it, every question is
refused with `503 RATE_LIMIT_UNAVAILABLE` by design.

1. SQL Editor → New query → paste the entire file → Run.
2. Re-running is safe: the table uses `IF NOT EXISTS` and the function is
   `create or replace`.
3. Verify the objects, the shape and the privileges:

   ```sql
   -- Expect: table_present non-null.
   select to_regclass('public.request_rate_limits') as table_present;

   -- Expect: one row, prosecdef = true, search_path pinned.
   select proname, prosecdef, proconfig
   from pg_proc
   where proname = 'horizon_admit_request';

   -- Expect: service_can_execute true, anon_can_execute false.
   select has_function_privilege('service_role',
     'public.horizon_admit_request(text,integer,integer,timestamptz)', 'execute') as service_can_execute,
     has_function_privilege('anon',
     'public.horizon_admit_request(text,integer,integer,timestamptz)', 'execute') as anon_can_execute;

   -- Expect: relrowsecurity true and no policy on the table.
   select relrowsecurity from pg_class where oid = 'public.request_rate_limits'::regclass;
   select count(*) as policies from pg_policies where tablename = 'request_rate_limits';

   -- Expect: bucket_key,window_seconds,window_start.
   select string_agg(a.attname, ',' order by array_position(i.indkey, a.attnum))
   from pg_index i
   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
   where i.indrelid = 'public.request_rate_limits'::regclass and i.indisprimary;
   ```

4. Exercise the function directly. These calls use a throwaway bucket and write
   two rows; delete them afterwards. The key is 64 hex characters because that is
   the shape the server sends, and the function rejects anything that is not at
   least 16 characters long.

   ```sql
   select * from public.horizon_admit_request(repeat('0123456789abcdef', 4), 600, 2, now());
   select * from public.horizon_admit_request(repeat('0123456789abcdef', 4), 600, 2, now());
   select * from public.horizon_admit_request(repeat('0123456789abcdef', 4), 600, 2, now());
   -- Expect: admitted true, true, false — with a positive retry_after_seconds
   -- on the third call, and request_count still 2 (the refusal is not counted).
   select request_count from public.request_rate_limits
   where bucket_key = repeat('0123456789abcdef', 4);
   delete from public.request_rate_limits
   where bucket_key = repeat('0123456789abcdef', 4);
   ```

5. Optionally, prove the contention path on the live project. This does write and
   then delete a throwaway bucket; skip it if you would rather not write at all:
   twelve concurrent calls with `limit = 4` must admit exactly 4. The disposable
   harness (`pnpm verify:rate-limit-sql`) already proves exactly this on Postgres
   16, so this is confirmation rather than the primary evidence.

5. Confirm the public endpoint answers questions again (`429` after the burst
   allowance, not `503`).

### Consequences of NOT applying 0004

- Every `POST /questions` returns `503` with code `RATE_LIMIT_UNAVAILABLE`,
  **before** parsing or any provider call. The limiter fails closed on purpose:
  a limiter that opens when it is broken looks protected while allowing unlimited
  spend.
- `/api/v1/health` still answers, and it no longer calls the deployment
  operational: `checks.admission.reachable` is `false`, `status` is `degraded`,
  and the public Status surface shows **Admission: unavailable**. The health
  probe asks the limiter with a deliberately invalid key, which the function
  rejects before writing, so the probe itself consumes nothing.
- `GET /api/v1/courses`, `/scope`, `/transcript`, `/resources` and the player are
  unaffected.

## Retention, rollback and recovery for 0004

**Retention is NOT automatic.** No cron, scheduler or trigger deletes these rows,
and nothing in this repository creates one. The mechanism is an operator command:

```bash
pnpm prune:rate-limits                 # dry run: prints the cutoff and eligible count
pnpm prune:rate-limits --apply         # delete eligible rows
pnpm prune:rate-limits --apply --retention-days=7
```

It reads `.env.local` (or the process environment), needs the service-role key, and
prints only the cutoff, the retention and counts — never a key, address or row.

**Why it cannot reset a live counter.** Eligibility is
`window_start < now − retention − widest window`. For every configured window
that guarantees the window ended at least `retention` seconds ago, so no active
window is selectable. The arithmetic lives in `src/lib/rate-limit/retention.ts`;
`tests/rate-limit-retention.test.ts` proves the property for every configured
window (including at `retention = 0`), and every deleted row is re-checked. A bad
retention value (negative, NaN) is rejected rather than producing a future cutoff.

The default retention is 2 days after a window closes, so the effective cutoff is
about 3 days back because the widest window is a day. To schedule it, run the
command with `--apply` daily or weekly from any scheduler that has the two database
variables; until such a job exists and has been observed running, do not describe
retention as automatic. Growth is one row per bucket per window (at most two live
rows per client per day), so a missed run is harmless; a run that deletes nothing
is also normal.

**Rollback.** Safe and complete, because 0004 touched nothing else:

```sql
drop function if exists public.horizon_admit_request(text, integer, integer, timestamptz);
drop table if exists public.request_rate_limits;
```

Rolling back makes the durable limiter fail closed (`503
RATE_LIMIT_UNAVAILABLE`), which is the intended direction: no limit is never the
failure mode. Redeploy the previous code at the same time to remove the symptom.

**Recovery from a partial apply.** The file is a single transaction when run as
one script in the SQL Editor; if it failed, nothing was created. If it was run
statement-by-statement and stopped after the table, re-running the whole file is
the fix — the table is `if not exists` and the function is `create or replace`.
The one thing not to do is create the table by hand without the function's
`revoke`s: a table reachable by `anon` would let a client read or edit counters.

**Usage data is never erased by rollback.** The only rows in this table are
short-lived counters for a closed window; no turn, ledger entry, course or
learner record lives here, and no other table references it.
