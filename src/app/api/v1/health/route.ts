import { NextResponse } from "next/server";
import { isRuntimeAiConfigured } from "@/lib/config";
import { healthResponseSchema, type HealthResponse } from "@/lib/contracts/http";
import { isDatabaseConfigured, probeDatabaseReachable } from "@/lib/db/server";
import { readServerEnv } from "@/lib/env";
import { embeddingCallCount } from "@/lib/answer/capped-embedder";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { createServerContext } from "@/lib/server/context";
import { USAGE_COVERAGE_NOTE } from "@/lib/usage/types";

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
    const { config, providers, storeResolution, usageResolution } = context;

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

    // Report the real cumulative total so a positive budget is never mistaken
    // for a cap that is actually being applied. The ledger is reported as
    // unreadable rather than as zero when it cannot be queried.
    let spentTokensToday: number | null = null;
    try {
      spentTokensToday = await usageResolution.ledger.spentToday();
    } catch {
      spentTokensToday = null;
    }

    const runtimeAiCheck = {
      configured: runtimeAiConfigured,
      // Never claim a model is reachable without a real smoke test.
      reachable: null,
      detail: runtimeAiConfigured
        ? spendGuardBlocked
          ? "Names are present, but HORIZON_DAILY_TOKEN_BUDGET is 0, so the spend guard permits no provider call and every turn will refuse with BUDGET_EXHAUSTED."
          : spentTokensToday === null
            ? "Names are present, but the usage ledger could not be read, so the daily spend is unknown and calls will be refused."
            : `Names are present. ${spentTokensToday} of ${config.dailyTokenBudget} daily tokens are used. This endpoint does not verify the provider: run pnpm smoke and pnpm canary to confirm live behaviour.`
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
        usageMode: usageResolution.ledger.mode,
        spentTokensToday,
        usageCoverage: USAGE_COVERAGE_NOTE,
        embeddingCalls: embeddingCallCount(),
        maxEmbeddingCalls: config.maxEmbeddingCalls,
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
