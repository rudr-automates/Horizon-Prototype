# Horizon — interface audit and studio revision (2026-10-18)

This is the screen-by-screen audit that preceded the interface work, what was
changed, what was deliberately left alone, and what is still not built. It is
written to be read beside [EVALUATION.md](EVALUATION.md) Part 11 and
[DECISIONS.md](DECISIONS.md) D-035 onwards.

The product promise did not change:

> Horizon helps a learner understand a lesson in context, see the evidence behind
> an answer, and explore only the content their current position permits.

What changed is whether the interface communicates that promise. It did not: the
capability was real and the page read like an operator's report.

---

## 1. What existed

One server-rendered page (`src/app/page.tsx`) rendering one client component,
`learner-workbench.tsx` (1,366 lines), which held:

- the recording and its real clock, with a seek slider, five jump presets and a
  "Play this passage" action that seeks and plays;
- a scope chip reading `GET /scope` for the eligible block count;
- a course-materials disclosure listing sources, policy and counts;
- a question composer, answer states, claim list, citation panel and per-turn
  diagnostics;
- six stacked health cards with provider, database, ledger and budget facts;
- honest notices for a missing transcript, a fixture corpus, a missing model or
  embedding key, a failed database path and configuration problems.

Backend surface at that point: `/health`, `/lesson/video`, `/courses`,
`/courses/:id`, `/courses/:id/scope`, `/courses/:id/resources`,
`/courses/:id/questions`. Tests: 345 passing in 22 files. Lint and typecheck
clean. A production deployment existed and had been verified for reachability,
health, scope counts and the YouTube embed.

## 2. What was wrong

| Observation | Why it mattered |
|---|---|
| Everything was one column under one heading | The lesson, the evidence scope, the assistant, the transcript and the runtime budget competed for the same attention. A judge's first screen was a stack of notices and a status table. |
| No navigation and no lesson identity in a persistent place | "Which lesson am I asking about" and "where else can I go" had to be inferred from body copy. |
| The transcript existed only as citations | The 56 ingested caption blocks were searchable only through the assistant. There was no way to read the lesson's text, and nothing said where the captions have no words. |
| Materials were a `<details>` disclosure | A three-source library with two policies and a review state was rendered as a footnote inside the scope card. |
| Developer diagnostics sat on the learning surface | Request ids, verifier names, ledger coverage and embedding caps were interleaved with the answer. Useful, but not a learner's screen. |
| Two clocks on one screen | The player printed its clock and the page printed another, both real, which invites doubt about which one a question uses. |
| Answer reasoning was described in a three-step `<ol>` in the page header | It explained the pipeline before the learner had seen a single answer, and it never changed. |
| Notes, bookmarks and progress did not exist | The blueprint's personal tools were absent, and no wording implied otherwise. |

What was already good, and was preserved: the eligibility predicate and its SQL
twin; the claims-only generator and two-tier verification; the citation
provenance rules; the refusal vocabulary; the spend guard; the video route with
range support; and the rule that a missing capability is stated rather than
faked.

## 3. The revision, surface by surface

### Learn

- An application shell with a left rail (desktop) and a five-column nav (mobile).
  Every destination exists; there is no disabled placeholder.
- The lesson stage keeps the real player and adds a transport that acts on it
  (play/pause, ±10 s, bookmark), one timeline, watched coverage, and a bookmark
  action beside the timeline instead of in the header.
- The scope strip states three facts: the position and where it came from, the
  eligible block count and the position it was counted at, and the policy (with
  the rule that a block unlocks at its end).
- The assistant is a panel with a composer, examples, a real pending state, a
  state badge, claims, and a citation card that shows the quotation, its source
  type, its location and its policy. "Play from mm:ss" appears only when the
  player can actually seek. The post-answer diagnostics moved into a disclosure.
- The transcript pane is new. It reads only the captions the lesson has reached,
  supports ordinary text search (no model call), states silent stretches as
  gaps, marks the passage the player's clock is inside, follows a seek, and
  re-flows the source's five-word caption lines into readable paragraphs without
  changing a word.
- Notices remain, but only for conditions that change what the learner can do.

### Materials

The disclosure became a library: one row per source with kind, policy, "n of m
blocks available now", text coverage and any pending review. The viewer shows
only permitted blocks, groups them by page, slide, line range or timestamp, and
offers page/slide chips and text zoom. Derived documents are labelled as
compiled from the same caption track, not as an independent second source. A
source that is visible here is not thereby searchable, and the page says so.

### Notes

Bookmarks and notes attached to a position, editable and removable with a
two-step confirmation. Stored in this browser, stated in the heading, because
Horizon has no accounts and a sync claim would be false.

### Progress

Watched coverage and furthest position are shown as two different numbers, with
a coverage map built from merged playback ranges. A seek moves the resume point
and does not count as watching; a playback step longer than five seconds is
discarded. Clearing site data removes the record, and the page says that too.

### System status

Everything that used to sit under the question box: provider, model, last
recorded provider call, embeddings, evidence source, database read, schema
objects, ledger, spend guard, embedding requests, configuration problems. Same
`/api/v1/health` payload, presented as an operator view with a short statement
of what is observed versus what is not claimed.

## 4. New backend surface, and why it is safe

Two read endpoints were added; no pipeline, prompt, provider or predicate
changed.

| Endpoint | Returns | Why it cannot leak |
|---|---|---|
| `GET /courses/:id/transcript?playheadSeconds=` | transcript blocks eligible at that position, with source timestamps and paragraphs re-flowed from stored caption lines | The store applies the canonical predicate in SQL and again in JavaScript; a future block is never in the response. No total count, no last-caption time, no unlock time. |
| `GET /courses/:id/resources/:resourceId?playheadSeconds=` | one source's permitted blocks, page/slide/line locations and a total count | Same predicate. A pending or rejected alignment never appears; a future page and its heading are not sent. The total count is already disclosed by the library list. |

Both use the learner-supplied playhead, exactly as the question path already
does. This is the existing trust model — there is no authentication, so a client
can assert any position — and it is now stated rather than implied. Within that
model, the panes can only fall behind the player, never ahead of it.

`EvidenceBlock` gained an optional `textOriginal` (stored caption line breaks,
read-only). Retrieval, prompts and quotation matching still use `text`.

## 5. Design system

- Tokens live in `@theme` in `src/app/globals.css`: surfaces, ink, lines, brand,
  status colours, radii, two shadows and a mono stack. Components use semantic
  utilities (`bg-surface`, `text-ink-soft`, `border-line`), not hex values.
- One deliberate light theme. `color-scheme: light` is fixed and the background
  and text colours are stated on `html` and `body`; there is no dark mode to get
  wrong, and the reason is documented in the file.
- No component library was added. Eleven inline SVG icons, four primitives
  (`Button`, `IconButton`, `Pill`, `Panel`), `Alert`, `EmptyState`, `Skeleton`
  and a two-step `ConfirmAction` cover the interface.
- Visible focus rings, `aria-current` on navigation, labelled controls, a skip
  link, `role="status"` on live state, and a `prefers-reduced-motion` block.

## 6. Verification

| Check | Result |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **365 passed** in 23 files (was 345 in 22). New: `tests/personal-and-panes.test.ts` (20 cases: storage validation, caps, watched-step rules, range merging, gap detection, search, paragraph flow, resource grouping) |
| `pnpm build` | see EVALUATION Part 11 (run after the interface work) |
| Browser, 1440×1000 | Learn, Materials, Notes, Progress, Status rendered. A jump to 25:00 seeked the real player (`currentTime` 1500) and the scope moved to 37 blocks; the transcript scrolled to the reached passage; the PDF viewer showed page 1 with page chips; the study guide is the default selection |
| Browser, 1024×900 | Rail layout, single content column, no clipped top bar |
| Browser, 768×900 | Mobile header and five-column nav, full-width player, no horizontal overflow |
| Browser, 390×844 and 360×780 | Nav fits without horizontal scroll, scope strip stacks, assistant follows the scope strip, lesson switcher reachable, timeline controls wrap |
| Interactions | Bookmark at 25:00, note saved, both survived a reload (`localStorage` inspected); seeking left `watched` empty and moved `furthest` to 1500; playing from 0 recorded 25–40 s of coverage; sample-fixture switch changed the stage, labels and source link |
| Console and network | No application errors. Media `206` responses during seeks; the `ERR_ABORTED` entries are aborted range requests from the player, which is normal during a seek |
| AI spend during this work | **none.** No question was asked. The ledger read 15,052 tokens and 10/10 embedding requests before and after |

## 7. Not built, and why

- **Instructor alignment review interface.** The review workflow exists as a CLI
  (`pnpm review:alignments`). A browser control would expose approve/reject to
  anonymous visitors, and there is no authentication to restrict it. It is
  documented as a limitation rather than shipped as an open endpoint.
- **Summary-so-far and quiz-on-covered-content.** Not implemented, so no control
  is rendered. This is still the largest missing learning action.
- **Mock interview.** Deferred.
- **Raster PDF rendering and OCR.** The viewer shows the permitted text layer.
  Rendering pages to canvas would need a worker and a new bundle, and OCR would
  require a vision model, which the spend rule for this phase forbids.
- **Cross-device notes, bookmarks and progress.** No account, no server-side
  personal store.
- **A theme switch.** Superseded the same day: revision 3 (§9) replaced the light
theme with the dark "Midnight Aurora" identity. The decision that survives is
"exactly one theme, stated once", not "a light one": a switch would double every
contrast pair that has to be measured, and it would need a per-preference QA pass
on a surface set that has none.

## 8. Limitations of this verification

- **No answer was generated through the redesigned assistant.** The provider
  calls are metered and this phase forbids them. The assistant's answer and
  citation markup is type-checked against the response contract and is a
  refactor of markup verified in Part 10, but the rendered result state has not
  been seen in a browser since the redesign.
- **No deployed-origin check yet for this revision.** The local build and the
  local browser are verified; the deploy follows this record and its own result
  is appended to EVALUATION Part 11.
- **PDF readability.** The stored page text is flattened at ingest, so headings
  and paragraph breaks inside a page are lost. The viewer groups by page and
  offers text zoom, but it does not re-typeset the document.
- **The materials viewer is text, not a facsimile.** A page looks like its text,
  not like the page.

---

## 9. Revision 3 — "Midnight Aurora" and the home entry point (2026-10-18, same day)

### What was asked, and what changed in structure

Two things were true of revision 2: it had no front door, and it looked like a
competent internal tool. `/` dropped every visitor straight into a lesson player
with an ask box and no statement of what the product is for, and the whole
interface was one light theme built from neutral greys.

- `/` is now **Home**: hero, continue card, course catalogue, the four-step
  learning loop, six capability cards and an explicit "what this build does not
  do" panel.
- `/learn` is the studio, moved unchanged in behaviour. The root route is no
  longer the workspace.
- Every screen shares one dark identity. Glass is used for chrome and the hero
  only; reading surfaces stay opaque.

### The identity, and why each choice is checkable

The palette, radii, shadows and glass rules live in
[`src/app/globals.css`](../src/app/globals.css) as `@theme` tokens. Two decisions
are worth recording because they are easy to get wrong and cheap to verify:

1. **Contrast is recorded, not eyeballed.** Each ink token carries its measured
   ratio against `--color-surface` in a comment: `ink` 16.8:1, `ink-soft` 10.2:1,
   `ink-faint` 6.6:1, `brand` 7.5:1, and `ink-inverse` 7.6:1 on `brand`. Status
   tones are the same (ok 12.5:1, warn 11.3:1, danger 6.9:1). A future palette
   change has a number to beat instead of an impression to match.
2. **Primary buttons use `text-ink-inverse`, not `text-white`.** On a periwinkle
   fill, white is about 2:1 and fails AA; the dark ink token is 7.6:1. Every
   filled control in the app was switched, and the reason is written beside the
   token so it is not "fixed" back.

Glass is deliberately bounded. `.glass` and `.glass-strong` are component-layer
classes applied to the rail, the two top bars and the hero card. Below 768px the
blur is dropped and the tint raised, because backdrop blur on a phone is a
compositing cost on every scroll frame.

### Home: what it is allowed to say

Every figure on Home is either a real course fact from the evidence store or a
real number from this browser's `localStorage`. Specifically:

- **Continue learning** reads the personal store through the existing
  `useSyncExternalStore` hook, and picks the lesson with the most recently updated
  progress record, not the first catalogue row. A record with a reached position
  but no watched time is still offered, and the two figures are printed
  separately ("Watched 00:00 of 56:39 · 0% · reached 25:00") so a seek can never
  look like coverage.
- **The catalogue** renders `listCourses()` as returned. The recording is
  identified by the id its own ingest derives from the video id; anything else is
  labelled a sample only when the catalogue itself says so (`demoContent` or its
  own title). With two courses it adds a note saying this is a two-course
  prototype rather than a library, instead of padding the grid.
- **Capability cards** state the availability of the deployment in front of the
  reader: whether a generation key is configured, whether an embedding credential
  is present, whether the player is the local copy or the original embed.
- **No model call is made anywhere on the page.** It is a read plus browser-local
  state, so the daily token budget is untouched by visiting it.

### The studio, restyled rather than only recoloured

- Glass rail and top bars; a gradient brand mark that links Home; a `Home` item in
  both navigations (six items on mobile, all visible at 360px, no horizontal
  scroll); an `All lessons` link in the top bar.
- The lesson stage keeps its transport attached to the panel instead of floating
  over the picture, with the watched bar, the position-source line and the jump
  presets in one band. The timeline is still a native `range` input — the only
  control that is keyboard-accessible, labelled and touch-correct for free — and
  it is restyled, not replaced by a div.
- Panels gained an eyebrow in the brand colour and a little more air; the
  transcript, citation, answer and resource surfaces stayed opaque and kept their
  sizes.

### Deep links, and the position they carry

`/learn` reads `?lesson=recording|sample`, `?section=learn|materials|notes|progress|status`
and `?start=<seconds>` on the server, so a shared link opens the right surface on
the first paint. Switching lesson or surface updates the address with
`history.replaceState`, which keeps the address shareable and refresh-survivable
without adding a history entry per tab click, so Back still returns to Home.

`?start=` is applied on the **player's first clock report**, not on mount: a seek
written before the element has metadata is silently discarded by the browser, and
a "resume" link that resumes nothing is worse than none. Once applied, the
parameter is removed from the address so a refresh cannot re-apply a stale
position. Both halves were verified in the browser: `?start=1500` seeked the real
element to 1500s (25:00), and the address came back as `/learn`.

### Verification

| Check | Result |
|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | exit 0; routes `/` and `/learn` both present in the build output |
| `pnpm test` | 371 passed in 23 files, including 6 new cases for the continue-lesson rules (recording identified by id, unflagged material not called synthetic, most-recent progress wins, a reached position is not watched coverage, empty catalogue returns null) |
| Widths | 1440, 1024, 768, 390 and 360 px, on Home and on `/learn`, in a real browser |
| Horizontal overflow | none at any of the five widths; measured as `scrollWidth - clientWidth` on the document, not inferred from the layout |
| Resume | `?start=1500` → `currentTime` 1500, clock `25:00`, position source `the player's own playback clock`, address cleaned afterwards |
| Lesson switch | selecting the sample changed the heading, removed the video element, stated that the sample has no recording, and set `?lesson=sample` |
| Scope and transcript at 25:00 | 37 eligible blocks, 24 passages, last passage ends at 1470.799s — unchanged by the redesign |
| Accessibility fixes found by inspection | the responsive header's hidden items were relying on class-order (`hidden sm:inline-flex` racing `inline-flex`); each is now inside a responsive wrapper. Footer links got a 24px tap target |
| AI spend | 15,052 tokens and 10/10 embedding requests before and after; no provider call was made in this revision |

### Not built here

- **The redesigned answer state is still unrendered.** Rendering a live answer
  needs a metered provider call, which this phase forbids. The markup compiles
  against the response contract and is a restyle of markup verified in Part 10.
- **No completion score, streak or grade.** Watched time is reported because it is
  measured; the others would not be.
- **No account surface.** Nothing on Home implies cross-device sync, because
  there is none.

### Limitations of this verification

- Every width was checked against the local production-parity build in the
  browser; the deployed origin is checked separately and recorded in
  [EVALUATION Part 12](EVALUATION.md).
- The glass blur was verified by rendering, not by measuring frame time. The
  phone-sized rule (no blur, stronger tint) is a deliberate precaution rather than
  a measurement of a slow device.
- Home's continue card was exercised with real stored progress created in the
  browser (a seek to 25:00 and a bookmark); no other progress state was simulated.
