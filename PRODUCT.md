# Horizon product record

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Learners watching a recorded lesson who want to ask about what they have reached, inspect its transcript and materials, save notes, and resume later. Competition judges also need to understand the evidence boundary and refusal behavior with little explanation.

## Product Purpose

Horizon is a position-aware learning assistant for recorded lessons. Success means a learner can ask a question at the current lesson position, receive an answer whose claims have inspectable supporting citations, or receive a safe refusal when the available evidence is insufficient.

## Positioning

Evidence eligibility follows the lesson clock. Time-gated passages become searchable only when the recording reaches their unlock point; approved course-wide references are labelled separately. Citation text is matched against stored evidence before a claim is shown. The system fails closed when evidence or runtime services are unavailable.

## Operating Context

The main workflow is a browser lesson workspace with a video or clearly labelled synthetic fixture, player controls, a timestamped transcript, a current evidence-scope summary, a question composer, citation inspection, course materials, browser-local notes and bookmarks, progress, and a public status view.

## Capabilities and Constraints

- Next.js App Router, React, TypeScript, Tailwind CSS, Fastify contracts and safety layers, Supabase/Postgres, pgvector, full-text search, and provider adapters.
- The current playback clock and server-returned evidence scope drive the question flow. Client-side playback position is not an identity or authorization boundary.
- Transcript captions are machine generated and may contain transcription errors. Horizon-created study materials are compiled from those captions and are not instructor-supplied handouts.
- Email/password learner accounts and a protected account page are implemented. Notes, bookmarks and progress remain browser-local until owner-scoped database persistence is approved and applied. There is no cross-device sync or public instructor-review console yet.
- The mock-interview extension is optional under PS1 and is not part of the required MVP flow.

## Evidence on Hand

- Official selected problem statement and rubric: user-provided `PS1.pdf` (AI-Powered Interactive Learning Assistant with AI Mock Interview Extension). The user confirmed PS1 is the governing competition goal on 2026-10-19.
- Current implementation, tests, evaluation records and dated browser/database evidence are in this repository, especially `src/`, `tests/`, `docs/EVALUATION.md`, and `docs/evidence/`.
- Do not invent learner outcomes, model accuracy, latency, cost, customer quotes, or performance measurements.

## Product Principles

- Evidence must be eligible at the learner's current position.
- Every displayed claim must be grounded in inspectable evidence.
- Refuse clearly when evidence or required services are unavailable.
- Label synthetic examples, machine transcripts, and browser-local persistence honestly.
- Keep status information useful to learners without exposing operator secrets or diagnostics.
