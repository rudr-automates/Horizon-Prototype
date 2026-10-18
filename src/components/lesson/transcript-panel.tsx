"use client";

/**
 * The transcript pane.
 *
 * It shows exactly the captions the server sent for this position — which is the
 * eligible set, not a client-side slice — and it states where the source has no
 * text instead of filling the hole. Selecting a segment seeks the player; the
 * segment playing now is marked only because the player's own clock says so.
 *
 * Search is ordinary text matching. No model call is made, and no score is
 * invented: a segment either contains the term or it does not.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { EmptyState, Panel, PanelHeader, Skeleton } from "@/components/ui/primitives";
import { LESSON_TRANSCRIPT_SOURCE } from "@/lib/lesson/transcript";
import { formatPlaybackClock } from "@/lib/lesson/video";
import {
  filterSegments,
  segmentAt,
  transcriptGaps,
  type TranscriptSegment,
} from "@/lib/presentation/transcript-view";

export function TranscriptPanel({
  segments,
  loading,
  error,
  playhead,
  highlightId,
  seekNonce,
  onSeek,
}: {
  segments: TranscriptSegment[];
  loading: boolean;
  error: string | null;
  playhead: number;
  highlightId: string | null;
  /** Incremented by the studio on every seek, including a citation's play action. */
  seekNonce: number;
  onSeek: (seconds: number) => void;
}) {
  const [query, setQuery] = useState("");
  const highlightRef = useRef<HTMLLIElement | null>(null);
  const followRef = useRef<HTMLLIElement | null>(null);
  const shouldFollow = useRef(false);
  const lastSeekNonce = useRef(seekNonce);

  const visible = useMemo(() => filterSegments(segments, query), [segments, query]);
  const gaps = useMemo(() => transcriptGaps(segments), [segments]);
  const current = useMemo(() => segmentAt(segments, playhead), [segments, playhead]);

  // A citation's "Show in transcript" must land on the passage, not at the top of
  // a list that now happens to contain it.
  useEffect(() => {
    if (highlightId === null) return;
    highlightRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlightId]);

  /**
   * After a seek, bring the pane to the passage the learner just landed on.
   *
   * Only a seek does this. Following the clock on every tick would yank the pane
   * out from under someone reading an earlier passage, which is the classic
   * auto-scroll bug in a transcript view. The anchor is the last reached passage
   * when the player sits a few seconds past it, because that block has not
   * finished unlocking and is therefore not the current one.
   */
  useEffect(() => {
    if (seekNonce === lastSeekNonce.current) return;
    lastSeekNonce.current = seekNonce;
    shouldFollow.current = true;
  }, [seekNonce]);

  const followTarget = query.trim() === "" ? (current ?? visible[visible.length - 1] ?? null) : null;
  useEffect(() => {
    if (!shouldFollow.current || followTarget === null) return;
    shouldFollow.current = false;
    followRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [followTarget]);

  return (
    <Panel className="flex min-h-0 flex-col">
      <PanelHeader
        eyebrow="Source text"
        title="Transcript"
        description={
          segments.length === 0
            ? "Captions appear here as the lesson reaches them."
            : `${segments.length} timestamped passage${segments.length === 1 ? "" : "s"} reached · ${LESSON_TRANSCRIPT_SOURCE.label}`
        }
        actions={
          <div className="relative">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint">
              <Icon name="search" size={13} />
            </span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find in captions"
              aria-label="Search reached captions"
              className="w-40 rounded-control border border-line bg-surface-muted py-1.5 pl-7 pr-2 text-xs text-ink placeholder:text-ink-faint focus:border-brand sm:w-52"
            />
          </div>
        }
      />

      {query.trim() !== "" && (
        <p className="border-b border-line bg-surface-muted px-4 py-1.5 text-[11px] text-ink-soft">
          {visible.length} match{visible.length === 1 ? "" : "es"} in the reached captions ·{" "}
          <button
            type="button"
            onClick={() => setQuery("")}
            className="font-semibold text-brand hover:underline"
          >
            clear
          </button>
        </p>
      )}

      <div className="scroll-pane max-h-[30rem] min-h-[12rem] overflow-y-auto px-2 py-2">
        {loading && (
          <div className="space-y-2 p-2">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        )}

        {!loading && error && (
          <EmptyState icon="warning" title="The transcript could not be read">
            {error} The assistant still answers from the evidence store; only this pane
            is affected.
          </EmptyState>
        )}

        {!loading && !error && segments.length === 0 && (
          <EmptyState icon="video" title="No captions reached yet">
            The lesson has not reached any captioned passage, so there is nothing to
            quote. Press play, or move the timeline.
          </EmptyState>
        )}

        {!loading && !error && segments.length > 0 && visible.length === 0 && (
          <EmptyState icon="search" title="No match in the reached captions">
            Search covers only what the lesson has already passed. A term may appear
            later, which this pane will not show in advance.
          </EmptyState>
        )}

        {!loading && !error && visible.length > 0 && (
          <ul className="space-y-0.5">
            {visible.map((segment) => {
              const isCurrent = current?.id === segment.id;
              const isHighlighted = highlightId === segment.id;
              const isFollowTarget = followTarget?.id === segment.id;
              return (
                <li
                  key={segment.id}
                  ref={
                    isHighlighted
                      ? highlightRef
                      : isFollowTarget
                        ? followRef
                        : undefined
                  }
                  className="relative"
                >
                  {isHighlighted && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-warn"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => onSeek(segment.startSeconds)}
                    aria-current={isCurrent ? "true" : undefined}
                    className={`group flex w-full gap-2.5 rounded-control px-2 py-2 text-left transition-colors ${
                      isCurrent
                        ? "bg-brand-soft"
                        : "hover:bg-surface-muted"
                    }`}
                  >
                    <span
                      className={`w-11 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums ${
                        isCurrent ? "font-semibold text-brand-strong" : "text-ink-faint"
                      }`}
                    >
                      {formatPlaybackClock(segment.startSeconds)}
                    </span>
                    <span
                      className={`min-w-0 flex-1 space-y-1.5 text-[12.5px] leading-5 ${
                        isCurrent ? "text-ink" : "text-ink-soft group-hover:text-ink"
                      }`}
                    >
                      {(segment.paragraphs ?? [segment.text]).map((paragraph, index) => (
                        <span key={index} className="block">
                          {paragraph}
                        </span>
                      ))}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Gaps are facts about the source, stated where they occur. */}
      {gaps.length > 0 && (
        <p className="border-t border-line px-4 py-2 text-[10px] leading-4 text-ink-faint">
          {gaps.length} stretch{gaps.length === 1 ? "" : "es"} of this lesson have no caption
          text ({gaps
            .slice(0, 2)
            .map(
              (gap) =>
                `${formatPlaybackClock(gap.startSeconds)}–${formatPlaybackClock(gap.endSeconds)}`,
            )
            .join(", ")}
          {gaps.length > 2 ? ", …" : ""}). Nothing is filled in.
        </p>
      )}

      <p className="border-t border-line bg-surface-muted px-4 py-2 text-[10px] leading-4 text-ink-faint">
        {LESSON_TRANSCRIPT_SOURCE.caveat} Selecting a line moves the player; the line
        marked as playing is the one the player&rsquo;s clock is inside.
      </p>
    </Panel>
  );
}
