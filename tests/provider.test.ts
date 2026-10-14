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
        }),
      ),
    );
    expect(providers.configured).toBe(true);
    expect(providers.generator?.providerId).toBe("google-genai");
    expect(providers.verifier?.providerId).toBe("google-genai");
    expect(providers.modelId).toBe("gemini-3.6-flash");
    expect(providers.embeddingProviderId).toBe("gemini-embedding-001");
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
