# Horizon — Decision Log

This file records decisions actually taken during implementation. It does not
replace the product blueprint; where a decision narrows scope, the blueprint's
long-term vision still stands.

The consolidated blueprint (`Horizon_Final_Prototype_Blueprint.md`) remains the
source of truth for product direction. This log tracks the deliberate, temporary
reductions needed for the imminent submission deadline.

---

## D-001 — Deadline MVP scope is frozen and reduced

**Date:** 2026-10-15
**Status:** Accepted
**Context:** The blueprint defines a large prototype (seven phases, adaptive
mock interview, full evaluation grid, OCR/vision, background worker). The
submission deadline (PPT + deployed URL, 16 Oct 2026 23:59 IST) leaves roughly
two days. The repository and database were both empty.

**Decision:** Build **one working, publicly deployable learning-assistant flow**:

1. Open one sample lesson.
2. Ask a question at a lesson timestamp.
3. Retrieve only evidence eligible at that timestamp.
4. Show an answer with inspectable citations, or a clear refusal.
5. Change the timestamp / rewind and re-evaluate the evidence scope.
6. Record real evaluation outcomes for those behaviours.

**Explicitly deferred (NOT built now):** adaptive mock interview, automatic
transcription, OCR/vision processing, a separate background worker, the full
evaluation grid, storage buckets, LMS launch demo, AWS mapping artefacts.

**Consequence:** any claim of a deferred feature is unsupported until built and
tested. The blueprint vision is unchanged; it is sequenced later.

---

## D-002 — Single Next.js App Router app instead of Fastify + worker

**Date:** 2026-10-15
**Status:** Accepted
**Context:** The blueprint recommends `apps/web` + `apps/api` (Fastify) +
`apps/worker`. The reduced MVP has no background ingestion work yet.

**Decision:** Use **one Next.js (App Router) application** with TypeScript route
handlers, Tailwind CSS and pnpm. Code stays modular under `src/lib/*` so a future
split into a separate Fastify service and worker is mechanical rather than a
rewrite.

**Consequence:** No `apps/api` or `apps/worker` packages exist yet. The blueprint
layout remains the target for the full product.

---

## D-003 — Supabase migration is authored but NOT remotely applied

**Date:** 2026-10-15
**Status:** Accepted (environment constraint)
**Context:** The Part 00 audit confirmed the Supabase MCP toolset is read-only:
no `execute_sql`, no `apply_migration`. No DB connection string or access token
is present in this environment.

**Decision:** Author `supabase/migrations/0001_init.sql` as the versioned source
of truth and document the manual Dashboard SQL Editor procedure in
[`apply-migration.md`](apply-migration.md). Do not invent credentials, do not
attempt unsupported writes, and do not state the schema exists remotely.

**Consequence:** The remote database still has no tables. Health reporting and
docs must reflect "configured / not yet migrated" honestly.

---

## D-004 — Runtime AI is unconfigured, and the adapter fails closed

**Date:** 2026-10-15
**Status:** Accepted
**Context:** No runtime provider endpoint, model id or key exists. The blueprint
requires model IDs to be frozen only after smoke tests.

**Decision:** Ship a server-only provider interface (`src/lib/answer/provider.ts`)
whose default implementation throws `RuntimeModelNotConfiguredError` and performs
**no** inference. No mock or canned claims are returned. `isRuntimeAiConfigured`
reports whether the env var **names** are present, which is separate from whether
a provider works.

**Consequence:** No answer path can produce output until a provider is chosen,
its terms reviewed, and a smoke test recorded in `docs/model-config.md` (still to
be written).

---

## D-005 — Embedding dimension intentionally left unfixed

**Date:** 2026-10-15
**Status:** Accepted
**Context:** No embedding model has been selected or verified.

**Decision:** Declare `blocks.embedding` as a dimension-less `extensions.vector`
and record `embedding_model` / `embedding_dim` alongside it. Defer both the fixed
dimension and any approximate index to a follow-up migration.

**Consequence:** Exact vector scan works today; ANN indexing is blocked until the
dimension is frozen and a filtered-recall test justifies it. See
`apply-migration.md` for the upgrade path.

---

## D-006 — RLS enabled with deny-by-default, no permissive policies

**Date:** 2026-10-15
**Status:** Accepted
**Context:** Supabase Auth integration is not implemented yet, but the tables
must not be publicly readable in the meantime.

**Decision:** Enable RLS on all tables, revoke `anon` grants, and add **no**
permissive policy. The server uses the service-role key and performs its own
authorization. Learner-facing policies arrive with Auth in a later phase.

**Consequence:** The public anon key can read nothing. This is deliberate and
documented in the migration so nobody "fixes" it with a broad allow policy.

---

## D-007 — Hosting target: Vercel, verified only when a live URL exists

**Date:** 2026-10-15
**Status:** Tentative — NOT yet verified
**Context:** Public deployment is mandatory for the submission. Vercel's Hobby
plan is the default path named in the task.

**Decision:** Target a single Vercel deployment of this Next.js app. No Vercel CLI
is installed and no deployment has been attempted in Part 01.

**Consequence:** Deployment is an open prerequisite. It must not be reported as
successful until a real public URL has been opened in a clean session.
