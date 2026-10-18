"use client";

/**
 * The lesson recording, played for real, with its own clock reported upward.
 *
 * TWO SOURCES, ONE CLOCK
 *   `file`  — this app streams the operator's own copy, so the clock is the
 *             video element's own `currentTime`. Exact, same-origin, no
 *             third-party request, and readable without any external script.
 *   `embed` — the original YouTube player, used wherever the local copy is not
 *             deployed. Its clock is read through YouTube's official IFrame
 *             Player API, so the figure shown is still real playback time.
 *
 * WHY IT REPORTS THE CLOCK
 *   The value the learner reads, the value sent with a question and the boundary
 *   the eligibility predicate uses must be the same number. This component
 *   therefore hands its clock to the page rather than keeping it private, and
 *   reports `null` — not zero — while it has nothing to report. Zero would be a
 *   position no player ever reported, and it is indistinguishable from the real
 *   start of the recording.
 *
 * WHAT THIS COMPONENT REFUSES TO DO
 *   It never estimates a position, never interpolates between polls into a
 *   "smooth" number, and never shows a timeline derived from anything but the
 *   player. When the embed's API cannot load, the panel says the clock is
 *   unavailable and links to the source — it does not fall back to a plausible
 *   looking number.
 */
import { useEffect, useRef, useState } from "react";
import { formatPlaybackClock, type LessonVideoSource } from "@/lib/lesson/video";

export interface LessonVideoClockReport {
  positionSeconds: number;
  durationSeconds: number;
}

interface YouTubePlayerLike {
  getCurrentTime: () => number;
  getDuration: () => number;
  /** Present on a real player; guarded because a resumed player may lack it. */
  seekTo?: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo?: () => void;
  destroy: () => void;
}

interface YouTubePlayerOptions {
  videoId: string;
  playerVars?: Record<string, number>;
  events?: { onReady?: (event: { target: YouTubePlayerLike }) => void };
}

interface YouTubeApi {
  Player: new (element: HTMLElement, options: YouTubePlayerOptions) => YouTubePlayerLike;
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const YOUTUBE_API_SRC = "https://www.youtube.com/iframe_api";
const API_TIMEOUT_MS = 12_000;
const CLOCK_POLL_MS = 500;

/**
 * One loader per page, because the API script calls a single global hook and
 * injecting it twice races two `onYouTubeIframeAPIReady` assignments. The
 * promise is cached and reused by every later mount.
 */
let apiPromise: Promise<YouTubeApi> | null = null;

function loadYouTubeApi(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error("The YouTube player API did not become ready in time."));
    }, API_TIMEOUT_MS);

    // The API calls this global when the script has finished loading.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      window.clearTimeout(timer);
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("The YouTube player API loaded without a player."));
    };

    const script = document.createElement("script");
    script.src = YOUTUBE_API_SRC;
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("The YouTube player API could not be fetched."));
    };
    document.head.appendChild(script);
  });

  return apiPromise;
}

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

type EmbedStatus = "loading" | "ready" | "failed";

/** A seek the page wants performed. The nonce is what makes a repeat seek fire. */
export interface SeekRequest {
  seconds: number;
  nonce: number;
  /**
   * Also start playing from the seeked position. Used by "Play this passage",
   * where the label promises playback; a scrub or a preset jump leaves this
   * unset and therefore only moves the playhead.
   */
  play?: boolean;
}

export default function LessonVideo({
  source,
  onClock,
  seekRequest = null,
}: {
  source: LessonVideoSource;
  onClock?: (clock: LessonVideoClockReport | null) => void;
  seekRequest?: SeekRequest | null;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<YouTubePlayerLike | null>(null);
  /**
   * The callback in a ref, so the player effect depends on the source alone. An
   * effect that listed `onClock` would restart the player on every parent render.
   * The ref is refreshed after each render rather than during one: assigning to
   * `.current` while rendering is what the react-hooks rules reject, and the
   * player only ever reads it from a DOM callback, which runs after that.
   */
  const onClockRef = useRef(onClock);
  useEffect(() => {
    onClockRef.current = onClock;
  }, [onClock]);

  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [embedStatus, setEmbedStatus] = useState<EmbedStatus>(
    source.kind === "embed" ? "loading" : "ready",
  );
  const [embedError, setEmbedError] = useState<string | null>(null);
  /** Set only when the browser refused a requested playback start. */
  const [playbackBlocked, setPlaybackBlocked] = useState(false);

  const youtubeId = source.kind === "embed" ? source.youtubeId : null;

  useEffect(() => {
    if (youtubeId === null) return;
    const mount = mountRef.current;
    if (!mount) return;

    let cancelled = false;
    let player: YouTubePlayerLike | null = null;
    let poll: number | undefined;

    loadYouTubeApi()
      .then((api) => {
        if (cancelled) return;
        player = new api.Player(mount, {
          videoId: youtubeId,
          // No related-video rail and no cookie-consented branding hints: the
          // learner should see this lesson, not a recommendation list.
          playerVars: { rel: 0, playsinline: 1 },
          events: {
            onReady: (event) => {
              if (cancelled) return;
              setEmbedStatus("ready");
              playerRef.current = event.target;
              setDuration(event.target.getDuration());
              poll = window.setInterval(() => {
                if (cancelled || !player) return;
                const current = player.getCurrentTime();
                const playbackDuration = player.getDuration();
                setPosition(current);
                if (playbackDuration > 0) setDuration(playbackDuration);
                onClockRef.current?.({
                  positionSeconds: current,
                  durationSeconds: playbackDuration,
                });
              }, CLOCK_POLL_MS);
            },
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setEmbedStatus("failed");
        setEmbedError(error instanceof Error ? error.message : "The player could not start.");
        // Nothing is reported rather than a stand-in: see the note at the top.
        onClockRef.current?.(null);
      });

    return () => {
      cancelled = true;
      if (poll !== undefined) window.clearInterval(poll);
      playerRef.current = null;
      player?.destroy();
      player = null;
    };
  }, [youtubeId]);

  // A file-backed player has a real clock. An embedded one has one only once its
  // API reports itself ready, so before that the panel says so instead of
  // printing 00:00, which would be a position no player ever reported.
  const clockAvailable = source.kind === "file" || embedStatus === "ready";
  const clockLabel = clockAvailable ? formatPlaybackClock(position) : null;

  // Seek when the page asks for it. Both branches are guarded: a player that is
  // not ready cannot be seeked, and saying nothing would look like a dead button.
  useEffect(() => {
    if (seekRequest === null) return;
    const target = seekRequest.seconds;
    if (source.kind === "file") {
      const element = videoRef.current;
      if (!element) return;
      setPlaybackBlocked(false);
      element.currentTime = target;
      setPosition(target);
      onClockRef.current?.({ positionSeconds: target, durationSeconds: element.duration });
      if (seekRequest.play) {
        // Playback is requested once the seek has SETTLED. Asking in the same tick
        // as the seek makes Chromium abort the play with "interrupted by a new load
        // request", which would leave a still frame under a button that says Play.
        // A refusal is reported in the panel rather than swallowed, so a paused
        // player can never be mistaken for playback that started.
        const start = () => {
          void element.play().catch(() => {
            setPlaybackBlocked(true);
          });
        };
        if (element.seeking) {
          element.addEventListener("seeked", start, { once: true });
        } else {
          start();
        }
      }
      return;
    }
    const player = playerRef.current;
    if (!player?.seekTo) return;
    player.seekTo(target, true);
    if (seekRequest.play) player.playVideo?.();
    setPosition(target);
  }, [seekRequest, source.kind]);

  return (
    <div className="mt-3">
      {source.kind === "file" ? (
        <video
          ref={videoRef}
          src={source.url}
          controls
          playsInline
          preload="metadata"
          aria-label="Lesson recording"
          className="aspect-video w-full rounded-lg border border-slate-300 bg-slate-900"
          onLoadedMetadata={(event) => {
            setDuration(event.currentTarget.duration);
            onClockRef.current?.({
              positionSeconds: event.currentTarget.currentTime,
              durationSeconds: event.currentTarget.duration,
            });
          }}
          onDurationChange={(event) => setDuration(event.currentTarget.duration)}
          // Playback that started by any route — this panel's button or the
          // learner's own — retires the refusal notice, which would otherwise
          // outlive the condition it described.
          onPlay={() => setPlaybackBlocked(false)}
          onTimeUpdate={(event) => {
            const current = event.currentTarget.currentTime;
            setPosition(current);
            onClockRef.current?.({
              positionSeconds: current,
              durationSeconds: event.currentTarget.duration,
            });
          }}
          onSeeked={(event) => {
            const current = event.currentTarget.currentTime;
            setPosition(current);
            onClockRef.current?.({
              positionSeconds: current,
              durationSeconds: event.currentTarget.duration,
            });
          }}
        />
      ) : (
        // The IFrame Player API replaces this element with its own iframe. It is
        // rendered inside a bordered box so an empty frame during load — or a
        // failed load — never looks like a broken page.
        <div className="aspect-video w-full overflow-hidden rounded-lg border border-slate-300 bg-slate-900">
          <div ref={mountRef} className="h-full w-full" />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-slate-700">
          {clockLabel === null ? (
            "The player's clock is unavailable."
          ) : (
            <>
              Playing at{" "}
              <span className="font-mono font-semibold tabular-nums text-slate-900">
                {clockLabel}
              </span>
              <span className="text-slate-600">
                {duration > 0 ? ` / ${formatPlaybackClock(duration)}` : ""}
              </span>
            </>
          )}
        </p>
        <p className="font-mono text-xs text-slate-600">
          {source.kind === "file"
            ? `${formatSize(source.bytes)} · local copy`
            : `original source · ${source.youtubeId}`}
        </p>
      </div>

      <p className="mt-1 text-xs text-slate-600">
        {source.kind === "file" ? (
          <>
            Streamed from the local copy in this workspace (
            <span className="font-mono">{source.fileName}</span>). This file is not
            part of the repository or any deploy artifact — it is 235 MiB and a
            third-party recording, so a host serves the original embed instead.
          </>
        ) : (
          <>
            Played from its original source on YouTube via the official IFrame
            Player API, because a host has no local copy of the recording.{" "}
            <a
              href={source.watchUrl}
              className="font-medium text-blue-800 underline"
              target="_blank"
              rel="noreferrer"
            >
              Open it on YouTube
            </a>
            .
          </>
        )}
      </p>

      {playbackBlocked && (
        <p
          className="mt-2 rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm font-medium text-amber-900"
          role="status"
        >
          The browser refused to start playback, so the recording is paused at that
          position. Press play in the player to continue.
        </p>
      )}

      {source.kind === "embed" && embedStatus === "failed" && (
        <p
          className="mt-2 rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm font-medium text-amber-900"
          role="status"
        >
          The YouTube player could not start here, so no playback clock is being
          reported, and the position you ask from has to be set by hand. {embedError}{" "}
          The recording itself is unaffected —{" "}
          <a
            href={source.watchUrl}
            className="underline"
            target="_blank"
            rel="noreferrer"
          >
            open it at the original source
          </a>
          .
        </p>
      )}
    </div>
  );
}
