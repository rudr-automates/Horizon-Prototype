# Horizon

A timestamp-aware, evidence-grounded learning assistant. A learner pauses a
recorded lesson, asks a question, and receives an answer supported only by
content that is **permitted at their current position** — with citations — or an
honest refusal.

> **Repository state:** this is the **Part 02 vertical slice**. The learner
> interface, timestamp-scoped retrieval, claims-only generation, deterministic +
> model-assisted verification and safe refusals are built. **Both Supabase
> migrations are applied and a runtime AI credential is configured**, so the demo
> corpus now lives in the database with real embeddings and the database-backed
> retrieval path has run against it. What is still NOT true: **the answer path
> has produced no live answer on this revision** — the provider's free-tier daily
> generation quota refuses every call, so generation, verification and turn
> persistence remain unexercised. See [docs/DECISIONS.md](docs/DECISIONS.md).

---

## What actually works right now

| Capability | Status |
|---|---|
| Next.js app builds and runs | ✅ verified (`pnpm build`) |
| `GET /api/v1/health` with honest config/connectivity reporting | ✅ verified live |
| Learner UI: sample timeline, playhead, ask, citations, refusal states | ✅ verified live |
| Canonical eligibility predicate, TS + SQL twin | ✅ unit tested |
| Both retrieval branches filtered before ranking | ✅ unit tested (fixture + fake SQL gateway) |
| Rank fusion (RRF) with deterministic ordering | ✅ unit tested |
| Claims-only generator, Tier-1 deterministic checks, Tier-2 verifier | ✅ unit tested |
| Google Gen AI adapter (`gemini-3.6-flash`, `gemini-embedding-001`) | ✅ implemented, unit tested against the real SDK's own types |
| Supabase migrations (schema + search RPCs) | ✅ **applied** — six tables with RLS, pgvector `0.8.2` installed |
| Database-backed retrieval | ✅ **verified live** — with the corpus seeded, the store's `listCourses`, `getCourse`, `listEligible`, `searchFullText`, `searchVector` and `hasMatchingIneligible` all ran against Supabase, and `GET /api/v1/courses` + `/scope` serve those rows over HTTP |
| Live embeddings (`gemini-embedding-001`, 768d) | ✅ **real calls made** on the current revision — `pnpm smoke`, plus one batched call that embedded all 18 demo documents for the seed |
| Live inference (`gemini-3.6-flash`) | ⚠️ real calls were made and recorded in an earlier revision; on the current revision generation is **429-blocked by the free-tier daily quota** with a ~15 h retry delay |
| Temporal eligibility end-to-end with a live model | ⚠️ 24 live checks pass on the current revision (eligibility, oracle cross-check, non-disclosure). The answer half is **NOT RUN** — refused by the quota, never counted as a pass |
| Cumulative daily token accounting | ✅ enforced at admission, per call, including billable **reasoning** tokens; the persisted charge is the same figure the cap was checked against |
| Atomic budget admission across requests AND instances | ⚠️ implemented and unit tested (including concurrency tests), but **requires migration `0003_atomic_budget.sql`, which is AUTHORED AND NOT APPLIED** — see [apply-migration.md](docs/apply-migration.md#applying-0003-required). Until a human applies it the answer path fails closed: `BUDGET_EXHAUSTED` with `durableLedger: "unreadable"` |
| A refused call releases its hold; a timeout keeps it | ✅ unit tested — a 429 is the provider refusing before processing, so it charges nothing, while an unanswered call keeps its reservation rather than erasing spend |
| `GET /api/v1/health` separates authentication from reachability | ✅ **verified live** — reports `querySucceeded: true` (a real authenticated read) alongside `durableLedger: "unreadable"` and `ok: false`, i.e. it refuses to call a database healthy just because a request answered |
| Durable usage ledger (`public.usage_ledger`) | ✅ **verified live** — `spentToday()` reads the table and `record()` writes to it; a labelled probe row was inserted, read back (66 tokens: 11 prompt + 55 completion, reasoning folded in) and deleted, leaving the table empty again |
| SDK automatic retries | ✅ disabled (`attempts: 1`); they default to 5 |
| Embedding-request cap | ✅ enforced — it bound and refused during live testing |
| Spend guard (`HORIZON_DAILY_TOKEN_BUDGET`) enforced before any provider call | ✅ unit tested |
| Seed/ingestion path for the demo corpus (`pnpm seed:demo`) | ✅ **executed live** — 1 course / 6 resources / 18 blocks upserted on primary key, using 1 embedding request against a cap of 10 |
| End-to-end canary harness (`pnpm canary`) | ✅ ran live; recorded in [docs/evidence](docs/evidence) |
| Turn persistence to a real database | ⚠️ implemented and now selected when Supabase is configured, but **still unexercised** — a turn is written only after a successful generation, which the quota refuses. The unconfigured path still reports `persisted: false` honestly |
| Public deployment | ❌ not attempted; staged procedure and the four-part release gate are in [DEPLOY.md](docs/DEPLOY.md). **No public URL exists** |
| Ingestion (transcription, OCR, parsing) | ❌ deferred — the demo corpus is a fixture |

Scope decisions and deferrals are recorded in [docs/DECISIONS.md](docs/DECISIONS.md);
evaluation cases and their actual results are in [docs/EVALUATION.md](docs/EVALUATION.md).

---

## The learner flow

1. Open the sample lesson (a **labelled simulation**, not a real video).
2. Move the playback position. The scope chip reports how many evidence blocks
   are eligible *at that position*.
3. Ask a question. The server embeds it, runs full-text **and** vector retrieval
   — both filtered by the same canonical predicate — fuses the candidates, and
   re-asserts eligibility on the final payload.
4. The generator receives **only** that payload and returns structured claims
   that cite evidence ids. It never decides what is eligible, and it never owns
   the answer state.
5. Tier-1 deterministic checks reject unknown ids and non-verbatim quotes.
   Tier-2 model-assisted verification rejects claims the cited evidence does not
   support. Only surviving claims are rendered, with server-resolved citations.
6. If nothing survives, or nothing eligible exists, the learner sees a refusal.

Ask `What backoff constant does the instructor choose, and why?` at 06:00 and
again at 12:00 to watch the evidence scope change.

---

## API

| Route | Purpose |
|---|---|
| `GET /api/v1/health` | configuration vs connectivity, separately |
| `GET /api/v1/courses` | course list, plus which evidence store is in use |
| `GET /api/v1/courses/:courseId` | one course |
| `GET /api/v1/courses/:courseId/scope?playheadSeconds=` | eligible-block count at a position (never a syllabus oracle) |
| `POST /api/v1/courses/:courseId/questions` | the full answer path |

`POST /questions` returns HTTP 200 with `answerState`
`TEMPORARILY_UNAVAILABLE` when a provider is unavailable, because that is a
**domain** state the learner must see — not a transport error. The internal
state (`NOT_AVAILABLE_YET` vs `NOT_IN_MATERIALS`) is deliberately never
serialized; both collapse into `INSUFFICIENT_EVIDENCE`.

---

## Requirements

- Node.js 20+ (developed on Node 24)
- pnpm 12 (`packageManager` is pinned in `package.json`)

## Setup

```bash
pnpm install
cp .env.example .env.local   # then fill in real values (never commit them)
```

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Start the dev server on http://localhost:3000 |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest unit tests |
| `pnpm seed:demo` | Seed the labelled demo corpus into Supabase with real embeddings. Refuses, writing nothing, unless the migrations, the database credential and a real embedding provider are all configured |
| `pnpm canary` | Ask the canary question at 00:00, 06:00 and 12:00 against a running server and record the real responses to `docs/evidence/` |

```bash
pnpm canary --base http://127.0.0.1:4321 --label fixture-unconfigured
pnpm canary --base http://127.0.0.1:4321 --delay 45000   # space positions out
```

`--delay <ms>` waits between positions. Use it on a free tier: three turns back
to back can exhaust a per-minute request quota, and the resulting
`PROVIDER_RATE_LIMITED` turns the answer half of the run into `NOT RUN` — a limit
on the harness, not a finding about the app.

The canary writes raw responses only after checking that no configured
credential value appears in them. It reports blocked cases as `NOT RUN`, never
as passing, and reports a missing answer as a failure rather than a quiet skip.

## Health endpoint

`GET /api/v1/health` returns a structured response that keeps three things
strictly separate:

- **configured** — the required environment variable *names* are present.
- **reachable** — an actual probe succeeded (`null` means "not verified").
- **detail** — a human-readable note.

It never returns credential values, and it never reports a dependency as healthy
just because an env var exists. `runtimeAi.reachable` stays `null` until a real
smoke test is run.

The database check reports five separate facts, and `ok` is true only when they
all hold. This is the real payload for the current revision, in the state it is
actually in — migration `0003` not yet applied:

```jsonc
{
  "ok": false,
  "status": "degraded",
  "service": "horizon",
  "version": "0.2.0",
  "requestId": "…",
  "timestamp": "…",
  "checks": {
    "app":       { "configured": true, "reachable": true, "detail": "Next.js route handler responded." },
    "database":  {
      "configured": true,          // names present (URL + anon key)
      "reachable": true,           // kept in step with querySucceeded
      "urlConfigured": true,
      "credentialsPresent": true,  // the key the DATA PATH authenticates with
      "querySucceeded": true,      // a real authenticated read, not a ping
      "schemaObjects": "unknown",  // probe could not run yet
      "durableLedger": "unreadable",// the budget table cannot be read → fail closed
      "detail": "An authenticated read of the database succeeded; the schema probe could not run, which is expected until migration 0003 is applied; the durable budget ledger could NOT be read, so provider calls are refused."
    },
    "runtimeAi": { "configured": true, "reachable": null, "detail": "Names are present, but the usage ledger could not be read…" }
  },
  "runtime": {
    "evidenceSource": "supabase", "usageMode": "supabase", "embeddingCapMode": "supabase",
    "demoContent": false,
    "spendGuard": "blocked",   // admission is impossible while the ledger is unreadable
    "spentTokensToday": null   // null means UNKNOWN, never "nothing spent"
  }
}
```

Once `0003` is applied, `schemaObjects` becomes `"verified"`, `durableLedger`
becomes `"usable"`, `spentTokensToday` becomes a number, `spendGuard` becomes
`"permitted"`, and `ok` becomes `true`.

`spendGuard` answers one question: **would the next provider call be admitted?**
It is therefore computed from every refusal path — a zero budget, an unreadable
ledger, or missing reservation objects — not from the budget value alone. It used
to report `"permitted"` whenever the budget was positive, which was wrong in
exactly the state the deployment is in below: the answer path refuses every turn
while health claimed calls were allowed.

`runtimeAi.reachable` stays `null` because this endpoint makes no provider call:
the health response reports that names are *present*, never that the provider
works. Only `pnpm smoke` and `pnpm canary` establish that.

> `database.reachable` no longer means "some HTTP response arrived". It means an
authenticated read succeeded. It still does **not** mean the schema is complete or
that the budget ledger can be read — those are `schemaObjects` and
`durableLedger`, and both are reported separately for exactly that reason. The
anon key, for instance, authenticates and still gets `42501` on the public tables
because it holds no table-level `SELECT` grant.

---

## Project structure

```text
src/
  app/
    api/v1/health/route.ts
    api/v1/courses/route.ts
    api/v1/courses/[courseId]/route.ts
    api/v1/courses/[courseId]/scope/route.ts
    api/v1/courses/[courseId]/questions/route.ts   # the answer path
    page.tsx, layout.tsx
  components/learner-workbench.tsx                 # the learner interface
  lib/
    answer/gemini.ts         # official Google Gen AI adapter (generate + verify + embed)
    answer/pipeline.ts       # retrieve → guard → generate → check → verify → render
    answer/provider.ts       # claims-only model boundary + fail-closed errors
    answer/providers.ts      # provider bundle; null generator when unconfigured
    answer/synthetic-embedder.ts  # LABELLED offline lexical embedder (demo fallback)
    answer/verification.ts   # Tier-1 deterministic claim checks
    contracts/               # shared Zod schemas + domain vocabulary
    db/server.ts             # server-only Supabase access + reachability probe
    demo/lesson.ts           # SYNTHETIC sample corpus with a future-only fact
    eligibility/predicate.ts # THE canonical eligibility predicate (TS + SQL twin)
    persistence/turns.ts     # minimal turn records, honestly reported
    retrieval/*              # stores, lexical helpers, RRF fusion, citation labels
    server/context.ts        # per-request dependency assembly
supabase/migrations/0001_init.sql              # schema
docs/DECISIONS.md, docs/apply-migration.md
tests/                       # Vitest unit tests
```

The single most important invariant lives in
[`src/lib/eligibility/predicate.ts`](src/lib/eligibility/predicate.ts): one
predicate decides what is eligible, and it must be used by **every** retrieval
branch so an ineligible block can never reach the model.

---

## Environment variables

Names only; see [`.env.example`](.env.example).

| Name | Scope | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | Supabase anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | server tasks; bypasses RLS. Required by `pnpm seed:demo` along with the two names above — all three must be set before the database path engages |
| `HORIZON_LLM_PROVIDER` | **server only** | `google-genai` |
| `HORIZON_LLM_BASE_URL` | **server only** | optional endpoint override; empty is normal |
| `HORIZON_LLM_API_KEY` | **server only** | provider key (`GOOGLE_API_KEY`/`GEMINI_API_KEY` also accepted) |
| `HORIZON_LLM_MODEL` | **server only** | frozen model id (`gemini-3.6-flash`) |
| `HORIZON_EMBEDDING_MODEL` | **server only** | `gemini-embedding-001` |
| `HORIZON_EMBEDDING_DIMENSIONS` | **server only** | `768`; must match the stored vectors |
| `HORIZON_LLM_MAX_OUTPUT_TOKENS` | server | output cap per call; must exceed the reasoning budget or JSON gets truncated (default 4096) |
| `HORIZON_LLM_THINKING_BUDGET` | server | reasoning-token budget; unset sends nothing, `0` disables thinking |
| `HORIZON_DAILY_TOKEN_BUDGET` | server | cumulative daily token ceiling; `0` permits no calls |
| `HORIZON_MAX_EMBEDDING_CALLS` | server | ceiling on embedding REQUESTS per process; `0` = no cap |
| `HORIZON_LLM_TIMEOUT_MS` | server | per-request provider timeout |

The budget is cumulative and per-call: each entry carries prompt, completion **and
billable reasoning** tokens, and the row persisted to `public.usage_ledger` sums to
exactly the figure the admission check used — `prompt_tokens + completion_tokens` —
so the durable total and the enforced cap cannot drift apart. (The table has no
reasoning column, so the reasoning tokens are folded into `completion_tokens`
rather than dropped.)

**What the budget does not cover.** Embedding requests are not metered, because
that API reports no token usage. `HORIZON_MAX_EMBEDDING_CALLS` bounds their
*count*, not their cost. And when no database is configured the ledger is
in-memory, so the daily total resets on restart and is not shared between
instances. `/api/v1/health` reports `runtime.usageMode`, `spentTokensToday` and
`embeddingCalls` so none of this has to be guessed.

Never prefix a secret with `NEXT_PUBLIC_`. Never commit `.env.local`.

---

## Database

The schema and the search functions live at
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) and
[`supabase/migrations/0002_search_functions.sql`](supabase/migrations/0002_search_functions.sql).

**Both are applied to the connected project**, verified this session by read-only
inspection rather than inferred from a variable being set:

| Probe | Result |
|---|---|
| Tables in `public` | all six present (`courses`, `resources`, `blocks`, `conversations`, `turns`, `usage_ledger`), every one with RLS enabled |
| `pgvector` | installed, `0.8.2` |
| Search functions | `horizon_is_eligible`, `horizon_search_fts`, `horizon_search_vector`, `horizon_list_eligible`, `horizon_has_matching_ineligible` all present |
| Column-level schema | matches `0001_init.sql`: enums, check constraints, generated `fts` column and the `usage_ledger` foreign key all agree |
| Migration *history* | empty — the SQL was applied through the Dashboard editor, which does not record history. The schema, not the history table, is the evidence |

Two advisor findings, neither of which blocks the app:

- **RLS enabled with no policies** (INFO, all six tables). Every read and write in
  this app goes through the **service-role** client, which bypasses RLS; the anon
  key is used only to probe reachability. Deny-by-default is therefore the safe
  posture here, not a gap — but it does mean an anon-key client would correctly
  see zero rows.
- **Mutable `search_path`** on six functions (WARN). None is `SECURITY DEFINER`,
  so this is hardening rather than a privilege-escalation hole; pinning
  `search_path` is the recommended follow-up.

**The database path is now exercised.** All three names —
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` — are set, `/api/v1/health` reports
`database.configured: true` with `evidenceSource: "supabase"`, and
`pnpm seed:demo` has run: 1 course, 6 resources and 18 blocks with real
768-dimensional embeddings, confirmed by re-reading the rows. The configuration
check still requires the anon key even though the server writes with the service
role.

The migrations cannot fix the *answer* path, and did not: generation is blocked
by the provider's free-tier quota, so no live answer exists on this revision.

One consequence worth knowing: the anon key authenticates but holds no
table-level `SELECT` grant on the public tables, so a direct anon-key read fails
with `42501 permission denied`. That is consistent with the deny-by-default
posture above — the app never reads with the anon key, and the health "reachable"
probe only proves the host answered, not that the key can read anything.

### Enabling the real model path

With no credential the app cannot answer; it reports
`TEMPORARILY_UNAVAILABLE` for any question that has eligible evidence rather
than inventing a result. To enable real inference:

```bash
cp .env.example .env.local
# set HORIZON_LLM_PROVIDER=google-genai, HORIZON_LLM_MODEL and HORIZON_LLM_API_KEY=…
# set HORIZON_DAILY_TOKEN_BUDGET to a positive value — see the warning below
pnpm build && pnpm start
pnpm canary --base http://127.0.0.1:4321 --label configured
```

**A free-tier generation quota is separate from the budget and can run out.**
`gemini-3.6-flash` has a *daily* free-tier request allowance with its own reset;
when it is spent the pipeline returns `TEMPORARILY_UNAVAILABLE` with reason
`PROVIDER_RATE_LIMITED` and the provider reports a retry delay measured in
hours. Embeddings are a different quota and keep working, so a run can pass its
embedding checks and fail every generation. The server log now carries the
provider's own `retryDelay` and quota id (never content). This is **not** the
budget refusing: with a positive budget, a readable ledger and the reservation
objects in place, `runtime.spendGuard` still reports `permitted` while the
provider rejects the call, and the two must not be confused. `spendGuard`
describes the spend guard's own admission, not the provider's availability.

**`HORIZON_DAILY_TOKEN_BUDGET=0` is a real hard stop.** With the budget at zero
the pipeline sends no provider request at all — not even the embedding call —
and every turn returns `TEMPORARILY_UNAVAILABLE` with reason `BUDGET_EXHAUSTED`.
Set a positive value to permit inference. `/api/v1/health` reports
`runtime.spendGuard` so the state is observable rather than guessed.

The free-tier data-use terms must be accepted by the team first, and the demo
corpus must stay synthetic or team-authored.

---

## Status and honesty rules

This project follows a strict rule: **no feature, test, migration or deployment
is described as working unless an artifact proves it.** Where something is
unverified, the health endpoint, this README and `docs/` say so explicitly.

Specific consequences of that rule:

- The demo corpus is a **simulation**. There is no lesson video; `Horizon.mp4`
  is promotional material and is never presented as lesson content.
- The offline embedder is a lexical hash, not a semantic model. It is labelled
  `synthetic-lexical-v1` everywhere it is used, and it is only used when no
  embedding credential exists.
- The Tier-2 verifier is **model-assisted**, not independent. It reduces risk; it
  does not make the output infallible.
- Timings reported in the UI are measured for that single request. They are not
  benchmarks and no accuracy or latency claim is derived from them.
- A migration that has been written and unit tested is still reported as
  **not applied** until an artifact shows it applied. Both migrations cleared that
  bar on 2026-10-15, and the seed that followed is recorded in
  [docs/evidence](docs/evidence).

## Verified in this revision

```
pnpm lint         exit 0
pnpm typecheck    exit 0
pnpm test         exit 0   187 tests, 13 files   (all mocked, incl. the concurrency and health cases)
pnpm build        exit 0
pnpm seed:demo    exit 0   1 embedding request (cap 10) -> 1 course / 6 resources / 18 blocks, real 768-d vectors
pnpm verify:budget exit 1  refuses before writing a row: migration 0003 is not applied yet
pnpm verify:data-path exit 0  24 passed, 0 failed, 1 pending (0003) — real rows, zero provider calls
pnpm smoke        exit 1   1 live embedding call OK; generation refused by the provider (429, daily free-tier quota)
pnpm canary       exit 1   24 passed, 1 failed, 2 not run   (live; answer half quota-blocked)
```

The concurrency tests are unit tests over a shared ledger: they prove no two
turns can both hold the same budget, and that a refused turn reaches the provider
zero times. They **cannot** prove Postgres serializes admission — that is what
`pnpm verify:budget` does against the real functions, and it is the reason the
migration is a required human step rather than something this revision claims.

Live checks against `next start` on `127.0.0.1:4321`: `evidenceSource` and
`usageMode` are `"supabase"`; `GET /api/v1/courses`, the course detail route and
`/scope` all answer from Supabase (eligible-block counts 2 / 4 / 7 / 10 / 16
across playheads 0–900 s), a negative playhead returns 400 and an unknown course
404. The store's course, full-text, vector and eligibility reads were exercised
directly, as were both halves of the durable usage ledger (a labelled probe row was
written and then removed).

`pnpm verify:data-path` re-runs those reads against the **persisted** corpus and
records the output, without spending anything: it asserts that the locked fact is
absent from every eligible block at 0 s and present at 900 s, that full-text and
vector search both respect the boundary, that a block queried with its own stored
768-dimensional vector matches itself at distance 0, and that no `PENDING` or
`FLAGGED` block is returned — then proves the run changed neither the ledger total
nor the embedding counter. Its one out-of-band read is a single stored embedding,
because the app's own gateway deliberately does not select that column.

On the current revision the question endpoint **fails closed**: it returns
`TEMPORARILY_UNAVAILABLE` with `BUDGET_EXHAUSTED` and makes **no provider call at
all**, because the budget ledger cannot be read until migration `0003` is applied.
Health simultaneously reports `ok: false`, `durableLedger: "unreadable"` and
`spendGuard: "blocked"`, and the refused turn reports `guard.spentTokensToday` as
`null` rather than `0` — all three agreeing with what the answer path does, since
the refusal is caused by the day's spend being unknown.
That is the honest state of the answer path today, and it is deliberate: an
unreadable budget must never be treated as an unspent one. The pre-fix record of
that state is in
[docs/evidence](docs/evidence/db-path-verification-2026-10-15T09-28-15-146Z.json),
and the current revision's re-verification against the persisted corpus is in
[docs/evidence](docs/evidence/data-path-verification-2026-10-15T10-18-54-216Z.json).
All model-dependent tests are **mocked**, not real inference.

**No deployment has been performed and no public URL exists.** Every live check
was against loopback, and nothing here is a hosting claim.

Every case, its evidence kind, its actual result and everything that was **not**
run is recorded in [docs/EVALUATION.md](docs/EVALUATION.md).
