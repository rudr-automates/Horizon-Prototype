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
| Supabase migrations (schema + search RPCs) **authored** | ✅ (not applied) |
| Database schema applied remotely | ❌ blocked — verified absent via three read-only checks; see [apply-migration.md](docs/apply-migration.md) |
| Runtime AI configured / live smoke test | ❌ blocked — no credential available |
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
```

The canary writes raw responses only after checking that no configured
credential value appears in them. It reports blocked cases as `NOT RUN`, never
as passing.

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
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | server tasks; bypasses RLS |
| `HORIZON_LLM_PROVIDER` | **server only** | `google-genai` |
| `HORIZON_LLM_BASE_URL` | **server only** | optional endpoint override; empty is normal |
| `HORIZON_LLM_API_KEY` | **server only** | provider key (`GOOGLE_API_KEY`/`GEMINI_API_KEY` also accepted) |
| `HORIZON_LLM_MODEL` | **server only** | frozen model id (`gemini-3.6-flash`) |
| `HORIZON_EMBEDDING_MODEL` | **server only** | `gemini-embedding-001` |
| `HORIZON_EMBEDDING_DIMENSIONS` | **server only** | `768`; must match the stored vectors |
| `HORIZON_LLM_MAX_OUTPUT_TOKENS` | server | output cap per call |
| `HORIZON_DAILY_TOKEN_BUDGET` | server | hard stop; `0` permits no calls |
| `HORIZON_LLM_TIMEOUT_MS` | server | per-request provider timeout |

Never prefix a secret with `NEXT_PUBLIC_`. Never commit `.env.local`.

---

## Database

The schema and the search functions are authored at
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) and
[`supabase/migrations/0002_search_functions.sql`](supabase/migrations/0002_search_functions.sql)
and are **not applied**. Follow [docs/apply-migration.md](docs/apply-migration.md)
to apply them through the Supabase Dashboard SQL Editor and verify the result.

Until then the app uses the labelled fixture corpus, and `/api/v1/health` keeps
reporting the database as unconfigured. Nothing pretends otherwise.

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
pnpm test       exit 0   98 tests, 9 files
pnpm build      exit 0
pnpm canary     exit 0   24 checks passed, 3 not run (no credential)
```

Live checks against `next start` on `127.0.0.1:4321`: health, courses, scope at
five playheads, and the question endpoint before and after the canary unlock
time. All model-dependent tests are **mocked**, not real inference.

Every case, its evidence kind, its actual result and everything that was **not**
run is recorded in [docs/EVALUATION.md](docs/EVALUATION.md).
