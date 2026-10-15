import { z } from "zod";

/**
 * Stable, safe API error codes. Messages must never reveal hidden
 * future-resource details or database internals.
 */
export const errorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "UNSUPPORTED_TYPE",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "BUDGET_EXHAUSTED",
  "INTERNAL_ERROR",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * A single dependency status. `configured` and `reachable` are reported
 * separately and must never be conflated:
 *  - configured: the required env var names are present.
 *  - reachable: an actual probe succeeded. `null` means "not verified".
 */
export const dependencyCheckSchema = z.object({
  configured: z.boolean(),
  reachable: z.boolean().nullable(),
  detail: z.string(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

/**
 * Runtime configuration actually in effect. Reports NAMES and defaults only;
 * never a credential value.
 */
export const runtimeInfoSchema = z.object({
  provider: z.string(),
  textModel: z.string(),
  embeddingModel: z.string(),
  embeddingDimensions: z.number().int(),
  /** Which embedder is really producing vectors right now. */
  embeddingProvider: z.string(),
  evidenceSource: z.enum(["supabase", "fixture"]),
  evidenceReason: z.string(),
  demoContent: z.boolean(),
  /**
   * The spend guard actually in effect. "blocked" means no provider call is
   * permitted at all, so a configured deployment will still refuse. Reported
   * here because a learner-facing refusal must not describe budgets.
   */
  spendGuard: z.enum(["blocked", "permitted"]),
});
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;

/** Health response contract. Contains no secrets and no env values. */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["ok", "degraded"]),
  service: z.literal("horizon"),
  version: z.string(),
  requestId: z.string(),
  timestamp: z.string(),
  checks: z.object({
    app: dependencyCheckSchema,
    database: dependencyCheckSchema,
    runtimeAi: dependencyCheckSchema,
  }),
  runtime: runtimeInfoSchema,
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
