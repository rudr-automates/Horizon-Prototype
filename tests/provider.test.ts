import { describe, expect, it } from "vitest";
import {
  RuntimeModelNotConfiguredError,
  claimGenerationResultSchema,
  verifierResultSchema,
} from "@/lib/answer/provider";
import { createRuntimeProviders } from "@/lib/answer/providers";
import { readRuntimeConfig } from "@/lib/config";
import { makeEnv } from "./helpers/fakes";

describe("createRuntimeProviders", () => {
  it("reports unconfigured when no credential is present", () => {
    const providers = createRuntimeProviders(readRuntimeConfig(makeEnv()));
    expect(providers.configured).toBe(false);
  });

  it("provides NO generator and NO verifier when unconfigured, so no inference is possible", () => {
    const providers = createRuntimeProviders(readRuntimeConfig(makeEnv()));
    expect(providers.generator).toBeNull();
    expect(providers.verifier).toBeNull();
    expect(providers.modelId).toBeNull();
  });

  it("falls back to the clearly labelled offline embedder at the configured dimension", () => {
    const providers = createRuntimeProviders(
      readRuntimeConfig(makeEnv({ embeddingDimensions: 768 })),
    );
    expect(providers.embeddingProviderId).toBe("synthetic-lexical-v1");
    expect(providers.embedder.dimensions).toBe(768);
  });

  it("still refuses to fabricate output when only some names are present", () => {
    const providers = createRuntimeProviders(
      readRuntimeConfig(makeEnv({ llmProvider: "google-genai", llmModel: "gemini-3.6-flash" })),
    );
    // No API key => not configured => no generator.
    expect(providers.configured).toBe(false);
    expect(providers.generator).toBeNull();
  });

  it("builds the Gemini providers once every required name is present", () => {
    const providers = createRuntimeProviders(
      readRuntimeConfig(
        makeEnv({
          llmProvider: "google-genai",
          llmApiKey: "placeholder",
          llmModel: "gemini-3.6-flash",
          // Embeddings have their own required name; without it this bundle is
          // generation-only and the real embedder is not built at all.
          embeddingApiKey: "placeholder",
        }),
      ),
    );
    expect(providers.configured).toBe(true);
    expect(providers.generator?.providerId).toBe("google-genai");
    expect(providers.verifier?.providerId).toBe("google-genai");
    expect(providers.modelId).toBe("gemini-3.6-flash");
    expect(providers.embeddingConfigured).toBe(true);
    expect(providers.embeddingProviderId).toBe("gemini-embedding-001");
  });
});

describe("provider selection", () => {
  it("builds the Groq generator and verifier when the provider is groq", () => {
    const providers = createRuntimeProviders(
      readRuntimeConfig(
        makeEnv({
          llmProvider: "groq",
          llmApiKey: "groq-key-placeholder",
          embeddingApiKey: "google-embedding-key-placeholder",
        }),
      ),
    );

    expect(providers.configured).toBe(true);
    expect(providers.generator?.providerId).toBe("groq");
    expect(providers.verifier?.providerId).toBe("groq");
    // The model and endpoint are BOTH configuration for an OpenAI-compatible
    // provider, so an unset pair must not leave the request without a target.
    expect(providers.modelId).toBe("openai/gpt-oss-20b");
  });

  it("leaves an unrecognised provider name unconfigured instead of guessing one", () => {
    const config = readRuntimeConfig(
      makeEnv({ llmProvider: "anthopic", llmApiKey: "key", embeddingApiKey: "key" }),
    );
    const providers = createRuntimeProviders(config);

    expect(config.provider).toBe("unconfigured");
    expect(providers.configured).toBe(false);
    expect(providers.generator).toBeNull();
    expect(providers.verifier).toBeNull();
  });
});

describe("the two credentials are independent", () => {
  it("uses a Groq generation key for generation and NOT for embeddings", () => {
    // The failure this prevents: the generation key silently becoming the
    // embedding key, which sends a Groq credential to Google and reports an
    // authentication error that looks like an outage.
    const providers = createRuntimeProviders(
      readRuntimeConfig(
        makeEnv({ llmProvider: "groq", llmApiKey: "groq-generation-key" }),
      ),
    );

    expect(providers.generator?.providerId).toBe("groq");
    expect(providers.embeddingConfigured).toBe(false);
    expect(providers.embeddingProviderId).toBe("synthetic-lexical-v1");
  });

  it("builds the real embedder from the embedding key alone, with no generation key", () => {
    const providers = createRuntimeProviders(
      readRuntimeConfig(
        makeEnv({ llmProvider: "groq", embeddingApiKey: "google-embedding-key" }),
      ),
    );

    expect(providers.embeddingConfigured).toBe(true);
    expect(providers.embeddingProviderId).toBe("gemini-embedding-001");
    // No generation credential, so there is still no generator: the opposite
    // direction must not fall back either.
    expect(providers.generator).toBeNull();
    expect(providers.configured).toBe(false);
  });
});

describe("error taxonomy", () => {
  it("keeps RuntimeModelNotConfiguredError catchable as a ProviderFailure", () => {
    const error = new RuntimeModelNotConfiguredError("not configured");
    expect(error.kind).toBe("not_configured");
    expect(error).toBeInstanceOf(RuntimeModelNotConfiguredError);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("the claim-generation envelope", () => {
  /** A well-formed claim, so each case varies exactly one property. */
  function claim(overrides: Record<string, unknown> = {}) {
    return {
      text: "The instructor connects to OpenAI and makes a real API call.",
      evidenceIds: ["block-1"],
      quote: "we connect OpenA models",
      ...overrides,
    };
  }

  it("accepts more claims than the interface has to render", () => {
    // It used to accept at most 8. A live turn at an early timestamp came back
    // with more, was rejected as `malformed_response`, and a supported question
    // was reported as a provider outage. How many claims a model returns is not
    // a property of whether its answer is grounded.
    const result = claimGenerationResultSchema.safeParse({
      claims: Array.from({ length: 14 }, (_, index) =>
        claim({ text: `claim number ${index}` }),
      ),
      unansweredParts: false,
    });

    expect(result.success).toBe(true);
  });

  it("accepts a long quotation, because a block can be that long", () => {
    const longQuote = "word ".repeat(150).trim();
    const result = claimGenerationResultSchema.safeParse({
      claims: [claim({ quote: longQuote })],
      unansweredParts: false,
    });

    expect(result.success).toBe(true);
  });

  it("still refuses a claim that cites nothing", () => {
    const result = claimGenerationResultSchema.safeParse({
      claims: [claim({ evidenceIds: [] })],
      unansweredParts: false,
    });

    expect(result.success).toBe(false);
  });

  it("can always receive a verdict for every claim it accepted", () => {
    const verdicts = Array.from({ length: 40 }, (_, index) => ({
      index,
      verdict: "SUPPORTED" as const,
      reason: "supported by the quoted span",
    }));

    expect(verifierResultSchema.safeParse({ verdicts }).success).toBe(true);
  });
});
