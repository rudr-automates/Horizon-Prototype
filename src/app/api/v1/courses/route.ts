import { NextResponse } from "next/server";
import { courseSummarySchema } from "@/lib/contracts/question";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { createServerContext } from "@/lib/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/v1/courses — courses available to the current deployment. */
export async function GET(): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { storeResolution } = createServerContext();
    const courses = await storeResolution.store.listCourses();
    return NextResponse.json({
      requestId,
      evidenceSource: storeResolution.store.mode,
      evidenceReason: storeResolution.reason,
      demoContent: storeResolution.store.demoContent,
      courses: courses.map((course) => courseSummarySchema.parse(course)),
    });
  } catch {
    return errorResponse("INTERNAL_ERROR", "Could not list courses.", requestId);
  }
}
