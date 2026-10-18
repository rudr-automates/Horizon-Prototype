import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public question endpoint is the one place an anonymous caller can spend
 * money. These cases act on the route itself, not on its helpers: a refused
 * caller must never reach `answerQuestion`, and a normal caller must still be
 * served with a non-cacheable answer.
 */

const state = vi.hoisted(() => ({
  decision: {
    admitted: true,
    retryAfterSeconds: 0,
    mode: "durable" as const,
  } as {
    admitted: boolean;
    retryAfterSeconds: number;
    mode: "durable" | "memory";
    unavailable?: boolean;
    window?: string;
  },
}));

const answerQuestion = vi.hoisted(() => vi.fn());

vi.mock("@/lib/rate-limit", () => ({
  createQuestionRateLimiter: () => ({
    mode: "durable" as const,
    detail: "stub",
    admit: async () => state.decision,
  }),
  requestBucketKey: () => "bucket",
}));

vi.mock("@/lib/answer/pipeline", () => ({
  answerQuestion,
}));

vi.mock("@/lib/env", () => ({
  readServerEnv: () => ({}),
}));

vi.mock("@/lib/server/context", () => ({
  createServerContext: () => ({
    config: {
      provider: "groq",
      apiKey: "test-key",
      model: "openai/gpt-oss-20b",
      baseUrlOverride: "",
      generationBaseUrl: "https://api.groq.com/openai/v1",
      reasoningEffort: null,
      embeddingApiKey: "test-embedding",
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: 768,
      maxOutputTokens: 1024,
      dailyTokenBudget: 20_000,
      maxEmbeddingCalls: 10,
      thinkingBudget: null,
      requestTimeoutMs: 30_000,
    },
    providers: {
      configured: true,
      generator: { providerId: "groq" },
      verifier: { providerId: "groq" },
      embeddingConfigured: true,
      embedder: {},
      embeddingProviderId: "gemini-embedding-001",
      modelId: "openai/gpt-oss-20b",
      embedderDetail: "",
    },
    storeResolution: {
      store: {
        mode: "supabase",
        demoContent: false,
        getCourse: async () => ({
          courseId: "course-1",
          title: "Lesson",
          durationSeconds: 900,
          demoContent: false,
        }),
      },
      reason: "stub",
    },
    usageResolution: { ledger: { mode: "supabase" } },
  }),
}));

vi.mock("@/lib/persistence/turns", () => ({
  createTurnRecorder: () => ({
    mode: "supabase" as const,
    record: async () => ({ persisted: true, mode: "supabase" as const, detail: "Turn stored." }),
  }),
  toTurnRecord: () => ({}),
}));

const answerOutcome = {
  answerState: "INSUFFICIENT_EVIDENCE" as const,
  internalState: "NOT_IN_MATERIALS" as const,
  reason: "NO_ELIGIBLE_EVIDENCE" as const,
  message: "Nothing eligible supports that.",
  claims: [],
  citations: [],
  scope: {
    boundarySeconds: 120,
    scopeMode: "POSITION" as const,
    eligibleBlockCount: 2,
    policySummary: "stub",
  },
  evidence: {
    source: "supabase" as const,
    retrievedCount: 0,
    payloadCount: 0,
    embeddingProvider: "gemini-embedding-001",
    generator: "groq",
    verifier: "groq",
  },
  provenance: {
    modelId: "openai/gpt-oss-20b",
    embeddingModel: "gemini-embedding-001",
    embeddingDimensions: 768,
    verification: "model_assisted" as const,
    demoContent: false,
  },
  guard: {
    mode: "supabase" as const,
    budgetTokens: 20_000,
    spentTokensToday: 0,
    coverage: "stub",
    detail: "stub",
  },
};

const { POST } = await import("@/app/api/v1/courses/[courseId]/questions/route");

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/v1/courses/course-1/questions", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
    }),
    { params: Promise.resolve({ courseId: "course-1" }) },
  );
}

function chunkedOversized(): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`{"question":"${"a".repeat(20 * 1024)}"}`));
      controller.close();
    },
  });
  const init: RequestInit & { duplex?: string } = { method: "POST", body: stream };
  init.duplex = "half";
  return new Request("http://localhost/api/v1/courses/course-1/questions", init);
}

async function callChunked(request: Request) {
  return POST(request, { params: Promise.resolve({ courseId: "course-1" }) });
}

beforeEach(() => {
  state.decision = { admitted: true, retryAfterSeconds: 0, mode: "durable" };
  answerQuestion.mockReset();
  answerQuestion.mockResolvedValue(answerOutcome);
});

describe("POST /questions guards", () => {
  it("answers a normal request and marks the response non-cacheable", async () => {
    const response = await post(JSON.stringify({ question: "Why does backoff grow?", playheadSeconds: 120 }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(answerQuestion).toHaveBeenCalledTimes(1);
  });

  it("refuses a rate-limited caller without invoking the answer path", async () => {
    state.decision = {
      admitted: false,
      retryAfterSeconds: 30,
      mode: "durable",
      window: "burst",
    };

    const response = await post(JSON.stringify({ question: "Why?", playheadSeconds: 10 }));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the limiter cannot decide", async () => {
    state.decision = {
      admitted: false,
      retryAfterSeconds: 60,
      mode: "durable",
      unavailable: true,
    };

    const response = await post(JSON.stringify({ question: "Why?", playheadSeconds: 10 }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("RATE_LIMIT_UNAVAILABLE");
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized body before doing any other work", async () => {
    const response = await post("{}", { "content-length": String(64 * 1024) });

    expect(response.status).toBe(413);
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("rejects a chunked body that crosses the ceiling", async () => {
    const response = await callChunked(chunkedOversized());

    expect(response.status).toBe(413);
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("rejects a body that fails the contract before any provider work", async () => {
    const response = await post(JSON.stringify({ question: "x" }));

    expect(response.status).toBe(400);
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
