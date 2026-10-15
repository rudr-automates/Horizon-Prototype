import { beforeEach, describe, expect, it } from "vitest";
import {
  CappedEmbedder,
  EmbeddingCallCapReached,
  embeddingCallCount,
  resetEmbeddingCallCount,
} from "@/lib/answer/capped-embedder";
import { buildHttpOptions } from "@/lib/answer/gemini";
import type { Embedder } from "@/lib/answer/provider";
import { readRuntimeConfig } from "@/lib/config";
import { makeEnv } from "./helpers/fakes";

const config = readRuntimeConfig(
  makeEnv({
    llmProvider: "google-genai",
    llmApiKey: "placeholder",
    llmModel: "gemini-3.6-flash",
    embeddingModel: "gemini-embedding-001",
    embeddingDimensions: 768,
  }),
);

beforeEach(() => {
  resetEmbeddingCallCount();
});

describe("SDK retries are disabled", () => {
  it("sets attempts to 1 so one logical call is one request", () => {
    // The SDK documents `attempts` as defaulting to 5 and retries 429/5xx, so
    // leaving it unset could turn one call into five billable requests.
    expect(buildHttpOptions(config).retryOptions.attempts).toBe(1);
  });

  it("passes the configured timeout through", () => {
    expect(buildHttpOptions(config).timeout).toBe(30_000);
  });

  it("omits baseUrl unless an override is configured", () => {
    expect(buildHttpOptions(config)).not.toHaveProperty("baseUrl");
    expect(
      buildHttpOptions({ ...config, baseUrlOverride: "https://example.invalid" }).baseUrl,
    ).toBe("https://example.invalid");
  });
});

describe("embedding call cap", () => {
  function countingEmbedder(): Embedder & { calls: number } {
    return {
      calls: 0,
      providerId: "gemini-embedding-001",
      dimensions: 768,
      embed: async function (this: { calls: number }, texts: string[]) {
        this.calls += 1;
        return texts.map(() => new Array<number>(768).fill(0));
      },
    };
  }

  it("forwards the inner provider identity and dimensions", () => {
    const capped = new CappedEmbedder(countingEmbedder(), 5);
    expect(capped.providerId).toBe("gemini-embedding-001");
    expect(capped.dimensions).toBe(768);
  });

  it("admits calls up to the cap and refuses the next one", async () => {
    const inner = countingEmbedder();
    const capped = new CappedEmbedder(inner, 2);

    await capped.embed(["a"], "document");
    await capped.embed(["b"], "query");

    await expect(capped.embed(["c"], "query")).rejects.toBeInstanceOf(EmbeddingCallCapReached);
    // The refused call must not have reached the provider at all.
    expect(inner.calls).toBe(2);
    expect(embeddingCallCount()).toBe(2);
  });

  it("counts the request before it is sent, so a failing call is not free", async () => {
    const failing: Embedder = {
      providerId: "gemini-embedding-001",
      dimensions: 768,
      embed: async () => {
        throw new Error("network down");
      },
    };
    const capped = new CappedEmbedder(failing, 1);

    await expect(capped.embed(["a"])).rejects.toThrow(/network down/);

    // The call was attempted, so it must consume the cap and a retry cannot
    // multiply requests under it.
    expect(embeddingCallCount()).toBe(1);
    await expect(capped.embed(["a"])).rejects.toBeInstanceOf(EmbeddingCallCapReached);
  });

  it("treats 0 as 'no cap configured' rather than 'no calls allowed'", async () => {
    const capped = new CappedEmbedder(countingEmbedder(), 0);
    for (let i = 0; i < 12; i += 1) {
      await capped.embed(["a"]);
    }
    expect(embeddingCallCount()).toBe(12);
  });

  it("shares one counter across instances, so a per-request bundle cannot reset it", async () => {
    // Provider bundles are rebuilt per request; a per-instance counter would
    // reset each time and the cap would never bind.
    await new CappedEmbedder(countingEmbedder(), 3).embed(["a"]);
    await new CappedEmbedder(countingEmbedder(), 3).embed(["b"]);
    await new CappedEmbedder(countingEmbedder(), 3).embed(["c"]);

    await expect(new CappedEmbedder(countingEmbedder(), 3).embed(["d"])).rejects.toBeInstanceOf(
      EmbeddingCallCapReached,
    );
  });

  it("is applied to the real adapter by the provider bundle", async () => {
    const { createRuntimeProviders } = await import("@/lib/answer/providers");
    const providers = createRuntimeProviders({
      ...config,
      maxEmbeddingCalls: 1,
    });

    expect(providers.embedder).toBeInstanceOf(CappedEmbedder);
  });

  it("does not wrap the offline embedder, which makes no network call", async () => {
    const { createRuntimeProviders } = await import("@/lib/answer/providers");
    const providers = createRuntimeProviders(readRuntimeConfig(makeEnv()));

    expect(providers.embedder).not.toBeInstanceOf(CappedEmbedder);
    expect(providers.embeddingProviderId).toBe("synthetic-lexical-v1");
  });
});

describe("reasoning tokens are metered", () => {
  it("counts prompt + completion + reasoning, since all three are billed", async () => {
    const { meteredTokens } = await import("@/lib/answer/provider");

    // Observed live: 984 thinking tokens against only 21 visible output tokens.
    // Counting only prompt+completion would understate this call by ~50x.
    expect(
      meteredTokens({ promptTokens: 417, completionTokens: 21, thoughtsTokens: 984 }),
    ).toBe(1422);
  });

  it("treats an unreported count as zero rather than guessing", async () => {
    const { meteredTokens } = await import("@/lib/answer/provider");
    expect(meteredTokens({ promptTokens: 10, completionTokens: 5, thoughtsTokens: null })).toBe(15);
    expect(meteredTokens(null)).toBe(0);
  });

  it("normalises a negative or non-finite count to zero, not a credit", async () => {
    const { meteredTokens } = await import("@/lib/answer/provider");

    expect(
      meteredTokens({ promptTokens: -5, completionTokens: Number.NaN, thoughtsTokens: 7 }),
    ).toBe(7);

    // A NaN total would compare false against every limit, silently disabling
    // the guard instead of tripping it.
    expect(
      meteredTokens({ promptTokens: Number.NaN, completionTokens: Number.NaN, thoughtsTokens: null }),
    ).toBe(0);
  });

  it("carries usage out of a malformed response so a failed call is not free", async () => {
    const { GeminiClaimGenerator, toTokenUsage } = await import("@/lib/answer/gemini");
    const { FakeGeminiClient } = await import("./helpers/fakes");

    const client = new FakeGeminiClient();
    client.generateResponses.push({
      text: '{"claims":[{"text":"truncated',
      usageMetadata: { promptTokenCount: 417, candidatesTokenCount: 21, thoughtsTokenCount: 984 },
    });

    const generator = new GeminiClaimGenerator(client, config);

    await expect(generator.generate({ question: "q", evidence: [] })).rejects.toMatchObject({
      kind: "malformed_response",
      usage: { promptTokens: 417, completionTokens: 21, thoughtsTokens: 984 },
    });

    // And the normaliser keeps reasoning separate rather than folding it in.
    expect(toTokenUsage({ promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 3 }))
      .toEqual({ promptTokens: 1, completionTokens: 2, thoughtsTokens: 3 });
  });
});

describe("thinking budget is passed to the provider", () => {
  it("omits thinkingConfig entirely when no budget is configured", async () => {
    const { GeminiClaimGenerator } = await import("@/lib/answer/gemini");
    const { FakeGeminiClient } = await import("./helpers/fakes");

    const client = new FakeGeminiClient();
    client.generateResponses.push({ text: '{"claims":[],"unansweredParts":true}' });

    await new GeminiClaimGenerator(client, { ...config, thinkingBudget: null }).generate({
      question: "q",
      evidence: [],
    });

    expect(client.generateCalls[0].config).not.toHaveProperty("thinkingConfig");
  });

  it("sends the configured budget so reasoning cannot eat the output allowance", async () => {
    const { GeminiClaimGenerator } = await import("@/lib/answer/gemini");
    const { FakeGeminiClient } = await import("./helpers/fakes");

    const client = new FakeGeminiClient();
    client.generateResponses.push({ text: '{"claims":[],"unansweredParts":true}' });

    await new GeminiClaimGenerator(client, { ...config, thinkingBudget: 512 }).generate({
      question: "q",
      evidence: [],
    });

    expect(client.generateCalls[0].config.thinkingConfig).toEqual({ thinkingBudget: 512 });
  });

  it("defaults the output allowance large enough for reasoning plus the answer", async () => {
    const { DEFAULT_MAX_OUTPUT_TOKENS } = await import("@/lib/config");
    const { readServerEnv } = await import("@/lib/env");

    // The live failure was a 1024 cap consumed by 984 reasoning tokens, so the
    // fallback default must leave room for thinking above the answer.
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4096);

    const previous = process.env.HORIZON_LLM_MAX_OUTPUT_TOKENS;
    delete process.env.HORIZON_LLM_MAX_OUTPUT_TOKENS;
    try {
      expect(readServerEnv().llmMaxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    } finally {
      if (previous === undefined) delete process.env.HORIZON_LLM_MAX_OUTPUT_TOKENS;
      else process.env.HORIZON_LLM_MAX_OUTPUT_TOKENS = previous;
    }
  });
});
