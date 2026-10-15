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
 * The database check, split into the facts that were previously conflated.
 *
 * WHY THE EXTRA FIELDS
 *   `reachable` used to mean "the host answered an HTTP request", which is true
 *   for a 401 and a 403. A deployment could therefore look healthy while being
 *   unable to read a single row. Each fact below is now reported separately:
 *
 *     configured          names are present (URL + anon key)
 *     urlConfigured       the URL itself is set
 *     credentialsPresent  the key the DATA PATH authenticates with is set
 *     querySucceeded      an AUTHENTICATED minimal read actually succeeded
 *     schemaObjects       whether the required tables/functions exist
 *     durableLedger       whether the budget ledger can be read at all
 *
 * Counts and enumerations only: no schema map, no raw database error and no
 * credential value is ever part of this payload.
 */
export const databaseCheckSchema = dependencyCheckSchema.extend({
  urlConfigured: z.boolean(),
  credentialsPresent: z.boolean(),
  querySucceeded: z.boolean().nullable(),
  schemaObjects: z.enum(["verified", "incomplete", "unknown"]),
  durableLedger: z.enum(["usable", "unreadable", "not_configured"]),
});
export type DatabaseCheck = z.infer<typeof databaseCheckSchema>;

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
  /**
   * Which ledger backs the daily total. "memory" is real per process but resets
   * on restart, so it is reported rather than presented as a durable cap.
   */
  usageMode: z.enum(["supabase", "memory"]),
  /**
   * Where the embedding REQUEST cap is enforced. "memory" means it is bounded
   * per process, so N instances get N caps. It never describes cost: the
   * embeddings API reports no token usage, so no cost figure is enforced.
   */
  embeddingCapMode: z.enum(["supabase", "memory"]),
  /** Tokens recorded for the current UTC day; null when the ledger was unreadable. */
  spentTokensToday: z.number().int().nullable(),
  usageCoverage: z.string(),
  /** Embedding requests attempted in this process (the token budget cannot meter these). */
  embeddingCalls: z.number().int(),
  /** Configured embedding-request ceiling; 0 means none is configured. */
  maxEmbeddingCalls: z.number().int(),
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
    database: databaseCheckSchema,
    runtimeAi: dependencyCheckSchema,
  }),
  runtime: runtimeInfoSchema,
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
