import { z } from "zod";

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

export interface ClaimGenerator {
  readonly providerId: string;
  generate(request: ClaimGenerationRequest): Promise<ClaimGenerationResult>;
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

export interface SemanticVerifier {
  readonly providerId: string;
  verify(targets: VerificationTarget[]): Promise<VerifierVerdict[]>;
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

  constructor(kind: ProviderFailureKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderFailure";
    this.kind = kind;
    this.status = status;
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
