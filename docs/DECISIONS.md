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
**Status:** Procedure prepared in Part 03; deployment still NOT verified
**Context:** Public deployment is mandatory for the submission. Vercel's Hobby
plan is the default path named in the task.

**Decision:** Target a single Vercel deployment of this Next.js app, connected
to the existing GitHub repository. The full procedure — project connection,
the exact environment-variable names, and the post-deploy checklist — is in
[docs/DEPLOY.md](DEPLOY.md).

**Consequence:** No Vercel CLI and no deployment token exist in this
environment, so the agent cannot perform the connection itself. Deployment is an
open prerequisite owned by a human with Vercel account access. It must not be
reported as successful until a real public URL has been opened in a clean
session; a local `next start` is not a deployment.

---

## D-009 — The spend guard is enforced, not merely documented

**Date:** 2026-10-15
**Status:** Accepted
**Context:** `.env.example` and the README both stated that
`HORIZON_DAILY_TOKEN_BUDGET=0` means "no calls permitted (hard stop)". The value
was read into configuration and then never consulted, so the documented limit
did not exist. A documented guardrail that does not run is a false claim.

**Decision:** Enforce it in `answerQuestion` at step 0, before the embedding
request, because the embedding call is itself billable. When the guard trips the
turn returns `TEMPORARILY_UNAVAILABLE` with reason `BUDGET_EXHAUSTED` and **no**
provider request is made. `/api/v1/health` reports `runtime.spendGuard`.

**Consequence:** A deployment with a credential but a zero budget still refuses.
That is correct fail-closed behaviour, but it is easy to mistake for a broken key,
so the state is reported on the health endpoint and the learner-facing message
deliberately says nothing about budgets.

---

## D-008 — Gemini provider is integrated through its own SDK; `HORIZON_LLM_BASE_URL` is not a base URL

**Date:** 2026-10-15
**Status:** Accepted
**Context:** The task named an OpenAI-compatible shape (`HORIZON_LLM_BASE_URL`)
but also required the official Google Gen AI SDK used correctly, and explicitly
forbade assuming Gemini is OpenAI-compatible.

**Decision:** Integrate `@google/genai` directly. The SDK resolves its own
endpoint, so there is no meaningful base URL to configure.
`HORIZON_LLM_BASE_URL` is kept as an OPTIONAL override that is only applied when
explicitly set. Provider configuration is `HORIZON_LLM_PROVIDER=google-genai`.
`HORIZON_LLM_API_KEY` is preferred, with `GOOGLE_API_KEY` / `GEMINI_API_KEY`
accepted as fallbacks because the SDK reads those names.

**Consequence:** The environment surface still uses the requested generic names,
but nothing forces a misleading OpenAI-compatible configuration. Structured
output uses `responseMimeType: application/json` plus `responseSchema`; the
schema shapes were checked against the installed SDK's own `.d.ts` rather than
assumed from documentation.

---

## D-009 — Offline lexical embedder as a labelled fallback, never as the configured model

**Date:** 2026-10-15
**Status:** Accepted
**Context:** Without an embedding credential the vector retrieval branch cannot
run at all, which would make the pipeline untestable and hide the temporal
invariant from a demo.

**Decision:** When embeddings are unconfigured, use a deterministic lexical
hashing embedder (`synthetic-lexical-v1`) at 768 dimensions. It is reported in
every response, labelled "in use" separately from the configured model, and
excluded from any claim about semantic retrieval quality.

**Consequence:** Retrieval quality in demo mode is weaker than PostgreSQL FTS
and far weaker than a real embedding model. That difference is reported, not
hidden. No generation fallback exists: when the text model is unconfigured the
pipeline refuses rather than fabricating claims.

---

## D-010 — NOT_AVAILABLE_YET collapses into INSUFFICIENT_EVIDENCE for learners

**Date:** 2026-10-15
**Status:** Accepted
**Context:** Distinguishing "the lesson has not reached that yet" from "that is
not in the material" would leak the existence of future content and turn the
assistant into a syllabus oracle. The blueprint's definition of done asks for a
distinct honest state for the future-only case.

**Decision:** Keep both states **internally** (`InternalAnswerState`) and store
the distinction in the database `turns.answer_state`. The learner-facing API
always collapses them to `INSUFFICIENT_EVIDENCE` with one identical message. The
backend diagnostic `horizon_has_matching_ineligible` returns a boolean only.

**Consequence:** Both requirements are satisfied without contradiction: the
system's internal honesty is preserved and testable, while nothing future-facing
reaches the browser. Tests assert both the internal distinction and the collapse.

---

## D-011 — Turn persistence is best-effort and reports `persisted: false`

**Date:** 2026-10-15
**Status:** Accepted
**Context:** §5 requires storing minimal conversation/turn information, but the
migration is not applied and the demo corpus is a fixture with no course row.

**Decision:** Persist turns through a `TurnRecorder`. When no database is
configured, or when the turn came from the fixture corpus, report
`persisted: false` with a plain-language reason. Persistence failures are caught,
never retried into the learner's latency budget, and never surfaced as a request
error.

**Consequence:** No invented database success. The UI shows a real `turn stored:
no — <reason>` field, and once the migration is applied and real rows exist the
same field reports `yes`.

---

## D-012 — Sample timeline simulation instead of a lesson video

**Date:** 2026-10-15
**Status:** Accepted
**Context:** No original lesson video exists. The promotional `Horizon.mp4` is
not lesson content and must not be portrayed as one.

**Decision:** Build a labelled 15-minute sample corpus (transcript, PDF pages,
slide, code appendix) with a deliberately invented, high-entropy fact: the
"Marlin backoff constant, 0.37", introduced only in timeline-bound blocks that
unlock at 578s and appearing in no course-wide resource. Every surface labels it
as synthetic demo content.

**Consequence:** The temporal invariant is demonstrable and testable: the same
question at 06:00 and 12:00 has different eligible evidence, and the canary fact
is unavailable before its unlock time. This is a simulation, not a learner
outcome, and is never presented as an evaluated result.

---

## D-013 — Exact vector scan, no approximate index, for the demo corpus

**Date:** 2026-10-15
**Status:** Accepted
**Context:** The blueprint requires recall to be measured before approximate
indexing is trusted.

**Decision:** `horizon_search_vector` scans eligible blocks exactly and orders by
distance before `LIMIT`. No HNSW/IVFFlat index is created.

**Consequence:** Retrieval is exact and cheap at this corpus size, and recall is
not silently traded away. An ANN index is a later, measured decision.

---

## D-014 — The semantic verifier is model-assisted, not independent

**Date:** 2026-10-15
**Status:** Accepted
**Context:** A second model call is easy to describe as "independent
verification", which would overstate what it guarantees.

**Decision:** Label the Tier-2 check as **model-assisted** everywhere: in the
response (`provenance.verification: "model_assisted"`), the UI and the docs. Keep
Tier-1 deterministic checks (payload membership, verbatim quote match) as the
parts that are actually mechanical. Fail closed on verifier errors, timeouts,
rate limits and malformed output.

**Consequence:** No claim of infallibility. A shared failure mode between the
generator and the verifier is possible and is stated rather than hidden.

---

## D-010 — The seed path refuses to persist placeholder vectors

**Date:** 2026-10-15
**Status:** Accepted
**Context:** Part 03 asks for the demo corpus to be loaded through the real data
path with real embeddings. The demo corpus is reachable only in fixture mode
today, so an ingestion operation had to exist. The risk is that it runs with the
offline `synthetic-lexical-v1` embedder and writes lexical hashes into
`blocks.embedding`, where they would then be indistinguishable from semantic
vectors.

**Decision:** `src/lib/ingest/seed.ts` refuses outright when the active embedder
id begins with `synthetic`, and it records `embedding_model` and `embedding_dim`
from the embedder that actually produced each vector. Fixture ids are hashed into
deterministic uuids so a re-run upserts rather than duplicating the corpus.

**Consequence:** `pnpm seed:demo` cannot silently populate the database with
placeholder vectors; it stops with an operator-facing reason. It is implemented
and unit tested against a fake gateway, but it has **never executed** against a
live database, and nothing in this repository claims that it has.

---

## D-011 — Withheld material is checked by an independent test oracle

**Date:** 2026-10-15
**Status:** Accepted
**Context:** The temporal invariant ("the future fact must not be reachable
before its unlock time") is the submission's headline claim. Testing it by
calling the application's own `isBlockEligible` would let a bug in that predicate
satisfy its own test.

**Decision:** `scripts/canary.ts` writes a second, explicit expression of the
policy and uses it as an oracle: it compares the server's eligible-block count
against its own count, and asserts that every returned citation id belongs to
that set. It also treats an unconfigured model as `NOT RUN` rather than a failure
or a pass.

**Consequence:** The invariant is cross-checked rather than self-confirmed, and
blocked evidence is never reported as verified.
