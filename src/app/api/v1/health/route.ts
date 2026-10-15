import { NextResponse } from "next/server";
import { isRuntimeAiConfigured } from "@/lib/config";
import { healthResponseSchema, type HealthResponse } from "@/lib/contracts/http";
import { isDatabaseConfigured, probeDatabaseReachable } from "@/lib/db/server";
import { readServerEnv } from "@/lib/env";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { createServerContext } from "@/lib/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SERVICE_VERSION = "0.2.0";

/**
 * GET /api/v1/health
 *
 * Reports configuration and connectivity as SEPARATE facts, plus the runtime
 * configuration actually in effect. Never returns credentials or env values,
 * and never reports a dependency as healthy merely because its env var exists.
 */
export async function GET(): Promise<NextResponse<HealthResponse>> {
  const requestId = newRequestId();

  try {
    const env = readServerEnv();
    const context = createServerContext();
    const { config, providers, storeResolution } = context;

    const databaseConfigured = isDatabaseConfigured(env);
    const databaseReachable = await probeDatabaseReachable(env);
    const runtimeAiConfigured = isRuntimeAiConfigured(config);

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

    const spendGuardBlocked = config.dailyTokenBudget <= 0;

    const runtimeAiCheck = {
      configured: runtimeAiConfigured,
      // Never claim a model is reachable without a real smoke test.
      reachable: null,
      detail: runtimeAiConfigured
        ? spendGuardBlocked
          ? "Names are present, but HORIZON_DAILY_TOKEN_BUDGET is 0, so the spend guard permits no provider call and every turn will refuse with BUDGET_EXHAUSTED."
          : "Environment variable names are present, but no live smoke test has been run or recorded."
        : "Runtime AI not configured; no model calls are possible and no fallback fabricates answers.",
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
      runtime: {
        provider: config.provider,
        textModel: config.model,
        embeddingModel: config.embeddingModel,
        embeddingDimensions: config.embeddingDimensions,
        embeddingProvider: providers.embeddingProviderId,
        evidenceSource: storeResolution.store.mode,
        evidenceReason: storeResolution.reason,
        demoContent: storeResolution.store.demoContent,
        spendGuard: spendGuardBlocked ? "blocked" : "permitted",
      },
    };

    return NextResponse.json(healthResponseSchema.parse(payload));
  } catch {
    return errorResponse(
      "INTERNAL_ERROR",
      "Health check failed to complete.",
      requestId,
    ) as unknown as NextResponse<HealthResponse>;
  }
}
