# Applying the Supabase migrations

**Status: AUTHORED, NOT APPLIED.**

Two files must be applied **in order**:

1. `supabase/migrations/0001_init.sql` — types, tables, indexes, RLS.
2. `supabase/migrations/0002_search_functions.sql` — the search/list functions
   `horizon_is_eligible`, `horizon_search_fts`, `horizon_search_vector`,
   `horizon_list_eligible` and `horizon_has_matching_ineligible`.

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
6. Run the verification queries below and confirm each expected result.
7. Record the outcome (date, project, who applied it) in your own notes. The
   migration files are the source of truth; the remote schema should match them.

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
