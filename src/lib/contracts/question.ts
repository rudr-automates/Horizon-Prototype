import { z } from "zod";
import { policySchema, publicAnswerStateSchema } from "@/lib/contracts/domain";

export const scopeModeSchema = z.enum(["POSITION", "PROGRESS"]);
export type ScopeMode = z.infer<typeof scopeModeSchema>;

/** Where retrieved evidence came from. Surfaced so the UI can label demo mode. */
export const evidenceSourceSchema = z.enum(["supabase", "fixture"]);
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

/** A citation resolved server-side from a real block. Never model-authored. */
export const citationSchema = z.object({
  evidenceId: z.string(),
  sourceLabel: z.string(),
  blockType: z.string(),
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
  pageNumber: z.number().int().nullable(),
  slideNumber: z.number().int().nullable(),
  lineStart: z.number().int().nullable(),
  lineEnd: z.number().int().nullable(),
  policy: policySchema,
  quote: z.string(),
});
export type Citation = z.infer<typeof citationSchema>;

export const verifiedClaimSchema = z.object({
  text: z.string(),
  citations: z.array(citationSchema).min(1),
});
export type VerifiedClaim = z.infer<typeof verifiedClaimSchema>;

/**
 * Coarse, non-leaking reason codes. These deliberately do NOT distinguish
 * "not available yet" from "not in materials" — both collapse into the same
 * learner-facing state and the same message.
 */
export const answerReasonSchema = z.enum([
  "NONE",
  "NO_ELIGIBLE_EVIDENCE",
  "UNSUPPORTED_BY_EVIDENCE",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_MALFORMED",
  "EMBEDDING_UNAVAILABLE",
  "BUDGET_EXHAUSTED",
  "INVALID_REQUEST",
]);
export type AnswerReason = z.infer<typeof answerReasonSchema>;

/** Only counts for the CURRENTLY eligible scope are exposed. */
export const scopeSummarySchema = z.object({
  boundarySeconds: z.number(),
  scopeMode: scopeModeSchema,
  eligibleBlockCount: z.number().int(),
  policySummary: z.string(),
});
export type ScopeSummary = z.infer<typeof scopeSummarySchema>;

export const questionRequestSchema = z.object({
  question: z.string().trim().min(3).max(500),
  playheadSeconds: z.number().min(0).max(86_400),
  scopeMode: scopeModeSchema.default("POSITION"),
});
export type QuestionRequest = z.infer<typeof questionRequestSchema>;

/**
 * What actually happened to the turn record. `persisted: false` is a normal,
 * honest outcome when no database is configured.
 */
export const persistenceSummarySchema = z.object({
  persisted: z.boolean(),
  mode: z.enum(["supabase", "disabled"]),
  detail: z.string(),
});
export type PersistenceSummary = z.infer<typeof persistenceSummarySchema>;

export const questionResponseSchema = z.object({
  requestId: z.string(),
  answerState: publicAnswerStateSchema,
  reason: answerReasonSchema,
  message: z.string(),
  /** Measured server-side wall-clock time for this turn. Not a benchmark. */
  latencyMs: z.number().int().min(0),
  persistence: persistenceSummarySchema,
  claims: z.array(verifiedClaimSchema),
  citations: z.array(citationSchema),
  scope: scopeSummarySchema,
  evidence: z.object({
    source: evidenceSourceSchema,
    retrievedCount: z.number().int(),
    payloadCount: z.number().int(),
    embeddingProvider: z.string(),
    generator: z.string().nullable(),
    verifier: z.string().nullable(),
  }),
  provenance: z.object({
    modelId: z.string().nullable(),
    embeddingModel: z.string(),
    embeddingDimensions: z.number().int(),
    verification: z.enum(["none", "model_assisted"]),
    demoContent: z.boolean(),
  }),
});
export type QuestionResponse = z.infer<typeof questionResponseSchema>;

export const courseSummarySchema = z.object({
  courseId: z.string(),
  title: z.string(),
  durationSeconds: z.number(),
  demoContent: z.boolean(),
});
export type CourseSummary = z.infer<typeof courseSummarySchema>;
