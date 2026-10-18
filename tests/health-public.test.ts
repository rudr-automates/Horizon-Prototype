import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse } from "@/lib/contracts/http";

/**
 * The public health endpoint used to publish the day's token spend, the budget,
 * the model ids, the schema object counts and the configuration problems to any
 * anonymous caller. It now answers a smaller question, and the full report is
 * gated behind an operator token (or rendered on the server for the Status
 * surface).
 *
 * These cases pin both halves: the public payload must NOT contain operational
 * detail, and the diagnostics route must not answer without the token.
 */
const state = vi.hoisted(() => ({
  diagnosticsToken: "",
  report: null as unknown,
}));

vi.mock("@/lib/health/report", () => ({
  buildHealthReport: async () => state.report,
}));

vi.mock("@/lib/env", () => ({
  readServerEnv: () => ({
    diagnosticsToken: state.diagnosticsToken,
    rateLimitSalt: "",
    supabaseUrl: "",
    supabaseAnonKey: "",
    supabaseServiceRoleKey: "",
    llmProvider: "",
    llmBaseUrl: "",
    llmApiKey: "",
    llmModel: "",
    llmReasoningEffort: "",
    embeddingApiKey: "",
    embeddingModel: "",
    embeddingDimensions: 768,
    llmMaxOutputTokens: 1024,
    dailyTokenBudget: 0,
    maxEmbeddingCalls: 0,
    llmThinkingBudget: null,
    requestTimeoutMs: 30_000,
  }),
}));

function fullReport(): HealthResponse {
  return {
    ok: true,
    status: "ok",
    service: "horizon",
    version: "0.2.0",
    requestId: "req-1",
    timestamp: "2026-10-19T00:00:00.000Z",
    checks: {
      app: { configured: true, reachable: true, detail: "Next.js route handler responded." },
      database: {
        configured: true,
        reachable: true,
        detail: "An authenticated read of the database succeeded.",
        urlConfigured: true,
        credentialsPresent: true,
        querySucceeded: true,
        schemaObjects: "verified",
        durableLedger: "usable",
      },
      runtimeAi: {
        configured: true,
        reachable: null,
        detail: "Names are present for groq / openai/gpt-oss-20b.",
      },
      admission: {
        configured: true,
        reachable: true,
        detail: "The request limiter answered, so a question can be admitted.",
      },
    },
    runtime: {
      provider: "groq",
      textModel: "openai/gpt-oss-20b",
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: 768,
      embeddingProvider: "gemini-embedding-001",
      embeddingCredentialPresent: true,
      configurationProblems: ["HORIZON_LLM_BASE_URL is empty"],
      evidenceSource: "supabase",
      evidenceReason: "Supabase is configured.",
      demoContent: false,
      providerCallEvidence: { state: "none_recorded", at: null, detail: "none" },
      spendGuard: "permitted",
      usageMode: "supabase",
      embeddingCapMode: "supabase",
      spentTokensToday: 15_052,
      usageCoverage: "coverage",
      embeddingCalls: 3,
      embeddingRequestsToday: 10,
      maxEmbeddingCalls: 10,
    },
  };
}

const { GET } = await import("@/app/api/v1/health/route");
const { GET: DIAGNOSTICS } = await import("@/app/api/v1/health/diagnostics/route");

function diagnosticsRequest(token?: string): Request {
  return new Request("http://localhost/api/v1/health/diagnostics", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  state.report = fullReport();
  state.diagnosticsToken = "operator-secret";
});

describe("public health", () => {
  it("reports liveness and the data path without publishing spend or model detail", async () => {
    const response = await GET();
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.ok).toBe(true);
    expect(body.checks.database.reachable).toBe(true);
    expect(body.checks.runtimeAi.reachable).toBeNull();
    expect(body.runtime.evidenceSource).toBe("supabase");

    for (const secret of [
      "15052",
      "openai/gpt-oss-20b",
      "gemini-embedding-001",
      "HORIZON_LLM_BASE_URL",
      "spentTokensToday",
      "usageCoverage",
      "durableLedger",
      "schemaObjects",
      "configurationProblems",
      "providerCallEvidence",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reports admission as a public fact, so a missing limiter cannot look operational", async () => {
    const body = await (await GET()).json();

    expect(body.checks.admission.reachable).toBe(true);
    expect(body.checks.admission.detail).toMatch(/a question can be admitted/);
    expect(JSON.stringify(body)).not.toContain("horizon_admit_request");
  });

  it("says the database is degraded rather than claiming health when the read failed", async () => {
    const report = fullReport();
    report.ok = false;
    report.status = "degraded";
    report.checks.database.querySucceeded = false;
    report.checks.database.reachable = false;
    state.report = report;

    const body = await (await GET()).json();

    expect(body.status).toBe("degraded");
    expect(body.checks.database.reachable).toBe(false);
    expect(body.checks.database.detail).toMatch(/did not succeed/);
  });
});

describe("operator diagnostics", () => {
  it("answers 404 when no diagnostics token is configured", async () => {
    state.diagnosticsToken = "";

    const response = await DIAGNOSTICS(diagnosticsRequest("anything"));

    expect(response.status).toBe(404);
  });

  it("answers 404 for a missing or wrong token without revealing the endpoint", async () => {
    expect((await DIAGNOSTICS(diagnosticsRequest())).status).toBe(404);
    expect((await DIAGNOSTICS(diagnosticsRequest("wrong"))).status).toBe(404);
    expect((await DIAGNOSTICS(diagnosticsRequest("operator-secre"))).status).toBe(404);
  });

  it("returns the full report to the token holder, uncached", async () => {
    const response = await DIAGNOSTICS(diagnosticsRequest("operator-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.runtime.spentTokensToday).toBe(15_052);
    expect(body.checks.database.durableLedger).toBe("usable");
  });
});
