# Horizon judged-demo runbook (PS1)

## Before the demo

For the hosted deployment, open <https://horizon-prototype.vercel.app/>. The production alias currently serves `main` commit `591552a`; its health endpoint reports the Supabase-backed runtime as healthy. The candidate `a66085d` has a Ready Vercel preview at <https://horizon-prototype-puduxarmy-irrelevant3.vercel.app>, but that preview has fixture-only configuration and is for route/build inspection, not the live lesson demo. See the current release evidence in `docs/EVALUATION.md` Part 21 and historical production observations in Parts 13 and 18. Check the public Status surface before asking a metered question.

The production alias has not yet been verified to serve the learner-account candidate. The candidate preview's anonymous lesson route renders sign-in while preserving its `next` destination, and both auth forms render. Real production email confirmation, signed-in restoration and two-account persistence remain unverified. Do not rely on an unverified signup flow during a judge demo.

For a local run, from the repository root:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Open `http://localhost:3000/` and sign in with a configured local QA account before entering `http://localhost:3000/learn?lesson=recording`. The app requires the environment configuration described in `.env.example` for the database-backed lesson and live model answers. Keep all credentials server-side and do not display `.env.local` during the demo. If local Supabase connectivity is unavailable, the UI must say so or use the explicitly labelled synthetic fixture; do not call fixture results real lesson answers.

## Recommended five-minute flow

1. **Open the real lesson.** Select “Lesson recording” and point out its original source and machine-generated caption provenance. Mention that the generated study guide/slides were compiled from the captions, not supplied by the instructor.
2. **Show current scope.** At `00:00`, the public release returned a cited answer to: “According to the opening transcript, which items are listed immediately after ‘Prompt engineering?’” The citation opened to a verbatim quote from page 1 of the compiled PDF, marked as an approved course-wide reference.
3. **Inspect the citation.** Open it and show the source type, page and verbatim quote. The player reports its own clock and the scope changes with seeking; keep the exact current position visible.
4. **Demonstrate the temporal refusal.** At `20:08`, the production release refused “What happens when the compliance score falls below 75%?” without revealing the future-only fact.
5. **Advance and ask again only when the Status view indicates budget availability.** Earlier live evidence recorded an eligible cited answer at `50:00`, but during the current release acceptance the `50:05` request was safely blocked by the daily spend guard. Do not claim the late answer works in a live demo unless it succeeds in that session.
6. **Demonstrate unsupported refusal.** At `50:00`, ask “How do I configure a Kubernetes ingress controller to serve gRPC over HTTP/2?” The expected result is an insufficient-evidence refusal with no claims or citations.
7. **Close with honest limits.** Show Materials, Notes or Progress if useful. The account API and RLS tables are deployed, but real-account browser sync, email confirmation and two-user isolation have not been verified. The Status page is the learner-safe health projection, not operator diagnostics.

## Expected behavior and recovery

- A supported question returns only verified claims with source citations.
- “Summarize so far” and “Explain simply” submit through the normal evidence-gated answer path; treat their scope as the retrieved eligible evidence, not as an exhaustive transcript digest.
- A future-only question refuses before its evidence unlocks; moving ahead may make the same evidence eligible.
- An unrelated question refuses without fabricated claims or citations.
- Provider, embedding, database and rate-limit failures remain distinguishable from an ordinary evidence refusal. If the live service is unavailable, show the message and continue with the source/transcript flow; do not claim a model answer succeeded.
- The fixture is synthetic and useful only to demonstrate the local deterministic pipeline. Keep its label visible.

Do not run `pnpm canary:lesson`, `pnpm verify:budget`, ingest/seed/prune scripts, production model calls or database writes as a last-minute demo check; they can consume quotas or mutate shared data. Use the dated evidence in `docs/EVALUATION.md` unless an approved development environment is available.
