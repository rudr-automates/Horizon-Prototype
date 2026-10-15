import { z } from "zod";

import { count } from "@/lib/usage/types";

/**
 * Runtime-model boundary (blueprint §9.5, §9.6).
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

/**
 * Tokens the provider reported for one call.
 *
 * `null` means "the provider did not report it", which is different from zero.
 * The spend guard treats null as unknown rather than free.
 */
export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * Billable reasoning tokens. The provider reports these SEPARATELY from
   * candidatesTokenCount, so ignoring them under-counts real usage — observed
   * live at 984 thinking tokens against only 21 visible output tokens.
   */
  thoughtsTokens: number | null;
}

/**
 * Tokens that actually count against the budget.
 *
 * Prompt, completion and reasoning are all billed, so all three are metered. A
 * null field means "the provider did not report it" and contributes zero, which
 * is the only defensible reading of an absent report.
 */
export function meteredTokens(usage: TokenUsage | null): number {
  if (!usage) return 0;
  // `count` is the single shared sanitiser: without its isFinite guard a single
  // NaN component would make the whole total NaN, and every comparison against
  // NaN is false — which would silently turn the spend guard OFF rather than
  // trip it. Negative counts are not credits either. One implementation, shared
  // with the ledgers, so the count here and the count persisted cannot drift.
  return count(usage.promptTokens) + count(usage.completionTokens) + count(usage.thoughtsTokens);
}

/**
 * A generator result carries its own usage, because metering is a real output of
 * the call and hiding it on the instance would make concurrent turns race.
 */
export interface GenerationOutcome {
  result: ClaimGenerationResult;
  usage: TokenUsage | null;
}

export interface ClaimGenerator {
  readonly providerId: string;
  generate(request: ClaimGenerationRequest): Promise<GenerationOutcome>;
}

/* ------------------------------------------------------------------ *
 * Semantic (Tier 2) verification — MODEL-ASSISTED, not independent.
 * ------------------------------------------------------------------ */

export const verifierVerdictSchema = z.object({
  index: z.number().int().min(0),
  verdict: z.enum(["SUPPORTED", "PARTIAL", "NOT_SUPPORTED"]),
  reason: z.string().max(300),
});
export type VerifierVerdict = z.infer<typeof verifierVerdictSchema>;

export const verifierResultSchema = z.object({
  verdicts: z.array(verifierVerdictSchema).max(16),
});
export type VerifierResult = z.infer<typeof verifierResultSchema>;

export interface VerificationTarget {
  index: number;
  claimText: string;
  evidence: EvidenceItem[];
}

export interface VerificationOutcome {
  verdicts: VerifierVerdict[];
  usage: TokenUsage | null;
}

export interface SemanticVerifier {
  readonly providerId: string;
  verify(targets: VerificationTarget[]): Promise<VerificationOutcome>;
}

/* ------------------------------------------------------------------ *
 * Embeddings
 * ------------------------------------------------------------------ */

export type EmbedPurpose = "query" | "document";

export interface Embedder {
  readonly providerId: string;
  readonly dimensions: number;
  embed(texts: string[], purpose?: EmbedPurpose): Promise<number[][]>;
}

/* ------------------------------------------------------------------ *
 * Fail-closed error taxonomy
 * ------------------------------------------------------------------ */

export type ProviderFailureKind =
  | "not_configured"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "malformed_response";

export class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;
  readonly status: number | null;
  /**
   * Usage the provider DID report before the failure. A failed call still costs
   * money, so this is carried out of the adapter and metered by the caller.
   * Without it, real spend disappears from the ledger exactly when something is
   * going wrong.
   */
  readonly usage: TokenUsage | null;

  constructor(
    kind: ProviderFailureKind,
    message: string,
    status: number | null = null,
    usage: TokenUsage | null = null,
  ) {
    super(message);
    this.name = "ProviderFailure";
    this.kind = kind;
    this.status = status;
    this.usage = usage;
  }
}

/**
 * Kept as a distinct class for Part 01 compatibility. It is a ProviderFailure
 * with kind "not_configured", so callers can catch either.
 */
export class RuntimeModelNotConfiguredError extends ProviderFailure {
  constructor(message: string) {
    super("not_configured", message);
    this.name = "RuntimeModelNotConfiguredError";
  }
}
