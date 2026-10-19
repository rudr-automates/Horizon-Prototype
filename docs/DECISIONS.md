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
migration was not applied and the demo corpus was a fixture with no course row.

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
**Status:** Accepted. **Migration `0003_atomic_budget.sql` was applied on
2026-10-15**, and the atomicity it provides is verified against the real database
(`pnpm verify:budget`: 12 concurrent reservations against a 4-slot budget granted
exactly 4; 12 concurrent embedding admissions bound at exactly 3; cleanup
complete).

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

---

## D-023 — Generation runs on Groq; generation and embedding credentials are separate

**Date:** 2026-10-15
**Status:** Accepted. **No live Groq call has been made.** The adapter is covered
by mocked tests only, and the account's limits are therefore unknown.

**Context:** Generation was locked to Google, and one credential served both
generation and embeddings. That was only ever safe because both calls happened to
go to the same vendor. Moving generation to Groq's OpenAI-compatible API breaks
that coincidence: a single shared name means either a Groq key sent to Google's
embedding endpoint — a guaranteed 401 that presents as an outage — or a Google key
sent to Groq. Meanwhile the persisted corpus was embedded with Google's model, and
cosine comparison against vectors from a different model is meaningless, so
embeddings could not simply move with generation.

**Decision:** The provider is selectable (`groq`, `google-genai`, or reported as
unrecognised rather than guessed). `HORIZON_LLM_API_KEY` is the **generation**
credential and `HORIZON_EMBEDDING_API_KEY` is the **embedding** credential.
Resolution falls back to `GOOGLE_API_KEY` / `GEMINI_API_KEY` for embeddings, and
to `HORIZON_LLM_API_KEY` for embeddings **only when the generation provider is
Google**, where that key is known to be a Google credential. The reverse never
happens. Groq is called with plain `fetch` — no SDK — so one logical call is
visibly one HTTP request, retries are structurally absent, and usage is mapped
exactly once: Groq's Chat Completions usage reports no separate reasoning count,
so `thoughtsTokens` stays `null` rather than being derived from
`completion_tokens` and double-billing every reasoning token.

**Consequence:** A credential in the wrong variable fails at startup diagnostics
rather than as a confusing 401, and `GET /api/v1/health` reports
`embeddingCredentialPresent` and a `configurationProblems` list, because
"configured for generation" and "able to embed" are different facts. The cost is
two settings to keep straight and one more place where a silent fallback would
have been convenient; `tests/env-credentials.test.ts` covers both directions of
the rule, including the legacy single-key setup that is still supported under
`google-genai`.

---

## D-024 — A corpus that cannot be embedded into the same space is refused

**Date:** 2026-10-15
**Status:** Accepted

**Context:** With the embedding credential missing, the provider bundle falls back
to the offline lexical embedder. For the labelled sample fixture that is
self-consistent — it embeds both the documents and the question — so it is
correct. For the database-backed corpus it is not: those vectors came from
Google's model, and comparing a lexical vector against them does not fail, it
returns a ranked list that is simply noise. Nothing downstream could tell: the
eligibility predicate still held, claims were still grounded in what was
retrieved, quotations still matched, citations still resolved. The only thing
wrong would have been that the evidence was never really retrieved.

**Decision:** Refuse the turn (`EMBEDDING_UNAVAILABLE`) when the evidence store is
database-backed and no real embedding credential is configured. The guard keys on
the **store**, not on the embedder alone, and it runs before the embedding request
is claimed and before any store read — so the refusal costs nothing.

**Consequence:** A deployment cannot silently degrade its own recall while looking
healthy. The cost is that an operator who loses the embedding key sees a refusal
rather than a degraded-but-running app, which is the intended direction:
`tests/embedding-credential-guard.test.ts` asserts 0 embedder calls and 0 store
reads on refusal, and asserts that the same store proceeds normally once the
credential exists.

---

## D-025 — The interface states its own colours, and the layer it depends on

**Date:** 2026-10-15
**Status:** Accepted

**Context:** The page declared `color-scheme: light dark` and set no background
and no text colour. Both were therefore chosen by the browser, from different
places: the surface was the document default, while the text resolved through the
UA's dark-palette `CanvasText` — white. The result was white text on a white page,
with only the few elements carrying explicit colours legible. Under a dark OS it
rendered differently again — a `#121212` canvas measuring 93.56% of the pixels —
which is why the same file was reported differently by different people. Neither
build nor lint nor a DOM dump can see this class of defect: the markup is
perfectly correct and every element is present.

**Decision:** The application ships **one** deliberate light theme.
`color-scheme: light` only, with `background-color` and `color` declared on both
`html` and `body`, so no UA default and no `prefers-color-scheme` value can invert
the page. Components state their own colours and never dim text with `opacity-*`,
which multiplies an already-wrong colour. Base rules stay inside the cascade layer
system: CSS written outside every `@layer` outranks Tailwind's `@layer utilities`,
so an unlayered `button { color: inherit }` silently beat every `text-*` utility on
the Ask button (measured at 1.24:1, dark on blue). Tailwind's preflight already
does that job in `@layer base`.

**Consequence:** Legibility no longer depends on the host's appearance settings,
and the defect class has a guard: the fix was verified by pixels and by contrast
ratios measured in the live page (heading 20.49:1, label 19.3:1, Ask button
14.45:1) at 1440px and 390px. The cost is that genuine dark-mode support is now an
explicit future decision rather than something the browser does by accident —
which is the point, because it was doing it wrongly.

## D-026 — A figure shown beside a cap comes from the store the cap is counted in

The status panel read `EMBEDDING REQUESTS 0 made · cap 10` while the database held
one embedding request for that UTC day. The field came from a counter in the
server process, which returns to 0 on every restart, and it sat in the same
payload as `embeddingCapMode: "supabase"` — a cap counted in Postgres. Two
numbers were being shown as one, and the one a reader would take as "how much of
the cap is gone" was the one that forgets.

The obvious source for the correct figure is wrong, which is worth stating: the
admission function returns a **hardcoded** `used_today = 0` from its
`p_max_calls <= 0` branch, so the call that writes nothing is the call that
cannot report the count. Reading the count from an admission decision is now
documented in `types.ts` as something not to do.

**Decision:** Displayed usage is read through `UsageLedger.embeddingRequestsToday()`,
which counts in the same store the cap enforces in, with the same predicate, so
the figure reported and the figure enforced cannot drift. A failure to read it is
reported as `unknown`, never as 0: zero would understate consumption and make the
remaining allowance look larger than it is. The process-local counter is still
reported and is still shown, but only — and explicitly — when the cap really is
process-local.

**Consequence:** The panel and the cap now agree by construction rather than by
coincidence, and the divergence is one live turn away from being visible: after a
further turn the durable count read 2 while the process counter read 1. Every
other diagnostic on that panel is read the same way — `spentTokensToday` comes
from the ledger, the guard comes from the answer path's own derivation — so this
removes the last figure that was describing a different thing from its label.

## D-027 — A verification command must be reproducible on a system that has been used

`pnpm verify:budget` hardcoded `cap 3, expect 3 grants` for its embedding half.
That is correct on an empty ledger and wrong on any day the application actually
ran, because the cap counts the day's rows across all providers; it reported
`FAIL — expected 3 grants, saw 2` while the cap was behaving exactly as designed.
The token half of the same script had always derived its budget from the live day
total, so the script disagreed with itself about how to state an expectation.

Separately, `pnpm verify:data-path` proved "nothing was spent" with the ledger
token total — durable, but blind to embedding requests, which carry no tokens —
and a process-local counter that resets with the script. Both read `0 -> 0` on a
day the ledger held one real request, so a correct run printed a line a reader
could take as a claim about the day.

A verification command that fails on a used system trains its reader to ignore
it, which is worse than not having it.

**Decision:** Expectations are derived from the state actually measured at run
time, never from a constant that assumes a fresh environment. Checks assert the
relationship they depend on — grants equal the remaining allowance, rows added
equal grants — so a predicate that drifts from the function it mirrors fails
loudly instead of mis-calibrating quietly. Where a claim is about durability, it
is checked against the durable store; a process-local instrument may support such
a claim only if it is labelled as covering that process.

**Consequence:** `pnpm verify:budget` passes on a used ledger (verified twice:
`1 -> 4 (3 added)`, cleanup complete, day total 913 before and after) and
`pnpm verify:data-path` now prints the real figure — `embedding requests recorded
for 2026-10-15 1 -> 1` — which is what its claim needed to say. The cost is that
these scripts now depend on the ledger being readable to make their strongest
statement, and an unreadable count makes the data-path check **fail** rather than
pass vacuously.

## D-028 — A harness asks the server which course it serves

**Context:** The first live canary against the database-backed server reported four
FAILs, and every request had been answered
`NOT_FOUND — "That course was not found."` `scripts/canary.ts` addressed the
course by `DEMO_COURSE.courseId` (`course_demo_retries`) — the id that names the
**fixture** corpus. The seeded database serves the same lesson under the UUID the
seed assigned it, so the harness asked a database-backed server for a course that
exists only in the fixture, and the eligible-set checks compared `-1` against an
oracle. Every earlier canary pass in this project ran against a **fixture-backed**
server, which is why the assumption had never been exercised.

This was worth a decision rather than a one-line edit because of how it reads. A
harness whose own addressing is wrong reports missing pages, empty payloads and
failed checks in exactly the shape a broken application would, so those four FAILs
were one step from being written down as an app defect. The instrument failed, not
the thing measured.

**Decision:** A verification harness resolves identifiers from the system under
test rather than from a constant compiled into the harness. `scripts/canary.ts`
reads the server's own `/api/v1/courses`, prefers the fixture id when the server is
genuinely fixture-backed (so that mode is unchanged), accepts `--course <id>` as an
explicit override, falls back to the fixture id only when the list is unreachable,
and prints which of the three it used. No check, threshold or oracle was weakened
to make the run pass.

**Consequence:** Against the same server that produced the FAILs, the harness now
reports **18 passed, 0 failed, 9 not run**, with real answers and citations. The
failed artifact is kept in `docs/evidence/` so the before and after are auditable
rather than asserted. The 9 NOT RUNs are a real limit and stay labelled as such: a
fixture-text oracle cannot check citations in a database corpus, so those were
verified separately against `public.blocks` (3 of 3). The cost is one extra HTTP
request per run, and a harness that now depends on the course list being reachable
in order to identify its own target.

## D-024 — The recording's own captions are the evidence, ingested verbatim

Part 08 concluded that no answer may cite the lesson recording, because no
transcript existed for it. The recording's source publishes an automatic English
caption track, so a transcript did exist; what did not exist was any attempt to
fetch it. Writing one by hand was never an option: a transcript this project
composed would be a different text from the recording, and no quotation could be
attributed to the audio.

**Decision:** The video's own captions (`json3`, with the timestamps the source
reported) are fetched, parsed, segmented and ingested **verbatim**, in a course of
their own, with `parser_version: youtube-json3-v1` and `extraction_coverage`
computed from the caption track. Not one word is corrected, and the ASR's errors
(`Chachib`, `Enthropics`) are stored as they are. Because this is machine
transcription, `review_state: AUTO_APPROVED` — not `HUMAN_APPROVED` — and the
interface states the provenance and the caveat beside the player and inside every
citation panel. Coverage is reported as 99.6% rather than "complete", because 12.8 s
of the recording has no caption text.

**Consequence:** Video-grounded Q&A is now available and cited, and its honesty cost
is visible rather than hidden. The alternative — a cleaned-up transcript — would
have read better and been unattributable.

## D-025 — A block unlocks at its END, not at its start

`unlock_seconds` could plausibly be either end of a block's span. Using the start
makes a passage eligible the instant the playhead reaches it, which hands a learner
evidence from a part of the recording they have not watched — the leak this project
exists to prevent. Using the end is stricter and costs a lag of at most one block
(~60 s) in what can be cited.

**Decision:** `unlock_seconds = end_seconds`. A block becomes eligible only once the
learner has watched it to its end, and the interface says exactly that next to the
playhead and above the question box. The ingest command asserts the equality on
every row and reports the count of rows where it does not hold (0), and the plan
builder refuses blocks whose spans overlap.

**Consequence:** The eligible count starts at 0 and lags the playhead by up to a
block; at 00:03 the panel honestly reads "0 eligible transcript blocks". Leakage is
impossible by construction rather than by convention, and the canary checks the
outcome at four positions.

## D-026 — The generation envelope's bounds are memory bounds, not truth bounds

A live canary turn at an early timestamp returned
`TEMPORARILY_UNAVAILABLE / PROVIDER_MALFORMED`. The server log named the cause:
`claims:too_big`. The envelope accepted at most 8 claims, the model returned more,
and a question the evidence fully supported was reported to the learner as a
provider outage. The count of claims a model returns says nothing about whether its
answer is grounded: Tier-1 checks every quotation against the payload, Tier-2
verifies every claim, and only supported claims render.

**Decision:** Raise the claim bound to 40 and the verifier's verdict bound to 64
(above the claim bound, so an accepted response can always be answered
verdict-for-verdict), and raise the per-quote length bound to 1000 characters
because this corpus's blocks run to about 950 and a 400-character ceiling could
reject an *honest* quotation. Minimums that do encode truth are unchanged: a claim
with no evidence id is still refused.

**Consequence:** The same turn now answers with 14 verified claims, 0 of whose
quotations or ids fail their checks. The stricter-looking numbers were the less
honest ones: they made a working system report a false outage.

## D-027 — The health line reports a recorded call, never a configured one

`checks.runtimeAi.reachable` has always been `null` and should stay that way: the
endpoint sends no request of its own, so it cannot know whether a provider is
reachable. But the interface rendered that `null` as "not verified (a smoke test is
required)" — a sentence that never changed, so a deployment that had been answering
questions for hours looked identical to one nothing had ever been sent to.

**Decision:** Add `runtime.providerCallEvidence`, read from the durable usage
ledger: the newest **settled, reported** generation row (`outcome = 'reported'` is
the load-bearing filter, so a reservation charged after a failed call cannot be
mistaken for a success), with its timestamp and whether it falls inside the current
UTC day. Four states stay distinct — `observed`, `none_recorded`, `not_durable`
(the in-memory ledger keeps no durable record of past calls) and `unreadable` — and
nothing is ever inferred from configuration. The line is rendered verbatim rather
than as a yes/no badge, so "it worked yesterday" cannot read as "it works now".

**Consequence:** The panel now reads
`yes — A completed call is recorded at 2026-10-16T19:06:58Z (groq / openai/gpt-oss-20b, verify), which is inside today's UTC day.`
A wrong or revoked credential reads `none_recorded` however healthy its names look.

## D-028 — A control labelled Play plays, and a seek never implies playback

The citation panel offers **Play this passage** next to the passage a claim cites.
It seeked to `startSeconds - 3` and stopped, so clicking a button that says *Play*
left a still frame, and the one control that could take a learner to the evidence
did not do what its label said.

**Decision:** Playback intent travels with the seek request as an explicit flag,
set only by this button; the slider and the preset jumps keep requesting a seek
alone, so scrubbing cannot start playback behind the learner's back. The flag is
also the reason the seek must settle first: requesting `play()` in the same tick as
the `currentTime` assignment makes Chromium abort the play (`AbortError`) and leave
the element paused — the fix that only added a `play()` call looked identical to
the defect from the outside.

**Consequence:** The button now seeks and plays, and the panel's clock follows the
player to the passage. A browser that still refuses to start playback is reported
under the player rather than silently showing a still frame. Measured live in
EVALUATION.md Part 09 (P9-8).
## D-029 — A claim is a sentence, and the payload is bounded

A live turn at 05:00 was refused although the transcript supported it. The generator
had returned fourteen one-word claims ("Prompt engineering", "Context", "Windows", …),
each with the same verbatim list quotation. Tier-1 accepted them all, the verifier
rejected the turn, and the learner saw a refusal for material the recording plainly
covers.

**Decision:** the claim contract now says what a claim IS — one complete, self-contained
sentence that answers part of the question, at most five of them — and the verifier is
told that restating an item from a list in the evidence counts as support. Separately,
the prompt was bounded: 1,500 characters per block (Tier-1 still checks quotations
against the FULL stored block, so truncation cannot weaken it) and at most five claims
verified per turn. Overflow beyond five is dropped before verification, and dropping it
is deliberately NOT reported as a partial answer: the cap is a spend bound, and making
`ANSWERED_PARTIAL` mean both "the evidence only supports part" and "the model was
verbose" would empty the state of meaning.

**Consequence:** the same question, same four blocks: 2 claims instead of 14, 1,379 +
926 prompt tokens instead of roughly 3,200 + 4,074, and a cited answer instead of a
refusal. Measured in EVALUATION.md P10-2.

## D-030 — Documents are ingested in one of two modes, and the lint can refuse

A PDF or deck added to a course has to be either explicitly permitted reference
material or evidence tied to a moment in the recording, and those are different
promises. `--mode reference` writes `COURSE_WIDE` + `HUMAN_APPROVED` (the only
combination the predicate accepts at every playhead); `--mode aligned` writes
`TIMELINE_BOUND`, auto-approved only above a confidence floor and a margin over the
best non-adjacent stretch, otherwise `PENDING` with a null unlock time — which the
predicate makes ineligible, so a weak guess can never become evidence by itself.

**Decision:** the reference path runs the blueprint's course-wide lint and REFUSES to
write an approved document that contains a registered late-only fact or aligns to the
last fifth of the recording. Overriding requires `--acknowledge "<reason>"`, which
writes `ACKNOWLEDGED` rather than `PASSED`, so the row records that a human took the
risk instead of claiming the lint found nothing.

**Consequence:** the study guide was approved only after the lint found none of the
late facts in it; the deck's slide that does quote the threshold stayed `TIMELINE_BOUND`
and therefore unlocks only where the recording reaches it. A document that trips the
lint is not silently approved — the command fails and writes nothing.

## D-031 — Alignment looks for a stretch, and a zero score is no match

Two defects, both found by reading the tool's own output rather than by a failing
assertion:

1. a chunk about Kubernetes ingress, absent from the recording, aligned to window 0
   with score 0 and inherited that window's 60-second unlock — a fabricated timestamp;
2. a comparison slide summarising seven minutes scored 0.90 against one 60-second
   transcript block yet reported a margin of −0.25, which is incoherent: it means a
   stretch of the recording outside the "winner" covered the slide better.

**Decision:** a zero score returns no match (`bestIndex: -1`, `unlockSeconds: null`),
and alignment grows the shortest contiguous RUN of transcript blocks that covers the
chunk, choosing the best run over all seeds. The run only extends on a gain of at least
10% of the chunk's content words (minimum two), because every extra block moves the
unlock later and would withhold material the learner has already reached. `unlockSeconds`
is the END of the run: a slide that summarises a section becomes available when the
last of that section has been watched.

**Consequence:** the deck moved from 1 auto-approved / 8 pending to 7 / 2, and the two
that remained were the title slide (0.07) and the genuinely multi-topic slide
(0.90 with a 0.00 margin) — the cases the blueprint says a human should decide.

## D-032 — No upload control, because there is no authentication

The blueprint's instructor journey starts with "upload/register course resources", and
this build has no auth, no per-user ownership and no private object storage. An upload
endpoint in that state is either an unauthenticated write into a shared database or a
control that reports success without persisting anything.

**Decision:** resources are registered by an operator command (`pnpm ingest:resource`)
that validates the file by magic bytes and size, caps pages, slides, ZIP entries and
decompressed size, refuses a container that is not a presentation, embeds in bounded
batches against the durable request cap, and reads every written row back. The
`storage_key` column records the file's private local path; nothing is served over
HTTP.

**Consequence:** the demo has real PDF/PPT evidence with real provenance and no
unauthenticated write path. A browser upload surface waits for authentication, which is
listed as missing rather than approximated.

## D-033 — The deployment is public deliberately, and the recording is absent by design

The Vercel project had deployment protection on, so every URL — including the API —
returned Vercel's SSO page to an anonymous visitor. A judge cannot evaluate that, and a
private preview is not "deployed" in any useful sense.

**Decision:** protection is switched off for this project, production environment
variables are pushed from the operator's `.env.local` over stdin (never printed, never
committed), and the 235 MiB recording is excluded from the upload by `.vercelignore`.
The host therefore plays the original YouTube embed, and `GET /api/v1/lesson/video`
answers `404` there — which is the documented fallback, not a defect to "fix" by
committing third-party video.

**Consequence:** verified on the deployed origin: home `200`, health `ok: true` with a
real authenticated read, evidence from Supabase, scope 10/20/66, the embed present with
the correct video id and origin, and no application error in the console.

## D-034 — A diagnostic that bypasses the ledger is a guard bypass

The first diagnostic called the generator and verifier directly to see the raw claims,
which was the right instrument and the wrong path: it spent roughly 11,500 tokens that
the durable ledger never saw, because only the pipeline reserves and reconciles. The
recorded 15,052 for the day understates real usage of about 26,500.

**Decision:** recorded in EVALUATION.md P10-7 rather than quietly dropped, and future
diagnostics must run through the metered path (or be added as a metered script) so the
number an operator reads is the number the provider charged.

**Consequence:** the ledger is still the authority for the pipeline's behaviour, but it
is not an account-level meter, and it is now documented as such.

---

## D-035 — The interface is five surfaces on one position, and diagnostics moved rather than multiplied

**Context.** A single 1,366-line page held the player, the scope count, the
assistant, the transcript disclosure, the materials disclosure and six runtime
cards. Every one of those was real, and together they read as an operator's
report. The most common question a first-time viewer asked was what they were
supposed to look at.

**Decision.** Split the page into five destinations — Learn, Materials, Notes,
Progress, System status — with a persistent rail and a five-column mobile nav.
The position, the eligible count and the eligibility rule stay adjacent to the
player, because they are the product. Health, ledger, schema and request
diagnostics move to System status, reading the same `/api/v1/health` payload the
old panel did. No fact was deleted; some facts were given their own address.

**Consequence.** The shell is a client component and the section is client state,
not a route. That keeps the player mounted while moving between Learn and
Materials, at the cost of shareable per-section URLs. If deep links are needed, the
section belongs in the query string and the player must be kept out of the
re-mount path.

## D-036 — Reading panes ask the store for eligible blocks, not for a slice computed in the browser

**Context.** The transcript and the document viewer need text. The obvious
implementation is one broad read plus a client-side filter by
`unlock_seconds <= playhead`. That would put future material in the browser and
make eligibility a presentation rule.

**Decision.** Two read endpoints — `/transcript` and `/resources/:resourceId` —
call `store.listEligible` with the requested playhead and return only what the
predicate permits. No unlock time, no future text and no future heading is
serialized. The transcript additionally returns the stored caption line breaks so
the pane can re-flow them without changing a word.

**Consequence.** The panes can lag the player by up to the five-second bucket the
client refreshes on, and cannot lead it. Within the existing trust model the
client asserts its own position; that is unchanged from the question path and is
now written down rather than assumed.

## D-037 — Personal data is browser-local, and progress separates coverage from resume position

**Context.** The blueprint asks for bookmarks, notes and progress. Horizon has no
authentication, and its own rules forbid implying a capability that does not
exist.

**Decision.** Bookmarks, notes and watched ranges live in `localStorage` behind a
small external store read with `useSyncExternalStore`. Every surface that shows
them says "saved in this browser". Progress keeps two numbers: watched coverage,
built from merged playback ranges, and the furthest position, which is a resume
point. A playback step longer than five seconds is a seek and is not counted as
watching.

**Consequence.** There is no cross-device sync, no reviewer identity and no
per-user authorization problem to get wrong. Clearing site data deletes the
record, and the page says so.

## D-038 — No instructor-review interface without an identity to review as

**Context.** The review workflow is real: `review-alignments.ts` lists pending
alignments, approves with an unlock time and rejects with a reason, and the
resulting rows change what is eligible. A UI would be straightforward.

**Decision.** Do not build it. Every route in this app is public and there is no
authentication, so an approve button in the browser would let any visitor change
what every learner can cite. The capability stays a CLI, and the limitation is
reported in the readiness matrix instead of being papered over with a disabled
button.

**Consequence.** A judge cannot see the review step in the product. The materials
library shows the *result* of review (pending counts, rejected counts, policy
labels), which is the part that affects learning, and the CLI is recorded in
EVALUATION.
---

## D-039 — Home is a real route, and the studio moved to `/learn`

**Context.** `/` rendered the studio directly. A first-time visitor saw a lesson
player, an evidence count and an ask box, with no statement of what the product
does. The product's promise was legible only after using it.

**Decision.** Move the studio to `/learn` unchanged in behaviour and make `/` a
welcome page built from the live course catalogue and this browser's own saved
progress. Home makes **no** model call, so landing on the product costs nothing
against the daily budget, and every action it offers leads to a surface that
exists.

**Consequence.** Every existing link, bookmark and document that named the studio
root now names Home. The shell carries a Home item on both desktop and mobile, and
the breadcrumb starts at `Horizon`, so the workspace is one click from the front
door in either direction. The alternative — a marketing page with fabricated
social proof — was rejected: the numbers on Home are the store's own courses and
the browser's own progress, and nothing else.

---

## D-040 — Midnight Aurora: one dark theme with recorded contrast ratios

**Context.** The first revision shipped a light theme whose only stated defence
was that one theme is simpler than two. That is true, but it left the palette
unexamined: `text-white` on a mid-blue button read at about 2:1, and secondary
text was dimmed with opacity rather than a token.

**Decision.** One dark identity, stated once in `@theme`, with the measured
contrast ratio of every ink and status token recorded beside its value, and filled
controls using `text-ink-inverse` rather than white. Glass is a component-layer
class applied to chrome and the hero only; all reading surfaces stay opaque.

**Consequence.** The palette can be changed against numbers rather than
impressions, and a reviewer can check the claim on the token instead of trusting
the screenshot. It also means a light theme is a real project (every pair
re-measured, and a QA pass per preference) rather than a toggle, which is why it
is not offered.

---

## D-041 — Deep links carry the lesson, the surface and a real resume position

**Context.** The studio's lesson switch and five surfaces were local component
state. A link could not open a surface, a refresh dropped both, and a learner
returning to a 56-minute recording had to find their place by hand even though the
browser already knew it.

**Decision.** Read `?lesson=`, `?section=` and `?start=` on the server so the
first paint is the right one, write them with `history.replaceState` so the
address stays shareable and refresh-survivable without a history entry per tab
click, and apply `?start=` on the player's first clock report — then remove it from
the address.

**Consequence.** Back from the studio still goes Home, a lesson link can be shared
with the position it was taken at, and a seek is never applied twice. Applying the
position on mount instead was rejected after checking: a range write before the
element has metadata is discarded by the browser, which would have produced a
resume control that resumes nothing.

---

## D-042 — The transcript, citations and answers stay on opaque surfaces

**Context.** Glass is the identity's most distinctive device, and the easiest one
to over-apply: a translucent transcript or citation card looks striking in a
screenshot and is measurably worse to read for forty minutes.

**Decision.** Glass is limited to the navigation rail, the top bars, the hero card
and floating chrome. Panels that carry text a learner reads — transcript,
citations, answers, resource pages, forms, tables — keep an opaque surface, and the
rule is written in `globals.css` where the tokens are defined.

**Consequence.** The two treatments have to coexist, so the shell reads as
layered glass over a midnight field while the working area reads as a document.
That contrast is the point: the atmosphere belongs to the frame, not to the
material being studied.

---

## D-043 — Admission happens before parsing, and the public health payload got smaller

**Context.** The Phase 0 audit found the question endpoint reachable by anyone
with no per-client limit and no body-size limit, and found `/api/v1/health`
publishing the day's token spend, the budget, model ids, schema-object counts and
configuration problems to anonymous callers. It also found the materials library
counting availability with its own copy of the eligibility rule, which omitted the
`lint_status` check for course-wide blocks.

**Decision.**

1. **The library counts with the canonical predicate.** `summarizeResources`
   (`src/lib/presentation/resource-summary.ts`) calls `isBlockEligible`, so the
   materials list and the answer path cannot disagree. The regression case — an
   approved but FLAGGED course-wide block — now counts as zero.
2. **Admission precedes work.** `POST /questions` checks a declared oversized
   body, then a durable per-client limit, then reads the body through a
   16 KiB-capped stream, and only then validates the contract. A refused caller
   never reaches the pipeline.
3. **The limit is durable or it fails closed.** With a database configured, the
   limit is one atomic SQL statement (`0004`); if that statement cannot run, the
   route answers `503 RATE_LIMIT_UNAVAILABLE`. An in-process limiter is used only
   where no database is configured at all, i.e. where the spend ledger is already
   process-local — and the deployment reports itself as degraded there.
4. **No IP is stored.** The bucket key is `HMAC-SHA256(salt, day + address)`,
   scoped to one UTC day.
5. **Health has two readers, and the page gets the public one.** The public
   endpoint answers liveness and the data path. The Status surface receives
   `toPublicHealth(report)` — the same projection the endpoint returns — so a
   field the public contract does not declare cannot reach the browser through a
   page prop. The full report is available only at `/health/diagnostics` behind
   an operator token. Both halves come from one builder, so they cannot diverge.
6. **The client address is read from the header the platform overwrites.**
   Vercel documents that it overwrites `x-forwarded-for` from the TCP connection;
   its `x-real-ip` claim is only "identical to" that header, with no separate
   overwrite guarantee. `clientAddress` therefore reads `x-forwarded-for`
   (left-most entry) first and uses `x-real-ip` only as a fallback. Reading
   `x-real-ip` first would let a client that sets it mint a fresh bucket per
   request — the same as having no limit. Ports and IPv6 brackets are stripped so
   one client cannot split itself across buckets; the value is HMAC'd, never
   stored.
7. **Admission readiness is part of health.** The public report carries a
   boolean for whether a question could be admitted, because the answer path
   refuses before parsing when the limiter is missing. The probe calls
   `horizon_admit_request` with a deliberately invalid key, which the function
   rejects *before* touching the table, so readiness is established without
   claiming a slot, writing a row or consuming a counter. A missing function, a
   revoked grant, a missing table or a timeout all read as unavailable; a probe
   that guessed "ready" on an unknown error would be worse than no probe.
8. **Retention is an operator command, not a promise.** `request_rate_limits`
   does not prune itself and this repository schedules nothing. `pnpm
   prune:rate-limits` is dry-run by default and `--apply` deletes rows whose
   windows closed at least the retention period ago. The cutoff includes the
   widest configured window, so an active window can never be selected; that
   property is tested for every window, and every deleted row is re-checked.
   Docs say "manual" because it is manual.
9. **Turn sequencing retries a lost race.** A unique violation on
   `(conversation_id, sequence)` is recomputed and retried up to three times;
   after that the turn is reported as not stored rather than silently dropped.

**Consequence.** Promoting this code requires `0004` first. Without it the
endpoint refuses every question — the intended direction, because a limiter that
opens when it is broken is worse than no limiter. The Status page no longer
exposes spend figures, model ids, schema counts or configuration detail: it
renders the public projection only, and the detailed report needs the operator
token. The historical diagnostic bypass described in D-034 is unchanged and is
not claimed to be reproduced or fixed; no new diagnostic path calls a provider,
and `GET /health` remains read-only.

## D-044 — Authenticated accounts use owner-scoped learner storage

**Context.** The original browser-only decision in D-037 predates the account
foundation. PS1 requires learner identity and durable notes, bookmarks, progress
and a minimal profile.

**Decision.** Use Supabase email/password Auth with `@supabase/ssr` and session
cookies. Migration `0005_learner_accounts.sql` creates profile, progress,
bookmark and note tables with `auth.uid() = user_id` RLS. The browser keeps an
identity-namespaced offline copy and uses the session-bound `/api/v1/me/learning`
API for remote reads/writes. Guest data is not imported into an account without
an explicit user action.

**Consequence.** The schema and local API are in place, but end-to-end account
sync and two-user isolation remain unverified until safe test accounts are
available. Do not describe the implementation as proven cross-device sync.
