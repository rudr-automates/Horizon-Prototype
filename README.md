# Horizon

A timestamp-aware, evidence-grounded learning assistant. A learner pauses a
recorded lesson, asks a question, and receives an answer supported only by
content that is **permitted at their current position** — with citations — or an
honest refusal.

> **Repository state:** this is the **Part 01 foundation** only. It is a real,
> modular Next.js application with a truthful health endpoint and an authored
> (but not yet applied) database migration. The learner UI, ingestion pipeline,
> retrieval and answer path are **not built yet**.

---

## What actually works right now

| Capability | Status |
|---|---|
| Next.js app builds and runs | ✅ |
| `GET /api/v1/health` with honest config/connectivity reporting | ✅ |
| Canonical eligibility predicate (unit tested) | ✅ |
| Tier-1 deterministic claim checks (unit tested) | ✅ |
| Runtime AI adapter that fails closed (unit tested) | ✅ |
| Supabase migration with pgvector + FTS + RLS **authored** | ✅ (not applied) |
| Database schema applied remotely | ❌ (see [apply-migration.md](docs/apply-migration.md)) |
| Runtime AI provider configured | ❌ (no key, no smoke test) |
| Public deployment | ❌ (not attempted) |
| Learner UI / retrieval / answer path | ❌ (deferred) |

Scope decisions and deferrals are recorded in [docs/DECISIONS.md](docs/DECISIONS.md).

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
    api/v1/health/route.ts   # health endpoint
    layout.tsx, page.tsx     # minimal shell (NOT the learner UI)
  lib/
    answer/provider.ts       # runtime-model adapter boundary (fails closed)
    answer/verification.ts   # Tier-1 deterministic claim checks
    contracts/               # shared Zod schemas + domain vocabulary
    db/server.ts             # server-only Supabase access + reachability probe
    eligibility/predicate.ts # THE canonical eligibility predicate (TS + SQL twin)
    env.ts                   # presence-only env reader
    http/api.ts              # request id, ApiError, safe error envelope
supabase/migrations/0001_init.sql
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
| `HORIZON_LLM_PROVIDER` | **server only** | provider kind, once verified |
| `HORIZON_LLM_BASE_URL` | **server only** | provider base URL |
| `HORIZON_LLM_API_KEY` | **server only** | provider key |
| `HORIZON_LLM_MODEL` | **server only** | frozen model id |
| `HORIZON_LLM_MAX_OUTPUT_TOKENS` | server | output cap per call |
| `HORIZON_DAILY_TOKEN_BUDGET` | server | hard stop; `0` permits no calls |

Never prefix a secret with `NEXT_PUBLIC_`. Never commit `.env.local`.

---

## Database

The schema is authored at
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) and is
**not applied**. Follow [docs/apply-migration.md](docs/apply-migration.md) to
apply it through the Supabase Dashboard SQL Editor and verify the result.

---

## Status and honesty rules

This project follows a strict rule: **no feature, test, migration or deployment
is described as working unless an artifact proves it.** Where something is
unverified, the health endpoint, this README and `docs/` say so explicitly.
