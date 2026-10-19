"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
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
  setPersonalNamespace,
  setPersonalSyncError,
  subscribePersonal,
  updatePersonal,
} from "@/lib/personal/store";
import { personalStateSchema } from "@/lib/personal/local-store";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { mergePersonalStates, stateDelta } from "@/lib/personal/remote-contract";

let idCounter = 0;
let remoteSyncEnabled = false;

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

function saveRemote(payload: unknown): void {
  if (!remoteSyncEnabled) return;
  void fetch("/api/v1/me/learning", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).then((response) => {
    if (!response.ok) throw new Error("Account sync unavailable");
    setPersonalSyncError(null);
  }).catch(() => {
    setPersonalSyncError("Account sync is unavailable. Your browser copy is saved locally.");
  });
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
  const syncReady = useRef(false);
  const lastRemote = useRef(state);

  useEffect(() => {
    let cancelled = false;
    syncReady.current = false;
    remoteSyncEnabled = false;
    async function bootstrap() {
      try {
        const client = createSupabaseBrowserClient();
        const { data, error } = await client.auth.getUser();
        if (cancelled) return;
        if (error || !data.user) {
          setPersonalNamespace(null);
          return;
        }
        setPersonalNamespace(data.user.id);
        const response = await fetch("/api/v1/me/learning", { cache: "no-store" });
        if (!response.ok) throw new Error("Account data unavailable");
        const payload: unknown = await response.json();
        if (cancelled || typeof payload !== "object" || payload === null) return;
        const record = payload as { ownerId?: unknown; state?: unknown };
        if (record.ownerId !== data.user.id) throw new Error("Account identity changed");
        const remote = personalStateSchema.safeParse(record.state);
        if (!remote.success) throw new Error("Account data invalid");
        const merged = mergePersonalStates(getPersonalSnapshot(), remote.data);
        lastRemote.current = remote.data;
        updatePersonal(() => merged);
        syncReady.current = true;
        remoteSyncEnabled = true;
        setPersonalSyncError(null);
      } catch {
        if (!cancelled) setPersonalSyncError("Account sync is unavailable. Your browser copy is saved locally.");
      }
    }
    void bootstrap();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!syncReady.current) return;
    const delta = stateDelta(state, lastRemote.current);
    if (!delta.bookmarks.length && !delta.notes.length && !delta.deletedBookmarkIds.length && !delta.deletedNoteIds.length && !Object.keys(delta.progress).length) return;
    const timer = window.setTimeout(async () => {
      try {
        for (let i = 0; i < delta.bookmarks.length; i += 25) {
          const response = await fetch("/api/v1/me/learning", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "sync", bookmarks: delta.bookmarks.slice(i, i + 25), notes: [] }) });
          if (!response.ok) throw new Error("Sync failed");
        }
        for (let i = 0; i < delta.notes.length; i += 5) {
          const response = await fetch("/api/v1/me/learning", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "sync", bookmarks: [], notes: delta.notes.slice(i, i + 5) }) });
          if (!response.ok) throw new Error("Sync failed");
        }
        for (let i = 0; i < Math.max(delta.deletedBookmarkIds.length, delta.deletedNoteIds.length); i += 25) {
          const response = await fetch("/api/v1/me/learning", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "sync", bookmarks: [], notes: [], deletedBookmarkIds: delta.deletedBookmarkIds.slice(i, i + 25), deletedNoteIds: delta.deletedNoteIds.slice(i, i + 25) }) });
          if (!response.ok) throw new Error("Sync failed");
        }
        for (const progress of Object.values(delta.progress)) {
          for (let i = 0; i < Math.max(progress.watched.length, 1); i += 100) {
            const response = await fetch("/api/v1/me/learning", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "progress.merge", courseId: progress.courseId, furthestSeconds: progress.furthestSeconds, watched: progress.watched.slice(i, i + 100) }) });
            if (!response.ok) throw new Error("Sync failed");
          }
        }
        const synced = mergePersonalStates(lastRemote.current, state);
        const deletedBookmarks = new Set(delta.deletedBookmarkIds);
        const deletedNotes = new Set(delta.deletedNoteIds);
        lastRemote.current = {
          ...synced,
          bookmarks: synced.bookmarks.filter((item) => !deletedBookmarks.has(item.id)),
          notes: synced.notes.filter((item) => !deletedNotes.has(item.id)),
        };
        setPersonalSyncError(null);
      } catch {
        setPersonalSyncError("Account sync is unavailable. Your browser copy is saved locally.");
      }
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [state]);

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
        const item = { id: newId("bm"), courseId, seconds, title, createdAt: new Date().toISOString() };
        updatePersonal((current) =>
          addBookmark(current, {
            ...item,
            now: item.createdAt,
          }),
        );
        saveRemote({ type: "bookmark.save", item });
      },
      renameBookmark(bookmarkId: string, title: string) {
        updatePersonal((current) => renameBookmark(current, bookmarkId, title));
        const item = getPersonalSnapshot().bookmarks.find((bookmark) => bookmark.id === bookmarkId);
        if (item) saveRemote({ type: "bookmark.save", item });
      },
      removeBookmark(bookmarkId: string) {
        updatePersonal((current) => removeBookmark(current, bookmarkId));
        saveRemote({ type: "bookmark.delete", id: bookmarkId });
      },
      addNoteAt(courseId: string, seconds: number, body: string) {
        const item = { id: newId("note"), courseId, seconds, body, updatedAt: new Date().toISOString() };
        updatePersonal((current) =>
          addNote(current, {
            ...item,
            now: item.updatedAt,
          }),
        );
        saveRemote({ type: "note.save", item });
      },
      updateNote(noteId: string, body: string) {
        updatePersonal((current) => updateNote(current, noteId, body, new Date().toISOString()));
        const item = getPersonalSnapshot().notes.find((note) => note.id === noteId);
        if (item) saveRemote({ type: "note.save", item });
      },
      removeNote(noteId: string) {
        updatePersonal((current) => removeNote(current, noteId));
        saveRemote({ type: "note.delete", id: noteId });
      },
    }),
    [],
  );

  return { state, ready, storageError, reportPlayback, resetPlaybackBaseline, actions };
}
