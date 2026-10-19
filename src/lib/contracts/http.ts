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
  /** The limiter itself could not answer, so the request was refused (fail closed). */
  "RATE_LIMIT_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
  "BUDGET_EXHAUSTED",
  "LEARNER_DATA_UNAVAILABLE",
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
  /**
   * Whether the EMBEDDING credential is present, reported separately from the
   * generation one because they are now different vendors' keys. A deployment
   * can generate and still be unable to embed; that state previously had no way
   * of being visible here, and it silently degraded vector search.
   */
  embeddingCredentialPresent: z.boolean(),
  /**
   * Configuration problems an operator must fix, in plain language. Empty when
   * nothing is wrong. Never contains a credential value: these are the settings
   * that are wrong or meaningless, not what they are set to.
   */
  configurationProblems: z.array(z.string()),
  evidenceSource: z.enum(["supabase", "fixture"]),
  evidenceReason: z.string(),
  demoContent: z.boolean(),
  /**
   * The newest completed provider call the ledger can still prove.
   *
   * `observed` carries the time, the provider/model and whether that record is
   * inside the current UTC day, so "a call worked at some point" and "a call has
   * worked today" cannot be confused. `none_recorded` means the durable store
   * holds no such row; `not_durable` means the active ledger cannot carry that
   * fact at all. It is never inferred from configuration and never hardcoded to
   * success: a configured provider with a rejected credential reads
   * `none_recorded` however healthy the names look.
   */
  providerCallEvidence: z.object({
    state: z.enum(["observed", "none_recorded", "not_durable", "unreadable"]),
    /** ISO timestamp of the newest recorded success, or null. */
    at: z.string().nullable(),
    detail: z.string(),
  }),
  /**
   * Whether the NEXT provider call would actually be admitted. "blocked" means
   * no provider call is permitted at all, so a configured deployment will still
   * refuse. It is computed from every refusal path — a zero budget, an
   * unreadable ledger, or missing reservation objects — rather than from the
   * budget value alone, so it cannot disagree with what the answer path does.
   * Reported here because a learner-facing refusal must not describe budgets.
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
  /**
   * Embedding requests attempted in THIS PROCESS (the token budget cannot meter
   * these). It resets on every restart, so it is not the day's usage and must not
   * be shown against a durable cap as though it were.
   */
  embeddingCalls: z.number().int(),
  /**
   * Embedding requests recorded for the current UTC day in the DURABLE ledger;
   * null when it could not be read. This is the figure to compare against the cap
   * when `embeddingCapMode` is "supabase", because it comes from the same store
   * the cap counts in. Null means unknown, never zero.
   */
  embeddingRequestsToday: z.number().int().nullable(),
  /** Configured embedding-request ceiling; 0 means none is configured. */
  maxEmbeddingCalls: z.number().int(),
});
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;

/**
 * The PUBLIC health payload.
 *
 * Deliberately smaller than `healthResponseSchema`: it answers whether the
 * service is up and whether it can read its database, and which corpus it is
 * serving. It carries no token totals, no budget, no model ids, no embedding
 * cap, no schema-object counts and no configuration problems. Those remain
 * available to an operator through `GET /health/diagnostics` and are rendered
 * server-side on the Status surface.
 */
export const publicHealthResponseSchema = z.object({
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
    /**
     * Whether a question could actually be admitted right now.
     *
     * This is the dependency that fails when migration 0004 is missing: every
     * request is refused before any provider call, so a report that omitted it
     * said "Operational" about a deployment that could not answer a question.
     * The detail is one public-safe sentence; it names no object, count or error.
     */
    admission: dependencyCheckSchema,
  }),
  runtime: z.object({
    evidenceSource: z.enum(["supabase", "fixture"]),
    demoContent: z.boolean(),
  }),
});
export type PublicHealthResponse = z.infer<typeof publicHealthResponseSchema>;

/** The operator report. Contains no secrets and no env values. */
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
    admission: dependencyCheckSchema,
  }),
  runtime: runtimeInfoSchema,
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
