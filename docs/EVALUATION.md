# Evaluation record — Part 02

**Read this as a log of what was actually run, not as a quality claim.**

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
