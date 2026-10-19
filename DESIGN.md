---
name: Horizon
description: A focused recorded-lesson workspace where playback position controls which evidence can support an answer.
colors:
  primary: "#7aa2ff"
  primary-strong: "#a9c1ff"
  canvas: "#060a14"
  surface: "#0c1322"
  surface-muted: "#111a2d"
  ink: "#eef4ff"
  ink-soft: "#b3c1d9"
  ink-faint: "#8b9bb7"
  ok: "#5eead4"
  warn: "#fbbf6b"
  danger: "#fb7185"
typography:
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  data:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sm: "10px"
  md: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#071022"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
  reading-surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "16px"
---

# Overview

**Creative North Star: The lesson clock is the evidence boundary.**

Horizon is an operating workspace for long lesson sessions. The player, current time, eligible evidence, question, answer and citation form one visible chain. Keep the video and reading areas quiet so the lesson carries the attention; use periwinkle for navigation and actions, and status colors only for actual status. Midnight Aurora remains the incumbent visual identity, refined for clear reading and concise evidence inspection.

**Key Characteristics:**

- Low-light canvas with opaque reading and form surfaces.
- One semantic token layer in `src/app/globals.css`; components use token utilities rather than individual hex values.
- Custom SVG icons, concise labels and timestamp-aligned monospace numerals.
- Motion is restrained; reduced-motion preferences are respected.
- No invented testimonials, vanity metrics, or unlabeled synthetic data.

# Colors

The deep navy canvas supports long viewing sessions. Raised surfaces separate controls and text without relying on blur. Ink values are measured against the main surface; status hues are reserved for real outcomes. The aurora is a subdued backdrop, never a text surface.

**The Reading Surface Rule.** Transcript, answer, citation, materials, form and table text sits on an opaque surface, never on glass or a decorative gradient.

# Typography

Use the system sans stack for reading and controls. Use the monospace stack only for timestamps, IDs and measured values. Keep long passages comfortably wrapped; labels may be compact but supporting body copy should remain readable at 16px or larger where space permits.

**The Clock Rule.** Playback times use tabular monospace numerals so changing values do not shift nearby controls.

# Layout

The desktop shell has a persistent navigation rail and a flexible content area. On the lesson surface, the player leads; evidence scope follows it; the assistant sits alongside on wide screens and follows scope on narrow screens; transcript and materials remain available as separate reading panes. Use `min-width: 0` in grid children and let controls wrap on narrow screens. Keep focus visible below sticky navigation.

**The Evidence Chain Rule.** Always keep the asked-at time, answer state, source label and timestamped citation understandable together. A seek changes the player position; it does not claim that the learner watched the skipped material.

# Elevation & Depth

Use a thin line and one subtle depth treatment to distinguish major panels from the canvas. Reserve glass and blur for navigation chrome; disable blur on narrow screens. Do not stack a prominent border and broad shadow on every nested surface.

# Shapes

Panels use a consistent moderate radius; controls use a smaller radius. Compact status pills are the only fully rounded shape. Use borders to define containment, not as decoration.

# Components

- **Primary button:** periwinkle fill, dark ink, visible focus, disabled state, and concise action label.
- **Secondary button:** opaque surface or transparent fill with a visible line; do not imply an unavailable action.
- **Panel:** opaque reading surface with a restrained border and consistent padding.
- **Scope summary:** playback position, server-returned eligible block count, and policy in plain language.
- **Citation:** source kind, precise timestamp/page/slide/line, matched quotation, and available seek or transcript action.
- **Notice and empty state:** say what happened and name a recovery action where one exists.
- **Navigation:** real routes and surfaces only; mark the selected destination semantically.

# Do's and Don'ts

- Do label synthetic course fixtures, browser-local notes, machine transcription, and database evidence at the point of use.
- Do make loading, unsupported-evidence, provider-failure and database-failure states distinct.
- Do preserve the current evidence-eligibility and citation-verification behavior when changing presentation.
- Do use visible keyboard focus, associated form labels, and reduced-motion behavior.
- Don't show a claim without its verified citation or show future-only lesson content early.
- Don't present quiz or mock-interview controls until those features exist. Summary and simple-explanation actions must keep the current evidence boundary and use the verified answer path; they summarize retrieved eligible evidence, not a guaranteed exhaustive set of every covered passage.
- Don't put secrets, internal spend details, or operator diagnostics in learner-facing pages.
- Don't use decorative glass behind text, gradients as text, emoji as structural icons, or colored side rails on every card.
