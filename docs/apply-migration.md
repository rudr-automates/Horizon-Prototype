# Applying the Supabase migration

**Status of `supabase/migrations/0001_init.sql`: AUTHORED, NOT APPLIED.**

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
5. Run the verification queries below and confirm each expected result.
6. Record the outcome (date, project, who applied it) in your own notes. The
   migration file is the source of truth; the remote schema should match it.

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
```

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

- **No approximate vector index.** Exact scan is the MVP default. Add ivfflat/hnsw
  only after a filtered-recall test shows it preserves eligible results.
- **No storage buckets.** Creating them, and wiring signed URLs, is a later phase.
- **No seed data.** The `courses`/`resources`/`blocks` rows will be produced by the
  ingestion step once a real, rights-safe sample lesson exists.

## Open item: embedding dimension

`blocks.embedding` is declared as a dimension-less `extensions.vector` because no
embedding model has been chosen or verified. This stores vectors of any
dimension and supports exact scan. When an embedding model is frozen:

1. Add a follow-up migration that sets the fixed dimension, for example
   `alter table public.blocks alter column embedding type extensions.vector(1536);`
2. Re-embed existing rows and record `embedding_model` and `embedding_dim`.
3. Only then consider an approximate index.

Do not guess a dimension now; a wrong value silently breaks similarity search.
