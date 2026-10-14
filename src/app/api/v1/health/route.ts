import { NextResponse } from "next/server";
import { isRuntimeAiConfigured } from "@/lib/answer/provider";
import { healthResponseSchema, type HealthResponse } from "@/lib/contracts/http";
import { isDatabaseConfigured, probeDatabaseReachable } from "@/lib/db/server";
import { readServerEnv } from "@/lib/env";
import { errorResponse, newRequestId } from "@/lib/http/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SERVICE_VERSION = "0.1.0";

/**
 * GET /api/v1/health
 *
 * Reports configuration and connectivity as SEPARATE facts. Never returns
 * credentials or environment-variable values, and never reports a dependency
 * as healthy merely because its env var exists.
 */
export async function GET(): Promise<NextResponse<HealthResponse>> {
  const requestId = newRequestId();

  try {
    const env = readServerEnv();

    const databaseConfigured = isDatabaseConfigured(env);
    const databaseReachable = await probeDatabaseReachable(env);
    const runtimeAiConfigured = isRuntimeAiConfigured(env);

    const appCheck = {
      configured: true,
      reachable: true,
      detail: "Next.js route handler responded.",
    };

    const databaseCheck = {
      configured: databaseConfigured,
      reachable: databaseReachable,
      detail: !databaseConfigured
        ? "Supabase URL/anon key not set."
        : databaseReachable
          ? "Supabase REST endpoint answered. This does not confirm migrations are applied."
          : "Supabase REST endpoint did not respond.",
    };

    const runtimeAiCheck = {
      configured: runtimeAiConfigured,
      // Never claim a model is reachable without a real smoke test.
      reachable: null,
      detail: runtimeAiConfigured
        ? "Environment variable names are present, but no verified provider adapter or smoke test exists yet."
        : "Runtime AI not configured; no model calls are possible.",
    };

    const ok = appCheck.reachable === true && databaseCheck.reachable === true;

    const payload: HealthResponse = {
      ok,
      status: ok ? "ok" : "degraded",
      service: "horizon",
      version: SERVICE_VERSION,
      requestId,
      timestamp: new Date().toISOString(),
      checks: {
        app: appCheck,
        database: databaseCheck,
        runtimeAi: runtimeAiCheck,
      },
    };

    // Validate our own output so the contract cannot silently drift.
    return NextResponse.json(healthResponseSchema.parse(payload));
  } catch {
    return errorResponse(
      "INTERNAL_ERROR",
      "Health check failed to complete.",
      requestId,
    ) as unknown as NextResponse<HealthResponse>;
  }
}
