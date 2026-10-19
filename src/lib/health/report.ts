import {
  describeConfigurationProblems,
  isRuntimeAiConfigured,
} from "@/lib/config";
import type { HealthResponse } from "@/lib/contracts/http";
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
import { newRequestId } from "@/lib/http/api";
import { probeAdmission } from "@/lib/rate-limit";
import { createServerContext } from "@/lib/server/context";
import { USAGE_COVERAGE_NOTE } from "@/lib/usage/types";

export const SERVICE_VERSION = "0.2.0";

/**
 * The full operator report.
 *
 * WHY IT IS NOT THE PUBLIC PAYLOAD
 *   `GET /api/v1/health` used to return all of this to any anonymous caller:
 *   the day's token spend, the budget, the model ids, the embedding cap, the
 *   schema object counts and the exact configuration problems. None of it is a
 *   credential, but all of it is operational detail that a public endpoint does
 *   not need to volunteer, and the daily spend figure is useful to someone
 *   deciding when to exhaust it.
 *
 *   The report now has two readers: the Status surface, which is server-rendered
 *   from this function, and `GET /api/v1/health/diagnostics`, which requires an
 *   operator token. The public endpoint answers a smaller question — is the
 *   service up, can it read its database, and is it serving the real corpus.
 *
 * Everything here is derived from real probes. Nothing is inferred from an env
 * var being present, and no credential value is ever included.
 */
export async function buildHealthReport(requestId: string = newRequestId()): Promise<HealthResponse> {
  const env = readServerEnv();
  const context = createServerContext();
  const { config, providers, storeResolution, usageResolution } = context;

  const databaseConfigured = isDatabaseConfigured(env);
  const urlConfigured = hasDatabaseUrl(env);
  const credentialsPresent = hasServiceRoleKey(env);

  // A real authenticated read, not a reachability ping.
  const read = await probeDatabaseReadable(env);
  const schema = await probeSchemaStatus(env);
  // The limiter is a dependency in its own right. It is probed with a call that
  // raises before writing, so health never consumes a slot or creates a row.
  const admission = await probeAdmission(env);

  // The ledger is read for real. A null here means "unknown", never "zero".
  let spentTokensToday: number | null = null;
  try {
    spentTokensToday = await usageResolution.ledger.spentToday();
  } catch {
    spentTokensToday = null;
  }
  const ledgerReadable = spentTokensToday !== null;

  let embeddingRequestsToday: number | null = null;
  try {
    embeddingRequestsToday = await usageResolution.ledger.embeddingRequestsToday();
  } catch {
    embeddingRequestsToday = null;
  }

  const providerCallEvidence = await describeProviderCallEvidence(
    usageResolution.ledger,
  );

  const durableLedger = !databaseConfigured
    ? ("not_configured" as const)
    : ledgerReadable
      ? ("usable" as const)
      : ("unreadable" as const);

  const schemaObjects = describeSchema(schema);

  const databaseCheck = {
    configured: databaseConfigured,
    reachable: databaseConfigured ? read.ok : null,
    detail: describeDatabase({
      urlConfigured,
      credentialsPresent,
      configured: databaseConfigured,
      readOk: read.ok,
      readDetail: read.detail,
      schema,
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

  const reservationObjectsPresent = schema ? schema.atomicBudgetObjects : false;
  const durableAdmissionAvailable =
    usageResolution.ledger.mode !== "supabase"
      ? true
      : ledgerReadable && reservationObjectsPresent;

  const spendGuardBlocked = config.dailyTokenBudget <= 0 || !durableAdmissionAvailable;

  const configurationProblems = describeConfigurationProblems(config);

  const runtimeAiDetail = isRuntimeAiConfigured(config)
    ? config.dailyTokenBudget <= 0
      ? "Names are present, but HORIZON_DAILY_TOKEN_BUDGET is 0, so the spend guard permits no provider call and every turn will refuse with BUDGET_EXHAUSTED."
      : spentTokensToday === null
        ? "Names are present, but the usage ledger could not be read, so the daily spend is unknown and calls will be refused rather than risking unmetered spend."
        : !reservationObjectsPresent
          ? "Names are present, but migration 0003's reservation objects are missing, so capacity cannot be reserved atomically and every call will be refused."
          : `Names are present for ${config.provider} / ${config.model}. ${spentTokensToday} of ${config.dailyTokenBudget} daily tokens are used. ${providerCallEvidence.detail} This report never sends a request of its own, so that record — not this line — is what establishes live behaviour.`
    : "Runtime AI not configured; no model calls are possible and no fallback fabricates answers.";

  const runtimeAiCheck = {
    configured: isRuntimeAiConfigured(config),
    // Never claim a model is reachable without a real smoke test.
    reachable: null,
    detail: [runtimeAiDetail, ...configurationProblems].join(" "),
  };

  const admissionCheck = {
    configured: databaseConfigured,
    reachable: admission.ready,
    detail: admission.detail,
  };

  const databaseHealthy =
    databaseConfigured &&
    read.ok &&
    ledgerReadable &&
    schemaObjects === "verified";

  // Admission is part of health, not a footnote: without it every question is
  // refused before any provider call, which is not an "Operational" service.
  const ok = appCheck.reachable === true && databaseHealthy && admission.ready;

  return {
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
      admission: admissionCheck,
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
      providerCallEvidence: {
        state: providerCallEvidence.state,
        at: providerCallEvidence.at,
        detail: providerCallEvidence.detail,
      },
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
}

/**
 * Turn a ledger's record of completed provider calls into one honest sentence.
 *
 * Four outcomes, deliberately distinct:
 *   observed      — a call settled and the provider reported usage for it.
 *   none_recorded — the durable store holds no such row.
 *   not_durable   — the active ledger cannot carry the fact (memory mode).
 *   unreadable    — the store could not be read, so nothing is claimed.
 */
async function describeProviderCallEvidence(
  ledger: ReturnType<typeof createServerContext>["usageResolution"]["ledger"],
): Promise<{ state: "observed" | "none_recorded" | "not_durable" | "unreadable"; at: string | null; detail: string }> {
  try {
    const evidence = await ledger.providerCallEvidence();
    if (evidence.state === "observed") {
      const model = evidence.modelId ?? "model not recorded";
      const operation = evidence.operation ?? "operation not recorded";
      return {
        state: "observed",
        at: evidence.at,
        detail:
          `A completed call is recorded at ${evidence.at} (${evidence.provider} / ${model}, ${operation}), ` +
          (evidence.today
            ? "which is inside today's UTC day. Re-confirm it with pnpm smoke; this line reports a recorded call, not a live probe."
            : "which was recorded on an EARLIER UTC day, so it proves the credential worked then and not that it works now. Run pnpm smoke to make a fresh call."),
      };
    }
    if (evidence.state === "not_durable") {
      return {
        state: "not_durable",
        at: null,
        detail:
          "No provider call can be confirmed from this ledger: it keeps its record in memory for the life of the process, so it cannot attest to a past call. Run pnpm smoke to make a real one.",
      };
    }
    return {
      state: "none_recorded",
      at: null,
      detail:
        "The durable ledger records no completed provider call with reported usage, so no call has succeeded since the ledger began. Run pnpm smoke to make one.",
    };
  } catch {
    return {
      state: "unreadable",
      at: null,
      detail:
        "The usage ledger could not be read, so no completed provider call can be confirmed and none is claimed. Run pnpm smoke to make a real call.",
    };
  }
}

/**
 * Whether the required schema objects exist.
 *
 * `null` (the probe could not run) is reported as "unknown" rather than
 * "incomplete": a probe that never executed is not evidence of absence.
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
