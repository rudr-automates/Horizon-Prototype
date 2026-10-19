# Horizon

A timestamp-aware, evidence-grounded learning assistant. A learner pauses a
recorded lesson, asks a question, and receives an answer supported only by
content that is **permitted at their current position** — with citations — or an
honest refusal.

> **Release status (2026-10-19):** Horizon's learning-assistant release is live at
> <https://horizon-prototype.vercel.app>. PR #7 contains the current learner
> account and protected-Studio candidate on
> `codex/production-acceptance-fixes-2026-10-19` (`a66085d`). Its Vercel preview
> is Ready; the production alias still serves `main` at `591552a` while final
> release checks and PR review are completed.
>
> **There is a public URL: <https://horizon-prototype.vercel.app>.** The home
> Production's landing page, health endpoint, course list and scope endpoint were
> checked on that origin on 2026-10-18: HTTP 200, an authenticated database read,
> and the scope count moving 10 → 20 → 66 as the playhead advances. The recording
> itself is not uploaded there, so the player is the original YouTube embed —
> verified present on the deployed page with the right video id. See
> [docs/DEPLOY.md](docs/DEPLOY.md) and the dated evidence in
> [docs/EVALUATION.md](docs/EVALUATION.md).
>
> **The evidence is the recording's own.** YouTube's automatic English captions
> were ingested verbatim into **56 timestamped blocks** in a course of their own,
> alongside **two documents compiled from those same captions**: a 3-page study
> guide approved as course-wide reference (10 blocks, eligible at every playhead)
> and a 9-slide deck whose blocks unlock where the recording covers them. Answers
> are cited from those blocks, and every screen says the transcript is machine
> transcription.
>
> **Questions are answered only from what the learner has watched.** The eligible
> set is computed from the player's own clock: 10 reference blocks at 00:00, 20 at
> 10:00, 66 at 50:00. A fact stated 44:52 into the lesson is absent from the
> eligible set, from the retrieval payload and from the response body before that
> point, and answered from a cited block after it.
>
> **The interface is a learning studio, not one long page.** Five surfaces —
> Learn, Materials, Notes, Progress and System status — share one position and one
> evidence store. The transcript pane reads only captions the lesson has reached,
> the library states each source's policy before you open it, and the operator
> diagnostics that used to sit under the question box have their own view. The
> audit that drove this, what was kept, and what was deliberately not built are in
> [docs/UI-AUDIT.md](docs/UI-AUDIT.md).
>
> **The root route is a welcome page, and the studio lives at `/learn`.** Home
> states the promise, offers the lesson *this browser* has progress in (read from
> `localStorage`, with the reached position and the watched time shown as the two
> different figures they are), lists the courses the evidence store actually
> returned, and explains the four-step learning loop. It makes no model call. A
> lesson link carries `?start=` only when a real position exists, and the studio
> applies it once the player reports a clock — never from the link alone.
>
> **One identity, "Midnight Aurora".** A dark reading surface: glass for the
> navigation rail, the top bars and the hero panel, and opaque surfaces for
> everything read for minutes (transcript, citations, answers, resource text,
> forms). Every text/background pair has a measured contrast ratio recorded beside
> its token in [`src/app/globals.css`](src/app/globals.css), so the palette can be
> checked against a number rather than an impression. One theme ships, and
> `color-scheme: dark` is stated so the browser never re-maps the palette it was
> not asked to.
>
> The candidate implements cookie-backed sign-up/sign-in, protected learner routes,
> an account dashboard and owner-scoped synchronization. The required Supabase
> learner schema is applied. Real email confirmation, signed-in restoration and
> two-account isolation remain unverified, so those end-to-end behaviors are not
> presented as tested. “Summarize so far” and “Explain simply” use the standard
> evidence-gated answer path; their coverage is bounded by the retrieved evidence.

---

## Capabilities and recorded evidence

Implementation and test notes below include dated production observations from
earlier revisions. For the current candidate and live release status, see
[docs/EVALUATION.md](docs/EVALUATION.md) Part 21; historical checks are not
claims that each behavior was re-run on this candidate.

| Capability | Status |
|---|---|
| Next.js app builds and runs | ✅ verified (`pnpm build`) |
| `GET /api/v1/health` with honest config/connectivity reporting | ✅ verified live |
| Learner UI: sample timeline, playhead, ask, citations, refusal states | ✅ verified live |
| Canonical eligibility predicate, TS + SQL twin | ✅ unit tested |
| Both retrieval branches filtered before ranking | ✅ unit tested (fixture + fake SQL gateway) |
| Rank fusion (RRF) with deterministic ordering | ✅ unit tested |
| Claims-only generator, Tier-1 deterministic checks, Tier-2 verifier | ✅ unit tested |
| Google Gen AI adapter (`gemini-3.6-flash`, `gemini-embedding-001`) | ✅ implemented, unit tested against the real SDK's own types; **embeddings still run on it, live** |
| Groq adapter (`openai/gpt-oss-20b`, OpenAI-compatible Chat Completions) | ✅ **live-verified on 2026-10-15** — one smoke request and three canary turns succeeded through this adapter. Endpoint, bearer auth, strict JSON Schema, usage mapping, 429 guidance and every failure path are also unit tested (38 cases, all mocked) |
| Home entry point (`/`) | ✅ verified rendered at 1440, 1024, 768, 390 and 360 px — the hero, a continue card built from this browser's real progress (`in progress`, `watched 00:00`, `reached 25:00`), the two real catalogue rows with the synthetic sample labelled, and no horizontal overflow at any of the five widths |
| Learning studio (`/learn`): app shell, lesson stage, scope strip, assistant | ✅ verified rendered at 1440, 1024, 768, 390 and 360 px with the real player, a live seek and a live scope update (37 blocks at 25:00); `?lesson=`, `?section=` and `?start=` deep links verified in the browser, including a resume that seeked the real element to 1500 s and then removed the consumed `start` parameter |
| Transcript pane (`GET /courses/:id/transcript`) | ✅ verified live — 24 timestamped passages at 25:00, ordinary text search, gaps stated rather than filled, seeking follows the player, and the endpoint returns only eligible captions |
| Course materials library and document viewer (`/resources`, `/resources/:id`) | ✅ verified live — 3 sources with policy and counts, a 3-page PDF with page chips and text zoom, and a slide deck whose only 3 permitted blocks at 25:00 are the ones the deck has reached |
| Notes, bookmarks and watched progress | ✅ verified live in a browser — one-click bookmark at 25:00, a note, both surviving a reload from `localStorage`; a 25-second playback recorded 25 s watched while a seek only moved the resume point. Local-only, and labelled as such |
| System status view | ✅ verified live — same health payload as before, now separated from the learning surface |
| Lesson video playback | ✅ **verified live** — the 235.0 MiB recording (56:39, 1920x1080 h264) streams from the local copy with byte-range support (`206` and a correct `Content-Range`, `416` past the end, `404` where no local copy exists), and the panel's clock is the element's own (`31:17 / 56:39` at a 1875 s seek). **Play this passage** seeks to its citation (2692.8 s → 2689.8 s) and then plays (advancing 3.00 s in 3 s). With the file absent the panel switches to the original YouTube embed and reads that player's own clock through the official IFrame Player API |
| Video-grounded Q&A from the recording | ✅ **live-verified** — the recording's own automatic English captions (1505 lines, 0.1 s–3386.5 s of the recording's 3399.3 s, so 99.6% coverage) are parsed into **56 timestamped blocks** in a course of their own and are cited. A fact stated only late in the lesson (`compliance score` … `below 75%`, unlocking at 44:52) is absent from the eligible set and from the entire response body at 05:00 and at 20:00 — including when the learner asks about it directly — and is answered from a verbatim-cited block at 50:00. It is **machine transcription**, and every screen that shows it says so |
| The transcript ingest itself (`pnpm ingest:lesson`) | ✅ **executed live** — captions parsed and segmented (56 blocks, mean 60.5 s), embedded in 3 batched requests against a cap of 10, every row 768-dimensional, every row `TIMELINE_BOUND/AUTO_APPROVED/INDEXED`, and **0 rows** carry synthetic-fixture text. OCR and PDF/slide parsing remain ❌ deferred |
| Playback clock → evidence scope | ✅ **verified live** — the position a question is asked at is the player's own clock (`Source: the player's own playback clock.`), and the eligible count moves with it: 0 blocks at 00:03, 9 at 10:00, 19 at 20:00, 49 at 50:00, each matching an independently written oracle. With no player clock the control falls back to a manual position that is labelled as manual |
| Supabase migrations | ✅ **0001–0005 applied and verified** — core schema/search, durable budget, request admission and owner-scoped learner tables; migration 0005 was re-read after approval on 2026-10-19. See `docs/EVALUATION.md` for evidence and remaining Auth test limits. |
| Database-backed retrieval | ✅ **verified live** — with the corpus seeded, the store's `listCourses`, `getCourse`, `listEligible`, `searchFullText`, `searchVector` and `hasMatchingIneligible` all ran against Supabase, and `GET /api/v1/courses` + `/scope` serve those rows over HTTP |
| Live embeddings (`gemini-embedding-001`, 768d) | ✅ **real calls made** on the current revision — `pnpm smoke`, plus one batched call that embedded all 18 demo documents for the seed |
| Live inference (`openai/gpt-oss-20b` on Groq) | ✅ **live-verified** — `pnpm smoke` parsed a structured claim, charged 396 tokens against reported 315 + 81. Generation moved off `gemini-3.6-flash`, whose free-tier daily quota was exhausted with a ~15 h retry delay |
| Temporal eligibility end-to-end with a live model | ✅ **18 passed, 0 failed, 9 not run** on the live path — the withheld constant `0.37` appears in no response before its 578 s unlock and does appear after it, with cited answers at 06:00 and 12:00. The 9 not-run checks need fixture text; 3 of 3 citations were verified against `public.blocks` instead |
| Cumulative daily token accounting | ✅ enforced at admission, per call, including billable **reasoning** tokens; the persisted charge is the same figure the cap was checked against |
| Atomic budget admission across requests AND instances | ✅ **verified live against the real database** — `pnpm verify:budget` fired 12 simultaneous reservations at `horizon_admit_generation_tokens` with a budget that only 4 could fit and got exactly **4 grants**, then 12 simultaneous embedding admissions bound at exactly the remaining allowance (3, on a day that had already used 1 of the 10), and cleanup left 0 probe rows with the day's total back where it started. Both expectations are derived from the day's measured state, so the command also passes on a system that has been used |
| A refused call releases its hold; a timeout keeps it | ✅ unit tested — a 429 is the provider refusing before processing, so it charges nothing, while an unanswered call keeps its reservation rather than erasing spend |
| `GET /api/v1/health` separates authentication from reachability | ✅ **verified live** — `querySucceeded: true` is a real authenticated read, and it has been observed both ways: `ok: false` with `durableLedger: "unreadable"` before `0003` was applied, and `ok: true` with `schemaObjects: "verified"` / `durableLedger: "usable"` after. A database is never called healthy merely because a request answered |
| Durable usage ledger (`public.usage_ledger`) | ✅ **verified live** — `spentToday()` reads the table and `record()` writes to it; a labelled probe row was inserted, read back and deleted, leaving the table empty again. Reasoning tokens have their own column from `0003` |
| SDK automatic retries | ✅ disabled (`attempts: 1`); they default to 5 |
| Embedding-request cap | ✅ enforced durably against the day's rows, and reported from the same store it is counted in — `runtime.embeddingRequestsToday`, with `null` meaning the count could not be read, never 0 |
| Spend guard (`HORIZON_DAILY_TOKEN_BUDGET`) enforced before any provider call | ✅ unit tested |
| Seed/ingestion path for the demo corpus (`pnpm seed:demo`) | ✅ **executed live** — 1 course / 6 resources / 18 blocks upserted on primary key, using 1 embedding request against a cap of 10 |
| End-to-end canary harness (`pnpm canary`) | ✅ ran live; recorded in [docs/evidence](docs/evidence) |
| Lesson canary with a database-derived oracle (`pnpm canary:lesson`) | ✅ **ran live: 31 passed, 0 failed, 1 not run**, then 8 passed / 0 failed / 0 not run for the early turn it exposed. It reads the stored transcript and builds its own expected-eligible set, so citation ids, quotations and clocks are checked against the real evidence rather than a fixture |
| `runtime.providerCallEvidence` on `/api/v1/health` | ✅ **verified live** — replaces a line that read "not verified (a smoke test is required)" forever with what the ledger can prove: the newest settled, reported provider call, its time, and whether it is inside the current UTC day (`observed` at 2026-10-16T19:06:58Z, groq / `openai/gpt-oss-20b`). Modes `none_recorded`, `not_durable` and `unreadable` are kept distinct, and nothing is inferred from configuration |
| Turn persistence to a real database | ✅ **verified live** — three canary turns were written to `public.turns` (`persistence: {"persisted":true,"mode":"supabase"}`) at boundaries 0 / 360 / 720 s, with the same answer states the responses reported. The unconfigured path still reports `persisted: false` honestly |
| Public deployment | ✅ **live at <https://horizon-prototype.vercel.app>** — Vercel build from this repository with production env vars, deployment protection disabled so a judge can open it, and the origin verified on 2026-10-18: home 200, health `ok: true`, `evidenceSource: "supabase"`, scope 10/20/66, YouTube embed present. The 235 MiB recording is not uploaded, so `GET /api/v1/lesson/video` answers `404` there by design |
| PDF and PPTX ingestion (`pnpm ingest:resource`) | ✅ **executed live** — a 3-page study guide and a 9-slide deck, both compiled from the recording's captions, parsed with page/slide provenance, embedded in 1 request each at 768 dimensions, and read back from the database. Scanned pages are reported as visual-only and are NOT counted as extracted |
| Course-wide review lint | ✅ **executed live** — the ingest refuses to approve a document course-wide if it contains a registered late-only fact or aligns to the last fifth of the recording, and requires an explicit `--acknowledge` to override. The approved study guide carries none of the late facts, and the canary checks that from the rows |
| Alignment review (`pnpm review:alignments`) | ✅ **executed live** — weak or ambiguous alignments are written `PENDING` with no unlock time and are therefore ineligible. Of the deck's 9 blocks, 7 auto-approved, one was approved by hand at its own segment clock (14:18) and one rejected as a provenance slide. No reviewer identity or audit table exists in this schema; a rejection reason is appended to `blocks.alignment_method` |
| Summary and simple explanation | ✅ implemented on the PR #7 candidate — both submit through the normal eligible-evidence retrieval and citation-verification path; coverage is bounded by retrieved evidence, not a full-lesson guarantee |
| Learner authentication | 🟡 email/password sign-up, sign-in, callback and protected learner routes are implemented on the PR #7 candidate; production Auth settings and real confirmation remain unverified |
| Cross-device notes, bookmarks and progress | 🟡 owner-scoped API and browser sync are implemented on the PR #7 candidate; migration 0005 is applied, while real-account restore and two-user isolation remain unverified |
| Learner data ownership and persistent profiles | 🟡 migration 0005 is applied with owner-scoped RLS; account profile and session-bound data APIs are implemented on the PR #7 candidate. Real-account isolation verification remains |

Scope decisions and deferrals are recorded in [docs/DECISIONS.md](docs/DECISIONS.md);
evaluation cases and their actual results are in [docs/EVALUATION.md](docs/EVALUATION.md).
For the selected PS1 goal, see the [criteria matrix](docs/COMPETITION_CRITERIA_MATRIX.md),
[architecture diagram](docs/ARCHITECTURE.md), and [judged-demo runbook](docs/DEMO_RUNBOOK.md).

---

## The learner flow

0. Land on **Home**. It says what the product does, offers the lesson this
   browser actually has progress in, and lists the courses the evidence store
   returned, with the synthetic sample labelled as synthetic. It makes no model
   call, so opening the product costs nothing against the daily budget. Everything
   it links to is a surface that exists; there is no disabled or placeholder
   destination anywhere in the navigation.
1. Watch the lesson recording. It is the real video, its clock is its own, and
   the **evidence is the recording's own transcript** — YouTube's automatic
   English captions, ingested verbatim with the timestamps the source reported.
   The page states where they came from and that they are machine transcription,
   so a mis-heard word in a quotation is visible as the source's, not ours.
   The course also holds **two documents compiled from those captions**: a study
   guide marked *approved reference* (available at every playhead, and labelled as
   such on every citation) and a slide deck whose blocks are time-gated like the
   transcript, each unlocking where the recording covers it.
2. Seek (the slider or a preset seeks the real player). The position shown is the
   player's clock, and the scope chip reports how many transcript blocks are
   eligible *at that position*. A block unlocks when it has been watched to its
   end, so the count starts at 0 and only ever describes material already
   finished.
3. Ask a question. The server embeds it, runs full-text **and** vector retrieval
   — both filtered by the same canonical predicate — fuses the candidates, and
   re-asserts eligibility on the final payload.
4. The generator receives **only** that payload and returns structured claims
   that cite evidence ids. It never decides what is eligible, and it never owns
   the answer state.
5. Tier-1 deterministic checks reject unknown ids and non-verbatim quotes.
   Tier-2 model-assisted verification rejects claims the cited evidence does not
   support. Only surviving claims are rendered, with server-resolved citations.
   Each citation opens its evidence, and **Play this passage** seeks the player to
   that passage and plays it, so the learner can watch the moment a claim came
   from. A browser that refuses to start playback says so under the player rather
   than leaving a still frame under a button that says Play.
6. If nothing survives, or nothing eligible exists, the learner sees a refusal.

Ask `What happens when the compliance score falls below 75%?` at 10:00 and again
at 50:00. At 10:00 nothing in the recording has reached that passage, so the turn
refuses and the response contains neither the question's own subject matter nor
any hint of it; at 50:00 the same question is answered from a cited transcript
block. Switching to **Sample fixture (synthetic)** moves to the labelled synthetic
retry-and-backoff lesson with its own short timeline, so the two can be compared
without ever being confused: the selector, the scope chip and the citation labels
all say which lesson is in play.

---

## API

| Route | Purpose |
|---|---|
| `GET /api/v1/health` | configuration vs connectivity, separately |
| `GET /api/v1/lesson/video` | the local lesson recording, with byte-range support; `404` on a deployment that has no local copy |
| `GET /api/v1/courses` | course list, plus which evidence store is in use |
| `GET /api/v1/courses/:courseId` | one course |
| `GET /api/v1/courses/:courseId/scope?playheadSeconds=` | eligible-block count at a position (never a syllabus oracle) |
| `GET /api/v1/courses/:courseId/transcript?playheadSeconds=` | the captions eligible at that position, for the reading pane |
| `GET /api/v1/courses/:courseId/resources?playheadSeconds=` | sources with policy and permitted counts, never text |
| `GET /api/v1/courses/:courseId/resources/:resourceId?playheadSeconds=` | one source's permitted blocks, for the viewer |
| `POST /api/v1/courses/:courseId/questions` | the full answer path |
| `GET /api/v1/me/learning` | session-bound learner profile, progress, bookmarks and notes |
| `POST /api/v1/me/learning` | validated, owner-scoped learner-data synchronization |

The `/account` dashboard and `/learn` studio require a signed-in session in the
PR #7 release candidate. Sign-up/sign-in are at `/auth/signup` and
`/auth/signin`; see [docs/DEPLOY.md](docs/DEPLOY.md) for the current production
and candidate deployment state.

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
| `pnpm ingest:lesson` | Fetch-parse-and-ingest the recording's captions: 56 timestamped blocks in a course of their own. `--dry-run` parses and reports without writing and without any embedding request; `--captions <path>` points at another json3 file |
| `pnpm build:materials` | Compile a study-guide PDF and a slide deck from the STORED transcript into `.freebuff/materials/` (gitignored). No model call, no invented text; both documents state their provenance on their face |
| `pnpm ingest:resource --file <path> --mode reference\|aligned` | Parse, chunk, embed and write a PDF or PPTX as a course resource. `reference` is `COURSE_WIDE` and human-approved, and is refused if the lint objects unless `--acknowledge "reason"` is given; `aligned` is `TIMELINE_BOUND`, auto-approved only above the confidence and margin floors, otherwise `PENDING`. `--dry-run` makes no embedding request |
| `pnpm review:alignments` | List `PENDING` document blocks with their scores; `--approve <id> --unlock <mm:ss>` or `--reject <id> --reason "…"` |
| `pnpm canary:lesson` | Interrogate the real lesson: reads the stored transcript, builds its own expected-eligible oracle, and checks the scope count, the temporal invariant, citation eligibility, verbatim quotations, citation clocks and an unsupported question. `--positions`, `--max-turns`, `--label` |

The PR #7 candidate last passed lint, typecheck, **450 tests across 38 files**,
and a production build on 2026-10-19. Those are local checks of that candidate;
they do not verify real-account confirmation, restore or two-account isolation.

```bash
# 1. fetch the recording's OWN automatic English captions (never write one by hand)
yt-dlp --skip-download --write-auto-subs --sub-langs en --sub-format json3 \
  -o '.freebuff/captions/%(id)s.%(ext)s' https://youtu.be/ZaPbP9DwBOE

# 2. parse + segment, and report coverage without writing anything
pnpm ingest:lesson --dry-run

# 3. ingest (embeds in batches, one admission per batch against the day's cap)
pnpm ingest:lesson

# 4. interrogate the stored evidence
pnpm canary:lesson --base http://127.0.0.1:4321 --positions 300,1200,3000
```

The caption file is a third-party artefact and is gitignored: the ingest command
takes a path, so the text that reaches the database is the text a human chose to
fetch. A malformed or out-of-order caption file is refused outright rather than
re-sorted, because ordering is what makes the timestamps mean anything.

```bash
pnpm canary --base http://127.0.0.1:4321 --label fixture-unconfigured
pnpm canary --base http://127.0.0.1:4321 --delay 45000   # space positions out
pnpm canary --base http://127.0.0.1:4321 --course <courseId>   # override the target
```

The course is read from the server's own `GET /api/v1/courses` rather than assumed
from the fixture id, because a database-backed server serves the same lesson under
the id its seed assigned. `--course` overrides that, and the run prints which id it
used. A fixture-text oracle cannot check citations in a database corpus, so those
checks report `NOT RUN` there and must be verified separately.

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

**Two payloads (Gate 1).** The public `GET /api/v1/health` answers only: is the
app up, did an authenticated database read succeed, is a generation credential
configured, which corpus is being served, and **whether a question could be
admitted at all**. That last check is what stops a deployment missing migration
`0004` from calling itself operational while refusing every question. It
deliberately omits the day's token spend, the budget, model ids, the embedding cap,
schema-object counts and configuration problems — all of which used to be
machine-readable to any anonymous caller.

The full report below is what **`GET /api/v1/health/diagnostics`** returns to a
caller holding `Authorization: Bearer $HORIZON_DIAGNOSTICS_TOKEN` (404 when the
setting is empty, so an unconfigured deployment does not advertise it). Scripts
that need it can set the token; `pnpm verify:data-path` does.

The Status surface does **not** render this report. A page prop is serialized
into the HTML, so the page receives only `toPublicHealth(report)` — the same
projection the public endpoint returns — and therefore shows no spend, budget,
model ids, schema counts or configuration detail. Those are operator-only.

The operator report keeps the database facts separate, and `ok` is true only when
they all hold. This is the real payload, copied from the running server on the
current revision with all three migrations applied:

```jsonc
{
  "ok": true,
  "status": "ok",
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
      "schemaObjects": "verified", // 6/6 required tables and 6/6 required functions present
      "durableLedger": "usable",   // the budget table was read, so admission is possible
      "detail": "An authenticated read of the database succeeded; 6/6 required tables and 6/6 required functions present; the durable budget ledger is readable."
    },
    "runtimeAi": { "configured": true, "reachable": null, "detail": "Names are present. 0 of 20000 daily tokens are used. This endpoint does not verify the provider: run pnpm smoke and pnpm canary to confirm live behaviour." }
  },
  "runtime": {
    "provider": "groq", "textModel": "openai/gpt-oss-20b",
    "embeddingModel": "gemini-embedding-001", "embeddingDimensions": 768,
    "evidenceSource": "supabase", "usageMode": "supabase", "embeddingCapMode": "supabase",
    "demoContent": false,
    "spendGuard": "permitted", // every admission path is satisfied, so a call would be allowed
    "spentTokensToday": 0,     // a number: the day's total was actually read
    "embeddingRequestsToday": 0, // durable count for the UTC day; null = unreadable
    "embeddingCalls": 0, "maxEmbeddingCalls": 10  // embeddingCalls is THIS process only
  }
}
```

The same endpoint has been observed in the other state, and both are honest.
Before `0003` was applied it reported `ok: false`, `schemaObjects: "unknown"`,
`durableLedger: "unreadable"`, `spendGuard: "blocked"` and
`spentTokensToday: null`. That is still exactly what an unreadable ledger produces,
and it is the reason the guard fails closed: `spentTokensToday` is `0` above
because the total really was read as zero, while `null` means the total is
**UNKNOWN** and admission is refused rather than assumed unspent.

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
    api/v1/courses/[courseId]/transcript/route.ts  # eligible captions for the pane
    api/v1/courses/[courseId]/resources/route.ts   # sources + policy, counts only
    api/v1/courses/[courseId]/resources/[resourceId]/route.ts
    api/v1/courses/[courseId]/questions/route.ts   # the answer path
    page.tsx                 # Home: the welcome entry point (no model call)
    learn/page.tsx           # the studio, with ?lesson= ?section= ?start= deep links
    layout.tsx
  components/
    home/home-experience.tsx # hero, continue card, catalogue, capabilities, limits
    learning-studio.tsx      # the studio: position, scope, and the five surfaces
    shell/app-shell.tsx      # rail on desktop, five-column nav on mobile
    lesson/                  # stage, scope strip, transcript, assistant, personal hook
    materials/               # library and document viewer
    personal/                # bookmarks, notes, progress
    status/                  # operator facts, off the learning surface
    ui/                      # tokens-based primitives and inline icons
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
    presentation/continue-lesson.ts # which lesson Home continues, and where it links
    presentation/transcript-view.ts # caption selection, gaps, search, paragraph re-flow
    presentation/resources.ts       # page/slide/line grouping for the viewer
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
| `HORIZON_LLM_PROVIDER` | **server only** | `groq` or `google-genai`. Anything else is reported as unrecognised, never guessed |
| `HORIZON_LLM_BASE_URL` | **server only** | endpoint base for GENERATION. For `groq` the documented default (`https://api.groq.com/openai/v1`) is applied when empty; it is never forwarded to the Google SDK, which serves embeddings |
| `HORIZON_LLM_API_KEY` | **server only** | **generation** credential only (Groq key, or Google key under `google-genai`) |
| `HORIZON_LLM_MODEL` | **server only** | `openai/gpt-oss-20b` for `groq`, `gemini-3.6-flash` for `google-genai` |
| `HORIZON_LLM_REASONING_EFFORT` | **server only** | `low` \| `medium` \| `high`. Empty sends nothing and leaves the model's own default. Lower answers faster and cheaper |
| `HORIZON_EMBEDDING_API_KEY` | **server only** | **embedding** credential. Separate from the generation key because the two may be different vendors. `GOOGLE_API_KEY`/`GEMINI_API_KEY` are accepted as fallbacks, and `HORIZON_LLM_API_KEY` is a legacy fallback **only** under `google-genai`. Never sent to a non-Google provider |
| `HORIZON_EMBEDDING_MODEL` | **server only** | `gemini-embedding-001` |
| `HORIZON_EMBEDDING_DIMENSIONS` | **server only** | `768`; must match the stored vectors |
| `HORIZON_LLM_MAX_OUTPUT_TOKENS` | server | output cap per call; must exceed the reasoning budget or JSON gets truncated (default 4096) |
| `HORIZON_LLM_THINKING_BUDGET` | server | reasoning-token budget; unset sends nothing, `0` disables thinking. **`google-genai` only** — under `groq` it is ignored and reported as ignored |
| `HORIZON_DAILY_TOKEN_BUDGET` | server | cumulative daily token ceiling; `0` permits no calls |
| `HORIZON_MAX_EMBEDDING_CALLS` | server | ceiling on embedding REQUESTS per **UTC day**. With a database it is enforced durably and shared by every instance; without one it is process-local and resets on restart. `0` = no cap |
| `HORIZON_LLM_TIMEOUT_MS` | server | per-request provider timeout |

The budget is cumulative and per-call: each entry carries prompt, completion **and
billable reasoning** tokens, and the row persisted to `public.usage_ledger` sums to
exactly the figure the admission check used — `prompt_tokens + completion_tokens +
reasoning_tokens` — so the durable total and the enforced cap cannot drift apart.
Migration `0003` gave the table its own `reasoning_tokens` column; before it, the
value had nowhere to go and was folded into `completion_tokens` to survive at all.

**The two providers report usage differently, and both are counted once.**
Google reports reasoning separately (`thoughtsTokenCount`), so it is added.
Groq's Chat Completions usage object reports only `prompt_tokens` and
`completion_tokens`, with reasoning **already inside the completion** — so it is
recorded as unset and must not be derived a second time, which would bill every
reasoning token twice. Each adapter is tested for its own shape.

**What the budget does not cover.** Embedding requests are not metered, because
that API reports no token usage. `HORIZON_MAX_EMBEDDING_CALLS` bounds their
*count*, not their cost. And when no database is configured the ledger is
in-memory, so the daily total resets on restart and is not shared between
instances. `/api/v1/health/diagnostics` reports `runtime.usageMode`,
`spentTokensToday`, `embeddingRequestsToday` (the durable figure for the day,
`null` when it could not be read) and `embeddingCalls` (that process alone) so
none of this has to be guessed, and so the figure shown beside a durable cap is
read from the store that cap is counted in. The public health payload omits all
of it.

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

The migrations could not fix the *answer* path by themselves, and the *answer*
path's earlier failure was not a schema problem: it was one provider's free-tier
daily quota. Moving generation to Groq removed that block, and the live canary now
produces cited answers at 06:00 and 12:00 with an honest refusal at 00:00.

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
# generation (either provider):
#   HORIZON_LLM_PROVIDER=groq
#   HORIZON_LLM_BASE_URL=https://api.groq.com/openai/v1
#   HORIZON_LLM_MODEL=openai/gpt-oss-20b
#   HORIZON_LLM_API_KEY=<your Groq key>
# embeddings (still Google — the stored vectors came from this model):
#   HORIZON_EMBEDDING_API_KEY=<the Google key>
# set HORIZON_DAILY_TOKEN_BUDGET to a positive value — see the warning below
pnpm build && pnpm start
pnpm smoke    # one embedding call and one generation call, then stop
pnpm canary --base http://127.0.0.1:4321 --label configured
```

Run `pnpm smoke` first and read its output: it refuses to make any call unless
retries are off, the budget is positive, the embedding request cap is set **and**
an embedding credential exists — because an embedding test that silently runs on
the offline lexical embedder proves nothing about the model that embedded the
corpus. `/api/v1/health` reports `runtime.configurationProblems` for the same
reason.

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

- The lesson recording is **real**, and so is its transcript — but that
  transcript is **machine transcription**: YouTube's automatic English captions,
  ingested verbatim. Wording can be wrong even though nothing was edited, so the
  ASR caveat is stated next to the playhead, and the synthetic sample lesson is a
  separate, clearly labelled course that is never presented as the recording.
- The offline embedder is a lexical hash, not a semantic model. It is labelled
  `synthetic-lexical-v1` everywhere it is used, and it is only used when no
  embedding credential exists.
- The Tier-2 verifier is **model-assisted**, not independent. It reduces risk; it
  does not make the output infallible.
- Timings reported in the UI are measured for that single request. They are not
  benchmarks and no accuracy or latency claim is derived from them.
- A migration that has been written and unit tested is still reported as
  **not applied** until an artifact shows it applied. All three migrations cleared
  that bar on 2026-10-15 — `0001` and `0002` by a re-read of the live schema, and
  `0003` later that day by its own behavioural proof — and the artifacts are
  recorded in [docs/evidence](docs/evidence).

## Verified in this revision

```
pnpm lint         exit 0
pnpm typecheck    exit 0
pnpm test         exit 0   424 tests, 32 files   (all mocked; the transcript/integration cases run against fixtures written in the tests)
pnpm build        exit 0   routes: / (Home), /learn (studio), 9 API routes
pnpm seed:demo    exit 0   1 embedding request (cap 10) -> 1 course / 6 resources / 18 blocks, real 768-d vectors
pnpm verify:budget exit 0  12 concurrent generation reservations -> exactly 4 granted of a 4-slot budget; 12 concurrent embedding admissions -> exactly 3 of a cap of 3; cleanup complete, 0 probe rows
pnpm verify:rate-limit-sql exit 0  disposable Postgres 16: 0004 applies and re-applies cleanly; 3 calls at limit 2 -> admitted,admitted,refused with the count left at 2; 12 concurrent sessions at limit 4 -> exactly 4 admitted and a stored count of 4; anon is refused at the table and the function; rollback leaves the app failing closed
pnpm verify:data-path exit 0  25 passed, 0 failed, 0 pending — real rows, zero provider calls
pnpm smoke        exit 0   2 LIVE calls: 1 embedding (768d, all finite) + 1 generation (1 structured claim, charged 396 = 315 + 81)
pnpm ingest:lesson exit 0  LIVE: 1505 caption lines -> 56 blocks, 99.6% coverage; 3 embedding requests (0 -> 3 of a cap of 10); 56/56 rows at 768 dimensions, 0 rows with fixture text
pnpm canary       exit 0   18 passed, 0 failed, 9 not run  (live, database corpus; the 9 need fixture text)
pnpm canary:lesson exit 0  31 passed, 0 failed, 1 not run (4 live turns, database corpus); the not-run turn is the defect fixed below, re-run as 8 passed / 0 failed / 0 not run
```

That canary run also **found a real defect**: at an early position the turn came
back `TEMPORARILY_UNAVAILABLE / PROVIDER_MALFORMED`, and the server log named the
cause — `claims:too_big`. The model had returned more claims than the generation
envelope accepted (8), so a supported question was reported as a provider outage.
The count is not a truth property — Tier-1 checks every quotation against the
payload and Tier-2 verifies every claim — so the bound was raised to 40 (and the
verifier's verdict bound with it, above the claim bound), and the re-run answered
with 14 verified claims, all 14 quotation-verbatim and all 14 inside the 4-block
eligible set. Both artifacts are in [docs/evidence](docs/evidence).

The concurrency tests are unit tests over a shared ledger: they prove no two
turns can both hold the same budget, and that a refused turn reaches the provider
zero times. They **cannot** prove Postgres serializes admission, so
`pnpm verify:budget` does that against the real functions instead. With 12
simultaneous admissions against a budget that fits 4, exactly 4 were granted and
the granted capacity landed on the budget to the token; 12 simultaneous embedding
admissions bound at exactly 3 against a cap of 3. Every row it writes is tagged
`provider = 'concurrency-probe'` and deleted in a `finally` block: the run
reported 0 probe rows remaining and the day's total back at 0, so the proof left
the ledger as it found it. It makes no provider call and cannot spend quota. The
observed output is recorded in
[docs/evidence](docs/evidence/budget-concurrency-live-2026-10-15.json) — a
verbatim transcript, because that command does not write its own artifact.

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

On 2026-10-15 the question endpoint **cleared admission and answered**: health
reported `ok: true`, `durableLedger: "usable"` and `spendGuard: "permitted"`, and
the canary's three turns returned a refusal at 00:00 and cited answers at 06:00 and
12:00, charging 4609 tokens for the day with every ledger row settled. A provider's
own free-tier quota is a separate refusal from the guard —
`TEMPORARILY_UNAVAILABLE` with `PROVIDER_RATE_LIMITED` and a retry delay the
provider measures in hours — and the two must not be confused: `spendGuard`
describes the spend guard's admission, never the provider's availability.
Generation now runs on Groq, whose quota is separate from the Google one that
refused earlier attempts.

The unreadable-ledger path is not merely historical: it is still enforced and
still tested, and it refuses before any provider call while reporting
`guard.spentTokensToday` as `null` rather than `0`, because an unreadable budget
must never be treated as an unspent one. The record of that state is in
[docs/evidence](docs/evidence/db-path-verification-2026-10-15T09-28-15-146Z.json),
and the current revision's re-verification against the persisted corpus, now with
0 checks pending, is in
[docs/evidence](docs/evidence/data-path-verification-2026-10-15T11-08-26-553Z.json)
(re-run on the current build, same result).
All model-dependent tests are **mocked**, not real inference.

**The public deployment exists: <https://horizon-prototype.vercel.app>.** Its home
page, health endpoint, course list, scope endpoint and player were verified on that
origin on 2026-10-18 (EVALUATION.md Part 10). What was NOT exercised there is an
answered question and an opened PDF citation, because the day's token ceiling was
spent first; both are recorded as **not run**, not as passing.

Every case, its evidence kind, its actual result and everything that was **not**
run is recorded in [docs/EVALUATION.md](docs/EVALUATION.md).
