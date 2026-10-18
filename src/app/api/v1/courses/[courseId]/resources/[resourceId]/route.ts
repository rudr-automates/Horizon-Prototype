import { NextResponse } from "next/server";
import { z } from "zod";
import { resourceDetailResponseSchema } from "@/lib/contracts/lesson-view";
import { createServiceRoleClient, isDatabaseConfigured } from "@/lib/db/server";
import { readServerEnv } from "@/lib/env";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { createServerContext } from "@/lib/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resourceKindSchema = z.enum(["video", "transcript", "pdf", "ppt", "notes", "code"]);

/**
 * GET /api/v1/courses/:courseId/resources/:resourceId?playheadSeconds=…
 *
 * The readable content of one course source, restricted to the blocks that are
 * eligible at this position. Time-gated pages and slides therefore appear only
 * after the recording has reached them, and a pending or rejected alignment never
 * appears at all — the store's predicate decides, not this route.
 *
 * The total block count IS returned, because the library already reports it and a
 * viewer that said "nothing available" without saying "of how much" would read as
 * a bug. No total text, no future heading and no unlock time is included.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string; resourceId: string }> },
): Promise<NextResponse> {
  const requestId = newRequestId();
  const { courseId, resourceId } = await params;

  if (!UUID_PATTERN.test(resourceId)) {
    return errorResponse("NOT_FOUND", "That resource was not found.", requestId);
  }

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

    const env = readServerEnv();
    if (!isDatabaseConfigured(env) || env.supabaseServiceRoleKey.trim() === "") {
      return errorResponse(
        "NOT_FOUND",
        "Resource records exist only for the database-backed lesson, and this server is serving the sample fixture.",
        requestId,
      );
    }

    const client = createServiceRoleClient(env);
    if (!client) {
      return errorResponse("INTERNAL_ERROR", "Could not read the resource.", requestId);
    }

    const { data: resource, error: resourceError } = await client
      .from("resources")
      .select("id, kind, title, extraction_coverage, parser_version, default_policy")
      .eq("id", resourceId)
      .eq("course_id", courseId)
      .maybeSingle();

    if (resourceError) {
      return errorResponse("INTERNAL_ERROR", "Could not read the resource.", requestId);
    }
    if (!resource) {
      return errorResponse("NOT_FOUND", "That resource was not found.", requestId);
    }

    const [eligible, countResult] = await Promise.all([
      store.listEligible({ courseId, boundarySeconds }, 1000),
      client
        .from("blocks")
        .select("id", { count: "exact", head: true })
        .eq("resource_id", resourceId),
    ]);

    if (countResult.error) {
      return errorResponse("INTERNAL_ERROR", "Could not read the resource.", requestId);
    }

    const blocks = eligible
      .filter((block) => block.resourceId === resourceId)
      .sort((a, b) => {
        const aValue =
          a.pageNumber ?? a.slideNumber ?? a.lineStart ?? a.startSeconds ?? 0;
        const bValue =
          b.pageNumber ?? b.slideNumber ?? b.lineStart ?? b.startSeconds ?? 0;
        return aValue - bValue;
      })
      .map((block) => ({
        id: block.id,
        text: block.text,
        pageNumber: block.pageNumber,
        slideNumber: block.slideNumber,
        lineStart: block.lineStart,
        lineEnd: block.lineEnd,
        startSeconds: block.startSeconds,
        endSeconds: block.endSeconds,
      }));

    const row = resource as Record<string, unknown>;
    const kind = resourceKindSchema.safeParse(String(row.kind ?? "notes"));

    return NextResponse.json(
      resourceDetailResponseSchema.parse({
        requestId,
        courseId,
        boundarySeconds,
        resource: {
          id: String(row.id),
          kind: kind.success ? kind.data : "notes",
          title: String(row.title ?? "Untitled resource"),
          policy:
            row.default_policy === "COURSE_WIDE"
              ? "COURSE_WIDE"
              : row.default_policy === "MIXED"
                ? "MIXED"
                : "TIMELINE_BOUND",
          parser: row.parser_version ? String(row.parser_version) : null,
          coverage:
            row.extraction_coverage === null || row.extraction_coverage === undefined
              ? null
              : Number(row.extraction_coverage),
        },
        blocks,
        totalBlocks: countResult.count ?? blocks.length,
        note:
          "Only blocks permitted at this position are sent. Text from a passage the recording " +
          "has not reached is never included.",
      }),
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return errorResponse("INTERNAL_ERROR", "Could not read the resource.", requestId);
  }
}
