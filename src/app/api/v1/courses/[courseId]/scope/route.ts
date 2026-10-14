import { NextResponse } from "next/server";
import { scopeSummarySchema } from "@/lib/contracts/question";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { formatSeconds } from "@/lib/retrieval/source-label";
import { createServerContext } from "@/lib/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCOPE_COUNT_LIMIT = 1000;

/**
 * GET /api/v1/courses/:courseId/scope?playheadSeconds=…
 *
 * Returns counts for the CURRENTLY ELIGIBLE scope only. It never exposes how
 * many resources or blocks exist later in the lesson, nor any future title,
 * timestamp or id — the scope chip must not become a syllabus-discovery oracle.
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
    const eligible = await store.listEligible(
      { courseId, boundarySeconds },
      SCOPE_COUNT_LIMIT,
    );

    return NextResponse.json(
      scopeSummarySchema.parse({
        boundarySeconds,
        scopeMode: "POSITION",
        eligibleBlockCount: eligible.length,
        policySummary: `Lesson through ${formatSeconds(boundarySeconds)} · approved course-wide references enabled`,
      }),
    );
  } catch {
    return errorResponse("INTERNAL_ERROR", "Could not resolve the scope.", requestId);
  }
}
