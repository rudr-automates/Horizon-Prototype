import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicHealthResponseSchema } from "@/lib/contracts/http";
import { OPERATIONAL_DETAIL, fullHealthReport } from "./helpers/health-report";

/**
 * A page prop is as public as an endpoint: Next.js serializes it into the HTML
 * and the RSC payload. The Status surface used to be handed the full operator
 * report, which published the day's spend, the budget, the model ids, the schema
 * counts and the configuration problems to any visitor of `/learn?section=status`.
 *
 * This test builds the page for real and inspects what it actually hands to the
 * client component. The JSON endpoint is covered separately in
 * `health-public.test.ts`.
 */

const state = vi.hoisted(() => ({
  report: null as unknown,
  signedIn: true,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.signedIn ? { id: "test-user" } : null }, error: null }) },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (destination: string) => { throw new Error(`REDIRECT:${destination}`); },
}));

vi.mock("@/lib/health/report", () => ({
  buildHealthReport: async () => state.report,
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
      embeddingApiKey: "test-embedding-key",
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: 768,
      maxOutputTokens: 4096,
      dailyTokenBudget: 250_000,
      maxEmbeddingCalls: 10,
      thinkingBudget: null,
      requestTimeoutMs: 30_000,
    },
    providers: { configured: true, embeddingConfigured: true },
    storeResolution: {
      store: { listCourses: async () => [] },
      reason: "Supabase is configured.",
    },
  }),
}));

vi.mock("@/lib/lesson/video-file", () => ({
  resolveServerLessonVideoSource: () => ({
    kind: "embed",
    youtubeId: "test-video",
    watchUrl: "https://www.youtube.com/watch?v=test-video",
    host: "https://www.youtube-nocookie.com",
  }),
}));

const { default: LearnPage } = await import("@/app/learn/page");

beforeEach(() => {
  state.report = fullHealthReport();
  state.signedIn = true;
});

describe("learn page props", () => {
  it("hands the client only the public health projection", async () => {
    const element = await LearnPage({ searchParams: Promise.resolve({ section: "status" }) });
    const props = element.props as Record<string, unknown>;
    const serialized = JSON.stringify(props);

    for (const detail of OPERATIONAL_DETAIL) {
      expect(serialized).not.toContain(detail);
    }

    // The prop is the public shape, not a superset of the operator report: the
    // report's `runtime` carries spend and model detail, the public one carries
    // only the evidence source.
    expect(publicHealthResponseSchema.safeParse(props.health).success).toBe(true);
    expect(Object.keys((props.health as { runtime: object }).runtime).sort()).toEqual([
      "demoContent",
      "evidenceSource",
    ]);
  });

  it("passes a count of configuration problems, never their names", async () => {
    const element = await LearnPage({ searchParams: Promise.resolve({}) });
    const props = element.props as Record<string, unknown>;

    expect(typeof props.configurationProblemCount).toBe("number");
    expect(props).not.toHaveProperty("configurationProblems");
    expect(JSON.stringify(props)).not.toContain("HORIZON_LLM_BASE_URL");
  });

  it("sends an unauthenticated studio visitor to sign-in and preserves the requested lesson", async () => {
    state.signedIn = false;
    await expect(LearnPage({ searchParams: Promise.resolve({ lesson: "recording", start: "300" }) }))
      .rejects.toThrow("REDIRECT:/auth/signin?next=%2Flearn%3Flesson%3Drecording%26start%3D300");
  });
});
