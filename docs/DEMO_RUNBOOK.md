# Horizon judged-demo runbook (PS1)

## Before the demo

For the hosted deployment, open <https://horizon-prototype.vercel.app/>. The production alias was redeployed Ready on 2026-10-19 from the existing main release with bounded demo caps; the current live answer is recorded in `docs/EVALUATION.md` Part 19. The public Status surface is learner-safe and does not show spend, so it cannot establish remaining model budget.

For a local run, from the repository root:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Open `http://localhost:3000/learn?lesson=recording`. The app requires the environment configuration described in `.env.example` for the database-backed lesson and live model answers. Keep all credentials server-side and do not display `.env.local` during the demo. If local Supabase connectivity is unavailable, the UI must say so or use the explicitly labelled synthetic fixture; do not call fixture results real lesson answers.

## Recommended five-minute flow

1. **Open the real lesson.** Select “Lesson recording” and point out its original source and machine-generated caption provenance. Mention that the generated study guide/slides were compiled from the captions, not supplied by the instructor.
2. **Show current scope.** At `00:00`, the public release returned a cited answer to: “According to the opening transcript, which items are listed immediately after ‘Prompt engineering?’” The citation opened to a verbatim quote from page 1 of the compiled PDF, marked as an approved course-wide reference.
3. **Inspect the citation.** Open it and show the source type, page and verbatim quote. The player reports its own clock and the scope changes with seeking; keep the exact current position visible.
4. **Demonstrate the temporal refusal.** At `20:08`, the production release refused “What happens when the compliance score falls below 75%?” without revealing the future-only fact.
5. **Show the late answer.** At `50:00`, ask “What happens when the compliance score falls below 75%?” A production request on 2026-10-19 returned a verified answer citing `Transcript 44:52–45:53`, whose timeline-bound block is eligible at that position. The daily caps at that check were 25,000 generation/verification tokens and 11 embedding requests; they persist in Vercel until manually changed, while usage counters reset at UTC midnight. The verified question used request 11 of 11, so further AI questions are blocked until the embedding counter resets at UTC midnight. A prior request that day was correctly refused at the embedding-call limit.
6. **Demonstrate unsupported refusal.** At `50:00`, ask “How do I configure a Kubernetes ingress controller to serve gRPC over HTTP/2?” The expected result is an insufficient-evidence refusal with no claims or citations.
7. **Close with honest limits.** Show Materials, Notes or Progress if useful. The account API and RLS tables are deployed, but real-account browser sync, email confirmation and two-user isolation have not been verified. The Status page is the learner-safe health projection, not operator diagnostics.

## Expected behavior and recovery

- A supported question returns only verified claims with source citations.
- A future-only question refuses before its evidence unlocks; moving ahead may make the same evidence eligible.
- An unrelated question refuses without fabricated claims or citations.
- Provider, embedding, database and rate-limit failures remain distinguishable from an ordinary evidence refusal. If the live service is unavailable, show the message and continue with the source/transcript flow; do not claim a model answer succeeded.
- The fixture is synthetic and useful only to demonstrate the local deterministic pipeline. Keep its label visible.

Do not run `pnpm canary:lesson`, `pnpm verify:budget`, ingest/seed/prune scripts, or repeated production model calls as a last-minute demo check; they can consume quota or mutate shared data. Use the dated evidence in `docs/EVALUATION.md` unless an approved development environment is available.
