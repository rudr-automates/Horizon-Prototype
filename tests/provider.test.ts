import { describe, expect, it } from "vitest";
import { RuntimeModelNotConfiguredError } from "@/lib/answer/provider";
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
