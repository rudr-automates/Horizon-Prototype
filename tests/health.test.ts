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
  dailyTokenBudget: 20_000,
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

vi.mock("@/lib/server/context", () => ({
  createServerContext: () => ({
    config: {
      provider: "google-genai",
      apiKey: "test-key-not-real",
      model: "gemini-3.6-flash",
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: 768,
      baseUrlOverride: "",
      maxOutputTokens: 1024,
      dailyTokenBudget: state.dailyTokenBudget,
      maxEmbeddingCalls: 10,
      thinkingBudget: null,
      requestTimeoutMs: 30_000,
    },
    providers: {
      configured: true,
      generator: null,
      verifier: null,
      embedder: undefined,
      embeddingProviderId: "gemini-embedding-001",
      modelId: null,
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
      },
      reason: "Usage is recorded in the database, so the daily total is durable and shared.",
    },
  }),
}));

const { GET } = await import("@/app/api/v1/health/route");

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
  const response = await GET();
  return (await response.json()) as ReturnType<typeof healthResponseSchema.parse>;
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
  state.dailyTokenBudget = 20_000;
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

  it("never leaks a credential, a raw database error or a schema map", async () => {
    const secret = "service-role-key-do-not-print-1234567890";
    state.env = { SUPABASE_SERVICE_ROLE_KEY: secret };

    const raw = JSON.stringify(await callHealth());

    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    // Counts, not a schema listing.
    expect(raw).not.toContain("usage_ledger");
    expect(raw).not.toContain("horizon_admit_generation_tokens");
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
