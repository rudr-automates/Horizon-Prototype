import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { readServerEnv } from "@/lib/env";
import { createServiceRoleClient, isDatabaseConfigured } from "@/lib/db/server";
import { createServerContext } from "@/lib/server/context";

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

interface BlockRow {
  resource_id: string;
  policy: string;
  review_state: string;
  ingest_status: string;
  unlock_seconds: string | number | null;
}

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
        .select("resource_id, policy, review_state, ingest_status, unlock_seconds")
        .eq("course_id", courseId),
    ]);

    if (resourceResult.error || blockResult.error) {
      return errorResponse("INTERNAL_ERROR", "Could not read course resources.", requestId);
    }

    const blocksByResource = new Map<string, BlockRow[]>();
    for (const row of (blockResult.data ?? []) as BlockRow[]) {
      const list = blocksByResource.get(row.resource_id) ?? [];
      list.push(row);
      blocksByResource.set(row.resource_id, list);
    }

    const resources = ((resourceResult.data ?? []) as Array<Record<string, unknown>>).map(
      (resource) => {
        const rows = blocksByResource.get(String(resource.id)) ?? [];
        const policies = new Set(rows.map((row) => row.policy));
        const eligibleNow = rows.filter((row) => {
          if (row.ingest_status !== "INDEXED") return false;
          const approved =
            row.review_state === "AUTO_APPROVED" || row.review_state === "HUMAN_APPROVED";
          if (row.policy === "COURSE_WIDE") {
            return approved; // The lint status is not selected here; course-wide rows
            // are only written as approved when the lint passed or a human
            // acknowledged it, and both are eligible by the same predicate branch.
          }
          if (!approved) return false;
          const unlock = Number(row.unlock_seconds);
          return Number.isFinite(unlock) && unlock <= boundarySeconds;
        }).length;

        return {
          id: String(resource.id),
          kind: String(resource.kind ?? "notes") as z.infer<typeof resourceKindSchema>,
          title: String(resource.title ?? "Untitled resource"),
          coverage:
            resource.extraction_coverage === null || resource.extraction_coverage === undefined
              ? null
              : Number(resource.extraction_coverage),
          parser: resource.parser_version ? String(resource.parser_version) : null,
          policy:
            policies.size === 0
              ? ("TIMELINE_BOUND" as const)
              : policies.size > 1
                ? ("MIXED" as const)
                : (String(resource.default_policy ?? "TIMELINE_BOUND") as
                    | "COURSE_WIDE"
                    | "TIMELINE_BOUND"),
          blocks: rows.length,
          eligibleNow,
          pendingReview: rows.filter((row) => row.review_state === "PENDING").length,
          rejected: rows.filter((row) => row.review_state === "REJECTED").length,
        };
      },
    );

    return NextResponse.json(
      responseSchema.parse({
        requestId,
        courseId,
        boundarySeconds,
        resources,
        note:
          "Counts only. A course-wide resource is approved reference material and is available " +
          "at every playhead; a timeline-bound one unlocks as the recording reaches it.",
      }),
    );
  } catch {
    return errorResponse("INTERNAL_ERROR", "Could not read course resources.", requestId);
  }
}
