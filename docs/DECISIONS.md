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

**Update (2026-10-15):** the precondition now holds — both migrations are applied
and the database holds a seeded course with real rows — but the path is still
**unexercised**, because a turn is recorded only after a successful generation,
and generation is refused by the provider's free-tier quota. The `persisted:
false` branch is what the current revision actually produces, and it is not a
stand-in for a passing write path.

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

---

## D-012 — SDK automatic retries are disabled

**Date:** 2026-10-15
**Status:** Accepted
**Context:** The Google Gen AI SDK documents `attempts` as defaulting to **5** and
retries 408/429/5xx. Nothing in this codebase set `retryOptions`, so a single
logical request could have become up to five billable requests — silently, and
most likely precisely when the free-tier limit was closest.

**Decision:** `buildHttpOptions` pins `retryOptions: { attempts: 1 }`, so one call
means one request. This is verified by unit test, not by comment.

**Consequence:** A transient 5xx now surfaces as a failure the learner sees as
`TEMPORARILY_UNAVAILABLE`, instead of being retried behind their back. That is the
right trade while usage accounting is meant to be trustworthy; retries can be
revisited only alongside idempotent accounting.

---

## D-013 — Reasoning tokens are metered and bounded

**Date:** 2026-10-15
**Status:** Accepted
**Context:** A live canary turn failed with `PROVIDER_MALFORMED`. Content-free
diagnostics showed `length=98 endsBrace=false finishReason=unknown
tokens=p417/c21/thoughts984` against `maxOutputTokens=1024`. `gemini-3.6-flash`
spends reasoning tokens that **count against `maxOutputTokens`**, so the JSON was
truncated after ~21 visible tokens. Separately, `thoughtsTokenCount` is billed but
appears in neither `promptTokenCount` nor `candidatesTokenCount`, so the ledger was
under-counting a call by roughly 50x.

**Decision:** Raise the default output allowance from 1024 to 4096, expose
`HORIZON_LLM_THINKING_BUDGET` to bound reasoning explicitly, and meter
prompt + completion + reasoning via `meteredTokens`.

**Consequence:** A truncated-JSON failure mode is removed rather than retried
around, and the recorded usage reflects what is actually billed. The output
allowance is not a cost control; the token budget is.

---

## D-014 — Embedding requests get their own cap

**Date:** 2026-10-15
**Status:** Accepted
**Context:** The embeddings API reports no token usage, so the daily token budget
cannot bound embedding spend. A retrieval fault could issue many embedding
requests with nothing to stop it.

**Decision:** `HORIZON_MAX_EMBEDDING_CALLS` caps embedding REQUESTS per process,
counted before the request is sent so a failing call is not free and a retry
cannot multiply requests. It is reported on `/api/v1/health` alongside the live
count. `0` means no cap is configured.

**Consequence:** This bounds call count, not tokens or cost, and it resets when the
process restarts — it is deliberately NOT described as a spending cap. It bound
during testing and refused correctly.

---

## D-015 — A failed provider call is still billed

**Date:** 2026-10-15
**Status:** Accepted
**Context:** `ProviderFailure` was thrown before usage was recorded, so every
malformed or truncated response cost real tokens that the ledger never saw —
under-counting spend exactly when something was going wrong.

**Decision:** `ProviderFailure` carries the usage the provider reported, and the
pipeline meters it in the failure path as well as the success path.

**Consequence:** Failed turns count against the budget, which is both more truthful
and a useful signal: repeated failures now visibly consume the allowance.

---

## D-016 — A provider failure is never evidence of temporal scoping

**Date:** 2026-10-15
**Status:** Accepted
**Context:** At an early playhead, a `TEMPORARILY_UNAVAILABLE` response renders no
claims — so a naive "no disclosure" check would pass and a provider outage would be
recorded as proof that a future fact was withheld.

**Decision:** `scripts/canary.ts` reports a provider/budget failure at an early
position as **NOT RUN**, never as a pass, and tests the early-position invariant by
inspecting every rendered claim and quotation for the withheld term rather than by
asserting a particular answer state.

**Consequence:** The canary cannot report a temporal-scoping pass that was really
an outage. It also no longer demands a refusal, because the requirement is that the
fact is not disclosed — a partially supported answer that omits it is correct.

---

## D-017 — The persisted usage row must sum to the figure the cap was checked against

**Date:** 2026-10-15
**Status:** Accepted
**Context:** D-013 metered prompt + completion + reasoning for the *in-turn*
reservation, but the entry written to the ledger carried only prompt and
completion. Both ledgers then accumulated `prompt + completion`, so every
persisted total silently dropped the reasoning tokens — the same class of
under-count as D-013, one layer down, and it made the two ledger modes disagree
about the same call. The row is what `spentToday()` reads back, so the daily cap
was being enforced against a figure far below the provider's bill while still
looking plausible.

**Decision:** `entryTotalTokens` is the single definition of an entry's
contribution. `usageRow` derives `completion_tokens` as
`entryTotalTokens(entry) − prompt_tokens` instead of re-deriving it from the
reported parts, so the identity `prompt_tokens + completion_tokens ===
entryTotalTokens(entry)` holds **by construction**. `count()` is the one shared
sanitiser for NaN/negative components, used by both ledgers and by
`meteredTokens`.

**Consequence:** A `reasoning_tokens` column would be more truthful about the
split, but adding one would invalidate the migration an operator has already
applied; the total is preserved instead and the split stays documented. A test
asserts both ledgers report the same number for the same entry, and that test
fails if the reasoning component is dropped again — verified by reintroducing the
bug.

---

## D-018 — A rate limit is reported with the provider's own reason

**Date:** 2026-10-15
**Status:** Accepted
**Context:** Every live generation call failed as `rate_limited`, and the coarse
reason code cannot distinguish "slow down for a minute" from "this project's
daily quota is spent" — opposite responses to the same HTTP status. Live
diagnosis was therefore guesswork.

**Decision:** `describeRateLimit` extracts only the API's `retryDelay` and quota
identifier from the error metadata and appends them server-side. It reads
metadata about the limit, never content, and contributes nothing when the shape
is unrecognised so it cannot mask the plain reason.

**Consequence:** The blocking condition is now legible: the free-tier
`generate_content_free_tier_requests` quota for `gemini-3.6-flash` is exhausted
with a ~15-hour retry delay, while embeddings — a separate quota — still work.
The canary gained `--delay <ms>` so three back-to-back turns do not exhaust a
per-minute limit on their own.

---

## D-019 — Admission is an atomic reservation, not a read-then-record

**Date:** 2026-10-15
**Status:** Accepted. **Requires migration `0003_atomic_budget.sql`, which is
AUTHORED AND NOT YET APPLIED.**

**Context:** The daily token budget was enforced by reading the day's total,
deciding in the application, and recording usage afterwards. Those are three
operations, so two turns in flight at once could each read the same remaining
budget and both be admitted: the ceiling was soft by exactly the number of
concurrent calls. The embedding-request cap had the same shape in a different
place — a process-local counter, so N instances got N caps.

**Decision:** Capacity is HELD before a billable request is sent. A single SQL
function takes an advisory transaction lock keyed on `(kind, UTC day)`, compares
the day's settled charges plus outstanding reservations against the budget, and
inserts a reservation row if it fits — one statement, one transaction. The same
mechanism counts embedding requests by row count. Reservation state lives in
`usage_ledger` itself rather than in a second table, because two tables would
mean two answers to "what has been spent today" and the wrong one would
eventually be read.

**Consequence:** "Two concurrent turns cannot both be admitted against the same
remaining budget" is now a property of the database rather than an assumption
about the application. A reservation that is never settled keeps counting against
the day, which over-counts a crashed process rather than under-counting real
spend. The cost is a new required migration and one extra round trip per call.

---

## D-020 — A refused request releases its hold; a timed-out one does not

**Date:** 2026-10-15
**Status:** Accepted

**Context:** Once a call holds a reservation, what should happen when it fails?
Charging nothing would let a timeout erase spend that may well have been billed.
Charging the full reservation unconditionally is also wrong: a 429 is the
provider REFUSING the request before processing it, so nothing was consumed — and
during an outage a burst of refusals would drain the day's budget and turn a
provider problem into a self-inflicted `BUDGET_EXHAUSTED`.

**Decision:** The charge follows billability, not the outcome label. Reported
usage is always charged. With no report: a provider rejection
(`rate_limited`) releases the hold at zero and is labelled
`failed_not_billable`; anything ambiguous — a timeout, a network failure, a
successful call that reported no metadata — keeps the reservation as the charge.
`notBillable` is therefore only ever set for an explicit rejection, and the
parameter is named for the claim it makes rather than for the failure it
accompanies.

**Consequence:** The settle function carries one extra boolean, and the pipeline
must know which failures are rejections. In exchange, neither direction of error
is silent: no timeout can under-count, and no outage can drain the budget.

---

## D-021 — Health reports the guard that is actually in force, not the budget value

**Date:** 2026-10-15
**Status:** Accepted

**Context:** `runtime.spendGuard` was computed as `dailyTokenBudget <= 0`. That is
one way to be blocked and it missed the others. A turn now reserves capacity
atomically before it is sent, so admission is also impossible when the ledger
cannot be read or when migration 0003's reservation objects are absent. In that
state the endpoint reported `permitted` while the answer path refused every turn,
and [DEPLOY.md](DEPLOY.md) tells an operator to trust exactly this field — so it
could send someone hunting a provider fault that was really a missing migration.
This is the same class of overclaim as the old `database.reachable` probe, which
returned true for a 401.

**Decision:** `spendGuard` answers one question: would the next provider call be
admitted? It is derived from every refusal path — a non-positive budget, an
unreadable ledger, or missing reservation objects — and a memory ledger (which
needs no reservation objects because it holds capacity in the process) is blocked
only by the budget. `runtimeAi.reachable` remains `null` regardless: guard state
is not the same claim as provider availability, and only `pnpm smoke` establishes
that.

The same reasoning was applied to the second surface that reports spend. The turn
response's `guard.spentTokensToday` initialised to `0` and so reported "nothing
spent today" in exactly the state where the day's spend is unknown — the refusal
it accompanied was `BUDGET_EXHAUSTED` *because* the total could not be read. It is
now `null` in that case, matching `runtime.spentTokensToday` on the health
endpoint. `null` means unknown; `0` means measured and zero.

**Consequence:** On the current revision health reports `ok: false`,
`durableLedger: "unreadable"` and `spendGuard: "blocked"` together, and a refused
turn reports `spentTokensToday: null` — which is what the answer path actually
does. Neither field can disagree with behaviour any more.

---

## D-022 — A course id that cannot be a uuid is "not found", not a server error

**Date:** 2026-10-15
**Status:** Accepted

**Context:** `courses.id` is a uuid, so `GET /api/v1/courses/not-a-course/scope`
made PostgreSQL reject the value with error 22P02
(`invalid_text_representation`) before any row could be considered. The gateway
turned that into a `StoreFailure`, and because every route checks the course
*before* anything else, the client received **HTTP 500** — a server fault for a
client mistake, which also tells the caller an internal failure occurred.
`docs/evidence` previously recorded a 404 for this case, so the earlier claim was
wrong and is superseded by the recorded 500.

**Decision:** Translate 22P02 into "no such row" at the gateway, and only that
code. A value that cannot be cast to the primary key's type cannot identify a row,
whereas a connection failure, a permissions error (42501) or a missing table must
still surface as a failure — mapping those to "not found" would hide a broken
deployment behind a 404. Verified against the live database that a malformed id
returns 22P02 and a real id returns no error at all.

**Consequence:** The three course endpoints answer 404 for a malformed or unknown
id. Tested in `tests/retrieval-eligibility.test.ts`, including the 42501 case that
must still throw.
