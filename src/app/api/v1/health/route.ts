import { NextResponse } from "next/server";
import type { PublicHealthResponse } from "@/lib/contracts/http";
import { toPublicHealth } from "@/lib/health/public";
import { buildHealthReport } from "@/lib/health/report";
import { errorResponse, newRequestId } from "@/lib/http/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/health — the public liveness and data-path check.
 *
 * WHAT THIS USED TO RETURN
 *   The full operator report: daily token spend, the budget, model ids, the
 *   embedding cap, schema object counts and the exact configuration problems.
 *   Nothing there was a secret, but a public endpoint does not need to volunteer
 *   an operator's spend figure, and the figures are useful to someone deciding
 *   when to exhaust the day's allowance.
 *
 * WHAT IT RETURNS NOW
 *   Whether the app answered, whether an authenticated database read succeeded,
 *   whether a generation credential is configured, which corpus is in use, and
 *   whether a question could be admitted at all. That last one is why a
 *   deployment missing migration 0004 no longer reports itself as operational.
 *   The detailed report lives at `/api/v1/health/diagnostics` behind an operator
 *   token.
 *
 * The payload is built by `toPublicHealth`, which the Status surface also uses,
 * so the JSON and the page can never disagree about what is public.
 */
export async function GET(): Promise<NextResponse<PublicHealthResponse>> {
  const requestId = newRequestId();

  try {
    const report = await buildHealthReport(requestId);
    const payload = toPublicHealth(report);

    return NextResponse.json(payload, {
      // Liveness is a fact about this instant; a cached copy would be a lie.
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return errorResponse(
      "INTERNAL_ERROR",
      "Health check failed to complete.",
      requestId,
    ) as unknown as NextResponse<PublicHealthResponse>;
  }
}
