# Horizon design system

This file supersedes the raw UI/UX Pro Max first-pass output. That generator classified Horizon as a language-learning landing page and proposed testimonials, playful typography and a light clay palette. Those recommendations do not describe this recorded-lesson workspace and were rejected. The final specification below follows the repository's implemented tokens and the PS1 learning task.

**Project:** Horizon — position-aware learning assistant
**Platform:** Web application
**Use mode:** Operate and read; the learner watches, asks, inspects and studies.

## Product-specific design thesis

The lesson clock is the evidence boundary. The visible workspace should connect the current recording position to the evidence available there, then to a question, a grounded answer or refusal, and an inspectable citation. Keep the real lesson content central; keep operational status in the status surface.

## Color roles

Values come from `src/app/globals.css`; components should use the existing semantic Tailwind tokens.

| Role | Value | Use |
|---|---|---|
| Canvas | `#060a14` | Main page background |
| Surface | `#0c1322` | Panels and long-form reading |
| Muted surface | `#111a2d` | Nested controls, supporting details |
| Main ink | `#eef4ff` | Body text and headings |
| Secondary ink | `#b3c1d9` | Supporting copy |
| Quiet ink | `#8b9bb7` | Metadata; remains above 4.5:1 on the main surface |
| Brand | `#7aa2ff` | Links, focus, primary action and active evidence marker |
| Brand strong | `#a9c1ff` | Brand content on a soft brand tint |
| Positive | `#5eead4` | Confirmed operational success |
| Warning | `#fbbf6b` | Partial availability or caution |
| Danger | `#fb7185` | Failure requiring attention |
| Lines | white at 9% / 18% | Surface separation and stronger control boundaries |

Status must be communicated with text or an icon as well as color. Keep status hues out of decoration. Aurora light is a low-opacity background effect only; it must not sit behind text.

## Typography

Use the system sans stack for paragraphs, controls and headings; use the monospace stack for timestamps, request identifiers and measured values. Base text is 16px with 1.55 line height. Compact labels can be smaller, but must remain legible and should not carry essential explanations alone. Timestamp figures use tabular numerals where available.

## Spacing and layout

Use the existing 4/8/16/24/32px rhythm. Panels use 16px radii and controls use 10px radii. The desktop application shell uses a navigation rail; mobile keeps the lesson switcher and all real destinations reachable without horizontal scrolling. Grid children must be shrinkable (`min-width: 0`); questions, citations and transcript passages wrap rather than clip.

In the lesson workspace, the player leads, the scope summary follows the player, the assistant sits beside the lesson on wide screens and below scope on narrow screens, and the transcript remains a distinct reading surface. Do not bury the asked-at time or the eligible-evidence policy.

## Components and states

- **Primary action:** brand fill and inverse ink; visible focus and a real disabled state.
- **Secondary action:** outlined or muted opaque surface; use only for a real action.
- **Panel:** opaque surface, one restrained separation treatment, consistent padding.
- **Evidence scope:** current playback position, server-reported eligible block count and a short policy explanation.
- **Citation:** source type and timestamp/page/slide/line, exact matched quote, and actual seek/transcript actions when available.
- **Transcript:** only reached passages, timestamped and seekable; gaps stay explicit.
- **Loading:** stable placeholder or status text that does not imply an answer already exists.
- **Refusal:** distinguish insufficient evidence from provider/configuration/database failure; keep claims and citations empty when the contract says so.
- **Empty/error:** state what is missing and the next action when one exists.

## Accessibility and motion

Keep visible keyboard focus, semantic headings, associated question labels, keyboard-operable navigation and timeline controls, and reduced-motion support. Sticky chrome must not cover focused controls. Prefer native controls when they expose the needed keyboard and screen-reader behavior.

## Guardrails

- Never weaken time eligibility, evidence filtering, citation verification or fail-closed behavior for visual convenience.
- Clearly label synthetic fixtures, browser-local personal data and machine-generated transcript text.
- Do not invent testimonials, accuracy, latency, cost or learner outcome claims.
- Do not add a mock-interview, quiz or summary control until the feature is implemented.
- Keep long-form content on solid surfaces; avoid decorative glass behind text.
- Use the existing SVG icon set; do not use emoji as interface icons.
