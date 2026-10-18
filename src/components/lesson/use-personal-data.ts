"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import {
  addBookmark,
  addNote,
  recordWatched,
  removeBookmark,
  removeNote,
  renameBookmark,
  updateNote,
} from "@/lib/personal/local-store";
import {
  getPersonalSnapshot,
  getPersonalWriteError,
  getServerPersonalSnapshot,
  getServerWriteError,
  subscribePersonal,
  updatePersonal,
} from "@/lib/personal/store";

let idCounter = 0;

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function subscribeAlways(): () => void {
  return () => undefined;
}

/**
 * Personal data for one browser, read through the external store.
 *
 * `ready` is false on the server and during hydration, true in the browser
 * afterwards. Panels use it to show a skeleton rather than "no bookmarks yet",
 * which would be a wrong statement for the one frame before storage is read.
 *
 * Playback reporting keeps the previous clock in a ref so a component re-rendering
 * for an unrelated reason cannot manufacture a large watched step out of two
 * identical reports.
 */
export function usePersonalData() {
  const state = useSyncExternalStore(
    subscribePersonal,
    getPersonalSnapshot,
    getServerPersonalSnapshot,
  );
  const storageError = useSyncExternalStore(
    subscribePersonal,
    getPersonalWriteError,
    getServerWriteError,
  );
  const ready = useSyncExternalStore(subscribeAlways, () => true, () => false);
  const lastReport = useRef<number | null>(null);

  const reportPlayback = useCallback((courseId: string, seconds: number) => {
    if (!Number.isFinite(seconds)) return;
    const previous = lastReport.current;
    lastReport.current = seconds;
    if (previous === null) return;
    updatePersonal((current) =>
      recordWatched(current, {
        courseId,
        fromSeconds: previous,
        toSeconds: seconds,
        now: new Date().toISOString(),
      }),
    );
  }, []);

  const resetPlaybackBaseline = useCallback(() => {
    lastReport.current = null;
  }, []);

  const actions = useMemo(
    () => ({
      addBookmarkAt(courseId: string, seconds: number, title: string) {
        updatePersonal((current) =>
          addBookmark(current, {
            id: newId("bm"),
            courseId,
            seconds,
            title,
            now: new Date().toISOString(),
          }),
        );
      },
      renameBookmark(bookmarkId: string, title: string) {
        updatePersonal((current) => renameBookmark(current, bookmarkId, title));
      },
      removeBookmark(bookmarkId: string) {
        updatePersonal((current) => removeBookmark(current, bookmarkId));
      },
      addNoteAt(courseId: string, seconds: number, body: string) {
        updatePersonal((current) =>
          addNote(current, {
            id: newId("note"),
            courseId,
            seconds,
            body,
            now: new Date().toISOString(),
          }),
        );
      },
      updateNote(noteId: string, body: string) {
        updatePersonal((current) =>
          updateNote(current, noteId, body, new Date().toISOString()),
        );
      },
      removeNote(noteId: string) {
        updatePersonal((current) => removeNote(current, noteId));
      },
    }),
    [],
  );

  return { state, ready, storageError, reportPlayback, resetPlaybackBaseline, actions };
}
