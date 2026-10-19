"use client";

/**
 * Bookmarks and notes.
 *
 * Both are attached to a lesson position. Browser storage is the immediate
 * offline copy; signed-in changes sync through the owner-scoped account API.
 * The two destructive actions use a two-step confirmation.
 */
import { useState } from "react";
import { Icon } from "@/components/ui/icons";
import {
  Button,
  ConfirmAction,
  EmptyState,
  Panel,
  PanelHeader,
  Pill,
  Skeleton,
} from "@/components/ui/primitives";
import { formatPlaybackClock } from "@/lib/lesson/video";
import type { Bookmark, Note } from "@/lib/personal/local-store";

export function NotesPanel({
  courseTitle,
  playhead,
  bookmarks,
  notes,
  ready,
  storageError,
  onAddBookmark,
  onRenameBookmark,
  onRemoveBookmark,
  onAddNote,
  onUpdateNote,
  onRemoveNote,
  onSeek,
}: {
  courseTitle: string;
  playhead: number;
  bookmarks: Bookmark[];
  notes: Note[];
  ready: boolean;
  storageError: string | null;
  onAddBookmark: (seconds: number, title: string) => void;
  onRenameBookmark: (id: string, title: string) => void;
  onRemoveBookmark: (id: string) => void;
  onAddNote: (seconds: number, body: string) => void;
  onUpdateNote: (id: string, body: string) => void;
  onRemoveNote: (id: string) => void;
  onSeek: (seconds: number) => void;
}) {
  const [bookmarkTitle, setBookmarkTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");

  const orderedBookmarks = [...bookmarks].sort((a, b) => a.seconds - b.seconds);
  const orderedNotes = [...notes].sort((a, b) => a.seconds - b.seconds);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Study tools
          </p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            Notes and bookmarks
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-soft">
            {courseTitle} · kept in this browser and synced to your account when you are signed in.
          </p>
        </div>
        <Pill tone="neutral">
          <Icon name="clock" size={11} />
          current {formatPlaybackClock(playhead)}
        </Pill>
      </header>

      {storageError && (
        <div className="rounded-panel border border-danger-line bg-danger-soft px-4 py-2.5 text-xs font-medium text-danger" role="status">
          {storageError}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------------- Bookmarks ---------------- */}
        <Panel className="flex flex-col">
          <PanelHeader
            eyebrow="Bookmarks"
            title={`${orderedBookmarks.length} saved position${orderedBookmarks.length === 1 ? "" : "s"}`}
            description="A bookmark is a place to return to, not a claim that the passage was watched."
          />

          <form
            className="border-b border-line px-4 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              const title = bookmarkTitle.trim();
              if (title === "") return;
              onAddBookmark(playhead, title);
              setBookmarkTitle("");
            }}
          >
            <label htmlFor="bookmark-title" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              New bookmark at {formatPlaybackClock(playhead)}
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="bookmark-title"
                value={bookmarkTitle}
                onChange={(event) => setBookmarkTitle(event.target.value)}
                maxLength={120}
                placeholder="e.g. The retry budget argument"
                className="min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-brand"
              />
              <Button type="submit" tone="primary" size="sm" icon="bookmark" disabled={bookmarkTitle.trim() === ""}>
                Save
              </Button>
            </div>
          </form>

          <div className="scroll-pane max-h-[24rem] flex-1 overflow-y-auto">
            {!ready && (
              <div className="space-y-2 p-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )}
            {ready && orderedBookmarks.length === 0 && (
              <EmptyState icon="bookmark" title="No bookmarks yet">
                Bookmark the moment you want to return to. The lesson player also has a
                one-click bookmark beside the timeline.
              </EmptyState>
            )}
            <ul className="divide-y divide-line">
              {orderedBookmarks.map((bookmark) => (
                <li key={bookmark.id} className="px-4 py-2.5">
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => onSeek(bookmark.seconds)}
                      className="shrink-0 rounded-control border border-line bg-surface-muted px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-brand hover:border-brand-line hover:bg-brand-soft"
                      aria-label={`Jump to ${formatPlaybackClock(bookmark.seconds)}`}
                    >
                      {formatPlaybackClock(bookmark.seconds)}
                    </button>

                    {editingId === bookmark.id ? (
                      <form
                        className="flex min-w-0 flex-1 gap-1.5"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (editingTitle.trim() !== "") {
                            onRenameBookmark(bookmark.id, editingTitle);
                          }
                          setEditingId(null);
                        }}
                      >
                        <input
                          value={editingTitle}
                          onChange={(event) => setEditingTitle(event.target.value)}
                          maxLength={120}
                          aria-label="Bookmark title"
                          className="min-w-0 flex-1 rounded-control border border-brand-line bg-surface px-2 py-1 text-sm text-ink"
                        />
                        <Button type="submit" size="sm" tone="primary">
                          Save
                        </Button>
                        <Button type="button" size="sm" tone="ghost" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </form>
                    ) : (
                      <>
                        <p className="min-w-0 flex-1 text-[13px] leading-5 text-ink">
                          {bookmark.title}
                        </p>
                        <button
                          type="button"
                          aria-label={`Edit ${bookmark.title}`}
                          onClick={() => {
                            setEditingId(bookmark.id);
                            setEditingTitle(bookmark.title);
                          }}
                          className="rounded-control p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink"
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                        <ConfirmAction
                          label={`Delete ${bookmark.title}`}
                          onConfirm={() => onRemoveBookmark(bookmark.id)}
                        />
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Panel>

        {/* ---------------- Notes ---------------- */}
        <Panel className="flex flex-col">
          <PanelHeader
            eyebrow="Notes"
            title={`${orderedNotes.length} note${orderedNotes.length === 1 ? "" : "s"}`}
            description="Each note keeps the position it was written at, so the context is never lost."
          />

          <form
            className="border-b border-line px-4 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (noteBody.trim() === "") return;
              onAddNote(playhead, noteBody);
              setNoteBody("");
            }}
          >
            <label htmlFor="note-body" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              New note at {formatPlaybackClock(playhead)}
            </label>
            <textarea
              id="note-body"
              value={noteBody}
              onChange={(event) => setNoteBody(event.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="What do you want to remember here?"
              className="mt-1 w-full resize-y rounded-control border border-line-strong bg-surface px-2.5 py-2 text-sm leading-6 text-ink placeholder:text-ink-faint focus:border-brand"
            />
            <div className="mt-1.5 flex items-center justify-between">
              <span className="text-[10px] tabular-nums text-ink-faint">
                {noteBody.length}/2000
              </span>
              <Button type="submit" tone="primary" size="sm" icon="note" disabled={noteBody.trim() === ""}>
                Save note
              </Button>
            </div>
          </form>

          <div className="scroll-pane max-h-[24rem] flex-1 overflow-y-auto">
            {ready && orderedNotes.length === 0 && (
              <EmptyState icon="note" title="No notes yet">
                A note is attached to the position you wrote it at, so returning to it
                also returns you to the right moment.
              </EmptyState>
            )}
            <ul className="divide-y divide-line">
              {orderedNotes.map((note) => (
                <li key={note.id} className="px-4 py-2.5">
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => onSeek(note.seconds)}
                      className="shrink-0 rounded-control border border-line bg-surface-muted px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-brand hover:border-brand-line hover:bg-brand-soft"
                      aria-label={`Jump to ${formatPlaybackClock(note.seconds)}`}
                    >
                      {formatPlaybackClock(note.seconds)}
                    </button>
                    <div className="min-w-0 flex-1">
                      {editingNoteId === note.id ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (editingBody.trim() !== "") onUpdateNote(note.id, editingBody);
                            setEditingNoteId(null);
                          }}
                        >
                          <textarea
                            value={editingBody}
                            onChange={(event) => setEditingBody(event.target.value)}
                            rows={2}
                            maxLength={2000}
                            aria-label="Note text"
                            className="w-full resize-y rounded-control border border-brand-line bg-surface px-2 py-1 text-sm leading-6 text-ink"
                          />
                          <div className="mt-1 flex gap-1.5">
                            <Button type="submit" size="sm" tone="primary">
                              Save
                            </Button>
                            <Button type="button" size="sm" tone="ghost" onClick={() => setEditingNoteId(null)}>
                              Cancel
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <p className="whitespace-pre-wrap text-[13px] leading-5 text-ink">
                          {note.body}
                        </p>
                      )}
                    </div>
                    {editingNoteId !== note.id && (
                      <>
                        <button
                          type="button"
                          aria-label="Edit note"
                          onClick={() => {
                            setEditingNoteId(note.id);
                            setEditingBody(note.body);
                          }}
                          className="rounded-control p-1 text-ink-faint hover:bg-surface-sunken hover:text-ink"
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                        <ConfirmAction
                          label="Delete note"
                          onConfirm={() => onRemoveNote(note.id)}
                        />
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>
    </div>
  );
}
