import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { readServerEnv } from "@/lib/env";
import { createServiceRoleClient, isDatabaseConfigured } from "@/lib/db/server";
import { createServerContext } from "@/lib/server/context";
import {
  summarizeResources,
  type ResourceBlockRow,
  type ResourceRow,
} from "@/lib/presentation/resource-summary";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/courses/:courseId/resources
 *
 * The course's materials, grouped by resource, with the two things a learner
 * needs in order to trust a citation: what kind of source it is, and whether it
 * is permitted at every playhead or only after a point in the recording.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN
 *   No text. No page of a future block. No unlock time for a block that is still
 *   ahead of the learner — only the count of blocks that are eligible now, and
 *   how many are waiting. A materials list must not become the syllabus oracle the
 *   scope endpoint refuses to be.
 */
const resourceKindSchema = z.enum(["video", "transcript", "pdf", "ppt", "notes", "code"]);

const resourceSchema = z.object({
  id: z.string(),
  kind: resourceKindSchema,
  title: z.string(),
  coverage: z.number().nullable(),
  parser: z.string().nullable(),
  policy: z.enum(["COURSE_WIDE", "TIMELINE_BOUND", "MIXED"]),
  blocks: z.number().int(),
  eligibleNow: z.number().int(),
  pendingReview: z.number().int(),
  rejected: z.number().int(),
});

const responseSchema = z.object({
  requestId: z.string(),
  courseId: z.string(),
  boundarySeconds: z.number(),
  resources: z.array(resourceSchema),
  note: z.string(),
});


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
    const course = await storeResolution.store.getCourse(courseId);
    if (!course) {
      return errorResponse("NOT_FOUND", "That course was not found.", requestId);
    }
    const boundarySeconds = Math.min(playhead, course.durationSeconds);

    const env = readServerEnv();
    if (!isDatabaseConfigured(env) || env.supabaseServiceRoleKey.trim() === "") {
      // The fixture corpus has no resource rows to describe, and inventing a list
      // would be worse than an empty one.
      return NextResponse.json(
        responseSchema.parse({
          requestId,
          courseId,
          boundarySeconds,
          resources: [],
          note: "This server is serving the labelled fixture corpus, which has no resource records to list.",
        }),
        { headers: { "cache-control": "no-store" } },
      );
    }

    const client = createServiceRoleClient(env);
    if (!client) {
      return errorResponse("INTERNAL_ERROR", "Could not read course resources.", requestId);
    }

    const [resourceResult, blockResult] = await Promise.all([
      client
        .from("resources")
        .select("id, kind, title, extraction_coverage, parser_version, default_policy, ingest_status")
        .eq("course_id", courseId)
        .order("created_at", { ascending: true }),
      client
        .from("blocks")
        .select(
          "course_id, resource_id, policy, review_state, lint_status, ingest_status, unlock_seconds",
        )
        .eq("course_id", courseId),
    ]);

    if (resourceResult.error || blockResult.error) {
      return errorResponse("INTERNAL_ERROR", "Could not read course resources.", requestId);
    }

    // Counts come from the canonical predicate, never from a rule restated here.
    // `summarizeResources` calls `isBlockEligible`, the same function the store
    // applies after every retrieval query, so the library cannot advertise a
    // block the answer path would refuse to cite.
    const resources = summarizeResources({
      courseId,
      boundarySeconds,
      resources: (resourceResult.data ?? []) as ResourceRow[],
      blocks: (blockResult.data ?? []) as ResourceBlockRow[],
    });

    return NextResponse.json(
      responseSchema.parse({
        requestId,
        courseId,
        boundarySeconds,
        resources,
        note:
          "Counts only. A course-wide resource is approved reference material and is available " +
          "at every playhead once its lint passes or is acknowledged; a timeline-bound one " +
          "unlocks as the recording reaches it.",
      }),
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return errorResponse("INTERNAL_ERROR", "Could not read course resources.", requestId);
  }
}
