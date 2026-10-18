"use client";

/**
 * The home experience.
 *
 * WHAT IT IS FOR
 *   A first-time visitor used to land directly inside the studio: a lesson player,
 *   an evidence count and an ask box, with no statement of what the product does.
 *   This page states the promise in one sentence, offers the lesson this browser
 *   actually has progress in, lists the course catalogue the evidence store really
 *   returned, and explains the four-step learning loop.
 *
 * WHAT IT IS NOT ALLOWED TO SAY
 *   No testimonials, no user counts, no completion rates, no "students love it".
 *   Every figure on this page is either a real course fact from the evidence store
 *   or a real progress figure from this browser's own storage, and the sample
 *   fixture is labelled as synthetic wherever it appears. Where a capability
 *   depends on server configuration, the card says which state this deployment is
 *   in instead of promising the feature.
 *
 * WHY PROGRESS IS READ HERE AND NOT FETCHED
 *   Bookmarks, notes and watched progress live in this browser's `localStorage`
 *   (Horizon has no accounts), so the continue card is the only honest source for
 *   "where were you". A server-rendered figure would be a different number with no
 *   way to reconcile it.
 */
import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/icons";
import { EmptyState, Panel, Pill } from "@/components/ui/primitives";
import { usePersonalData } from "@/components/lesson/use-personal-data";
import { LESSON_VIDEO_EVIDENCE, formatPlaybackClock } from "@/lib/lesson/video";
import { watchedFraction } from "@/lib/personal/local-store";
import {
  chooseContinueLesson,
  lessonHref,
  type LessonEntry,
} from "@/lib/presentation/continue-lesson";

const PRIMARY_ACTION =
  "inline-flex items-center justify-center gap-2 rounded-control border border-brand bg-brand px-4 py-2.5 text-sm font-semibold text-ink-inverse transition-[background-color,border-color,box-shadow] duration-200 hover:border-brand-strong hover:bg-brand-strong hover:shadow-[0_16px_40px_-20px_rgb(122_162_255/0.9)]";
const SECONDARY_ACTION =
  "inline-flex items-center justify-center gap-2 rounded-control border border-line-strong bg-surface px-4 py-2.5 text-sm font-semibold text-ink transition-[background-color,border-color] duration-200 hover:border-brand-line hover:bg-brand-soft";
const QUIET_ACTION =
  "inline-flex items-center gap-1.5 rounded-control px-2 py-2 text-sm font-semibold text-ink-soft transition-colors duration-150 hover:text-ink";

const HOW_IT_WORKS: Array<{ title: string; body: string }> = [
  {
    title: "Follow the lesson at your own pace",
    body: "Play the recording, scrub the timeline, or jump to a chapter. The player's own clock is the position the rest of the studio uses.",
  },
  {
    title: "Read what the lesson has reached",
    body: "The transcript and every course source show only the passages the recording has passed. A caption you have not reached is never rendered early.",
  },
  {
    title: "Ask where the assistant is enabled",
    body: "A question is answered from the eligible passages at your position, and each claim has to quote one before it can be shown.",
  },
  {
    title: "Check the citation, then return to it",
    body: "Open the source behind a claim, read the quoted line, and play the passage it came from. An unsupported claim is dropped rather than softened.",
  },
];

interface Capability {
  icon: IconName;
  title: string;
  body: string;
  availability: "available" | "configured" | "not-configured";
  availabilityNote: string;
}

export interface HomeExperienceProps {
  entries: LessonEntry[];
  evidenceSource: "supabase" | "fixture";
  evidenceReason: string;
  storeError: string | null;
  runtimeAiConfigured: boolean;
  embeddingCredentialPresent: boolean;
  lessonVideoKind: "file" | "embed";
}

export function HomeExperience(props: HomeExperienceProps) {
  const {
    entries,
    evidenceSource,
    evidenceReason,
    storeError,
    runtimeAiConfigured,
    embeddingCredentialPresent,
    lessonVideoKind,
  } = props;

  const personal = usePersonalData();
  const choice = chooseContinueLesson(entries, personal.state.progress);
  const noteCount = personal.state.notes.length;
  const bookmarkCount = personal.state.bookmarks.length;
  // Counted separately and phrased separately: "1 saved note and bookmark" would
  // report two different things as one, which is exactly the kind of number that
  // stops being trustworthy once it is wrong.
  const practiceParts = [
    noteCount > 0 ? `${noteCount} note${noteCount === 1 ? "" : "s"}` : null,
    bookmarkCount > 0 ? `${bookmarkCount} bookmark${bookmarkCount === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => part !== null);

  const capabilities: Capability[] = [
    {
      icon: "video",
      title: "Recorded lessons",
      body:
        lessonVideoKind === "file"
          ? "Streamed from this workspace's own copy of the recording, with the browser's element as the clock."
          : "Played from the original source through the official player API, because a host has no local copy of the recording.",
      availability: "available",
      availabilityNote:
        lessonVideoKind === "file" ? "local copy · same origin" : "original source · embed",
    },
    {
      icon: "search",
      title: "Position-aware transcript",
      body:
        "Captions arrive as the lesson reaches them, searchable by ordinary text matching, with the silent stretches between them stated rather than filled in.",
      availability: "available",
      availabilityNote:
        LESSON_VIDEO_EVIDENCE === "indexed"
          ? "machine transcription · unedited"
          : "caption source not indexed here",
    },
    {
      icon: "layers",
      title: "Evidence-linked answers",
      body:
        "Each claim carries the passage it came from, the source type, and where it sits. Opening a citation shows the quoted text that was matched verbatim.",
      availability: runtimeAiConfigured ? "configured" : "not-configured",
      availabilityNote: runtimeAiConfigured
        ? embeddingCredentialPresent
          ? "generation and embeddings configured"
          : "generation configured · embedding credential missing"
        : "no generation key on this deployment",
    },
    {
      icon: "materials",
      title: "Course materials",
      body:
        "PDF, slide and transcript sources of the same lesson, with each source's policy shown: approved at every position, or unlocked as the recording reaches it.",
      availability: "available",
      availabilityNote:
        evidenceSource === "supabase"
          ? "read from the database"
          : "sample corpus has no resource rows",
    },
    {
      icon: "bookmark",
      title: "Bookmarks and notes",
      body:
        "Save a moment or write a note against the position it belongs to. Both live in this browser and the panels say so on every screen.",
      availability: "available",
      availabilityNote: "stored in this browser only",
    },
    {
      icon: "progress",
      title: "Honest progress",
      body:
        "Watched coverage is counted from playback the player reported, and is kept separate from the furthest point reached, which is only a resume position.",
      availability: "available",
      availabilityNote: "a seek is not watching",
    },
  ];

  const primaryHref = choice ? lessonHref(choice.entry, choice.started ? choice.seconds : 0) : "/learn";
  const primaryLabel = choice?.started
    ? `Continue · resume at ${formatPlaybackClock(choice.seconds)}`
    : "Start the lesson";

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#home-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control border border-brand bg-brand px-4 py-2 text-sm font-semibold text-ink-inverse"
      >
        Skip to content
      </a>

      {/* ---------------- Product navigation ---------------- */}
      <header className="glass sticky top-0 z-40 border-b border-line">
        <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Horizon home">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-control bg-[linear-gradient(140deg,var(--color-brand),#9d7bff)] text-base font-bold text-ink-inverse"
            >
              H
            </span>
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold leading-5 tracking-tight text-ink">
                Horizon
              </span>
              <span className="hidden text-[11px] text-ink-faint sm:block">
                Position-aware learning
              </span>
            </span>
          </Link>

          {/*
           * Each anchor is wrapped rather than given `hidden sm:inline-flex`
           * directly: `hidden` and `inline-flex` set the same property at the same
           * specificity, so which one wins depends on stylesheet order, not class
           * order. A variant (`sm:inline-flex`) is generated after both, so the
           * wrapper is the reliable form.
           */}
          <nav aria-label="Product" className="flex items-center gap-1">
            <span className="hidden sm:inline-flex">
              <a href="#how-it-works" className={QUIET_ACTION}>
                How it works
              </a>
            </span>
            <span className="hidden md:inline-flex">
              <a href="#lessons" className={QUIET_ACTION}>
                Lessons
              </a>
            </span>
            <span className="hidden md:inline-flex">
              <a href="#capabilities" className={QUIET_ACTION}>
                Capabilities
              </a>
            </span>
            <Link href="/learn" className={`${PRIMARY_ACTION} ml-1 shrink-0 px-3.5 py-2`}>
              Open the studio
              <Icon name="arrow" size={14} />
            </Link>
          </nav>
        </div>
      </header>

      <main id="home-main" className="flex-1">
        {/* ---------------- Hero ---------------- */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-32 -top-40 h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(circle,rgb(122_162_255/0.28),transparent_65%)] blur-2xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-24 top-10 h-[22rem] w-[22rem] rounded-full bg-[radial-gradient(circle,rgb(157_123_255/0.22),transparent_65%)] blur-2xl"
          />

          <div className="mx-auto grid w-full max-w-[1200px] items-start gap-10 px-4 pb-16 pt-12 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14 lg:pb-20 lg:pt-20">
            <div className="min-w-0">
              <Pill tone="brand" className="px-2.5 py-1">
                <Icon name="sparkle" size={12} />
                Position-aware learning
              </Pill>
              <h1 className="mt-4 text-balance text-[34px] font-semibold leading-[1.1] tracking-[-0.03em] text-ink sm:text-[44px] lg:text-[52px]">
                Learn beyond the lecture.
              </h1>
              <p className="mt-4 max-w-xl text-base leading-7 text-ink-soft sm:text-[17px]">
                Follow recorded lessons, ask questions grounded in permitted evidence,
                and jump straight to the passage that explains the answer.
              </p>

              <div className="mt-7 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                {entries.length > 0 ? (
                  <Link href={primaryHref} className={`${PRIMARY_ACTION} w-full sm:w-auto`}>
                    <Icon name="play" size={15} />
                    {primaryLabel}
                  </Link>
                ) : null}
                <Link
                  href="/learn?section=materials"
                  className={`${SECONDARY_ACTION} w-full sm:w-auto`}
                >
                  <Icon name="materials" size={15} />
                  Explore course materials
                </Link>
                {entries.length > 0 ? (
                  <a href="#how-it-works" className={`${QUIET_ACTION} justify-center sm:justify-start`}>
                    See how it works
                    <Icon name="arrow" size={13} />
                  </a>
                ) : null}
              </div>

              <dl className="mt-9 grid max-w-xl grid-cols-1 gap-x-6 gap-y-3 text-xs text-ink-soft sm:grid-cols-3">
                <div>
                  <dt className="font-semibold text-ink">Eligibility first</dt>
                  <dd className="mt-0.5 leading-5">
                    Evidence is filtered before the model sees it, at the position the
                    player reported.
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink">Cited answers</dt>
                  <dd className="mt-0.5 leading-5">
                    A claim that cannot quote its source is dropped, not shown.
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink">No account needed</dt>
                  <dd className="mt-0.5 leading-5">
                    Your notes and progress stay in this browser.
                  </dd>
                </div>
              </dl>
            </div>

            {/* ---------------- Continue card ---------------- */}
            <Panel tone="glass" className="min-w-0 p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand">
                  <Icon name="progress" size={13} />
                  Continue learning
                </p>
                {choice?.started ? (
                  <Pill tone="ok">in progress</Pill>
                ) : (
                  <Pill tone="neutral">not started</Pill>
                )}
              </div>

              {choice === null ? (
                <EmptyState icon="materials" title="No lesson to open">
                  The evidence store returned no course for this deployment. The studio
                  and the status surface explain why.
                </EmptyState>
              ) : (
                <>
                  <p className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                    <span className="inline-flex items-center gap-1">
                      <Icon
                        name={choice.entry.kind === "recording" ? "video" : "layers"}
                        size={12}
                      />
                      {choice.entry.kind === "recording" ? "Lesson recording" : "Sample course"}
                    </span>
                    <span aria-hidden="true" className="text-line-strong">·</span>
                    <span className="font-mono tabular-nums">
                      {formatPlaybackClock(choice.entry.durationSeconds)}
                    </span>
                    {choice.entry.synthetic && (
                      <>
                        <span aria-hidden="true" className="text-line-strong">·</span>
                        <span className="font-semibold text-warn">synthetic sample</span>
                      </>
                    )}
                  </p>

                  <h2 className="mt-2 text-lg font-semibold leading-7 tracking-[-0.01em] text-ink">
                    {choice.entry.title}
                  </h2>

                  <div className="mt-4">
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
                      role="img"
                      aria-label={`Watched ${formatPlaybackClock(choice.watched)}, ${Math.round(choice.fraction * 100)} percent of this lesson, in this browser`}
                    >
                      <div
                        className="h-full rounded-full bg-ok transition-[width] duration-500"
                        style={{ width: `${Math.min(100, Math.max(0, choice.fraction * 100))}%` }}
                      />
                    </div>
                    {personal.ready ? (
                      <p className="mt-2 text-xs text-ink-soft">
                        Watched{" "}
                        <span className="font-mono tabular-nums text-ink">
                          {formatPlaybackClock(choice.watched)}
                        </span>{" "}
                        of {formatPlaybackClock(choice.entry.durationSeconds)} ·{" "}
                        {Math.round(choice.fraction * 100)}% · saved in this browser
                        {choice.started ? (
                          <>
                            {" · reached "}
                            <span className="font-mono tabular-nums text-ink">
                              {formatPlaybackClock(choice.seconds)}
                            </span>
                          </>
                        ) : null}
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-ink-faint">
                        Reading this browser&rsquo;s saved progress…
                      </p>
                    )}
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <Link href={primaryHref} className={PRIMARY_ACTION}>
                      <Icon name="play" size={15} />
                      {choice.started ? "Resume where you stopped" : "Start this lesson"}
                    </Link>
                    <Link href="/learn?section=materials" className={SECONDARY_ACTION}>
                      Materials
                    </Link>
                  </div>

                  {personal.ready && practiceParts.length > 0 && (
                    <p className="mt-3 text-[11px] leading-5 text-ink-faint">
                      {practiceParts.join(" and ")} saved in this browser. Open Notes in the
                      studio to read {noteCount + bookmarkCount === 1 ? "it" : "them"}.
                    </p>
                  )}
                </>
              )}
            </Panel>
          </div>
        </section>

        {storeError && (
          <section className="mx-auto w-full max-w-[1200px] px-4 pb-4 sm:px-6">
            <div className="rounded-panel border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">
              <p className="font-semibold">The evidence store could not be read</p>
              <p className="mt-0.5 text-xs leading-5 text-ink-soft">{storeError}</p>
            </div>
          </section>
        )}

        {/* ---------------- How it works ---------------- */}
        <section id="how-it-works" className="scroll-mt-20 border-y border-line bg-surface-sunken/60">
          <div className="mx-auto w-full max-w-[1200px] px-4 py-14 sm:px-6 lg:py-16">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand">
              The learning loop
            </p>
            <h2 className="mt-2 max-w-2xl text-balance text-[26px] font-semibold leading-9 tracking-[-0.02em] text-ink sm:text-[32px] sm:leading-10">
              Four steps, and a boundary you can check
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-ink-soft">
              What the assistant can use depends on how far the lesson has been
              followed and on which sources cover the question. Both are visible before
              you ask, and both are stated again in the refusal when they are not enough.
            </p>

            <ol className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {HOW_IT_WORKS.map((step, index) => (
                <li
                  key={step.title}
                  className="group rounded-panel border border-line bg-surface p-4 shadow-panel transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-brand-line"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-control border border-brand-line bg-brand-soft font-mono text-[13px] font-semibold text-brand-strong">
                    {index + 1}
                  </span>
                  <h3 className="mt-3 text-[15px] font-semibold leading-6 text-ink">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-xs leading-5 text-ink-soft">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---------------- Lessons ---------------- */}
        <section id="lessons" className="scroll-mt-20">
          <div className="mx-auto w-full max-w-[1200px] px-4 py-14 sm:px-6 lg:py-16">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="max-w-2xl">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand">
                  Lessons in this deployment
                </p>
                <h2 className="mt-2 text-balance text-[26px] font-semibold leading-9 tracking-[-0.02em] text-ink sm:text-[32px] sm:leading-10">
                  What is actually in the evidence store
                </h2>
                <p className="mt-3 text-sm leading-6 text-ink-soft">
                  {entries.length} course{entries.length === 1 ? "" : "s"} available right now.
                  Nothing is listed that the studio cannot open, and the synthetic sample is
                  labelled wherever it appears.
                </p>
              </div>
              <Pill tone="outline">
                <span className="font-mono tabular-nums">{entries.length}</span> catalogue entries
              </Pill>
            </div>

            <ul className="mt-8 grid gap-4 lg:grid-cols-2">
              {entries.map((entry) => {
                const record = personal.state.progress[entry.courseId] ?? null;
                const fraction = record
                  ? watchedFraction(record.watched, entry.durationSeconds)
                  : 0;
                return (
                  <li key={entry.courseId}>
                    <Panel className="flex h-full flex-col p-5">
                      <div className="flex items-start justify-between gap-3">
                        <span className="flex h-10 w-10 items-center justify-center rounded-control border border-line bg-surface-muted text-brand">
                          <Icon name={entry.kind === "recording" ? "video" : "layers"} size={17} />
                        </span>
                        <span className="flex flex-wrap justify-end gap-1.5">
                          <Pill tone={entry.kind === "recording" ? "brand" : "neutral"}>
                            {entry.kind === "recording" ? "Lesson recording" : "Sample course"}
                          </Pill>
                          {entry.synthetic && <Pill tone="warn">synthetic</Pill>}
                        </span>
                      </div>

                      <h3 className="mt-3.5 text-[17px] font-semibold leading-7 tracking-[-0.01em] text-ink">
                        {entry.title}
                      </h3>

                      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
                        <span className="font-mono tabular-nums">
                          {formatPlaybackClock(entry.durationSeconds)}
                        </span>
                        <span aria-hidden="true" className="text-line-strong">·</span>
                        <span>
                          {entry.kind === "recording"
                            ? LESSON_VIDEO_EVIDENCE === "indexed"
                              ? "captions ingested as timestamped evidence"
                              : "captions not ingested"
                            : "synthetic corpus for the eligibility path"}
                        </span>
                      </p>

                      {personal.ready && record ? (
                        <div className="mt-4">
                          <div className="h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                            <div
                              className="h-full rounded-full bg-ok"
                              style={{ width: `${Math.round(fraction * 100)}%` }}
                            />
                          </div>
                          <p className="mt-1.5 text-[11px] text-ink-faint">
                            {Math.round(fraction * 100)}% watched in this browser · reached{" "}
                            <span className="font-mono tabular-nums text-ink-soft">
                              {formatPlaybackClock(record.furthestSeconds)}
                            </span>
                          </p>
                        </div>
                      ) : (
                        <p className="mt-4 text-[11px] text-ink-faint">
                          {personal.ready
                            ? "No playback recorded in this browser yet."
                            : "Reading this browser's saved progress…"}
                        </p>
                      )}

                      <div className="mt-5 flex flex-wrap items-center gap-2">
                        <Link href={lessonHref(entry)} className={SECONDARY_ACTION}>
                          <Icon name="arrow" size={14} />
                          {entry.kind === "recording" ? "Open the lesson" : "Open the sample"}
                        </Link>
                        <span className="text-[11px] text-ink-faint">
                          course{" "}
                          <span className="font-mono">{entry.courseId.slice(0, 8)}</span>
                        </span>
                      </div>
                    </Panel>
                  </li>
                );
              })}

              {entries.length < 3 && (
                <li className="lg:col-span-2">
                  <div className="rounded-panel border border-dashed border-line px-5 py-4 text-xs leading-5 text-ink-faint">
                    <p className="font-semibold text-ink-soft">
                      This is a two-course prototype, not a library
                    </p>
                    <p className="mt-1">
                      The catalogue above is the whole of it: the ingested lesson recording
                      and the labelled synthetic sample used to exercise the eligibility and
                      refusal path. No invented courses are shown to fill the space.
                    </p>
                  </div>
                </li>
              )}
            </ul>
          </div>
        </section>

        {/* ---------------- Capabilities ---------------- */}
        <section
          id="capabilities"
          className="scroll-mt-20 border-y border-line bg-surface-sunken/60"
        >
          <div className="mx-auto w-full max-w-[1200px] px-4 py-14 sm:px-6 lg:py-16">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand">
              What you can do here
            </p>
            <h2 className="mt-2 max-w-2xl text-balance text-[26px] font-semibold leading-9 tracking-[-0.02em] text-ink sm:text-[32px] sm:leading-10">
              Six surfaces, each saying what it is based on
            </h2>

            <ul className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {capabilities.map((capability) => (
                <li
                  key={capability.title}
                  className="rounded-panel border border-line bg-surface p-5 shadow-panel transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-brand-line"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-control border border-line bg-surface-muted text-brand">
                    <Icon name={capability.icon} size={16} />
                  </span>
                  <h3 className="mt-3 text-[15px] font-semibold leading-6 text-ink">
                    {capability.title}
                  </h3>
                  <p className="mt-1.5 text-xs leading-5 text-ink-soft">{capability.body}</p>
                  <p className="mt-3 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 rounded-full ${
                        capability.availability === "available"
                          ? "bg-ok"
                          : capability.availability === "configured"
                            ? "bg-ok"
                            : "bg-warn"
                      }`}
                    />
                    <span
                      className={
                        capability.availability === "not-configured" ? "text-warn" : "text-ink-faint"
                      }
                    >
                      {capability.availabilityNote}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------------- Limits ---------------- */}
        <section className="mx-auto w-full max-w-[1200px] px-4 py-14 sm:px-6 lg:py-16">
          <div className="rounded-panel border border-line bg-surface p-6 shadow-panel sm:p-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand">
              What this build does not do
            </p>
            <h2 className="mt-2 text-balance text-[24px] font-semibold leading-8 tracking-[-0.02em] text-ink sm:text-[28px] sm:leading-9">
              Stated here rather than discovered later
            </h2>
            <div className="mt-6 grid gap-5 text-sm leading-6 text-ink-soft sm:grid-cols-3">
              <div>
                <p className="font-semibold text-ink">No accounts, no sync</p>
                <p className="mt-1">
                  Bookmarks, notes and progress are stored by this browser. Clearing site
                  data removes them, and another device starts empty.
                </p>
              </div>
              <div>
                <p className="font-semibold text-ink">No instructor console</p>
                <p className="mt-1">
                  Material awaiting review is invisible to retrieval and can only be
                  approved from the command line, so there is nothing here that could
                  change what every learner may cite.
                </p>
              </div>
              <div>
                <p className="font-semibold text-ink">No completion score</p>
                <p className="mt-1">
                  Watched time is reported; a grade, a streak or a completion percentage
                  is not, because none of them would be measured from anything real.
                </p>
              </div>
            </div>
            <p className="mt-6 border-t border-line pt-4 text-xs leading-5 text-ink-faint">
              Evidence source:{" "}
              <span className="font-medium text-ink-soft">
                {evidenceSource === "supabase" ? "Supabase database" : "labelled sample fixture"}
              </span>
              . {evidenceReason} This page makes no model call.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-surface-sunken/70">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-start justify-between gap-6 px-4 py-8 sm:px-6">
          <div className="max-w-sm">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink">
              <span
                aria-hidden="true"
                className="flex h-7 w-7 items-center justify-center rounded-control bg-[linear-gradient(140deg,var(--color-brand),#9d7bff)] text-xs font-bold text-ink-inverse"
              >
                H
              </span>
              Horizon
            </p>
            <p className="mt-2 text-xs leading-5 text-ink-faint">
              Understand a lesson in context, explore the evidence behind an answer, and
              learn at your own pace. Built as a working prototype: what it can do is
              stated on the screen where it does it.
            </p>
          </div>

          <nav aria-label="Studio" className="min-w-[10rem]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Studio
            </p>
            {/* `block py-1` on each link gives a 24px tap target rather than a
                16px text run, which is the WCAG 2.2 minimum. */}
            <ul className="mt-1.5 text-xs">
              {[
                { href: "/learn", label: "Learn" },
                { href: "/learn?section=materials", label: "Materials" },
                { href: "/learn?section=notes", label: "Notes and bookmarks" },
                { href: "/learn?section=progress", label: "Progress" },
                { href: "/learn?section=status", label: "System status" },
              ].map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="block py-1 text-ink-soft hover:text-ink"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-[10rem]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              On this page
            </p>
            <ul className="mt-1.5 text-xs">
              {[
                { href: "#how-it-works", label: "How it works" },
                { href: "#lessons", label: "Lessons" },
                { href: "#capabilities", label: "Capabilities" },
                { href: "/api/v1/health", label: "Health endpoint" },
              ].map((item) => (
                <li key={item.href}>
                  <a href={item.href} className="block py-1 text-ink-soft hover:text-ink">
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="border-t border-line px-4 py-4 text-center text-[11px] text-ink-faint sm:px-6">
          Horizon prototype · evidence is filtered before it reaches the model · refusals
          are reported as refusals
        </div>
      </footer>
    </div>
  );
}
