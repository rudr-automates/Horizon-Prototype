import { z } from "zod";

/**
 * Canonical resource policy values (blueprint §7.2).
 * There are exactly two policies. "Unaligned" is a review state, never a policy.
 */
export const policySchema = z.enum(["TIMELINE_BOUND", "COURSE_WIDE"]);
export type Policy = z.infer<typeof policySchema>;

/** Review/approval state, separate from policy. */
export const reviewStateSchema = z.enum([
  "PENDING",
  "AUTO_APPROVED",
  "HUMAN_APPROVED",
  "REJECTED",
]);
export type ReviewState = z.infer<typeof reviewStateSchema>;

/** COURSE_WIDE leakage-lint result. */
export const lintStatusSchema = z.enum([
  "NA",
  "PASSED",
  "FLAGGED",
  "ACKNOWLEDGED",
]);
export type LintStatus = z.infer<typeof lintStatusSchema>;

/** Ingestion/indexing state of a block. */
export const ingestStatusSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "INDEXED",
  "FAILED",
]);
export type IngestStatus = z.infer<typeof ingestStatusSchema>;

/** Block kind. Mirrors the `block_type` enum in the migration. */
export const blockTypeSchema = z.enum([
  "transcript",
  "pdf",
  "ppt",
  "notes",
  "code",
]);
export type BlockType = z.infer<typeof blockTypeSchema>;

/**
 * Internal answer outcomes (blueprint §9.7). The learner-facing API collapses
 * NOT_AVAILABLE_YET and NOT_IN_MATERIALS into INSUFFICIENT_EVIDENCE.
 */
export const internalAnswerStateSchema = z.enum([
  "ANSWERED",
  "ANSWERED_PARTIAL",
  "NOT_AVAILABLE_YET",
  "NOT_IN_MATERIALS",
  "TEMPORARILY_UNAVAILABLE",
]);
export type InternalAnswerState = z.infer<typeof internalAnswerStateSchema>;

/** Learner-facing answer states. Deliberately coarser than the internal set. */
export const publicAnswerStateSchema = z.enum([
  "ANSWERED",
  "ANSWERED_PARTIAL",
  "INSUFFICIENT_EVIDENCE",
  "TEMPORARILY_UNAVAILABLE",
]);
export type PublicAnswerState = z.infer<typeof publicAnswerStateSchema>;

/**
 * The single mapping from internal to learner-facing answer state. Both
 * insufficient-evidence subtypes map to one identical public state.
 */
export function toPublicAnswerState(
  internal: InternalAnswerState,
): PublicAnswerState {
  switch (internal) {
    case "ANSWERED":
      return "ANSWERED";
    case "ANSWERED_PARTIAL":
      return "ANSWERED_PARTIAL";
    case "NOT_AVAILABLE_YET":
    case "NOT_IN_MATERIALS":
      return "INSUFFICIENT_EVIDENCE";
    case "TEMPORARILY_UNAVAILABLE":
      return "TEMPORARILY_UNAVAILABLE";
  }
}
