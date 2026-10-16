/**
 * GET /api/v1/lesson/video
 *
 * Streams the operator's own copy of the lesson recording to the player.
 *
 * WHY A ROUTE AND NOT `public/`
 *   The recording is 235 MiB. Putting it in `public/` would add it to the repo,
 *   to every build output and to every deploy artifact — and it is a third-party
 *   download, so redistributing it publicly is not this project's decision to
 *   make. It stays untracked and is served from where it already sits, if it
 *   exists at all.
 *
 * RANGE SUPPORT IS THE POINT
 *   A video element cannot seek to 12:00 unless the server answers a range
 *   request with 206 and a correct `Content-Range`. Without this the learner
 *   would get a playhead that only ever moves forward in one continuous read,
 *   which is exactly the kind of not-quite-real behaviour this revision removes.
 *
 * This route never resolves a path from the request. It serves one known file or
 * answers 404, and on any host — where the file was never uploaded — 404 is the
 * honest and expected answer.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { parseByteRange } from "@/lib/lesson/video";
import { findLocalLessonVideoFile } from "@/lib/lesson/video-file";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTENT_TYPE = "video/mp4";

function headersFor(start: number, end: number, size: number, partial: boolean): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": CONTENT_TYPE,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    // A private local media file: nothing here is cacheable by a shared cache,
    // and a stale copy would be a lie about what this deployment can play.
    "Cache-Control": "no-store",
  };
  if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return headers;
}

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const file = findLocalLessonVideoFile();
  if (!file) {
    return errorResponse(
      "NOT_FOUND",
      "This deployment has no local copy of the lesson recording, so there is nothing to stream. The lesson is available from its original source instead.",
      requestId,
    );
  }

  const range = parseByteRange(request.headers.get("range"), file.bytes);
  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${file.bytes}` },
    });
  }

  const start = range === null ? 0 : range.start;
  const end = range === null ? file.bytes - 1 : range.end;
  const body = Readable.toWeb(
    createReadStream(file.absolutePath, { start, end }),
  ) as unknown as ReadableStream<Uint8Array>;

  return new NextResponse(body, {
    status: range === null ? 200 : 206,
    headers: headersFor(start, end, file.bytes, range !== null),
  });
}

/**
 * A player occasionally asks HEAD before it commits to a download. Answering it
 * from the same facts keeps that probe honest instead of returning a 405 that
 * looks like the recording is uninterested in being played.
 */
export async function HEAD(): Promise<Response> {
  const requestId = newRequestId();
  const file = findLocalLessonVideoFile();
  if (!file) {
    return errorResponse(
      "NOT_FOUND",
      "This deployment has no local copy of the lesson recording, so there is nothing to stream. The lesson is available from its original source instead.",
      requestId,
    );
  }
  return new NextResponse(null, {
    status: 200,
    headers: headersFor(0, file.bytes - 1, file.bytes, false),
  });
}
