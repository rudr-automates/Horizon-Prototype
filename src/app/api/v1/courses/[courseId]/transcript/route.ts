import { NextResponse } from "next/server";
import { transcriptResponseSchema } from "@/lib/contracts/lesson-view";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { LESSON_TRANSCRIPT_SOURCE } from "@/lib/lesson/transcript";
import { selectTranscriptSegments } from "@/lib/presentation/transcript-view";
import { createServerContext } from "@/lib/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The transcript is a reading pane, not a search index; this is its upper bound. */
const SEGMENT_LIMIT = 1000;

/**
 * GET /api/v1/courses/:courseId/transcript?playheadSeconds=…
 *
 * The captions that are ELIGIBLE at this position, and nothing else. The store
 * applies the canonical predicate in SQL and again in JavaScript, so this route
 * cannot return a passage the answer path would refuse to cite — and because the
 * boundary is the learner's own position, the pane cannot be used to read ahead.
 *
 * What is deliberately absent: total segment count, the last caption's time, and
 * any unlock time. A learner at 00:00 can see that no captions have been reached
 * yet; they cannot learn how many are coming.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> },
): Promise<NextResponse> {
  const requestId = newRequestId();
  const { courseId } = await params;

  const rawPlayhead = new URL(request.url).searchParams.get("playheadSeconds");
  const playhead = rawPlayhead === null ? 0 : Number(rawPlayhead);
  if (!Number.isFinite(playhead) || playhead < 0) {
    return errorResponse(
      "INVALID_REQUEST",
      "playheadSeconds must be a non-negative number.",
      requestId,
    );
  }

  try {
    const { storeResolution } = createServerContext();
    const store = storeResolution.store;

    const course = await store.getCourse(courseId);
    if (!course) {
      return errorResponse("NOT_FOUND", "That course was not found.", requestId);
    }

    const boundarySeconds = Math.min(playhead, course.durationSeconds);
    const eligible = await store.listEligible({ courseId, boundarySeconds }, SEGMENT_LIMIT);

    const segments = selectTranscriptSegments(eligible);

    return NextResponse.json(
      transcriptResponseSchema.parse({
        requestId,
        courseId,
        boundarySeconds,
        segments,
        sourceLabel: LESSON_TRANSCRIPT_SOURCE.label,
        note:
          "Only captions the lesson has already reached are sent. A gap between segments means " +
          "the source has no caption text there; nothing is filled in.",
      }),
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return errorResponse("INTERNAL_ERROR", "Could not read the transcript.", requestId);
  }
}
