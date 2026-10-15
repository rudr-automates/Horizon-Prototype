# Evaluation record

**Read this as a log of what was actually run, not as a quality claim.**

This document spans several revisions. **Part 04 (immediately below) is the
current record**; Parts 03 and 02 are retained unchanged further down as history,
and they describe an earlier revision whose results still stand as history for
that revision and are not claimed for the current code.

Three kinds of evidence appear below, and they are never mixed:

| Label | Meaning |
|---|---|
| **MOCKED** | The model boundary was replaced by a scripted fake. Proves the *pipeline* logic, proves nothing about model quality. |
| **SYNTHETIC** | Ran against the labelled sample fixture corpus and the offline lexical embedder. Proves *policy and eligibility* behaviour. |
| **LIVE** | Observed by hitting the running server over HTTP. |
| **NOT RUN** | Blocked by a missing prerequisite — a credential, an applied migration, or (as in Part 04) an exhausted provider quota. Explicitly not claimed. |

There is no held-out accuracy number, no latency benchmark and no response-quality
metric in this document. Some real inference has now been executed (Parts 03 and
04), but a handful of live calls is a demonstration, not a measurement. A test
that was designed is not a test that passed, and a call that was refused is not a
call that succeeded.

---

# Part 04 — spend-accounting repair, and the quota wall — LIVE where possible

**Date:** 2026-10-15 · **Label:** `live-generation-blocked` · Runtime credential: present.

Evidence: [smoke-live-2026-10-15.txt](evidence/smoke-live-2026-10-15.txt),
[canary-live-generation-blocked-2026-10-15T08-43-15Z.json](evidence/canary-live-generation-blocked-2026-10-15T08-43-15Z.json).

## Q1. A second under-count, found by reading the deployed schema

The migrations were verified applied this session (six tables, RLS on, pgvector
`0.8.2` installed), which made the database path concrete enough to audit. The
Supabase ledger writes to `public.usage_ledger`, and that audit found that the
Part 03 fix was incomplete: `sumTokensSince` sums `prompt_tokens +
completion_tokens`, but the recorded `completion_tokens` **excluded reasoning
tokens**. So the durable ledger — the one the cap reads back — under-counted
exactly as the in-memory one had before D-013, and the two modes disagreed about
the same call.

Corrected so the sum is derived from the total rather than from its parts, making
the identity hold by construction (D-017). Verified three ways:

| Check | Result |
|---|---|
| Reasoning is counted in the in-memory ledger | PASS — 417 + 21 + 984 = 1422 |
| Reasoning survives into the persisted row | PASS — `prompt_tokens + completion_tokens` = 1422 |
| Both ledger modes report the same total for the same entry | PASS |
| The tests are load-bearing | PASS — dropping reasoning again fails 2 tests |

**This is a mocked, not live, verification.** Unit tests. Stated plainly because
the defect was an accounting error that only a live call can fully price.

## Q2. Live embedding — REAL

On the final revision, `pnpm smoke`: `gemini-embedding-001`, 768 dimensions, all
finite, 676 ms, one request against a cap of 10.

## Q3. Live generation — BLOCKED, not passed

Every generation call on this revision was refused by the provider with HTTP 429.
The reason was made legible rather than guessed (D-018):

```
The provider rate limit was reached (retry after 54921s,
quota generativelanguage.googleapis.com/generate_content_free_tier_requests).
```

~15 hours of retry delay against the **free-tier daily generation request quota**.
This is an account limit, not an application defect and not a budget refusal:

| Signal | Reading |
|---|---|
| `quota … generate_content_free_tier_requests` | The day's generation allowance is spent |
| `retry after 54959s` / `54921s` | Resets on the daily boundary, not per minute |
| Embedding succeeded in the same process | Embeddings are a **separate** quota and still work |
| Guard state | `permitted`, `spentTokensToday` far below `20000` — the budget did not refuse |

**No live generation result is claimed for the current revision.** The live
generation evidence in Part 03 (L1–L3) was obtained on the **pre-repair** revision
and is not evidence about the accounting change.

## Q4. Canary on the final revision — 24 PASS, 1 FAIL, 2 NOT RUN

The model half could not run, so the harness produced exactly the split it was
built to produce. Positions were spaced 45 s apart (`--delay 45000`), which rules
out a per-minute burst as the cause.

| Position | Eligible (oracle) | Eligible-set check | Future fact in eligible set | Withheld fact in response | Answer half |
|---|---|---|---|---|---|
| 00:00 | 2 (2) | PASS | 0 blocks | **No** | NOT RUN |
| 06:00 | 10 (10) | PASS | 0 blocks | **No** | NOT RUN |
| 12:00 | 15 (15) | PASS | 3 blocks | n/a | **FAIL** — 429, 0 claims |

The 12:00 row is recorded as a **FAIL**, not as a pass: an expected answer was not
produced. The two early rows are **NOT RUN**, because a provider failure renders
nothing and therefore demonstrates nothing about temporal scoping. The eligibility
and non-disclosure invariants remain independently oracle-checked at all three
positions and are unaffected by the quota.

## Q5. Supabase prerequisites — VERIFIED APPLIED (read-only, executed)

Part 03 recorded these as *blocked*. That is now stale, so it is re-checked rather
than assumed. Each probe is an observation of the remote project:

| Probe | Result | Conclusion |
|---|---|---|
| `list_tables(public, verbose)` | six tables, RLS enabled on all six | `0001_init.sql` applied |
| Column-level detail | enums, check constraints, generated `fts`, `usage_ledger` FK all match the migration | `0001` applied faithfully, not approximately |
| `list_extensions` | `vector` **installed** `0.8.2` (was `installed_version: null`) | pgvector is live |
| `get_advisors(security)` | `horizon_is_eligible`, `horizon_search_fts`, `horizon_search_vector`, `horizon_list_eligible`, `horizon_has_matching_ineligible` all exist | `0002_search_functions.sql` applied |
| `list_migrations` | `[]` | History is empty because the SQL was applied through the Dashboard editor, which does not record history. The **schema** is the evidence, not this table |

The advisors also returned two findings, recorded rather than smoothed over:

- **`rls_enabled_no_policy`** (INFO, 6 tables). Not a defect here: every read and
  write in the app uses the service-role client, which bypasses RLS, and the anon
  key is only used to probe reachability. Deny-by-default is the safe posture.
- **`function_search_path_mutable`** (WARN, 6 functions). None of the functions is
  `SECURITY DEFINER`, so this is hardening rather than an escalation hole. Left as
  a documented follow-up.

**Applying the migrations did NOT make the database path live.** No Supabase name
is set in `.env.local`, so `database.configured` is still `false`,
`evidenceSource` is still `fixture`, and `pnpm seed:demo` has still never
executed. `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` are all three required — the configuration check
requires the anon key even though the server writes with the service role. The
seed command's own pre-flight list was corrected to match, since checking two of
three names let it report "2/2 set" and then refuse further down with a vaguer
message.

## Q6. Deployment

**No deployment was performed and no public URL exists.** Nothing in this document
should be read as a deployment claim. `GET /api/v1/health` was exercised only on
`127.0.0.1`.

---

# Part 03 continuation — LIVE results

**Date:** 2026-10-15 · **Label:** `live-fixture` · **Runtime credential: present.**

Raw responses: [canary-live-fixture-2026-10-15T08-26-00-321Z.json](evidence/canary-live-fixture-2026-10-15T08-26-00-321Z.json).

These are the first real provider calls in the project's history. Findings are
kept separate, as requested, because they have different evidentiary strength.

## L1. Live inference — REAL

`pnpm smoke`, one embedding request and one generation request, no other calls:

| Check | Result |
|---|---|
| Text model | `gemini-3.6-flash`, invoked for real |
| Structured output | JSON parsed into 1 claim; `unansweredParts=false` |
| Embedding model | `gemini-embedding-001`, 768 values, **all finite** |
| Reported usage | prompt 133, completion 51 |
| Latency (single observation, not a benchmark) | embed 696 ms, generate 3631 ms |

## L2. Canary `live-fixture` — 27 checks PASS, 0 FAIL, 0 NOT RUN (exit 0)

The fixture unlocks the canary fact at **578 s (09:38)**.

| Position | Eligible | State | Claims | Citations | Withheld fact disclosed? |
|---|---|---|---|---|---|
| 00:00 | 2 | `INSUFFICIENT_EVIDENCE` | 0 | 0 | **No** |
| 06:00 | 10 | `ANSWERED_PARTIAL` | 1 | 1 | **No** |
| 12:00 | 15 | `ANSWERED` | 2 | 2 | Yes — correctly, past the unlock |

**00:00** — a real refusal. The eligible set contains no block carrying `0.37`,
and the response body contains neither the constant nor its label.

**06:00** — a *partially supported* answer that does **not** disclose the fact:

> The numeric backoff constant is not chosen immediately, but is selected later
> after observing the shape of the failure distribution.
>
> cited to `b_0007`, *Transcript 03:30–04:40*, quote `"the constant is selected
> later, once we can see the shape of the failure distribution."`

**12:00** — the withheld fact, cited:

> The instructor chooses the Marlin backoff constant of 0.37.
> This constant is chosen because a sub-unit coefficient keeps the initial retry
> fast while ensuring the doubling schedule remains within the retry budget…
>
> cited to `b_0013` (*Transcript 09:38–10:40*, quote `"We use the Marlin backoff
> constant, 0.37, as the scaling coefficient."`) and `b_0016` (*Transcript
> 12:00–13:40*).

That is the headline behaviour: **the same question, refused or hedged before the
unlock point and answered with verbatim citations after it.**

## L3. Citation integrity and temporal eligibility — REAL, checked independently

Verified per position by inspecting the returned artifact, not by trusting the app:

| Invariant | 00:00 | 06:00 | 12:00 |
|---|---|---|---|
| Eligible-block count equals an independently written oracle | PASS (2) | PASS (10) | PASS (15) |
| No withheld fact in the eligible set before unlock | PASS | PASS | n/a |
| Every returned citation id is in the eligible set | PASS | PASS | PASS |
| Every quotation is verbatim in its cited source | PASS | PASS | PASS |
| Every citation label carries the source's true clock | PASS | PASS | PASS |
| No collapsed internal state leaks | PASS | PASS | PASS |
| Refusal/partial messaging is clear | PASS | PASS | PASS |

Two harness corrections were needed, and both are recorded rather than quietly made:

1. The early-position assertion originally demanded a *refusal*. The actual
   requirement is that the withheld fact is **not disclosed**, and the 06:00 run
   met that while legitimately answering a related sub-question. The check now
   inspects every rendered claim and quotation for the withheld term — a more
   direct test of the real invariant — rather than asserting a state.
2. A provider or budget failure is now reported as **NOT RUN**, never as a pass:
   nothing rendered means nothing demonstrated about temporal scoping.

## L4. Spending safeguards — enforced, and the holes left

`HORIZON_DAILY_TOKEN_BUDGET=20000`, `HORIZON_MAX_EMBEDDING_CALLS=10`.

| Safeguard | Status |
|---|---|
| SDK automatic retries | **Discovered ON by default (5 attempts, retrying 429/5xx).** Now explicitly `attempts: 1`. Verified by unit test. |
| Cumulative token accounting | Enforced at admission before every billable call. Observed live: `spentTokensToday` 0 → 1487 → 2026 across the run. |
| Reasoning tokens metered | **Was a real defect.** `thoughtsTokenCount` is billed and is reported separately from `candidatesTokenCount`; observed live at **984 thinking vs 21 visible** tokens, so ignoring it under-counted that call by ~50x. Now counted. |
| Failed calls metered | **Was a real defect.** A malformed response threw before usage was recorded, so failing calls cost tokens invisibly. Usage now travels out on the failure. |
| Embedding-request cap | Enforced. It **bound during testing** and refused with `embeddingCalls=10 cap=10`, which is how the 12:00 case failed once and why the final run was restarted. |
| NaN safety | Fixed: a single `NaN` component would have made the total `NaN`, and every comparison against `NaN` is false — the guard would have silently *stopped* refusing. |

**Limits that remain UNENFORCED — do not read the budget as a spending cap:**

- **Embedding tokens and cost are not metered at all**, because that API reports
  no token usage. The call cap bounds *how many requests*, not how much they cost.
- **The ledger is in-memory** (`usageMode: "memory"`), so the daily total is real
  for one process only: it resets on restart and is not shared between instances.
  This run restarted several times, so the exact cross-run token total is **not
  recoverable**; the per-process figures above are the only trustworthy ones.
- **Reservation is not atomic.** Two concurrent turns can both be admitted
  against the same remaining budget.
- **No cost figure is recorded.** `estimated_cost_usd` is left NULL because
  pricing needs a dated price source.
- **The output allowance is not a cost control.** `maxOutputTokens` was raised
  from 1024 to 4096 because reasoning alone consumed 984 of the original cap and
  truncated the JSON mid-object.

## L5. Database status — BLOCKED, unchanged

> Superseded: this section records the state at the baseline below. All three
> migrations are now applied and verified — see Part 05.

Read-only probes still report no tables in `public` and no migration history, and
no Supabase name is configured. **`pnpm seed:demo` has still never executed**, and
no Supabase connectivity is claimed anywhere. All retrieval above is the **labelled
synthetic fixture corpus**, and the embedder in use is the real
`gemini-embedding-001` operating over fixture text — the *corpus* is synthetic and
the *labelled* fixture ranking is lexical-plus-cosine, not a database vector index.

## L6. Command outcomes

```
pnpm lint       exit 0
pnpm typecheck  exit 0
pnpm test       exit 0   140 tests, 11 files   (all MOCKED)
pnpm build      exit 0
pnpm smoke      exit 0   2 LIVE calls
pnpm canary     exit 0   27 passed, 0 failed, 0 not run   (LIVE model, fixture corpus)
pnpm seed:demo  exit 1   refused — nothing written (no database)
```

**Mocked:** every test file. **Live:** the smoke test, the 3-position canary, the
health endpoint, and the browser walkthrough. **Synthetic:** the corpus and its
fixture ranking.

---

# Part 03 — real integration, evaluation and release

**Date:** 2026-10-15 · **Baseline:** `e56bea7` · **Outcome: prerequisites missing, so the real integrations are BLOCKED. This section records exactly which.**

> Superseded: the prerequisites below were met later the same day. Parts 04 and 05
> record what happened once they were, including the applied migrations and the
> live checks that followed.

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

---

# Part 04 — database path verification (2026-10-15)

**Baseline:** `73d731a` · **Outcome: the database path is EXECUTED; the answer path
is still refused by the provider's generation quota.**

Supabase is configured (all three names present, values never printed), the demo
corpus is seeded, and the database-backed retrieval path ran for real. Raw record:
[db-path-verification-2026-10-15T09-28-15-146Z.json](evidence/db-path-verification-2026-10-15T09-28-15-146Z.json).

| # | Case | Evidence | Kind | Result |
|---|---|---|---|---|
| D1 | Seed the corpus through the real data path | `pnpm seed:demo` | LIVE — 1 embedding request against a cap of 10 | **PASS** exit 0; 1 course / 6 resources / 18 blocks |
| D2 | Real embeddings persisted, not placeholders | re-read of `blocks.embedding` via REST | LIVE | **PASS** — 18/18 vectors of 768 values, all finite, none all-zero, 18 distinct prefixes, labelled `gemini-embedding-001` |
| D3 | Durable usage ledger — read | the app's own `spentToday()` | LIVE | **PASS** — a real `SELECT` against `usage_ledger` |
| D4 | Durable usage ledger — write | the app's own `record()`, labelled probe row deleted afterwards | LIVE | **PASS** — total moved 0 → 66 (11 prompt + 55 completion, with the 33 reasoning tokens folded in); cleanup left 0 rows / 0 tokens |
| D5 | Course reads through the store | `listCourses`, `getCourse` | LIVE | **PASS** — the seeded course, 900 s |
| D6 | Eligibility enforced on real rows | `listEligible` at boundaries 0 / 200 / 899 / 900 s | LIVE | **PASS** — 2 / 7 / 16 / 16, i.e. 18 blocks minus the 1 `PENDING` and the 1 `FLAGGED` block |
| D7 | Full-text branch | `searchFullText` | LIVE | **PASS** — `backoff` 2 hits, `exponential backoff` 1, `jitter` 2 |
| D8 | Vector branch | `searchVector` using a **stored** vector as the query, so no provider call was made | LIVE | **PASS** — the source block returns first at distance 0 |
| D9 | Ineligible-match probe | `hasMatchingIneligible` | LIVE | **PASS** — `backoff` true, `zzz-not-present` false |
| D10 | HTTP interface | `GET /api/v1/courses`, `/courses/:id`, `/scope` at five playheads | LIVE | **PASS** — 200; counts 2 / 4 / 7 / 10 / 16; negative playhead 400; unknown course 404 |
| D11 | The answer path | `POST /questions` | LIVE | **NOT RUN as a success** — generation is refused by the provider (429); the observed outcome is the safe refusal `TEMPORARILY_UNAVAILABLE` / `PROVIDER_RATE_LIMITED`. Never counted as a pass |
| D12 | Turn persistence to the database | — | — | **NOT RUN** — a turn is recorded only after a successful generation |

## Part 04 — what is still not evaluated

Nothing about answer *quality* changed. No live answer exists on this revision, so
citation precision, claim sufficiency and the two-playhead citation-set comparison
remain unmeasured, and no accuracy, latency or cost metric is claimed. The
provider's own retry-after was roughly 15 h from 2026-10-15T08:43:15Z and that
window had not elapsed when this part was recorded, so the deferred live run is a
scheduling matter, not a code change.

---

# Part 05 — atomic budget safety and release readiness (2026-10-15)

**Outcome: admission is now an atomic reservation, and that claim is verified
against the real database.** Migration `0003` was applied on 2026-10-15 and a
re-read confirmed 6/6 required tables, 6/6 required functions, the `0003` objects
present and the ledger readable. Both live commands were then run against the
same project: `pnpm verify:budget` **PASS** (exit 0) and `pnpm verify:data-path`
**25/25 passed, 0 failed, 0 pending** (exit 0). No generation call was made, so
nothing here is a statement about answer quality.

## P5-1. The defect, and what replaced it

Admission used to be read → decide → record as three operations, so two turns in
flight could both read the same remaining budget. It is now a single SQL
statement that takes an advisory transaction lock keyed on `(kind, UTC day)` and
inserts a reservation only if the day's settled charges plus outstanding holds
still fit. The same mechanism counts embedding requests by row count, replacing a
process-local counter that gave N instances N caps. Reservation state lives in
`usage_ledger` itself rather than a second table, so there is exactly one answer
to "what has been spent today".

## P5-2. What was verified, and how

| # | Case | Evidence | Kind | Result |
|---|---|---|---|---|
| P5-1 | Two concurrent turns cannot over-reserve a budget that fits one | `tests/budget-concurrency.test.ts` — two real pipeline turns over one shared ledger, with the first parked inside its reservation window | MOCKED (unit) | **PASS** — one answered, one `BUDGET_EXHAUSTED`, provider reached once |
| P5-2 | Several turns started at once | same file, 4 simultaneous turns, budget derived from the pipeline's own reservation arithmetic | MOCKED (unit) | **PASS** — 1 answered, 3 refused, 1 provider call |
| P5-3 | Reserved capacity cannot be spent by a later call | ledger-level test, 600 + 600 against 1000 | MOCKED (unit) | **PASS** — exactly one grant |
| P5-4 | A reservation is charged even before settlement | `InMemoryUsageLedger.spentToday()` | MOCKED (unit) | **PASS** |
| P5-5 | A sent call that reports nothing keeps its reservation | settlement policy tests | MOCKED (unit) | **PASS** — `failed_no_report_charged_reservation` |
| P5-6 | A provider REJECTION releases its hold at zero | settlement policy tests + live behaviour | MOCKED (unit) | **PASS** — `failed_not_billable` |
| P5-7 | A duplicate settle does not charge twice | settlement policy tests | MOCKED (unit) | **PASS** |
| P5-8 | An unreadable ledger refuses instead of assuming zero spend | pipeline test + the live endpoint | LIVE | **PASS** — `TEMPORARILY_UNAVAILABLE` / `BUDGET_EXHAUSTED`, zero provider calls |
| P5-9 | Health distinguishes authentication from reachability from schema from ledger | `GET /api/v1/health` | LIVE | **PASS** — reports `querySucceeded: true` with `durableLedger: "unreadable"` and `ok: false` |
| P5-12 | The guard reported by health matches what the answer path does | `GET /api/v1/health` + 8 new cases in `tests/health.test.ts` | LIVE + MOCKED | **PASS** — `spendGuard: "blocked"` with the ledger unreadable, where it previously said `permitted` while every turn was refused |
| P5-13 | A malformed course id is a client error, not a server one | `GET /api/v1/courses/not-a-course/scope` | LIVE | **PASS after fix** — was **HTTP 500**, now 404. Supersedes the earlier recorded 404, which was not reproduced |
| P5-14 | Health leaks no credential, raw error or schema map | `tests/health.test.ts` + the live payload | MOCKED + LIVE | **PASS** — the payload carries counts and booleans only |
| P5-15 | The persisted corpus and both retrieval branches, at zero provider cost | `pnpm verify:data-path` | LIVE (real rows) | **PASS** — 25 passed, 0 failed, **0 pending**; see below |
| P5-16 | An unknown spend is reported as unknown, not as zero | the live `POST /questions` response + `tests/pipeline.test.ts` | LIVE + MOCKED | **PASS** — `guard.spentTokensToday` is `null` (was `0`) while that same response is `BUDGET_EXHAUSTED` because the total could not be read. Recorded with the ledger unreadable, which is no longer the deployment's state; the rejection path is unchanged and still covered by the unit test |
| P5-10 | The concurrency claim against real PostgreSQL | `pnpm verify:budget` | LIVE (real rows) | **PASS** — 12 simultaneous `admitGeneration` calls against a 4800-token budget that fits 4 x 1200: **exactly 4 granted, 8 refused**, granted capacity 4800/4800, refusal detail `"…needs about 1200 tokens but only 0 remain of the 4800-token daily budget (0 settled, 4800 reserved)"`. Then 12 simultaneous `admitEmbedding` calls against a cap of 3: **exactly 3 granted**. Cleanup: 0 probe rows remaining, day total 0 → 0. This is the check that turns P5-1..P5-3 from "the app is correct" into "the database serializes admission" |
| P5-11 | Deployment | — | — | **NOT ATTEMPTED.** No public URL exists |

## P5-3. The persisted corpus, re-verified without spending anything

`pnpm verify:data-path` (new) exercises the app's own store against the seeded
Supabase corpus and records the result. It makes **no provider request**, and it
proves that by reading the ledger total and the embedding counter before and after
and requiring both to be unchanged. Recorded in
[docs/evidence](evidence/data-path-verification-2026-10-15T11-08-26-553Z.json),
where all 25 checks pass and none is pending — the ledger-readability check that
was previously `PENDING` on the unapplied migration is now a `PASS`. The command
was run three times on this revision, before and after the tooling change that
removed a stale expectation string from its output, with 25/25 each time.

| Check | Result |
|---|---|
| Store is the database-backed one | **PASS** — `evidenceSource: "supabase"`, `demoContent: false` |
| Course and resource counts | **PASS** — 1 course, 900 s |
| Eligibility grows with the boundary | **PASS** — 2 blocks at 0 s, 16 at 900 s |
| The predicate is re-applied independently | **PASS** — 0 of 16 returned blocks were ineligible |
| `PENDING` / `FLAGGED` material is withheld | **PASS** — 0 of 16 returned blocks carry either status |
| The fact is withheld before it unlocks | **PASS** — 0 of 2 eligible blocks at 0 s contain `0.37`; 3 of 16 do at 900 s |
| Full-text search respects the boundary | **PASS** — 3 eligible hits at 900 s, 0 for the locked fact at 0 s |
| The withheld-match diagnostic returns a boolean | **PASS** — `true` for the locked fact at 0 s, `false` for a term that is absent |
| Vector search over real rows | **PASS** — a stored 768-d vector returns its own block first at distance 0 |
| HTTP surface | **PASS** — health 200, courses 200, scope count matches the store, negative playhead 400, unknown course 404 |
| Nothing was spent | **PASS** — ledger total and embedding counter identical before and after |

One read is deliberately out of band: the app's gateway does not select the
`embedding` column, so a single stored vector is read directly with the
service-role key. The search itself runs through the app's store.

## P5-4. Still not evaluated

- **Live generation.** The free-tier quota is still exhausted; no answer has been
  produced by a live model on this revision, so citation precision and claim
  sufficiency remain unmeasured. `pnpm smoke` and `pnpm canary` stay blocked.
  The recorded retry-after runs to roughly 2026-10-15T24:00Z. This is the one
  remaining item on the release gate.
- **Turn persistence to the database.** Still unexercised: a turn row is written
  only after a successful generation, and generation is quota-blocked. Neither
  verification command reaches it.
- **Embedding cost.** The durable cap bounds request COUNT. That API reports no
  token usage, so no cost figure is enforced and `estimated_cost_usd` stays NULL.
- **What the concurrency proof does not cover.** `pnpm verify:budget` proves the
  admission function serializes correctly for one budget and one UTC day, under
  12-way concurrency from a single client. It does not exercise multi-instance
  deployment, rollover at a UTC day boundary, or a crash between reservation and
  settlement; those rest on the SQL's design (one statement, one advisory-lock
  transaction) and on settlement tests rather than on a measurement.

## P5-5. `0003` has now been executed

The concurrency run's own output is captured in
[docs/evidence](evidence/budget-concurrency-live-2026-10-15.json): that command
writes no artifact itself, so the transcript is kept deliberately, labelled as a
transcript rather than as a file the command produced.

The ambiguity that would have failed at run time — `reserved_tokens` being both an
OUT parameter and a ledger column — was found by reading and removed by qualifying
the reference. The migration has since run: Verifications A and B from
[apply-migration.md](apply-migration.md) returned 6/6 tables, 6/6 functions, the
`0003` objects present and the ledger readable, and `pnpm verify:budget` then
exercised the reservation functions for real. The reviewed-by-reading step is no
longer the only evidence.
