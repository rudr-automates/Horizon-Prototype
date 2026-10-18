"use client";

/**
 * The lesson stage.
 *
 * The player is the visual anchor, and every control below it acts on the real
 * thing: the transport seeks the player, the scrubber seeks the player, and the
 * progress bar reports what this browser has actually watched. Nothing here
 * interpolates a position, and nothing claims coverage from the furthest point
 * reached — those are different facts and the labels keep them apart.
 */
import type { LessonVideoClockReport, SeekRequest } from "@/components/lesson-video";
import LessonVideo from "@/components/lesson-video";
import { Icon } from "@/components/ui/icons";
import { Button, Panel, Pill } from "@/components/ui/primitives";
import { formatPlaybackClock, type LessonVideoSource } from "@/lib/lesson/video";

export interface JumpPreset {
  seconds: number;
  label: string;
}

export function LessonStage({
  view,
  source,
  title,
  author,
  watchUrl,
  durationSeconds,
  playhead,
  clock,
  positionNote,
  captionsIndexed,
  seekRequest,
  onClock,
  onSeek,
  onBookmark,
  bookmarkedAt,
  watchedSeconds,
  progressFraction,
  presets,
}: {
  view: "video" | "fixture";
  source: LessonVideoSource;
  title: string;
  author: string;
  /** The original recording. Null for the synthetic sample, which has none. */
  watchUrl: string | null;
  durationSeconds: number;
  playhead: number;
  clock: LessonVideoClockReport | null;
  positionNote: string;
  captionsIndexed: boolean;
  seekRequest: SeekRequest | null;
  onClock: (report: LessonVideoClockReport | null) => void;
  onSeek: (seconds: number, options?: { play?: boolean; pause?: boolean }) => void;
  onBookmark: () => void;
  bookmarkedAt: number | null;
  watchedSeconds: number;
  progressFraction: number;
  presets: JumpPreset[];
}) {
  const isVideo = view === "video";
  const playerReady = isVideo && clock !== null;
  const playing = clock?.playing === true;
  const percent = Math.round(progressFraction * 100);

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {isVideo ? "Lesson recording" : "Synthetic sample"}
            </p>
            {isVideo ? (
              <Pill tone={captionsIndexed ? "ok" : "warn"}>
                {captionsIndexed ? "Captions indexed" : "Not indexed"}
              </Pill>
            ) : (
              <Pill tone="warn">Labeled fixture · not the recording</Pill>
            )}
          </div>
          <h1 className="mt-1.5 text-lg font-semibold leading-7 tracking-tight text-ink sm:text-[22px] sm:leading-8">
            {title}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
            <span>{author}</span>
            <span aria-hidden="true" className="text-line-strong">·</span>
            <span className="font-mono tabular-nums">{formatPlaybackClock(durationSeconds)}</span>
            {watchUrl !== null && (
              <>
                <span aria-hidden="true" className="text-line-strong">·</span>
                <a
                  href={watchUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-brand hover:underline"
                >
                  Original source
                  <Icon name="external" size={12} />
                </a>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="px-4 sm:px-5">
        {isVideo ? (
          <LessonVideo source={source} onClock={onClock} seekRequest={seekRequest} />
        ) : (
          <div className="rounded-panel border border-warn-line bg-warn-soft p-4">
            <p className="text-sm font-semibold text-ink">
              This sample lesson has no recording.
            </p>
            <p className="mt-1 text-xs leading-5 text-ink-soft">
              It exists to exercise the eligibility, citation and refusal path on
              content that is openly synthetic. Its timeline below is the fixture&rsquo;s
              own; nothing on this page presents it as playback.
            </p>
          </div>
        )}
      </div>

      {/* ---------------- Timeline ---------------- */}
      <div className="px-4 pb-4 pt-3 sm:px-5">
        <div className="flex items-center gap-3">
          <output
            htmlFor="lesson-timeline"
            className="w-[4.6rem] font-mono text-base font-semibold tabular-nums text-ink"
          >
            {formatPlaybackClock(playhead)}
          </output>
          <input
            id="lesson-timeline"
            type="range"
            min={0}
            max={Math.max(1, Math.floor(durationSeconds))}
            step={1}
            value={Math.min(playhead, Math.floor(durationSeconds))}
            onChange={(event) => onSeek(Number(event.target.value))}
            aria-label={isVideo ? "Playback position" : "Sample timeline position"}
            aria-valuetext={`${formatPlaybackClock(playhead)} of ${formatPlaybackClock(durationSeconds)}`}
            className="min-w-0 flex-1 cursor-pointer accent-brand"
            disabled={durationSeconds <= 0}
          />
          <span className="w-[4.6rem] text-right font-mono text-xs tabular-nums text-ink-faint">
            {formatPlaybackClock(durationSeconds)}
          </span>
        </div>

        {/* Watched coverage, which is not the same as the furthest point reached. */}
        <div className="mt-2">
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-surface-sunken"
            role="img"
            aria-label={`Watched ${formatPlaybackClock(watchedSeconds)}, ${percent}% of this lesson, in this browser`}
          >
            <div
              className="h-full rounded-full bg-ok transition-[width] duration-300"
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </div>
          <p className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-faint">
            <span>
              Watched{" "}
              <span className="font-mono text-ink-soft">{formatPlaybackClock(watchedSeconds)}</span>
              {" · "}
              {percent}%
              <span className="text-ink-faint"> · saved in this browser</span>
            </span>
            <span data-testid="position-source" className="truncate">
              Position: {positionNote}
            </span>
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            tone={playing ? "secondary" : "primary"}
            icon={playing ? "pause" : "play"}
            onClick={() => onSeek(playhead, playing ? { pause: true } : { play: true })}
            disabled={!playerReady}
            aria-label={playing ? "Pause the recording" : "Play the recording"}
          >
            {playing ? "Pause" : "Play"}
          </Button>
          <Button
            size="sm"
            icon="clock"
            onClick={() => onSeek(Math.max(0, playhead - 10))}
            disabled={!playerReady}
            aria-label="Back 10 seconds"
          >
            <span className="hidden sm:inline">Back 10s</span>
            <span className="sm:hidden">-10s</span>
          </Button>
          <Button
            size="sm"
            onClick={() => onSeek(Math.min(durationSeconds, playhead + 10))}
            disabled={!playerReady}
            aria-label="Forward 10 seconds"
          >
            <span className="hidden sm:inline">Forward 10s</span>
            <span className="sm:hidden">+10s</span>
          </Button>
          <Button size="sm" icon="bookmark" onClick={onBookmark} disabled={!isVideo}>
            Bookmark
          </Button>

          <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-line sm:block" />

          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
            Jump
          </span>
          <div className="flex flex-wrap gap-1">
            {presets.map((preset) => {
              const active = Math.floor(playhead) === preset.seconds;
              return (
                <button
                  key={preset.seconds}
                  type="button"
                  onClick={() => onSeek(preset.seconds)}
                  aria-pressed={active}
                  aria-label={`Jump to ${formatPlaybackClock(preset.seconds)}, ${preset.label}`}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "border-brand bg-brand text-white"
                      : "border-line bg-surface text-ink-soft hover:border-brand-line hover:bg-brand-soft hover:text-brand-strong"
                  }`}
                >
                  <span className="font-mono tabular-nums">{formatPlaybackClock(preset.seconds)}</span>
                  <span className="ml-1.5">{preset.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {isVideo && !playerReady && (
          <p className="mt-2 rounded-control border border-warn-line bg-warn-soft px-2.5 py-1.5 text-[11px] leading-4 text-warn">
            The player has reported no clock, so the position is the one set here and is
            labelled as manual. Press play in the player to ask from its real position.
          </p>
        )}

        {bookmarkedAt !== null && (
          <p className="mt-2 text-[11px] font-medium text-ok" role="status">
            Saved a bookmark at {formatPlaybackClock(bookmarkedAt)}. It is in Notes, in this
            browser.
          </p>
        )}
      </div>
    </Panel>
  );
}
