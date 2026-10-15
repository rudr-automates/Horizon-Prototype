# Evaluation record

**Read this as a log of what was actually run, not as a quality claim.**

This document spans two revisions. **Part 03 (below) is the current record**;
the Part 02 log is retained unchanged further down as history.

Three kinds of evidence appear below, and they are never mixed:

| Label | Meaning |
|---|---|
| **MOCKED** | The model boundary was replaced by a scripted fake. Proves the *pipeline* logic, proves nothing about model quality. |
| **SYNTHETIC** | Ran against the labelled sample fixture corpus and the offline lexical embedder. Proves *policy and eligibility* behaviour. |
| **LIVE** | Observed by hitting the running server over HTTP. |
| **NOT RUN** | Requires a runtime model credential that does not exist. Explicitly not claimed. |

There is no held-out accuracy number, no latency benchmark and no response-quality
metric in this document, because no real inference has been executed. A test that
was designed is not a test that passed.

---

# Part 03 — real integration, evaluation and release

**Date:** 2026-10-15 · **Baseline:** `e56bea7` · **Outcome: prerequisites missing, so the real integrations are BLOCKED. This section records exactly which.**

## P3-1. Prerequisite verification (read-only, executed)

Performed against the connected Supabase project. These are observations, not
inferences from an env var being absent.

| Probe | Tool | Result | Conclusion |
|---|---|---|---|
| `list_tables(public, verbose)` | read-only | `{"tables":[]}` | No table exists |
| `list_extensions` | read-only | `vector` present, `installed_version: null` | pgvector **not installed** |
| `list_migrations` | read-only | `[]` | No migration was ever applied |
| Local environment | `presence check, values never printed` | 0/13 names set; no `.env`, `.env.local` | No DB or provider credential |

**Conclusion: migrations `0001_init.sql` and `0002_search_functions.sql` are NOT applied.** The exact manual step is in [apply-migration.md](apply-migration.md). No write was attempted, because the MCP toolset exposes no `execute_sql` or `apply_migration`.

## P3-2. Canary results — 00:00, 06:00, 12:00 (LIVE, executed)

Run with `pnpm canary --base http://127.0.0.1:4321`, against a production build
with no credentials configured. Raw responses:
[canary-fixture-unconfigured-2026-10-15T07-27-39-380Z.json](evidence/canary-fixture-unconfigured-2026-10-15T07-27-39-380Z.json).

The numbers below are from a freshly bound server whose startup log was checked
for `Ready` and the listening socket confirmed on the expected PID. An earlier
pass was discarded because the replacement server had silently failed to bind
(`EADDRINUSE`) and the checks had been answered by a stale process.

The fixture defines the canary fact's unlock at **578 s (09:38)**, so both 00:00
and 06:00 precede it.

| Position | Eligible blocks | Oracle says | Canary constant in eligible set | answerState | reason |
|---|---|---|---|---|---|
| 00:00 (0 s) | 2 | 2 | **0** blocks — not disclosed | `TEMPORARILY_UNAVAILABLE` | `PROVIDER_UNAVAILABLE` |
| 06:00 (360 s) | 10 | 10 | **0** blocks — not disclosed | `TEMPORARILY_UNAVAILABLE` | `PROVIDER_UNAVAILABLE` |
| 12:00 (720 s) | 15 | 15 | **3** blocks — reachable | `TEMPORARILY_UNAVAILABLE` | `PROVIDER_UNAVAILABLE` |

**Result: 24 checks PASS, 0 FAIL, 3 NOT RUN. Exit code 0.**

What this proves, and how:

| Invariant | Outcome | How it was checked |
|---|---|---|
| The eligible set is correct at each position | **PASS** | Server count compared against a **second, independently written** expression of the policy in the harness, at 3 positions |
| The future fact is unreachable before its unlock time | **PASS** | 0 eligible blocks carry `0.37` at 0 s and 360 s |
| The future fact is reachable at/after the unlock time | **PASS** | 3 eligible blocks carry `0.37` at 720 s |
| The withheld fact never reaches the client | **PASS** | The entire response body was searched for the constant and its label, before the unlock time |
| Displayed citation ids belong to the eligible set | **PASS (vacuously)** | No citations were produced, because no model ran. The check is not evidence about citations |
| Quotations match the source verbatim | **PASS (vacuously)** | Same — 0 quotations to check |
| Citation labels carry the true source clock | **PASS (vacuously)** | Same |
| No collapsed internal state leaks | **PASS** | Body searched for `NOT_AVAILABLE_YET`, `NOT_IN_MATERIALS`, `internalState` |
| Refusals are clear | **PASS** | Non-empty learner message on every turn |
| Early position refuses *because* the fact is withheld | **NOT RUN** | Cannot be distinguished from "no model configured" without a credential |
| Later position produces a supported answer | **NOT RUN** | No credential. Eligible evidence did exist, so the missing prerequisite is the model, not the scope |
| Semantic verification passed for each rendered claim | **NOT RUN** | Not observable over HTTP even with a model; asserted in the mocked pipeline tests instead |

**Honest reading:** the temporal-eligibility invariant is verified live and
cross-checked. The *answer* half of the canary is not verified at all, because
no model was available to answer. Three checks are recorded as NOT RUN, not as
passes.

## P3-3. Spend guard (LIVE, executed)

`GET /api/v1/health` reports `runtime.spendGuard: "blocked"` on the running
server. The guard was previously documented and unenforced; it is now enforced
before the first provider request, so a zero budget sends no embedding call
either. Covered by 3 new unit tests.

## P3-4. Not run, and why

| Case | Why not run |
|---|---|
| Live generation with `gemini-3.6-flash` | No `HORIZON_LLM_API_KEY`. **No live model call has ever been made by this project.** |
| Live embeddings with `gemini-embedding-001` | Same. Demo mode uses `synthetic-lexical-v1`, which is lexical and labelled as such |
| Seeding the corpus through the real path | No database credential and no applied migration. `pnpm seed:demo` was **executed once** and correctly refused, writing nothing (exit 1) |
| The database-backed evidence store | Never executed against a database. Unit tested against a fake gateway only |
| Citation panel with real citations | Needs a real answer to produce citations. Exercised only by the mocked pipeline test asserting a citation at 578 s labelled `Transcript 09:38–10:40` |
| Answer quality, accuracy, latency, cost | Needs a live model. **No metric is claimed** |
| Public deployment | No host configured and no deployment access. Procedure in [DEPLOY.md](DEPLOY.md). **No public URL exists** |

## P3-5. Command outcomes on the final revision

```
pnpm lint       exit 0
pnpm typecheck  exit 0
pnpm test       exit 0   98 tests, 9 files
pnpm build      exit 0
pnpm canary     exit 0   24 passed, 0 failed, 3 not run
pnpm seed:demo  exit 1   refused — nothing written (expected without credentials)
```

New in Part 03: `tests/seed.test.ts` (19 tests, mocked) and 3 spend-guard tests
in `tests/pipeline.test.ts`. Everything that touches a model boundary remains
**MOCKED**. Nothing in this revision is a live integration test.


---

# Part 02 record (earlier revision)

## 1. Correctness cases and their actual results

| # | Case | Evidence | Kind | Result |
|---|---|---|---|---|
| E1 | A fact introduced later in the lesson is absent from the model payload before its unlock time | `tests/pipeline.test.ts` → "never sends the future-only fact to the model before its unlock time" | MOCKED | **PASS** — payload contained no `b_0013`/`b_0014` and neither the string `0.37` nor `Marlin`; payload was non-empty, so this is scoping, not an empty retrieval |
| E2 | The same fact is retrievable and answerable at/after the unlock time | `tests/pipeline.test.ts` → "makes the same fact retrievable and answerable at or after the unlock time" | MOCKED | **PASS** — `b_0013` present, answer `ANSWERED`, citation at 578s labelled `Transcript 09:38–10:40` |
| E3 | A model-supplied evidence id outside the eligible set is rejected | `tests/pipeline.test.ts` → "refuses when the model cites an id that was not in the eligible payload" | MOCKED | **PASS** — refusal, 0 claims, and the future value absent from the serialized outcome |
| E4 | Both retrieval branches apply the same eligibility rule | `tests/retrieval-eligibility.test.ts` | SYNTHETIC | **PASS** — 6 playheads × 2 branches, every returned block re-checked against the canonical predicate |
| E5 | An `INDEXED` but ineligible row returned by the database is dropped anyway | `tests/retrieval-eligibility.test.ts` → supabase store cases | SYNTHETIC | **PASS** — future, `PENDING` and `PROCESSING` rows filtered from both branches and from `getBlocksByIds` |
| E6 | A fabricated / non-verbatim quotation is rejected | `tests/pipeline.test.ts` + `tests/verification.test.ts` | MOCKED | **PASS** |
| E7 | A claim the semantic verifier marks `NOT_SUPPORTED` is not rendered | `tests/pipeline.test.ts` → "does not render a claim the semantic verifier marks NOT_SUPPORTED" | MOCKED | **PASS** — refusal with reason `UNSUPPORTED_BY_EVIDENCE` |
| E8 | Partially supported answers render only the supported claims | `tests/pipeline.test.ts` → "returns only the supported claims and marks the answer partial" | MOCKED | **PASS** — 1 of 2 claims rendered, state `ANSWERED_PARTIAL` |
| E9 | No eligible supporting evidence leads to refusal | `tests/pipeline.test.ts` (2 cases: real corpus and a store stub) | SYNTHETIC | **PASS** — the stub case also proves the model was never called |
| E10 | The internal `NOT_AVAILABLE_YET` / `NOT_IN_MATERIALS` distinction never reaches the client | `tests/pipeline.test.ts`, `tests/api-contract.test.ts` | MOCKED | **PASS** — both collapse to `INSUFFICIENT_EVIDENCE`; serialized body contains neither internal token |
| E11 | Invalid JSON, timeout, 429, empty response, schema mismatch, missing config fail safely | `tests/gemini-adapter.test.ts` (16), `tests/pipeline.test.ts`, `tests/provider.test.ts` | MOCKED | **PASS** |
| E12 | Embedding model and dimensionality are consistent | `tests/gemini-adapter.test.ts` → embedder cases | MOCKED | **PASS** — requests `gemini-embedding-001` with `outputDimensionality: 768`; a mismatched returned dimension throws |
| E13 | The API schema and the UI agree on every answer state | `tests/api-contract.test.ts` | MOCKED | **PASS** — `ANSWER_STATE_LABEL`/`TONE` keys equal the public enum |
| E14 | A refused turn is recorded as refused, not as answered | `tests/persistence.test.ts` | MOCKED | **PASS** — internal state and reason code stored; fixture-backed turns store nothing |
| E15 | The eligibility tests are load-bearing, not vacuous | manual mutation: predicate made to ignore `unlock_seconds` | SYNTHETIC | **PASS (mutation caught)** — 3 pipeline tests failed; change reverted and confirmed byte-identical |

## 2. Live observations

Server: `next start` on `127.0.0.1:4321`, production build, no credentials set.

| Observation | Result |
|---|---|
| `GET /api/v1/health` | HTTP 200; `app.configured/reachable: true`, `database.configured: false`, `runtimeAi.configured: false`, `runtimeAi.reachable: null` |
| `GET /api/v1/courses` | HTTP 200; one labelled sample course, `demoContent: true`, `evidenceSource: "fixture"` |
| `GET /scope` at 0 / 360 / 576 / 578 / 720 s | HTTP 200; eligible block count **2 → 10 → 12 → 13 → 15** |
| `POST /questions` canary at 360 s | HTTP 200; `TEMPORARILY_UNAVAILABLE` / `PROVIDER_UNAVAILABLE`; 6 blocks in payload; `persisted: false` |
| `POST /questions` canary at 720 s | HTTP 200; same state; 6 blocks in payload |
| Browser interaction (`12:00` preset → Ask) | Scope chip refreshed to 15; result card rendered; **0 console errors**; 3 × HTTP 200 |

The live boundary the scope numbers show (2 → 15) is real policy behaviour. The
`TEMPORARILY_UNAVAILABLE` responses are the honest consequence of running without
a model, not a failure of the pipeline.

## 3. Not run, and why

| Case | Why not run |
|---|---|
| Real generation with `gemini-3.6-flash` | No `HORIZON_LLM_API_KEY`. Blocked, not attempted, not simulated. |
| Real embeddings with `gemini-embedding-001` | Same blocker. Demo mode uses `synthetic-lexical-v1`, which is lexical, not semantic. |
| Answer quality / citation precision against a real model | Requires the above. **No accuracy figure is claimed.** |
| End-to-end path against the real database | Migrations `0001` and `0002` are **not applied** and no DB credential exists. The Supabase store is unit-tested against a fake gateway only. |
| Any latency or cost benchmark | The `latencyMs` field is a single-request measurement shown for transparency. One observation is not a benchmark. |
| Public deployment | Not attempted; no host configured. |

## 4. What would make this a real evaluation

1. Configure the runtime key and re-run E1–E9 against the real model, recording
   raw responses (secrets stripped) rather than assertions.
2. Record, per case, whether the claim set was *sufficient* — not merely
   supported — since verification cannot detect an incomplete answer.
3. Repeat the same question at two playheads against the real model and log
   whether the citation *set* differed, which is the submission's headline claim.
4. Apply the migrations, load a real course, and repeat everything with
   `evidenceSource: "supabase"`.
