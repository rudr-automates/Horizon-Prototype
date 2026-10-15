import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readServerEnv } from "@/lib/env";
import { describeConfigurationProblems, readRuntimeConfig } from "@/lib/config";

/**
 * Credential resolution, exercised through the REAL environment reader.
 *
 * WHY THIS IS NOT TESTED THROUGH `makeEnv`
 *   The separation rule lives in the reader, which is the only place that sees
 *   the raw variable names. A fixture that hands `readRuntimeConfig` a ready-made
 *   struct cannot exercise it, and this is exactly the rule where a mistake is
 *   both easy and silent: a Groq key sent to Google's embedding endpoint returns
 *   401, which the application reports as a provider outage.
 *
 * Every name is cleared first so the result cannot depend on the machine's
 * environment — including any real key that happens to be exported.
 */

const MANAGED = [
  "HORIZON_LLM_PROVIDER",
  "HORIZON_LLM_API_KEY",
  "HORIZON_LLM_MODEL",
  "HORIZON_LLM_BASE_URL",
  "HORIZON_LLM_REASONING_EFFORT",
  "HORIZON_EMBEDDING_API_KEY",
  "HORIZON_EMBEDDING_MODEL",
  "HORIZON_EMBEDDING_DIMENSIONS",
  "HORIZON_LLM_THINKING_BUDGET",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
];

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  saved.clear();
  for (const name of MANAGED) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function setEnv(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

describe("generation and embedding credentials are resolved separately", () => {
  it("takes each credential from its own name when both are set", () => {
    setEnv({
      HORIZON_LLM_PROVIDER: "groq",
      HORIZON_LLM_API_KEY: "groq-key",
      HORIZON_EMBEDDING_API_KEY: "google-embedding-key",
    });

    const env = readServerEnv();

    expect(env.llmApiKey).toBe("groq-key");
    expect(env.embeddingApiKey).toBe("google-embedding-key");
  });

  it("never reuses a Groq generation key as the embedding credential", () => {
    // The failure this pins down. Under a non-Google provider the generation key
    // is NOT a Google credential, so falling back to it would send a Groq key to
    // Google and surface as an outage.
    setEnv({ HORIZON_LLM_PROVIDER: "groq", HORIZON_LLM_API_KEY: "groq-key" });

    const env = readServerEnv();

    expect(env.llmApiKey).toBe("groq-key");
    expect(env.embeddingApiKey).toBe("");
    expect(readRuntimeConfig(env).embeddingApiKey).toBe("");
  });

  it("accepts GOOGLE_API_KEY as the embedding credential without using it for generation", () => {
    setEnv({
      HORIZON_LLM_PROVIDER: "groq",
      HORIZON_LLM_API_KEY: "groq-key",
      GOOGLE_API_KEY: "google-key",
    });

    const env = readServerEnv();

    // The two directions are independent: the Google key must not become the
    // generation key any more than the Groq key may become the embedding key.
    expect(env.llmApiKey).toBe("groq-key");
    expect(env.embeddingApiKey).toBe("google-key");
  });

  it("keeps the legacy single-key setup working when the provider IS Google", () => {
    // Under google-genai the generation key is known to be a Google credential,
    // so this fallback preserves an existing configured deployment.
    setEnv({
      HORIZON_LLM_PROVIDER: "google-genai",
      HORIZON_LLM_API_KEY: "google-key",
    });

    const env = readServerEnv();

    expect(env.llmApiKey).toBe("google-key");
    expect(env.embeddingApiKey).toBe("google-key");
  });

  it("prefers an explicit embedding key over the legacy fallback", () => {
    setEnv({
      HORIZON_LLM_PROVIDER: "google-genai",
      HORIZON_LLM_API_KEY: "legacy-key",
      HORIZON_EMBEDDING_API_KEY: "dedicated-key",
    });

    expect(readServerEnv().embeddingApiKey).toBe("dedicated-key");
  });
});

describe("configuration problems are named, not inferred", () => {
  it("is silent for a correct Groq configuration", () => {
    setEnv({
      HORIZON_LLM_PROVIDER: "groq",
      HORIZON_LLM_API_KEY: "groq-key",
      HORIZON_EMBEDDING_API_KEY: "google-key",
      HORIZON_LLM_BASE_URL: "https://api.groq.com/openai/v1",
    });

    expect(describeConfigurationProblems(readRuntimeConfig(readServerEnv()))).toEqual([]);
  });

  it("names an unrecognised provider instead of silently doing nothing", () => {
    setEnv({ HORIZON_LLM_PROVIDER: "openai", HORIZON_LLM_API_KEY: "key" });

    const problems = describeConfigurationProblems(readRuntimeConfig(readServerEnv()));

    expect(problems.join(" ")).toContain("not recognised");
  });

  it("names a missing embedding credential", () => {
    setEnv({ HORIZON_LLM_PROVIDER: "groq", HORIZON_LLM_API_KEY: "groq-key" });

    const problems = describeConfigurationProblems(readRuntimeConfig(readServerEnv()));

    expect(problems.join(" ")).toContain("HORIZON_EMBEDDING_API_KEY");
  });

  it("reports a Google-only setting that Groq ignores", () => {
    setEnv({
      HORIZON_LLM_PROVIDER: "groq",
      HORIZON_LLM_API_KEY: "groq-key",
      HORIZON_EMBEDDING_API_KEY: "google-key",
      HORIZON_LLM_THINKING_BUDGET: "2048",
    });

    const problems = describeConfigurationProblems(readRuntimeConfig(readServerEnv()));

    expect(problems.join(" ")).toContain("HORIZON_LLM_THINKING_BUDGET");
    expect(problems.join(" ")).toContain("HORIZON_LLM_REASONING_EFFORT");
  });

  it("flags a base URL that is not a usable https endpoint", () => {
    setEnv({
      HORIZON_LLM_PROVIDER: "groq",
      HORIZON_LLM_API_KEY: "groq-key",
      HORIZON_EMBEDDING_API_KEY: "google-key",
      HORIZON_LLM_BASE_URL: "api.groq.com/openai/v1",
    });

    expect(describeConfigurationProblems(readRuntimeConfig(readServerEnv())).join(" ")).toContain(
      "HORIZON_LLM_BASE_URL",
    );
  });

  it("resolves Groq's documented endpoint when none is set, and Google's stays absent", () => {
    setEnv({ HORIZON_LLM_PROVIDER: "groq" });
    expect(readRuntimeConfig(readServerEnv()).generationBaseUrl).toBe(
      "https://api.groq.com/openai/v1",
    );
    // An OpenAI-compatible provider needs a host; Google's SDK resolves its own.
    setEnv({ HORIZON_LLM_PROVIDER: "google-genai" });
    expect(readRuntimeConfig(readServerEnv()).generationBaseUrl).toBe("");
  });
});
