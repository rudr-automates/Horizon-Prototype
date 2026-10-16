# Deploying Horizon

**Status: NOT DEPLOYED. There is no public URL.** No host was configured in any
part of this work, so nothing here has been executed. This document is the
prepared procedure, not a report of a deployment.

The evidence a deployed instance would serve is already in the database this
procedure points at, so a host needs no extra data step: the recording's 56
transcript blocks live in Supabase (see EVALUATION.md Part 09). What a host does
NOT have is the 235 MiB recording itself, so it plays the original YouTube embed —
and that is the one path this procedure still cannot claim, because it has never
run on a host.

Read the last section before believing a deploy "worked".

---

## 1. What is being deployed

A single Next.js 16 application. It is **not** statically exportable: every API
route is `force-dynamic` and the learner workbench is a client component that
calls the server. The host must run a Node server.

| Fact | Value |
|---|---|
| Framework | Next.js 16 (App Router), `next build` / `next start` |
| Package manager | pnpm, pinned by `packageManager` in `package.json` |
| Runtime | Node (route handlers declare `runtime = "nodejs"`) |
| Build command | `pnpm build` |
| Start command | `pnpm start` |
| Server-only code | `src/lib/db/server.ts`, `src/lib/answer/gemini.ts`, `src/lib/ingest/seed.ts` |
| Lesson recording | **Not deployed, by design.** 235.0 MiB and a third-party download, so it is neither committed nor uploaded. The app streams it only where it exists locally (`GET /api/v1/lesson/video`, which `404`s on a host) and plays the original YouTube embed otherwise. See §7 |

## 2. Before deploying anything

Run these locally and require all four to exit `0`:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 3. Environment variables to configure in the host

Add these through the host's environment-variable UI. They must never be
committed, logged or placed in `NEXT_PUBLIC_*` (except the two that are
explicitly public).

| Name | Exposure | Required for | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | database path | Safe for the browser, but nothing client-side uses it yet |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | database path | RLS denies `anon` by design; see `docs/apply-migration.md` |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | database path | Bypasses RLS. Server-only. Never sent to the client |
| `HORIZON_LLM_PROVIDER` | server | inference | `groq` or `google-genai`. Any other value is reported as unrecognised and no model call is possible |
| `HORIZON_LLM_BASE_URL` | server | inference | Endpoint base for GENERATION. Empty means "use the provider's documented default", which for `groq` is `https://api.groq.com/openai/v1`. It is **not** forwarded to the Google SDK |
| `HORIZON_LLM_API_KEY` | **secret** | inference | **Generation** credential only. Under `google-genai`, `GOOGLE_API_KEY` / `GEMINI_API_KEY` are also accepted |
| `HORIZON_LLM_MODEL` | server | inference | `openai/gpt-oss-20b` under `groq`; `gemini-3.6-flash` under `google-genai` |
| `HORIZON_LLM_REASONING_EFFORT` | server | inference | `low` / `medium` / `high`. Leave empty to send nothing and accept the model's default |
| `HORIZON_EMBEDDING_API_KEY` | **secret** | retrieval | **Embedding** credential. Separate from the generation key: the two calls may go to different vendors, and one key must never stand in for the other. `GOOGLE_API_KEY` / `GEMINI_API_KEY` are accepted as fallbacks; `HORIZON_LLM_API_KEY` only as a legacy fallback under `google-genai` |
| `HORIZON_EMBEDDING_MODEL` | server | retrieval | `gemini-embedding-001` |
| `HORIZON_EMBEDDING_DIMENSIONS` | server | retrieval | `768`. Must match the stored vectors exactly |
| `HORIZON_DAILY_TOKEN_BUDGET` | server | inference | **`0` permits no provider call at all.** See §5 |
| `HORIZON_MAX_EMBEDDING_CALLS` | server | retrieval | **`0` permits no embedding request at all** under the durable cap. The token budget cannot bound embeddings, so this is the only control on their request count. It is a REQUEST cap, never a cost cap |
| `HORIZON_LLM_TIMEOUT_MS` | server | inference | `30000` is a sane start |
| `HORIZON_LLM_MAX_OUTPUT_TOKENS` | server | inference | `4096`. Reasoning tokens count against this, and a 1024 cap was observed live leaving only 21 visible tokens |
| `HORIZON_LLM_THINKING_BUDGET` | server | inference | `google-genai` **only**. Leave unset to send no `thinkingConfig`; `-1` is the provider's automatic mode. Under `groq` it is ignored, and `/api/v1/health` reports it as ignored rather than dropping it silently |

`vercel env add <NAME> production` is the CLI equivalent; the dashboard path is
**Project → Settings → Environment Variables**.

## 4. Vercel through the GitHub repository

1. Sign in at `vercel.com` and choose **Add New… → Project**.
2. **Import Git Repository** and select `rudr-automates/Horizon-Prototype`.
   Grant the Vercel GitHub App access to that repository if prompted.
3. On the configuration screen confirm, for the `main` branch:
   - Framework Preset: **Next.js** (auto-detected — do not override it)
   - Install Command: `pnpm install` (Vercel detects pnpm from the lockfile)
   - Build Command: `pnpm build`
   - Output Directory: leave as the Next.js default
   - Root Directory: repository root
4. Expand **Environment Variables** and add every name from §3, for the
   **Production** environment. Do not paste secrets into this document, a
   commit, or a chat message.
5. **Deploy**. Vercel will produce a URL of the form
   `https://<project>.vercel.app`.
6. Add the resulting domain to the Supabase project's allowed redirect URLs if
   and when Supabase Auth is introduced. Not required today.

Environment variables are read at runtime, so changing one requires a
**redeploy** to take effect.

## 5. The spend guard will block a naive deploy

`HORIZON_DAILY_TOKEN_BUDGET = 0` is a real hard stop: the pipeline makes **no**
provider call at all and every turn returns `TEMPORARY_UNAVAILABLE` with reason
`BUDGET_EXHAUSTED`. This is deliberate — it fails closed rather than promising a
spend cap it does not enforce.

**The target database must have `0003_atomic_budget.sql` applied first.** The
budget is now enforced by reserving capacity atomically in Postgres before each
call, so with a database configured and 0003 missing, every turn fails closed with
`BUDGET_EXHAUSTED` and the health endpoint reports `durableLedger: "unreadable"`.
That is the guard working, not a deployment bug. The project this revision was
developed against has it applied and verified; a **fresh** project starts without
it, so apply all three migrations there before expecting a turn to be admitted.

With 0003 applied, the daily ceiling is shared by every instance rather than
per process, because admission takes an advisory lock keyed on the UTC day. Two
concurrent requests cannot both be admitted against the same remaining budget.

To allow inference, set a positive value, for example `HORIZON_DAILY_TOKEN_BUDGET=200000`.

Confirm the guard's state from the public health endpoint rather than guessing.
`spendGuard` reports whether the **next provider call would be admitted**, so it
is `"blocked"` until all three of a positive budget, a readable durable ledger and
migration 0003's reservation objects are in place. On the development project all
three now hold, so it reads `"permitted"`:

```bash
curl -s https://<project>.vercel.app/api/v1/health | node -e \
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.runtime.spendGuard, '| ledger:', j.checks.database.durableLedger, '| schema:', j.checks.database.schemaObjects)})"
# observed on the development project: permitted | ledger: usable     | schema: verified
# before 0003 is applied:            blocked   | ledger: unreadable | schema: unknown
```

Do **not** treat `permitted` as proof the provider works. It says the spend guard
would allow a call; the provider's own free-tier quota is a separate refusal that
this field does not model, and `pnpm smoke` is what establishes that a call
actually succeeds.

## 6. Verification after deploy — run all of it

Open the URL in a clean browser session and then:

| Check | Expected |
|---|---|
| Home page | Loads; **Lesson recording (real captions)** is the selected lesson and "Transcribed and indexed from its own captions" is visible |
| Lesson video | The player renders and its clock advances while playing and follows a seek. On a host the source line names the original YouTube embed, because the recording was not uploaded — that is the expected state, not a defect |
| Position provenance | The panel reads `Source: the player's own playback clock.` once the player has started. If a host's browser refuses the embed, it must instead read `Source: set by hand, because no player has reported a clock in this session` — never a number presented as playback |
| Evidence scope moves with the clock | `pnpm canary:lesson --base https://<project>.vercel.app --positions 300,1200,3000` exits 0: 4 / 19 / 49 eligible blocks, each matching the harness's own oracle |
| The late fact is unreachable early | In the same run, the 20:00 turn about the `75%` threshold is a refusal whose response body contains neither `compliance score` nor `75%`, while the 50:00 turn is answered and cites `Transcript 44:52–45:53` |
| An uncovered question refuses | The Kubernetes/gRPC question returns `INSUFFICIENT_EVIDENCE` with 0 claims |
| `GET /api/v1/health` | HTTP 200; each check reflects reality and nothing is inferred from an env var being set |
| Health must not overclaim | `runtimeAi.reachable` is `null` unless a live smoke test was actually recorded |
| Database is genuinely usable | `checks.database.querySucceeded: true` (an authenticated read, not a reachability ping), `schemaObjects: "verified"`, `durableLedger: "usable"`, `ok: true` |
| The guard agrees with the answer path | `runtime.spendGuard` is `"permitted"`, and a real question is not refused for a budget reason |
| Persisted data and retrieval | `pnpm verify:data-path --base https://<project>.vercel.app` exits 0 with 0 failed and the non-disclosure checks passing |
| Concurrency is really enforced | `pnpm verify:budget` prints `RESULT: PASS` and `CLEANUP: complete` against the deployed project's database |
| Timestamp controls | Moving the slider or a preset changes the eligible-block count |
| Early canary (00:00, 06:00) | Refuses. The constant `0.37` must not appear anywhere in the page or the response |
| Late canary (12:00) | A supported answer **only** if the model is configured, in budget, and the eligible set actually contains the fact |
| Citation panel | Opens and shows the source text with a timestamp/page/slide that matches the block |
| Secret exposure | View source and DevTools: no key, no service-role token, no stack trace |
| Failure modes | With credentials removed, the app refuses; it never fabricates an answer |

Run the recorded canary against the deployed host so the evidence is
reproducible rather than described:

```bash
pnpm canary --base https://<project>.vercel.app --label prod          # the fixture corpus
pnpm canary:lesson --base https://<project>.vercel.app --label prod  # the recording's transcript
```

`pnpm canary:lesson` needs the database credentials, because it reads the stored
transcript to build its own oracle. It spends: one embedding request and two
generation calls per turn. `--max-turns 2` halves that if the day's budget is
already partly used.

## 7. Things that are still missing after a successful deploy

- **Migrations are not applied by this procedure.** `0001_init.sql`,
  `0002_search_functions.sql` **and `0003_atomic_budget.sql`** must be applied
  separately through the Supabase SQL Editor (`docs/apply-migration.md`). A
  **fresh** project has none of them: until `0001`/`0002` are applied the app runs
  in fixture mode and says so in `/api/v1/health` (`evidenceSource: "fixture"`),
  and until `0003` is, the answer path refuses every turn. Pointing the deployment
  at the existing project avoids all of this — it has all three.
- **The sample lesson is still synthetic, and it ships alongside the real one.**
  Both courses are listed; the interface makes the recording the default and
  labels the sample as synthetic everywhere it appears. A deployment that wants
  only the recording should delete the sample course deliberately, not by
  accident.
- **A fresh project needs the transcript ingested.** The recording's evidence is
  not in a migration: point a brand-new Supabase project at this app and the
  video course will be absent until `pnpm ingest:lesson` is run against it with
  the same caption file. That costs 3 embedding requests and no model tokens, and
the page states the absence plainly instead of failing obscurely.
- **The lesson recording is not uploaded, so a host has no byte-range endpoint to
  serve.** `GET /api/v1/lesson/video` answers `404` there and the player falls
  back to the original YouTube embed; both paths were verified on the local
  production build (EVALUATION.md P8-3). Nobody should "fix" the 404 by making the
  file part of the build: it is 235.0 MiB and a third-party download, which is why
  `.gitignore` excludes it. Serving it from object storage instead of the embed
  would be a deliberate change, and would need the redistribution question
  answered first.
- **No approximate vector index**, no auth, no rate limiting beyond the spend
  guard and request-size validation.
- **Embedding COST is unmeasured.** The durable cap bounds how many embedding
  requests are made, not what they cost. `estimated_cost_usd` is still NULL.

## 8. Release gate — do not call this a working AI product until all four hold

1. Atomic budget admission is implemented **and verified against the real
   database**: `pnpm verify:budget` → `RESULT: PASS`, 4 grants of 12 concurrent
   reservations, cap bound at 3, cleanup complete. **HOLDS (2026-10-15).**
2. `/api/v1/health` reports actual database connectivity truthfully
   (`querySucceeded`, `schemaObjects: "verified"`, `durableLedger: "usable"`).
   **HOLDS (2026-10-15)** — all three observed on the live endpoint.
3. A **real generation call succeeds** (`pnpm smoke` exit 0). **HOLDS
   (2026-10-15)** — on Groq / `openai/gpt-oss-20b`: one embedding request (768
   dims, finite) and one generation request that parsed a structured claim, with
   `charged 396` equal to `prompt 315 + completion 81`. The earlier Google
   free-tier exhaustion was an account quota, not an application limit.
4. The timestamp-aware canary demonstrates non-disclosure before the unlock time
   **and** a properly supported, cited answer once eligible evidence is available.
   **HOLDS (2026-10-15)** — 18 passed, 0 failed, 9 not run (the citation oracles,
   which need fixture text); 0.37 absent from every response before 578 s and
   present afterwards, with all 3 citations verified against `public.blocks`.

Two commands support gates 1 and 2, and neither makes a provider call, so neither
can spend quota:

```bash
pnpm verify:data-path --base https://<project>.vercel.app   # read-only: real rows, zero writes
pnpm verify:budget                                          # needs 0003; writes probe rows, deletes them in a finally block
```

`verify:budget` is not read-only: admission is a write, so there is no read-only
way to test it. Every row it creates is tagged `provider = 'concurrency-probe'`
and deleted before it exits, and it reports the day's total and probe-row count
before and after, so a failed cleanup is loud rather than silent. Run it against a
project whose spend you can account for.

All four gates hold on the local production build as of 2026-10-15. See
[EVALUATION.md](EVALUATION.md) Part 07 for the run and its artifacts, including the
two checks that remain outside the harness's reach.

That is not a hosting claim: **no public URL exists**, and nothing above was
verified on a deployed origin. One thing must be repeated in the host before a
deploy can behave as the local run does — `HORIZON_DAILY_TOKEN_BUDGET` and
`HORIZON_MAX_EMBEDDING_CALLS` resolve to `0`, which is the guard's "permit
nothing" state, unless they are set. Both **are** set in the local `.env.local` as
of 2026-10-16 (verified: `spendGuard: "permitted"` and an empty
`configurationProblems` from `/api/v1/health`), which corrects the observation in
EVALUATION.md Part 07 — but a host has its own environment, so set both to
positive values there too (§3) and confirm `spendGuard` reads `"permitted"`
afterwards rather than assuming.

## 9. If access cannot be connected

The blocking action is a human one: someone with Vercel account access must
authorise the GitHub repository connection in the Vercel dashboard (§4) and add
the environment variables (§3). Until that happens, report **no public URL
exists**. Do not present a local `next start` as a deployment — it is not
reachable by a judge.
