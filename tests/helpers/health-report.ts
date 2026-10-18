import type { HealthResponse } from "@/lib/contracts/http";

/**
 * A full operator report, with every field the public projection must drop.
 *
 * Shared so the projection test, the Status-surface test and the page test all
 * describe the same report. The values are the ones a leak would be visible as.
 */
export function fullHealthReport(
  overrides: { degrade?: boolean; admissionUnready?: boolean } = {},
): HealthResponse {
  return {
    ok: !overrides.degrade && !overrides.admissionUnready,
    status: overrides.degrade || overrides.admissionUnready ? "degraded" : "ok",
    service: "horizon",
    version: "0.2.0",
    requestId: "req-1",
    timestamp: "2026-10-19T00:00:00.000Z",
    checks: {
      app: { configured: true, reachable: true, detail: "Next.js route handler responded." },
      database: {
        configured: true,
        reachable: !overrides.degrade,
        detail: "An authenticated read of the database succeeded; 6/6 required tables.",
        urlConfigured: true,
        credentialsPresent: true,
        querySucceeded: !overrides.degrade,
        schemaObjects: "verified",
        durableLedger: "usable",
      },
      runtimeAi: {
        configured: true,
        reachable: null,
        detail: "Names are present for groq / openai/gpt-oss-20b. 15052 of 250000 daily tokens are used.",
      },
      admission: {
        configured: true,
        reachable: !overrides.admissionUnready,
        detail: overrides.admissionUnready
          ? "The request limiter is unavailable, so every question is refused before any provider call."
          : "The request limiter answered, so a question can be admitted.",
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

/** Strings that must not appear in anything the public page serializes. */
export const OPERATIONAL_DETAIL = [
  "15052", // the day's spend
  "250000", // the budget
  "openai/gpt-oss-20b",
  "gemini-embedding-001",
  "HORIZON_LLM_BASE_URL",
  "spentTokensToday",
  "usageCoverage",
  "schemaObjects",
  "durableLedger",
  "configurationProblems",
  "providerCallEvidence",
  "spendGuard",
  "embeddingRequestsToday",
  "maxEmbeddingCalls",
  "horizon_admit_request",
];
