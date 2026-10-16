/**
 * The selected lesson video.
 *
 * WHY THIS IS A MODULE AND NOT A `src` ATTRIBUTE
 *   The lesson recording the learner watches and the material Horizon has
 *   evidence for are currently two different things, and the interface must not
 *   blur them. This module states, in one place, which recording is the lesson
 *   and where it can be played from — a local file when the operator has one,
 *   the original YouTube embed otherwise — so that exactly one code path decides
 *   it and the UI never has to guess.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 *   It contains no `node:fs` import. The filesystem check lives in
 *   `video-file.ts`, which is imported only by server code, because a client
 *   component importing `fs` fails to build and a browser must never be handed a
 *   filesystem path. The public descriptor below carries a route URL instead.
 *
 * EVIDENCE STATUS
 *   This video has NO transcript in the repository and its container carries no
 *   subtitle stream (ffprobe reports one h264 video stream and one aac audio
 *   stream, nothing else). So nothing here may be cited, and the interface says
 *   so. See `LESSON_VIDEO_EVIDENCE` below and docs/EVALUATION.md Part 08.
 */

/** The lesson selected for Horizon, identified by its original source. */
export const LESSON_VIDEO = {
  youtubeId: "ZaPbP9DwBOE",
  watchUrl: "https://youtu.be/ZaPbP9DwBOE",
  title: "Don't learn AI Agents without Learning these Fundamentals",
  author: "KodeKloud",
  /**
   * Measured from the downloaded file with ffprobe (`format.duration`), NOT
   * taken from a listing or assumed. The embedded player reports its own
   * duration and that figure is what the panel displays, so this constant is
   * only a fallback and never a claim about playback.
   */
  durationSeconds: 3399.2959,
  /** The file the operator placed in the repository root. */
  localFileName:
    "Don't learn AI Agents without Learning these Fundamentals 1080P.mp4",
  /** Byte size of that file when this integration was written (235.0 MiB). */
  localFileBytes: 246_439_107,
} as const;

/**
 * What Horizon knows about this video's text.
 *
 * `"not_indexed"` is not a temporary placeholder: there is no transcript file,
 * no caption track in the container, and no ingestion step for this recording.
 * Video-grounded Q&A is therefore unavailable, not merely unverified, and the
 * interface must label it that way rather than letting a synthetic fixture stand
 * in for it. Change this value only when a real transcript for this video has
 * actually been ingested — and change the wording with it.
 */
export const LESSON_VIDEO_EVIDENCE = "not_indexed" as const;

/** The route that serves the local file when a deployment has one. */
export const PUBLIC_VIDEO_ROUTE = "/api/v1/lesson/video";

/**
 * Where the learner's player can get the video.
 *
 *  - `file`  — the operator's own copy, streamed by this app. No third-party
 *              request, and the browser's clock is the element's own.
 *  - `embed` — the original YouTube player. Used whenever the local file is
 *              absent, which is the normal case on a host: the recording is
 *              235 MiB and a third-party download, so it is never part of a
 *              deploy artifact or the repository.
 *
 * Neither variant carries a filesystem path.
 */
export type LessonVideoSource =
  | {
      kind: "file";
      /** Same-origin route on this app, never a raw path. */
      url: string;
      fileName: string;
      bytes: number;
    }
  | {
      kind: "embed";
      youtubeId: string;
      watchUrl: string;
      /** Privacy-preserving embed host; the API script still comes from YouTube. */
      host: string;
    };

/** A local file that exists on disk. Internal to server code. */
export interface LocalVideoFile {
  fileName: string;
  bytes: number;
  /** Absolute path. NEVER serialized into a response or passed to the browser. */
  absolutePath: string;
}

/** The embed host. `youtube-nocookie.com` avoids advertising cookies. */
export const EMBED_HOST = "https://www.youtube-nocookie.com";

/**
 * Decide the source from what was actually found on disk.
 *
 * Pure on purpose: the caller does the filesystem read, so this decision — which
 * is the one the UI's honesty depends on — is unit-testable without touching a
 * 235 MiB file or a real disk.
 */
export function resolveLessonVideoSource(local: LocalVideoFile | null): LessonVideoSource {
  if (local) {
    return {
      kind: "file",
      url: PUBLIC_VIDEO_ROUTE,
      fileName: local.fileName,
      bytes: local.bytes,
    };
  }
  return {
    kind: "embed",
    youtubeId: LESSON_VIDEO.youtubeId,
    watchUrl: LESSON_VIDEO.watchUrl,
    host: EMBED_HOST,
  };
}

export type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * Parse one `Range` request header against a known file size.
 *
 * A browser will not seek inside a video unless the server answers with 206 and
 * a correct `Content-Range`, so this is what makes "jump to 12:00" work at all.
 * Three outcomes, and the difference between them matters:
 *
 *   null            — no header, or one too malformed to honour. Serve the whole
 *                     file with 200, which is what RFC 9110 permits for a
 *                     malformed range and what a player recovers from.
 *   "unsatisfiable" — a well-formed range that cannot be met (it starts past the
 *                     end). RFC 9110 requires 416 here, and answering 200 would
 *                     hand the player a body it cannot interpret.
 *   {start, end}    — inclusive byte offsets, clamped to the file. A client that
 *                     asks for more than exists still gets a valid 206.
 *
 * Only the first range of a multi-range request is honoured. Returning several
 * parts would require multipart/byteranges, and every browser video element
 * sends a single range.
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
  if (header === null) return null;
  if (size <= 0) return "unsatisfiable";

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  // "bytes=-" and "bytes=" name no position at all.
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // Suffix form: the LAST n bytes.
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start)) return null;
  if (start >= size) return "unsatisfiable";

  if (rawEnd === "") return { start, end: size - 1 };

  const end = Number(rawEnd);
  if (!Number.isFinite(end)) return null;
  // "bytes=500-100" is syntactically a range and semantically empty.
  if (end < start) return "unsatisfiable";

  return { start, end: Math.min(end, size - 1) };
}

/** `mm:ss`, or `h:mm:ss` past an hour. Used for the real playback clock. */
export function formatPlaybackClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--:--";
  const safe = Math.floor(totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
