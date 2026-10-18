import { z } from "zod";

/**
 * Personal learning data: bookmarks, notes and watched progress.
 *
 * WHY THIS IS LOCAL, AND SAYS SO
 *   Horizon has no authentication. Notes that claimed to sync would be a lie on
 *   the first reload of another device, so nothing here pretends otherwise: the
 *   state lives in one browser's `localStorage`, every panel that shows it says
 *   "saved in this browser", and there is no cross-user surface to get wrong.
 *
 * WHY THE LOGIC IS PURE
 *   Two things are worth testing and neither needs a DOM: that a stored document
 *   can be read back without trusting it, and that watched time accumulates
 *   honestly. Both live here as pure functions over an explicit state value; the
 *   hook in `use-personal-data.ts` only does storage and React state.
 *
 * HONEST PROGRESS
 *   Playback reports arrive roughly twice a second, but they also arrive after a
 *   seek, and a seek is not watching. A step larger than MAX_WATCH_STEP is
 *   therefore discarded rather than counted, so scrubbing to the end of a lesson
 *   cannot report it as watched. Ranges merge, so rewinding over old ground never
 *   inflates the total.
 */

export const PERSONAL_STATE_VERSION = 1;
export const PERSONAL_STATE_KEY = "horizon.personal.v1";
export const MAX_BOOKMARKS = 200;
export const MAX_NOTES = 500;
export const MAX_RANGES = 400;
/** Largest playback step treated as continuous watching, in seconds. */
export const MAX_WATCH_STEP = 5;

const isoDate = z.string().min(1).max(40);
const seconds = z.number().min(0).max(86_400);
const id = z.string().min(1).max(80);

export const bookmarkSchema = z.object({
  id,
  courseId: z.string().min(1).max(120),
  seconds,
  title: z.string().min(1).max(120),
  createdAt: isoDate,
});
export type Bookmark = z.infer<typeof bookmarkSchema>;

export const noteSchema = z.object({
  id,
  courseId: z.string().min(1).max(120),
  seconds,
  body: z.string().min(1).max(2000),
  updatedAt: isoDate,
});
export type Note = z.infer<typeof noteSchema>;

export const watchedRangeSchema = z.object({
  start: seconds,
  end: seconds,
});
export type WatchedRange = z.infer<typeof watchedRangeSchema>;

export const courseProgressSchema = z.object({
  courseId: z.string().min(1).max(120),
  furthestSeconds: seconds,
  watched: z.array(watchedRangeSchema).max(MAX_RANGES),
  updatedAt: isoDate,
});
export type CourseProgress = z.infer<typeof courseProgressSchema>;

export const personalStateSchema = z.object({
  version: z.literal(PERSONAL_STATE_VERSION),
  bookmarks: z.array(bookmarkSchema).max(MAX_BOOKMARKS),
  notes: z.array(noteSchema).max(MAX_NOTES),
  progress: z.record(z.string(), courseProgressSchema),
});
export type PersonalState = z.infer<typeof personalStateSchema>;

export function emptyPersonalState(): PersonalState {
  return { version: PERSONAL_STATE_VERSION, bookmarks: [], notes: [], progress: {} };
}

/**
 * Read persisted state without trusting it.
 *
 * A stored document can be malformed, from an older version, or edited by hand.
 * The rule is the same one the rest of the app follows for model output: validate,
 * and fall back to an empty state rather than to half-parsed data. Entries are
 * individually validated so one corrupt bookmark cannot erase twenty good ones.
 */
export function parsePersonalState(raw: string | null): PersonalState {
  if (raw === null || raw.trim() === "") return emptyPersonalState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyPersonalState();
  }

  if (typeof parsed !== "object" || parsed === null) return emptyPersonalState();
  const record = parsed as Record<string, unknown>;
  if (record.version !== PERSONAL_STATE_VERSION) return emptyPersonalState();

  const bookmarks = asArray(record.bookmarks)
    .map((entry) => bookmarkSchema.safeParse(entry))
    .flatMap((result) => (result.success ? [result.data] : []))
    .slice(-MAX_BOOKMARKS);

  const notes = asArray(record.notes)
    .map((entry) => noteSchema.safeParse(entry))
    .flatMap((result) => (result.success ? [result.data] : []))
    .slice(-MAX_NOTES);

  const progress: Record<string, CourseProgress> = {};
  const rawProgress = record.progress;
  if (typeof rawProgress === "object" && rawProgress !== null) {
    for (const [courseId, value] of Object.entries(rawProgress)) {
      const result = courseProgressSchema.safeParse(value);
      if (result.success) progress[courseId] = result.data;
    }
  }

  return { version: PERSONAL_STATE_VERSION, bookmarks, notes, progress };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/* ------------------------------------------------------------------ *
 * Bookmarks
 * ------------------------------------------------------------------ */

export function addBookmark(
  state: PersonalState,
  input: { id: string; courseId: string; seconds: number; title: string; now: string },
): PersonalState {
  const title = input.title.trim().slice(0, 120);
  if (title === "") return state;
  const bookmark: Bookmark = {
    id: input.id,
    courseId: input.courseId,
    seconds: Math.max(0, Math.floor(input.seconds)),
    title,
    createdAt: input.now,
  };
  return {
    ...state,
    bookmarks: [...state.bookmarks, bookmark].slice(-MAX_BOOKMARKS),
  };
}

export function renameBookmark(
  state: PersonalState,
  bookmarkId: string,
  title: string,
): PersonalState {
  const next = title.trim().slice(0, 120);
  if (next === "") return state;
  return {
    ...state,
    bookmarks: state.bookmarks.map((bookmark) =>
      bookmark.id === bookmarkId ? { ...bookmark, title: next } : bookmark,
    ),
  };
}

export function removeBookmark(state: PersonalState, bookmarkId: string): PersonalState {
  return {
    ...state,
    bookmarks: state.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId),
  };
}

/* ------------------------------------------------------------------ *
 * Notes
 * ------------------------------------------------------------------ */

export function addNote(
  state: PersonalState,
  input: { id: string; courseId: string; seconds: number; body: string; now: string },
): PersonalState {
  const body = input.body.trim().slice(0, 2000);
  if (body === "") return state;
  const note: Note = {
    id: input.id,
    courseId: input.courseId,
    seconds: Math.max(0, Math.floor(input.seconds)),
    body,
    updatedAt: input.now,
  };
  return { ...state, notes: [...state.notes, note].slice(-MAX_NOTES) };
}

export function updateNote(
  state: PersonalState,
  noteId: string,
  body: string,
  now: string,
): PersonalState {
  const next = body.trim().slice(0, 2000);
  if (next === "") return state;
  return {
    ...state,
    notes: state.notes.map((note) =>
      note.id === noteId ? { ...note, body: next, updatedAt: now } : note,
    ),
  };
}

export function removeNote(state: PersonalState, noteId: string): PersonalState {
  return { ...state, notes: state.notes.filter((note) => note.id !== noteId) };
}

/* ------------------------------------------------------------------ *
 * Watched progress
 * ------------------------------------------------------------------ */

/**
 * Merge overlapping or touching ranges, so replaying a passage twice counts once.
 * Adjacent ranges (within 0.25s) merge too: the clock is polled, and a fraction
 * of a second between reports must not fragment the same minute of watching.
 */
export function mergeRanges(ranges: WatchedRange[]): WatchedRange[] {
  const clean = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, range.end)),
      end: Math.max(0, Math.max(range.start, range.end)),
    }))
    .sort((a, b) => a.start - b.start);

  const merged: WatchedRange[] = [];
  for (const range of clean) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end + 0.25) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.slice(-MAX_RANGES);
}

export function watchedSeconds(ranges: WatchedRange[]): number {
  return Math.round(
    mergeRanges(ranges).reduce((total, range) => total + (range.end - range.start), 0),
  );
}

export function watchedFraction(ranges: WatchedRange[], durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(1, watchedSeconds(ranges) / durationSeconds);
}

export function progressForCourse(
  state: PersonalState,
  courseId: string,
): CourseProgress | null {
  return state.progress[courseId] ?? null;
}

/**
 * Account for one playback report.
 *
 * A backwards step, a zero step and a step larger than MAX_WATCH_STEP are all
 * ignored: the first two carry no information, and the third is a seek rather
 * than watching. The furthest position still advances on a seek, because it is a
 * resume point rather than a claim of coverage.
 */
export function recordWatched(
  state: PersonalState,
  input: { courseId: string; fromSeconds: number; toSeconds: number; now: string },
): PersonalState {
  const { courseId, fromSeconds, toSeconds, now } = input;
  const delta = toSeconds - fromSeconds;
  const previous =
    state.progress[courseId] ?? { courseId, furthestSeconds: 0, watched: [], updatedAt: now };

  let watched = previous.watched;
  if (delta > 0 && delta <= MAX_WATCH_STEP) {
    watched = mergeRanges([...watched, { start: fromSeconds, end: toSeconds }]);
  }

  const furthestSeconds = Math.max(previous.furthestSeconds, Math.floor(toSeconds));
  if (watched === previous.watched && furthestSeconds === previous.furthestSeconds) {
    return state;
  }

  return {
    ...state,
    progress: {
      ...state.progress,
      [courseId]: { courseId, furthestSeconds, watched, updatedAt: now },
    },
  };
}

/**
 * The buckets a progress strip draws.
 *
 * Pure and counted rather than estimated: `covered` is derived from the merged
 * ranges intersect each bucket, never from the furthest position.
 */
export function progressBuckets(
  ranges: WatchedRange[],
  durationSeconds: number,
  bucketCount = 48,
): number[] {
  if (durationSeconds <= 0 || bucketCount <= 0) return [];
  const merged = mergeRanges(ranges);
  const size = durationSeconds / bucketCount;
  return Array.from({ length: bucketCount }, (_, index) => {
    const start = index * size;
    const end = start + size;
    return merged.reduce((sum, range) => {
      const overlap = Math.max(0, Math.min(end, range.end) - Math.max(start, range.start));
      return sum + overlap;
    }, 0) / size;
  });
}
