import { describe, expect, it } from "vitest";
import {
  RuntimeModelNotConfiguredError,
  getClaimGenerator,
  isRuntimeAiConfigured,
} from "@/lib/answer/provider";
import type { ServerEnv } from "@/lib/env";

const baseEnv: ServerEnv = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  supabaseServiceRoleKey: "",
  llmProvider: "",
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
  llmMaxOutputTokens: 1024,
  dailyTokenBudget: 0,
};

describe("isRuntimeAiConfigured", () => {
  it("is false when any required name is missing", () => {
    expect(isRuntimeAiConfigured(baseEnv)).toBe(false);
    expect(
      isRuntimeAiConfigured({ ...baseEnv, llmProvider: "openai-compatible" }),
    ).toBe(false);
  });

  it("is true only when all four names are present", () => {
    expect(
      isRuntimeAiConfigured({
        ...baseEnv,
        llmProvider: "openai-compatible",
        llmBaseUrl: "https://example.invalid",
        llmApiKey: "placeholder",
        llmModel: "placeholder-model",
      }),
    ).toBe(true);
  });
});

describe("getClaimGenerator", () => {
  it("fails closed with an explicit error instead of fabricating claims", async () => {
    const generator = getClaimGenerator(baseEnv);
    await expect(
      generator.generate({ question: "q", evidence: [] }),
    ).rejects.toBeInstanceOf(RuntimeModelNotConfiguredError);
  });

  it("does not return canned claims even when env names are present", async () => {
    const generator = getClaimGenerator({
      ...baseEnv,
      llmProvider: "openai-compatible",
      llmBaseUrl: "https://example.invalid",
      llmApiKey: "placeholder",
      llmModel: "placeholder-model",
    });
    await expect(
      generator.generate({ question: "q", evidence: [] }),
    ).rejects.toBeInstanceOf(RuntimeModelNotConfiguredError);
  });
});
