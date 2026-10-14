import { NextResponse } from "next/server";
import { courseSummarySchema } from "@/lib/contracts/question";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { createServerContext } from "@/lib/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/courses/:courseId — course metadata only, no future-content detail. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ courseId: string }> },
): Promise<NextResponse> {
  const requestId = newRequestId();
  const { courseId } = await params;

  try {
    const { storeResolution } = createServerContext();
    const course = await storeResolution.store.getCourse(courseId);
    if (!course) {
      return errorResponse("NOT_FOUND", "That course was not found.", requestId);
    }
    return NextResponse.json(courseSummarySchema.parse(course));
  } catch {
    return errorResponse("INTERNAL_ERROR", "Could not load the course.", requestId);
  }
}
