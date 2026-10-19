import { z } from "zod";
import {
  MAX_BOOKMARKS,
  MAX_NOTES,
  MAX_RANGES,
  bookmarkSchema,
  emptyPersonalState,
  noteSchema,
  parsePersonalState,
  watchedRangeSchema,
  type PersonalState,
} from "@/lib/personal/local-store";

const uuid = z.uuid();
const bookmark = bookmarkSchema.extend({ courseId: uuid }).strict();
const note = noteSchema.extend({ courseId: uuid }).strict();
const progressMerge = z.object({
  type: z.literal("progress.merge"),
  courseId: uuid,
  furthestSeconds: z.number().min(0).max(86_400),
  watched: z.array(watchedRangeSchema).max(100),
}).strict();

const syncSchema = z.object({
  type: z.literal("sync"),
  bookmarks: z.array(bookmark).max(25).default([]),
  notes: z.array(note).max(5).default([]),
  deletedBookmarkIds: z.array(z.string().min(1).max(80)).max(25).default([]),
  deletedNoteIds: z.array(z.string().min(1).max(80)).max(25).default([]),
}).strict();

export const learnerMutationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("profile.save"), displayName: z.string().trim().max(80) }).strict(),
  z.object({ type: z.literal("bookmark.save"), item: bookmark }).strict(),
  z.object({ type: z.literal("bookmark.delete"), id: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal("note.save"), item: note }).strict(),
  z.object({ type: z.literal("note.delete"), id: z.string().min(1).max(80) }).strict(),
  progressMerge,
  syncSchema,
]);

type RemoteBookmark = {
  id: unknown;
  course_id: unknown;
  position_seconds: unknown;
  title: unknown;
  created_at: unknown;
};
type RemoteNote = {
  id: unknown;
  course_id: unknown;
  position_seconds: unknown;
  body: unknown;
  updated_at: unknown;
};
type RemoteProgress = {
  course_id: unknown;
  furthest_seconds: unknown;
  watched_ranges: unknown;
  updated_at: unknown;
};

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Validate data returned by PostgREST before it reaches the browser store. */
export function personalStateFromRemote(input: {
  bookmarks: unknown;
  notes: unknown;
  progress: unknown;
}): PersonalState {
  const remoteBookmarks = rows(input.bookmarks).map((value) => {
    if (typeof value !== "object" || value === null) return null;
    const row = value as RemoteBookmark;
    return {
      id: row.id,
      courseId: row.course_id,
      seconds: Number(row.position_seconds),
      title: row.title,
      createdAt: row.created_at,
    };
  }).filter((value) => value !== null);

  const remoteNotes = rows(input.notes).map((value) => {
    if (typeof value !== "object" || value === null) return null;
    const row = value as RemoteNote;
    return {
      id: row.id,
      courseId: row.course_id,
      seconds: Number(row.position_seconds),
      body: row.body,
      updatedAt: row.updated_at,
    };
  }).filter((value) => value !== null);

  const remoteProgress: Record<string, unknown> = {};
  for (const value of rows(input.progress)) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as RemoteProgress;
    if (typeof row.course_id !== "string") continue;
    const watched = rows(row.watched_ranges)
      .map((range) => watchedRangeSchema.safeParse(range))
      .filter((result) => result.success)
      .map((result) => result.data)
      .slice(-MAX_RANGES);
    remoteProgress[row.course_id] = {
      courseId: row.course_id,
      furthestSeconds: Number(row.furthest_seconds),
      watched,
      updatedAt: row.updated_at,
    };
  }

  return parsePersonalState(JSON.stringify({
    version: emptyPersonalState().version,
    bookmarks: remoteBookmarks.slice(-MAX_BOOKMARKS),
    notes: remoteNotes.slice(-MAX_NOTES),
    progress: remoteProgress,
  }));
}

export function mergePersonalStates(local: PersonalState, remote: PersonalState): PersonalState {
  const bookmarks = new Map(remote.bookmarks.map((item) => [item.id, item]));
  for (const item of local.bookmarks) {
    const current = bookmarks.get(item.id);
    if (!current || item.createdAt > current.createdAt) bookmarks.set(item.id, item);
  }

  const notes = new Map(remote.notes.map((item) => [item.id, item]));
  for (const item of local.notes) {
    const current = notes.get(item.id);
    if (!current || item.updatedAt > current.updatedAt) notes.set(item.id, item);
  }

  const mergedProgress: PersonalState["progress"] = { ...remote.progress };
  for (const item of Object.values(local.progress)) {
    const current = mergedProgress[item.courseId];
    const watched = current
      ? [...current.watched, ...item.watched]
      : item.watched;
    mergedProgress[item.courseId] = {
      courseId: item.courseId,
      furthestSeconds: Math.max(current?.furthestSeconds ?? 0, item.furthestSeconds),
      watched: current ? mergeRanges(watched) : item.watched,
      updatedAt: item.updatedAt > (current?.updatedAt ?? "") ? item.updatedAt : (current?.updatedAt ?? item.updatedAt),
    };
  }

  return {
    version: local.version,
    bookmarks: [...bookmarks.values()].slice(-MAX_BOOKMARKS),
    notes: [...notes.values()].slice(-MAX_NOTES),
    progress: mergedProgress,
  };
}

export function stateDelta(local: PersonalState, remote: PersonalState): {
  bookmarks: PersonalState["bookmarks"];
  notes: PersonalState["notes"];
  deletedBookmarkIds: string[];
  deletedNoteIds: string[];
  progress: PersonalState["progress"];
} {
  const remoteBookmarks = new Map(remote.bookmarks.map((item) => [item.id, item]));
  const remoteNotes = new Map(remote.notes.map((item) => [item.id, item]));
  const bookmarks = local.bookmarks.filter((item) => {
    const other = remoteBookmarks.get(item.id);
    return !other || item.createdAt > other.createdAt;
  });
  const notes = local.notes.filter((item) => {
    const other = remoteNotes.get(item.id);
    return !other || item.updatedAt > other.updatedAt;
  });
  const localBookmarkIds = new Set(local.bookmarks.map((item) => item.id));
  const localNoteIds = new Set(local.notes.map((item) => item.id));
  const deletedBookmarkIds = remote.bookmarks.filter((item) => !localBookmarkIds.has(item.id)).map((item) => item.id);
  const deletedNoteIds = remote.notes.filter((item) => !localNoteIds.has(item.id)).map((item) => item.id);
  const progress = Object.fromEntries(Object.entries(local.progress).filter(([courseId, item]) => {
    const other = remote.progress[courseId];
    return !other || item.updatedAt > other.updatedAt ||
      item.furthestSeconds > other.furthestSeconds ||
      JSON.stringify(item.watched) !== JSON.stringify(other.watched);
  }));
  return { bookmarks, notes, deletedBookmarkIds, deletedNoteIds, progress };
}

function mergeRanges(ranges: PersonalState["progress"][string]["watched"]) {
  const sorted = ranges.map((range) => ({ ...range })).sort((a, b) => a.start - b.start);
  const merged: typeof sorted = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 0.25) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged.slice(-MAX_RANGES);
}
