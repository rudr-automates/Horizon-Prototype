/**
 * Which lesson the home page offers to continue, and where it links.
 *
 * WHY THIS IS PURE AND SEPARATE
 *   The home page makes one claim that must not be wrong: "continue this lesson,
 *   from this position". Everything that decides it — which course is the
 *   recording, which one is the labelled sample, which has the newest real
 *   progress, and what the link looks like — is computed here from explicit
 *   values, so it can be tested without a browser, a database or a player.
 *
 * WHAT IT REFUSES TO DO
 *   It never invents progress, never treats a seek as watching (that rule lives in
 *   `local-store.ts` and is applied there), and never presents the synthetic
 *   sample as the recorded lesson. When there is no history at all it returns the
 *   recording as a NOT-STARTED choice, which is a true statement about a first
 *   visit, rather than a fabricated "42% complete".
 */
import type { CourseSummary } from "@/lib/contracts/question";
import {
  watchedFraction,
  watchedSeconds,
  type CourseProgress,
} from "@/lib/personal/local-store";

export type LessonKind = "recording" | "sample";

export interface LessonEntry {
  courseId: string;
  title: string;
  durationSeconds: number;
  kind: LessonKind;
  /**
   * True only when the catalogue itself says the content is synthetic, or when
   * the course is not the ingested recording. The home page labels it in the
   * catalogue and never implies instructor-provided evidence.
   */
  synthetic: boolean;
}

/**
 * Which lesson a catalogue row is.
 *
 * The recording is identified by the id the transcript ingest derives from the
 * video's own id, so this is a fact about the database rather than "whichever row
 * came back first". Anything else is a secondary course; the sample fixture is
 * one, and it is marked synthetic either by its own `demoContent` flag or by its
 * own title.
 */
export function classifyCourse(course: CourseSummary, videoCourseId: string | null): LessonKind {
  return course.courseId === videoCourseId ? "recording" : "sample";
}

export function isSyntheticCourse(course: CourseSummary, videoCourseId: string | null): boolean {
  if (course.courseId === videoCourseId) return false;
  return course.demoContent || /synthetic/i.test(course.title);
}

export function buildLessonEntries(
  courses: CourseSummary[],
  videoCourseId: string | null,
): LessonEntry[] {
  return courses.map((course) => ({
    courseId: course.courseId,
    title: course.title,
    durationSeconds: course.durationSeconds,
    kind: classifyCourse(course, videoCourseId),
    synthetic: isSyntheticCourse(course, videoCourseId),
  }));
}

export interface ContinueChoice {
  entry: LessonEntry;
  /** Furthest position this browser reached. 0 means nothing was started. */
  seconds: number;
  /** Time the player reported as actually playing. */
  watched: number;
  /** Watched coverage of the whole lesson, 0–1. */
  fraction: number;
  started: boolean;
}

export type ProgressByCourse = Record<string, CourseProgress>;

/**
 * The course to continue.
 *
 * Preference order is stated rather than emergent:
 *   1. The lesson with the most recently updated progress, so "continue" follows
 *      what the learner actually did last, not what the page loaded first.
 *   2. Otherwise the recording, as a not-started choice.
 *   3. Otherwise the first lesson the catalogue returned, or null when it is empty.
 */
export function chooseContinueLesson(
  entries: LessonEntry[],
  progress: ProgressByCourse,
): ContinueChoice | null {
  if (entries.length === 0) return null;

  let best: { entry: LessonEntry; record: CourseProgress } | null = null;
  for (const entry of entries) {
    const record = progress[entry.courseId];
    if (!record) continue;
    if (record.furthestSeconds <= 0 && record.watched.length === 0) continue;
    if (best === null || record.updatedAt > best.record.updatedAt) {
      best = { entry, record };
    }
  }

  const chosen = best?.entry ?? entries.find((entry) => entry.kind === "recording") ?? entries[0];
  const record = progress[chosen.courseId] ?? null;
  const ranges = record?.watched ?? [];
  return {
    entry: chosen,
    seconds: record?.furthestSeconds ?? 0,
    watched: watchedSeconds(ranges),
    fraction: watchedFraction(ranges, chosen.durationSeconds),
    started: best !== null && best.entry.courseId === chosen.courseId,
  };
}

/**
 * The studio URL for a lesson.
 *
 * The position is carried only when there is a real one to resume from, and the
 * studio applies it once the player reports a clock — it never claims playback
 * started from the link alone.
 */
export function lessonHref(entry: Pick<LessonEntry, "kind">, seconds = 0): string {
  const query = new URLSearchParams();
  query.set("lesson", entry.kind === "recording" ? "recording" : "sample");
  if (seconds > 0) query.set("start", String(Math.floor(seconds)));
  return `/learn?${query.toString()}`;
}

/** The dev-facing note the catalogue shows when the store returned nothing. */
export const EMPTY_CATALOGUE_NOTE =
  "This deployment's evidence store returned no course, so there is no lesson to open yet.";
