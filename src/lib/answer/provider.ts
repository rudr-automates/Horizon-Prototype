import { z } from "zod";
import type { ServerEnv } from "@/lib/env";

/**
 * Runtime-model adapter boundary (blueprint §9.5).
 *
 * The generator returns STRUCTURED CLAIMS ONLY. There is no free-text answer
 * field and no model-owned answer state. A verifier and the application decide
 * what is rendered.
 */
export const generatedClaimSchema = z.object({
  text: z.string().min(1).max(600),
  evidenceIds: z.array(z.string().min(1)).min(1).max(8),
  quote: z.string().min(1).max(400),
});
export type GeneratedClaim = z.infer<typeof generatedClaimSchema>;

export const claimGenerationResultSchema = z.object({
  claims: z.array(generatedClaimSchema).max(8),
  unansweredParts: z.boolean(),
});
export type ClaimGenerationResult = z.infer<typeof claimGenerationResultSchema>;

export interface EvidenceItem {
  id: string;
  text: string;
}

export interface ClaimGenerationRequest {
  question: string;
  evidence: EvidenceItem[];
}

export interface ClaimGenerator {
  readonly providerId: string;
  generate(request: ClaimGenerationRequest): Promise<ClaimGenerationResult>;
}

/** Raised whenever a real inference call cannot be made honestly. */
export class RuntimeModelNotConfiguredError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "RuntimeModelNotConfiguredError";
  }
}

/**
 * "Configured" means the required env var names are present. It does NOT mean
 * the provider works. Reachability requires a real smoke test, which Part 01
 * deliberately has not performed.
 */
export function isRuntimeAiConfigured(env: ServerEnv): boolean {
  return Boolean(
    env.llmProvider && env.llmBaseUrl && env.llmApiKey && env.llmModel,
  );
}

/**
 * A generator that never fabricates output. Part 01 ships no verified provider
 * adapter, so every call fails closed with an explicit error. Do not replace
 * this with a mock that returns canned claims.
 */
class UnconfiguredClaimGenerator implements ClaimGenerator {
  readonly providerId = "unconfigured";

  constructor(private readonly envPresent: boolean) {}

  async generate(): Promise<ClaimGenerationResult> {
    throw new RuntimeModelNotConfiguredError(
      this.envPresent
        ? "Runtime AI environment variables are present, but no verified provider adapter exists yet. No inference was performed."
        : "Runtime AI is not configured. Set the HORIZON_LLM_* variables and add a verified provider adapter. No inference was performed.",
    );
  }
}

export function getClaimGenerator(env: ServerEnv): ClaimGenerator {
  return new UnconfiguredClaimGenerator(isRuntimeAiConfigured(env));
}
