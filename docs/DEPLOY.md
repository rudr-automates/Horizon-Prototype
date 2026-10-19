# Deploying Horizon

**Status: DEPLOYED on 2026-10-18 — <https://horizon-prototype.vercel.app>.**

**Current acceptance checkpoint (2026-10-19):** the alias serves Ready
production commit `591552a` from `main`. PR #7 contains Auth-protected learner
routes and account persistence changes, but remains draft and is not deployed.
Its email-confirmation, remote-restore and two-account isolation journeys are
release gates. Do not promote this branch until those are verified.

Deployed from this repository's `main` with the Vercel CLI, on the project
`irrelevant3/horizon-prototype` (project id `prj_hVJ27iem3nuYUuKUc5BWgnjAqt7z`).
Deployment protection was switched **off** for the project, because with it on every
path answered Vercel's SSO page to an anonymous visitor and no judge could open the
site.

What was verified on that origin, with the values observed:

**Route change on 2026-10-18:** `/` is now the welcome page and the learning studio
is at **`/learn`**. The figure below was taken while `/` still served the studio; the
current state of both routes was verified after the redesign in
[EVALUATION.md](EVALUATION.md) **Part 12 (§ P12-6)**, which records the deployed
responses, health values, scope counts and the ten measured screenshots. §6 below
lists both routes as separate checks.

**Last deployed:** 2026-10-18, `main` at `96759b7` — `/` 200 (35.6 KB), `/learn` 200,
`/api/v1/health` `ok` with `evidenceSource: "supabase"` and the ledger still at
15,052 tokens (no provider call was made by this revision).

| Check | Observed on https://horizon-prototype.vercel.app |
|---|---|
| Home page (then the studio; now `/learn`) | `200`, 20,259 bytes, `text/html` |
| `GET /api/v1/health` | `ok: true`, `spendGuard: "permitted"`, `querySucceeded: true`, `schemaObjects: "verified"`, `durableLedger: "usable"`, `configurationProblems: []` |
| Evidence store | `evidenceSource: "supabase"` — the recording's transcript and its two compiled documents |
| Scope moves with position | `10` at 00:03, `20` at 10:00, `66` at 50:00 |
| Player | an `iframe` on `youtube.com/embed/ZaPbP9DwBOE` with `origin=https://horizon-prototype.vercel.app`; no `<video>` element; the page states it plays from the original source |
| `GET /api/v1/lesson/video` | `404` — expected, the 235 MiB file is not uploaded |
| Console | 8 warnings, all `Unrecognized feature: 'web-share'` from the embed; no application error |

NOT verified there: a answered question (the day's token ceiling was spent before a
turn could run), and the citation panel opened on a PDF citation. Those are recorded
as **not run** in EVALUATION.md P10-6 and P10-8, and are the first two things to redo
on a fresh UTC day.

The host needs no extra data step: the recording's 56 transcript blocks and both
compiled documents live in the Supabase project this deployment points at. What the
host does NOT have is the 235 MiB recording, so it plays the original YouTube embed.

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

## 4a. What was actually run (CLI, no Git integration)

```bash
npm install -g vercel@64.5.0
vercel login                     # device flow: approve the printed URL in a browser
vercel link --yes --project horizon-prototype
# every name from §3, pushed over stdin so no value is printed or committed:
node .logs/push-env.mjs          # local script, gitignored; sets 13 production variables
vercel project protection disable horizon-prototype --sso
vercel deploy --prod --yes       # builds on Vercel, aliases horizon-prototype.vercel.app
```

Notes on that run, because each one changed the outcome:

- **No token was used.** The device login was approved in a browser by the account
  owner, and no credential was pasted into a command, a file or a chat message.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` was rejected on the first attempt with "This value
  looks sensitive"; Vercel requires `--type config` for it explicitly. The value is a
  publishable key, not a secret, and the flag is what records that.
- `.vercelignore` excludes `*.mp4`, `.freebuff/`, `.logs/`, `.vercel/` and
  `docs/evidence/`, so the 235 MiB recording cannot enter a deployment artifact even
  if someone runs `vercel deploy` from this checkout.
- `vercel link` appends a short-lived `VERCEL_OIDC_TOKEN` to `.env.local`, which is
  gitignored; it is not needed by the app.
- No Git integration was connected, so a push does **not** deploy. Run the last
  command again to publish a new build.

## 4b. Vercel through the GitHub repository (alternative)

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
   for the Supabase Auth confirmation callback. PR #7 adds cookie-backed Auth;
   confirm the production redirect allowlist before promoting it.

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

Confirm the guard's state from the operator diagnostics endpoint rather than
guessing. `spendGuard` reports whether the **next provider call would be
admitted**, so it is `"blocked"` until all three of a positive budget, a readable
durable ledger and migration 0003's reservation objects are in place. On the
development project all three now hold, so it reads `"permitted"`:

```bash
curl -s -H "Authorization: Bearer $HORIZON_DIAGNOSTICS_TOKEN" \
  https://<project>.vercel.app/api/v1/health/diagnostics | node -e \
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.runtime.spendGuard, '| ledger:', j.checks.database.durableLedger, '| schema:', j.checks.database.schemaObjects)})"
# The public /api/v1/health no longer publishes these figures, by design.
# Without the token, that route answers 404.
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
| Home (`/`) | Loads without any model call: the hero, the continue card built from this browser's own stored progress, and the catalogue rows the evidence store returned, with a synthetic course labelled as synthetic |
| Studio (`/learn`) | Loads; the lesson recording is the selected lesson and "Captions indexed" is visible; `?lesson=sample` opens the labelled synthetic corpus, `?section=materials` opens the library, and `?start=<seconds>` resumes on the player's first clock report and then clears itself from the address |
| Lesson video | The player renders and its clock advances while playing and follows a seek. On a host the source line names the original YouTube embed, because the recording was not uploaded — that is the expected state, not a defect |
| Position provenance | The panel reads `Source: the player's own playback clock.` once the player has started. If a host's browser refuses the embed, it must instead read `Source: set by hand, because no player has reported a clock in this session` — never a number presented as playback |
| Evidence scope moves with the clock | `pnpm canary:lesson --base https://<project>.vercel.app --positions 300,1200,3000` exits 0, each count matching the harness's own oracle. Observed on the deployed origin once documents existed: **10 / 20 / 66** — the 10 course-wide reference blocks are present at every position, and the rest unlock with the recording. (Before the documents were ingested the same origin read 4 / 19 / 49.) |
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
- **PDF and PPTX evidence is in the database, but the two documents that carry it were
  compiled from the recording's own captions, not supplied by the instructor.** They
  say so on their face and in their resource titles. A fresh project needs
  `pnpm build:materials` then `pnpm ingest:resource` for each file; a scanned PDF has
  no text layer and is refused rather than indexed.
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
- **No approximate vector index.** Cookie-backed Auth and owner-scoped learner
  tables are in PR #7 and not yet deployed at this checkpoint. Request admission,
  size limits and the spend guard are implemented on the current production line.
- **Embedding COST is unmeasured.** The durable cap bounds how many embedding
  requests are made, not what they cost. `estimated_cost_usd` is still NULL.

## 8. Release gate — do not call this a working AI product until all four hold

0. **A public origin serves the app to an anonymous visitor.** **HOLDS
   (2026-10-18)** — <https://horizon-prototype.vercel.app>, deployment protection off,
   home `200`, health `ok: true`, and the YouTube embed present on the page. This is
   weaker than the four gates below it: it proves the host runs the app and can read
   the database, not that a question was answered there.

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

Gates 1–4 above are checks of the local production build. The deployed origin was
verified separately and more narrowly on 2026-10-18 (home, health, courses, scope,
player, console); a question answered **on the host** is still not among the evidence,
because the day's token ceiling was spent before that turn could run.

One thing must be repeated in any host before a deploy can behave as the local run
does — `HORIZON_DAILY_TOKEN_BUDGET` and `HORIZON_MAX_EMBEDDING_CALLS` resolve to `0`,
which is the guard's "permit nothing" state, unless they are set. Both are set on the
project this document describes (verified: `spendGuard: "permitted"`, empty
`configurationProblems`, and 15,052 of 20,000 tokens used with 10 of 10 embedding
requests on 2026-10-18), but a different host has its own environment, so set both
there too (§3) and confirm `spendGuard` reads `"permitted"` afterwards.

## 9. Access, and what a redeploy needs

The account used is the one that owns `irrelevant3/horizon-prototype`; the device
login is the only human step in publishing. A later build needs nothing from that
person beyond a valid CLI session:

```bash
vercel deploy --prod --yes    # after lint, typecheck, test and build pass locally
```

Do not present a local `next start` as a deployment — it is not reachable by a judge —
and do not describe the aliased URL as verified for behaviour that was not exercised on
it. The rows that are still **not run** on the deployed origin are listed at the top of
this document.

---

## 10. Gate 1 rollout — request admission, minimal health, turn sequencing

This revision changes what happens **before** a question reaches the pipeline. It
adds one migration and two environment settings. Nothing about retrieval,
prompts, models or the recorded corpus changed.

### 10.1 What must be applied, and in what order

1. **Apply `0004_request_rate_limit.sql`** through the SQL Editor. Procedure and
   verification queries: [apply-migration.md](apply-migration.md#applying-0004-required-before-the-rate-limited-build-is-promoted).
   It is additive: one table, one function, no alteration of existing objects.
   The SQL has been exercised on a disposable Postgres 16 with
   `pnpm verify:rate-limit-sql` (Docker required, no credentials, no Supabase
   contact): clean apply and re-apply, the limit binding at exactly the configured
   count, twelve concurrent sessions admitting exactly four with a stored count of
   four, `anon` refused at both the table and the function, and a rollback that
   leaves the app failing closed. That is evidence about the SQL; the migration
   still has **not** been run on the shared project, which is a separate approval.
2. **Set `HORIZON_RATE_LIMIT_SALT`** to a long random string (Vercel → Settings →
   Environment Variables, production and preview). If it is empty the key is
   derived from the service-role key, which works but ties bucket rotation to a
   credential rotation.
3. **Set `HORIZON_DIAGNOSTICS_TOKEN`** to a different long random string. This is
   what re-enables the detailed health report for an operator; without it the
   diagnostics route answers 404. It is never sent to a browser.
4. Redeploy preview, then production. **Order matters:** a deployment of this
   code against a project without `0004` refuses every question with
   `503 RATE_LIMIT_UNAVAILABLE` before parsing or any provider call, and health
   reports `status: degraded` with `checks.admission.reachable: false` rather than
   "Operational".
5. **Schedule the retention command** (recommended, not automatic):
   `pnpm prune:rate-limits --apply` daily or weekly from a host that has
   `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Run it once by hand
   first and confirm the dry run reports a cutoff about three days back and does
   not report active rows as eligible. There is no scheduler in this repository;
   until one is observed, retention is a manual operation.

### 10.2 What to verify on the preview, then on production

| Check | Expected |
|---|---|
| `GET /api/v1/health` | 200, `cache-control: no-store`, and **no** `spentTokensToday`, `textModel`, `configurationProblems`, `durableLedger` or `schemaObjects` anywhere in the body |
| `GET /api/v1/health` before 0004 | `status: "degraded"`, `checks.admission.reachable: false`, detail says questions are refused; **not** "Operational" |
| `GET /api/v1/health` after 0004 | `checks.admission.reachable: true` and the overall `status` becomes `ok` — if it does not, the limiter probe is failing and no question will be answered |
| `GET /api/v1/health/diagnostics` without a token | 404 (not 401 — the route is not advertised) |
| `GET /api/v1/health/diagnostics` with the token | 200, full report, `cache-control: no-store`; `spendGuard` matches the deployment's real state |
| `POST /questions` with a body over 16 KiB | 413 `FILE_TOO_LARGE`, `cache-control: no-store`, no provider activity |
| `POST /questions` with a body of 1–2 MB sent chunked (no `content-length`) | 413; the stream is cut, not buffered |
| `POST /questions` normally | Answered as before; the response carries `cache-control: no-store` |
| Burst of 9 questions from one address within 10 minutes | The 9th is `429 RATE_LIMITED` with a `retry-after` header; other addresses are unaffected |
| Status surface (`/learn?section=status`) | Shows only the public facts (overall status, authenticated database read, evidence source, credential present, admission ready/unavailable). **No** spend figure, budget, model id, schema count or configuration name in the HTML or the RSC payload |
| Status surface source | `view-source:` contains no `spentTokensToday`, `textModel`, `schemaObjects`, `configurationProblems` or `HORIZON_` setting name |

### 10.3 Rollback

- **Code:** redeploy the previous commit. The rate-limit table may stay; it is
  inert to older code.
- **Database:** `drop function if exists public.horizon_admit_request(text, integer, integer, timestamptz); drop table if exists public.request_rate_limits;`
  Dropping them makes the limiter fail closed (503), never open, and health will
  report `checks.admission.reachable: false`.
- **Retention:** rollback also stops any pruning job you created. The rows that
  remain are closed-window counters only; they are never read by the application
  again and can be dropped with the table.
- **Health:** removing `HORIZON_DIAGNOSTICS_TOKEN` returns the diagnostics route
  to 404. The public payload is unaffected.

### 10.4 Known limits of this revision

- **Retention is manual.** `request_rate_limits` is pruned only by
  `pnpm prune:rate-limits --apply`; there is no cron in this repository and the
  table does not prune itself. Until a scheduler is observed running it, treat the
  table as growing by one row per client per window and plan a weekly run. The
  command is dry-run by default and can never select an active window.
- **The limiter's SQL is verified on a disposable Postgres, not on this project.**
  `pnpm verify:rate-limit-sql` proves the migration and its concurrency behaviour,
  but it does not prove Supabase-specific role configuration.
- **The Status surface still has no authentication.** It now renders only the
  public health projection, so there is nothing private on it to protect; the
  detailed operator report is behind a bearer token. Per-user surfaces remain a
  later gate.
