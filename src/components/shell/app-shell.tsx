"use client";

/**
 * The application shell.
 *
 * A glass rail on desktop, a glass header with a six-item strip on mobile. Every
 * destination here is a surface that exists: there is no disabled "Settings", no
 * placeholder "Course catalog" and no instructor console, because a nav item that
 * leads nowhere teaches the wrong thing about what the product can do. Home is the
 * sixth item and the brand mark, so the studio always has a way back to the
 * lessons index.
 *
 * The lesson identity lives in the rail because the whole product is
 * position-relative: "which lesson am I asking about" is not a detail to be
 * inferred from the page body.
 *
 * WHY GLASS IS SAFE HERE
 *   The rail and the top bars carry labels and icons only. Every surface a learner
 *   reads for minutes — transcript, citations, answers, resource text, forms —
 *   stays opaque, which is the rule stated in globals.css.
 */
import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/icons";
import { Pill } from "@/components/ui/primitives";

export type SectionId = "learn" | "materials" | "notes" | "progress" | "status";

export interface NavDestination {
  id: SectionId;
  label: string;
  icon: IconName;
  description: string;
}

export const NAV_DESTINATIONS: NavDestination[] = [
  {
    id: "learn",
    label: "Learn",
    icon: "learn",
    description: "Lesson, transcript and assistant",
  },
  {
    id: "materials",
    label: "Materials",
    icon: "materials",
    description: "Course sources and their policy",
  },
  {
    id: "notes",
    label: "Notes",
    icon: "notes",
    description: "Bookmarks and notes in this browser",
  },
  {
    id: "progress",
    label: "Progress",
    icon: "progress",
    description: "What you have actually watched",
  },
  {
    id: "status",
    label: "System status",
    icon: "status",
    description: "Evidence, provider and budget state",
  },
];

export type ShellStatusTone = "ok" | "warn" | "unknown";

export interface LessonOption {
  id: string;
  label: string;
  disabled: boolean;
}

export function AppShell({
  active,
  onNavigate,
  courseTitle,
  courseDetail,
  lessonOptions,
  activeLessonId,
  onSelectLesson,
  statusTone,
  statusLabel,
  statusShortLabel,
  statusDetail,
  children,
}: {
  active: SectionId;
  onNavigate: (section: SectionId) => void;
  courseTitle: string;
  courseDetail: string;
  lessonOptions: LessonOption[];
  activeLessonId: string;
  onSelectLesson: (courseId: string) => void;
  statusTone: ShellStatusTone;
  statusLabel: string;
  /** A one-or-two-word form for narrow screens. */
  statusShortLabel: string;
  statusDetail: string;
  children: React.ReactNode;
}) {
  const activeDestination = NAV_DESTINATIONS.find((item) => item.id === active);

  const dot =
    statusTone === "ok"
      ? "bg-ok"
      : statusTone === "warn"
        ? "bg-warn"
        : "bg-ink-faint";

  const mobileLabel: Record<SectionId, string> = {
    learn: "Learn",
    materials: "Materials",
    notes: "Notes",
    progress: "Progress",
    status: "Status",
  };

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:border focus:border-brand bg-brand px-4 py-2 text-sm font-semibold text-ink-inverse"
      >
        Skip to content
      </a>

      {/* ---------------- Desktop rail ---------------- */}
      <aside className="glass sticky top-0 hidden h-screen flex-col border-r border-line lg:flex">
        <Link
          href="/"
          className="group flex items-center gap-2.5 px-5 py-5"
          aria-label="Horizon home"
        >
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-control bg-[linear-gradient(140deg,var(--color-brand),#9d7bff)] text-base font-bold text-ink-inverse shadow-[0_10px_24px_-12px_rgb(122_162_255/0.9)] transition-transform duration-200 group-hover:scale-[1.04]"
          >
            H
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold leading-5 tracking-tight text-ink">
              Horizon
            </span>
            <span className="block truncate text-[11px] text-ink-faint">
              Learning studio
            </span>
          </span>
        </Link>

        <nav aria-label="Sections" className="mt-1 px-3">
          <ul className="space-y-0.5">
            <li>
              <Link
                href="/"
                className="group flex w-full items-center gap-3 rounded-control px-3 py-2 text-ink-soft transition-colors duration-150 hover:bg-neutral-soft hover:text-ink"
              >
                <Icon name="home" size={17} className="text-ink-faint group-hover:text-ink-soft" />
                <span className="text-sm font-semibold leading-5">Home</span>
              </Link>
            </li>
            <li aria-hidden="true" className="py-1.5">
              <span className="block h-px w-full bg-line" />
            </li>
            {NAV_DESTINATIONS.map((item) => {
              const selected = item.id === active;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate(item.id)}
                    aria-current={selected ? "page" : undefined}
                    className={`group relative flex w-full items-start gap-3 rounded-control px-3 py-2 text-left transition-colors duration-150 ${
                      selected
                        ? "bg-brand-soft text-ink"
                        : "text-ink-soft hover:bg-neutral-soft hover:text-ink"
                    }`}
                  >
                    {selected && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand"
                      />
                    )}
                    <Icon
                      name={item.icon}
                      size={17}
                      className={`mt-0.5 ${selected ? "text-brand" : "text-ink-faint group-hover:text-ink-soft"}`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold leading-5">
                        {item.label}
                      </span>
                      <span
                        className={`block text-[11px] leading-4 ${selected ? "text-ink-soft" : "text-ink-faint"}`}
                      >
                        {item.description}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="mt-auto space-y-3 border-t border-line px-3 py-4">
          <div className="rounded-control border border-line bg-surface px-3 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Lesson
            </p>
            <p className="mt-1 text-[13px] font-semibold leading-5 text-ink">
              {courseTitle}
            </p>
            <p className="mt-0.5 text-[11px] leading-4 text-ink-faint">{courseDetail}</p>
            {lessonOptions.length > 1 && (
              <>
                <label
                  htmlFor="lesson-switcher"
                  className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint"
                >
                  Switch lesson
                </label>
                <select
                  id="lesson-switcher"
                  value={activeLessonId}
                  onChange={(event) => onSelectLesson(event.target.value)}
                  className="mt-1 w-full rounded-control border border-line-strong bg-surface-muted px-2 py-1.5 text-xs font-medium text-ink"
                >
                  {lessonOptions.map((option) => (
                    <option key={option.id} value={option.id} disabled={option.disabled}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => onNavigate("status")}
            className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-left transition-colors duration-150 hover:bg-neutral-soft"
            title={statusDetail}
          >
            <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
            <span className="text-[11px] font-medium text-ink-soft">{statusLabel}</span>
          </button>
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-col">
        {/* ---------------- Mobile header ---------------- */}
        <header className="glass-strong sticky top-0 z-30 border-b border-line lg:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Link
                href="/"
                aria-label="Horizon home"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-[linear-gradient(140deg,var(--color-brand),#9d7bff)] text-sm font-bold text-ink-inverse"
              >
                <span aria-hidden="true">H</span>
              </Link>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-5 text-ink">Horizon</p>
                {/* On a phone the lesson identity doubles as the switcher, so the
                    sample lesson is reachable without a rail. */}
                {lessonOptions.length > 1 ? (
                  <label className="flex items-center gap-1 text-[11px] leading-4 text-ink-faint">
                    <Icon name="switch" size={11} />
                    <span className="sr-only">Lesson</span>
                    <select
                      value={activeLessonId}
                      onChange={(event) => onSelectLesson(event.target.value)}
                      className="max-w-[11rem] truncate bg-transparent py-0 text-[11px] font-medium text-ink-soft"
                    >
                      {lessonOptions.map((option) => (
                        <option key={option.id} value={option.id} disabled={option.disabled}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="truncate text-[11px] leading-4 text-ink-faint">
                    {courseTitle}
                  </p>
                )}
              </div>
            </div>
            <Pill
              tone={statusTone === "ok" ? "ok" : statusTone === "warn" ? "warn" : "neutral"}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
              {statusShortLabel}
            </Pill>
          </div>
          {/* Six destinations, six equal columns: no horizontal scroll, and Home
              is never hidden off the edge of a phone. */}
          <nav aria-label="Sections" className="px-2 pb-2">
            <ul className="grid grid-cols-6 gap-0.5">
              <li className="min-w-0">
                <Link
                  href="/"
                  className="flex w-full flex-col items-center gap-0.5 rounded-control px-0.5 py-1.5 text-[10px] font-semibold text-ink-soft transition-colors duration-150 hover:bg-neutral-soft"
                >
                  <Icon name="home" size={15} />
                  <span className="truncate">Home</span>
                </Link>
              </li>
              {NAV_DESTINATIONS.map((item) => {
                const selected = item.id === active;
                return (
                  <li key={item.id} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => onNavigate(item.id)}
                      aria-current={selected ? "page" : undefined}
                      className={`flex w-full flex-col items-center gap-0.5 rounded-control px-0.5 py-1.5 text-[10px] font-semibold transition-colors duration-150 ${
                        selected
                          ? "bg-brand-soft text-brand-strong"
                          : "text-ink-soft hover:bg-neutral-soft"
                      }`}
                    >
                      <Icon name={item.icon} size={15} />
                      <span className="truncate">{mobileLabel[item.id]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </header>

        {/* ---------------- Desktop top bar ---------------- */}
        <div className="glass sticky top-0 z-30 hidden items-center justify-between gap-4 border-b border-line px-6 py-2.5 lg:flex xl:px-8">
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-ink-faint">
            <Link href="/" className="font-medium text-ink-soft hover:text-ink">
              Horizon
            </Link>
            <Icon name="chevron" size={12} />
            <span className="font-medium text-ink">{activeDestination?.label ?? "Learn"}</span>
            <span className="mx-1 text-line-strong">/</span>
            <span className="max-w-[28rem] truncate">{courseTitle}</span>
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-ink-soft">
              <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
              {statusLabel}
            </span>
            <Link
              href="/"
              className="rounded-control border border-line px-2.5 py-1 text-[11px] font-semibold text-ink-soft transition-colors duration-150 hover:border-line-strong hover:text-ink"
            >
              All lessons
            </Link>
          </div>
        </div>

        <main
          id="main-content"
          className="mx-auto w-full max-w-[1540px] flex-1 px-4 py-5 sm:px-6 lg:py-7 xl:px-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
