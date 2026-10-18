import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { healthResponseSchema, type HealthResponse } from "@/lib/contracts/http";
import { readServerEnv } from "@/lib/env";
import { buildHealthReport } from "@/lib/health/report";
import { errorResponse, newRequestId } from "@/lib/http/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/health/diagnostics — the full operator report.
 *
 * WHY IT IS SEPARATE
 *   The public health endpoint used to return the day's token spend, the budget,
 *   the model ids and the schema object counts to anyone. The Status surface
 *   still shows all of it, but it is rendered on the server from the same
 *   builder; this route exists for CLI verification, which cannot read a
 *   rendered page.
 *
 * ACCESS
 *   `Authorization: Bearer <HORIZON_DIAGNOSTICS_TOKEN>`. When the setting is
 *   empty the route answers 404 rather than 401, so an unconfigured deployment
 *   does not advertise an operator surface at all. Comparison is constant-time
 *   over fixed-length digests, so the response time does not reveal a prefix.
 *
 * This is not user authentication and does not protect any personal data: the
 * report contains names, booleans and counts, never a credential value.
 */
export async function GET(request: Request): Promise<NextResponse<HealthResponse>> {
  const requestId = newRequestId();
  const configured = readServerEnv().diagnosticsToken;

  if (configured === "" || !tokenMatches(request, configured)) {
    return errorResponse(
      "NOT_FOUND",
      "That resource was not found.",
      requestId,
    ) as unknown as NextResponse<HealthResponse>;
  }

  try {
    const report = await buildHealthReport(requestId);
    return NextResponse.json(healthResponseSchema.parse(report), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return errorResponse(
      "INTERNAL_ERROR",
      "Health check failed to complete.",
      requestId,
    ) as unknown as NextResponse<HealthResponse>;
  }
}

function tokenMatches(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "bearer ";
  if (!header.toLowerCase().startsWith(prefix)) return false;
  const provided = header.slice(prefix.length).trim();
  if (provided === "") return false;

  // Hash both sides first: `timingSafeEqual` throws on different lengths, and a
  // length comparison would itself leak the token's length.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
