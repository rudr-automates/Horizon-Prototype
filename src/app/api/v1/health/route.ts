import { NextResponse } from "next/server";
import {
  describeConfigurationProblems,
  isRuntimeAiConfigured,
} from "@/lib/config";
import {
  healthResponseSchema,
  type HealthResponse,
} from "@/lib/contracts/http";
import {
  hasDatabaseUrl,
  hasServiceRoleKey,
  isDatabaseConfigured,
  probeDatabaseReadable,
  probeSchemaStatus,
  type SchemaStatus,
} from "@/lib/db/server";
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
 * configuration actually in effect. Never returns credentials, env values, raw
 * database errors or a schema map, and never reports a dependency as healthy
 * merely because its env var exists.
 *
 * WHAT CHANGED
 *   `checks.database.reachable` used to mean "the Supabase host answered an HTTP
 *   request", which is also true of a 401. It now means "an authenticated read
 *   actually succeeded", and the surrounding fields separate the remaining
 *   questions: is the URL set, is the key the data path uses set, does the
 *   required schema exist, and can the budget ledger be read.
 *
 *   `runtime.spendGuard` used to be `dailyTokenBudget <= 0` alone. It now reports
 *   whether the NEXT call will actually be admitted, including the cases where
 *   admission itself is impossible because the ledger is unreadable or the
 *   reservation objects are missing.
 */
export async function GET(): Promise<NextResponse<HealthResponse>> {
  const requestId = newRequestId();

  try {
    const env = readServerEnv();
    const context = createServerContext();
    const { config, providers, storeResolution, usageResolution } = context;

    const databaseConfigured = isDatabaseConfigured(env);
    const urlConfigured = hasDatabaseUrl(env);
    const credentialsPresent = hasServiceRoleKey(env);

    // A real authenticated read, not a reachability ping.
    const read = await probeDatabaseReadable(env);
    const schema = await probeSchemaStatus(env);

    // The ledger is read for real. A null here means "unknown", never "zero".
    let spentTokensToday: number | null = null;
    try {
      spentTokensToday = await usageResolution.ledger.spentToday();
    } catch {
      spentTokensToday = null;
    }
    const ledgerReadable = spentTokensToday !== null;

    // Read for the same reason the token total is: the embedding cap is enforced
    // durably, so the figure displayed beside it must come from the same place.
    // Null stays "unknown" rather than becoming 0 — a process-local counter is
    // not the day's usage, and nothing here should imply it is.
    let embeddingRequestsToday: number | null = null;
    try {
      embeddingRequestsToday = await usageResolution.ledger.embeddingRequestsToday();
    } catch {
      embeddingRequestsToday = null;
    }

    const durableLedger = !databaseConfigured
      ? ("not_configured" as const)
      : ledgerReadable
        ? ("usable" as const)
        : ("unreadable" as const);

    const schemaObjects = describeSchema(schema);

    const databaseCheck = {
      configured: databaseConfigured,
      // Kept in sync with querySucceeded so an existing reader of `reachable`
      // cannot see a green value that the detailed fields contradict.
      reachable: databaseConfigured ? read.ok : null,
      detail: describeDatabase({
        urlConfigured,
        credentialsPresent,
        configured: databaseConfigured,
        readOk: read.ok,
        readDetail: read.detail,
        schema,
        schemaObjects,
        ledgerReadable,
      }),
      urlConfigured,
      credentialsPresent,
      querySucceeded: databaseConfigured ? read.ok : null,
      schemaObjects,
      durableLedger,
    };

    const appCheck = {
      configured: true,
      reachable: true,
      detail: "Next.js route handler responded.",
    };

    // ---------------------------------------------------------------------
    // The spend guard: what will ACTUALLY happen to the next provider call.
    //
    // WHY THIS IS NOT `dailyTokenBudget <= 0` ANY MORE
    //   That test describes one way to be blocked and missed the others. A turn
    //   reserves capacity atomically in the database before it is sent, so when
    //   the ledger cannot be read, or migration 0003's reservation objects are
    //   absent, the reservation is refused and EVERY call is blocked — while
    //   this endpoint still reported "permitted". That is the same class of
    //   overclaim as the old database reachability probe, and it is the field
    //   docs/DEPLOY.md tells an operator to trust, so it can send someone
    //   hunting a provider problem that is really a missing migration.
    //
    // A memory ledger needs no reservation objects: it holds capacity in the
    // process, so only a zero budget blocks it.
    const reservationObjectsPresent = schema ? schema.atomicBudgetObjects : false;
    const durableAdmissionAvailable =
      usageResolution.ledger.mode !== "supabase"
        ? true
        : ledgerReadable && reservationObjectsPresent;

    const spendGuardBlocked = config.dailyTokenBudget <= 0 || !durableAdmissionAvailable;

    // Reported rather than inferred. A wrong provider name, a credential that
    // belongs to the other vendor, and a setting that no longer means anything
    // all surface as the same kind of baffling refusal, and each has a different
    // fix. Never contains a credential value.
    const configurationProblems = describeConfigurationProblems(config);

    const runtimeAiDetail = isRuntimeAiConfigured(config)
      ? config.dailyTokenBudget <= 0
        ? "Names are present, but HORIZON_DAILY_TOKEN_BUDGET is 0, so the spend guard permits no provider call and every turn will refuse with BUDGET_EXHAUSTED."
        : spentTokensToday === null
          ? "Names are present, but the usage ledger could not be read, so the daily spend is unknown and calls will be refused rather than risking unmetered spend."
          : !reservationObjectsPresent
            ? "Names are present, but migration 0003's reservation objects are missing, so capacity cannot be reserved atomically and every call will be refused."
            : `Names are present for ${config.provider} / ${config.model}. ${spentTokensToday} of ${config.dailyTokenBudget} daily tokens are used. This endpoint does not verify the provider: run pnpm smoke and pnpm canary to confirm live behaviour.`
      : "Runtime AI not configured; no model calls are possible and no fallback fabricates answers.";

    const runtimeAiCheck = {
      configured: isRuntimeAiConfigured(config),
      // Never claim a model is reachable without a real smoke test.
      reachable: null,
      detail: [runtimeAiDetail, ...configurationProblems].join(" "),
    };

    // Healthy means the database can actually serve this app: configured, an
    // authenticated read worked, the required objects exist, and the budget
    // ledger is readable. Anything else is degraded, and saying so is the point.
    const databaseHealthy =
      databaseConfigured &&
      read.ok &&
      ledgerReadable &&
      schemaObjects === "verified";

    const ok = appCheck.reachable === true && databaseHealthy;

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
        embeddingCredentialPresent: providers.embeddingConfigured,
        configurationProblems,
        evidenceSource: storeResolution.store.mode,
        evidenceReason: storeResolution.reason,
        demoContent: storeResolution.store.demoContent,
        spendGuard: spendGuardBlocked ? "blocked" : "permitted",
        usageMode: usageResolution.ledger.mode,
        embeddingCapMode: usageResolution.ledger.mode,
        spentTokensToday,
        usageCoverage: USAGE_COVERAGE_NOTE,
        embeddingCalls: embeddingCallCount(),
        embeddingRequestsToday,
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

/**
 * Whether the required schema objects exist.
 *
 * `null` (the probe could not run) is reported as "unknown" rather than
 * "incomplete": a probe that never executed is not evidence of absence, and
 * conflating the two would make a misconfiguration look like a missing
 * migration.
 */
function describeSchema(schema: SchemaStatus | null): "verified" | "incomplete" | "unknown" {
  if (!schema) return "unknown";
  const tablesOk = schema.tablesPresent >= schema.tablesExpected;
  const functionsOk = schema.coreFunctionsPresent >= schema.coreFunctionsExpected;
  return tablesOk && functionsOk && schema.atomicBudgetObjects ? "verified" : "incomplete";
}

interface DatabaseDetailInput {
  urlConfigured: boolean;
  credentialsPresent: boolean;
  configured: boolean;
  readOk: boolean;
  readDetail: string;
  schema: SchemaStatus | null;
  schemaObjects: "verified" | "incomplete" | "unknown";
  ledgerReadable: boolean;
}

/** One actionable sentence. Names and counts only — never a credential. */
function describeDatabase(input: DatabaseDetailInput): string {
  if (!input.urlConfigured) {
    return "The database URL is not set, so the labelled sample fixture corpus is used.";
  }
  if (!input.credentialsPresent) {
    return "The database URL is set but the service-role key is not, so no authenticated read was attempted.";
  }
  if (!input.readOk) {
    return input.readDetail;
  }

  // The read probe returns a complete sentence; joining it with `; ` would
  // otherwise produce "succeeded.;".
  const parts = [input.readDetail.replace(/\.$/, "")];
  if (input.schema) {
    parts.push(
      `${input.schema.tablesPresent}/${input.schema.tablesExpected} required tables and ` +
        `${input.schema.coreFunctionsPresent}/${input.schema.coreFunctionsExpected} required functions present`,
    );
    if (!input.schema.atomicBudgetObjects) {
      parts.push("migration 0003 budget objects are missing, so admission cannot be atomic");
    }
  } else {
    parts.push(
      "the schema probe could not run, which is expected until migration 0003 is applied",
    );
  }
  parts.push(
    input.ledgerReadable
      ? "the durable budget ledger is readable"
      : "the durable budget ledger could NOT be read, so provider calls are refused",
  );
  return `${parts.join("; ")}.`;
}
