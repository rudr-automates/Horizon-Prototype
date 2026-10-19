import { beforeEach, describe, expect, it, vi } from "vitest";
import { healthResponseSchema } from "@/lib/contracts/http";

/**
 * The health endpoint is the operator's only unauthenticated view of what the
 * deployment can actually do, so these cases exist to stop it OVERCLAIMING.
 *
 * The two defects they pin down were both real:
 *   1. `database.reachable` was true for any HTTP response, including a 401 from
 *      a wrong or revoked key, so a deployment that could not read a single row
 *      reported a healthy database.
 *   2. `runtime.spendGuard` was `dailyTokenBudget <= 0` alone. With a positive
 *      budget it reported "permitted" even when admission was impossible —
 *      because the ledger could not be read, or migration 0003's reservation
 *      objects were missing — and the answer path refused every call.
 *
 * Everything below the endpoint is replaced with a controlled stub: the subject
 * here is the endpoint's own derivation, not the probes it calls.
 */
const state = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  databaseConfigured: true,
  urlConfigured: true,
  credentialsPresent: true,
  readProbe: {
    ok: true,
    detail: "An authenticated read of the database succeeded.",
  } as { ok: boolean; detail: string },
  schema: null as null | {
    tablesPresent: number;
    tablesExpected: number;
    coreFunctionsPresent: number;
    coreFunctionsExpected: number;
    atomicBudgetObjects: boolean;
    ledgerReadable: boolean;
  },
  ledgerMode: "supabase" as "supabase" | "memory",
  ledgerReadSucceeds: true,
  spentToday: 0,
  /**
   * The DURABLE embedding-request count, held separately from the process-local
   * counter the endpoint also reports, so a case can prove which of the two is
   * the one shown beside the cap.
   */
  embeddingRequestsToday: 0,
  embeddingCountSucceeds: true,
  dailyTokenBudget: 20_000,
  embeddingCredentialPresent: true,
  provider: "google-genai" as string,
  thinkingBudget: null as number | null,
  /**
   * What the stubbed ledger can prove about a completed provider call. The
   * endpoint must render this, not infer it from configuration: a configured
   * provider whose calls are all refused still looks perfectly healthy by name.
   */
  /**
   * Whether the limiter can answer at all. Defaults to ready; the case below
   * sets it to unavailable, which is the production state without migration
   * 0004 and must not be reported as operational.
   */
  admission: {
    ready: true,
    mode: "durable",
    detail: "The request limiter answered, so a question can be admitted.",
  } as { ready: boolean; mode: "durable" | "memory"; detail: string },
  providerCallEvidence: { state: "not_durable" } as
    | { state: "not_durable" }
    | { state: "none_recorded" }
    | {
        state: "observed";
        at: string;
        provider: string;
        modelId: string | null;
        operation: string | null;
        today: boolean;
      },
}));

vi.mock("@/lib/env", () => ({
  readServerEnv: () => state.env,
}));

vi.mock("@/lib/db/server", () => ({
  isDatabaseConfigured: () => state.databaseConfigured,
  hasDatabaseUrl: () => state.urlConfigured,
  hasServiceRoleKey: () => state.credentialsPresent,
  probeDatabaseReadable: async () => state.readProbe,
  probeSchemaStatus: async () => state.schema,
}));

// The limiter is a dependency of its own. Replacing it here isolates the
// report's derivation, which is the subject of this file.
vi.mock("@/lib/rate-limit", () => ({
  probeAdmission: async () => state.admission,
}));

vi.mock("@/lib/server/context", () => ({
  createServerContext: () => ({
    config: {
      provider: state.provider,
      apiKey: "test-key-not-real",
      model: "gemini-3.6-flash",
      // The GENERATION and EMBEDDING credentials are separate now, so both have
      // to be present in the fixture for the endpoint to report a clean
      // configuration; the case that omits one asserts the difference.
      embeddingApiKey: state.embeddingCredentialPresent ? "test-embedding-key-not-real" : "",
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: 768,
      baseUrlOverride: "",
      generationBaseUrl: "",
      reasoningEffort: null,
      maxOutputTokens: 1024,
      dailyTokenBudget: state.dailyTokenBudget,
      maxEmbeddingCalls: 10,
      thinkingBudget: state.thinkingBudget,
      requestTimeoutMs: 30_000,
    },
    providers: {
      configured: true,
      generator: null,
      verifier: null,
      embeddingConfigured: state.embeddingCredentialPresent,
      embedder: undefined,
      embeddingProviderId: "gemini-embedding-001",
      modelId: null,
      embedderDetail: "",
    },
    storeResolution: {
      store: { mode: "supabase", demoContent: false },
      reason: "Supabase is configured; using the database-backed evidence store.",
    },
    usageResolution: {
      ledger: {
        mode: state.ledgerMode,
        spentToday: async () => {
          if (!state.ledgerReadSucceeds) throw new Error("ledger read failed");
          return state.spentToday;
        },
        embeddingRequestsToday: async () => {
          if (!state.embeddingCountSucceeds) throw new Error("embedding count read failed");
          return state.embeddingRequestsToday;
        },
        providerCallEvidence: async () => state.providerCallEvidence,
      },
      reason: "Usage is recorded in the database, so the daily total is durable and shared.",
    },
  }),
}));

// The derivation moved out of the public route when the public payload was
// reduced. These cases test the report itself — the source both the Status page
// and the diagnostics route render.
const { buildHealthReport } = await import("@/lib/health/report");

/** A schema probe result with every required object present. */
function verifiedSchema(overrides: Partial<NonNullable<typeof state.schema>> = {}) {
  return {
    tablesPresent: 7,
    tablesExpected: 7,
    coreFunctionsPresent: 6,
    coreFunctionsExpected: 6,
    atomicBudgetObjects: true,
    ledgerReadable: true,
    ...overrides,
  };
}

async function callHealth() {
  return (await buildHealthReport("health-test")) as ReturnType<
    typeof healthResponseSchema.parse
  >;
}

beforeEach(() => {
  state.env = {};
  state.databaseConfigured = true;
  state.urlConfigured = true;
  state.credentialsPresent = true;
  state.readProbe = { ok: true, detail: "An authenticated read of the database succeeded." };
  state.schema = verifiedSchema();
  state.ledgerMode = "supabase";
  state.ledgerReadSucceeds = true;
  state.spentToday = 0;
  state.embeddingRequestsToday = 0;
  state.embeddingCountSucceeds = true;
  state.dailyTokenBudget = 20_000;
  state.embeddingCredentialPresent = true;
  state.provider = "google-genai";
  state.thinkingBudget = null;
  state.providerCallEvidence = { state: "not_durable" };
  state.admission = {
    ready: true,
    mode: "durable",
    detail: "The request limiter answered, so a question can be admitted.",
  };
});

describe("the completed-provider-call line", () => {
  it("reports a call the ledger can prove, with its time and model", async () => {
    state.providerCallEvidence = {
      state: "observed",
      at: "2026-10-16T18:00:00.000Z",
      provider: "groq",
      modelId: "openai/gpt-oss-20b",
      operation: "generate",
      today: true,
    };

    const body = await callHealth();

    expect(body.runtime.providerCallEvidence.state).toBe("observed");
    expect(body.runtime.providerCallEvidence.at).toBe("2026-10-16T18:00:00.000Z");
    expect(body.runtime.providerCallEvidence.detail).toMatch(/inside today's UTC day/);
    expect(body.checks.runtimeAi.detail).toMatch(/openai\/gpt-oss-20b/);
  });

  it("says an earlier-day call proves the past, not the present", async () => {
    state.providerCallEvidence = {
      state: "observed",
      at: "2026-10-14T09:00:00.000Z",
      provider: "groq",
      modelId: "openai/gpt-oss-20b",
      operation: "generate",
      today: false,
    };

    const body = await callHealth();

    expect(body.runtime.providerCallEvidence.detail).toMatch(/EARLIER UTC day/);
    expect(body.runtime.providerCallEvidence.detail).not.toMatch(/inside today/);
  });

  it("distinguishes an in-memory ledger from 'no call ever succeeded'", async () => {
    state.providerCallEvidence = { state: "not_durable" };

    const body = await callHealth();

    expect(body.runtime.providerCallEvidence.state).toBe("not_durable");
    expect(body.runtime.providerCallEvidence.detail).toMatch(/keeps its record in memory/);
  });

  it("reports nothing when the durable store holds no completed call", async () => {
    state.providerCallEvidence = { state: "none_recorded" };

    const body = await callHealth();

    expect(body.runtime.providerCallEvidence.state).toBe("none_recorded");
    expect(body.runtime.providerCallEvidence.at).toBeNull();
    expect(body.checks.runtimeAi.reachable).toBeNull();
  });

  it("claims nothing when the ledger read itself fails", async () => {
    state.providerCallEvidence = undefined as never;

    const body = await callHealth();

    expect(body.runtime.providerCallEvidence.state).toBe("unreadable");
    expect(body.runtime.providerCallEvidence.at).toBeNull();
  });
});

describe("database health reports what actually happened", () => {
  it("is not healthy when the authenticated read fails, even though the URL and key are set", async () => {
    // The 401 case: the host answers, so the old reachability probe said "up".
    state.readProbe = {
      ok: false,
      detail: "An authenticated read of the database failed. See server logs.",
    };

    const body = await callHealth();

    expect(body.checks.database.urlConfigured).toBe(true);
    expect(body.checks.database.credentialsPresent).toBe(true);
    expect(body.checks.database.querySucceeded).toBe(false);
    expect(body.checks.database.reachable).toBe(false);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("degraded");
  });

  it("separates the facts instead of collapsing them into one boolean", async () => {
    state.credentialsPresent = false;
    state.readProbe = {
      ok: false,
      detail: "The service-role key is not set, so no authenticated read was attempted.",
    };

    const body = await callHealth();

    expect(body.checks.database.configured).toBe(true);
    expect(body.checks.database.urlConfigured).toBe(true);
    expect(body.checks.database.credentialsPresent).toBe(false);
    expect(body.checks.database.querySucceeded).toBe(false);
    expect(body.checks.database.detail).toContain("service-role key is not");
  });

  it("reports a schema probe that could not run as unknown, not incomplete", async () => {
    // A probe that never executed is not evidence of absence: conflating the two
    // would make a misconfiguration look like a missing migration.
    state.schema = null;

    const body = await callHealth();

    expect(body.checks.database.schemaObjects).toBe("unknown");
    expect(body.checks.database.schemaObjects).not.toBe("incomplete");
  });

  it("reports the ledger as unreadable rather than letting the read failure pass silently", async () => {
    state.ledgerReadSucceeds = false;

    const body = await callHealth();

    expect(body.checks.database.durableLedger).toBe("unreadable");
    expect(body.runtime.spentTokensToday).toBeNull();
    expect(body.checks.database.detail).toContain("could NOT be read");
  });

  it("reports the day's DURABLE embedding-request count, which is not this process's counter", async () => {
    // The process-local counter restarts at 0 with the server, so on its own it
    // would report "0 made" against the cap on a day that had already consumed
    // part of it. The two figures are deliberately different here.
    state.embeddingRequestsToday = 3;

    const body = await callHealth();

    expect(body.runtime.embeddingRequestsToday).toBe(3);
    expect(body.runtime.embeddingCapMode).toBe("supabase");
  });

  it("reports an unreadable embedding count as unknown, never as zero", async () => {
    // Zero would understate consumption and make the remaining allowance look
    // larger than it is, which is the failure this field exists to prevent.
    state.embeddingRequestsToday = 3;
    state.embeddingCountSucceeds = false;

    const body = await callHealth();

    expect(body.runtime.embeddingRequestsToday).toBeNull();
    expect(body.runtime.embeddingRequestsToday).not.toBe(0);
  });

  it("never leaks a credential, a raw database error or a schema map", async () => {
    const secret = "service-role-key-do-not-print-1234567890";
    state.env = { SUPABASE_SERVICE_ROLE_KEY: secret };

    const raw = JSON.stringify(await callHealth());

    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    // The provider credentials are now two, and neither belongs in a response.
    expect(raw).not.toContain("test-key-not-real");
    expect(raw).not.toContain("test-embedding-key-not-real");
    expect(raw).not.toContain("HORIZON_LLM_API_KEY");
    expect(raw).not.toContain("HORIZON_EMBEDDING_API_KEY");
    // Counts, not a schema listing.
    expect(raw).not.toContain("usage_ledger");
    expect(raw).not.toContain("horizon_admit_generation_tokens");
  });

  it("reports the embedding credential separately from the generation one", async () => {
    // Generation can be perfectly configured while embeddings are not. That
    // state used to be invisible here: the runtime reported "configured" and the
    // vector branch silently ran on the offline lexical stand-in.
    state.embeddingCredentialPresent = false;

    const body = await callHealth();

    expect(body.checks.runtimeAi.configured).toBe(true);
    expect(body.runtime.embeddingCredentialPresent).toBe(false);
    expect(body.runtime.configurationProblems.join(" ")).toContain(
      "HORIZON_EMBEDDING_API_KEY",
    );
  });

  it("names a setting that the selected provider ignores instead of dropping it", async () => {
    // A leftover Google-only setting under Groq is otherwise a silent no-op.
    state.provider = "groq";
    state.thinkingBudget = 5_000;

    const body = await callHealth();

    expect(body.runtime.provider).toBe("groq");
    expect(body.runtime.configurationProblems.join(" ")).toContain(
      "HORIZON_LLM_THINKING_BUDGET",
    );
    expect(body.checks.runtimeAi.detail).toContain("pnpm smoke");
  });
});

describe("admission is part of health", () => {
  it("is not operational when the limiter is unavailable, however healthy the database is", async () => {
    // The production state before 0004: 0001-0003 applied, the ledger readable,
    // the budget positive — and every question refused with 503.
    state.admission = {
      ready: false,
      mode: "durable",
      detail: "The request limiter is unavailable, so every question is refused before any provider call.",
    };

    const body = await callHealth();

    expect(body.checks.database.schemaObjects).toBe("verified");
    expect(body.runtime.spendGuard).toBe("permitted");
    expect(body.checks.admission.reachable).toBe(false);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("degraded");
  });

  it("carries a public-safe sentence and no object name", async () => {
    state.admission = {
      ready: false,
      mode: "durable",
      detail: "The request limiter is unavailable, so every question is refused before any provider call.",
    };

    const raw = JSON.stringify(await callHealth());

    expect(raw).not.toContain("horizon_admit_request");
    expect(raw).not.toContain("request_rate_limits");
    expect(raw).not.toContain("PGRST");
  });

  it("reports the process-local mode honestly rather than as a durable limit", async () => {
    state.databaseConfigured = false;
    state.ledgerMode = "memory";
    state.admission = {
      ready: true,
      mode: "memory",
      detail:
        "No database is configured, so requests are limited per process only. The limit is real for this instance but is not shared.",
    };

    const body = await callHealth();

    expect(body.checks.admission.configured).toBe(false);
    expect(body.checks.admission.reachable).toBe(true);
    expect(body.checks.admission.detail).toContain("per process only");
  });
});

describe("the spend guard reports what the next call would do", () => {
  it("is blocked when the durable ledger cannot be read, even with a positive budget", async () => {
    // This is the regression: the answer path refuses every call here, so
    // reporting "permitted" sent an operator hunting a provider problem.
    state.ledgerReadSucceeds = false;
    state.dailyTokenBudget = 20_000;

    const body = await callHealth();

    expect(body.runtime.spendGuard).toBe("blocked");
    expect(body.checks.runtimeAi.reachable).toBeNull();
    expect(body.checks.runtimeAi.detail).toContain("usage ledger could not be read");
  });

  it("is blocked when migration 0003's reservation objects are absent", async () => {
    // The ledger read succeeds, but capacity cannot be reserved, so the call is
    // refused. A budget-only check cannot see this.
    state.schema = verifiedSchema({ atomicBudgetObjects: false });

    const body = await callHealth();

    expect(body.checks.database.durableLedger).toBe("usable");
    expect(body.checks.database.schemaObjects).toBe("incomplete");
    expect(body.runtime.spendGuard).toBe("blocked");
    expect(body.checks.runtimeAi.detail).toContain("migration 0003");
    expect(body.ok).toBe(false);
  });

  it("is blocked when the daily budget is zero", async () => {
    state.dailyTokenBudget = 0;

    const body = await callHealth();

    expect(body.runtime.spendGuard).toBe("blocked");
    expect(body.checks.runtimeAi.detail).toContain("HORIZON_DAILY_TOKEN_BUDGET is 0");
  });

  it("is permitted only when the budget, the ledger and the reservation objects all hold", async () => {
    const body = await callHealth();

    expect(body.runtime.spendGuard).toBe("permitted");
    expect(body.checks.database.durableLedger).toBe("usable");
    expect(body.checks.database.schemaObjects).toBe("verified");
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
  });

  it("still permits calls on the in-memory ledger, which needs no reservation objects", async () => {
    // Without a database the ledger holds capacity in the process, so a missing
    // migration must not be reported as a block it cannot cause.
    state.databaseConfigured = false;
    state.ledgerMode = "memory";
    state.schema = null;
    state.dailyTokenBudget = 20_000;

    const body = await callHealth();

    expect(body.checks.database.durableLedger).toBe("not_configured");
    expect(body.runtime.usageMode).toBe("memory");
    expect(body.runtime.spendGuard).toBe("permitted");
  });

  it("reports the budget as blocked for the in-memory ledger when it is zero", async () => {
    state.databaseConfigured = false;
    state.ledgerMode = "memory";
    state.dailyTokenBudget = 0;

    const body = await callHealth();

    expect(body.runtime.spendGuard).toBe("blocked");
  });

  it("never claims the model itself is reachable without a smoke test", async () => {
    const body = await callHealth();

    expect(body.checks.runtimeAi.configured).toBe(true);
    expect(body.checks.runtimeAi.reachable).toBeNull();
    expect(body.checks.runtimeAi.detail).toContain("pnpm smoke");
  });
});
