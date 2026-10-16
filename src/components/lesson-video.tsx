"use client";

/**
 * The lesson recording, played for real.
 *
 * TWO SOURCES, ONE CLOCK
 *   `file`  — this app streams the operator's own copy, so the clock is the
 *             video element's own `currentTime`. Exact, same-origin, no
 *             third-party request, and readable without any external script.
 *   `embed` — the original YouTube player, used wherever the local copy is not
 *             deployed. Its clock is read through YouTube's official IFrame
 *             Player API, so the figure shown is still real playback time.
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

interface YouTubePlayerLike {
  getCurrentTime: () => number;
  getDuration: () => number;
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

export default function LessonVideo({ source }: { source: LessonVideoSource }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [embedStatus, setEmbedStatus] = useState<EmbedStatus>(
    source.kind === "embed" ? "loading" : "ready",
  );
  const [embedError, setEmbedError] = useState<string | null>(null);

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
              setDuration(event.target.getDuration());
              poll = window.setInterval(() => {
                if (cancelled || !player) return;
                setPosition(player.getCurrentTime());
                const playbackDuration = player.getDuration();
                if (playbackDuration > 0) setDuration(playbackDuration);
              }, CLOCK_POLL_MS);
            },
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setEmbedStatus("failed");
        setEmbedError(error instanceof Error ? error.message : "The player could not start.");
      });

    return () => {
      cancelled = true;
      if (poll !== undefined) window.clearInterval(poll);
      player?.destroy();
      player = null;
    };
  }, [youtubeId]);

  // A file-backed player always has a real clock. An embedded one has one only
  // once the API reports itself ready, so before that the panel says so instead
  // of printing 00:00, which would be a position no player ever reported.
  const clockLabel =
    source.kind === "file" || embedStatus === "ready"
      ? formatPlaybackClock(position)
      : null;

  return (
    <div className="mt-3">
      {source.kind === "file" ? (
        <video
          src={source.url}
          controls
          playsInline
          preload="metadata"
          aria-label="Lesson recording"
          className="aspect-video w-full rounded-lg border border-slate-300 bg-slate-900"
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          onDurationChange={(event) => setDuration(event.currentTarget.duration)}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onSeeked={(event) => setPosition(event.currentTarget.currentTime)}
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
            <span className="font-mono">{source.fileName}</span>). This file is
            not part of the repository or any deploy artifact — it is 235 MiB and
            a third-party recording, so a host serves the original embed instead.
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

      {source.kind === "embed" && embedStatus === "failed" && (
        <p
          className="mt-2 rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm font-medium text-amber-900"
          role="status"
        >
          The YouTube player could not start here, so no playback clock is being
          reported. {embedError} The recording itself is unaffected —{" "}
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
