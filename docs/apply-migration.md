# Applying the Supabase migrations

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

Three files must be applied **in order**:

1. `supabase/migrations/0001_init.sql` — types, tables, indexes, RLS.
2. `supabase/migrations/0002_search_functions.sql` — the search/list functions
   `horizon_is_eligible`, `horizon_search_fts`, `horizon_search_vector`,
   `horizon_list_eligible` and `horizon_has_matching_ineligible`.
3. `supabase/migrations/0003_atomic_budget.sql` — the atomic budget admission and
   settlement functions (`horizon_admit_generation_tokens`,
   `horizon_admit_embedding_request`, `horizon_settle_reservation`,
   `horizon_schema_status`) plus the reservation columns on `usage_ledger`.
   Read [the 0003 section](#applying-0003-required) before running it: it alters
   an existing table and it changes how the app spends money.

`0002` reuses the identical eligibility condition as
`src/lib/eligibility/predicate.ts`, so both retrieval branches filter the same
way. If you change one, change the other and rerun
[`tests/retrieval-eligibility.test.ts`](../tests/retrieval-eligibility.test.ts).

The Part 00 audit found that the connected Supabase MCP toolset exposes only
read-only tools (no `execute_sql`, no `apply_migration`). The coding agent
therefore cannot apply this migration, and must not claim that it did.

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
