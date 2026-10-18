# Evaluation record

**Read this as a log of what was actually run, not as a quality claim.**

This document spans several revisions. **Part 06, at the END of this file, is the
current record** — each part is appended after the one it supersedes, so the
newest record is the last one. Parts 05 and earlier are retained unchanged as
history: their results still stand for the revision they describe and are not
claimed for the current code.

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

> **Superseded later the same day — see Part 07.** Generation moved to Groq, whose
> quota is separate from the exhausted Google one. `pnpm smoke` and the 3-position
> canary both ran live and passed. The 429 above was an account limit on one
> provider, not a property of the application.

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

---

# Part 06 — Groq provider switch and the invisible interface (2026-10-15)

**Label:** `groq-switch-ui-rescue` · Runtime generation credential: present but
quota-blocked. **No Groq call has been made.**

## P6-1. The reported defect was real, and it was measurable

The interface was reported as "a blank white window with unreadable text". That is
what it did, and the cause was not styling taste — it was a missing contract:

| Fact | Measured value |
|---|---|
| Declared colour scheme | `color-scheme: light dark` on `:root`, with **no** background or text colour set anywhere |
| Text colour resolved to | `rgb(255, 255, 255)` — the UA's `CanvasText` for the DARK palette |
| Page surface | the embedder's own default, which was white |
| Result | white text on a white page; secondary text additionally multiplied by `opacity-0.7` |
| Only legible elements | those carrying their own explicit colour (badges, the Ask button) |

It was reproducible two ways from the same file, which is why it looked
different to different people: under a dark OS preference the same page painted a
`#121212` canvas (93.56% of the pixels) with white text and invisible dark-on-dark
panels; in the preview webview it painted white-on-white. Both are the same bug.

**Fix:** `color-scheme: light` only, with `background-color` and `color` stated on
`html` and `body`, and every component colour stated explicitly instead of
inherited or dimmed with `opacity-*`. Measured after the fix, in the same dark
preference: surfaces `#F1F5F9` / `#FFFFFF` / `#F8FAFC` = 92% of pixels, borders
`#CAD5E2`, accent `#1447E6`, and real ink present. Text contrast measured in the
live page: heading **20.49:1**, form label **19.3:1**, Ask button **14.45:1**
(white on blue-700).

A second, self-inflicted defect was caught by the same pixel-and-computed-style
check and is worth recording because no build or lint step can see it. An
unlayered `button, input, textarea, select { font: inherit; color: inherit }` rule
in `globals.css` **outranks Tailwind's `@layer utilities`** — CSS outside every
layer beats all layered CSS — so it silently overrode every `text-white`,
`text-xs` and `font-semibold` utility on those elements. The Ask button rendered
dark-on-blue at **1.24:1** and the type scale collapsed. Tailwind's preflight
already does that job inside `@layer base`; the duplicate was removed.

## P6-2. What the interface now is

A single-page learner workspace: brand header with live status pills; a one-screen
explainer of the three-stage pipeline; a lesson panel whose timeline has a slider,
a large clock readout and `00:00` / `06:00` / `12:00` presets wired to `aria-pressed`;
an **evidence-in-scope** count that refreshes as the playhead moves and is honest
about being mid-refresh; a question box with example chips and a prominent Ask
button; an answer card with a state pill, the claims, and citation chips that open
the exact quoted text with its timestamp, page, slide or line numbers; and a
status panel that reads `/api/v1/health` itself, so it cannot disagree with the
endpoint an operator would consult. Nothing fabricates: an absent credential, an
unavailable provider and a refusal are each rendered as what they are.

## P6-3. Generation moved to Groq; the two credentials were separated

Generation is now selectable (`groq` or `google-genai`) and runs against Groq's
OpenAI-compatible Chat Completions API. The generation half is a plain `fetch` —
no SDK — so "one call is one call" is visible in the code: `POST /chat/completions`
with `Bearer` auth, `response_format: { type: "json_schema", json_schema: {
name, strict, schema } }`, `max_completion_tokens` (not the deprecated
`max_tokens`), `include_reasoning: false`, and `temperature: 0`, which Groq
documents as being converted to `1e-8`.

**Usage is mapped once, not twice.** Groq's Chat Completions usage object reports
`prompt_tokens` and `completion_tokens` and **no separate reasoning count** —
reasoning is part of the completion. So `thoughtsTokens` is `null` and must not be
derived from `completion_tokens`, which would bill every reasoning token twice.
That is the opposite of the Gemini shape, where `thoughtsTokenCount` is reported
separately and must be added; both adapters are tested for their own shape.

**Credentials are now independent.** Embeddings still use the Google model,
because the persisted corpus was embedded with it and a vector from another model
is not comparable with it. The resolution rule is: `HORIZON_EMBEDDING_API_KEY`,
then `GOOGLE_API_KEY` / `GEMINI_API_KEY`, and `HORIZON_LLM_API_KEY` as a **legacy
fallback only when the generation provider is Google** — under any other provider
that key belongs to a different vendor, and sending it to Google would fail as an
authentication error that reads like an outage. The reverse direction is closed
too: `GOOGLE_API_KEY` never becomes the generation credential.

Three consequences are deliberate: a provider name that is not recognised is
reported rather than guessed; a Google-only setting left behind under Groq
(`HORIZON_LLM_THINKING_BUDGET`) is reported as ignored rather than silently
dropped; and `GET /api/v1/health` now reports `embeddingCredentialPresent` and a
`configurationProblems` list, because "configured for generation" and "able to
embed" are different facts with different fixes.

## P6-4. Test outcomes — all MOCKED, and labelled as such

`pnpm test` **PASS** — 246 tests in 16 files, exit 0. New in Part 06:

| Suite | Cases | What it pins down |
|---|---|---|
| `tests/groq-adapter.test.ts` | 38 | The endpoint, model id, bearer header and strict JSON Schema body; strict-mode invariants walked structurally (`required` complete, `additionalProperties: false`); fenced JSON accepted; malformed, schema-violating, empty, refused and truncated responses each fail closed **without echoing model text**; a 429's own `retry-after` and `x-ratelimit-*` guidance is recorded and **exactly one attempt** is made; 401/403/400/422/500/502/503 → unavailable, 408/504 → timeout, network failure → unavailable, non-JSON error body survived; usage mapped once with no reasoning double-count, and usage carried out of a FAILED call |
| `tests/env-credentials.test.ts` | 11 | Through the real environment reader: a Groq key never becomes the embedding key; `GOOGLE_API_KEY` is accepted for embeddings only; the legacy single-key setup still works **only** under `google-genai`; an unrecognised provider, a missing embedding credential, an ignored setting and a malformed base URL are each named |
| `tests/embedding-credential-guard.test.ts` | 3 | A database-backed corpus with no embedding credential is refused **before any read or any call** (0 embedder calls, 0 store reads), the same store proceeds normally once a real embedder exists, and the labelled sample fixture is still allowed |
| `tests/health.test.ts` | +2 | The embedding credential is reported separately from the generation one, and an ignored setting is named in `configurationProblems` while the payload still leaks neither key |

**A mocked Groq response is not evidence that Groq works.** No live Groq call has
been made on any revision; the account's limits are unknown until one is, and no
quota figure is claimed here.

## P6-5. Live observations, on the production build

Unlike Parts 04 and 05, the interface itself was verified against rendered output,
not against a DOM dump. Screenshots: [desktop](evidence/ui-desktop-final.png),
[mobile](evidence/ui-mobile-final.png).

| Observation | Result |
|---|---|
| Pixels, desktop 1440px | **PASS** — light surfaces 92%, borders and accent present, ink 2.41%; no blank bands |
| Pixels, mobile 390px | **PASS** — single column, no horizontal overflow (`scrollWidth - clientWidth = 0`), no element crosses the viewport edge, all three presets reachable |
| Timeline selection | **PASS (LIVE)** — eligible evidence **2 → 10 → 15** at `00:00` / `06:00` / `12:00`, with the clock, the `aria-pressed` preset and the policy line all following, and the "refreshing" state clearing rather than sticking |
| An unavailable provider reads as unavailable | **PASS (LIVE)** — the turn rendered `Temporarily unavailable`, the message, and `Reason: The model provider refused the request (rate limit or quota) (PROVIDER_RATE_LIMITED)`. Nothing was invented to fill the gap |
| The status panel matches the endpoint | **PASS (LIVE)** — `google-genai` / `gemini-3.6-flash`, `supabase` with `demoContent: no`, schema `verified`, ledger `usable`, `spendGuard: permitted`, `overall: ok` |
| Spend accounting after a real turn | **PASS (LIVE)** — the day's tokens moved 0 → **913**, which is the successful generation of one turn; the embedding-request counter moved 0 → 1 against its durable cap of 10 |

**One turn was run, and it is the most informative result in this part.** The
server log records `provider failure at verify: rate_limited — retry after 39519s,
quota generativelanguage.googleapis.com/generate_content_free_tier_requests`. So
the **generation half of the live path succeeded** on the Google adapter, and the
**verification call was refused** by the still-exhausted free tier. The turn
therefore returned `PROVIDER_RATE_LIMITED` and rendered **no claims** — the
fail-closed guarantee observed live rather than only mocked: a claim that could
not be verified is not shown, even though it was generated and paid for.

## P6-6. Not run, and why

- **Any Groq call**, live smoke test or canary. No Groq credential is configured,
  by instruction; the adapter is covered by mocked tests only. Its rate limits and
  its acceptance of the request shape are therefore **unknown**, not verified.
- **The canary** (`pnpm canary`) at `00:00` / `06:00` / `12:00`. It requires a
  working generation path; every position would report the answer half as NOT RUN.
- **A rendered answer with citations.** No claim has passed verification on this
  revision, so the citation panel and the claim list have never been exercised by
  live data — they remain covered by the mocked pipeline tests. The panel's
  *rendering* was verified in Part 03's fixture run; its *behaviour under a verified
  live claim* is unproven.
- **Turn persistence to the database.** A row is written only after a successful
  verification, which the quota prevented. Unchanged from Part 05.
- **Embedding cost.** Still unmetered: that API reports no tokens. The cap bounds
  requests only.
- **A real device.** Mobile was verified by viewport width (390px) on the same
  engine, not on a phone.
- **Deployment.** Not attempted. No public URL exists, so nothing above has been
  verified on a deployed origin.

## P6-7. Two environment limits worth recording, because they shaped the method

1. **`pnpm dev` did not hydrate inside the preview webview.** Its HMR websocket
   failed (`net::ERR_INVALID_HTTP_RESPONSE`), so every effect stayed unrun: the
   scope count sat at `—`, the status panel said `Loading status…`, and nothing was
   clickable. The **production build hydrates** (`next start`, verified) and every
   interaction below was checked there. The dev-server symptom is an environment
   artefact, not an application defect — but it means "it looks broken under
   `pnpm dev` in this panel" is not evidence of a defect.
2. **Raw pointer input from the preview webview did not reach the page.** Clicks
   reported success at the right coordinates and changed nothing; the same
   buttons worked when their handlers were invoked through the DOM, which is how
   the timeline and Ask checks above were driven. Keyboard/pointer fidelity is
   therefore *not* verified by those runs, only the application's own behaviour.
3. **The preview webview stopped compositing, so `preview_screenshot` could not
   capture anything at all.** That is an environment failure, not a defect, and
   the third pass below works around it: the pixels come from headless Chrome
   driven over the DevTools protocol, which is also the only way to capture a
   state — such as a refusal — that only exists after a click.

## P6-8. The status panel contradicted the database

Found while re-verifying, and it is the kind of defect that only shows up if you
check the screen against the database rather than against itself.

The rendered panel read **`EMBEDDING REQUESTS 0 made · cap 10`** while
`usage_ledger` held **1** `embedding_request` row for the same UTC day.

The cause: `GET /api/v1/health` reported `embeddingCallCount()`, a counter that
lives in the server process and returns to 0 on every restart, and it reported it
immediately beside a cap that is enforced durably in Postgres — in the same
payload as `embeddingCapMode: "supabase"`. The two figures described different
things, and the one a reader would take as "how much of the cap is gone" was the
process-local one.

| State | Process-local counter | Durable rows for the day | Panel showed |
|---|---|---|---|
| Before the fix, after a restart | 0 | 1 | `0 made · cap 10` — **wrong** |
| After the fix | 0 | 1 | `1 made today · cap 10` |
| After one further live turn | 1 | 2 | `2 made today · cap 10` |

The reading is now taken from the store the cap is counted in, through a new
`UsageLedger.embeddingRequestsToday()`, and it is `null` — rendered as
`unknown (the ledger could not be read)` — rather than 0 when that read fails,
because 0 would understate consumption. The process-local counter is still
reported, and the panel formats it as `made in this process` only when the cap
really is process-local.

One trap is worth recording because it cost a wrong attempt. The count cannot be
read from `admitEmbedding()`, which looks like the obvious source: the SQL
function returns a **hardcoded** `used_today = 0` from its `p_max_calls <= 0`
early return, so the one call that writes nothing is also the one that cannot
report the count. A calibration that trusted it produced an expectation of 3
grants where the true answer was 2, and the row arithmetic below caught it. The
field is now documented in `types.ts` as not a count read.

## P6-9. Two verification instruments were weaker than their output implied

Neither of these is an application defect. Both are cases where a command's
output read as a stronger statement than the command actually established.

**`pnpm verify:budget` could only pass on an untouched day.** Its embedding half
hardcoded `cap 3, expect 3 grants`, which is correct only while the ledger is
empty. The cap counts embedding rows for the UTC day across every provider, so on
a day the application had really been used the remaining allowance was 2 while
the script still demanded 3, and it reported **FAIL — expected 3 grants, saw 2**.
The cap was behaving correctly; the expectation was wrong. The token half had
always derived its budget from the live day total, so the script was already
inconsistent with itself. The cap is now derived as `existing + 3`, and the run
also asserts that every grant wrote exactly one row and no refusal wrote any, so
a predicate that drifted from the function it describes fails loudly instead of
mis-calibrating quietly. Re-run twice on the used ledger: **PASS** both times,
`1 -> 4 (3 added)`, cleanup complete, day total 913 before and after.

**`pnpm verify:data-path` claimed "nothing was spent" on evidence that could not
see embedding spend.** It compared the ledger token total, which is durable but
structurally blind to embedding requests because those carry no tokens, and a
process-local counter that restarts at 0 with the script. Both read `0 -> 0` on a
day when the ledger held one real request, so the line as printed could be read
as a statement about the day. It now reads the durable embedding-request count as
well, and the same check prints `ledger 913 -> 913; embedding calls in this
process 0 -> 0; embedding requests recorded for 2026-10-15 1 -> 1` — the real
figure, unchanged, which is what the claim needed to say. **25/25 checks pass.**

## P6-10. Visual verification, third pass, on pixels this time

The preview webview would not composite, so the captures come from headless
Chrome (`--screenshot`, and CDP for the state that needs a click). The analysis is
the same programmatic one used in P6-1 — exact colour counts, the share of
dark-ink pixels, and a luminance grid of the whole frame — not a glance at a
file, and it is reported as such.

| Capture | Size | Dark-ink pixels | Near-white | Palette |
|---|---|---|---|---|
| Desktop, full page | 1440x1620 | 2.33% | 94.57% | `#FFFFFF`, `#F1F5F9`, `#F8FAFC`, accent `#1447E6` |
| Mobile, full page | 390x3560 | 3.41% | 92.79% | same, plus `#0F172B` body ink |
| Refusal state, desktop | 1425x1708 | 1.60% | 94.21% | same |

The captures are kept as artifacts: [desktop](evidence/ui-desktop-final.png),
[mobile](evidence/ui-mobile-final.png),
[refusal state](evidence/ui-refusal-desktop-final.png), and this pass **replaced**
the two files Part 06 first wrote, so the images on disk are of the current build
rather than of the one before the panel fix. The data-path artifact from the same
run is [here](evidence/data-path-verification-2026-10-15T13-48-33-102Z.json).

Ink is dark on light in every capture, the accent and border colours are present,
and no capture contains an inverted or blank region — the failure mode P6-1 was
about. Measured on the live page, body text is `rgb(15, 23, 42)` on `#F8FAFC`
(**17.2:1**) and the refusal banner is `rgb(139, 8, 54)` on `rgb(255, 228, 230)`
(**8.0:1**), both well past the 4.5:1 threshold. No horizontal overflow at 390px
(`scrollWidth` equals the viewport).

Interaction was driven on the running production build:

- **Timeline.** Clicking `12:00` moved the playhead to `12:00 / 15:00` and the
  scope indicator from **2** eligible blocks at `00:00` to **15** at `12:00`, with
  the note (`Lesson through 12:00`), the answer boundary and the button label
  (`Ask at 12:00`) all following. This is the check Stage 3 asks for, and the
  count is the same one `pnpm verify:data-path` reads from the store.
- **An unavailable provider.** Asking rendered, in full: *"Temporarily
  unavailable … The assistant is temporarily unavailable, so no answer was
  generated. Reason: The model provider refused the request (rate limit or quota)
  (PROVIDER_RATE_LIMITED). Nothing was invented to fill the gap."* with
  `asked at 00:00`, `2 eligible blocks in the payload` and a server time. Legible,
  specific, and not an empty page.
- **Budget integrity.** That failed turn left `spentTokensToday` at **913** — the
  429 released its reservation instead of charging it — while the durable
  embedding count moved 1 → 2. Both are what the design says should happen.

---

# Part 07 — generation moved to Groq: live smoke test and live canary

**Date:** 2026-10-15 · **Baseline:** `2b710b3` · **Outcome: the live path works.**
One real embedding request and one real generation request passed, and the
3-position canary passed at every position with real answers and real citations.
Two things are still wrong, both recorded below rather than smoothed over:
`HORIZON_DAILY_TOKEN_BUDGET` and `HORIZON_MAX_EMBEDDING_CALLS` are **absent** from
`.env.local`, and the canary harness had to be repaired before it could run at all.

## P7-1. Configuration actually in effect

Read from variable NAMES and non-secret values only, then confirmed against the
running server's own `/api/v1/health` rather than inferred from the file:

| Setting | Value in effect |
|---|---|
| `HORIZON_LLM_PROVIDER` | `groq` |
| `HORIZON_LLM_MODEL` | `openai/gpt-oss-20b` |
| `HORIZON_LLM_BASE_URL` | `https://api.groq.com/openai/v1` |
| `HORIZON_LLM_REASONING_EFFORT` | `low` |
| `HORIZON_EMBEDDING_MODEL` / `_DIMENSIONS` | `gemini-embedding-001` / `768` |
| `HORIZON_EMBEDDING_API_KEY` | present (separate from the generation key) |

**Two required names are missing from the file.** `HORIZON_DAILY_TOKEN_BUDGET`
and `HORIZON_MAX_EMBEDDING_CALLS` are not set, and both resolve to `0` — which is
the guard's own "permit nothing" state, not a default that permits everything. The
restarted server said so unambiguously instead of failing obscurely:

```
spendGuard: "blocked"
Names are present, but HORIZON_DAILY_TOKEN_BUDGET is 0, so the spend guard
permits no provider call and every turn will refuse with BUDGET_EXHAUSTED.
```

The live runs below were therefore made with the **previously configured values**
(`20000` budget, cap `10`) supplied as process environment **for those commands
only**. That preserves the existing budget rather than raising it, but it is not a
configuration a deployment would have: the file on disk still lacks both names, so
a plain `pnpm start` and any host would refuse every turn. **This must be fixed
before the app is called demo-ready.**

## P7-2. Live smoke test — PASS (1 embedding request, 1 generation request)

`pnpm smoke`, retries disabled, atomic reservation in force:

```
Safeguard 1 — provider request attempts per call: 1
Provider      : groq
Text model    : openai/gpt-oss-20b
Embedding     : gemini-embedding-001 (768d)
Embedding admission (supabase cap): granted — 6 of 10 embedding requests recorded
Embedding request 1/1: OK  768 dimensions, all finite, 952 ms
Generation request 1/1: admission granted — reserving 4140 for this call
  OK  parsed 1 structured claim(s), unansweredParts=false, 699 ms
  usage: prompt 315, completion 81
  settlement: reported — charged 396, reported 396
```

Charged `396` equals `315 + 81` exactly: the reported usage was mapped once, with
no double count and nothing silently dropped. Groq reports no separate reasoning
count, so reasoning is already inside `completion_tokens`; `reasoning_tokens` was
recorded as `null` rather than invented, which is why the settlement reconciles.

## P7-3. Live canary — 18 PASS, 0 FAIL, 9 NOT RUN

Raw responses: [canary-after-groq-switch-live-2026-10-15T14-28-41-685Z.json](evidence/canary-after-groq-switch-live-2026-10-15T14-28-41-685Z.json).
Positions spaced 20 s apart to stay inside a free-tier per-minute window.

| Position | Eligible (oracle) | Eligible-set | Withheld fact in eligible set | Live answer |
|---|---|---|---|---|
| 00:00 | 2 (2) | PASS | 0 blocks | `INSUFFICIENT_EVIDENCE` / `UNSUPPORTED_BY_EVIDENCE`, with a message |
| 06:00 | 10 (10) | PASS | 0 blocks | `ANSWERED` — 1 claim, 1 citation |
| 12:00 | 15 (15) | PASS | 3 blocks | `ANSWERED` — 2 claims, 2 citations |

The 06:00 answer is the interesting one. It answers a *different* true thing about
the same topic — the constant is chosen later, after a simulation — and cites the
03:30 block that says exactly that, so it does not reach forward to the 0.37 fact
that unlocks at **578 s (09:38)**. The 12:00 answer does contain 0.37, from blocks
unlocked at 578 s and 720 s. The withheld constant never appears before its
unlock, which is the invariant the whole timestamp design exists for.

## P7-4. The harness was broken before the app could be judged

**The first canary run reported 4 FAILs, and none of them was an application
fault.** Every request came back `NOT_FOUND — "That course was not found."`

`scripts/canary.ts` addressed the course by `DEMO_COURSE.courseId`
(`course_demo_retries`) — the id that names the **fixture** corpus. The seeded
database serves the same lesson under the UUID the seed assigned it
(`83eafd47-15d8-50e0-9edc-ee6fb580cb83`). The harness was asking a database-backed
server for a course that only exists in the fixture, so the eligible-set checks
compared `-1` against an oracle and the answer half was empty. Every earlier
canary pass in this journal ran against a **fixture-backed** server, which is why
the hardcoded id survived this long.

The harness now reads the server's own `/api/v1/courses` list, prefers the fixture
id when the server really is fixture-backed (so that mode is unchanged), accepts an
explicit `--course <id>` override, and falls back to the fixture id only when the
list is unreachable — reporting which of the three it used. No check was weakened:
the same oracles, thresholds and outcomes are applied, and the run it produced is
the one above. The failed run is kept as
[canary-after-groq-switch-2026-10-15T14-25-26-603Z.json](evidence/canary-after-groq-switch-2026-10-15T14-25-26-603Z.json)
so the before/after is auditable rather than asserted.

A real limit remains, and it is why 9 checks are **NOT RUN**: the harness holds
only the fixture text, so for a database corpus it has no oracle for citation ids,
quotes or clocks. Those were verified independently instead of being assumed:

| Citation, by position | Row exists | Quote verbatim in `text_original` | Label matches the block's true clock | Block eligible at that playhead |
|---|---|---|---|---|
| 06:00 `f35f5722…` | yes | yes | yes — `Transcript 03:30–04:40`, start 210 s | yes |
| 12:00 `20fcaa3f…` | yes | yes | yes — `Transcript 09:38–10:40`, start 578 s | yes |
| 12:00 `644ebb8f…` | yes | yes | yes — `Transcript 12:00–13:40`, start 720 s | yes |

**3 of 3 citations check out** against `public.blocks` with no problems reported.

## P7-5. Persistence and budget accounting after the live run

`persistence` was `{"persisted":true,"mode":"supabase","detail":"Turn stored."}`
for all three turns, and the rows agree with the responses:

```
14:27:48 · boundary 0s   · NOT_IN_MATERIALS (UNSUPPORTED_BY_EVIDENCE) · openai/gpt-oss-20b · 3063 ms
14:28:14 · boundary 360s · ANSWERED (NONE)                          · openai/gpt-oss-20b · 4798 ms
14:28:40 · boundary 720s · ANSWERED (NONE)                          · openai/gpt-oss-20b · 5122 ms
```

Today's `usage_ledger`, read from the rows themselves:

| Operation | Rows | Charged |
|---|---|---|
| `generate` | 9 | 3421 |
| `verify` | 3 | 1188 |
| `embed` | 9 | 0 (that API reports no tokens) |

All 21 rows for the day are in state `settled`; **none is left holding capacity**,
which is the failure that would silently block later turns. The day's total reads
`4609`, which is exactly the sum of the charged rows — the number the health
endpoint reports and the number the rows contain agree, so the shown figure is not
taken on trust. Three `verify` rows exist, so semantic verification really ran as a
separate provider call rather than being claimed by a flag.

One gap to record: `turns.prompt_tokens`, `turns.completion_tokens` and
`turns.verifier_version` are still `NULL` after a live turn. Token accounting lives
in `usage_ledger` and is correct there, so nothing is unaccounted for, but the turn
row is not the self-describing record its columns promise.

## P7-6. The interface re-checked after the switch

The preview webview still refuses to composite (`preview_screenshot` returned "no
frames"), so the pixels come from headless Chrome again, as in P6-10, and were
analysed with the same programmatic colour count rather than by eye:

| Capture | Size | Dark-ink pixels | Near-white | Accent present |
|---|---|---|---|---|
| [Desktop](evidence/ui-desktop-groq.png) | 1440x1620 | 2.33% | 94.58% | `#1447E6` 1.19% |
| [Mobile](evidence/ui-mobile-groq.png) | 390x3560 | 3.38% | 92.80% | `#1447E6` 1.49% |

Ink is dark on light, the layout is dense with content rather than blank, and the
figures match the pre-switch build within a fraction of a percent — the provider
switch changed text on the page, not its legibility. The page now reads
`Model: groq · openai/gpt-oss-20b`, `Evidence: Supabase (live)`, `EMBEDDING
REQUESTS 9 made today · cap 10`, `TOKENS TODAY 4609`, and `NEXT CALL would be
permitted`, all taken from `/api/v1/health`.

One honest wart is visible in that capture: the status panel says **`VERIFIED
LIVE: not verified (a smoke test is required)`** even though a live smoke test has
now passed. That is the health endpoint refusing to claim reachability it cannot
observe — `runtimeAi.reachable` is always `null` — and the panel names what would
settle it, so the text is not false. It is nonetheless misleading to a judge on
the one screen that is supposed to answer "is this working", and surfacing a
*recorded* smoke result would be the fix. Not changed here: it would mean the
server reading a docs artifact, which is worse than the wart.

No question was asked through the UI during this pass. Nine of the ten
embedding requests for the day are spent, and the tenth was deliberately left
unused so the demo keeps one.

## P7-7. Still not established

- **A deployment.** No public URL exists. The Vercel procedure in
  [DEPLOY.md](DEPLOY.md) needs an account a human has to authorise, and it would
  inherit the two missing names from P7-1 — a deploy made now would refuse every
  turn. Nothing in this part has been checked on a deployed origin.
- **A separately-reported reasoning count.** Groq reports none, so the mapping
  "reasoning is inside completion" is the only live-verified case. The accounting
  path for a provider that reports reasoning separately is covered by mocked tests
  only.
- **Groq's rate limits.** One smoke call and three canary calls succeeded 20 s
  apart. That is consistent with the free tier tolerating this pace; it is not a
  measurement of the tier's limits, and no 429 was observed to record guidance
  from.
- **Embedding cost**, still unmetered by design: the cap bounds request count and
  nothing else. Nine of ten requests for the day are now used.

---

# Part 08 — the real lesson video (2026-10-16)

## P8-1. What was in the tree, before anything was changed

`git status` showed exactly one uncommitted thing: an untracked file at the
repository root, `Don't learn AI Agents without Learning these Fundamentals
1080P.mp4`, 246,439,107 bytes (235.0 MiB), on branch `main` at `4dabf92`.

`ffprobe` on that file: container `mov,mp4,m4a,3gp,3g2,mj2`, duration
**3399.295900 s (56:39)**, one `h264` 1920x1080 video stream and one `aac` stereo
audio stream, 579,976 b/s. **Two streams only — there is no subtitle stream**, so
the file itself cannot supply captions.

A search for `*.vtt`, `*.srt`, `*.json`, `*.txt`, `*transcript*`, `*caption*` and
`*subtitle*` outside `node_modules`, `.git` and `.next` found **no transcript or
caption file of any kind**. There was nothing to index, and nothing was invented
to stand in for it.

The original source is genuinely this recording: YouTube's public oEmbed endpoint
for `ZaPbP9DwBOE` returns title *"Don't learn AI Agents without Learning these
Fundamentals"*, author *KodeKloud* — the same title as the downloaded file, which
is what makes the embed fallback in P8-2 a statement about the same lesson rather
than a plausible-looking substitute.

One further fact, recorded because the report owes an answer to "were real
timestamped captions available": the watch page's embedded player response
contains a caption track with `vssId: "a.en"` and `kind: "asr"`, i.e. YouTube
exposes **auto-generated English captions** for this video. **They were not
downloaded, not stored and not used.** An unofficial caption fetch is not a
foundation a submission should rest on, and the ingestion it would require is a
deliberate project of its own, not a side effect of this change. It is named here
as the one honest route to video-grounded Q&A later.

The spend state was read *before* any work, from the application's own endpoint,
because the brief called the embedding allowance nearly exhausted:

| Reading | Value | Source |
|---|---|---|
| `runtime.spentTokensToday` | 0 | `/api/v1/health` |
| `runtime.embeddingRequestsToday` | 0 of `maxEmbeddingCalls` 10 | same |
| `runtime.spendGuard` | `permitted` | same |
| `runtime.configurationProblems` | `[]` | same |

**No embedding or generation call was made in this part.** Nothing in Part 08
costs quota.

> **Correction to P7-1 and P7-7.** P7-1 listed `HORIZON_DAILY_TOKEN_BUDGET` and
> `HORIZON_MAX_EMBEDDING_CALLS` as absent from `.env.local`, and P7-7 said a deploy
> would inherit that. Both names are now set locally, and the readings above are
> the proof: with either still absent, `HORIZON_DAILY_TOKEN_BUDGET` would resolve
> to `0` and `spendGuard` would read `blocked` rather than `permitted`. The two
> observations are left in place above rather than rewritten — they were true when
> they were taken — and the DEPLOY.md procedure still requires both to be set in
> the host, because a host has its own environment.

## P8-2. What was integrated

| Piece | What it does |
|---|---|
| `src/lib/lesson/video.ts` | The recording's identity (source id, title, author, measured duration, file name) and the **decision** of where it plays from. No `node:fs`, so a client component can import it. |
| `src/lib/lesson/video-file.ts` | Server-only: looks for the local file, reports its real size, or reports nothing. |
| `src/app/api/v1/lesson/video/route.ts` | Streams the local file with byte-range support, and 404s honestly when this deployment has no copy. |
| `src/components/lesson-video.tsx` | The player. Local `<video>` where a local copy exists; the original YouTube embed, read through the official IFrame Player API, where it does not. |
| `learner-workbench.tsx` | A **lesson video** section above the workbench, and relabelling of the fixture panel so its numbers cannot be read as the video's. |

The central decision is that **the video's clock and the fixture's clock are
different things and the page says so**, rather than pretending to satisfy "the
displayed position, the submitted lesson position and the citation timestamps
agree" by wiring real playback time to synthetic evidence. That wiring would
produce exactly the deception this part exists to prevent: at video 12:00 the
scope chip would have read *15 eligible blocks* about a recording that has no
indexed text at all. So:

- The **video panel** shows real playback time and its real duration.
- The **fixture panel** is labelled *Sample fixture — synthetic, not the video
  above*, its control is the *Sample-fixture position*, and the question box
  states that answers come from that fixture and never from the recording.
- An amber notice under the player carries the sentence the design turns on:
  *"Horizon holds no evidence from this recording, so no answer can cite it."*

## P8-3. The clock is the player's, measured

| Probe | Reported |
|---|---|
| `ffprobe` on the file | 3399.295900 s |
| `HEAD /api/v1/lesson/video` | `200`, `content-length: 246439107`, `accept-ranges: bytes`, `content-type: video/mp4` |
| `bytes=0-15` | `ftypisom` — real MP4 bytes from offset 0 |
| `bytes=1000-1023` | `206`, 24 bytes |
| `bytes=120000000-120000099` | `206`, `content-range: bytes 120000000-120000099/246439107` |
| `bytes=999999999-` | `416` |
| With the file moved away, and in the browser | `404` with `NOT_FOUND`; the page switched to the embed and said so |
| `<video>` in the page | `duration` **3399.2959** — the file's own figure, not a constant |
| Desktop capture, seeked to 1875 s and played | panel read **`Playing at 31:17 / 56:39`**, element `currentTime` 1877.96 |
| Mobile capture, seeked to 600 s and played | panel read **`Playing at 10:02 / 56:39`**, element `currentTime` 602.96 |

The embed fallback — which is what a host will actually serve, since no host
receives a 235 MiB blob — was verified by moving the local file out of the way
(with the checksum confirmed unchanged afterwards: `73515aa7…`):

| Check | Observed |
|---|---|
| Player rendered | An iframe created by YouTube's API: `https://www.youtube.com/embed/ZaPbP9DwBOE?rel=0&playsinline=1&enablejsapi=1&origin=http%3A%2F%2Flocalhost%3A4321…` |
| API loaded | `window.YT.Player` present |
| Real duration read from the player | **`/ 56:40`** — YouTube's own figure, not our constant |
| Clock after a real click on the player | **`Playing at 00:05 / 56:40`** |

That last row matters: a programmatic `playVideo()` sent through the widget
channel did **not** start playback (autoplay policy), which would have left the
embedded clock unverified. A genuine pointer click on the player did start it, and
the panel then reported the embedded player's own advancing time.

A defect was found on the way and fixed. The first `next build` after the
filesystem lookup warned that the dynamic access caused *"the whole project [to be]
traced and included in the output"* — the precise mechanism by which a 235 MiB
recording and every source file would have entered a deploy artifact. The lookup
now carries a documented `turbopackIgnore` marker, and the warning is gone:
`.next` contains no file over 5 MiB other than Turbopack's own build cache.

## P8-4. What is still synthetic, and is labelled as such

Everything the assistant can cite. The evidence store is the same labelled
sample fixture as before — a synthetic retry-and-backoff lesson with a 15-minute
timeline — and the video is not in it. The interface now says this in three
places rather than leaving a reader to infer it: the notice under the player, the
fixture panel's own badge, and the line above the question box. The older claim
in this document that there is *"no lesson video"* was true when it was written
and is not true now; it is superseded here rather than edited.

## P8-5. Visual verification, on pixels

`preview_screenshot` again returned *"no frames"* (the webview does not
composite), so the captures come from headless Chrome driven over the DevTools
protocol, and the PNGs were decoded and counted programmatically — exact colour
frequencies and per-cell mean luminance, not a glance at a file.

| Capture | Size | Dark ink | Near-white | Palette | Overflow |
|---|---|---|---|---|---|
| [Desktop](evidence/lesson-video-desktop.png) | 1440x2541 | 19.02% | 77.05% | `#F1F5F9`, `#FFFFFF`, `#F8FAFC`, `#000000` (16.16% — the player's area: 1104x621 of 3.66 M pixels is 18.7%, so the region is where the player is, and whether a decoded frame or the element's own dark background occupies it is not distinguishable from pixels alone), `#FFFBEB` (3.39%), accent `#1447E6` | none (`scrollWidth` 1440) |
| [Mobile](evidence/lesson-video-mobile.png) | 390x4345 | 7.08% | 85.90% | `#FFFFFF`, `#F8FAFC`, `#F1F5F9`, `#FFFBEB` (5.37%), `#000000` (3.14%, again the player area — 358x201 of 1.69 M is 4.3%) | none (`scrollWidth` 390) |

The luminance grid is light at the top and bottom and dark across the middle
rows — the player and the dense text, in the place the layout puts them — with no
uniform mid-luminance band anywhere, which is the blank-region failure mode P6-1
was about. Raw observations are kept in
[the capture JSON](evidence/lesson-video-capture.json).

## P8-6. Not established

- **Video-grounded Q&A.** Unavailable, not merely unverified: no transcript
  exists for this recording. The page says exactly that, and no answer claims to
  come from the video.
- **The embedded clock under a policy that forbids autoplay.** It was observed
  advancing after a real click. Nothing here was measured in a browser that
  refuses embedded playback outright; the code reports the clock as unavailable
  and links to the source in that case, and that branch is not exercised by a
  real browser in this environment.
- **A deployed origin.** Still no public URL. Nothing in Part 08 was checked on
  one; the embed path was verified by removing the local file from a local
  production build, which is a simulation of a host, not a host.
- **That the screenshots contain decoded video frames.** The element is proven to
  be decoding and playing — `readyState` 4, `duration` 3399.2959, and a
  `currentTime` that advances from a seek — and the panel's clock is read from it.
  Whether headless Chrome composited an actual frame into the PNG is a separate
  question this pixel count cannot answer: the dark region is the player's area
  (the counts above match its box), and it could be a decoded frame or the
  element's own background. Not claimed.
- **That a host would ever stream the recording.** It would not, by design: the
  route 404s there, `.gitignore` keeps the blob out of the repository, and the
  app falls back to the original source.

# Part 09 — the recording's own captions, ingested and interrogated (2026-10-16)

Part 08 ended with video-grounded Q&A **unavailable**: there was no transcript for
the recording and its container carries no subtitle stream. This part removes that
blocker with the recording's **own** captions, and then tries to break the result.

## P9-1. What was fetched, and from where

| Fact | Value |
|---|---|
| Source | `https://youtu.be/ZaPbP9DwBOE` — KodeKloud, *Don't learn AI Agents without Learning these Fundamentals* |
| Caption track | YouTube **automatic** English captions (`en`), present in the track list yt-dlp reports |
| Fetch command | `yt-dlp --skip-download --write-auto-subs --sub-langs en --sub-format json3` |
| Format | `json3`: one event per caption line, each with the source's own `tStartMs`, plus word-level `tOffsetMs` |
| File | 1 038 867 bytes, sha256 prefix `d7c6e21c20d70d64…`, gitignored (third-party artefact; the ingest command takes a path) |
| Parsed | **1505 caption lines**, 1505 display-only newline events skipped |
| Timestamp coverage | **0.1 s → 3386.5 s** of the recording's ffprobe-measured **3399.2959 s** = **99.6%** |
| Segmentation | **56 blocks**, mean 60.5 s, max 62.4 s, contiguous (each block's end is the next block's start) |

**Nothing was written by hand and nothing was corrected.** Every word is what the
ASR emitted, including its errors (`Chachib`, `Enthropics`, `langraph`), because an
edited transcript would be a different text from the recording and no quotation
could be attributed to it. The ASR caveat is rendered app-side next to the player.

## P9-2. What was written, and what it cost

| Fact | Value |
|---|---|
| Course | one course, id derived from the video id (`083d7195-9371-5202-93dc-a724ad7982cc`), 3399.2959 s |
| Resource | one `transcript` resource, `parser_version: youtube-json3-v1`, `extraction_coverage: 0.996` |
| Blocks | **56** rows, `block_type: transcript`, `policy: TIMELINE_BOUND`, `review_state: AUTO_APPROVED`, `ingest_status: INDEXED` |
| Vectors | 56/56 at **768** dimensions from `gemini-embedding-001`; 0 rows with a null embedding |
| Unlock rule | `unlock_seconds = end_seconds` for all 56 rows — a block becomes eligible only once it has been **watched to its end** |
| Synthetic-fixture contamination | **0 rows** contain the fixture's invented text; the sample lesson is a separate course |
| Embedding requests | **3** (0 → 3 of a daily cap of 10), one admission per batch of 25 blocks |
| Generation tokens | **0** — this command makes no model call |

`pnpm ingest:lesson --dry-run` first, which parses, segments and prints coverage
having written nothing and sent nothing.

## P9-3. The canary: 31 passed, 0 failed, 1 not run

`pnpm canary:lesson --positions 300,1200,3000` against the production build on
`127.0.0.1:4321`, four live turns. The harness reads the stored transcript itself
and builds its **own** expected-eligible set, so the citations below are checked
against the actual evidence a turn used.

| Turn | Position | Question | Result |
|---|---|---|---|
| 1 | 05:00 | *What topics does the instructor list at the very start of this lesson?* | `TEMPORARILY_UNAVAILABLE / PROVIDER_MALFORMED` → **NOT RUN** (see P9-4) |
| 2 | 20:00 | *What happens when the compliance score falls below 75%?* | `INSUFFICIENT_EVIDENCE / UNSUPPORTED_BY_EVIDENCE`, 0 claims — the fact unlocks at **44:52** |
| 3 | 50:00 | the same question | `ANSWERED`, 1 claim, 1 citation to `Transcript 44:52–45:53` |
| 4 | 50:00 | *How do I configure a Kubernetes ingress controller to serve gRPC over HTTP/2?* | `INSUFFICIENT_EVIDENCE`, 0 claims (no marker phrase exists anywhere in the corpus) |

Checks that ran for every turn and passed: the app's eligible count matched the
independent oracle (4 / 19 / 49 / 49); the late fact was absent from the eligible
set **and from the entire response body** before its unlock and present after it;
every citation id was inside the eligible set; every quotation appeared verbatim in
its cited stored block; every citation label carried that block's real clock; no
collapsed internal state token appeared.

The citation from turn 3, verbatim from the artifact:

```
text      If the compliance score is below 75%, the workflow routes back to node
          one to gather additional documents.
cite      c4e269b3-ac4d-5c01-872d-4b4863a7c004 · Transcript 44:52–45:53 · 2692.8–2753.119 s
quote     If node 3 determines compliance score is below 75% the conditional edge
          routes back to node one to gather additional documents.
```

Raw artifact: [docs/evidence](evidence/canary-lesson-lesson-2026-10-16T19-02-50-181Z.json).

## P9-4. The canary found a real defect, and the re-run cleared it

Turn 1's failure was not a provider outage. The server log named it:

```
[horizon] provider failure at generate: malformed_response — The model response did not match the claim schema (claims:too_big).
```

The generation envelope accepted at most **8** claims; the model returned more, so
a perfectly answerable question was rejected and reported to the learner as
"temporarily unavailable". The count is not a truth property — Tier-1 checks every
quotation against the payload and Tier-2 verifies every claim, rendering only the
supported ones — so the bound was raised to 40, and the verifier's verdict bound
raised above it so an accepted response can always be answered verdict-for-verdict.

Re-run at the same early position:

| Check | Result |
|---|---|
| `expected-outcome` | **PASS** — `ANSWERED`, 14 claims, 14 citations |
| `citations-eligible` | **PASS** — 0 of 14 outside the 4-block eligible set |
| `quotes-verbatim` | **PASS** — 0 of 14 failed to match the stored text |
| `citation-clock` | **PASS** — 0 of 14 disagreed with the stored start time |
| `no-fact-in-response` | **PASS** — the late fact is still absent at 05:00 |
| Summary | **8 passed, 0 failed, 0 not run** |

Raw artifact: [docs/evidence](evidence/canary-lesson-early-after-envelope-fix-2026-10-16T19-07-00-150Z.json).

## P9-5. Playback position → eligibility, in a real browser

Measured on the running production build at `127.0.0.1:4321` (Chromium via CDP),
not inferred from code:

| Observation | Value |
|---|---|
| Player | `<video src="/api/v1/lesson/video">`, `readyState` 4, `duration` **3399.2959** (the file's own) |
| Play | `currentTime` advanced 0 → **3.417 s** in 3.5 s with no error |
| Seek | the "10:00" preset put the element at **600.0 s**; the panel then read `10:00 / 56:39` |
| Position source | `Source: the player's own playback clock.` |
| Evidence in scope | **0** blocks at 00:03 → **9** at 10:00 → (canary) **19** at 20:00, **49** at 50:00 |
| Desktop 1440×1000 | `scrollWidth` 1440 = `clientWidth` 1440, no horizontal overflow; PNG 1440×2814, dark ink 17.44%, near-white 78.74%, accent `#1447E6` |
| Mobile 390×844 | no element wider than the viewport, `scrollWidth` 390; PNG 390×4708, dark ink 7.05%, near-white 85.80% |
| Captured page text at both widths | contains the indexed badge, the ASR provenance paragraph, `the player's own playback clock`, `eligible transcript block`, the lesson switcher and `Playing at` |

Artifacts: [lesson-video-capture.json](evidence/lesson-video-capture.json),
[desktop PNG](evidence/lesson-video-desktop.png),
[mobile PNG](evidence/lesson-video-mobile.png).

## P9-6. The status line that never changed

`checks.runtimeAi.reachable` is still `null` — this endpoint sends no request of
its own, so it must not claim a provider is live. What replaced the permanent
`not verified (a smoke test is required)` is `runtime.providerCallEvidence`, read
from the durable ledger: the newest **settled, reported** generation row, with its
timestamp and whether it falls inside the current UTC day. Four states are kept
distinct — `observed`, `none_recorded`, `not_durable`, `unreadable` — and the
memory ledger reports `not_durable` rather than implying that no call ever
succeeded. Observed live on this build:

```
observed · 2026-10-16T19:06:58Z · groq / openai/gpt-oss-20b · inside today's UTC day
```

## P9-7. Budget, before and after

| Meter | Before this part | After the ingest | After the canaries and the browser work |
|---|---|---|---|
| Embedding requests (cap 10/day) | 0 | 3 | **8** |
| Generation tokens (ceiling 20 000/day) | 0 | 0 | **15 132** |

The two canary runs and the browser checks cost 8 embedding requests and 15 132
generation tokens in total; the ingest itself cost 3 requests and no tokens.
Counters were never reset or raised, and no cap was bypassed. The remaining 4 868
tokens of the day were deliberately **not** spent on further turns.

## P9-8. The citation's play button, and the defect it was hiding

A citation panel offers **Play this passage**, and until this check it did not
play. It seeked — `startSeconds - 3` — and stopped there, so a learner who clicked
a button labelled *Play* got a still frame with no explanation. Two things were
wrong, and the second only appears once the first is fixed:

1. the handler requested a seek with no playback intent at all; and
2. requesting playback in the **same tick** as the seek makes Chromium abort it —
   `play()` is rejected with `AbortError` and the element ends up paused, which is
   how the first attempt at a fix behaved in this browser.

The seek request now carries an explicit `play` flag, set only by this button, and
playback is requested **after the seek settles** (`seeked`). Measured on the
running production build at `127.0.0.1:4321`, with the recorded 50:00 turn served
into the real UI and a real pointer click:

| Check | Observed |
|---|---|
| Seek target | `startSeconds` 2692.8 → element at **2689.8 s** (`44:49`, the passage start with a 3 s lead-in) |
| Playback requested | `play()` called with `seeking: false` — after `seeked`, not alongside it |
| Playback accepted | `play()` **resolved**; `play` and `playing` events fired; not rejected |
| Playback sustained | `currentTime` advanced **2693.0 → 2696.1** over 3.2 s (`advanced 3.09`), still playing at the read |
| Panel clock | read `Playing at 44:55 / 56:39`, `PLAYBACK POSITION` `44:55` — the player's own clock |
| Refusal path | with playback blocked, the panel says so instead of showing a still frame under a Play button |
| A preset jump does **not** play | video paused first, then a real click on `Jump to 10:00`: element at **600.0 s**, still **paused**, **0** `play()` calls, panel `10:00` |
| Eligibility follows the seek | **49** blocks at 50:00 → **44** at 44:55 → **9** at 10:00 |

Two limits on this evidence. There is no screenshot: the preview webview reported
that it was **not being composited** (`it produced no frames`), so no PNG exists
for this check. And in that un-composited state Chromium **suspends playback** —
about a second after a play is accepted, with no script call — which is why the
sustained row was re-measured in a freshly opened tab. The suspension is the
browser's, not the app's, and it is visible as such: the refused-playback notice
stays down (`play()` resolved, nothing was refused) while the panel's clock simply
stops where the browser stopped it.

## P9-9. Not established here

- **Whether the ASR text is faithful to the audio.** It is faithful to the
  *captions*; whether YouTube's recognition is correct is not something this
  project can measure, and it is why every screen says "machine transcription".
- **The whole recording.** Coverage is 99.6%, not 100%: 12.8 s of the recording has
  no caption text, so a question about that span has no evidence regardless of the
  playhead.
- **Any deployed origin.** Still no public URL (see [DEPLOY.md](DEPLOY.md)). Every
  check in this part was against loopback, and the deployed path — the YouTube
  embed instead of the local file — has not been exercised on a host.
- **A second provider or model.** One live provider (Groq) and one embedding model
  were exercised. No claim is made about others.
- **Sustained playback in the un-composited preview webview.** Playback was
  sustained in a normal tab; in a webview Chromium was not compositing, media is
  suspended roughly a second after a play is accepted. That is a property of that
  browser state, and it is reported rather than worked around.

# Part 10 — 2026-10-18: deployment, claim shape, and document resources

Every number below was produced on this date. Where a check could not run, it says
so and gives the reason; nothing in this part is projected or extrapolated.

## P10-1. The deployed origin

`https://horizon-prototype.vercel.app` — built by the Vercel CLI from this
repository's `main` at `f9e4b7a`, with the production environment variables set from
the operator's own `.env.local` over stdin (no value printed, no value committed).
Deployment protection was switched off explicitly; before that, every path returned
Vercel's SSO page to an anonymous visitor, which is not a deployment a judge can open.

| Check | Observed |
|---|---|
| `GET /` | `200`, 20,259 bytes, `text/html` |
| `GET /api/v1/health` | `ok: true`; `spendGuard: "permitted"`; `querySucceeded: true`; `schemaObjects: "verified"`; `durableLedger: "usable"`; `configurationProblems: []`; `evidenceSource: "supabase"` |
| `GET /api/v1/courses` | both courses, served from Supabase |
| `GET /api/v1/courses/:id/scope` | `10` at 00:03, `20` at 10:00, `66` at 50:00 |
| `GET /api/v1/lesson/video` | `404` — expected: the 235 MiB file is not uploaded |
| Player on the deployed page | an `iframe` pointing at `youtube.com/embed/ZaPbP9DwBOE` with `origin=https://horizon-prototype.vercel.app`; no `<video>` element; the page says it is playing from the original source |
| Console | 8 warnings, all `Unrecognized feature: 'web-share'` from the YouTube iframe; no application error |
| Screenshots | captured of the deployed page (player and runtime panel) — the webview composited normally this time, unlike Part 09's attempt |

## P10-2. A supported question was being refused, and why

The first production canary on this date reported `1 failed, 2 not run`:

- turn 1 at 05:00, "What topics does the instructor list at the very start of this
  lesson?", returned `INSUFFICIENT_EVIDENCE` with 4 eligible blocks;
- turns 3 and 4 were `PROVIDER_RATE_LIMITED` (Groq's free-tier tokens-per-minute
  ceiling, hit by running four turns back to back).

A diagnostic script called the generator and verifier directly with those same four
blocks and printed what came back: **fourteen one-word claims** ("Prompt engineering",
"Context", "Windows", …), each carrying the same verbatim list quotation. Tier-1
accepted all fourteen; the verifier rejected the turn as a whole. The transcript did
support an answer; the answer shape did not.

**Change.** The generator instruction now requires a complete, self-contained sentence
per claim, at most five claims, and a contiguous verbatim quotation with no
punctuation repair; the verifier instruction states that a claim restating an item
from a list in the evidence IS supported. The pipeline also bounds each block to
1,500 characters in the prompt and verifies at most five claims, dropping overflow
before the verification call.

**Measured on the same question and the same four blocks, before → after:**

| Figure | Before | After |
|---|---|---|
| Claims returned | 14 | 2 |
| Generation prompt tokens | (not captured for that run) | 1,379 |
| Verification prompt tokens | 4,074 | 926 |
| Verdicts | all rejected | 2 × SUPPORTED |
| Turn outcome | `INSUFFICIENT_EVIDENCE` | `ANSWERED`, 2 claims, 2 citations |

The next canary run (`local-after-prompt-fix`) then reported **16 passed, 0 failed, 0
not run** across 05:00 and 20:00 — the early question answerable with two verbatim,
clock-checked citations, and the late fact still absent from the eligible set and
from the response body at 20:00. It stopped before turn 3 itself, printing that 4,948
tokens remained and that was not enough for two more metered calls.

## P10-3. Document resources, ingested live

`pnpm build:materials` compiled two documents from the **stored** transcript — 56
blocks, 8 segments, no model call — into `.freebuff/materials/`. Both state on their
face that they are team-authored from the automatic captions and are not the
instructor's material, and both are gitignored because the text is a third-party
caption track.

| Document | Parse result | Ingest result |
|---|---|---|
| `lesson-notes.pdf` (8,477 bytes) | 3 pages, 3 with text, coverage 1.0, `unpdf-pdfjs-v1` | 10 blocks, `COURSE_WIDE` / `HUMAN_APPROVED` / lint `PASSED`, 768-dim, 1 embedding request |
| `lesson-slides.pptx` (111,759 bytes) | 9 slides, 9 with text, coverage 1.0, `pptx-ooxml-v1` | 9 blocks, `TIMELINE_BOUND`, 7 `AUTO_APPROVED` + 2 `PENDING`, 1 `FLAGGED` (it quotes the late fact, but it is time-gated), 1 embedding request |

The study guide was approved course-wide only because the lint found **none** of the
registered late-only markers in it — confirmed by re-parsing the stored PDF and
searching for `compliance score` and `75%`, both `false`. The generated excerpts
sample the opening and middle line of each segment, and the segment containing the
threshold is not among them. That is a property of this document, not of PDFs in
general; a document that did contain the fact would be refused.

What the parse does NOT claim: a page with no text layer is reported as visual-only
and excluded from the block count, so `extraction_coverage` is 1.0 here because every
page had text — not because OCR ran.

## P10-4. The alignment algorithm had two real defects, found by its own output

1. **A zero score reported a match.** A chunk about Kubernetes ingress, which the
   recording never mentions, aligned to transcript window 0 with score 0 and got that
   window's 60-second unlock time. Fixed: a zero score is no match, `bestIndex` is
   `-1` and the unlock is `null`.
2. **The runner-up margin went negative.** Slides were scored against one 60-second
   block, so a slide summarising seven minutes could never score well; and the winner
   was chosen by best single block rather than best stretch, so a "winner" could be
   beaten by a stretch of the recording outside it — a negative margin, which is
   incoherent. Fixed: alignment grows a contiguous run from its seed, and the winner
   is the best run over all seeds.

After the fix, the deck went from 1 auto-approved / 8 pending to **7 auto-approved /
2 pending**. The two that still needed a human were the title/provenance slide
(score 0.07) and a content slide scoring 0.90 with a 0.00 margin — the multi-topic
ambiguity the blueprint says a human should see.

## P10-5. The review workflow, exercised live

```
pnpm review:alignments --reject 4eb1ccaf… --reason "title and provenance slide: metadata, not lesson content"
  → Rejected. It is no longer eligible and cannot be cited.
pnpm review:alignments --approve 33f728f0… --unlock 14:18
  → review_state=HUMAN_APPROVED, unlock=14:18. It becomes evidence at or after 14:18 only.
```

`--unlock` is required for an approval: approving without a time would leave the block
approved and still ineligible, which is a no-op dressed as a decision. The scope count
moved with both decisions (`20` at 10:00 after the approval, up from 19).

**Limit, stated plainly:** this schema has no `alignment_events` table, so there is no
durable reviewer identity, timestamp or approval history. A rejection reason is
appended to `blocks.alignment_method` with a `rejected:` prefix, and `updated_at` moves
on the row. Nothing here claims an audit trail it cannot keep.

## P10-6. Post-ingest canary

`pnpm canary:lesson --positions 300 --max-turns 1` reported **8 passed, 0 failed, 1 not
run**, including the new `references-do-not-leak` check (10 `COURSE_WIDE` blocks in the
course, 0 eligible and containing the late fact) and an eligible-set count of 15 that
matched the independent oracle over 75 stored blocks. The run's single turn returned
`TEMPORARILY_UNAVAILABLE` / `BUDGET_EXHAUSTED`, so its answering check is **NOT RUN**:
the day's 20,000-token ceiling was already spent (15,052 recorded, and the remainder
is smaller than a generation reservation). This is the guard working; it is not
evidence that the answering path works with documents in the corpus, and that turn
must be repeated on a fresh UTC day.

## P10-7. Spend, honestly

The durable ledger recorded **15,052 generation tokens and 10 of 10 embedding
requests** for 2026-10-18 by the end of this work. It does not record the two
diagnostic calls in P10-2, because those scripts called the generator and verifier
directly rather than through the pipeline, and only the pipeline reserves and settles.
Their real cost was roughly 11,500 tokens across four calls: generation 4,556 and
verification 4,074 in the first diagnostic, then 1,379 + 341 + 926 + 113 in the
second. So true provider usage on this date is about 26,500 tokens against a recorded
15,052 and a 20,000 ceiling. Two consequences follow, and both are recorded as
findings rather than footnotes: a diagnostic must go through the metered path, and
the spend guard as built protects the pipeline, not the provider account.

## P10-8. Still not established

- **A post-ingest answered turn.** Blocked by the day's budget (P10-6).
- **The late-fact turn on a deployed origin.** The pre-ingest production canary could
  not reach it either (rate limit), and later runs had no budget.
- **PDF/PPT citation rendering in the browser.** The label logic and the absence of a
  seek button for a block with no clock are unit tested, and the API returns those
  citations, but no screenshot of a rendered PDF citation exists.
- **Mobile layout after these changes.** Verified in earlier parts at 390px; not
  re-checked after the citation-panel wording change.
- **Summary, quiz and mock interview.** Not built.

---

# Part 11 — 2026-10-18: the learning studio (interface only)

This part records an interface revision. No prompt, provider, retrieval branch,
predicate, model or spend limit was changed, and **no model or embedding call was
made**: the ledger read 15,052 tokens and 10/10 embedding requests before and
after the work. The full audit that scoped this is
[UI-AUDIT.md](UI-AUDIT.md); the decisions are D-035 to D-038.

## P11-1 — What replaced what

`src/components/learner-workbench.tsx` (1,366 lines, one page, diagnostics on the
learning surface) was removed and replaced by a studio with five destinations:

| Surface | Content |
|---|---|
| Learn | lesson stage (real player, transport, timeline, watched bar, bookmark), scope strip, transcript pane, assistant |
| Materials | source library with policy and counts, permission-filtered document viewer with page/slide chips and text zoom |
| Notes | bookmarks and notes at a position, editable, two-step delete, browser-local |
| Progress | watched coverage versus furthest position, coverage map, resume |
| System status | the previous health cards, unchanged in content |

Two read endpoints were added, both returning only blocks permitted at the
requested position:

- `GET /api/v1/courses/:id/transcript?playheadSeconds=`
- `GET /api/v1/courses/:id/resources/:resourceId?playheadSeconds=`

`EvidenceBlock` gained an optional `textOriginal` (the stored caption line
breaks) for the transcript pane. Prompts and quotation matching still use
`text`.

## P11-2 — Checks

| Command | Result |
|---|---|
| `pnpm lint` | exit 0, no warnings |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **365 passed in 23 files** (was 345 / 22). The new file is `tests/personal-and-panes.test.ts`, 20 cases |
| `pnpm build` | exit 0; the two new routes appear in the route table |
| `pnpm start --port 3100` | 200; loaded with **no console errors and no hydration warning** in the production build |

The new tests cover the parts of the interface that can be wrong without a
browser: persisted-state validation and entry-level recovery, bookmark and note
caps, the rule that a step over five seconds is a seek and not watching, range
merging, watched fraction and buckets, transcript gap detection, half-open
segment lookup, case-insensitive search, paragraph re-flow that preserves every
word, and resource grouping by page/slide/line.

## P11-3 — Browser verification

Rendered in Chromium through the preview panel, against the real database and the
real 235 MiB local recording.

| Width | Result |
|---|---|
| 1440×1000 | rail + two-column Learn; Materials with page chips; Status with live ledger figures |
| 1024×900 | rail, single content column; top bar truncates the breadcrumb rather than stacking the status label |
| 768×900 | mobile header, five equal nav columns, full-width player, no horizontal overflow |
| 390×844 | same, scope strip stacked, assistant immediately after the scope strip |
| 360×780 | nav labels still fit; timeline controls wrap rather than clip |

Interactions executed, not inferred:

- A jump to **25:00** seeked the real element (`currentTime` 1500) and the scope
  moved to **37 eligible blocks**, matching `GET /scope`.
- The transcript request at that boundary returned **24** timestamped passages;
  the pane scrolled to the reached passage after the seek, and the current-line
  highlight was absent because the block containing 25:00 had not finished
  unlocking. That absence is the predicate working, not a rendering bug.
- **Bookmark** at 25:00 and a note were saved, then survived a full reload
  (`localStorage` inspected: 1 bookmark, 1 note).
- Playing from 00:00 for 25 s recorded **25 s watched**, while the earlier seek
  left `watched` empty and moved only `furthestSeconds` to 1500. The Progress
  screen showed both figures and the coverage map filled only the first bucket.
- Switching to the sample lesson through the lesson switcher changed the stage,
  removed the recording's source link, labelled the timeline as the fixture's own,
  and loaded that course's scope, transcript and materials.
- Materials at 25:00: study guide 10/10 blocks permitted (course-wide), slides
  3/9, transcript 24/56. The viewer's default selection is the study guide, not
  the transcript.

## P11-4 — Not verified

- **A live answer rendered in the redesigned assistant.** The provider calls are
  metered and this phase forbade them, so no question was asked. The result and
  citation markup compiles against the response contract and mirrors the markup
  verified in Part 10, but the rendered result state has not been seen since the
  redesign. This is the first thing to check when the daily budget resets.
- **The deployed origin for this revision.** The local production build is
  verified above; the deployment outcome is appended below once it exists.
- **A mobile re-check after this exact commit.** The widths above were checked on
  the working tree immediately before the commit; nothing changed after them.
- The PDF viewer shows the stored text layer, with headings and in-page paragraph
  breaks flattened at ingest (P10 limitation). It is text, not a page facsimile.


---

# Part 12 — 2026-10-18: the home entry point and the Midnight Aurora identity (interface only)

Revision 3 of the interface. No prompt, provider, retrieval branch, eligibility
rule, model, budget or spend limit was changed, and **no provider call was made**:
the ledger read 15,052 tokens and 10/10 embedding requests before the work and the
same figures after it (`/api/v1/health` on the local server and on the deployed
origin).

## P12-1 — What changed

- `/` is a welcome page. It reads `listCourses()` once and this browser's
  `localStorage`; it makes no model call. The hero states the promise, the
  continue card shows the lesson with the most recent real progress, the catalogue
  lists the courses the store returned with the synthetic sample labelled, and an
  explicit "what this build does not do" panel replaces marketing claims.
- `/learn` is the studio, with `?lesson=`, `?section=` and `?start=` read on the
  server. The resume position is applied on the player's first clock report and
  then removed from the address.
- One dark identity in `@theme`, with the measured contrast ratio of every ink and
  status token recorded beside it, filled controls on `text-ink-inverse`, and
  glass restricted to the rail, the top bars and the hero.
- 6 new unit cases for the continue-lesson rules. `tests/personal-and-panes.test.ts`
  now has 26.

## P12-2 — Checks

| Command | Result |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **371 passed in 23 files** (was 365 in 23) |
| `pnpm build` | exit 0; `/` and `/learn` both in the route table |

## P12-3 — Browser checks, measured not inferred

Against the local dev server with the real recording, the real database and the
real personal store:

| Check | Measured result |
|---|---|
| Horizontal overflow at 1440 / 1024 / 768 / 390 / 360 px on `/` and `/learn` | `scrollWidth - clientWidth` = **0** at every width (the document reports 1423/1007/751/373/343 px of content width) |
| Resume from a link (`/learn?start=1500`) | `video.currentTime` **1500**, clock `25:00`, position source `the player's own playback clock`, and the address returned to `/learn` after the position was consumed |
| Evidence at that position | scope **37 blocks**, transcript **24 passages**, last passage ends at **1470.799 s** — identical to Part 11, so the redesign changed no eligibility behaviour |
| Lesson switch | heading changed to the sample, the video element was removed, the control was disabled and the pane stated the sample has no recording; address became `?lesson=sample` |
| Bookmark | saved at the current position and read back from `localStorage` as `horizon.personal.v1` (`1` bookmark), with the confirmation shown in the pane |
| Home continue card after that activity | `in progress` · `Watched 00:00 of 56:39 · 0% · reached 25:00` · primary link `/learn?lesson=recording&start=1500` |
| Accessibility | no element with a tap target under 24 px remains in the header or footer; the six-item mobile navigation shows all six labels at 360 px with no clipping |
| Console | no errors and no hydration warning on either route |

## P12-4 — One defect the responsive check found

The product header's three anchor links were hidden with `hidden sm:inline-flex`
next to a base class that also set a display value. Both are plain utilities at the
same specificity, so which won depended on stylesheet order rather than class
order, and at 390 px "How it works" rendered on a phone and pushed the page into
horizontal scroll. Each link now sits inside a `hidden sm:inline-flex` wrapper,
because a variant is generated after every plain utility. The overflow measurement
above is the proof: it was non-zero before the change and zero after.

## P12-5 — Not verified here

- **No live answer was rendered through the redesigned assistant.** That needs a
  metered provider call, which this phase forbids. The markup is type-checked
  against the response contract and is a restyle of markup verified in Part 10.
- **Frame timing under glass.** The blur is bound to three chrome surfaces and is
  disabled below 768 px, but no slow-device frame measurement was made.
- **The deployed origin for this revision.** Since verified and recorded in P12-6
  below, on both the preview and production.

## P12-6 — Deployment

Both environments were deployed from this repository's `main` at commit
`96759b7`, with the Vercel CLI, after the preview was verified.

| Environment | URL | Mode | Result |
|---|---|---|---|
| Preview | `horizon-prototype-8qvmfvpph-irrelevant3.vercel.app` | fixture (preview has no production env) | `/` 200 (33.5 KB), `/learn` 200, `/learn?lesson=sample` 200, health 200 with `evidenceSource: "fixture"`, `demoContent: true` |
| Production | https://horizon-prototype.vercel.app | Supabase | `/` 200 (35.6 KB), `/learn` 200 (38.6 KB), `/learn?section=materials` 200, `/learn?lesson=sample` 200, `/api/v1/lesson/video` 404 as designed |

Production values observed after the deploy:

- `GET /api/v1/health`: `ok`, `evidenceSource: "supabase"`, `spendGuard: "permitted"`,
  `querySucceeded: true`, **15,052 tokens** and **10/10 embedding requests** — the
  same figures as before the work, so this revision made no provider call.
- Scope at 00:00 → **10** eligible blocks; at 25:00 → **37**; transcript at 25:00 →
  **24** passages. Identical to Part 11, so nothing about eligibility moved.
- Home in the browser at 1440 px: `Learn beyond the lecture.`, the two real
  catalogue rows with the synthetic sample labelled and the two-course note shown,
  continue link `/learn?lesson=recording`, the evidence line reading "Evidence
  source: Supabase database … This page makes no model call.", and
  `scrollWidth - clientWidth = 0`.
- Studio in the browser at 1440 px: the real YouTube embed
  (`youtube.com/embed/ZaPbP9DwBOE`), the source line "original source ·
  ZaPbP9DwBOE", scope 10 blocks at 00:00, both navigations present (6 items each),
  `scrollWidth - clientWidth = 0`.

### Screenshots, and what was measured about them

Ten screenshots of **each** deployed origin were captured at 1440, 1024, 768, 390
and 360 px for `/` and `/learn` (headless Chrome, `--virtual-time-budget`), because
the editor's own preview surface stopped compositing frames partway through this
session. Each frame was then decoded and measured rather than assumed:

| Origin | Mean luminance (of 255) | Pixels differing from the modal colour | Distinct sampled colours |
|---|---|---|---|
| Preview `/` | 30.3 – 49.3 | 0.686 – 0.862 | 1,930 – 2,225 |
| Preview `/learn` | 28.7 – 32.3 | 0.712 – 0.765 | 1,036 – 1,366 |
| Production `/` | 30.7 – 49.3 | 0.686 – 0.862 | 1,865 – 2,225 |
| Production `/learn` | 38.3 – 44.3 | 0.718 – 0.757 | 7,607 – 14,726 |

A blank or failed frame measures ~255 luminance with a spread near zero. Every
captured frame is dark, is mostly non-modal content, and the studio's colour count
on the production origin (7,600–14,700) is an order of magnitude above the fixture
preview's, which is what rendering the real embed, transcript and materials looks
like. The frames are in `.logs/shots/` (gitignored, because they are host snapshots
rather than repository artifacts).

### Still not established on the deployed origin

- **A live answer through the redesigned assistant.** The daily ceiling and this
  phase's rules both forbid it; it remains the first thing to check on a fresh UTC
  day, as recorded in P11-4.
- **Frame timing with glass enabled on a low-powered device.** The blur is bound to
  three chrome surfaces and disabled below 768 px, but no device profiling was done.
