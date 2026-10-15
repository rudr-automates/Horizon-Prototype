# Horizon

A timestamp-aware, evidence-grounded learning assistant. A learner pauses a
recorded lesson, asks a question, and receives an answer supported only by
content that is **permitted at their current position** — with citations — or an
honest refusal.

> **Repository state:** this is the **Part 02 vertical slice**. The learner
> interface, timestamp-scoped retrieval, claims-only generation, deterministic +
> model-assisted verification and safe refusals are built. Two things are still
> NOT true: **no Supabase migration has been applied** and **no runtime AI
> credential is configured**, so the answer path has never run against a real
> model. See [docs/DECISIONS.md](docs/DECISIONS.md).

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
| Database-backed retrieval, seeding and persistence | ❌ blocked — migrations are applied but no Supabase credential is configured, so the fixture corpus is still in use and `pnpm seed:demo` has never run |
| Live embeddings (`gemini-embedding-001`, 768d) | ✅ **real calls made** on the current revision — `pnpm smoke` |
| Live inference (`gemini-3.6-flash`) | ⚠️ real calls were made and recorded in an earlier revision; on the current revision generation is **429-blocked by the free-tier daily quota** with a ~15 h retry delay |
| Temporal eligibility end-to-end with a live model | ⚠️ 24 live checks pass on the current revision (eligibility, oracle cross-check, non-disclosure). The answer half is **NOT RUN** — refused by the quota, never counted as a pass |
| Cumulative daily token accounting | ✅ enforced at admission, per call, including billable **reasoning** tokens; the persisted row sums to the same figure the cap was checked against |
| SDK automatic retries | ✅ disabled (`attempts: 1`); they default to 5 |
| Embedding-request cap | ✅ enforced — it bound and refused during live testing |
| Spend guard (`HORIZON_DAILY_TOKEN_BUDGET`) enforced before any provider call | ✅ unit tested |
| Seed/ingestion path for the demo corpus (`pnpm seed:demo`) | ✅ implemented + unit tested; **never executed** against a live database |
| End-to-end canary harness (`pnpm canary`) | ✅ ran live; recorded in [docs/evidence](docs/evidence) |
| Turn persistence to a real database | ❌ reports `persisted: false` honestly |
| Public deployment | ❌ not attempted; procedure in [DEPLOY.md](docs/DEPLOY.md). No URL exists |
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

```jsonc
{
  "ok": false,
  "status": "degraded",
  "service": "horizon",
  "version": "0.1.0",
  "requestId": "…",
  "timestamp": "…",
  "checks": {
    "app":        { "configured": true,  "reachable": true,  "detail": "…" },
    "database":   { "configured": false, "reachable": null,  "detail": "Supabase URL/anon key not set." },
    "runtimeAi":  { "configured": false, "reachable": null,  "detail": "Runtime AI not configured; no model calls are possible." }
  }
}
```

> `database.reachable` proves only that the Supabase REST host answered. It does
> **not** prove the migration was applied or that any table exists.

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

**The database path is still not exercised.** Applying the migrations did not
configure the app: no Supabase name is present in `.env.local`, so
`/api/v1/health` correctly reports `database.configured: false`,
`evidenceSource` stays `fixture`, and `pnpm seed:demo` has still never run. For
that path to engage, all three of `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` must be set — the
configuration check requires the anon key even though the server writes with the
service role.

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
provider's own `retryDelay` and quota id (never content), and `/api/v1/health`
still reports `spendGuard: permitted` — this is not the budget refusing, and the
two must not be confused.

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
  **not applied**.

## Verified in this revision

```
pnpm lint       exit 0
pnpm typecheck  exit 0
pnpm test       exit 0   145 tests, 11 files   (all mocked)
pnpm build      exit 0
pnpm smoke      exit 1   1 live embedding call OK; generation refused by the provider (429, daily free-tier quota)
pnpm canary     exit 1   24 passed, 1 failed, 2 not run   (live; answer half quota-blocked)
```

Live checks against `next start` on `127.0.0.1:4321`: health, courses, scope at
five playheads, and the question endpoint before and after the canary unlock
time. All model-dependent tests are **mocked**, not real inference.

**No deployment has been performed and no public URL exists.** Every live check
was against loopback, and nothing here is a hosting claim.

Every case, its evidence kind, its actual result and everything that was **not**
run is recorded in [docs/EVALUATION.md](docs/EVALUATION.md).
