# Deploying Horizon

**Status: NOT DEPLOYED. There is no public URL.** No host was configured in any
part of this work, so nothing here has been executed. This document is the
prepared procedure, not a report of a deployment.

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
| `HORIZON_LLM_PROVIDER` | server | inference | Must be `google-genai` for any model call to be possible |
| `HORIZON_LLM_API_KEY` | **secret** | inference | Free-tier Google Gemini key. `GOOGLE_API_KEY` / `GEMINI_API_KEY` are accepted as fallbacks |
| `HORIZON_LLM_MODEL` | server | inference | `gemini-3.6-flash` |
| `HORIZON_EMBEDDING_MODEL` | server | retrieval | `gemini-embedding-001` |
| `HORIZON_EMBEDDING_DIMENSIONS` | server | retrieval | `768`. Must match the stored vectors exactly |
| `HORIZON_DAILY_TOKEN_BUDGET` | server | inference | **`0` permits no provider call at all.** See §5 |
| `HORIZON_LLM_TIMEOUT_MS` | server | inference | `30000` is a sane start |
| `HORIZON_LLM_MAX_OUTPUT_TOKENS` | server | inference | `1024` |
| `HORIZON_LLM_BASE_URL` | server | — | Leave **empty**. The official SDK resolves its own endpoint |

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

To allow inference, set a positive value, for example `HORIZON_DAILY_TOKEN_BUDGET=200000`.

Confirm the guard's state from the public health endpoint rather than guessing:

```bash
curl -s https://<project>.vercel.app/api/v1/health | node -e \
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).runtime.spendGuard))"
# expect: permitted
```

## 6. Verification after deploy — run all of it

Open the URL in a clean browser session and then:

| Check | Expected |
|---|---|
| Home page | Loads; the sample lesson and the "synthetic demo" labelling are visible |
| `GET /api/v1/health` | HTTP 200; `checks.database.configured` and `checks.runtimeAi.configured` reflect reality; `runtime.spendGuard` is reported |
| Health must not overclaim | `runtimeAi.reachable` is `null` unless a live smoke test was actually recorded |
| Timestamp controls | Moving the slider or a preset changes the eligible-block count |
| Early canary (00:00, 06:00) | Refuses. The constant `0.37` must not appear anywhere in the page or the response |
| Late canary (12:00) | A supported answer **only** if the model is configured, in budget, and the eligible set actually contains the fact |
| Citation panel | Opens and shows the source text with a timestamp/page/slide that matches the block |
| Secret exposure | View source and DevTools: no key, no service-role token, no stack trace |
| Failure modes | With credentials removed, the app refuses; it never fabricates an answer |

Run the recorded canary against the deployed host so the evidence is
reproducible rather than described:

```bash
pnpm canary --base https://<project>.vercel.app --label prod
```

## 7. Things that are still missing after a successful deploy

- **Migrations are not applied by this procedure.** `0001_init.sql` and
  `0002_search_functions.sql` must be applied separately through the Supabase
  SQL Editor (`docs/apply-migration.md`). Until they are, the app runs in
  fixture mode and says so in `/api/v1/health` (`evidenceSource: "fixture"`).
- **The corpus is synthetic.** Deploying does not make the demo database-backed.
- **No approximate vector index**, no auth, no rate limiting beyond the spend
  guard and request-size validation.

## 8. If access cannot be connected

The blocking action is a human one: someone with Vercel account access must
authorise the GitHub repository connection in the Vercel dashboard (§4) and add
the environment variables (§3). Until that happens, report **no public URL
exists**. Do not present a local `next start` as a deployment — it is not
reachable by a judge.
