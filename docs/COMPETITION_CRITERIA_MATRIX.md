# PS1 competition criteria matrix

## Source and selection

The governing source is the user-provided `PS1.pdf`, **AI-Powered Interactive Learning Assistant with AI Mock Interview Extension**. The user confirmed “PS1 learning assistant” on 2026-10-19. `PS2.pdf` is a different Build & Validation Agent problem and does not guide this product assessment.

Statuses reflect evidence in this repository and dated evaluation records. “PASS” means the core criterion has a verified implementation path; it does not mean every deployment scenario or benchmark is complete. No score is claimed.

## Weighted judging rubric

| Official criterion | Weight | Horizon behavior and evidence | Status | Remaining work |
|---|---:|---|---|---|
| Core functionality & learning experience | 20 | Public lesson catalogue, protected Studio, account dashboard, owner-progress resume route, video/playhead, transcript, materials, notes, bookmarks, progress, and summary/simple-explanation requests on the normal evidence-verified answer path. Historical real-player and responsive interaction evidence: `docs/UI-AUDIT.md`, `docs/EVALUATION.md`. | PARTIAL | Real Auth, remote restore, two-account isolation, quiz and end-to-end learner journey remain unverified or incomplete. |
| RAG accuracy & grounding | 20 | Eligibility-constrained retrieval in `src/lib/retrieval/`; quote and claim validation in `src/lib/answer/verification.ts` and `src/lib/answer/pipeline.ts`; deterministic cases in `tests/`; live cited answer and unsupported-question refusal in EVALUATION Part 13. | PASS | The live examples establish specific outcomes, not a general accuracy benchmark. Evaluate more paraphrases against a labeled set. |
| Timestamp awareness | 15 | Position boundary and server-reported scope in `src/lib/lesson/playhead.ts`, `src/lib/eligibility/predicate.ts`, API routes and `learning-studio.tsx`; live late-only fact refused at 20:00 and cited at 50:00 in EVALUATION Part 13. | PASS | Browser playhead is user-controlled and is not an identity or authorization boundary; that limitation is documented. |
| Technical architecture | 15 | App Router + typed API contracts; Supabase/Postgres, pgvector and FTS store; provider adapters; server-side eligibility and validation. `README.md`, `docs/DECISIONS.md`, SQL migrations and `supabase/` document the architecture. Connected Supabase inspection confirmed the expected learning tables and request-admission objects. | PASS | The Supabase migration-history API is empty because prior schema was applied manually; continue the established reviewed SQL Editor workflow. |
| Production readiness / deployment | 10 | Hosted app URL and historical production health/route verification recorded in `README.md` and EVALUATION Part 13; request size cap, request admission, budget guard, protected diagnostics and RLS are implemented. | PARTIAL | This work did not redeploy or verify a new production revision. Valid-token diagnostics success and automated rate-limit retention remain unverified/unconfigured. |
| Performance / cost optimization | 10 | Durable generation and embedding guards, bounded request body, lexical/vector retrieval and cancellation-safe UI queries. | PARTIAL | No fresh latency, low-powered-device frame-time, or monetary embedding-cost benchmark is available. Do not infer performance from code structure. |
| Code quality / security / documentation | 10 | TypeScript validation, lint and automated tests; security layers, RLS and public/operator health split; `README.md`, `docs/EVALUATION.md`, API documentation, migrations and this matrix. | PASS | Supabase advisors report mutable search paths on six `SECURITY INVOKER` functions and four unindexed foreign keys. RLS is enabled with no policies and browser-role table grants remain denied; no data exposure was established. Review narrowly if privileges or function security change. |

## Required competition deliverables

| Deliverable | Evidence/status |
|---|---|
| Hosted working system | Existing public URL: `https://horizon-prototype.vercel.app`; dated successful checks are in README and EVALUATION Part 13. Not redeployed by this task. |
| Source code | Repository source and tests. |
| Architecture diagram | `docs/ARCHITECTURE.md` contains a Mermaid diagram and verified question-path/data-boundary notes. |
| README/setup guide | `README.md` documents setup, environment variables, routes and operations. |
| API documentation | `README.md` API contract section and route handlers under `src/app/api/v1/`. |
| Sample dataset | Deterministic synthetic fixture in `src/lib/demo/lesson.ts`, clearly labelled in the UI. |
| Evaluation results | `docs/EVALUATION.md`; includes dated local and live evidence, known limits and non-claims. |
| Demo video | Not present in this repository inventory; record and submit separately if required. |
| Deployment instructions | `docs/DEPLOY.md`. |

## Scope notes

PS1 describes the mock interview as an advanced extension eligible for an additional reward. Horizon's selected blueprint includes it in full-prototype scope, but it is not represented as implemented. The summary action uses the regular evidence-gated answer path; a verified covered-content quiz is still missing.
