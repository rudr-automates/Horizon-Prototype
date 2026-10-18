"use client";

/**
 * The application shell.
 *
 * A rail on desktop, a horizontal strip on mobile. Every destination here is a
 * surface that exists: there is no disabled "Settings", no placeholder "Course
 * catalog" and no instructor console, because a nav item that leads nowhere
 * teaches the wrong thing about what the product can do.
 *
 * The lesson identity lives in the rail because the whole product is
 * position-relative: "which lesson am I asking about" is not a detail to be
 * inferred from the page body.
 */
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

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-brand focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>

      {/* ---------------- Desktop rail ---------------- */}
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-surface lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-control bg-brand text-base font-bold text-white"
          >
            H
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-semibold leading-5 tracking-tight text-ink">
              Horizon
            </p>
            <p className="truncate text-[11px] text-ink-faint">
              Learning studio
            </p>
          </div>
        </div>

        <nav aria-label="Sections" className="mt-1 px-3">
          <ul className="space-y-0.5">
            {NAV_DESTINATIONS.map((item) => {
              const selected = item.id === active;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate(item.id)}
                    aria-current={selected ? "page" : undefined}
                    className={`group flex w-full items-start gap-3 rounded-control px-3 py-2 text-left transition-colors ${
                      selected
                        ? "bg-brand-soft text-brand-strong"
                        : "text-ink-soft hover:bg-surface-sunken hover:text-ink"
                    }`}
                  >
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
                        className={`block text-[11px] leading-4 ${selected ? "text-brand-strong" : "text-ink-faint"}`}
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
          <div className="rounded-control border border-line bg-surface-muted p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
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
                  className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint"
                >
                  Switch lesson
                </label>
                <select
                  id="lesson-switcher"
                  value={activeLessonId}
                  onChange={(event) => onSelectLesson(event.target.value)}
                  className="mt-1 w-full rounded-control border border-line-strong bg-surface px-2 py-1.5 text-xs font-medium text-ink"
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
            className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-left hover:bg-surface-sunken"
            title={statusDetail}
          >
            <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
            <span className="text-[11px] font-medium text-ink-soft">{statusLabel}</span>
          </button>
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-col">
        {/* ---------------- Mobile header ---------------- */}
        <header className="sticky top-0 z-30 border-b border-line bg-surface lg:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-brand text-sm font-bold text-white"
              >
                H
              </span>
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
          {/* Five destinations, five equal columns: no horizontal scroll and no
              destination hidden off the edge of a phone. */}
          <nav aria-label="Sections" className="px-2 pb-2">
            <ul className="grid grid-cols-5 gap-1">
              {NAV_DESTINATIONS.map((item) => {
                const selected = item.id === active;
                const shortLabel = item.id === "status" ? "Status" : item.label;
                return (
                  <li key={item.id} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => onNavigate(item.id)}
                      aria-current={selected ? "page" : undefined}
                      className={`flex w-full flex-col items-center gap-0.5 rounded-control px-1 py-1.5 text-[10px] font-semibold ${
                        selected
                          ? "bg-brand-soft text-brand-strong"
                          : "text-ink-soft hover:bg-surface-sunken"
                      }`}
                    >
                      <Icon name={item.icon} size={15} />
                      <span className="truncate">{shortLabel}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </header>

        {/* ---------------- Desktop top bar ---------------- */}
        <div className="hidden items-center justify-between gap-4 border-b border-line bg-surface px-6 py-2.5 lg:flex xl:px-8">
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-ink-faint">
            <span className="font-medium text-ink-soft">Horizon</span>
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
            <button
              type="button"
              onClick={() => onNavigate("status")}
              className="rounded-control border border-line px-2.5 py-1 text-[11px] font-semibold text-ink-soft hover:border-line-strong hover:text-ink"
            >
              Status
            </button>
          </div>
        </div>

        <main id="main-content" className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-5 sm:px-6 lg:py-7 xl:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
