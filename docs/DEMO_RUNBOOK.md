# Horizon judged-demo runbook (PS1)

## Before the demo

For the hosted deployment, open <https://horizon-prototype.vercel.app/> and confirm the page loads. The dated health and answer evidence is in `docs/EVALUATION.md` Part 13; this runbook does not claim this working copy has just been deployed or live-tested.

For a local run, from the repository root:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Open `http://localhost:3000/learn?lesson=recording`. The app requires the environment configuration described in `.env.example` for the database-backed lesson and live model answers. Keep all credentials server-side and do not display `.env.local` during the demo. If local Supabase connectivity is unavailable, the UI must say so or use the explicitly labelled synthetic fixture; do not call fixture results real lesson answers.

## Recommended five-minute flow

1. **Open the real lesson.** Select “Lesson recording” and point out its original source and machine-generated caption provenance. Mention that the generated study guide/slides were compiled from the captions, not supplied by the instructor.
2. **Show current scope.** Set the player to `05:00`. The scope summary and assistant boundary should read at or before that position. Ask the suggested question: “According to the opening transcript, which items are listed immediately after ‘Prompt engineering’?” Historical production evidence records one cited answer to this exact wording.
3. **Inspect the citation.** Open it. Show source kind, timestamp and verbatim quote; use “Show in transcript” or “Play from” to connect the citation back to the lesson.
4. **Demonstrate the temporal refusal.** Ask “What happens when the compliance score falls below 75%?” at `20:00`. The expected response is an insufficient-evidence refusal with no claims or citations because the passage is not yet eligible.
5. **Advance and ask again.** Move to `50:00` and submit the same question. The historical verified response is one claim with a citation to the `44:52–45:53` transcript passage. Show that the evidence unlocks only after the lesson reaches it.
6. **Demonstrate unsupported refusal.** At `50:00`, ask “How do I configure a Kubernetes ingress controller to serve gRPC over HTTP/2?” The expected result is an insufficient-evidence refusal with no claims or citations.
7. **Close with honest limits.** Show Materials, Notes or Progress if useful. Signed-in personal data syncs through the owner-scoped API; this local implementation has not had a real-account browser round trip. The Status page is the learner-safe health projection, not operator diagnostics.

## Expected behavior and recovery

- A supported question returns only verified claims with source citations.
- A future-only question refuses before its evidence unlocks; moving ahead may make the same evidence eligible.
- An unrelated question refuses without fabricated claims or citations.
- Provider, embedding, database and rate-limit failures remain distinguishable from an ordinary evidence refusal. If the live service is unavailable, show the message and continue with the source/transcript flow; do not claim a model answer succeeded.
- The fixture is synthetic and useful only to demonstrate the local deterministic pipeline. Keep its label visible.

Do not run `pnpm canary:lesson`, `pnpm verify:budget`, ingest/seed/prune scripts, production model calls or database writes as a last-minute demo check; they can consume quotas or mutate shared data. Use the dated evidence in `docs/EVALUATION.md` unless an approved development environment is available.
